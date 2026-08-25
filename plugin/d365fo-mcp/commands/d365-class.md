---
description: Analyzes a D365FO X++ class — inheritance hierarchy, methods, CoC extensions, event handlers, callers, and extensibility points. Use when the user names a class (e.g. SalesFormLetter, InventMovement) and wants its structure, code path, or extension surface.
argument-hint: <ClassName>
---

# D365 Class Analysis

## Task
Analyze the class `$ARGUMENTS`: hierarchy, methods, extensions, callers, and extensibility points.
**Done when:** the report covers the sections below from live MCP data, with inferred statements labeled as such.

## Workflow

### Step 1: Gather all class data (parallel)
Run ALL in parallel:
- `d365kb:d365_get_class_methods` with className = `$ARGUMENTS` — all method signatures
- `d365xref:xref_class_hierarchy` with className = `$ARGUMENTS` — inheritance tree (up and down)
- `d365xref:xref_object_summary` with objectName = `$ARGUMENTS` — reference overview
- `d365xref:xref_find_extensions` with objectName = `$ARGUMENTS` — CoC extensions
- `d365xref:xref_find_event_handlers` with objectName = `$ARGUMENTS` — event handlers

### Step 2: If the user asks about a specific method
- `d365kb:d365_get_method_source` for the source code
- `d365xref:xref_find_method_callers` for who calls it
- `d365xref:xref_method_references` for what it calls

## Output

**Class: `$ARGUMENTS`**

| Property | Value |
|----------|-------|
| Module | |
| Extends | (parent class) |
| Abstract | Yes/No |
| Methods | N |
| Extensions | N |
| Event Handlers | N |

Then: **Inheritance Chain** (tree from xref_class_hierarchy), **Key Methods** (grouped by purpose: construct/init, core business, delegates), **Extensions** found, **Top Callers**.

## Follow-ups to offer
- View a specific method's source
- Impact of changing a method (`/d365-impact`)
- Find interface implementors (`d365xref:xref_interface_implementors`)
