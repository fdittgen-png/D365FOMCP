# Copilot Studio Configuration Guide: D365FO MCP Services

**Project**: tis-p-mcpd365fo
**Owner**: Trelleborg IT Services (TIS)
**Version**: 1.0
**Date**: 2026-03-25
**Author**: Florian Dittgen
**Status**: Current

---

This guide explains how to connect the D365FO MCP Services to a **Microsoft Copilot Studio** agent. Copilot Studio supports MCP connections but requires explicit tool registration via the `knownTools` property to enable proper generative orchestration.

> **Important:** Without `knownTools`, Copilot Studio routes all requests through a generic `InvokeServer` endpoint instead of calling specific named tools. This breaks tool selection and must be configured manually.

---

## 1. Prerequisites

- A Copilot Studio agent (existing or new)
- Access to the D365FO MCP endpoints:

| Environment | Service | URL |
|-------------|---------|-----|
| Development | KB | `https://tis-d-mcpd365fo-func.azurewebsites.net/api/d365kb` |
| Development | XRef | `https://tis-d-mcpd365fo-func.azurewebsites.net/api/d365xref` |
| Production | KB | `https://tis-p-mcpd365fo-func.azurewebsites.net/api/d365kb` |
| Production | XRef | `https://tis-p-mcpd365fo-func.azurewebsites.net/api/d365xref` |

---

## 2. Add MCP Connections

In your Copilot Studio agent:

1. Go to **Actions** (or **Connections**, depending on UI version)
2. Add a new **MCP Server** connection for each service:

| Connection Name | Endpoint URL |
|-----------------|--------------|
| D365-KB | `https://tis-p-mcpd365fo-func.azurewebsites.net/api/d365kb` |
| D365-Reference | `https://tis-p-mcpd365fo-func.azurewebsites.net/api/d365xref` |

3. Save both connections

At this point, Copilot Studio can reach the MCP servers, but the generative engine does not yet know which tools are available. The next step is required.

---

## 3. Populate `knownTools` (Required)

### 3.1 Why This Is Needed

Copilot Studio's generative orchestration engine needs an explicit list of tool names per MCP connection. Without it, the engine falls back to a generic `InvokeServer` endpoint and cannot route to specific tools. This results in:

- Poor or no tool selection
- Generic error responses
- The agent failing to use MCP tools in conversation

### 3.2 Tool Names to Register

#### D365-KB Connection -- 17 tools

```
d365_lookup_table
d365_get_join_keys
d365_search
d365_get_enum
d365_check_field_exists
d365_get_class_methods
d365_get_method_source
d365_find_referencing_tables
d365_get_module_summary
d365_get_entity_sources
d365_sql_template
d365_hallucination_check
d365_raw_sql
d365_graph_traverse
d365_field_renames
d365_list_modules
d365_resolve_label
```

#### D365-Reference (XRef) Connection -- 16 tools

```
xref_find_references
xref_find_usages
xref_find_method_callers
xref_class_hierarchy
xref_interface_implementors
xref_search_names
xref_method_references
xref_module_objects
xref_cross_module_deps
xref_raw_sql
xref_impact_analysis
xref_list_modules
xref_object_summary
xref_find_extensions
xref_find_field_usages
xref_find_event_handlers
```

### 3.3 How to Edit `knownTools`

There are two approaches to populate the `knownTools` property.

#### Option A: Edit in Copilot Studio UI

1. Open the agent in Copilot Studio
2. Navigate to each MCP connection action/dialog
3. Find the `knownTools` property in the connection configuration
4. Add all tool names as a list
5. Save and publish

#### Option B: Export Solution, Edit File, Rezip & Re-import

This approach is more efficient when adding many tool names at once.

1. **Export** the Copilot Studio solution as an **unmanaged** solution (.zip) from the Power Platform maker portal
2. **Unzip** the solution package to a local folder
3. **Locate** the data files for the two MCP connections:
   - The **D365-Reference** TaskDialog data file (for the XRef connection)
   - The **D365-KB** action data file (for the KB connection)
4. **Edit** each file to add the `knownTools` property listing all tool names (see section 3.2)
5. **Rezip** the solution, preserving the original folder structure
6. **Import** the modified solution back into the Power Platform environment

> **Tip:** When rezipping, make sure the `[Content_Types].xml` and `customizations.xml` files remain at the root of the zip -- do not nest them inside an extra folder.

---

## 4. Verify the Configuration

After configuring `knownTools` on both connections:

1. **Open** the Copilot Studio test panel
2. **Ask** a D365-related question, for example:
   - "Look up the CustTable table structure"
   - "Who calls SalesTable.find()?"
   - "What classes extend SalesFormLetter?"
3. **Check** the conversation trace / activity log to confirm that:
   - The agent calls **specific named tools** (e.g., `d365_lookup_table`, `xref_find_method_callers`)
   - It does **not** fall back to the generic `InvokeServer` endpoint

If you still see `InvokeServer` calls, double-check that:
- Tool names are spelled exactly as listed in section 3.2
- `knownTools` is populated in **both** MCP connections
- The solution was re-imported successfully

---

## 5. Keeping Tools in Sync

When new tools are added to the MCP servers (in `src/azure/kb-tools.js` or `src/azure/xref-tools.js`), the `knownTools` list in Copilot Studio must be updated to include the new tool names. Otherwise, the new tools will not be available to the agent.

Check the current tool count:
- **KB tools**: see comment at top of `src/azure/kb-tools.js` (currently 17)
- **XRef tools**: see comment at top of `src/azure/xref-tools.js` (currently 16)

---

## 6. Troubleshooting

| Issue | Resolution |
|-------|-----------|
| Agent uses `InvokeServer` instead of named tools | `knownTools` is not populated -- follow section 3 |
| Agent cannot reach MCP endpoint | Verify the URL is correct and the Function App is running (GET the URL -- should return `{"status":"ok"}`) |
| Some tools work but others don't | Check that all tool names are listed in `knownTools` -- a missing entry means that tool is invisible to the orchestrator |
| Solution import fails after rezip | Ensure the zip structure matches the original export exactly (no extra nested folders) |
| Tools return errors | Check Application Insights in the Azure Portal for the Function App |

---

## 7. Reference: Tool Descriptions

For full tool documentation including parameters and descriptions, see [AI Configuration Guide -- Available Tools Reference](AI-Configuration.md#10-available-tools-reference).
