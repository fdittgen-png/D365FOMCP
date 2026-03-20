# AI Configuration Guide: D365FO MCP Services

**Project**: tis-p-mcpd365fo
**Owner**: Trelleborg IT Services (TIS)
**Version**: 2.0
**Date**: 2026-03-19
**Author**: Florian Dittgen
**Status**: Current

---

This guide explains how to connect AI coding assistants to the D365FO MCP Services. Two services are available:

- **d365kb** -- Knowledge Base (tables, fields, classes, methods, enums, entities, security)
- **d365xref** -- Cross-Reference (code dependencies, call graphs, impact analysis)

Both services expose tools via the **Model Context Protocol (MCP)**.

---

## 1. Service URLs

| Environment | Service | URL |
|-------------|---------|-----|
| Development | KB | `https://tis-d-mcpd365fo-func.azurewebsites.net/api/d365kb` |
| Development | XRef | `https://tis-d-mcpd365fo-func.azurewebsites.net/api/d365xref` |
| Production | KB | `https://tis-p-mcpd365fo-func.azurewebsites.net/api/d365kb` |
| Production | XRef | `https://tis-p-mcpd365fo-func.azurewebsites.net/api/d365xref` |

**Health check:** `GET` to any endpoint returns `{ "name": "...", "version": "1.0.0", "status": "ok" }`.

---

## 2. Claude Code

Claude Code supports MCP natively via both remote (HTTP) and local (stdio) transports.

### 2.1 Remote (Azure-hosted)

Add to Claude Code MCP settings (`.claude/settings.json` or via `claude mcp add`):

```json
{
  "mcpServers": {
    "d365kb": {
      "type": "url",
      "url": "https://tis-d-mcpd365fo-func.azurewebsites.net/api/d365kb"
    },
    "d365xref": {
      "type": "url",
      "url": "https://tis-d-mcpd365fo-func.azurewebsites.net/api/d365xref"
    }
  }
}
```

Or via CLI:

```bash
claude mcp add d365kb url https://tis-d-mcpd365fo-func.azurewebsites.net/api/d365kb
claude mcp add d365xref url https://tis-d-mcpd365fo-func.azurewebsites.net/api/d365xref
```

### 2.2 Local (stdio, for development)

Requires the SQLite databases in `%USERPROFILE%\.claude\`:

```json
{
  "mcpServers": {
    "d365kb": {
      "type": "stdio",
      "command": "node",
      "args": ["C:\\working\\MCP\\src\\local\\mcp-server-kb.js"]
    },
    "d365xref": {
      "type": "stdio",
      "command": "node",
      "args": ["C:\\working\\MCP\\src\\local\\mcp-server-xref.js"]
    }
  }
}
```

---

## 3. Claude Desktop

Claude Desktop supports MCP via `claude_desktop_config.json`.

### 3.1 Remote (Azure-hosted)

Edit `claude_desktop_config.json` (typically at `%APPDATA%\Claude\claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "d365kb": {
      "type": "url",
      "url": "https://tis-d-mcpd365fo-func.azurewebsites.net/api/d365kb"
    },
    "d365xref": {
      "type": "url",
      "url": "https://tis-d-mcpd365fo-func.azurewebsites.net/api/d365xref"
    }
  }
}
```

### 3.2 Local (stdio)

```json
{
  "mcpServers": {
    "d365kb": {
      "command": "node",
      "args": ["C:\\working\\MCP\\src\\local\\mcp-server-kb.js"]
    },
    "d365xref": {
      "command": "node",
      "args": ["C:\\working\\MCP\\src\\local\\mcp-server-xref.js"]
    }
  }
}
```

---

## 4. Cursor

Cursor supports MCP servers natively. Configure via **Settings > MCP Servers**.

### 4.1 Remote (Azure-hosted)

In Cursor settings (`.cursor/mcp.json` in your project, or global settings):

```json
{
  "mcpServers": {
    "d365kb": {
      "url": "https://tis-d-mcpd365fo-func.azurewebsites.net/api/d365kb"
    },
    "d365xref": {
      "url": "https://tis-d-mcpd365fo-func.azurewebsites.net/api/d365xref"
    }
  }
}
```

### 4.2 Local (stdio)

```json
{
  "mcpServers": {
    "d365kb": {
      "command": "node",
      "args": ["C:\\working\\MCP\\src\\local\\mcp-server-kb.js"]
    },
    "d365xref": {
      "command": "node",
      "args": ["C:\\working\\MCP\\src\\local\\mcp-server-xref.js"]
    }
  }
}
```

---

## 5. GitHub Copilot (VS Code)

GitHub Copilot supports MCP servers via the VS Code extension. Requires **Copilot Chat** with agent mode enabled.

### 5.1 Configuration

Add to your VS Code workspace settings (`.vscode/settings.json`) or user settings:

```json
{
  "github.copilot.chat.experimental.mcpServers": {
    "d365kb": {
      "type": "http",
      "url": "https://tis-d-mcpd365fo-func.azurewebsites.net/api/d365kb"
    },
    "d365xref": {
      "type": "http",
      "url": "https://tis-d-mcpd365fo-func.azurewebsites.net/api/d365xref"
    }
  }
}
```

Alternatively, create `.vscode/mcp.json` in your project:

```json
{
  "servers": {
    "d365kb": {
      "type": "http",
      "url": "https://tis-d-mcpd365fo-func.azurewebsites.net/api/d365kb"
    },
    "d365xref": {
      "type": "http",
      "url": "https://tis-d-mcpd365fo-func.azurewebsites.net/api/d365xref"
    }
  }
}
```

### 5.2 Usage

In Copilot Chat, use agent mode (`@workspace` or the agent icon) -- MCP tools will appear automatically. You can invoke tools by asking D365FO-related questions, for example:

- "Look up the CustTable table structure"
- "Who calls SalesTable.find()?"
- "What classes extend SalesFormLetter?"

---

## 6. ChatGPT (Custom GPT with Actions)

ChatGPT does not natively support MCP. Integration requires wrapping the MCP endpoints as an **OpenAPI-compatible API** or using a **Custom GPT with Actions**.

### 6.1 Approach: Custom GPT with Actions

Since the MCP endpoints use JSON-RPC over HTTP, ChatGPT can interact with them via a thin wrapper or by posting raw JSON-RPC requests.

**Option A: Direct JSON-RPC (Custom Action)**

Create a Custom GPT Action with this OpenAPI schema pattern:

```yaml
openapi: 3.1.0
info:
  title: D365FO Knowledge Base
  version: 1.0.0
servers:
  - url: https://tis-d-mcpd365fo-func.azurewebsites.net
paths:
  /api/d365kb:
    post:
      operationId: mcpKbToolCall
      summary: Call a D365FO KB tool via MCP JSON-RPC
      requestBody:
        required: true
        content:
          application/json:
            schema:
              type: object
              properties:
                jsonrpc:
                  type: string
                  enum: ["2.0"]
                id:
                  type: integer
                method:
                  type: string
                  enum: ["tools/call"]
                params:
                  type: object
                  properties:
                    name:
                      type: string
                      description: "Tool name (e.g. d365_lookup_table)"
                    arguments:
                      type: object
      responses:
        '200':
          description: MCP JSON-RPC response
```

**Option B: MCP Gateway**

Use an MCP-to-REST gateway (e.g., [mcp-gateway](https://github.com/anthropics/mcp-gateway) or a custom Azure API Management policy) to expose each tool as a separate REST endpoint that ChatGPT can call directly.

### 6.2 Instructions for the Custom GPT

Add these instructions to the Custom GPT system prompt:

```
You have access to D365FO metadata via MCP tools. To call a tool, POST to the
/api/d365kb or /api/d365xref endpoint with a JSON-RPC request:

{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "tools/call",
  "params": {
    "name": "<tool_name>",
    "arguments": { ... }
  }
}

Available KB tools: d365_lookup_table, d365_search, d365_get_enum,
d365_check_field_exists, d365_get_join_keys, d365_get_class_methods,
d365_get_method_source, d365_find_referencing_tables, d365_get_module_summary,
d365_get_entity_sources, d365_sql_template, d365_hallucination_check,
d365_raw_sql, d365_graph_traverse, d365_field_renames, d365_list_modules,
d365_resolve_label.

Available XRef tools: xref_find_references, xref_find_usages,
xref_find_method_callers, xref_class_hierarchy, xref_interface_implementors,
xref_search_names, xref_method_references, xref_module_objects,
xref_cross_module_deps, xref_raw_sql, xref_impact_analysis, xref_list_modules,
xref_object_summary, xref_find_extensions, xref_find_field_usages,
xref_find_event_handlers.
```

---

## 7. Google Gemini

Gemini (via Google AI Studio or Vertex AI) does not natively support MCP as of March 2026. Integration options:

### 7.1 Approach: Function Calling via MCP Proxy

Use Gemini's **Function Calling** feature to define tool schemas, then have the application layer forward calls to the MCP endpoint.

**Step 1: Define function declarations**

```python
# Example using Google GenAI SDK (Python)
from google import genai

tools = [
    genai.types.Tool(
        function_declarations=[
            genai.types.FunctionDeclaration(
                name="d365_lookup_table",
                description="Get complete metadata for a D365FO table: fields, indexes, relations",
                parameters=genai.types.Schema(
                    type="OBJECT",
                    properties={
                        "table_name": genai.types.Schema(type="STRING", description="Table name")
                    },
                    required=["table_name"]
                )
            ),
            # ... repeat for each tool
        ]
    )
]
```

**Step 2: Forward function calls to MCP endpoint**

```python
import requests

def call_mcp_tool(service, tool_name, arguments):
    """Forward a Gemini function call to the D365FO MCP endpoint."""
    url = f"https://tis-d-mcpd365fo-func.azurewebsites.net/api/{service}"
    payload = {
        "jsonrpc": "2.0",
        "id": 1,
        "method": "tools/call",
        "params": {
            "name": tool_name,
            "arguments": arguments
        }
    }
    response = requests.post(url, json=payload)
    result = response.json()
    return result.get("result", {}).get("content", [{}])[0].get("text", "")
```

### 7.2 Approach: Vertex AI Extensions

On Vertex AI, register the MCP endpoint as an **Extension** with an OpenAPI spec (same as the ChatGPT approach in section 6).

---

## 8. Windsurf / Other MCP Clients

Any MCP-compatible client can connect using the standard MCP Streamable HTTP transport:

```json
{
  "mcpServers": {
    "d365kb": {
      "type": "url",
      "url": "https://tis-d-mcpd365fo-func.azurewebsites.net/api/d365kb"
    },
    "d365xref": {
      "type": "url",
      "url": "https://tis-d-mcpd365fo-func.azurewebsites.net/api/d365xref"
    }
  }
}
```

For stdio clients (local development only):

```json
{
  "mcpServers": {
    "d365kb": {
      "command": "node",
      "args": ["<path-to-project>/src/local/mcp-server-kb.js"]
    },
    "d365xref": {
      "command": "node",
      "args": ["<path-to-project>/src/local/mcp-server-xref.js"]
    }
  }
}
```

---

## 9. Verifying the Connection

After configuring any client, verify the connection:

1. **Health check** -- Access the endpoint URL in a browser or with curl:
   ```bash
   curl https://tis-d-mcpd365fo-func.azurewebsites.net/api/d365kb
   # Expected: {"name":"d365fo-kb","version":"1.0.0","status":"ok"}
   ```

2. **Tool listing** -- MCP clients should show 17 KB tools and 16 XRef tools after connecting.

3. **Test query** -- Ask the AI to "look up the CustTable table" or "find all callers of InventTable.find()".

---

## 10. Available Tools Reference

### 10.1 Knowledge Base Tools (17)

| Tool | Key Parameters | Description |
|------|---------------|-------------|
| `d365_lookup_table` | `table_name` | Complete table metadata |
| `d365_get_join_keys` | `table1`, `table2` | Join fields between tables |
| `d365_search` | `query`, `object_type?`, `limit?` | Search across all objects |
| `d365_get_enum` | `enum_name` | Enum values with IDs |
| `d365_check_field_exists` | `table_name`, `field_names[]` | Verify field names |
| `d365_get_class_methods` | `name`, `filter?`, `include_source?` | Class/table methods |
| `d365_get_method_source` | `owner_name`, `method_name` | Full X++ source code |
| `d365_find_referencing_tables` | `table_name` | FK references to table |
| `d365_get_module_summary` | `module_name` | Module overview |
| `d365_get_entity_sources` | `entity_name` | Data entity mappings |
| `d365_sql_template` | `scenario?` | Query templates |
| `d365_hallucination_check` | `table_name` | Known LLM mistakes |
| `d365_raw_sql` | `sql` | Ad-hoc SQL (read-only) |
| `d365_graph_traverse` | `start_node`, `max_depth?`, `edge_type?` | Dependency graph |
| `d365_field_renames` | `table_name` | AX2012 field renames |
| `d365_list_modules` | (none) | All modules |
| `d365_resolve_label` | `label_ids[]` | Resolve @SYS labels |

### 10.2 Cross-Reference Tools (16)

| Tool | Key Parameters | Description |
|------|---------------|-------------|
| `xref_find_references` | `object_name`, `kind?`, `limit?` | Who references this (incoming) |
| `xref_find_usages` | `object_name`, `kind?`, `limit?` | What this references (outgoing) |
| `xref_find_method_callers` | `object_name`, `method_name`, `limit?` | Method callers |
| `xref_class_hierarchy` | `class_name`, `direction?` | Inheritance tree |
| `xref_interface_implementors` | `interface_name` | Interface implementations |
| `xref_search_names` | `pattern`, `object_type?`, `limit?` | Name pattern search |
| `xref_method_references` | `object_name`, `method_name`, `kind?`, `limit?` | Method outgoing refs |
| `xref_module_objects` | `module_name`, `object_type?`, `limit?` | Module contents |
| `xref_cross_module_deps` | `module_name`, `direction?`, `limit?` | Module dependencies |
| `xref_raw_sql` | `sql` | Ad-hoc SQL (read-only) |
| `xref_impact_analysis` | `object_name`, `depth?` | Change impact |
| `xref_list_modules` | (none) | All modules |
| `xref_object_summary` | `object_name` | Object overview |
| `xref_find_extensions` | `object_name`, `object_type?`, `limit?` | CoC extensions |
| `xref_find_field_usages` | `table_name`, `field_name`, `kind?`, `limit?` | Field read/write sites |
| `xref_find_event_handlers` | `object_name`, `method_name?`, `limit?` | Event handlers |

---

## 11. Troubleshooting

| Issue | Resolution |
|-------|-----------|
| Client shows 0 tools | Check the URL is correct and ends with `/api/d365kb` or `/api/d365xref` |
| Connection timeout | Verify the Function App is running: `curl <endpoint-url>` |
| 500 Internal Server Error | Check Application Insights in Azure Portal for error details |
| Tools return empty results | The SQLite databases may not be uploaded; see [Administration Guide](Administration.md) |
| Copilot doesn't show MCP tools | Ensure agent mode is enabled and the MCP server config is correct |
| ChatGPT action fails | Verify the OpenAPI schema matches the JSON-RPC format exactly |
