# D365 What-If Role Simulation

Simulate the impact of adding or removing security roles from a user before making changes.

## Arguments
- $ARGUMENTS: Natural language describing the change (e.g., "add SystemAdministrator to john.doe", "remove AccountsPayableManager from FDittgen", "what if we give FDittgen the AP Clerk role instead of AP Manager")

## Workflow

### Step 1: Parse the simulation request

Extract from $ARGUMENTS:
- **user_id**: the target user
- **add_roles**: role names to add
- **remove_roles**: role names to remove

If role names are ambiguous, use `sec_search` to find the correct role name.

### Step 2: Run the simulation

`sec_what_if` with user_id, add_roles, remove_roles

This returns:
- Current vs projected licence tier (with cost delta)
- Current vs projected SoD violations (new and resolved)
- List of current and projected roles

### Step 3: Validate the change

**Licence impact:**
- If tier goes UP: flag as cost increase, show monthly + annual delta
- If tier goes DOWN: flag as cost saving opportunity
- If no change: note it

**SoD impact:**
- If new violations appear: show each rule, the conflicting duties, and the risk level
- If violations are resolved: highlight the improvement
- If no change: note it

**Access impact:**
For significant changes, check what access the user gains or loses:
- `sec_effective_permissions` with the user_id — current permissions
- `sec_permission_trace` for added/removed roles — what entry points change

### Step 4: Present results

**What-If Simulation: $USER**

| | Current | Projected | Delta |
|---|---|---|---|
| Licence Tier | X | Y | +/- cost |
| Monthly Cost | X.XX | Y.YY | +/- Z.ZZ |
| Annual Cost | X.XX | Y.YY | +/- Z.ZZ |
| Roles | N | M | +/- |
| SoD Violations | N | M | +/- |

**Role Changes:**
- Added: [list]
- Removed: [list]

**SoD Impact:**
- New violations: [list with rule IDs and risk levels]
- Resolved violations: [list]

**Recommendation:**
- Is this change safe?
- What should be done differently?
- Are there alternative role assignments that achieve the same goal with less risk/cost?

---

## Multiple scenarios

If the user asks to compare alternatives (e.g., "should we give them AP Clerk or AP Manager?"), run `sec_what_if` for each scenario and present a comparison table.
