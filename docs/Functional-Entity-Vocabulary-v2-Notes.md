# vocabulary-v2 notes (2026-09-07, XRef snapshot 2026-09-01 / KB snapshot 2026-08-14)

## Judgement calls on the canonical data entity
- customer: `CustCustomerV3Entity` first (Learn: V3 = full field set; "Customer definitions"+"details V2" are the high-performance pair, not listed); V2 kept as the widely used predecessor.
- item: `EcoResReleasedProductV2Entity` before `EcoResProductV2Entity` (Learn: released = company-level, shared product must pre-exist). `EcoResReleasedProductCreationV2Entity` omitted (import-only).
- party: `DirPartyBaseEntity` + `DirPersonBaseEntity`; `DirOrganizationBaseEntity` does not exist on this box.
- contact: only `CustElectronicAddressEntity` found; no party-generic electronic-address entity (`LogisticsElectronicAddress*`, `DirParty*ElectronicAddress*`, `Vend*` all missing).
- site: no site master entity (`InventSiteEntity`/`InventorySiteEntity` missing); `OMOperatingUnitEntity` used because sites are operating units of type Site.
- legal_entity: `CompanyInfoEntity` (the "Legal entities" entity); `OMLegalEntityEntity` does not exist.
- price_list: `SalesPriceAgreementEntity` / `PurchasePriceAgreementEntity` (trade-agreement journal lines); `PriceDiscTradeAgreement*` names do not exist.
- shipment: only the BI entity `WHSShipmentTableBiEntity`; no DMF entity for `CustPackingSlipJour` (packing slip headers) was found.
- customer_transaction: `CustTransEntity` + `CustTransOpenBiEntity`. vendor_transaction: only `VendTransCDREntity` exists (no `VendTransEntity`/`VendTransBiEntity`).
- fixed_asset_transaction: posted `AssetTrans` has only the CDR entity `AssetTransCDREntity`; the journal entities `AssetJournalV2Entity`/`AssetJournalLineEntity` listed first because they are the import path.
- fiscal_period: `FiscalPeriodEntity` (Calendar) + `LedgerFiscalPeriodEntity` (Ledger); the `FiscalCalendar*Entity` / `LedgerFiscalCalendar*Entity` names do not exist.
- budget: `BudgetRegisterEntryHeaderEntity`/`LineEntity` (not `BudgetTransaction*Entity`, which do not exist).
- project_transaction: only the journal entities `ProjJournalTableEntity`/`ProjJournalTransEntity`; no entity over the posted `Proj*Trans` tables.
- inventory_on_hand: `InventWarehouseInventoryStatusOnHandEntity` (V2 NOT on this box, although Learn documents it), `InventorySiteOnHandEntity`, `InventOnHandAIEntity`.
- inventory_transaction: only the BI entity `InventTransBiEntity`; no DMF/OData entity over `InventTrans`.
- ledger_transaction: `GeneralJournalAccountEntryEntity` first, `GeneralJournalAccountEntryBiEntity` second.
- receipt: `VendProductReceiptHeaderEntity`/`LineEntity` (found via the tool's suggestion; `PurchProductReceipt*` names do not exist).
- location: `WMSWarehouseLocationEntity` (not `WHSWarehouseLocationEntity`). warehouse = `InventLocation`, location = `WMSLocation`.
- user: `SystemUserEntity` + `SystemSecurityUserRoleEntity`; module set to `KernelTypeModule` (where `UserInfo` lives).

## Empty logical layer
- resource: no data entity found (`WrkCtrResource*Entity`, `WrkCtrCapabilityEntity` etc. all missing; only `DimAttributeWrkCtrResourceGroupEntity`, a dimension helper, exists). Physical layer `WrkCtrTable`/`WrkCtrResourceGroup` kept.

## Verified but with caveats
- `DataArea`, `UserInfo`, `SecurityUserRole` exist in XRef (module KernelTypeModule) but the KB has no field rows for kernel tables, so `DataArea.Id`, `UserInfo.Id`, `UserInfo.NetworkAlias` could not be verified and are OUT; `user.key_fields` is therefore `[]`, `legal_entity` keys on `CompanyInfo.DataArea` only.
- `WrkCtrResourceGroup`: no candidate key field (`WrkCtrGroupId`, `ResourceGroupId`, `Name`, `GroupId`, `Id`) exists in the KB; no key emitted for that table.
- KB search returned `FiscalCalendarBiEntity` and `InventorySiteOnHandV2Entity` but XRef does not have them; both left OUT.

## Not verified, left out
`DirOrganizationBaseEntity`, `LogisticsPostalAddressV2Entity`, `EcoResCategoryEntity`, `EcoResCategoryHierarchyEntity`, `UnitOfMeasureConversionEntity`, `InventSiteEntity`, `WHSWarehouseLocationEntity`, `OMLegalEntityEntity`, `DimensionAttributeValueEntity`, `WHSShipmentEntity`, `CustPaymentJournal*Entity`, `PurchAgreement*Entity`, `PurchPurchaseOrderProductReceiptHeaderEntity`, `VendTransEntity`, `LedgerChartOfAccountsEntity`, `FiscalCalendar(Period)Entity`, `AssetTransBiEntity`, `BankBankAccountEntity`, `BudgetTransaction*Entity`, `ProjProjectEntity`, `ProjTransPostingEntity`, `WrkCtrResource*Entity`, `InventOnHandEntity`, `InventInventoryCountingJournalEntryEntity`, `HcmJobV2Entity`, `SecurityUserRoleEntity`, `GeneralJournalAccountEntry`-less variants — none appear in the JSON.
