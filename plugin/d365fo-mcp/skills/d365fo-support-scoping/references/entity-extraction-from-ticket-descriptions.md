# Part 5: Entity Extraction from Ticket Descriptions

_Reference for the `d365fo-support-scoping` skill. Read on demand._


### Extraction Patterns

| Entity Type | Detection Pattern | Verification Tool |
|------------|-------------------|-------------------|
| Table name | PascalCase 2+ words (CustTable, SalesLine) | `d365_lookup_table` |
| Field name | Table.Field pattern, quoted field labels | `d365_check_field_exists` |
| Form name | "on the [X] form", "[X] page", nav paths | `d365_search(keywords, object_type:"form")` |
| Class name | PascalCase ending in *FormLetter, *Controller | `d365_get_class_methods` |
| User ID | Email, domain\user, "user [name]" | `sec_lookup_user` |
| Error message | Quoted text, "error:", stack traces | `rag_search` + `microsoft_docs_search` in parallel |
| Process name | "posting", "approval", "settlement" | `rag_ask` + `microsoft_docs_search` in parallel |
| Company code | 4-letter uppercase (LADE, DEMF, KAIN) | `sec_company_users` |
| Menu item | "Accounts receivable > ..." | `d365_search(keywords)` |
| Data entity | PascalCase ending in *Entity, *V2 | `d365_get_entity_sources` |

### Disambiguation Rules

- "CustAccount" could be field or table → `d365_check_field_exists("CustTable", ["CustAccount"])` first
- "Sales order" is a process → `rag_ask` + `microsoft_docs_search` for process context, `d365_search("SalesTable")` for objects
- Error messages with AX2012 names → `d365_field_renames` to map to D365FO names

