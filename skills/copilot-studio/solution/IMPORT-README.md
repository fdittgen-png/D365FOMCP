# Import guide — D365FO Governance Agent (Copilot Studio)

This folder builds **two importable unmanaged solution zips** plus a guaranteed manual fallback.

| Artifact | What it is | Reliability |
|----------|------------|-------------|
| `dist/D365FO-MCP-Connectors_1_0_0_0.zip` | The **4 MCP custom connectors** (KB, XRef, Security, Task Recorder), dev host `tis-d-mcpd365fo-func`. | ✅ Imports. (Each connector is defined in `customizations.xml` under `<Connectors>` with `connectorid` ↔ RootComponent `id`, files in the singular `Connector/` folder.) |
| `dist/D365FO-Governance-Agent_1_0_0_0.zip` | The **agent**: `bot` + Custom GPT component with **all 17 skill workflows baked into the instructions**. | ✅ Built on the real 2026 export layout (`bots/` + `botcomponents/` folders). Import after the connectors, then wire the 4 tools (UI). |
| `AGENT-INSTRUCTIONS.md` | The same baked instructions as paste-ready text. | Always works (manual paste). |
| `../connectors/*.swagger.json` | The raw OpenAPI 2.0 files behind the connectors. | Always works (import-OpenAPI). |

Rebuild any time after editing `AGENT-INSTRUCTIONS.md` or changing the host:
```powershell
./build-solutions.ps1                                   # dev host (default)
./build-solutions.ps1 -Host_ "your-prod-host.azurewebsites.net"
```

---

## Import order (this matters)

Microsoft requires a **custom connector to be registered before** anything that references it. So:

1. **Import `D365FO-MCP-Connectors` first.** Power Apps maker portal → **Solutions** → **Import solution** → upload the zip → **Import**.
2. **Create the agent** — manually (Path 1) or from a real export I repackage (Path 2). The hand-authored `D365FO-Governance-Agent` zip does **not** import; see the section below.
3. In **Copilot Studio**, open the agent and **add the 4 connectors as tools/actions** (one-time UI step below).
4. **Publish** the agent.

---

## The agent zip — built on the real 2026 export layout

An earlier attempt put the `bot` in a `<bots>` block inside `customizations.xml` and failed (*"Entity bot does not contain key value for attribute schemaname"*). That was the **wrong location**. Modern Copilot Studio exports put the bot in **separate folders**, not `customizations.xml`:

```
[Content_Types].xml          # Override part for every extensionless `data` file
solution.xml                 # <RootComponents /> EMPTY (folders are the content source)
customizations.xml           # minimal — bot is NOT here
bots/<bot>/bot.xml           # <bot schemaname="..."> — schemaname is an ATTRIBUTE (the fix)
bots/<bot>/configuration.json# GenerativeActionsEnabled + GenerativeAIRecognizer + instructions
botcomponents/<bot>.gpt.default/botcomponent.xml   # componenttype 15 (Custom GPT)
botcomponents/<bot>.gpt.default/data               # YAML: kind: GptComponentMetadata + instructions
botcomponents/<bot>.topic.ConversationStart/...    # componenttype 9 (system topic)
```

The build script generates exactly this (templated from the real `darsoohoo/intake-bot` export) and embeds `AGENT-INSTRUCTIONS.md` in **both** `configuration.json` (`agentSettings`) and the Custom GPT `data` YAML.

**Import order:** connectors solution **first**, then this agent solution.

**Still required after import — wire the 4 tools.** The agent zip carries the bot + instructions but **not** the connector tools/connection references (those bind to the connectors that live in the other solution). After import, open the agent → **Tools → + Add a tool** → add `D365KB`, `D365XRef`, `D365Security`, `D365TaskRecorder` (create the OAuth connection on first add — sign in as a `D365FO-MCP-Users` member) → **Publish**.

### If the agent zip is still rejected
Hand-authored bots are version-sensitive. If your environment's Copilot Studio rejects it, fall back to: create the agent in the UI, paste `AGENT-INSTRUCTIONS.md`, add the 4 tools (the "Guaranteed path" below). To get a perfectly-matched reusable zip, build the agent once in the UI **inside a solution** (so the tool wiring + connection references are captured), then **Export → Unmanaged** — that export is your portable artifact.

---

## Guaranteed fallback — create the agent manually (≈3 min)

1. **Copilot Studio** → **Create** → **New agent** → skip the conversational setup (**Configure** / **Skip to configure**).
2. Name it `D365FO Governance Assistant`.
3. **Instructions** field → paste the entire body of [`AGENT-INSTRUCTIONS.md`](AGENT-INSTRUCTIONS.md) (everything below the first `---` rule).
4. Add the 4 MCP tools (see next section).
5. (Optional) Add the 5 conversation starters from the bottom of the instructions file.
6. **Publish.**

---

## Wiring the 4 MCP connectors as agent tools

Whether you imported the agent zip or built it manually, attach the connectors as tools:

1. In the agent, go to **Tools** → **Add a tool** → **Connector** (or **Model Context Protocol** if your tenant surfaces MCP tools directly).
2. Pick each connector — **D365 KB**, **D365 XRef**, **D365 Security**, **D365 Task Recorder** — and add it.
3. When prompted for a **connection**, create one — the connectors use **Entra OAuth** since the 2026-08-04 cutover, so sign in as a member of `D365FO-MCP-Users` (see the Auth note at the bottom).
4. Repeat for all four. The instructions already tell the model which tool to use for which question.

> **If you skipped the connector solution** and want to add them straight from OpenAPI: Power Apps → **Custom connectors** → **New custom connector** → **Import an OpenAPI file** → pick each `../connectors/*.swagger.json`. These are MCP-streamable (`x-ms-agentic-protocol: mcp-streamable-1.0`) and need no auth.

---

## Endpoints

All four target the **dev** Function App:

| Tool | URL |
|------|-----|
| D365 KB | `https://tis-d-mcpd365fo-func.azurewebsites.net/api/d365kb` |
| D365 XRef | `https://tis-d-mcpd365fo-func.azurewebsites.net/api/d365xref` |
| D365 Security | `https://tis-d-mcpd365fo-func.azurewebsites.net/api/d365sec` |
| D365 Task Recorder | `https://tis-d-mcpd365fo-func.azurewebsites.net/api/d365taskrecorder` |

To target prod later, rebuild with `-Host_` and re-import — the agent definition doesn't change.

> **Auth (cutover LIVE since 2026-08-04):** the endpoints require an Entra bearer token with the `Mcp.Access` app role — anonymous connections no longer work. The connector swaggers now carry the Entra OAuth `securityDefinitions` block (tenant `0f861177-7722-4f06-8db9-3384e5321a9f`, scope `api://trelleborg.onmicrosoft.com/sp-tis-d-d365fokb-mcp/user_impersonation`) — re-import them, set each connector's Security tab to OAuth 2.0 (Microsoft Entra ID) with client `54b1261c-352d-4772-b83a-001e529bd117` + a client secret, add the `https://global.consent.azure-apim.net/redirect` Web redirect to the app registration (see `docs/MCP-Entra-Auth-Setup.md` Part D), and recreate every connection as an OAuth connection by a member of the `D365FO-MCP-Users` group.
