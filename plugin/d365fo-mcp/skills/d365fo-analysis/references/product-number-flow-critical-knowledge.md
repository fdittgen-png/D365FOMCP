# Part 4: Product Number Flow (Critical Knowledge)

_Reference for the `d365fo-analysis` skill. Read on demand._


### 4.1 Flow 1: Product Creation with Number Transfer

**Behavior:** When creating a new engineering product, D365 only requires entering the product number. It automatically transfers to DisplayProductNumber.

**Technical Implementation:**

```x++
// EngChgEcoResProductCreate.createProduct()

// Step 1: Create EcoResProduct
ecoResProduct.DisplayProductNumber = productId;  // Set display number
ecoResProduct.insert();

// Step 2: Create EcoResProductIdentifier
ecoResProductIdentifier.ProductNumber = productId;  // Same as input
ecoResProductIdentifier.Product = ecoResProduct.RecId;
ecoResProductIdentifier.write();

// Step 3: If ProductMaster with dimensions, create variant
if (ecoResProduct.isProductMaster() && inventDim.anyProductDimensionSpecified())
{
    ecoResProduct = this.createDistinctProductVariant(
        ecoResProduct as EcoResProductMaster,
        inventDim
    );
}
```

**Data Flow:**
```
User Input: "ENG-PROD-001"
    │
    ├─→ EcoResProduct.DisplayProductNumber = "ENG-PROD-001"
    ├─→ EcoResProductIdentifier.ProductNumber = "ENG-PROD-001"
    └─→ EcoResProductIdentifier.Product = EcoResProduct.RecId
```

### 4.2 Flow 2: Product Variant Using Product Number as Base

**Behavior:** When creating a product variant, D365 takes the product number as the base for the released product variant ID.

**Technical Implementation:**

```x++
// EngChgEcoResProductCreate.createDistinctProductVariant()

public EcoResDistinctProductVariant createDistinctProductVariant(
    EcoResProductMaster _productMaster,
    InventDim _inventDim)
{
    // Build dimension container from InventDim
    while (enumerator.moveNext())
    {
        InventProductDimension dimProduct = InventDimension::singletonFromInventDimFieldId(
            enumerator.current()
        ) as InventProductDimension;

        // Get dimension value
        Common dimensionRecord = dimProduct.findDimensionByNaturalKey(
            _inventDim.(enumerator.current())
        );

        dimcon = conIns(dimcon, conLen(dimcon)+1, dimensionRecord.RecId);
    }

    // Create or find variant using ProductMaster reference
    variant = EcoResProductVariantManager::findDistinctProductVariant(
        _productMaster.RecId,  // Base: Master's RecId (which has ProductNumber)
        dimcon,                // Dimensions
        true                   // Create if not exists
    );

    return variant;
}
```

**Data Flow:**
```
Product Master: "PROD-001" (ProductNumber)
    │
    ├─→ Variant: RecId links to ProductMaster.RecId
    │       ├── Color: RED
    │       └── Size: SMALL
    │
    └─→ Variant Display Name: "PROD-001-RED-SMALL" (via nomenclature)
```

### 4.3 Flow 3: Intercompany Release Using Product Number as ItemId

**Behavior:** When releasing to another company, D365 uses the product number as the basis for the new item number at the receiving site (when no number sequence is configured).

**Technical Implementation:**

```x++
// EngChgEcmProductReleaseCollect.run() - Determines target companies

while select ecmProduct
    where ecmProduct.EngineeringChangeOrderHeader == ecmHeader.RecId
{
    container releaseTo;

    // Rule 1: Re-release to previously released companies
    while select crosscompany DataAreaId from release
    where release.Status == EngChgReleaseStatus::Posted
       && release.Direction == EngChgReleaseDirection::Receive
       && release.DataAreaId != curExt()  // Not engineering company
    {
        releaseTo = conIns(releaseTo, conLen(releaseTo)+1,
            [release.DataAreaId, inventSiteId]);
    }

    // Rule 2: Auto-release per policy
    while select productReleasePolicyLegalEntityRule
    where productReleasePolicyLegalEntityRule.AutoRelease == NoYes::Yes
    {
        releaseTo = conIns(releaseTo, conLen(releaseTo)+1,
            [productReleasePolicyLegalEntityRule.CompanyId, inventSiteId]);
    }

    // Create release records
    for (releaseCnt = 1; releaseCnt <= conLen(releaseTo); releaseCnt++)
    {
        [targetCompanyId, inventSiteId] = conPeek(releaseTo, releaseCnt);
        EngChgEcmProductRelease::findOrCreate(ecmHeader.RecId,
            ecmProduct.RecId, targetCompanyId, inventSiteId);
    }
}
```

```x++
// EngChgEcoResProductReleaseManager.release() - Executes in target company

public void release()
{
    // CRITICAL: Execute in target company context
    changecompany (CompanyInfo::find(false, legalEntity).DataArea)
    {
        ttsbegin;

        this.createInventTable();           // Creates InventTable with ItemId
        this.populateInventDistinctProduct(); // Links to EcoResProduct
        this.createProductPerCompanyTables(); // Company-specific setup

        ttscommit;
    }
}

protected void createInventTable()
{
    // ItemId generation logic
    if (numberSequenceIsConfigured)
    {
        itemId = NumberSeq::newGetNum(numberSeqRef).num();  // Auto-generated
    }
    else
    {
        itemId = ecoResProduct.productNumber();  // Uses ProductNumber
    }

    inventTable.ItemId = itemId;
    inventTable.Product = ecoResProduct.RecId;  // Links to global product
    inventTable.insert(true);
}
```

**Data Flow:**
```
Engineering Company "ENGCO":
├── EcoResProduct.RecId = 12345
├── ProductNumber = "ENG-PROD-001"
│
└── Release to Company "COMPA":
    │
    └── changecompany("COMPA")
        │
        ├── EngChgReleasedProductVersion
        │   ├── EngineeringProductVersion = <version RecId>
        │   ├── ItemId = "ENG-PROD-001" (or auto-generated)
        │   └── DataAreaId = "COMPA"
        │
        └── InventTable (in COMPA)
            ├── ItemId = "ENG-PROD-001"
            └── Product = 12345 (same EcoResProduct.RecId)
```

### 4.4 EngChgReleasedProductVersion.initFromEcoResProduct()

```x++
public void initFromEcoResProduct(EcoResProduct product)
{
    if (product.isDistinctProductVariant())
    {
        // For variants: Get ItemId from dimension combination
        var dimCombination = InventDimCombination::findByDistinctProductVariant(
            product.RecId
        );
        this.ItemId = dimCombination.ItemId;
        this.InventDimId = dimCombination.InventDimId;
    }
    else
    {
        // For distinct products: Get ItemId from InventTable
        var item = InventTable::findByProduct(product.RecId);
        this.ItemId = item.ItemId;
        this.InventDimId = InventDim::inventDimIdBlank();
    }

    // Set lifecycle state from category
    if (!this.ProductLifecycleStateId)
    {
        this.ProductLifecycleStateId = EngChgProductCategoryDetails::find(
            product.EngChgProductCategoryDetails
        ).CreatedProductLifecycleStateId;
    }
}
```

