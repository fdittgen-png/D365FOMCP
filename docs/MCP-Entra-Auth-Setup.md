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
- Leave **anonymous** (no auth): `/api/health` (deploy probes), admin pages as-is

We gate access with an **app role** assigned to a **security group** (app roles
avoid the `groups`-claim overage problem KJ would hit at scale).

---

## Status (2026-07-06)

- **Code gate (Part C): implemented and merged** — see below.
- **`REQUIRE_AUTH=false` is set on `tis-d-mcpd365fo-func`** so deploying the
  fail-closed code does NOT break the (still anonymous) live endpoints.
  Remove it at cutover — `scripts/Enable-McpAuth.ps1` does this.
- **Easy Auth: still off** (verified via `az webapp auth show` — unconfigured).
- **Directory work needs an admin**: creating app registrations and security
  groups returns `Insufficient privileges` for our accounts (tenant restricts
  both) → Part A goes to Aaron. ARM writes on the Function App work fine
  non-interactively from the TIS.D365FO subscription.
- **In-house precedent found**: `sp-tis-p-orion-mcp`, `sp-tis-p-busarch-mcp`,
  `sp-tis-t-pulsar-mcp` all use a **single combined registration** — the MCP
  is both resource (App ID URI + scope, token v2) and public client
  (claude.ai callback redirect). We follow that shape: ONE app registration,
  not two.

## Part A — The ask for Aaron (forward this verbatim)

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
security — the security is step 2.

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
| Health-probe exception | — | `--excluded-paths '[/api/health]'` hard-coded in `Enable-McpAuth.ps1:50`; route defined in `src/functions/d365health.js` | Script edit |
| Scope `user_impersonation`, redirect URIs, group name/membership | Expose an API / Authentication / group | No server-side counterpart; scope reappears in client config (Part D) + Copilot swagger | Entra only |

### What Aaron sends back

Just the registration's **Application (client) ID** — one GUID. Everything
else is fixed by convention (`api://sp-tis-d-mcpd365fo-mcp`, tenant ID,
role value). That GUID is the only parameter of the cutover:

```powershell
.\scripts\Enable-McpAuth.ps1 -ApiAppId <that-guid>
```

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
with the client ID from Part A:

```powershell
.\scripts\Enable-McpAuth.ps1 -ApiAppId <client-id-from-Aaron>
```

It configures the Microsoft identity provider (issuer
`https://login.microsoftonline.com/<tenant>/v2.0`, audiences
`api://sp-tis-d-mcpd365fo-mcp` + the client ID), enables Easy Auth with
**`Return401`**, excludes **`/api/health`** so deploy probes keep working,
removes the temporary `REQUIRE_AUTH=false` app setting (use
`-KeepRequireAuthOff` for a staged cutover), and smoke-tests
401-for-anonymous / 200-for-health.

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

## Part D — Point the clients at OAuth

- **Claude Code:** `claude mcp add --transport http d365sec https://…/api/d365sec` — it
  performs the OAuth flow on first use (loopback redirect). For non-interactive use,
  pass a token: `--header "Authorization: Bearer <token>"`.
- **claude.ai connector:** Add custom connector → **Advanced settings** → enter the
  **OAuth Client ID** (+ secret if confidential) and the scope
  `api://<MCP-API-app-id>/access_as_user`. (Org-gated — the Owner adds it; see the
  custom-connector note.)
- **Copilot Studio:** the custom connector → Security → **OAuth 2.0 (Microsoft Entra ID)**;
  enter tenant, client ID/secret, and resource `api://<MCP-API-app-id>`.
- **Update the swaggers** in `skills/copilot-studio/connectors/*.json`: replace
  `"securityDefinitions": {}, "security": []` with the Entra OAuth security definition.

## Part E — Test plan
1. **Anonymous is rejected:** `curl -s -o /dev/null -w "%{http_code}" -X POST https://…/api/d365kb -d '{}'` → **401**.
2. **Valid member token works:** acquire a user token for the scope (interactive `az account get-access-token --resource api://<id>` for a member, or the client's flow) → `curl -H "Authorization: Bearer <token>" …/api/d365kb` with a `tools/list` body → **200** + tool list.
3. **Non-member is forbidden:** a signed-in user *not* in the group → **403** (the Part C role check) or no token issued at all (assignment required).
4. **Health still probes:** confirm `Deploy.ps1` health phase passes (token or excluded path).
5. **Each client connects:** Claude Code, claude.ai, Copilot Studio each complete the OAuth flow and list tools.

## Known rough edge
The immature part (KJ's "many hoops", Aaron's "MS will make MCP security easier")
is the **MCP OAuth *discovery* handshake** — the `.well-known/oauth-protected-resource`
metadata that lets claude.ai auto-negotiate. Easy Auth protects the endpoint but
doesn't advertise that metadata yet, so claude.ai may need explicit OAuth client
config (above) rather than auto-discovery. Don't build custom discovery/OBO plumbing
now — do this standards-aligned minimum and adopt Microsoft's MCP-auth support when
it ships.
