# D365 Segregation of Duties Analysis

Check for SoD violations across users based on defined conflict rules.

## Arguments
- $ARGUMENTS: User ID for single check, "all" for full scan, or category filter (e.g., "FDittgen", "all accounts_payable", "full SoD scan")

## Prerequisites

The SoD ruleset must be configured via `SOD_RULES_FILE` environment variable pointing to a JSON file. See `examples/sod-rules-sample.json` for the format.

## Workflow

### Step 1: Run SoD check

Parse $ARGUMENTS to determine mode:

**If user ID:**
- `sec_sod_check` with user_id

**If category specified:**
- `sec_sod_check` with category (e.g., "accounts_payable", "general_ledger")

**If "all" or full scan:**
- `sec_sod_check` without user_id (scans all enabled users)

### Step 2: Analyze violations

For each violation found:
- Identify the two conflicting duty groups and which roles grant them
- Assess whether the conflict is mitigated by:
  - Company restrictions (`sec_lookup_user` — are the roles scoped to different companies?)
  - Deny overrides (`sec_permission_trace` — does a Deny role suppress one side?)
  - Workflow approvals (domain knowledge — does the process have a manual approval step?)

### Step 3: Drill into high-risk users

For users with Critical violations:
- `sec_lookup_user` — full role profile
- `sec_effective_permissions` — what can they actually do?
- `sec_what_if` — simulate removing one of the conflicting roles

### Step 4: Present report

**SoD Analysis Report**

| Metric | Value |
|--------|-------|
| Users scanned | N |
| Users with violations | N |
| Total violations | N |
| Risk score | sum |

**Violations by Risk Level:**
- Critical: N
- High: N
- Medium: N

**Violations by Category:**
(grouped)

**Per-User Detail:**
For each user with violations:
- User ID, name
- Each violation: rule ID, conflicting duties, granting roles
- Mitigation status (company-restricted? Deny override? Workflow?)

**Remediation Recommendations:**
1. Which role to remove/split for each Critical violation
2. What-if simulation results showing the impact of each change
3. Priority order based on risk score

---

## Critical data quirks

### Deny roles do NOT suppress SoD violations

The SoD check operates on **Grant duties** only (P4-02 filter). A Deny role removes access at the entry-point level but does NOT remove the duty from the user's effective set. A user with both a Grant and Deny path to the same duty still triggers a SoD rule. This is intentional — the Deny may be removed later, re-exposing the conflict.

### Sub-role expansion is included

If a user is assigned a parent role that inherits a child role via `role_subroles`, the child role's duties are included in the SoD check. This catches indirect violations that wouldn't be visible from direct role assignments alone.
