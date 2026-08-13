/**
 * Core security database builder logic.
 *
 * Builds a normalized SQLite database of D365FO security configuration by
 * merging two data sources:
 *   1. AOT metadata (PackagesLocalDirectory) -- role/duty/privilege definitions
 *   2. DMF XML exports (PROD) -- users, user-role assignments, company scoping
 *
 * Used by both the CLI build tool (build/build-sec.js) and the Azure upload
 * function (src/functions/d365sec-upload.js).
 */

import { createRequire } from 'module';
import { readFileSync, readdirSync, existsSync, mkdirSync, rmSync, renameSync, copyFileSync, statSync, openSync, readSync, closeSync } from 'fs';
import { join, resolve, basename, dirname } from 'path';
import { XMLParser } from 'fast-xml-parser';
import {
  readModelDescriptors,
  insertModelVersions,
  MODEL_VERSIONS_SCHEMA,
} from './model-descriptors.js';

const require = createRequire(import.meta.url);
const Database = require('better-sqlite3');

// ── Schema ───────────────────────────────────────────────────────────────────

const SCHEMA = `
-- ROLES
CREATE TABLE IF NOT EXISTS roles (
  role_id              TEXT PRIMARY KEY,
  role_name            TEXT NOT NULL,
  module_id            TEXT,
  label                TEXT,
  description          TEXT,
  license_type         TEXT,
  -- permission_type is the effective Grant/Deny used by every reader.
  -- dmf_permission_type is the raw value from the DMF export (P4-05 /
  -- CR-SEC-005). When both are present the DMF value wins; when DMF is
  -- NULL the regex fallback in detectPermissionType populates
  -- permission_type. Existing dbs upgrade via ALTER TABLE below.
  permission_type      TEXT DEFAULT 'Grant',
  dmf_permission_type  TEXT,
  is_profile           INTEGER DEFAULT 0,
  source               TEXT DEFAULT 'aot'
);
CREATE INDEX IF NOT EXISTS idx_roles_name ON roles(role_name);
CREATE INDEX IF NOT EXISTS idx_roles_module ON roles(module_id);

-- SUB-ROLES (role hierarchy)
CREATE TABLE IF NOT EXISTS role_subroles (
  parent_role_id   TEXT NOT NULL,
  child_role_id    TEXT NOT NULL,
  is_transitive    INTEGER DEFAULT 0,
  PRIMARY KEY (parent_role_id, child_role_id)
);
CREATE INDEX IF NOT EXISTS idx_subroles_child ON role_subroles(child_role_id);

-- DUTIES
CREATE TABLE IF NOT EXISTS duties (
  duty_id          TEXT PRIMARY KEY,
  duty_name        TEXT,
  module_id        TEXT,
  description      TEXT
);
CREATE INDEX IF NOT EXISTS idx_duties_module ON duties(module_id);

CREATE TABLE IF NOT EXISTS role_duties (
  role_id          TEXT NOT NULL,
  duty_id          TEXT NOT NULL,
  permission_type  TEXT DEFAULT 'Grant',
  PRIMARY KEY (role_id, duty_id)
);
CREATE INDEX IF NOT EXISTS idx_role_duties_duty ON role_duties(duty_id);

-- PRIVILEGES
CREATE TABLE IF NOT EXISTS privileges (
  privilege_name   TEXT PRIMARY KEY,
  module_id        TEXT,
  label            TEXT
);
CREATE INDEX IF NOT EXISTS idx_privileges_module ON privileges(module_id);

CREATE TABLE IF NOT EXISTS duty_privileges (
  duty_id          TEXT NOT NULL,
  privilege_name   TEXT NOT NULL,
  PRIMARY KEY (duty_id, privilege_name)
);
CREATE INDEX IF NOT EXISTS idx_duty_privs_priv ON duty_privileges(privilege_name);

-- ENTRY POINTS (privilege -> menu item with CRUD)
CREATE TABLE IF NOT EXISTS privilege_entry_points (
  privilege_name   TEXT NOT NULL,
  entry_point_name TEXT NOT NULL,
  object_type      TEXT,
  object_name      TEXT,
  grant_read       TEXT,
  grant_create     TEXT,
  grant_update     TEXT,
  grant_delete     TEXT,
  grant_correct    TEXT,
  grant_invoke     TEXT,
  PRIMARY KEY (privilege_name, entry_point_name)
);
CREATE INDEX IF NOT EXISTS idx_ep_object ON privilege_entry_points(object_name);

-- USERS (from DMF)
CREATE TABLE IF NOT EXISTS users (
  user_id          TEXT PRIMARY KEY,
  person_name      TEXT,
  email            TEXT,
  enabled          INTEGER DEFAULT 1,
  default_company  TEXT
);
CREATE INDEX IF NOT EXISTS idx_users_enabled ON users(enabled);

CREATE TABLE IF NOT EXISTS user_roles (
  user_id          TEXT NOT NULL,
  role_id          TEXT NOT NULL,
  PRIMARY KEY (user_id, role_id)
);
CREATE INDEX IF NOT EXISTS idx_user_roles_role ON user_roles(role_id);

CREATE TABLE IF NOT EXISTS user_role_companies (
  user_id          TEXT NOT NULL,
  role_id          TEXT NOT NULL,
  company_id       TEXT NOT NULL,
  PRIMARY KEY (user_id, role_id, company_id)
);
CREATE INDEX IF NOT EXISTS idx_urc_company ON user_role_companies(company_id);

-- DIRECT PERMISSIONS (from SecurityDatabaseCustomizations)
CREATE TABLE IF NOT EXISTS role_direct_privileges (
  role_id          TEXT NOT NULL,
  privilege_name   TEXT NOT NULL,
  PRIMARY KEY (role_id, privilege_name)
);

CREATE TABLE IF NOT EXISTS role_direct_entity_permissions (
  role_id          TEXT NOT NULL,
  entity_name      TEXT NOT NULL,
  resource_type    TEXT,
  grant_read       TEXT,
  grant_create     TEXT,
  grant_update     TEXT,
  grant_delete     TEXT,
  grant_correct    TEXT,
  grant_invoke     TEXT,
  PRIMARY KEY (role_id, entity_name)
);
CREATE INDEX IF NOT EXISTS idx_rdep_entity ON role_direct_entity_permissions(entity_name);

-- SEARCH INDEX + METADATA
CREATE TABLE IF NOT EXISTS sec_search (
  object_type      TEXT,
  object_name      TEXT,
  module_id        TEXT,
  content          TEXT
);
CREATE INDEX IF NOT EXISTS idx_sec_search_type ON sec_search(object_type);
CREATE INDEX IF NOT EXISTS idx_sec_search_name ON sec_search(object_name);
CREATE INDEX IF NOT EXISTS idx_sec_search_content_nocase ON sec_search(content COLLATE NOCASE);

-- FTS5 full-text index over sec_search. Content-external: the FTS index
-- does NOT duplicate the rows — it references sec_search via rowid. This
-- keeps the DB size manageable while enabling 10-50x faster multi-word
-- queries via MATCH instead of multiple LIKE '%term%' scans.
CREATE VIRTUAL TABLE IF NOT EXISTS sec_search_fts USING fts5(
  object_name, content,
  content='sec_search', content_rowid='rowid'
);

CREATE TABLE IF NOT EXISTS sec_metadata (
  key              TEXT PRIMARY KEY,
  value            TEXT
);

-- Model build provenance: one row per model descriptor found in the scanned
-- AOT metadata roots (Microsoft application, ISV models, customizations).
${MODEL_VERSIONS_SCHEMA}

-- ── Performance indexes ──────────────────────────────────────────────────────
-- Case-insensitive lookups (sec-tools.js uses COLLATE NOCASE everywhere)
CREATE INDEX IF NOT EXISTS idx_roles_name_nocase    ON roles(role_name COLLATE NOCASE);
CREATE INDEX IF NOT EXISTS idx_duties_id_nocase     ON duties(duty_id COLLATE NOCASE);
CREATE INDEX IF NOT EXISTS idx_duties_name_nocase   ON duties(duty_name COLLATE NOCASE);
CREATE INDEX IF NOT EXISTS idx_privs_name_nocase    ON privileges(privilege_name COLLATE NOCASE);
CREATE INDEX IF NOT EXISTS idx_users_id_nocase      ON users(user_id COLLATE NOCASE);
CREATE INDEX IF NOT EXISTS idx_users_email_nocase   ON users(email COLLATE NOCASE);
CREATE INDEX IF NOT EXISTS idx_users_person_nocase  ON users(person_name COLLATE NOCASE);
CREATE INDEX IF NOT EXISTS idx_ep_object_nocase     ON privilege_entry_points(object_name COLLATE NOCASE);

-- Covering composite for the duty_privileges joins (multi-million-row table).
-- The PK is (duty_id, privilege_name) — this adds the reverse direction.
CREATE INDEX IF NOT EXISTS idx_dp_priv_duty         ON duty_privileges(privilege_name, duty_id);

-- Reverse lookups for direct privilege/permission tables
CREATE INDEX IF NOT EXISTS idx_rdp_priv             ON role_direct_privileges(privilege_name);
CREATE INDEX IF NOT EXISTS idx_rdep_role            ON role_direct_entity_permissions(role_id);
CREATE INDEX IF NOT EXISTS idx_urc_role_id          ON user_role_companies(role_id);

-- Hierarchy traversal in both directions
CREATE INDEX IF NOT EXISTS idx_subroles_parent      ON role_subroles(parent_role_id);
`;

// ── Helpers ──────────────────────────────────────────────────────────────────

function ensureArray(val) {
  if (!val) return [];
  return Array.isArray(val) ? val : [val];
}

function createXmlParser() {
  return new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: '@_',
    isArray: (name) => [
      'AxSecurityRole', 'AxSecurityDuty', 'AxSecurityPrivilege',
      'AxSecurityDutyReference', 'AxSecurityPrivilegeReference',
      'AxSecurityEntryPointReference', 'AxSecurityDataEntityReference',
      'SYSTEMSECURITYROLEENTITY', 'SYSTEMSECURITYSUBROLEENTITYV2',
      'SYSTEMSECURITYROLEDUTYENTITY', 'SYSTEMSECURITYUSERROLEENTITY',
      'SYSTEMSECURITYUSERROLEASSOCIATIONENTITY',
      'SYSTEMSECURITYUSERROLEORGANIZATIONENTITY',
      'SYSTEMUSERENTITY', 'USERINFOENTITY',
      'SYSTEMSECURITYDUTYENTITY',
      'SYSTEMSECURITYPRIVILEGEENTITY',
      'SYSTEMSECURITYPERMISSIONENTITY',
    ].includes(name),
  });
}

/**
 * Recursively find directories named `dirName` under basePath.
 * Walks up to 4 levels deep (PackagesLocalDirectory/Package/Model/AxType).
 */
function findAxDirs(basePath, dirName) {
  const results = [];
  // AOT directories are stored with inconsistent casing across modules:
  // `ApplicationSuite/Foundation/axsecurityduty` is lowercase while most
  // other modules use TitleCase. A case-sensitive match silently drops
  // ~1,700 duty XMLs from Foundation (CR-SEC-006 root cause).
  const target = dirName.toLowerCase();
  function walk(dir, depth) {
    if (depth > 4) return;
    try {
      const entries = readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        // XppMetadata is a compiled mirror present in customization models;
        // skipping it avoids double-counting their security objects.
        if (entry.name === 'bin' || entry.name === 'node_modules' || entry.name === 'XppMetadata') continue;
        const fullPath = join(dir, entry.name);
        if (entry.name.toLowerCase() === target) {
          results.push(fullPath);
        } else {
          walk(fullPath, depth + 1);
        }
      }
    } catch (err) {
      // P6-01: walking the AOT package tree can hit ENOENT (deleted while
      // iterating) or EACCES (locked file). These are intentional skips,
      // not silent — emit a debug-level warning so the build log shows the
      // skipped path instead of pretending nothing happened.
      try { console.warn('cleanup-warn', 'aot-walk-skip', dir, err.message); }
      catch { /* logger unavailable */ }
    }
  }
  walk(basePath, 0);
  return results;
}

/** Read all .xml files from a directory */
function readXmlFiles(dirPath) {
  try {
    return readdirSync(dirPath)
      .filter(f => f.endsWith('.xml'))
      .map(f => join(dirPath, f));
  } catch { return []; }
}

/**
 * Determine module name from file path.
 * Path pattern: PackagesLocalDirectory/PackageName/ModelName/AxType/File.xml
 */
function getModuleFromPath(filePath, packagesPaths) {
  for (const basePath of packagesPaths) {
    const norm = filePath.replace(/\\/g, '/');
    const base = basePath.replace(/\\/g, '/');
    if (norm.startsWith(base)) {
      const rel = norm.substring(base.length + 1);
      const parts = rel.split('/');
      return parts[0] || 'Unknown';
    }
  }
  const parts = filePath.replace(/\\/g, '/').split('/');
  for (let i = parts.length - 1; i >= 0; i--) {
    if (parts[i].startsWith('Ax') && i >= 2) return parts[i - 2] || parts[i - 1] || 'Unknown';
  }
  return 'Unknown';
}

/**
 * Recursively collect en-US `*.label.txt` files under an AxLabelFile directory.
 *
 * Label resources are nested at
 * `AxLabelFile/LabelResources/<locale>/<name>.<locale>.label.txt` — NOT directly
 * in the AxLabelFile dir — so a flat readdir finds nothing (the gap #4 root
 * cause: `Labels loaded: 0`). Locale is matched case-insensitively because some
 * packages ship `en-us` rather than `en-US`.
 */
function findLabelFiles(dir, depth = 0, out = []) {
  if (depth > 4) return out;
  let entries;
  try { entries = readdirSync(dir, { withFileTypes: true }); }
  catch { return out; }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      findLabelFiles(full, depth + 1, out);
    } else if (/\.label\.txt$/i.test(entry.name) && /en-us/i.test(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

/** Load label files from a packages directory */
function loadLabels(packagesPath) {
  const labels = new Map();
  const labelDirs = findAxDirs(packagesPath, 'AxLabelFile');

  for (const dir of labelDirs) {
    for (const file of findLabelFiles(dir)) {
      // The label file's own basename is the label-file/module prefix used in
      // both AOT reference shapes (`@Prefix:Id` and `@PrefixId`) — e.g.
      // "QMS.en-US.label.txt" backs `@QMS:CAPAViewer` and `@QMS338`.
      // Namespacing avoids id collisions across modules that both use a bare
      // numeric id (e.g. "77" meaning different text in SYS vs. QMS).
      const fileModule = basename(file).split('.')[0];
      try {
        const content = readFileSync(file, 'utf-8');
        for (const line of content.split('\n')) {
          const idx = line.indexOf('=');
          if (idx > 0) {
            const id = line.substring(0, idx).trim();
            const text = line.substring(idx + 1).trim();
            if (id && text) {
              labels.set(id, text);
              labels.set(`${fileModule}:${id}`, text);
            }
          }
        }
      } catch { /* skip */ }
    }
  }
  return labels;
}

/**
 * Resolve a raw AOT label reference to its loaded text. Two reference shapes
 * occur in practice (confirmed against the live sec DB, 2026-07-08):
 *   - colon-delimited:  `@Module:LabelId`   e.g. `@QMS:CAPAViewer`, `@SYS:130317`
 *   - concatenated:     `@ModuleLabelId`    e.g. `@SYS154926`, `@QMS338`
 * The previous implementation only matched the colon form, so every
 * concatenated-form reference (including plain `@SYS…` ids) fell through
 * unresolved regardless of whether the label text was loaded — see
 * docs/Sec-Service-Completeness-Concept.md gap #4.
 */
function resolveLabel(labelMap, raw) {
  if (!raw) return null;
  if (typeof raw !== 'string' || raw[0] !== '@') return raw;
  let prefix, id;
  let match = raw.match(/^@(\w+):(\w+)$/);
  if (match) {
    [, prefix, id] = match;
  } else {
    match = raw.match(/^@([A-Za-z]+)(\d+)$/);
    if (match) [, prefix, id] = match;
  }
  if (!prefix) return raw;
  const resolved = labelMap.get(`${prefix}:${id}`) || labelMap.get(id);
  return resolved || raw;
}

/** Detect Grant/Deny permission type from name (regex fallback). */
function detectPermissionType(name) {
  if (!name) return 'Grant';
  if (/^(TBG[\s_])?Deny[\s_]/i.test(name)) return 'Deny';
  return 'Grant';
}

/**
 * P4-05 / CR-SEC-005: pick the effective permission type for a role.
 * Priority:
 *   1. The raw DMF value if present and recognized as Grant or Deny
 *      (case-insensitive). Non-English DMF exports may use different
 *      casing — normalize once.
 *   2. The regex fallback against `detectPermissionType(name)`.
 *
 * Returns one of `'Grant' | 'Deny'`. Logs (once per process) when a
 * non-null DMF value is unrecognized so the next builder run surfaces
 * the schema drift instead of silently downgrading to the regex.
 */
let _warnedUnknownPerm = false;
function getEffectivePermissionType(rawDmfPerm, roleName) {
  if (rawDmfPerm) {
    const s = String(rawDmfPerm).trim().toLowerCase();
    if (s === 'grant' || s === 'allow') return 'Grant';
    if (s === 'deny' || s === 'block') return 'Deny';
    if (!_warnedUnknownPerm) {
      _warnedUnknownPerm = true;
      try { console.warn(`[sec-builder] unknown DMF permission type "${rawDmfPerm}" for role "${roleName}" — falling back to regex`); }
      catch { /* logger unavailable */ }
    }
  }
  return detectPermissionType(roleName);
}
// Exported for tests
export { getEffectivePermissionType };

/** Find a DMF file by trying multiple name variants.
 *  First tries each name as an exact path; if none hit, falls back to a
 *  case-insensitive directory scan (DMF names files by entity *label*, whose
 *  casing/spacing varies between exports, e.g. `System Security Role Duty.xml`). */
function findDmfFile(dir, ...names) {
  for (const name of names) {
    const path = join(dir, name);
    if (existsSync(path)) return path;
  }
  try {
    const wanted = new Set(names.map((n) => n.toLowerCase()));
    for (const entry of readdirSync(dir)) {
      if (wanted.has(entry.toLowerCase())) return join(dir, entry);
    }
  } catch { /* dir unreadable / missing — fall through to null */ }
  return null;
}

/**
 * Extract a field value from a flat XML entity string.
 * Assumes simple <TAG>value</TAG> structure (no attributes, no nesting).
 */
function extractField(xml, tag) {
  const open = `<${tag}>`;
  const start = xml.indexOf(open);
  if (start === -1) return null;
  const valStart = start + open.length;
  const end = xml.indexOf(`</${tag}>`, valStart);
  if (end === -1) return null;
  const val = xml.substring(valStart, end);
  return val || null;
}

/**
 * Stream-parse a large DMF XML file synchronously (handles multi-GB files).
 * Reads in chunks and extracts entity blocks via string matching.
 * Memory usage: ~8 MB buffer + whatever the callback accumulates.
 * @param {string} filePath - Path to the XML file
 * @param {string} entityTag - Entity element name (e.g. 'SYSTEMSECURITYDUTYENTITY')
 * @param {Function} extractFn - Called with inner XML string of each entity
 * @returns {number} Number of entities processed
 */
function streamParseLargeDmfXmlSync(filePath, entityTag, extractFn) {
  const fd = openSync(filePath, 'r');
  const CHUNK_SIZE = 8 * 1024 * 1024; // 8 MB chunks
  const readBuf = Buffer.alloc(CHUNK_SIZE);
  let remainder = '';
  let count = 0;
  const openTag = `<${entityTag}>`;
  const closeTag = `</${entityTag}>`;
  const openLen = openTag.length;
  const closeLen = closeTag.length;

  try {
    let bytesRead;
    while ((bytesRead = readSync(fd, readBuf, 0, CHUNK_SIZE, null)) > 0) {
      const text = remainder + readBuf.toString('utf-8', 0, bytesRead);
      let pos = 0;

      while (true) {
        const entityStart = text.indexOf(openTag, pos);
        if (entityStart === -1) { pos = text.length; break; }
        const entityEnd = text.indexOf(closeTag, entityStart + openLen);
        if (entityEnd === -1) {
          // Incomplete entity — carry over to next chunk
          remainder = text.substring(entityStart);
          pos = text.length;
          break;
        }
        extractFn(text.substring(entityStart + openLen, entityEnd));
        count++;
        pos = entityEnd + closeLen;
      }

      // If we consumed everything past the last entity, clear remainder
      if (pos >= text.length) remainder = '';
      else if (text.indexOf(openTag, pos) === -1) remainder = '';
      // else remainder was already set in the inner loop break
    }
  } finally {
    closeSync(fd);
  }
  return count;
}

/** Parse a DMF XML file, returns array of entity elements */
function parseDmfXml(xmlParser, filePath, entityNodeName, log) {
  if (!filePath) return [];
  log(`    Reading: ${basename(filePath)}`);
  const xml = readFileSync(filePath, 'utf-8');
  const parsed = xmlParser.parse(xml);
  const root = parsed.Document || parsed.document || parsed;
  const entities = root[entityNodeName] || [];
  return ensureArray(entities);
}

// ── Main Build Function ──────────────────────────────────────────────────────

/**
 * Build the security SQLite database.
 *
 * @param {Object} options
 * @param {string} options.packagesPathArg - Comma-separated PackagesLocalDirectory paths (or 'skip'/'')
 * @param {string} options.dmfInputDir     - Directory with DMF XML exports (or 'skip'/'')
 * @param {string} options.outputPath      - Output SQLite file path
 * @param {Function} [options.log]         - Logger function (default: console.log)
 * @returns {{ stats: Object, counts: Object, elapsed: string, fileSize: string }}
 */
export function buildSecurityDatabase({ packagesPathArg = '', dmfInputDir = '', outputPath, log = console.log }) {
  const xmlParser = createXmlParser();

  const stats = {
    aotRoles: 0, aotDuties: 0, aotPrivileges: 0, aotEntryPoints: 0,
    dmfRoles: 0, dmfSubRoles: 0, dmfDuties: 0, dmfDutyPrivileges: 0,
    dmfUsers: 0, dmfUserRoles: 0, dmfCompanyAssignments: 0,
    directPrivileges: 0, directEntityPerms: 0,
    transitiveSubRoles: 0,
  };

  log('===================================================');
  log('  D365FO Security Database Builder');
  log('===================================================');
  log(`  AOT source:  ${packagesPathArg || '(skip)'}`);
  log(`  DMF source:  ${dmfInputDir || '(skip)'}`);
  log(`  Output:      ${outputPath}`);
  log('');

  const startTime = Date.now();

  // Ensure output directory exists
  mkdirSync(dirname(outputPath), { recursive: true });

  // Build to a temp file, then atomically rename to avoid serving a partial DB
  const tmpOutputPath = outputPath + '.tmp';
  rmSync(tmpOutputPath, { force: true });

  const db = new Database(tmpOutputPath);
  db.pragma('journal_mode = OFF');
  db.pragma('synchronous = OFF');
  db.pragma('cache_size = -200000');
  db.pragma('locking_mode = EXCLUSIVE');

  // Create schema
  db.exec(SCHEMA);

  // Prepared statements
  // P4-05: roles is now a 10-column table (added `dmf_permission_type`).
  // Use named columns instead of positional `VALUES (?,...)` so future
  // schema additions don't silently shift positions.
  const stmts = {
    insertRole: db.prepare(`INSERT OR REPLACE INTO roles
      (role_id, role_name, module_id, label, description, license_type,
       permission_type, dmf_permission_type, is_profile, source)
      VALUES (?,?,?,?,?,?,?,?,?,?)`),
    insertDuty: db.prepare('INSERT OR REPLACE INTO duties VALUES (?,?,?,?)'),
    insertRoleDuty: db.prepare('INSERT OR REPLACE INTO role_duties VALUES (?,?,?)'),
    insertPrivilege: db.prepare('INSERT OR REPLACE INTO privileges VALUES (?,?,?)'),
    insertDutyPriv: db.prepare('INSERT OR REPLACE INTO duty_privileges VALUES (?,?)'),
    insertEntryPoint: db.prepare('INSERT OR REPLACE INTO privilege_entry_points VALUES (?,?,?,?,?,?,?,?,?,?)'),
    insertSubRole: db.prepare('INSERT OR REPLACE INTO role_subroles VALUES (?,?,?)'),
    insertUser: db.prepare('INSERT OR REPLACE INTO users VALUES (?,?,?,?,?)'),
    insertUserRole: db.prepare('INSERT OR REPLACE INTO user_roles VALUES (?,?)'),
    insertUserRoleCompany: db.prepare('INSERT OR REPLACE INTO user_role_companies VALUES (?,?,?)'),
    insertDirectPriv: db.prepare('INSERT OR REPLACE INTO role_direct_privileges VALUES (?,?)'),
    // The System Security Permissions matrix emits MULTIPLE rows per
    // (role, resource) — one per privilege path — so a plain INSERT OR REPLACE
    // would be last-write-wins and could silently overwrite a Deny with a Grant.
    // Merge with Deny-wins per operation instead: Deny if either side denies,
    // else Allow if either grants, else keep whatever is set.
    insertDirectEntityPerm: db.prepare(`INSERT INTO role_direct_entity_permissions
      (role_id, entity_name, resource_type, grant_read, grant_create, grant_update, grant_delete, grant_correct, grant_invoke)
      VALUES (?,?,?,?,?,?,?,?,?)
      ON CONFLICT(role_id, entity_name) DO UPDATE SET
        resource_type = COALESCE(role_direct_entity_permissions.resource_type, excluded.resource_type),
        grant_read   = CASE WHEN role_direct_entity_permissions.grant_read='Deny'   OR excluded.grant_read='Deny'   THEN 'Deny' WHEN role_direct_entity_permissions.grant_read='Allow'   OR excluded.grant_read='Allow'   THEN 'Allow' ELSE COALESCE(excluded.grant_read,   role_direct_entity_permissions.grant_read)   END,
        grant_create = CASE WHEN role_direct_entity_permissions.grant_create='Deny' OR excluded.grant_create='Deny' THEN 'Deny' WHEN role_direct_entity_permissions.grant_create='Allow' OR excluded.grant_create='Allow' THEN 'Allow' ELSE COALESCE(excluded.grant_create, role_direct_entity_permissions.grant_create) END,
        grant_update = CASE WHEN role_direct_entity_permissions.grant_update='Deny' OR excluded.grant_update='Deny' THEN 'Deny' WHEN role_direct_entity_permissions.grant_update='Allow' OR excluded.grant_update='Allow' THEN 'Allow' ELSE COALESCE(excluded.grant_update, role_direct_entity_permissions.grant_update) END,
        grant_delete = CASE WHEN role_direct_entity_permissions.grant_delete='Deny' OR excluded.grant_delete='Deny' THEN 'Deny' WHEN role_direct_entity_permissions.grant_delete='Allow' OR excluded.grant_delete='Allow' THEN 'Allow' ELSE COALESCE(excluded.grant_delete, role_direct_entity_permissions.grant_delete) END,
        grant_correct= CASE WHEN role_direct_entity_permissions.grant_correct='Deny' OR excluded.grant_correct='Deny' THEN 'Deny' WHEN role_direct_entity_permissions.grant_correct='Allow' OR excluded.grant_correct='Allow' THEN 'Allow' ELSE COALESCE(excluded.grant_correct, role_direct_entity_permissions.grant_correct) END,
        grant_invoke = CASE WHEN role_direct_entity_permissions.grant_invoke='Deny' OR excluded.grant_invoke='Deny' THEN 'Deny' WHEN role_direct_entity_permissions.grant_invoke='Allow' OR excluded.grant_invoke='Allow' THEN 'Allow' ELSE COALESCE(excluded.grant_invoke, role_direct_entity_permissions.grant_invoke) END`),
    insertSearch: db.prepare('INSERT INTO sec_search VALUES (?,?,?,?)'),
    insertMeta: db.prepare('INSERT OR REPLACE INTO sec_metadata VALUES (?,?)'),
  };

  // ── Phase 1: Parse AOT Security Metadata ───────────────────────────────────

  let packagesPaths = [];
  let labelsLoaded = 0;  // visible at the DATA QUALITY CHECKS site below

  if (packagesPathArg && packagesPathArg.toLowerCase() !== 'skip') {
    log('[1/5] Parsing AOT security metadata...');

    packagesPaths = packagesPathArg.split(',').map(p => resolve(p.trim()));
    let labelMap = new Map();

    for (const pp of packagesPaths) {
      if (existsSync(pp)) {
        log(`  Loading labels from: ${pp}`);
        const labels = loadLabels(pp);
        for (const [k, v] of labels) labelMap.set(k, v);
      }
    }
    labelsLoaded = labelMap.size;
    log(`  Labels loaded: ${labelsLoaded}`);

    const rl = (raw) => resolveLabel(labelMap, raw);

    function processAxType(axTypeName, extractFn) {
      const dirs = packagesPaths.flatMap(p => existsSync(p) ? findAxDirs(p, axTypeName) : []);
      let count = 0;
      for (const dir of dirs) {
        const files = readXmlFiles(dir);
        for (const filePath of files) {
          try {
            const content = readFileSync(filePath, 'utf-8');
            const parsed = xmlParser.parse(content);
            if (parsed) extractFn(parsed, filePath);
            count++;
          } catch { /* skip malformed files */ }
        }
      }
      return count;
    }

    const aotTransaction = db.transaction(() => {
      // Security Roles
      const roleCount = processAxType('AxSecurityRole', (parsed, filePath) => {
        const r = parsed.AxSecurityRole?.[0] || parsed.AxSecurityRole;
        if (!r || !r.Name) return;
        const mod = getModuleFromPath(filePath, packagesPaths);
        const duties = ensureArray(r.Duties?.AxSecurityDutyReference).map(d => d.Name).filter(Boolean);
        // P4-05: AOT path has no DMF source for permission_type, so dmf_permission_type
        // stays NULL and the regex fallback (`detectPermissionType`) is the effective value.
        stmts.insertRole.run(
          r.Name, r.Name, mod, rl(r.Label) || null, rl(r.Description) || null,
          null, detectPermissionType(r.Name), null, 0, 'aot'
        );
        for (const dutyName of duties) {
          stmts.insertRoleDuty.run(r.Name, dutyName, 'Grant');
        }
        stats.aotRoles++;
      });
      log(`  AxSecurityRole: ${roleCount} files processed`);

      // Security Duties
      const dutyCount = processAxType('AxSecurityDuty', (parsed, filePath) => {
        const d = parsed.AxSecurityDuty?.[0] || parsed.AxSecurityDuty;
        if (!d || !d.Name) return;
        const mod = getModuleFromPath(filePath, packagesPaths);
        const privs = ensureArray(d.Privileges?.AxSecurityPrivilegeReference).map(p => p.Name).filter(Boolean);
        stmts.insertDuty.run(d.Name, rl(d.Label) || null, mod, rl(d.Description) || null);
        for (const privName of privs) {
          stmts.insertDutyPriv.run(d.Name, privName);
        }
        stats.aotDuties++;
      });
      log(`  AxSecurityDuty: ${dutyCount} files processed`);

      // Security Privileges
      const privCount = processAxType('AxSecurityPrivilege', (parsed, filePath) => {
        const p = parsed.AxSecurityPrivilege?.[0] || parsed.AxSecurityPrivilege;
        if (!p || !p.Name) return;
        const mod = getModuleFromPath(filePath, packagesPaths);
        stmts.insertPrivilege.run(p.Name, mod, rl(p.Label) || null);
        const eps = ensureArray(p.EntryPoints?.AxSecurityEntryPointReference);
        for (const ep of eps) {
          if (!ep.Name) continue;
          const grant = ep.Grant || {};
          stmts.insertEntryPoint.run(
            p.Name, ep.Name,
            ep.ObjectType || null, ep.ObjectName || null,
            grant.Read || null, grant.Create || null,
            grant.Update || null, grant.Delete || null,
            grant.Correct || null, grant.Invoke || null,
          );
          stats.aotEntryPoints++;
        }
        stats.aotPrivileges++;
      });
      log(`  AxSecurityPrivilege: ${privCount} files processed`);
    });

    aotTransaction();
    log(`  AOT totals: ${stats.aotRoles} roles, ${stats.aotDuties} duties, ${stats.aotPrivileges} privileges, ${stats.aotEntryPoints} entry points`);
  } else {
    log('[1/5] Skipping AOT parsing (no packages path)');
  }

  // ── Phase 2: Parse DMF Exports ─────────────────────────────────────────────

  if (dmfInputDir && dmfInputDir.toLowerCase() !== 'skip' && existsSync(dmfInputDir)) {
    log('\n[2/5] Parsing DMF exports from PROD...');

    const aotIdUpper = new Map();
    for (const row of db.prepare('SELECT role_id, role_name FROM roles').all()) {
      aotIdUpper.set(row.role_id.toUpperCase(), row.role_id);
    }

    // Pre-prepare statements used inside DMF loops
    // P4-05: updateRole now also stores the raw DMF permission_type alongside
    // the effective one. Bind order: id, name, label, description, license,
    // effective_permission_type, dmf_permission_type, where_id.
    const dmfStmts = {
      updateRole: db.prepare(`UPDATE roles SET role_id = ?, role_name = ?, label = COALESCE(label, ?),
        description = COALESCE(description, ?), license_type = ?,
        permission_type = ?, dmf_permission_type = ?, source = 'aot+dmf'
        WHERE role_id = ?`),
      rekeyRoleDuties: db.prepare('UPDATE OR IGNORE role_duties SET role_id = ? WHERE role_id = ?'),
      deleteOldRoleDuties: db.prepare('DELETE FROM role_duties WHERE role_id = ?'),
      findDuty: db.prepare('SELECT 1 FROM duties WHERE duty_id = ?'),
      findRolePerm: db.prepare('SELECT permission_type FROM roles WHERE role_id = ?'),
      findUser: db.prepare('SELECT 1 FROM users WHERE user_id = ?'),
    };

    const dmfTransaction = db.transaction(() => {
      // 2a: Roles
      // P4-04 / CR-SEC-003: track per-skip diagnostics so missing roles
      // (e.g. "TBG Ledger Calendar Security Role") can be traced from the
      // build log without re-running the importer. Counters land in
      // `stats.roles` and individual skip reasons accumulate in
      // `stats.skippedRoles` (capped at 100 to bound memory).
      stats.roles = { totalInDmf: 0, imported: 0, mergedWithAot: 0, skipped: 0 };
      stats.skippedRoles = [];
      const SKIP_LOG_CAP = 100;
      const recordSkip = (id, name, reason) => {
        stats.roles.skipped++;
        if (stats.skippedRoles.length < SKIP_LOG_CAP) {
          stats.skippedRoles.push({ id: id ?? null, name: name ?? null, reason });
        }
      };

      const rolesFile = findDmfFile(dmfInputDir, 'System Security Role.xml', 'SystemSecurityRole.xml');
      if (rolesFile) {
        const entities = parseDmfXml(xmlParser, rolesFile, 'SYSTEMSECURITYROLEENTITY', log);
        const seenIds = new Set();
        let mergedCount = 0;
        for (const e of entities) {
          stats.roles.totalInDmf++;
          const roleId = e.SECURITYROLEIDENTIFIER;
          const roleName = e.SECURITYROLENAME;
          if (!roleId) { recordSkip(null, roleName, 'missing-id'); continue; }
          if (!roleName) { recordSkip(roleId, null, 'missing-name'); continue; }
          if (seenIds.has(roleId.toUpperCase())) {
            recordSkip(roleId, roleName, 'duplicate');
            continue;
          }
          seenIds.add(roleId.toUpperCase());
          const existingAotId = aotIdUpper.get(roleId.toUpperCase());
          if (existingAotId) {
            const rawDmfPerm = e.PERMISSIONTYPE || e.SECURITYROLEPERMISSIONTYPE || e.ROLEPERMISSIONTYPE || null;
            const effectivePerm = getEffectivePermissionType(rawDmfPerm, roleName);
            dmfStmts.updateRole.run(roleId, roleName, e.DESCRIPTION || null, e.DESCRIPTION || null,
              e.USERLICENSETYPE || null, effectivePerm, rawDmfPerm, existingAotId);
            if (roleId !== existingAotId) {
              dmfStmts.rekeyRoleDuties.run(roleId, existingAotId);
              dmfStmts.deleteOldRoleDuties.run(existingAotId);
            }
            aotIdUpper.delete(existingAotId.toUpperCase());
            aotIdUpper.set(roleId.toUpperCase(), roleId);
            mergedCount++;
          } else {
            // P4-05 / CR-SEC-005: capture the raw DMF permission type when it
            // is present (any of `PERMISSIONTYPE`, `SECURITYROLEPERMISSIONTYPE`,
            // `ROLEPERMISSIONTYPE` — DMF field naming varies across versions).
            // The regex fallback fills `permission_type` so existing readers
            // keep working; the new column is the source of truth for non-
            // English / non-conventional names.
            const rawDmfPerm = e.PERMISSIONTYPE || e.SECURITYROLEPERMISSIONTYPE || e.ROLEPERMISSIONTYPE || null;
            const effectivePerm = getEffectivePermissionType(rawDmfPerm, roleName);
            stmts.insertRole.run(
              roleId, roleName, null, e.DESCRIPTION || null, e.DESCRIPTION || null,
              e.USERLICENSETYPE || null, effectivePerm, rawDmfPerm, 0, 'dmf'
            );
          }
          stats.dmfRoles++;
          stats.roles.imported++;
        }
        stats.roles.mergedWithAot = mergedCount;
        const sample = stats.skippedRoles.slice(0, 10).map(s => `${s.id || '(no-id)'}/${s.name || '(no-name)'}: ${s.reason}`).join('; ');
        log(`    Roles: total_in_dmf=${stats.roles.totalInDmf}, imported=${stats.roles.imported} (${mergedCount} merged with AOT), skipped=${stats.roles.skipped}` +
            (stats.roles.skipped > 0 ? ` (first ${Math.min(10, stats.roles.skipped)}: ${sample})` : ''));
      }

      // 2b: Sub-Roles
      const subRolesFile = findDmfFile(dmfInputDir,
        'System Security Sub Role V2.xml', 'SystemSecuritySubRoleV2.xml');
      if (subRolesFile) {
        const entities = parseDmfXml(xmlParser, subRolesFile, 'SYSTEMSECURITYSUBROLEENTITYV2', log);
        for (const e of entities) {
          const parentId = e.SECURITYROLEIDENTIFIER;
          const childId = e.SECURITYSUBROLEIDENTIFIER;
          if (!parentId || !childId) continue;
          stmts.insertSubRole.run(parentId, childId, 0);
          stats.dmfSubRoles++;
        }
        log(`    Sub-roles: ${stats.dmfSubRoles}`);

        // Flatten transitive sub-roles via BFS (bulk-load adjacency list)
        const adj = new Map();
        for (const row of db.prepare('SELECT parent_role_id, child_role_id FROM role_subroles').all()) {
          if (!adj.has(row.parent_role_id)) adj.set(row.parent_role_id, []);
          adj.get(row.parent_role_id).push(row.child_role_id);
        }
        for (const [parentId, directChildren] of adj) {
          const visited = new Set();
          const queue = [...directChildren];
          while (queue.length > 0) {
            const childId = queue.shift();
            if (visited.has(childId)) continue;
            visited.add(childId);
            for (const n of adj.get(childId) || []) {
              if (!visited.has(n)) queue.push(n);
            }
          }
          const directSet = new Set(directChildren);
          for (const transId of visited) {
            if (!directSet.has(transId)) {
              try {
                stmts.insertSubRole.run(parentId, transId, 1);
                stats.transitiveSubRoles++;
              } catch { /* duplicate -- skip */ }
            }
          }
        }
        log(`    Transitive sub-roles added: ${stats.transitiveSubRoles}`);
      }

      // 2c: Role-Duty Assignments
      const aotDutyUpper = new Map();
      for (const row of db.prepare('SELECT duty_id FROM duties').all()) {
        aotDutyUpper.set(row.duty_id.toUpperCase(), row.duty_id);
      }

      const roleDutiesFile = findDmfFile(dmfInputDir,
        'System Security Role Duty.xml', 'SystemSecurityRoleDuty.xml');
      if (roleDutiesFile) {
        const entities = parseDmfXml(xmlParser, roleDutiesFile, 'SYSTEMSECURITYROLEDUTYENTITY', log);
        for (const e of entities) {
          const roleId = e.SECURITYROLEIDENTIFIER;
          const dmfDutyId = e.SECURITYDUTYIDENTIFIER;
          const dutyName = e.SECURITYDUTYNAME;
          if (!roleId || !dmfDutyId) continue;
          const existingAotDutyId = aotDutyUpper.get(dmfDutyId.toUpperCase());
          const dutyId = existingAotDutyId || dmfDutyId;
          if (!existingAotDutyId) {
            if (!dmfStmts.findDuty.get(dutyId)) {
              stmts.insertDuty.run(dutyId, dutyName || null, null, null);
              aotDutyUpper.set(dutyId.toUpperCase(), dutyId);
            }
          }
          const parentPerm = dmfStmts.findRolePerm.get(roleId)?.permission_type || 'Grant';
          const perm = (parentPerm === 'Deny' || detectPermissionType(dutyName) === 'Deny') ? 'Deny' : 'Grant';
          stmts.insertRoleDuty.run(roleId, dutyId, perm);
          stats.dmfDuties++;
        }
        log(`    Role-duty assignments: ${stats.dmfDuties}`);
      }

      // 2d: Duty-Privilege Mappings (from System Security Duty DMF export)
      //
      // The full DMF export for `System Security Duty.xml` is ~4 GB with
      // 10M+ entities. The earlier implementation accumulated every
      // (duty,priv) pair in a JS Set for dedup before insertion — that
      // breaks Node's 4 GB default heap around 8M entries. INSERT OR
      // REPLACE in SQLite is already idempotent on the (duty_id,
      // privilege_name) PK, so we dedup at the DB layer instead and
      // insert directly inside the stream callback.
      const dutyPrivFile = findDmfFile(dmfInputDir,
        'System Security Duty.xml', 'SystemSecurityDuty.xml');
      if (dutyPrivFile) {
        const fileSize = statSync(dutyPrivFile).size;
        const sizeMB = (fileSize / (1024 * 1024)).toFixed(0);

        const existingPrivsUpper = new Map();
        for (const row of db.prepare('SELECT privilege_name FROM privileges').all()) {
          existingPrivsUpper.set(row.privilege_name.toUpperCase(), row.privilege_name);
        }

        let inserted = 0;
        const onEntity = (rawDutyId, dutyName, rawPrivId, privLabel) => {
          if (!rawDutyId || !rawPrivId) return;
          const resolvedDutyId = aotDutyUpper.get(rawDutyId.toUpperCase()) || rawDutyId;
          const resolvedPrivId = existingPrivsUpper.get(rawPrivId.toUpperCase()) || rawPrivId;
          if (!aotDutyUpper.has(rawDutyId.toUpperCase())) {
            stmts.insertDuty.run(resolvedDutyId, dutyName || null, null, null);
            aotDutyUpper.set(resolvedDutyId.toUpperCase(), resolvedDutyId);
          }
          if (!existingPrivsUpper.has(rawPrivId.toUpperCase())) {
            stmts.insertPrivilege.run(resolvedPrivId, null, privLabel || null);
            existingPrivsUpper.set(rawPrivId.toUpperCase(), resolvedPrivId);
          }
          stmts.insertDutyPriv.run(resolvedDutyId, resolvedPrivId);
          inserted++;
        };

        if (fileSize > 100 * 1024 * 1024) {
          // Large file (>100 MB): stream + direct-insert (no in-memory Set)
          log(`    Reading (streaming, ${sizeMB} MB): ${basename(dutyPrivFile)}`);
          const entityCount = streamParseLargeDmfXmlSync(
            dutyPrivFile, 'SYSTEMSECURITYDUTYENTITY',
            (inner) => onEntity(
              extractField(inner, 'SECURITYDUTYIDENTIFIER'),
              extractField(inner, 'SECURITYDUTYNAME'),
              extractField(inner, 'SECURITYPRIVILEGEIDENTIFIER'),
              extractField(inner, 'SECURITYPRIVILEGENAME'),
            ),
          );
          log(`    Parsed ${entityCount.toLocaleString()} entities → ${inserted.toLocaleString()} duty-privilege insertions (INSERT OR REPLACE dedupes)`);
        } else {
          // Small file: regular DOM parser
          const entities = parseDmfXml(xmlParser, dutyPrivFile, 'SYSTEMSECURITYDUTYENTITY', log);
          for (const e of entities) {
            onEntity(e.SECURITYDUTYIDENTIFIER, e.SECURITYDUTYNAME,
              e.SECURITYPRIVILEGEIDENTIFIER, e.SECURITYPRIVILEGENAME);
          }
          log(`    Duty-privilege mappings: ${inserted.toLocaleString()}`);
        }
        stats.dmfDutyPrivileges = inserted;
      }

      // 2d-bis: Duty-Privilege Mappings from System Security Duty V2 (CR-SEC-006)
      // -------------------------------------------------------------------------
      // The V1 `System Security Duty.xml` exports duty→privilege pairs but does
      // NOT cover all DMF-only duties. As of build 2026-03-25, 1,562 of 2,623
      // duties (~60%) had zero privileges in the live DB — including the entire
      // CollectionLetter family. The V2 entity (`SYSTEMSECURITYDUTYV2ENTITY` in
      // `System Security Duty V2.xml`) is the authoritative source for duty→
      // privilege pairs across the full duty catalog.
      //
      // Field shape per the DMF target entity:
      //   SECURITYDUTYIDENTIFIER     — duty id (matches V1 + AOT)
      //   SECURITYPRIVILEGEIDENTIFIER — privilege name
      // Same identifiers as V1; only the wrapping entity tag differs.
      const dutyPrivV2File = findDmfFile(dmfInputDir,
        'System Security Duty V2.xml', 'SystemSecurityDutyV2.xml');
      stats.dmfDutyPrivilegesV2 = 0;
      stats.dmfDutyV2Skipped = 0;
      stats.dmfDutyV2Missing = !dutyPrivV2File;
      if (dutyPrivV2File) {
        const fileSize = statSync(dutyPrivV2File).size;
        const sizeMB = (fileSize / (1024 * 1024)).toFixed(0);

        // Reuse the V1 collector pattern but with a V2 entity tag and a fresh
        // pair set — pairs added here go through the same insert pipeline.
        const v2Pairs = new Set();
        const v2DutyNames = new Map();
        const v2PrivLabels = new Map();

        const collectV2 = (dutyId, dutyName, privId, privLabel) => {
          if (!dutyId || !privId) {
            stats.dmfDutyV2Skipped++;
            return;
          }
          v2Pairs.add(`${dutyId}\t${privId}`);
          if (dutyName && !v2DutyNames.has(dutyId)) v2DutyNames.set(dutyId, dutyName);
          if (privLabel && !v2PrivLabels.has(privId)) v2PrivLabels.set(privId, privLabel);
        };

        if (fileSize > 100 * 1024 * 1024) {
          log(`    Reading V2 (streaming, ${sizeMB} MB): ${basename(dutyPrivV2File)}`);
          const cnt = streamParseLargeDmfXmlSync(
            dutyPrivV2File, 'SYSTEMSECURITYDUTYV2ENTITY',
            (inner) => collectV2(
              extractField(inner, 'SECURITYDUTYIDENTIFIER'),
              extractField(inner, 'SECURITYDUTYNAME'),
              extractField(inner, 'SECURITYPRIVILEGEIDENTIFIER'),
              extractField(inner, 'SECURITYPRIVILEGENAME'),
            ),
          );
          log(`    V2 parsed ${cnt.toLocaleString()} entities → ${v2Pairs.size.toLocaleString()} unique pairs`);
        } else {
          const entities = parseDmfXml(xmlParser, dutyPrivV2File, 'SYSTEMSECURITYDUTYV2ENTITY', log);
          for (const e of entities) {
            collectV2(e.SECURITYDUTYIDENTIFIER, e.SECURITYDUTYNAME,
              e.SECURITYPRIVILEGEIDENTIFIER, e.SECURITYPRIVILEGENAME);
          }
          log(`    V2 found ${v2Pairs.size.toLocaleString()} unique duty-privilege pairs`);
        }

        // Refresh the privilege lookup — V1 ingestion above may have added rows.
        const v2PrivsUpper = new Map();
        for (const row of db.prepare('SELECT privilege_name FROM privileges').all()) {
          v2PrivsUpper.set(row.privilege_name.toUpperCase(), row.privilege_name);
        }

        let v2Inserted = 0;
        for (const pair of v2Pairs) {
          const [rawDutyId, rawPrivId] = pair.split('\t');
          const resolvedDutyId = aotDutyUpper.get(rawDutyId.toUpperCase()) || rawDutyId;
          const resolvedPrivId = v2PrivsUpper.get(rawPrivId.toUpperCase()) || rawPrivId;

          if (!aotDutyUpper.has(rawDutyId.toUpperCase())) {
            stmts.insertDuty.run(resolvedDutyId, v2DutyNames.get(rawDutyId) || null, null, null);
            aotDutyUpper.set(resolvedDutyId.toUpperCase(), resolvedDutyId);
          }
          if (!v2PrivsUpper.has(rawPrivId.toUpperCase())) {
            stmts.insertPrivilege.run(resolvedPrivId, null, v2PrivLabels.get(rawPrivId) || null);
            v2PrivsUpper.set(resolvedPrivId.toUpperCase(), resolvedPrivId);
          }
          // INSERT OR REPLACE on the (duty_id, privilege_name) PK is idempotent —
          // V1 + V2 overlap is fine; the pair is a deduplicated set.
          stmts.insertDutyPriv.run(resolvedDutyId, resolvedPrivId);
          v2Inserted++;
        }
        stats.dmfDutyPrivilegesV2 = v2Inserted;
        log(`    Duty-privilege mappings (V2): inserted=${v2Inserted.toLocaleString()}, skipped=${stats.dmfDutyV2Skipped}`);
      } else {
        log(`    Duty V2 DMF not found — duty_privileges may be incomplete (CR-SEC-006). Looked for: System Security Duty V2.xml`);
      }

      // 2e: User Information
      const usersFile = findDmfFile(dmfInputDir,
        'User information.xml', 'UserInformation.xml', 'SystemUsers.xml');
      if (usersFile) {
        // Parse once, then probe for known entity names
        log(`    Reading: ${basename(usersFile)}`);
        const usersXml = readFileSync(usersFile, 'utf-8');
        const usersParsed = xmlParser.parse(usersXml);
        const usersRoot = usersParsed.Document || usersParsed;
        const allEntities = ensureArray(
          usersRoot.SYSTEMUSERENTITY || usersRoot.USERINFOENTITY || []
        );
        for (const e of allEntities) {
          const userId = e.USERID || e.USER;
          if (!userId) continue;
          const enableVal = e.ENABLE || e.ISENABLED || e.USERINFOENABLE || e.ENABLED || '';
          const enabled = /^(Yes|1|true|Enabled)$/i.test(String(enableVal)) ? 1 : 0;
          const personName = e.PERSONNAME || e.USERNAME || e.NAME || null;
          const email = e.EMAIL || e.EMAILADDRESS || null;
          const company = e.COMPANY || e.DEFAULTCOMPANY || null;
          stmts.insertUser.run(userId, personName, email, enabled, company);
          stats.dmfUsers++;
        }
        log(`    Users: ${stats.dmfUsers}`);
      }

      // 2f: User-Role Assignments
      const userRolesFile = findDmfFile(dmfInputDir,
        'SystemSecurityUserRoleEntity.xml',
        'Security user role association.xml',
        'UserRoleAssociation.xml');
      if (userRolesFile) {
        // Parse once, extract both possible entity names
        log(`    Reading: ${basename(userRolesFile)}`);
        const urXml = readFileSync(userRolesFile, 'utf-8');
        const urParsed = xmlParser.parse(urXml);
        const urRoot = urParsed.Document || urParsed;
        const entities = ensureArray(urRoot.SYSTEMSECURITYUSERROLEENTITY || [])
          .concat(ensureArray(urRoot.SYSTEMSECURITYUSERROLEASSOCIATIONENTITY || []));
        const enabledPairs = new Set();
        for (const e of entities) {
          const userId = e.USERID;
          const roleId = e.SECURITYROLEIDENTIFIER;
          const status = e.ASSIGNMENTSTATUS;
          if (!userId || !roleId) continue;
          if (status !== 'Enabled') continue;
          if (!dmfStmts.findUser.get(userId)) {
            stmts.insertUser.run(userId, null, null, 1, null);
          }
          stmts.insertUserRole.run(userId, roleId);
          enabledPairs.add(`${userId}|${roleId}`);
          stats.dmfUserRoles++;
        }
        log(`    User-role assignments (enabled): ${stats.dmfUserRoles}`);

        // 2g: Company-Scoped Role Restrictions
        const orgFile = findDmfFile(dmfInputDir,
          'SystemSecurityUserRoleOrganizationEntity.xml',
          'System security user role organization.xml');
        if (orgFile) {
          const orgEntities = parseDmfXml(xmlParser, orgFile, 'SYSTEMSECURITYUSERROLEORGANIZATIONENTITY', log);
          for (const e of orgEntities) {
            const userId = e.USERID;
            const roleId = e.SECURITYROLEIDENTIFIER;
            const orgType = e.ORGANIZATIONTYPE;
            const orgId = e.ORGANIZATIONID;
            if (orgType !== 'LegalEntity' || !orgId || !userId || !roleId) continue;
            if (!enabledPairs.has(`${userId}|${roleId}`)) continue;
            stmts.insertUserRoleCompany.run(userId, roleId, orgId);
            stats.dmfCompanyAssignments++;
          }
          log(`    Company-scoped assignments: ${stats.dmfCompanyAssignments}`);
        }
      }

      // 2h: Direct Role-Privilege Mappings (CR-SEC-007)
      // -------------------------------------------------------------------
      // `System Security Privilege.xml` exports the DIRECT role→privilege
      // graph (bypassing duties). In a DMF-only build this is the only way
      // to complete the role-privilege chain for roles whose AOT-side
      // duty tree isn't present. Entity shape:
      //   SYSTEMSECURITYPRIVILEGEENTITY
      //     SECURITYPRIVILEGEIDENTIFIER — privilege name (PK in privileges)
      //     SECURITYPRIVILEGENAME      — human label
      //     SECURITYROLEIDENTIFIER     — role id (GUID matching roles.role_id
      //                                  populated from System Security Role.xml)
      //     SECURITYROLENAME           — role display name
      // The full DMF export is multi-GB, so stream even though the current
      // sample is 55 MB.
      const privFile = findDmfFile(dmfInputDir,
        'System Security Privilege.xml', 'SystemSecurityPrivilege.xml');
      stats.dmfDirectPrivileges = 0;
      stats.dmfDirectPrivilegesSkipped = 0;
      if (privFile) {
        const fileSize = statSync(privFile).size;
        const sizeMB = (fileSize / (1024 * 1024)).toFixed(0);

        const existingPrivsUpper = new Map();
        for (const row of db.prepare('SELECT privilege_name FROM privileges').all()) {
          existingPrivsUpper.set(row.privilege_name.toUpperCase(), row.privilege_name);
        }

        const onPrivEntity = (privId, privLabel, roleId) => {
          if (!privId || !roleId) { stats.dmfDirectPrivilegesSkipped++; return; }
          const resolvedPrivId = existingPrivsUpper.get(privId.toUpperCase()) || privId;
          if (!existingPrivsUpper.has(privId.toUpperCase())) {
            stmts.insertPrivilege.run(resolvedPrivId, null, privLabel || null);
            existingPrivsUpper.set(privId.toUpperCase(), resolvedPrivId);
          }
          // INSERT OR REPLACE on (role_id, privilege_name) PK — idempotent.
          stmts.insertDirectPriv.run(roleId, resolvedPrivId);
          stats.dmfDirectPrivileges++;
        };

        if (fileSize > 10 * 1024 * 1024) {
          log(`    Reading Privilege (streaming, ${sizeMB} MB): ${basename(privFile)}`);
          const cnt = streamParseLargeDmfXmlSync(
            privFile, 'SYSTEMSECURITYPRIVILEGEENTITY',
            (inner) => onPrivEntity(
              extractField(inner, 'SECURITYPRIVILEGEIDENTIFIER'),
              extractField(inner, 'SECURITYPRIVILEGENAME'),
              extractField(inner, 'SECURITYROLEIDENTIFIER'),
            ),
          );
          log(`    Privilege parsed ${cnt.toLocaleString()} entities → ${stats.dmfDirectPrivileges.toLocaleString()} direct role-privilege rows`);
        } else {
          const entities = parseDmfXml(xmlParser, privFile, 'SYSTEMSECURITYPRIVILEGEENTITY', log);
          for (const e of entities) {
            onPrivEntity(e.SECURITYPRIVILEGEIDENTIFIER, e.SECURITYPRIVILEGENAME, e.SECURITYROLEIDENTIFIER);
          }
          log(`    Privilege: ${stats.dmfDirectPrivileges.toLocaleString()} direct role-privilege rows`);
        }
        stats.directPrivileges += stats.dmfDirectPrivileges;
      } else {
        log('    System Security Privilege.xml not found — role_direct_privileges will be AOT-only');
      }

      // 2i: Direct Role-Entity Permissions (CR-SEC-007)
      // -------------------------------------------------------------------
      // `System Security Permissions.xml` exports role→resource CRUD
      // permissions directly (menu items, tables, entities). Entity shape:
      //   SYSTEMSECURITYPERMISSIONENTITY
      //     CORRECTACCESS, CREATEACCESS, DELETEACCESS,
      //     INVOKEACCESS, READACCESS, UPDATEACCESS — 0=Unset,1=Grant,2=Deny
      //     RESOURCENAME, RESOURCETYPE
      //     SECURITYROLEIDENTIFIER, SECURITYROLENAME
      const permsFile = findDmfFile(dmfInputDir,
        'System Security Permissions.xml', 'SystemSecurityPermissions.xml');
      stats.dmfDirectEntityPerms = 0;
      stats.dmfDirectEntityPermsSkipped = 0;
      stats.dmfDirectEntityPermsAllZero = 0;
      if (permsFile) {
        const fileSize = statSync(permsFile).size;
        const sizeMB = (fileSize / (1024 * 1024)).toFixed(0);

        // DMF codes 0/1/2 → 'Allow'/'Deny'/null, compatible with formatCrudFlag.
        const mapAccess = (code) => {
          if (code === '1' || code === 1) return 'Allow';
          if (code === '2' || code === 2) return 'Deny';
          return null;
        };

        const onPermEntity = (roleId, resourceName, resourceType, read, create, update, del, correct, invoke) => {
          if (!roleId || !resourceName) { stats.dmfDirectEntityPermsSkipped++; return; }
          const gr = mapAccess(read), gc = mapAccess(create), gu = mapAccess(update),
                gd = mapAccess(del), gco = mapAccess(correct), gi = mapAccess(invoke);
          // Skip all-zero rows (every access Unset): the resource is referenced
          // but no operation is granted or denied → no information value. The
          // DMF entity normally excludes these, but guard regardless of how the
          // export was filtered.
          if (!gr && !gc && !gu && !gd && !gco && !gi) { stats.dmfDirectEntityPermsAllZero++; return; }
          stmts.insertDirectEntityPerm.run(
            roleId, resourceName, resourceType || null,
            gr, gc, gu, gd, gco, gi,
          );
          stats.dmfDirectEntityPerms++;
        };

        if (fileSize > 10 * 1024 * 1024) {
          log(`    Reading Permissions (streaming, ${sizeMB} MB): ${basename(permsFile)}`);
          const cnt = streamParseLargeDmfXmlSync(
            permsFile, 'SYSTEMSECURITYPERMISSIONENTITY',
            (inner) => onPermEntity(
              extractField(inner, 'SECURITYROLEIDENTIFIER'),
              extractField(inner, 'RESOURCENAME'),
              extractField(inner, 'RESOURCETYPE'),
              extractField(inner, 'READACCESS'),
              extractField(inner, 'CREATEACCESS'),
              extractField(inner, 'UPDATEACCESS'),
              extractField(inner, 'DELETEACCESS'),
              extractField(inner, 'CORRECTACCESS'),
              extractField(inner, 'INVOKEACCESS'),
            ),
          );
          log(`    Permissions parsed ${cnt.toLocaleString()} entities → ${stats.dmfDirectEntityPerms.toLocaleString()} direct entity-permission rows`);
        } else {
          const entities = parseDmfXml(xmlParser, permsFile, 'SYSTEMSECURITYPERMISSIONENTITY', log);
          for (const e of entities) {
            onPermEntity(
              e.SECURITYROLEIDENTIFIER, e.RESOURCENAME, e.RESOURCETYPE,
              e.READACCESS, e.CREATEACCESS, e.UPDATEACCESS,
              e.DELETEACCESS, e.CORRECTACCESS, e.INVOKEACCESS,
            );
          }
          log(`    Permissions: ${stats.dmfDirectEntityPerms.toLocaleString()} direct entity-permission rows`);
        }
        stats.directEntityPerms += stats.dmfDirectEntityPerms;
      } else {
        log('    System Security Permissions.xml not found — role_direct_entity_permissions will be AOT-only');
      }
    });

    dmfTransaction();
  } else {
    log('\n[2/5] Skipping DMF parsing (no DMF input directory)');
  }

  // ── Phase 3: SecurityDatabaseCustomizations ────────────────────────────────

  if (dmfInputDir && dmfInputDir.toLowerCase() !== 'skip') {
    log('\n[3/5] Parsing SecurityDatabaseCustomizations...');
    const sdcFile = findDmfFile(dmfInputDir || '.', 'SecurityDatabaseCustomizations.xml');
    if (sdcFile) {
      const content = readFileSync(sdcFile, 'utf-8');
      const parsed = xmlParser.parse(content);
      const sdcRoles = ensureArray(
        parsed.SecurityDatabaseCustomizations?.AxSecurityRole ||
        parsed.AxSecurityRole || []
      );
      const findRoleByNameOrId = db.prepare('SELECT role_id FROM roles WHERE role_name = ? OR role_id = ?');
      const sdcTransaction = db.transaction(() => {
        for (const sdcRole of sdcRoles) {
          const roleName = sdcRole.Name;
          if (!roleName) continue;
          const roleRow = findRoleByNameOrId.get(roleName, roleName);
          if (!roleRow) continue;
          const roleId = roleRow.role_id;
          const privs = ensureArray(sdcRole.Privileges?.AxSecurityPrivilegeReference);
          for (const priv of privs) {
            if (!priv.Name) continue;
            stmts.insertDirectPriv.run(roleId, priv.Name);
            stats.directPrivileges++;
          }
          const daps = ensureArray(sdcRole.DirectAccessPermissions?.AxSecurityDataEntityReference);
          for (const dap of daps) {
            if (!dap.Name) continue;
            const grant = dap.Grant || {};
            stmts.insertDirectEntityPerm.run(
              roleId, dap.Name, dap.Type || null,
              grant.Read || null, grant.Create || null,
              grant.Update || null, grant.Delete || null,
              grant.Correct || null, grant.Invoke || null,
            );
            stats.directEntityPerms++;
          }
        }
      });
      sdcTransaction();
      log(`  Direct privileges: ${stats.directPrivileges}`);
      log(`  Direct entity permissions: ${stats.directEntityPerms}`);
    } else {
      log('  SecurityDatabaseCustomizations.xml not found (optional)');
    }
  } else {
    log('\n[3/5] Skipping SecurityDatabaseCustomizations');
  }

  // ── Phase 4: Build Search Index ────────────────────────────────────────────

  log('\n[4/5] Building search index...');
  const searchTransaction = db.transaction(() => {
    const roles = db.prepare('SELECT role_id, role_name, module_id, label, description FROM roles').all();
    for (const r of roles) {
      const content = [r.role_name, r.label, r.description, r.module_id].filter(Boolean).join(' ');
      stmts.insertSearch.run('role', r.role_name, r.module_id, content);
    }
    const duties = db.prepare('SELECT duty_id, duty_name, module_id, description FROM duties').all();
    for (const d of duties) {
      const content = [d.duty_id, d.duty_name, d.description, d.module_id].filter(Boolean).join(' ');
      stmts.insertSearch.run('duty', d.duty_id, d.module_id, content);
    }
    const privs = db.prepare('SELECT privilege_name, module_id, label FROM privileges').all();
    for (const p of privs) {
      const content = [p.privilege_name, p.label, p.module_id].filter(Boolean).join(' ');
      stmts.insertSearch.run('privilege', p.privilege_name, p.module_id, content);
    }
    const users = db.prepare('SELECT user_id, person_name, email, default_company FROM users').all();
    for (const u of users) {
      const content = [u.user_id, u.person_name, u.email, u.default_company].filter(Boolean).join(' ');
      stmts.insertSearch.run('user', u.user_id, null, content);
    }
  });
  searchTransaction();

  // Populate the FTS5 index from sec_search rows.
  log('  Populating FTS5 index...');
  db.exec(`INSERT INTO sec_search_fts(sec_search_fts) VALUES('rebuild')`);

  // ── Phase 5: Metadata & Finalize ───────────────────────────────────────────

  log('\n[5/5] Writing metadata & finalizing...');
  const counts = {
    roles: db.prepare('SELECT COUNT(*) as n FROM roles').get().n,
    duties: db.prepare('SELECT COUNT(*) as n FROM duties').get().n,
    privileges: db.prepare('SELECT COUNT(*) as n FROM privileges').get().n,
    entryPoints: db.prepare('SELECT COUNT(*) as n FROM privilege_entry_points').get().n,
    users: db.prepare('SELECT COUNT(*) as n FROM users').get().n,
    userRoles: db.prepare('SELECT COUNT(*) as n FROM user_roles').get().n,
    companies: db.prepare('SELECT COUNT(DISTINCT company_id) as n FROM user_role_companies').get().n,
    subRoles: db.prepare('SELECT COUNT(*) as n FROM role_subroles').get().n,
    roleDuties: db.prepare('SELECT COUNT(*) as n FROM role_duties').get().n,
    dutyPrivileges: db.prepare('SELECT COUNT(*) as n FROM duty_privileges').get().n,
    directEntityPerms: db.prepare('SELECT COUNT(*) as n FROM role_direct_entity_permissions').get().n,
  };

  // ── Data-quality checks ──────────────────────────────────────────────────────
  // Loud PASS/WARN gate so a degraded export can't slip through unnoticed (this
  // is how role_direct_entity_permissions silently sat at 0 on prod).
  const dutiesNoPriv = db.prepare(
    'SELECT COUNT(*) as n FROM duties d WHERE NOT EXISTS (SELECT 1 FROM duty_privileges dp WHERE dp.duty_id = d.duty_id)'
  ).get().n;
  const epWithInvoke = db.prepare(
    "SELECT COUNT(*) as n FROM privilege_entry_points WHERE grant_invoke IS NOT NULL AND grant_invoke <> ''"
  ).get().n;
  const dep = {
    rows: counts.directEntityPerms,
    withType: db.prepare("SELECT COUNT(*) as n FROM role_direct_entity_permissions WHERE resource_type IS NOT NULL AND resource_type <> ''").get().n,
    withDeny: db.prepare("SELECT COUNT(*) as n FROM role_direct_entity_permissions WHERE 'Deny' IN (grant_read,grant_create,grant_update,grant_delete,grant_correct,grant_invoke)").get().n,
    distinctRoles: db.prepare('SELECT COUNT(DISTINCT role_id) as n FROM role_direct_entity_permissions').get().n,
  };
  const hadPermsExport = (stats.dmfDirectEntityPerms || 0) > 0 || dep.rows > 0;
  // "labels loaded" only proves label FILES were found — it stayed green
  // through the gap-#4 regression because resolveLabel() silently returned
  // the raw `@…` reference instead of throwing. Count actual leaks left in
  // the queryable columns so a degraded resolve pass is visible in the log.
  const unresolvedLabels = {
    roles: db.prepare("SELECT COUNT(*) as n FROM roles WHERE label LIKE '@%'").get().n,
    duties: db.prepare("SELECT COUNT(*) as n FROM duties WHERE duty_name LIKE '@%'").get().n,
    privileges: db.prepare("SELECT COUNT(*) as n FROM privileges WHERE label LIKE '@%'").get().n,
  };
  const totalUnresolvedLabels = unresolvedLabels.roles + unresolvedLabels.duties + unresolvedLabels.privileges;
  const checks = [
    { name: 'duties have privileges', pass: counts.duties === 0 || dutiesNoPriv < counts.duties, detail: `${dutiesNoPriv}/${counts.duties} duties have NO privileges` },
    { name: 'entry points carry Invoke', pass: counts.entryPoints === 0 || epWithInvoke > 0, detail: `${epWithInvoke} entry points with Invoke` },
    { name: 'direct entity permissions present', pass: !dmfInputDir || dmfInputDir.toLowerCase() === 'skip' || dep.rows > 0, detail: `${dep.rows} rows, ${dep.distinctRoles} roles, ${dep.withDeny} with a Deny` },
    { name: 'resource_type captured', pass: dep.rows === 0 || dep.withType > 0, detail: `${dep.withType}/${dep.rows} rows have resource_type` },
    { name: 'labels loaded', pass: !packagesPathArg || packagesPathArg.toLowerCase() === 'skip' || labelsLoaded > 0, detail: `${labelsLoaded} en-US labels loaded` },
    { name: 'labels resolved', pass: !packagesPathArg || packagesPathArg.toLowerCase() === 'skip' || totalUnresolvedLabels === 0, detail: `${unresolvedLabels.roles} role / ${unresolvedLabels.duties} duty / ${unresolvedLabels.privileges} privilege label(s) still raw \`@…\` (missing label file for that module)` },
  ];

  // Source-module breakdown: which models contributed security objects. This
  // makes it verifiable that both Microsoft-standard and customization-model
  // security objects were considered — a custom model (e.g. iExtension, HISOL)
  // appearing here proves its AOT security objects were merged in.
  let securityModules = [];
  try {
    securityModules = db.prepare(`
      SELECT module_id, COUNT(*) AS n FROM (
        SELECT module_id FROM roles
        UNION ALL SELECT module_id FROM duties
        UNION ALL SELECT module_id FROM privileges
      ) WHERE module_id IS NOT NULL AND module_id <> ''
      GROUP BY module_id ORDER BY n DESC
    `).all();
  } catch (e) { log(`  (security module breakdown unavailable: ${e.message})`); }

  // Model build provenance: which build of each scanned model (Microsoft,
  // ISV, customizations like iExtension) the security objects came from.
  let modelVersions = [];
  if (packagesPaths.length) {
    modelVersions = readModelDescriptors(packagesPaths, (m) => log(`  descriptor-warn: ${m}`));
    const mvTransaction = db.transaction(() => {
      insertModelVersions((sql, params) => db.prepare(sql).run(...params), modelVersions);
    });
    mvTransaction();
    log(`  Model build versions captured: ${modelVersions.length}`);
  }

  const metaTransaction = db.transaction(() => {
    stmts.insertMeta.run('build_date', new Date().toISOString());
    stmts.insertMeta.run('aot_source', packagesPathArg || 'none');
    stmts.insertMeta.run('dmf_source', dmfInputDir || 'none');
    stmts.insertMeta.run('security_module_count', String(securityModules.length));
    stmts.insertMeta.run('model_versions_count', String(modelVersions.length));
    // Persist the full module→count map (small; dozens of modules) so the
    // admin UI can show the MS-vs-custom split without re-querying.
    stmts.insertMeta.run('security_modules', JSON.stringify(
      securityModules.map(m => ({ module: m.module_id, objects: m.n }))
    ));
    for (const [k, v] of Object.entries(counts)) {
      stmts.insertMeta.run(k, String(v));
    }
  });
  metaTransaction();
  log(`  Security source modules: ${securityModules.length} (${securityModules.slice(0, 8).map(m => m.module_id).join(', ')}${securityModules.length > 8 ? ', …' : ''})`);

  db.pragma('journal_mode = DELETE');
  db.exec('VACUUM');
  db.close();

  // Replace output file: try rename first, fall back to copy+delete for CIFS/SMB mounts (Azure /home/)
  rmSync(outputPath, { force: true });
  try {
    renameSync(tmpOutputPath, outputPath);
  } catch {
    // On CIFS, renameSync may throw even when it succeeds — check before fallback
    if (existsSync(outputPath) && !existsSync(tmpOutputPath)) {
      // Rename actually worked (CIFS quirk)
    } else if (existsSync(tmpOutputPath)) {
      copyFileSync(tmpOutputPath, outputPath);
      rmSync(tmpOutputPath, { force: true });
    } else {
      throw new Error(`Build output lost: neither ${tmpOutputPath} nor ${outputPath} exist after rename.`);
    }
  }

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  const fileSize = (statSync(outputPath).size / (1024 * 1024)).toFixed(1);

  log('');
  log('===================================================');
  log('  Security Database Build Complete');
  log('===================================================');
  log(`  Output:          ${outputPath}`);
  log(`  Size:            ${fileSize} MB`);
  log(`  Time:            ${elapsed}s`);
  log(`  Roles:           ${counts.roles}`);
  log(`  Sub-roles:       ${counts.subRoles}`);
  log(`  Duties:          ${counts.duties}`);
  log(`  Role-Duties:     ${counts.roleDuties}`);
  log(`  Privileges:      ${counts.privileges}`);
  log(`  Duty-Privileges: ${counts.dutyPrivileges}`);
  log(`  Entry Points:    ${counts.entryPoints}`);
  log(`  Users:           ${counts.users}`);
  log(`  User-Roles:      ${counts.userRoles}`);
  log(`  Companies:       ${counts.companies}`);
  log(`  Direct Entity Perms: ${counts.directEntityPerms}`);
  log('===================================================');

  log('  DATA QUALITY CHECKS');
  let anyWarn = false;
  for (const c of checks) {
    if (!c.pass) anyWarn = true;
    log(`   [${c.pass ? 'PASS' : 'WARN'}] ${c.name} — ${c.detail}`);
  }
  if (anyWarn) log('   ⚠ One or more checks WARNed — review the export before uploading this DB.');
  log('===================================================');

  return { stats, counts, elapsed, fileSize, checks };
}

// Exported for testing
export { extractField, streamParseLargeDmfXmlSync as _streamParseLargeDmfXmlSync, loadLabels as _loadLabels, resolveLabel as _resolveLabel };
