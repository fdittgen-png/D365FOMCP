# Part 4: Template Queries (Verified)

_Reference for the `d365fo-sql-direct-queries` skill. Read on demand._


### 4.1 Customer Invoices — Year Filter

```sql
DECLARE @LegalEntity NVARCHAR(4) = 'spno';
DECLARE @YearStart DATE = '2025-01-01';
DECLARE @YearEnd DATE = '2026-01-01';

SELECT
    H.DATAAREAID            AS LegalEntity,
    H.INVOICEDATE           AS InvoiceDate,
    H.INVOICEID             AS InvoiceNumber,
    H.ORDERACCOUNT          AS CustomerAccount,
    H.INVOICEAMOUNT         AS InvoiceAmount,
    H.INVOICEAMOUNTMST      AS InvoiceAmountMST,
    H.CURRENCYCODE          AS Currency,
    H.SALESID               AS SalesOrderId,
    H.PURCHASEORDER         AS CustomerPO,
    H.INVOICEACCOUNT        AS InvoiceAccount,
    H.PAYMENT               AS PaymentTerms,
    H.DUEDATE               AS DueDate,
    L.ITEMID                AS ItemId,
    L.NAME                  AS ItemDescription,
    L.QTY                   AS Quantity,
    L.SALESUNIT             AS UOM,
    L.SALESPRICE            AS UnitPrice,
    L.LINEAMOUNT            AS LineAmount,
    L.LINEAMOUNTMST         AS LineAmountMST,
    L.TAXAMOUNT             AS TaxAmount,
    L.INVENTDIMID           AS InventDimId,
    L.INVENTTRANSID         AS InventTransId
FROM CUSTINVOICEJOUR H WITH (NOLOCK)
INNER JOIN CUSTINVOICETRANS L WITH (NOLOCK)
    ON  L.DATAAREAID          = H.DATAAREAID
    AND L.SALESID             = H.SALESID
    AND L.INVOICEID           = H.INVOICEID
    AND L.INVOICEDATE         = H.INVOICEDATE
    AND L.NUMBERSEQUENCEGROUP = H.NUMBERSEQUENCEGROUP
WHERE H.DATAAREAID = @LegalEntity
  AND H.INVOICEDATE >= @YearStart
  AND H.INVOICEDATE <  @YearEnd
ORDER BY H.INVOICEDATE, H.INVOICEID, L.LINENUM;
```

### 4.2 Vendor Invoices — Year Filter

```sql
DECLARE @LegalEntity NVARCHAR(4) = 'spno';
DECLARE @YearStart DATE = '2025-01-01';
DECLARE @YearEnd DATE = '2026-01-01';

SELECT
    H.DATAAREAID            AS LegalEntity,
    H.INVOICEDATE           AS InvoiceDate,
    H.INVOICEID             AS InvoiceNumber,
    H.ORDERACCOUNT          AS VendorAccount,
    H.INVOICEACCOUNT        AS InvoiceAccount,
    H.INVOICEAMOUNT         AS InvoiceAmount,
    H.INVOICEAMOUNTMST      AS InvoiceAmountMST,
    H.CURRENCYCODE          AS Currency,
    H.PURCHID               AS PurchaseOrderId,
    H.PAYMENT               AS PaymentTerms,
    H.DUEDATE               AS DueDate,
    H.DOCUMENTDATE          AS DocumentDate,
    L.ITEMID                AS ItemId,
    L.NAME                  AS ItemDescription,
    L.QTY                   AS Quantity,
    L.PURCHUNIT             AS UOM,
    L.PURCHPRICE            AS UnitPrice,
    L.LINEAMOUNT            AS LineAmount,
    L.LINEAMOUNTMST         AS LineAmountMST,
    L.TAXAMOUNT             AS TaxAmount,
    L.INVENTTRANSID         AS InventTransId
FROM VENDINVOICEJOUR H WITH (NOLOCK)
INNER JOIN VENDINVOICETRANS L WITH (NOLOCK)
    ON  L.DATAAREAID          = H.DATAAREAID
    AND L.PURCHID             = H.PURCHID
    AND L.INVOICEID           = H.INVOICEID
    AND L.INVOICEDATE         = H.INVOICEDATE
    AND L.NUMBERSEQUENCEGROUP = H.NUMBERSEQUENCEGROUP
    AND L.INTERNALINVOICEID   = H.INTERNALINVOICEID
WHERE H.DATAAREAID = @LegalEntity
  AND H.INVOICEDATE >= @YearStart
  AND H.INVOICEDATE <  @YearEnd
ORDER BY H.INVOICEDATE, H.INVOICEID, L.LINENUM;
```

### 4.3 General Journal — Year Filter

```sql
DECLARE @LegalEntity NVARCHAR(10) = 'spno';
DECLARE @YearStart DATE = '2025-01-01';
DECLARE @YearEnd DATE = '2026-01-01';

SELECT
    GJE.SUBLEDGERVOUCHERDATAAREAID AS LegalEntity,
    GJE.ACCOUNTINGDATE          AS AccountingDate,
    GJE.JOURNALNUMBER           AS JournalNumber,
    GJE.SUBLEDGERVOUCHER        AS Voucher,
    DAVC.MAINACCOUNTVALUE       AS MainAccount,
    MA.NAME                     AS MainAccountName,
    DAVC.DISPLAYVALUE           AS FullDimensionString,
    GJAE.ACCOUNTINGCURRENCYAMOUNT AS AmountAccountingCurrency,
    GJAE.REPORTINGCURRENCYAMOUNT  AS AmountReportingCurrency,
    GJAE.TRANSACTIONCURRENCYAMOUNT AS AmountTransactionCurrency,
    GJAE.TRANSACTIONCURRENCYCODE AS TransactionCurrency,
    GJAE.ISCREDIT               AS IsCredit,
    GJAE.TEXT                   AS Description,
    GJAE.POSTINGTYPE            AS PostingType
FROM GENERALJOURNALENTRY GJE WITH (NOLOCK)
INNER JOIN GENERALJOURNALACCOUNTENTRY GJAE WITH (NOLOCK)
    ON GJAE.GENERALJOURNALENTRY = GJE.RECID
INNER JOIN DIMENSIONATTRIBUTEVALUECOMBINATION DAVC WITH (NOLOCK)
    ON DAVC.RECID = GJAE.LEDGERDIMENSION
LEFT JOIN MAINACCOUNT MA WITH (NOLOCK)
    ON MA.RECID = DAVC.MAINACCOUNT
WHERE GJE.SUBLEDGERVOUCHERDATAAREAID = @LegalEntity
  AND GJE.ACCOUNTINGDATE >= @YearStart
  AND GJE.ACCOUNTINGDATE <  @YearEnd
ORDER BY GJE.ACCOUNTINGDATE, GJE.SUBLEDGERVOUCHER, GJAE.RECID;
```

### 4.4 Inventory Transactions — Year Filter (Financially Posted)

```sql
DECLARE @LegalEntity NVARCHAR(4) = 'spno';
DECLARE @YearStart DATE = '2025-01-01';
DECLARE @YearEnd DATE = '2026-01-01';

SELECT
    IT.DATAAREAID               AS LegalEntity,
    IT.DATEPHYSICAL             AS DatePhysical,
    IT.DATEFINANCIAL            AS DateFinancial,
    IT.VOUCHER                  AS Voucher,
    IT.ITEMID                   AS ItemId,
    ITO.INVENTTRANSID           AS InventTransId,
    IT.QTY                      AS Quantity,
    CASE WHEN IT.QTY < 0 THEN 'Issue' ELSE 'Receipt' END AS Direction,
    IT.COSTAMOUNTPOSTED         AS CostAmountPosted,
    IT.COSTAMOUNTPHYSICAL       AS CostAmountPhysical,
    IT.COSTAMOUNTADJUSTMENT     AS CostAmountAdjustment,
    IT.CURRENCYCODE             AS Currency,
    IT.STATUSISSUE              AS StatusIssue,
    IT.STATUSRECEIPT            AS StatusReceipt,
    ID.INVENTSITEID             AS Site,
    ID.INVENTLOCATIONID         AS Warehouse,
    ID.WMSLOCATIONID            AS Location,
    ID.INVENTBATCHID            AS BatchId,
    ID.INVENTSERIALID           AS SerialId,
    ID.CONFIGID                 AS ConfigId,
    ID.INVENTSIZEID             AS SizeId,
    ID.INVENTCOLORID            AS ColorId
FROM INVENTTRANS IT WITH (NOLOCK)
INNER JOIN INVENTTRANSORIGIN ITO WITH (NOLOCK)
    ON ITO.RECID = IT.INVENTTRANSORIGIN
INNER JOIN INVENTDIM ID WITH (NOLOCK)
    ON ID.DATAAREAID = IT.DATAAREAID
    AND ID.INVENTDIMID = IT.INVENTDIMID
WHERE IT.DATAAREAID = @LegalEntity
  AND IT.DATEFINANCIAL >= @YearStart
  AND IT.DATEFINANCIAL <  @YearEnd
  AND (IT.STATUSISSUE = 1 OR IT.STATUSRECEIPT = 1)
ORDER BY IT.DATEFINANCIAL, IT.VOUCHER, IT.ITEMID;
```

