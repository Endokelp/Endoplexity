/**
 * The comparison row: one task through Claude in Chrome, Anthropic's own
 * extension, driven by the same `claude` CLI and model as Endoplexity's Claude
 * row, so tokens, turns and cost come from the same accounting.
 *
 *   node bench/cic.ts <model> <label> "<task>"     (bench/suite.ts calls it for cic:<model>)
 *
 * The CLI gets ToolSearch and Claude in Chrome's tools only (no shell, no web
 * fetch, none of the operator's settings or MCP servers), as Endoplexity's
 * Claude row gets ToolSearch, Agent and its own tools. It needs a Chrome for
 * Testing with the extension loaded and signed in, on ENDO_LIVE_PORT, which is
 * also where the end state is read from for the judge. Writes the same
 * <label>.jsonl / .summary.json / .final.txt as scripts/bench.ts.
 */
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const [model, label, task] = process.argv.slice(2);
const ROOT = new URL("../", import.meta.url);
const DEV = `http://127.0.0.1:${process.env.ENDO_LIVE_PORT ?? 9351}`;
const start = process.env.ENDO_BENCH_URL ?? "about:blank";
const cap = Number(process.env.ENDO_BENCH_TIMEOUT) || 600_000;
const empty = join(tmpdir(), "endo-cic-empty-mcp.json");
writeFileSync(empty, '{"mcpServers":{}}');

// The extension starts with no tab of its own, so it is told where to start
// instead of being put there; that costs it one navigate the other rows skip.
const prompt = `${process.env.CIC_PREAMBLE ?? ""}Start at ${start}\n\n${task}`;
const args = ["-p", "--chrome", "--strict-mcp-config", "--mcp-config", empty, "--setting-sources", "", "--model", model,
  "--tools", "ToolSearch", "--allowedTools", "ToolSearch,mcp__claude-in-chrome__*", "--output-format", "stream-json", "--verbose", prompt];

const events: Record<string, any>[] = [];
const started = Date.now();
let timedOut = false;
let buf = "";
const child = spawn("claude", args, { stdio: ["ignore", "pipe", "pipe"] });
child.stdout.on("data", (d) => {
  buf += d;
  for (let i; (i = buf.indexOf("\n")) >= 0; buf = buf.slice(i + 1)) {
    try {
      events.push({ ...JSON.parse(buf.slice(0, i)), at: Date.now() - started });
    } catch {}
  }
});
let stderr = "";
child.stderr.on("data", (d) => (stderr += d));
const timer = setTimeout(() => ((timedOut = true), child.kill()), cap);
const code: number | null = await new Promise((done) => child.on("close", done));
clearTimeout(timer);
const wall = Date.now() - started;
writeFileSync(fileURLToPath(new URL(`${label}.jsonl`, ROOT)), events.map((e) => JSON.stringify(e)).join("\n"));

const calls: string[] = [];
let turns = 0;
let images = 0;
for (const e of events) {
  if (e.type === "assistant") {
    const tools = (e.message?.content ?? []).filter((p: any) => p.type === "tool_use");
    if (tools.length) turns++;
    calls.push(...tools.map((p: any) => p.name));
  }
  if (e.type === "user") for (const p of e.message?.content ?? []) if (p.type === "tool_result" && Array.isArray(p.content)) images += p.content.filter((c: any) => c.type === "image").length;
}
const result = events.findLast((e) => e.type === "result") ?? {};
const usage = result.usage ?? {};

// The end state for the judge, read over the test browser's debugging port: the
// page the agent last saw, its text and (in suite.ts) its screenshot. Claude in
// Chrome works in a tab of its own, so the first page tab can be a previous
// task's leftover: on 2026-11-07/08 it was for 14 of 30 runs.
const seen = events.flatMap((e) =>
  (e.message?.content ?? []).flatMap((p: any) => [
    p.input?.url,
    ...(Array.isArray(p.content) ? p.content : []).map((c: any) => /^URL: (\S+)/m.exec(c.text ?? "")?.[1]),
  ]),
).filter(Boolean);
const lastUrl = seen.at(-1);
let finalTabs = "";
let finalText = "";
try {
  const pages = (await (await fetch(`${DEV}/json/list`)).json()).filter((t: any) => t.type === "page" && /^https?:/.test(t.url));
  const host = (u: string) => URL.parse(u)?.hostname;
  const page = pages.find((t: any) => t.url === lastUrl) ?? pages.find((t: any) => lastUrl && host(t.url) === host(lastUrl)) ?? pages[0];
  if (page) {
    finalTabs = `* id 0 — "${page.title}" ${page.url}`;
    const ws = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise((ok, fail) => ((ws.onopen = ok), (ws.onerror = fail)));
    const r: any = await new Promise((ok) => {
      ws.onmessage = (m) => ok(JSON.parse(String(m.data)));
      ws.send(JSON.stringify({ id: 1, method: "Runtime.evaluate", params: { expression: "document.body.innerText", returnByValue: true } }));
    });
    ws.close();
    finalText = String(r.result?.result?.value ?? "");
  }
} catch {}
writeFileSync(fileURLToPath(new URL(`${label}.final.txt`, ROOT)), `${finalTabs}\n\n${finalText}`);

const failed = code !== 0 || result.is_error;
writeFileSync(
  fileURLToPath(new URL(`${label}.summary.json`, ROOT)),
  JSON.stringify({
    model: `cic:${model}`,
    start,
    wall,
    timedOut,
    error: failed && !timedOut ? String(result.result || stderr.trim() || `claude exited ${code}`).slice(0, 500) : null,
    num_turns: result.num_turns ?? null,
    tool_turns: turns,
    tool_calls: calls.length,
    input_tokens: usage.input_tokens ?? 0,
    cache_read: usage.cache_read_input_tokens ?? 0,
    cache_write: usage.cache_creation_input_tokens ?? 0,
    output_tokens: usage.output_tokens ?? 0,
    cost_usd: result.total_cost_usd ?? null,
    screenshots: images,
    sequence: calls,
    answer: String(result.result ?? ""),
    final_tabs: finalTabs,
  }, null, 2),
);
console.log(`${label}: ${(wall / 1000).toFixed(0)}s, ${turns} turns, ${images} screenshots, $${result.total_cost_usd ?? "?"}`);
