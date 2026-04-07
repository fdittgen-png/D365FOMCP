# D365FO MCP Services Reference

## Service Inventory

| Service | Endpoint | Tools | Database |
|---------|----------|-------|----------|
| KB | /api/d365kb | 17 | SQLite (AOT metadata) |
| XRef | /api/d365xref | 16 | SQLite (cross-references) |
| Security | /api/d365sec | 15 | D365 security model |
| Task Recorder | /api/d365taskrecorder | 1 | N/A (file parsing) |
| **Total** | | **49** | |

### Architecture

All local MCP servers follow the same pattern:

1. Data is extracted from D365 sources into SQLite databases
2. An MCP server loads the SQLite database into memory at startup
3. Claude Code communicates with the server via JSON-RPC over stdio
4. Queries execute in 1-50ms (in-memory SQLite)

Cloud-based services (d365sec) are hosted remotely and accessed via the MCP protocol through the Claude.ai infrastructure.

---

## 1. Knowledge Base Tools (17)

The Knowledge Base provides structured access to the entire D365 Finance & Operations Application Object Tree (AOT) metadata. It answers questions like "What fields does CustTable have?", "What are the values of enum SalesStatus?", and "Does field XYZ exist on table ABC?".

### Data Coverage

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

---

### d365_lookup_table

Get complete metadata for a D365FO table: fields (name, type, EDT), primary key, indexes, and foreign key relations. Returns a compact Markdown summary.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| table_name | string (max 500) | Yes | Table name (case-insensitive, e.g. CustInvoiceJour) |

**Example use case:** "Show me the structure of SalesTable including all fields, indexes, and relations."

---

### d365_get_join_keys

Get the exact join fields between two D365FO tables. Critical for writing correct SQL joins.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| table1 | string (max 500) | Yes | First table name |
| table2 | string (max 500) | Yes | Second table name |

**Example use case:** "How do I join CustInvoiceJour to CustInvoiceTrans?"

---

### d365_search

Full-text search across all D365FO objects (tables, classes, enums, entities). Use for discovery queries like "find tables related to inventory" or "classes that handle product release".

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| query | string (max 1000) | Yes | Search query (keywords) |
| object_type | string (max 500) | No | Optional filter: table, class, enum, entity |
| limit | number | No | Max results (default 20) |

**Example use case:** "Find objects related to vendor invoicing."

---

### d365_get_enum

Get all values for a D365FO enum with their numeric values. Essential for correct enum usage in SQL and X++.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| enum_name | string (max 500) | Yes | Enum name (e.g. StatusIssue, InventTransType) |

**Example use case:** "What are the numeric values of SalesStatus?"

---

### d365_check_field_exists

Verify if fields exist on a D365FO table. Returns existence status and suggests corrections for non-existent fields. Use BEFORE generating SQL to prevent hallucinated column names.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| table_name | string (max 500) | Yes | Table name |
| field_names | array of string (max 500 each) | Yes | Array of field names to check |

**Example use case:** "Verify that CustTable has fields AccountNum, CreditLimit, and CustName before writing SQL."

---

### d365_get_class_methods

Get method signatures (and optionally full X++ source code) for a D365FO class or table. Use include_source=true to get the complete method bodies.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| name | string (max 500) | Yes | Class or table name |
| filter | string (max 500) | No | Optional filter on method name (LIKE pattern) |
| include_source | boolean | No | If true, include full X++ source code for each method (default false) |
| limit | number | No | Max results (default 100) |

**Example use case:** "What methods does SalesFormLetter have? Show me methods matching 'validate' with source code."

---

### d365_get_method_source

Get the full X++ source code for a specific method on a class or table. Use this for targeted code analysis when you know the exact method name.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| owner_name | string (max 500) | Yes | Class or table name |
| method_name | string (max 500) | Yes | Method name |

**Example use case:** "Show me the source of SalesFormLetter.confirm."

---

### d365_find_referencing_tables

Find all tables that have foreign key relationships TO a given table. Useful for impact analysis.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| table_name | string (max 500) | Yes | Target table name |

**Example use case:** "What tables have foreign keys pointing to CustTable?"

---

### d365_get_module_summary

Get a summary of a D365FO module/package: object counts and key tables/classes.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| module_name | string (max 500) | Yes | Module name (e.g. ApplicationSuite, EngineeringChangeManagement) |

**Example use case:** "Show me an overview of the ApplicationSuite module."

---

### d365_get_entity_sources

Get data source chain and fields for a D365FO data entity. Shows the primary table and OData name.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| entity_name | string (max 500) | Yes | Data entity name |

**Example use case:** "What are the source tables and fields for CustCustomerEntity?"

---

### d365_sql_template

Get a pre-validated SQL query template for common D365FO scenarios. Templates have correct join keys and field names.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| scenario | string (max 500) | No | Search term for template (e.g. "customer invoice", "vendor", "GL entries"). Leave empty to list all. |

**Example use case:** "Show me a SQL template for customer invoices."

---

### d365_hallucination_check

Check for known D365FO hallucination traps for a table. Returns common LLM mistakes and their corrections.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| table_name | string (max 500) | Yes | Table name to check traps for |

**Example use case:** "Check CustTable for known hallucination traps before writing SQL."

---

### d365_raw_sql

Execute a raw SQL query against the D365FO knowledge base. Use for ad-hoc queries not covered by other tools. READ-ONLY, limited to 500 rows. Schema: kb_tables(table_name, table_group, ...), kb_fields(table_name, field_name, ...), kb_enums(enum_name, ...), kb_classes(class_name, ...), kb_methods(class_name, method_name, source_code, ...), kb_search(object_type, object_name, content), kb_relations(...), kb_entities(...)

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| sql | string (max 50000) | Yes | SQL SELECT query to execute |

**Example use case:** "SELECT table_name, field_count FROM tables WHERE module_id = 'ApplicationSuite' ORDER BY field_count DESC LIMIT 10"

---

### d365_graph_traverse

Traverse the D365FO object dependency graph. Find related tables, class hierarchies, or entity-to-table mappings within N hops.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| start_node | string (max 500) | Yes | Starting object name |
| max_depth | number | No | Maximum traversal depth (default 2) |
| edge_type | string (max 500) | No | Optional edge type filter: FK, extends, datasource |

**Example use case:** "Traverse the dependency graph from SalesTable up to 3 hops following FK edges."

---

### d365_field_renames

Look up AX2012-to-D365FO field renames for a table. Prevents using obsolete field names.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| table_name | string (max 500) | Yes | Table name |

**Example use case:** "Were any fields renamed on CustTable from AX2012 to D365FO?"

---

### d365_list_modules

List all D365FO modules/packages with object counts. The Level-0 directory of the entire knowledge base.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| _(none)_ | | | |

**Example use case:** "List all available D365FO modules."

---

### d365_resolve_label

Resolve D365FO label IDs (like @SYS12345) to human-readable text. Use when you encounter unresolved label references.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| label_ids | array of string (max 500 each) | Yes | Array of label IDs to resolve (e.g. ["@SYS12345", "@SYS67890"]) |

**Example use case:** "Resolve labels @SYS12345 and @SYS67890 to their display text."

---

## 2. Cross-Reference Tools (16)

The Cross-Reference service answers "who uses what" questions across the entire D365 codebase. It tracks 26.6 million references between 5.8 million named objects, covering method calls, field reads, class inheritance, interface implementation, and more.

### Data Coverage

| Metric | Count |
|--------|-------|
| Named paths (objects) | 5,821,999 |
| References between them | 26,589,848 |
| Modules | 390 |
| Reference kinds | 8 |

### Reference Kinds

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

### Path Format

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

---

### xref_find_references

Find all objects that reference a given D365FO object (who calls/reads/extends it). This is the "Used By" / "Find All References" query.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| object_name | string (max 500) | Yes | Object name (e.g. "SalesTable", "CustInvoiceJour") or full path (e.g. "/Classes/SalesFormLetter") |
| kind | enum: All, Call, Read, Implements, Extends, Delegate, Attribute, Override | No | Filter by reference kind (default: All) |
| limit | number | No | Max results (default 100) |

**Example use case:** "Who uses CustTable? Show me all references filtered to Extends only."

---

### xref_find_usages

Find all objects that a given D365FO object references (what it calls/reads/extends). This is the "Uses" / outgoing references query.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| object_name | string (max 500) | Yes | Object name or full path |
| kind | enum: All, Call, Read, Implements, Extends, Delegate, Attribute, Override | No | Filter by reference kind (default: All) |
| limit | number | No | Max results (default 100) |

**Example use case:** "What does SalesFormLetter depend on?"

---

### xref_find_method_callers

Find all callers of a specific method on a class or table. Returns source locations with line numbers.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| object_name | string (max 500) | Yes | Class or table name (e.g. "SalesFormLetter") |
| method_name | string (max 500) | Yes | Method name (e.g. "construct", "run") |
| limit | number | No | Max results (default 100) |

**Example use case:** "Who calls SalesFormLetter.confirm?"

---

### xref_class_hierarchy

Find the full class inheritance hierarchy -- all subclasses (recursive) or the parent chain of a given class.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| class_name | string (max 500) | Yes | Class name (e.g. "SalesFormLetter", "FormLetterServiceController") |
| direction | enum: subclasses, parents | No | "subclasses" = who extends this (default), "parents" = what does this extend |

**Example use case:** "Show all subclasses of InventMovement."

---

### xref_interface_implementors

Find all classes that implement a given interface, including indirect implementors through inheritance.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| interface_name | string (max 500) | Yes | Interface name (e.g. "SysRunnable", "SysPackable") |

**Example use case:** "Who implements SysRunnable?"

---

### xref_search_names

Search for D365FO objects by name pattern in the cross-reference database. Use to discover objects when you only know part of the name.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| pattern | string (max 500) | Yes | Search pattern (e.g. "SalesInvoice", "CustTrans"). Supports SQL LIKE wildcards (%). |
| object_type | enum: All, Classes, Tables, Forms, Enums, DataEntityViews, Edts, Views, Maps, Labels | No | Filter by object type (default: All) |
| limit | number | No | Max results (default 50) |

**Example use case:** "Find all classes starting with 'SalesForm'."

---

### xref_method_references

Find all outgoing references from a specific method -- what objects/methods/types does it call or use.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| object_name | string (max 500) | Yes | Class or table name |
| method_name | string (max 500) | Yes | Method name |
| kind | enum: All, Call, Read | No | Filter: All, Call (method invocations only), Read (type/field reads only). Default: All |
| limit | number | No | Max results (default 100) |

**Example use case:** "What does SalesFormLetter.confirm call internally?"

---

### xref_module_objects

List all top-level objects (classes, tables, forms, etc.) in a given D365FO module from the cross-reference database.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| module_name | string (max 500) | Yes | Module name (e.g. "ApplicationSuite", "EngineeringChangeManagement") |
| object_type | enum: All, Classes, Tables, Forms, Enums, DataEntityViews, Edts, Views | No | Filter by object type (default: All) |
| limit | number | No | Max results (default 200) |

**Example use case:** "List all tables in the EngineeringChangeManagement module."

---

### xref_cross_module_deps

Analyze cross-module dependencies: which modules does a given module depend on (or which modules depend on it).

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| module_name | string (max 500) | Yes | Module name |
| direction | enum: depends_on, depended_by | No | "depends_on" = modules this module references (default), "depended_by" = modules that reference this one |
| limit | number | No | Max results (default 50) |

**Example use case:** "Which modules does EngineeringChangeManagement depend on?"

---

### xref_raw_sql

Execute a read-only SQL query against the XRef SQLite database. Schema: names(id,path,provider_id,module_id), refs(source_id,target_id,kind,line,col), modules(id,module), providers(id,provider).

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| sql | string (max 50000) | Yes | SQL SELECT query (no schema prefix needed -- use table names directly) |
| limit | number | No | Max rows (default 100) |

**Example use case:** "SELECT path FROM names WHERE path LIKE '/Classes/Sales%' LIMIT 20"

---

### xref_impact_analysis

Analyze the impact of changing a D365FO object: find all direct dependents grouped by type and module. Essential before modifying shared classes, tables, or methods. Performs single-level (direct) impact analysis.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| object_name | string (max 500) | Yes | Object name or path |

**Example use case:** "What is the impact of modifying SalesTable?"

---

### xref_list_modules

List all D365FO modules in the XRef database with object counts.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| _(none)_ | | | |

**Example use case:** "List all modules available in the XRef database."

---

### xref_object_summary

Get a compact summary of an object: incoming vs outgoing reference counts by kind, methods, sub-objects, and module.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| object_name | string (max 500) | Yes | Object name or path |

**Example use case:** "Give me a quick reference profile for SalesFormLetter."

---

### xref_find_extensions

Find all Chain of Command (CoC) extension classes and table/form extensions for a D365FO object. Shows [ExtensionOf] classes that wrap the target with CoC methods using "next". Finds extensions by naming convention. Results may include false positives for common name prefixes.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| object_name | string (max 500) | Yes | Object name (e.g. "SalesTable", "CustTable", "SalesFormLetter") |
| object_type | enum: All, Classes, Tables, Forms, DataEntityViews | No | Object type to search for extensions (default: All) |
| limit | number | No | Max results (default 100) |

**Example use case:** "Find all CoC extensions on CustTable."

---

### xref_find_field_usages

Find all code locations that read or write a specific field on a D365FO table. Returns callers with line numbers, grouped by kind (Read vs Call/Write).

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| table_name | string (max 500) | Yes | Table name (e.g. "CustTable", "SalesTable") |
| field_name | string (max 500) | Yes | Field name (e.g. "AccountNum", "InvoiceId") |
| kind | enum: All, Read, Write | No | Filter: All, Read (field value reads), Write (field assignments). Default: All |
| limit | number | No | Max results (default 100) |

**Example use case:** "Who reads SalesTable.SalesStatus?"

---

### xref_find_event_handlers

Find all event handlers and delegates for a D365FO object or method. Discovers [SubscribesTo], [DataEventHandler], [PreHandlerFor], [PostHandlerFor] subscriptions, and delegate definitions.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| object_name | string (max 500) | Yes | Class or table name (e.g. "SalesFormLetter", "CustTable") |
| method_name | string (max 500) | No | Optional: specific method/delegate name to find handlers for |
| limit | number | No | Max results (default 100) |

**Example use case:** "What event handlers subscribe to SalesFormLetter events?"

---

## 3. Security Tools (15)

The Security service provides access to the D365 role-based security model. It can answer questions about user access, role assignments, duty/privilege structures, and permission traces.

### Security Model Hierarchy

```
User
  -> Security Role(s)
    -> Security Duty/Duties
      -> Security Privilege(s)
        -> Permission(s) on AOT objects (Table, Form, Menu Item, etc.)
```

---

### sec_lookup_role

Get complete security role details: description, license type, Grant/Deny, sub-roles, duties, and direct privileges.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| role_name | string (max 500) | Yes | Role name (case-insensitive) |

**Example use case:** "Show me the full structure of the SystemAdministrator role."

---

### sec_lookup_duty

Get duty details: parent roles, privileges granted, and entry points.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| duty_name | string (max 500) | Yes | Duty ID or name (case-insensitive) |

**Example use case:** "What privileges are in the SalesOrderMaintain duty?"

---

### sec_lookup_privilege

Get privilege details: entry points with CRUD grants, parent duties, and parent roles.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| privilege_name | string (max 500) | Yes | Privilege name (case-insensitive) |

**Example use case:** "What entry points does the CustTableMaintain privilege grant?"

---

### sec_lookup_user

Get user profile: roles, company scoping, enabled status, and email.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| user_id | string (max 500) | Yes | User ID (case-insensitive) |

**Example use case:** "Show me the roles and companies for user FDittgen."

---

### sec_role_hierarchy

Show the sub-role hierarchy for a role (children that inherit from it, or parents it inherits from).

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| role_name | string (max 500) | Yes | Role name |
| direction | enum: children, parents | No | Traverse direction (default: children) |

**Example use case:** "What sub-roles does SystemAdministrator inherit?"

---

### sec_find_users_by_role

Find all users assigned to a role, optionally filtered to a specific company.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| role_name | string (max 500) | Yes | Role name |
| company_id | string (max 500) | No | Filter to users scoped to this company |
| limit | number | No | Max results (default 100) |

**Example use case:** "List all users with the SystemAdministrator role in company LADE."

---

### sec_find_roles_by_duty

Find all roles that contain a specific duty.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| duty_name | string (max 500) | Yes | Duty ID or name |

**Example use case:** "Which roles contain the SalesOrderMaintain duty?"

---

### sec_find_roles_by_privilege

Find all roles that grant a privilege (via the duty chain or directly).

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| privilege_name | string (max 500) | Yes | Privilege name |

**Example use case:** "Which roles grant the CustTableMaintain privilege?"

---

### sec_company_users

List all users and their roles for a specific company (legal entity).

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| company_id | string (max 500) | Yes | Company / legal entity ID (e.g., LADE, TAB) |
| limit | number | No | Max results (default 200) |

**Example use case:** "List all users and their roles in company LADE."

---

### sec_permission_trace

Trace the full permission chain for a role: role -> duties -> privileges -> entry points with CRUD. Optionally filter to a specific target object.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| role_name | string (max 500) | Yes | Role name |
| object_name | string (max 500) | No | Filter to entry points targeting this object |
| limit | number | No | Max results (default 500) |

**Example use case:** "Trace how SalesClerk gets access to CustTable."

---

### sec_compare_roles

Compare two roles side by side: shared vs unique duties and privileges.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| role1 | string (max 500) | Yes | First role name |
| role2 | string (max 500) | Yes | Second role name |

**Example use case:** "Compare SalesClerk and SalesManager to see what permissions differ."

---

### sec_effective_permissions

Compute flattened effective permissions for a user or role: all entry points with CRUD grants, resolving sub-roles. Optionally filter by object name or company.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| user_id | string (max 500) | No | User ID (provide this OR role_name) |
| role_name | string (max 500) | No | Role name (provide this OR user_id) |
| object_name | string (max 500) | No | Filter to entry points for this object |
| limit | number | No | Max results (default 200) |

**Example use case:** "Can user FDittgen access CustTable? Show effective permissions."

---

### sec_search

Full-text search across roles, duties, privileges, and users.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| query | string (max 500) | Yes | Search keywords |
| object_type | enum: role, duty, privilege, user | No | Filter: role, duty, privilege, user |
| limit | number | No | Max results (default 20) |

**Example use case:** "Search for security objects related to 'inventory'."

---

### sec_stats

Get summary statistics for the security database: role counts, user counts, company count, etc.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| _(none)_ | | | |

**Example use case:** "How many roles, duties, and users are in the security database?"

---

### sec_raw_sql

Execute a raw SQL query against the security database. READ-ONLY, 500-row limit. Schema: roles(role_id, role_name, label, description, module_id, license_type, permission_type, source), duties(duty_id, duty_name, module_id, description), privileges(privilege_name, module_id, label), role_duties(role_id, duty_id, permission_type), role_direct_privileges(role_id, privilege_name), duty_privileges(duty_id, privilege_name), privilege_entry_points(privilege_name, entry_point_name, object_type, object_name, grant_read, grant_create, grant_update, grant_delete, grant_correct, grant_invoke), users(user_id, person_name, email, enabled, default_company), user_roles(user_id, role_id), user_role_companies(user_id, role_id, company_id), role_subroles(parent_role_id, child_role_id, is_transitive), role_direct_entity_permissions(role_id, entity_name, grant_read, grant_create, grant_update, grant_delete, grant_correct, grant_invoke)

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| sql | string (max 50000) | Yes | SQL SELECT query |

**Example use case:** "SELECT role_name, license_type FROM roles WHERE permission_type = 'Grant' ORDER BY role_name"

---

## 4. Task Recorder Tools (1)

The Task Recorder service parses D365FO Task Recorder (.axtr) files and returns structured Markdown documents describing recorded test cases.

---

### taskrecorder_to_markdown

Parse a D365FO Task Recorder (.axtr) file and return a structured Markdown document describing the recorded test case. The output includes: overview, forms visited, every recorded step (commands, data entry, validations, subtasks, navigation), data sources, security roles, navigation flow, and scope tree.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| file_content | string (max 20000000) | Yes | Base64-encoded contents of the .axtr file |
| file_name | string (max 255) | No | Original filename (used in the generated footer, default: "recording.axtr") |

**Example use case:** "Parse this task recording to extract the steps, forms, and security roles involved."

---

## 5. Orchestration Workflows

### 5.1 Design Principles

1. **Parallel first**: Run independent tool calls simultaneously to minimize latency
2. **Narrow before wide**: Use specific tools before broad searches
3. **KB for metadata, RAG for concepts**: Never mix them up
4. **Stop early**: If the first call answers the question, skip remaining calls

### 5.2 Table Deep Dive

For comprehensive table analysis, run in parallel:

- `d365_lookup_table(table_name)` -- fields, indexes, relations
- `xref_object_summary(object_name)` -- who references this table
- `xref_find_extensions(object_name)` -- CoC extensions
- `d365_find_referencing_tables(table_name)` -- incoming foreign keys

Then resolve any enum-type fields with `d365_get_enum(enum_name)`.

### 5.3 Field Investigation

Run in parallel:

- `d365_check_field_exists(table_name, field_names)` -- confirms existence and type
- `d365_field_renames(table_name)` -- AX2012 rename history
- `xref_find_field_usages(table_name, field_name)` -- who reads/writes the field

Then `d365_get_enum(enum_name)` if the field is an enum type.

### 5.4 Impact Analysis

Run in parallel:

- `xref_impact_analysis(object_name)` -- downstream dependency tree
- `d365_lookup_table(table_name)` or `d365_get_class_methods(name)` -- current structure
- `xref_find_extensions(object_name)` -- existing CoC extensions
- `xref_find_event_handlers(object_name)` -- event handler subscriptions

Then `xref_cross_module_deps(module_name)` if cross-module impacts are detected.

### 5.5 Method Tracing

Run in parallel:

- `xref_find_method_callers(object_name, method_name)` -- incoming calls
- `xref_method_references(object_name, method_name)` -- outgoing calls
- `d365_get_method_source(owner_name, method_name)` -- source code

### 5.6 Security Audit

For a user: `sec_lookup_user(user_id)` + `sec_effective_permissions(user_id)` in parallel.

For a role: `sec_lookup_role(role_name)` + `sec_role_hierarchy(role_name)` + `sec_find_users_by_role(role_name)` in parallel.

For an object: `sec_permission_trace(role_name, object_name)` + `d365_lookup_table(table_name)` in parallel.

### 5.7 Class Extensibility Analysis

Run in parallel:

- `d365_get_class_methods(name)` -- available methods
- `xref_class_hierarchy(class_name)` -- inheritance chain
- `xref_find_extensions(object_name)` -- existing CoC extensions
- `xref_find_event_handlers(object_name)` -- existing event handlers

### 5.8 Task Recording Analysis

1. `taskrecorder_to_markdown(file_content)` -- parse the .axtr file
2. From the output, identify forms and tables, then run in parallel:
   - `d365_lookup_table(table_name)` for each key table
   - `sec_lookup_role(role_name)` for each security role referenced

---

## 6. Anti-Patterns

| Anti-Pattern | Why it is Inefficient | Correct Approach |
|-------------|----------------------|------------------|
| Using `d365_search` when you know the exact name | Wastes a call, returns fuzzy results | Use `d365_lookup_table` or `d365_get_enum` directly |
| Sequential calls when parallel is possible | Doubles or triples latency | Batch independent calls in one message |
| Using `d365_raw_sql` for standard lookups | Fragile, schema may change | Use purpose-built tools |
| Calling `d365_hallucination_check` on every query | Unnecessary overhead | Only when generating SQL or unsure about field names |
| Calling `sec_lookup_user` for role questions | Wrong starting point | Use `sec_lookup_role` for role analysis |

---

## 7. Slash Commands

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

*Document version: 2.0*
*Date: 2026-04-07*
*Author: Florian Dittgen*
