# Part 7: InventItemPrice — Active Cost Prices (Verified)

_Reference for the `d365fo-sql-direct-queries` skill. Read on demand._


### 7.1 Table Overview

`INVENTITEMPRICE` stores active (posted) item cost prices per costing version. This is one of the most critical tables for standard costing and inventory valuation.

**Key characteristics:**
- Per-company table (`DATAAREAID`)
- Each record = one active price for a specific Item + InventDim + PriceType + CostingVersion + ActivationDate
- Prices are created by the "Activate pending prices" process from `InventItemPriceSim` (pending prices)

### 7.2 Columns (Verified against 10.0.2263.172)

| Column | Type | Purpose |
|--------|------|---------|
| ITEMID | nvarchar(40) | Item ID |
| INVENTDIMID | nvarchar(200) | FK to InventDim (site, warehouse, etc.) |
| VERSIONID | nvarchar(20) | Costing version ID (e.g., 'STD-1') |
| PRICETYPE | int | 0=Cost, 1=Sales, 2=Transfer |
| ACTIVATIONDATE | datetime | Date the price became active |
| PRICE | numeric | Unit price |
| PRICEUNIT | numeric | Price unit (quantity denominator) |
| MARKUP | numeric | Markup amount |
| COSTINGTYPE | int | 2=Standard cost (common for STD versions) |
| UNITID | nvarchar(20) | Unit of measure |
| PRICECALCID | nvarchar(200) | BOM calculation ID (if from BOM calc) |
| PRICEQTY | numeric | Price quantity |
| PRICEALLOCATEMARKUP | int | Markup allocation flag |
| STDCOSTTRANSDATE | datetime | Standard cost transaction date |
| STDCOSTVOUCHER | nvarchar(200) | Standard cost voucher |
| CREATEDDATETIME | datetime | Record creation timestamp |
| MODIFIEDDATETIME | datetime | Last modification timestamp |
| LASTPRICEUNIQUENESSALLOWANCE | uniqueidentifier | GUID ensuring PK uniqueness (see 7.3) |
| RECID | bigint | Unique record ID |

**Fields that do NOT exist on InventItemPrice:**
| Hallucinated Field | Reality |
|--------------------|---------|
| CREATEDBY | Does not exist |
| MODIFIEDBY | Does not exist |
| PRICEACTIVE | No such flag — all records in this table ARE active |
| PENDING | Pending prices are in `InventItemPriceSim`, not here |

### 7.3 Primary Key — 8-Column Composite (Critical)

```
PARTITION, DATAAREAID, ITEMID, INVENTDIMID, PRICETYPE,
ACTIVATIONDATE, CREATEDDATETIME, LASTPRICEUNIQUENESSALLOWANCE
```

**The `LASTPRICEUNIQUENESSALLOWANCE` field is a GUID (`uniqueidentifier`)**, unique per record. It exists specifically to prevent PK collisions when ActivationDate is changed. This means:
- Two records for the same Item+Dim+PriceType at different dates can safely be moved to the same date
- PK collision from date changes is **structurally impossible** due to the GUID
- However, this also means **duplicate active prices** for the same Item+Dim at the same date are allowed at the SQL level

**RecId index:** Secondary unique nonclustered index `I_15160RECID` on `RECID` alone.

### 7.4 Price Resolution Logic — Tie-Breaking

When multiple active prices exist for the same Item+InventDimId+PriceType+VersionId at the same ActivationDate, D365FO resolves the tie via:

```
ORDER BY ACTIVATIONDATE DESC, CREATEDDATETIME DESC, RECID DESC
```

The **most recently created** record wins. This means orphaned duplicate records (older CreatedDateTime) are ignored by the costing engine but remain in the table as data waste.

### 7.5 Duplicate Detection Query

After bulk date changes, detect orphaned duplicates:

```sql
;WITH Duplicates AS (
    SELECT
        RECID,
        ITEMID,
        INVENTDIMID,
        PRICETYPE,
        ACTIVATIONDATE,
        CREATEDDATETIME,
        PRICE,
        ROW_NUMBER() OVER (
            PARTITION BY ITEMID, INVENTDIMID, PRICETYPE, VERSIONID, ACTIVATIONDATE
            ORDER BY CREATEDDATETIME DESC, RECID DESC
        ) AS rn
    FROM INVENTITEMPRICE WITH (NOLOCK)
    WHERE DATAAREAID = 'lade'
      AND VERSIONID = 'STD-1'
      AND ACTIVATIONDATE = '2026-02-28'
)
SELECT * FROM Duplicates WHERE rn > 1;  -- These are orphans (never selected by costing engine)
```

### 7.6 Relationship to InventDim

Always join via composite key:
```sql
JOIN INVENTDIM ID WITH (NOLOCK)
    ON ID.INVENTDIMID = IP.INVENTDIMID
    AND ID.DATAAREAID = IP.DATAAREAID
    AND ID.PARTITION = IP.PARTITION
```

Site filtering is via InventDim:
```sql
WHERE ID.INVENTSITEID IN ('S-LADE-2', 'S-LADE-3')
```

### 7.7 Template Query — Active Prices by Site

```sql
DECLARE @Company NVARCHAR(4) = 'lade';
DECLARE @VersionId NVARCHAR(20) = 'STD-1';
DECLARE @ActivationDate DATE = '2026-02-28';

SELECT
    IP.ITEMID,
    IP.INVENTDIMID,
    IP.PRICETYPE,
    IP.ACTIVATIONDATE,
    IP.PRICE,
    IP.PRICEUNIT,
    IP.UNITID,
    IP.COSTINGTYPE,
    IP.CREATEDDATETIME,
    IP.LASTPRICEUNIQUENESSALLOWANCE,
    IP.RECID,
    ID.INVENTSITEID,
    ID.INVENTLOCATIONID
FROM INVENTITEMPRICE IP WITH (NOLOCK)
JOIN INVENTDIM ID WITH (NOLOCK)
    ON ID.INVENTDIMID = IP.INVENTDIMID
    AND ID.DATAAREAID = IP.DATAAREAID
    AND ID.PARTITION = IP.PARTITION
WHERE IP.DATAAREAID = @Company
  AND IP.VERSIONID = @VersionId
  AND IP.ACTIVATIONDATE = @ActivationDate
ORDER BY IP.ITEMID, ID.INVENTSITEID;
```

### 7.8 Key Observations (Verified March 2026)

1. **1 item = 1 record per site per date per PriceType** in normal operations. Each site gets its own InventDimId, so S-LADE-2 and S-LADE-3 are separate records
2. **Batch activation creates records in bursts** — CREATEDDATETIME clusters around the activation batch runtime (e.g., 1,978 distinct second-values across 28,604 records in a 33-minute window)
3. **LASTPRICEUNIQUENESSALLOWANCE is always unique** — verified 28,604 distinct GUIDs across 28,604 records (100% unique)
4. **Re-activating the same items creates ADDITIONAL records**, not overwrites. Each activation run creates new rows with new GUIDs and new CreatedDateTime values
5. **InventItemPriceSim** is the pending/simulated price table (same structure minus the activation columns). Activation moves records from Sim to active

---

*Skill verified against D365FO 10.0.2263.172 metadata and live database on 2026-02-23.*
*InventItemPrice section added and verified against PPROD database on 2026-03-09.*
*§1.5 (read-only on cloud PROD) and sales-order hold tables (MCROrderStopped / MCROrderEventTable) added 2026-06-30 from the SO-005961 "Do not process" orphaned-flag case.*
*Last updated: June 30, 2026*

