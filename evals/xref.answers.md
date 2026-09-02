# XRef evals — verified answers and the calls that produce them

Verified 2026-09-02 against the local XRef snapshot (`~/.claude/d365fo_xref.sqlite`, 3.5 GB,
last refreshed 2026-09-01) through `src/local/mcp-server-xref.js`. Machine form:
`xref.calls.json`; replay with `node scripts/run-evals.mjs xref`. Byte figures are
`structuredContent`.

Enum values that matter (the tool descriptions carry them; the wrong guess is a validation
error, not a wrong answer): `direction: parents|subclasses` (class hierarchy),
`depends_on|depended_by` (module deps), `kind: All|Read|Write`, `object_type: Tables|Classes|Forms|…`.

| # | Title | Calls | Answer | sc bytes |
|---|---|---|---|---:|
| 1 | Ancestor depth + parent's direct subclasses | `xref_class_hierarchy {class_name:SalesFormLetter_Invoice, direction:parents, limit:10}` → 6 entries, depth 0..5 (SalesFormLetter, FormLetterServiceController, SysOperationServiceController, SysOperationController, Object) → 5 ancestors; `xref_class_hierarchy {class_name:SalesFormLetter, direction:subclasses, limit:100}` → 29 entries, 10 at depth 1 | **5,10** | 3,960 |
| 2 | CoC extension of CustGroup → module → dependency count | `xref_find_extensions {object_name:CustGroup, limit:5}` → `coc_classes: [CustGroupFormSubBillDeferral_Extension @ SubscriptionBilling]`; `xref_cross_module_deps {module_name:SubscriptionBilling, direction:depends_on, limit:100}` → `result_count: 24` | **SubscriptionBilling,24** | 1,427 |
| 3 | CustGroup.find() distinct caller modules | `xref_object_summary {object_name:CustGroup}` → `methods` includes `find`; `xref_find_method_callers {object_name:CustGroup, method_name:find, limit:500}` → 92 callers, not truncated, 10 distinct `module` values | **10** | 12,341 |
| 4 | documentStatus override declaring ancestor | `xref_method_references {object_name:SalesFormLetter_Invoice, method_name:documentStatus, limit:10}` → `kind: Override` → `/Classes/FormLetterServiceController/Methods/documentStatus`; `xref_class_hierarchy {…parents}` confirms it is an ancestor (depth 2) | **FormLetterServiceController** | 1,221 |
| 5 | CustGroup impact: Calls and AdvancedQualityManagement | `xref_object_summary {object_name:CustGroup}`; `xref_impact_analysis {object_name:CustGroup, limit:1}` → `by_kind: {Read:340, Call:158}`, `by_module.AdvancedQualityManagement: 2` | **158,2** | 1,547 |
| 6 | Sealed ISV model referencing CustGroup most | `xref_find_references {object_name:CustGroup, limit:1, include_isv:true}` → `isv.module_summary[0]: Lasernet (10)`; `xref_isv_find_usages {object_name:CustGroup, limit:1}` → `module_summary[0]: Lasernet (23)` | **Lasernet** | 1,309 |
| 7 | CreditManagement tables / CredManCreditLimit* | `xref_module_objects {module_name:CreditManagement, object_type:Tables, limit:500}` → `result_count: 37`, not truncated; `xref_search_names {pattern:"/Tables/CredManCreditLimit%", object_type:Tables, limit:100}` → `result_count: 7` | **37,7** | 3,188 |
| 8 | SubscriptionBilling dependents / top dependency | `xref_cross_module_deps {module_name:SubscriptionBilling, direction:depended_by, limit:100}` → `result_count: 10`; `xref_cross_module_deps {…, direction:depends_on, limit:1}` → `modules[0]: ApplicationSuite (35,159 refs)` | **10,ApplicationSuite** | 757 |
| 9 | Country-suffixed direct subclasses of SalesFormLetter | `xref_class_hierarchy {class_name:SalesFormLetter, direction:subclasses, limit:100}` → depth-1 names ending `_RU`/`_IN`: SalesFormLetter_Invoice4Paym_RU, SalesFormLetter_ShippingBill_IN; `xref_object_summary {object_names:[both]}` → `module: ApplicationSuite` for both | **2,ApplicationSuite** | 4,918 |
| 10 | SalesStatus vs PurchStatus sealed-ISV references | `xref_find_references {objects:[SalesStatus, PurchStatus], limit:1, include_isv:true}` → SalesStatus `isv.reference_count: 6` (Lasernet 4, AmcBankingFoundation 2), PurchStatus 0; `xref_isv_find_usages {object_name:SalesStatus, limit:1}` confirms the enum has ISV usages (its `usage_count` is higher because it also lists `/Enums/SalesStatus/EnumValues/*` targets — the question therefore names the scope) | **SalesStatus,6** | 1,745 |

Notes

- `result_count` on the list tools is the **returned** count (it equals `limit` when
  truncated); a count question therefore needs `limit` above the true total and
  `truncated:false` — every expr above checks that flag before trusting the number.
- Two tools count CustGroup differently and both are right about their own scope:
  `xref_object_summary` reports `incoming_total: 1244` (table + fields + methods, Call 187),
  `xref_impact_analysis` reports `total_refs: 498` for the table object itself (Call 158).
  Same for the ISV counts (find_references 10 vs isv_find_usages 23 on CustGroup; 6 vs more
  on the SalesStatus enum, where `xref_isv_find_usages` also lists `EnumValues/*` targets).
  Question 5 therefore names the tool ("impact analysis"), question 6 asks only for the
  model, and question 10 names the scope ("the enum object itself").
- `xref_interface_implementors {interface_name:SysPackable, limit:2}` took **150 s** on this
  box (900 implementors) and was left out; `xref_find_event_handlers {CustTable, insert}` took
  39 s and `xref_find_extensions {CustGroup}` 15 s cold, ~2 s warm.
- `xref_search_names` patterns are SQL `LIKE`: `SalesFormLetter_%` matches 214 classes because
  `_` is a one-character wildcard; question 9 counts the suffix in JavaScript instead.
