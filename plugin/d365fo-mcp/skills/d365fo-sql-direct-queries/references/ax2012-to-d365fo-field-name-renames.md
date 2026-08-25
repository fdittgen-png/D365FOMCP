# Part 2: AX2012-to-D365FO Field Name Renames

_Reference for the `d365fo-sql-direct-queries` skill. Read on demand._


These are the most common hallucination sources. LLM training data contains both names; only the D365FO column exists in the SQL database.

### 2.1 Verified Renames

| AX2012 / Common Guess | Actual D365FO Column | Table(s) | Notes |
|----------------------|---------------------|----------|-------|
| `CustAccount` | `OrderAccount` | CustInvoiceJour | Customer account on the sales order |
| `PurchOrderFormNum` | `PurchaseOrder` | CustInvoiceJour | Customer's PO reference |
| `PaymTermId` | `Payment` | CustInvoiceJour, VendInvoiceJour | Payment terms code |
| `ProductName` | `Name` | VendInvoiceTrans | Item description |
| `Unit` / `SalesUnit` (on vend) | `PurchUnit` | VendInvoiceTrans | Unit of measure |
| `Unit` (on cust) | `SalesUnit` | CustInvoiceTrans | Unit of measure |
| `Voucher` | `SubledgerVoucher` | GeneralJournalEntry | Voucher number |
| `IsDebit` | `IsCredit` | GeneralJournalAccountEntry | Inverted logic |

### 2.2 Fields That Do NOT Exist (Common Hallucinations)

| Hallucinated Field | Table | Reality |
|-------------------|-------|---------|
| `DIRECTION` | InventTrans | Derived from QTY sign: `CASE WHEN QTY < 0 THEN 'Issue' ELSE 'Receipt' END` |
| `SUBLEDGERVOUCHERTYPE` | GeneralJournalEntry | Does not exist at all |
| `AMOUNTCURDEBMST` | LedgerJournalTrans | Calculated at runtime, not stored. Only `AMOUNTCURDEBIT` / `AMOUNTCURCREDIT` exist |
| `AMOUNTCURCREDMST` | LedgerJournalTrans | Same as above |
| `POSTED` | LedgerJournalTrans | Lives on `LedgerJournalTable` (header), not on the line table |
| `RECINVOICEJOUR` | VendTrans | Does not exist |
| `CUSTACCOUNT` | CustInvoiceJour | Use `ORDERACCOUNT` or `INVOICEACCOUNT` |
| `PAYMTERMID` | Any invoice table | Use `PAYMENT` |

