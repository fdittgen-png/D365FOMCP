# Part 26: InventItemPrice — Standard Costing Architecture

_Reference for the `d365fo-analysis` skill. Read on demand._


### 26.1 Overview

`InventItemPrice` stores **active** (posted) item cost prices per costing version. Prices start as **pending** in `InventItemPriceSim` and are moved to `InventItemPrice` by the "Activate pending prices" process. This is foundational for standard cost accounting and inventory valuation.

### 26.2 Table Architecture

```
InventItemPriceSim (Pending prices)
    ↓ Activation process
InventItemPrice (Active prices)
    ↓ Used by
InventTrans costing, Inventory close, BOM calculation
```

**Per-company table** (DATAAREAID). Each record represents one active price for a specific combination of:
- ItemId + InventDimId (item + site/warehouse)
- VersionId (costing version, e.g., 'STD-1')
- PriceType (0=Cost, 1=Sales, 2=Transfer)
- ActivationDate (when price takes effect)

### 26.3 Primary Key — 8-Column Composite (Critical Knowledge)

```
PARTITION, DATAAREAID, ITEMID, INVENTDIMID, PRICETYPE,
ACTIVATIONDATE, CREATEDDATETIME, LASTPRICEUNIQUENESSALLOWANCE
```

The `LASTPRICEUNIQUENESSALLOWANCE` field is a **GUID (uniqueidentifier)**, unique per record. It exists specifically to make every row unique regardless of other field combinations.

**Implications:**
1. **PK collision from ActivationDate changes is structurally impossible** — the GUID guarantees uniqueness
2. **Duplicate active prices for same Item+Dim+Date ARE allowed** at SQL level — the table does NOT enforce business-level uniqueness on (ItemId, InventDimId, PriceType, VersionId, ActivationDate) alone
3. **Re-activating the same items creates ADDITIONAL records**, not overwrites — each activation generates new rows with new GUIDs

### 26.4 Price Resolution — Tie-Breaking on Duplicates

When multiple active prices exist for the same logical combination (Item+Dim+PriceType+Version) at the same ActivationDate:

```
Resolution order: ACTIVATIONDATE DESC → CREATEDDATETIME DESC → RECID DESC
```

**The most recently created record wins.** Older duplicates become data waste — never selected by the costing engine but permanently occupying table space.

### 26.5 Duplicate Active Price Risk

**When this occurs:**
- Bulk ActivationDate corrections that merge multiple source dates into one target date
- Re-running costing version activation for items that already have active prices at the target date
- Custom scripts that update ActivationDate without first checking/deleting existing records

**Example scenario:**
```
Before script:
  Item X, S-LADE-2: ActivePrice at 03/05 (Created 03/05, GUID-A)
  Item X, S-LADE-2: ActivePrice at 03/09 (Created 03/09, GUID-B)

After script (both moved to 02/28):
  Item X, S-LADE-2: ActivePrice at 02/28 (Created 03/05, GUID-A) ← orphan
  Item X, S-LADE-2: ActivePrice at 02/28 (Created 03/09, GUID-B) ← winner (latest)
```

**Impact:** Functionally harmless (correct price used), but creates data waste. Cleanup with DELETE of `rn > 1` records recommended.

### 26.6 Non-Existent Fields (Hallucination Prevention)

| Field | Status |
|-------|--------|
| CREATEDBY | Does NOT exist |
| MODIFIEDBY | Does NOT exist |
| PRICEACTIVE | Does NOT exist — all records in this table ARE active |
| PENDING | Wrong table — pending prices are in `InventItemPriceSim` |

### 26.7 X++ Activation Process

The activation is performed by class `InventItemPriceActivationManager`:

```x++
// Standard activation flow
InventItemPriceActivationManager manager = InventItemPriceActivationManager::construct();
manager.activate(versionId, activationDate);
// Creates new InventItemPrice records from InventItemPriceSim
// Each record gets a new GUID in LASTPRICEUNIQUENESSALLOWANCE
```

### 26.8 Custom Script Pattern — Safe Date Correction

When correcting ActivationDates via Custom Scripts, consider:

1. **UPDATE mode** (change date): Safe from PK collisions due to GUID, but creates duplicates if records at target date already exist
2. **DELETE mode** (remove wrong records): Clean approach, then re-activate with correct date
3. **Best practice**: DELETE wrong records first, then re-activate from pending prices with correct date

**When using UPDATE mode with multiple source dates → single target date:**
- Process each source date separately
- After all updates, run duplicate detection query
- Clean up orphans (older CreatedDateTime duplicates)

### 26.9 Data Volumes (Typical)

For a company with ~14,000 items across 2 sites:
- **~28,000 records per activation date** (1 per item × 2 sites)
- Batch activation creates records in bursts over ~30 minutes
- CREATEDDATETIME has ~1,500-2,000 distinct second-values across 28,000 records

