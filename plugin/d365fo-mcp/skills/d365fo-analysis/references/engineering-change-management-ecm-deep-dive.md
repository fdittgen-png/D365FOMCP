# Part 3: Engineering Change Management (ECM) Deep Dive

_Reference for the `d365fo-analysis` skill. Read on demand._


### 3.1 ECM Model Statistics

- **Tables:** 160+ (including staging tables)
- **Classes:** 300+
- **Data Entities:** 50+
- **Forms:** 40+
- **Workflows:** Multiple templates for ECR/ECO

### 3.2 ECM Core Tables

#### Version and Release Tables

| Table | Purpose | Key Fields |
|-------|---------|------------|
| EngChgProductVersion | Engineering product versions | Product, ProductMaster, EngineeringVersionId, EngineeringOrganizationId, VersionNum |
| EngChgReleasedProductVersion | Released version per company | EngineeringProductVersion (FK), ItemId, InventDimId, DataAreaId, Active, EffectiveFromDate, EffectiveToDate |
| EngChgProductRelease | Release document tracking | Product, EngineeringProductVersion, ReleasingCompanyId, Status, Direction |
| EngChgProductReleaseLine | Release line details | ProductRelease (FK), additional details |

#### Change Order Tables

| Table | Purpose | Key Fields |
|-------|---------|------------|
| EngChgEcmHeader | Engineering change order header | RecId, Status, Workflow fields |
| EngChgEcmProduct | Products in change order | EngineeringChangeOrderHeader (FK), Product, TargetProduct, ChangeType |
| EngChgEcmProductRelease | Release targets per ECO | EngineeringChangeOrderHeader (FK), ReleasedIn (company), ReleaseProduct |
| EngChgEcmRequest | Engineering change requests | RecId, Status, Workflow fields |

#### Configuration Tables

| Table | Purpose | Key Fields |
|-------|---------|------------|
| EngChgProductParameters | Global ECM parameters | Various settings |
| EngChgProductParametersLocal | Per-company ECM parameters | Company-specific settings |
| EngChgEngineeringOrganization | Engineering organization definition | LegalEntityId |
| EngChgProductReleasePolicy | Release policy rules | Policy settings |
| EngChgProductReleasePolicyLegalEntityRule | Auto-release per company | CompanyId, AutoRelease |
| EngChgProductCategoryDetails | Product category ECM settings | Various category settings |
| EngChgProductCategoryNomenclature | Product naming rules | Nomenclature segments |

### 3.3 ECM Core Classes

#### Product Creation Classes

| Class | Purpose | Key Methods |
|-------|---------|-------------|
| EngChgEcoResProductCreate | Creates engineering products | createProduct(), createDistinctProductVariant(), createEngineeringProduct() |
| EngChgEcoResProductCreate_Extension | Extensions to standard creation | Extended methods |

#### Release Management Classes

| Class | Purpose | Key Methods |
|-------|---------|-------------|
| EngChgEcoResProductReleaseManager | Manages product release | release(), createInventTable(), populateInventDistinctProduct() |
| EngChgEcoResProductVariantReleaseManager | Variant-specific release | release(), productMasterItemId() |
| EngChgEcmProductReleaseCollect | Collects release targets | run() - determines which companies receive release |
| EngChgEcmProductReleaseProcess | Processes releases | run() - executes the release to each company |
| EngChgProductReleaseService | Release service layer | releaseItem() |

#### Version Management Classes

| Class | Purpose | Key Methods |
|-------|---------|-------------|
| EngChgProductActivate | Activates product versions | Activation logic |
| EngChgProductDeActivate | Deactivates versions | Deactivation logic |
| EngChgBOMVersion | BOM version handling | BOM-specific version logic |
| EngChgBOMRouteVersionActivate | Activates BOM/Route versions | Combined activation |

