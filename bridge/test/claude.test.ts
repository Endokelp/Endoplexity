import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { claudeArgs, PRELOAD } from "../src/claude.ts";

// Spawn args are a security boundary — pin the ones that already bit us. These
// read the argv that actually reaches spawn rather than regexing the source
// that builds it: a misspelt flag is still perfectly valid source, and would
// disable the boundary while a source-text test kept passing.
const args = (resume?: string) => claudeArgs("do a thing", "sonnet", resume);
const valueOf = (argv: string[], flag: string) => argv[argv.indexOf(flag) + 1];

const src = readFileSync(fileURLToPath(new URL("../src/claude.ts", import.meta.url)), "utf8");

// This one DOES read source text, deliberately: the thing being pinned is that
// two hand-written lists agree, and mcp.ts's registerTool calls are the only
// statement of the real set that does not need an MCP round trip to read.
test("the ToolSearch briefing preloads every tool mcp.ts registers", () => {
  const mcp = readFileSync(fileURLToPath(new URL("../src/mcp.ts", import.meta.url)), "utf8");
  const registered = [...mcp.matchAll(/registerTool\(\s*"([^"]+)"/g)].map((m) => m[1]);

  assert.ok(registered.length > 10, `expected to find the tools in mcp.ts, found ${registered.length}`);
  assert.deepEqual(
    [...PRELOAD].sort(),
    [...registered].sort(),
    "PRELOAD in claude.ts and registerTool in mcp.ts have drifted — a tool missing here costs a whole extra ToolSearch turn",
  );
});

test("the briefing tells the agent it can read a configured file, not only attach one", () => {
  const briefing = valueOf(args(), "--append-system-prompt");
  assert.match(briefing, /read_file reads one/);
  assert.match(briefing, /mcp__endo__read_file/);
});

test("print mode auto-approves ToolSearch and Agent, not only mcp__endo__*", () => {
  assert.equal(valueOf(args(), "--allowedTools"), "ToolSearch,Agent,mcp__endo__*");
});

test("--allowedTools stays last — it is variadic and swallows whatever follows", () => {
  const argv = args("abc-123");
  assert.equal(argv.indexOf("--allowedTools"), argv.length - 2);
});

test("stdin is ignored so -p does not stall waiting for a pipe", () => {
  assert.match(src, /stdio:\s*\[\s*"ignore"/);
});

test("a fresh task carries no --resume", () => {
  assert.ok(!args().includes("--resume"));
});

test("a reply resumes exactly the session it was given", () => {
  const argv = args("abc-123");
  assert.equal(valueOf(argv, "--resume"), "abc-123");
  assert.equal(argv.filter((arg) => arg === "--resume").length, 1);
});

// The one that matters: --resume restores a conversation, not a permission set.
// A resumed run that lost these flags is a browser agent with a shell behind it.
test("resuming keeps the whole tool boundary", () => {
  const argv = args("abc-123");
  assert.equal(valueOf(argv, "--tools"), "ToolSearch,Agent");
  assert.equal(valueOf(argv, "--allowedTools"), "ToolSearch,Agent,mcp__endo__*");
  assert.equal(valueOf(argv, "--setting-sources"), "");
  assert.ok(argv.includes("--strict-mcp-config"));
  assert.deepEqual(Object.keys(JSON.parse(valueOf(argv, "--agents"))), ["reader"]);
  assert.match(valueOf(argv, "--disallowedTools"), /Agent\(general-purpose\)/);
});

// The scout reads; it must never hold a tool the gate weighs or that acts on a page.
test("the reader scout gets the read tools and nothing else", () => {
  const { reader } = JSON.parse(valueOf(args(), "--agents"));
  assert.deepEqual([...reader.tools].sort(), ["mcp__endo__navigate", "mcp__endo__snapshot", "mcp__endo__tabs", "mcp__endo__use_tab"]);
  assert.equal(reader.model, "claude-haiku-5-5");
});

test("background tasks are off, so a scout never drives the tab alongside the main model", () => {
  assert.match(src, /CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: "1"/);
});

test("--bare never reaches the spawn — it would force ANTHROPIC_API_KEY", () => {
  assert.ok(!args("abc-123").includes("--bare"));
});
