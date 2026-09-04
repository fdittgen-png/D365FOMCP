# d365fo-mcp — Claude Code plugin for the D365FO MCP services

Turns Claude Code into a Dynamics 365 Finance & Operations analyst. The plugin:

- **works with the four D365FO MCP connectors** (knowledge base, cross-references, security model, Task Recorder) hosted on the TIS Azure Function App and published as claude.ai connectors — sign-in with your work account, no local database;
- **adds 19 slash commands** that run complete analysis workflows (`/d365-table`, `/d365-security`, `/support-scope`, …);
- **adds 8 skills** that teach Claude which tool to call first, how to read the answers, what to verify before asserting, and how to stay token-efficient.

Contact / information: florian.dittgen@trelleborg.com

## Install

```text
/plugin marketplace add fdittgen-png/D365FOMCP        # reads <repo>/.claude-plugin/marketplace.json
/plugin install d365fo-mcp@d365fo-mcp-marketplace
```

You need read access to the GitHub repository (it is private — ask the contact above). Claude Code clones the repo and reads the marketplace file **at the repo root**; the second copy under `plugin/.claude-plugin/` exists only for a local *directory* marketplace (`/plugin marketplace add C:\path\to\D365FOMCP\plugin`) and a test keeps the two identical. After a plugin update, run `/plugin` → *Marketplaces* → *Update* to pull the new version; skills and commands are re-read on the next session.

**The plugin ships skills and commands only — no MCP server definitions.** The four D365FO services are reached through the **claude.ai connectors** ("D365 KB", "D365 xRef", "D365 Sec", "D365 Task recorder") that your organisation publishes in the claude.ai Directory; enable them once under *Customize → Connectors* and they are available in claude.ai, Claude Desktop and Claude Code alike (Claude Code: `/mcp` → Authenticate). Sign-in is Entra ID; your account needs the `Mcp.Access` app role — ask the contact above if you get a 403.

> **Never register the Azure MCP URLs as your own servers** (`claude mcp add … https://…azurewebsites.net/api/d365kb`, project `.mcp.json`, or a plugin `.mcp.json`). Claude Code hides a connector whose URL matches a local server ("hidden — same URL as your server") and uses the local entry instead, which then needs its own OAuth dance. This is why the plugin deliberately has no `.mcp.json`. A SessionStart guard hook (`~/.claude/hooks/mcp-url-guard.cjs`) warns if such an entry exists.

Developing the plugin locally (no install):

```text
claude --plugin-dir C:\path\to\D365FOMCP\plugin\d365fo-mcp
```

### Reduce permission prompts

The tools are all read-only. Add to your `~/.claude/settings.json` (or the project's `.claude/settings.json`) — connector tool names carry the connector label:

```json
{
  "permissions": {
    "allow": [
      "mcp__claude_ai_D365_KB__*",
      "mcp__claude_ai_D365_xRef__*",
      "mcp__claude_ai_D365_Sec__*",
      "mcp__claude_ai_D365_Task_recorder__*"
    ]
  }
}
```

### Local stdio servers (developers with built databases)

If you also run the local stdio servers (`d365kb`, `d365xref`, `d365sec`, `d365taskrecorder` → local SQLite files), keep them **stdio**. They coexist with the connectors (tools appear twice — pick by freshness: connectors = live Azure snapshot, stdio = your local build). See "Local stdio alternative" below.

## What is inside

```text
d365fo-mcp/
├── .claude-plugin/plugin.json
├── commands/                     # 19 workflows
│   ├── d365-table, d365-class, d365-trace-field, d365-impact, d365-security, d365-research, d365-wiki
│   ├── arch-change-impact, arch-module-review
│   ├── func-analysis, func-process-analysis, func-config-review
│   ├── support-scope, support-diagnose, support-reproduce
│   ├── tech-code-review, tech-security-audit
│   └── biz-access-check, biz-explain-process
└── skills/
    ├── d365fo-mcp-tooling/       # loads first: service map, call discipline, verification + privacy rules
    │   └── references/           # generated per-tool parameter tables (kb, xref, sec, taskrecorder, wiki)
    ├── d365fo-mcp-workflows/     # 14 multi-tool recipes
    ├── d365fo-sql-direct-queries/# verified AxDB schemas, join keys, AX2012 renames
    ├── d365fo-analysis/          # product/ECM/DMF/tax/dimension data-model knowledge (27 reference files)
    ├── d365fo-security-analysis/ # security model, Deny-wins, SoD method
    ├── d365fo-support-scoping/   # ticket → scoping document method
    ├── d365fo-functional-analysis/ # FAD template + maturity tagging
    └── d365fo-llm-prompting/     # D365-specific prompting failure modes
```

Skills follow progressive disclosure: `SKILL.md` is short and points at `references/*.md`; Claude reads a reference only when the question needs it.

### Commands at a glance

| Command | Use it for |
|---|---|
| `/d365-table <Table>` | Structure, relations, extensions, usage hotspots |
| `/d365-class <Class>` | Hierarchy, methods, CoC/event handlers, callers |
| `/d365-trace-field <Table.Field>` | One field end-to-end |
| `/d365-impact <Object>` | Change impact + go/no-go |
| `/arch-change-impact <change>` | Full architectural blast radius of a change request |
| `/arch-module-review <Module>` | Module / ISV model health |
| `/d365-security <user|role|object>` | Access investigation, minimal grants |
| `/biz-access-check <user> <action>` | "Can X do Y" in business language |
| `/tech-security-audit <scope>` | SoD, over-provisioning, escalation paths |
| `/tech-code-review <Class[.Method]>` | X++ review of a code path |
| `/d365-research <topic>` | Wiki + RAG + Microsoft Learn + AOT synthesis |
| `/d365-wiki <query|slug>` | Internal wiki lookup |
| `/func-analysis <requirement|.axtr>` | Functional analysis document |
| `/func-process-analysis <process|.axtr>` | Process flow, data model, security matrix, gaps |
| `/func-config-review <area>` | Parameters, number sequences, config keys |
| `/biz-explain-process <process|.axtr>` | Plain-language step guide |
| `/support-scope <ticket|.axtr>` | Initial scoping document |
| `/support-diagnose <issue>` | Root-cause diagnosis |
| `/support-reproduce <.axtr|issue>` | Repro scenario / payload replay |

Some commands also use optional MCPs when connected (`d365rag`, Microsoft Learn, Azure DevOps, wiki servers); they degrade gracefully without them.

## Local stdio alternative (developers with built databases)

If you run the MCP servers from a clone of this repo with local SQLite databases, register them as **stdio** servers (user scope, `claude mcp add-json …`). The server scripts read the DB path from the first argument or from `KB_DB_PATH` / `XREF_DB_PATH` / `SEC_DB_PATH`:

```json
{
  "mcpServers": {
    "d365kb":   { "type": "stdio", "command": "node", "args": ["${CLAUDE_PLUGIN_ROOT}/../../src/local/mcp-server-kb.js"],   "env": { "KB_DB_PATH":   "D:/d365/d365fo_kb.sqlite" } },
    "d365xref": { "type": "stdio", "command": "node", "args": ["${CLAUDE_PLUGIN_ROOT}/../../src/local/mcp-server-xref.js"], "env": { "XREF_DB_PATH": "D:/d365/d365fo_xref.sqlite" } },
    "d365sec":  { "type": "stdio", "command": "node", "args": ["${CLAUDE_PLUGIN_ROOT}/../../src/local/mcp-server-sec.js"],  "env": { "SEC_DB_PATH":  "D:/d365/d365fo_sec.sqlite" } },
    "d365taskrecorder": { "type": "stdio", "command": "node", "args": ["${CLAUDE_PLUGIN_ROOT}/../../src/local/mcp-server-taskrecorder.js"] }
  }
}
```

Keep the server **keys** as above — the commands and skills refer to tools as `d365kb:d365_lookup_table` etc. (they match on tool name, so connector-hosted tools work equally).

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| A `claude.ai D365 …` connector shows **hidden — same URL as your server** and its tools are missing | A local Claude Code server entry (e.g. `d365kb-azure`) points at the same Azure URL; the local entry wins and hides the connector | `claude mcp remove <name> -s local` (check every project scope in `~/.claude.json`); reach Azure via the connector only; keep local entries stdio-only. The SessionStart guard `~/.claude/hooks/mcp-url-guard.cjs` reports offenders |
| `/mcp` says `invalid_request` for an Azure server registered directly in Claude Code | Entra AADSTS90009 — URI-form scope on a client-is-resource registration | Fixed server-side (`normalizeScope`, 2026-08-25); reconnect. `claude mcp get <server>` shows the real AADSTS text |
| Plugin tools duplicated (`mcp__d365kb__*` and `mcp__plugin_d365fo-mcp_d365kb__*`) | User-level stdio servers and the plugin's HTTP servers both active | Intentional if you want offline + live; otherwise remove one side |
| A security call hangs and *every other* tool on the host times out | The Function App has one Node worker and SQLite is synchronous — one slow query blocks all endpoints | Indexes self-heal at first request after deploy (`ensureSecIndexes`); fan out heavy `sec_object_access` / `xref_find_references` calls one at a time with `limit` |
| The skill fell back to `*_raw_sql` on another server or to local files when a service was down | Older skill text | Skill now says: a disconnected service is a gap to report, not a detour |
| `/plugin marketplace add fdittgen-png/D365FOMCP` → **Marketplace file not found at …\.claude-plugin\marketplace.json** | Claude Code reads the marketplace file at the repo root; older clones had it only under `plugin/` | Pull a version with the root `.claude-plugin/marketplace.json` (plugin ≥ 1.1.0); you also need read access to the private repo |
| `/plugin install …` says **already installed** but the skills still show the old text | Install copies the plugin into `~/.claude/plugins/cache/…/<version>/`; editing or pulling the repo does not touch that copy | `/plugin marketplace update d365fo-mcp-marketplace` → `/plugin update d365fo-mcp@d365fo-mcp-marketplace` (or uninstall + install), then **start a new session** — skills are read at session start |

## Maintaining

- Tool added or changed in `src/azure/*-tools.js` → `npm run gen:plugin-refs` regenerates `skills/d365fo-mcp-tooling/references/*-tools.md`; `test/plugin.test.js` fails until you do.
- New command/skill → `npm test` checks frontmatter, name/dir match, reference pointers and the privacy scrub (no personal paths, no e-mail addresses other than the contact above).
- Validate the package: `claude plugin validate plugin/d365fo-mcp`.
- Bump `version` in `plugin.json` when the tool surface or a command's contract changes; the data snapshot date is reported by the tools themselves.
