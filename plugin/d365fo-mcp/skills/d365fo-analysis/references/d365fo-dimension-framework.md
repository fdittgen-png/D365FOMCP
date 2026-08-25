# Part 20: D365FO Dimension Framework

_Reference for the `d365fo-analysis` skill. Read on demand._


### 20.1 Core Dimension Tables

| Table | Purpose |
|-------|---------|
| DimensionAttribute | Dimension definition (e.g., CostCenter, Department) |
| DimensionAttributeValue | Individual dimension values |
| DimensionAttributeValueSet | Collection of dimension values |
| DimensionAttributeValueSetItem | Link between set and values |
| DimensionAttributeValueCombination | Ledger dimension combinations |

### 20.2 DefaultDimension vs LedgerDimension

| Field | Purpose | Example |
|-------|---------|---------|
| **DefaultDimension** | Financial dimensions without main account | CostCenter=1050, Department=Sales |
| **LedgerDimension** | Full ledger account structure | 60100-1050-Sales |

### 20.3 Dimension Storage API

**Creating/Updating Dimensions:**
```x++
// Create new dimension set from scratch
DimensionAttributeValueSetStorage dimStorage = new DimensionAttributeValueSetStorage();

// Add dimension values
DimensionAttribute dimAttr = DimensionAttribute::findByName('CostCenter');
DimensionAttributeValue dimAttrValue = DimensionAttributeValue::findByDimensionAttributeAndValue(
    dimAttr, '1050', false, true);

dimStorage.addItem(dimAttrValue);

// Save and get RecId
DimensionDefault newDimension = dimStorage.save();

// Apply to record
purchTable.DefaultDimension = newDimension;
purchTable.update();
```

### 20.4 Dimension Query Patterns

**Get dimension values from RecId:**
```sql
SELECT da.NAME as DimensionName, dav.DISPLAYVALUE as DimensionValue
FROM DIMENSIONATTRIBUTEVALUESET davs
INNER JOIN DIMENSIONATTRIBUTEVALUESETITEM davsi
    ON davsi.DIMENSIONATTRIBUTEVALUESET = davs.RECID
INNER JOIN DIMENSIONATTRIBUTEVALUE dav
    ON dav.RECID = davsi.DIMENSIONATTRIBUTEVALUE
INNER JOIN DIMENSIONATTRIBUTE da
    ON da.RECID = dav.DIMENSIONATTRIBUTE
WHERE davs.RECID = @DimensionRecId
ORDER BY da.NAME
```

**Get dimension string:**
```sql
SELECT STRING_AGG(da.NAME + ':' + dav.DISPLAYVALUE, '-')
       WITHIN GROUP (ORDER BY da.NAME) as DimString
FROM DIMENSIONATTRIBUTEVALUESET davs
INNER JOIN DIMENSIONATTRIBUTEVALUESETITEM davsi
    ON davsi.DIMENSIONATTRIBUTEVALUESET = davs.RECID
INNER JOIN DIMENSIONATTRIBUTEVALUE dav
    ON dav.RECID = davsi.DIMENSIONATTRIBUTEVALUE
INNER JOIN DIMENSIONATTRIBUTE da
    ON da.RECID = dav.DIMENSIONATTRIBUTE
WHERE davs.RECID = @DimensionRecId
```

### 20.5 Account Structure Impact

**Important:** Dimensions stored in database may not be visible in D365FO UI if not in active Account Structure.

**Check Account Structure:** `General Ledger > Chart of Accounts > Structures > Configure account structures`

### 20.6 Dimension Replacement Logic

When updating dimensions with `DimensionAttributeValueSetStorage`:

```x++
// This CREATES A NEW dimension set (replacement, not merge!)
DimensionAttributeValueSetStorage dimStorage = new DimensionAttributeValueSetStorage();
dimStorage.addItem(dimAttrValueBPC);
dimStorage.addItem(dimAttrValueCostCenter);
DimensionDefault newDim = dimStorage.save();

// IMPORTANT: This replaces ALL dimensions, not just the ones added!
// Any dimensions NOT added to dimStorage will be LOST
```

**To preserve existing dimensions:**
```x++
// Load existing dimensions first
DimensionAttributeValueSetStorage dimStorage =
    DimensionAttributeValueSetStorage::find(existingDimensionRecId);

// Then add/update specific dimensions
dimStorage.addItem(newDimAttrValue);

// Save preserves unchanged dimensions
DimensionDefault updatedDim = dimStorage.save();
```

