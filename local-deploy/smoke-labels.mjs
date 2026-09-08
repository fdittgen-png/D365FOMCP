// Smoke test: real stdio labels server through the MCP SDK client.
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const transport = new StdioClientTransport({
  command: 'node',
  args: ['C:/working/MCP/src/local/mcp-server-labels.js'],
  env: { ...process.env, MCP_STRUCTURED_CONTENT: 'off', MCP_TRACE: 'off' },
});
const client = new Client({ name: 'smoke', version: '0.0.0' }, { capabilities: {} });
await client.connect(transport);
const tools = await client.listTools();
console.log('tools:', tools.tools.map(t => t.name).join(', '), '| tools/list bytes:', JSON.stringify(tools.tools).length);

const show = (label, r) => {
  const text = r.content?.[0]?.text ?? '';
  console.log(`\n=== ${label} (${text.length} chars, isError=${r.isError ?? false})\n${text.slice(0, 1400)}`);
};
const t = async (name, args) => { const t0 = Date.now(); const r = await client.callTool({ name, arguments: args }); console.log(`\n[${name} ${Date.now() - t0} ms]`); return r; };

show('lookup @SYS154828 (en-US, de, fr)', await t('labels_lookup', { label_ids: ['@SYS154828', 'AccountsPayable:VendVendorMasterIntegrationMaintain'], languages: ['en-US', 'de', 'fr'] }));
show('lookup @SYS154828 all languages (count only)', (() => { return { content: [{ type: 'text', text: '' }] }; })());
const all = await t('labels_lookup', { label_ids: ['@SYS154828'] });
console.log('all-languages rows:', (all.content[0].text.match(/^\| @SYS154828 \|/gm) ?? []).length, 'table rows;', all.content[0].text.length, 'chars');
show('search "Kreditor sperren" de', await t('labels_search', { text: 'Kreditor sperren', language: 'de', limit: 5 }));
show('where_used @SYS154828', await t('labels_where_used', { label_id: '@SYS154828', limit: 10 }));
show('for_object table CustTable (en-US, de)', await t('labels_for_object', { object_type: 'table', object_name: 'CustTable', languages: ['en-US', 'de'], limit: 12 }));
show('for_object duty VendVendorMasterIntegrationMaintain', await t('labels_for_object', { object_type: 'duty', object_name: 'VendVendorMasterIntegrationMaintain' }));
show('not found', await t('labels_lookup', { label_ids: ['@SYS99999999'] }));
await client.close();
