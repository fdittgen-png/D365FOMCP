# Using the D365FO KB and XRef MCP services

A practical guide to the two *metadata* services of the D365FO MCP platform — **d365kb** (the AOT knowledge base) and **d365xref** (the compiler cross-reference) — plus the **skills package** that teaches Claude to use them correctly, and how to install it.

Contact / information: florian.dittgen@trelleborg.com

| | **d365kb — Knowledge Base** | **d365xref — Cross-References** |
|---|---|---|
| Answers | *What is this object?* | *Who uses this object?* |
| Content | Tables, fields, indexes, relations, enums, EDTs, classes + X++ method source, data entities, forms, views, menu items, labels, security objects, AX2012 renames, SQL templates | Compiler cross-references: calls, reads, writes, extends, implements, subscribes; module-to-module dependencies |
| Tools | 17 | 16 |
| Endpoint | `/api/d365kb` | `/api/d365xref` |
| Store | SQLite, ~1 GB | SQLite, ~3.3 GB |
| Coverage | every model scanned in the build (`d365_list_modules`) | **compiled** models only (`xref_list_modules`) |

Both are **read-only snapshots of one D365FO build**. They prove what exists *now*; they never tell you when something appeared, and they hold no business transactions.

---

## 1. Connect

### 1.1 The normal way — claude.ai connectors

The four services (KB, xRef, Sec, Task Recorder) are published as **claude.ai connectors** — "D365 KB", "D365 xRef", "D365 Sec", "D365 Task recorder". Enable them once under *Customize → Connectors* and they work in claude.ai, Claude Desktop and Claude Code alike. In Claude Code: `/mcp` → Authenticate (Entra ID sign-in; your account needs the `Mcp.Access` app role — a 403 means the role is missing).

> **Never register the Azure MCP URLs as your own server** (`claude mcp add … https://…azurewebsites.net/api/d365kb`, a project `.mcp.json`, or a plugin `.mcp.json`). Claude Code hides a connector whose URL matches a local server ("hidden — same URL as your server") and uses the local entry instead, which then needs its own OAuth dance. This is why the plugin deliberately ships no `.mcp.json`.

Fewer permission prompts — every tool here is read-only, so allowlist them in `~/.claude/settings.json`:

```json
{
  "permissions": {
    "allow": [
      "mcp__claude_ai_D365_KB__*",
      "mcp__claude_ai_D365_xRef__*"
    ]
  }
}
```

### 1.2 Local stdio servers (developers with built databases)

From a clone of this repo with the SQLite files built (`npm run build:kb`, `npm run build:xref`), run them as **stdio** servers — they coexist with the connectors:

```json
{
  "mcpServers": {
    "d365kb":   { "type": "stdio", "command": "node", "args": ["<repo>/src/local/mcp-server-kb.js"],   "env": { "KB_DB_PATH":   "D:/d365/d365fo_kb.sqlite" } },
    "d365xref": { "type": "stdio", "command": "node", "args": ["<repo>/src/local/mcp-server-xref.js"], "env": { "XREF_DB_PATH": "D:/d365/d365fo_xref.sqlite" } }
  }
}
```

Tools then appear twice (connector + stdio). Pick by freshness: connectors = the live Azure snapshot, stdio = your local build.

**Tool names are the stable key.** `d365_lookup_table`, `xref_object_summary`, … are identical whatever the host calls the server (`D365 KB`, `d365kb`, `plugin_d365fo-mcp_d365kb`). Never match on the server label.

---

## 2. Tool inventory

### 2.1 d365kb — 17 tools

| Tool | Use it for |
|---|---|
| `d365_lookup_table` | Complete table metadata: fields (name, type, EDT), primary key, indexes, relations. `fields_like` / `custom_only` narrow a wide table |
| `d365_check_field_exists` | Verify one or more fields exist on a table — **before** asserting anything about them |
| `d365_get_enum` | All values of an enum with their numeric codes |
| `d365_get_join_keys` | The exact join fields between two tables |
| `d365_sql_template` | Pre-validated SQL for common scenarios (AxDB, not the KB schema) |
| `d365_field_renames` | AX2012 → D365FO field renames for a table |
| `d365_search` | Full-text discovery across tables, classes, enums, entities (`modules` to scope) |
| `d365_get_class_methods` | Method signatures (optionally full source) of a class, table or entity |
| `d365_get_method_source` | Full line-numbered X++ source of one method |
| `d365_get_entity_sources` | Data-entity → data-source chain and fields. Takes the AOT name, OData public name **or** collection name; `custom_only` / `computed_only` / `fields_like` / `limit` narrow it; methods only with `include_methods: true` |
| `d365_find_referencing_tables` | Tables with a foreign key **to** a given table (`limit`) |
| `d365_graph_traverse` | Walk the dependency graph N hops (`FK`, `extends`, `datasource`) |
| `d365_get_module_summary` | Object counts and key objects of one module |
| `d365_list_modules` | All models with counts + build provenance (version, layer, origin, publisher). Filter with `origin` / `layer` / `publisher`, or drop counts with `include_counts: false` |
| `d365_resolve_label` | `@SYS12345` → label text (only needed for a bare id; tools resolve labels themselves) |
| `d365_hallucination_check` | Known naming traps for a table |
| `d365_raw_sql` | Last resort — read-only, capped at 500 rows |

### 2.2 d365xref — 16 tools

| Tool | Use it for |
|---|---|
| `xref_object_summary` | **Start here.** Incoming vs outgoing reference counts by kind, methods, module |
| `xref_find_references` | Who references this object (callers/readers/extenders) |
| `xref_find_usages` | What this object references (the other direction) |
| `xref_find_method_callers` | Callers of one method |
| `xref_method_references` | Outgoing references of one method |
| `xref_find_field_usages` | Code that reads or writes `Table.Field` (`kind: Read` / `Write`) |
| `xref_find_extensions` | CoC `[ExtensionOf]` classes, table/form extensions |
| `xref_find_event_handlers` | `[SubscribesTo]`, `[Pre/PostHandlerFor]`, `[DataEventHandler]`, delegates |
| `xref_class_hierarchy` | Subclasses (recursive) or the parent chain (`limit` — framework roots have thousands) |
| `xref_interface_implementors` | Implementors of an interface, including indirect (`limit`) |
| `xref_impact_analysis` | Direct dependents of a change, grouped by type and module (`limit` sizes the listed sample; the counts always cover everything) |
| `xref_cross_module_deps` | Module → module dependencies, either direction |
| `xref_module_objects` | Top-level objects in a module |
| `xref_search_names` | Name-pattern search (`modules` to scope) |
| `xref_list_modules` | Modules in the XRef DB + build provenance, with the same `origin` / `layer` / `publisher` filters |
| `xref_raw_sql` | Last resort — never `SELECT *` on a 3 GB database |

Full parameter tables, generated from the code and always current: `plugin/d365fo-mcp/skills/d365fo-mcp-tooling/references/kb-tools.md` and `…/xref-tools.md`.

---

## 3. Question → first tool

| Question | Server | First call | Then |
|---|---|---|---|
| "What does table X look like?" | kb | `d365_lookup_table` | `d365_get_enum` per enum field, `d365_find_referencing_tables` |
| "Does field X exist on Y?" | kb | `d365_check_field_exists` | `d365_field_renames` if it is an AX2012 name |
| "How do I join A and B?" | kb | `d365_get_join_keys` | `d365_sql_template` |
| "What are the values of enum E?" | kb | `d365_get_enum` | — |
| "What does class C do?" | kb | `d365_get_class_methods` | `d365_get_method_source` for the one method that matters |
| "Which tables back entity E?" | kb | `d365_get_entity_sources` | `xref_find_references` on the entity |
| "Find objects about <topic>" | kb | `d365_search` (+ `modules`) | `d365_lookup_table` on the hits |
| "Is this name real?" | kb | `d365_hallucination_check` / `d365_search` | — |
| "Who uses object X?" | xref | `xref_object_summary` | `xref_find_references`, `xref_find_method_callers` |
| "Who writes Table.Field?" | xref | `xref_find_field_usages` (`kind: "Write"`) | `xref_find_method_callers` on the writer |
| "What extends X?" | xref | `xref_find_extensions` | `xref_find_event_handlers`, `xref_class_hierarchy` |
| "What breaks if I change X?" | xref | `xref_impact_analysis` | `xref_cross_module_deps` |
| "What is custom vs Microsoft?" | both | `d365_list_modules` / `xref_list_modules` | pass `modules: […]` to the search tools |

**They are complementary, not alternatives.** KB says a field exists and what type it is; XRef says who reads and writes it. A field investigation needs both; so does an impact assessment.

---

## 4. Worked recipes

**Table deep dive** — `d365_lookup_table` + `xref_object_summary` in one batch → read counts → then, only if the counts justify it, `xref_find_extensions` + `d365_find_referencing_tables` (`limit: 20`) → `d365_get_enum` for the enum fields the first call revealed.

**Field end-to-end** — `d365_check_field_exists` → `d365_lookup_table` for type/EDT → `d365_get_enum` if it is an enum → `d365_field_renames` if an AX2012 name is in play → `xref_find_field_usages` with `kind: "Write"` (who sets it) then `"Read"` (who consumes it).

**Impact of a change** — `xref_object_summary` (blast radius in one call) → `xref_impact_analysis` (`limit: 20`) → `xref_find_extensions` + `xref_find_event_handlers` (anything customer code hangs off) → `xref_cross_module_deps` if other modules are hit.

**Custom-layer scoping** — `d365_list_modules({ origin: "custom" })` (a handful of rows, not ~170) → re-run `d365_search` / `xref_search_names` with `modules: ["iExtension", …]` → state in the answer which layer each finding came from. For one entity's customisation surface, `d365_get_entity_sources({ entity_name, custom_only: true })` is a single call.

**Writing SQL against AxDB** — `d365_get_join_keys` for every join, `d365_check_field_exists` for every column, `d365_get_enum` for every literal, `d365_field_renames` for every AX2012 name you inherited. The `d365fo-sql-direct-queries` skill has the verified schemas.

---

## 5. Reading the responses

- **`format`** — the text channel defaults to **TOON** (compact, token-efficient). Pass `format: "markdown"` only when the output is quoted verbatim to a human. `structuredContent` (typed JSON) is identical either way — use it for post-processing.
- **Freshness banner** — every data response opens with `_<service> snapshot: <date>_`. Quote that date when a claim matters: "verified against the 2026-08-14 KB snapshot".
- **Empty vs not-found** — an empty result (no `isError`) means "valid object, zero rows". `isError: true` + *not-found* means the object is not in this build: re-check the spelling with `d365_search` / `xref_search_names` before concluding it was removed.
- **Truncation note** — tells you whether the cut came from your `limit`, the tool default, or the hard safety ceiling. Only re-query with a bigger `limit` when the note says there is more.
- **Two counts in a filtered response** — `field_count` / `result_count` / `module_count` are the totals; `fields_returned` / `returned_count` are what came back. Quote the total, not the sample size.
- **Labels** — `@SYS…` ids are resolved server-side. A raw id in the output is a data gap; report it, never invent the text.

Contract details: `plugin/d365fo-mcp/skills/d365fo-mcp-tooling/references/response-format.md` (`structuredContent`, error categories, truncation kinds).

---

## 6. Guardrails that actually matter

1. **`limit` on every list-returning call, and the narrowing filter when there is one.** Defaults are 100–500 rows — thousands of tokens you will not cite. Start at `limit: 20`, and reach for `origin: "custom"` (module lists), `custom_only` / `fields_like` (table and entity fields), `include_methods: false` (the default on entities) rather than filtering a full dump in your head. Measured on a real export task, the unfiltered forms of two KB tools were 82% of the whole token bill.
2. **Counts before lists, as the *first* call.** `xref_object_summary` and `d365_get_module_summary` cost a few hundred tokens and tell you which follow-ups are worth making at all. Firing the summary *alongside* the lists defeats the purpose.
3. **Batch independent lookups, serialise heavy ones.** The servers run SQLite synchronously: one slow query blocks every other call to that host. Cheap lookups in parallel; broad `xref_find_references` one at a time with a `limit`.
4. **A disconnected service is a gap, not a detour.** If XRef is down, say the usage findings are unverified — do not substitute KB raw SQL, local files, or memory.
5. **Every factual claim has a call behind it.** Anything from background knowledge is an inference and must be labelled as one.
6. **Raw SQL last.** `LIMIT` always, `COLLATE NOCASE` on name comparisons, never `SELECT *` on the XRef DB, and read `references/kb-raw-sql-schema.md` first — the KB schema is *not* the AxDB schema.
7. **Two known false negatives on `d365_check_field_exists`.** `LAC*`/`PRN*` fields come from binary-only ISV models nothing scans; `*_Custom` fields are D365 UI custom fields that live in no model at all. Say "not in the metadata snapshot", never "does not exist".
8. **XRef covers compiled models only.** "Nothing else uses this" needs `xref_object_summary` count 0 **and** an empty `xref_find_extensions`, plus the caveat about uncompiled/binary models.
9. **Privacy.** These services hold metadata and configuration, never customer or vendor transactions — do not try to pull party data through `*_raw_sql`.

---

## 7. The skills package

The skills are what turn the raw tools into reliable answers: which tool to call first, what to verify before asserting, how to stay token-efficient. Eight skills ship together.

| Skill | What it gives Claude | KB/XRef relevance |
|---|---|---|
| `d365fo-mcp-tooling` | Service map, call discipline, response format, verification rules, privacy — **loads before the first MCP call** | Essential |
| `d365fo-mcp-workflows` | 14 multi-tool recipes (table deep dive, field investigation, impact analysis, migration-defect RCA, field-wiper hunt…) | Essential |
| `d365fo-sql-direct-queries` | Verified AxDB schemas, join keys, AX2012 renames, raw-SQL guardrails | High |
| `d365fo-analysis` | Product/ECM/DMF/tax/dimension data-model knowledge (25+ reference files) | High |
| `d365fo-security-analysis` | Role→duty→privilege resolution, Deny-wins, SoD method | For the Sec service |
| `d365fo-support-scoping` | Ticket → scoping-document method | Workflow |
| `d365fo-functional-analysis` | FAD template + maturity tagging | Workflow |
| `d365fo-llm-prompting` | D365-specific prompting failure modes | Supporting |

Skills use progressive disclosure: `SKILL.md` is short and points at `references/*.md`, which Claude reads only when the question needs it.

### 7.1 Build the zip

```powershell
.\scripts\Build-SkillsPackage.ps1                 # -> dist\d365fo-mcp-skills.zip
.\scripts\Build-SkillsPackage.ps1 -IncludeCommands  # also packs the 19 slash commands
```

or `npm run pack:skills`. The script validates every skill (SKILL.md present, frontmatter `name` equal to the folder name, description present) before packing, and prints size and SHA-256. Rebuild it after changing any skill and after `npm run gen:plugin-refs`.

Zip layout:

```text
d365fo-mcp-skills.zip
├── README.md          # this guide
├── MANIFEST.json      # version, build date, skill inventory
├── skills/            # one folder per skill  <- this is what you install
│   ├── d365fo-mcp-tooling/
│   │   ├── SKILL.md
│   │   └── references/   (kb-tools.md, xref-tools.md, sec-tools.md, …)
│   ├── d365fo-mcp-workflows/
│   └── … 6 more
└── commands/          # only with -IncludeCommands
```

---

## 8. Installing the skills

### 8.1 Recommended — install the plugin (skills + 19 commands, and it updates)

```text
/plugin marketplace add fdittgen-png/D365FOMCP
/plugin install d365fo-mcp@d365fo-mcp-marketplace
```

Nothing to copy, and `/plugin update` keeps you current. Use the zip only when you cannot reach the repo or want the skills without the commands.

### 8.2 From the zip — user-wide (all your projects)

Unpack the `skills/` folders into `~/.claude/skills/` — on Windows that is `%USERPROFILE%\.claude\skills\`:

```powershell
Expand-Archive d365fo-mcp-skills.zip -DestinationPath $env:TEMP\d365fo-skills -Force
New-Item -ItemType Directory -Force "$env:USERPROFILE\.claude\skills" | Out-Null
Copy-Item "$env:TEMP\d365fo-skills\skills\*" "$env:USERPROFILE\.claude\skills\" -Recurse -Force
```

```bash
unzip -o d365fo-mcp-skills.zip -d /tmp/d365fo-skills
mkdir -p ~/.claude/skills
cp -r /tmp/d365fo-skills/skills/* ~/.claude/skills/
```

The result must be `~/.claude/skills/d365fo-mcp-tooling/SKILL.md` — **one folder per skill, `SKILL.md` at its root**. A nested `skills/skills/…` or a bare `SKILL.md` will not be picked up.

If you also took `-IncludeCommands`, copy `commands/*` into `~/.claude/commands/` (they then appear as `/d365-table`, `/d365-security`, …).

### 8.3 From the zip — one project only (shared with the team via git)

Unpack into `<project>/.claude/skills/` instead. Everyone who clones the repo gets the skills; nothing to install per person.

```powershell
Expand-Archive d365fo-mcp-skills.zip -DestinationPath .\.tmp-skills -Force
New-Item -ItemType Directory -Force .\.claude\skills | Out-Null
Copy-Item .\.tmp-skills\skills\* .\.claude\skills\ -Recurse -Force
Remove-Item .\.tmp-skills -Recurse -Force
```

### 8.4 For plugin development — no install at all

```text
claude --plugin-dir <repo>/plugin/d365fo-mcp
```

### 8.5 Verify

Start a new Claude Code session (skills are read at startup) and check:

- `/plugin` lists `d365fo-mcp` (plugin route), or the skills appear in the session's available-skills list (manual route);
- ask something D365 — Claude should load `d365fo-mcp-tooling` before its first MCP call;
- `/mcp` shows the D365 connectors authenticated.

Common mistakes: an extra folder level after unzipping; editing a `SKILL.md` so its frontmatter `name` no longer matches the folder name (the skill is then ignored); expecting a running session to pick up newly copied skills — restart.

### 8.6 Updating

Plugin route: `/plugin update d365fo-mcp`. Zip route: rebuild the zip and copy over the folders again (overwrite; delete a skill's folder if it was removed upstream). The generated `references/*-tools.md` change whenever a tool's parameters change, so re-copy after every service release.

---

## 9. Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| A `claude.ai D365 …` connector shows **hidden — same URL as your server** | A local Claude Code entry points at the same Azure URL and wins | `claude mcp remove <name> -s local` (check every project scope in `~/.claude.json`); keep local entries stdio-only |
| `/mcp` says `invalid_request` for a directly registered Azure server | Entra AADSTS90009 | Fixed server-side (2026-08-25) — reconnect; `claude mcp get <server>` shows the real AADSTS text |
| 403 on sign-in | Missing `Mcp.Access` app role | Ask the contact above |
| Tools appear twice | Connector + local stdio both active | Intentional if you want live + offline; otherwise remove one side |
| One call hangs and *every* other tool on that host times out | One Node worker, synchronous SQLite — a slow query blocks all endpoints | Serialise heavy calls, always pass `limit` |
| A tool insists a field does not exist | Binary-only ISV model or a `*_Custom` UI field | See guardrail 8 in §6 — verify in the environment |
| Answers ignore the call discipline | Skills not loaded | New session; check the folder layout in §8.2 |

---

## See also

- `plugin/d365fo-mcp/README.md` — the plugin, its 19 commands, local stdio setup
- `plugin/d365fo-mcp/skills/d365fo-mcp-tooling/references/{kb,xref}-tools.md` — generated per-tool parameter tables
- `MCP_SERVICES_REFERENCE.md` — full service inventory including Sec and Task Recorder
- `docs/XRef-Custom-Layer-Coverage.md` — exactly which custom/ISV models the XRef snapshot compiled
