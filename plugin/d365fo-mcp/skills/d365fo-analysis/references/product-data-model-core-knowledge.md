# Part 2: Product Data Model (Core Knowledge)

_Reference for the `d365fo-analysis` skill. Read on demand._


### 2.1 Product Number vs ItemId - Critical Distinction

| Identifier | Scope | Storage | Purpose |
|------------|-------|---------|---------|
| **ProductNumber** | Global (cross-company) | EcoResProductIdentifier.ProductNumber | Unique product identifier across all legal entities |
| **ItemId** | Per Legal Entity | InventTable.ItemId | Inventory item identifier within a specific company |
| **DisplayProductNumber** | Global | EcoResProduct.DisplayProductNumber | User-visible product number |

**Key Insight:** ProductNumber and ItemId are DIFFERENT identifiers serving different purposes. They may have the same value (when no number sequence is configured) or different values (when auto-generated).

### 2.2 Core Product Tables

```
EcoResProduct (Abstract Base - RecId is the key)
│
├── EcoResProductIdentifier (1:1)
│   ├── ProductNumber: EcoResProductNumber (global unique)
│   └── Product: RefRecId → EcoResProduct.RecId
│
├── EcoResProductMaster (inherits EcoResProduct)
│   └── For products with variants (configurable, sizes, colors, etc.)
│
├── EcoResDistinctProduct (inherits EcoResProduct)
│   └── For products without variants
│
├── EcoResDistinctProductVariant (inherits EcoResProduct)
│   ├── ProductMaster: RefRecId → EcoResProductMaster.RecId
│   └── Specific variant of a master product
│
└── InventTable (1:N per legal entity via Product field)
    ├── ItemId: String (unique per DataAreaId)
    ├── Product: RefRecId → EcoResProduct.RecId
    └── DataAreaId: Company identifier
```

### 2.3 Product-to-Item Linking Tables

| Table | Purpose | Key Fields |
|-------|---------|------------|
| InventDistinctProduct | Links ItemId to distinct product | ItemId, Product (FK), InventDimId |
| InventDimCombination | Links ItemId to variant with dimensions | ItemId, DistinctProductVariant (FK), InventDimId |
| EcoResProductIdentifier | Maps ProductNumber to EcoResProduct | ProductNumber, Product (FK) |

### 2.4 Product Release Tables

| Table | Purpose | Key Fields |
|-------|---------|------------|
| EcoResReleaseSessionProduct | Products in release session | Product (FK), ReleaseSession (FK) |
| EcoResReleaseProductLegalEntity | Target companies for release | ReleaseSessionProduct (FK), LegalEntity (FK) |

