/**
 * One task, one CLI, one row of numbers.
 *
 * Four measurements died before this existed — wrong tab, an accidental Reply,
 * a sleeping laptop, and an agent answering from memory — because every one of
 * them was a human driving the panel by hand and reading a chip afterwards. The
 * fix is that none of that is necessary: the bridge's own `/mcp` endpoint is
 * reachable from a terminal, and the CLI adapters are plain functions. So this
 * spawns the PRODUCTION adapter (the same runClaude/runCursor index.ts uses,
 * same flags, same briefing, same isolated cursor profile) against the live
 * bridge, and the tools really do drive the attached Chrome tab.
 *
 * What it is not: it bypasses the panel's Run button, so it measures the
 * CLI + bridge + browser, not the panel's own event handling.
 *
 *   npm run bench -- claude-sonnet-5-5 claude-hn "the task"
 *   npm run bench -- grok-4.7-medium cursor-hn "the same task"
 *   npm run bench -- gpt-6.1-sol codex-hn "the same task"
 *
 * Writes <label>.jsonl beside the repo's .endo-bridge.log so a run can be read
 * back without paying for it twice, then prints the summary.
 *
 * REQUIRES a connected side panel — and one running the extension as it is on
 * disk. Chrome caches an unpacked extension's files until you reload it at
 * chrome://extensions, and a stale panel reports numbers for code that is no
 * longer in the tree. The one-glance tell is in the refs: `@f0e1, @f0e2, @f0e3…`
 * contiguous from 1 is the pre-P11e walk counter, and that build is old.
 */
import { writeFileSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = new URL("../", import.meta.url);
const { MODELS } = await import(new URL("bridge/src/models.ts", REPO).href);
const { runCodex, CODEX_HOME } = await import(new URL("bridge/src/codex.ts", REPO).href);

const [model, label, task] = process.argv.slice(2);
if (!model || !label || !task || !Object.hasOwn(MODELS, model)) {
  console.error(`usage: npm run bench -- <model> <label> "<task>"\nmodels: ${Object.keys(MODELS).join(", ")}`);
  process.exit(2);
}

const mcpUrl = JSON.parse(readFileSync(new URL(".endo-mcp.json", REPO), "utf8")).mcpServers.endo.url;

/** Direct MCP call, so the harness can read and reset the browser itself. */
async function tool(name: string, args: Record<string, unknown> = {}) {
  const res = await fetch(mcpUrl, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
  });
  const text = await res.text();
  const line = text.split("\n").find((l) => l.startsWith("data: "));
  const body = JSON.parse(line ? line.slice(6) : text);
  return String(body.result?.content?.[0]?.text ?? "");
}

// Both legs start parked on about:blank, so the two prompts are byte-identical
// and neither model inherits the other's page. The panel names the current page
// in every task prompt, so a measurement that skipped the line would not be
// measuring the product.
const parked = await tool("navigate", { url: "about:blank" });
if (parked.startsWith("error:")) {
  console.error(`${parked}\n\nOpen the side panel and check it says connected.`);
  process.exit(1);
}
console.log(`tabs before the run:\n${await tool("tabs")}`);
const prompt = `The page you are on is "about:blank" — about:blank\n\n${task}`;

const events: Record<string, unknown>[] = [];
const started = Date.now();
await new Promise<void>((done) => {
  MODELS[model](prompt, model, (event: Record<string, unknown>) => {
    events.push({ ...event, at: Date.now() - started });
    if (event.type === "done" || event.type === "failed") done();
  });
});

const wall = Date.now() - started;
const out = fileURLToPath(new URL(`${label}.jsonl`, REPO));
writeFileSync(out, events.map((e) => JSON.stringify(e)).join("\n"));

// --- read the run back -------------------------------------------------------

const calls: { name: string; turn: string }[] = [];
let assistantTurns = 0;

for (const e of events) {
  // claude nests tool_use blocks in an assistant message, one message per turn.
  if (e.type === "assistant") {
    const content = (e.message as { content?: Record<string, unknown>[] })?.content ?? [];
    if (content.length) assistantTurns++;
    for (const part of content) {
      if (part.type === "tool_use") calls.push({ name: String(part.name), turn: `a${assistantTurns}` });
    }
  }
  // cursor emits its own event, batched by the `fc_…` half of call_id — one
  // fc per model turn, so parallel calls in one turn are not counted twice.
  if (e.type === "tool_call" && e.subtype === "started") {
    const tc = (e.tool_call ?? {}) as Record<string, Record<string, unknown>>;
    const kind = Object.keys(tc)[0] ?? "?";
    const name = kind === "mcpToolCall" ? String((tc[kind].args as Record<string, unknown>)?.name) : kind;
    calls.push({ name, turn: /fc_[0-9a-f-]+/.exec(String(e.call_id ?? ""))?.[0] ?? "?" });
  }
}

const result = (events.find((e) => e.type === "result") ?? {}) as Record<string, never>;
const usage = (result.usage ?? {}) as Record<string, number>;
// claude spells usage in snake_case, cursor in camelCase — reading one spelling
// prints a 60k-token run as 0.
const num = (...keys: string[]) => keys.reduce((sum, k) => sum + (usage[k] ?? 0), 0);
const answer = String(result.result ?? "");

// A turn is a model response that did work; cursor batches parallel calls into
// one, so counting raw calls instead would flatter it.
let toolTurns = new Set(calls.map((c) => c.turn)).size;

// Codex calls tools by writing JS into one `exec` cell, which may call several,
// and its JSONL shows the calls but not the cells. The session's rollout file
// shows both: one `exec` per tool-calling turn, one usage record per request.
if (MODELS[model] === runCodex) {
  const thread = String(events.find((e) => e.type === "system")?.session_id ?? "");
  // Optional evidence: with no rollout, the call-derived count stands rather
  // than being overwritten by a zero that reads like a measurement.
  let rows: Record<string, any>[] = [];
  try {
    const sessions = join(CODEX_HOME, "sessions");
    const file = thread && readdirSync(sessions, { recursive: true }).find((name) => String(name).includes(thread));
    if (file) rows = readFileSync(join(sessions, String(file)), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
  } catch (err) {
    console.warn(`no codex rollout read (${(err as Error).message}) — tool-call turns are an upper bound`);
  }
  if (rows.length) {
    toolTurns = rows.filter((r) => r.payload?.type === "custom_tool_call" && r.payload?.name === "exec").length;
    Object.assign(result, { num_turns: rows.filter((r) => r.type === "token_usage_record").length });
  }
}
// The tax this harness was written to catch: turns that bought only a schema.
const discovery = calls.filter((c) => /ToolSearch|getMcpTools/.test(c.name)).length;

console.log(`\n=== ${label} (${model}) ===`);
console.log(`wall               ${(wall / 1000).toFixed(1)}s`);
console.log(`num_turns          ${result.num_turns ?? "(not reported)"}`);
console.log(`tool-call turns    ${toolTurns}`);
console.log(`  of them discovery ${discovery}`);
console.log(`tool calls         ${calls.length}`);
console.log(`input tokens       ${num("input_tokens", "inputTokens")}`);
console.log(`cache read         ${num("cache_read_input_tokens", "cacheReadTokens")}`);
console.log(`cache write        ${num("cache_creation_input_tokens", "cacheWriteTokens")}`);
console.log(`output tokens      ${num("output_tokens", "outputTokens")}`);
console.log(`cost usd           ${result.total_cost_usd ?? "(not reported — subscription)"}`);
console.log(`fake xml           ${/<function_calls>|<invoke name=/.test(JSON.stringify(events))}`);
console.log(`sequence           ${calls.map((c) => c.name).join(" -> ")}`);
console.log(`\nfull stream: ${out}`);
console.log(`\nanswer (${answer.length} chars):\n${answer.slice(0, 1200)}`);
