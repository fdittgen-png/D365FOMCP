# Part 19: Custom Scripts Feature (AppConsistencyCustomScript)

_Reference for the `d365fo-analysis` skill. Read on demand._


### 19.1 Feature Overview

The Custom Scripts feature allows uploading and executing X++ runnable classes without full deployment. Introduced in version 10.0.27, it provides a controlled mechanism for data corrections with full audit trail.

**Menu Path:** `System Administration > Periodic Tasks > Database > Custom Scripts`

**Feature Flight:** `AppConsistencyCustomScriptFlight` (must be enabled via Flighting)

### 19.2 Core Components

**Model Location:** `PackagesLocalDirectory\AppTroubleshooting\AppTroubleshooting\`

| Component | Type | Purpose |
|-----------|------|---------|
| AppConsistencyCustomScript | Table | Stores script metadata, status, logs |
| AppConsistencyCustomScriptFile | Class | File extraction, assembly loading, execution |
| AppConsistencyCustomScriptStateChange | Class | Workflow state transitions |
| AppConsistencyCustomScriptUploadStrategy | Class | File upload with anti-malware |
| AppConsistencyCustomScriptListPage | Form | Main management UI |
| AppConsistencyCustomScriptUpload | Form | Upload dialog |
| AppConsistencyCustomScriptDetails | Form | Details and workflow actions |

### 19.3 Workflow States

```
None (internal)
  ↓
Uploaded → Rejected
  ↓         ↓
Approved → Abandoned
  ↓
Tested → Abandoned
  ↓
ReadyForExecution → Abandoned
  ↓
Executed
  ├→ Verified
  └→ VerificationFailed
```

**Key Constraints:**
- Segregation of Duties: Uploader cannot approve their own script
- Test runs abort transactions (no data changes)
- Production runs commit transactions

### 19.4 Upload Mechanism

**File Structure Required:**
```
uploaded.zip
└── AOSService/Packages/files/
    └── nested.zip
        └── bin/
            └── [EXACTLY ONE .dll]
```

**Validation Rules:**
- Exactly ONE DLL file in bin/ folder
- Exactly ONE X++ class in `Dynamics.AX.Application` namespace
- Class must have `public static void main(Args _args)` method
- Anti-malware scanning enabled

**Storage:** DMF temporary storage via `SharedServiceUnitFileID`

### 19.5 Table Protection

Custom scripts have restricted access to certain tables:

**Protected Tables (CUD blocked by default):**
- BankChequeTable
- CustSettlement
- VendSettlement
- BankDepositDocument
- BankDeposit
- BankTransSummarizationDocument
- BankTransSummarizationLine

**Override Flight:** `AppConsistencyCustomScriptAllow[TableName]`

**Extension Point:**
```x++
// Subscribe to add custom protection
[SubscribesTo(classStr(AppConsistencyCustomScriptTableProtector),
              delegateStr(AppConsistencyCustomScriptTableProtector, canScriptAccessTable))]
public static void preventCustomTableAccess(
    TableName _tableName,
    str _accessType,
    EventHandlerRejectResult _result)
{
    if (_tableName == tableStr(MyProtectedTable) && _accessType != 'Read')
    {
        _result.reject();
    }
}
```

### 19.6 Execution Logging

**Captured Information:**
- All SQL statements executed (via ETL trace)
- Table access counts (read, insert, update, delete)
- Infolog messages
- Execution timestamps
- Errors and exceptions

**Audit Log Category:** `AppConsistencyCustomScript`

### 19.7 Key Class Methods

**AppConsistencyCustomScript (Table):**
| Method | Purpose |
|--------|---------|
| `create()` | Factory method to create from uploaded file |
| `isStateChangeAllowed()` | Validates workflow transitions |
| `assertSegregationOfDuties()` | Enforces SOX compliance |
| `appendToLog()` | Adds timestamped log entries |

**AppConsistencyCustomScriptFile:**
| Method | Purpose |
|--------|---------|
| `newFromFileId()` | Factory from file ID |
| `executeScript()` | Invokes main() via reflection |
| `findInvokableClass()` | Validates assembly structure |
| `loadAssembly()` | Loads .NET assembly |

**AppConsistencyCustomScriptStateChange:**
| Method | Purpose |
|--------|---------|
| `main()` | Entry point from menu items |
| `process()` | Runs script with tracing |
| `transitionState()` | Commits status change |
| `assertAccessIsSupported()` | Validates table access |

### 19.8 Automation Possibilities

**⚠️ NO API EXISTS for automated upload.**

| Method | Feasibility | Notes |
|--------|-------------|-------|
| OData/Data Entity | ❌ Not possible | No data entity exists |
| Custom Service | ⚠️ Requires development | Build custom X++ service |
| LCS Deployment | ✅ Supported | Deploy as regular package |
| Browser Automation | ⚠️ Fragile | Selenium/Playwright |
| Direct DB Insert | ❌ Not recommended | Bypasses validation |

**LCS Alternative:** Upload to LCS and deploy via standard process (official Microsoft recommendation).

### 19.9 Creating Custom Script Packages

**Package Structure:**
```
PackageName.zip
└── AOSService/
    └── Packages/
        └── files/
            └── ModelName.zip
                └── bin/
                    └── Dynamics.AX.ModelName.dll
```

**X++ Class Requirements:**
```x++
internal final class MyCustomScript
{
    public static void main(Args _args)
    {
        // Script logic here
        info("Script executed successfully");
    }
}
```

### 19.10 Security Configuration

**Duties:**
- `AppConsistencyCustomScriptMaintain` - Upload and manage scripts
- `AppConsistencyCustomScriptApprove` - Approve scripts for execution

**Recommended Role Setup:**
- Script developers: Maintain duty
- Approvers: Approve duty (different users)
- Auditors: Read access only

### 19.11 Runtime Script Identification (Critical Pattern)

**Problem:** During execution, the script must identify itself in `AppConsistencyCustomScript` to:
1. Read configuration from attached DocuRef notes
2. Attach execution reports back to the correct script record

**Status During Execution:**

| Run Type | Status DURING Execution | Status AFTER Completion |
|----------|-------------------------|-------------------------|
| **Test Run** | `Approved` | `Tested` |
| **Actual Run** | `ReadyForExecution` | `Executed` |

**Critical:** The `executeScript()` method passes an empty `Args()` object, so the script cannot use `_args.record()` to get its record!

**Multiple Scripts with Same ClassName:**
If multiple scripts with the same class name exist (from multiple uploads), you must:
1. Check for both `Approved` AND `ReadyForExecution` status
2. Order by `RecId desc` to get the most recent upload

**Complete Identification Pattern:**
```x++
private static container loadXmlFromDocuRef()
{
    DocuRef docuRef;
    str scriptClassName = getScriptClassName();  // Use funcName() reflection
    str currentCompany = curExt();

    // Find the currently executing script record
    AppConsistencyCustomScript customScript;

    // First try: ReadyForExecution (actual run)
    // Order by RecId desc to get most recent if multiple exist
    select firstonly customScript
        order by customScript.RecId desc
        where customScript.ClassName == scriptClassName
           && customScript.Status == AppConsistencyCustomScriptStatus::ReadyForExecution;

    // Second try: Approved (test run)
    if (!customScript)
    {
        select firstonly customScript
            order by customScript.RecId desc
            where customScript.ClassName == scriptClassName
               && customScript.Status == AppConsistencyCustomScriptStatus::Approved;
    }

    // Fallback: Most recent record (for debugging/re-runs)
    if (!customScript)
    {
        select firstonly customScript
            order by customScript.RecId desc
            where customScript.ClassName == scriptClassName;

        if (!customScript)
        {
            throw error(strFmt("Script '%1' not found.", scriptClassName));
        }

        warning(strFmt("No script in expected status. Using RecId: %1, Status: %2",
            customScript.RecId, customScript.Status));
    }

    info(strFmt("Using script '%1' (RecId: %2, Status: %3) in company '%4'",
        scriptClassName, customScript.RecId, customScript.Status, currentCompany));

    // Now query DocuRef attached to THIS specific script
    select firstonly docuRef
        order by docuRef.CreatedDateTime desc
        where docuRef.RefTableId == tableNum(AppConsistencyCustomScript)
           && docuRef.RefRecId == customScript.RecId
           && docuRef.TypeId == DocuType::typeNote()
           && docuRef.ActualCompanyId == currentCompany;  // CRITICAL!

    // ... process docuRef
    return [xmlContent, docuRef.RefTableId, docuRef.RefRecId];
}
```

**Key Points:**
- `order by RecId desc` ensures most recent script is selected
- Check `ReadyForExecution` first (actual runs), then `Approved` (test runs)
- Return `RefTableId` and `RefRecId` from DocuRef to attach reports to same script
- Always filter DocuRef by `ActualCompanyId` for correct company context

