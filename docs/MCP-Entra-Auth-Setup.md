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
