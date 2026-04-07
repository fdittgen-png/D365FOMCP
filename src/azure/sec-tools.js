/**
 * D365FO Security Configuration – SQLite MCP Tools
 *
 * Registers all 15 security tools on an McpServer instance, querying
 * the normalized security database.
 *
 * Usage:
 *   import { registerSecTools } from './sec-tools.js';
 *   registerSecTools(server, db);
 */

import { query, formatMarkdownTable, textResult } from './shared.js';
import { z } from 'zod';

// ── Register all 15 Security tools ──────────────────────────────────────────

export function registerSecTools(server, db) {

  const q = (sql, params = []) => query(db, sql, params);

  // ── 1. sec_lookup_role ──────────────────────────────────────────────────

  server.tool(
    'sec_lookup_role',
    'Get complete security role details: description, license type, Grant/Deny, sub-roles, duties, and direct privileges.',
    { role_name: z.string().max(500).describe('Role name (case-insensitive)') },
    async ({ role_name }) => {
      const rn = role_name.trim();
      const role = q(`SELECT * FROM roles WHERE role_name = ? COLLATE NOCASE`, [rn]);

      if (!role.length) {
        const fuzzy = q(`SELECT role_name FROM roles WHERE role_name LIKE ? LIMIT 10`, [`%${rn}%`]);
        if (fuzzy.length) {
          return textResult(`Role "${rn}" not found. Did you mean:\n${fuzzy.map(r => `- ${r.role_name}`).join('\n')}`);
        }
        return textResult(`Role "${rn}" not found.`);
      }

      const r = role[0];
      let out = `# ${r.role_name}\n`;
      out += `| Property | Value |\n|---|---|\n`;
      out += `| Module | ${r.module_id || 'N/A'} |\n`;
      out += `| License Type | ${r.license_type || 'N/A'} |\n`;
      out += `| Permission | ${r.permission_type} |\n`;
      out += `| Source | ${r.source} |\n`;
      out += `| Description | ${r.description || 'N/A'} |\n\n`;

      // Sub-roles
      const subs = q(`SELECT r.role_name, rs.is_transitive
        FROM role_subroles rs JOIN roles r ON r.role_id = rs.child_role_id
        WHERE rs.parent_role_id = ? ORDER BY r.role_name`, [r.role_id]);
      if (subs.length) {
        out += `## Sub-Roles (${subs.length})\n`;
        out += formatMarkdownTable(subs, ['role_name', 'is_transitive']) + '\n\n';
      }

      // Duties
      const duties = q(`SELECT d.duty_id, d.duty_name, rd.permission_type
        FROM role_duties rd JOIN duties d ON d.duty_id = rd.duty_id
        WHERE rd.role_id = ? ORDER BY d.duty_id`, [r.role_id]);
      if (duties.length) {
        out += `## Duties (${duties.length})\n`;
        out += formatMarkdownTable(duties, ['duty_id', 'duty_name', 'permission_type']) + '\n\n';
      }

      // Direct privileges
      const dirPrivs = q(`SELECT privilege_name FROM role_direct_privileges
        WHERE role_id = ? ORDER BY privilege_name`, [r.role_id]);
      if (dirPrivs.length) {
        out += `## Direct Privileges (${dirPrivs.length})\n`;
        out += dirPrivs.map(p => `- ${p.privilege_name}`).join('\n') + '\n\n';
      }

      // Direct entity permissions
      const dirPerms = q(`SELECT entity_name, grant_read, grant_create, grant_update, grant_delete, grant_correct, grant_invoke FROM role_direct_entity_permissions
        WHERE role_id = ? ORDER BY entity_name`, [r.role_id]);
      if (dirPerms.length) {
        out += `## Direct Entity Permissions (${dirPerms.length})\n`;
        out += formatMarkdownTable(dirPerms,
          ['entity_name', 'grant_read', 'grant_create', 'grant_update', 'grant_delete', 'grant_correct', 'grant_invoke']) + '\n\n';
      }

      // Users with this role
      const userCount = q(`SELECT COUNT(*) as n FROM user_roles WHERE role_id = ?`, [r.role_id]);
      out += `## Assigned Users: ${userCount[0]?.n || 0}\n`;

      return textResult(out);
    }
  );

  // ── 2. sec_lookup_duty ──────────────────────────────────────────────────

  server.tool(
    'sec_lookup_duty',
    'Get duty details: parent roles, privileges granted, and entry points.',
    { duty_name: z.string().max(500).describe('Duty ID or name (case-insensitive)') },
    async ({ duty_name }) => {
      const dn = duty_name.trim();
      const duty = q(`SELECT * FROM duties WHERE duty_id = ? COLLATE NOCASE
        OR duty_name = ? COLLATE NOCASE`, [dn, dn]);

      if (!duty.length) {
        const fuzzy = q(`SELECT duty_id, duty_name FROM duties
          WHERE duty_id LIKE ? OR duty_name LIKE ? LIMIT 10`, [`%${dn}%`, `%${dn}%`]);
        if (fuzzy.length) {
          return textResult(`Duty "${dn}" not found. Did you mean:\n` +
            formatMarkdownTable(fuzzy, ['duty_id', 'duty_name']));
        }
        return textResult(`Duty "${dn}" not found.`);
      }

      const d = duty[0];
      let out = `# ${d.duty_id}\n`;
      if (d.duty_name) out += `**${d.duty_name}**\n`;
      if (d.module_id) out += `Module: ${d.module_id}\n`;
      if (d.description) out += `${d.description}\n`;
      out += '\n';

      // Parent roles
      const roles = q(`SELECT r.role_name, rd.permission_type
        FROM role_duties rd JOIN roles r ON r.role_id = rd.role_id
        WHERE rd.duty_id = ? ORDER BY r.role_name`, [d.duty_id]);
      if (roles.length) {
        out += `## Roles containing this duty (${roles.length})\n`;
        out += formatMarkdownTable(roles, ['role_name', 'permission_type']) + '\n\n';
      }

      // Privileges
      const privs = q(`SELECT dp.privilege_name, p.label
        FROM duty_privileges dp LEFT JOIN privileges p ON p.privilege_name = dp.privilege_name
        WHERE dp.duty_id = ? ORDER BY dp.privilege_name`, [d.duty_id]);
      if (privs.length) {
        out += `## Privileges (${privs.length})\n`;
        out += formatMarkdownTable(privs, ['privilege_name', 'label']) + '\n\n';
      }

      return textResult(out);
    }
  );

  // ── 3. sec_lookup_privilege ─────────────────────────────────────────────

  server.tool(
    'sec_lookup_privilege',
    'Get privilege details: entry points with CRUD grants, parent duties, and parent roles.',
    { privilege_name: z.string().max(500).describe('Privilege name (case-insensitive)') },
    async ({ privilege_name }) => {
      const pn = privilege_name.trim();
      const priv = q(`SELECT * FROM privileges WHERE privilege_name = ? COLLATE NOCASE`, [pn]);

      if (!priv.length) {
        const fuzzy = q(`SELECT privilege_name, label FROM privileges
          WHERE privilege_name LIKE ? LIMIT 10`, [`%${pn}%`]);
        if (fuzzy.length) {
          return textResult(`Privilege "${pn}" not found. Did you mean:\n` +
            formatMarkdownTable(fuzzy, ['privilege_name', 'label']));
        }
        return textResult(`Privilege "${pn}" not found.`);
      }

      const p = priv[0];
      let out = `# ${p.privilege_name}\n`;
      if (p.label) out += `**${p.label}**\n`;
      if (p.module_id) out += `Module: ${p.module_id}\n\n`;

      // Entry points
      const eps = q(`SELECT * FROM privilege_entry_points
        WHERE privilege_name = ? ORDER BY entry_point_name`, [p.privilege_name]);
      if (eps.length) {
        out += `## Entry Points (${eps.length})\n`;
        out += formatMarkdownTable(eps,
          ['entry_point_name', 'object_type', 'object_name',
           'grant_read', 'grant_create', 'grant_update', 'grant_delete', 'grant_invoke']) + '\n\n';
      }

      // Parent duties
      const duties = q(`SELECT dp.duty_id, d.duty_name
        FROM duty_privileges dp LEFT JOIN duties d ON d.duty_id = dp.duty_id
        WHERE dp.privilege_name = ? ORDER BY dp.duty_id`, [p.privilege_name]);
      if (duties.length) {
        out += `## Parent Duties (${duties.length})\n`;
        out += formatMarkdownTable(duties, ['duty_id', 'duty_name']) + '\n\n';
      }

      // Trace to roles
      const roles = q(`SELECT DISTINCT r.role_name, rd.permission_type
        FROM duty_privileges dp
        JOIN role_duties rd ON rd.duty_id = dp.duty_id
        JOIN roles r ON r.role_id = rd.role_id
        WHERE dp.privilege_name = ?
        ORDER BY r.role_name`, [p.privilege_name]);
      if (roles.length) {
        out += `## Roles granting this privilege (${roles.length})\n`;
        out += formatMarkdownTable(roles, ['role_name', 'permission_type']) + '\n\n';
      }

      return textResult(out);
    }
  );

  // ── 4. sec_lookup_user ──────────────────────────────────────────────────

  server.tool(
    'sec_lookup_user',
    'Get user profile: roles, company scoping, enabled status, and email.',
    { user_id: z.string().max(500).describe('User ID (case-insensitive)') },
    async ({ user_id }) => {
      const uid = user_id.trim();
      const user = q(`SELECT * FROM users WHERE user_id = ? COLLATE NOCASE`, [uid]);

      if (!user.length) {
        // Try partial match on user_id, person_name, or email
        const fuzzy = q(`SELECT user_id, person_name, email FROM users
          WHERE user_id LIKE ? OR person_name LIKE ? OR email LIKE ? LIMIT 10`,
          [`%${uid}%`, `%${uid}%`, `%${uid}%`]);
        if (fuzzy.length) {
          return textResult(`User "${uid}" not found. Did you mean:\n` +
            formatMarkdownTable(fuzzy, ['user_id', 'person_name', 'email']));
        }
        return textResult(`User "${uid}" not found.`);
      }

      const u = user[0];
      let out = `# ${u.user_id}\n`;
      out += `| Property | Value |\n|---|---|\n`;
      out += `| Name | ${u.person_name || 'N/A'} |\n`;
      out += `| Email | ${u.email || 'N/A'} |\n`;
      out += `| Enabled | ${u.enabled ? 'Yes' : 'No'} |\n`;
      out += `| Default Company | ${u.default_company || 'N/A'} |\n\n`;

      // Roles
      const roles = q(`SELECT r.role_name, r.permission_type, r.license_type
        FROM user_roles ur JOIN roles r ON r.role_id = ur.role_id
        WHERE ur.user_id = ? ORDER BY r.role_name`, [u.user_id]);
      if (roles.length) {
        out += `## Roles (${roles.length})\n`;
        out += formatMarkdownTable(roles, ['role_name', 'permission_type', 'license_type']) + '\n\n';
      }

      // Company-scoped restrictions
      const companies = q(`SELECT urc.role_id, r.role_name, urc.company_id
        FROM user_role_companies urc
        JOIN roles r ON r.role_id = urc.role_id
        WHERE urc.user_id = ?
        ORDER BY r.role_name, urc.company_id`, [u.user_id]);
      if (companies.length) {
        out += `## Company-Scoped Roles (${companies.length})\n`;
        out += formatMarkdownTable(companies, ['role_name', 'company_id']) + '\n\n';
      }

      return textResult(out);
    }
  );

  // ── 5. sec_role_hierarchy ───────────────────────────────────────────────

  server.tool(
    'sec_role_hierarchy',
    'Show the sub-role hierarchy for a role (children that inherit from it, or parents it inherits from).',
    {
      role_name: z.string().max(500).describe('Role name'),
      direction: z.enum(['children', 'parents']).default('children').describe('Traverse direction'),
    },
    async ({ role_name, direction }) => {
      const role = q(`SELECT role_id, role_name FROM roles WHERE role_name = ? COLLATE NOCASE`, [role_name.trim()]);
      if (!role.length) return textResult(`Role "${role_name}" not found.`);
      const r = role[0];

      let rows;
      if (direction === 'children') {
        rows = q(`SELECT child.role_name, rs.is_transitive
          FROM role_subroles rs JOIN roles child ON child.role_id = rs.child_role_id
          WHERE rs.parent_role_id = ? ORDER BY child.role_name`, [r.role_id]);
      } else {
        rows = q(`SELECT parent.role_name, rs.is_transitive
          FROM role_subroles rs JOIN roles parent ON parent.role_id = rs.parent_role_id
          WHERE rs.child_role_id = ? ORDER BY parent.role_name`, [r.role_id]);
      }

      if (!rows.length) return textResult(`No ${direction} found for role "${r.role_name}".`);

      let out = `# ${r.role_name} — ${direction}\n`;
      out += formatMarkdownTable(rows, ['role_name', 'is_transitive']);
      return textResult(out);
    }
  );

  // ── 6. sec_find_users_by_role ───────────────────────────────────────────

  server.tool(
    'sec_find_users_by_role',
    'Find all users assigned to a role, optionally filtered to a specific company.',
    {
      role_name: z.string().max(500).describe('Role name'),
      company_id: z.string().max(500).optional().describe('Filter to users scoped to this company'),
      limit: z.number().optional().default(100).describe('Max results'),
    },
    async ({ role_name, company_id, limit: rawLimit }) => {
      const limit = rawLimit || 100;
      const role = q(`SELECT role_id, role_name FROM roles WHERE role_name = ? COLLATE NOCASE`, [role_name.trim()]);
      if (!role.length) return textResult(`Role "${role_name}" not found.`);
      const r = role[0];

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
      if (!rows.length) return textResult(`No users found with role "${r.role_name}"` +
        (company_id ? ` in company ${company_id}` : '') + '.');

      let out = `# Users with role: ${r.role_name}`;
      if (company_id) out += ` (company: ${company_id})`;
      out += `\n${rows.length} user(s)\n\n`;
      out += formatMarkdownTable(rows);
      if (rows.length >= limit) out += `\n\n> ⚠️ Showing first ${limit} results. There may be more — increase limit or refine your query.`;
      return textResult(out);
    }
  );

  // ── 7. sec_find_roles_by_duty ───────────────────────────────────────────

  server.tool(
    'sec_find_roles_by_duty',
    'Find all roles that contain a specific duty.',
    { duty_name: z.string().max(500).describe('Duty ID or name') },
    async ({ duty_name }) => {
      const dn = duty_name.trim();
      const duty = q(`SELECT duty_id FROM duties
        WHERE duty_id = ? COLLATE NOCASE OR duty_name = ? COLLATE NOCASE`, [dn, dn]);
      if (!duty.length) return textResult(`Duty "${dn}" not found.`);

      const rows = q(`SELECT r.role_name, r.permission_type, r.license_type, rd.permission_type as duty_permission
        FROM role_duties rd JOIN roles r ON r.role_id = rd.role_id
        WHERE rd.duty_id = ? ORDER BY r.role_name`, [duty[0].duty_id]);

      if (!rows.length) return textResult(`No roles contain duty "${dn}".`);

      let out = `# Roles containing duty: ${duty[0].duty_id}\n${rows.length} role(s)\n\n`;
      out += formatMarkdownTable(rows, ['role_name', 'permission_type', 'license_type', 'duty_permission']);
      return textResult(out);
    }
  );

  // ── 8. sec_find_roles_by_privilege ──────────────────────────────────────

  server.tool(
    'sec_find_roles_by_privilege',
    'Find all roles that grant a privilege (via the duty chain or directly).',
    { privilege_name: z.string().max(500).describe('Privilege name') },
    async ({ privilege_name }) => {
      const pn = privilege_name.trim();

      // Via duty chain
      const viaChain = q(`SELECT DISTINCT r.role_name, rd.permission_type, d.duty_id
        FROM duty_privileges dp
        JOIN role_duties rd ON rd.duty_id = dp.duty_id
        JOIN roles r ON r.role_id = rd.role_id
        JOIN duties d ON d.duty_id = dp.duty_id
        WHERE dp.privilege_name = ? COLLATE NOCASE
        ORDER BY r.role_name`, [pn]);

      // Direct assignments
      const direct = q(`SELECT r.role_name, 'Direct' as via
        FROM role_direct_privileges rdp JOIN roles r ON r.role_id = rdp.role_id
        WHERE rdp.privilege_name = ? COLLATE NOCASE
        ORDER BY r.role_name`, [pn]);

      if (!viaChain.length && !direct.length) {
        return textResult(`No roles grant privilege "${pn}".`);
      }

      let out = `# Roles granting privilege: ${pn}\n\n`;

      if (viaChain.length) {
        out += `## Via Duty Chain (${viaChain.length})\n`;
        out += formatMarkdownTable(viaChain, ['role_name', 'permission_type', 'duty_id']) + '\n\n';
      }

      if (direct.length) {
        out += `## Direct Assignment (${direct.length})\n`;
        out += formatMarkdownTable(direct, ['role_name', 'via']) + '\n\n';
      }

      return textResult(out);
    }
  );

  // ── 9. sec_company_users ────────────────────────────────────────────────

  server.tool(
    'sec_company_users',
    'List all users and their roles for a specific company (legal entity).',
    {
      company_id: z.string().max(500).describe('Company / legal entity ID (e.g., LADE, TAB)'),
      limit: z.number().optional().default(200).describe('Max results'),
    },
    async ({ company_id, limit: rawLimit }) => {
      const limit = rawLimit || 200;
      const cid = company_id.trim().toUpperCase();

      const rows = q(`SELECT u.user_id, u.person_name, u.email, r.role_name, r.permission_type
        FROM user_role_companies urc
        JOIN users u ON u.user_id = urc.user_id
        JOIN roles r ON r.role_id = urc.role_id
        WHERE urc.company_id = ?
        ORDER BY u.user_id, r.role_name
        LIMIT ?`, [cid, limit]);

      if (!rows.length) return textResult(`No users found for company "${cid}".`);

      let out = `# Company: ${cid}\n${rows.length} user-role assignment(s)\n\n`;
      out += formatMarkdownTable(rows, ['user_id', 'person_name', 'role_name', 'permission_type']);
      if (rows.length >= limit) out += `\n\n> ⚠️ Showing first ${limit} results. There may be more — increase limit or refine your query.`;
      return textResult(out);
    }
  );

  // ── 10. sec_permission_trace ────────────────────────────────────────────

  server.tool(
    'sec_permission_trace',
    'Trace the full permission chain for a role: role -> duties -> privileges -> entry points with CRUD. Optionally filter to a specific target object.',
    {
      role_name: z.string().max(500).describe('Role name'),
      object_name: z.string().max(500).optional().describe('Filter to entry points targeting this object'),
      limit: z.number().optional().default(500).describe('Max results'),
    },
    async ({ role_name, object_name, limit: rawLimit }) => {
      const limit = rawLimit || 500;
      const role = q(`SELECT role_id, role_name FROM roles WHERE role_name = ? COLLATE NOCASE`, [role_name.trim()]);
      if (!role.length) return textResult(`Role "${role_name}" not found.`);

      const params = [role[0].role_id];
      let objectFilter = '';
      if (object_name) {
        objectFilter = ' AND ep.object_name LIKE ?';
        params.push(`%${object_name.trim()}%`);
      }
      params.push(limit);

      const trace = q(`
        WITH RECURSIVE role_tree AS (
          SELECT role_id FROM roles WHERE role_id = ?
          UNION ALL
          SELECT rs.child_role_id FROM role_subroles rs JOIN role_tree rt ON rs.parent_role_id = rt.role_id
        )
        SELECT rd.permission_type, d.duty_id,
               dp.privilege_name,
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
               rp.privilege_name,
               ep.object_type, ep.object_name,
               ep.grant_read, ep.grant_create, ep.grant_update,
               ep.grant_delete, ep.grant_correct, ep.grant_invoke
        FROM role_tree rtree
        JOIN role_direct_privileges rp ON rp.role_id = rtree.role_id
        JOIN privilege_entry_points ep ON ep.privilege_name = rp.privilege_name
        WHERE 1=1 ${objectFilter}
        ORDER BY duty_id, privilege_name, object_name
        LIMIT ?
      `, params);

      if (!trace.length) {
        return textResult(`No permission chain found for "${role[0].role_name}"` +
          (object_name ? ` targeting "${object_name}"` : '') + '.');
      }

      let out = `# Permission Trace: ${role[0].role_name}\n`;
      out += `${trace.length} entry point(s)` + (object_name ? ` matching "${object_name}"` : '') + '\n\n';
      out += formatMarkdownTable(trace, [
        'duty_id', 'privilege_name', 'object_type', 'object_name',
        'grant_read', 'grant_create', 'grant_update', 'grant_delete',
      ]);
      if (trace.length >= limit) out += `\n\n> ⚠️ Showing first ${limit} results. There may be more — increase limit or refine your query.`;
      return textResult(out);
    }
  );

  // ── 11. sec_compare_roles ───────────────────────────────────────────────

  server.tool(
    'sec_compare_roles',
    'Compare two roles side by side: shared vs unique duties and privileges.',
    {
      role1: z.string().max(500).describe('First role name'),
      role2: z.string().max(500).describe('Second role name'),
    },
    async ({ role1, role2 }) => {
      const r1 = q(`SELECT role_id, role_name FROM roles WHERE role_name = ? COLLATE NOCASE`, [role1.trim()]);
      const r2 = q(`SELECT role_id, role_name FROM roles WHERE role_name = ? COLLATE NOCASE`, [role2.trim()]);
      if (!r1.length) return textResult(`Role "${role1}" not found.`);
      if (!r2.length) return textResult(`Role "${role2}" not found.`);

      const duties1 = new Set(q(`SELECT duty_id FROM role_duties WHERE role_id = ?`, [r1[0].role_id]).map(r => r.duty_id));
      const duties2 = new Set(q(`SELECT duty_id FROM role_duties WHERE role_id = ?`, [r2[0].role_id]).map(r => r.duty_id));

      const shared = [...duties1].filter(d => duties2.has(d));
      const only1 = [...duties1].filter(d => !duties2.has(d));
      const only2 = [...duties2].filter(d => !duties1.has(d));

      let out = `# Role Comparison\n`;
      out += `| | ${r1[0].role_name} | ${r2[0].role_name} |\n|---|---|---|\n`;
      out += `| Total Duties | ${duties1.size} | ${duties2.size} |\n`;
      out += `| Shared | ${shared.length} | ${shared.length} |\n`;
      out += `| Unique | ${only1.length} | ${only2.length} |\n\n`;

      if (shared.length > 0 && shared.length <= 50) {
        out += `## Shared Duties (${shared.length})\n`;
        out += shared.map(d => `- ${d}`).join('\n') + '\n\n';
      }
      if (only1.length > 0 && only1.length <= 50) {
        out += `## Only in ${r1[0].role_name} (${only1.length})\n`;
        out += only1.map(d => `- ${d}`).join('\n') + '\n\n';
      }
      if (only2.length > 0 && only2.length <= 50) {
        out += `## Only in ${r2[0].role_name} (${only2.length})\n`;
        out += only2.map(d => `- ${d}`).join('\n') + '\n\n';
      }

      // Direct privilege comparison
      const privs1 = new Set(q(`SELECT privilege_name FROM role_direct_privileges WHERE role_id = ?`, [r1[0].role_id]).map(r => r.privilege_name));
      const privs2 = new Set(q(`SELECT privilege_name FROM role_direct_privileges WHERE role_id = ?`, [r2[0].role_id]).map(r => r.privilege_name));

      if (privs1.size > 0 || privs2.size > 0) {
        const sharedPrivs = [...privs1].filter(p => privs2.has(p));
        const onlyPrivs1 = [...privs1].filter(p => !privs2.has(p));
        const onlyPrivs2 = [...privs2].filter(p => !privs1.has(p));

        out += `## Direct Privileges\n`;
        out += `| | ${r1[0].role_name} | ${r2[0].role_name} |\n|---|---|---|\n`;
        out += `| Total | ${privs1.size} | ${privs2.size} |\n`;
        out += `| Shared | ${sharedPrivs.length} | ${sharedPrivs.length} |\n`;
        out += `| Unique | ${onlyPrivs1.length} | ${onlyPrivs2.length} |\n\n`;

        if (sharedPrivs.length > 0 && sharedPrivs.length <= 50) {
          out += `### Shared Direct Privileges (${sharedPrivs.length})\n`;
          out += sharedPrivs.map(p => `- ${p}`).join('\n') + '\n\n';
        }
        if (onlyPrivs1.length > 0 && onlyPrivs1.length <= 50) {
          out += `### Only in ${r1[0].role_name} (${onlyPrivs1.length})\n`;
          out += onlyPrivs1.map(p => `- ${p}`).join('\n') + '\n\n';
        }
        if (onlyPrivs2.length > 0 && onlyPrivs2.length <= 50) {
          out += `### Only in ${r2[0].role_name} (${onlyPrivs2.length})\n`;
          out += onlyPrivs2.map(p => `- ${p}`).join('\n') + '\n\n';
        }
      }

      return textResult(out);
    }
  );

  // ── 12. sec_effective_permissions ───────────────────────────────────────

  server.tool(
    'sec_effective_permissions',
    'Compute flattened effective permissions for a user or role: all entry points with CRUD grants, resolving sub-roles. Optionally filter by object name or company.',
    {
      user_id: z.string().max(500).optional().describe('User ID (provide this OR role_name)'),
      role_name: z.string().max(500).optional().describe('Role name (provide this OR user_id)'),
      object_name: z.string().max(500).optional().describe('Filter to entry points for this object'),
      limit: z.number().optional().default(200).describe('Max results'),
    },
    async ({ user_id, role_name, object_name, limit: rawLimit }) => {
      const limit = rawLimit || 200;
      // Resolve role IDs
      let roleIds = [];
      let heading = '';

      if (user_id) {
        const uid = user_id.trim();
        const user = q(`SELECT user_id, person_name FROM users WHERE user_id = ? COLLATE NOCASE`, [uid]);
        if (!user.length) return textResult(`User "${uid}" not found.`);
        heading = `User: ${user[0].user_id} (${user[0].person_name || 'N/A'})`;

        roleIds = q(`SELECT role_id FROM user_roles WHERE user_id = ?`, [user[0].user_id])
          .map(r => r.role_id);
      } else if (role_name) {
        const rn = role_name.trim();
        const role = q(`SELECT role_id, role_name FROM roles WHERE role_name = ? COLLATE NOCASE`, [rn]);
        if (!role.length) return textResult(`Role "${rn}" not found.`);
        heading = `Role: ${role[0].role_name}`;
        roleIds = [role[0].role_id];
      } else {
        return textResult('Provide either user_id or role_name.');
      }

      if (!roleIds.length) return textResult('No roles found.');

      // Expand sub-roles recursively using CTE
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

      const allPlaceholders = [...allRoleIds].map(() => '?').join(',');
      const params = [...allRoleIds];

      let objectFilter = '';
      if (object_name) {
        objectFilter = ' AND ep.object_name LIKE ?';
        params.push(`%${object_name.trim()}%`);
      }
      params.push(limit);

      const perms = q(`
        SELECT DISTINCT ep.object_name, ep.object_type,
               ep.grant_read, ep.grant_create, ep.grant_update,
               ep.grant_delete, ep.grant_correct, ep.grant_invoke,
               rd.permission_type as duty_perm
        FROM role_duties rd
        JOIN duty_privileges dp ON dp.duty_id = rd.duty_id
        JOIN privilege_entry_points ep ON ep.privilege_name = dp.privilege_name
        WHERE rd.role_id IN (${allPlaceholders}) ${objectFilter}
        UNION ALL
        SELECT DISTINCT ep.object_name, ep.object_type,
               ep.grant_read, ep.grant_create, ep.grant_update,
               ep.grant_delete, ep.grant_correct, ep.grant_invoke,
               'Grant' as duty_perm
        FROM role_direct_privileges rp
        JOIN privilege_entry_points ep ON ep.privilege_name = rp.privilege_name
        WHERE rp.role_id IN (${allPlaceholders}) ${objectFilter}
        ORDER BY object_name
        LIMIT ?
      `, [...params, ...allRoleIds, ...(object_name ? [`%${object_name.trim()}%`] : [])]);

      if (!perms.length) {
        return textResult(`No effective permissions found for ${heading}` +
          (object_name ? ` on "${object_name}"` : '') + '.');
      }

      let out = `# Effective Permissions\n${heading}\n`;
      out += `${perms.length} entry point(s)` + (object_name ? ` matching "${object_name}"` : '') + '\n\n';
      out += formatMarkdownTable(perms, [
        'object_name', 'object_type', 'grant_read', 'grant_create',
        'grant_update', 'grant_delete', 'duty_perm',
      ]);
      if (perms.length >= limit) out += `\n\n> ⚠️ Showing first ${limit} results. There may be more — increase limit or refine your query.`;
      return textResult(out);
    }
  );

  // ── 13. sec_search ──────────────────────────────────────────────────────

  server.tool(
    'sec_search',
    'Full-text search across roles, duties, privileges, and users.',
    {
      query: z.string().max(500).describe('Search keywords'),
      object_type: z.enum(['role', 'duty', 'privilege', 'user']).optional().describe('Filter: role, duty, privilege, user'),
      limit: z.number().optional().default(20).describe('Max results'),
    },
    async ({ query: searchQuery, object_type, limit: rawLimit }) => {
      const limit = rawLimit || 20;
      const terms = searchQuery.trim().split(/\s+/).filter(Boolean);
      if (!terms.length) return textResult('Empty search query.');

      const likeParts = terms.map(() => '(object_name LIKE ? OR content LIKE ?)');
      const likeParams = terms.flatMap(t => [`%${t}%`, `%${t}%`]);

      let sql = `SELECT object_type, object_name, module_id, content
        FROM sec_search WHERE ${likeParts.join(' AND ')}`;
      if (object_type) {
        sql += ' AND object_type = ?';
        likeParams.push(object_type);
      }
      sql += ' LIMIT ?';
      likeParams.push(limit);

      const results = q(sql, likeParams);
      if (!results.length) return textResult(`No results for "${searchQuery}".`);

      const rows = results.map(r => ({
        ...r,
        match_context: r.content ? r.content.substring(0, 120) + (r.content.length > 120 ? '...' : '') : ''
      }));

      let out = formatMarkdownTable(rows, ['object_type', 'object_name', 'module_id', 'match_context']);
      if (results.length >= limit) out += `\n\n> ⚠️ Showing first ${limit} results. There may be more — increase limit or refine your query.`;
      return textResult(out);
    }
  );

  // ── 14. sec_stats ───────────────────────────────────────────────────────

  server.tool(
    'sec_stats',
    'Get summary statistics for the security database: role counts, user counts, company count, etc.',
    {},
    async () => {
      const meta = q('SELECT key, value FROM sec_metadata ORDER BY key');

      const grantRoles = q(`SELECT COUNT(*) as n FROM roles WHERE permission_type = 'Grant'`)[0]?.n || 0;
      const denyRoles = q(`SELECT COUNT(*) as n FROM roles WHERE permission_type = 'Deny'`)[0]?.n || 0;
      const totalDuties = q(`SELECT COUNT(*) as n FROM duties`)[0]?.n || 0;
      const totalPrivileges = q(`SELECT COUNT(*) as n FROM privileges`)[0]?.n || 0;
      const totalEntryPoints = q(`SELECT COUNT(*) as n FROM privilege_entry_points`)[0]?.n || 0;
      const enabledUsers = q(`SELECT COUNT(*) as n FROM users WHERE enabled = 1`)[0]?.n || 0;
      const disabledUsers = q(`SELECT COUNT(*) as n FROM users WHERE enabled = 0`)[0]?.n || 0;
      const userRoleAssignments = q(`SELECT COUNT(*) as n FROM user_roles`)[0]?.n || 0;
      const companies = q(`SELECT COUNT(DISTINCT company_id) as n FROM user_role_companies`)[0]?.n || 0;

      let out = '# Security Database Statistics\n\n';
      out += '## Build Info\n';
      out += formatMarkdownTable(meta, ['key', 'value']) + '\n\n';

      out += '## Breakdown\n';
      out += `| Metric | Value |\n|---|---|\n`;
      out += `| Grant Roles | ${grantRoles} |\n`;
      out += `| Deny Roles | ${denyRoles} |\n`;
      out += `| Total Duties | ${totalDuties} |\n`;
      out += `| Total Privileges | ${totalPrivileges} |\n`;
      out += `| Total Entry Points | ${totalEntryPoints} |\n`;
      out += `| Enabled Users | ${enabledUsers} |\n`;
      out += `| Disabled Users | ${disabledUsers} |\n`;
      out += `| User-Role Assignments | ${userRoleAssignments} |\n`;
      out += `| Companies | ${companies} |\n`;

      return textResult(out);
    }
  );

  // ── 15. sec_raw_sql ─────────────────────────────────────────────────────

  server.tool(
    'sec_raw_sql',
    'Execute a raw SQL query against the security database. READ-ONLY, 500-row limit. Schema: roles(role_id, role_name, label, description, module_id, license_type, permission_type, source), duties(duty_id, duty_name, module_id, description), privileges(privilege_name, module_id, label), role_duties(role_id, duty_id, permission_type), role_direct_privileges(role_id, privilege_name), duty_privileges(duty_id, privilege_name), privilege_entry_points(privilege_name, entry_point_name, object_type, object_name, grant_read, grant_create, grant_update, grant_delete, grant_correct, grant_invoke), users(user_id, person_name, email, enabled, default_company), user_roles(user_id, role_id), user_role_companies(user_id, role_id, company_id), role_subroles(parent_role_id, child_role_id, is_transitive), role_direct_entity_permissions(role_id, entity_name, grant_read, grant_create, grant_update, grant_delete, grant_correct, grant_invoke)',
    { sql: z.string().max(50000).describe('SQL SELECT query') },
    async ({ sql: rawSql }) => {
      const trimmed = rawSql.trim().replace(/;+$/, '');
      if (!/^\s*(SELECT|WITH|PRAGMA)\b/i.test(trimmed)) {
        return textResult('ERROR: Only SELECT/WITH/PRAGMA queries are allowed.');
      }

      // Reject dangerous keywords
      const forbidden = ['INSERT', 'UPDATE', 'DELETE', 'DROP', 'ALTER', 'CREATE', 'TRUNCATE', 'ATTACH', 'DETACH'];
      for (const kw of forbidden) {
        const regex = new RegExp(`\\b${kw}\\b`, 'i');
        if (regex.test(trimmed)) {
          return textResult(`ERROR: Keyword "${kw}" is not allowed in read-only queries.`);
        }
      }

      let limited = trimmed;
      if (!/\bLIMIT\b/i.test(limited)) {
        limited += ' LIMIT 500';
      }

      try {
        const rows = q(limited);
        if (!rows.length) return textResult('No results found.');
        let out = formatMarkdownTable(rows);
        if (rows.length >= 500) out += `\n\n> ⚠️ Showing first 500 results. There may be more — add a LIMIT clause or refine your query.`;
        return textResult(out);
      } catch (err) {
        return textResult(`SQL Error: ${err.message}`);
      }
    }
  );

}
