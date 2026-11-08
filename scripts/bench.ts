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
 * back without paying for it twice, then prints the summary. Also writes
 * <label>.summary.json (the numbers) and <label>.final.txt (the open tabs and
 * the whole page the run ended on), which bench/suite.ts and its judge read.
 *
 *   ENDO_BENCH_URL=https://...   start there instead of about:blank, named in
 *                                the prompt the way the panel names a page
 *   ENDO_BENCH_TIMEOUT=600000    kill the CLI after this many ms: a stall
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

const [model, label, task, varsJson] = process.argv.slice(2);
// `replay` is the zero-model row: `npm run bench -- replay <label> <host/skill> ['{"var":"value"}']`
// calls run_skill over /mcp itself, so no CLI starts and no token is spent.
if (!model || !label || !task || (model !== "replay" && !Object.hasOwn(MODELS, model))) {
  console.error(`usage: npm run bench -- <model> <label> "<task>"\n       npm run bench -- replay <label> <host/skill> ['{"var":"value"}']\nmodels: ${Object.keys(MODELS).join(", ")}`);
  process.exit(2);
}

const mcpUrl = JSON.parse(readFileSync(process.env.ENDO_MCP_CONFIG ?? new URL(".endo-mcp.json", REPO), "utf8")).mcpServers.endo.url;

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
const start = process.env.ENDO_BENCH_URL ?? "about:blank";
const parked = await tool("navigate", { url: start });
if (parked.startsWith("error:")) {
  console.error(`${parked}\n\nOpen the side panel and check it says connected.`);
  process.exit(1);
}
const before = await tool("tabs");
console.log(`tabs before the run:\n${before}`);
// The tab the panel drives is starred: `* id 7 — "Title" https://...`.
const here = /^\* id \d+ — "(.*)" (\S+)/m.exec(before);

if (model === "replay") {
  const t0 = Date.now();
  const text = await tool("run_skill", { name: task, ...(varsJson && { vars: JSON.parse(varsJson) }) });
  const wall = Date.now() - t0;
  const row = { type: "replay", skill: task, wall, turns: 0, tokens: 0, ok: text.startsWith("replayed all"), result: text };
  writeFileSync(fileURLToPath(new URL(`${label}.jsonl`, REPO)), JSON.stringify(row));
  console.log(`\n=== ${label} (replay ${task}) ===`);
  console.log(`wall               ${(wall / 1000).toFixed(1)}s`);
  console.log(`model turns        0`);
  console.log(`tokens             0`);
  console.log(`\n${text.split("\nthe page as it is now:")[0]}`);
  process.exit(row.ok ? 0 : 1);
}

const prompt =
  start === "about:blank" ? `The page you are on is "about:blank" — about:blank\n\n${task}` : `The page you are on is "${here?.[1] ?? ""}" — ${here?.[2] ?? start}\n\n${task}`;

const events: Record<string, unknown>[] = [];
const started = Date.now();
const cap = Number(process.env.ENDO_BENCH_TIMEOUT) || 0;
let timedOut = false;
await new Promise<void>((done) => {
  const child = MODELS[model](prompt, model, (event: Record<string, unknown>) => {
    events.push({ ...event, at: Date.now() - started });
    if (event.type === "done" || event.type === "failed") done();
  });
  if (cap)
    setTimeout(() => {
      timedOut = true;
      child.kill();
      // The adapter reports the kill as its end; this is for one that never does.
      setTimeout(done, 15_000).unref();
    }, cap).unref();
});

const wall = Date.now() - started;
const out = fileURLToPath(new URL(`${label}.jsonl`, REPO));
writeFileSync(out, events.map((e) => JSON.stringify(e)).join("\n"));

// Where the run ended, for a judge: a whole page, not a delta against what the
// model last read, so /forget first (same token as /mcp).
const forgetUrl = new URL(mcpUrl);
forgetUrl.pathname = "/forget";
await fetch(forgetUrl, { method: "POST" }).catch(() => {});
const finalTabs = await tool("tabs");
writeFileSync(fileURLToPath(new URL(`${label}.final.txt`, REPO)), `${finalTabs}\n\n${await tool("snapshot")}`);

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
const end = (events.findLast((e) => e.type === "done" || e.type === "failed") ?? {}) as Record<string, unknown>;
writeFileSync(
  fileURLToPath(new URL(`${label}.summary.json`, REPO)),
  JSON.stringify({
    model,
    start,
    wall,
    timedOut,
    error: end.type === "failed" || end.error ? String(end.error ?? end.message ?? "failed").slice(0, 500) : null,
    num_turns: result.num_turns ?? null,
    tool_turns: toolTurns,
    tool_calls: calls.length,
    input_tokens: num("input_tokens", "inputTokens"),
    cache_read: num("cache_read_input_tokens", "cacheReadTokens"),
    cache_write: num("cache_creation_input_tokens", "cacheWriteTokens"),
    output_tokens: num("output_tokens", "outputTokens"),
    cost_usd: result.total_cost_usd ?? null,
    // Images a tool handed the model. Endoplexity sends none; the count is here
    // so the comparison rows (bench/cic.ts) are read the same way.
    screenshots: events.flatMap((e) => (e.type === "user" ? ((e.message as any)?.content ?? []) : [])).filter((p: any) => p.type === "tool_result" && Array.isArray(p.content)).flatMap((p: any) => p.content).filter((c: any) => c.type === "image").length,
    sequence: calls.map((c) => c.name),
    answer,
    final_tabs: finalTabs,
  }, null, 2),
);
console.log(`\nfull stream: ${out}`);
console.log(`\nanswer (${answer.length} chars):\n${answer.slice(0, 1200)}`);
