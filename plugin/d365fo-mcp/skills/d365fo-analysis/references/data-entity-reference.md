# Part 9: Data Entity Reference

_Reference for the `d365fo-analysis` skill. Read on demand._


### 9.1 Product Data Entities

| Entity | Purpose | Key Fields |
|--------|---------|------------|
| EcoResReleasedProductEntity | Released product management | ItemNumber, ProductNumber |
| EcoResProductEntity | Global product | ProductNumber, ProductName |
| EcoResDistinctProductVariantEntity | Variants | ProductNumber, dimensions |

### 9.1a Process Manufacturing (PMF) Fields on Released Products

The "Product planning properties" section on the Released Product Details form (Plan tab) contains several PMF fields stored directly on `InventTable`.

**Planning Requirement / Planning Formula Item:**

| Property | Value |
|----------|-------|
| **Table** | `InventTable` |
| **Field** | `PmfPlanningItemId` |
| **EDT** | `PmfPlanningItemId` (extends `ItemId`) |
| **Config Key** | PMF (Process Manufacturing) |
| **Form** | `EcoResProductDetailsExtended` → Plan tab → `PmfFormulaPlanning` group |
| **Relation** | Self-referencing FK: `InventTable.PmfPlanningItemId` → `InventTable.ItemId` |

**DMF Import**: Use entity `EcoResReleasedProductEntity` (NOT V2). The entity field name is **`PlanningFormulaItemNumber`** (maps to `InventTable.PmfPlanningItemId`). Minimum fields to map: `ItemNumber` + `PlanningFormulaItemNumber`.

**Note**: The lookup on the form filters to formula items via `InventTable::lookupFormulaItemId()`. The planning requirement records themselves must exist as released products before they can be assigned.

### 9.2 ECM Data Entities

| Entity | Purpose |
|--------|---------|
| EngChgEngineeringProductVersionEntity | Engineering versions |
| EngChgReleasedEngineeringProductVersionEntity | Released versions |
| EngChgEngineeringChangeOrderHeaderEntity | Change orders |
| EngChgEngineeringChangeRequestHeaderEntity | Change requests |

