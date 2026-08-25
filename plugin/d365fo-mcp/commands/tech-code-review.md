---
description: Reviews D365FO X++ code for a class, method, or table method — call chains, inheritance, CoC extension behavior, patterns, and modification risks. Use when reviewing customizations, planning modifications, or auditing an extension's behavior.
argument-hint: <Class | Class.Method | Table.Method>
---

# Technical: Code Review

## Task
Review the X++ code behind `$ARGUMENTS`: call chains, extensions, inheritance, patterns, and risks.
**Done when:** every CoC extension found has been read (not just listed) and its behavior characterized (pre/post, calls next?, what it modifies), and each stated risk cites the code observation behind it.

## Workflow

### Step 1: Parse target
- **Class** (no dot) → class-level review
- **Class.Method / Table.Method** (has dot) → method-level review

### Step 2: Gather code context (parallel)
**Class-level:**
- `d365kb:d365_get_class_methods` (includeSource=true), `d365xref:xref_class_hierarchy` (ancestors and descendants), `d365xref:xref_find_extensions`, `d365xref:xref_find_event_handlers`, `d365xref:xref_object_summary`

**Method-level (additional):**
- `d365kb:d365_get_method_source` — full X++ source
- `d365xref:xref_find_method_callers` + `d365xref:xref_method_references`

### Step 3: Extension analysis
For each CoC extension found, read its source with `d365_get_method_source` and determine: does it call `next`? What does it modify? Pre or post logic?

## Output

**Code Review: $ARGUMENTS**

1. **Object Overview** table: module, type, extends, abstract, method/extension/handler counts
2. **Inheritance Chain**
3. **Key Methods** grouped: initialization, core logic, validation, event points
4. **Extension Impact** table: Extension | Model | Method | Type | Calls next? | Risk
5. **Call Chain** (method-level)
6. **Code Quality Observations** — patterns used, potential issues (hardcoded values, missing error handling, performance), available extension points
7. **Modification Risks** — breaking changes, extensions depending on current behavior, cross-module consumers

Separate observed facts (from source) from suspected issues (inference) — label the latter.

## Follow-ups to offer
- Full source of a method, `/d365-impact`, or `d365sec:sec_permission_trace` for who can run this
