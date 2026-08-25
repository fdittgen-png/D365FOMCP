# Securing the D365FO MCP services with Entra ID (OAuth)

Turns the currently-anonymous Azure Function MCP endpoints into Entra-protected,
group-gated services that work across Claude Code, claude.ai connectors, and
Copilot Studio.

**Reference:** in-house pattern from Karl-Johan's app (same tenant). His MCP
fronts a downstream API, so he needed an **on-behalf-of (OBO)** exchange. **Ours
does not** — the Function App reads local SQLite and *is* the resource server, so
we use the simpler "protected resource" shape: client gets a user token → sends
`Authorization: Bearer` → the Function validates it and checks group/role.

- Tenant: `0f861177-7722-4f06-8db9-3384e5321a9f` (Trelleborg)
- Function App: `tis-d-mcpd365fo-func` (RG `tis-d-mcpd365fo-rg`); prod analog `tis-p-…`
- Endpoints to protect: `/api/d365kb`, `/api/d365xref`, `/api/d365sec`,
  `/api/d365taskrecorder` (+ its `/upload` route), `/api/wiki-mcp/{name}`
- Leave **anonymous** (no auth): `/api/ping` (liveness probe,
  `src/functions/d365ping.js`) and `/api/icon.png` + `/api/icon-512.png`
  (server icon, `src/functions/d365icon.js` — referenced from every MCP
  server's `initialize` → `serverInfo.icons`; connector directories fetch it
  unauthenticated). Both are Easy Auth excluded paths; add new ones with
  `scripts/Update-McpAuthExcludedPaths.ps1` (non-destructive merge).
  `/api/health` is the admin dashboard backend and sits **behind** Easy Auth;
  its code fail-closes via `decideAdminAccess` anyway.

We gate access with an **app role** assigned to a **security group** (app roles
avoid the `groups`-claim overage problem KJ would hit at scale).

---

## Why not OBO — this service vs. the Orion deck

The Orion engineering deck ("OAuth On-Behalf-Of in the Orion Platform")
describes KJ's **two-hop** topology: Claude → MCP bridge (Container App) →
downstream Function API. There, the MCP server must *swap audiences* — it
receives Token A (audience: MCP) and performs an OBO exchange for Token B
(audience: the API) — and it proxies the whole OAuth flow, so the Container
App exposes five unauthenticated OAuth endpoints (`/.well-known/*`,
`/register`, `/authorize`, `/token`).

This service is **single-hop**: the Function App *is* the resource server
(local SQLite, no downstream API), so there is no second audience and nothing
for OBO to exchange. Mapping the deck's elements onto this project:

| Orion deck element | This project | Why |
|---|---|---|
| Identity preservation — API sees the user's `oid`, never an SP | Same invariant, enforced directly: `mcp-auth.js` requires the principal id (`oid`); no id → 401 | Single hop — no bridge to lose identity behind |
| Audience binding | Same invariant: Easy Auth validates `aud` against the App ID URI + client ID, issuer pinned to tenant v2.0 | — |
| Auth code + PKCE, public client, Mobile & desktop redirects | Identical (same claude.ai callback + `http://localhost` loopback) | — |
| No client secrets | Same for MCP clients (public client + PKCE). Exception: Copilot Studio needs a secret (confidential client, Part D) | No UAMI needed — nothing server-side ever requests a token |
| **OBO exchange (Token A → Token B)** | Not implemented | Only one token exists; no second audience |
| **Two app registrations (MCP + API)** | ONE combined registration (resource + public client) | Matches in-house `sp-tis-p-orion-mcp`/`pulsar` registration shape; no audience swap to declare |
| **UAMI federated credential, `knownClientApplications`, `/.default` OBO scope** | None | All exist solely to enable OBO |
| **MCP proxies OAuth; five unauthenticated OAuth endpoints** | **Same — since 2026-08-05.** `src/functions/oauth-proxy.js` serves the equivalent five: PRM, AS metadata, `/api/oauth/register` (mock DCR), `/api/oauth/authorize`, `/api/oauth/token` | Forced by Entra: it rejects the MCP-mandated RFC 8707 `resource` param (AADSTS9010010), so the proxy strips it. Exactly why orion's Container App has these endpoints |

The deck's *security properties* (audience-bound tokens, end-to-end `oid`
attribution, secret-free client chain) all hold here. The one structural
divergence that remains is **OBO itself** (rows 5–7): single hop, one
registration, no token exchange, no UAMI. The client-facing OAuth-proxy
surface, by contrast, turned out not to be an Orion-specific choice but a
general Entra-vs-MCP-spec compatibility requirement — this service adopted it
on 2026-08-05 (see "The MCP OAuth proxy" below). **When the deck's pattern
becomes fully right for us:** the day a tool calls **live D365 on the user's
behalf**, we add KJ's second registration + OBO exchange (see the note at the
end of Part A).

---

## Status (2026-08-05)

- **✅ E2E VERIFIED (2026-08-05):** full interactive MCP OAuth completed from
  Claude Code through the deployed OAuth proxy — discovery → proxied
  authorize (resource stripped) → Entra sign-in → proxied token → Easy Auth
  validation → `Mcp.Access` gate → live `d365_list_modules` result. No admin
  consent prompt appeared (the 2026-08-04 permission grants sufficed). Two
  deploy-day gotchas, both fixed: (1) `az webapp auth update
  --excluded-paths` takes only ONE value (same quirk as
  `--allowed-audiences`) — `Enable-McpAuth.ps1` now writes the full list via
  an ARM `authsettingsV2` PUT; (2) **`AADSTS50011`**: Entra ignores the
  loopback *port* but matches the *path* — Claude Code redirects to
  `http://localhost:<port>/callback`, so the registration needs
  `http://localhost/callback` in addition to `http://localhost` (added live +
  in `Configure-McpAppRegistration.ps1`). Also: new function files must be
  imported in `src/functions/index.js` or their routes silently don't exist —
  now enforced by a static-scan test.
- **OAuth proxy implemented (2026-08-05, deployed same day):** the first real
  member sign-in test failed at Entra with **`AADSTS9010010`** ("The resource
  parameter provided in the request doesn't match with the requested
  scopes"). Root cause: the MCP spec (2025-06-18) makes clients send an
  RFC 8707 `resource` parameter (the MCP server URL, copied verbatim from the
  PRM document), and since Entra's ~2026-03 enforcement change the v2.0
  endpoints reject any `resource` that is not an Application ID URI of the
  scope's app — and tenant policy blocks registering
  `https://…azurewebsites.net/…` URIs (no verified domain). Every
  spec-compliant MCP client (Claude Code, claude.ai) dead-ends there; VS Code
  only works because it doesn't send `resource`. Fix: the in-app **OAuth
  proxy** (`src/functions/oauth-proxy.js` + `src/azure/oauth-proxy-core.js`)
  — see "The MCP OAuth proxy" section. Requires a code deploy + re-run of
  `Enable-McpAuth.ps1` (new excluded paths, removes
  `WEBSITE_AUTH_PRM_DEFAULT_WITH_SCOPES`).
- **CUTOVER LIVE (2026-08-04):** Easy Auth (Return401) enforces on every MCP
  endpoint of `tis-d-mcpd365fo-func`; `Enable-McpAuth.ps1` ran with
  `-ApiAppId 54b1261c-352d-4772-b83a-001e529bd117` and removed the temporary
  `REQUIRE_AUTH=false` setting. Verified 2026-08-05 by anonymous probes: all
  five MCP surfaces + `/upload` + `/api/health` → 401, `/api/ping` → 200,
  RFC 9728 metadata served at `/.well-known/oauth-protected-resource`, and the
  401 challenge carries `scope=` + `resource_metadata=`. Operational
  learnings (PIM, MFA-claim tokens, `az webapp auth` quirks) live in
  `skills/claude-code/mcp-deploy.md` § Session learnings 2026-08-04.
- **Code gate (Part C): implemented and merged** — see below.
- **Directory work needs an admin**: creating app registrations and security
  groups returns `Insufficient privileges` for our accounts (tenant restricts
  both) → Part A goes to Aaron. ARM writes on the Function App work fine
  non-interactively from the TIS.D365FO subscription.
- **In-house precedent found**: `sp-tis-p-orion-mcp`, `sp-tis-p-busarch-mcp`,
  `sp-tis-t-pulsar-mcp` all use a **single combined registration** — the MCP
  is both resource (App ID URI + scope, token v2) and public client
  (claude.ai callback redirect). We follow that shape: ONE app registration,
  not two.
- **Aaron returned the app registration on 2026-07-06** — as
  `sp-tis-p-D365metadata-mcp` (appId `5e8bc645-a8f6-4516-a4dc-9235d242a309`,
  object id `d32f6d4c-8a37-424d-9982-c5237c7cbdd1`), **not** the
  `sp-tis-d-mcpd365fo-mcp` name asked for below — accepted as-is rather than
  asking for a rename. It was created as a bare shell (no App ID URI, scope,
  app role, or public-client redirect URIs yet — just the portal-default
  Graph `User.Read` permission). The full Part A config (Expose an API +
  `user_impersonation` scope + `Mcp.Access` role + public client redirects +
  self-consent) has been assembled as a manifest for import; the security
  group (`D365FO-MCP-Users`) and Enterprise App role assignment /
  Assignment-required still need Aaron. `scripts/Enable-McpAuth.ps1`'s
  `-AppIdUri` default now points at `api://trelleborg.onmicrosoft.com/sp-tis-p-D365metadata-mcp`.
- **Tenant policy blocks bare-name Application ID URIs.** Attempting to set
  `api://sp-tis-p-D365metadata-mcp` in Expose an API failed: *"All newly
  added URIs must contain a tenant verified domain, tenant ID, or app ID"*.
  Used the verified-domain form instead:
  `api://trelleborg.onmicrosoft.com/sp-tis-p-D365metadata-mcp`. This means
  the `sp-tis-p-orion-mcp`-style bare name assumed in Part A below either
  predates this tenant policy or was never actually configured that way —
  don't trust that precedent for the URI *format*, only for the
  single-registration *shape*.
- **2026-07-20 sign-in test hit "Need admin approval"; Aaron's diagnosis
  (Teams, same day): wrong blade.** Consent was being chased on the
  **Enterprise application → Permissions** blade, which is a read-only
  *view* of grants that already exist — it showed "No admin consent
  permissions found" simply because nothing has been granted yet. The
  working direction is the opposite: declare the wanted permissions on the
  **App registration → API permissions** blade (step 1d below), have an
  admin grant consent *there*, and the grants propagate to the Enterprise
  app automatically. The tenant disables user self-consent, so *every*
  scope a sign-in requests (the self `user_impersonation`, plus OIDC
  `openid`/`profile`/`offline_access`) must be covered by that one admin
  grant — anything missing re-triggers the "Need admin approval" prompt.
- **2026-08-04 — the target registration CHANGED.** The full Teams thread
  revealed Aaron's link points at a **second, newer registration**: via
  Ticket#202607102005643 he created the properly-named
  **`sp-tis-d-d365fokb-mcp`** (appId `54b1261c-352d-4772-b83a-001e529bd117`,
  app object `6c08d606-df94-46af-adb6-d7974f3bda37`, Enterprise app
  `5c2276ef-a699-4e1d-b3b3-f42b314eb86d`) **plus the security group
  `D365FO-MCP-Users`** (`371b144a-234f-4df3-b99a-980a4f6eee4c`) — all bare
  ("created, not configured") and **all owned by Florian**. This supersedes
  `sp-tis-p-D365metadata-mcp` (`5e8bc645-…`), which is retired for this
  purpose. Ownership makes everything self-service except a possible
  Global-Admin consent grant (per Karl-Johan, likely unnecessary — the
  scope allows user consent, so a one-time Accept dialog is the expected
  UX). **One script now does all of Part A + step 2:**
  `scripts/Configure-McpAppRegistration.ps1` (idempotent; URI/token-v2/
  scope/role/public-client/permissions on the registration, plus group
  membership, role assignment, Assignment required = Yes). Run it from an
  interactive `az` session (Graph sits behind the CA step-up:
  `az login --tenant 0f861177-… --scope https://graph.microsoft.com/.default`),
  then the sign-in smoke test it prints, then
  `Enable-McpAuth.ps1 -ApiAppId 54b1261c-…` (its `-AppIdUri` default now
  points at `api://trelleborg.onmicrosoft.com/sp-tis-d-d365fokb-mcp`).

## Part A — The ask for Aaron (forward this verbatim)

> Stand-alone version: [`MCP-Entra-Auth-Handover.md`](MCP-Entra-Auth-Handover.md)
> contains this ask as a ready-to-send email plus the full explanation —
> the file to share outside the repo.

> Hi Aaron — to put Entra OAuth in front of the D365FO MCP Function App
> (`tis-d-mcpd365fo-func`, tenant `0f861177-7722-4f06-8db9-3384e5321a9f`), could you
> set up the following? Same shape as `sp-tis-p-orion-mcp` /
> `sp-tis-t-pulsar-mcp` (single registration: the MCP is the resource *and*
> the public client — no OBO, no separate client app), plus one app role.
>
> **1. App registration `sp-tis-d-mcpd365fo-mcp`** (single tenant):
> - **Expose an API** → Application ID URI: **`api://sp-tis-d-mcpd365fo-mcp`**;
>   requested access token version **2**.
> - Delegated scope **`user_impersonation`** (admins and users may consent).
> - **App role**: display name "MCP Access", value **`Mcp.Access`**
>   (exact casing — the code matches this string), member types *Users/Groups*.
> - **Authentication**: *Allow public client flows = Yes*; Mobile/desktop
>   redirect URIs: `https://claude.ai/api/mcp/auth_callback` and
>   `http://localhost` (Claude Code loopback) — same as orion-mcp.
> - API permissions: its own `user_impersonation` scope, **admin consent**.
>
> **2. Security group `D365FO-MCP-Users`**:
> - Initial member: Florian Dittgen (oid `9495865f-c1c7-459f-87a6-4e9d8a20fb28`).
> - Enterprise app → Users and groups → assign the group to the **Mcp.Access** role.
> - Enterprise app → Properties → **Assignment required = Yes**.
>
> **What I need back:** the app registration's **client ID** and confirmation
> of the App ID URI + group assignment. I run the Easy Auth cutover on the
> Function App myself (`scripts/Enable-McpAuth.ps1`).

*(If we ever add a tool that calls **live D365** on the user's behalf, that's
when we'd add KJ's second SP + OBO exchange — not now. If claude.ai's
connector turns out to require a confidential client, we'd additionally ask
for a client secret on the same registration — pulsar/orion get by without.)*

---

## Part A explained — what each Entra object does, and where its counterpart lives in this repo

### The big picture

Two directory objects make the whole security model work:

1. **App registration `sp-tis-d-mcpd365fo-mcp`** — teaches Entra that our
   Function App is a thing you can request an access token *for* (a
   "resource"), and simultaneously a thing that can *request* tokens (a
   "client", since MCP clients like Claude authenticate as this app). The
   in-house MCP registrations (`sp-tis-p-orion-mcp`, `sp-tis-t-pulsar-mcp`)
   combine both halves in one registration, and we follow that.
2. **Security group `D365FO-MCP-Users`** — the on/off switch for individual
   people. Nobody touches Entra config again after setup; access management
   becomes "add/remove a person from this group."

At runtime the flow is: a client asks Entra for a token for
`api://sp-tis-d-mcpd365fo-mcp` → Entra checks the user is assigned (via the
group) → stamps `"roles": ["Mcp.Access"]` into the token → Easy Auth on the
Function App validates the token's signature/issuer/audience/expiry → our
`mcp-auth.js` reads the roles claim and requires `Mcp.Access`. No directory
lookup ever happens at request time — everything travels inside the token.

### Step 1 — The app registration

**Entra portal → App registrations → New registration**
- Name: `sp-tis-d-mcpd365fo-mcp` (org convention:
  `sp-tis-<env>-<workload>-<kind>`; `d` = dev, matching
  `tis-d-mcpd365fo-func`).
- Supported account types: **single tenant** ("Accounts in this
  organizational directory only"). Nobody outside Trelleborg's tenant can
  ever get a token.
- Redirect URI: skip on this screen — added in step 1c.

> **App side:** the registration's name itself never appears in code. Its
> two derived values do: the **client ID** Aaron returns is the
> `-ApiAppId` parameter of `scripts/Enable-McpAuth.ps1` (mandatory, no
> default), and the **App ID URI** is `-AppIdUri` (default
> `api://sp-tis-d-mcpd365fo-mcp`, `Enable-McpAuth.ps1:28`). Both are written
> into the Function App's Easy Auth config as allowed audiences — the
> Node code never sees them.

#### 1a. Expose an API (make it a resource)

**App registration → Expose an API:**
- Set the **Application ID URI** to `api://sp-tis-d-mcpd365fo-mcp`
  (name-based, like orion — not the bare-GUID default). This URI is the
  token **audience**: it's what clients request, and what Easy Auth
  validates the token's `aud` claim against.
- Add a scope named **`user_impersonation`** ("Admins and users" can
  consent; display name something like "Access D365FO MCP as the signed-in
  user"). A scope is just the named permission a client asks for during
  sign-in — it's what appears on the user's consent screen. It grants
  nothing by itself; the real access control is the role + group.
- **Manifest / advanced:** set requested access token version to **2**
  (`api.requestedAccessTokenVersion: 2`). Without this, Entra issues
  v1-format tokens whose issuer string differs from the `…/v2.0` issuer the
  Function App is configured to validate — a classic silent-401 trap.
  Orion's registration has this set.

> **App side:** audience validation is Azure platform config, not code —
> `Enable-McpAuth.ps1:42` passes `--allowed-audiences $AppIdUri $ApiAppId`
> (both forms, because Entra can emit either as `aud`). The matching
> **issuer** is built from `-TenantId` (default Trelleborg,
> `Enable-McpAuth.ps1:32`) as `https://login.microsoftonline.com/<tenant>/v2.0`
> (`Enable-McpAuth.ps1:41`) — which is why token version **2** on the
> registration is mandatory. The **scope name** has no counterpart in this
> repo's server code; it resurfaces only in client configuration (Part D)
> and the Copilot Studio swagger `securityDefinitions`.

#### 1b. The app role (make authorization decisions possible)

**App registration → App roles → Create app role:**
- Display name: `MCP Access`
- Value: **`Mcp.Access`** — this exact string, exact casing.
- Allowed member types: **Users/Groups** (the "Applications" option is for
  daemon/client-credential scenarios — not this pattern).

Why a role rather than checking group membership directly? Group claims
have an overflow problem: users in very many groups get a Graph link
instead of a `groups` claim, forcing a directory call. App Roles never
overflow — the role value is always in the token.

> **App side:** this is the one Entra value the Node code matches directly.
> The default is hard-coded as `DEFAULT_REQUIRED_ROLE = 'Mcp.Access'`
> (`src/azure/mcp-auth.js:21`) and can be overridden **without a code
> change** via the `MCP_REQUIRED_ROLE` app setting (`mcp-auth.js:25`,
> documented in `.env.example`). The match is exact and case-sensitive
> (`decideMcpAuthorization`, enforced by a test in
> `test/mcp-auth.test.js` — `mcp.access` is rejected). Which claim types
> count as roles IS hard-coded: `typ === 'roles'` or `typ` ending in
> `/role` (`mcp-auth.js:62`) — the two forms Easy Auth emits.

#### 1c. Authentication (make it a client too)

**App registration → Authentication:**
- **Allow public client flows = Yes.** Claude Code and MCP Inspector are
  "public clients" — apps that can't hold a secret. They authenticate via
  the auth-code + PKCE flow with a loopback redirect.
- Under **Mobile and desktop applications**, add redirect URIs:
  - `https://claude.ai/api/mcp/auth_callback` — where claude.ai's connector
    sends the user back after sign-in (exactly what orion-mcp has
    registered).
  - `http://localhost` — Claude Code spins up a temporary local listener
    during its OAuth flow.

The redirect URI is a security control: Entra will only deliver auth codes
to pre-registered addresses, so a phishing site can't intercept the flow.

> **App side:** nothing — redirect URIs live exclusively in Entra and in
> the calling clients. Neither the Function App code nor the cutover script
> references them.

#### 1d. API permission + admin consent (smooth the UX)

**App registration → API permissions:** add a delegated permission to
**its own** `user_impersonation` scope (select "APIs my organization uses"
→ `sp-tis-d-mcpd365fo-mcp`), then click **Grant admin consent**. This
pre-approves the consent dialog for the whole tenant so users don't each
see a "this app wants to access…" prompt on first connect. It's UX, not
security — the security is step 2. In *this* tenant it is more than UX:
user self-consent is disabled, so without the admin grant every sign-in
dead-ends at "Need admin approval".

> **Blade trap (Aaron, 2026-07-20):** grant consent from the **App
> registration → API permissions** blade, *not* from the Enterprise app →
> Permissions blade. The Enterprise-app blade only displays grants after
> they exist; consent granted on the registration transfers to the
> Enterprise app automatically. Also declare Graph `openid`, `profile`,
> `offline_access` (refresh tokens for MCP clients) alongside the default
> `User.Read`, so the single admin grant covers everything a sign-in
> requests. `scripts/Add-McpApiPermissions.ps1` declares the full list
> idempotently.

> **App side:** nothing — consent state lives entirely in Entra.

### Step 2 — The group and the enterprise-app settings

Creating the app registration auto-creates a companion **Enterprise
application** (the service principal — the registration's footprint in
*this* tenant). Two settings there, plus the group:

- **Create security group `D365FO-MCP-Users`** (plain security group, no
  mail). First member: Florian Dittgen
  (oid `9495865f-c1c7-459f-87a6-4e9d8a20fb28`).
- **Enterprise app → Users and groups → Add user/group:** assign
  `D365FO-MCP-Users` to the **MCP Access** role. This is the mapping that
  makes Entra stamp `Mcp.Access` into the token of anyone in the group.
- **Enterprise app → Properties → Assignment required = Yes.** This is the
  gate that makes "only authorized people get tokens *at all*" true: any
  tenant user *not* in the group gets `AADSTS50105` at sign-in — they never
  receive a token, so they never even reach our 403. Without this, any
  Trelleborg user could get a (role-less) token and we'd rely solely on the
  in-code role check.

> **App side:** nothing — group name and membership never appear in code
> (that's the point of using the `roles` claim). The code only ever sees
> the *result*: role values inside the token.

Note the defense-in-depth: three independent layers must all agree — token
issuance (assignment required), platform validation (Easy Auth), and the
code's role check (`mcp-auth.js`).

### Configuration map — every value, where it lives, how to change it

| Value | Entra side | This repo / Azure side | Changeable without code change? |
|---|---|---|---|
| Client ID | App registration overview | `Enable-McpAuth.ps1 -ApiAppId` → Easy Auth client ID + allowed audience | Yes (script param) |
| App ID URI / audience | Expose an API | `Enable-McpAuth.ps1 -AppIdUri` (default `api://sp-tis-d-mcpd365fo-mcp`) → `--allowed-audiences` | Yes (script param) |
| Tenant / issuer | Directory | `Enable-McpAuth.ps1 -TenantId` (default Trelleborg) → `--issuer …/v2.0` | Yes (script param) |
| Role value `Mcp.Access` | App role definition | Default `src/azure/mcp-auth.js:21`; override via **`MCP_REQUIRED_ROLE`** app setting | Yes (app setting) |
| Role claim types (`roles`, `…/role`) | Token format (fixed by Entra) | Hard-coded `src/azure/mcp-auth.js:62` | No |
| Auth enforcement on/off | — | **`REQUIRE_AUTH`** app setting; only the literal `false` disables (`mcp-auth.js:36`) | Yes (app setting) |
| "Is Easy Auth on" signal | — | `WEBSITE_AUTH_ENABLED === 'True'` — set by the App Service platform, read at `src/azure/admin-auth.js:12` | Platform-managed |
| Principal transport | — | Easy Auth headers `x-ms-client-principal(-id/-name)` — fixed platform contract, parsed at `mcp-auth.js:141` / `admin-auth.js:17` | No |
| `oid` required | Token claim | No principal id header → 401 (`admin-auth.js getAuthUser` + `mcp-auth.js`) | No (by design) |
| 401/403/503 texts incl. stale-token hint | — | Hard-coded in `decideMcpAuthorization` (`mcp-auth.js:116` area) | No |
| Which endpoints are gated | — | Each handler in `src/functions/` calls `authorizeMcpRequest`; the static-scan test in `test/mcp-auth.test.js` fails if one is missing | Code change, test-enforced |
| Liveness-probe exception | — | `--excluded-paths '/api/ping'` hard-coded in `Enable-McpAuth.ps1` (plain path — the `'[…]'` bracket form is stored as a literal); route defined in `src/functions/d365ping.js` | Script edit |
| Scope `user_impersonation`, redirect URIs, group name/membership | Expose an API / Authentication / group | No server-side counterpart; scope reappears in client config (Part D) + Copilot swagger | Entra only |

### What Aaron sends back

Just the registration's **Application (client) ID** — one GUID. Everything
else is fixed by convention (App ID URI, tenant ID, role value). That GUID
is the only parameter of the cutover:

```powershell
.\scripts\Enable-McpAuth.ps1 -ApiAppId <that-guid>
```

**Actual values (history):** the first registration returned on 2026-07-06
was `sp-tis-p-D365metadata-mcp` (`5e8bc645-a8f6-4516-a4dc-9235d242a309`) —
**retired**, superseded on 2026-08-04 by `sp-tis-d-d365fokb-mcp`
(`54b1261c-352d-4772-b83a-001e529bd117`, see the Status section). The cutover
command that actually ran:

```powershell
.\scripts\Enable-McpAuth.ps1 -ApiAppId 54b1261c-352d-4772-b83a-001e529bd117
```

(`-AppIdUri` defaults to `api://trelleborg.onmicrosoft.com/sp-tis-d-d365fokb-mcp` already — no
override needed.)

### Why a directory admin and not us

Both creations were attempted on 2026-07-06 and failed with *Insufficient
privileges* — the tenant restricts app-registration **and** group creation
to directory admins. The admin-consent grant in 1d requires a privileged
role even in tenants where users may register apps.

One operational note to hand over with the ask: role assignments are baked
into tokens **at issue time**. Someone added to `D365FO-MCP-Users` today
still carries their old role-less token until it expires — they'll see 403s
until they sign out and back in. Our 403 response text already tells the
caller exactly that (`mcp-auth.js:116`).

---

## Part B — Enable Easy Auth on the Function App (after Aaron returns the ID)

App Service Authentication validates the bearer token at the platform edge and
returns 401 for anonymous/invalid callers — no token-parsing code needed for authn.

**Scripted:** run [`scripts/Enable-McpAuth.ps1`](../scripts/Enable-McpAuth.ps1)
with the client ID from Part A (this ran at the 2026-08-04 cutover):

```powershell
.\scripts\Enable-McpAuth.ps1 -ApiAppId 54b1261c-352d-4772-b83a-001e529bd117
```

It upgrades the auth config format to v2 if needed, configures the Microsoft
identity provider (issuer `https://login.microsoftonline.com/<tenant>/v2.0`,
audiences `api://trelleborg.onmicrosoft.com/sp-tis-d-d365fokb-mcp` + the
client ID — the second audience merged via an ARM `authsettingsV2` PUT because
`--allowed-audiences` takes only one value), enables Easy Auth with
**`Return401`**, excludes **`/api/ping`** so deploy probes keep working
(`/api/health` stays gated — it's the admin dashboard backend), removes the
temporary `REQUIRE_AUTH=false` app setting (use `-KeepRequireAuthOff` for a
staged cutover), and smoke-tests 401-for-anonymous / 200-for-ping.

> `Return401` (not `RedirectToLoginPage`) is essential — MCP clients send a bearer
> token and expect a 401 challenge, not an HTML login redirect.
>
> Note the per-endpoint GET pings (`GET /api/d365kb` etc.) sit behind Easy Auth
> after cutover — only `/api/health` is excluded. If `local-deploy/Deploy.ps1`
> probes the per-endpoint pings, switch it to `/api/health` or add a token.

ARM writes on this Function App were verified to work non-interactively
(2026-07-06); if Conditional Access ever demands step-up MFA, re-run the
script in an interactive `az` session.

## Part C — Group/role check in code (defense in depth) — **IMPLEMENTED**

Implemented in [`src/azure/mcp-auth.js`](../src/azure/mcp-auth.js), tested by
[`test/mcp-auth.test.js`](../test/mcp-auth.test.js) (a static scan there also
asserts every MCP HTTP surface calls the gate).

Easy Auth validates the token at the platform edge (signature / issuer /
audience / expiry) and injects the verified principal as the base64 JSON
header `x-ms-client-principal`. The code half is `authorizeMcpRequest(request)`:

- Requires the **`Mcp.Access`** app role (override via `MCP_REQUIRED_ROLE`) in
  the principal's role claims — accepts both the short `roles` claim type and
  the WS-Fed long form (`…/identity/claims/role`). Exact, case-sensitive match;
  App Roles have no hierarchy.
- Requires a principal id (`x-ms-client-principal-id`, the token's `oid`) —
  needed for audit attribution; no id → 401.
- **Fail-closed** (issues #27 + #28, same `REQUIRE_AUTH` lever as the upload
  endpoints): when Easy Auth is NOT enabled, principal headers are spoofable,
  so requests get **503** unless `REQUIRE_AUTH=false` (local-dev opt-out).
  This is deliberately stricter than the earlier no-op-when-off sketch —
  see the deploy-sequencing warning below.
- 403 responses hint that a recent role assignment needs a fresh token
  (role claims are baked in at issue time — sign out/in after a group change).

Wired at the top of every MCP HTTP handler: `d365kb.js`, `d365xref.js`,
`d365sec.js`, `d365taskrecorder.js` (both the MCP route and the
`/upload` route), and `wiki-mcp.js` (per-wiki MCP path). The cheap non-SSE
GET health pings and the wiki catalog stay open in code (static metadata,
used by deploy probes); Easy Auth covers them at the platform edge once on.

> **Deploy sequencing:** because the gate fails closed, deploying this code
> while the Function App has neither Easy Auth enabled nor
> `REQUIRE_AUTH=false` in app settings turns every MCP call into a 503.
> Either complete Part B first, or set `REQUIRE_AUTH=false` as a temporary
> app setting and remove it at cutover.

## The MCP OAuth proxy — why clients no longer talk to Entra directly

**The failure this fixes (first seen 2026-08-05, error `AADSTS9010010`):**
the MCP authorization spec (2025-06-18) requires clients to send an RFC 8707
`resource` parameter on `/authorize` and `/token` — the MCP server URL,
copied verbatim from the protected-resource metadata. Entra's v2.0 endpoints
(since the ~2026-03 enforcement change) reject any `resource` that isn't an
Application ID URI of the app owning the requested scope. Ours is
`api://trelleborg.onmicrosoft.com/sp-tis-d-d365fokb-mcp`, the client sends
`https://tis-d-mcpd365fo-func.azurewebsites.net/api/d365kb` → mismatch →
sign-in dead-ends. This hits **every spec-compliant MCP client** (Claude
Code, claude.ai connectors); Microsoft's own remote MCP servers have the same
open issues (azure-devops-mcp #1293, Dataverse-MCP #15). The two known fixes
are (a) an Application ID URI that exactly equals the server URL — impossible
here, tenant policy requires a verified domain and `azurewebsites.net` isn't
one — or (b) an OAuth proxy that strips the parameter. We do (b), like
`sp-tis-p-orion-mcp` does.

**Shape:** the Function App presents *itself* as the OAuth authorization
server. Five anonymous endpoints (`src/functions/oauth-proxy.js`, pure logic
in `src/azure/oauth-proxy-core.js`, tests in `test/oauth-proxy.test.js`):

| Endpoint | Role |
|---|---|
| `GET /.well-known/oauth-protected-resource[/{path}]` | RFC 9728 PRM. `resource` echoes the requested URL; `authorization_servers` points at **this app** (that's the redirect that makes the proxy work) |
| `GET /.well-known/oauth-authorization-server[/{path}]` | RFC 8414 AS metadata: authorize/token/register point at the proxy routes; advertises PKCE `S256` (absent from Entra's own metadata) |
| `GET /.well-known/openid-configuration` | OIDC-style alias of the same document |
| `GET /api/oauth/authorize` | 302 to Entra `/oauth2/v2.0/authorize` with all params passed through verbatim **minus `resource`**; injects the client ID if omitted |
| `POST /api/oauth/token` | Forwards the form body to Entra `/oauth2/v2.0/token` **minus `resource`**; streams Entra's response back. `POST /api/oauth/register` is a mock RFC 7591 DCR that hands every client the single registered public-client ID |

**What does NOT change:** tokens still come from Entra, audience-bound to the
`api://…` URI; Easy Auth still validates signature/issuer/audience at the
platform edge; `mcp-auth.js` still enforces `Mcp.Access`; PKCE runs end to
end (the proxy never sees a usable secret — there are none). The proxy is
discovery + parameter mediation only; it stores nothing. This is **not** OBO
— no audience swap, no second registration (see the deck-comparison section).

**Config:** defaults in `oauth-proxy-core.js` match the live registration;
override via app settings `MCP_OAUTH_TENANT_ID`, `MCP_OAUTH_CLIENT_ID`,
`MCP_OAUTH_SCOPE` — no code change for the prod analog.

**Plumbing this required:** `host.json` `routePrefix` is now `''` and every
function route self-prefixes `api/` (public URLs unchanged — enforced by a
static-scan test in `test/oauth-proxy.test.js`), because the well-known
documents must live at the URL root. The proxy paths are Easy Auth
**excluded paths**, and `WEBSITE_AUTH_PRM_DEFAULT_WITH_SCOPES` must be
**removed** (while set, Easy Auth serves its own PRM pointing clients
straight at Entra — the broken path). `Enable-McpAuth.ps1` does both and
smoke-tests the proxy; re-run it after deploying the proxy code.

**Superseded:** the 2026-08-04 `WEBSITE_AUTH_PRM_DEFAULT_WITH_SCOPES` setup
(previous revisions of this doc called it the "rough edge" resolution). It
produced a *discoverable* but *uncompletable* flow — clients found Entra,
then died at AADSTS9010010. One side effect of removing it: the 401 challenge
no longer carries `resource_metadata=`; MCP clients fall back to probing the
spec-mandated `/.well-known` locations, which the proxy serves.

## Part D — Point the clients at OAuth

- **Claude Code** (verified to reach the auth prompt 2026-08-04): Entra has no
  dynamic client registration, so the client ID must be pinned — without it
  `claude mcp list` reports *"Incompatible auth server: does not support
  dynamic client registration"*:
  ```
  claude mcp add --transport http --client-id 54b1261c-352d-4772-b83a-001e529bd117 \
      d365kb-azure https://tis-d-mcpd365fo-func.azurewebsites.net/api/d365kb
  ```
  (same pattern for `/api/d365xref`, `/api/d365sec`, `/api/d365taskrecorder`).
  Then `/mcp` → select the server → **Authenticate** (browser flow; the
  registration's `http://localhost` loopback redirect covers any port).
  Non-interactive fallback: `--header "Authorization: Bearer <token>"`.
- **claude.ai connector** (org-gated — the Owner adds it): Add custom
  connector → URL `https://tis-d-mcpd365fo-func.azurewebsites.net/api/<service>` →
  **Advanced settings** → OAuth Client ID `54b1261c-352d-4772-b83a-001e529bd117`,
  no client secret (public client + PKCE; the
  `https://claude.ai/api/mcp/auth_callback` redirect is pre-registered).
  If a scope field is offered:
  `api://trelleborg.onmicrosoft.com/sp-tis-d-d365fokb-mcp/user_impersonation`.
- **Copilot Studio:** the swaggers in `skills/copilot-studio/connectors/*.json`
  (and the packaged solution copy) now carry the Entra `oauth2-auth`
  security definition (accessCode flow, tenant v2.0 endpoints, the
  `user_impersonation` scope). Power Platform's OAuth is a **confidential
  client**, so two one-time additions to the app registration are needed
  (owner-doable):
  1. a **client secret** (`az ad app credential reset --id 54b1261c-… --append`),
  2. a **Web** redirect URI `https://global.consent.azure-apim.net/redirect`.
  Then custom connector → Security → OAuth 2.0 → Microsoft Entra ID: tenant
  `0f861177-7722-4f06-8db9-3384e5321a9f`, client ID `54b1261c-…`, the secret,
  resource `api://trelleborg.onmicrosoft.com/sp-tis-d-d365fokb-mcp`.

## Part E — Test plan
1. **Anonymous is rejected:** `curl -s -o /dev/null -w "%{http_code}" -X POST https://…/api/d365kb -d '{}'` → **401**. ✅ *Verified 2026-08-05 on all six surfaces (kb, xref, sec, taskrecorder, taskrecorder/upload, wiki-mcp).*
2. **Valid member token works:** acquire a user token for the scope via a real
   MCP client's OAuth flow → `curl -H "Authorization: Bearer <token>" …/api/d365kb`
   with a `tools/list` body → **200** + tool list. ✅ *Verified 2026-08-05
   end-to-end from Claude Code via the OAuth proxy (live tool call returned
   data).* ⚠️ `az account get-access-token` does NOT work for this — it
   authenticates as the *Azure CLI* client (`04b07795-…`), which is not
   consented to this API → `AADSTS65001` (reproduced 2026-08-05). Test with
   Claude Code / claude.ai instead.
3. **Non-member is forbidden:** a signed-in user *not* in the group → **403** (the Part C role check) or no token issued at all (assignment required). ☐ untested — needs a non-member volunteer.
4. **Health still probes:** confirm `Deploy.ps1` health phase passes (token or excluded path). ✅ *Verified 2026-08-05 (two deploys, 0 failures).*
5. **Each client connects:** Claude Code ✅ *(2026-08-05, via the OAuth proxy)*; claude.ai ☐ (org Owner adds the connector — client ID now optional thanks to mock DCR); Copilot Studio ☐ (needs the client secret + apim redirect, Part D).

## Known rough edges — history
The immature part (KJ's "many hoops", Aaron's "MS will make MCP security easier")
was the **MCP OAuth handshake** against Entra. Two rounds:

1. **Discovery (resolved 2026-08-04, superseded 2026-08-05):** the
   `WEBSITE_AUTH_PRM_DEFAULT_WITH_SCOPES` preview setting made Easy Auth
   serve the RFC 9728 document and enrich the 401 challenge. It worked — but
   pointed clients directly at Entra, which then rejected their
   spec-mandated `resource` parameter.
2. **RFC 8707 vs Entra (resolved 2026-08-05):** `AADSTS9010010` on every
   spec-compliant client. Fixed by the in-app **OAuth proxy** (see "The MCP
   OAuth proxy" section), which also mock-implements RFC 7591 DCR — so
   clients no longer strictly need a pinned client ID (`/api/oauth/register`
   hands out the registered one). Pinning `--client-id` still works and
   remains the documented default for Claude Code.

> **AADSTS90009 — "Application X is requesting a token for itself" (Claude Code CLI, 2026-08-25).** One registration is both OAuth client and API resource, and Entra then only accepts the *GUID* scope form (`<clientId>/user_impersonation`) on the token endpoint. Claude Code echoes the PRM `scopes_supported` (URI form `api://…/user_impersonation`) into the token request → `invalid_request`; claude.ai omits `scope` at redemption, so connectors worked. Fixed in the proxy: `normalizeScope()` (`src/azure/oauth-proxy-core.js`) rewrites URI-form API scopes to the GUID form on both `/api/oauth/authorize` and `/api/oauth/token`. Symptom in Claude Code: `claude mcp get <server>` shows the AADSTS text; App Insights shows `oauth-token` 400s right after `oauth-asm` 200s.
