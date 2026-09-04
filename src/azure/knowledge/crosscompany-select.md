---
topic: crosscompany-select
title: crossCompany selects and company context
aliases: crosscompany, changecompany, dataareaid, multi-company
tags: x++, select, company, dataareaid, query
---
- Tables with `SaveDataPerCompany = Yes` carry `DataAreaId`; a plain `select` is implicitly filtered to the CURRENT company (`curExt()`). `d365_lookup_table` shows `save_per_company`.
- `select crossCompany * from custTable` returns rows from EVERY company the user has access to. `select crossCompany : companies * from custTable` restricts to a `container` of company ids. Always read `custTable.DataAreaId` in the result — rows from different companies can share the same natural key.
- `crossCompany` is a READ keyword for `select` and `while select` and for `Query` objects via `query.allowCrossCompany(true)` (+ `addCompanyRange`). To WRITE in another company use `changecompany(companyId) { ... }` and re-declare the buffer inside the block — a buffer selected before `changecompany` still belongs to the old company.
- Shared (`SaveDataPerCompany = No`) tables are not filtered and must not be queried with `crossCompany`.
- Joins across a per-company and a shared table need no company clause on the shared side; two per-company tables joined under `crossCompany` are matched on `DataAreaId` implicitly — verify with the generated SQL if in doubt.
- In direct SQL against AxDB/BYOD the same rule applies explicitly: `WHERE DATAAREAID = 'xxxx'` on every per-company table, on both sides of a join. `d365_sql_template` carries validated join templates.
