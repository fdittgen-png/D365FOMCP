/**
 * verify-isv-live.cjs — prove the sealed-ISV data is live on AZURE.
 *
 * Why this exists: the local stdio MCP servers read the databases in
 * ~/.claude/, so asking them anything reports the LOCAL state and will happily
 * show ISV data whether or not the deploy uploaded anything. The only honest
 * check is an authenticated HTTP call against the deployed endpoint — the same
 * trap that made an earlier TOON deploy look successful when it wasn't.
 *
 * Usage:
 *   az account get-access-token --resource api://trelleborg.onmicrosoft.com/sp-tis-d-d365fokb-mcp --query accessToken -o tsv > token.txt
 *   node local-deploy/verify-isv-live.cjs <token>
 *
 * Exit code 0 = ISV data live on Azure, 1 = not live or unreachable.
 */

const BASE = process.env.MCP_BASE_URL || 'https://tis-d-mcpd365fo-func.azurewebsites.net';
const token = process.argv[2] || process.env.MCP_TOKEN;

if (!token) {
  console.error('Usage: node local-deploy/verify-isv-live.cjs <bearer-token>');
  console.error('Get one with:');
  console.error('  az account get-access-token --resource api://trelleborg.onmicrosoft.com/sp-tis-d-d365fokb-mcp --query accessToken -o tsv');
  process.exit(1);
}

/** One MCP JSON-RPC call over Streamable HTTP. */
async function rpc(endpoint, method, params, sessionId) {
  const headers = {
    'Content-Type': 'application/json',
    // Streamable HTTP requires the client to accept both.
    Accept: 'application/json, text/event-stream',
    Authorization: `Bearer ${token}`,
  };
  if (sessionId) headers['Mcp-Session-Id'] = sessionId;

  const res = await fetch(`${BASE}${endpoint}`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ jsonrpc: '2.0', id: Date.now(), method, params }),
  });

  const text = await res.text();
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} on ${endpoint} ${method}: ${text.slice(0, 300)}`);
  }
  // The server may answer as SSE; take the last data: line either way.
  let payload = text.trim();
  if (payload.startsWith('event:') || payload.includes('\ndata:')) {
    const lines = payload.split('\n').filter(l => l.startsWith('data:'));
    payload = lines.length ? lines[lines.length - 1].slice(5).trim() : payload;
  }
  return {
    body: JSON.parse(payload),
    sessionId: res.headers.get('mcp-session-id') || sessionId,
  };
}

async function checkService(endpoint, toolName, args) {
  const init = await rpc(endpoint, 'initialize', {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'verify-isv-live', version: '1.0.0' },
  });
  const sid = init.sessionId;

  const listed = await rpc(endpoint, 'tools/list', {}, sid);
  const tools = (listed.body.result?.tools || []).map(t => t.name);

  const called = await rpc(endpoint, 'tools/call',
    { name: toolName, arguments: args }, sid);

  return { tools, result: called.body.result };
}

(async () => {
  let ok = true;

  // ── KB: is the ISV registry populated on Azure? ──────────────────────────
  try {
    const { tools, result } = await checkService('/api/d365kb', 'd365_isv_list_models', {});
    const isvTools = tools.filter(t => t.startsWith('d365_isv_'));
    console.log(`KB   tools registered : ${tools.length} (${isvTools.length} ISV: ${isvTools.join(', ') || 'NONE'})`);

    const sc = result?.structuredContent;
    if (!isvTools.length) {
      console.log('KB   ISV tools        : ABSENT — the code deploy did not land');
      ok = false;
    } else if (!sc?.isv_data_available) {
      console.log('KB   ISV data         : DORMANT — tools live, no isv_* tables in the Azure KB');
      console.log(`                        (${sc?.provenance?.caveat || 'no detail'})`);
      ok = false;
    } else {
      console.log(`KB   ISV data         : LIVE — ${sc.model_count} sealed models, scanned ${sc.provenance?.scanned_at}`);
      const totals = (sc.models || []).reduce((a, m) => ({
        elements: a.elements + (m.counts?.elements || 0),
        labels: a.labels + (m.counts?.labels || 0),
      }), { elements: 0, labels: 0 });
      console.log(`                        ${totals.elements.toLocaleString()} elements, ${totals.labels.toLocaleString()} labels`);
    }
  } catch (err) {
    console.log(`KB   ERROR            : ${err.message}`);
    ok = false;
  }

  // ── XRef: does the 199k-reference gap actually answer now? ───────────────
  try {
    const { tools, result } = await checkService('/api/d365xref', 'xref_isv_find_usages',
      { object_name: 'CustTable', object_type: 'Tables', limit: 1 });
    const isvTools = tools.filter(t => t.startsWith('xref_isv_'));
    console.log(`XRef tools registered : ${tools.length} (${isvTools.length} ISV: ${isvTools.join(', ') || 'NONE'})`);

    const sc = result?.structuredContent;
    if (!isvTools.length) {
      console.log('XRef ISV tools        : ABSENT — the code deploy did not land');
      ok = false;
    } else if (!sc?.isv_data_available) {
      console.log('XRef ISV data         : DORMANT — tools live, no isv_* tables in the Azure XRef DB');
      ok = false;
    } else {
      console.log(`XRef ISV data         : LIVE — ${sc.usage_count} references to CustTable from ${sc.module_summary?.length || 0} sealed models`);
      for (const m of (sc.module_summary || []).slice(0, 5)) {
        console.log(`                          ${m.module}: ${m.reference_count}`);
      }
    }
  } catch (err) {
    console.log(`XRef ERROR            : ${err.message}`);
    ok = false;
  }

  console.log('');
  console.log(ok ? 'RESULT: sealed-ISV data is LIVE on Azure.'
    : 'RESULT: sealed-ISV data is NOT live on Azure (see above).');
  process.exit(ok ? 0 : 1);
})();
