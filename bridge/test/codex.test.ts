import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { API_KEYS, codexArgs, codexEvents, FEATURES_OFF, outside, writeCodexConfig } from "../src/codex.ts";

// The whole boundary is config.toml, so these read the file writeCodexConfig
// actually writes. Parsed by section, not regexed: a key that lands under the
// wrong [table] is still valid TOML and does nothing at all.
const config = () => {
  const dir = mkdtempSync(join(tmpdir(), "endo-codex-test-"));
  writeCodexConfig(4242, "s3cret", dir);
  const keys: Record<string, unknown> = {};
  let table = "";
  for (const line of readFileSync(join(dir, "config.toml"), "utf8").split("\n")) {
    const header = /^\[(.+)\]$/.exec(line);
    if (header) table = `${header[1]}.`;
    const pair = /^([\w.]+) = (.+)$/.exec(line);
    // An inline table is not JSON: kept as its text.
    if (pair) keys[table + pair[1]] = /^\{.*\}$/.test(pair[2]) ? pair[2] : JSON.parse(pair[2]);
  }
  return keys;
};

test("codex's own shell, browsers and sub-agents are switched off", () => {
  const keys = config();
  for (const name of ["shell_tool", "unified_exec", "browser_use", "computer_use", "in_app_browser", "apps", "plugins"]) {
    assert.equal(keys[`features.${name}`], false, `${name} must be off`);
  }
  for (const name of FEATURES_OFF) assert.equal(keys[`features.${name}`], false);
  assert.equal(keys["agents.enabled"], false);
  assert.equal(keys.web_search, "disabled");
  assert.equal(keys.sandbox_mode, "read-only");
});

// Every 0.160.1 model is code_mode_only: with the host off, nothing is callable.
test("the code-mode host stays on, or the agent cannot call even endo", () => {
  assert.equal(config()["features.code_mode_host"], undefined);
});

test("endo is the only MCP server, approved, with room for a gated click", () => {
  const keys = config();
  assert.deepEqual(
    Object.keys(keys).filter((key) => key.startsWith("mcp_servers.")).map((key) => key.split(".")[1]),
    ["endo", "endo", "endo", "endo"],
  );
  assert.equal(keys["mcp_servers.endo.url"], "http://127.0.0.1:4242/mcp?token=s3cret");
  // Each spawn sets ENDO_RUN, so a call names its run (run.ts) with no per-run file.
  assert.equal(keys["mcp_servers.endo.env_http_headers"], '{ "X-Endo-Run" = "ENDO_RUN" }');
  assert.equal(keys["mcp_servers.endo.default_tools_approval_mode"], "approve");
  // 60s for the human at the gate plus 30s for the panel, per relay.ts.
  assert.ok(Number(keys["mcp_servers.endo.tool_timeout_sec"]) >= 90);
  assert.equal(keys.approval_policy, "never");
});

test("the briefing rides in the config and skill listings stay out", () => {
  const keys = config();
  assert.match(String(keys.developer_instructions), /^You drive a real web browser\./);
  assert.equal(keys["skills.include_instructions"], false);
});

const promptOf = (argv: string[]) => argv.at(-1);

test("a fresh run is machine-readable, strict and resumes nothing", () => {
  const argv = codexArgs("do a thing", "gpt-6.1-sol");
  assert.deepEqual(argv.slice(0, 1), ["exec"]);
  assert.ok(!argv.includes("resume"));
  for (const flag of ["--json", "--strict-config", "--skip-git-repo-check"]) assert.ok(argv.includes(flag), flag);
  assert.equal(argv[argv.indexOf("-m") + 1], "gpt-6.1-sol");
  assert.equal(promptOf(argv), "do a thing");
});

test("a reply resumes the thread, and a prompt that starts with a dash stays a prompt", () => {
  const argv = codexArgs("--yolo please", "gpt-6.1-sol", "thread-9");
  assert.deepEqual(argv.slice(0, 2), ["exec", "resume"]);
  assert.deepEqual(argv.slice(argv.indexOf("--") + 1), ["thread-9", "--yolo please"]);
  assert.ok(argv.includes("--strict-config"), "a resume is held to the same config");
});

const code = readFileSync(fileURLToPath(new URL("../src/codex.ts", import.meta.url)), "utf8")
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .replace(/\/\/.*/g, "");

test("nothing that bypasses the sandbox or approvals reaches the spawn", () => {
  assert.doesNotMatch(code, /dangerously|full-auto|danger-full-access|shell:\s*true/);
});

test("the spawn runs on the subscription, never an API key, in any spelling", () => {
  assert.deepEqual(API_KEYS, ["CODEX_API_KEY", "OPENAI_API_KEY"]);
  assert.match(code, /!API_KEYS\.includes\(key\.toUpperCase\(\)\)/);
  assert.match(code, /env: \{ \.\.\.codexEnv\(\), CODEX_HOME, ENDO_RUN: run \}/);
  // The second key's judge spawns codex as well, on the same terms.
  const judge = readFileSync(fileURLToPath(new URL("../src/second.ts", import.meta.url)), "utf8");
  assert.match(judge, /env: \{ \.\.\.codexEnv\(\), CODEX_HOME \}/);
  assert.doesNotMatch(judge, /dangerously|full-auto|danger-full-access|shell:\s*true/);
});

// From a real run (2026-11-01, gpt-6.1-sol, one endo call with no panel attached).
const fixture = readFileSync(fileURLToPath(new URL("fixtures/codex-run.jsonl", import.meta.url)), "utf8")
  .split("\n")
  .filter(Boolean)
  .map((line) => JSON.parse(line));

test("a real run normalizes onto the shapes the panel and bench read", () => {
  const out = fixture.map(codexEvents("gpt-6.1-sol"));
  const init = out.find((e) => e.type === "system");
  assert.equal(init?.subtype, "init");
  assert.equal(init?.session_id, fixture[0].thread_id, "the thread id is what a reply resumes");

  const parts = out.flatMap((e) => (e.type === "assistant" ? (e.message as { content: Record<string, unknown>[] }).content : []));
  assert.deepEqual(parts.filter((p) => p.type === "tool_use").map((p) => p.name), ["mcp__endo__tabs"]);
  assert.equal(parts.filter((p) => p.type === "text").length, 2);

  const result = out.find((e) => e.type === "result") as { result: string; duration_ms: number; usage: Record<string, number> };
  assert.equal(result.result, (parts.at(-1) as { text: string }).text);
  assert.equal(typeof result.duration_ms, "number", "the panel's chip reads a missing duration as 0s");
  // 24,636 in, 16,000 of them cached: OpenAI counts the cache inside input.
  assert.deepEqual(result.usage, { input_tokens: 8636, cache_read_input_tokens: 16000, output_tokens: 108 });
});

test("only text and endo calls are inside the boundary", () => {
  for (const event of fixture) if (event.item) assert.equal(outside(event.item), false, JSON.stringify(event.item));
  for (const type of ["command_execution", "file_change", "collab_tool_call", "web_search", "something_new"]) {
    assert.equal(outside({ type }), true, type);
  }
  assert.equal(outside({ type: "mcp_tool_call", server: "chrome-devtools", tool: "click" }), true);
});
