# Functional: Process Analysis

Analyze a D365 business process end-to-end by combining Task Recordings with metadata, security, and documentation. For functional consultants doing gap analysis, process documentation, or fit/gap workshops.

## Arguments
- $ARGUMENTS: Process name OR .axtr file path (e.g., "procure to pay", "sales order to invoice", "C:\recordings\po-creation.axtr")

## Workflow

### Step 1: Gather process context

**If .axtr file provided:**
- Read and `taskrecorder_to_markdown` — get the full recorded flow
- Extract: forms visited, data entered, navigation flow, validations

**If process name provided:**
- `rag_ask` with "$ARGUMENTS process flow D365" — find process documentation
- `microsoft_docs_search` with "$ARGUMENTS" — official process guides
- `d365_search` with process keywords — find related forms, tables, menu items

### Step 2: Analyze each process step (parallel per form)
For each form/table identified in Step 1:
- `d365_lookup_table` — understand data model (fields, relations, indexes)
- `d365_get_entity_sources` — check if OData/data entities exist for integration
- `d365_find_referencing_tables` — downstream tables affected by this step

### Step 3: Security requirements
- For each form's menu item: `sec_permission_trace` — which roles can access
- Group by: minimum role needed per step
- Flag steps requiring elevated privileges

### Step 4: Present process analysis

**Process Analysis: $ARGUMENTS**

**1. Process Flow**
```
Step 1: [Form] — [Action] → Step 2: [Form] — [Action] → ...
```

**2. Data Model**
| Step | Form | Primary Table | Key Fields | Related Tables |
|------|------|--------------|------------|----------------|
| 1 | ... | ... | ... | ... |

**3. Data Entry Points**
| Field | Table.Column | Type | Mandatory | Values/Enum |
|-------|-------------|------|-----------|-------------|
(from task recording data entry summary)

**4. Security Matrix**
| Step | Form | Minimum Role | Duty | Privilege |
|------|------|-------------|------|-----------|

**5. Integration Points**
| Table | Data Entity | OData Endpoint | Direction |
|-------|------------|----------------|-----------|

**6. Validations & Business Rules**
- (from task recording validation steps)
- (from class method analysis if available)

**7. Gaps & Observations**
- Missing validations
- Over-privileged access
- Integration opportunities
- Customization risks

### Step 5: Offer drill-down
- "Deep dive on a specific table?" → `/d365-table`
- "Check field mappings?" → `/d365-trace-field`
- "Review security for a role?" → `/d365-security`
- "What customizations exist?" → `xref_find_extensions`
