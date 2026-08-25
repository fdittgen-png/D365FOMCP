# FDD Compliance Audit Method (2026-07-07 session)

_Reference for the `d365fo-security-analysis` skill. Read on demand._


How to answer "does this SoD solution identify everything the FDD requires?" — reusable for any spec-vs-implementation audit.

### Locate and mine the FDD
- The RAG knowledge base may not have project FDDs — search **SharePoint/OneDrive via the M365 MCP** (`sharepoint_search` with the DevOps ID, then `read_resource` on the hit). FDD 99352 lived in the operator's OneDrive as `FDD_Administration-01_SOD compliance check V1.docx`.
- Extract the *verbatim* engine spec (99352's is: load roles-duties mapping → filter selected → expand roles→duties → generate all duty pairs → check vs conflicts → output JSON) and the workflow/table requirements (columns, approvers-per-legal-entity, functional translations). Audit each item explicitly — the misses hide in workflow requirements (approve/reject endpoint, notifications, approver config), not in the engine.

### Quantify detection coverage empirically (MCP sec DB)
- The compliance question reduces to: **what fraction of duties actually assigned to enabled users can the engine see?** CTE pattern against `sec_raw_sql`: assigned roles of enabled users → UNION with `role_subroles` children → DISTINCT `role_duties.duty_id` → count those in the mapping's ID set.
- **Traps**: (a) in the MCP schema, `duties.duty_id` is the AOT name and `duty_name` is a label *reference* (`@AppTroubleshooting:...`) — matching on `duty_name` returns garbage (1 hit instead of 100); (b) DMF-derived mapping IDs are truncated at 39 chars — compare on `SUBSTR(UPPER(duty_id),1,39)`; (c) some ISV duty IDs are GUIDs.
- Result shape that matters to stakeholders: "engine sees N of M assigned duties (x%)", "bucket Dnn has zero mapped duties → k rules can never fire", "j of R rules carry the auditor's functional translation". Concrete numbers turn "coverage concern" into a workplan.
- Rule-relevance nuance: not every unmapped duty matters — but **nobody knows which ones matter until they are reviewed against the buckets**, and that review IS the remediation task. Don't let "most duties are irrelevant" excuse the gap unmeasured.
