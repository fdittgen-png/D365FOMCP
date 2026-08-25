---
name: d365fo-sql-direct-queries
description: Verified SQL reference for querying D365FO databases directly — table schemas, join keys, AX2012 field renames, template queries, and the pitfalls that prevent column-name hallucination. Use before writing any SQL against AxDB, BYOD, database copies, or the KB/XRef/Sec MCP raw_sql tools.
---

# D365FO SQL Direct Query Skill

Reference for writing correct SQL against D365FO databases (AxDB, BYOD exports, database copies). It encodes verified table structures, join keys, field renames and pitfalls — designed to stop column-name hallucination and incomplete join keys.

**Validation source:** D365FO 10.0.2263.172 metadata XML + live `INFORMATION_SCHEMA` (2026-02-23). Newer builds may add columns; they very rarely rename them.

## Before you write a query

1. **Confirm every column with the KB MCP** — `d365_check_field_exists` (single field) or `d365_lookup_table` (whole table). This is cheaper than a failed query and catches renamed AX2012 fields.
2. **Get composite join keys from `d365_get_join_keys`**, then compare with the verified joins in the references. Header→line joins in D365FO are almost never single-column.
3. **Resolve enums with `d365_get_enum`** — the integer in the database is meaningless without it.
4. **Run `d365_hallucination_check`** on any field or table name you are not 100 % sure about.
5. For the MCP `*_raw_sql` tools the schema is *not* the AxDB schema — read `d365fo-mcp-tooling/references/kb-raw-sql-schema.md` instead.

## Decision guide — which reference to read

| Need | Read |
|---|---|
| The rules every D365FO SQL query must obey (DataAreaId/Partition, RecId, date sentinel, enum ints, `UPPER` casing, cross-company tables) | `references/critical-d365fo-sql-concepts.md` |
| "Column X does not exist" — AX2012 → D365FO rename list, plus fields LLMs invent that never existed | `references/ax2012-to-d365fo-field-name-renames.md` |
| Exact column names and composite join keys for CustInvoiceJour/Trans, VendInvoiceJour/Trans, SalesTable/Line, PurchTable/Line, GeneralJournalEntry/AccountEntry, InventTrans, DirParty/LogisticsPostalAddress | `references/verified-table-schemas-join-keys.md` |
| Copy-paste template queries (customer invoices with lines, vendor invoices, GL entries with dimensions, inventory transactions, on-hand) | `references/template-queries-verified.md` |
| Less common but frequently needed tables (MCR order events, holds, InventDim, WHS work, LedgerJournal) | `references/additional-common-tables-quick-reference.md` |
| Query performance on large tables (`NOLOCK`, index-friendly predicates, avoiding functions on indexed columns) | `references/performance-notes.md` |
| Standard cost prices: `INVENTITEMPRICE` vs `INVENTITEMPRICESIM`, activation, costing version joins | `references/inventitemprice-active-cost-prices-verified.md` |

## The five mistakes that cause most wrong queries

1. Joining header to line on a single column (e.g. `INVOICEID` alone) — the verified keys include `SALESID`/`PURCHID`, `INVOICEDATE`, `NUMBERSEQUENCEGROUP`, `DATAAREAID`.
2. Using an AX2012 field name (`CUSTGROUP` on `CustInvoiceJour`, `INVOICEACCOUNT` where D365 uses `INVOICEACCOUNT` vs `ORDERACCOUNT` semantics, …) — check the rename file.
3. Filtering by `DATAAREAID` on a table that is cross-company (`GeneralJournalEntry`, `DirPartyTable`, `EcoResProduct`).
4. Treating `CustTrans.TransType` as containing an "Invoice" value — it is `LedgerTransType` (Sales = 2, Cust = 8, Project = 6, Payment = 15).
5. Comparing dates to `NULL` — D365FO stores `1900-01-01`.
