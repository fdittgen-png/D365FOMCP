# KB evals — verified answers and the calls that produce them

Verified 2026-09-02 against the local KB snapshot (`~/.claude/d365fo_kb.sqlite`, build
2026-08-14, ApplicationSuite 10.39.2142.10721) through the stdio server
`src/local/mcp-server-kb.js`. Machine form: `kb.calls.json`; replay with
`node scripts/run-evals.mjs kb`. Byte figures are `structuredContent` (the channel the
claude.ai connector bills).

| # | Title | Calls | Answer | sc bytes |
|---|---|---|---|---:|
| 1 | SalesTable status enum: integer of Invoiced | `d365_lookup_table {table_name:SalesTable, fields_like:SalesStatus}` → `enum_type: SalesStatus`; `d365_get_enum {enum_name:SalesStatus}` → `values[Invoiced].value` | **3** | 22,758 |
| 2 | CustInvoiceJour → CustTable target field's EDT | `d365_get_join_keys {table1:CustInvoiceJour, table2:CustTable}` → both relations target `AccountNum`; `d365_lookup_table {table_name:CustTable, fields_like:AccountNum}` → `edt` | **CustAccount** | 22,206 |
| 3 | CustCustomerV3Entity: the one mandatory *Group* field | `d365_get_entity_sources {entity_name:CustCustomerV3Entity, fields_like:Group, limit:30}` → 21 matches, one `is_mandatory:1` = `CustomerGroupId` → `CustTable.CustGroup`; `d365_check_field_exists {table_name:CustTable, field_names:[CustGroup]}` → exists | **CustTable.CustGroup** | 2,957 |
| 4 | Grandparent of SalesFormLetter_Invoice | `d365_get_class_methods {name:SalesFormLetter_Invoice, limit:1}` → `extends_class: SalesFormLetter`; `d365_get_class_methods {name:SalesFormLetter, limit:1}` → `extends_class` | **FormLetterServiceController** | 895 |
| 5 | documentStatus() of SalesFormLetter_Invoice | `d365_get_class_methods {name:SalesFormLetter_Invoice, filter:documentStatus, limit:5}` → one method; `d365_get_method_source {owner_name:SalesFormLetter_Invoice, method_name:documentStatus}` → `return DocumentStatus::Invoice;` | **Invoice** | 679 |
| 6 | Publisher of the model declaring LedgerJournalTrans | `d365_lookup_table {table_name:LedgerJournalTrans, field_limit:1}` → `module_id: ApplicationSuite`; `d365_get_module_summary {module_name:ApplicationSuite, table_limit:1, class_limit:1}` → every model's `publisher` | **Microsoft Corporation** | 37,822 |
| 7 | CustGroup referencing tables − one-hop FK targets | `d365_find_referencing_tables {table_name:CustGroup, limit:1}` → `reference_count: 82`; `d365_graph_traverse {start_node:CustGroup, max_depth:1}` → `node_count: 8` | **74** | 938 |
| 8 | PurchStatus: name of value 2 | `d365_lookup_table {table_name:PurchTable, fields_like:PurchStatus}` → `enum_type: PurchStatus`; `d365_get_enum {enum_names:[SalesStatus, PurchStatus]}` → PurchStatus value 2 | **Received** | 19,427 |
| 9 | Largest Microsoft extension model on CustTable / VendTable | `d365_effective_schema {table_name:CustTable, field_limit:1}` → `contributing_models`: CreditManagement 19 (microsoft, extension); `d365_effective_schema {table_name:VendTable, field_limit:1}` → no CreditManagement row → 0 | **CreditManagement,19,0** | 35,238 |
| 10 | Invoice header→lines composite key size | `d365_sql_template {}` → template 2 "Customer Invoice with Lines … (4-field key)"; `d365_get_join_keys {table1:CustInvoiceJour, table2:CustInvoiceTrans}` → relation `CustInvoiceJour` has 4 `join_pairs` | **4** | 4,284 |

Notes

- Questions 6 and 9 are expensive by construction (`d365_lookup_table` ships indexes and
  relations even at `field_limit:1`; `d365_effective_schema` likewise). They are kept
  because the fact is only reachable that way today; they are deliberately **not** in
  the budget file. `d365_search {query:LedgerJournalTrans, object_type:table, limit:1}` was
  tried as the cheap route to a table's module and returns an FTS context hit on another
  table first — not a reliable substitute.
- `d365_field_renames` returns `rename_count: 0` for CustTable, LedgerTrans, InventTable,
  CustTrans and SalesLine on this snapshot, so no rename question was possible.
- Question 8: `d365_lookup_table {fields_like:"Status"}` on PurchTable matches 6 fields,
  one of them the custom `TBG_StatusUpdate`; the recorded call narrows to `PurchStatus`.
