import { spawn, type ChildProcess } from "node:child_process";
import { createInterface } from "node:readline";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { BRIEFING_CORE } from "./claude.ts";

/**
 * A bridge-owned Codex home, deliberately not `~/.codex`.
 *
 * `--ignore-user-config` drops config.toml (plugins, the operator's MCP servers)
 * but not `$CODEX_HOME/AGENTS.md`, which Codex injects into every run as user
 * instructions and which no config key turns off. Measured 2026-11-01 with
 * `codex debug prompt-input` from a temp dir: the operator's whole personal
 * operating contract, 3.6k characters, in front of a browser task. A browser
 * agent reading untrusted pages must not be steered by the operator's notes to
 * themselves, so it gets a home of its own and its own login, as cursor does.
 *
 * Outside the repo on purpose — `npm run codex-login` puts a real session in here.
 */
export const CODEX_HOME = join(homedir(), ".endo-codex");

/**
 * npm installs Codex as a `.cmd` shim that runs `codex.js`, which spawns the
 * native `codex.exe` from a platform package. Node cannot spawn a `.cmd`
 * without `shell: true`, and a shell would re-parse the prompt, so run the exe
 * the shim ends at — the same move `resolveCursor()` makes.
 *
 * ponytail: x64 Windows only; arm64 Windows falls through to PATH and fails to
 * spawn with a named error. Add the arm64 triple when someone has one.
 */
export function resolveCodex(): string {
  if (process.platform !== "win32") return "codex";
  const exe = join(
    process.env.APPDATA ?? "",
    "npm/node_modules/@openai/codex/node_modules/@openai/codex-win32-x64/vendor/x86_64-pc-windows-msvc/bin/codex.exe",
  );
  return existsSync(exe) ? exe : "codex";
}

/**
 * Codex 0.160.1 turns on its own shell and its own browsers by default. Each of
 * these is a way to act outside the gate, or to read the disk behind it, so
 * each is switched off by name. A denylist, unlike claude's `--tools`
 * allowlist, rots as Codex ships new features — which is why runCodex also
 * kills any run that reports an item that is not an endo call or text.
 */
export const FEATURES_OFF = [
  "shell_tool",
  "unified_exec",
  "browser_use",
  "browser_use_external",
  "browser_use_full_cdp_access",
  "computer_use",
  "in_app_browser",
  "apps",
  "plugins",
  "hooks",
  // NOT code_mode_host: every model in the 0.160.1 catalog is
  // `tool_mode: "code_mode_only"`, so with the host off the model has no
  // working way to call anything, endo included. The host is a JS isolate with
  // no require, process, fetch, WebSocket or import (probed 2026-11-01), so it
  // reaches only the `tools.*` namespace — which is the boundary that matters.
  "multi_agent",
  "view_image",
  "image_generation",
  "tool_suggest",
  "skill_search",
  "skill_mcp_dependency_install",
];

// TOML basic strings take JSON's escapes, so JSON.stringify is a correct encoder.
const str = JSON.stringify;

/**
 * The whole boundary, as the config.toml of a home only the bridge uses.
 * Overwritten at every start, never merged: isolation is the point, and login
 * keeps its session in auth.json beside it, not in here.
 *
 * In a file rather than in `-c` flags so the token is never on a command line
 * and a resume (`codex exec resume`) reads the same restrictions as the run it
 * resumes without anyone remembering to pass them again.
 *
 *  - `tool_timeout_sec`: a gated call waits up to 60s for the human and then up
 *    to 30s for the panel (relay.ts), and Codex gives an MCP call 60s by
 *    default. The default would fail the approved click it was waiting for.
 *  - `skills.include_instructions`: `~/.agents/skills` resolves off the OS
 *    profile, not $HOME, so no sandbox keeps it out. This drops the 22k
 *    characters of skill listings it put in front of every task.
 *  - `default_tools_approval_mode = "approve"`: with `approval_policy =
 *    "never"`, Codex refuses any MCP call it would have asked about ("MCP tool
 *    call requires approval, but approval policy is never" — every endo call,
 *    measured). This is cursor's `Mcp(endo:*)` allow; the gate in the bridge,
 *    not Codex, is what stops an irreversible click.
 *  - `agents.enabled`: the catalog sets `multi_agent_version: "v2"` per model,
 *    which `features.multi_agent = false` does not reach. Left on, the model
 *    gets spawn_agent — a second driver fighting the first over one tab.
 */
export function writeCodexConfig(port: number, token: string, dir: string = CODEX_HOME): string {
  mkdirSync(dir, { recursive: true });
  const toml = [
    "# Written by the Endoplexity bridge at every start. Edits are overwritten.",
    `sandbox_mode = "read-only"`,
    `approval_policy = "never"`,
    `web_search = "disabled"`,
    `developer_instructions = ${str(BRIEFING_CORE)}`,
    "",
    "[features]",
    ...FEATURES_OFF.map((name) => `${name} = false`),
    "",
    "[skills]",
    "include_instructions = false",
    "",
    "[agents]",
    "enabled = false",
    "",
    "[mcp_servers.endo]",
    `url = ${str(`http://127.0.0.1:${port}/mcp?token=${encodeURIComponent(token)}`)}`,
    // The run the calls belong to (run.ts): Codex sends this header with the
    // value of ENDO_RUN, which the spawn sets.
    `env_http_headers = { "X-Endo-Run" = "ENDO_RUN" }`,
    "tool_timeout_sec = 120",
    `default_tools_approval_mode = "approve"`,
    "",
  ].join("\n");
  writeFileSync(join(dir, "config.toml"), toml, { mode: 0o600 });
  return dir;
}

/**
 * The args for `codex exec`, exported so a test can assert on them without
 * spawning. The boundary is the config file above; these only make the run
 * non-interactive and machine-readable.
 *
 *  - `--strict-config` refuses a config.toml key this Codex does not know. A
 *    feature renamed in an update would otherwise be ignored silently and come
 *    back on; this way the run fails closed with the key named.
 *  - `--skip-git-repo-check`: the run's cwd is the temp dir, not a repo.
 *  - `--` before the positionals, because a reply is raw user text and one
 *    that starts with `-` would otherwise be parsed as a flag.
 *  - Resume is `exec resume <id>`; it re-reads the same config.toml, so it is
 *    held to the same boundary without the flags having to be repeated.
 */
export const codexArgs = (prompt: string, model: string, resume?: string): string[] => [
  "exec",
  ...(resume ? ["resume"] : []),
  "--json",
  "--strict-config",
  "--skip-git-repo-check",
  "-m",
  model,
  "--",
  ...(resume ? [resume] : []),
  prompt,
];

/**
 * The item types a browser run may produce. An allowlist, so a tool kind Codex
 * ships next month is refused without anyone having to name it here.
 */
const ALLOWED_ITEMS = new Set(["agent_message", "reasoning", "mcp_tool_call", "todo_list", "error"]);

/** True for an item that means Codex reached past the endo tools. */
export const outside = (item: Record<string, unknown>): boolean =>
  !ALLOWED_ITEMS.has(String(item.type)) || (item.type === "mcp_tool_call" && item.server !== "endo");

/**
 * Codex's JSONL onto the claude shapes index.ts, the panel and the bench
 * already read, so none of them grows a third branch. Shapes taken from real
 * runs (test/fixtures/codex-run.jsonl), not from documentation.
 *
 * Usage is re-spelled as well as renamed: OpenAI counts cached tokens INSIDE
 * `input_tokens`, claude counts them beside it, and adding the two the panel's
 * way would bill every cached token twice.
 *
 * Anything else passes through untouched: index.ts logs it and the panel
 * ignores types it does not know.
 */
export function codexEvents(model: string) {
  let last = ""; // the result event repeats the final message, as claude's does
  // Codex reports no duration, and the panel's chip reads a missing one as 0s.
  const started = Date.now();
  return (event: Record<string, unknown>): Record<string, unknown> => {
    const item = (event.item ?? {}) as Record<string, unknown>;
    if (event.type === "thread.started") return { type: "system", subtype: "init", session_id: event.thread_id, model };
    if (event.type === "item.completed" && item.type === "agent_message") {
      last = String(item.text ?? "");
      return { type: "assistant", message: { content: [{ type: "text", text: last }] } };
    }
    if (event.type === "item.started" && item.type === "mcp_tool_call") {
      const name = `mcp__${item.server}__${item.tool}`;
      return { type: "assistant", message: { content: [{ type: "tool_use", name, input: item.arguments }] } };
    }
    if (event.type === "turn.completed") {
      const u = (event.usage ?? {}) as Record<string, number>;
      const cached = u.cached_input_tokens ?? 0;
      return {
        type: "result",
        result: last,
        duration_ms: Date.now() - started,
        usage: {
          input_tokens: (u.input_tokens ?? 0) - cached,
          cache_read_input_tokens: cached,
          output_tokens: u.output_tokens ?? 0,
        },
      };
    }
    return event;
  };
}

export const API_KEYS = ["CODEX_API_KEY", "OPENAI_API_KEY"];

/**
 * The bridge's environment without either API-key variable: `codex exec` bills
 * CODEX_API_KEY in preference to the login, and this product runs on the
 * subscription. Compared upper-cased because Windows looks env names up
 * case-insensitively, so an `OpenAI_Api_Key` the operator set would still be
 * found by the child. The second key's judge (second.ts) spawns with it too.
 */
export const codexEnv = () =>
  Object.fromEntries(Object.entries(process.env).filter(([key]) => !API_KEYS.includes(key.toUpperCase())));

/**
 * Spawn `codex exec` restricted to the browser tools. Pass `resume` to continue
 * a previous run's thread rather than starting a fresh one.
 */
export function runCodex(
  prompt: string,
  model: string,
  onEvent: (event: Record<string, unknown>) => void,
  resume?: string,
  run = "",
): ChildProcess {
  const child = spawn(resolveCodex(), codexArgs(prompt, model, resume), {
    cwd: tmpdir(),
    windowsHide: true,
    // stdin ignored: exec otherwise waits on "Reading additional input from stdin".
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...codexEnv(), CODEX_HOME, ENDO_RUN: run },
  });

  const toPanel = codexEvents(model);
  // Why the run ended badly, if it did. stderr is no use for this: under --json
  // it carries Codex's log lines (a malformed skill elsewhere on disk, say), so
  // reporting it would name the wrong problem.
  let failure = "";
  createInterface({ input: child.stdout }).on("line", (line) => {
    if (!line.trim()) return;
    let event;
    try { event = JSON.parse(line); } catch {}
    if (!event || typeof event !== "object") return onEvent({ type: "stray", text: line });

    const item = event.item as Record<string, unknown> | undefined;
    if (item && outside(item)) {
      // A tripwire behind FEATURES_OFF, not instead of it: by the time this
      // reads `item.started` the action may be under way. It exists so that a
      // Codex update which re-enables a tool cannot go on doing so unnoticed.
      failure = `codex reached outside the browser tools (${item.type}${item.server ? ` on ${item.server}` : ""}) — run killed`;
      child.kill();
    }
    if (event.type === "turn.failed") failure = String((event.error as { message?: unknown })?.message ?? "turn failed");
    onEvent(toPanel(event));
  });

  let stderr = "";
  child.stderr.on("data", (chunk) => (stderr += chunk));
  child.on("error", (err) => onEvent({ type: "failed", error: `could not start codex: ${err.message}` }));
  child.on("close", (code) =>
    onEvent({
      type: "done",
      code,
      ...(code === 0 && !failure ? {} : { error: failure || stderr.trim() || `codex exited ${code}` }),
    }),
  );

  return child;
}
