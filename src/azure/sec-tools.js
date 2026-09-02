/**
 * D365FO Security Configuration – SQLite MCP Tools
 *
 * Registers all 18 security tools on an McpServer instance, querying
 * the normalized security database.
 *
 * Usage:
 *   import { registerSecTools } from './sec-tools.js';
 *   registerSecTools(server, db);
 */

import {
  query,
  formatMarkdownTable,
  emptyResult,
  notFoundResult,
  truncationNote,
  errorResult,
  structuredResult,
  formatPermission,
  formatCrudFlag,
  contextAround,
  formatTextParam,
  modulesFilterParam,
  sanitizeModulesFilter,
  queryModelVersions,
  READ_ONLY_DB_ANNOTATIONS,
} from './shared.js';
import { installToolGuards } from './tool-guards.js';
import { cursorParam, decodeCursor, pageMeta, pageNote, probeLimit, takePage } from './pagination.js';
import { z } from 'zod';
import {
  secLookupUserOutput,
  secEffectivePermissionsOutput,
  secLookupRoleOutput,
  secLookupDutyOutput,
  secLookupPrivilegeOutput,
  secRoleHierarchyOutput,
  secFindUsersByRoleOutput,
  secFindRolesByDutyOutput,
  secFindRolesByPrivilegeOutput,
  secCompanyUsersOutput,
  secPermissionTraceOutput,
  secCompareRolesOutput,
  secSearchOutput,
  secStatsOutput,
  rawSqlOutput,
  secLicenceAssessmentOutput,
  secWhatIfOutput,
  secObjectAccessOutput,
} from './output-schemas.js';

// ── Licence tier cost table (Microsoft published pricing, GBP, March 2026) ──
// Sorted by monthly_cost ascending. The UserLicenseType enum value in D365's
// SecurityRole table maps to one of these names. The assessment picks the
// highest-cost tier across all of a user's assigned Grant roles.

const LICENCE_TIERS = [
  { name: 'None',       cost: 0.00 },
  { name: 'SelfServe',  cost: 0.00 },
  { name: 'Server',     cost: 0.00 },
  { name: 'Universal',  cost: 5.80 },
  { name: 'TeamMembers', cost: 5.80 },  // alias used in some DMF exports
  { name: 'Activity',   cost: 25.30 },
  { name: 'Task',       cost: 30.00 },
  { name: 'Functional', cost: 100.00 },
  { name: 'HR',         cost: 100.00 },
  { name: 'Project',    cost: 100.00 },
  { name: 'Commerce',   cost: 135.00 },
  { name: 'Enterprise', cost: 135.70 },
  { name: 'Finance',    cost: 135.70 },
  { name: 'SCM',        cost: 135.70 },
];
const TIER_COST_MAP = new Map(LICENCE_TIERS.map(t => [t.name?.toLowerCase(), t.cost]));

function tierCost(tierName) {
  if (!tierName) return 0;
  return TIER_COST_MAP.get(tierName.toLowerCase()) ?? 0;
}

function highestTier(tierNames) {
  let best = null;
  let bestCost = -1;
  for (const t of tierNames) {
    const c = tierCost(t);
    if (c > bestCost) { bestCost = c; best = t; }
  }
  return { name: best, cost: bestCost > 0 ? bestCost : 0 };
}

// ── Register all 18 Security tools ──────────────────────────────────────────

export function registerSecTools(server, db) {
  // Agent guardrails (loop detection + one-shot staleness note) wrap every
  // tool registered below. Returns a proxy, so the shared McpServer is not
  // mutated and a second register*Tools() call cannot double-wrap it.
  server = installToolGuards(server, { service: 'sec', db });


  const q = (sql, params = []) => query(db, sql, params);

  // The `resource_type` column on role_direct_entity_permissions was added in a
  // later (v3) build. Older deployed snapshots lack it, so a query referencing
  // `rdep.resource_type` throws "no such column" — which surfaced as the
  // sec_effective_permissions / sec_object_access schema fault. Detect the
  // column once at registration and fall back to a literal object type so both
  // tools degrade gracefully on a pre-v3 DB instead of erroring.
  let rdepHasResourceType = false;
  try {
    rdepHasResourceType = q('PRAGMA table_info(role_direct_entity_permissions)')
      .some((c) => String(c.name).toLowerCase() === 'resource_type');
  } catch { /* table absent — keep false */ }
  const rdepObjectType = rdepHasResourceType
    ? "COALESCE(rdep.resource_type, 'DataEntity')"
    : "'DataEntity'";

  // ── List caps for the lookup tools (W3 #107.6) ──────────────────────────
  // Single-object lookups whose sub-lists are unbounded in the data model
  // (a duty in hundreds of roles, a privilege with hundreds of entry points,
  // a user with roles x companies pairs). Each list is cut at `limit`; the
  // exact totals travel in the *_count keys so the array length is never
  // mistaken for the answer.
  const LIST_CAP_DEFAULT = 200;   // lookup tools: several lists per response
  const FIND_CAP_DEFAULT = 100;   // find_roles_by_*: one list, the whole answer
  const LIST_CAP_MAX = 2000;
  const listLimitParam = (dflt) => z.number().int().min(1).max(LIST_CAP_MAX).optional().default(dflt)
    .describe(`Max rows per list (default ${dflt})`);
  const clampListLimit = (limit, dflt) =>
    (Number.isInteger(limit) && limit > 0 ? Math.min(limit, LIST_CAP_MAX) : dflt);
  // 'user' when the caller set the limit, 'cap' when the default cut the list.
  const limitKind = (limit) => (Number.isInteger(limit) && limit > 0 ? 'user' : 'cap');
  /** Section footer: the truncation note when a list was cut, else the blank line. */
  const capNote = (shown, total) =>
    (total > shown ? truncationNote('cap', shown, LIST_CAP_MAX) + '\n' : '\n\n');

  // ── 1. sec_lookup_role ──────────────────────────────────────────────────

  // Summary by default (W3, issue #107.1). Measured on a real role:
  // direct_entity_permissions[2434] was 420 KB of a 458 KB payload — one call
  // was 75% of a 200k context. The three lists are capped; the counts are
  // exact; `include_entity_permissions:true` returns the complete lists.
  const ROLE_SUMMARY_CAP = 50;
  const ROLE_ENTITY_PERMISSION_MAX = 5000;
  const ROLE_BATCH_MAX = 10;
  const GRANT_COLUMNS = ['grant_read', 'grant_create', 'grant_update', 'grant_delete', 'grant_correct', 'grant_invoke'];

  /** Full typed payload for one role row (`r` from `roles`). */
  function buildRolePayload(r, { includeAll, entityLimit }) {
    const subs = q(`SELECT r.role_name, rs.is_transitive
      FROM role_subroles rs JOIN roles r ON r.role_id = rs.child_role_id
      WHERE rs.parent_role_id = ? ORDER BY r.role_name`, [r.role_id]);
    const duties = q(`SELECT d.duty_id, d.duty_name, rd.permission_type
      FROM role_duties rd JOIN duties d ON d.duty_id = rd.duty_id
      WHERE rd.role_id = ? ORDER BY d.duty_id`, [r.role_id]);
    const dirPrivs = q(`SELECT privilege_name FROM role_direct_privileges
      WHERE role_id = ? ORDER BY privilege_name`, [r.role_id]);
    const permCount = q(`SELECT COUNT(*) AS n FROM role_direct_entity_permissions WHERE role_id = ?`, [r.role_id])[0]?.n || 0;
    const dirPerms = includeAll
      ? q(`SELECT entity_name, grant_read, grant_create, grant_update, grant_delete, grant_correct, grant_invoke
          FROM role_direct_entity_permissions WHERE role_id = ? ORDER BY entity_name`, [r.role_id])
      : q(`SELECT entity_name, grant_read, grant_create, grant_update, grant_delete, grant_correct, grant_invoke
          FROM role_direct_entity_permissions WHERE role_id = ? ORDER BY entity_name LIMIT ?`, [r.role_id, entityLimit]);
    const userCount = q(`SELECT COUNT(*) as n FROM user_roles WHERE role_id = ?`, [r.role_id]);

    const listCap = includeAll ? Infinity : ROLE_SUMMARY_CAP;
    // Rule #14, decided per RESPONSE: a grant column is emitted on every row
    // when it is non-null on at least one row, and on no row otherwise. Rows
    // stay uniform so the TOON channel keeps its tabular form.
    const liveGrants = GRANT_COLUMNS.filter(c => dirPerms.some(p => p[c] != null));

    return {
      role_id: r.role_id,
      role_name: r.role_name,
      module_id: r.module_id ?? null,
      label: r.label ?? null,
      description: r.description ?? null,
      license_type: r.license_type ?? null,
      permission_type: r.permission_type ?? null,
      source: r.source ?? null,
      sub_roles: subs.map(s => ({
        role_name: s.role_name,
        is_transitive: s.is_transitive ?? null,
      })),
      duties: duties.slice(0, listCap).map(d => ({
        duty_id: d.duty_id,
        duty_name: d.duty_name ?? null,
        permission_type: d.permission_type ?? null,
      })),
      duty_count: duties.length,
      duties_truncated: duties.length > listCap,
      direct_privileges: dirPrivs.slice(0, listCap).map(p => p.privilege_name),
      direct_privilege_count: dirPrivs.length,
      direct_privileges_truncated: dirPrivs.length > listCap,
      direct_entity_permissions: dirPerms.map(p => {
        const row = { entity_name: p.entity_name };
        for (const c of liveGrants) row[c] = p[c] ?? null;
        return row;
      }),
      direct_entity_permission_count: permCount,
      direct_entity_permissions_truncated: dirPerms.length < permCount,
      assigned_user_count: userCount[0]?.n || 0,
    };
  }

  /** Markdown rendering of one role payload. `heading` = '##' (single) or '###' (batch). */
  function renderRole(typed, heading = '##') {
    let out = `${heading} ${typed.role_name}\n`;
    out += `| Property | Value |\n|---|---|\n`;
    out += `| Module | ${typed.module_id || 'N/A'} |\n`;
    out += `| License Type | ${typed.license_type || 'N/A'} |\n`;
    out += `| Permission | ${formatPermission(typed.permission_type)} |\n`;
    out += `| Source | ${typed.source ?? ''} |\n`;
    out += `| Description | ${typed.description || 'N/A'} |\n\n`;

    if (typed.sub_roles.length) {
      out += `${heading} Sub-Roles (${typed.sub_roles.length})\n`;
      out += formatMarkdownTable(typed.sub_roles, ['role_name', 'is_transitive']) + '\n\n';
    }

    if (typed.duties.length) {
      out += `${heading} Duties (${typed.duty_count})\n`;
      out += formatMarkdownTable(
        typed.duties.map(d => ({
          duty_id: d.duty_id,
          duty_name: d.duty_name ?? '',
          permission_type: formatPermission(d.permission_type),
        })),
        ['duty_id', 'duty_name', 'permission_type'],
      );
      out += typed.duties_truncated ? truncationNote('cap', typed.duties.length) + '\n' : '\n\n';
    }

    if (typed.direct_privileges.length) {
      out += `${heading} Direct Privileges (${typed.direct_privilege_count})\n`;
      out += typed.direct_privileges.map(p => `- ${p}`).join('\n');
      out += typed.direct_privileges_truncated ? truncationNote('cap', typed.direct_privileges.length) + '\n' : '\n\n';
    }

    if (typed.direct_entity_permissions.length) {
      const cols = Object.keys(typed.direct_entity_permissions[0]);
      out += `${heading} Direct Entity Permissions (${typed.direct_entity_permission_count})\n`;
      out += formatMarkdownTable(typed.direct_entity_permissions, cols);
      out += typed.direct_entity_permissions_truncated
        ? truncationNote('cap', typed.direct_entity_permissions.length, ROLE_ENTITY_PERMISSION_MAX) + '\n'
        : '\n\n';
    }

    if (typed.duties_truncated || typed.direct_privileges_truncated || typed.direct_entity_permissions_truncated) {
      out += `_Summary view. Pass \`include_entity_permissions: true\` for the complete lists, or raise \`entity_permission_limit\`._\n\n`;
    }

    out += `${heading} Assigned Users: ${typed.assigned_user_count}\n`;
    return out;
  }

  server.registerTool(
    'sec_lookup_role',
    {
      annotations: READ_ONLY_DB_ANNOTATIONS,
      description: 'Get security role details: description, license type, Grant/Deny, sub-roles, duties, direct privileges and entity permissions. Summary by default: first 50 per list + exact counts.',
      inputSchema: {
        role_name: z.string().min(1).max(500).optional().describe('Role name (case-insensitive). Use this or `role_names`.'),
        role_names: z.array(z.string().min(1).max(500)).min(1).max(ROLE_BATCH_MAX).optional()
          .describe(`Several roles in one call (max ${ROLE_BATCH_MAX}); the summary options apply to each. Unknown names come back in \`not_found\`.`),
        include_entity_permissions: z.boolean().optional().default(false)
          .describe('true: complete lists (can exceed 400 KB on wide roles)'),
        entity_permission_limit: z.number().int().min(1).max(ROLE_ENTITY_PERMISSION_MAX).optional().default(ROLE_SUMMARY_CAP)
          .describe(`Max entity permissions in the summary view (default ${ROLE_SUMMARY_CAP})`),
        format: formatTextParam,
      },
      outputSchema: secLookupRoleOutput.shape,
    },
    async ({ role_name, role_names, include_entity_permissions, entity_permission_limit, format }) => {
      const includeAll = include_entity_permissions === true;
      const entityLimit = Number.isInteger(entity_permission_limit) && entity_permission_limit > 0
        ? Math.min(entity_permission_limit, ROLE_ENTITY_PERMISSION_MAX) : ROLE_SUMMARY_CAP;

      // Batching (issue #83): singular and plural are unioned and deduped in
      // caller order; the summary options are hoisted (they apply to each).
      const requested = [...new Set([
        ...(Array.isArray(role_names) ? role_names : []),
        ...(role_name ? [role_name] : []),
      ].map(s => String(s).trim()).filter(Boolean))];
      if (!requested.length) return errorResult('invalid-input', 'Provide `role_name` or `role_names`.');
      const batchMode = Array.isArray(role_names) && role_names.length > 0;
      const names = requested.slice(0, ROLE_BATCH_MAX);
      const findRole = (rn) => q(`SELECT * FROM roles WHERE role_name = ? COLLATE NOCASE`, [rn])[0] ?? null;

      if (!batchMode) {
        const rn = names[0];
        const role = findRole(rn);
        if (!role) {
          const fuzzy = q(`SELECT role_name FROM roles WHERE role_name LIKE ? LIMIT 10`, [`%${rn}%`]);
          return notFoundResult('Role', rn, fuzzy.map(r => r.role_name));
        }
        // Exactly the pre-batching payload — no batch keys.
        const typed = buildRolePayload(role, { includeAll, entityLimit });
        return structuredResult(typed, renderRole(typed), format);
      }

      // Batch mode: only batch keys; a miss is data, not a failure.
      const roles = [];
      const notFound = [];
      for (const rn of names) {
        const role = findRole(rn);
        if (!role) { notFound.push(rn); continue; }
        roles.push(buildRolePayload(role, { includeAll, entityLimit }));
      }
      const typed = {
        requested_count: names.length,
        resolved_count: roles.length,
        not_found: notFound,
        roles,
      };
      let out = `## Roles (${typed.resolved_count} of ${typed.requested_count})\n\n`;
      for (const r of roles) out += renderRole(r, '###') + '\n';
      if (notFound.length) out += `**Not found:** ${notFound.join(', ')}\n`;
      if (requested.length > names.length) out += truncationNote('cap', names.length, ROLE_BATCH_MAX);
      return structuredResult(typed, out, format);
    }
  );

  // ── 2. sec_lookup_duty ──────────────────────────────────────────────────

  server.registerTool(
    'sec_lookup_duty',
    {
      annotations: READ_ONLY_DB_ANNOTATIONS,
      description: 'Get duty details: parent roles, privileges granted, and entry points.',
      inputSchema: {
        duty_name: z.string().min(1).max(500).describe('Duty ID or name (case-insensitive)'),
        limit: listLimitParam(LIST_CAP_DEFAULT),
        format: formatTextParam,
      },
      outputSchema: secLookupDutyOutput.shape,
    },
    async ({ duty_name, limit, format }) => {
      const lim = clampListLimit(limit, LIST_CAP_DEFAULT);
      const dn = duty_name.trim();
      const duty = q(`SELECT * FROM duties WHERE duty_id = ? COLLATE NOCASE
        OR duty_name = ? COLLATE NOCASE`, [dn, dn]);

      if (!duty.length) {
        const fuzzy = q(`SELECT duty_id, duty_name FROM duties
          WHERE duty_id LIKE ? OR duty_name LIKE ? LIMIT 10`, [`%${dn}%`, `%${dn}%`]);
        return notFoundResult('Duty', dn, fuzzy.map(r => r.duty_id));
      }

      const d = duty[0];
      const roles = q(`SELECT r.role_name, rd.permission_type
        FROM role_duties rd JOIN roles r ON r.role_id = rd.role_id
        WHERE rd.duty_id = ? ORDER BY r.role_name`, [d.duty_id]);
      const privs = q(`SELECT dp.privilege_name, p.label
        FROM duty_privileges dp LEFT JOIN privileges p ON p.privilege_name = dp.privilege_name
        WHERE dp.duty_id = ? ORDER BY dp.privilege_name`, [d.duty_id]);

      const typed = {
        duty_id: d.duty_id,
        duty_name: d.duty_name ?? null,
        module_id: d.module_id ?? null,
        description: d.description ?? null,
        role_count: roles.length,
        privilege_count: privs.length,
        truncated: roles.length > lim || privs.length > lim,
        roles: roles.slice(0, lim).map(r => ({
          role_name: r.role_name,
          permission_type: r.permission_type ?? null,
        })),
        privileges: privs.slice(0, lim).map(p => ({
          privilege_name: p.privilege_name,
          label: p.label ?? null,
        })),
      };

      let out = `## ${typed.duty_id}\n`;
      if (typed.duty_name) out += `**${typed.duty_name}**\n`;
      if (typed.module_id) out += `Module: ${typed.module_id}\n`;
      if (typed.description) out += `${typed.description}\n`;
      out += '\n';

      if (typed.roles.length) {
        out += `## Roles containing this duty (${typed.role_count})\n`;
        out += formatMarkdownTable(
          typed.roles.map(r => ({
            role_name: r.role_name,
            permission_type: formatPermission(r.permission_type),
          })),
          ['role_name', 'permission_type'],
        );
        out += capNote(typed.roles.length, typed.role_count);
      }

      if (typed.privileges.length) {
        out += `## Privileges (${typed.privilege_count})\n`;
        out += formatMarkdownTable(typed.privileges, ['privilege_name', 'label']);
        out += capNote(typed.privileges.length, typed.privilege_count);
      }

      return structuredResult(typed, out, format);
    }
  );

  // ── 3. sec_lookup_privilege ─────────────────────────────────────────────

  server.registerTool(
    'sec_lookup_privilege',
    {
      annotations: READ_ONLY_DB_ANNOTATIONS,
      description: 'Get privilege details: entry points with CRUD grants, parent duties, and parent roles.',
      inputSchema: {
        privilege_name: z.string().min(1).max(500).describe('Privilege name (case-insensitive)'),
        limit: listLimitParam(LIST_CAP_DEFAULT),
        format: formatTextParam,
      },
      outputSchema: secLookupPrivilegeOutput.shape,
    },
    async ({ privilege_name, limit, format }) => {
      const lim = clampListLimit(limit, LIST_CAP_DEFAULT);
      const pn = privilege_name.trim();
      const priv = q(`SELECT * FROM privileges WHERE privilege_name = ? COLLATE NOCASE`, [pn]);

      if (!priv.length) {
        const fuzzy = q(`SELECT privilege_name, label FROM privileges
          WHERE privilege_name LIKE ? LIMIT 10`, [`%${pn}%`]);
        return notFoundResult('Privilege', pn, fuzzy.map(r => r.privilege_name));
      }

      const p = priv[0];
      const eps = q(`SELECT * FROM privilege_entry_points
        WHERE privilege_name = ? ORDER BY entry_point_name`, [p.privilege_name]);
      const duties = q(`SELECT dp.duty_id, d.duty_name
        FROM duty_privileges dp LEFT JOIN duties d ON d.duty_id = dp.duty_id
        WHERE dp.privilege_name = ? ORDER BY dp.duty_id`, [p.privilege_name]);
      const roles = q(`SELECT DISTINCT r.role_name, rd.permission_type
        FROM duty_privileges dp
        JOIN role_duties rd ON rd.duty_id = dp.duty_id
        JOIN roles r ON r.role_id = rd.role_id
        WHERE dp.privilege_name = ?
        ORDER BY r.role_name`, [p.privilege_name]);

      const typed = {
        privilege_name: p.privilege_name,
        module_id: p.module_id ?? null,
        label: p.label ?? null,
        entry_point_count: eps.length,
        parent_duty_count: duties.length,
        granting_role_count: roles.length,
        truncated: eps.length > lim || duties.length > lim || roles.length > lim,
        entry_points: eps.slice(0, lim).map(ep => ({
          entry_point_name: ep.entry_point_name,
          object_type: ep.object_type ?? null,
          object_name: ep.object_name ?? null,
          grant_read: ep.grant_read ?? null,
          grant_create: ep.grant_create ?? null,
          grant_update: ep.grant_update ?? null,
          grant_delete: ep.grant_delete ?? null,
          grant_correct: ep.grant_correct ?? null,
          grant_invoke: ep.grant_invoke ?? null,
        })),
        parent_duties: duties.slice(0, lim).map(d => ({
          duty_id: d.duty_id,
          duty_name: d.duty_name ?? null,
        })),
        granting_roles: roles.slice(0, lim).map(r => ({
          role_name: r.role_name,
          permission_type: r.permission_type ?? null,
        })),
      };

      let out = `## ${typed.privilege_name}\n`;
      if (typed.label) out += `**${typed.label}**\n`;
      if (typed.module_id) out += `Module: ${typed.module_id}\n\n`;

      if (typed.entry_points.length) {
        out += `## Entry Points (${typed.entry_point_count})\n`;
        out += formatMarkdownTable(typed.entry_points,
          ['entry_point_name', 'object_type', 'object_name',
           'grant_read', 'grant_create', 'grant_update', 'grant_delete', 'grant_invoke']);
        out += capNote(typed.entry_points.length, typed.entry_point_count);
      }

      if (typed.parent_duties.length) {
        out += `## Parent Duties (${typed.parent_duty_count})\n`;
        out += formatMarkdownTable(typed.parent_duties, ['duty_id', 'duty_name']);
        out += capNote(typed.parent_duties.length, typed.parent_duty_count);
      }

      if (typed.granting_roles.length) {
        out += `## Roles granting this privilege (${typed.granting_role_count})\n`;
        out += formatMarkdownTable(
          typed.granting_roles.map(r => ({
            role_name: r.role_name,
            permission_type: formatPermission(r.permission_type),
          })),
          ['role_name', 'permission_type'],
        );
        out += capNote(typed.granting_roles.length, typed.granting_role_count);
      }

      return structuredResult(typed, out, format);
    }
  );

  // ── 4. sec_lookup_user ──────────────────────────────────────────────────

  server.registerTool(
    'sec_lookup_user',
    {
      annotations: READ_ONLY_DB_ANNOTATIONS,
      description: 'Get user profile: roles, company scoping, enabled status, and email.',
      inputSchema: {
        user_id: z.string().min(1).max(500).describe('User ID (case-insensitive)'),
        limit: listLimitParam(LIST_CAP_DEFAULT),
        format: formatTextParam,
      },
      outputSchema: secLookupUserOutput.shape,
    },
    async ({ user_id, limit, format }) => {
      const lim = clampListLimit(limit, LIST_CAP_DEFAULT);
      const uid = user_id.trim();
      const user = q(`SELECT * FROM users WHERE user_id = ? COLLATE NOCASE`, [uid]);

      if (!user.length) {
        const fuzzy = q(`SELECT user_id, person_name, email FROM users
          WHERE user_id LIKE ? OR person_name LIKE ? OR email LIKE ? LIMIT 10`,
          [`%${uid}%`, `%${uid}%`, `%${uid}%`]);
        return notFoundResult('User', uid, fuzzy.map(r => r.user_id));
      }

      const u = user[0];

      // Direct role assignments. Each row carries the role's company-scope
      // (P4-08) as a comma-joined string from `user_role_companies`. An empty
      // companies value means "(all)" — no restriction.
      const roleRows = q(`SELECT r.role_id, r.role_name, r.permission_type, r.license_type,
          GROUP_CONCAT(urc.company_id, ',') AS companies_csv
        FROM user_roles ur
        JOIN roles r ON r.role_id = ur.role_id COLLATE NOCASE
        LEFT JOIN user_role_companies urc
          ON urc.user_id = ur.user_id COLLATE NOCASE
         AND urc.role_id = ur.role_id COLLATE NOCASE
        WHERE ur.user_id = ? COLLATE NOCASE
        GROUP BY r.role_id
        ORDER BY r.role_name`, [u.user_id]);

      const companyRows = q(`SELECT urc.role_id, r.role_name, urc.company_id
        FROM user_role_companies urc
        JOIN roles r ON r.role_id = urc.role_id COLLATE NOCASE
        WHERE urc.user_id = ? COLLATE NOCASE
        ORDER BY r.role_name, urc.company_id`, [u.user_id]);

      // P4-03 / CR-SEC-001: transitive sub-role expansion via recursive CTE.
      // Schema confirmed against live DB: `role_subroles(parent_role_id,
      // child_role_id, is_transitive)`. The CTE seeds at the user's direct
      // role ids and walks down each sub-role chain. Excluding the direct
      // ids from the result keeps the section focused on what the user
      // *gains* through inheritance.
      const directRoleIds = roleRows.map(r => r.role_id);
      let subRoleRows = [];
      if (directRoleIds.length > 0) {
        const placeholders = directRoleIds.map(() => '?').join(',');
        subRoleRows = q(`
          WITH RECURSIVE rt(parent_id, child_id) AS (
            SELECT parent_role_id, child_role_id
            FROM role_subroles
            WHERE parent_role_id IN (${placeholders}) COLLATE NOCASE
            UNION ALL
            SELECT rt.parent_id, rs.child_role_id
            FROM role_subroles rs
            JOIN rt ON rs.parent_role_id = rt.child_id COLLATE NOCASE
          )
          SELECT DISTINCT child.role_name AS sub_role_name,
                          parent.role_name AS parent_role_name,
                          child.permission_type
          FROM rt
          JOIN roles child ON child.role_id = rt.child_id COLLATE NOCASE
          JOIN roles parent ON parent.role_id = rt.parent_id COLLATE NOCASE
          WHERE rt.child_id NOT IN (${placeholders}) COLLATE NOCASE
          ORDER BY parent.role_name, child.role_name
        `, [...directRoleIds, ...directRoleIds]);
      }

      // P4-03 / CR-SEC-004: Deny overrides.
      // Any role in the user's effective chain (direct OR via sub-role) that
      // declares a duty as Deny applies that Deny to the user. Surface them so
      // an agent answering "why is X blocked from Y?" sees the chain at a glance.
      let denyRows = [];
      if (directRoleIds.length > 0) {
        const placeholders = directRoleIds.map(() => '?').join(',');
        denyRows = q(`
          SELECT DISTINCT r.role_name, rd.duty_id, d.duty_name
          FROM role_duties rd
          JOIN roles r ON r.role_id = rd.role_id COLLATE NOCASE
          LEFT JOIN duties d ON d.duty_id = rd.duty_id COLLATE NOCASE
          WHERE rd.role_id IN (${placeholders})
            AND rd.permission_type = 'Deny'
          ORDER BY r.role_name, rd.duty_id
        `, directRoleIds);
      }

      const typed = {
        user_id: u.user_id,
        person_name: u.person_name ?? null,
        email: u.email ?? null,
        enabled: Boolean(u.enabled),
        default_company: u.default_company ?? null,
        // Each list is capped at `limit`; the *_count keys are exact totals.
        truncated: [roleRows, companyRows, subRoleRows, denyRows].some(a => a.length > lim),
        role_count: roleRows.length,
        roles: roleRows.slice(0, lim).map(r => ({
          role_name: r.role_name,
          permission_type: r.permission_type ?? null,
          license_type: r.license_type ?? null,
          companies: r.companies_csv
            ? [...new Set(r.companies_csv.split(',').filter(Boolean))].sort()
            : [],
        })),
        company_scoped_role_count: companyRows.length,
        company_scoped_roles: companyRows.slice(0, lim).map(r => ({
          role_name: r.role_name,
          company_id: r.company_id,
        })),
        effective_sub_role_count: subRoleRows.length,
        effective_sub_roles: subRoleRows.slice(0, lim).map(r => ({
          role_name: r.sub_role_name,
          parent_role_name: r.parent_role_name,
          permission_type: r.permission_type ?? null,
        })),
        deny_override_count: denyRows.length,
        deny_overrides: denyRows.slice(0, lim).map(r => ({
          role_name: r.role_name,
          duty_id: r.duty_id,
          duty_name: r.duty_name ?? null,
        })),
      };

      // Markdown fallback rendered from the typed object.
      let out = `## ${typed.user_id}\n`;
      out += `| Property | Value |\n|---|---|\n`;
      out += `| Name | ${typed.person_name || 'N/A'} |\n`;
      out += `| Email | ${typed.email || 'N/A'} |\n`;
      out += `| Enabled | ${typed.enabled ? 'Yes' : 'No'} |\n`;
      out += `| Default Company | ${typed.default_company || 'N/A'} |\n\n`;

      if (typed.role_count > 0) {
        out += `## Assigned Roles (${typed.role_count})\n`;
        out += formatMarkdownTable(
          typed.roles.map(r => ({
            role_name: r.role_name,
            permission_type: formatPermission(r.permission_type),
            license_type: r.license_type ?? '',
            companies: r.companies.length > 0 ? r.companies.join(', ') : '(all)',
          })),
          ['role_name', 'permission_type', 'license_type', 'companies'],
        );
        out += capNote(typed.roles.length, typed.role_count);
      }

      out += `## Effective Sub-Roles (${typed.effective_sub_role_count})\n`;
      if (typed.effective_sub_role_count > 0) {
        out += formatMarkdownTable(typed.effective_sub_roles,
          ['role_name', 'parent_role_name', 'permission_type']);
        out += capNote(typed.effective_sub_roles.length, typed.effective_sub_role_count);
      } else {
        out += '_No sub-role inheritance for this user._\n\n';
      }

      if (typed.deny_override_count > 0) {
        out += `## Deny Overrides (${typed.deny_override_count})\n`;
        out += `_⛔ The following roles in this user's chain declare Deny on a duty. These actively REMOVE permissions and are excluded from \`sec_effective_permissions\`._\n\n`;
        out += formatMarkdownTable(
          typed.deny_overrides.map(d => ({
            role_name: d.role_name,
            duty_id: d.duty_id,
            duty_name: d.duty_name ?? '',
            permission: formatPermission('Deny'),
          })),
          ['role_name', 'duty_id', 'duty_name', 'permission'],
        );
        out += capNote(typed.deny_overrides.length, typed.deny_override_count);
      }

      // The PM-05 "Company-Scoped Roles" section is now redundant with the
      // Companies column inside Assigned Roles — keep it as a flat list for
      // backward compat and to make grep-style searches easy.
      if (typed.company_scoped_role_count > 0) {
        out += `## Company-Scoped Role Pairs (${typed.company_scoped_role_count})\n`;
        out += formatMarkdownTable(typed.company_scoped_roles, ['role_name', 'company_id']);
        out += capNote(typed.company_scoped_roles.length, typed.company_scoped_role_count);
      }

      return structuredResult(typed, out, format);
    }
  );

  // ── 5. sec_role_hierarchy ───────────────────────────────────────────────

  server.registerTool(
    'sec_role_hierarchy',
    {
      annotations: READ_ONLY_DB_ANNOTATIONS,
      description: 'Show the sub-role hierarchy for a role (children that inherit from it, or parents it inherits from).',
      inputSchema: {
      role_name: z.string().min(1).max(500).describe('Role name'),
      direction: z.enum(['children', 'parents']).default('children').describe('Traverse direction'),
      limit: z.number().int().min(1).max(1000).optional().default(100).describe('Max related roles (default 100)'),
      format: formatTextParam,
    },
      outputSchema: secRoleHierarchyOutput.shape,
    },
    async ({ role_name, direction, limit, format }) => {
      const dir = direction || 'children';
      const lim = Number.isInteger(limit) && limit > 0 ? Math.min(limit, 1000) : 100;
      const role = q(`SELECT role_id, role_name FROM roles WHERE role_name = ? COLLATE NOCASE`, [role_name.trim()]);
      if (!role.length) return notFoundResult('Role', role_name);
      const r = role[0];

      let rows;
      if (dir === 'children') {
        rows = q(`SELECT child.role_name, rs.is_transitive
          FROM role_subroles rs JOIN roles child ON child.role_id = rs.child_role_id
          WHERE rs.parent_role_id = ? ORDER BY child.role_name`, [r.role_id]);
      } else {
        rows = q(`SELECT parent.role_name, rs.is_transitive
          FROM role_subroles rs JOIN roles parent ON parent.role_id = rs.parent_role_id
          WHERE rs.child_role_id = ? ORDER BY parent.role_name`, [r.role_id]);
      }

      if (!rows.length) return emptyResult(`${dir} of role "${r.role_name}"`, {
        role_name: r.role_name,
        direction: dir,
        result_count: 0,
        truncated: false,
        entries: [],
      });

      const typed = {
        role_name: r.role_name,
        direction: dir,
        result_count: rows.length,
        truncated: rows.length > lim,
        entries: rows.slice(0, lim).map(row => ({
          role_name: row.role_name,
          is_transitive: row.is_transitive ?? null,
        })),
      };

      let out = `## ${typed.role_name} — ${typed.direction}\n`;
      out += formatMarkdownTable(typed.entries, ['role_name', 'is_transitive']);
      if (typed.truncated) out += truncationNote('cap', typed.entries.length, 1000);
      return structuredResult(typed, out, format);
    }
  );

  // ── 6. sec_find_users_by_role ───────────────────────────────────────────

  server.registerTool(
    'sec_find_users_by_role',
    {
      annotations: READ_ONLY_DB_ANNOTATIONS,
      description: 'Find all users assigned to a role, optionally filtered to a specific company.',
      inputSchema: {
      role_name: z.string().min(1).max(500).describe('Role name'),
      company_id: z.string().min(1).max(500).optional().describe('Filter to users scoped to this company'),
      limit: z.number().int().min(1).max(500).optional().default(100).describe('Max results'),
      format: formatTextParam,
    },
      outputSchema: secFindUsersByRoleOutput.shape,
    },
    async ({ role_name, company_id, limit: rawLimit, format }) => {
      const limit = Number.isInteger(rawLimit) && rawLimit > 0 ? rawLimit : 100;
      const role = q(`SELECT role_id, role_name, permission_type FROM roles WHERE role_name = ? COLLATE NOCASE`, [role_name.trim()]);
      if (!role.length) return notFoundResult('Role', role_name);
      const r = role[0];

      // P4-02 / CR-SEC-002: a role whose top-level `permission_type` is 'Deny'
      // applies its assignments as denials, not grants. Effective-membership
      // queries must exclude Deny roles (they remove permissions, they don't
      // grant them). `sec_permission_trace` keeps Deny roles annotated; this
      // tool does not.
      if (r.permission_type === 'Deny') {
        return emptyResult(`users effectively granted role "${r.role_name}" (this role is a Deny role and does not grant access — use sec_permission_trace to inspect overrides)`, {
          role_name: r.role_name,
          company_id: company_id ? company_id.trim() : null,
          limit,
          result_count: 0,
          truncated: false,
          deny_role: true,
          users: [],
        });
      }

      let sql, params;
      if (company_id) {
        sql = `SELECT u.user_id, u.person_name, u.email, u.enabled, urc.company_id
          FROM user_roles ur
          JOIN users u ON u.user_id = ur.user_id
          JOIN user_role_companies urc ON urc.user_id = ur.user_id AND urc.role_id = ur.role_id
          WHERE ur.role_id = ? AND urc.company_id = ? COLLATE NOCASE
          ORDER BY u.user_id LIMIT ?`;
        params = [r.role_id, company_id.trim(), limit];
      } else {
        sql = `SELECT u.user_id, u.person_name, u.email, u.enabled
          FROM user_roles ur JOIN users u ON u.user_id = ur.user_id
          WHERE ur.role_id = ?
          ORDER BY u.user_id LIMIT ?`;
        params = [r.role_id, limit];
      }

      const rows = q(sql, params);
      if (!rows.length) return emptyResult(`users with role "${r.role_name}"` +
        (company_id ? ` in company ${company_id}` : ''), {
        role_name: r.role_name,
        company_id: company_id ? company_id.trim() : null,
        limit,
        result_count: 0,
        truncated: false,
        deny_role: false,
        users: [],
      });

      const typed = {
        role_name: r.role_name,
        company_id: company_id ? company_id.trim() : null,
        limit,
        result_count: rows.length,
        truncated: rows.length >= limit,
        deny_role: false,
        users: rows.map(row => ({
          user_id: row.user_id,
          person_name: row.person_name ?? null,
          email: row.email ?? null,
          enabled: row.enabled ?? null,
          company_id: row.company_id ?? null,
        })),
      };

      let out = `## Users with role: ${typed.role_name}`;
      if (typed.company_id) out += ` (company: ${typed.company_id})`;
      out += `\n${typed.result_count} user(s)\n\n`;
      out += `_Note: Deny overrides are not applied here. Use \`sec_permission_trace\` for the full picture._\n\n`;
      out += formatMarkdownTable(typed.users);
      if (typed.truncated) out += truncationNote('user', limit);
      return structuredResult(typed, out, format);
    }
  );

  // ── 7. sec_find_roles_by_duty ───────────────────────────────────────────

  server.registerTool(
    'sec_find_roles_by_duty',
    {
      annotations: READ_ONLY_DB_ANNOTATIONS,
      description: 'Find all roles that contain a specific duty.',
      inputSchema: {
        duty_name: z.string().min(1).max(500).describe('Duty ID or name'),
        limit: listLimitParam(FIND_CAP_DEFAULT),
        cursor: cursorParam,
        format: formatTextParam,
      },
      outputSchema: secFindRolesByDutyOutput.shape,
    },
    async ({ duty_name, limit, cursor, format }) => {
      const lim = clampListLimit(limit, FIND_CAP_DEFAULT);
      const page = decodeCursor(cursor);
      if (!page.ok) return page.error;
      const dn = duty_name.trim();
      const duty = q(`SELECT duty_id FROM duties
        WHERE duty_id = ? COLLATE NOCASE OR duty_name = ? COLLATE NOCASE`, [dn, dn]);
      if (!duty.length) return notFoundResult('Duty', dn);

      // P4-02 / CR-SEC-002: only Grant assignments count — a role that
      // declares this duty as Deny is *removing* it, not granting it. To
      // see the full picture (Grant + Deny rows), use `sec_permission_trace`.
      const rows = q(`SELECT r.role_name, r.permission_type, r.license_type, rd.permission_type as duty_permission
        FROM role_duties rd JOIN roles r ON r.role_id = rd.role_id COLLATE NOCASE
        WHERE rd.duty_id = ? COLLATE NOCASE
          AND rd.permission_type = 'Grant'
        ORDER BY r.role_name`, [duty[0].duty_id]);

      if (!rows.length) return emptyResult(`roles granting duty "${dn}"`, {
        duty_id: duty[0].duty_id,
        result_count: 0,
        truncated: false,
        roles: [],
        has_more: false,
      });

      // The whole list is in memory (ordered by role_name), so the cursor is a
      // plain offset; result_count stays the exact total (#109).
      const pageRows = rows.slice(page.offset, page.offset + lim);
      const typed = {
        duty_id: duty[0].duty_id,
        result_count: rows.length,
        truncated: rows.length > lim,
        roles: pageRows.map(r => ({
          role_name: r.role_name,
          permission_type: r.permission_type ?? null,
          license_type: r.license_type ?? null,
          duty_permission: r.duty_permission ?? null,
        })),
        ...pageMeta(null, page.offset, pageRows.length, lim, page.offset + pageRows.length < rows.length),
      };

      let out = `## Roles granting duty: ${typed.duty_id}\n${typed.result_count} role(s)\n\n`;
      out += `_Note: Deny overrides are excluded from this result. Use \`sec_permission_trace\` to see the full picture._\n\n`;
      out += formatMarkdownTable(
        typed.roles.map(r => ({
          role_name: r.role_name,
          permission_type: formatPermission(r.permission_type),
          license_type: r.license_type ?? '',
          duty_permission: formatPermission(r.duty_permission),
        })),
        ['role_name', 'permission_type', 'license_type', 'duty_permission'],
      );
      if (typed.has_more) out += pageNote(typed.roles.length, page.offset, typed.next_cursor);
      return structuredResult(typed, out, format);
    }
  );

  // ── 8. sec_find_roles_by_privilege ──────────────────────────────────────

  server.registerTool(
    'sec_find_roles_by_privilege',
    {
      annotations: READ_ONLY_DB_ANNOTATIONS,
      description: 'Find all roles that grant a privilege (via the duty chain or directly).',
      inputSchema: {
        privilege_name: z.string().min(1).max(500).describe('Privilege name'),
        limit: listLimitParam(FIND_CAP_DEFAULT),
        cursor: cursorParam,
        format: formatTextParam,
      },
      outputSchema: secFindRolesByPrivilegeOutput.shape,
    },
    async ({ privilege_name, limit, cursor, format }) => {
      const lim = clampListLimit(limit, FIND_CAP_DEFAULT);
      const page = decodeCursor(cursor);
      if (!page.ok) return page.error;
      const pn = privilege_name.trim();

      // Via duty chain. duty_id completes the ORDER BY: one role can reach the
      // privilege through several duties, and OFFSET needs a stable order.
      const viaChain = q(`SELECT DISTINCT r.role_name, rd.permission_type, d.duty_id
        FROM duty_privileges dp
        JOIN role_duties rd ON rd.duty_id = dp.duty_id
        JOIN roles r ON r.role_id = rd.role_id
        JOIN duties d ON d.duty_id = dp.duty_id
        WHERE dp.privilege_name = ? COLLATE NOCASE
        ORDER BY r.role_name, d.duty_id`, [pn]);

      // Direct assignments
      const direct = q(`SELECT r.role_name
        FROM role_direct_privileges rdp JOIN roles r ON r.role_id = rdp.role_id
        WHERE rdp.privilege_name = ? COLLATE NOCASE
        ORDER BY r.role_name`, [pn]);

      if (!viaChain.length && !direct.length) {
        return emptyResult(`roles granting privilege "${pn}"`, {
          privilege_name: pn,
          via_chain_count: 0,
          direct_count: 0,
          truncated: false,
          via_chain: [],
          direct: [],
          has_more: false,
        });
      }

      // One cursor pages both lists in step (same offset, same page size); the
      // *_count keys stay the exact totals (#109).
      const chainPage = viaChain.slice(page.offset, page.offset + lim);
      const directPage = direct.slice(page.offset, page.offset + lim);
      const hasMore = page.offset + lim < viaChain.length || page.offset + lim < direct.length;
      const typed = {
        privilege_name: pn,
        via_chain_count: viaChain.length,
        direct_count: direct.length,
        truncated: viaChain.length > lim || direct.length > lim,
        via_chain: chainPage.map(v => ({
          role_name: v.role_name,
          permission_type: v.permission_type ?? null,
          duty_id: v.duty_id,
        })),
        direct: directPage.map(d => ({ role_name: d.role_name })),
        ...pageMeta(null, page.offset, Math.max(chainPage.length, directPage.length), lim, hasMore),
      };

      let out = `## Roles granting privilege: ${typed.privilege_name}\n\n`;
      if (typed.via_chain_count > 0) {
        out += `## Via Duty Chain (${typed.via_chain_count})\n`;
        out += formatMarkdownTable(
          typed.via_chain.map(v => ({
            role_name: v.role_name,
            permission_type: formatPermission(v.permission_type),
            duty_id: v.duty_id,
          })),
          ['role_name', 'permission_type', 'duty_id'],
        );
        out += capNote(typed.via_chain.length, typed.via_chain_count);
      }
      if (typed.direct_count > 0) {
        out += `## Direct Assignment (${typed.direct_count})\n`;
        out += formatMarkdownTable(
          typed.direct.map(d => ({ role_name: d.role_name, via: 'Direct' })),
          ['role_name', 'via'],
        );
        out += capNote(typed.direct.length, typed.direct_count);
      }
      if (typed.has_more) out += pageNote(Math.max(typed.via_chain.length, typed.direct.length), page.offset, typed.next_cursor);

      return structuredResult(typed, out, format);
    }
  );

  // ── 9. sec_company_users ────────────────────────────────────────────────

  server.registerTool(
    'sec_company_users',
    {
      annotations: READ_ONLY_DB_ANNOTATIONS,
      description: 'List all users and their roles for a specific company (legal entity).',
      inputSchema: {
      company_id: z.string().min(1).max(500).describe('Company / legal entity ID (e.g., LADE, TAB)'),
      limit: z.number().int().min(1).max(500).optional().default(200).describe('Max results'),
      format: formatTextParam,
    },
      outputSchema: secCompanyUsersOutput.shape,
    },
    async ({ company_id, limit: rawLimit, format }) => {
      const limit = Number.isInteger(rawLimit) && rawLimit > 0 ? rawLimit : 200;
      const cid = company_id.trim().toUpperCase();

      const rows = q(`SELECT u.user_id, u.person_name, u.email, r.role_name, r.permission_type
        FROM user_role_companies urc
        JOIN users u ON u.user_id = urc.user_id
        JOIN roles r ON r.role_id = urc.role_id
        WHERE urc.company_id = ?
        ORDER BY u.user_id, r.role_name
        LIMIT ?`, [cid, limit]);

      if (!rows.length) return emptyResult(`users assigned to company "${cid}"`, {
        company_id: cid,
        limit,
        result_count: 0,
        truncated: false,
        assignments: [],
      });

      const typed = {
        company_id: cid,
        limit,
        result_count: rows.length,
        truncated: rows.length >= limit,
        assignments: rows.map(r => ({
          user_id: r.user_id,
          person_name: r.person_name ?? null,
          email: r.email ?? null,
          role_name: r.role_name,
          permission_type: r.permission_type ?? null,
        })),
      };

      let out = `## Company: ${typed.company_id}\n${typed.result_count} user-role assignment(s)\n\n`;
      out += formatMarkdownTable(
        typed.assignments.map(r => ({
          user_id: r.user_id,
          person_name: r.person_name ?? '',
          role_name: r.role_name,
          permission_type: formatPermission(r.permission_type),
        })),
        ['user_id', 'person_name', 'role_name', 'permission_type'],
      );
      if (typed.truncated) out += truncationNote('user', limit);
      return structuredResult(typed, out, format);
    }
  );

  // ── 10. sec_permission_trace ────────────────────────────────────────────

  server.registerTool(
    'sec_permission_trace',
    {
      annotations: READ_ONLY_DB_ANNOTATIONS,
      description: 'Trace the full permission chain for a role: role -> duties -> privileges -> entry points with CRUD. Optionally filter to a specific target object.',
      inputSchema: {
      role_name: z.string().min(1).max(500).describe('Role name'),
      object_name: z.string().min(1).max(500).optional().describe('Filter to entry points targeting this object'),
      limit: z.number().int().min(1).max(500).optional().default(500).describe('Max results'),
      format: formatTextParam,
    },
      outputSchema: secPermissionTraceOutput.shape,
    },
    async ({ role_name, object_name, limit: rawLimit, format }) => {
      const limit = Number.isInteger(rawLimit) && rawLimit > 0 ? rawLimit : 500;
      const role = q(`SELECT role_id, role_name FROM roles WHERE role_name = ? COLLATE NOCASE`, [role_name.trim()]);
      if (!role.length) return notFoundResult('Role', role_name);

      let objectFilter = '';
      const objParam = object_name ? `%${object_name.trim()}%` : null;
      if (objParam) objectFilter = ' AND ep.object_name LIKE ?';

      // Params: CTE base (1), first branch objectFilter (0-1), second branch objectFilter (0-1), LIMIT (1)
      const params = [role[0].role_id];
      if (objParam) params.push(objParam);
      if (objParam) params.push(objParam);
      params.push(limit);

      const trace = q(`
        WITH RECURSIVE role_tree AS (
          SELECT role_id FROM roles WHERE role_id = ?
          UNION ALL
          SELECT rs.child_role_id FROM role_subroles rs JOIN role_tree rt ON rs.parent_role_id = rt.role_id
        )
        SELECT rd.permission_type, d.duty_id as duty_id,
               dp.privilege_name as priv_name,
               ep.object_type, ep.object_name,
               ep.grant_read, ep.grant_create, ep.grant_update,
               ep.grant_delete, ep.grant_correct, ep.grant_invoke
        FROM role_tree rtree
        JOIN role_duties rd ON rd.role_id = rtree.role_id
        JOIN duties d ON d.duty_id = rd.duty_id
        JOIN duty_privileges dp ON dp.duty_id = d.duty_id
        JOIN privileges p ON p.privilege_name = dp.privilege_name
        JOIN privilege_entry_points ep ON ep.privilege_name = p.privilege_name
        WHERE 1=1 ${objectFilter}
        UNION ALL
        SELECT 'Grant' as permission_type, '(direct)' as duty_id,
               rp.privilege_name as priv_name,
               ep.object_type, ep.object_name,
               ep.grant_read, ep.grant_create, ep.grant_update,
               ep.grant_delete, ep.grant_correct, ep.grant_invoke
        FROM role_tree rtree
        JOIN role_direct_privileges rp ON rp.role_id = rtree.role_id
        JOIN privilege_entry_points ep ON ep.privilege_name = rp.privilege_name
        WHERE 1=1 ${objectFilter}
        ORDER BY 2, 3, 5
        LIMIT ?
      `, params);

      if (!trace.length) {
        return emptyResult(`permission chain for "${role[0].role_name}"` +
          (object_name ? ` targeting "${object_name}"` : ''), {
          role_name: role[0].role_name,
          object_name: object_name ?? null,
          limit,
          result_count: 0,
          truncated: false,
          grant_count: 0,
          deny_count: 0,
          rows: [],
        });
      }

      const denyCount = trace.filter(t => t.permission_type === 'Deny').length;
      const grantCount = trace.length - denyCount;

      const typed = {
        role_name: role[0].role_name,
        object_name: object_name ?? null,
        limit,
        result_count: trace.length,
        truncated: trace.length >= limit,
        grant_count: grantCount,
        deny_count: denyCount,
        rows: trace.map(t => ({
          permission_type: t.permission_type ?? null,
          duty_id: t.duty_id ?? null,
          priv_name: t.priv_name,
          object_type: t.object_type ?? null,
          object_name: t.object_name ?? null,
          grant_read: t.grant_read ?? null,
          grant_create: t.grant_create ?? null,
          grant_update: t.grant_update ?? null,
          grant_delete: t.grant_delete ?? null,
          grant_correct: t.grant_correct ?? null,
          grant_invoke: t.grant_invoke ?? null,
        })),
      };

      // P4-02 / CR-SEC-002: `sec_permission_trace` is the ONLY permission
      // tool that intentionally surfaces Deny rows — it's the agent's window
      // into "why is this user blocked from X?". Annotate Deny rows with a
      // ⛔ marker as the first table column so the visual scan is unmissable.
      // P4-07: render CRUD flags as Y/N via formatCrudFlag.
      const annotated = typed.rows.map(t => ({
        Deny: t.permission_type === 'Deny' ? '⛔ DENIED' : '',
        duty_id: t.duty_id ?? '',
        priv_name: t.priv_name,
        object_type: t.object_type ?? '',
        object_name: t.object_name ?? '',
        grant_read: formatCrudFlag(t.grant_read),
        grant_create: formatCrudFlag(t.grant_create),
        grant_update: formatCrudFlag(t.grant_update),
        grant_delete: formatCrudFlag(t.grant_delete),
        grant_correct: formatCrudFlag(t.grant_correct),
        grant_invoke: formatCrudFlag(t.grant_invoke),
      }));

      let out = `## Permission Trace: ${typed.role_name}\n`;
      out += `${typed.result_count} entry point(s)` + (typed.object_name ? ` matching "${typed.object_name}"` : '') + '\n';
      out += `Grant rows: ${typed.grant_count} • Deny rows: ${typed.deny_count}\n\n`;
      // P4-07: explicit CRUD legend so an agent doesn't have to guess.
      // Co = Correct, Inv = Invoke (Invoke governs action menu items / buttons).
      out += `**Legend:** Y = granted • N = not granted • (empty) = no specification • Co = Correct • Inv = Invoke\n\n`;
      if (typed.deny_count > 0) {
        out += `_⛔ Deny rows actively REMOVE the listed access on the entry point and override grants (Deny wins). \`sec_effective_permissions\` resolves the net verdict; this view shows every contributing path._\n\n`;
      }
      out += formatMarkdownTable(annotated, [
        'Deny', 'duty_id', 'priv_name', 'object_type', 'object_name',
        'grant_read', 'grant_create', 'grant_update', 'grant_delete',
        'grant_correct', 'grant_invoke',
      ]);
      if (typed.truncated) out += truncationNote('user', limit);
      return structuredResult(typed, out, format);
    }
  );

  // ── 11. sec_compare_roles ───────────────────────────────────────────────

  server.registerTool(
    'sec_compare_roles',
    {
      annotations: READ_ONLY_DB_ANNOTATIONS,
      description: 'Compare two roles side by side: shared vs unique duties and privileges.',
      inputSchema: {
      role1: z.string().min(1).max(500).describe('First role name'),
      role2: z.string().min(1).max(500).describe('Second role name'),
      list_limit: z.number().int().min(1).max(2000).optional().default(50)
        .describe('Max names per list (default 50); counts stay exact'),
      format: formatTextParam,
    },
      outputSchema: secCompareRolesOutput.shape,
    },
    async ({ role1, role2, list_limit, format }) => {
      const listLimit = Number.isInteger(list_limit) && list_limit > 0 ? Math.min(list_limit, 2000) : 50;
      const r1 = q(`SELECT role_id, role_name FROM roles WHERE role_name = ? COLLATE NOCASE`, [role1.trim()]);
      const r2 = q(`SELECT role_id, role_name FROM roles WHERE role_name = ? COLLATE NOCASE`, [role2.trim()]);
      if (!r1.length) return notFoundResult('Role', role1);
      if (!r2.length) return notFoundResult('Role', role2);

      // P4-02 / CR-SEC-002: comparison must be against effective grants only.
      // Deny rows would falsely show up as "shared" duties when in fact one
      // role grants and the other denies the same duty id.
      const duties1 = new Set(q(`SELECT duty_id FROM role_duties WHERE role_id = ? AND permission_type = 'Grant'`, [r1[0].role_id]).map(r => r.duty_id));
      const duties2 = new Set(q(`SELECT duty_id FROM role_duties WHERE role_id = ? AND permission_type = 'Grant'`, [r2[0].role_id]).map(r => r.duty_id));

      const dShared = [...duties1].filter(d => duties2.has(d));
      const dOnly1 = [...duties1].filter(d => !duties2.has(d));
      const dOnly2 = [...duties2].filter(d => !duties1.has(d));

      const privs1 = new Set(q(`SELECT privilege_name FROM role_direct_privileges WHERE role_id = ?`, [r1[0].role_id]).map(r => r.privilege_name));
      const privs2 = new Set(q(`SELECT privilege_name FROM role_direct_privileges WHERE role_id = ?`, [r2[0].role_id]).map(r => r.privilege_name));

      const pShared = [...privs1].filter(p => privs2.has(p));
      const pOnly1 = [...privs1].filter(p => !privs2.has(p));
      const pOnly2 = [...privs2].filter(p => !privs1.has(p));

      // Summary by default (W3, #107.1): each list is capped at list_limit;
      // the *_count keys hold the exact sizes.
      const lists = [dShared, dOnly1, dOnly2, pShared, pOnly1, pOnly2];
      const typed = {
        role1: r1[0].role_name,
        role2: r2[0].role_name,
        list_limit: listLimit,
        truncated: lists.some(l => l.length > listLimit),
        duties_total_1: duties1.size,
        duties_total_2: duties2.size,
        duties_shared_count: dShared.length,
        duties_only_1_count: dOnly1.length,
        duties_only_2_count: dOnly2.length,
        duties_shared: dShared.slice(0, listLimit),
        duties_only_1: dOnly1.slice(0, listLimit),
        duties_only_2: dOnly2.slice(0, listLimit),
        direct_privs_total_1: privs1.size,
        direct_privs_total_2: privs2.size,
        direct_privs_shared_count: pShared.length,
        direct_privs_only_1_count: pOnly1.length,
        direct_privs_only_2_count: pOnly2.length,
        direct_privs_shared: pShared.slice(0, listLimit),
        direct_privs_only_1: pOnly1.slice(0, listLimit),
        direct_privs_only_2: pOnly2.slice(0, listLimit),
      };

      const renderList = (heading, items, total) => {
        if (!total) return '';
        let s = `${heading} (${total})\n` + items.map(d => `- ${d}`).join('\n');
        s += total > items.length ? truncationNote('cap', items.length, 2000) + '\n' : '\n\n';
        return s;
      };

      let out = `## Role Comparison\n`;
      out += `| | ${typed.role1} | ${typed.role2} |\n|---|---|---|\n`;
      out += `| Total Duties | ${typed.duties_total_1} | ${typed.duties_total_2} |\n`;
      out += `| Shared | ${typed.duties_shared_count} | ${typed.duties_shared_count} |\n`;
      out += `| Unique | ${typed.duties_only_1_count} | ${typed.duties_only_2_count} |\n\n`;

      out += renderList('## Shared Duties', typed.duties_shared, typed.duties_shared_count);
      out += renderList(`## Only in ${typed.role1}`, typed.duties_only_1, typed.duties_only_1_count);
      out += renderList(`## Only in ${typed.role2}`, typed.duties_only_2, typed.duties_only_2_count);

      if (typed.direct_privs_total_1 > 0 || typed.direct_privs_total_2 > 0) {
        out += `## Direct Privileges\n`;
        out += `| | ${typed.role1} | ${typed.role2} |\n|---|---|---|\n`;
        out += `| Total | ${typed.direct_privs_total_1} | ${typed.direct_privs_total_2} |\n`;
        out += `| Shared | ${typed.direct_privs_shared_count} | ${typed.direct_privs_shared_count} |\n`;
        out += `| Unique | ${typed.direct_privs_only_1_count} | ${typed.direct_privs_only_2_count} |\n\n`;

        out += renderList('### Shared Direct Privileges', typed.direct_privs_shared, typed.direct_privs_shared_count);
        out += renderList(`### Only in ${typed.role1}`, typed.direct_privs_only_1, typed.direct_privs_only_1_count);
        out += renderList(`### Only in ${typed.role2}`, typed.direct_privs_only_2, typed.direct_privs_only_2_count);
      }

      return structuredResult(typed, out, format);
    }
  );

  // ── 12. sec_effective_permissions ───────────────────────────────────────

  server.registerTool(
    'sec_effective_permissions',
    {
      annotations: READ_ONLY_DB_ANNOTATIONS,
      description: 'Compute the NET effective permissions for a user or role, resolving sub-roles and applying Deny-over-Grant (Deny wins). Returns one row per object with the effective verdict on all six access levels (Read/Create/Update/Delete/Correct/Invoke) and a status: granted (control enabled) · partial (some ops denied → control likely greyed) · denied (blocked). An object ABSENT from the result means no grant at all (control hidden). Consumes duty chains, direct privileges and direct entity permissions. Use to answer "can this user actually use this button, and if not why?".',
      inputSchema: {
        user_id: z.string().min(1).max(500).optional().describe('User ID (provide this OR role_name)'),
        role_name: z.string().min(1).max(500).optional().describe('Role name (provide this OR user_id)'),
        object_name: z.string().min(1).max(500).optional().describe('Filter to entry points for this object'),
        limit: z.number().int().min(1).max(500).optional().default(200).describe('Max results'),
        format: formatTextParam,
      },
      outputSchema: secEffectivePermissionsOutput.shape,
    },
    async ({ user_id, role_name, object_name, limit: rawLimit, format }) => {
      const limit = Number.isInteger(rawLimit) && rawLimit > 0 ? rawLimit : 200;

      let roleIds = [];
      let subjectType, subjectId, subjectLabel;

      if (user_id) {
        const uid = user_id.trim();
        const user = q(`SELECT user_id, person_name FROM users WHERE user_id = ? COLLATE NOCASE`, [uid]);
        if (!user.length) return notFoundResult('User', uid);
        subjectType = 'user';
        subjectId = user[0].user_id;
        subjectLabel = `User: ${user[0].user_id} (${user[0].person_name || 'N/A'})`;
        roleIds = q(`SELECT role_id FROM user_roles WHERE user_id = ?`, [user[0].user_id])
          .map(r => r.role_id);
      } else if (role_name) {
        const rn = role_name.trim();
        const role = q(`SELECT role_id, role_name FROM roles WHERE role_name = ? COLLATE NOCASE`, [rn]);
        if (!role.length) return notFoundResult('Role', rn);
        subjectType = 'role';
        subjectId = role[0].role_id;
        subjectLabel = `Role: ${role[0].role_name}`;
        roleIds = [role[0].role_id];
      } else {
        return errorResult('invalid-input', 'Provide either user_id or role_name.');
      }

      if (!roleIds.length) return emptyResult('roles assigned to the target', {
        subject_type: subjectType,
        subject_id: subjectId,
        subject_label: subjectLabel,
        role_count: 0,
        object_filter: object_name ?? null,
        entry_point_count: 0,
        truncated: false,
        permissions: [],
        denied_object_count: 0,
        effective: [],
      });

      const placeholders = roleIds.map(() => '?').join(',');
      const allRoleIds = new Set(roleIds);
      const expanded = q(`
        WITH RECURSIVE role_tree AS (
          SELECT role_id FROM roles WHERE role_id IN (${placeholders})
          UNION ALL
          SELECT rs.child_role_id FROM role_subroles rs JOIN role_tree rt ON rs.parent_role_id = rt.role_id
        )
        SELECT DISTINCT role_id FROM role_tree
      `, roleIds);
      for (const r of expanded) allRoleIds.add(r.role_id);

      const allRoleArr = [...allRoleIds];
      const allPlaceholders = allRoleArr.map(() => '?').join(',');

      const objParam = object_name ? `%${object_name.trim()}%` : null;
      const epFilter = objParam ? ' AND ep.object_name LIKE ?' : '';
      const entityFilter = objParam ? ' AND rdep.entity_name LIKE ?' : '';

      // Hard safety ceiling on contributing rows so a many-role user can't
      // pull millions of entry points into memory. The Deny-wins aggregation
      // below collapses these into one row per object.
      const RAW_CAP = 20000;
      const queryParams = [];
      queryParams.push(...allRoleArr);                 // branch 1: duties
      if (objParam) queryParams.push(objParam);
      queryParams.push(...allRoleArr);                 // branch 2: direct privileges
      if (objParam) queryParams.push(objParam);
      queryParams.push(...allRoleArr);                 // branch 3: direct entity perms
      if (objParam) queryParams.push(objParam);
      queryParams.push(RAW_CAP);

      // P4-02 / CR-SEC-002 superseded: effective permissions now resolve
      // Deny-over-Grant rather than dropping Deny rows. We gather every
      // contributing path — duty chain (Grant AND Deny), direct privileges,
      // and direct entity permissions — carrying the duty-level and role-level
      // permission_type so the aggregation can apply Deny-wins per operation.
      const rows = q(`
        SELECT ep.object_name, ep.object_type,
               ep.grant_read, ep.grant_create, ep.grant_update,
               ep.grant_delete, ep.grant_correct, ep.grant_invoke,
               rd.permission_type as duty_perm, r.permission_type as role_perm,
               'duty' as source
        FROM role_duties rd
        JOIN roles r ON r.role_id = rd.role_id
        JOIN duty_privileges dp ON dp.duty_id = rd.duty_id COLLATE NOCASE
        JOIN privilege_entry_points ep ON ep.privilege_name = dp.privilege_name COLLATE NOCASE
        WHERE rd.role_id IN (${allPlaceholders}) ${epFilter}
        UNION ALL
        SELECT ep.object_name, ep.object_type,
               ep.grant_read, ep.grant_create, ep.grant_update,
               ep.grant_delete, ep.grant_correct, ep.grant_invoke,
               'Grant' as duty_perm, r.permission_type as role_perm,
               'direct_priv' as source
        FROM role_direct_privileges rp
        JOIN roles r ON r.role_id = rp.role_id
        JOIN privilege_entry_points ep ON ep.privilege_name = rp.privilege_name COLLATE NOCASE
        WHERE rp.role_id IN (${allPlaceholders}) ${epFilter}
        UNION ALL
        SELECT rdep.entity_name as object_name, ${rdepObjectType} as object_type,
               rdep.grant_read, rdep.grant_create, rdep.grant_update,
               rdep.grant_delete, rdep.grant_correct, rdep.grant_invoke,
               'Grant' as duty_perm, r.permission_type as role_perm,
               'direct_entity' as source
        FROM role_direct_entity_permissions rdep
        JOIN roles r ON r.role_id = rdep.role_id
        WHERE rdep.role_id IN (${allPlaceholders}) ${entityFilter}
        LIMIT ?
      `, queryParams);

      if (!rows.length) {
        return emptyResult(`effective permissions for ${subjectLabel}` +
          (object_name ? ` on "${object_name}"` : ''), {
          subject_type: subjectType,
          subject_id: subjectId,
          subject_label: subjectLabel,
          role_count: allRoleArr.length,
          object_filter: object_name ?? null,
          entry_point_count: 0,
          truncated: false,
          permissions: [],
          denied_object_count: 0,
          effective: [],
        });
      }

      // ── Deny-wins aggregation ────────────────────────────────────────────
      // For each operation on a row, derive a per-op verdict: a path DENIES an
      // operation when the duty or role is a Deny carrier (it removes whatever
      // the privilege would have granted) or the stored grant value is itself
      // 'Deny'. Otherwise a non-null grant value means Allow. Across all paths
      // for an object, Deny on an op wins over Allow.
      const OPS = ['read', 'create', 'update', 'delete', 'correct', 'invoke'];
      const rowOpSignal = (row, op) => {
        const v = row['grant_' + op];
        if (v === null || v === undefined || v === '') return null;
        const pathDeny = row.duty_perm === 'Deny' || row.role_perm === 'Deny';
        if (pathDeny || /^deny$/i.test(String(v))) return 'Deny';
        return 'Allow';
      };

      const agg = new Map(); // key -> { object_name, object_type, ops{}, grantPath, denyPath }
      for (const row of rows) {
        const key = `${row.object_name}\0${row.object_type ?? ''}`;
        let e = agg.get(key);
        if (!e) {
          e = { object_name: row.object_name, object_type: row.object_type ?? null,
                ops: {}, grantPath: false, denyPath: false };
          agg.set(key, e);
        }
        const rowDeny = row.duty_perm === 'Deny' || row.role_perm === 'Deny';
        if (rowDeny) e.denyPath = true; else e.grantPath = true;
        for (const op of OPS) {
          const sig = rowOpSignal(row, op);
          if (sig === null) continue;
          // Deny wins: once Deny, stay Deny; otherwise Allow.
          if (e.ops[op] !== 'Deny') e.ops[op] = sig === 'Deny' ? 'Deny' : (e.ops[op] || 'Allow');
        }
      }

      const effective = [...agg.values()].map(e => {
        const present = OPS.filter(op => e.ops[op]);
        let status;
        if (present.length) {
          const anyDeny = present.some(op => e.ops[op] === 'Deny');
          const anyAllow = present.some(op => e.ops[op] === 'Allow');
          status = anyDeny && anyAllow ? 'partial' : anyDeny ? 'denied' : 'granted';
        } else {
          // Entry point referenced but with no explicit CRUD spec: launch
          // access governed purely by Grant vs Deny path presence.
          status = e.denyPath && !e.grantPath ? 'denied' : e.denyPath && e.grantPath ? 'partial' : 'granted';
        }
        return {
          object_name: e.object_name,
          object_type: e.object_type,
          effective_read: e.ops.read ?? null,
          effective_create: e.ops.create ?? null,
          effective_update: e.ops.update ?? null,
          effective_delete: e.ops.delete ?? null,
          effective_correct: e.ops.correct ?? null,
          effective_invoke: e.ops.invoke ?? null,
          status,
        };
      }).sort((a, b) => a.object_name.localeCompare(b.object_name));

      const deniedCount = effective.filter(e => e.status !== 'granted').length;
      const cappedEffective = effective.slice(0, limit);

      const typed = {
        subject_type: subjectType,
        subject_id: subjectId,
        subject_label: subjectLabel,
        role_count: allRoleArr.length,
        object_filter: object_name ?? null,
        entry_point_count: rows.length,
        truncated: rows.length >= RAW_CAP || effective.length > limit,
        permissions: rows.slice(0, limit).map(p => ({
          object_name: p.object_name,
          object_type: p.object_type ?? null,
          grant_read: p.grant_read ?? null,
          grant_create: p.grant_create ?? null,
          grant_update: p.grant_update ?? null,
          grant_delete: p.grant_delete ?? null,
          grant_correct: p.grant_correct ?? null,
          grant_invoke: p.grant_invoke ?? null,
          duty_perm: p.duty_perm ?? null,
          source: p.source ?? null,
        })),
        denied_object_count: deniedCount,
        effective: cappedEffective,
      };

      // ── Markdown fallback: lead with the Deny-wins resolved view ──────────
      let out = `## Effective Permissions\n${typed.subject_label}\n`;
      out += `${effective.length} object(s) • ${deniedCount} with a Deny override • from ${typed.entry_point_count} path(s) across ${typed.role_count} role(s)` +
             (typed.object_filter ? ` • filter "${typed.object_filter}"` : '') + '\n\n';
      out += `_Deny-wins applied: an explicit Deny on any operation overrides all Grants. ` +
             `**status** = granted (enabled) · partial (some ops denied → control likely greyed) · denied (blocked). ` +
             `An object **absent** here means no grant at all (control hidden)._\n\n`;
      out += `**Legend:** Y = allowed • ⛔ = denied • (empty) = no specification\n\n`;
      const flag = (v) => v == null || v === '' ? '' : (/^deny$/i.test(String(v)) ? '⛔' : 'Y');
      const renderedEff = cappedEffective.map(e => ({
        object_name: e.object_name,
        type: e.object_type ?? '',
        status: e.status,
        R: flag(e.effective_read),
        C: flag(e.effective_create),
        U: flag(e.effective_update),
        D: flag(e.effective_delete),
        Co: flag(e.effective_correct),
        Inv: flag(e.effective_invoke),
      }));
      out += formatMarkdownTable(renderedEff, [
        'object_name', 'type', 'status', 'R', 'C', 'U', 'D', 'Co', 'Inv',
      ]);
      if (typed.truncated) out += truncationNote('user', limit);

      return structuredResult(typed, out, format);
    }
  );

  // ── 13. sec_search ──────────────────────────────────────────────────────

  server.registerTool(
    'sec_search',
    {
      annotations: READ_ONLY_DB_ANNOTATIONS,
      description: 'Full-text search across roles, duties, privileges, and users. Scope with `modules` to search only security objects from specific models (e.g. only iExtension, an ISV model, or the Microsoft application — see sec_stats for the scanned build versions). Note: users carry no module and are excluded when the filter is set.',
      inputSchema: {
      query: z.string().min(1).max(500).describe('Search keywords'),
      object_type: z.enum(['role', 'duty', 'privilege', 'user']).optional().describe('Filter: role, duty, privilege, user'),
      modules: modulesFilterParam,
      limit: z.number().int().min(1).max(500).optional().default(20).describe('Max results'),
      cursor: cursorParam,
      format: formatTextParam,
    },
      outputSchema: secSearchOutput.shape,
    },
    async ({ query: searchQuery, object_type, modules, limit: rawLimit, cursor, format }) => {
      const limit = Number.isInteger(rawLimit) && rawLimit > 0 ? rawLimit : 20;
      const page = decodeCursor(cursor);
      if (!page.ok) return page.error;
      const moduleFilter = sanitizeModulesFilter(modules);
      const terms = searchQuery.trim().split(/\s+/).filter(Boolean);
      if (!terms.length) return errorResult('invalid-input', 'Provide at least one search term.');

      // Try FTS5 first (10-50x faster), fall back to LIKE if FTS5 table
      // doesn't exist (e.g., older DB builds or in-memory test DBs).
      let results;
      try {
        // FTS5 MATCH: each term becomes a prefix-match token.
        const ftsExpr = terms.map(t => `"${t.replace(/"/g, '""')}"*`).join(' AND ');
        let ftsSql = `
          SELECT s.object_type, s.object_name, s.module_id, s.content
          FROM sec_search_fts f
          JOIN sec_search s ON s.rowid = f.rowid
          WHERE sec_search_fts MATCH ?`;
        const ftsParams = [ftsExpr];
        if (object_type) {
          ftsSql += ' AND s.object_type = ?';
          ftsParams.push(object_type);
        }
        if (moduleFilter.length) {
          ftsSql += ` AND s.module_id COLLATE NOCASE IN (${moduleFilter.map(() => '?').join(', ')})`;
          ftsParams.push(...moduleFilter);
        }
        // rowid order is what the un-ordered query returned; explicit so OFFSET
        // is stable. limit+1 probe makes has_more exact (#109).
        ftsSql += ' ORDER BY s.rowid LIMIT ? OFFSET ?';
        ftsParams.push(probeLimit(limit), page.offset);
        results = q(ftsSql, ftsParams);
      } catch {
        // FTS5 table missing — fall back to LIKE scan.
        const likeParts = terms.map(() => '(object_name LIKE ? OR content LIKE ?)');
        const likeParams = terms.flatMap(t => [`%${t}%`, `%${t}%`]);

        let sql = `SELECT object_type, object_name, module_id, content
          FROM sec_search WHERE ${likeParts.join(' AND ')}`;
        if (object_type) {
          sql += ' AND object_type = ?';
          likeParams.push(object_type);
        }
        if (moduleFilter.length) {
          sql += ` AND module_id COLLATE NOCASE IN (${moduleFilter.map(() => '?').join(', ')})`;
          likeParams.push(...moduleFilter);
        }
        sql += ' ORDER BY rowid LIMIT ? OFFSET ?';
        likeParams.push(probeLimit(limit), page.offset);
        results = q(sql, likeParams);
      }
      const pageRows = takePage(results, limit);
      results = pageRows.rows;
      if (!results.length) return emptyResult(`matches for "${searchQuery}"`, {
        query: searchQuery,
        object_type: object_type ?? null,
        modules: moduleFilter.length ? moduleFilter : null,
        limit,
        result_count: 0,
        truncated: false,
        results: [],
        has_more: false,
      });

      // P4-09: center the snippet on the first matching term so matches at
      // position > 120 are no longer hidden. Use the first user term as the
      // anchor (multi-term queries highlight the first term only — good
      // enough for the search use case).
      const anchor = terms[0];
      const typed = {
        query: searchQuery,
        object_type: object_type ?? null,
        modules: moduleFilter.length ? moduleFilter : null,
        limit,
        result_count: results.length,
        truncated: pageRows.has_more,
        results: results.map(r => ({
          object_type: r.object_type ?? null,
          object_name: r.object_name,
          module_id: r.module_id ?? null,
          match_context: r.content ? contextAround(r.content, anchor, 60) : null,
        })),
        ...pageMeta(null, page.offset, results.length, limit, pageRows.has_more),
      };

      let out = `## Security search: "${typed.query}"\n\n`;
      if (typed.modules) out += `_Scope: modules ${typed.modules.join(', ')}_\n\n`;
      out += formatMarkdownTable(
        typed.results.map(r => ({
          object_type: r.object_type ?? '',
          object_name: r.object_name,
          module_id: r.module_id ?? '',
          match_context: r.match_context ?? '',
        })),
        ['object_type', 'object_name', 'module_id', 'match_context'],
      );
      if (typed.has_more) out += pageNote(typed.result_count, page.offset, typed.next_cursor);
      return structuredResult(typed, out, format);
    }
  );

  // ── 14. sec_stats ───────────────────────────────────────────────────────

  server.registerTool(
    'sec_stats',
    {
      annotations: READ_ONLY_DB_ANNOTATIONS,
      description: 'Security database statistics: role, user and company counts, scanned models by origin. include_model_versions=true lists each model with its build version.',
      inputSchema: {
        include_model_versions: z.boolean().optional().default(false)
          .describe('true: per-model build versions (Descriptor provenance)'),
        format: formatTextParam,
      },
      outputSchema: secStatsOutput.shape,
    },
    async ({ include_model_versions, format }) => {
      const meta = q('SELECT key, value FROM sec_metadata ORDER BY key');
      // Which build of each scanned model the security objects came from
      // ([] on sec databases built before model_versions capture).
      const versions = queryModelVersions(q);
      const byOrigin = { microsoft: 0, isv: 0, custom: 0 };
      for (const v of versions) {
        const o = String(v.origin ?? '').toLowerCase();
        if (o in byOrigin) byOrigin[o]++;
      }

      const typed = {
        build_info: meta.map(r => ({ key: r.key, value: String(r.value) })),
        model_count: versions.length,
        models_by_origin: byOrigin,
        grant_roles: q(`SELECT COUNT(*) as n FROM roles WHERE permission_type = 'Grant'`)[0]?.n || 0,
        deny_roles: q(`SELECT COUNT(*) as n FROM roles WHERE permission_type = 'Deny'`)[0]?.n || 0,
        total_duties: q(`SELECT COUNT(*) as n FROM duties`)[0]?.n || 0,
        total_privileges: q(`SELECT COUNT(*) as n FROM privileges`)[0]?.n || 0,
        total_entry_points: q(`SELECT COUNT(*) as n FROM privilege_entry_points`)[0]?.n || 0,
        enabled_users: q(`SELECT COUNT(*) as n FROM users WHERE enabled = 1`)[0]?.n || 0,
        disabled_users: q(`SELECT COUNT(*) as n FROM users WHERE enabled = 0`)[0]?.n || 0,
        user_role_assignments: q(`SELECT COUNT(*) as n FROM user_roles`)[0]?.n || 0,
        companies: q(`SELECT COUNT(DISTINCT company_id) as n FROM user_role_companies`)[0]?.n || 0,
      };
      // The 180-row list was 37 KB inside a *stats* call (#107.2): opt-in only,
      // and the key is absent (not an empty array) when it was not asked for.
      if (include_model_versions === true) {
        typed.model_versions = versions.map(v => ({
          model_name: v.model_name,
          module_id: v.module_id ?? null,
          display_name: v.display_name ?? null,
          publisher: v.publisher ?? null,
          layer: v.layer ?? null,
          origin: v.origin ?? null,
          version: v.version ?? null,
        }));
      }

      // P4-10: render Build Info as a bulleted list rather than a generic
      // |key|value| table. Build metadata has a fixed small set of keys and
      // every key has a one-line value — bullets are easier to scan than a
      // table whose columns add no information.
      let out = '## Security Database Statistics\n\n';
      out += '## Build Info\n';
      for (const row of typed.build_info) {
        out += `- **${row.key}:** ${row.value}\n`;
      }
      out += '\n';

      out += '## Breakdown\n';
      out += `| Metric | Value |\n|---|---|\n`;
      out += `| Grant Roles | ${typed.grant_roles} |\n`;
      out += `| Deny Roles | ${typed.deny_roles} |\n`;
      out += `| Total Duties | ${typed.total_duties} |\n`;
      out += `| Total Privileges | ${typed.total_privileges} |\n`;
      out += `| Total Entry Points | ${typed.total_entry_points} |\n`;
      out += `| Enabled Users | ${typed.enabled_users} |\n`;
      out += `| Disabled Users | ${typed.disabled_users} |\n`;
      out += `| User-Role Assignments | ${typed.user_role_assignments} |\n`;
      out += `| Companies | ${typed.companies} |\n`;
      out += `| Scanned Models | ${typed.model_count} (microsoft ${byOrigin.microsoft}, isv ${byOrigin.isv}, custom ${byOrigin.custom}) |\n`;

      if (typed.model_versions?.length) {
        out += '\n## Scanned Model Versions\n';
        out += formatMarkdownTable(
          typed.model_versions.map(m => ({
            Model: m.model_name,
            Module: m.module_id ?? '',
            Version: m.version ?? '',
            Layer: m.layer ?? '',
            Origin: m.origin ?? '',
            Publisher: m.publisher ?? '',
          })),
          ['Model', 'Module', 'Version', 'Layer', 'Origin', 'Publisher'],
        );
        out += '\n';
      }

      return structuredResult(typed, out, format);
    }
  );

  // ── 15. sec_raw_sql ─────────────────────────────────────────────────────

  server.registerTool(
    'sec_raw_sql',
    {
      annotations: READ_ONLY_DB_ANNOTATIONS,
      description: 'Execute a raw SQL query against the security database. READ-ONLY, 500-row limit. Schema: roles(role_id, role_name, label, description, module_id, license_type, permission_type, source), duties(duty_id, duty_name, module_id, description), privileges(privilege_name, module_id, label), role_duties(role_id, duty_id, permission_type), role_direct_privileges(role_id, privilege_name), duty_privileges(duty_id, privilege_name), privilege_entry_points(privilege_name, entry_point_name, object_type, object_name, grant_read, grant_create, grant_update, grant_delete, grant_correct, grant_invoke), users(user_id, person_name, email, enabled, default_company), user_roles(user_id, role_id), user_role_companies(user_id, role_id, company_id), role_subroles(parent_role_id, child_role_id, is_transitive), role_direct_entity_permissions(role_id, entity_name, grant_read, grant_create, grant_update, grant_delete, grant_correct, grant_invoke).',
      inputSchema: {
        sql: z.string().min(1).max(50000).describe('SQL SELECT query'),
        // The SHARED param (rule #5): a private z.enum(['markdown','toon'])
        // .default('toon') here pinned TOON and defeated the adaptive default.
        format: formatTextParam,
      },
      outputSchema: rawSqlOutput.shape,
    },
    async ({ sql: rawSql, format }) => {
      const SAFETY_CAP = 500;
      const trimmed = rawSql.trim().replace(/;+$/, '');
      if (!/^\s*(SELECT|WITH|PRAGMA)\b/i.test(trimmed)) {
        return errorResult('invalid-input', 'Only SELECT, WITH, and PRAGMA queries are allowed.');
      }

      // Reject dangerous keywords
      const forbidden = ['INSERT', 'UPDATE', 'DELETE', 'DROP', 'ALTER', 'CREATE', 'TRUNCATE', 'ATTACH', 'DETACH'];
      for (const kw of forbidden) {
        const regex = new RegExp(`\\b${kw}\\b`, 'i');
        if (regex.test(trimmed)) {
          return errorResult('invalid-input', `Forbidden keyword "${kw}" detected. Only read-only queries are allowed.`);
        }
      }

      let limited = trimmed;
      if (!/\bLIMIT\b/i.test(limited)) {
        limited += ` LIMIT ${SAFETY_CAP}`;
      }

      try {
        const rows = q(limited);
        if (!rows.length) return emptyResult('rows matching your query', {
          row_count: 0,
          truncated: false,
          columns: [],
          rows: [],
        });
        const columns = Object.keys(rows[0]);
        const truncated = rows.length >= SAFETY_CAP;
        const typed = {
          row_count: rows.length,
          truncated,
          columns,
          rows,
        };
        // structuredResult picks the smaller channel unless the caller pinned
        // one; `format` goes through untouched — rule #5.
        let md = formatMarkdownTable(rows);
        if (truncated) md += truncationNote('hard', SAFETY_CAP);
        return structuredResult(typed, md, format);
      } catch (err) {
        return errorResult('db-error', 'Check your SQL syntax and table/column names. Only read-only SELECT queries are supported.', err);
      }
    }
  );

  // ── 16. sec_licence_assessment ────────────────────────────────────────────

  server.registerTool(
    'sec_licence_assessment',
    {
      annotations: READ_ONLY_DB_ANNOTATIONS,
      description: 'Assess the minimum required D365 licence tier for one or all users based on their assigned security roles. Each role carries a UserLicenseType; the user requires the highest-cost tier across all Grant roles. Returns per-user breakdown and a tier summary.',
      inputSchema: {
        user_id: z.string().min(1).max(500).optional().describe('Assess a single user (omit for all enabled users)'),
        limit: z.number().int().min(1).max(500).optional().default(500).describe('Max users to return'),
        format: formatTextParam,
      },
      outputSchema: secLicenceAssessmentOutput.shape,
    },
    async ({ user_id, limit: rawLimit, format }) => {
      const limit = Number.isInteger(rawLimit) && rawLimit > 0 ? rawLimit : 500;
      const single = !!user_id;

      let userFilter = 'WHERE u.enabled = 1';
      const params = [];
      if (single) {
        userFilter = 'WHERE u.user_id = ? COLLATE NOCASE';
        params.push(user_id.trim());
      }

      const users = q(`
        SELECT u.user_id, u.person_name,
               GROUP_CONCAT(r.role_name, '||') as role_names,
               GROUP_CONCAT(r.license_type, '||') as license_types,
               COUNT(ur.role_id) as role_count
        FROM users u
        LEFT JOIN user_roles ur ON ur.user_id = u.user_id
        LEFT JOIN roles r ON r.role_id = ur.role_id AND r.permission_type = 'Grant'
        ${userFilter}
        GROUP BY u.user_id
        ORDER BY u.user_id
        LIMIT ?
      `, [...params, limit]);

      if (single && !users.length) return notFoundResult('User', user_id);
      if (!users.length) return emptyResult('enabled users', {
        mode: single ? 'single' : 'all',
        user_count: 0,
        limit,
        truncated: false,
        tier_summary: [],
        users: [],
      });

      const userRows = users.map(u => {
        const types = (u.license_types || '').split('||').filter(Boolean);
        const names = (u.role_names || '').split('||').filter(Boolean);
        const tier = highestTier(types);
        // Driving role: the one at the highest tier cost
        let drivingRole = null;
        for (let i = 0; i < types.length; i++) {
          if (tierCost(types[i]) === tier.cost && tier.cost > 0) { drivingRole = names[i]; break; }
        }
        return {
          user_id: u.user_id,
          person_name: u.person_name ?? null,
          required_tier: tier.name,
          monthly_cost: tier.cost,
          driving_role: drivingRole,
          role_count: u.role_count || 0,
        };
      });

      // Tier summary
      const tierCounts = new Map();
      for (const u of userRows) {
        const t = u.required_tier || 'None';
        if (!tierCounts.has(t)) tierCounts.set(t, 0);
        tierCounts.set(t, tierCounts.get(t) + 1);
      }
      const tierSummary = [...tierCounts.entries()]
        .map(([tier, count]) => ({ tier, user_count: count, monthly_cost_per_user: tierCost(tier) }))
        .sort((a, b) => b.monthly_cost_per_user - a.monthly_cost_per_user);

      const typed = {
        mode: single ? 'single' : 'all',
        user_count: userRows.length,
        limit,
        truncated: userRows.length >= limit,
        tier_summary: tierSummary,
        users: userRows,
      };

      let out = '## Licence Assessment\n';
      out += `${typed.user_count} user(s) assessed\n\n`;
      out += '### Tier Summary\n';
      out += formatMarkdownTable(tierSummary, ['tier', 'user_count', 'monthly_cost_per_user']) + '\n\n';
      out += '### Per-User Breakdown\n';
      out += formatMarkdownTable(
        userRows.map(u => ({
          user_id: u.user_id,
          person_name: u.person_name ?? '',
          required_tier: u.required_tier ?? 'None',
          monthly_cost: u.monthly_cost.toFixed(2),
          driving_role: u.driving_role ?? '',
          role_count: u.role_count,
        })),
        ['user_id', 'person_name', 'required_tier', 'monthly_cost', 'driving_role', 'role_count'],
      );
      if (typed.truncated) out += truncationNote('user', limit);
      return structuredResult(typed, out, format);
    }
  );

  // ── 17. sec_what_if ───────────────────────────────────────────────────────

  server.registerTool(
    'sec_what_if',
    {
      annotations: READ_ONLY_DB_ANNOTATIONS,
      description: 'Simulate adding or removing roles from a user. Returns the projected licence tier change with monthly/annual cost delta.',
      inputSchema: {
        user_id: z.string().min(1).max(500).describe('User ID to simulate changes for'),
        add_roles: z.array(z.string().min(1).max(500)).optional().default([]).describe('Role names to add'),
        remove_roles: z.array(z.string().min(1).max(500)).optional().default([]).describe('Role names to remove'),
        format: formatTextParam,
      },
      outputSchema: secWhatIfOutput.shape,
    },
    async ({ user_id, add_roles: addRolesRaw, remove_roles: removeRolesRaw, format }) => {
      const addRoles = Array.isArray(addRolesRaw) ? addRolesRaw : [];
      const removeRoles = Array.isArray(removeRolesRaw) ? removeRolesRaw : [];

      const uid = user_id.trim();
      const user = q('SELECT user_id, person_name FROM users WHERE user_id = ? COLLATE NOCASE', [uid]);
      if (!user.length) return notFoundResult('User', uid);

      const warnings = [];

      // Resolve role names to IDs
      const allRolesDb = q('SELECT role_id, role_name, license_type, permission_type FROM roles');
      const roleByName = new Map(allRolesDb.map(r => [r.role_name.toLowerCase(), r]));
      const roleNameMap = new Map(allRolesDb.map(r => [r.role_id, r.role_name]));

      const addRoleIds = [];
      for (const rn of addRoles) {
        const r = roleByName.get(rn.toLowerCase());
        if (!r) { warnings.push(`Unknown role: ${rn}`); continue; }
        addRoleIds.push(r.role_id);
      }
      const removeRoleIds = new Set();
      for (const rn of removeRoles) {
        const r = roleByName.get(rn.toLowerCase());
        if (!r) { warnings.push(`Unknown role: ${rn}`); continue; }
        removeRoleIds.add(r.role_id);
      }

      // Current roles
      const currentRoleIds = q('SELECT role_id FROM user_roles WHERE user_id = ?', [user[0].user_id])
        .map(r => r.role_id);

      // Projected roles (set operation)
      const projectedRoleIds = [
        ...currentRoleIds.filter(rid => !removeRoleIds.has(rid)),
        ...addRoleIds.filter(rid => !currentRoleIds.includes(rid)),
      ];

      // Licence tier: current
      const currentTypes = currentRoleIds
        .map(rid => allRolesDb.find(r => r.role_id === rid))
        .filter(r => r && r.permission_type === 'Grant')
        .map(r => r.license_type);
      const currentTier = highestTier(currentTypes);

      // Licence tier: projected
      const projectedTypes = projectedRoleIds
        .map(rid => allRolesDb.find(r => r.role_id === rid))
        .filter(r => r && r.permission_type === 'Grant')
        .map(r => r.license_type);
      const projectedTier = highestTier(projectedTypes);

      const monthlyDelta = projectedTier.cost - currentTier.cost;
      const annualDelta = Math.round(monthlyDelta * 12 * 100) / 100;

      const currentRoleNames = currentRoleIds.map(rid => roleNameMap.get(rid) || rid);
      const projectedRoleNames = projectedRoleIds.map(rid => roleNameMap.get(rid) || rid);

      const typed = {
        user_id: user[0].user_id,
        person_name: user[0].person_name ?? null,
        add_roles: addRoles,
        remove_roles: removeRoles,
        current_tier: currentTier.name,
        current_monthly_cost: currentTier.cost,
        projected_tier: projectedTier.name,
        projected_monthly_cost: projectedTier.cost,
        monthly_delta: Math.round(monthlyDelta * 100) / 100,
        annual_delta: annualDelta,
        current_role_count: currentRoleIds.length,
        projected_role_count: projectedRoleIds.length,
        current_roles: currentRoleNames,
        projected_roles: projectedRoleNames,
        warnings,
      };

      let out = `## What-If: ${typed.user_id}\n`;
      out += `Adding: ${addRoles.length ? addRoles.join(', ') : '(none)'} • Removing: ${removeRoles.length ? removeRoles.join(', ') : '(none)'}\n\n`;

      out += '### Licence Impact\n';
      out += `| | Current | Projected |\n|---|---|---|\n`;
      out += `| Tier | ${typed.current_tier || 'None'} | ${typed.projected_tier || 'None'} |\n`;
      out += `| Monthly Cost | ${typed.current_monthly_cost.toFixed(2)} | ${typed.projected_monthly_cost.toFixed(2)} |\n`;
      out += `| Roles | ${typed.current_role_count} | ${typed.projected_role_count} |\n\n`;

      if (monthlyDelta !== 0) {
        const direction = monthlyDelta > 0 ? '📈 Cost increase' : '📉 Cost saving';
        out += `${direction}: **${Math.abs(typed.monthly_delta).toFixed(2)}/month** (${Math.abs(typed.annual_delta).toFixed(2)}/year)\n\n`;
      } else {
        out += 'No licence cost change.\n\n';
      }

      if (warnings.length) {
        out += '### Warnings\n' + warnings.map(w => `- ${w}`).join('\n') + '\n';
      }

      return structuredResult(typed, out, format);
    }
  );

  // ── 18. sec_object_access ─────────────────────────────────────────────────

  server.registerTool(
    'sec_object_access',
    {
      annotations: READ_ONLY_DB_ANNOTATIONS,
      description: 'Reverse permission chain: given an object name (menu item, form, table), find every privilege, duty, role and user whose access touches it — including Deny paths (⛔, which REMOVE access and override grants) and direct entity permissions. Surfaces all six access levels (Read/Create/Update/Delete/Correct/Invoke; Invoke governs action buttons). Use to answer "who can — or is blocked from — this object/button?".',
      inputSchema: {
        object_name: z.string().min(1).max(500).describe('Object name to trace (e.g., VendInvoiceJournal, CustTable)'),
        limit: z.number().int().min(1).max(500).optional().default(200).describe('Max access paths to return'),
        format: formatTextParam,
      },
      outputSchema: secObjectAccessOutput.shape,
    },
    async ({ object_name, limit: rawLimit, format }) => {
      const limit = Number.isInteger(rawLimit) && rawLimit > 0 ? rawLimit : 200;
      const objName = object_name.trim();

      // Step 1: find every path touching the object — Grant AND Deny, plus
      // direct privileges and direct (object-level) entity permissions. Deny
      // paths are NOT filtered out: a disabled button is often explained by a
      // Deny that removes access the grants would otherwise give.
      const like = `%${objName}%`;
      const rawPaths = q(`
        SELECT r.role_name, rd.permission_type as duty_perm, r.permission_type as role_perm,
               rd.duty_id, ep.privilege_name,
               ep.entry_point_name, ep.object_type,
               ep.grant_read, ep.grant_create, ep.grant_update, ep.grant_delete,
               ep.grant_correct, ep.grant_invoke
        FROM privilege_entry_points ep
        JOIN duty_privileges dp ON dp.privilege_name = ep.privilege_name COLLATE NOCASE
        JOIN role_duties rd ON rd.duty_id = dp.duty_id COLLATE NOCASE
        JOIN roles r ON r.role_id = rd.role_id
        WHERE (ep.object_name LIKE ? COLLATE NOCASE OR ep.entry_point_name LIKE ? COLLATE NOCASE)
        UNION ALL
        SELECT r.role_name, 'Grant' as duty_perm, r.permission_type as role_perm,
               '(direct)' as duty_id, rp.privilege_name,
               ep.entry_point_name, ep.object_type,
               ep.grant_read, ep.grant_create, ep.grant_update, ep.grant_delete,
               ep.grant_correct, ep.grant_invoke
        FROM privilege_entry_points ep
        JOIN role_direct_privileges rp ON rp.privilege_name = ep.privilege_name COLLATE NOCASE
        JOIN roles r ON r.role_id = rp.role_id
        WHERE (ep.object_name LIKE ? COLLATE NOCASE OR ep.entry_point_name LIKE ? COLLATE NOCASE)
        UNION ALL
        SELECT r.role_name, 'Grant' as duty_perm, r.permission_type as role_perm,
               '(direct entity)' as duty_id, '(direct entity)' as privilege_name,
               rdep.entity_name as entry_point_name, ${rdepObjectType} as object_type,
               rdep.grant_read, rdep.grant_create, rdep.grant_update, rdep.grant_delete,
               rdep.grant_correct, rdep.grant_invoke
        FROM role_direct_entity_permissions rdep
        JOIN roles r ON r.role_id = rdep.role_id
        WHERE rdep.entity_name LIKE ? COLLATE NOCASE
        ORDER BY role_name
        LIMIT ?
      `, [like, like, like, like, like, limit]);

      const hasDenyValue = (p) => /^deny$/i.test(String(p.grant_read ?? '')) ||
        /^deny$/i.test(String(p.grant_create ?? '')) || /^deny$/i.test(String(p.grant_update ?? '')) ||
        /^deny$/i.test(String(p.grant_delete ?? '')) || /^deny$/i.test(String(p.grant_correct ?? '')) ||
        /^deny$/i.test(String(p.grant_invoke ?? ''));
      const isDenied = (p) => p.duty_perm === 'Deny' || p.role_perm === 'Deny' || hasDenyValue(p);

      if (!rawPaths.length) return emptyResult(`access paths for "${objName}"`, {
        object_name: objName,
        limit,
        result_count: 0,
        truncated: false,
        user_count: 0,
        role_count: 0,
        grant_path_count: 0,
        deny_path_count: 0,
        paths: [],
        users: [],
      });
      const paths = rawPaths;

      // Step 2: find users who hold these roles
      const roleNames = [...new Set(paths.map(p => p.role_name))];
      const rolePh = roleNames.map(() => '?').join(',');
      const users = roleNames.length ? q(`
        SELECT DISTINCT u.user_id, u.person_name, r.role_name
        FROM user_roles ur
        JOIN users u ON u.user_id = ur.user_id AND u.enabled = 1
        JOIN roles r ON r.role_id = ur.role_id
        WHERE r.role_name IN (${rolePh}) COLLATE NOCASE
        ORDER BY u.user_id
        LIMIT ?
      `, [...roleNames, 500]) : [];

      const denyPathCount = paths.filter(isDenied).length;
      const typed = {
        object_name: objName,
        limit,
        result_count: paths.length,
        truncated: paths.length >= limit,
        user_count: new Set(users.map(u => u.user_id)).size,
        role_count: roleNames.length,
        grant_path_count: paths.length - denyPathCount,
        deny_path_count: denyPathCount,
        paths: paths.map(p => ({
          role_name: p.role_name,
          permission_type: p.duty_perm ?? null,
          duty_id: p.duty_id ?? null,
          privilege_name: p.privilege_name,
          entry_point_name: p.entry_point_name,
          object_type: p.object_type ?? null,
          grant_read: p.grant_read ?? null,
          grant_create: p.grant_create ?? null,
          grant_update: p.grant_update ?? null,
          grant_delete: p.grant_delete ?? null,
          grant_correct: p.grant_correct ?? null,
          grant_invoke: p.grant_invoke ?? null,
          denied: isDenied(p),
        })),
        users: users.map(u => ({
          user_id: u.user_id,
          person_name: u.person_name ?? null,
          role_name: u.role_name,
        })),
      };

      let out = `## Object Access: ${typed.object_name}\n`;
      out += `${typed.result_count} access path(s) • ${typed.role_count} role(s) • ${typed.user_count} user(s) • ` +
             `${typed.grant_path_count} grant / ${typed.deny_path_count} deny\n\n`;
      if (typed.deny_path_count > 0) {
        out += `_⛔ rows are Deny paths — they REMOVE the access on this object and override grants (Deny wins)._\n\n`;
      }
      out += `**Legend:** Y = allowed • ⛔ = denied • (empty) = no specification\n\n`;

      // On a Deny path, any specified operation becomes a removal (⛔);
      // on a Grant path, render the stored flag as Y / (empty).
      const cell = (p, v) => {
        if (v == null || v === '') return '';
        if (p.denied || /^deny$/i.test(String(v))) return '⛔';
        return formatCrudFlag(v);
      };
      out += '### Access Paths\n';
      out += formatMarkdownTable(
        typed.paths.map(p => ({
          role: (p.denied ? '⛔ ' : '') + p.role_name,
          duty: p.duty_id ?? '',
          privilege: p.privilege_name,
          entry_point: p.entry_point_name,
          type: p.object_type ?? '',
          R: cell(p, p.grant_read),
          C: cell(p, p.grant_create),
          U: cell(p, p.grant_update),
          D: cell(p, p.grant_delete),
          Co: cell(p, p.grant_correct),
          Inv: cell(p, p.grant_invoke),
        })),
        ['role', 'duty', 'privilege', 'entry_point', 'type', 'R', 'C', 'U', 'D', 'Co', 'Inv'],
      ) + '\n\n';

      if (users.length) {
        out += '### Users with Access\n';
        out += formatMarkdownTable(
          typed.users.map(u => ({
            user_id: u.user_id,
            person_name: u.person_name ?? '',
            role: u.role_name,
          })),
          ['user_id', 'person_name', 'role'],
        );
      }

      if (typed.truncated) out += truncationNote('user', limit);
      return structuredResult(typed, out, format);
    }
  );

}
