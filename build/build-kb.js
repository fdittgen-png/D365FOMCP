/**
 * D365FO Knowledge Base Builder
 *
 * Parses D365FO XML metadata files from PackagesLocalDirectory and builds
 * a SQLite database optimized for AI consumption via MCP server.
 *
 * Usage: node build-kb.js [packagesPath] [outputPath]
 */

import { readFileSync, writeFileSync, readdirSync, statSync, existsSync } from 'fs';
import { join, basename, resolve } from 'path';
import { XMLParser } from 'fast-xml-parser';
import initSqlJs from 'sql.js';

// ─── Configuration ───────────────────────────────────────────────────────────

const DEFAULT_PACKAGES_PATH = join(
  process.env.USERPROFILE || 'C:\\Users\\florian.dittgen',
  'AppData', 'Local', 'Microsoft', 'Dynamics365',
  '10.0.2263.202', 'PackagesLocalDirectory'
);

const DEFAULT_OUTPUT_PATH = join(
  process.env.USERPROFILE || 'C:\\Users\\florian.dittgen',
  '.claude', 'd365fo_kb.sqlite'
);

const packagesPath = process.argv[2] || DEFAULT_PACKAGES_PATH;
const outputPath = process.argv[3] || DEFAULT_OUTPUT_PATH;

// XML parser options
const xmlParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  isArray: (name) => {
    // Force these to always be arrays even with single element
    return [
      'Method', 'AxTableField', 'AxTableIndex', 'AxTableIndexField',
      'AxTableRelation', 'AxTableRelationConstraint', 'AxTableFieldGroup',
      'AxTableFieldGroupField', 'AxEnumValue', 'AxTableMapping',
      'AxDataEntityViewField', 'AxQuerySimpleRootDataSource',
      'AxQuerySimpleDataSource', 'AxSecurityEntryPointReference',
      'AxSecurityDutyReference', 'AxSecurityPrivilegeReference',
    ].includes(name);
  },
  cdataPropName: '__cdata',
  textNodeName: '__text',
});

// ─── Stats tracking ──────────────────────────────────────────────────────────

const stats = {
  modules: 0, tables: 0, fields: 0, indexes: 0, relations: 0,
  enums: 0, enumValues: 0, edts: 0, classes: 0, methods: 0,
  entities: 0, forms: 0, securityRoles: 0, securityDuties: 0,
  securityPrivileges: 0, menuItems: 0, views: 0, errors: 0,
};

// ─── Helpers ─────────────────────────────────────────────────────────────────

function safeRead(filePath) {
  try {
    return readFileSync(filePath, 'utf-8');
  } catch {
    return null;
  }
}

function parseXml(content) {
  try {
    return xmlParser.parse(content);
  } catch {
    return null;
  }
}

function ensureArray(val) {
  if (!val) return [];
  return Array.isArray(val) ? val : [val];
}

function extractText(val) {
  if (val === undefined || val === null) return null;
  if (typeof val === 'string') return val;
  if (val.__cdata) return typeof val.__cdata === 'string' ? val.__cdata : String(val.__cdata);
  if (val.__text) return String(val.__text);
  return String(val);
}

/**
 * Extract the first line of an X++ method source that looks like a signature.
 * Skips comment lines and blank lines.
 */
function extractMethodSignature(source) {
  if (!source) return null;
  const text = extractText(source);
  if (!text) return null;
  const lines = text.split('\n');
  let sigLines = [];
  let foundSig = false;
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;
    if (line.startsWith('///') || line.startsWith('//') || line.startsWith('/*') || line.startsWith('*')) continue;
    sigLines.push(line);
    if (line.includes('{') || line.includes(';')) {
      foundSig = true;
      break;
    }
    if (sigLines.length >= 3) {
      foundSig = true;
      break;
    }
  }
  if (sigLines.length === 0) return null;
  let sig = sigLines.join(' ').replace(/\s*\{.*$/, '').trim();
  // Truncate very long signatures
  if (sig.length > 500) sig = sig.substring(0, 500) + '...';
  return sig;
}

/**
 * Parse class declaration to extract extends/implements
 */
function parseClassDeclaration(declSource) {
  const text = extractText(declSource);
  if (!text) return { extends: null, implements: null, isAbstract: false };

  let extendsClass = null;
  let implementsList = null;
  let isAbstract = false;

  const extendsMatch = text.match(/extends\s+(\w+)/i);
  if (extendsMatch) extendsClass = extendsMatch[1];

  const implMatch = text.match(/implements\s+([\w\s,]+?)[\s{]/i);
  if (implMatch) implementsList = implMatch[1].trim();

  if (text.match(/\babstract\s+class\b/i)) isAbstract = true;

  return { extends: extendsClass, implements: implementsList, isAbstract };
}

/**
 * Recursively find all directories matching a name pattern under a base path.
 */
function findAxDirs(basePath, dirName) {
  const results = [];

  function walk(dir, depth) {
    if (depth > 4) return; // Don't go too deep
    try {
      const entries = readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        if (entry.name === 'bin' || entry.name === 'node_modules' || entry.name.startsWith('tmpclaude')) continue;
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

/**
 * Determine the module name from a file path.
 * Path pattern: PackagesLocalDirectory/ModuleName/SubModel/AxType/File.xml
 */
function getModuleFromPath(filePath) {
  const rel = filePath.substring(packagesPath.length + 1);
  const parts = rel.split(/[/\\]/);
  return parts[0] || 'Unknown';
}

/**
 * Read all XML files in a directory
 */
function readXmlFiles(dirPath) {
  try {
    return readdirSync(dirPath)
      .filter(f => f.endsWith('.xml'))
      .map(f => ({
        name: f.replace('.xml', ''),
        path: join(dirPath, f),
      }));
  } catch {
    return [];
  }
}

// ─── Schema ──────────────────────────────────────────────────────────────────

const SCHEMA_SQL = `
-- KB Metadata
CREATE TABLE IF NOT EXISTS kb_metadata (
  key TEXT PRIMARY KEY,
  value TEXT
);

-- Modules
CREATE TABLE IF NOT EXISTS modules (
  module_id TEXT PRIMARY KEY,
  table_count INTEGER DEFAULT 0,
  class_count INTEGER DEFAULT 0,
  enum_count INTEGER DEFAULT 0,
  entity_count INTEGER DEFAULT 0,
  form_count INTEGER DEFAULT 0
);

-- Tables
CREATE TABLE IF NOT EXISTS tables (
  table_name TEXT PRIMARY KEY,
  module_id TEXT,
  label TEXT,
  table_group TEXT,
  save_per_company TEXT DEFAULT 'Yes',
  cache_lookup TEXT,
  clustered_index TEXT,
  replacement_key TEXT,
  config_key TEXT,
  field_count INTEGER DEFAULT 0,
  has_methods INTEGER DEFAULT 0,
  developer_doc TEXT,
  file_path TEXT
);

-- Fields
CREATE TABLE IF NOT EXISTS fields (
  table_name TEXT,
  field_name TEXT,
  field_type TEXT,
  edt TEXT,
  enum_type TEXT,
  mandatory TEXT DEFAULT 'No',
  allow_edit TEXT DEFAULT 'Yes',
  label TEXT,
  PRIMARY KEY (table_name, field_name)
);

-- Indexes
CREATE TABLE IF NOT EXISTS indexes_tbl (
  table_name TEXT,
  index_name TEXT,
  is_unique INTEGER DEFAULT 0,
  is_clustered INTEGER DEFAULT 0,
  fields_json TEXT,
  PRIMARY KEY (table_name, index_name)
);

-- Relations
CREATE TABLE IF NOT EXISTS relations (
  source_table TEXT,
  relation_name TEXT,
  related_table TEXT,
  cardinality TEXT,
  related_cardinality TEXT,
  on_delete TEXT,
  relationship_type TEXT,
  constraints_json TEXT,
  PRIMARY KEY (source_table, relation_name)
);

-- Enums
CREATE TABLE IF NOT EXISTS enums (
  enum_name TEXT PRIMARY KEY,
  module_id TEXT,
  label TEXT,
  values_json TEXT
);

-- Extended Data Types
CREATE TABLE IF NOT EXISTS edts (
  edt_name TEXT PRIMARY KEY,
  base_type TEXT,
  extends_edt TEXT,
  label TEXT,
  string_size INTEGER,
  table_ref TEXT,
  module_id TEXT
);

-- Classes
CREATE TABLE IF NOT EXISTS classes (
  class_name TEXT PRIMARY KEY,
  module_id TEXT,
  extends_class TEXT,
  implements_list TEXT,
  is_abstract INTEGER DEFAULT 0,
  method_count INTEGER DEFAULT 0,
  file_path TEXT
);

-- Methods (signatures + full source code)
CREATE TABLE IF NOT EXISTS methods (
  owner_type TEXT,
  owner_name TEXT,
  method_name TEXT,
  signature TEXT,
  is_static INTEGER DEFAULT 0,
  source_code TEXT,
  PRIMARY KEY (owner_type, owner_name, method_name)
);

-- Data Entities
CREATE TABLE IF NOT EXISTS data_entities (
  entity_name TEXT PRIMARY KEY,
  module_id TEXT,
  label TEXT,
  public_name TEXT,
  public_collection TEXT,
  is_public INTEGER DEFAULT 0,
  primary_table TEXT,
  staging_table TEXT,
  config_key TEXT,
  file_path TEXT
);

-- Data Entity Fields
CREATE TABLE IF NOT EXISTS entity_fields (
  entity_name TEXT,
  field_name TEXT,
  data_field TEXT,
  data_source TEXT,
  is_mandatory INTEGER DEFAULT 0,
  PRIMARY KEY (entity_name, field_name)
);

-- Forms (minimal metadata)
CREATE TABLE IF NOT EXISTS forms (
  form_name TEXT PRIMARY KEY,
  module_id TEXT,
  label TEXT,
  data_sources_json TEXT,
  file_path TEXT
);

-- Views
CREATE TABLE IF NOT EXISTS views (
  view_name TEXT PRIMARY KEY,
  module_id TEXT,
  label TEXT,
  config_key TEXT,
  field_count INTEGER DEFAULT 0,
  file_path TEXT
);

-- Security Roles
CREATE TABLE IF NOT EXISTS security_roles (
  role_name TEXT PRIMARY KEY,
  module_id TEXT,
  label TEXT,
  description TEXT,
  duties_json TEXT
);

-- Security Duties
CREATE TABLE IF NOT EXISTS security_duties (
  duty_name TEXT PRIMARY KEY,
  module_id TEXT,
  label TEXT,
  description TEXT,
  privileges_json TEXT
);

-- Security Privileges
CREATE TABLE IF NOT EXISTS security_privileges (
  privilege_name TEXT PRIMARY KEY,
  module_id TEXT,
  label TEXT,
  entry_points_json TEXT
);

-- Menu Items
CREATE TABLE IF NOT EXISTS menu_items (
  menu_item_name TEXT,
  menu_item_type TEXT,
  module_id TEXT,
  label TEXT,
  object_name TEXT,
  object_type TEXT,
  config_key TEXT,
  PRIMARY KEY (menu_item_name, menu_item_type)
);

-- Graph edges (relationship graph for traversal)
CREATE TABLE IF NOT EXISTS graph_edges (
  source_node TEXT,
  source_type TEXT,
  target_node TEXT,
  target_type TEXT,
  edge_type TEXT,
  edge_detail TEXT,
  PRIMARY KEY (source_node, target_node, edge_type, edge_detail)
);

-- Hallucination traps (curated)
CREATE TABLE IF NOT EXISTS hallucination_traps (
  trap_id INTEGER PRIMARY KEY AUTOINCREMENT,
  object_name TEXT,
  trap_type TEXT,
  wrong_value TEXT,
  correct_value TEXT,
  explanation TEXT
);

-- Field renames (AX2012 to D365FO)
CREATE TABLE IF NOT EXISTS field_renames (
  table_name TEXT,
  ax2012_name TEXT,
  d365fo_name TEXT,
  PRIMARY KEY (table_name, ax2012_name)
);

-- Pre-validated SQL query templates
CREATE TABLE IF NOT EXISTS query_templates (
  template_id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT,
  description TEXT,
  sql_template TEXT,
  tables_used TEXT
);

-- Object file paths (for fallback raw XML reads)
CREATE TABLE IF NOT EXISTS object_paths (
  object_type TEXT,
  object_name TEXT,
  file_path TEXT,
  file_size INTEGER,
  PRIMARY KEY (object_type, object_name)
);

-- Indexes for efficient querying
CREATE INDEX IF NOT EXISTS idx_fields_table ON fields(table_name);
CREATE INDEX IF NOT EXISTS idx_indexes_table ON indexes_tbl(table_name);
CREATE INDEX IF NOT EXISTS idx_relations_source ON relations(source_table);
CREATE INDEX IF NOT EXISTS idx_relations_target ON relations(related_table);
CREATE INDEX IF NOT EXISTS idx_methods_owner ON methods(owner_type, owner_name);
CREATE INDEX IF NOT EXISTS idx_tables_module ON tables(module_id);
CREATE INDEX IF NOT EXISTS idx_classes_module ON classes(module_id);
CREATE INDEX IF NOT EXISTS idx_classes_extends ON classes(extends_class);
CREATE INDEX IF NOT EXISTS idx_graph_source ON graph_edges(source_node);
CREATE INDEX IF NOT EXISTS idx_graph_target ON graph_edges(target_node);
CREATE INDEX IF NOT EXISTS idx_entity_fields ON entity_fields(entity_name);
`;

const FTS_SCHEMA = `
-- Full-text search (regular table -- sql.js WASM does not include FTS5)
CREATE TABLE IF NOT EXISTS kb_search (
  object_type TEXT,
  object_name TEXT,
  module_id TEXT,
  content TEXT
);
CREATE INDEX IF NOT EXISTS idx_search_name ON kb_search(object_name);
CREATE INDEX IF NOT EXISTS idx_search_type ON kb_search(object_type);
CREATE INDEX IF NOT EXISTS idx_search_module ON kb_search(module_id);
`;

// ─── Extraction Functions ────────────────────────────────────────────────────

function extractTable(parsed, filePath) {
  const t = parsed.AxTable;
  if (!t || !t.Name) return;

  const tableName = t.Name;
  const moduleId = getModuleFromPath(filePath);

  // Insert table
  const fieldList = ensureArray(t.Fields?.AxTableField);

  stmts.insertTable.run(
    tableName, moduleId, t.Label || null, t.TableGroup || null,
    t.SaveDataPerCompany || 'Yes', t.CacheLookup || null,
    t.ClusteredIndex || null, t.ReplacementKey || null,
    t.ConfigurationKey || null, fieldList.length,
    (t.SourceCode?.Methods?.Method) ? 1 : 0,
    t.DeveloperDocumentation || null, filePath
  );
  stats.tables++;

  // Insert fields
  for (const f of fieldList) {
    const fieldType = (f['@_i:type'] || f['@_xmlns:i'] || '').replace('AxTableField', '');
    stmts.insertField.run(
      tableName, f.Name, fieldType || null, f.ExtendedDataType || null,
      f.EnumType || null, f.Mandatory || 'No', f.AllowEdit || 'Yes',
      f.Label || null
    );
    stats.fields++;
  }

  // Insert indexes
  const indexList = ensureArray(t.Indexes?.AxTableIndex);
  for (const idx of indexList) {
    const idxFields = ensureArray(idx.Fields?.AxTableIndexField).map(f => f.DataField);
    const isUnique = idx.AllowDuplicates === 'Yes' ? 0 : 1;
    const isClustered = t.ClusteredIndex === idx.Name ? 1 : 0;
    stmts.insertIndex.run(
      tableName, idx.Name, isUnique, isClustered, JSON.stringify(idxFields)
    );
    stats.indexes++;
  }

  // Insert relations
  const relList = ensureArray(t.Relations?.AxTableRelation);
  for (const rel of relList) {
    const constraints = ensureArray(rel.Constraints?.AxTableRelationConstraint).map(c => ({
      field: c.Field || c.Value || null,
      relatedField: c.RelatedField || null,
      type: c['@_i:type'] || 'Field',
      fixedValue: c.Value || null,
    }));

    stmts.insertRelation.run(
      tableName, rel.Name, rel.RelatedTable || null,
      rel.Cardinality || null, rel.RelatedTableCardinality || null,
      rel.OnDelete || null, rel.RelationshipType || null,
      JSON.stringify(constraints)
    );
    stats.relations++;

    // Graph edge
    if (rel.RelatedTable) {
      try {
        stmts.insertGraphEdge.run(
          tableName, 'table', rel.RelatedTable, 'table', 'FK',
          JSON.stringify(constraints.filter(c => c.field).map(c => `${c.field}->${c.relatedField}`).join(','))
        );
      } catch { /* ignore duplicate */ }
    }
  }

  // Extract method signatures + full source code
  const methods = ensureArray(t.SourceCode?.Methods?.Method);
  for (const m of methods) {
    const sig = extractMethodSignature(m.Source);
    if (sig) {
      const isStatic = sig.includes('static ') ? 1 : 0;
      const sourceCode = extractText(m.Source) || null;
      try {
        stmts.insertMethod.run('table', tableName, m.Name, sig, isStatic, sourceCode);
        stats.methods++;
      } catch { /* ignore duplicate */ }
    }
  }

  // Object path
  try {
    stmts.insertObjectPath.run('table', tableName, filePath, statSync(filePath).size);
  } catch {}
}

function extractEnum(parsed, filePath) {
  const e = parsed.AxEnum;
  if (!e || !e.Name) return;

  const moduleId = getModuleFromPath(filePath);
  // D365FO uses "EnumValues" (not "Values") as the container element
  const rawValues = ensureArray(e.EnumValues?.AxEnumValue || e.Values?.AxEnumValue);
  const values = rawValues.map(v => ({
    name: v.Name,
    value: v.Value !== undefined ? Number(v.Value) : null,
    label: v.Label || null,
  }));

  stmts.insertEnum.run(e.Name, moduleId, e.Label || null, JSON.stringify(values));
  stats.enums++;
  stats.enumValues += values.length;

  try {
    stmts.insertObjectPath.run('enum', e.Name, filePath, statSync(filePath).size);
  } catch {}
}

function extractEdt(parsed, filePath) {
  const e = parsed.AxEdt;
  if (!e || !e.Name) return;

  const moduleId = getModuleFromPath(filePath);
  const baseType = (e['@_i:type'] || '').replace('AxEdt', '') || null;

  stmts.insertEdt.run(
    e.Name, baseType, e.Extends || null, e.Label || null,
    e.StringSize ? Number(e.StringSize) : null,
    e.ReferenceTable || null, moduleId
  );
  stats.edts++;

  try {
    stmts.insertObjectPath.run('edt', e.Name, filePath, statSync(filePath).size);
  } catch {}
}

function extractClass(parsed, filePath) {
  const c = parsed.AxClass;
  if (!c || !c.Name) return;

  const moduleId = getModuleFromPath(filePath);
  const declSource = c.SourceCode?.Declaration;
  const { extends: extendsClass, implements: implementsList, isAbstract } = parseClassDeclaration(declSource);

  const methods = ensureArray(c.SourceCode?.Methods?.Method);

  stmts.insertClass.run(
    c.Name, moduleId, extendsClass, implementsList,
    isAbstract ? 1 : 0, methods.length, filePath
  );
  stats.classes++;

  // Extract method signatures + full source code
  for (const m of methods) {
    const sig = extractMethodSignature(m.Source);
    if (sig) {
      const isStatic = sig.includes('static ') ? 1 : 0;
      const sourceCode = extractText(m.Source) || null;
      try {
        stmts.insertMethod.run('class', c.Name, m.Name, sig, isStatic, sourceCode);
        stats.methods++;
      } catch { /* ignore duplicate */ }
    }
  }

  // Graph edges for inheritance
  if (extendsClass) {
    try {
      stmts.insertGraphEdge.run(c.Name, 'class', extendsClass, 'class', 'extends', '');
    } catch {}
  }

  try {
    stmts.insertObjectPath.run('class', c.Name, filePath, statSync(filePath).size);
  } catch {}
}

function extractDataEntity(parsed, filePath) {
  const e = parsed.AxDataEntityView;
  if (!e || !e.Name) return;

  const moduleId = getModuleFromPath(filePath);

  // Get primary data source table
  let primaryTable = null;
  const ds = e.ViewMetadata?.DataSources;
  if (ds) {
    const rootDs = ds.AxQuerySimpleRootDataSource || ds.AxQuerySimpleDataSource;
    const first = ensureArray(rootDs)[0];
    if (first) primaryTable = first.Table || first.Name || null;
  }

  stmts.insertEntity.run(
    e.Name, moduleId, e.Label || null,
    e.PublicEntityName || null, e.PublicCollectionName || null,
    e.IsPublic === 'Yes' ? 1 : 0, primaryTable,
    e.StagingTable || null, e.ConfigurationKey || null, filePath
  );
  stats.entities++;

  // Entity fields
  const fieldList = ensureArray(e.Fields?.AxDataEntityViewField);
  for (const f of fieldList) {
    try {
      stmts.insertEntityField.run(
        e.Name, f.Name, f.DataField || null,
        f.DataSource || null, f.Mandatory === 'Yes' ? 1 : 0
      );
    } catch {}
  }

  // Graph edge: entity -> primary table
  if (primaryTable) {
    try {
      stmts.insertGraphEdge.run(e.Name, 'entity', primaryTable, 'table', 'datasource', 'primary');
    } catch {}
  }

  try {
    stmts.insertObjectPath.run('entity', e.Name, filePath, statSync(filePath).size);
  } catch {}
}

function extractForm(parsed, filePath) {
  const f = parsed.AxForm;
  if (!f || !f.Name) return;

  const moduleId = getModuleFromPath(filePath);

  // Extract data source tables
  let dataSources = [];
  function collectDataSources(ds) {
    if (!ds) return;
    const items = ensureArray(ds.AxFormDataSource || ds);
    for (const item of items) {
      if (item.Table) dataSources.push(item.Table);
      if (item.DataSources) collectDataSources(item.DataSources);
    }
  }
  try {
    collectDataSources(f.Design?.DataSources || f.DataSources);
    // Also try FormDesign path
    if (dataSources.length === 0 && f.FormDesign?.DataSources) {
      collectDataSources(f.FormDesign.DataSources);
    }
  } catch {}

  stmts.insertForm.run(
    f.Name, moduleId, f.Label || null,
    JSON.stringify(dataSources), filePath
  );
  stats.forms++;

  try {
    stmts.insertObjectPath.run('form', f.Name, filePath, statSync(filePath).size);
  } catch {}
}

function extractView(parsed, filePath) {
  const v = parsed.AxView;
  if (!v || !v.Name) return;

  const moduleId = getModuleFromPath(filePath);
  const fieldList = ensureArray(v.Fields?.AxViewField);

  stmts.insertView.run(
    v.Name, moduleId, v.Label || null,
    v.ConfigurationKey || null, fieldList.length, filePath
  );
  stats.views++;

  try {
    stmts.insertObjectPath.run('view', v.Name, filePath, statSync(filePath).size);
  } catch {}
}

function extractSecurityRole(parsed, filePath) {
  const r = parsed.AxSecurityRole;
  if (!r || !r.Name) return;

  const moduleId = getModuleFromPath(filePath);
  const duties = ensureArray(r.Duties?.AxSecurityDutyReference).map(d => d.Name);

  stmts.insertSecRole.run(
    r.Name, moduleId, r.Label || null, r.Description || null,
    JSON.stringify(duties)
  );
  stats.securityRoles++;
}

function extractSecurityDuty(parsed, filePath) {
  const d = parsed.AxSecurityDuty;
  if (!d || !d.Name) return;

  const moduleId = getModuleFromPath(filePath);
  const privs = ensureArray(d.Privileges?.AxSecurityPrivilegeReference).map(p => p.Name);

  stmts.insertSecDuty.run(
    d.Name, moduleId, d.Label || null, d.Description || null,
    JSON.stringify(privs)
  );
  stats.securityDuties++;
}

function extractSecurityPrivilege(parsed, filePath) {
  const p = parsed.AxSecurityPrivilege;
  if (!p || !p.Name) return;

  const moduleId = getModuleFromPath(filePath);
  const eps = ensureArray(p.EntryPoints?.AxSecurityEntryPointReference).map(ep => ({
    name: ep.Name,
    objectType: ep.ObjectType || null,
    objectName: ep.ObjectName || null,
    grant: ep.Grant || null,
  }));

  stmts.insertSecPriv.run(
    p.Name, moduleId, p.Label || null, JSON.stringify(eps)
  );
  stats.securityPrivileges++;
}

function extractMenuItem(parsed, filePath, menuType) {
  const rootKey = menuType === 'Display' ? 'AxMenuItemDisplay'
    : menuType === 'Action' ? 'AxMenuItemAction'
    : 'AxMenuItemOutput';
  const mi = parsed[rootKey];
  if (!mi || !mi.Name) return;

  const moduleId = getModuleFromPath(filePath);

  stmts.insertMenuItem.run(
    mi.Name, menuType, moduleId, mi.Label || null,
    mi.ObjectName || mi.Object || null, mi.ObjectType || null,
    mi.ConfigurationKey || null
  );
  stats.menuItems++;
}

// ─── Prepared Statements (set up after db init) ─────────────────────────────

let db;
let stmts = {};

function prepareStatements() {
  stmts.insertTable = db.prepare(`INSERT OR REPLACE INTO tables VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  stmts.insertField = db.prepare(`INSERT OR REPLACE INTO fields VALUES (?,?,?,?,?,?,?,?)`);
  stmts.insertIndex = db.prepare(`INSERT OR REPLACE INTO indexes_tbl VALUES (?,?,?,?,?)`);
  stmts.insertRelation = db.prepare(`INSERT OR REPLACE INTO relations VALUES (?,?,?,?,?,?,?,?)`);
  stmts.insertEnum = db.prepare(`INSERT OR REPLACE INTO enums VALUES (?,?,?,?)`);
  stmts.insertEdt = db.prepare(`INSERT OR REPLACE INTO edts VALUES (?,?,?,?,?,?,?)`);
  stmts.insertClass = db.prepare(`INSERT OR REPLACE INTO classes VALUES (?,?,?,?,?,?,?)`);
  stmts.insertMethod = db.prepare(`INSERT OR REPLACE INTO methods VALUES (?,?,?,?,?,?)`);
  stmts.insertEntity = db.prepare(`INSERT OR REPLACE INTO data_entities VALUES (?,?,?,?,?,?,?,?,?,?)`);
  stmts.insertEntityField = db.prepare(`INSERT OR REPLACE INTO entity_fields VALUES (?,?,?,?,?)`);
  stmts.insertForm = db.prepare(`INSERT OR REPLACE INTO forms VALUES (?,?,?,?,?)`);
  stmts.insertView = db.prepare(`INSERT OR REPLACE INTO views VALUES (?,?,?,?,?,?)`);
  stmts.insertSecRole = db.prepare(`INSERT OR REPLACE INTO security_roles VALUES (?,?,?,?,?)`);
  stmts.insertSecDuty = db.prepare(`INSERT OR REPLACE INTO security_duties VALUES (?,?,?,?,?)`);
  stmts.insertSecPriv = db.prepare(`INSERT OR REPLACE INTO security_privileges VALUES (?,?,?,?)`);
  stmts.insertMenuItem = db.prepare(`INSERT OR REPLACE INTO menu_items VALUES (?,?,?,?,?,?,?)`);
  stmts.insertGraphEdge = db.prepare(`INSERT OR IGNORE INTO graph_edges VALUES (?,?,?,?,?,?)`);
  stmts.insertObjectPath = db.prepare(`INSERT OR REPLACE INTO object_paths VALUES (?,?,?,?)`);
  stmts.insertModule = db.prepare(`INSERT OR REPLACE INTO modules VALUES (?,?,?,?,?,?)`);
  stmts.insertFts = db.prepare(`INSERT INTO kb_search VALUES (?,?,?,?)`);
  stmts.insertHallTrap = db.prepare(`INSERT INTO hallucination_traps (object_name,trap_type,wrong_value,correct_value,explanation) VALUES (?,?,?,?,?)`);
  stmts.insertFieldRename = db.prepare(`INSERT OR REPLACE INTO field_renames VALUES (?,?,?)`);
  stmts.insertQueryTemplate = db.prepare(`INSERT INTO query_templates (title,description,sql_template,tables_used) VALUES (?,?,?,?)`);
}

// sql.js uses a different API - we need a wrapper
class StmtWrapper {
  constructor(db, sql) {
    this.db = db;
    this.sql = sql;
  }
  run(...params) {
    this.db.run(this.sql, params);
  }
}

function prepareStatementsForSqlJs() {
  const wrap = (sql) => new StmtWrapper(db, sql);
  stmts.insertTable = wrap(`INSERT OR REPLACE INTO tables VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  stmts.insertField = wrap(`INSERT OR REPLACE INTO fields VALUES (?,?,?,?,?,?,?,?)`);
  stmts.insertIndex = wrap(`INSERT OR REPLACE INTO indexes_tbl VALUES (?,?,?,?,?)`);
  stmts.insertRelation = wrap(`INSERT OR REPLACE INTO relations VALUES (?,?,?,?,?,?,?,?)`);
  stmts.insertEnum = wrap(`INSERT OR REPLACE INTO enums VALUES (?,?,?,?)`);
  stmts.insertEdt = wrap(`INSERT OR REPLACE INTO edts VALUES (?,?,?,?,?,?,?)`);
  stmts.insertClass = wrap(`INSERT OR REPLACE INTO classes VALUES (?,?,?,?,?,?,?)`);
  stmts.insertMethod = wrap(`INSERT OR REPLACE INTO methods VALUES (?,?,?,?,?,?)`);
  stmts.insertEntity = wrap(`INSERT OR REPLACE INTO data_entities VALUES (?,?,?,?,?,?,?,?,?,?)`);
  stmts.insertEntityField = wrap(`INSERT OR REPLACE INTO entity_fields VALUES (?,?,?,?,?)`);
  stmts.insertForm = wrap(`INSERT OR REPLACE INTO forms VALUES (?,?,?,?,?)`);
  stmts.insertView = wrap(`INSERT OR REPLACE INTO views VALUES (?,?,?,?,?,?)`);
  stmts.insertSecRole = wrap(`INSERT OR REPLACE INTO security_roles VALUES (?,?,?,?,?)`);
  stmts.insertSecDuty = wrap(`INSERT OR REPLACE INTO security_duties VALUES (?,?,?,?,?)`);
  stmts.insertSecPriv = wrap(`INSERT OR REPLACE INTO security_privileges VALUES (?,?,?,?)`);
  stmts.insertMenuItem = wrap(`INSERT OR REPLACE INTO menu_items VALUES (?,?,?,?,?,?,?)`);
  stmts.insertGraphEdge = wrap(`INSERT OR IGNORE INTO graph_edges VALUES (?,?,?,?,?,?)`);
  stmts.insertObjectPath = wrap(`INSERT OR REPLACE INTO object_paths VALUES (?,?,?,?)`);
  stmts.insertModule = wrap(`INSERT OR REPLACE INTO modules VALUES (?,?,?,?,?,?)`);
  stmts.insertFts = wrap(`INSERT INTO kb_search VALUES (?,?,?,?)`);
  stmts.insertHallTrap = wrap(`INSERT INTO hallucination_traps (object_name,trap_type,wrong_value,correct_value,explanation) VALUES (?,?,?,?,?)`);
  stmts.insertFieldRename = wrap(`INSERT OR REPLACE INTO field_renames VALUES (?,?,?)`);
  stmts.insertQueryTemplate = wrap(`INSERT INTO query_templates (title,description,sql_template,tables_used) VALUES (?,?,?,?)`);
}

// ─── Processing Pipeline ─────────────────────────────────────────────────────

function processAxType(axTypeName, extractFn, extraArg) {
  const dirs = findAxDirs(packagesPath, axTypeName);
  let count = 0;
  for (const dir of dirs) {
    const files = readXmlFiles(dir);
    for (const file of files) {
      const content = safeRead(file.path);
      if (!content) continue;
      const parsed = parseXml(content);
      if (!parsed) { stats.errors++; continue; }
      try {
        if (extraArg !== undefined) {
          extractFn(parsed, file.path, extraArg);
        } else {
          extractFn(parsed, file.path);
        }
      } catch (err) {
        stats.errors++;
      }
      count++;
      if (count % 5000 === 0) {
        process.stdout.write(`  ${axTypeName}: ${count} files processed...\r`);
      }
    }
  }
  console.log(`  ${axTypeName}: ${count} files processed`);
}

function buildModuleSummaries() {
  console.log('Building module summaries...');
  // Collect unique modules from tables
  const modRows = db.exec(`
    SELECT DISTINCT module_id FROM (
      SELECT module_id FROM tables
      UNION SELECT module_id FROM classes
      UNION SELECT module_id FROM enums
      UNION SELECT module_id FROM data_entities
      UNION SELECT module_id FROM forms
    )
  `);

  if (modRows.length > 0) {
    for (const row of modRows[0].values) {
      const mid = row[0];
      if (!mid) continue;
      const tc = db.exec(`SELECT COUNT(*) FROM tables WHERE module_id='${mid}'`)[0]?.values[0][0] || 0;
      const cc = db.exec(`SELECT COUNT(*) FROM classes WHERE module_id='${mid}'`)[0]?.values[0][0] || 0;
      const ec = db.exec(`SELECT COUNT(*) FROM enums WHERE module_id='${mid}'`)[0]?.values[0][0] || 0;
      const dc = db.exec(`SELECT COUNT(*) FROM data_entities WHERE module_id='${mid}'`)[0]?.values[0][0] || 0;
      const fc = db.exec(`SELECT COUNT(*) FROM forms WHERE module_id='${mid}'`)[0]?.values[0][0] || 0;
      stmts.insertModule.run(mid, tc, cc, ec, dc, fc);
      stats.modules++;
    }
  }
}

function buildFtsIndex() {
  console.log('Building FTS5 search index...');

  // Index tables
  const tables = db.exec(`SELECT table_name, module_id, label, developer_doc FROM tables`);
  if (tables.length > 0) {
    for (const row of tables[0].values) {
      const fields = db.exec(`SELECT GROUP_CONCAT(field_name, ', ') FROM fields WHERE table_name='${row[0]}'`);
      const fieldNames = fields[0]?.values[0][0] || '';
      stmts.insertFts.run('table', row[0], row[1] || '', `${row[2] || ''} ${row[3] || ''} ${fieldNames}`);
    }
  }

  // Index classes
  const classes = db.exec(`SELECT class_name, module_id, extends_class, implements_list FROM classes`);
  if (classes.length > 0) {
    for (const row of classes[0].values) {
      stmts.insertFts.run('class', row[0], row[1] || '', `${row[2] || ''} ${row[3] || ''}`);
    }
  }

  // Index enums
  const enums = db.exec(`SELECT enum_name, module_id, label, values_json FROM enums`);
  if (enums.length > 0) {
    for (const row of enums[0].values) {
      let valNames = '';
      try { valNames = JSON.parse(row[3]).map(v => v.name).join(', '); } catch {}
      stmts.insertFts.run('enum', row[0], row[1] || '', `${row[2] || ''} ${valNames}`);
    }
  }

  // Index entities
  const entities = db.exec(`SELECT entity_name, module_id, label, public_name FROM data_entities`);
  if (entities.length > 0) {
    for (const row of entities[0].values) {
      stmts.insertFts.run('entity', row[0], row[1] || '', `${row[2] || ''} ${row[3] || ''}`);
    }
  }

  console.log('  FTS5 index built');
}

function importCuratedData() {
  console.log('Importing curated AI-assist data...');

  // ── Hallucination traps ──
  const traps = [
    // Non-existent fields
    ['GeneralJournalEntry', 'nonexistent_field', 'DATAAREAID', null, 'GeneralJournalEntry has NO DATAAREAID. Use SUBLEDGERVOUCHERDATAAREAID for company filtering.'],
    ['GeneralJournalEntry', 'nonexistent_field', 'Direction', null, 'GeneralJournalEntry has no Direction field.'],
    ['GeneralJournalAccountEntry', 'nonexistent_field', 'SubledgerVoucherType', null, 'GJAE has no SubledgerVoucherType field.'],
    ['GeneralJournalAccountEntry', 'nonexistent_field', 'IsDebit', null, 'GJAE uses ISCREDIT (1=Credit, 0=Debit), NOT IsDebit.'],
    ['GeneralJournalAccountEntry', 'nonexistent_field', 'AmountCurDebMST', null, 'GJAE has no AmountCurDebMST. Use ACCOUNTINGCURRENCYAMOUNT with ISCREDIT to derive debit/credit.'],
    ['InventTrans', 'nonexistent_field', 'Direction', null, 'InventTrans has no Direction. Derive from QTY sign (positive=receipt, negative=issue).'],
    ['InventItemPrice', 'nonexistent_field', 'CREATEDBY', null, 'InventItemPrice has no CREATEDBY field.'],
    ['InventItemPrice', 'nonexistent_field', 'MODIFIEDBY', null, 'InventItemPrice has no MODIFIEDBY field.'],
    ['InventItemPrice', 'nonexistent_field', 'PRICEACTIVE', null, 'InventItemPrice has no PRICEACTIVE field. Active price = PRICECALCID != empty + most recent ACTIVATIONDATE.'],
    // Wrong join patterns
    ['CustInvoiceTrans', 'wrong_join', 'JOIN ON InvoiceId only', 'JOIN ON InvoiceId + InvoiceDate + numberSequenceGroup + SalesId', 'CustInvoiceTrans requires 4-field join key including SalesId.'],
    ['VendInvoiceTrans', 'wrong_join', 'JOIN ON InvoiceId only', 'JOIN ON InvoiceId + InvoiceDate + numberSequenceGroup + PurchId + InternalInvoiceId', 'VendInvoiceTrans requires 5-field join key including PurchId and InternalInvoiceId.'],
  ];

  for (const [obj, type, wrong, correct, expl] of traps) {
    stmts.insertHallTrap.run(obj, type, wrong, correct, expl);
  }

  // ── AX2012 to D365FO field renames ──
  const renames = [
    ['CustInvoiceJour', 'CustAccount', 'InvoiceAccount'],
    ['CustInvoiceJour', 'OrderAccount', 'OrderAccount'], // same
    ['CustInvoiceJour', 'PaymTermId', 'Payment'],
    ['SalesTable', 'CustAccount', 'OrderAccount'],
    ['SalesTable', 'InvoiceAccount', 'InvoiceAccount'], // same
    ['PurchTable', 'VendAccount', 'OrderAccount'],
    ['PurchTable', 'InvoiceAccount', 'InvoiceAccount'], // same
    ['VendInvoiceJour', 'VendAccount', 'InvoiceAccount'],
    ['VendInvoiceJour', 'OrderAccount', 'OrderAccount'], // same
  ];

  for (const [table, ax2012, d365fo] of renames) {
    stmts.insertFieldRename.run(table, ax2012, d365fo);
  }

  // ── Query templates ──
  const templates = [
    [
      'Customer Invoice Headers',
      'Query CustInvoiceJour with common filters',
      `SELECT cij.INVOICEID, cij.INVOICEDATE, cij.INVOICEACCOUNT, cij.ORDERACCOUNT,
  cij.INVOICEAMOUNTMST, cij.SALESBALANCEMST
FROM CUSTINVOICEJOUR cij WITH (NOLOCK)
WHERE cij.DATAAREAID = '{{company}}'
  AND cij.INVOICEDATE >= '{{fromDate}}'
  AND cij.INVOICEDATE <= '{{toDate}}'
ORDER BY cij.INVOICEDATE DESC`,
      'CustInvoiceJour'
    ],
    [
      'Customer Invoice with Lines',
      'Join CustInvoiceJour to CustInvoiceTrans (4-field key)',
      `SELECT cij.INVOICEID, cij.INVOICEDATE, cij.INVOICEACCOUNT,
  cit.ITEMID, cit.NAME, cit.QTY, cit.LINEAMOUNT
FROM CUSTINVOICEJOUR cij WITH (NOLOCK)
JOIN CUSTINVOICETRANS cit WITH (NOLOCK)
  ON cit.INVOICEID = cij.INVOICEID
  AND cit.INVOICEDATE = cij.INVOICEDATE
  AND cit.NUMBERSEQUENCEGROUP = cij.NUMBERSEQUENCEGROUP
  AND cit.SALESID = cij.SALESID
WHERE cij.DATAAREAID = '{{company}}'
  AND cit.DATAAREAID = cij.DATAAREAID`,
      'CustInvoiceJour,CustInvoiceTrans'
    ],
    [
      'Vendor Invoice with Lines',
      'Join VendInvoiceJour to VendInvoiceTrans (5-field key)',
      `SELECT vij.INVOICEID, vij.INVOICEDATE, vij.INVOICEACCOUNT,
  vit.ITEMID, vit.NAME, vit.QTY, vit.LINEAMOUNT
FROM VENDINVOICEJOUR vij WITH (NOLOCK)
JOIN VENDINVOICETRANS vit WITH (NOLOCK)
  ON vit.INVOICEID = vij.INVOICEID
  AND vit.INVOICEDATE = vij.INVOICEDATE
  AND vit.NUMBERSEQUENCEGROUP = vij.NUMBERSEQUENCEGROUP
  AND vit.PURCHID = vij.PURCHID
  AND vit.INTERNALINVOICEID = vij.INTERNALINVOICEID
WHERE vij.DATAAREAID = '{{company}}'
  AND vit.DATAAREAID = vij.DATAAREAID`,
      'VendInvoiceJour,VendInvoiceTrans'
    ],
    [
      'General Ledger Entries',
      'Query GeneralJournalEntry with GeneralJournalAccountEntry and MainAccount',
      `SELECT gje.SUBLEDGERVOUCHER, gje.ACCOUNTINGDATE,
  ma.MAINACCOUNTID, ma.NAME,
  gjae.ACCOUNTINGCURRENCYAMOUNT, gjae.ISCREDIT, gjae.TEXT
FROM GENERALJOURNALENTRY gje WITH (NOLOCK)
JOIN GENERALJOURNALACCOUNTENTRY gjae WITH (NOLOCK)
  ON gjae.GENERALJOURNALENTRY = gje.RECID
JOIN DIMENSIONATTRIBUTEVALUECOMBINATION davc WITH (NOLOCK)
  ON davc.RECID = gjae.LEDGERDIMENSION
JOIN MAINACCOUNT ma WITH (NOLOCK)
  ON ma.RECID = davc.MAINACCOUNT
WHERE gje.SUBLEDGERVOUCHERDATAAREAID = '{{company}}'
  AND gje.ACCOUNTINGDATE >= '{{fromDate}}'`,
      'GeneralJournalEntry,GeneralJournalAccountEntry,DimensionAttributeValueCombination,MainAccount'
    ],
    [
      'Inventory Transactions',
      'Query InventTrans with item and dimension info',
      `SELECT it.ITEMID, it.QTY, it.COSTAMOUNTPOSTED, it.DATEPHYSICAL, it.DATEFINANCIAL,
  it.STATUSISSUE, it.STATUSRECEIPT, it.TRANSTYPE, it.VOUCHER
FROM INVENTTRANS it WITH (NOLOCK)
WHERE it.DATAAREAID = '{{company}}'
  AND it.DATEPHYSICAL >= '{{fromDate}}'
ORDER BY it.DATEPHYSICAL DESC`,
      'InventTrans'
    ],
  ];

  for (const [title, desc, sql, tables] of templates) {
    stmts.insertQueryTemplate.run(title, desc, sql, tables);
  }

  console.log(`  Imported ${traps.length} hallucination traps, ${renames.length} field renames, ${templates.length} query templates`);
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
  console.log('═══════════════════════════════════════════════════════════');
  console.log('  D365FO Knowledge Base Builder');
  console.log('═══════════════════════════════════════════════════════════');
  console.log(`Source: ${packagesPath}`);
  console.log(`Output: ${outputPath}`);
  console.log('');

  if (!existsSync(packagesPath)) {
    console.error(`ERROR: Packages path not found: ${packagesPath}`);
    process.exit(1);
  }

  // Initialize sql.js
  console.log('Initializing SQLite...');
  const SQL = await initSqlJs();
  db = new SQL.Database();

  // Create schema
  console.log('Creating schema...');
  // sql.js db.run() handles multiple statements via exec
  for (const stmt of SCHEMA_SQL.split(';').filter(s => s.trim())) {
    db.run(stmt + ';');
  }
  for (const stmt of FTS_SCHEMA.split(';').filter(s => s.trim())) {
    db.run(stmt + ';');
  }

  // Prepare statements
  prepareStatementsForSqlJs();

  // ── Phase 1: Extract metadata ──
  console.log('');
  console.log('Phase 1: Extracting metadata...');
  const t0 = Date.now();

  // Wrap in transaction for performance
  db.run('BEGIN TRANSACTION');

  console.log('[1/10] AxTable...');
  processAxType('AxTable', extractTable);

  console.log('[2/10] AxEnum...');
  processAxType('AxEnum', extractEnum);

  console.log('[3/10] AxEdt...');
  processAxType('AxEdt', extractEdt);

  console.log('[4/10] AxClass (signatures + source code)...');
  processAxType('AxClass', extractClass);

  console.log('[5/10] AxDataEntityView...');
  processAxType('AxDataEntityView', extractDataEntity);

  console.log('[6/10] AxForm (metadata only)...');
  processAxType('AxForm', extractForm);

  console.log('[7/10] AxView...');
  processAxType('AxView', extractView);

  console.log('[8/10] Security: Roles, Duties, Privileges...');
  processAxType('AxSecurityRole', extractSecurityRole);
  processAxType('AxSecurityDuty', extractSecurityDuty);
  processAxType('AxSecurityPrivilege', extractSecurityPrivilege);

  console.log('[9/10] Menu Items...');
  processAxType('AxMenuItemDisplay', extractMenuItem, 'Display');
  processAxType('AxMenuItemAction', extractMenuItem, 'Action');
  processAxType('AxMenuItemOutput', extractMenuItem, 'Output');

  db.run('COMMIT');

  const t1 = Date.now();
  console.log(`\nPhase 1 complete: ${((t1 - t0) / 1000).toFixed(1)}s`);

  // ── Phase 2: Build summaries and indexes ──
  console.log('\nPhase 2: Building summaries and indexes...');
  db.run('BEGIN TRANSACTION');

  console.log('[10/10] Module summaries + FTS index + curated data...');
  buildModuleSummaries();
  buildFtsIndex();
  importCuratedData();

  // KB metadata
  db.run(`INSERT OR REPLACE INTO kb_metadata VALUES ('d365fo_version', '10.0.2263.172')`);
  db.run(`INSERT OR REPLACE INTO kb_metadata VALUES ('build_date', '${new Date().toISOString()}')`);
  db.run(`INSERT OR REPLACE INTO kb_metadata VALUES ('packages_path', '${packagesPath.replace(/\\/g, '\\\\')}')`);
  db.run(`INSERT OR REPLACE INTO kb_metadata VALUES ('schema_version', '1.0')`);

  db.run('COMMIT');

  const t2 = Date.now();
  console.log(`Phase 2 complete: ${((t2 - t1) / 1000).toFixed(1)}s`);

  // ── Save database ──
  console.log('\nSaving database...');
  const data = db.export();
  const buffer = Buffer.from(data);

  // Ensure output directory exists
  const outDir = resolve(outputPath, '..');
  if (!existsSync(outDir)) {
    const { mkdirSync } = await import('fs');
    mkdirSync(outDir, { recursive: true });
  }

  writeFileSync(outputPath, buffer);

  const dbSizeMB = (buffer.length / (1024 * 1024)).toFixed(1);

  // ── Summary ──
  console.log('');
  console.log('═══════════════════════════════════════════════════════════');
  console.log('  BUILD COMPLETE');
  console.log('═══════════════════════════════════════════════════════════');
  console.log(`  Database: ${outputPath} (${dbSizeMB} MB)`);
  console.log(`  Duration: ${((t2 - t0) / 1000).toFixed(1)}s`);
  console.log('');
  console.log('  Objects extracted:');
  console.log(`    Modules:      ${stats.modules}`);
  console.log(`    Tables:       ${stats.tables}`);
  console.log(`    Fields:       ${stats.fields}`);
  console.log(`    Indexes:      ${stats.indexes}`);
  console.log(`    Relations:    ${stats.relations}`);
  console.log(`    Enums:        ${stats.enums} (${stats.enumValues} values)`);
  console.log(`    EDTs:         ${stats.edts}`);
  console.log(`    Classes:      ${stats.classes}`);
  console.log(`    Methods:      ${stats.methods} (signatures + source code)`);
  console.log(`    Entities:     ${stats.entities}`);
  console.log(`    Forms:        ${stats.forms}`);
  console.log(`    Views:        ${stats.views}`);
  console.log(`    Sec Roles:    ${stats.securityRoles}`);
  console.log(`    Sec Duties:   ${stats.securityDuties}`);
  console.log(`    Sec Privs:    ${stats.securityPrivileges}`);
  console.log(`    Menu Items:   ${stats.menuItems}`);
  console.log(`    Errors:       ${stats.errors}`);
  console.log('═══════════════════════════════════════════════════════════');

  db.close();
}

main().catch(err => {
  console.error('FATAL ERROR:', err);
  process.exit(1);
});
