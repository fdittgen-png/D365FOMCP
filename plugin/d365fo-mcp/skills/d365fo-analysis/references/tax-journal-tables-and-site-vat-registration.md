# Part 24: Tax Journal Tables and Site VAT Registration

_Reference for the `d365fo-analysis` skill. Read on demand._


### 24.1 Overview

When retrieving VAT registration numbers for sales and purchase documents (Confirmations, Quotations, Invoices, Purchase Orders), there are two distinct paths:

| Path | Source | Use Case |
|------|--------|----------|
| **Customer Master** | DirPartyLocation → TaxRegistration | Customer's VAT number |
| **Site/Company Tax** | TaxTable → TaxPeriodHead → TaxRegistration | Company/Site VAT for tax reporting |

This section covers the **Site/Company Tax path** - retrieving the VAT number associated with the tax period configuration.

### 24.2 Key Tables and Relationships

```
DocumentJour (CustConfirmJour, CustQuotationJour, CustInvoiceJour, VendPurchOrderJour)
       │
       │ TaxJournalTrans (for Confirm/Quote/PurchOrder) or TaxTrans (for Invoice)
       │ JOIN: TRANSTABLEID + TRANSRECID / VOUCHER + TRANSDATE
       ▼
TAXJOURNALTRANS / TAXTRANS
       │
       │ JOIN: TaxCode + DataAreaId
       ▼
TAXTABLE
       │
       │ JOIN: TaxPeriod + DataAreaId
       ▼
TAXPERIODHEAD
       │
       │ JOIN: TaxId → RecId
       ▼
TAXREGISTRATION
       │
       └── REGISTRATIONNUMBER (VAT Number)
```

### 24.3 Key TableIds (from SQLDICTIONARY)

| Table | TableId | Usage |
|-------|---------|-------|
| CustConfirmJour | 5713 | Sales Order Confirmations |
| CustQuotationJour | 13933 | Sales Quotations |
| CustInvoiceJour | 6391 | Customer Invoices |
| VendPurchOrderJour | 3652 | Purchase Order Confirmations |
| TaxJournalTrans | 11480 | Tax transactions (pre-posting) |
| TaxTrans | - | Tax transactions (posted) |
| TaxTable | 23562 | Tax code definitions |
| TaxPeriodHead | - | Tax period headers |
| TaxRegistration | 6185 | Tax registration numbers |

### 24.4 Critical: Different Join Methods per Document Type

| Document Type | Tax Link Table | Join Method |
|---------------|----------------|-------------|
| **CustConfirmJour** | TaxJournalTrans | `TRANSTABLEID = 5713 AND TRANSRECID = ccj.RECID` |
| **CustQuotationJour** | TaxJournalTrans | `TRANSTABLEID = 13933 AND TRANSRECID = cqj.RECID` |
| **CustInvoiceJour** | TaxTrans | `VOUCHER = cij.LEDGERVOUCHER AND TRANSDATE = cij.INVOICEDATE` |
| **VendPurchOrderJour** | TaxJournalTrans | `TRANSTABLEID = 3652 AND TRANSRECID = vpoj.RECID` |

**Key Insights:**
- CustInvoiceJour uses `TaxTrans` (posted tax) via voucher/date join, NOT `TaxJournalTrans`.
- VendPurchOrderJour uses `TaxJournalTrans` (unposted tax) like CustConfirmJour/CustQuotationJour.

### 24.5 SQL Query - CustConfirmJour VAT via TaxPeriodHead

```sql
SELECT DISTINCT
    ccj.CONFIRMID,
    ccj.SALESID,
    ccj.CONFIRMDATE,
    ccj.DATAAREAID,
    tjt.TAXCODE,
    tt.TAXPERIOD,
    tr.REGISTRATIONNUMBER AS VATNumber
FROM CUSTCONFIRMJOUR ccj
INNER JOIN TAXJOURNALTRANS tjt
    ON tjt.TRANSTABLEID = 5713  -- CustConfirmJour TableId
    AND tjt.TRANSRECID = ccj.RECID
    AND tjt.DATAAREAID = ccj.DATAAREAID
INNER JOIN TAXTABLE tt
    ON tt.TAXCODE = tjt.TAXCODE
    AND tt.DATAAREAID = tjt.DATAAREAID
INNER JOIN TAXPERIODHEAD tph
    ON tph.TAXPERIOD = tt.TAXPERIOD
    AND tph.DATAAREAID = tt.DATAAREAID
INNER JOIN TAXREGISTRATION tr
    ON tr.RECID = tph.TAXID
WHERE ccj.DATAAREAID = @DataAreaId
ORDER BY ccj.CONFIRMDATE DESC;
```

### 24.6 SQL Query - CustQuotationJour VAT via TaxPeriodHead

```sql
SELECT DISTINCT
    cqj.QUOTATIONID,
    cqj.QUOTATIONDATE,
    cqj.DATAAREAID,
    tjt.TAXCODE,
    tt.TAXPERIOD,
    tr.REGISTRATIONNUMBER AS VATNumber
FROM CUSTQUOTATIONJOUR cqj
INNER JOIN TAXJOURNALTRANS tjt
    ON tjt.TRANSTABLEID = 13933  -- CustQuotationJour TableId
    AND tjt.TRANSRECID = cqj.RECID
    AND tjt.DATAAREAID = cqj.DATAAREAID
INNER JOIN TAXTABLE tt
    ON tt.TAXCODE = tjt.TAXCODE
    AND tt.DATAAREAID = tjt.DATAAREAID
INNER JOIN TAXPERIODHEAD tph
    ON tph.TAXPERIOD = tt.TAXPERIOD
    AND tph.DATAAREAID = tt.DATAAREAID
INNER JOIN TAXREGISTRATION tr
    ON tr.RECID = tph.TAXID
WHERE cqj.DATAAREAID = @DataAreaId
ORDER BY cqj.QUOTATIONDATE DESC;
```

### 24.7 SQL Query - CustInvoiceJour VAT via TaxTrans + TaxPeriodHead

```sql
-- NOTE: CustInvoiceJour uses TaxTrans (via VOUCHER/TRANSDATE), NOT TaxJournalTrans
SELECT DISTINCT
    cij.INVOICEID,
    cij.INVOICEDATE,
    cij.DATAAREAID,
    tx.TAXCODE,
    tt.TAXPERIOD,
    tr.REGISTRATIONNUMBER AS VATNumber
FROM CUSTINVOICEJOUR cij
INNER JOIN TAXTRANS tx
    ON tx.VOUCHER = cij.LEDGERVOUCHER
    AND tx.TRANSDATE = cij.INVOICEDATE
    AND tx.DATAAREAID = cij.DATAAREAID
INNER JOIN TAXTABLE tt
    ON tt.TAXCODE = tx.TAXCODE
    AND tt.DATAAREAID = tx.DATAAREAID
INNER JOIN TAXPERIODHEAD tph
    ON tph.TAXPERIOD = tt.TAXPERIOD
    AND tph.DATAAREAID = tt.DATAAREAID
INNER JOIN TAXREGISTRATION tr
    ON tr.RECID = tph.TAXID
WHERE cij.DATAAREAID = @DataAreaId
ORDER BY cij.INVOICEDATE DESC;
```

### 24.8 SQL Query - VendPurchOrderJour VAT via TaxPeriodHead

```sql
SELECT DISTINCT
    vpoj.PURCHID,
    vpoj.PURCHORDERCONFIRMATIONDATE,
    vpoj.DATAAREAID,
    tjt.TAXCODE,
    tt.TAXPERIOD,
    tr.REGISTRATIONNUMBER AS VATNumber
FROM VENDPURCHORDERJOUR vpoj
INNER JOIN TAXJOURNALTRANS tjt
    ON tjt.TRANSTABLEID = 3652  -- VendPurchOrderJour TableId
    AND tjt.TRANSRECID = vpoj.RECID
    AND tjt.DATAAREAID = vpoj.DATAAREAID
INNER JOIN TAXTABLE tt
    ON tt.TAXCODE = tjt.TAXCODE
    AND tt.DATAAREAID = tjt.DATAAREAID
INNER JOIN TAXPERIODHEAD tph
    ON tph.TAXPERIOD = tt.TAXPERIOD
    AND tph.DATAAREAID = tt.DATAAREAID
INNER JOIN TAXREGISTRATION tr
    ON tr.RECID = tph.TAXID
WHERE vpoj.DATAAREAID = @DataAreaId
ORDER BY vpoj.PURCHORDERCONFIRMATIONDATE DESC;
```

### 24.9 Lasernet Report Wizard Chains

For Lasernet reports, the default relations work correctly in the Report Wizard:

| Document | Chain |
|----------|-------|
| Sales Confirmation | `CustConfirmJour → TaxJournalTrans → TaxTable → TaxPeriodHead → TaxRegistration` |
| Sales Quotation | `CustQuotationJour → TaxJournalTrans → TaxTable → TaxPeriodHead → TaxRegistration` |
| Sales Invoice | `CustInvoiceJour → TaxTrans → TaxTable → TaxPeriodHead → TaxRegistration` |
| Purchase Order | `VendPurchOrderJour → TaxJournalTrans → TaxTable → TaxPeriodHead → TaxRegistration` |

**Target field:** `TaxRegistration.RegistrationNumber`

### 24.10 TaxPeriodHead Key Fields

| Field | Type | Purpose |
|-------|------|---------|
| TAXPERIOD | nvarchar(10) | Tax period identifier (e.g., 'NO-M', 'SE-M') |
| TAXID | bigint | FK to TaxRegistration.RecId |
| TAXAUTHORITY | nvarchar(10) | Tax authority code |
| PERIODUNIT | int | Period type (monthly, quarterly) |
| DATAAREAID | nvarchar(4) | Legal entity |

### 24.11 Important: TaxPeriodHead.TaxId Configuration

The `TaxPeriodHead.TAXID` field must be populated for this query path to work. Not all companies have this configured.

**Query to check configured companies:**
```sql
SELECT
    tph.DATAAREAID,
    tph.TAXPERIOD,
    tr.REGISTRATIONNUMBER AS VATNumber
FROM TAXPERIODHEAD tph
INNER JOIN TAXREGISTRATION tr ON tr.RECID = tph.TAXID
ORDER BY tph.DATAAREAID, tph.TAXPERIOD;
```

**Example configured companies (January 2026):**
| Company | Tax Period | VAT Number |
|---------|------------|------------|
| llnl | NL-M | NL001818089B01 |
| llnl | NO-BIM | NO984246781MVA |
| llnl | PL-M | 5251007278PLN |
| llnl | SE-Q | SE502045499601 |
| roda | DK_QUATER | DK31348757 |
| roda | SE_QUATER | SE502092931001 |
| spno | NO-M | NO931704699MVA |
| spno | SE-M | SE502063389601 |

### 24.12 TaxDocumentRowTransaction (Tax Engine)

For scenarios using the **Tax Engine** (GTE - Globalization Tax Engine), a different path is used:

```
DocumentJour → TaxDocumentRowTransaction → TaxDocumentComponentTransaction
                         │
                         ▼
                    TaxRegistration (via TAXID)
```

**Key Fields in TaxDocumentRowTransaction:**
| Field | Purpose |
|-------|---------|
| TRANSACTIONHEADERTABLEID | TableId of source document |
| TRANSACTIONHEADERRECID | RecId of source document |
| TAXID | FK to TaxRegistration.RecId |

**Note:** TaxDocumentRowTransaction typically links to **working tables** (SalesParmTable, CustInvoiceTable), not journal tables.

### 24.13 Common Mistakes

| Mistake | Symptom | Solution |
|---------|---------|----------|
| Using TaxJournalTrans for CustInvoiceJour | 0 rows returned | Use TaxTrans with VOUCHER/TRANSDATE join |
| Missing DataAreaId on joins | Cross-company data leakage | Always include `AND t.DATAAREAID = source.DATAAREAID` |
| TaxPeriodHead.TaxId not configured | NULL VAT numbers | Check company configuration or use Customer Master path |
| Using SourceTableId/SourceRecId on TaxTrans | 0 rows returned | Use VOUCHER + TRANSDATE for CustInvoiceJour |

### 24.14 Reference Script

Complete PowerShell script for all queries: `C:\Temp\query_d365.ps1`

