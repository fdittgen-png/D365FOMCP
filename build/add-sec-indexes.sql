-- Performance indexes for the security database
-- Safe to re-run (uses IF NOT EXISTS)

PRAGMA journal_mode = DELETE;
PRAGMA synchronous = NORMAL;

-- Show current state
SELECT 'BEFORE: rows in duty_privileges' as label, COUNT(*) as n FROM duty_privileges;
SELECT 'BEFORE: existing indexes' as label, COUNT(*) as n FROM sqlite_master WHERE type='index' AND name NOT LIKE 'sqlite_%';

-- ── NOCASE indexes for case-insensitive lookups ──────────────────────────────
CREATE INDEX IF NOT EXISTS idx_roles_name_nocase    ON roles(role_name COLLATE NOCASE);
CREATE INDEX IF NOT EXISTS idx_duties_id_nocase     ON duties(duty_id COLLATE NOCASE);
CREATE INDEX IF NOT EXISTS idx_duties_name_nocase   ON duties(duty_name COLLATE NOCASE);
CREATE INDEX IF NOT EXISTS idx_privs_name_nocase    ON privileges(privilege_name COLLATE NOCASE);
CREATE INDEX IF NOT EXISTS idx_users_id_nocase      ON users(user_id COLLATE NOCASE);
CREATE INDEX IF NOT EXISTS idx_users_email_nocase   ON users(email COLLATE NOCASE);
CREATE INDEX IF NOT EXISTS idx_users_person_nocase  ON users(person_name COLLATE NOCASE);

-- ── Covering composite for the 34M-row duty_privileges joins (BIGGEST WIN) ──
CREATE INDEX IF NOT EXISTS idx_dp_priv_duty         ON duty_privileges(privilege_name, duty_id);

-- ── Reverse lookups ──────────────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_rdp_priv             ON role_direct_privileges(privilege_name);
CREATE INDEX IF NOT EXISTS idx_rdep_role            ON role_direct_entity_permissions(role_id);
CREATE INDEX IF NOT EXISTS idx_urc_role_id          ON user_role_companies(role_id);
CREATE INDEX IF NOT EXISTS idx_subroles_parent      ON role_subroles(parent_role_id);

-- ── Case-insensitive entry-point lookups ─────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_ep_object_nocase     ON privilege_entry_points(object_name COLLATE NOCASE);

-- ── Search content for sec_search LIKE queries ───────────────────────────────
CREATE INDEX IF NOT EXISTS idx_sec_search_content_nocase ON sec_search(content COLLATE NOCASE);

-- Refresh planner stats
ANALYZE;

-- Show final state
SELECT 'AFTER: total indexes' as label, COUNT(*) as n FROM sqlite_master WHERE type='index' AND name NOT LIKE 'sqlite_%';
SELECT name, tbl_name FROM sqlite_master WHERE type='index' AND name NOT LIKE 'sqlite_%' ORDER BY tbl_name, name;
