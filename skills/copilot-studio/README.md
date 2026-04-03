# Copilot Studio Skills — Role-Based Agent Configurations

Ready-to-use agent configurations for Microsoft Copilot Studio. Each file contains:

1. **System Instructions** — paste into the agent's Instructions field
2. **knownTools** — the MCP tool subset this role needs (minimizes token usage)
3. **MCP Connections** — which services to connect
4. **Sample Prompts** — starter prompts for testing

## Available Configurations

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
