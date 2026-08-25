# Part 7: Number Sequences and Nomenclature (Deep Dive)

_Reference for the `d365fo-analysis` skill. Read on demand._


### 7.1 Number Sequence Module Definitions

#### Product Number Sequence (Global/Shared)

**File:** `ApplicationSuite\Foundation\AxClass\NumberSeqModuleEcoResProduct.xml`

```x++
protected void loadModule()
{
    NumberSeqDatatype datatype = NumberSeqDatatype::construct();

    // Product number - configured for MANUAL entry by default!
    datatype.parmDatatypeId(extendedTypeNum(EcoResProductNumber));
    datatype.parmReferenceHelp(literalStr("@SYS301333"));
    datatype.parmWizardIsContinuous(false);
    datatype.parmWizardIsManual(NoYes::Yes);  // KEY: Manual allowed
    datatype.parmWizardIsChangeDownAllowed(NoYes::No);
    datatype.parmWizardIsChangeUpAllowed(NoYes::No);
    datatype.parmSortField(1);
    this.create(datatype);
}

public NumberSeqModule numberSeqModule()
{
    return NumberSeqModule::EcoResProduct;
}
```

**Key Properties:**
| Property | Value | Meaning |
|----------|-------|---------|
| Module | `NumberSeqModule::EcoResProduct` | Product management module |
| Scope | Shared (cross-company) | Global product identifiers |
| Manual | `NoYes::Yes` | Manual entry supported by default |
| EDT | `EcoResProductNumber` | Extended data type |

#### ItemId Number Sequence (Per Legal Entity)

**File:** `ApplicationSuite\Foundation\AxClass\NumberSeqModuleInventory.xml`

```x++
protected void loadModule()
{
    NumberSeqDatatype datatype = NumberSeqDatatype::construct();

    // Item id - configured for MANUAL entry by default!
    datatype.parmDatatypeId(extendedtypenum(ItemId));
    datatype.parmReferenceHelp(literalstr("@SYS53849"));
    datatype.parmWizardIsContinuous(false);
    datatype.parmWizardIsManual(NoYes::Yes);  // KEY: Manual allowed
    datatype.parmWizardIsChangeDownAllowed(NoYes::No);
    datatype.parmWizardIsChangeUpAllowed(NoYes::No);
    datatype.parmSortField(20);
    datatype.addParameterType(NumberSeqParameterType::DataArea, true, false);
    this.create(datatype);
}

public NumberSeqModule numberSeqModule()
{
    return NumberSeqModule::Invent;
}
```

**Key Properties:**
| Property | Value | Meaning |
|----------|-------|---------|
| Module | `NumberSeqModule::Invent` | Inventory management module |
| Scope | DataArea (per company) | Company-specific item identifiers |
| Manual | `NoYes::Yes` | Manual entry supported by default |
| EDT | `ItemId` | Extended data type |

### 7.2 Critical ItemId Initialization Logic

**File:** `ApplicationSuite\Foundation\AxClass\EcoResProductReleaseManager.xml`

```x++
// This is the KEY method that determines how ItemId is assigned!
protected void initItemId()
{
    if (!itemId)
    {
        NumberSequenceTable numberSequenceTable = InventParameters::numRefItemId().numberSequenceTable();

        // Decision logic:
        // 1. If no number sequence configured OR manual mode -> Use ProductNumber
        // 2. If auto number sequence configured -> Generate new ItemId
        if (!numberSequenceTable.RecId || numberSequenceTable.Manual)
        {
            itemId = ecoResProduct.productNumber();  // ProductNumber becomes ItemId
        }
        else
        {
            itemId = NumberSeq::newGetNumFromId(numberSequenceTable.RecId).num();
        }
    }
}
```

**Critical Behavior Matrix:**

| Number Seq Config | numberSequenceTable.RecId | numberSequenceTable.Manual | Result |
|-------------------|---------------------------|----------------------------|--------|
| Not configured | 0 | N/A | ItemId = ProductNumber |
| Configured as Manual | >0 | Yes | ItemId = ProductNumber |
| Configured as Auto | >0 | No | ItemId = Generated from sequence |

### 7.3 Product Number Builder

**File:** `ApplicationSuite\Foundation\AxClass\EcoResProductNumberBuilder.xml`

```x++
public class EcoResProductNumberBuilder
{
    EcoResProduct product;

    public EcoResProductNumber buildNumber()
    {
        return product.productNumber();
    }
}
```

**Variant Number Builder:**

**File:** `ApplicationSuite\Foundation\AxClass\EcoResProductNumberBuilderVariant.xml`

```x++
// Builds variant product numbers from master + dimensions
public EcoResProductNumber buildNumber()
{
    // Uses nomenclature rules to concatenate master number with dimension values
    return nomenclatureBuilder.build(productMaster, dimensionValues);
}
```

### 7.4 ECM Product Nomenclature Rules

**Table:** `EngChgProductCategoryNomenclature`

**Nomenclature Roles:**
| Role | Enum | Purpose |
|------|------|---------|
| Product Number | `EcoResNomenclatureRole::Id` | Generate ProductNumber |
| Product Name | `EcoResNomenclatureRole::Name` | Generate product name |
| Description | `EcoResNomenclatureRole::Description` | Generate description |

**Implementation in EngChgEcoResProductCreate:**

```x++
public static EngChgProductNumber createProductNumberNomenclature(
    EngChgProductCategoryDetailsRecId _productCategoryDetailsRecId,
    Map _attributeMap)
{
    int numberLimit = new DictType(extendedTypeNum(EngChgProductNumber)).stringLen();
    EcoResNomenclatureOutput result = EngChgProductCategoryNomenclature::buildProductCategoryNomenclature(
        _productCategoryDetailsRecId,
        _attributeMap,
        EcoResNomenclatureRole::Id
    );

    if (strLen(result) > numberLimit)
    {
        info(strFmt("@ENG:ProductNumberNomenclatureCrossedMaxSizeWarning", result, numberLimit));
    }

    return result;
}
```

**Example Nomenclature:**
```
Segment 1: "PRD-" (literal text)
Segment 2: {Number Sequence} → "0001"
Segment 3: "-" (separator)
Segment 4: {Color Attribute} → "BLU"
→ Result: "PRD-0001-BLU"
```

### 7.5 Engineering Version Numbering

**Options (EngChgProductCategoryDetails):**
- **Auto:** Sequential version numbers (V1, V2, V3...)
- **List:** Predefined version list
- **Manual:** User-specified version names

### 7.6 Number Sequence Configuration Paths

| Number Sequence | Navigation Path |
|-----------------|-----------------|
| Product Number | Product information management > Setup > Product information management parameters > Number sequences |
| Item ID | Inventory management > Setup > Inventory and warehouse management parameters > Number sequences |
| ECM Nomenclature | Engineering change management > Setup > Engineering product category details > Nomenclature |

### 7.7 Customization Options for Manual Number Entry

#### Option 1: Number Sequence Configuration (No Code)

```
1. Organization administration > Number sequences > Number sequences
2. Find the sequence for ProductNumber or ItemId
3. General FastTab > Set Manual = Yes
4. Save
```

**Effect:** Enables manual entry in standard forms.

#### Option 2: Chain of Command Extension (Full Control)

```x++
[ExtensionOf(classStr(EcoResProductReleaseManager))]
final class EcoResProductReleaseManager_Custom_Extension
{
    protected void initItemId()
    {
        // Custom logic before standard processing
        if (this.shouldUseCustomItemId())
        {
            this.parmItemId(this.generateCustomItemId());
        }
        else
        {
            next initItemId();
        }
    }

    private boolean shouldUseCustomItemId()
    {
        // Check if product comes from an external source system
        return true;
    }

    private ItemId generateCustomItemId()
    {
        // Custom generation logic
        // Example: Use external system's item number
        return strFmt('CUSTOM-%1', ecoResProduct.productNumber());
    }
}
```

#### Option 3: Use parmItemId() for Programmatic Override

```x++
// When releasing programmatically, set ItemId before release
EcoResProductReleaseManager releaseManager = EcoResProductReleaseManager::construct();
releaseManager.parmProduct(ecoResProduct);
releaseManager.parmLegalEntity(legalEntityRecId);
releaseManager.parmItemId('CUSTOM-ITEM-001');  // Override ItemId
releaseManager.init();
releaseManager.release();
```

### 7.8 Key Extension Points

| Method | Class | Hookable | Extension Point |
|--------|-------|----------|-----------------|
| `initItemId()` | EcoResProductReleaseManager | Yes | Override ItemId generation |
| `init()` | EcoResProductReleaseManager | Yes | Initialize release parameters |
| `release()` | EcoResProductReleaseManager | Yes | Pre/post release processing |
| `createInventTable()` | EcoResProductReleaseManager | Yes | Customize InventTable creation |
| `setInventTableFields()` | EcoResProductReleaseManager | Yes | Set additional fields |

### 7.9 Number Sequence Diagnostic Queries

```x++
// Check ItemId number sequence configuration
NumberSequenceTable nsTable = InventParameters::numRefItemId().numberSequenceTable();
info(strFmt('ItemId Number Seq: RecId=%1, Manual=%2', nsTable.RecId, nsTable.Manual));

// Check ProductNumber number sequence configuration
NumberSeqReference nsRef = NumberSeqReference::findReference(
    extendedTypeNum(EcoResProductNumber)
);
info(strFmt('ProductNumber Number Seq: %1', nsRef.NumberSequenceId));
```

