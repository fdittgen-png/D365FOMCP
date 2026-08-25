# Part 6: Performance Notes

_Reference for the `d365fo-sql-direct-queries` skill. Read on demand._


### 6.1 NOLOCK Hints
Always use `WITH (NOLOCK)` on read-only reporting queries against large tables:
```sql
FROM INVENTTRANS IT WITH (NOLOCK)
```

### 6.2 Date Range Patterns
Use exclusive upper bound for date ranges (sargable):
```sql
WHERE INVOICEDATE >= '2025-01-01' AND INVOICEDATE < '2026-01-01'
```
Do NOT use: `YEAR(INVOICEDATE) = 2025` (not sargable, kills index usage).

### 6.3 Large Table Warnings
These tables are typically very large and need targeted WHERE clauses:
- INVENTTRANS (millions of rows)
- GENERALJOURNALACCOUNTENTRY (millions of rows)
- LEDGERJOURNALTRANS (millions of rows)
- DIMENSIONATTRIBUTEVALUECOMBINATION (hundreds of thousands)

