# Copilot Studio Skills — Agent Configurations

Ready-to-use agent configurations for Microsoft Copilot Studio. Each file contains:

1. **System Instructions** — paste into the agent's Instructions field
2. **knownTools** — the MCP tool subset this role needs (minimizes token usage)
3. **MCP Connections** — which services to connect
4. **Sample Prompts** — starter prompts for testing

## ⭐ Start here (current)

| File | What | Services | Tools |
|------|------|----------|-------|
| **`agent-d365fo.md`** | **Canonical governance agent** — verified live endpoints, real tool inventory, skills baked in (incl. the disabled-button security diagnosis) | All 4 | **54** |
| `connectors/*.swagger.json` | MCP custom-connector definitions to import (one per service) | — | — |

> **Use `agent-d365fo.md`.** It targets the deployed `tis-d-mcpd365fo-func` endpoints and the actual 54-tool set.

## Legacy role-split configs (⚠ stale)

The files below predate the current deployment: they point at the non-deployed `tis-p-mcpd365fo-func` host and list several tool names that no longer exist (e.g. `sec_check_permission`, `sec_find_role_conflicts`, `sec_lookup_entity_permissions`). Keep for role-split *instructions* inspiration only; correct the host + tool names against `agent-d365fo.md` before use.

| File | Role | Services | Tools |
|------|------|----------|-------|
| `agent-support.md` | 1st-Level Support Engineer | KB + Sec + TaskRecorder | 10 tools |
| `agent-functional.md` | Functional Consultant | KB + Sec + TaskRecorder | 15 tools |
| `agent-business.md` | Business User | KB + Sec + TaskRecorder | 7 tools |
| `agent-technical.md` | Technical Expert | KB + XRef + Sec | 25 tools |
| `agent-architect.md` | Solution Architect | KB + XRef + Sec + TaskRecorder | 35 tools |
| `agent-full.md` | Full Access (all roles) | All 4 services | 49 tools |

## Setup Steps

1. Create a new agent in Copilot Studio (or clone existing)
2. Add MCP connections for the services listed in the configuration
3. Populate `knownTools` with the tool names from the configuration
4. Paste the System Instructions into the agent's Instructions field
5. Add the Sample Prompts as conversation starters
6. Publish

See [Copilot-Studio-Guide.md](../../docs/Copilot-Studio-Guide.md) for detailed MCP connection setup.
