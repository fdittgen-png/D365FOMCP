# Part 8: Technical Bug Analysis

_Reference for the `d365fo-support-scoping` skill. Read on demand._


### Root Cause Investigation Pattern

**Phase 1: Identify affected area (parallel — 5 calls):**
```
PARALLEL:
  d365_search(error_keywords)                          -- Find related objects
  rag_search(error_message)                            -- Known internal issue?
  microsoft_docs_search("D365 [error_or_topic]")       -- MS known issue / troubleshooting?
  microsoft_docs_search("D365 [feature] configuration") -- Is it a config issue?
  microsoft_code_sample_search("[pattern] X++")         -- Official code patterns
```

**Phase 1b: Fetch full MS docs if search found relevant pages:**
```
microsoft_docs_fetch(troubleshooting_url)  -- Full troubleshooting steps
microsoft_docs_fetch(configuration_url)    -- Full config guide with parameters
```

**Phase 2: Trace code path (parallel per class):**
```
PARALLEL:
  d365_get_class_methods(className, include_source:true, filter:"methodName")
  xref_find_method_callers(className, methodName)
  xref_find_extensions(className)
  xref_find_event_handlers(className, methodName)
```

**Phase 3: Check customization conflicts:**
```
For each extension:
  d365_get_method_source(extensionClass, "methodName") -- Read CoC code
  xref_class_hierarchy(extensionClass)                 -- Inheritance context
```

**Phase 4: Data model verification:**
```
PARALLEL:
  d365_lookup_table(affectedTable)                     -- Structure + constraints
  d365_get_join_keys(table1, table2)                   -- Correct join?
  d365_hallucination_check(tableName)                  -- Known field traps
```

### Extension Conflict Detection

Extensions (CoC) are the #1 cause of bugs after upgrades. Always check:
```
xref_find_extensions(objectName) → for each extension:
  d365_get_method_source(extensionClass, "methodName") → read CoC code
  xref_find_event_handlers(objectName, methodName)     → event handler conflicts
```

**Red flags in extension code:**
- `next` keyword missing → breaks CoC chain
- `ttsbegin`/`ttscommit` without `ttsabort` in catch
- Hard-coded company IDs or enums
- Missing `super()` calls in form overrides

### Stuck / Orphaned Status Flags (a status shown but its cause can't be found)

When a user reports a status/flag that is set "and can't be turned back" (e.g. a sales order shows **Do not process = Yes** but there's no hold anywhere), do NOT assume the displayed control is editable. Many D365 status indicators are **stored flags that a background engine toggles from a child "events"/log table** — the indicator only clears when the engine re-evaluates and finds no active driver.

**Diagnostic pattern:**
```
1. Identify the backing field, not the label.
   d365_check_field_exists(table, ["<guessField>", ...])  -- find the real stored field
   → e.g. "Do not process" = SalesTable.MCROrderStopped (NOT a checkbox)
2. Find the driver table + its event/type enum.
   d365_search("<feature> event hold")  → e.g. MCROrderEventTable
   d365_get_enum(<eventTypeEnum>)        → e.g. MCROrderEventType (which values are HOLDS vs audit-only)
3. Query the driver table for the record (user runs it — see SQL skill).
   Active hold = hold-type event row with its clear-datetime blank.
   If ALL rows are audit-only (create/modify/date-change) → ORPHANED FLAG, nothing to release.
```

**Worked example — sales order "Do not process":**
- Field: `SalesTable.MCROrderStopped` (NoYes). Driver: `MCROrderEventTable` (key `SalesId`), event enum `MCROrderEventType`.
- Hold-type event values: 0 AddSOOrderHold, 40 fraud, 53 item-cancel, 60 check, 61 over-credit, 64 over-pay, 65 under-pay. Audit-only: 10 create, 27 modify, 79/80 modify confirmed receipt/ship date. `HoldClearDateTime = 1900-01-01` is the null default — meaningless on non-hold rows.
- The **Functions → Order holds** button shows MANUAL holds only; fraud/payment/check holds live in the **Order holds workbench** (Retail and Commerce → Customers → Order holds). "No hold on the order" ≠ no hold event.
- **Fix (orphaned flag):** add a dummy order hold then immediately Remove it — the remove logic re-evaluates, finds no active hold, resets the flag. Validate on the SUPPORT copy, apply via UI on cloud PROD (no SQL write on PROD — see SQL skill). If add/remove fails, deploy an X++ runnable class to set the flag (safe only because no backing event exists to re-trigger).

**General lesson:** status flag + child event/log table + an enum that distinguishes "active driver" from "audit entry" is a recurring D365 shape (sales holds, FTC clock, credit management). Always locate the driver table before declaring it stuck or recommending a data fix.

### Migrated-PO Inconsistency Signature (DMF-injected documents bypassing InventUpdate)

When a purchase order that was **data-migrated from a legacy system** throws state-guard errors on later processing, suspect a migration data defect before user error or config. Recognizable signature:

- **Bare/legacy document number** (e.g. `041551` instead of `PO-xxxxx` from the number sequence) → created by migration, not by users
- **Header/document state mismatch**: `PurchTable.DocumentState = Draft` while confirmations, receipt lists, or posted product receipts already exist
- **Guard errors on the next touch**, e.g.:
  - *"Workflow" Submit greyed / order stuck Draft* (workflow can't evaluate the inconsistent state)
  - *"Quantity ordered cannot be reduced because there are not enough open inventory transactions with the ordered status..."* on registration/receipt — the InventTrans Ordered/Received split doesn't match the line remainders

**Why it happens:** header/line DMF entities (`PurchPurchaseOrderHeaderV2Entity`/`...LineV2Entity`) are heavily validated, but document-injection entities like `VendProductReceiptHeaderEntity`/`VendProductReceiptLineV2Entity` have **no custom validation** (only `defaultCTQuery`) and do **not** drive the `InventUpdate` engine a real `PurchFormLetter::Receipt` posting would. Raw inserts create `VendPackingSlipJour/Trans` documents without keeping `InventTrans` statuses and `PurchLine` remainders in sync.

**Diagnostic queries (support DB copy):**
1. `InventTrans` joined via `InventTransOrigin` (ReferenceId = PO) broken out by `StatusReceipt`, with `InventDim.InventBatchId`
2. `PurchLine.PurchQty / RemainPurchPhysical / RemainInventPhysical` for the affected line
3. `VendPackingSlipJour/Trans` — was a receipt actually posted for those pieces?

**Decision table before proposing a fix:**
| Finding | Conclusion | Action |
|---|---|---|
| Qty sits in Received matching a posted packing slip | Goods already booked by migration — user is **double-booking** | Explain; proceed to invoicing; no data fix |
| Received/Registered qty with no matching receipt doc, or remainders don't reconcile | Migration corrupted the status split | Guarded data correction, sandbox-first |
| Ordered qty exists under a different InventDimId/batch | Batch/dim mismatch | Register against correct dim or correct the dim |

**Fixes, cheapest first:** (1) OOB periodic task **"Purchase order distribution reset"** (Procurement and sourcing → Periodic tasks → Clean up) — rebuilds distributions and cleared the workflow-unavailable case on a CM-off orphan Draft; (2) guarded X++ DocumentState correction; (3) InventTrans/remainder data correction. Always sweep cross-company for the same migration signature (bare-number PurchId + Draft + posted documents, same migration date).

**Ticket-linkage lesson:** tickets from the same reporter minutes apart, or sharing a document number, are usually one root cause. Diagnose the root-cause ticket first, fix, then re-test the symptom ticket — never scope them independently.

