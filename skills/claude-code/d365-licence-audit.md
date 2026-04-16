# D365 Licence Audit

Assess D365 licence tier requirements for users based on their security role assignments.

## Arguments
- $ARGUMENTS: User ID for single-user audit, or "all" / empty for full audit (e.g., "FDittgen", "all users", "top over-licensed")

## Workflow

### Step 1: Assess licence tiers

**If single user** (user ID provided):
- `sec_licence_assessment` with user_id

**If all users** (no user ID or "all"):
- `sec_licence_assessment` without user_id (returns all enabled users)

### Step 2: Identify cost optimization opportunities

From the tier summary, look for:
- Users with **Enterprise/Finance/SCM** tiers (135+ GBP/month) — are they justified?
- Users with only a few low-privilege roles assigned to an expensive tier — the driving role may be removable
- Disabled users still counted (they should not be, but verify)

### Step 3: Cross-reference with role assignments

For the top 5 most expensive users:
- `sec_lookup_user` — what roles do they actually have?
- Are any roles over-provisioned (SysAdmin assigned broadly)?
- Could any roles be replaced with a lower-tier alternative?

### Step 4: What-if simulations for savings

For each identified optimization:
- `sec_what_if` — simulate removing the expensive role
- Check the projected tier and monthly/annual savings
- Check for SoD impact (would removing the role create or resolve conflicts?)

### Step 5: Present report

**Licence Audit Report**

| Metric | Value |
|--------|-------|
| Users assessed | N |
| Total monthly cost | sum of all user costs |
| Average tier | most common tier |

**Tier Distribution:**
(from tier_summary)

**Optimization Opportunities:**
For each opportunity:
- User, current tier, proposed change, projected tier, monthly saving
- SoD impact if any

**Recommendations:**
1. Role consolidation opportunities
2. Users who should be downgraded
3. Roles contributing most to licence cost
