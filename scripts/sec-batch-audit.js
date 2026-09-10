#!/usr/bin/env node
/**
 * sec-batch-audit.js — Batch security audit using Claude API + MCP tools.
 *
 * Spawns the local security MCP server, pre-fetches the role catalog once,
 * then loops over users calling Claude API with tool-use for per-user
 * security analysis. Finishes with a cross-user summary.
 *
 * Inspired by ameyer505/D365FSC-Security-MCP's programmatic client pattern.
 * Key optimizations (4x token reduction vs interactive):
 *   1. ListTools once, reuse across all API calls
 *   2. Pre-fetch role catalog + stats as context (not a per-user tool call)
 *   3. Filter registered tools to only those needed per-user
 *   4. Tool-free summary call at the end for cross-user reasoning
 *
 * Usage:
 *   SEC_DB_PATH=... node scripts/sec-batch-audit.js [user1 user2 ...]
 *
 * Credentials: the SDK resolves ANTHROPIC_API_KEY, ANTHROPIC_AUTH_TOKEN or an
 * `ant auth login` profile on its own — nothing is passed explicitly.
 * Model: AUDIT_MODEL (default claude-opus-5). Effort: AUDIT_EFFORT (default: API default, `high`).
 *
 * If no users are specified, audits all enabled users.
 *
 * Output: audit-report-YYYY-MM-DD.json in CWD.
 */

import { createRequire } from 'module';
import { writeFileSync } from 'fs';

const require = createRequire(import.meta.url);

// ── Configuration ────────────────────────────────────────────────────────────

// claude-sonnet-4-5-20241022 (the previous default) never existed — Sonnet 4.5's
// snapshot is 20250929 — so every run without AUDIT_MODEL failed with a 404.
const MODEL = process.env.AUDIT_MODEL || 'claude-opus-5';
// Thinking is on by default on Claude Opus 5 and max_tokens caps thinking + answer
// together, so the old 1024/2048 caps would truncate mid-answer.
const MAX_TOKENS = 16000;
const EFFORT = process.env.AUDIT_EFFORT || undefined; // low | medium | high | xhigh | max
const SEC_DB = process.env.SEC_DB_PATH;
const MAX_TOOL_ROUNDS = 5;

if (!SEC_DB) { console.error('Error: SEC_DB_PATH not set.'); process.exit(1); }
if (!process.env.ANTHROPIC_API_KEY && !process.env.ANTHROPIC_AUTH_TOKEN) {
  console.error('Note: no ANTHROPIC_API_KEY / ANTHROPIC_AUTH_TOKEN — the SDK will use an `ant auth login` profile if one exists.');
}

// ── Lazy imports (avoid crashing if deps missing) ────────────────────────────

let Anthropic;
try {
  ({ default: Anthropic } = await import('@anthropic-ai/sdk'));
} catch {
  console.error('Error: @anthropic-ai/sdk not installed. Run: npm install @anthropic-ai/sdk');
  process.exit(1);
}

// ── Direct DB access (skip MCP overhead for batch) ───────────────────────────

const Database = require('better-sqlite3');
const db = new Database(SEC_DB, { readonly: true });
db.pragma('journal_mode = OFF');
db.pragma('cache_size = -50000');
const q = (sql, params = []) => db.prepare(sql).all(...params);

// ── Pre-fetch context (done ONCE) ────────────────────────────────────────────

console.log('Pre-fetching role catalog and stats...');
const allRoles = q('SELECT role_name, license_type, permission_type, description FROM roles ORDER BY role_name');
const stats = q('SELECT key, value FROM sec_metadata');
const buildDate = stats.find(s => s.key === 'build_date')?.value || 'unknown';

const roleContext = `Security database snapshot: ${buildDate}\n` +
  `${allRoles.length} roles in the database.\n\n` +
  `Role catalog (name | licence | type | description):\n` +
  allRoles.slice(0, 200).map(r =>
    `- ${r.role_name} | ${r.license_type || 'N/A'} | ${r.permission_type} | ${(r.description || '').slice(0, 80)}`
  ).join('\n');

// ── Get target users ─────────────────────────────────────────────────────────

const cliUsers = process.argv.slice(2);
let targetUsers;
if (cliUsers.length) {
  targetUsers = cliUsers.map(uid => {
    const row = q('SELECT user_id, person_name FROM users WHERE user_id = ? COLLATE NOCASE', [uid]);
    return row[0] || { user_id: uid, person_name: null };
  });
} else {
  targetUsers = q('SELECT user_id, person_name FROM users WHERE enabled = 1 ORDER BY user_id LIMIT 50');
}

console.log(`Auditing ${targetUsers.length} user(s)...`);

// ── Anthropic client ─────────────────────────────────────────────────────────

const anthropic = new Anthropic();

/**
 * Shared request shape. `fallbacks: 'default'` re-runs a request that Opus 5's
 * safety classifiers decline (stop_reason 'refusal', HTTP 200) on Anthropic's
 * recommended fallback model, routed by refusal category — a security audit is
 * exactly the benign workload that occasionally trips the cyber classifier.
 * Requires the beta messages endpoint + the -2026-07-01 beta header.
 */
const requestBase = {
  model: MODEL,
  max_tokens: MAX_TOKENS,
  thinking: { type: 'adaptive' },
  ...(EFFORT ? { output_config: { effort: EFFORT } } : {}),
  betas: ['server-side-fallback-2026-07-01'],
  fallbacks: 'default',
};

/** All text blocks of a response joined — thinking blocks come first, so never index content[0]. */
const textOf = (response) => response.content.filter(c => c.type === 'text').map(c => c.text).join('\n');

/** Non-tool stop reasons end the analysis; the text says why when it was not a normal end. */
function finalText(response) {
  if (response.stop_reason === 'refusal') {
    const d = response.stop_details;
    return `(declined by safety classifier${d?.category ? `: ${d.category}` : ''}${d?.explanation ? ` — ${d.explanation}` : ''})`;
  }
  const text = textOf(response);
  if (response.stop_reason === 'max_tokens') return `${text}\n(truncated: max_tokens reached)`;
  return text;
}

// Define the tools Claude can call (subset for efficiency)
const tools = [
  {
    name: 'sec_lookup_user',
    description: 'Look up a user\'s assigned roles, companies, sub-roles, and deny overrides.',
    input_schema: {
      type: 'object',
      properties: { user_id: { type: 'string', description: 'User ID' } },
      required: ['user_id'],
    },
  },
  {
    name: 'sec_effective_permissions',
    description: 'Compute flattened effective permissions for a user: all entry points with CRUD grants.',
    input_schema: {
      type: 'object',
      properties: {
        user_id: { type: 'string', description: 'User ID' },
        object_name: { type: 'string', description: 'Optional object filter' },
      },
      required: ['user_id'],
    },
  },
];

// ── Tool execution (direct DB, not MCP) ──────────────────────────────────────

async function executeTool(name, args) {
  // Simplified tool execution against the DB directly
  if (name === 'sec_lookup_user') {
    const uid = args.user_id;
    const user = q('SELECT * FROM users WHERE user_id = ? COLLATE NOCASE', [uid]);
    if (!user.length) return `User "${uid}" not found.`;
    const roles = q(`
      SELECT r.role_name, r.permission_type, r.license_type
      FROM user_roles ur JOIN roles r ON r.role_id = ur.role_id
      WHERE ur.user_id = ? ORDER BY r.role_name
    `, [user[0].user_id]);
    return JSON.stringify({ user: user[0], roles, role_count: roles.length });
  }
  if (name === 'sec_effective_permissions') {
    const uid = args.user_id;
    const user = q('SELECT user_id FROM users WHERE user_id = ? COLLATE NOCASE', [uid]);
    if (!user.length) return `User "${uid}" not found.`;
    const roleIds = q('SELECT role_id FROM user_roles WHERE user_id = ?', [user[0].user_id]).map(r => r.role_id);
    if (!roleIds.length) return 'No roles assigned.';
    const ph = roleIds.map(() => '?').join(',');
    const perms = q(`
      SELECT DISTINCT ep.object_name, ep.object_type,
             ep.grant_read, ep.grant_create, ep.grant_update, ep.grant_delete
      FROM role_duties rd
      JOIN duty_privileges dp ON dp.duty_id = rd.duty_id COLLATE NOCASE
      JOIN privilege_entry_points ep ON ep.privilege_name = dp.privilege_name COLLATE NOCASE
      WHERE rd.role_id IN (${ph}) AND rd.permission_type = 'Grant'
      ORDER BY ep.object_name LIMIT 100
    `, roleIds);
    return JSON.stringify({ entry_point_count: perms.length, permissions: perms.slice(0, 50) });
  }
  return `Unknown tool: ${name}`;
}

// ── Per-user analysis ────────────────────────────────────────────────────────

async function analyzeUser(userId) {
  const messages = [{
    role: 'user',
    content: `Analyze D365 security for user: ${userId}\n\n` +
      `${roleContext}\n\n` +
      `Steps:\n` +
      `1. Call sec_lookup_user to get their roles\n` +
      `2. Identify overly permissive or unusual roles\n` +
      `3. Brief risk assessment: Low / Medium / High with justification\n\n` +
      `Be concise — this is one analysis in a batch.`,
  }];

  let totalTokens = 0;

  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    const response = await anthropic.beta.messages.create({ ...requestBase, tools, messages });

    totalTokens += (response.usage?.input_tokens || 0) + (response.usage?.output_tokens || 0);

    // Anything but a tool call ends the turn — looping on end_turn / refusal / max_tokens
    // would leave an assistant message last in `messages`, which is a prefill and a 400.
    if (response.stop_reason !== 'tool_use') {
      return { userId, analysis: finalText(response), tokens: totalTokens };
    }

    // Process tool calls: the full content (thinking blocks included) goes back
    // unchanged, and every tool_result of the turn goes in ONE user message.
    messages.push({ role: 'assistant', content: response.content });
    const toolResults = [];
    for (const block of response.content) {
      if (block.type === 'tool_use') {
        let result;
        try {
          result = await executeTool(block.name, block.input);
        } catch (err) {
          toolResults.push({ type: 'tool_result', tool_use_id: block.id, content: `Tool failed: ${err.message}`, is_error: true });
          continue;
        }
        toolResults.push({ type: 'tool_result', tool_use_id: block.id, content: result });
      }
    }
    messages.push({ role: 'user', content: toolResults });
  }

  return { userId, analysis: '(max tool rounds exceeded)', tokens: totalTokens };
}

// ── Main ─────────────────────────────────────────────────────────────────────

const results = [];
for (const user of targetUsers) {
  process.stdout.write(`  ${user.user_id}... `);
  try {
    const result = await analyzeUser(user.user_id);
    results.push(result);
    console.log(`done (${result.tokens} tokens)`);
  } catch (err) {
    console.log(`error: ${err.message}`);
    results.push({ userId: user.user_id, analysis: `Error: ${err.message}`, tokens: 0 });
  }
}

// ── Cross-user summary ───────────────────────────────────────────────────────

console.log('\nGenerating cross-user summary...');
const summaryResponse = await anthropic.beta.messages.create({
  ...requestBase,
  messages: [{
    role: 'user',
    content: `You analyzed D365 security for ${results.length} users. Individual results:\n\n` +
      results.map(r => `### ${r.userId}\n${r.analysis}`).join('\n\n') +
      `\n\nProvide a concise security summary:\n` +
      `1. Users with excessive privileges\n` +
      `2. Overall risk posture\n` +
      `3. Top 3 remediation actions`,
  }],
});

const summary = finalText(summaryResponse);
const totalTokens = results.reduce((s, r) => s + r.tokens, 0) +
  (summaryResponse.usage?.input_tokens || 0) + (summaryResponse.usage?.output_tokens || 0);

// ── Write report ─────────────────────────────────────────────────────────────

const report = {
  analyzedAt: new Date().toISOString(),
  buildDate,
  model: MODEL,
  userCount: results.length,
  totalTokensUsed: totalTokens,
  summary,
  individualAnalyses: results.map(r => ({
    userId: r.userId,
    analysis: r.analysis,
    tokensUsed: r.tokens,
  })),
};

const filename = `audit-report-${new Date().toISOString().slice(0, 10)}.json`;
writeFileSync(filename, JSON.stringify(report, null, 2));
console.log(`\nReport written to ${filename}`);
console.log(`Total tokens: ${totalTokens}`);

db.close();
