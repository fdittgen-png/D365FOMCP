# Part 22: DocuRef Critical Patterns (Cross-Company & Ordering)

_Reference for the `d365fo-analysis` skill. Read on demand._


### 22.1 Critical: DocuRef is Cross-Company!

**The DocuRef table stores attachments/notes from ALL legal entities in a single table.** If you query DocuRef without filtering by company, you may retrieve records from other companies!

**Key Fields:**

| Field | Purpose | Required for Filtering |
|-------|---------|------------------------|
| `ActualCompanyId` | Company where the DocuRef record itself was created/belongs | **Yes - Always filter!** |
| `RefCompanyId` | Company (DataAreaId) of the referenced record being attached to | Yes - When inserting |
| `RefTableId` | Table ID of parent record | Yes |
| `RefRecId` | RecId of parent record | Yes |
| `TypeId` | Document type | Yes |
| `CreatedDateTime` | When the note was created | **Yes - For ordering!** |

### 22.1.1 ActualCompanyId vs RefCompanyId - Critical Distinction

| Field | Meaning | Example |
|-------|---------|---------|
| **RefCompanyId** | Company of the **referenced record** (the record the note is attached TO) | Vendor record's DataAreaId |
| **ActualCompanyId** | Company where the **DocuRef itself** was created - determines which legal entity "owns" the attachment | User's current company when creating note |

**When They Differ (Cross-Company Attachment):**
```
Example: User in USMF attaches a note to a vendor record in FRRT

RefCompanyId    = FRRT   (the vendor record's company)
ActualCompanyId = USMF   (where the attachment was created)
```

**For Shared/Global Tables (like AppConsistencyCustomScript):**
- `AppConsistencyCustomScript` is a **shared table** (no DataAreaId - records are cross-company)
- DocuRef notes attached to these records still have company context via `ActualCompanyId`
- Notes created in GRUK have `ActualCompanyId = 'GRUK'`
- Notes created in USMF have `ActualCompanyId = 'USMF'`
- **Without ActualCompanyId filter, running in GRUK could read USMF's configuration!**

### 22.2 Critical: Always Order by CreatedDateTime

Without ordering, DocuRef queries return records in **index order** (typically oldest first). If multiple notes match your criteria, you'll get the **oldest** one, not the **latest**.

**Wrong (Common Mistake):**
```x++
select firstonly docuRef
    where docuRef.RefTableId == tableNum(MyTable)
       && docuRef.RefRecId == myRecord.RecId
       && docuRef.TypeId == DocuType::typeNote();
// Returns OLDEST matching note!
```

**Correct:**
```x++
select firstonly docuRef
    order by docuRef.CreatedDateTime desc  // CRITICAL!
    where docuRef.RefTableId == tableNum(MyTable)
       && docuRef.RefRecId == myRecord.RecId
       && docuRef.TypeId == DocuType::typeNote()
       && docuRef.ActualCompanyId == curExt();  // CRITICAL!
// Returns LATEST matching note in current company
```

### 22.3 Complete DocuRef Query Pattern

```x++
private static container loadConfigFromDocuRef()
{
    DocuRef docuRef;
    str noteContent;
    str currentCompany = curExt();  // CRITICAL: Get current company

    info(strFmt("Searching DocuRef in company: %1", currentCompany));

    // ALWAYS use these three critical elements:
    // 1. order by CreatedDateTime desc
    // 2. ActualCompanyId filter
    // 3. Log which note is used

    while select docuRef
        order by docuRef.CreatedDateTime desc  // 1. LATEST first
        where docuRef.RefTableId == tableNum(AppConsistencyCustomScript)
           && docuRef.RefRecId == customScript.RecId
           && docuRef.TypeId == DocuType::typeNote()
           && docuRef.ActualCompanyId == currentCompany  // 2. COMPANY filter
    {
        noteContent = docuRef.Notes;
        if (noteContent && strContains(noteContent, '<ExpectedElement'))
        {
            // 3. LOG which note is being used
            info(strFmt("Found config in note '%1' (DocuRef RecId: %2, Created: %3)",
                docuRef.Name,
                docuRef.RecId,
                DateTimeUtil::toStr(docuRef.CreatedDateTime)));

            return [noteContent, docuRef.RefTableId, docuRef.RefRecId];
        }
    }

    warning("No matching DocuRef note found!");
    return conNull();
}
```

### 22.4 DocuRef Insert Pattern

When creating DocuRef records, **always set both company fields**:

```x++
private static boolean saveToDocuRef(str _content, TableId _refTableId, RecId _refRecId)
{
    str currentCompany = curExt();

    DocuRef docuRef;
    docuRef.clear();
    docuRef.RefTableId = _refTableId;
    docuRef.RefRecId = _refRecId;
    docuRef.RefCompanyId = currentCompany;      // CRITICAL!
    docuRef.ActualCompanyId = currentCompany;   // CRITICAL!
    docuRef.TypeId = DocuType::typeNote();
    docuRef.Name = strFmt('Config_%1', DateTimeUtil::toStr(DateTimeUtil::utcNow()));
    docuRef.Notes = _content;
    docuRef.Restriction = DocuRestriction::Internal;

    ttsbegin;
    docuRef.insert();
    ttscommit;

    info(strFmt("Saved DocuRef note '%1' (RecId: %2)", docuRef.Name, docuRef.RecId));
    return true;
}
```

### 22.5 Common DocuRef Mistakes

| Mistake | Symptom | Solution |
|---------|---------|----------|
| Missing `ActualCompanyId` filter | Script reads notes from other companies | Add `&& docuRef.ActualCompanyId == curExt()` |
| Missing `order by CreatedDateTime desc` | Script uses old note instead of latest | Add ordering clause |
| Not logging which note is used | Can't debug why wrong data is used | Log RecId and CreatedDateTime |
| Missing company fields on insert | Notes don't filter properly later | Set both `RefCompanyId` and `ActualCompanyId` |
| Using `_args.record()` for Custom Scripts | Wrong context for note lookup | Query `AppConsistencyCustomScript` by ClassName |

### 22.6 Debugging DocuRef Issues

**Symptom:** Script processes wrong/old data even after updating the note.

**Debugging Checklist:**

1. **Check infolog for which note is being read:**
   ```
   Looking for DocuRef note for script: MyScript in company: GRUK
   Found config in note 'MyScript_Config' (DocuRef RecId: 12345, Created: 2026-01-09 10:30:00)
   ```

2. **Verify the RecId and timestamp match your expected note**

3. **Check for multiple notes in D365FO:**
   - Go to the Custom Script configuration
   - View attachments
   - Look for multiple notes with similar names
   - Delete or rename old notes

4. **SQL diagnostic:**
   ```sql
   SELECT RecId, Name, ActualCompanyId, CreatedDateTime, LEFT(Notes, 100) as NotePreview
   FROM DocuRef
   WHERE RefTableId = 79043  -- AppConsistencyCustomScript table ID
     AND RefRecId = @CustomScriptRecId
     AND TypeId = 0  -- Note type
   ORDER BY CreatedDateTime DESC
   ```

### 22.7 funcName() for Dynamic Class Name (Standard in All TBG Scripts)

All TBG Custom Scripts use `funcName()` to get the class name via reflection. This allows copying code to new timestamped classes without updating any constants:

```x++
/// <summary>
/// Gets the class name using reflection
/// Allows code reuse without updating class name constants
/// </summary>
private static str getScriptClassName()
{
    // funcName() returns "ClassName::methodName"
    // e.g., "TBG_CS_MyScript_202601091031::getScriptClassName"
    str fullName = funcName();
    int colonPos = strScan(fullName, ':', 1, strLen(fullName));

    if (colonPos > 1)
    {
        return subStr(fullName, 1, colonPos - 1);
    }

    return fullName;
}
```

### 22.8 Automatic XML Report Saving to DocuRef

All TBG Custom Scripts automatically save their XML execution reports as DocuRef notes attached to the Custom Script record.

**Report Naming Convention:** `{ReportType}{yyyymmddhhmmss}`

| Script | Report Prefix | Example Note Name |
|--------|---------------|-------------------|
| TBG_CS_PO_Reset | POResetReport | POResetReport20260112143025 |
| TBG_CS_UpdatePOStatus | POStatusResetReport | POStatusResetReport20260112143025 |
| TBG_CS_UpdateProdRoute | ProdRouteDimUpdateReport | ProdRouteDimUpdateReport20260112143025 |
| TBG_CS_PO_UpdateDimension | PODimensionUpdateReport | PODimensionUpdateReport20260112143025 |

**Timestamp Format:** Year (4) + Month (2) + Day (2) + Hour (2) + Minute (2) + Second (2) - no separators.

**Implementation Pattern:**
```x++
private static boolean saveXmlReportToDocuRef(str _xmlReport)
{
    str scriptClassName = MyScript::getScriptClassName();  // Dynamic!
    str currentCompany = curExt();

    // Find the Custom Script record
    AppConsistencyCustomScript customScript;
    select firstonly customScript
        order by customScript.RecId desc
        where customScript.ClassName == scriptClassName;

    if (!customScript)
    {
        warning(strFmt("Script '%1' not found.", scriptClassName));
        return false;
    }

    // Generate note name with timestamp
    utcDateTime now = DateTimeUtil::utcNow();
    str noteName = strFmt('ReportType%1%2%3%4%5%6',
        DateTimeUtil::year(now),
        month < 10 ? strFmt('0%1', month) : int2Str(month),
        day < 10 ? strFmt('0%1', day) : int2Str(day),
        hour < 10 ? strFmt('0%1', hour) : int2Str(hour),
        minute < 10 ? strFmt('0%1', minute) : int2Str(minute),
        second < 10 ? strFmt('0%1', second) : int2Str(second));

    DocuRef docuRef;
    docuRef.clear();
    docuRef.RefTableId = tableNum(AppConsistencyCustomScript);
    docuRef.RefRecId = customScript.RecId;
    docuRef.RefCompanyId = currentCompany;
    docuRef.ActualCompanyId = currentCompany;
    docuRef.TypeId = DocuType::typeNote();
    docuRef.Name = noteName;
    docuRef.Notes = _xmlReport;
    docuRef.Restriction = DocuRestriction::Internal;

    ttsbegin;
    docuRef.insert();
    ttscommit;

    info(strFmt("XML report saved as '%1' (RecId: %2)", noteName, docuRef.RecId));
    return true;
}
```

**Key Benefits:**
- Full audit trail of all script executions
- Reports viewable in Custom Script attachments
- Timestamp uniqueness prevents overwrites
- Cross-company safe with ActualCompanyId

### 22.9 update_recordset with Skip Flags

When standard table updates are blocked by validation, use `update_recordset` with skip flags:

```x++
// CAUTION: Bypasses ALL table business logic!
MyTable tableUpdate;
tableUpdate.skipDataMethods(true);      // Skip insert/update/delete methods
tableUpdate.skipDatabaseLog(true);      // Skip database logging
tableUpdate.skipEvents(true);           // Skip table events
tableUpdate.skipAosValidation(true);    // Skip AOS validation

update_recordset tableUpdate
    setting FieldToUpdate = newValue
    where tableUpdate.KeyField == keyValue;
```

**Warning:** Use only when:
- Standard update is blocked by validation
- You understand the business implications
- Data integrity has been verified manually

