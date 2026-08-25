---
description: Investigates a reported D365FO issue across configuration, security, data model, and code paths, and produces a diagnosis with root cause and resolution steps. Use for troubleshooting tickets — "user cannot post X", "approval failing", "field missing", integration errors.
argument-hint: <issue description>
---

# Support: Diagnose Issue

## Task
Diagnose the issue described in `$ARGUMENTS`.
**Done when:** the report states a most-likely root cause with the evidence behind it, clearly separates confirmed findings (from tool output) from hypotheses, and — if the fix changes data — includes the full cross-company Actionable Data extract.

Domain deep-dives when the ticket matches: Basware/AP invoices → `the `basware-d365-vendor-invoice-integration` skill`; SQL extracts → `d365fo-sql-direct-queries.md`; security → `d365fo-security-analysis.md`.

## Workflow

### Step 1: Identify the area (parallel)
Extract key objects (forms, tables, fields, error messages, user IDs), then:
- `d365kb:d365_search` with keywords, `d365rag:rag_search` with the issue description, `Microsoft Learn:microsoft_docs_search` with the topic _(if the d365rag MCP is connected)_

### Step 2: Check security (if user-related)
- `d365sec:sec_lookup_user` — roles, companies; `d365sec:sec_effective_permissions` on the relevant object; `d365sec:sec_permission_trace` for the full chain
- For "access denied": trace the menu item/form and compare granting roles with the user's actual roles. Also check the user's Person/Worker link — a granted permission with a broken worker link still fails.

### Step 3: Check data model (if data-related)
- `d365kb:d365_lookup_table`, `d365kb:d365_check_field_exists` (verify every field before writing SQL), `d365kb:d365_get_enum` for status fields
- **Scope across all legal entities:** never limit the investigation to the reported company — data issues usually exist in several. The reported company is just where the symptom was noticed.

### Step 4: Check code (if logic-related)
- `d365kb:d365_get_class_methods` for the processing class, `d365xref:xref_find_method_callers`, `d365xref:xref_find_extensions` for customizations that may cause the issue

## Output

**Diagnosis Report for: "$ARGUMENTS"**

| Check | Finding |
|-------|---------|
| Security | OK / Issue found |
| Configuration | OK / Issue found |
| Customization | None / Extensions found |
| Documentation | Known issue / No match |

- **Root Cause Analysis** — most likely cause + supporting evidence; alternatives you ruled out and why
- **Resolution Steps** — ordered
- **Actionable Data** (if the fix changes data): ready-to-run SQL for ALL affected records across companies, a Company | Current Value | Proposed Value table, per-company counts, and flagged secondary data-quality issues. This is the operations handoff — complete enough to act on without follow-up questions.
- **Escalation Notes** (if unresolved): objects involved, extensions found, suggested next investigation

## Diagnostic patterns (hard-won discriminators)

**"Fails via integration but posts manually"** — several D365 validations are automation-only gates (e.g. the vendor-invoice totals-match check, raised only for `DocumentOrigin == Service` + `VendParameters.AutomationTotalsReqForWorkflowSubmission`). A clerk posting from the form bypasses them, and D365 books its own calculated figures — so "posted without error" ≠ "posted correctly"; verify the voucher. Confirm via `d365_get_method_source` whether a check is scoped to automation/workflow. Full analysis: basware skill.

**Reading OData write errors:** `IEEE754Compatible` = serialization (number sent as string / Int32 sent `0.0`); `insert not allowed for field X` (403) = read-only/derived field in the payload; a business validation in an HTTP 200 body = parse the response body, never trust the status code alone.

**Tax on charges & rounding (vendor invoices):** the Tax Calculation Service excludes charge `MarkupTrans` from the tax document (charges → 0 VAT), and middleware net "rounding" lines double-count against D365's per-tax-code rounding. Diagnose by tiering: vendor document vs middleware payload vs posted voucher; discriminator = does D365's computed VAT total already equal the supplier's? Full taxonomy: basware skill.

## Boundaries
- Never pull live consumer/vendor financial records into the session. To verify posted data, give the user a read-only run-it-yourself query keyed by known IDs; have them return only privacy-safe scalars.
