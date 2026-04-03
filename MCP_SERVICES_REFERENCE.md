# D365 MCP Services - Complete Reference

## 1. Overview

This document provides a comprehensive reference for all MCP (Model Context Protocol) services available in the Claude Code environment for D365 Finance & Operations development, analysis, and operations. These services provide instant access to metadata, cross-references, security models, documentation, and official Microsoft Learn content.

### Service Inventory

| Service | Scope | Database / Source | Tools | Purpose |
|---------|-------|-------------------|-------|---------|
| d365kb | Local | SQLite (412 MB, AOT metadata) | 15 | Table/field/enum/class metadata, anti-hallucination |
| d365xref | Local | SQLite (3.3 GB, cross-references) | 13 | Who calls/uses/extends/implements what |
| d365sec | Cloud | D365 security model | 12 | Users, roles, duties, privileges, permissions |
| d365rag | Cloud | D365 documentation corpus | 8 | Conceptual documentation, how-to guides |
| Microsoft Learn | Cloud | Official Microsoft docs | 3 | Microsoft/Azure documentation and code samples |

### Architecture

All local MCP servers follow the same pattern:

1. Data is extracted from D365 sources into SQLite databases
2. An MCP server loads the SQLite database into memory at startup
3. Claude Code communicates with the server via JSON-RPC over stdio
4. Queries execute in 1-50ms (in-memory SQLite)

Cloud-based services (d365sec, d365rag, Microsoft Learn) are hosted remotely and accessed via the MCP protocol through the Claude.ai infrastructure.

---

## 2. D365 Knowledge Base (d365kb)

### 2.1 Purpose

The Knowledge Base provides structured access to the entire D365 Finance & Operations Application Object Tree (AOT) metadata. It answers questions like "What fields does CustTable have?", "What are the values of enum SalesStatus?", and "Does field XYZ exist on table ABC?".

### 2.2 Data Coverage

| Object Type | Count | Details |
|-------------|-------|---------|
| Tables | 17,626 | With 215,862 fields (types, EDTs, mandatory flags) |
| Relations | 44,825 | Foreign keys with join field mappings |
| Enums | 7,839 | With 35,661 values and numeric codes |
| EDTs | 22,547 | Extended Data Type definitions |
| Classes | 63,330 | With 819,297 method signatures |
| Data Entities | 5,421 | With field-to-datasource mapping |
| Forms | 9,054 | Form definitions |
| Views | 2,894 | SQL view definitions |
| Security Objects | 7,236 | Roles, duties, privileges |
| Menu Items | 17,638 | Action, display, and output menu items |
| Modules | 165 | With aggregated object counts |

### 2.3 Tool Reference

#### d365_lookup_table

**Purpose:** Complete table metadata including fields, indexes, and relations.

**Parameters:**
- `tableName` (required) - Exact table name (e.g., "CustTable")

**Returns:** Table properties, all fields with types and EDTs, indexes, and outgoing relations.

**When to use:** When you know the exact table name and need its full structure. This is the primary entry point for table analysis.

**Example use case:** "Show me the structure of SalesTable" or "What fields does InventTable have?"

---

#### d365_check_field_exists

**Purpose:** Validates whether a specific field exists on a table. Returns the field's type, EDT, and mandatory flag if found.

**Parameters:**
- `tableName` (required) - Table name
- `fieldName` (required) - Field name to check

**Returns:** Field existence confirmation, data type, EDT, enum reference, and mandatory flag.

**When to use:** Before writing SQL queries or making assumptions about field names. Essential for anti-hallucination - LLMs frequently invent field names that don't exist in D365.

**Example use case:** "Does CustTable have a field called CreditLimit?" or validating LLM-generated SQL.

---

#### d365_search

**Purpose:** Full-text search across all object types in the AOT.

**Parameters:**
- `query` (required) - Search terms

**Returns:** Matching objects across tables, classes, enums, entities, etc. with relevance ranking.

**When to use:** When you don't know the exact name of an object but know keywords related to it. Do NOT use when you already know the exact name - use `d365_lookup_table` or `d365_get_enum` directly instead.

**Example use case:** "Find objects related to vendor invoicing" or "Search for anything about warehouse management".

---

#### d365_get_enum

**Purpose:** Retrieves all values of a D365 enum with their numeric codes.

**Parameters:**
- `enumName` (required) - Exact enum name (e.g., "SalesStatus")

**Returns:** All enum values with Name and numeric Value.

**When to use:** When you need to understand what numeric values mean in a database query, or when mapping status codes to human-readable names.

**Example use case:** "What are the values of SalesStatus?" or "What does LogType value 2 mean?"

---

#### d365_get_join_keys

**Purpose:** Returns the exact join fields between two tables based on their foreign key relations.

**Parameters:**
- `sourceTable` (required) - First table name
- `targetTable` (required) - Second table name

**Returns:** Join field pairs (source field = target field) for the relation between the two tables.

**When to use:** When writing SQL JOIN clauses. Never guess join keys - always verify with this tool. D365 composite keys are complex and frequently wrong in LLM-generated queries.

**Example use case:** "How do I join CustInvoiceJour to CustInvoiceTrans?" or "What are the join keys between SalesTable and SalesLine?"

---

#### d365_get_class_methods

**Purpose:** Lists all method signatures for a class or table.

**Parameters:**
- `className` (required) - Class or table name

**Returns:** Method names with full signatures (parameters and return types).

**When to use:** When exploring what methods are available on a class, or when planning an extension.

**Example use case:** "What methods does SalesFormLetter have?" or "Show me the methods on CustTable".

---

#### d365_get_method_source

**Purpose:** Retrieves the X++ source code of a specific method.

**Parameters:**
- `className` (required) - Class or table name
- `methodName` (required) - Method name

**Returns:** Full X++ source code of the method.

**When to use:** When you need to understand how a method works internally, or when planning a Chain of Command extension.

**Example use case:** "Show me the source of SalesFormLetter.confirm" or "How does CustTable.find work?"

---

#### d365_find_referencing_tables

**Purpose:** Finds all tables that have a foreign key pointing to the specified table.

**Parameters:**
- `tableName` (required) - Target table name

**Returns:** List of tables with their relation fields that reference the target table.

**When to use:** When you need to understand the data model around a table - what child/related tables exist.

**Example use case:** "What tables reference CustTable?" or "Find all child tables of SalesTable".

---

#### d365_get_module_summary

**Purpose:** Overview of a module with key objects and counts.

**Parameters:**
- `moduleName` (required) - Module name (e.g., "AccountsReceivable")

**Returns:** Module overview with counts of tables, classes, enums, entities, and key objects.

**When to use:** When exploring what a module contains, or when starting work in an unfamiliar module.

---

#### d365_get_entity_sources

**Purpose:** Maps data entity fields back to their source tables and fields.

**Parameters:**
- `entityName` (required) - Data entity name

**Returns:** Field mapping showing which source table and field each entity field comes from.

**When to use:** When troubleshooting data entity behavior, understanding BYOD sync, or mapping entity fields to table fields.

**Example use case:** "What are the source fields for CustCustomerEntity?"

---

#### d365_sql_template

**Purpose:** Returns pre-validated SQL query templates for common D365 queries.

**Parameters:**
- `templateName` (required) - Template identifier

**Returns:** Complete, validated SQL query with correct table names, join keys, and field names.

**When to use:** When writing SQL against D365 databases. These templates have been verified against live databases and avoid common LLM mistakes.

---

#### d365_hallucination_check

**Purpose:** Checks a query or field reference against known LLM hallucination patterns.

**Parameters:**
- `query` (required) - SQL query or field reference to validate

**Returns:** List of potential hallucination issues found (non-existent fields, wrong table names, incorrect join keys).

**When to use:** After generating SQL queries, before presenting them to the user. Catches common LLM mistakes like using AX2012 field names or inventing fields.

---

#### d365_field_renames

**Purpose:** Maps AX2012 field names to their D365FO equivalents.

**Parameters:**
- `fieldName` (required) - Field name (AX2012 or D365)

**Returns:** Rename history showing old and new names.

**When to use:** When working with legacy documentation or AX2012 migration code that uses old field names.

**Example use case:** "Was CUSTACCOUNT renamed in D365?" or "What was DATAAREAID called in AX2012?"

---

#### d365_list_modules

**Purpose:** Lists all D365 modules with their object counts.

**Returns:** Module directory with counts of tables, classes, enums, entities per module.

**When to use:** For orientation - understanding what modules exist and their relative size.

---

#### d365_graph_traverse

**Purpose:** Traverses the dependency graph using recursive CTEs.

**Parameters:**
- `startNode` (required) - Starting object
- `direction` (optional) - "upstream" or "downstream"
- `maxDepth` (optional) - Maximum traversal depth

**Returns:** Dependency tree from the starting point.

**When to use:** When analyzing complex dependency chains that go beyond direct references.

---

#### d365_raw_sql

**Purpose:** Executes ad-hoc read-only SQL queries against the KB SQLite database.

**Parameters:**
- `sql` (required) - SQL SELECT query

**Returns:** Query results.

**When to use:** When none of the purpose-built tools can answer your question. Prefer specific tools over raw SQL for reliability.

---

## 3. D365 Cross-References (d365xref)

### 3.1 Purpose

The Cross-Reference service answers "who uses what" questions across the entire D365 codebase. It tracks 26.6 million references between 5.8 million named objects, covering method calls, field reads, class inheritance, interface implementation, and more.

### 3.2 Data Coverage

| Metric | Count |
|--------|-------|
| Named paths (objects) | 5,821,999 |
| References between them | 26,589,848 |
| Modules | 390 |
| Reference kinds | 8 |

### 3.3 Reference Kinds

| Kind ID | Name | Count | Meaning |
|---------|------|-------|---------|
| 1 | Call | 8.2M | Method invocation or label reference |
| 2 | Read | 17.4M | Type, field, or variable read access |
| 3 | Implements | 15K | Interface implementation |
| 4 | Extends | 94K | Class inheritance |
| 6 | Delegate | 7K | Delegate reference |
| 7 | Attribute | 731K | Attribute decoration |
| 9 | Tag | 4K | Tag reference |
| 10 | Override | 134K | Method override |

### 3.4 Path Format

Objects are identified by paths following the pattern:

```
/Classes/SalesFormLetter
/Classes/SalesFormLetter/Methods/construct
/Tables/CustTable
/Tables/CustTable/Methods/find
/Enums/DocumentStatus
/Forms/SalesTable
/DataEntityViews/CustInvoiceJourEntity
```

### 3.5 Tool Reference

#### xref_find_references

**Purpose:** Finds all objects that reference (use) the specified object. Answers "Who uses X?"

**Parameters:**
- `objectName` (required) - Object name (e.g., "CustTable", "SalesFormLetter")
- `kind` (optional) - Filter by reference kind (Call, Read, Extends, etc.)

**Returns:** List of objects that reference the target, with reference kind and line numbers.

**When to use:** When you need to understand who depends on an object before modifying it.

**Example use case:** "Who uses CustTable?" or "What classes extend InventMovement?"

---

#### xref_find_usages

**Purpose:** Finds all objects that the specified object uses. Answers "What does X depend on?"

**Parameters:**
- `objectName` (required) - Object name

**Returns:** List of objects referenced by the source object, with kind and location.

**When to use:** When understanding what an object depends on - its outgoing dependencies.

**Example use case:** "What does SalesFormLetter depend on?" or "What tables does PurchFormLetter read?"

---

#### xref_find_method_callers

**Purpose:** Finds all callers of a specific method.

**Parameters:**
- `className` (required) - Class or table name
- `methodName` (required) - Method name

**Returns:** List of methods that call the specified method, with line numbers.

**When to use:** Before modifying a method's signature or behavior - understand who calls it.

**Example use case:** "Who calls CustTable.find?" or "What invokes SalesFormLetter.confirm?"

---

#### xref_method_references

**Purpose:** Finds all outgoing references from a specific method.

**Parameters:**
- `className` (required) - Class or table name
- `methodName` (required) - Method name

**Returns:** All objects referenced by the method (calls, reads, etc.).

**When to use:** When analyzing what a method does - its internal dependencies.

**Example use case:** "What does SalesFormLetter.confirm call internally?"

---

#### xref_class_hierarchy

**Purpose:** Returns the full class inheritance tree (both upward and downward).

**Parameters:**
- `className` (required) - Class name

**Returns:** Inheritance chain: ancestors (parent, grandparent, ...) and descendants (children, grandchildren, ...).

**When to use:** When understanding class design patterns, planning extensions, or identifying which subclass to modify.

**Example use case:** "Show the inheritance tree for InventMovement" or "What are the subclasses of FormLetterService?"

---

#### xref_interface_implementors

**Purpose:** Finds all classes that implement a specified interface.

**Parameters:**
- `interfaceName` (required) - Interface name

**Returns:** List of implementing classes, including those that inherit the implementation.

**When to use:** When working with interfaces to understand which concrete classes provide the implementation.

**Example use case:** "Who implements SysRunnable?" or "What classes implement WHSWorkExecuteDisplay?"

---

#### xref_find_extensions

**Purpose:** Finds Chain of Command (CoC) extensions on an object.

**Parameters:**
- `objectName` (required) - Object to check for extensions

**Returns:** Extension classes and their methods that extend the target.

**When to use:** Before creating a new extension - check what already exists to avoid conflicts.

---

#### xref_find_event_handlers

**Purpose:** Finds event handlers attached to an object.

**Parameters:**
- `objectName` (required) - Object to check

**Returns:** Event handler methods with their subscription type (Pre/Post/DataEvent).

**When to use:** When analyzing customization patterns or before adding new event handlers.

---

#### xref_find_field_usages

**Purpose:** Finds all code locations that read or write a specific table field.

**Parameters:**
- `tableName` (required) - Table name
- `fieldName` (required) - Field name

**Returns:** List of methods that access the field, with read/write indication.

**When to use:** Before modifying a field's type, removing it, or changing its behavior.

**Example use case:** "Who reads SalesTable.SalesStatus?" or "What code writes to CustTable.CreditMax?"

---

#### xref_impact_analysis

**Purpose:** Comprehensive impact analysis for modifying an object. Combines multiple reference lookups into a single impact report.

**Parameters:**
- `objectName` (required) - Object to analyze

**Returns:** Impact summary: direct consumers, transitive dependents, extensions at risk, cross-module impacts.

**When to use:** Before making any significant modification to a shared object. This is the most comprehensive analysis tool.

**Example use case:** "What's the impact of modifying SalesTable?" or "Impact analysis for changing InventMovement".

---

#### xref_cross_module_deps

**Purpose:** Analyzes cross-module dependencies for a module.

**Parameters:**
- `moduleName` (required) - Module name

**Returns:** Which modules depend on this module, and which modules this module depends on.

**When to use:** When assessing the blast radius of changes to a module, or understanding module coupling.

---

#### xref_object_summary

**Purpose:** Compact summary of an object's reference profile.

**Parameters:**
- `objectName` (required) - Object name

**Returns:** Reference counts by kind, top callers, top dependencies.

**When to use:** Quick overview of how important/connected an object is before deep-diving.

---

#### xref_module_objects

**Purpose:** Lists all objects in a module.

**Parameters:**
- `moduleName` (required) - Module name

**Returns:** All objects in the module grouped by type.

**When to use:** When exploring a module's contents.

---

#### xref_search_names

**Purpose:** Searches object names by pattern.

**Parameters:**
- `pattern` (required) - Search pattern (supports LIKE wildcards)

**Returns:** Matching object paths.

**When to use:** When looking for objects by partial name.

**Example use case:** "Find all classes starting with 'SalesForm'" or "Search for methods named 'validate'".

---

#### xref_list_modules

**Purpose:** Lists all modules with object counts.

**Returns:** All modules with their object counts.

---

#### xref_raw_sql

**Purpose:** Ad-hoc read-only SQL queries against the XRef SQLite database.

**Parameters:**
- `sql` (required) - SQL SELECT query

**Returns:** Query results.

**When to use:** When purpose-built tools don't cover your specific cross-reference question.

---

## 4. D365 Security (d365sec)

### 4.1 Purpose

The Security service provides access to the D365 role-based security model. It can answer questions about user access, role assignments, duty/privilege structures, and permission traces.

### 4.2 Security Model Hierarchy

```
User
  -> Security Role(s)
    -> Security Duty/Duties
      -> Security Privilege(s)
        -> Permission(s) on AOT objects (Table, Form, Menu Item, etc.)
```

### 4.3 Tool Reference

#### sec_lookup_user

**Purpose:** Retrieves a user's profile including assigned roles and companies.

**Parameters:**
- `userId` (required) - User ID or alias

**Returns:** User details, assigned security roles, company access.

**When to use:** When auditing a specific user's access or troubleshooting "why can't user X do Y?"

---

#### sec_lookup_role

**Purpose:** Retrieves a role's complete structure (duties, privileges, permissions).

**Parameters:**
- `roleName` (required) - Security role name

**Returns:** Role definition with nested duties and privileges.

**When to use:** When analyzing what a role grants access to.

---

#### sec_lookup_duty

**Purpose:** Retrieves a duty's privileges and their permissions.

**Parameters:**
- `dutyName` (required) - Security duty name

**Returns:** Duty definition with privileges and their granted permissions.

---

#### sec_lookup_privilege

**Purpose:** Retrieves a privilege's direct permissions.

**Parameters:**
- `privilegeName` (required) - Security privilege name

**Returns:** Privilege definition with object-level permissions (Read, Update, Create, Delete).

---

#### sec_effective_permissions

**Purpose:** Calculates a user's effective (flattened) permissions, optionally filtered to a specific object.

**Parameters:**
- `userId` (required) - User ID
- `objectName` (optional) - Filter to a specific object

**Returns:** Merged permissions from all roles/duties/privileges.

**When to use:** To definitively answer "Can user X access object Y?" considering all role assignments.

---

#### sec_permission_trace

**Purpose:** Traces which roles, duties, and privileges grant access to a specific object.

**Parameters:**
- `objectName` (required) - AOT object name (table, form, menu item)

**Returns:** All access paths: Role -> Duty -> Privilege -> Permission on the object.

**When to use:** When you need to know "Who can access CustTable?" or "Which roles grant write access to SalesTable?"

---

#### sec_find_roles_by_duty

**Purpose:** Finds all roles that contain a specific duty.

**Parameters:**
- `dutyName` (required) - Duty name

**Returns:** List of roles containing the duty.

---

#### sec_find_roles_by_privilege

**Purpose:** Finds all roles that grant a specific privilege (directly or via duties).

**Parameters:**
- `privilegeName` (required) - Privilege name

**Returns:** List of roles and the path through which they grant the privilege.

---

#### sec_find_users_by_role

**Purpose:** Finds all users assigned to a specific role.

**Parameters:**
- `roleName` (required) - Role name

**Returns:** List of users with the role, including company scope.

**When to use:** When auditing role membership or before modifying a role.

---

#### sec_compare_roles

**Purpose:** Side-by-side comparison of two security roles.

**Parameters:**
- `role1` (required) - First role name
- `role2` (required) - Second role name

**Returns:** Duties/privileges unique to each role and those shared.

**When to use:** When consolidating roles, troubleshooting access differences, or planning role reorganization.

---

#### sec_role_hierarchy

**Purpose:** Shows parent and child roles for a given role.

**Parameters:**
- `roleName` (required) - Role name

**Returns:** Role hierarchy tree (inherited roles and sub-roles).

---

#### sec_company_users

**Purpose:** Lists all users with access to a specific company/legal entity.

**Parameters:**
- `companyId` (required) - Company/DataAreaId

**Returns:** Users with their roles scoped to that company.

---

#### sec_stats

**Purpose:** Overall security model statistics.

**Returns:** Counts of roles, duties, privileges, users, and relationships.

---

#### sec_search

**Purpose:** Search across security objects (roles, duties, privileges).

**Parameters:**
- `query` (required) - Search terms

**Returns:** Matching security objects.

---

#### sec_raw_sql

**Purpose:** Ad-hoc read-only SQL against the security database.

**Parameters:**
- `sql` (required) - SQL SELECT query

---

## 5. D365 RAG (d365rag)

### 5.1 Purpose

The RAG (Retrieval-Augmented Generation) service provides access to a curated corpus of D365 Finance & Operations documentation. It answers conceptual questions about how D365 features work, configuration guides, and best practices.

### 5.2 Tool Reference

#### rag_ask

**Purpose:** Ask a natural language question about D365 and get an answer grounded in documentation.

**Parameters:**
- `question` (required) - Natural language question

**Returns:** Answer synthesized from relevant documentation passages, with source references.

**When to use:** For conceptual questions about D365 functionality, configuration, or best practices. Do NOT use for metadata questions (use d365kb for those).

**Example use case:** "How does BYOD incremental sync work?" or "What is the purpose of number sequences in D365?"

---

#### rag_search

**Purpose:** Keyword search across the documentation corpus.

**Parameters:**
- `query` (required) - Search keywords

**Returns:** Matching document passages with relevance scores.

**When to use:** When `rag_ask` doesn't find what you need, or when you want to browse related documents.

---

#### rag_list_documents

**Purpose:** Lists all documents in the RAG corpus.

**Returns:** Document inventory with titles and categories.

---

#### rag_lookup_document

**Purpose:** Retrieves a specific document by ID.

**Parameters:**
- `documentId` (required) - Document identifier

**Returns:** Full document content.

**When to use:** When you found a document via search and want to read the complete content.

---

#### rag_list_categories

**Purpose:** Lists all document categories in the corpus.

**Returns:** Category names with document counts.

---

#### rag_search_by_category

**Purpose:** Searches within a specific category.

**Parameters:**
- `category` (required) - Category name
- `query` (optional) - Additional search terms

**Returns:** Matching documents within the category.

---

#### rag_get_image_info

**Purpose:** Retrieves information about images referenced in documents.

**Parameters:**
- `imageId` (required) - Image identifier

**Returns:** Image metadata and description.

---

#### rag_raw_sql

**Purpose:** Ad-hoc SQL against the RAG database.

**Parameters:**
- `sql` (required) - SQL SELECT query

---

## 6. Microsoft Learn

### 6.1 Purpose

The Microsoft Learn service provides structured access to official Microsoft and Azure documentation. It returns authoritative, up-to-date content directly from Microsoft's documentation platform.

### 6.2 Tool Reference

#### microsoft_docs_search

**Purpose:** Search official Microsoft documentation and return concise, high-quality content chunks.

**Parameters:**
- `query` (required) - Search terms

**Returns:** Up to 10 content chunks (max 500 tokens each) with title, URL, and excerpt.

**When to use:** First step when looking for Microsoft/Azure documentation. Provides breadth.

**Example use case:** "D365 data entity batch processing" or "Azure SQL BACPAC export"

---

#### microsoft_code_sample_search

**Purpose:** Search for code snippets and examples in Microsoft documentation.

**Parameters:**
- `query` (required) - Search terms
- `language` (optional) - Filter by programming language

**Returns:** Up to 20 relevant code samples.

**When to use:** When you need practical code examples for Microsoft/Azure technologies.

**Example use case:** "X++ Chain of Command example" or "PowerShell Azure SQL export"

---

#### microsoft_docs_fetch

**Purpose:** Fetch and convert a full Microsoft Learn documentation page to markdown.

**Parameters:**
- `url` (required) - Microsoft Learn URL

**Returns:** Full page content in clean markdown format.

**When to use:** After `microsoft_docs_search` identifies a relevant page, use this to get the complete content. Required for detailed tutorials, prerequisites, or when search results are incomplete.

**Example use case:** Fetching the full BACPAC export tutorial or a complete API reference page.

---

## 7. Orchestration Workflows

### 7.1 Design Principles

1. **Parallel first**: Run independent tool calls simultaneously to minimize latency
2. **Narrow before wide**: Use specific tools before broad searches
3. **KB for metadata, RAG for concepts**: Never mix them up
4. **Stop early**: If the first call answers the question, skip remaining calls

### 7.2 Table Deep Dive

For comprehensive table analysis, run in parallel:

- `d365_lookup_table` (fields, indexes, relations)
- `xref_object_summary` (who references this table)
- `xref_find_extensions` (CoC extensions)
- `d365_find_referencing_tables` (incoming foreign keys)

Then resolve any enum-type fields with `d365_get_enum`.

### 7.3 Field Investigation

Run in parallel:

- `d365_check_field_exists` (confirms existence and type)
- `d365_field_renames` (AX2012 rename history)
- `xref_find_field_usages` (who reads/writes the field)

Then `d365_get_enum` if the field is an enum type.

### 7.4 Impact Analysis

Run in parallel:

- `xref_impact_analysis` (downstream dependency tree)
- `d365_lookup_table` or `d365_get_class_methods` (current structure)
- `xref_find_extensions` (existing CoC extensions)
- `xref_find_event_handlers` (event handler subscriptions)

Then `xref_cross_module_deps` if cross-module impacts are detected.

### 7.5 Method Tracing

Run in parallel:

- `xref_find_method_callers` (incoming calls)
- `xref_method_references` (outgoing calls)
- `d365_get_method_source` (source code)

### 7.6 Security Audit

For a user: `sec_lookup_user` + `sec_effective_permissions` in parallel.

For a role: `sec_lookup_role` + `sec_role_hierarchy` + `sec_find_users_by_role` in parallel.

For an object: `sec_permission_trace` + `d365_lookup_table` in parallel.

### 7.7 Research

Run all in parallel:

- `rag_ask` (D365 documentation)
- `microsoft_docs_search` (official Microsoft docs)
- `d365_search` (AOT metadata objects)

Then conditionally: `microsoft_docs_fetch` for full articles, `microsoft_code_sample_search` for code examples.

### 7.8 Class Extensibility Analysis

Run in parallel:

- `d365_get_class_methods` (available methods)
- `xref_class_hierarchy` (inheritance chain)
- `xref_find_extensions` (existing CoC extensions)
- `xref_find_event_handlers` (existing event handlers)

---

## 8. Slash Commands

The following slash commands are available to invoke predefined multi-tool workflows:

| Command | Purpose | Example |
|---------|---------|---------|
| `/d365-table <name>` | Full table analysis with structure, usage, security, and enums | `/d365-table CustTable` |
| `/d365-impact <object>` | Impact analysis before modifying a table, class, method, or field | `/d365-impact SalesFormLetter.confirm` |
| `/d365-security <target>` | Security audit for a user, role, or object access paths | `/d365-security SystemAdministrator` |
| `/d365-research <topic>` | Research across RAG, Microsoft Learn, and KB metadata | `/d365-research "BYOD incremental sync"` |
| `/d365-trace-field <T.F>` | Trace a field: existence, type, usage, renames, enum values | `/d365-trace-field SalesTable.SalesStatus` |
| `/d365-class <name>` | Class analysis: hierarchy, methods, extensions, callers | `/d365-class SalesFormLetter` |

Each command orchestrates 3-5 parallel MCP calls, synthesizes results, and offers drill-down options.

---

## 9. Anti-Patterns

| Anti-Pattern | Why it is Inefficient | Correct Approach |
|-------------|----------------------|------------------|
| Using `d365_search` when you know the exact name | Wastes a call, returns fuzzy results | Use `d365_lookup_table` or `d365_get_enum` directly |
| Sequential calls when parallel is possible | Doubles or triples latency | Batch independent calls in one message |
| Using `d365_raw_sql` for standard lookups | Fragile, schema may change | Use purpose-built tools |
| Using `rag_ask` for metadata questions | RAG contains docs, not metadata | Use KB tools for tables/fields/enums |
| Using `microsoft_docs_fetch` without searching first | May fetch the wrong page | Search first, then fetch the best match |
| Calling `d365_hallucination_check` on every query | Unnecessary overhead | Only when generating SQL or unsure about field names |
| Calling `sec_lookup_user` for role questions | Wrong starting point | Use `sec_lookup_role` for role analysis |

---

## 10. Service Availability and Dependencies

### Local Services (d365kb, d365xref)

- **Require:** Node.js v18+, SQLite databases built from D365 metadata
- **Startup:** Loaded into memory when Claude Code session starts
- **Memory:** KB ~200 MB, XRef ~3.5 GB
- **Latency:** 1-50ms per query
- **Rebuild trigger:** D365FO version update, new custom models

### Cloud Services (d365sec, d365rag, Microsoft Learn)

- **Require:** Active internet connection, Claude.ai infrastructure
- **Availability:** Dependent on remote service uptime
- **Latency:** 100-2000ms per query (network dependent)
- **Data currency:** Updated independently of local builds

---

*Document version: 1.0*
*Date: 2026-03-26*
*Author: Florian Dittgen*
