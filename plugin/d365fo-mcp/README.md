# d365fo-mcp — Claude Code plugin for the D365FO MCP services

Turns Claude Code into a Dynamics 365 Finance & Operations analyst. The plugin:

- **connects the four D365FO MCP services** (knowledge base, cross-references, security model, Task Recorder) hosted on the TIS Azure Function App — sign-in with your work account, no local database;
- **adds 19 slash commands** that run complete analysis workflows (`/d365-table`, `/d365-security`, `/support-scope`, …);
- **adds 8 skills** that teach Claude which tool to call first, how to read the answers, what to verify before asserting, and how to stay token-efficient.

Contact / information: florian.dittgen@trelleborg.com

## Install

```text
/plugin marketplace add fdittgen-png/D365FOMCP        # the repo's plugin/ folder is the marketplace
/plugin install d365fo-mcp@d365fo-mcp-marketplace
```

On first use of any `d365*` tool Claude Code opens a browser sign-in (Entra ID). Your account needs the `Mcp.Access` app role on the Function App — ask the contact above if you get a 403.

Developing the plugin locally (no install):

```text
claude --plugin-dir C:\path\to\D365FOMCP\plugin\d365fo-mcp
```

### Reduce permission prompts

The tools are all read-only. Add to your `~/.claude/settings.json` (or the project's `.claude/settings.json`):

```json
{
  "permissions": {
    "allow": [
      "mcp__plugin_d365fo-mcp_d365kb__*",
      "mcp__plugin_d365fo-mcp_d365xref__*",
      "mcp__plugin_d365fo-mcp_d365sec__*",
      "mcp__plugin_d365fo-mcp_d365taskrecorder__*"
    ]
  }
}
```

### Avoid duplicate tools

If you previously registered `d365kb`, `d365xref`, `d365sec` or `d365taskrecorder` yourself (`claude mcp add …` or entries in `~/.claude.json`), remove them — otherwise every tool appears twice and Claude may pick the stale one:

```text
claude mcp remove d365kb
claude mcp remove d365xref
claude mcp remove d365sec
claude mcp remove d365taskrecorder
```

## What is inside

```text
d365fo-mcp/
├── .claude-plugin/plugin.json
├── .mcp.json                     # d365kb, d365xref, d365sec, d365taskrecorder (HTTP, Entra sign-in)
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

If you run the MCP servers from a clone of this repo with local SQLite databases, replace `.mcp.json` with stdio entries. The server scripts read the DB path from the first argument or from `KB_DB_PATH` / `XREF_DB_PATH` / `SEC_DB_PATH`:

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

Keep the server **keys** unchanged — the commands and skills refer to tools as `d365kb:d365_lookup_table` etc.

## Maintaining

- Tool added or changed in `src/azure/*-tools.js` → `npm run gen:plugin-refs` regenerates `skills/d365fo-mcp-tooling/references/*-tools.md`; `test/plugin.test.js` fails until you do.
- New command/skill → `npm test` checks frontmatter, name/dir match, reference pointers and the privacy scrub (no personal paths, no e-mail addresses other than the contact above).
- Validate the package: `claude plugin validate plugin/d365fo-mcp`.
- Bump `version` in `plugin.json` when the tool surface or a command's contract changes; the data snapshot date is reported by the tools themselves.
