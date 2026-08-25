# Part 16: Dataverse / Azure Synapse Link Queries

_Reference for the `d365fo-analysis` skill. Read on demand._


### 16.1 Schema Differences: [dbo] vs [ax]

D365FO data can be accessed via two different schemas depending on the data source:

| Schema | Source | Characteristics |
|--------|--------|-----------------|
| `[dbo]` | On-premises SQL / Cloud-hosted | Full table structure with all columns, flattened inheritance |
| `[ax]` | Dataverse / Azure Synapse Link | Normalized structure, base table columns only, missing child table columns |

**Critical Differences:**

| Table | [dbo] Schema | [ax]/Dataverse |
|-------|--------------|----------------|
| ECORESINSTANCEVALUE | Has `PRODUCT` column | **NO** `PRODUCT` column |
| ECORESPRODUCTINSTANCEVALUE | Flattened into ECORESINSTANCEVALUE | **Not synced** (separate table) |
| ECORESVALUE | Has all typed value columns (TEXTVALUE, INTVALUE, etc.) | **NO** value columns |
| ECORESTEXTVALUE, ECORESINTVALUE, etc. | Flattened into ECORESVALUE | **Not synced** |

### 16.2 Table Inheritance in Dataverse

D365FO uses table inheritance where child tables extend base tables:

```
[dbo] Schema (Flattened):
ECORESINSTANCEVALUE
├── RECID
├── INSTANCERELATIONTYPE  ← Identifies child type
├── PRODUCT               ← From ECORESPRODUCTINSTANCEVALUE (flattened)
├── CHANNEL               ← From ECORESCATALOGINSTANCEVALUE (flattened)
└── ... all columns from child tables

Dataverse/[ax] Schema (Normalized):
ECORESINSTANCEVALUE (Base only)
├── RECID
├── INSTANCERELATIONTYPE
└── Base metadata columns only

ECORESPRODUCTINSTANCEVALUE (Child - often NOT synced)
├── RECID
└── PRODUCT
```

### 16.3 Key Instance Relation Types

| INSTANCERELATIONTYPE | Table/Type | Purpose |
|---------------------|------------|---------|
| 4434 | EcoResProductInstanceValue | Product attributes |
| 12538 | EcoResCatalogInstanceValue | Catalog attributes |
| 14155 | EcoResCategoryInstanceValue | Category attributes |
| 4991 | EcoResTextValue | Text value type |

### 16.4 Critical Discovery: Product Instance Value Link

**In Dataverse, when `INSTANCERELATIONTYPE = 4434`:**
```
ECORESINSTANCEVALUE.RECID = ECORESPRODUCT.RECID
```

This allows joining products to their instance values WITHOUT the PRODUCT column:

```sql
-- This works in Dataverse!
SELECT prod.displayproductnumber, piv.recid
FROM ecoresproduct prod
INNER JOIN ecoresinstancevalue piv
    ON piv.recid = prod.recid
    AND piv.instancerelationtype = 4434;
```

### 16.5 Product Attribute Query - Dataverse Version

**Working Query (without actual values):**

```sql
SELECT
    inv.itemid AS ITEMID,
    prod.displayproductnumber AS ProductNumber,
    attr.name AS SpecificationName,
    av.value AS ValueRecId  -- Reference only, not actual value
FROM inventtable inv
INNER JOIN ecoresproduct prod
    ON prod.recid = inv.product
INNER JOIN ecoresinstancevalue piv
    ON piv.recid = prod.recid
    AND piv.instancerelationtype = 4434
INNER JOIN ecoresattributevalue av
    ON av.instancevalue = piv.recid
INNER JOIN ecoresattribute attr
    ON attr.recid = av.attribute
ORDER BY inv.itemid, attr.name;
```

**Filter for specific attributes:**

```sql
-- Filter for "specification" attributes
WHERE attr.name LIKE '%specification%'
   OR attr.name LIKE '%Specification%'
```

### 16.6 Tables Required for Complete Query

To get actual specification VALUES in Dataverse, these tables must be synced:

| Table | Contains | Required For |
|-------|----------|--------------|
| ECORESTEXTVALUE | textvalue column | Text attribute values |
| ECORESINTVALUE | intvalue column | Integer attribute values |
| ECORESFLOATVALUE | floatvalue column | Decimal attribute values |
| ECORESBOOLEANVALUE | booleanvalue column | Yes/No attribute values |
| ECORESDATETIMEVALUE | datetimevalue column | Date/Time attribute values |
| ECORESCURRENCYVALUE | currencyvalue column | Currency attribute values |

**Complete Query (requires synced value tables):**

```sql
SELECT
    inv.itemid AS ITEMID,
    prod.displayproductnumber AS ProductNumber,
    attr.name AS SpecificationName,
    COALESCE(
        txtval.textvalue,
        CAST(intval.intvalue AS NVARCHAR(1999)),
        CAST(fltval.floatvalue AS NVARCHAR(1999)),
        CASE WHEN boolval.booleanvalue = 1 THEN 'Yes'
             WHEN boolval.booleanvalue = 0 THEN 'No'
             ELSE NULL END,
        CONVERT(NVARCHAR(1999), dtval.datetimevalue, 121),
        CAST(curval.currencyvalue AS NVARCHAR(1999))
    ) AS SpecificationValue
FROM inventtable inv
INNER JOIN ecoresproduct prod
    ON prod.recid = inv.product
INNER JOIN ecoresinstancevalue piv
    ON piv.recid = prod.recid
    AND piv.instancerelationtype = 4434
INNER JOIN ecoresattributevalue av
    ON av.instancevalue = piv.recid
INNER JOIN ecoresattribute attr
    ON attr.recid = av.attribute
LEFT JOIN ecorestextvalue txtval ON txtval.recid = av.value
LEFT JOIN ecoresintvalue intval ON intval.recid = av.value
LEFT JOIN ecoresfloatvalue fltval ON fltval.recid = av.value
LEFT JOIN ecoresbooleanvalue boolval ON boolval.recid = av.value
LEFT JOIN ecoresdatetimevalue dtval ON dtval.recid = av.value
LEFT JOIN ecorescurrencyvalue curval ON curval.recid = av.value
WHERE COALESCE(
    txtval.textvalue,
    CAST(intval.intvalue AS NVARCHAR(1999)),
    CAST(fltval.floatvalue AS NVARCHAR(1999)),
    CASE WHEN boolval.booleanvalue = 1 THEN 'Yes' ELSE 'No' END,
    CONVERT(NVARCHAR(1999), dtval.datetimevalue, 121),
    CAST(curval.currencyvalue AS NVARCHAR(1999))
) IS NOT NULL
ORDER BY inv.itemid, attr.name;
```

### 16.7 On-Premises SQL Query ([dbo] Schema)

For on-premises or cloud-hosted environments with [dbo] schema:

```sql
SELECT
    inv.ITEMID,
    prod.DISPLAYPRODUCTNUMBER AS ProductNumber,
    attr.NAME AS SpecificationName,
    COALESCE(
        val.TEXTVALUE,
        CAST(val.INTVALUE AS NVARCHAR(1999)),
        CAST(val.FLOATVALUE AS NVARCHAR(1999)),
        CASE WHEN val.BOOLEANVALUE = 1 THEN 'Yes'
             WHEN val.BOOLEANVALUE = 0 THEN 'No'
             ELSE NULL END,
        CONVERT(NVARCHAR(1999), val.DATETIMEVALUE, 121),
        CAST(val.CURRENCYVALUE AS NVARCHAR(1999))
    ) AS SpecificationValue
FROM [dbo].INVENTTABLE inv
INNER JOIN [dbo].ECORESPRODUCT prod
    ON prod.RECID = inv.PRODUCT
INNER JOIN [dbo].ECORESINSTANCEVALUE piv
    ON piv.PRODUCT = prod.RECID  -- PRODUCT column exists in [dbo]!
INNER JOIN [dbo].ECORESATTRIBUTEVALUE av
    ON av.INSTANCEVALUE = piv.RECID
INNER JOIN [dbo].ECORESATTRIBUTE attr
    ON attr.RECID = av.ATTRIBUTE
INNER JOIN [dbo].ECORESVALUE val
    ON val.RECID = av.VALUE  -- All value columns in single table!
ORDER BY inv.ITEMID, attr.NAME;
```

### 16.8 Diagnostic Queries for Dataverse

**Check available columns:**
```sql
SELECT COLUMN_NAME, DATA_TYPE
FROM INFORMATION_SCHEMA.COLUMNS
WHERE TABLE_NAME = 'ecoresinstancevalue'
ORDER BY ORDINAL_POSITION;
```

**Check if table is synced:**
```sql
SELECT COUNT(*) FROM ecoresproductinstancevalue;  -- 0 = not synced
```

**Check available schemas:**
```sql
SELECT DISTINCT TABLE_SCHEMA
FROM INFORMATION_SCHEMA.TABLES
ORDER BY TABLE_SCHEMA;
```

**Sample data with instance types:**
```sql
SELECT TOP 10 recid, instancerelationtype, partition
FROM ecoresinstancevalue
ORDER BY instancerelationtype;
```

### 16.9 Dataverse Sync Configuration

To enable complete product attribute queries, add these tables to Synapse Link:

1. Navigate to **Power Platform Admin Center**
2. Select your environment
3. Go to **Azure Synapse Link for Dataverse**
4. Click **Manage tables**
5. Add the following tables:
   - `msdyn_ecorestextvalue`
   - `msdyn_ecoresintvalue`
   - `msdyn_ecoresfloatvalue`
   - `msdyn_ecoresbooleanvalue`
   - `msdyn_ecoresdatetimevalue`
   - `msdyn_ecorescurrencyvalue`

### 16.10 Common Dataverse Query Errors

| Error | Cause | Solution |
|-------|-------|----------|
| `Invalid column name 'PRODUCT'` | ECORESINSTANCEVALUE doesn't have PRODUCT in Dataverse | Use `piv.recid = prod.recid AND piv.instancerelationtype = 4434` |
| `Invalid column name 'TEXTVALUE'` | ECORESVALUE doesn't have value columns in Dataverse | Sync ECORESTEXTVALUE table or use ValueRecId only |
| `Invalid object name 'ECORESPRODUCTINSTANCEVALUE'` | Table not synced to Dataverse | Add to Synapse Link configuration |
| `Partitioning column 'PartitionId' not found` | Delta lake warning | Can be ignored, doesn't affect query |

