/**
 * Admin authorization helpers — shared by /api/health and the admin HTML pages.
 *
 * Easy Auth gate for admin/back-office surfaces. Pure functions are exported
 * for unit-testing the decision logic without HTTP plumbing. Mirrors the
 * fail-closed posture from `decideUploadAuthorization` (issue #27): when Easy
 * Auth is configured we REQUIRE a signed-in principal, never warn-and-proceed.
 */

/** True when the Function App has Easy Auth (App Service Authentication) enabled. */
export function isEasyAuthEnabled() {
  return process.env.WEBSITE_AUTH_ENABLED === 'True';
}

/** Read the principal from Easy Auth headers. Returns null when absent. */
export function getAuthUser(request) {
  const principalId = request.headers.get('x-ms-client-principal-id');
  const principalName = request.headers.get('x-ms-client-principal-name');
  if (!principalId) return null;
  return { principalId, principalName };
}

/**
 * Decide whether a back-office (read-only) admin request may proceed.
 * Pure function — `easyAuth` and `user` are injected for testability.
 *
 * Returns `null` when the request may continue, or a response object to emit
 * immediately. The shape (`jsonBody` vs `body`) depends on `wantsHtml`.
 *
 * Behaviour:
 *   - Signed in → allow.
 *   - Easy Auth enabled, no signed-in user → 401 with a sign-in landing page
 *     (HTML callers) or a structured error (JSON callers).
 *   - Easy Auth disabled (local dev) → allow — admin pages are low-risk
 *     read-only surfaces. The upload endpoint keeps its stricter gate.
 */
export function decideAdminAccess({ user, easyAuth, wantsHtml = false, redirectTarget = '/' }) {
  if (user) return null;
  if (!easyAuth) return null;

  if (wantsHtml) {
    return {
      status: 401,
      headers: { 'Content-Type': 'text/html; charset=utf-8' },
      body: buildSignInHtml(redirectTarget),
    };
  }
  return {
    status: 401,
    jsonBody: {
      error: 'Authentication required.',
      hint: 'Sign in via Azure AD before calling this endpoint.',
      signInUrl: `/.auth/login/aad?post_login_redirect_uri=${encodeURIComponent(redirectTarget)}`,
    },
  };
}

/** Build a minimal sign-in landing page that links to the Easy Auth flow. */
export function buildSignInHtml(redirectTarget) {
  const safeTarget = encodeURIComponent(redirectTarget || '/');
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Sign in required</title>
<style>
  :root { --accent:#1f3a5f; --bg:#fff; --muted:#5b6b7c; --border:#dbe1e8; --shell:#f4f6f9; }
  * { box-sizing:border-box; margin:0; padding:0; }
  body { font-family: 'Inter', system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif;
         background: var(--shell); color:#1c2733; min-height:100vh;
         display:flex; align-items:center; justify-content:center; padding:24px; }
  .card { background: var(--bg); border:1px solid var(--border); border-radius:8px;
          padding:32px 36px; max-width:440px; width:100%; box-shadow:0 1px 3px rgba(0,0,0,0.04); }
  h1 { font-size:18px; font-weight:600; margin-bottom:8px; color: var(--accent); }
  p  { font-size:14px; color: var(--muted); margin-bottom:20px; line-height:1.55; }
  .btn { display:inline-block; background: var(--accent); color:#fff; padding:10px 22px;
         border-radius:4px; text-decoration:none; font-size:14px; font-weight:600; }
  .btn:hover { background:#16294a; }
</style>
</head>
<body>
<div class="card">
  <h1>Sign in required</h1>
  <p>This page is restricted to authenticated administrators. Sign in with your organisation account to continue.</p>
  <a class="btn" href="/.auth/login/aad?post_login_redirect_uri=${safeTarget}">Sign in</a>
</div>
</body>
</html>`;
}
