import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { cursorArgs, writeCursorConfig } from "../src/cursor.ts";

// cursor-agent has no --allowedTools, so the whole restriction is this file.
// These assert on what writeCursorConfig actually produces rather than on the
// source text: a typo'd permission token is still valid JSON and would otherwise
// disable the boundary silently.
const seed = () => {
  const dir = mkdtempSync(join(tmpdir(), "endo-cursor-test-"));
  writeCursorConfig(4242, "s3cret", dir);
  return dir;
};

const read = (dir: string, name: string) => JSON.parse(readFileSync(join(dir, name), "utf8"));

test("shell, write and read are denied and only endo's tools are allowed", () => {
  const { permissions, approvalMode } = read(seed(), "cli-config.json");
  assert.deepEqual(permissions.allow, ["Mcp(endo:*)"]);
  for (const token of ["Shell(*)", "Write(*)", "Read(*)"]) {
    assert.ok(permissions.deny.includes(token), `${token} must be denied`);
  }
  assert.equal(approvalMode, "allowlist");
});

test("the isolated profile exposes endo and nothing the operator configured", () => {
  // Under the sandboxed HOME, not the config dir: cursor resolves mcp.json off
  // homedir(), so writing it beside cli-config.json leaves the operator's own
  // servers loaded and endo unreachable. Measured, not assumed.
  const { mcpServers } = read(seed(), join("home", ".cursor", "mcp.json"));
  assert.deepEqual(Object.keys(mcpServers), ["endo"]);
  assert.match(mcpServers.endo.url, /^http:\/\/127\.0\.0\.1:4242\/mcp\?token=s3cret$/);
  // cursor expands this from the env each spawn sets: the call names its run (run.ts).
  assert.deepEqual(mcpServers.endo.headers, { "X-Endo-Run": "${env:ENDO_RUN}" });
});

test("rewriting the config keeps the session cursor-agent login stored beside it", () => {
  const dir = seed();
  const path = join(dir, "cli-config.json");
  writeFileSync(path, JSON.stringify({ ...read(dir, "cli-config.json"), session: "keep-me" }));
  writeCursorConfig(4242, "s3cret", dir);
  assert.equal(read(dir, "cli-config.json").session, "keep-me");
});

test("a corrupt config is rewritten rather than crashing the bridge at startup", () => {
  const dir = seed();
  writeFileSync(join(dir, "cli-config.json"), "{ not json");
  writeCursorConfig(4242, "s3cret", dir);
  assert.deepEqual(read(dir, "cli-config.json").permissions.allow, ["Mcp(endo:*)"]);
});

const args = (resume?: string) => cursorArgs("do a thing", "composer-2.5", resume);
const promptOf = (argv: string[]) => argv[argv.indexOf("-p") + 1];

test("a fresh run briefs the agent and resumes nothing", () => {
  const argv = args();
  assert.ok(!argv.includes("--resume"));
  assert.match(promptOf(argv), /^You drive a real web browser\..*do a thing$/);
});

test("a reply resumes the chat and drops the briefing already in its transcript", () => {
  const argv = args("chat-9");
  assert.equal(argv[argv.indexOf("--resume") + 1], "chat-9");
  assert.equal(promptOf(argv), "do a thing");
});

// Same reason as claude's boundary test: resuming restores the conversation, and
// everything that makes the run non-interactive has to be passed again with it.
test("resuming still auto-approves endo and trusts the workspace", () => {
  for (const flag of ["--approve-mcps", "--trust"]) {
    assert.ok(args("chat-9").includes(flag), `${flag} must survive a resume`);
  }
});

// Comments here quote the very flags and options these tests forbid — explaining
// why `shell: true` is absent otherwise reads as `shell: true` being present.
const code = readFileSync(fileURLToPath(new URL("../src/cursor.ts", import.meta.url)), "utf8")
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .replace(/\/\/.*/g, "");

test("--force/--yolo never reaches the spawn — it would undo the permission set", () => {
  assert.doesNotMatch(code, /--force|--yolo/);
});

test("no shell: a .cmd shim would put the prompt back on a command line", () => {
  assert.doesNotMatch(code, /shell:\s*true/);
});

test("the spawn sandboxes HOME too, or mcp.json resolves to the operator's own", () => {
  for (const key of ["CURSOR_CONFIG_DIR", "USERPROFILE", "HOME"]) {
    assert.match(code, new RegExp(`${key}:`), `${key} must be pinned on the spawn`);
  }
});
