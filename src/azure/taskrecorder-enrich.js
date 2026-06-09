/**
 * D365FO Task Recorder — KB + Security enrichment
 *
 * Pure, non-throwing enrichment helpers used by the enriched-document builder.
 * Each takes an already-opened better-sqlite3 handle (or null/undefined) and a
 * name, and returns a plain typed object. They NEVER throw: a missing database
 * handle, a missing object, or an unexpected schema column degrades to an
 * `{ available, found, notes }` shape so the document still renders with a
 * clear "data not available" note instead of failing the whole tool.
 *
 *   enrichFormFromKb(kbDb, formName)
 *     -> form metadata, related classes + methods, and OData/data-entity
 *        endpoints, sourced from the KB SQLite database.
 *
 *   enrichRoleFromSec(secDb, roleNameOrGuid, opts)
 *     -> the role-based security chain (sub-roles, duties, privileges) and the
 *        users assigned to the role, sourced from the Security SQLite database.
 *
 * PRIVACY: the role→user enrichment selects user_id, person_name and enabled
 * ONLY — it must never read or emit email addresses (global privacy policy).
 *
 * Query shapes mirror the existing tools in `sec-tools.js`
 * (sec_lookup_role / sec_find_users_by_role / sec_permission_trace) and
 * `kb-tools.js` (d365_get_class_methods / d365_get_entity_sources).
 */

import { makeLabelResolver } from './shared.js';

// ── Caps — keep enrichment proportionate so the document stays readable ──────
const MAX_CLASSES = 25;
const MAX_METHODS_PER_CLASS = 30;
const MAX_ENDPOINTS = 50;
const MAX_DUTIES = 100;
const MAX_PRIVILEGES = 200;
const DEFAULT_MAX_USERS = 50;

/** Run a prepared SELECT, returning [] (not throwing) on any error. */
function safeAll(db, sql, params = []) {
  try {
    return db.prepare(sql).all(...params);
  } catch {
    return [];
  }
}

function placeholders(n) {
  return new Array(n).fill('?').join(',');
}

/** Normalize a form's data_sources_json into a flat list of root table names. */
function rootTablesFromJson(raw) {
  if (!raw) return [];
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  const out = [];
  for (const item of Array.isArray(parsed) ? parsed : [parsed]) {
    if (typeof item === 'string') {
      out.push(item);
    } else if (item && typeof item === 'object') {
      const name = item.table || item.name || item.dataSource || item.Table || item.Name;
      if (name) out.push(String(name));
    }
  }
  return [...new Set(out.filter(Boolean))];
}

/**
 * Enrich a single form name with KB technical data.
 * @param {object|null|undefined} kbDb - better-sqlite3 handle (read-only) or null
 * @param {string} formName
 */
export function enrichFormFromKb(kbDb, formName) {
  const result = {
    form_name: formName,
    available: false,
    found: false,
    module_id: null,
    label: null,
    root_tables: [],
    classes: [],
    endpoints: [],
    notes: [],
  };
  if (!kbDb) {
    result.notes.push('KB database not available (set KB_DB_PATH to enable technical enrichment).');
    return result;
  }
  result.available = true;

  let resolve;
  try { resolve = makeLabelResolver(kbDb); } catch { resolve = (s) => s; }

  // ── Form metadata ──────────────────────────────────────────────────────
  const formRows = safeAll(kbDb,
    `SELECT form_name, module_id, label, data_sources_json
     FROM forms WHERE form_name = ? COLLATE NOCASE LIMIT 1`, [formName]);
  if (formRows.length) {
    const f = formRows[0];
    result.found = true;
    result.module_id = f.module_id ?? null;
    result.label = f.label ? resolve(f.label) : null;
    result.root_tables = rootTablesFromJson(f.data_sources_json);
  } else {
    result.notes.push(`Form "${formName}" not found in the KB snapshot.`);
  }

  // ── Related classes (form -> class edges, and class -> form edges) ───────
  const classRows = safeAll(kbDb,
    `SELECT DISTINCT target_node AS class_name, edge_type FROM graph_edges
       WHERE source_node = ? COLLATE NOCASE AND source_type = 'form' AND target_type = 'class'
     UNION
     SELECT DISTINCT source_node AS class_name, edge_type FROM graph_edges
       WHERE target_node = ? COLLATE NOCASE AND target_type = 'form' AND source_type = 'class'
     LIMIT ?`, [formName, formName, MAX_CLASSES]);

  for (const c of classRows) {
    const methods = safeAll(kbDb,
      `SELECT method_name, signature FROM methods
       WHERE owner_type = 'class' AND owner_name = ? COLLATE NOCASE
       ORDER BY method_name LIMIT ?`, [c.class_name, MAX_METHODS_PER_CLASS + 1]);
    const truncated = methods.length > MAX_METHODS_PER_CLASS;
    result.classes.push({
      class_name: c.class_name,
      edge_type: c.edge_type ?? null,
      methods: methods.slice(0, MAX_METHODS_PER_CLASS).map(m => ({
        method_name: m.method_name,
        signature: m.signature ?? null,
      })),
      methods_truncated: truncated,
    });
  }

  // ── OData / data-entity endpoints for the form's root tables ─────────────
  if (result.root_tables.length) {
    const ph = placeholders(result.root_tables.length);
    const entRows = safeAll(kbDb,
      `SELECT DISTINCT entity_name, public_name, public_collection, is_public, label, primary_table
       FROM data_entities WHERE primary_table IN (${ph}) COLLATE NOCASE
       ORDER BY entity_name LIMIT ?`, [...result.root_tables, MAX_ENDPOINTS]);
    result.endpoints = entRows.map(e => ({
      entity_name: e.entity_name,
      public_name: e.public_name ?? null,
      public_collection: e.public_collection ?? null,
      is_public: e.is_public ?? null,
      label: e.label ? resolve(e.label) : null,
      primary_table: e.primary_table ?? null,
    }));
  }

  return result;
}

/**
 * Enrich a single role (named by AOT name or DMF GUID) with the Security DB
 * role-based access chain and the assigned users.
 *
 * @param {object|null|undefined} secDb - better-sqlite3 handle (read-only) or null
 * @param {string} roleNameOrGuid
 * @param {{ includeUsers?: boolean, company?: (string|null), maxUsers?: number }} [opts]
 */
export function enrichRoleFromSec(secDb, roleNameOrGuid, opts = {}) {
  const includeUsers = opts.includeUsers !== false;
  const company = opts.company || null;
  const maxUsers = Number.isInteger(opts.maxUsers) && opts.maxUsers > 0 ? opts.maxUsers : DEFAULT_MAX_USERS;

  const result = {
    queried: roleNameOrGuid,
    available: false,
    found: false,
    role_id: null,
    role_name: null,
    label: null,
    license_type: null,
    permission_type: null,
    sub_roles: [],
    duties: [],
    duties_truncated: false,
    privileges: [],
    privileges_truncated: false,
    users: [],
    user_count: 0,
    users_truncated: false,
    notes: [],
  };
  if (!secDb) {
    result.notes.push('Security database not available (set SEC_DB_PATH to enable role/user enrichment).');
    return result;
  }
  result.available = true;

  // ── Resolve the role by GUID (role_id) or AOT name (role_name) ───────────
  const roleRows = safeAll(secDb,
    `SELECT role_id, role_name, label, license_type, permission_type
     FROM roles WHERE role_id = ? COLLATE NOCASE OR role_name = ? COLLATE NOCASE LIMIT 1`,
    [roleNameOrGuid, roleNameOrGuid]);
  if (!roleRows.length) {
    result.notes.push(`Role "${roleNameOrGuid}" not found in the security snapshot.`);
    return result;
  }
  const r = roleRows[0];
  result.found = true;
  result.role_id = r.role_id;
  result.role_name = r.role_name ?? r.role_id;
  result.label = r.label ?? null;
  result.license_type = r.license_type ?? null;
  result.permission_type = r.permission_type ?? null;

  // ── Direct sub-roles ─────────────────────────────────────────────────────
  result.sub_roles = safeAll(secDb,
    `SELECT child.role_name, rs.is_transitive
     FROM role_subroles rs JOIN roles child ON child.role_id = rs.child_role_id
     WHERE rs.parent_role_id = ? ORDER BY child.role_name`, [r.role_id])
    .map(s => ({ role_name: s.role_name, is_transitive: s.is_transitive ?? null }));

  // ── Expand the full role tree (this role + all transitive sub-roles) ─────
  const expanded = safeAll(secDb,
    `WITH RECURSIVE rt(role_id) AS (
       SELECT ?
       UNION
       SELECT rs.child_role_id FROM role_subroles rs JOIN rt ON rs.parent_role_id = rt.role_id
     )
     SELECT DISTINCT role_id FROM rt`, [r.role_id]).map(x => x.role_id);
  const roleIds = expanded.length ? expanded : [r.role_id];
  const rolePh = placeholders(roleIds.length);

  // ── Duties (across the role tree) ────────────────────────────────────────
  const dutyRows = safeAll(secDb,
    `SELECT DISTINCT d.duty_id, d.duty_name, rd.permission_type
     FROM role_duties rd JOIN duties d ON d.duty_id = rd.duty_id
     WHERE rd.role_id IN (${rolePh}) ORDER BY d.duty_id LIMIT ?`,
    [...roleIds, MAX_DUTIES + 1]);
  result.duties_truncated = dutyRows.length > MAX_DUTIES;
  result.duties = dutyRows.slice(0, MAX_DUTIES)
    .map(d => ({ duty_id: d.duty_id, duty_name: d.duty_name ?? null, permission_type: d.permission_type ?? null }));

  // ── Privileges (via duties + direct role privileges) ─────────────────────
  const privSet = new Set();
  if (result.duties.length) {
    const dutyIds = result.duties.map(d => d.duty_id);
    const dph = placeholders(dutyIds.length);
    for (const row of safeAll(secDb,
      `SELECT DISTINCT privilege_name FROM duty_privileges
       WHERE duty_id IN (${dph}) ORDER BY privilege_name LIMIT ?`, [...dutyIds, MAX_PRIVILEGES])) {
      privSet.add(row.privilege_name);
    }
  }
  for (const row of safeAll(secDb,
    `SELECT DISTINCT privilege_name FROM role_direct_privileges
     WHERE role_id IN (${rolePh}) ORDER BY privilege_name LIMIT ?`, [...roleIds, MAX_PRIVILEGES])) {
    privSet.add(row.privilege_name);
  }
  result.privileges_truncated = privSet.size > MAX_PRIVILEGES;
  result.privileges = [...privSet].slice(0, MAX_PRIVILEGES);

  // ── Users assigned to the named role ─────────────────────────────────────
  // PRIVACY: user_id + person_name + enabled only — never email.
  if (includeUsers) {
    let userRows;
    if (company) {
      userRows = safeAll(secDb,
        `SELECT DISTINCT u.user_id, u.person_name, u.enabled
         FROM user_roles ur
         JOIN users u ON u.user_id = ur.user_id
         JOIN user_role_companies urc ON urc.user_id = ur.user_id AND urc.role_id = ur.role_id
         WHERE ur.role_id = ? AND urc.company_id = ? COLLATE NOCASE
         ORDER BY u.user_id LIMIT ?`, [r.role_id, company, maxUsers + 1]);
    } else {
      userRows = safeAll(secDb,
        `SELECT u.user_id, u.person_name, u.enabled
         FROM user_roles ur JOIN users u ON u.user_id = ur.user_id
         WHERE ur.role_id = ? ORDER BY u.user_id LIMIT ?`, [r.role_id, maxUsers + 1]);
    }
    result.users_truncated = userRows.length > maxUsers;
    result.users = userRows.slice(0, maxUsers).map(u => ({
      user_id: u.user_id,
      person_name: u.person_name ?? null,
      enabled: u.enabled ?? null,
    }));
    const countRows = safeAll(secDb,
      `SELECT COUNT(*) AS n FROM user_roles WHERE role_id = ?`, [r.role_id]);
    result.user_count = countRows[0]?.n ?? result.users.length;
  }

  return result;
}
