# Support: Reproduce Issue from Task Recording

Build a step-by-step reproduction scenario from a Task Recording, enriched with form/field context for 1st-level support engineers.

## Arguments
- $ARGUMENTS: Path to .axtr file, OR base64 content, OR description of the issue area (e.g., "C:\recordings\invoice-error.axtr", "sales order posting issue")

## Workflow

### Step 1: Parse the recording
If $ARGUMENTS is a file path ending in .axtr:
- Read the file and base64-encode it
- `taskrecorder_to_markdown` with file_content and file_name

If $ARGUMENTS is a description (no file):
- Ask the user to provide the .axtr file
- Or use `d365_search` to find related forms/tables for the described area

### Step 2: Enrich with form context (parallel)
For each form mentioned in the parsed recording:
- `d365_lookup_table` for the primary data source table — understand what data the form shows
- `d365_search` for related configuration or setup forms

### Step 3: Build reproduction document

Format as a **Support Reproduction Scenario**:

**Issue Area:** (from recording name)
**Environment:** (note to fill in)
**Date Recorded:** (from footer)

**Prerequisites:**
- Required security role(s) (from BPM security section)
- Navigation path (from menu item in recording)

**Steps to Reproduce:**
For each recorded step, write in plain language:
1. Navigate to **[Menu Item Label]** (Module > Menu path)
2. [Action description in user-friendly language]
3. Enter **[value]** in the **[field label]** field
   - *Technical: Table.Field = value*

**Expected Result:** (ask user)
**Actual Result:** (ask user)

**Technical Context:**
- Forms involved: (list)
- Tables affected: (list from data sources)
- Key fields: (from data entry summary)

### Step 4: Offer follow-up
- "Check which users can reproduce this?" → `sec_find_users_by_role` for required roles
- "Look up documentation for this process?" → `rag_ask` or `microsoft_docs_search`
- "What code runs behind this action?" → `xref_find_method_callers` for the command
