# Part 5: Additional Common Tables Quick Reference

_Reference for the `d365fo-sql-direct-queries` skill. Read on demand._


### 5.1 Sales Documents

| Document | Header Table | Line Table | Key Join Fields |
|----------|-------------|------------|----------------|
| Sales Quotation | CustQuotationJour | CustQuotationTrans | QuotationId, QuotationDate |
| Sales Confirmation | CustConfirmJour | CustConfirmTrans | ConfirmId, ConfirmDate |
| Packing Slip | CustPackingSlipJour | CustPackingSlipTrans | PackingSlipId, DeliveryDate |
| Sales Invoice | CustInvoiceJour | CustInvoiceTrans | SalesId, InvoiceId, InvoiceDate, NumberSequenceGroup |

**Sales order holds / "Do not process" status:**
- `SalesTable.MCROrderStopped` (NoYes) is the stored field behind the **Do not process** column. It is not a free checkbox — the order-events engine toggles it.
- `MCROrderEventTable` (key `SALESID`) is the event/log driver. A hold is *active* while `HOLDCLEARDATETIME` is blank (the `1900-01-01` default = null, meaningless on non-hold rows).
- Hold-type `MCRORDEREVENTTYPE` values: 0 AddSOOrderHold, 40 fraud, 53 item-cancel, 60 check, 61 over-credit, 64 over-pay, 65 under-pay (each paired with a remove). Audit-only: 10 create, 27 modify, 79/80 modify confirmed receipt/ship date.
- Diagnose a stuck flag:
```sql
SELECT SALESID, MCRORDEREVENTTYPE, HOLDCLEARDATETIME, EVENTDESCRIPTION, FTCACTIVE
FROM   MCROrderEventTable
WHERE  SALESID = 'SO-XXXXXX' AND DATAAREAID = 'gruk'   -- lowercase company
ORDER BY RECID;
```
If every row is audit-only (10/27/79/80) and none is a hold type with a blank clear date, the flag is **orphaned** — clear it via the UI add/remove-hold trick (PROD) per §1.5, not by editing `MCROrderStopped` on PROD.

### 5.2 Purchase Documents

| Document | Header Table | Line Table | Key Join Fields |
|----------|-------------|------------|----------------|
| Purchase Order Confirmation | VendPurchOrderJour | VendPurchOrderTrans | PurchId, PurchOrderDocNum |
| Product Receipt | VendPackingSlipJour | VendPackingSlipTrans | PackingSlipId, DeliveryDate |
| Vendor Invoice | VendInvoiceJour | VendInvoiceTrans | PurchId, InvoiceId, InvoiceDate, NumberSequenceGroup, InternalInvoiceId |

### 5.3 InventTable — Process Manufacturing Fields

| Column | Purpose | Notes |
|--------|---------|-------|
| PMFPLANNINGITEMID | Planning requirement (formula item) | Self-FK to InventTable.ITEMID |
| PMFPRODUCTTYPE | Process manufacturing product type | 0=None, 1=BOM, 2=Formula, 3=PlanningItem, 4=Co_Product, 5=By_Product |

**DMF Entity Mapping**: `EcoResReleasedProductEntity.PlanningFormulaItemNumber` → `InventTable.PmfPlanningItemId`

### 5.4 Subledger Transaction Tables

| Table | Content | Company Filter |
|-------|---------|---------------|
| CustTrans | Customer transactions (open/settled) | DATAAREAID |
| VendTrans | Vendor transactions (open/settled) | DATAAREAID |
| BankAccountTrans | Bank transactions | DATAAREAID |
| TaxTrans | Tax transactions | DATAAREAID |

### 5.5 Key Linking Tables

| Link | From | To | Via |
|------|------|----|-----|
| Invoice → GL | CustInvoiceJour.LEDGERVOUCHER | GeneralJournalEntry.SUBLEDGERVOUCHER | Voucher match + company |
| InventTrans → GL | InventTrans.VOUCHER | GeneralJournalEntry.SUBLEDGERVOUCHER | Voucher match + company |
| LedgerJournal → GL | LedgerJournalTrans.VOUCHER | GeneralJournalEntry.SUBLEDGERVOUCHER | Voucher match + company |

