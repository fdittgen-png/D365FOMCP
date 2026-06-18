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
- Endpoints to protect: `/api/d365kb`, `/api/d365xref`, `/api/d365sec`, `/api/d365taskrecorder`
- Leave **anonymous** (no auth): `/api/health` (deploy probes), admin pages as-is

We gate access with an **app role** assigned to a **security group** (app roles
avoid the `groups`-claim overage problem KJ would hit at scale).

---

## Part A — The ask for Aaron (forward this verbatim)

> Hi Aaron — to put Entra OAuth in front of the D365FO MCP Function App
> (`tis-d-mcpd365fo-func`, tenant `0f861177-7722-4f06-8db9-3384e5321a9f`), could you
> set up the following? Same shape as Karl-Johan's app, minus the OBO API hop
> (this server is the resource itself).
>
> **1. App registration "D365FO MCP API" (the protected resource)**
> - Expose an API → Application ID URI: `api://<new-app-id>` (default is fine).
> - Add a delegated scope: **`access_as_user`** (admin + user consent, "Access D365FO MCP as the signed-in user").
> - App roles → add **`Mcp.Access`** (member types: *Users/Groups*), value `Mcp.Access`.
> - Enterprise app → **Assignment required = Yes**.
> - Assign the security group below to the `Mcp.Access` role.
> - Token configuration: not needed if we rely on the `roles` claim (preferred). (If you'd rather use group claims, add `groupMembershipClaims: SecurityGroup` instead.)
>
> **2. Security group "D365FO-MCP-Users"** (or reuse an existing access group) — assign the people who may use the MCP services, and assign the group to the `Mcp.Access` app role above.
>
> **3. App registration "D365FO MCP – Claude client" (the OAuth client)**
> - Type: public/native client (Claude Code uses a loopback redirect; enable **Allow public client flows = Yes**).
> - **Redirect URIs** — please add the ones I confirm from each client's connector UI; expected:
>   - claude.ai custom connector callback: `https://claude.ai/api/mcp/auth_callback` *(I will confirm the exact URI from the connector "Advanced settings" screen)*
>   - Claude Code (loopback): `http://localhost` *(plus the specific port/path it prints; enable loopback)*
> - API permissions: delegated **`api://<MCP-API-app-id>/access_as_user`**, grant **admin consent**.
> - If claude.ai needs a confidential client (client secret), generate one and send it to me securely; otherwise public-client is fine.
>
> **What I need back:** the **API app (client) ID**, the **Application ID URI**, the **tenant ID** (have it), the **`Mcp.Access` value**, the **client app ID** (+ secret if confidential), and confirmation the group is assigned. Then I enable Easy Auth on the Function App and the group check in code.

*(If we ever add a tool that calls **live D365** on the user's behalf, that's when we'd add KJ's second SP + OBO exchange — not now.)*

---

## Part B — Enable Easy Auth on the Function App (after Aaron returns the IDs)

App Service Authentication validates the bearer token at the platform edge and
returns 401 for anonymous/invalid callers — no token-parsing code needed for authn.

```bash
RG=tis-d-mcpd365fo-rg ; APP=tis-d-mcpd365fo-func
API_APP_ID=<MCP-API-app-id-from-Aaron>
TENANT=0f861177-7722-4f06-8db9-3384e5321a9f

# Microsoft provider + require auth; allow the API's own audience
az webapp auth microsoft update -g $RG -n $APP \
  --client-id "$API_APP_ID" \
  --issuer "https://login.microsoftonline.com/$TENANT/v2.0" \
  --allowed-audiences "api://$API_APP_ID" "$API_APP_ID"

az webapp auth update -g $RG -n $APP \
  --enabled true \
  --action Return401 \
  --unauthenticated-client-action Return401
```

> `Return401` (not `RedirectToLoginPage`) is essential — MCP clients send a bearer
> token and expect a 401 challenge, not an HTML login redirect.
>
> Keep `/api/health` reachable: either leave it on its own (Easy Auth applies app-wide,
> so the deploy health probe must then send a token) **or** exclude it via an auth
> route rule. Simplest: have `Deploy.ps1` probe health with a token, or keep a separate
> unauthenticated health path. Decide before flipping `Return401`.

This requires an ARM write — run it in an **interactive** `az` session (the tenant's
Conditional-Access step-up blocks subprocess ARM writes).

## Part C — Group/role check in code (defense in depth)

Easy Auth injects the validated principal as a base64 JSON header
`x-ms-client-principal`. Add a tiny shared guard that rejects callers lacking the
`Mcp.Access` role, mirroring the existing fail-closed pattern in
`src/azure/d365sec-upload.js` (`decideUploadAuthorization` / `isAuthRequired`).

```js
// src/azure/mcp-auth.js  (new) — fail-closed app-role check
const REQUIRED_ROLE = 'Mcp.Access';

export function isAuthEnforced() {
  // Mirror WEBSITE_AUTH_ENABLED awareness already used elsewhere.
  return /^true$/i.test(process.env.WEBSITE_AUTH_ENABLED || '');
}

/** Returns null if authorized, or an HTTP response object if not. */
export function authorizeMcpRequest(request) {
  if (!isAuthEnforced()) return null;              // local/dev: no Easy Auth
  const header = request.headers.get('x-ms-client-principal');
  if (!header) return { status: 401, body: 'Unauthenticated.' };
  let principal;
  try { principal = JSON.parse(Buffer.from(header, 'base64').toString('utf8')); }
  catch { return { status: 401, body: 'Invalid principal.' }; }
  const claims = principal.claims || [];
  const roles = claims.filter(c => c.typ === 'roles' || c.typ?.endsWith('/role')).map(c => c.val);
  if (!roles.includes(REQUIRED_ROLE)) return { status: 403, body: 'Not authorized for MCP.' };
  return null;                                     // OK
}
```

Wire it at the top of each MCP HTTP handler (`d365kb.js`, `d365xref.js`,
`d365sec.js`, `d365taskrecorder.js`):

```js
import { authorizeMcpRequest } from '../azure/mcp-auth.js';
// inside the handler, before doing any work:
const denied = authorizeMcpRequest(request);
if (denied) return denied;
```

Gated by `WEBSITE_AUTH_ENABLED`, so it's a **no-op locally** and only enforces once
Easy Auth is on — safe to commit ahead of the cutover.

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
