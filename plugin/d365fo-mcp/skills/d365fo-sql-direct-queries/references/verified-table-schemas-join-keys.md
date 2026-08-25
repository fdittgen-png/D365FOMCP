# Part 3: Verified Table Schemas & Join Keys

_Reference for the `d365fo-sql-direct-queries` skill. Read on demand._


### 3.1 Customer Invoices

**Tables**: `CUSTINVOICEJOUR` (header) + `CUSTINVOICETRANS` (lines)

**Join — 4-field composite key** (verified from metadata Composition relation):
```sql
INNER JOIN CUSTINVOICETRANS L
    ON  L.DATAAREAID          = H.DATAAREAID
    AND L.SALESID             = H.SALESID              -- Often omitted — CRITICAL
    AND L.INVOICEID           = H.INVOICEID
    AND L.INVOICEDATE         = H.INVOICEDATE
    AND L.NUMBERSEQUENCEGROUP = H.NUMBERSEQUENCEGROUP
```

**CustInvoiceJour key columns**:
| Column | Purpose |
|--------|---------|
| DATAAREAID | Legal entity |
| INVOICEDATE | Invoice posting date |
| INVOICEID | Invoice number |
| ORDERACCOUNT | Customer account (sales order) |
| INVOICEACCOUNT | Invoice-to customer |
| INVOICEAMOUNT | Amount in transaction currency |
| INVOICEAMOUNTMST | Amount in accounting currency |
| CURRENCYCODE | Transaction currency |
| SALESID | Sales order ID |
| PURCHASEORDER | Customer's PO number |
| PAYMENT | Payment terms code |
| DUEDATE | Due date |
| NUMBERSEQUENCEGROUP | Number sequence group |
| LEDGERVOUCHER | GL voucher number |

**CustInvoiceTrans key columns**:
| Column | Purpose |
|--------|---------|
| SALESID | Sales order ID (part of composite key) |
| INVOICEID | Invoice number |
| INVOICEDATE | Invoice date |
| NUMBERSEQUENCEGROUP | Number sequence group |
| LINENUM | Line number |
| ITEMID | Item ID |
| NAME | Item description |
| QTY | Invoiced quantity |
| SALESUNIT | Unit of measure |
| SALESPRICE | Unit price |
| LINEAMOUNT | Line amount (transaction currency) |
| LINEAMOUNTMST | Line amount (accounting currency) |
| TAXAMOUNT | Tax amount |
| INVENTDIMID | Inventory dimension ID |
| INVENTTRANSID | Inventory transaction ID |
| PARENTRECID | FK to CustInvoiceJour.RECID |

---

### 3.2 Vendor Invoices

**Tables**: `VENDINVOICEJOUR` (header) + `VENDINVOICETRANS` (lines)

**Join — 5-field composite key** (verified from metadata Composition relation):
```sql
INNER JOIN VENDINVOICETRANS L
    ON  L.DATAAREAID          = H.DATAAREAID
    AND L.PURCHID             = H.PURCHID              -- Often omitted — CRITICAL
    AND L.INVOICEID           = H.INVOICEID
    AND L.INVOICEDATE         = H.INVOICEDATE
    AND L.NUMBERSEQUENCEGROUP = H.NUMBERSEQUENCEGROUP
    AND L.INTERNALINVOICEID   = H.INTERNALINVOICEID    -- Often omitted — CRITICAL
```

**VendInvoiceJour key columns**:
| Column | Purpose |
|--------|---------|
| DATAAREAID | Legal entity |
| INVOICEDATE | Invoice posting date |
| INVOICEID | Vendor invoice number |
| ORDERACCOUNT | Vendor account (PO) |
| INVOICEACCOUNT | Invoice-from vendor |
| INVOICEAMOUNT | Amount in transaction currency |
| INVOICEAMOUNTMST | Amount in accounting currency |
| CURRENCYCODE | Transaction currency |
| PURCHID | Purchase order ID |
| PAYMENT | Payment terms code |
| DUEDATE | Due date |
| DOCUMENTDATE | Document date |
| INTERNALINVOICEID | Internal invoice sequence |
| NUMBERSEQUENCEGROUP | Number sequence group |
| LEDGERVOUCHER | GL voucher number |

**VendInvoiceTrans key columns**:
| Column | Purpose |
|--------|---------|
| PURCHID | Purchase order ID (part of composite key) |
| INVOICEID | Invoice number |
| INVOICEDATE | Invoice date |
| NUMBERSEQUENCEGROUP | Number sequence group |
| INTERNALINVOICEID | Internal invoice ID (part of composite key) |
| LINENUM | Line number |
| ITEMID | Item ID |
| NAME | Item description (NOT ProductName) |
| QTY | Invoiced quantity |
| PURCHUNIT | Unit of measure (NOT Unit) |
| PURCHPRICE | Unit price |
| LINEAMOUNT | Line amount (transaction currency) |
| LINEAMOUNTMST | Line amount (accounting currency) |
| TAXAMOUNT | Tax amount |
| INVENTTRANSID | Inventory transaction ID |
| INVENTDIMID | Inventory dimension ID |

---

### 3.3 General Ledger — Posted Journal Entries

**Tables**: `GENERALJOURNALENTRY` (header, cross-company) + `GENERALJOURNALACCOUNTENTRY` (lines)

**Join — RecId-based**:
```sql
INNER JOIN GENERALJOURNALACCOUNTENTRY GJAE
    ON GJAE.GENERALJOURNALENTRY = GJE.RECID
```

**Legal entity filter** (NO DATAAREAID on GJE):
```sql
WHERE GJE.SUBLEDGERVOUCHERDATAAREAID = 'spno'
```

**GeneralJournalEntry key columns**:
| Column | Purpose | Notes |
|--------|---------|-------|
| RECID | Primary key | Used by GJAE FK |
| ACCOUNTINGDATE | Posting date | Main date filter |
| JOURNALNUMBER | Journal number | |
| SUBLEDGERVOUCHER | Voucher number | NOT "Voucher" |
| SUBLEDGERVOUCHERDATAAREAID | Legal entity | THE company filter |
| LEDGER | Ledger RecId | FK to Ledger table |
| FISCALCALENDARPERIOD | Period RecId | |
| POSTINGLAYER | Posting layer | 0=Current, 1=Operations, etc. |
| DOCUMENTNUMBER | Document number | |
| DOCUMENTDATE | Document date | |

**GeneralJournalAccountEntry key columns**:
| Column | Purpose | Notes |
|--------|---------|-------|
| GENERALJOURNALENTRY | FK to GJE.RECID | Join field |
| LEDGERDIMENSION | FK to DAVC.RECID | Dimension combination |
| MAINACCOUNT | FK to MainAccount.RECID | Direct main account reference |
| ACCOUNTINGCURRENCYAMOUNT | Amount in accounting currency | Debit=positive, Credit=negative |
| REPORTINGCURRENCYAMOUNT | Amount in reporting currency | |
| TRANSACTIONCURRENCYAMOUNT | Amount in transaction currency | |
| TRANSACTIONCURRENCYCODE | Transaction currency | |
| ISCREDIT | Credit flag | 1=Credit, 0=Debit (NOT IsDebit) |
| TEXT | Description | |
| POSTINGTYPE | Posting type enum | LedgerPostingType values |

---

### 3.4 Dimension Decode — Main Account

**Simplified 2-table approach** (verified: DAVC has direct MAINACCOUNT FK):
```sql
INNER JOIN DIMENSIONATTRIBUTEVALUECOMBINATION DAVC
    ON DAVC.RECID = GJAE.LEDGERDIMENSION
LEFT JOIN MAINACCOUNT MA
    ON MA.RECID = DAVC.MAINACCOUNT
```

**Key DAVC columns**:
| Column | Purpose |
|--------|---------|
| RECID | Primary key |
| MAINACCOUNT | FK to MainAccount.RECID |
| MAINACCOUNTVALUE | Main account ID string (human-readable) |
| DISPLAYVALUE | Full dimension combination string (e.g., "60100-001-022") |
| DEPARTMENT / DEPARTMENTVALUE | Department dimension |
| COSTCENTER / COSTCENTERVALUE | Cost center dimension |

**Key MainAccount columns**:
| Column | Purpose |
|--------|---------|
| RECID | Primary key |
| MAINACCOUNTID | Account number string |
| NAME | Account name |
| TYPE | Account type (0=ProfitAndLoss, 1=Revenue, 2=Expense, etc.) |
| LEDGERCHARTOFACCOUNTS | FK to chart of accounts |

**Do NOT use the 4-table DAVSI/DAV chain** for main account decode — it is unnecessary overhead. The chain through DIMENSIONATTRIBUTEVALUESETITEM → DIMENSIONATTRIBUTEVALUE → MainAccount.RECID (via EntityInstance) is the generic dimension resolution path needed only for custom/financial dimensions, not for the main account.

---

### 3.5 Inventory Transactions

**Tables**: `INVENTTRANS` + `INVENTTRANSORIGIN` + `INVENTDIM`

**Joins**:
```sql
INNER JOIN INVENTTRANSORIGIN ITO
    ON ITO.RECID = IT.INVENTTRANSORIGIN          -- RecId-based FK
INNER JOIN INVENTDIM ID
    ON ID.DATAAREAID = IT.DATAAREAID
    AND ID.INVENTDIMID = IT.INVENTDIMID           -- Natural key join
```

**InventTrans key columns**:
| Column | Purpose | Notes |
|--------|---------|-------|
| DATAAREAID | Legal entity | |
| DATEFINANCIAL | Financial posting date | Use for "posted in year" filter |
| DATEPHYSICAL | Physical posting date | |
| DATEINVENT | Inventory date | |
| VOUCHER | Financial voucher | |
| VOUCHERPHYSICAL | Physical voucher | Separate field |
| ITEMID | Item ID | |
| QTY | Quantity | Negative=issue, Positive=receipt |
| COSTAMOUNTPOSTED | Financial cost amount | |
| COSTAMOUNTPHYSICAL | Physical cost amount | |
| COSTAMOUNTADJUSTMENT | Adjustment amount | |
| COSTAMOUNTSETTLED | Settled cost | |
| CURRENCYCODE | Transaction currency | |
| INVENTDIMID | FK to InventDim | Natural key |
| INVENTTRANSORIGIN | FK to InventTransOrigin.RECID | RecId-based |
| STATUSISSUE | Issue status enum | 1=Sold (financially posted) |
| STATUSRECEIPT | Receipt status enum | 1=Purchased (financially posted) |
| INVOICEID | Related invoice ID | |
| PACKINGSLIPID | Related packing slip | |

**DIRECTION does NOT exist** — derive it:
```sql
CASE WHEN IT.QTY < 0 THEN 'Issue' ELSE 'Receipt' END AS Direction
```

**InventTransOrigin key columns**:
| Column | Purpose |
|--------|---------|
| RECID | Primary key (joined from InventTrans) |
| INVENTTRANSID | Inventory transaction ID (lot ID) |
| ITEMID | Item ID |
| REFERENCECATEGORY | Source document type |
| REFERENCEID | Source document ID |

**InventDim key columns**:
| Column | Purpose |
|--------|---------|
| DATAAREAID + INVENTDIMID | Composite key |
| INVENTLOCATIONID | Warehouse |
| INVENTSITEID | Site |
| WMSLOCATIONID | WMS location |
| INVENTBATCHID | Batch number |
| INVENTSERIALID | Serial number |
| CONFIGID | Configuration |
| INVENTSIZEID | Size |
| INVENTCOLORID | Color |
| INVENTSTYLEID | Style |

---

### 3.6 LedgerJournalTrans (Alternative GL Query)

**Tables**: `LEDGERJOURNALTABLE` (header) + `LEDGERJOURNALTRANS` (lines)

**Join**:
```sql
INNER JOIN LEDGERJOURNALTABLE LJH
    ON LJH.DATAAREAID = LJT.DATAAREAID
    AND LJH.JOURNALNUM = LJT.JOURNALNUM
```

**Key fields on LedgerJournalTrans**:
| Column | Exists | Notes |
|--------|:------:|-------|
| JOURNALNUM | Yes | |
| VOUCHER | Yes | |
| TRANSDATE | Yes | |
| ACCOUNTTYPE | Yes | 0=Ledger, 1=Customer, 2=Vendor, 3=Project, 4=FixedAsset, 5=Bank |
| LEDGERDIMENSION | Yes | |
| AMOUNTCURDEBIT | Yes | Transaction currency debit |
| AMOUNTCURCREDIT | Yes | Transaction currency credit |
| AMOUNTCURDEBMST | **NO** | Does not exist — calculated at runtime |
| AMOUNTCURCREDMST | **NO** | Does not exist — calculated at runtime |
| CURRENCYCODE | Yes | |
| TXT | Yes | Description |
| OFFSETACCOUNTTYPE | Yes | |
| OFFSETLEDGERDIMENSION | Yes | |
| POSTED | **NO** | Lives on LedgerJournalTable, not here |

**Key fields on LedgerJournalTable**:
| Column | Purpose |
|--------|---------|
| JOURNALNUM | Primary key (per company) |
| JOURNALTYPE | 0=Daily, 1=Allocation, 5=VendInvoiceRegister, 9=Payment |
| POSTED | 0=Not posted, 1=Posted |
| JOURNALNAME | Journal name |

**Posted filter must go through header**:
```sql
WHERE LJH.POSTED = 1
```

