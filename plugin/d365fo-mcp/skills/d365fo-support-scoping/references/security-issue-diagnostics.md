# Part 6: Security Issue Diagnostics

_Reference for the `d365fo-support-scoping` skill. Read on demand._


### Access Denied / Permission Issues

**Workflow (3 parallel calls):**
```
PARALLEL:
  sec_lookup_user(userId)                                    -- Assigned roles
  sec_effective_permissions(user_id: userId, object_name: X) -- Can they access X?
  sec_permission_trace(role_name: expectedRole, object_name: X) -- What role IS needed?
```

**Then determine:**
- Missing role → assign it
- Wrong company scope → check `user_role_companies`
- Role missing duty/privilege → role customization needed

### SoD (Segregation of Duties) Analysis

**Quick SoD check:**
```
1. sec_lookup_user(userId) → get all roles
2. sec_compare_roles(role1, role2) → find shared duties
3. Check if shared duties violate SoD rules (AP + AR, Create + Approve)
```

**Users with global roles — no company restriction (raw SQL):**
```sql
SELECT u.user_id, u.person_name, r.role_name, r.license_type
FROM users u
JOIN user_roles ur ON u.user_id = ur.user_id
JOIN roles r ON ur.role_id = r.role_id
WHERE u.enabled = 1
  AND NOT EXISTS (
    SELECT 1 FROM user_role_companies urc
    WHERE urc.user_id = u.user_id AND urc.role_id = ur.role_id
  )
ORDER BY u.user_id
```

**Roles that can both Create and Delete same object (raw SQL):**
```sql
SELECT DISTINCT r.role_name, ep.object_name, ep.object_type
FROM roles r
JOIN role_duties rd ON r.role_id = rd.role_id
JOIN duty_privileges dp ON rd.duty_id = dp.duty_id
JOIN privilege_entry_points ep ON dp.privilege_name = ep.privilege_name
WHERE ep.grant_create IS NOT NULL AND ep.grant_delete IS NOT NULL
  AND r.permission_type = 'Grant'
ORDER BY r.role_name, ep.object_name
```

**Cross-company access audit (raw SQL):**
```sql
SELECT u.user_id, u.person_name,
       COUNT(DISTINCT urc.company_id) as company_count,
       GROUP_CONCAT(DISTINCT urc.company_id) as companies
FROM users u
JOIN user_role_companies urc ON u.user_id = urc.user_id
WHERE u.enabled = 1
GROUP BY u.user_id
HAVING COUNT(DISTINCT urc.company_id) > 3
ORDER BY company_count DESC
```

### When to Use sec_raw_sql vs Specific Tools

| Need | sec_raw_sql | Specific Tool |
|------|-------------|---------------|
| Single user lookup | — | `sec_lookup_user` |
| Single role trace | — | `sec_permission_trace` |
| Cross-company anomaly | Yes | — |
| Grant + Deny role conflicts | Yes | — |
| Object-level access aggregation | Yes | — |
| Disabled users with active roles | Yes | — |
| Batch SoD rule checking | Yes | — |

