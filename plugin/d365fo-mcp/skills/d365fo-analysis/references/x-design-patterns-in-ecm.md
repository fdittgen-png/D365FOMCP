# Part 5: X++ Design Patterns in ECM

_Reference for the `d365fo-analysis` skill. Read on demand._


### 5.1 Builder/Creator Pattern

**Example:** EngChgEcoResProductCreate

```x++
// Usage pattern
EngChgEcoResProductCreate creator = new EngChgEcoResProductCreate();
creator.parmProductId("PROD-001");
creator.parmProductName("Product Name");
creator.parmProductSubtype(EcoResProductSubtype::Product);
creator.parmSearchName("PROD001");

EcoResProduct product = creator.createProduct();
```

**Characteristics:**
- Fluent API with parm* methods
- Separates construction from representation
- Allows complex object creation step-by-step

### 5.2 Manager Pattern

**Example:** EngChgEcoResProductReleaseManager

```x++
// Pattern structure
class EngChgEcoResProductReleaseManager extends EcoResProductReleaseManager
{
    // State
    protected EcoResProduct ecoResProduct;
    protected CompanyId legalEntity;

    // Factory method
    public static EngChgEcoResProductReleaseManager construct() { }

    // Parameter methods
    public EcoResProduct parmProduct(EcoResProduct _product) { }
    public CompanyId parmLegalEntity(CompanyId _legalEntity) { }

    // Main workflow
    public void release() { }

    // Sub-operations
    protected void createInventTable() { }
    protected void populateInventDistinctProduct() { }
    protected void createProductPerCompanyTables() { }
}
```

### 5.3 Template Method Pattern

**Example:** Release managers with hookable methods

```x++
class EngChgEcoResProductReleaseManager
{
    [Hookable(true)]  // Can be extended
    protected void createProductPerCompanyTables()
    {
        // Default implementation
    }

    [Hookable(false)]  // Cannot be extended
    protected void createInventTable()
    {
        // Core logic, not extensible
    }
}
```

### 5.4 Factory Pattern

**Example:** Release manager creation based on product type

```x++
public static EcoResProductReleaseManager createReleaseManager(
    EcoResProduct _product)
{
    if (_product.isDistinctProductVariant())
    {
        return EngChgEcoResProductVariantReleaseManager::construct();
    }
    else if (_product.isProductMaster())
    {
        return EngChgEcoResProductMasterReleaseManager::construct();
    }
    else
    {
        return EngChgEcoResProductReleaseManager::construct();
    }
}
```

### 5.5 Strategy Pattern

**Example:** Different release strategies per product type

```
ReleaseManager (Context)
    │
    ├── DistinctProductReleaseManager (Strategy 1)
    │   └── Creates InventTable + InventDistinctProduct
    │
    ├── ProductMasterReleaseManager (Strategy 2)
    │   └── Creates InventTable for master only
    │
    └── VariantReleaseManager (Strategy 3)
        └── Creates InventDimCombination using master's ItemId
```

### 5.6 Chain of Command (CoC) Extension Pattern

```x++
// Extension class
[ExtensionOf(classStr(EngChgEcoResProductCreate))]
final class EngChgEcoResProductCreate_Extension
{
    public EcoResProduct createProduct()
    {
        // Pre-processing
        this.customPreProcess();

        // Call original
        EcoResProduct product = next createProduct();

        // Post-processing
        this.customPostProcess(product);

        return product;
    }
}
```

