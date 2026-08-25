# Part 25: Site VAT Registration - Document Impact Analysis

_Reference for the `d365fo-analysis` skill. Read on demand._


### 25.1 Overview

**Analysis Date:** February 2026

When implementing VAT registration numbers **per site** (instead of per legal entity), numerous documents, reports, classes, and configuration tables are affected. This section provides a comprehensive impact analysis across all standard D365FO models.

**Business Scenario:** A legal entity has sites in different countries, each requiring a different VAT registration number on outgoing documents (invoices, confirmations, packing slips, etc.).

### 25.2 Current Architecture (Company-Level VAT)

In standard D365FO, VAT registration numbers are resolved at the **legal entity (company) level**:

```
CompanyInfo (Legal Entity)
  └── DirPartyTable.VATNUM              ← Company-level VAT number
  └── DirPartyLocation
       └── TaxRegistration              ← Registration linked to company address
            └── RegistrationNumber
```

**Two VAT resolution paths exist:**

| Path | Chain | Used For |
|------|-------|----------|
| **Customer/Vendor Master** | DirPartyLocation → TaxRegistration | Customer's/Vendor's VAT number |
| **Company Tax Config** | TaxTable → TaxPeriodHead.TaxId → TaxRegistration | Company's own VAT on tax reporting |

### 25.3 Target Architecture (Site-Level VAT)

To enable per-site VAT, the following data must be created:

```
InventSite
  └── InventSiteLogisticsLocation (ISPRIMARY = 1)
       └── LogisticsLocation
            └── DirPartyLocation       ← MUST CREATE (currently missing for sites)
                 └── TaxRegistration   ← MUST CREATE with site-specific VAT number
```

**Resolution priority (COALESCE pattern):**
1. Site-specific `TaxRegistration.RegistrationNumber` (if configured)
2. Company `DirPartyTable.VATNUM` (fallback)
3. Company `DirPartyTable.COREGNUM` (last resort)

### 25.4 Affected Sales Documents

| Document | Journal Table | Tax Link Table | Join Method | Model |
|----------|--------------|----------------|-------------|-------|
| Sales Order Confirmation | `CustConfirmJour` | TaxJournalTrans | `TRANSTABLEID = 5713 AND TRANSRECID = RecId` | ApplicationSuite |
| Sales Quotation | `CustQuotationJour` | TaxJournalTrans | `TRANSTABLEID = 13933 AND TRANSRECID = RecId` | ApplicationSuite |
| Quotation Confirmation | `CustQuotationConfirmJour` | TaxJournalTrans | TRANSTABLEID + TRANSRECID | ApplicationSuite |
| Sales Invoice | `CustInvoiceJour` | TaxTrans | `VOUCHER = LEDGERVOUCHER AND TRANSDATE = INVOICEDATE` | ApplicationSuite |
| Free Text Invoice | `CustInvoiceTable` | TaxTrans | VOUCHER + TRANSDATE | ApplicationSuite |
| Customer Packing Slip | `CustPackingSlipJour` | TaxExemptNum field | Direct field | ApplicationSuite |
| Credit/Debit Note | `CustVendCreditInvoicingJour` | TaxTrans | VOUCHER + TRANSDATE | ApplicationSuite |

**Critical:** `CustInvoiceJour` uses `TaxTrans` (posted) via `VOUCHER + TRANSDATE`, while Confirmations and Quotations use `TaxJournalTrans` (pre-posting) via `TRANSTABLEID + TRANSRECID`.

### 25.5 Affected Purchase Documents

| Document | Journal Table | Model |
|----------|--------------|-------|
| Purchase Order Confirmation | `VendPurchOrderJour` | ApplicationSuite |
| Purchase Invoice | `VendInvoiceJour` | ApplicationSuite |
| Vendor Packing Slip | `VendPackingSlipJour` | ApplicationSuite |
| Receipts List | `VendReceiptsListJour` | ApplicationSuite |
| RFQ | `VendRFQJour` | ApplicationSuite |
| RFQ Amendment | `VendRFQAmendmentJour` | ApplicationSuite |
| Purchase Confirmation Request | `PurchConfirmationRequestJour` | ApplicationSuite |

### 25.6 Affected Project Documents

| Document | Journal Table | Model |
|----------|--------------|-------|
| Project Invoice | `ProjInvoiceJour` | ApplicationSuite |
| Project Proposal | `ProjProposalJour` | ApplicationSuite |
| Project Contract Line Invoice | via PSAContractLineInvoice report | ApplicationSuite |

### 25.7 Affected Inventory/Logistics Documents

| Document | Journal Table | Model |
|----------|--------------|-------|
| Transfer Order | `InventTransferJour` | ApplicationSuite |
| WHS Customer Packing Slip | `WHSLoadTableCustPackingSlipJour` | ApplicationSuite |
| WHS Vendor Packing Slip | `WHSLoadTableVendPackingSlipJour` | ApplicationSuite |
| Transport Load Packing Slip | `WHSTransportLoadCustPackingSlipJour` | ApplicationSuite |

### 25.8 Affected SSRS Reports

| Report | Purpose | Model |
|--------|---------|-------|
| SalesConfirm.Report | Sales order confirmation | ApplicationSuite |
| SalesInvoice.Report | Sales invoice | ApplicationSuite |
| SalesPackingSlip.Report | Packing slip | ApplicationSuite |
| FreeTextInvoice.Report | Free text invoice | ApplicationSuite |
| CustDebitCreditNote.Design | Debit/credit note | ApplicationSuite |
| PSAContractLineInvoice.Report | Project contract invoice (+ regional variants) | ApplicationSuite |
| PSAProjInvoice.Report | Project invoice (+ regional variants) | ApplicationSuite |
| PaymReceiptTaxInv.Design | Payment receipt tax invoice | ApplicationSuite |
| PurchPackingSlip.Report | Purchase packing slip | ApplicationSuite |
| VendInvoiceDocument.Report | Vendor invoice | ApplicationSuite |

### 25.9 Affected Data Provider (DP) Classes - PRIMARY CHANGE POINT

These classes resolve the VAT number from `CompanyInfo` and populate report data. They are the **critical modification point** for site-level VAT:

| Class | Report | Extension Pattern |
|-------|--------|-------------------|
| `SalesConfirmDP` | Sales Confirmation | CoC via `[ExtensionOf(classStr(SalesConfirmDP))]` |
| `SalesInvoiceDP` | Sales Invoice | CoC extension |
| `SalesInvoiceDPBase` | Sales Invoice (base) | CoC extension |
| `FreeTextInvoiceDP` | Free Text Invoice | CoC extension |
| `SalesPackingSlipDP` | Packing Slip | CoC extension |
| `VendCompanyInfoDP` | Vendor documents | CoC extension |

**Existing extensions to review:**
- `SalesConfirmDP_ApplicationSuite_Extension`
- `SalesInvoiceDPBase_ApplicationSuite_Extension`
- `SalesInvoiceDP_ApplicationSuite_Extension`
- `FreeTextInvoiceDP_ApplicationSuite_Extension`
- `SalesInvoiceDPApplicationSuite_IT_Extension` (Italy)
- `SalesInvoiceDPApplicationSuite_AE_Extension` (UAE)
- `FreeTextInvoiceDP_CH_QRBill_Extension` (Switzerland QR-Bill)

### 25.10 Affected Controller Classes

| Class | Document | Model |
|-------|----------|-------|
| `SalesConfirmController` | Sales confirmation | ApplicationSuite |
| `SalesInvoiceController` | Sales invoice | ApplicationSuite |
| `SalesPackingSlipController` | Packing slip | ApplicationSuite |
| `FreeTextInvoiceController` | Free text invoice | ApplicationSuite |
| `SalesInvoice4PaymController` | Invoice for payment | ApplicationSuite |

### 25.11 Affected FormLetter Posting Classes

| Class | Document | Model |
|-------|----------|-------|
| `SalesFormLetter` (base) | All sales documents | ApplicationSuite |
| `SalesFormLetterConfirmContract` | Sales confirmation | ApplicationSuite |
| `SalesFormLetterInvoiceContract` | Sales invoice | ApplicationSuite |
| `SalesFormLetterPackingSlipContract` | Packing slip | ApplicationSuite |
| `SalesFormLetterFreeTextContract` | Free text invoice | ApplicationSuite |
| `PurchFormLetter` (base) | All purchase documents | ApplicationSuite |
| `PurchFormLetterInvoiceContract` | Purchase invoice | ApplicationSuite |
| `PurchFormLetterPackingSlipContract` | Purchase packing slip | ApplicationSuite |

### 25.12 Tax Configuration Tables

| Table | Role | Impact |
|-------|------|--------|
| `TaxRegistration` | Stores registration numbers | New records per site DirPartyLocation |
| `TaxPeriodHead` | Links TaxPeriod → TaxRegistration via TaxId | May need site-aware resolution |
| `TaxTable` | Tax code → TaxPeriod | No change, but resolution logic changes |
| `TaxJournalTrans` | Pre-posting tax lines | No schema change |
| `TaxTrans` | Posted tax lines | No schema change |
| `TaxAuthorityAddressRegistration` | Authority → Registration link | May need site-specific registrations |
| `DirPartyLocation` | Party-Location link | **Must be created** for each site |

### 25.13 Standard Models Involved

| Model | Objects Affected | Role |
|-------|-----------------|------|
| **ApplicationSuite** | All journal tables, DP classes, controllers, FormLetter classes, SSRS reports | Core business logic |
| **ApplicationFoundation** | DirPartyTable, DirPartyLocation, LogisticsLocation | Party/address framework |
| **Directory** | CompanyInfo table | Legal entity master |
| **Tax** | TaxRegistrationNumber EDT, TaxRegistrationFormat EDT, TaxRegistrationTypeId EDT | Tax EDTs and types |
| **ApplicationSuiteFormAdaptor** | Form adaptor classes for TaxRegistration forms | UI testing/automation |

### 25.14 Data Entities for Setup (DMF)

| Entity | Purpose | Model |
|--------|---------|-------|
| `TaxRegistrationBaseEntity` | Core registration import (RegistrationNumber, PartyNumber, LocationId, ValidFrom/To) | ApplicationSuite |
| `TaxRegistrationTypeEntity` | Registration type setup | ApplicationSuite |
| `TaxVATRegistrationNumberEntity` | VAT-specific registrations | ApplicationSuite |
| `TaxSalesTaxRegistrationNumberEntity` | Sales tax registrations | ApplicationSuite |
| `TaxRegistrationOnCustomerEntity` | Customer-specific registrations | ApplicationSuite |
| `TaxRegistrationOnVendorEntity` | Vendor-specific registrations | ApplicationSuite |

### 25.15 Impact Summary

| Category | Count | Complexity |
|----------|-------|------------|
| Sales document journals | 7 | High - each has different tax join logic |
| Purchase document journals | 7 | Medium - similar pattern to sales |
| Project document journals | 2 | Medium |
| Inventory/logistics journals | 4 | Low |
| SSRS reports to modify | 10+ | High - regional variants multiply effort |
| Data Provider classes | 5+ (plus extensions) | **Critical** - VAT resolution point |
| Controller classes | 5+ | Low - mostly pass-through |
| FormLetter posting classes | 8+ | Medium - tax calculation context |
| Tax config tables | 7 | Medium - setup/configuration |
| Data entities (DMF) | 6 | Low - for data migration |
| Master data records to create | Per site | Setup effort |

### 25.16 Implementation Strategy

**Recommended approach using Chain of Command (CoC):**

1. **Data setup**: Create `DirPartyLocation` + `TaxRegistration` records per site
2. **DP class extensions**: Override VAT resolution in DP classes to check site first, then fall back to company
3. **Report templates**: Update SSRS/Lasernet templates to use new data source fields
4. **Testing**: Verify per-site VAT on all document types across multiple companies

**The critical modification point** is in the DP classes where `CompanyInfo` is used to resolve the company VAT number. These need CoC extensions to check the delivery site's `DirPartyLocation → TaxRegistration` chain first, falling back to company-level VAT when no site-specific registration exists.

