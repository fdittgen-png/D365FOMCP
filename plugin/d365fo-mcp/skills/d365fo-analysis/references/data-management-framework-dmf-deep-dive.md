# Part 15: Data Management Framework (DMF) Deep Dive

_Reference for the `d365fo-analysis` skill. Read on demand._


### 15.1 DMF Architecture Overview

**Key Tables:**

| Table | Purpose | Scope |
|-------|---------|-------|
| **DMFEntity** | Global entity configuration | Framework-level (all projects) |
| **DMFDefinitionGroupEntity** | Project-level entity mapping | Per data project |
| **DMFDefinitionGroup** | Data project definition | Per project |
| **DMFDefinitionGroupExecution** | Execution tracking | Per execution |
| **DMFEntityExecutionParameters** | Entity-specific parameters | Per entity |
| **DMFDataSourceProperties** | Data source configuration | Per source |
| **[Entity]Staging** | Staging table for each entity | Per entity |

**Key Classes:**

| Class | Purpose | Key Methods |
|-------|---------|-------------|
| **DMFEntityWriter** | Writes staging data to target | `writeV2()`, `processRecords()` |
| **DMFEntityBase** | Base entity operations | `copyStagingToTarget()`, `preTargetSetBased()` |
| **DMFDataPopulation** | Entity list management | `bulkCreateEntities()` |
| **DMFDelegates** | Event delegates | `isTargetSetBasedByDefault()` |

### 15.2 Set-Based Processing Architecture

**Critical Design Issue:** Set-based processing is controlled ONLY at the framework/entity level, NOT per project.

**Data Flow:**

```
DMFEntity (Framework Level)
├── TargetIsSetBased: NoYes       ← Only location of this setting!
├── EntityName
├── TargetEntity
└── EntityTable

DMFDefinitionGroupEntity (Project Level)
├── DefinitionGroup
├── Entity → Links to DMFEntity.EntityName
├── RunInsertLogic: NoYes
├── RunValidateField: NoYes
├── RunValidateWrite: NoYes
├── SkipStaging: NoYes
└── ... (NO TargetIsSetBased field!)
```

### 15.3 DMFEntityWriter.writeV2() Decision Logic

**File:** `ApplicationFoundation\ApplicationFoundation\AxClass\DMFEntityWriter.xml`

```x++
// Line 2436 - The critical decision point
if (_entity.ParentEntityName == '' && _entity.TargetIsSetBased)
{
    // SET-BASED PATH
    // Uses direct SQL INSERT/UPDATE statements
    // entityClass.copyStagingToTarget() is called

    _definitionGroupExecution.TelemetryRuntimeInfo('EntitySetBasedOptionEnabled')
}
else
{
    // ROW-BY-ROW PATH
    // Processes records one at a time
    // this.processRecords() is called

    _definitionGroupExecution.TelemetryRuntimeInfo('EntitySetBasedOptionDisabled')
}
```

**Key Observation:** The `_entity` parameter is of type `DMFEntity` (framework table), NOT `DMFDefinitionGroupEntity` (project table).

### 15.4 Why Project-Level Settings Are Ignored

**Root Cause Analysis:**

1. **No Override Field Exists:**
   - `DMFDefinitionGroupEntity` does NOT have a `TargetIsSetBased` field
   - Project-level configuration cannot override the entity-level setting

2. **UI vs. Reality:**
   - The project UI may show a set-based toggle
   - This likely reads/writes directly to `DMFEntity` (global)
   - Changes affect ALL projects using that entity

3. **Code Path:**
   ```
   DMFEntityWriter.writeV2()
       │
       ├── Receives: DMFEntity _entity
       │
       └── Checks: _entity.TargetIsSetBased
                   ↑
                   └── From DMFEntity table (global)
                       NOT from DMFDefinitionGroupEntity (project)
   ```

### 15.5 Set-Based Processing Initialization

**File:** `DMFDataPopulation.xml` - Line 1842

```x++
// During entity list refresh:
dmfTmpEntityList.TargetIsSetBased = DMFDelegates::isTargetSetBasedByDefault(dmfTmpEntityList.TargetEntity);
```

**File:** `DMFDelegates.xml` - Line 228

```x++
public static boolean isTargetSetBasedByDefault(QueryName _targetEntity)
{
    EventHandlerResult eventResult = new EventHandlerResult();
    DMFDelegates::isTargetSetBasedByDefaultDelegate(_targetEntity, eventResult);

    if (eventResult.hasResult())
    {
        return eventResult.result();
    }
    else
    {
        return false;  // Default: Set-based DISABLED
    }
}
```

### 15.6 Entity View INSTEAD OF Trigger Issue

**Problem:** Complex data entities with multiple data sources create SQL views with INSTEAD OF triggers.

**Example Error:**
```sql
UPDATE is not allowed because the statement updates view "ASSETFIXEDASSETV2ENTITY"
which participates in a join and has an INSTEAD OF UPDATE trigger.
```

**Why It Happens:**
1. Entity has `SupportsSetBasedSqlOperations = Yes` in metadata
2. Set-based mode generates direct SQL UPDATE from staging to entity view
3. SQL Server rejects UPDATE on views with:
   - INSTEAD OF triggers
   - JOIN to other tables

**Affected Entity Characteristics:**
- Multiple outer-joined data sources (e.g., 11+ tables)
- Complex relationships requiring INSERT/UPDATE triggers
- Views that don't support direct UPDATE

### 15.7 Solutions for Set-Based Processing Issues

#### Solution 1: Framework-Level Disable (Recommended)

**Path:** Data Management > Framework parameters > Entity settings

```
1. Find entity: "Fixed assets V2 entity"
2. Set "Disable set-based SQL operations" = Yes
3. Save
```

**Effect:** Applies to ALL projects using this entity.

#### Solution 2: Verify via SQL

```sql
-- Check current set-based setting for an entity
SELECT EntityName, TargetEntity, TargetIsSetBased
FROM DMFEntity
WHERE EntityName = 'Fixed assets V2 entity';
```

#### Solution 3: X++ Update

```x++
// Programmatically disable set-based
ttsbegin;
DMFEntity dmfEntity = DMFEntity::find('Fixed assets V2 entity', true);
dmfEntity.TargetIsSetBased = NoYes::No;
dmfEntity.update();
ttscommit;
```

### 15.8 DMF Configuration Hierarchy

```
Level 1: Entity Metadata (AOT)
├── SupportsSetBasedSqlOperations: Yes/No
└── Cannot be changed at runtime

Level 2: DMFEntity Table (Framework)
├── TargetIsSetBased: Yes/No
├── Configurable via Framework Parameters
└── Affects ALL projects using this entity

Level 3: DMFDefinitionGroupEntity (Project) ← MISSING SET-BASED!
├── RunInsertLogic, RunValidateField, RunValidateWrite
├── SkipStaging
└── No TargetIsSetBased override exists!

Level 4: Execution Parameters
├── Threshold counts
├── Parallel task settings
└── No set-based override
```

### 15.9 Key DMF Tables Field Reference

**DMFEntity (Framework Level):**
| Field | Type | Purpose |
|-------|------|---------|
| EntityName | String | Unique entity identifier |
| TargetEntity | QueryName | Target data entity view |
| EntityTable | String | Staging table name |
| **TargetIsSetBased** | NoYes | Set-based processing flag |
| EntityType | DMFEntityTypes | Entity/Composite |
| DMFChangeTrackingType | Enum | Change tracking mode |

**DMFDefinitionGroupEntity (Project Level):**
| Field | Type | Purpose |
|-------|------|---------|
| DefinitionGroup | String | Project name |
| Entity | String | Entity name (FK to DMFEntity) |
| Source | String | Data source |
| Sequence | Int | Processing order |
| RunInsertLogic | NoYes | Run insert events |
| RunValidateField | NoYes | Validate fields |
| RunValidateWrite | NoYes | Validate on write |
| SkipStaging | NoYes | Skip staging table |
| ExecutionUnit | Int | Parallel unit |
| LevelInExecutionUnit | Int | Level within unit |

### 15.10 DMF Troubleshooting

| Issue | Cause | Solution |
|-------|-------|----------|
| "UPDATE not allowed on view with INSTEAD OF trigger" | Set-based enabled on complex entity | Disable at framework level |
| Project set-based setting ignored | No project-level override exists | Use framework-level setting |
| Records not processing | Staging status stuck | Check DMFStagingValidationLog |
| Parallel tasks fail with set-based | Incompatible configuration | Disable either set-based or parallel |

### 15.11 File Locations for DMF Analysis

| Component | Path |
|-----------|------|
| DMF Core Classes | `ApplicationFoundation\ApplicationFoundation\AxClass\DMF*.xml` |
| DMF Tables | `ApplicationFoundation\ApplicationFoundation\AxTable\DMF*.xml` |
| DMF Forms | `ApplicationFoundation\ApplicationFoundation\AxForm\DMF*.xml` |
| Fixed Asset Entity | `ApplicationSuite\Foundation\AxDataEntityView\AssetFixedAssetV2Entity.xml` |

### 15.12 Empty Cells, Zero Values, and Blank Handling in DMF Import

#### 15.12.1 The Import Chain: Excel/CSV → Staging → Target

When importing data via DMF (Excel, CSV, XML), values go through this pipeline:

```
Source file (Excel/CSV)
   ↓ (1) File parser (SSIS)
Staging table ([Entity]Staging)
   ↓ (2) isFieldSet() check in persister
   ↓ (3) mapEntityToDataSource()
Target table(s) (e.g., InventTable)
```

**Critical behavior at each stage:**

| Stage | Empty Cell (no value) | Explicit `0` | Column Removed from Mapping |
|-------|----------------------|--------------|----------------------------|
| **(1) File → Staging** | Integer → `0`, String → `""`, Date → null date | Integer → `0` | Column not in staging |
| **(2) isFieldSet()** | Returns **true** (column exists in mapping) | Returns **true** | Returns **false** |
| **(3) → Target** | **Overwrites** with default (0, "", etc.) | **Overwrites** with 0 | **Preserves** existing value |

#### 15.12.2 Why Empty Cells Are Destructive for Integer Fields

For integer fields (e.g., `PdsShelfLife`, `PdsBestBefore`, `PdsShelfAdvice`, quantity fields, lead time fields), the DMF framework has **no concept of NULL**:

- X++ integer type defaults to `0` — there is no distinction between "not provided" and "zero"
- The SSIS file parser writes `0` into the staging table for empty integer cells
- `isFieldSet()` checks whether the **column exists in the field mapping**, not whether the value is non-zero
- The persister maps the `0` to the target table, overwriting any existing non-zero value

**Consequence:** An empty cell in an Excel import template silently overwrites existing data with the type default.

#### 15.12.3 Behavior by Data Type

| Data Type | Empty Cell in Excel | Staging Table Value | Target Impact |
|-----------|-------------------|-------------------|---------------|
| **Integer** (`int`) | Empty | `0` | Overwrites with 0 |
| **Real** (`real`) | Empty | `0.0` | Overwrites with 0.0 |
| **String** (`str`) | Empty | `""` (empty string) | Overwrites with empty string |
| **Date** (`date`) | Empty | `1900-01-01` (null date) | Overwrites with null date |
| **Enum** (`enum`) | Empty | `0` (first enum value) | Overwrites with first enum value |
| **Int64** (`int64`) | Empty | `0` | Overwrites with 0 |

#### 15.12.4 The `isFieldSet()` Framework Method

The entity persister (generated code) uses `isFieldSet()` to determine whether to apply a value:

```x++
// Generated persister pattern:
if (_entity.isFieldSet(fieldnum(EntityName, FieldName)))
{
    return true;  // → field WILL be mapped to target
}
```

**Key rules:**
- Column **present** in mapping + any value (including 0/empty) → `isFieldSet()` = **true** → value applied
- Column **absent** from mapping → `isFieldSet()` = **false** → existing value preserved
- `isFieldSet()` does NOT evaluate the value itself, only column presence

#### 15.12.5 "Ignore Blank Values" — Mapping Configuration

**No standard built-in "ignore blank values" checkbox exists at the DMF project level.** This is a common misconception.

What **does** exist:

| Configuration | Location | What It Does |
|--------------|----------|--------------|
| **Remove column from mapping** | Data project > View map > Mapping details | Unmapped fields are skipped entirely (`isFieldSet() = false`) |
| **Remove column from file** | Source Excel/CSV | Same effect — column not in staging |
| **Default value in mapping** | Data project > View map > Mapping details > Default value | Replaces empty/missing source values with a specified default |
| **RunValidateField** | DMFDefinitionGroupEntity | Enables/disables field-level validation (does NOT skip blanks) |
| **RunValidateWrite** | DMFDefinitionGroupEntity | Enables/disables record-level validation |
| **Custom `mapEntityToDataSource`** | CoC extension on entity class | X++ code to conditionally skip blank values |

#### 15.12.6 Prevention Strategies

**Strategy 1: Remove columns from mapping (Recommended)**

If you don't need to update certain fields, remove them entirely:
1. Data Management workspace → Open import project
2. Select entity → **View map**
3. Switch to **Mapping details** tab
4. Select the field → **Delete selection** → **Save**

This is the safest approach — `isFieldSet()` returns false for unmapped fields.

**Strategy 2: Export-Modify-Import workflow**

1. Export current data using the same entity
2. Modify only the columns you need to update
3. Re-import — all other columns retain their current values

**Strategy 3: Custom CoC extension on entity**

```x++
[ExtensionOf(dataentityviewstr(EcoResReleasedProductV2Entity))]
final class MyEntity_Extension
{
    public void mapEntityToDataSource(
        DataEntityRuntimeContext _entityCtx,
        DataEntityDataSourceRuntimeContext _dataSourceCtx)
    {
        next mapEntityToDataSource(_entityCtx, _dataSourceCtx);

        if (_entityCtx.getDatabaseOperation() == DataEntityDatabaseOperation::Update)
        {
            InventTable inventTable = _dataSourceCtx.getBuffer();
            InventTable inventTableOrig = inventTable.orig();

            // Preserve existing shelf life if incoming value is 0
            if (inventTable.PdsShelfLife == 0 && inventTableOrig.PdsShelfLife != 0)
            {
                inventTable.PdsShelfLife = inventTableOrig.PdsShelfLife;
            }
        }
    }
}
```

**Warning:** Strategy 3 introduces ambiguity — the system can no longer distinguish between "intentionally set to 0" and "empty cell in import file". Use only when you are certain that 0 is never a valid intended value.

#### 15.12.7 Practical Impact Matrix — Common Fields

| Field | Type | Empty Cell Result | Business Impact |
|-------|------|------------------|-----------------|
| `PdsShelfLife` / ShelfLifePeriodDays | int | 0 → shelf life disabled | Batch expiration dates no longer calculated |
| `PdsBestBefore` / BestBeforePeriodDays | int | 0 → best-before disabled | FEFO picking ignores best-before |
| `PdsShelfAdvice` / ShelfAdvicePeriodDays | int | 0 → no shelf advice | Quality orders not triggered |
| `StandardQuantity` | real | 0.0 | BOM/formula quantity zeroed |
| `NetWeight` / `TaraWeight` | real | 0.0 | Weight-based logistics broken |
| `LeadTimePurchase` | int | 0 | Master planning lead times wrong |
| Enum fields (e.g., `ItemType`) | enum | First enum value | Misclassification |
| `PrimaryVendorId` | string | "" (empty) | Primary vendor cleared |

#### 15.12.8 Troubleshooting: "Did the import clear my data?"

**Diagnosis steps:**
1. Check the **staging table** (`[Entity]Staging`) — look at the value that was written:
   ```sql
   SELECT ShelfLifePeriodDays, BestBeforePeriodDays, ShelfAdvicePeriodDays
   FROM EcoResReleasedProductV2Staging
   WHERE ItemNumber = 'YOUR_ITEM' AND DefinitionGroup = 'YOUR_PROJECT';
   ```
2. If staging shows `0` and the source Excel cell was empty → confirmed: empty cell caused the overwrite
3. Check `DMFStagingValidationLog` for any validation warnings

**Recovery:**
- Re-import with the correct values from a backup/export
- Or update directly via the entity/form with the original values

#### 15.12.9 Key Rules Summary

1. **Empty cell = type default** — for integers this means `0`, for strings `""`, for dates null date
2. **Column in mapping = field is set** — regardless of value, `isFieldSet()` returns true
3. **Column removed = field preserved** — only way to guarantee no overwrite
4. **No native "ignore blank" toggle** — must use mapping removal, custom code, or export-modify-import
5. **Affects both Insert and Update** — on insert, empty cells set initial values to defaults; on update, they overwrite existing values
6. **Set-based vs. row-by-row** — behavior is consistent across both processing modes for blank handling

---

### 15.13 DMF import gotchas (learned 2026-08-20, Registration-IDs remediation)

1. **Country/region-gated entities fail SILENTLY in DMF.** An entity with `CountryRegionCodes` (e.g. `TaxRegistrationOnVendorEntity` = TH) evaluated against the session company's country: "Generate source mapping" reports *"mapping has completed successfully"* but draws NO lines, and "Add file" errors with *"Entity … is not enabled for country/region"*. If auto-mapping is a no-op, grep the entity XML for `<CountryRegionCodes>` before debugging the file.
2. **Auto-mapping needs source column names = staging field names exactly** (all fields you send; case-insensitive). Excel is the most reliable auto-map source; CSV auto-map can no-op even with identical names. Mapping is discarded when a new file/format is uploaded — re-check after every file swap.
3. **Staging unique keys can EXCLUDE business keys.** Example: registration staging key = COUNTRYREGIONID+REGISTRATIONNUMBER+VALIDFROM (+DEFINITIONGROUP/EXECUTIONID) — NOT the vendor account. Two vendors sharing a value collide within one execution regardless of file format (XML changes nothing). Fix: stagger a key field (e.g. ValidFrom −1 day per duplicate) or split into one execution per occurrence rank.
4. **Run the import with the session in the TARGET legal entity.** Entities whose `mapEntityToDataSource` does company-scoped lookups (VendTable etc.) resolve against the session company — importing from DAT produces "Party/Location must be filled in" on every row even though staging succeeded. The project's owning company is irrelevant; the session company at execution time counts.
5. **Re-running staging-to-target on date-effective targets creates split timelines, not errors.** Two completed copy-to-target runs of the same registration rows produced per-record pairs (1900→yesterday expired + today→never current). Harmless for resolution (current row wins) but lookups then show two rows and users can pick the expired one.
6. **"Validate all" surfaces the real per-record errors** that the job-level status hides; the fix loop is: correct data/master data → re-run *Copy data to target* on error rows only (staging survives; new upload only needed when the file values themselves were wrong).
