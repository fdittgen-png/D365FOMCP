# Part 7: OData, DIXF/DMF, Web Services, REST Issue Patterns

_Reference for the `d365fo-support-scoping` skill. Read on demand._


### OData / Data Entity Issues

**Diagnostic workflow:**
```
PARALLEL:
  d365_get_entity_sources(entityName)                      -- Field mappings, staging, public name
  xref_find_extensions(entityName)                         -- Customizations on entity
  microsoft_docs_search("D365 [entityName] data entity")   -- Official entity documentation
```

**Then if needed:**
```
microsoft_docs_fetch(entity_docs_url) -- Full entity field reference, known issues
```

**Common OData issues and MCP investigation:**
| Issue | MCP Tools | What to Check |
|-------|-----------|---------------|
| Entity returns wrong data | `d365_get_entity_sources` | Verify field→table mapping |
| Missing field in entity | `d365_check_field_exists` on backing table | Field may not exist or not mapped |
| Entity not visible in OData | `d365_get_entity_sources` | Check `is_public` flag |
| Custom field not exported | `xref_find_extensions(entityName)` | Check entity extension exists |
| Import fails on staging | `d365_lookup_table(stagingTable)` | Check mandatory fields, types |
| Validation error on import | `d365_get_class_methods(entityName)` | Find validate* methods |
| Unknown error code | `microsoft_docs_search("D365 [error]")` | Official troubleshooting |

### DIXF/DMF Investigation Pattern

```
1. d365_get_entity_sources(entityName) → backing tables, field mappings
2. d365_lookup_table(stagingTable) → staging table structure
3. d365_get_class_methods(entityName, filter:"*validate*") → validation logic
4. xref_find_extensions(entityName) → CoC modifying import/export
5. sec_permission_trace(role, object_name:entityName) → DMF access
6. microsoft_docs_search("D365 DMF [entityName] import") → official DMF guidance
```

### REST / Web Service Issues

**D365FO exposes two API surfaces:**
1. **OData v4** — via data entities. `d365_get_entity_sources` → `is_public` flag.
2. **Custom Web Services** — X++ classes with `[SysServiceAttribute]`. Find via `xref_search_names("*Service*", object_type:"Classes")`.

**Investigation:**
```
PARALLEL:
  d365_get_class_methods(serviceClass)       -- Available methods
  xref_find_extensions(serviceClass)          -- CoC modifications
  sec_permission_trace(role, serviceClass)    -- Authorization
  microsoft_docs_search("D365 custom service [topic]")  -- Official patterns
```

