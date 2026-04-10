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

const require = createRequire(import.meta.url);
const Database = require('better-sqlite3');

// ── Schema ───────────────────────────────────────────────────────────────────

const SCHEMA = `
-- ROLES
CREATE TABLE IF NOT EXISTS roles (
  role_id          TEXT PRIMARY KEY,
  role_name        TEXT NOT NULL,
  module_id        TEXT,
  label            TEXT,
  description      TEXT,
  license_type     TEXT,
  permission_type  TEXT DEFAULT 'Grant',
  is_profile       INTEGER DEFAULT 0,
  source           TEXT DEFAULT 'aot'
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

CREATE TABLE IF NOT EXISTS sec_metadata (
  key              TEXT PRIMARY KEY,
  value            TEXT
);

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
    ].includes(name),
  });
}

/**
 * Recursively find directories named `dirName` under basePath.
 * Walks up to 4 levels deep (PackagesLocalDirectory/Package/Model/AxType).
 */
function findAxDirs(basePath, dirName) {
  const results = [];
  function walk(dir, depth) {
    if (depth > 4) return;
    try {
      const entries = readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        if (entry.name === 'bin' || entry.name === 'node_modules') continue;
        const fullPath = join(dir, entry.name);
        if (entry.name === dirName) {
          results.push(fullPath);
        } else {
          walk(fullPath, depth + 1);
        }
      }
    } catch { /* ignore permission errors */ }
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

/** Load label files from a packages directory */
function loadLabels(packagesPath) {
  const labels = new Map();
  const labelDirs = findAxDirs(packagesPath, 'AxLabelFile');

  for (const dir of labelDirs) {
    try {
      for (const file of readdirSync(dir)) {
        if (!file.endsWith('.label.txt') || !file.includes('en-US')) continue;
        const content = readFileSync(join(dir, file), 'utf-8');
        for (const line of content.split('\n')) {
          const idx = line.indexOf('=');
          if (idx > 0) {
            const id = line.substring(0, idx).trim();
            const text = line.substring(idx + 1).trim();
            if (id && text) labels.set(id, text);
          }
        }
      }
    } catch { /* skip */ }
  }
  return labels;
}

function resolveLabel(labelMap, raw) {
  if (!raw) return null;
  const match = raw.match(/^@(\w+):(\w+)$/);
  if (match) {
    const resolved = labelMap.get(match[2]) || labelMap.get(`${match[1]}:${match[2]}`);
    return resolved || raw;
  }
  return raw;
}

/** Detect Grant/Deny permission type from name */
function detectPermissionType(name) {
  if (!name) return 'Grant';
  if (/^(TBG[\s_])?Deny[\s_]/i.test(name)) return 'Deny';
  return 'Grant';
}

/** Find a DMF file by trying multiple name variants */
function findDmfFile(dir, ...names) {
  for (const name of names) {
    const path = join(dir, name);
    if (existsSync(path)) return path;
  }
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
  const stmts = {
    insertRole: db.prepare('INSERT OR REPLACE INTO roles VALUES (?,?,?,?,?,?,?,?,?)'),
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
    insertDirectEntityPerm: db.prepare('INSERT OR REPLACE INTO role_direct_entity_permissions VALUES (?,?,?,?,?,?,?,?)'),
    insertSearch: db.prepare('INSERT INTO sec_search VALUES (?,?,?,?)'),
    insertMeta: db.prepare('INSERT OR REPLACE INTO sec_metadata VALUES (?,?)'),
  };

  // ── Phase 1: Parse AOT Security Metadata ───────────────────────────────────

  let packagesPaths = [];

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
    log(`  Labels loaded: ${labelMap.size}`);

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
        stmts.insertRole.run(
          r.Name, r.Name, mod, rl(r.Label) || null, rl(r.Description) || null,
          null, detectPermissionType(r.Name), 0, 'aot'
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
    const dmfStmts = {
      updateRole: db.prepare(`UPDATE roles SET role_id = ?, role_name = ?, label = COALESCE(label, ?),
        description = COALESCE(description, ?), license_type = ?, permission_type = ?, source = 'aot+dmf'
        WHERE role_id = ?`),
      rekeyRoleDuties: db.prepare('UPDATE OR IGNORE role_duties SET role_id = ? WHERE role_id = ?'),
      deleteOldRoleDuties: db.prepare('DELETE FROM role_duties WHERE role_id = ?'),
      findDuty: db.prepare('SELECT 1 FROM duties WHERE duty_id = ?'),
      findRolePerm: db.prepare('SELECT permission_type FROM roles WHERE role_id = ?'),
      findUser: db.prepare('SELECT 1 FROM users WHERE user_id = ?'),
    };

    const dmfTransaction = db.transaction(() => {
      // 2a: Roles
      const rolesFile = findDmfFile(dmfInputDir, 'System Security Role.xml', 'SystemSecurityRole.xml');
      if (rolesFile) {
        const entities = parseDmfXml(xmlParser, rolesFile, 'SYSTEMSECURITYROLEENTITY', log);
        let mergedCount = 0;
        for (const e of entities) {
          const roleId = e.SECURITYROLEIDENTIFIER;
          const roleName = e.SECURITYROLENAME;
          if (!roleId || !roleName) continue;
          const existingAotId = aotIdUpper.get(roleId.toUpperCase());
          if (existingAotId) {
            dmfStmts.updateRole.run(roleId, roleName, e.DESCRIPTION || null, e.DESCRIPTION || null,
              e.USERLICENSETYPE || null, detectPermissionType(roleName), existingAotId);
            if (roleId !== existingAotId) {
              dmfStmts.rekeyRoleDuties.run(roleId, existingAotId);
              dmfStmts.deleteOldRoleDuties.run(existingAotId);
            }
            aotIdUpper.delete(existingAotId.toUpperCase());
            aotIdUpper.set(roleId.toUpperCase(), roleId);
            mergedCount++;
          } else {
            stmts.insertRole.run(
              roleId, roleName, null, e.DESCRIPTION || null, e.DESCRIPTION || null,
              e.USERLICENSETYPE || null, detectPermissionType(roleName), 0, 'dmf'
            );
          }
          stats.dmfRoles++;
        }
        log(`    Roles: ${stats.dmfRoles} (${mergedCount} merged with AOT)`);
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
      const dutyPrivFile = findDmfFile(dmfInputDir,
        'System Security Duty.xml', 'SystemSecurityDuty.xml');
      if (dutyPrivFile) {
        const fileSize = statSync(dutyPrivFile).size;
        const sizeMB = (fileSize / (1024 * 1024)).toFixed(0);

        // Collect unique duty-privilege pairs (works for both streaming and DOM paths)
        const dutyPrivPairs = new Set();
        const dutyNames = new Map();  // rawDutyId → label
        const privLabels = new Map(); // privId → label

        const collectEntity = (dutyId, dutyName, privId, privLabel) => {
          if (!dutyId || !privId) return;
          dutyPrivPairs.add(`${dutyId}\t${privId}`);
          if (dutyName && !dutyNames.has(dutyId)) dutyNames.set(dutyId, dutyName);
          if (privLabel && !privLabels.has(privId)) privLabels.set(privId, privLabel);
        };

        if (fileSize > 100 * 1024 * 1024) {
          // Large file (>100 MB): stream to avoid OOM
          log(`    Reading (streaming, ${sizeMB} MB): ${basename(dutyPrivFile)}`);
          const entityCount = streamParseLargeDmfXmlSync(
            dutyPrivFile, 'SYSTEMSECURITYDUTYENTITY',
            (inner) => collectEntity(
              extractField(inner, 'SECURITYDUTYIDENTIFIER'),
              extractField(inner, 'SECURITYDUTYNAME'),
              extractField(inner, 'SECURITYPRIVILEGEIDENTIFIER'),
              extractField(inner, 'SECURITYPRIVILEGENAME'),
            ),
          );
          log(`    Parsed ${entityCount.toLocaleString()} entities → ${dutyPrivPairs.size.toLocaleString()} unique duty-privilege pairs`);
        } else {
          // Small file: regular DOM parser
          const entities = parseDmfXml(xmlParser, dutyPrivFile, 'SYSTEMSECURITYDUTYENTITY', log);
          for (const e of entities) {
            collectEntity(e.SECURITYDUTYIDENTIFIER, e.SECURITYDUTYNAME,
              e.SECURITYPRIVILEGEIDENTIFIER, e.SECURITYPRIVILEGENAME);
          }
          log(`    Found ${dutyPrivPairs.size.toLocaleString()} unique duty-privilege pairs`);
        }

        // Build privilege lookup for fast existence checks
        const existingPrivsUpper = new Map();
        for (const row of db.prepare('SELECT privilege_name FROM privileges').all()) {
          existingPrivsUpper.set(row.privilege_name.toUpperCase(), row.privilege_name);
        }

        // Insert unique pairs
        let inserted = 0;
        for (const pair of dutyPrivPairs) {
          const [rawDutyId, rawPrivId] = pair.split('\t');
          const resolvedDutyId = aotDutyUpper.get(rawDutyId.toUpperCase()) || rawDutyId;
          const resolvedPrivId = existingPrivsUpper.get(rawPrivId.toUpperCase()) || rawPrivId;

          // Ensure duty exists
          if (!aotDutyUpper.has(rawDutyId.toUpperCase())) {
            stmts.insertDuty.run(resolvedDutyId, dutyNames.get(rawDutyId) || null, null, null);
            aotDutyUpper.set(resolvedDutyId.toUpperCase(), resolvedDutyId);
          }
          // Ensure privilege exists
          if (!existingPrivsUpper.has(rawPrivId.toUpperCase())) {
            stmts.insertPrivilege.run(resolvedPrivId, null, privLabels.get(rawPrivId) || null);
            existingPrivsUpper.set(resolvedPrivId.toUpperCase(), resolvedPrivId);
          }
          stmts.insertDutyPriv.run(resolvedDutyId, resolvedPrivId);
          inserted++;
        }
        stats.dmfDutyPrivileges = inserted;
        log(`    Duty-privilege mappings: ${inserted.toLocaleString()}`);
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
              roleId, dap.Name,
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
  };

  const metaTransaction = db.transaction(() => {
    stmts.insertMeta.run('build_date', new Date().toISOString());
    stmts.insertMeta.run('aot_source', packagesPathArg || 'none');
    stmts.insertMeta.run('dmf_source', dmfInputDir || 'none');
    for (const [k, v] of Object.entries(counts)) {
      stmts.insertMeta.run(k, String(v));
    }
  });
  metaTransaction();

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
  log('===================================================');

  return { stats, counts, elapsed, fileSize };
}

// Exported for testing
export { extractField, streamParseLargeDmfXmlSync as _streamParseLargeDmfXmlSync };
