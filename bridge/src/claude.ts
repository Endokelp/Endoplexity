import { spawn, type ChildProcess } from "node:child_process";
import { createInterface } from "node:readline";
import { readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

// ENDO_MCP_CONFIG: a second bridge (a live check on another port) writes its
// own, and leaves the file the user's bridge wrote, and its runs read, alone.
const CONFIG_PATH = process.env.ENDO_MCP_CONFIG ?? fileURLToPath(new URL("../../.endo-mcp.json", import.meta.url));

/**
 * Habits real runs paid for, corrected up front. Each costs ~20 tokens here —
 * cached after the first turn — against a whole model turn each time it is not
 * said:
 *
 *  1. MCP tools arrive deferred, and the agent discovered them one at a time:
 *     four ToolSearch round trips for five tools. `select:` takes a list.
 *  2. It snapshotted after every action out of habit. The tools now hand the
 *     page back themselves, but the tool description alone did not stop it.
 *  3. It retried the same failing action three times before routing around it.
 *  4. Given "apply to THIS job" it asked which job and exited, having called
 *     nothing — it has no way to know a tab is open unless told. The panel now
 *     names the page in the prompt, and this says to act on it. Measured
 *     2026-08-06 on a Greenhouse posting: 1 turn, zero tool calls, $0.0064.
 *  5. Same run asked the user to "share your resume file". It cannot receive
 *     one, and the upload tool's own description says so — but that description
 *     only arrives after a ToolSearch this run never made.
 *  6. A five-source research task answered entirely from memory: a plausible
 *     comparison table, every source URL recalled rather than visited, zero tool
 *     calls, 1 turn, $0.1354 / 15,432 tokens. That is the worst failure this
 *     thing has, because it reads as success — and browsing is strictly more
 *     work than recalling, so nothing else in the product argues against it.
 *
 * Deliberately generic — no site names. A prompt that knows about Google is a
 * prompt that is wrong on Greenhouse.
 */
export const BRIEFING_CORE = [
  "You drive a real web browser.",
  "The task names the page the user is already looking at — act on that page rather than asking which page they mean.",
  "navigate, click, key, upload and select return the page they produced — never call snapshot after them.",
  "Refs like @f1e7 are only valid on the most recent page you were given.",
  "You cannot be sent files, but the user has configured some by key: read_file reads one, upload attaches one to a form. Use a key, and never ask for a file or a path.",
  "If an action did not do what you expected, take a different route rather than repeating it.",
  "Never answer from memory: every fact and every URL you report must come from a page you loaded in this run.",
  "Several steps on refs you already have (fill a form, tick boxes, then click) go in ONE batch call, not one call each.",
  "To locate an element on the page you were given, find costs less than reading the page again.",
].join(" ");

/**
 * Every tool mcp.ts registers, named here because the briefing is a string the
 * model reads rather than anything the server can be asked for.
 *
 * It went stale once already: phase 7 took the tool count 7 -> 13 and left this
 * list at 7, so scroll, hover, back, forward, tabs and use_tab each cost a
 * second ToolSearch round trip — a whole turn, which re-sends every turn before
 * it. Paying ~140 tokens of schema up front for a tool that may go unused is
 * strictly cheaper than that. claude.test.ts pins this against mcp.ts's own
 * registerTool calls so the next tool added cannot repeat it.
 */
export const PRELOAD = [
  "snapshot",
  "navigate",
  "click",
  "type",
  "key",
  "upload",
  "read_file",
  "select",
  "scroll",
  "hover",
  "back",
  "forward",
  "tabs",
  "use_tab",
  "batch",
  "find",
  "run_skill",
  "note_site",
];

/**
 * The reader scout, claude only (cursor and codex have no subagents).
 *
 * Every page a research task reads stays in the context every later turn
 * re-sends. Handed to a subagent, the pages stay in ITS context and only the
 * answer enters the main one. Haiku because reading is not reasoning; spelled
 * out because the `haiku` alias resolved to 4.5 (see models.ts).
 *
 * The tool list is the boundary of the scout, and it was measured, not assumed
 * (2026-11-01, claude 2.1.280): asked to list its tools, the reader named these
 * four and nothing else, and called `tabs`. Read tools only, so the scout has
 * nothing the gate would weigh.
 */
const READER = {
  reader: {
    description:
      "Reads web pages in the browser and returns only the answer you asked for. Give it every page and exactly what to bring back in one job.",
    prompt: [
      "You read web pages for another agent and hand back only what it asked for.",
      "navigate returns the page; pass full:true when you need the prose, and use snapshot with from: to read past a cut-off page.",
      "Never answer from memory: every fact must come from a page you loaded, and give the URL each one came from.",
      "Reply with the answer alone, as short as it can be while complete. No page dumps.",
    ].join(" "),
    tools: ["mcp__endo__snapshot", "mcp__endo__navigate", "mcp__endo__tabs", "mcp__endo__use_tab"],
    model: "claude-haiku-5-5",
  },
};

/**
 * The built-in agent types, denied so `reader` is the only one the Agent tool
 * offers. Not a boundary: measured, a general-purpose agent spawned here got
 * the session's own pool (ToolSearch, Agent, the endo tools) and no shell,
 * because `--tools` bounds subagents too. It is cost: each one's description
 * rides in the Agent tool's schema on every turn (~540 tokens for these six),
 * and each would run on the main model instead of Haiku.
 * ponytail: a list, so a built-in type added by a later CLI shows up offered
 * until named here. Harmless (it gets the same pool), only a few tokens a turn.
 * `--allowedTools "Agent(reader)"` was tried as the rot-proof form and does
 * NOT stop the others: general-purpose still ran.
 */
const BUILTIN_AGENTS = ["general-purpose", "Explore", "Plan", "claude", "claude-code-guide", "statusline-setup"];

// Habit 1 is claude-only — cursor hands MCP tools to the model directly, with no
// deferred-tool step to get wrong.
const BRIEFING = [
  BRIEFING_CORE,
  "To read several pages, hand the reader agent ONE job naming every page and what to bring back;",
  "the pages stay out of your context. It drives the same tab you do, so the tab is wherever it left it.",
  // Last, with nothing after it: a trailing full stop gets copied into the query.
  "Load every browser tool in ONE ToolSearch call, query:",
  `select:${PRELOAD.map((name) => `mcp__endo__${name}`).join(",")}`,
].join(" ");

/**
 * The token cannot be passed on the command line — argv shows up in any process
 * listing on the machine. It goes in a 0600 file instead, which is also the only
 * form `--mcp-config` needs.
 */
export function writeMcpConfig(port: number, token: string): string {
  const config = {
    mcpServers: {
      // Which run the calls belong to (run.ts): claude expands ${ENDO_RUN}
      // from its own env, which the spawn sets, so one file serves every run.
      endo: {
        type: "http",
        url: `http://127.0.0.1:${port}/mcp?token=${encodeURIComponent(token)}`,
        headers: { "X-Endo-Run": "${ENDO_RUN}" },
      },
    },
  };
  writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2), { mode: 0o600 });
  return CONFIG_PATH;
}

/**
 * The flag set is a security boundary, not a preference — exported as a plain
 * array so a test can assert on it without spawning anything. Regexing the
 * source was the old check, and it passes just as happily on a typo'd flag as
 * on a correct one, which is the same trap cursor.test.ts already avoids by
 * asserting on the config it writes rather than the code that writes it.
 *
 * Each flag is load-bearing:
 *
 *  - `--tools "ToolSearch"` cuts the built-in set down to one schema-lookup tool.
 *    The design doc called for a denylist (`--disallowedTools Bash Edit Write
 *    Read`); that was written POSIX-first and measurably failed — a spawned
 *    agent still reported PowerShell, Task, Skill, WebFetch and NotebookEdit in
 *    its init event, so "fill in this form" had a shell behind it after all. An
 *    allowlist cannot rot as new tools ship.
 *    ToolSearch has to stay: MCP tools arrive deferred, and it is the only way
 *    to reach them. Measured — with `--tools ""` the agent never sees a single
 *    endo tool. It only fetches schemas, so it grants no new reach itself.
 *    Agent is the second entry, for the reader scout, and it grants no reach
 *    either: a subagent draws from this same pool. Measured 2026-11-01 — a
 *    general-purpose agent spawned under it reported ToolSearch, Agent and the
 *    endo tools, no shell. It costs ~3.2k tokens of schema a turn, mostly
 *    cached; the bench decides whether the scout earns it back.
 *  - `--agents` defines the reader; `--disallowedTools` hides the built-in
 *    agent types (see READER and BUILTIN_AGENTS above).
 *  - `--allowedTools "ToolSearch,Agent,mcp__endo__*"` auto-approves all three. Print mode
 *    with only `mcp__endo__*` leaves ToolSearch visible but uncallable — the
 *    model then pastes fake `<function_calls>` XML as text and exits in one
 *    turn. Measured 2026-08-01 against claude 2.1.170.
 *  - `--strict-mcp-config` keeps the operator's own MCP servers out of reach.
 *  - `--setting-sources ""` loads no user/project settings, so local hooks and
 *    CLAUDE.md do not end up as context in a browser agent. Worth real money:
 *    with them loaded a one-tool task billed 33k tokens of unrelated preamble.
 *
 *  - `--resume <id>` continues an existing transcript instead of starting one.
 *    Every other flag is still passed alongside it: resuming restores the
 *    conversation, NOT the tool restrictions, so a resumed run that dropped
 *    `--tools` would hand a browser agent a shell. Verified by running a
 *    resumed task and reading its init event, not by reading this comment.
 *
 * Deliberately NOT `--bare`, which also skips hooks but forces auth to
 * ANTHROPIC_API_KEY — the whole point here is to run on an existing subscription.
 */
export const claudeArgs = (model: string, resume?: string): string[] => [
  // No prompt here: it arrives on stdin (runClaude), the channel a message
  // typed mid-run also comes down. It also keeps page titles and the user's
  // words out of argv, which any process listing on the machine shows.
  "-p",
  "--input-format",
  "stream-json",
  // Sonnet is the default the panel offers: browser driving is
  // snapshot-read-click, not hard reasoning, and the earlier Opus runs billed
  // ~20x for it. index.ts allowlists what may arrive here.
  "--model",
  model,
  // claude's own answer to an overloaded model: the turn retries on another,
  // and the next user turn goes back to the first. A usage limit is not this:
  // measured with it set, a model refused for credits still ended the run, so
  // limits stay failover.ts's.
  "--fallback-model",
  model === "claude-sonnet-5-5" ? "claude-haiku-5-5" : "claude-sonnet-5-5",
  // Before --allowedTools, which is variadic and swallows whatever follows it.
  ...(resume ? ["--resume", resume] : []),
  "--output-format",
  "stream-json",
  "--verbose", // stream-json refuses to run without it
  "--append-system-prompt",
  BRIEFING,
  "--mcp-config",
  CONFIG_PATH,
  "--strict-mcp-config",
  "--setting-sources",
  "",
  "--agents",
  JSON.stringify(READER),
  // Variadic like --allowedTools; the flag after it ends the list.
  "--disallowedTools",
  BUILTIN_AGENTS.map((name) => `Agent(${name})`).join(","),
  "--tools",
  "ToolSearch,Agent",
  // Variadic, so it stays last or it swallows whatever follows.
  "--allowedTools",
  "ToolSearch,Agent,mcp__endo__*",
];

/**
 * The reader subagent is starting or handing back. It and the main model share
 * the panel's delta baseline but not their contexts, so whichever reads next
 * must get a whole page, not "unchanged" against a page it never read. Either
 * side needs a model turn before its first call; this takes milliseconds.
 *
 * Through the bridge's /forget route, not a direct call: the bench runs this
 * adapter in a process of its own, and the route is the one door both share.
 * Fire and forget: a lost reset costs one confusing delta, never data.
 */
function forget(run: string): void {
  let url: URL;
  try {
    url = new URL(JSON.parse(readFileSync(CONFIG_PATH, "utf8")).mcpServers.endo.url);
  } catch {
    return;
  }
  url.pathname = "/forget";
  url.searchParams.set("run", run);
  fetch(url, { method: "POST" }).catch(() => {});
}

/** A running CLI. `steer` reaches it mid-run where the CLI can take that: claude only. */
export type Run = ChildProcess & { steer?: (text: string) => boolean };

/** One user message in `--input-format stream-json`. */
export const userLine = (text: string) => `${JSON.stringify({ type: "user", message: { role: "user", content: text } })}\n`;

/**
 * What an event says went wrong, in claude's words, or null. A refused
 * request is a synthetic assistant message carrying `error` (`rate_limit` for
 * a usage limit, test/fixtures/claude-limit.jsonl), then an `is_error` result
 * with the same text; stderr stays empty and the exit code is 1, so without
 * this the panel said only "claude exited 1".
 */
export function errorIn(event: Record<string, unknown>): { text: string; limit: boolean } | null {
  if (event.type === "assistant" && typeof event.error === "string") {
    const content = (event.message as { content?: unknown } | undefined)?.content;
    const text = Array.isArray(content) ? content.map((c) => (c as { text?: unknown })?.text ?? "").join("") : "";
    return { text: text || event.error, limit: event.error === "rate_limit" };
  }
  if (event.type === "result" && event.is_error === true && typeof event.result === "string") {
    return { text: event.result, limit: event.api_error_status === 429 };
  }
  return null;
}

/**
 * Spawn `claude -p` with browser tools and nothing else. Pass `resume` to
 * continue a previous run's transcript rather than starting a fresh one.
 *
 * No `shell: true`: claude resolves to a real .exe, and a shell here would turn
 * a prompt containing quotes into a command-injection surface.
 */
export function runClaude(
  prompt: string,
  model: string,
  onEvent: (event: Record<string, unknown>) => void,
  resume?: string,
  run = "",
): Run {
  const child = spawn(
    "claude",
    claudeArgs(model, resume),
    // Somewhere with no CLAUDE.md, belt to --setting-sources' braces.
    // Background tasks off: a backgrounded reader would drive the tab while the
    // main model does. Measured: with this set, `run_in_background` leaves the
    // Agent schema and a reader asked to run in the background ran in front.
    {
      cwd: tmpdir(),
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: "1", ENDO_RUN: run },
    },
  );

  // The prompt, and then whatever the user types while the run goes. Measured
  // 2026-11-02 (claude 2.1.280): a message written mid-turn reaches the model
  // at its next tool result, inside the same turn, and it changed course there.
  // A pipe to a child that has exited errors, and an unheard stream error
  // takes the whole bridge down.
  child.stdin.on("error", () => {});
  child.stdin.write(userLine(prompt));
  const steer = (text: string) => {
    if (child.stdin.writableEnded || child.stdin.destroyed) return false;
    child.stdin.write(userLine(text));
    return true;
  };

  let failure: { text: string; limit: boolean } | null = null;
  // readline does the line framing — NDJSON arrives split across chunks.
  createInterface({ input: child.stdout }).on("line", (line) => {
    if (!line.trim()) return;
    // Parsing is not proof of an event: `null`, a number and a string are all
    // valid JSON, and everything downstream reads properties off this. A bare
    // `null` line used to reach sessionOf() and kill the whole bridge.
    let event;
    try { event = JSON.parse(line); } catch {}
    if (!event || typeof event !== "object") return onEvent({ type: "stray", text: line });
    if (event.type === "system" && (event.subtype === "task_started" || event.subtype === "task_notification")) forget(run);
    failure = errorIn(event) ?? failure;
    // stdin open is claude waiting for the next message. A result with nothing
    // queued behind it is the run's end, so close it and let claude exit; a
    // message it already queued is in the pipe ahead of the close.
    if (event.type === "result" && !event.queued_turn_count) child.stdin.end();
    onEvent(event);
  });

  let stderr = "";
  child.stderr.on("data", (chunk) => (stderr += chunk));
  child.on("error", (err) =>
    onEvent({ type: "failed", error: `could not start claude: ${err.message}` }),
  );
  child.on("close", (code) =>
    onEvent({
      type: "done",
      code,
      ...(code === 0 && !failure ? {} : { error: failure?.text || stderr.trim() || `claude exited ${code}` }),
      ...(failure?.limit ? { limit: true } : {}),
    }),
  );

  return Object.assign(child, { steer });
}
