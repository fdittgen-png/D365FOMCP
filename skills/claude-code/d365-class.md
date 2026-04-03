# D365 Class Analysis

Analyze a D365 class: hierarchy, methods, extensions, callers, and extensibility points.

## Arguments
- $ARGUMENTS: Class name (e.g., "SalesFormLetter", "InventMovement", "CustVendTransData")

## Workflow

### Step 1: Gather all class data (parallel)
Run ALL in parallel:
- `d365_get_class_methods` with className = `$ARGUMENTS` — all method signatures
- `xref_class_hierarchy` with className = `$ARGUMENTS` — inheritance tree (up and down)
- `xref_object_summary` with objectName = `$ARGUMENTS` — reference overview
- `xref_find_extensions` with objectName = `$ARGUMENTS` — CoC extensions
- `xref_find_event_handlers` with objectName = `$ARGUMENTS` — event handlers

### Step 2: Present class report

**Class: `$ARGUMENTS`**

| Property | Value |
|----------|-------|
| Module | |
| Extends | (parent class) |
| Abstract | Yes/No |
| Methods | N |
| Extensions | N |
| Event Handlers | N |

**Inheritance Chain** (from xref_class_hierarchy)
```
GrandParent
  -> Parent
    -> $ARGUMENTS
      -> Child1
      -> Child2
```

**Key Methods** (grouped by visibility/purpose)
- construct / new / init
- Core business methods
- Event handlers / delegates

**Extensions** (CoC and event handlers found)

**Top Callers** (from object summary)

### Step 3: If user asks about a specific method
- `d365_get_method_source` for the source code
- `xref_find_method_callers` for who calls it
- `xref_method_references` for what it calls

### Step 4: Offer next steps
- View specific method source code
- Analyze impact of changing a method
- Find interface implementors (`xref_interface_implementors`)
- Search documentation about this class
