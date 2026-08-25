# Part 27: Tax Exempt Number on Order Headers & the TCS Multiple-VAT-ID Write-Back

_Reference for the `d365fo-analysis` skill. Read on demand._


*From the "Tax exempt number disappears when the PO is approved" RCA (2026-08-18, verified against 10.39/7.0.7996 source).*

### 27.1 The field triple — a Tax exempt number is three fields, not one

On document headers (`PurchTable`, `SalesTable`, `CustInvoiceTable`, `VendInvoiceInfoTable`, …) the "Tax exempt number" is stored as a **triple**, mapped via the `TaxExemptVATNumMap` map:

| Field | Meaning |
|---|---|
| `VATNum` | the number string shown in the UI |
| `VATNumTableType` | enum `TaxExemptNumberSourceType`: `None`=0, `TaxRegistration`=1, `TaxVATNumTable`=2 |
| `VATNumRecId` | RecId into `TaxRegistration` or `TaxVATNumTable`, per the type |

The header lookup shows **two sections** (documented in `TaxIntegrationTaxIdActivityOnDocument.setPartyTaxId`'s doc comment):
- **"Party"** rows → from the party's **Registration IDs** (`TaxRegistration`) → saves type `TaxRegistration`
- **"All"** rows → from the global list Tax > Setup > Sales tax > Tax exempt numbers (`TaxVATNumTable`) → saves type `TaxVATNumTable`

The legacy vendor-card field (Vendor > Invoice tab > Tax exempt number, `VendTable.VATNum`) is an "All"-type value. It is **not** the same thing as a Registration IDs VAT ID on the party's primary address.

### 27.2 The write-back that blanks the field

When the **Tax Calculation Service (TCS)** is enabled for a business process **and** "Support multiple VAT registration numbers" is on, every tax calculation ends with a persistence pass (`TaxIntegration<Doc>DataPersistence.saveDocument` → `TaxIntegrationTaxIdUtility::saveTaxIDFromDocumentToTable`) that **overwrites the header triple with the service's verdict**:

```xpp
// Neither VAT ID returned or default VAT number is valid, write 0.
if (_vatMap.VATNumTableType != TaxExemptNumberSourceType::TaxRegistration && !_document.getPartyTaxRecId())
{
    _vatMap.VATNum = ''; _vatMap.VATNumTableType = TaxExemptNumberSourceType::None;
    _vatMap.VATNumRecId = 0; _vatMap.doUpdate();
}
```

Consequences:
- An **"All"-type** (or imported/legacy) value is **wiped to blank** whenever the service cannot resolve a `TaxRegistration` RecId for the invoice-account party — i.e. the VAT ID is missing from the party's **Registration IDs**.
- Even when the service CAN resolve one, a manual value is **replaced** by the service-resolved registration (second branch).
- Only **"Party"-type** values survive. While the feature is on, re-entering "All"-type values is futile.
- Gates: `TaxIntegrationUtils::isMultipleTaxIdEnabledForBusinessProcess` = `isMultipleTaxIdEnabledForTaxService() && Tax::isTaxIntegrationEnabledForBusinessProcess(_bp)`.
- A warning IS raised at wipe time but scrolls by: `@TaxMultipleVATID:VendVATIDNotFoundAndBlankWarning` — "Vendor tax registration %1 is not found in the vendor's Registration IDs setup … otherwise the vendor tax registration will be left blank." (Cust variant exists.)
- Same mechanism covers `LedgerJournalTrans` via `saveTaxIDFromDocumentToLedgerJournalTrans`.

**Why it looks like "approval wipes it":** PO workflow approval calls `VersioningPurchaseOrder.approveChangeRequest`, which auto re-confirms when no confirmable change exists (`runPurchaseOrderConfirmationProcess`) → confirmation runs tax calculation → write-back. Totals calculation and manual confirmation trigger the identical wipe; approval is just the most visible moment. (Microsoft's own unit test `updateTaxIDWhenPurchTableInReview` pins the in-review timing.)

**The fix** is master data, not code: add the VAT ID under the party's primary (Business) address **Registration IDs** (+Add in the Registration ID grid on Manage addresses). Prerequisite: a **Registration type** for that country assigned to **registration category "VAT ID"** (Organization administration > Global address book > Registration types). Mark the entry **Primary**, dates current. Then pick the **"Party"** row in the document lookup — the service resolves it and keeps/auto-sets it.

### 27.3 PO change management approval does NOT restore old field values

Ruled out during the same RCA — useful to short-circuit the "versioning reverted my field" hypothesis:

- `VersioningDocument.approveChangeRequest` only sets state → `createNewVersion` (**archives** the current record into `PurchTableHistory`/`PurchTableVersion`). Nothing is copied back onto the live `PurchTable` at approval.
- Restore paths exist only for reject/cancel scenarios (`PurchTable.initFromPurchTableHistory` ← `PurchTableVersioning.copyVersion`) and a PublicSector-gated `restorePreviousVersion`.
- The versioned header-field subset is defined by the **`PurchTableMap`** table map (mapped on both `PurchTable` and `PurchTableHistory`) — `VATNum`/`VATNumRecId`/`VATNumTableType` ARE in it, so restores would carry them if a restore ran.
- Extension pattern: implement `PurchTableIVersioningFieldSet` with a custom map to version additional custom fields (`PurchTableVersioning.copyVersion` enumerates all registered field sets). Tenant example: `TBG_PurchTableVersioningFieldSet` + `TBG_PurchTableMap` (adds only `TBG_StatusUpdate`; also drives `isChangeConfirmationRequired` for that field).
- The standard re-confirmation decision compares only the hardcoded field list in `PurchTableVersioningFieldSet.isChangeConfirmationRequired` (CashDisc, CurrencyCode, DeliveryDate, accounts, Payment, DlvTerm, …) — `VATNum` is **not** in it, so changing only the tax exempt number does not force manual re-confirmation (which is exactly why approval auto-confirms and the tax calc runs immediately).

### 27.4 Where header VATNum values legitimately come from (writer inventory)

Complete writer list for `PurchTable.VATNum` (found via KB source search, see mcp-workflows Workflow 14):
- `PurchTable.initFromVendTableIL` — on create / order-account change: `vendTable.copyPrimaryRegistrationNumberToVATMap(purchTable)` (from `RegNumVendTable_Extension`; uses the **invoice account** unless the `EnableDefaultingOfFiscalDataFromInvoiceAccount` feature redirects to the order account). Blank vendor registration → blank PO triple.
- `PurchTable.doTransferTaxDefaultsFromInvoiceAcc` (via `transferInvoiceAccount` → runs on invoice-account change; also ProdPurch / release-from-agreement creation) — copies `vatNum`/`VATNumTableType`/`VATNumRecId` + TaxGroup straight from the invoice-account `VendTable`.
- `AxPurchTable.setVATNum` — services/entities (AIF-style writers).
- `TaxIntegrationTaxIdUtility::saveTaxIDFromDocumentToTable` — the TCS write-back above (the only one that runs *after* approval).

### 27.5 Vendor-master TEN layer — writers, integration limits, what corrupts the data (2026-08-20, DEV02 remediation)

**The VendTable triple has exactly three writers (code-verified, complete list):**
1. The vendor form's Tax exempt number **lookup click** (writes all three fields).
2. **`VendTable.insert()`** — copies the party's primary-address TAXID registration into the triple, but ONLY when the incoming `VATNum` is **empty**, the AP parameter `VendTableCopyTaxRegistionNumAsTaxExemptNum` is off, and the vendor is attached to a pre-existing party. **Supplying TEN text on the insert suppresses this copy.**
3. **X++** (e.g. Custom Script). There is NO update-time hook: customers have `RegNumCustTable_Extension.updateTaxExemptNumberFromPrimaryAddress`, **vendors have no equivalent** — after insert, nothing ever re-syncs the vendor card from the GAB.

**What leaves the data erroneous when inserting/updating vendors via OData/DMF:**
- Every WRITABLE vendor entity (`VendVendorV2Entity`/VendorsV2, V1, Retail V3, VRM) exposes only `TaxExemptNumber → VATNum` (text). `VATNumTableType`/`VATNumRecId` are exposed ONLY by the read-only `VendTableBiEntity`/`VendTableCDREntity` — exhaustive entity-catalogue check. ⇒ **any entity insert/update carrying TEN text produces `type 0 / RecId 0`** (TEXT_WITHOUT_POINTER), which TCS wipes from POs. On insert it ALSO suppresses writer #2. On update of a type-2 vendor it desynchronizes text vs pointer. Pre-creating the global list (`VATNumTables`) or the party registration changes nothing — no update-time resolution exists (empirically proven).
- The vendor-change-approval workflow ("Data fields requiring approvals" incl. Tax exempt number) silently diverts entity TEN updates into **change proposals**: the PATCH returns HTTP 200 but the stored value is unchanged. Verify writes by re-reading.

**The correct data model & fix:** the authoritative record is the party VAT registration (`TaxRegistration` ← `DirPartyLocation`), category **TAXID** — verified in X++: `TaxIntegrationTaxIdActivityOnDocument.getTaxIdRecIdByIDAccountRegion` joins `TaxRegistrationTypesList::TAXID` (NOT the "VAT ID" label, NOT EUVatID), and matches the registration number **exactly** (normalize: uppercase, no whitespace). At PO creation `PurchTable.initFromVendTableIL → copyPrimaryRegistrationNumberToVATMap` reads the registration directly and — under multiple-VAT-ID — stamps the PO with the Party-type RecId **even when the vendor card is text-only**. The card triple is a cache; the RecId that matters materializes on the PO.

**Entity to create registrations:** `TaxServiceTaxRegistrationNumberVendorEntity` — OData `TaxServiceTaxRegistrationNumberVendors`, DMF "Tax registration IDs on vendor for tax calculation feature setup master data lookup". No country gate, explicit Insert/Update handling, resolves `DirPartyLocation` (primary) from `VendAccount` via a **company-scoped select → session/import must run in the vendor's company**. Staging requires `VendName`. Server validations: party needs a primary postal address ("Field 'Reference' must be filled in" = missing), registration country ∈ {primary-address country, company country}, per-country number format. **Do NOT use** `TaxRegistrationOnVendorEntity` — `CountryRegionCodes=TH` on it AND its base entity: silently breaks DMF auto-mapping and blocks Add-file outside Thailand.

**Correct integration sequence (Power App / any onboarding):** (1) validate+normalize the VAT number, enforce prefix-country ∈ {address country, company country}; (2) POST VendorsV2 **with TEN empty** and the primary address included; (3) POST `TaxServiceTaxRegistrationNumberVendors`; (4) optional cosmetic text PATCH. The card **pointer** can only come from a CoC extension on the entity (CR: resolve triple in `mapEntityToDataSource` when a matching registration exists — FDD/TDD in the ticket folder) or a periodic X++ sweep. Registration-before-vendor is impossible (the registration entity keys on VendAccount) — so writer #2 never fires in integration flows.

**Remediation toolkit** (SupportTickets\TBD-po-taxexempt-wiped-on-approval\): `VendorVatNum_OriginDiagnosis.sql` (per-record verdict incl. party-side evidence), `VendorVatPrefix_vs_AddressCountry.sql` (prefix vs primary-address country), `Add-VendorVatRegistration.ps1` (idempotent per-vendor registration POST + `-SetVendorText`), `TBG_CS_Vend_InitVATNum_*_v1.2.0.0.zip` (Custom Script triple backfill incl. stale-pointer re-point), FDD/TDD for the entity extension.

---

*Last Updated: 2026-08-20 (added 27.5 — vendor TEN writers, OData/DMF corruption modes, TaxService registration entity, integration sequence)*

