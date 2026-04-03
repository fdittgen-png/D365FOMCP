# Critical Audit: D365 Legal Entity Configuration Agent Blueprint

**Auditor**: Florian Dittgen
**Date**: 2026-03-25
**Document under review**: Agent Blueprint — D365 Finance Legal Entity Configuration Agent v1.0 (March 2026)
**Audit scope**: Technical accuracy, architectural feasibility, entity validation, platform constraints, security

---

## Executive Summary

The blueprint is an ambitious and well-structured document that demonstrates deep thinking about the problem. However, it contains **critical issues that would prevent it from working as described**. The most serious problems are: (1) the majority of OData entity names listed are wrong or fabricated, (2) the Copilot Studio platform cannot reliably orchestrate 40-80 sequential tool calls in a single session, (3) key entities referenced don't exist (notably `SalesTaxPresetParameters`), and (4) the "D365 ERP MCP Server" referenced is not the same as the d365kb/d365xref MCP servers in this project. The blueprint reads as if it was generated with heavy LLM assistance and not validated against a real D365 environment.

**Verdict**: Not production-ready. Requires significant rework before even PoC phase.

---

## SEVERITY 1 — Blockers (Will Not Work)

### 1.1 Most OData Entity Names Are Wrong

The Entity Map (Section 8) lists 46 entity names. Cross-referencing against the actual D365FO metadata knowledge base reveals that **the majority use incorrect names**. The blueprint uses simplified/invented plural names that don't match D365's actual OData entity set names.

| # | Blueprint Claims | Actual Entity Name (from D365 KB) | Status |
|---|---|---|---|
| 1 | `LegalEntitiesV2` | Likely correct (standard Microsoft entity) | Needs verification |
| 2 | `LegalEntityPostalAddresses` | **Not found** — no entity by this name exists | WRONG |
| 3 | `TaxCodes` | No such entity set. Actual: `TaxCodeValueV2Entity` (OData: `TaxCodeValuesV2`) exposes tax code values, not the code header | WRONG |
| 4 | `TaxGroups` | No such entity set. Closest: `BusinessDocumentTaxGroupHeadingEntity` | WRONG |
| 5 | `TaxItemGroups` | Actual: `TaxItemGroupHeadingEntity` (OData: `ItemSalesTaxGroups`) | WRONG name |
| 6 | `SalesTaxPresetParameters` | **Does not exist at all** — zero results in D365 metadata | FABRICATED |
| 7 | `TaxLedgerPostingGroups` | **Does not exist** — zero results | FABRICATED |
| 8 | `TaxAuthorities` | Actual: `TaxAuthorityEntity` (OData: `SalesTaxAuthorities`) | WRONG name |
| 9 | `TaxSettlementPeriods` | Actual: `TaxPeriodHeadEntity` (OData: `SalesTaxSettlementPeriods`) + `TaxPeriodEntity` for lines | WRONG name |
| 10 | `BankAccountsV3` | No V3 exists. Actual: `BankAccountEntity` (OData: `BankAccounts`) | WRONG |
| 11 | `VendorPaymentMethods` | Not found. Related: `BankVendPaymModeBankAccountsEntity` | WRONG |
| 12 | `CustomerPaymentMethods` | Not found. Related: `BankCustPaymModeBankAccountsEntity` | WRONG |
| 13 | `CustomerPostingProfiles` | Actual: `CustCustomerPostingProfileHeaderEntity` + `CustCustomerPostingProfileLineEntity` (two entities, not one) | WRONG (2 entities needed) |
| 14 | `CustomerGroups` | Actual: `CustCustomerGroupEntity` (OData: `CustomerGroups`) | Name might work, but field names differ |
| 15 | `AccountsReceivableParameters` | Actual: `CustomerParametersEntity` (OData: `CustomerParameters`) | WRONG name |
| 16 | `AccountsPayableParameters` | Likely `VendorParametersEntity` — not found directly | WRONG name |
| 17 | `InterestCodes` | Actual: `CustInterestCodeWithFeeEntity` / `CustInterestCodeWithRangeEntity` | WRONG (multiple entities) |
| 18 | `CollectionLetterSequences` | Actual: `CollectionLetterCourseEntity` | WRONG name |
| 19 | `VendorPostingProfiles` | Actual: `VendorPostingProfileHeaderEntity` + line entity | WRONG (2 entities needed) |
| 20 | `VendorGroups` | Actual: `VendVendorGroupEntity` (OData: `VendorGroups`) | Name might work |
| 21 | `VendorChargesGroups` | **Does not exist** — zero results | FABRICATED |
| 22 | `DepreciationProfiles` | Actual: `AssetDepreciationProfileEntity` | WRONG name |
| 23 | `FixedAssetGroups` | Actual: `AssetGroupEntity` (OData: `FixedAssetGroups`) | Name might work |
| 24 | `FixedAssetsParameters` | Actual: `AssetParametersEntity` (OData: `FixedAssetParameters`) | WRONG name |
| 25 | `Sites` | Actual: `InventOperationalSiteEntity` (OData: `OperationalSites`) | WRONG name |
| 26 | `Warehouses` | Actual: `InventWarehouseEntity` (OData: `Warehouses`) | Probably correct |
| 27 | `ItemModelGroups` | Not found as entity | UNVERIFIED |
| 28 | `ItemGroups` | Not found as a standard config entity | UNVERIFIED |
| 29 | `InventoryPostingProfiles` | Not found | FABRICATED or custom |
| 30 | `InventoryParameters` | Not found directly | UNVERIFIED |
| 31 | `PaymentDays` | Not found as entity | UNVERIFIED |
| 32 | `PaymentTerms` | Actual: `PaymentTermEntity` (OData: `TermsOfPayment`) | WRONG name |
| 33 | `NumberSequences` | Actual: `NumberSequenceEntity` (OData: singular pattern) | Needs verification |

**Impact**: The agent will fail on its first `data_create_entities` call for most entities. The instruction "ALWAYS call `data_find_entity_type` before using any entity" is meant to mitigate this, but then the entity map is misleading documentation that will confuse both the agent and operators.

**Recommendation**: Every entity name must be verified against the actual D365 OData `$metadata` endpoint of the target environment. The entity map should be rebuilt from scratch using verified names. This is not a minor fix — it invalidates the Excel schema (Section 9), the dependency graph (Section 12), and most topic specifications.

---

### 1.2 `SalesTaxPresetParameters` Does Not Exist

The blueprint identifies `SalesTaxPresetParameters` as a **critical dependency** that "MUST precede TaxCodes" (highlighted with a warning icon in Sections 2, 7, 8, and 12). This entity does not exist in D365 metadata.

The concept it's trying to address — the marginal base/calculation method for sales tax — is configured as part of the tax code setup itself (fields on the `TaxData` / `TaxTable` tables), not via a separate "preset parameters" entity.

**Impact**: The entire Tax phase ordering rationale is built on a phantom dependency. This is a hallmark of LLM-generated content that was never validated.

---

### 1.3 The "D365 ERP MCP Server" Is Not an Existing Product

The blueprint references a specific MCP server: "Dynamics 365 ERP MCP Server" with tools named `data_find_entity_type`, `data_create_entities`, `data_find_entities`, `data_get_entity_metadata`, `data_update_entities`, `data_delete_entities`, `form_find_menu_item`, `form_open_menu_item`, `form_click_control`, `form_save_form`, `form_set_control_values`, `form_filter_grid`, `form_open_or_close_tab`, `api_find_actions`, `api_invoke_action`.

This is **not** the d365kb/d365xref MCP servers in this repository. Those servers provide metadata lookup and cross-reference analysis — they are read-only and have no CRUD or form automation capabilities.

The "D365 ERP MCP Server" described in the blueprint appears to be either:
- A hypothetical/future product that doesn't exist yet
- A third-party tool (e.g., from the MCP community) that needs to be separately sourced, licensed, and deployed
- A completely fabricated tool set

**Impact**: Without this MCP server, the entire agent has zero capability to write to D365. This is the most fundamental blocker.

**Recommendation**: The blueprint must clarify exactly what this MCP server is, where it comes from, its current availability status, and how to deploy it. If it doesn't exist, the entire blueprint is a concept paper, not a production-ready design.

---

### 1.4 Copilot Studio Cannot Reliably Orchestrate 40-80 Sequential Tool Calls

The blueprint estimates 40-80 MCP tool calls per configuration run, spread across 13+ sequential topics with topic redirects. This pushes against multiple Copilot Studio platform limits:

- **Turn limits**: Copilot Studio generative mode has limits on consecutive tool call turns within a single conversation. Sustained autonomous execution of 80 tool calls without user interaction is not guaranteed behavior.
- **Session timeouts**: Long-running autonomous sessions may time out, especially if individual MCP calls take several seconds each (40 calls × 3s avg = 2+ minutes of pure tool execution).
- **Token context window**: By Phase 7-8, the conversation context will contain the accumulated results of dozens of tool calls. The model may start losing track of earlier phases, producing errors in later phases.
- **Generative orchestration reliability**: The blueprint relies on generative AI to "select topic and tools dynamically per phase." Generative orchestration is designed for routing user requests to the right topic — not for driving a 13-step deterministic workflow. This is a misuse of the pattern.

**Recommendation**: This workflow should be implemented as a **Power Automate flow with MCP HTTP calls** (deterministic orchestration), not as a conversational agent using generative orchestration. The agent layer should only handle user interaction (input gathering, confirmation, status reporting), while the execution engine is a flow.

---

## SEVERITY 2 — Major Issues (Will Cause Problems)

### 2.1 Phase Numbering Is Inconsistent

The Instructions Field (Section 2) numbers phases 0-12 (13 phases). The Topics (Section 7) number them as Phase 1-9. The dependency graph (Section 12) uses Phases 0-9. The entity map (Section 8) groups by module name without phase numbers. These all tell different stories:

| Source | Legal Entity | GL | NumSeq | Tax | Bank | AR | AP | FA | SC |
|---|---|---|---|---|---|---|---|---|---|
| Instructions | Phase 3 | Phase 4 | Phase 5 | Phase 6 | Phase 7 | Phase 8 | Phase 9 | Phase 10 | Phase 11 |
| Topics | Topic 4 (Phase 1) | Topic 5 (Phase 2) | Topic 6 (Phase 3) | Topic 7 (Phase 4) | Topic 8 (Phase 5) | Topic 9 (Phase 6) | Topic 10 (Phase 7) | Topic 11 (Phase 8) | Topic 12 (Phase 9) |
| Dep. Graph | Phase 1 | Phase 2 | Phase 3 | Phase 4 | Phase 5 | Phase 6 | Phase 7 | Phase 8 | Phase 9 |

An agent trying to set `Global.LastCompletedPhase = 2` after GL configuration will be inconsistent with the instructions saying GL is Phase 4. This will break checkpoint/resume logic.

---

### 2.2 Checkpoint/Resume Won't Work as Designed

The blueprint proposes `Global.LastCompletedPhase` as a checkpoint mechanism. However:

- **Copilot Studio global variables don't persist across sessions**. When the session ends (timeout, browser close, error), the variable is lost.
- The gap analysis (Section 3) correctly identifies this and says "must be written to a Dataverse table or SharePoint list by the Power Automate flow." But no flow is designed for this — Flow 1 reads Excel, Flow 2 sends notifications. There's no Flow 3 for checkpoint persistence.
- Even if checkpoints were persisted, **resuming mid-workflow requires re-reading all configuration data AND the state of what was already created in D365**. Simply skipping to "Phase 6" means the agent has no context about what was created in Phases 1-5 (entity IDs, keys, etc. needed for foreign key references in later phases).

**Recommendation**: Design an explicit checkpoint flow. But more fundamentally, reconsider whether a conversational agent is the right pattern for this (see 1.4).

---

### 2.3 Rollback Topic Is Dangerously Naive

Topic 14 proposes rollback via `data_delete_entities` in reverse phase order. Problems:

- **D365 does not support cascading deletes on configuration entities**. You cannot delete a `Ledger` record if `LedgerParameters`, `TaxCodes`, `JournalNames`, etc. reference it. The reverse-order deletion would need to be perfect, and any single failure blocks subsequent deletions.
- **Some configuration records are shared** and may have been referenced by other processes during the time between creation and rollback (e.g., a user may have already posted a transaction using a payment term created by the agent).
- **Posting profiles, when applied, affect transaction processing**. Deleting them mid-operation could corrupt financial data.
- **The Legal Entity itself cannot be deleted via OData**. Company deletion in D365 is a complex, multi-step administrative process that requires the company to be completely empty of transactions.
- **No undo for form tool actions** — the Account Structure activation done via `form_click_control` cannot be reversed via a simple delete.

**Recommendation**: Remove the rollback topic entirely. Replace with a "Deactivate / Flag for Review" topic that marks the company as inactive and generates a manual cleanup checklist. Honest documentation that rollback is not automated is better than a rollback feature that will fail and make things worse.

---

### 2.4 Claude Sonnet 4.5 as Primary Model in Copilot Studio

The blueprint specifies Claude Sonnet 4.5 as the primary model with GPT-4o as fallback. Issues:

- **Copilot Studio does not natively support Claude models**. As of March 2026, Copilot Studio uses Azure OpenAI (GPT-4o/GPT-4o-mini) as its generative engine. Using Claude would require a custom AI plugin or connector — this is not documented anywhere in the blueprint.
- **Model routing between Claude and GPT-4o is not a Copilot Studio feature**. There's no native "fallback model" configuration.
- **Tenant admin approval for external AI models** is mentioned but the actual mechanism to integrate Claude into Copilot Studio is not described.

**Recommendation**: Either design the agent for GPT-4o (which Copilot Studio natively supports) or document the exact integration architecture for using an external model. The current specification is not implementable.

---

### 2.5 Posting Profiles Require Header + Line Entities (Not One Entity)

The blueprint treats Posting Profiles as single entities:
- `CustomerPostingProfiles` → actually needs `CustCustomerPostingProfileHeaderEntity` + `CustCustomerPostingProfileLineEntity`
- `VendorPostingProfiles` → actually needs `VendorPostingProfileHeaderEntity` + a line entity

A posting profile header without lines is useless — it defines no GL account assignments. The Excel schema only has one sheet per posting profile type, and the column list doesn't distinguish header vs. line fields.

**Impact**: Posting profiles will either fail to create or be created as empty shells with no account assignments, breaking AR/AP posting.

---

### 2.6 "System Agent" Security Role Does Not Exist

The blueprint references a "System agent" security role that "exempts from D365 user licensing" and provides "base MCP server access." This is not a standard D365 security role. D365 has:
- System Administrator
- System User (the base role)
- Various module-level roles

The claim that an agent identity is exempt from D365 user licensing via a "System agent" role is not supported by Microsoft's current licensing documentation. D365 Finance requires a user license for any identity that reads/writes data via OData, including service accounts.

**Impact**: Licensing costs may be significantly higher than documented. The security model needs to be validated with Microsoft licensing terms.

---

## SEVERITY 3 — Design Concerns (Should Be Improved)

### 3.1 Excel as Configuration Source Is Fragile

Using Excel with named tables and exact column headers is error-prone:
- Users can accidentally rename columns, insert extra columns, reorder columns, or change table names
- Excel date formatting varies by locale — a user with Italian Excel may produce `25/03/2026` instead of `2026-03-25` despite documentation saying ISO 8601
- No schema validation happens at the Excel level — errors are only caught at flow runtime
- The blueprint has 23 sheets with specific table names and column headers — maintaining this manually is unsustainable

**Recommendation**: Provide a locked Excel template with data validation rules, protected column headers, and named ranges. Better yet, consider a SharePoint list or Dataverse table as the config source — these provide schema enforcement natively.

---

### 3.2 Cross-Company OData Writes Need More Nuance

The blueprint states: "For company-specific entities: always include `dataAreaId` in the payload." This oversimplifies D365 cross-company OData behavior:

- Some entities require `dataAreaId` in the URL path (e.g., `/data/EntityName?cross-company=true`), not just in the payload
- Some entities derive `dataAreaId` from the authenticated session context and reject it in the payload
- The `cross-company=true` parameter is for reads, not writes — writes to company-specific entities typically require the company to be set in the HTTP header (`OData-Company`) or the session

These nuances are not documented and will cause cryptic "400 Bad Request" errors.

---

### 3.3 No Idempotency Strategy

The blueprint has no strategy for handling the case where the agent is re-run and records already exist. The verification step only confirms creation — it doesn't check "does this record already exist before I try to create it?"

If the agent fails at Phase 6 and is restarted, it will attempt to re-create all Phase 1-5 records, which will fail with duplicate key errors on every entity.

The checkpoint mechanism (even if it worked) only skips phases — but a phase is not atomic. If Phase 4 (Tax) fails after creating 5 of 8 entities, a restart would skip the entire phase or re-attempt all 8, creating duplicates for the first 5.

**Recommendation**: Every `data_create_entities` call should be preceded by a `data_find_entities` check. If the record exists, skip or update. This doubles the tool call count (to 80-160) which further strains the platform limits from issue 1.4.

---

### 3.4 Power Automate Flow Response Size Limits

Flow 1 reads an entire Excel workbook (23 sheets) and returns a single JSON object containing all configuration data. Power Automate has:
- **Response body size limit**: The "Respond to a tool" action has a maximum response size. A large configuration with dozens of number sequences, tax codes, and posting profile lines could exceed this.
- **Flow execution timeout**: The "When an agent calls a flow (V2)" trigger has synchronous timeout limits (typically 30-120 seconds). Reading 23 Excel tables sequentially may exceed this.

The blueprint acknowledges the 30-second timeout in Section 3 but doesn't design around it — it just says "document this risk." That's not a mitigation.

---

### 3.5 The Dependency Graph Oversimplifies

The dependency graph (Section 12) shows dependencies between phases, but within each phase, the dependencies between entities are not fully mapped. For example:

- `TaxCodes` requires `TaxLedgerPostingGroups` (which the blueprint correctly sequences) but also requires a valid `TaxSettlementPeriod` to be assigned — this cross-dependency within Phase 4 is not called out
- `AccountsForAutomaticTransactions` requires the main accounts to exist in the Chart of Accounts AND in the Ledger's account structure — but account structures are shared (Phase 0 prerequisite) and the blueprint only validates they exist, not that the specific accounts referenced in the Excel are part of the structure
- `NumberSequenceReferences` links sequences to D365 functional areas using internal reference IDs — these are not user-friendly values and won't appear in an Excel file naturally

---

### 3.6 No Logging or Audit Trail Design

The blueprint mentions "log step number, entity name, error message, payload attempted" in error handling, but doesn't specify WHERE this log is stored. Copilot Studio conversation history is not a reliable audit trail:
- Conversations expire
- There's no structured export
- Multi-run history is not queryable

For a process that makes 40-80 writes to a production ERP system, a proper audit log (in Dataverse, Application Insights, or at minimum a SharePoint list) is essential for compliance and debugging.

---

### 3.7 Form Tool Usage for Account Structure Activation Is Under-Specified

The blueprint includes a form tool sequence for Account Structure activation (Topic 5):
```
form_find_menu_item → form_open_menu_item → form_open_or_close_tab → form_filter_grid → form_click_control("Activate") → form_save_form
```

This assumes:
- The account structure is already created (it's a Phase 0 prerequisite)
- The account structure has been modified since the last activation (otherwise Activate is greyed out)
- The form renders in the expected layout for the MCP server to find the "Activate" button
- No validation errors pop up during activation (structure validation can produce dialogs)

None of these conditions are verified. If the structure is already active, clicking "Activate" may do nothing or produce an error. The blueprint should check the activation status first.

---

### 3.8 Missing: Currency Exchange Rate Setup

The blueprint configures currency assignments (via Ledger entity) but never creates **exchange rates**. A new legal entity with a currency different from the system currency will fail on any GL posting without exchange rates. This should be either:
- Added as a Phase 2 sub-step
- Listed as a mandatory manual follow-up item (it's currently not in the manual steps list)

---

### 3.9 Missing: Financial Dimension Value Setup

The blueprint configures `DimensionParameters` but never creates dimension values (e.g., Department, CostCenter values). If the new company uses financial dimensions (most do), transactions will fail without valid dimension values. This is another missing phase or manual step.

---

## SEVERITY 4 — Minor / Documentation Issues

### 4.1 "46 Entities" Count Is Wrong
The entity map numbers 1-46 but several entries are questionable (fabricated entities). The actual implementable entity count, after removing phantom entities and adding missing header/line splits, will be different.

### 4.2 Adaptive Cards Contradiction
Section 7 (Topic 2.5) uses emoji-heavy plain text for confirmation. Section 11 says "Adaptive Cards not supported outside Teams." Section 5 (Flow 2) says "Post adaptive card (Teams)." The document should pick one approach and be consistent.

### 4.3 Testing Checklist References Non-Existent Entities
The testing checklist (Section 14) references `SalesTaxPresetParameters` as a test case: "SalesTaxPresetParameters created BEFORE TaxCodes — validate ordering in D365 Tax module." This will fail since the entity doesn't exist.

### 4.4 Tool Count "17 KB + 16 XRef" Is Irrelevant
The blueprint doesn't use the d365kb or d365xref MCP servers at all — it uses a separate "D365 ERP MCP Server." Mentioning KB/XRef tool counts creates confusion about which MCP server the agent uses.

### 4.5 Version Reference "D365 Finance 10.0.47+"
D365 Finance version 10.0.47 would correspond to a release beyond current GA. The entity availability should be validated against the actual target environment version, not a forward-looking version number.

---

## Summary: Issues by Severity

| Severity | Count | Key Items |
|---|---|---|
| **S1 — Blockers** | 4 | Wrong entity names, phantom entities, MCP server doesn't exist, platform can't support the workload |
| **S2 — Major** | 6 | Phase numbering chaos, checkpoint won't persist, rollback is dangerous, Claude not supported in Copilot Studio, posting profiles need 2 entities, "System agent" role doesn't exist |
| **S3 — Design** | 9 | Fragile Excel source, OData write nuances, no idempotency, flow size limits, incomplete dependencies, no audit trail, under-specified form tools, missing exchange rates, missing dimensions |
| **S4 — Minor** | 5 | Entity count wrong, Adaptive Cards contradiction, test checklist references phantoms, irrelevant tool counts, future D365 version |
| **Total** | **24** | |

---

## Recommendations

### Immediate Actions (Before Any Development)

1. **Verify every entity name** against the actual D365 OData `$metadata` endpoint. Rebuild the entity map from scratch. Use `data_find_entity_type` or the D365 DMF entity list as the authoritative source.
2. **Clarify the "D365 ERP MCP Server"** — what is it, where does it come from, is it available today? This is a prerequisite for the entire project.
3. **Settle on GPT-4o** as the model (or document the Claude integration architecture) since Copilot Studio natively supports GPT-4o.
4. **Unify the phase numbering** — pick one scheme and apply it consistently across all sections.

### Architectural Rethink

5. **Move execution logic to Power Automate**. Use a deterministic flow for the D365 write operations, not generative AI orchestration. The agent should be the user-facing layer (gather inputs, confirm, report status) while Power Automate handles the actual configuration writes in a reliable, sequential, checkpoint-able flow.
6. **Add idempotency** — every create must be preceded by an existence check.
7. **Remove the rollback topic** or replace with a manual cleanup guide.
8. **Design a real checkpoint mechanism** using Dataverse or SharePoint to persist state between sessions, including per-entity (not just per-phase) granularity.

### Before Go-Live

9. **Build the Excel template** with locked headers, data validation, and locale-independent formatting.
10. **Add exchange rate and financial dimension setup** to the scope or the manual steps list.
11. **Implement a structured audit log** for every D365 write operation.
12. **Validate licensing** — confirm whether the agent identity requires a D365 Finance user license.
