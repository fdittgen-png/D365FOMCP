# Technical: Code Review

Review D365 X++ code for a class or method: call chains, extensions, inheritance, patterns, and risks. For technical experts reviewing customizations or planning modifications.

## Arguments
- $ARGUMENTS: Class, method, or table (e.g., "SalesFormLetter", "CustPostInvoice.run", "PurchTable.validateWrite")

## Workflow

### Step 1: Parse target
Determine if $ARGUMENTS is:
- **Class** (no dot): analyze class-level
- **Class.Method** (has dot): analyze method-level
- **Table.Method** (table name pattern): analyze table method

### Step 2: Gather all code context (parallel)

**For class-level:**
- `d365_get_class_methods` with className, includeSource=true — all method signatures + source
- `xref_class_hierarchy` with className, direction=ancestors — inheritance chain up
- `xref_class_hierarchy` with className, direction=descendants — who extends this
- `xref_find_extensions` with objectName — CoC extensions and overlayering
- `xref_find_event_handlers` with objectName — event handlers attached
- `xref_object_summary` with objectName — reference counts

**For method-level (additional):**
- `d365_get_method_source` for the specific method — full X++ source
- `xref_find_method_callers` with className, methodName — all callers
- `xref_method_references` with className, methodName — what it calls

### Step 3: Extension analysis
For each CoC extension found:
- `d365_get_method_source` — read the extension code
- Identify: does it call next? What does it modify? Is it pre/post?

### Step 4: Present code review

**Code Review: $ARGUMENTS**

**1. Object Overview**
| Property | Value |
|----------|-------|
| Module | |
| Type | Class / Table |
| Extends | (parent) |
| Abstract | Yes/No |
| Methods | N |
| Extensions | N (list models) |
| Event Handlers | N |

**2. Inheritance Chain**
```
Base → Parent → $ARGUMENTS → [Children]
```

**3. Key Methods** (grouped)
- **Initialization**: construct, new, init
- **Core Logic**: [business methods]
- **Validation**: validate*, check*
- **Event Points**: delegates, events

**4. Extension Impact**
| Extension | Model | Method | Type | Calls next? | Risk |
|-----------|-------|--------|------|-------------|------|
(CoC extensions and their behavior)

**5. Call Chain** (for method-level)
```
Caller1.method → $ARGUMENTS → Callee1.method
Caller2.method →            → Callee2.method
```

**6. Code Quality Observations**
- Patterns used (command, strategy, factory)
- Potential issues (hardcoded values, missing error handling, performance)
- Extension points available for customization

**7. Modification Risks**
- Breaking changes if signature changes
- Extensions that depend on current behavior
- Cross-module consumers

### Step 5: Offer drill-down
- "View full source of a method?" → `d365_get_method_source`
- "Impact analysis?" → `/d365-impact`
- "Who has access to run this?" → `sec_permission_trace`
