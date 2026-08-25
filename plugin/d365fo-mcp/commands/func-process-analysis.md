---
description: Analyzes a D365FO business process end-to-end — process flow, data model per step, security matrix, integration points, and gaps — from a process name or Task Recording (.axtr). Use for gap analysis, process documentation, or fit/gap workshops.
argument-hint: <process name | path\to\recording.axtr>
---

# Functional: Process Analysis

## Task
Analyze the process in `$ARGUMENTS` end-to-end for a functional consultant.
**Done when:** each process step is mapped to its form, primary table, and minimum security role from tool data, and the Gaps section separates observed gaps (from the recording/metadata) from suspected ones (inference).

## Workflow

### Step 1: Gather process context
**If .axtr provided:** call `d365taskrecorder:taskrecorder_to_markdown` directly with the file content (base64) — do NOT parse the .axtr yourself. Extract forms visited, data entered, navigation flow, validations.

**If process name provided:**
- `d365rag:rag_ask` with "[process] process flow D365", `Microsoft Learn:microsoft_docs_search`, `d365kb:d365_search` with process keywords _(if the d365rag MCP is connected)_

### Step 2: Analyze each step (parallel per form)
- `d365kb:d365_lookup_table` — data model behind the form
- `d365kb:d365_get_entity_sources` — OData/data entities for integration
- `d365kb:d365_find_referencing_tables` — downstream tables affected

### Step 3: Security requirements
- `d365sec:sec_permission_trace` per form menu item → minimum role per step; flag steps requiring elevated privileges

## Output

**Process Analysis: $ARGUMENTS**

1. **Process Flow**: Step → Form → Action chain
2. **Data Model**: Step | Form | Primary Table | Key Fields | Related Tables
3. **Data Entry Points**: Field | Table.Column | Type | Mandatory | Values/Enum
4. **Security Matrix**: Step | Form | Minimum Role | Duty | Privilege
5. **Integration Points**: Table | Data Entity | OData Endpoint | Direction
6. **Validations & Business Rules** — from the recording and class analysis
7. **Gaps & Observations** — missing validations, over-privileged access, integration opportunities, customization risks (observed vs suspected, labeled)

## Follow-ups to offer
- `/d365-table`, `/d365-trace-field`, `/d365-security`, or `d365xref:xref_find_extensions` for customizations
