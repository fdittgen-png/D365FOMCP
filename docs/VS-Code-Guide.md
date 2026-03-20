# Visual Studio Code Guide: D365FO MCP Services

**Project**: tis-p-mcpd365fo
**Owner**: Trelleborg IT Services (TIS)
**Version**: 2.0
**Date**: 2026-03-20
**Author**: Florian Dittgen
**Status**: Current

---

This guide walks you through setting up Visual Studio Code for developing, debugging, and maintaining the D365FO MCP Services project.

---

## 1. Prerequisites

Before opening the project in VS Code, ensure you have:

| Requirement | Version | How to check |
|-------------|---------|-------------|
| VS Code | Latest stable | `code --version` |
| Node.js | 20 LTS+ | `node --version` |
| npm | 10+ | `npm --version` |
| Git | Any | `git --version` |
| Azure Functions Core Tools | 4.x | `func --version` (optional, for Azure Functions local testing) |

Install project dependencies:

```bash
cd C:\working\MCP
npm install
```

---

## 2. Opening the Project

Open the project folder directly in VS Code:

```bash
code C:\working\MCP
```

Or from within VS Code: **File > Open Folder** → select `C:\working\MCP`.

### 2.1 Project Structure at a Glance

When you open the project, you will see this folder structure in the Explorer panel:

```
MCP/
├── build/              # Database build scripts (XML/LocalDB → SQLite)
│   ├── build-kb.js       # Knowledge Base builder
│   └── build-xref-db.js  # Cross-Reference builder
├── docs/               # Project documentation
├── infra/              # Azure Bicep infrastructure templates
├── scripts/            # PowerShell deployment & automation scripts
├── src/                # Application source code
│   ├── azure/            # Shared tool implementations (KB + XRef)
│   │   ├── shared.js       # DB singletons, query helpers, formatting
│   │   ├── kb-tools.js     # 17 Knowledge Base tool definitions
│   │   └── xref-tools.js   # 16 Cross-Reference tool definitions
│   ├── functions/        # Azure Functions HTTP entry points
│   │   ├── d365kb.js       # KB MCP endpoint (/api/d365kb)
│   │   ├── d365xref.js     # XRef MCP endpoint (/api/d365xref)
│   │   └── index.js        # Function App loader
│   └── local/            # Local stdio MCP servers (development)
│       ├── mcp-server-kb.js    # KB local server
│       └── mcp-server-xref.js  # XRef local server
├── host.json           # Azure Functions runtime config
├── package.json        # Node.js project definition
└── README.md           # Project overview
```

**Key principle:** The tool logic in `src/azure/` is shared between local (stdio) and Azure (HTTP) modes. The `src/local/` and `src/functions/` folders only handle transport — stdio vs. Streamable HTTP.

---

## 3. Recommended VS Code Extensions

Install these extensions for the best development experience:

### Essential

| Extension | ID | Purpose |
|-----------|----|---------|
| ESLint | `dbaeumer.vscode-eslint` | JavaScript linting |
| Prettier | `esbenp.prettier-vscode` | Code formatting |
| Azure Functions | `ms-azuretools.vscode-azurefunctions` | Azure Functions support, local debugging |

### Highly Recommended

| Extension | ID | Purpose |
|-----------|----|---------|
| SQLite Viewer | `qwtel.sqlite-viewer` | Browse SQLite database files |
| PowerShell | `ms-vscode.powershell` | Edit and debug deployment scripts |
| Azure Resources | `ms-azuretools.vscode-azureresourcegroups` | Browse Azure resources |
| Bicep | `ms-azuretools.vscode-bicep` | IntelliSense for infrastructure templates |
| REST Client | `humao.rest-client` | Test MCP endpoints with HTTP requests |
| GitLens | `eamodio.gitlens` | Enhanced Git history and blame |

### Optional

| Extension | ID | Purpose |
|-----------|----|---------|
| GitHub Copilot | `github.copilot` | AI code completion (supports MCP via agent mode) |
| Claude (Anthropic) | `anthropic.claude-code` | Claude Code integration in VS Code |
| Thunder Client | `rangav.vscode-thunder-client` | GUI-based API testing |
| Markdown Preview Enhanced | `shd101wyy.markdown-preview-enhanced` | Rich Markdown preview for docs |

Install all essential extensions at once via the terminal:

```bash
code --install-extension dbaeumer.vscode-eslint
code --install-extension esbenp.prettier-vscode
code --install-extension ms-azuretools.vscode-azurefunctions
```

---

## 4. Workspace Settings

Create a `.vscode/settings.json` file in the project root with the following recommended settings:

```json
{
  "editor.tabSize": 2,
  "editor.formatOnSave": true,
  "editor.defaultFormatter": "esbenp.prettier-vscode",
  "files.eol": "\n",
  "files.exclude": {
    "node_modules": true,
    ".deploy": true,
    "**/*.sqlite": true
  },
  "search.exclude": {
    "node_modules": true,
    ".deploy": true,
    "package-lock.json": true
  },
  "javascript.suggest.autoImports": true,
  "javascript.updateImportsOnFileMove.enabled": "always",
  "terminal.integrated.defaultProfile.windows": "Git Bash"
}
```

---

## 5. Running and Debugging

### 5.1 Launch Configurations

Create `.vscode/launch.json` to enable one-click debugging:

```json
{
  "version": "0.2.0",
  "configurations": [
    {
      "name": "Start KB Server (stdio)",
      "type": "node",
      "request": "launch",
      "program": "${workspaceFolder}/src/local/mcp-server-kb.js",
      "console": "integratedTerminal",
      "env": {
        "NODE_ENV": "development"
      }
    },
    {
      "name": "Start XRef Server (stdio)",
      "type": "node",
      "request": "launch",
      "program": "${workspaceFolder}/src/local/mcp-server-xref.js",
      "console": "integratedTerminal",
      "env": {
        "NODE_ENV": "development"
      }
    },
    {
      "name": "Build KB Database",
      "type": "node",
      "request": "launch",
      "program": "${workspaceFolder}/build/build-kb.js",
      "console": "integratedTerminal"
    },
    {
      "name": "Build XRef Database",
      "type": "node",
      "request": "launch",
      "program": "${workspaceFolder}/build/build-xref-db.js",
      "console": "integratedTerminal",
      "runtimeArgs": ["--max-old-space-size=8192"]
    },
    {
      "name": "Azure Functions (local)",
      "type": "node",
      "request": "attach",
      "port": 9229,
      "preLaunchTask": "func: host start"
    }
  ]
}
```

### 5.2 Task Configuration

Create `.vscode/tasks.json` to define build and run tasks accessible via **Ctrl+Shift+B** or the Command Palette:

```json
{
  "version": "2.0.0",
  "tasks": [
    {
      "label": "Start KB Server",
      "type": "npm",
      "script": "start:kb",
      "problemMatcher": [],
      "presentation": { "reveal": "always", "panel": "dedicated" }
    },
    {
      "label": "Start XRef Server",
      "type": "npm",
      "script": "start:xref",
      "problemMatcher": [],
      "presentation": { "reveal": "always", "panel": "dedicated" }
    },
    {
      "label": "Build KB Database",
      "type": "npm",
      "script": "build:kb",
      "problemMatcher": [],
      "presentation": { "reveal": "always" }
    },
    {
      "label": "Build XRef Database",
      "type": "npm",
      "script": "build:xref",
      "problemMatcher": [],
      "presentation": { "reveal": "always" }
    },
    {
      "label": "func: host start",
      "type": "shell",
      "command": "func start",
      "isBackground": true,
      "problemMatcher": "$func-node-watch"
    }
  ]
}
```

**Usage:**
- Press **Ctrl+Shift+P** → type "Tasks: Run Task" → select the task
- Or press **Ctrl+Shift+B** → select the task from the build task list

### 5.3 Running from the Terminal

You can also run commands directly in the VS Code integrated terminal (**Ctrl+`**):

```bash
# Start local MCP servers
npm run start:kb          # KB server on stdio
npm run start:xref        # XRef server on stdio

# Build databases
npm run build:kb          # Build KB SQLite (~10 min)
npm run build:xref        # Build XRef SQLite (~22 min, needs 8GB heap)

# Run Azure Functions locally (requires Azure Functions Core Tools)
npm run start:azure       # or: func start
```

### 5.4 Debugging Tips

- **Set breakpoints** by clicking the left gutter in any `.js` file
- **Watch variables** in the Debug sidebar (Ctrl+Shift+D)
- The local stdio servers (`src/local/`) read from stdin and write to stdout — use the integrated terminal (not the debug console) to interact with them
- For Azure Functions debugging, start with `func start --debug` and attach the VS Code debugger on port 9229

---

## 6. Key Files to Know

When working on this project, these are the files you will edit most often:

### 6.1 Tool Development

| File | What it does | When to edit |
|------|-------------|-------------|
| `src/azure/kb-tools.js` | All 17 KB tool definitions and handlers | Adding/modifying KB tools |
| `src/azure/xref-tools.js` | All 16 XRef tool definitions and handlers | Adding/modifying XRef tools |
| `src/azure/shared.js` | DB connections, SQL helpers, formatting utilities | Changing DB access patterns, shared logic |

Each tool is defined as an object with `name`, `description`, `inputSchema`, and a `handler` function. To add a new tool:

1. Define the tool schema and handler in `kb-tools.js` or `xref-tools.js`
2. The tool is automatically registered — no separate registration step needed
3. Test locally via the stdio server before deploying

**Important: Local vs Azure tool parity.** The local stdio servers (`src/local/`) have their own independent tool implementations. Currently they have fewer tools than the Azure version:

| Server | Azure (shared) | Local (stdio) | Missing locally |
|--------|---------------|---------------|-----------------|
| KB | 17 tools | 16 tools | `d365_resolve_label` |
| XRef | 16 tools | 13 tools | `xref_find_extensions`, `xref_find_field_usages`, `xref_find_event_handlers` |

When adding new tools, ensure you update both `src/azure/` (shared implementation) and the corresponding `src/local/` server.

### 6.2 Transport Layer

| File | What it does | When to edit |
|------|-------------|-------------|
| `src/local/mcp-server-kb.js` | Local stdio server for KB | Changing local transport behavior |
| `src/local/mcp-server-xref.js` | Local stdio server for XRef | Changing local transport behavior |
| `src/functions/d365kb.js` | Azure Functions HTTP endpoint for KB | Changing Azure transport config |
| `src/functions/d365xref.js` | Azure Functions HTTP endpoint for XRef | Changing Azure transport config |
| `src/functions/index.js` | Azure Functions app loader | Adding new HTTP endpoints |

### 6.3 Database Build

| File | What it does | When to edit |
|------|-------------|-------------|
| `build/build-kb.js` | Parses D365FO XML metadata → SQLite | Adding new object types to KB |
| `build/build-xref-db.js` | Exports LocalDB cross-references → SQLite | Changing XRef schema |

### 6.4 Infrastructure & Deployment

| File | What it does | When to edit |
|------|-------------|-------------|
| `infra/main-rg.bicep` | Azure resource definitions | Changing Azure infrastructure |
| `infra/modules/functionApp.bicep` | Function App + dependencies | Changing Function App config |
| `scripts/Deploy-FunctionApp.ps1` | Code deployment to Azure | Changing deployment process |
| `scripts/Update-Databases.ps1` | Config-based DB rebuild | Changing build workflow |
| `scripts/Deploy-Databases.ps1` | Upload DBs to Azure | Changing upload process |

---

## 7. Working with the Codebase

### 7.1 JavaScript ES Modules

This project uses **ES modules** (`"type": "module"` in `package.json`). This means:

- Use `import`/`export` instead of `require()`/`module.exports`
- File extensions are required in imports: `import { foo } from './bar.js'`
- No TypeScript — all source is plain JavaScript
- Node.js 20+ is required

### 7.2 Navigating Tool Definitions

To quickly find a specific tool, use VS Code's search (**Ctrl+Shift+F**):

- Search for `name: "d365_lookup_table"` to find a KB tool definition
- Search for `name: "xref_find_references"` to find an XRef tool definition
- Search for `inputSchema` to see all tool parameter definitions

Or use **Ctrl+P** to open files by name:
- `kb-tools.js` — all KB tools
- `xref-tools.js` — all XRef tools
- `shared.js` — database and utility functions

### 7.3 SQLite Database Inspection

The SQLite databases (when built) are stored at `%USERPROFILE%\.claude\`:

- `d365fo_kb.sqlite` (~1 GB) — Knowledge Base
- `d365fo_xref.sqlite` (~3.3 GB) — Cross-References

With the **SQLite Viewer** extension installed, you can open these files directly in VS Code to browse tables and run queries. Note: the XRef database is very large and may be slow to open.

For command-line inspection, use the `sqlite3` CLI or the project's own raw SQL tools:

```bash
# Via the local MCP server (after starting it)
# Use d365_raw_sql or xref_raw_sql tools to query

# Or directly with sqlite3
sqlite3 "%USERPROFILE%\.claude\d365fo_kb.sqlite" ".tables"
sqlite3 "%USERPROFILE%\.claude\d365fo_kb.sqlite" "SELECT COUNT(*) FROM tables"
```

---

## 8. Testing MCP Endpoints

### 8.1 Using the REST Client Extension

Create a file called `test.http` in the project root to test MCP endpoints:

```http
### Health Check - KB (Dev)
GET https://tis-d-mcpd365fo-func.azurewebsites.net/api/d365kb

### Health Check - XRef (Dev)
GET https://tis-d-mcpd365fo-func.azurewebsites.net/api/d365xref

### Tool Call - Lookup CustTable
POST https://tis-d-mcpd365fo-func.azurewebsites.net/api/d365kb
Content-Type: application/json

{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "tools/call",
  "params": {
    "name": "d365_lookup_table",
    "arguments": { "table_name": "CustTable" }
  }
}

### Tool Call - Find references to InventTable
POST https://tis-d-mcpd365fo-func.azurewebsites.net/api/d365xref
Content-Type: application/json

{
  "jsonrpc": "2.0",
  "id": 2,
  "method": "tools/call",
  "params": {
    "name": "xref_find_references",
    "arguments": { "object_name": "InventTable" }
  }
}

### Tool Call - Search for "Sales" objects
POST https://tis-d-mcpd365fo-func.azurewebsites.net/api/d365kb
Content-Type: application/json

{
  "jsonrpc": "2.0",
  "id": 3,
  "method": "tools/call",
  "params": {
    "name": "d365_search",
    "arguments": { "query": "Sales", "limit": 10 }
  }
}
```

Click **Send Request** above each request block to execute it.

### 8.2 Using cURL from the Terminal

```bash
# Health check
curl https://tis-d-mcpd365fo-func.azurewebsites.net/api/d365kb

# Tool call
curl -X POST https://tis-d-mcpd365fo-func.azurewebsites.net/api/d365kb \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"d365_lookup_table","arguments":{"table_name":"CustTable"}}}'
```

### 8.3 Using Azure Functions Locally

If you have Azure Functions Core Tools installed:

```bash
func start
```

This starts the Function App locally at `http://localhost:7071`. You can then test against:
- `http://localhost:7071/api/d365kb`
- `http://localhost:7071/api/d365xref`

---

## 9. GitHub Copilot with MCP Tools

VS Code's GitHub Copilot can connect to the D365FO MCP services, giving Copilot agent mode full access to D365FO metadata while you code.

### 9.1 Configure MCP Servers for Copilot

Create `.vscode/mcp.json` in the project root:

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

### 9.2 Using Copilot Agent Mode

1. Open Copilot Chat (**Ctrl+Shift+I** or click the Copilot icon)
2. Switch to **Agent mode** (click the agent icon or use `@workspace`)
3. Ask D365FO-related questions — Copilot will automatically call the MCP tools:

**Example prompts:**
- "Look up the CustTable table and show me its fields"
- "Who calls SalesTable.find()?"
- "What classes extend SalesFormLetter?"
- "Show me the X++ source code for InventTable.find"
- "What is the impact of changing PurchTable?"

---

## 10. Git Workflow

### 10.1 Branch Strategy

The project uses a simple **main-branch** workflow:

- `main` — production-ready code
- Feature branches for changes (e.g., `feature/new-tool`, `fix/query-timeout`)

### 10.2 Files Excluded from Git

The `.gitignore` excludes:

```
node_modules/          # Dependencies (reinstall with npm install)
*.sqlite               # Large database files (built locally)
local.settings.json    # Azure Functions local secrets
.deploy/               # Deployment staging directory
.claude/               # Claude Code settings (local)
```

### 10.3 Common Git Operations in VS Code

| Action | VS Code Way | Terminal Way |
|--------|------------|-------------|
| View changes | Source Control panel (Ctrl+Shift+G) | `git status` |
| Stage files | Click `+` next to file in Source Control | `git add <file>` |
| Commit | Type message + click checkmark | `git commit -m "message"` |
| Push | Click `...` → Push | `git push` |
| Pull | Click `...` → Pull | `git pull` |
| View history | GitLens: File History | `git log --oneline` |
| Compare changes | Click file in Source Control panel | `git diff` |

---

## 11. Deployment from VS Code

### 11.1 Running PowerShell Scripts

Open the integrated terminal (**Ctrl+`**), switch to PowerShell, and run:

```powershell
# Rebuild databases from current D365FO configuration
.\scripts\Update-Databases.ps1

# Upload databases to Azure dev environment
.\scripts\Deploy-Databases.ps1 -Environment d

# Full code + database deployment
.\scripts\Deploy-FunctionApp.ps1 -Environment d

# Code-only deployment (no database upload)
.\scripts\Deploy-FunctionApp.ps1 -Environment d -SkipDbUpload
```

### 11.2 Quick Reference: Deployment Scenarios

| Scenario | Command |
|----------|---------|
| D365FO version updated | `.\scripts\Update-Databases.ps1` then `.\scripts\Deploy-Databases.ps1 -Environment d` |
| Code changes only | `.\scripts\Deploy-FunctionApp.ps1 -Environment d -SkipDbUpload` |
| First-time setup | `.\scripts\Deploy-Infrastructure.ps1 -Environment d` then `.\scripts\Deploy-McpD365foData.ps1 -Environment d` |
| KB database only | `.\scripts\Update-Databases.ps1 -KbOnly` then `.\scripts\Deploy-Databases.ps1 -Environment d -KbOnly` |
| XRef database only | `.\scripts\Update-Databases.ps1 -XrefOnly` then `.\scripts\Deploy-Databases.ps1 -Environment d -XrefOnly` |

---

## 12. Troubleshooting

### 12.1 Common VS Code Issues

| Issue | Resolution |
|-------|-----------|
| "Extension host exited with code: 0" | Normal behavior — VS Code restarted the extension host (e.g., after a reload). Code 0 means clean shutdown, not a crash. |
| IntelliSense not working for imports | Ensure `"type": "module"` is in `package.json`. Restart the JS/TS language server: Ctrl+Shift+P → "TypeScript: Restart TS Server". |
| `better-sqlite3` import errors | Run `npm install` — native modules need to be compiled for your platform. |
| Terminal shows PowerShell errors | Switch to Git Bash in the terminal dropdown, or ensure PowerShell execution policy allows scripts: `Set-ExecutionPolicy -Scope CurrentUser -ExecutionPolicy RemoteSigned`. |
| SQLite files not found at runtime | Build databases first: `npm run build:kb`. Files go to `%USERPROFILE%\.claude\`. |
| Azure Functions Core Tools not found | Install via `npm install -g azure-functions-core-tools@4 --unsafe-perm true`. |
| Port 7071 already in use | Another `func` process is running. Kill it: `taskkill /F /IM func.exe` or change the port in `host.json`. |

### 12.2 Performance Tips

- **Exclude large files from search**: The workspace settings above exclude `node_modules`, `.deploy`, and `*.sqlite` from search to keep VS Code responsive.
- **Large file warning**: The XRef database is ~3.3 GB. Do not try to open it directly in VS Code — use the SQLite Viewer extension or command-line tools.
- **Memory usage**: If running the XRef build from VS Code, the `--max-old-space-size=8192` flag is already configured in the launch config and npm script.

---

## 13. Useful Keyboard Shortcuts

| Shortcut | Action |
|----------|--------|
| **Ctrl+P** | Quick Open — open any file by name |
| **Ctrl+Shift+F** | Search across all files |
| **Ctrl+Shift+G** | Open Source Control (Git) panel |
| **Ctrl+`** | Toggle integrated terminal |
| **Ctrl+Shift+P** | Command Palette — run any VS Code command |
| **Ctrl+Shift+D** | Open Debug panel |
| **Ctrl+Shift+B** | Run build task |
| **F5** | Start debugging (uses active launch config) |
| **F12** | Go to Definition |
| **Shift+F12** | Find All References |
| **Ctrl+Shift+I** | Open Copilot Chat |
| **Alt+Shift+F** | Format document |
| **Ctrl+K Ctrl+S** | Open keyboard shortcuts |

---

## Related Documentation

| Document | Description |
|----------|-------------|
| [README](../README.md) | Project overview and quick start |
| [Architecture](Architecture.md) | System design, data flow, Azure resources |
| [Implementation](Implementation.md) | Build pipeline, database schemas, tool catalog |
| [Administration](Administration.md) | Build/deploy procedures, monitoring, troubleshooting |
| [AI Configuration](AI-Configuration.md) | MCP client setup for Claude, Copilot, ChatGPT, Gemini, Cursor |
