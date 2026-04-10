# Demand for POC: MCP Services Platform for D365 F&O Governance

**Project**: TIS AI Tools -- MCP Services Platform
**Author**: Florian Dittgen
**Date**: 2026-04-01
**Version**: 1.0 (Draft)
**Status**: Demand / Budget Request

---

## 1. Executive Summary

This document details the resources, development tools, infrastructure capacities, and operational costs required to develop, deploy, and operate a suite of **MCP (Model Context Protocol) services** for Dynamics 365 Finance & Operations governance at Trelleborg Industrial Solutions.

The platform provides AI coding assistants and business agents (Claude, Copilot, ChatGPT, Gemini, Cursor, Copilot Studio) with structured, queryable access to:

- **D365 F&O metadata** (tables, classes, enums, entities, methods, X++ source code)
- **Cross-reference data** (code dependencies, call graphs, inheritance, impact analysis)
- **Security configuration** (roles, duties, privileges, users, permissions from PROD)
- **Documentation & blueprints** (curated D365 functional documentation, agent blueprints)
- **OTRS ticket knowledge** (resolved tickets with articles, searchable by AI agents)

### 1.1 Services Overview

| # | Service | Status | Tools | Database | Deployment |
|---|---------|--------|-------|----------|------------|
| 1 | **d365kb** -- Knowledge Base | Delivered | 17 | ~1,063 MB SQLite | Azure Functions + Local |
| 2 | **d365xref** -- Cross-Reference | Delivered | 16 | ~3,300 MB SQLite | Azure Functions + Local |
| 3 | **d365sec** -- Security | In Development | 15 | ~30-60 MB SQLite | Azure Functions + Local |
| 4 | **d365rag** -- Documentation & Blueprints | Delivered (docs), Planned (blueprints) | 8 | Cloud-hosted | Claude.ai infrastructure |
| 5 | **otrs-rag** -- OTRS Ticket Knowledge | Planned | ~8 | Est. 100-500 MB SQLite | Azure Functions + Local |
| 6 | **Microsoft Learn** | Delivered (3rd party) | 3 | Cloud (Microsoft) | Claude.ai integration |

**Total tools across all services: ~67**

---

## 2. Scope of Work

### 2.1 Already Delivered (Services 1, 2, 6)

The Knowledge Base and Cross-Reference services are fully operational in both development and production environments. The Microsoft Learn integration is provided by the Claude.ai platform.

| Deliverable | Description |
|-------------|-------------|
| 17 KB tools | Table/field/enum/class lookup, search, X++ source, anti-hallucination, SQL templates |
| 16 XRef tools | Find references, call hierarchy, impact analysis, extensions, field usages, event handlers |
| 3 Microsoft Learn tools | Documentation search, code sample search, full page fetch |
| Build pipeline | XML/LocalDB to SQLite (build-kb.js, build-xref-db.js) |
| Azure deployment | Bicep IaC, CI/CD pipeline (azure-pipelines.yml), PowerShell scripts |
| AI client configs | Claude Code, Claude Desktop, Cursor, VS Code Copilot, ChatGPT, Gemini, Copilot Studio |
| Documentation | Architecture, Implementation, Administration, AI Configuration, Copilot Studio Guide |

### 2.2 In Development (Service 3 -- d365sec)

The Security MCP service is designed and partially implemented. It merges AOT security metadata with DMF production exports to provide a complete, queryable security model.

| Deliverable | Description | Status |
|-------------|-------------|--------|
| build-sec.js | Build script: parse AOT XML + DMF XML + SecurityDatabaseCustomizations to SQLite | Implemented |
| sec-tools.js | 15 security tools (lookup, trace, compare, effective permissions, search) | Implemented |
| d365sec.js | Azure Function endpoint | Implemented |
| mcp-server-sec.js | Local stdio server | Implemented |
| Unit tests | 38 tests for security tools | Implemented |
| Pipeline integration | azure-pipelines.yml updates for sec database build/deploy | Pending |
| Documentation updates | AI-Configuration.md, README.md, Copilot Studio Guide | Pending |

### 2.3 Planned -- RAG Service Extension (Service 4 -- Blueprints)

The d365rag service currently serves curated D365 documentation. The planned extension adds **agent blueprint** documents (like the Legal Entity Configuration Agent Blueprint) as a searchable corpus, enabling AI agents to consult architectural blueprints, audit findings, and design patterns.

| Deliverable | Description |
|-------------|-------------|
| Blueprint ingestion pipeline | Parse Markdown/Word blueprints, chunk, embed, index into RAG database |
| Category management | Separate "blueprint" category from functional documentation |
| Audit trail integration | Link blueprint versions to audit findings and recommendations |
| Search tuning | Optimize retrieval for architectural questions vs. functional how-to |

### 2.4 Planned -- OTRS Ticket Knowledge Service (Service 5 -- otrs-rag)

A new RAG service that makes resolved OTRS tickets searchable by AI agents. This follows the same architecture as the d365rag service.

| Deliverable | Description |
|-------------|-------------|
| **Data source: BI report** | Extract resolved tickets from the existing BI reporting layer (ticket metadata: ID, subject, status, category, creation/resolution dates, assignee) |
| **Data source: REST API** | For each resolved ticket, call the OTRS REST API to retrieve the full article content (messages, notes, resolution text) |
| **Build pipeline** | `build-otrs-rag.js`: fetch BI report, iterate tickets, call REST API for articles, chunk text, build SQLite database with FTS (full-text search) |
| **SQLite schema** | Tables: `tickets` (metadata), `articles` (content per ticket), `chunks` (embedded text for search), `categories` (ticket categories/queues), `metadata` (build stats) |
| **MCP tools (~8)** | `otrs_ask` (natural language question), `otrs_search` (keyword search), `otrs_list_tickets` (browse), `otrs_lookup_ticket` (full ticket + articles), `otrs_list_categories` (queues/categories), `otrs_search_by_category`, `otrs_get_article`, `otrs_raw_sql` |
| **Azure Function endpoint** | `d365otrs.js` or `otrs-rag.js` -- same pattern as other services |
| **Local stdio server** | `mcp-server-otrs.js` for development |
| **Refresh schedule** | Periodic rebuild (weekly or on-demand) to incorporate newly resolved tickets |

---

## 3. Resource Requirements

### 3.1 Human Resources

| Role | Scope | Effort Estimate | Who |
|------|-------|-----------------|-----|
| **Architect / Lead Developer** | Platform architecture, MCP tool design, build pipeline design, Azure infrastructure, AI client configuration, documentation, code review | Ongoing (primary owner) | Florian Dittgen |
| **D365 X++ Developer** | DMF export configuration, security entity exports, PackagesLocalDirectory access, X++ metadata extraction | Punctual tasks | Eugene (via CR 99351) |
| **D365 Solution Architect** | FDD writing, change request creation, functional validation of security/license data | Advisory | Antoine Bastian |
| **Approver** | Change request approval | As needed | Hans Ahlberg |
| **Azure Administrator** | Resource group creation, RBAC assignments, subscription-level access, cost monitoring | Initial setup + quarterly review | TIS IT / Florian |
| **OTRS Administrator** | BI report access, REST API credentials, ticket data access authorization | OTRS RAG setup | TIS IT (to be identified) |
| **AI Administrator** | Copilot Studio configuration, MCP connection setup, knownTools management | Per AI client onboarding | Florian + client owners |

### 3.2 Skills Required

| Skill | Used For |
|-------|----------|
| Node.js (ES Modules, v20) | All MCP servers, build scripts, Azure Functions |
| SQLite / better-sqlite3 | Database design, query optimization, FTS |
| MCP SDK (@modelcontextprotocol/sdk) | Server implementation, tool registration, transport handling |
| Azure Functions v4 (Node.js) | Cloud deployment, HTTP endpoints |
| Azure Bicep | Infrastructure as Code |
| PowerShell | Deployment automation, D365 data extraction |
| XML parsing (fast-xml-parser) | D365 AOT metadata, DMF exports |
| Azure DevOps Pipelines | CI/CD |
| D365 F&O security model | Security service design (roles, duties, privileges, entry points) |
| REST API integration | OTRS ticket article retrieval |
| Text chunking / FTS indexing | RAG pipeline for blueprints and OTRS tickets |

---

## 4. Development Tools & Licenses

### 4.1 Development Environment

| Tool | Purpose | Cost |
|------|---------|------|
| **VS Code** | Primary IDE for Node.js development | Free |
| **Node.js 20 LTS** | Runtime for all MCP servers and build scripts | Free (open source) |
| **Git** | Version control | Free |
| **Azure DevOps** | Repository hosting, CI/CD pipelines, work items | Included in Trelleborg subscription |
| **Azure CLI** | Infrastructure deployment, Function App management | Free |
| **PowerShell 7** | Deployment scripts, D365 data extraction automation | Free |

### 4.2 AI Development Tools (MCP Clients)

| Tool | Purpose | Cost |
|------|---------|------|
| **Claude Code (CLI/Desktop)** | Primary AI coding assistant, MCP client for development & testing | Anthropic subscription (Max plan) |
| **Claude.ai** | RAG service hosting (d365rag), Microsoft Learn integration | Included in Anthropic subscription |
| **GitHub Copilot** | Secondary AI assistant, MCP client testing | GitHub Copilot license |
| **Cursor** | Alternative AI IDE, MCP client testing | Cursor license (optional) |
| **Copilot Studio** | Business agent platform, MCP consumer for end-user scenarios | Microsoft 365 / Power Platform license |

### 4.3 NPM Dependencies (Open Source)

| Package | Version | Purpose | License |
|---------|---------|---------|---------|
| `@azure/functions` | ^4.9.0 | Azure Functions v4 programming model | MIT |
| `@modelcontextprotocol/sdk` | ^1.27.0 | MCP server framework | MIT |
| `better-sqlite3` | ^12.8.0 | Native SQLite driver (runtime) | MIT |
| `sql.js` | ^1.12.0 | WebAssembly SQLite (KB build) | MIT |
| `fast-xml-parser` | ^5.2.3 | XML parsing for D365 metadata/DMF exports | MIT |
| `adm-zip` | ^0.5.16 | ZIP handling for DMF exports | MIT |

All dependencies are open source with permissive licenses. **No commercial library costs.**

---

## 5. Azure Infrastructure & Capacities

### 5.1 Resource Inventory (per environment)

Each environment (Development, Production) requires the following Azure resources, deployed via Bicep:

| Resource | Azure Type | SKU / Tier | Naming Pattern |
|----------|-----------|------------|----------------|
| **Function App** | Microsoft.Web/sites | Linux, Node.js 20 | `tis-{env}-mcpd365fo-func` |
| **App Service Plan** | Microsoft.Web/serverfarms | **Elastic Premium EP1** | `tis-{env}-mcpd365fo-asp` |
| **Storage Account** | Microsoft.Storage/storageAccounts | Standard_LRS (StorageV2) | `tis{env}mcpd365fost` |
| **Key Vault** | Microsoft.KeyVault/vaults | Standard, RBAC-enabled | `tis-{env}-mcpd365fo-kv` |
| **Application Insights** | Microsoft.Insights/components | Log-based | `tis-{env}-mcpd365fo-appi` |
| **Log Analytics Workspace** | Microsoft.OperationalInsights/workspaces | Per-GB | `tis-{env}-mcpd365fo-log` |

### 5.2 Why Elastic Premium EP1

The Elastic Premium plan is required (not Consumption) because:

1. **Large SQLite databases loaded into memory** -- KB (~1 GB) + XRef (~3.3 GB) + Sec (~60 MB) + OTRS RAG (~500 MB) must remain in-process memory for sub-50ms query latency
2. **Persistent file storage** -- `/home/data/` mount provides durable file storage for SQLite databases across Function App restarts
3. **No cold-start penalty** -- Always-warm instances avoid 10-30s cold starts that would timeout MCP clients
4. **Predictable performance** -- MCP tool calls must respond within 1-2 seconds to remain useful in AI conversation flow

### 5.3 Storage & Compute Capacity

| Capacity | Value | Notes |
|----------|-------|-------|
| **Total database size on disk** | ~5.0 GB | KB (1.0 GB) + XRef (3.3 GB) + Sec (0.06 GB) + OTRS RAG (0.5 GB est.) |
| **Memory footprint (runtime)** | ~5-6 GB | SQLite databases loaded into process memory (better-sqlite3 mmap) |
| **EP1 instance memory** | 3.5 GB RAM | **May require EP2 (7 GB) if all services run on same instance** |
| **EP1 vCPU** | 1 vCPU | Sufficient for query workload (read-only SQLite) |
| **Max elastic instances** | 3 | Configured in Bicep, scales under load |
| **Blob storage for DB staging** | ~5 GB | Pre-built databases uploaded before deployment |
| **Log Analytics retention** | 30 days (default) | Adjustable |

**Important capacity note:** With the addition of the OTRS RAG database, the total in-memory footprint may exceed EP1's 3.5 GB limit. **An upgrade to EP2 (7 GB RAM) may be required.** This is the primary cost driver.

### 5.4 Environments

| Environment | Purpose | Usage Pattern |
|-------------|---------|---------------|
| **Development (d)** | Development, testing, validation | Active during business hours |
| **Production (p)** | Production use by AI clients and Copilot Studio agents | 24/7, low-traffic |

---

## 6. Operational Costs

### 6.1 Azure Costs (Monthly Estimate)

#### Per Environment

| Resource | SKU | Estimated Monthly Cost (EUR) | Notes |
|----------|-----|-----|-------|
| **App Service Plan** | EP1 (1 vCPU, 3.5 GB) | ~155 EUR | Always-on, 1 instance minimum. West Europe pricing |
| **App Service Plan** | EP2 (2 vCPU, 7 GB) | ~310 EUR | **If EP1 memory is insufficient** |
| **Storage Account** | Standard_LRS, ~10 GB | ~1 EUR | Databases + Function App storage |
| **Key Vault** | Standard, <100 ops/month | ~0.50 EUR | Minimal usage (API key storage) |
| **Application Insights** | ~1 GB/month ingestion | ~2.50 EUR | Log and telemetry data |
| **Log Analytics** | ~1 GB/month, 30-day retention | ~2.50 EUR | Query logs |
| **Bandwidth** | <5 GB egress/month | ~0.50 EUR | MCP responses (JSON, small payloads) |

#### Cost Summary

| Scenario | Dev (monthly) | Prod (monthly) | Total (monthly) | Total (annual) |
|----------|---------------|----------------|-----------------|----------------|
| **EP1 (if memory fits)** | ~162 EUR | ~162 EUR | **~324 EUR** | **~3,888 EUR** |
| **EP2 (if upgrade needed)** | ~317 EUR | ~317 EUR | **~634 EUR** | **~7,608 EUR** |
| **Mixed (Dev=EP1, Prod=EP2)** | ~162 EUR | ~317 EUR | **~479 EUR** | **~5,748 EUR** |

#### Cost Optimization Options

| Option | Savings | Trade-off |
|--------|---------|-----------|
| Shut down Dev environment outside business hours | ~40% on Dev ASP | Requires startup script, 2-3 min cold start |
| Use Consumption plan for Dev | ~70% on Dev ASP | Cold starts (10-30s), no persistent /home/data |
| Reduce Log Analytics retention to 7 days | ~50% on logging | Less historical data for troubleshooting |
| Single environment (Prod only) | 50% total | No separate test environment |

### 6.2 AI Platform Costs

These costs are prerequisites for consuming the MCP services. The MCP services themselves are AI-platform-agnostic, but each client platform requires its own license.

#### 6.2.1 Anthropic Claude (Primary AI Platform)

Claude is the primary development and consumption platform. It provides:
- **Claude Code** (CLI/Desktop) -- the main developer tool for interacting with MCP services
- **Claude.ai** -- hosts the d365rag service (documentation RAG) and Microsoft Learn integration
- **Claude API** -- programmatic access for custom integrations

| Plan | Price (USD/month) | Price (EUR/month) | Includes | Recommended For |
|------|-------|-------|----------|-----------------|
| **Claude Pro** | $20/user | ~18 EUR/user | 5x free usage, all models, Claude Code CLI | Occasional users |
| **Claude Max 5x** | $100/user | ~92 EUR/user | ~25x free usage, priority access | Regular developers |
| **Claude Max 20x** | $200/user | ~184 EUR/user | ~100x free usage, designed for heavy Claude Code use | Primary developer (Florian) |
| **Claude Team** | $30-35/seat | ~28-32 EUR/seat | Team admin, higher limits, 5-seat minimum | Team rollout |
| **Claude Enterprise** | Custom (~$60-100+/seat) | Custom | SSO/SAML, 500K context, data isolation, admin analytics | Enterprise rollout |

**Claude API pricing** (for custom integrations or API-key-based Claude Code usage):

| Model | Input (per 1M tokens) | Output (per 1M tokens) | Typical Use |
|-------|----------------------|------------------------|-------------|
| Claude Opus 4 | $15.00 | $75.00 | Complex analysis, code generation |
| Claude Sonnet 4 | $3.00 | $15.00 | General-purpose, good cost/quality ratio |
| Claude Haiku 3.5 | $0.80 | $4.00 | Fast lookups, simple queries |

**Current POC setup**: 1 user on Claude Max 20x = **~184 EUR/month**

**Scaling scenario** (3 developers + 2 architects):

| Users | Plan | Monthly (EUR) |
|-------|------|---------------|
| 1 primary developer | Max 20x | 184 |
| 2 regular developers | Max 5x | 184 |
| 2 architects (occasional) | Pro | 37 |
| **Total (5 users)** | Mixed | **~405 EUR/month** |

**Team plan alternative** (5 seats): 5 x 32 EUR = **~160 EUR/month** (but lower limits than Max)

#### 6.2.2 GitHub Copilot

| Plan | Price (USD/month/seat) | Price (EUR/month/seat) | Notes |
|------|------------------------|------------------------|-------|
| **Copilot Free** | $0 | 0 EUR | 2,000 completions, 50 chat messages, limited models |
| **Copilot Pro** | $10 | ~9 EUR | Unlimited completions, 300 premium requests/month |
| **Copilot Pro+** | $39 | ~36 EUR | 1,500 premium requests, access to Claude/GPT-4o |
| **Copilot Business** | $19/seat | ~17 EUR/seat | Org management, IP indemnity, policy controls |
| **Copilot Enterprise** | $39/seat | ~36 EUR/seat | Repo knowledge bases, doc indexing |

GitHub Copilot supports MCP via VS Code. "Premium requests" are consumed when using advanced models (Claude, GPT-4o) through Copilot Chat. MCP tool calls count as premium requests.

**Current POC setup**: Copilot is available but not the primary MCP client. Cost is covered by existing developer licenses.

#### 6.2.3 Microsoft Copilot Studio

| Component | Price (USD/month) | Price (EUR/month) | Notes |
|-----------|-------|-------|-------|
| **Copilot Studio (standalone)** | $200/tenant | ~184 EUR/tenant | 25,000 messages/month pooled across tenant |
| **Additional message pack** | ~$100/10,000 messages | ~92 EUR | For overage |
| **Microsoft 365 Copilot** (prerequisite for some features) | $30/user | ~28 EUR/user | AI in Office apps, separate from Copilot Studio |

Copilot Studio is the platform for building business-facing agents (e.g., security audit agent, onboarding agent) that consume MCP services. A "message" in generative AI mode may consume 2-3x the base message count due to orchestration overhead.

**Important**: Copilot Studio is **not included** in M365 E3/E5. It requires a separate license.

**Estimated usage**: With MCP tool calls, a single D365 security audit session (5-10 tool calls) consumes ~15-30 messages. At 25,000 messages/month, this supports ~800-1,600 audit sessions.

#### 6.2.4 Cursor IDE (Optional)

| Plan | Price (USD/month/seat) | Price (EUR/month/seat) | Notes |
|------|-------|-------|-------|
| **Cursor Pro** | $20 | ~18 EUR | 500 fast premium requests/month |
| **Cursor Business** | $40/seat | ~37 EUR/seat | Admin dashboard, SSO |

Cursor supports MCP natively. It is an optional alternative to Claude Code / VS Code Copilot.

#### 6.2.5 AI Cost Summary

**Minimum POC setup** (1 developer, no Copilot Studio):

| Platform | Plan | Monthly (EUR) |
|----------|------|---------------|
| Claude Max 20x | 1 user | 184 |
| GitHub Copilot | Existing license | 0 (already covered) |
| **Total** | | **~184 EUR/month** |

**Recommended POC setup** (1 developer + Copilot Studio for business agents):

| Platform | Plan | Monthly (EUR) |
|----------|------|---------------|
| Claude Max 20x | 1 user | 184 |
| Copilot Studio | 1 tenant | 184 |
| GitHub Copilot | Existing license | 0 |
| **Total** | | **~368 EUR/month** |

**Full rollout scenario** (5 users + Copilot Studio):

| Platform | Plan | Monthly (EUR) |
|----------|------|---------------|
| Claude (mixed plans) | 5 users | 405 |
| Copilot Studio | 1 tenant | 184 |
| GitHub Copilot Business | 5 seats | 87 |
| **Total** | | **~676 EUR/month** |

### 6.3 D365 F&O Costs (Data Extraction)

| Activity | Cost | Notes |
|----------|------|-------|
| DMF recurring export job | No additional cost | Uses existing D365 capacity |
| PackagesLocalDirectory access | No additional cost | Read-only access to dev environment metadata |
| SecurityDatabaseCustomizations export | No additional cost | Manual export from Security Configuration page |
| Additional D365 user license for automation | 0 EUR if using existing service account | Would be ~150-200 EUR/month if a new license is needed |

### 6.4 OTRS Costs

| Activity | Cost | Notes |
|----------|------|-------|
| BI report access | No additional cost | Uses existing BI infrastructure |
| REST API access | No additional cost | Existing OTRS API |
| API service account | To be confirmed | May require OTRS admin configuration |

---

## 7. Build & Deployment Pipeline

### 7.1 CI/CD Pipeline (Azure DevOps)

The existing pipeline (`azure-pipelines.yml`) handles:

| Stage | Description | Duration |
|-------|-------------|----------|
| **Build** | npm install, Linux prebuild for better-sqlite3, create deployment zip | ~3 min |
| **Infrastructure** | Bicep deployment (optional, one-time) | ~5 min |
| **Configure** | RBAC role assignments (Key Vault Secrets User) | ~1 min |
| **Deploy** | Upload SQLite databases to /home/data/, deploy code via zipDeploy, restart | ~15-30 min |
| **Validate** | Health checks, smoke tests, database verification | ~2 min |

Total pipeline runtime: **~25-40 minutes** (including large database uploads).

### 7.2 Database Build Pipeline

| Database | Build Script | Input Sources | Build Time | Output Size |
|----------|-------------|---------------|------------|-------------|
| KB | `build-kb.js` | PackagesLocalDirectory XML | ~10-15 min | ~1,063 MB |
| XRef | `build-xref-db.js` | PackagesLocalDirectory cross-refs | ~30-45 min (8 GB heap) | ~3,300 MB |
| Sec | `build-sec.js` | AOT XML + DMF XML + SecurityDatabaseCustomizations | ~2-5 min | ~30-60 MB |
| OTRS RAG | `build-otrs-rag.js` (planned) | BI report + OTRS REST API | Est. 10-30 min (depends on ticket volume) | Est. 100-500 MB |

### 7.3 Data Refresh Cadence

| Database | Trigger | Recommended Frequency |
|----------|---------|----------------------|
| KB | D365 version update, new custom models | Quarterly or per release |
| XRef | D365 version update | Quarterly or per release |
| Sec | DMF re-export from PROD | Monthly or after major role changes |
| OTRS RAG | New resolved tickets | Weekly (automated) or on-demand |

---

## 8. Architecture Summary

```
                    AI Clients
    ┌──────────────────────────────────────────────┐
    │  Claude Code  |  Copilot  |  Cursor  |  ...  │
    │  Claude Desktop  |  Copilot Studio  |  GPTs  │
    └──────────────────┬───────────────────────────┘
                       │ MCP Protocol
                       │ (Streamable HTTP / stdio)
                       ▼
    ┌──────────────────────────────────────────────┐
    │     Azure Function App (Linux, Node.js 20)   │
    │     App Service Plan: Elastic Premium EP1/2  │
    │                                              │
    │  ┌─────────┐ ┌─────────┐ ┌─────────┐       │
    │  │ d365kb  │ │d365xref │ │ d365sec │       │
    │  │ 17 tools│ │16 tools │ │15 tools │       │
    │  └────┬────┘ └────┬────┘ └────┬────┘       │
    │       │           │           │              │
    │  ┌─────────┐ ┌─────────┐ ┌─────────┐       │
    │  │otrs-rag │ │         │ │         │       │
    │  │ 8 tools │ │ shared  │ │   ...   │       │
    │  └────┬────┘ │  .js    │ │         │       │
    │       │      └─────────┘ └─────────┘       │
    │       ▼           ▼           ▼              │
    │  /home/data/  (persistent storage)           │
    │  ├── d365fo_kb.sqlite    (~1.0 GB)          │
    │  ├── d365fo_xref.sqlite  (~3.3 GB)          │
    │  ├── d365fo_sec.sqlite   (~0.06 GB)         │
    │  └── otrs_rag.sqlite     (~0.5 GB est.)     │
    └──────────────────────────────────────────────┘
                       │
    ┌──────────────────┴───────────────────────────┐
    │  Supporting Azure Resources                   │
    │  Storage Account | Key Vault | App Insights  │
    │  Log Analytics                                │
    └──────────────────────────────────────────────┘

    ┌──────────────────────────────────────────────┐
    │  Cloud Services (external)                    │
    │  d365rag (Claude.ai) | Microsoft Learn       │
    └──────────────────────────────────────────────┘

    ┌──────────────────────────────────────────────┐
    │  Data Sources                                 │
    │  D365 PackagesLocalDirectory (AOT XML)       │
    │  D365 DMF Exports (PROD security/users)      │
    │  OTRS BI Report (resolved tickets)           │
    │  OTRS REST API (ticket articles)             │
    │  Blueprint documents (Markdown/Word)         │
    └──────────────────────────────────────────────┘
```

---

## 9. Detailed Work Breakdown -- Remaining Work

### 9.1 Security Service (d365sec) -- Finalization

| Task | Effort | Status |
|------|--------|--------|
| Pipeline integration (azure-pipelines.yml) | 0.5 day | Pending |
| Documentation updates (README, AI-Config, Copilot Studio) | 0.5 day | Pending |
| DMF export automation (D365 recurring data job) | 0.5 day | Pending (requires Eugene) |
| Production deployment & validation | 0.5 day | Pending |
| **Subtotal** | **2 days** | |

### 9.2 RAG Blueprint Extension (d365rag)

| Task | Effort | Status |
|------|--------|--------|
| Define blueprint document format & chunking strategy | 1 day | Not started |
| Build ingestion pipeline (Markdown/Word to RAG database) | 2 days | Not started |
| Add "blueprint" category, tune search relevance | 1 day | Not started |
| Test with Legal Entity Configuration Blueprint & audit doc | 0.5 day | Not started |
| Documentation | 0.5 day | Not started |
| **Subtotal** | **5 days** | |

### 9.3 OTRS Ticket Knowledge Service (otrs-rag)

| Task | Effort | Status |
|------|--------|--------|
| Analyze OTRS BI report structure & REST API authentication | 1 day | Not started |
| Design SQLite schema (tickets, articles, chunks, FTS) | 0.5 day | Not started |
| Build `build-otrs-rag.js`: BI report fetch + REST API article retrieval + chunking + SQLite build | 3 days | Not started |
| Implement 8 MCP tools (`otrs-tools.js`) | 2 days | Not started |
| Azure Function endpoint + local stdio server | 0.5 day | Not started |
| Pipeline integration | 0.5 day | Not started |
| Automated refresh (weekly cron or trigger) | 1 day | Not started |
| Testing & validation | 1 day | Not started |
| Documentation | 0.5 day | Not started |
| **Subtotal** | **10 days** | |

### 9.4 Total Development Effort

| Work Package | Effort |
|--------------|--------|
| Security service finalization | 2 days |
| RAG blueprint extension | 5 days |
| OTRS ticket knowledge service | 10 days |
| Infrastructure capacity review (EP1 vs EP2) | 0.5 day |
| End-to-end integration testing | 1 day |
| Copilot Studio configuration for new services | 1 day |
| **Total remaining effort** | **~19.5 days** |

---

## 10. Risk Assessment

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| EP1 memory insufficient for all databases | High | Medium | Monitor memory usage; budget for EP2 upgrade |
| OTRS REST API rate limits or authentication complexity | Medium | High | Early API analysis; fallback to batch export |
| Large OTRS ticket volume causes build time/database size issues | Medium | Medium | Filter to last 2-3 years of resolved tickets; compress articles |
| D365 DMF export format changes between versions | Low | Medium | Version-pin DMF entity schemas; validate in build script |
| Claude.ai RAG service availability | Low | Low | d365rag is supplementary; core services run on Azure |
| MCP SDK breaking changes | Low | Medium | Pin SDK version; test before upgrading |

---

## 11. Dependencies & Prerequisites

| Prerequisite | Owner | Status |
|--------------|-------|--------|
| Azure subscription with resource group `tis-{env}-mcpd365fo-rg` | TIS IT | Done |
| Azure DevOps service connection `azure-mcpd365fo` | TIS IT | Done |
| D365 PackagesLocalDirectory access (dev environment) | Eugene | Done |
| DMF data project `secMCP_Repository` (6 security entities) configured in PROD | Eugene (CR 99351) | In progress |
| SecurityDatabaseCustomizations export from PROD | Florian / Eugene | Done |
| OTRS BI report credentials & access | TIS IT | Not started |
| OTRS REST API credentials (service account) | TIS IT / OTRS admin | Not started |
| Anthropic subscription (Claude Max) | Florian | Active |
| Copilot Studio environment | TIS IT | Available |

---

## 12. Success Criteria for POC

| Criterion | Measurement |
|-----------|------------|
| All 6 MCP services operational and responding to health checks | `GET` returns `{"status":"ok"}` on all endpoints |
| ~67 tools available across all services | Tool listing returns expected count per service |
| Query latency < 2 seconds for 95% of tool calls | Application Insights P95 metric |
| Security service correctly reflects PROD role/user assignments | Spot-check 10 users against D365 PROD |
| OTRS RAG returns relevant resolved tickets for known issues | Test with 5 known tickets, verify article content returned |
| Blueprint search returns relevant design documents | Test with 3 known blueprint topics |
| At least 2 AI clients successfully connected (Claude Code + Copilot Studio) | End-to-end tool call from each client |
| CI/CD pipeline deploys all services in < 45 minutes | Pipeline execution time |

---

## 13. Timeline

| Phase | Scope | Target |
|-------|-------|--------|
| **Phase 1** (immediate) | Finalize d365sec, deploy to PROD | April 2026 |
| **Phase 2** (short-term) | OTRS RAG: API analysis, build pipeline, tools | April-May 2026 |
| **Phase 3** (short-term) | RAG blueprint extension | May 2026 |
| **Phase 4** (validation) | Infrastructure capacity review, EP1/EP2 decision | May 2026 |
| **Phase 5** (completion) | Integration testing, Copilot Studio onboarding, documentation | June 2026 |

---

## 14. Budget Summary

### 14.1 Monthly Cost Overview

#### POC Phase (1 developer, 2 environments)

| Category | Monthly (EUR) | Notes |
|----------|---------------|-------|
| **Azure infrastructure** | 324 - 634 | EP1 (324) vs EP2 (634), 2 environments |
| **Claude Max 20x** | 184 | Primary developer (Florian) |
| **Copilot Studio** | 184 | Business agent platform (1 tenant) |
| **GitHub Copilot** | 0 | Covered by existing license |
| **NPM dependencies** | 0 | Open source (MIT) |
| **D365 data extraction** | 0 | Existing D365 capacity |
| **OTRS data access** | 0 (TBC) | Existing infrastructure |
| **Total (EP1 scenario)** | **~692 EUR/month** | |
| **Total (EP2 scenario)** | **~1,002 EUR/month** | |

#### Full Rollout (5 users, 2 environments)

| Category | Monthly (EUR) | Notes |
|----------|---------------|-------|
| **Azure infrastructure** | 324 - 634 | EP1 vs EP2 |
| **Claude (mixed plans)** | 405 | 1x Max 20x + 2x Max 5x + 2x Pro |
| **Copilot Studio** | 184 | 1 tenant, 25,000 messages |
| **GitHub Copilot Business** | 87 | 5 seats x ~17 EUR |
| **Total (EP1 scenario)** | **~1,000 EUR/month** | |
| **Total (EP2 scenario)** | **~1,310 EUR/month** | |

### 14.2 Annual Cost Overview

| Scenario | Monthly (EUR) | Annual (EUR) |
|----------|---------------|--------------|
| **POC minimum** (1 dev, EP1, no Copilot Studio) | 508 | 6,096 |
| **POC recommended** (1 dev, EP1, Copilot Studio) | 692 | 8,304 |
| **POC with EP2** (1 dev, EP2, Copilot Studio) | 1,002 | 12,024 |
| **Full rollout** (5 users, EP1, all platforms) | 1,000 | 12,000 |
| **Full rollout** (5 users, EP2, all platforms) | 1,310 | 15,720 |

### 14.3 Cost Breakdown by Category

```
  POC Recommended (692 EUR/month)          Full Rollout (1,310 EUR/month)
  ┌─────────────────────────────┐          ┌─────────────────────────────┐
  │ Azure Infra    47%  324 EUR │          │ Azure Infra    48%  634 EUR │
  │ Claude         27%  184 EUR │          │ Claude         31%  405 EUR │
  │ Copilot Studio 26%  184 EUR │          │ Copilot Studio 14%  184 EUR │
  │ Other           0%    0 EUR │          │ Copilot         7%   87 EUR │
  └─────────────────────────────┘          └─────────────────────────────┘
```

### 14.4 Development Effort

| Work Package | Effort |
|--------------|--------|
| Security service finalization | 2 days |
| RAG blueprint extension | 5 days |
| OTRS ticket knowledge service | 10 days |
| Infrastructure + testing + onboarding | 2.5 days |
| **Total remaining effort** | **~19.5 person-days** |

### 14.5 Key Cost Drivers

1. **Azure App Service Plan (EP1/EP2)** -- required for in-memory SQLite databases with sub-second query performance. This is the single largest cost and cannot be replaced by a Consumption plan due to memory and cold-start requirements.
2. **Claude subscription** -- required for Claude Code (the primary development and MCP consumption tool) and for hosting the d365rag cloud service. The Max 20x plan is recommended for heavy Claude Code usage during development; can be downgraded to Pro for occasional users.
3. **Copilot Studio** -- required only if building business-facing agents (security audit agent, onboarding agent). Can be deferred if MCP services are consumed exclusively via developer tools (Claude Code, Copilot, Cursor).
4. **All other costs are negligible** -- open-source dependencies, existing D365 capacity, existing OTRS infrastructure.

---

**Document owner**: Florian Dittgen
**Next step**: Review with stakeholders, validate OTRS API access, confirm EP1/EP2 capacity requirement
