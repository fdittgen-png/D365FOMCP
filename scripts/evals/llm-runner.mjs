/**
 * LLM leg of the evals (issue #119 item 1): one question, one agent loop.
 *
 * The model gets the server's `instructions`, the tool list and the question —
 * nothing else. Tool calls are forwarded to the MCP client; the TEXT channel
 * (`content[].text`, what a text-only client sees) is what the model reads,
 * while `structuredContent` bytes are recorded because that is the channel the
 * claude.ai connector bills. A tool `isError` result goes back as
 * `is_error: true`, never aborts the question — recovering from "not found" is
 * part of what the eval measures.
 *
 * Privacy: the record keeps tool names and argument KEYS. Never values, never
 * payloads.
 *
 * Both clients are injected so the loop is testable without network or a
 * server: `anthropic` needs `messages.create(params)`; `mcp` needs
 * `callTool({name, arguments}, undefined, {timeout})`.
 */

export const DEFAULT_MODEL = 'claude-sonnet-5';
export const DEFAULT_MAX_TURNS = 12;
const MAX_TOKENS = 8192;
const CALL_TIMEOUT_MS = 180_000;

/**
 * USD per million tokens — the claude-api skill's table (cached 2026-06-24).
 * Cache reads bill at 0.1x input, cache writes at 1.25x input.
 */
export const PRICES_PER_MTOK = Object.freeze({
  'claude-fable-5-1': { input: 10, output: 50 },
  'claude-fable-5': { input: 10, output: 50 },
  'claude-opus-5': { input: 5, output: 25 },
  'claude-opus-4-8': { input: 5, output: 25 },
  'claude-opus-4-7': { input: 5, output: 25 },
  'claude-opus-4-6': { input: 5, output: 25 },
  'claude-sonnet-5': { input: 2, output: 10 },
  'claude-sonnet-4-6': { input: 3, output: 15 },
  'claude-haiku-4-5': { input: 1, output: 5 },
});

export function estimateCostUsd(model, usage) {
  const p = PRICES_PER_MTOK[model];
  if (!p || !usage) return null;
  const u = usage.input_tokens ?? 0;
  const o = usage.output_tokens ?? 0;
  const cr = usage.cache_read_input_tokens ?? 0;
  const cw = usage.cache_creation_input_tokens ?? 0;
  const usd = (u * p.input + cr * p.input * 0.1 + cw * p.input * 1.25 + o * p.output) / 1e6;
  return Math.round(usd * 1e5) / 1e5;
}

export function buildSystemPrompt(instructions) {
  return `${(instructions ?? '').trim()}\nAnswer with the value only.`.trim();
}

/**
 * MCP tools -> Anthropic `tools` array. Tools that declare
 * `readOnlyHint: false` are dropped: an eval is read-only by contract and the
 * KB server registers a few write tools (semantic mapping) that a wandering
 * model must not reach.
 */
export function toAnthropicTools(mcpTools) {
  return (mcpTools ?? [])
    .filter(t => t.annotations?.readOnlyHint !== false)
    .map(t => ({
      name: t.name,
      description: (t.description ?? '').slice(0, 1024),
      input_schema: t.inputSchema && t.inputSchema.type === 'object' ? t.inputSchema : { type: 'object', properties: {} },
    }));
}

function textOf(content) {
  return Array.isArray(content) ? content.filter(b => b.type === 'text').map(b => b.text).join('\n') : '';
}

function addUsage(total, u) {
  if (!u) return total;
  for (const k of ['input_tokens', 'output_tokens', 'cache_read_input_tokens', 'cache_creation_input_tokens']) {
    total[k] = (total[k] ?? 0) + (u[k] ?? 0);
  }
  return total;
}

/**
 * Run one question through the tool-use loop.
 * @returns {Promise<object>} the per-question record (see results-file shape in evals/README.md)
 */
export async function runQuestionLlm({ anthropic, mcp, tools, system, question, model = DEFAULT_MODEL, maxTurns = DEFAULT_MAX_TURNS, callTimeoutMs = CALL_TIMEOUT_MS }) {
  const started = Date.now();
  const messages = [{ role: 'user', content: question }];
  const toolCalls = [];
  const usage = {};
  let turns = 0;
  let scBytes = 0;
  let textBytes = 0;
  let toolErrors = 0;
  let answer = '';
  let stop = 'max_turns';

  while (turns < maxTurns) {
    turns++;
    const response = await anthropic.messages.create({
      model,
      max_tokens: MAX_TOKENS,
      // tools -> system is the stable prefix across every question of a run;
      // the breakpoint on the system block caches the ~70 KB tool list once.
      system: [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }],
      tools,
      messages,
    });
    addUsage(usage, response.usage);
    const text = textOf(response.content);
    if (text) answer = text;

    if (response.stop_reason === 'pause_turn') {
      messages.push({ role: 'assistant', content: response.content });
      continue;
    }
    const toolUses = (response.content ?? []).filter(b => b.type === 'tool_use');
    if (response.stop_reason !== 'tool_use' || toolUses.length === 0) {
      stop = response.stop_reason ?? 'end_turn';
      break;
    }
    messages.push({ role: 'assistant', content: response.content });

    const results = [];
    for (const tu of toolUses) {
      const args = tu.input && typeof tu.input === 'object' ? tu.input : {};
      const rec = { tool: tu.name, arg_keys: Object.keys(args).sort(), is_error: false, structured_bytes: 0, text_bytes: 0, ms: 0 };
      const t0 = Date.now();
      let content;
      try {
        const res = await mcp.callTool({ name: tu.name, arguments: args }, undefined, { timeout: callTimeoutMs });
        content = textOf(res.content);
        rec.is_error = Boolean(res.isError);
        rec.structured_bytes = res.structuredContent === undefined ? 0 : Buffer.byteLength(JSON.stringify(res.structuredContent), 'utf8');
        rec.text_bytes = Buffer.byteLength(content, 'utf8');
      } catch (err) {
        // Transport/timeout failure: the model sees a short error, the run goes on.
        content = `Tool call failed: ${String(err?.message ?? err).slice(0, 200)}`;
        rec.is_error = true;
      }
      rec.ms = Date.now() - t0;
      if (rec.is_error) toolErrors++;
      scBytes += rec.structured_bytes;
      textBytes += rec.text_bytes;
      toolCalls.push(rec);
      results.push({ type: 'tool_result', tool_use_id: tu.id, content: content || '(empty result)', ...(rec.is_error ? { is_error: true } : {}) });
    }
    // All results of one assistant turn go back in ONE user message.
    messages.push({ role: 'user', content: results });
  }

  return {
    answer: answer.trim(),
    stop_reason: stop,
    turns,
    tool_calls: toolCalls,
    tool_errors: toolErrors,
    structured_bytes: scBytes,
    text_bytes: textBytes,
    usage,
    estimated_cost_usd: estimateCostUsd(model, usage),
    wall_ms: Date.now() - started,
    model,
  };
}
