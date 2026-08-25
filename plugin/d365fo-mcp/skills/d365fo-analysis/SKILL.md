---
name: d365fo-analysis
description: Core D365FO analysis knowledge base — architecture, product data model, Engineering Change Management, number sequences, DMF, dimension framework, DocuRef, site/tax registration data models, standard costing, cleanup jobs, custom scripts. Use for data-model, posting, ECM, product, tax-registration, or deep troubleshooting analysis.
---

# D365FO Analysis Skill

Verified domain knowledge for analysing Microsoft Dynamics 365 Finance & Operations. Every reference file below was validated against AOT metadata and/or a live database; where a claim is inferred rather than verified the file says so.

**How to use with the MCP services:** this skill tells you *where to look and what the trap is*; the MCP tools (`d365kb`, `d365xref`, `d365sec`) confirm the current build. Always re-verify a table/field/method named here with `d365_lookup_table` / `d365_check_field_exists` / `d365_get_method_source` before quoting it in a deliverable — the `d365fo-mcp-tooling` skill has the rules.

## Decision guide — which reference to read

| Question is about… | Read |
|---|---|
| Package/model layout, layers, PackagesLocalDirectory, AOT object types | `references/d365fo-architecture.md` |
| Products, released products, variants, `EcoResProduct` vs `InventTable`, item vs product number | `references/product-data-model-core-knowledge.md`, `references/product-number-flow-critical-knowledge.md` |
| Engineering Change Management (engineering products, versions, change orders, release to companies) | `references/engineering-change-management-ecm-deep-dive.md`, `references/x-design-patterns-in-ecm.md`, `references/key-methods-reference.md` |
| Number sequences (setup, `NumberSeqModule*`, scopes, continuous vs non-continuous, nomenclature) | `references/number-sequences-and-nomenclature-deep-dive.md` |
| `changeCompany`, cross-company queries, `DataAreaId` pitfalls | `references/cross-company-operations.md` |
| Data entities for products/ECM; DMF framework internals, staging, execution, validation depth | `references/data-entity-reference.md`, `references/data-management-framework-dmf-deep-dive.md` |
| Querying D365 data through Dataverse / Synapse Link (schema differences, enum handling) | `references/dataverse-azure-synapse-link-queries.md` |
| Licences, environments, storage/capacity governance | `references/governance-framework-licenses-environments-capacity.md` |
| Cleanup batch jobs (which one, what it deletes, safety order) | `references/cleanup-batch-jobs-reference.md` |
| Custom Scripts feature (`AppConsistencyCustomScript`, upload/approve/run, packaging) | `references/custom-scripts-feature-appconsistencycustomscript.md`, `references/custom-script-development-tooling.md` |
| Financial / default dimensions (`DimensionAttributeValueSet*`, DAVC decode) | `references/d365fo-dimension-framework.md` |
| Document attachments (`DocuRef`) cross-company and ordering bugs | `references/docuref-critical-patterns-cross-company-ordering.md` |
| Site addresses, VAT registration per site, tax journal tables (`TaxTrans`, `TaxPeriodHead`), document impact | `references/site-address-and-tax-registration-data-model.md`, `references/tax-journal-tables-and-site-vat-registration.md`, `references/site-vat-registration-document-impact-analysis.md` |
| Tax exempt number on order headers, the VATNum/VATNumTableType/VATNumRecId triple, TCS multiple-VAT-ID write-back | `references/tax-exempt-number-on-order-headers-the-tcs-multiple-vat-id-w.md` |
| Standard costing, `InventItemPrice` / `InventItemPriceSim`, costing versions | `references/inventitemprice-standard-costing-architecture.md` |
| Extension points and CoC targets in the product/ECM area | `references/extension-points.md` |
| Common ECM/product symptoms and their causes | `references/troubleshooting-guide.md` |
| Short D365FO-specific reminders (not generic best practices) | `references/best-practices.md` |

Load **one** file per question; they are self-contained. If two areas intersect (e.g. "VAT number on a sales confirmation printed via Lasernet"), read the tax-journal file first, then the document-impact file.

## Cross-cutting facts worth knowing before any reference

- `EcoResProduct.RecId` is the product key; `InventTable.ItemId` is the *released* product key per company. They are different objects joined through `InventTable.Product`.
- `DataAreaId` is a filter, not a key: most tables are per-company; `Global` tables (e.g. `EcoResProduct`, `DirPartyTable`) are not. Cross-company reads need `crossCompany` / `changeCompany`.
- Enum values in SQL are integers; resolve them with `d365_get_enum` rather than guessing.
- Dates use `1900-01-01` as the null sentinel, not `NULL`.
- Field names changed between AX2012 and D365FO in several posting tables — the `d365fo-sql-direct-queries` skill has the rename list; `d365_field_renames` has it live.
