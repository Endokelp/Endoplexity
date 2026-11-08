import { test } from "node:test";
import assert from "node:assert/strict";
import { report } from "../src/mcp.ts";

test("a hand-off never carries a secret's value, only its placeholder and who has it", () => {
  const skill = {
    name: "login",
    host: "example.com",
    task: "log in",
    saved: "2026-01-01",
    vars: { email: "me@example.com", password: "" },
    steps: [
      { do: "type", target: { label: '[textbox] "Email"' }, text: "{{email}}" },
      { do: "type", target: { label: '[textbox] "Password"' }, text: "{{password}}" },
    ],
  };
  const out = report({
    skill: skill as never,
    vars: { email: "you@example.com", password: "hunter22-secret" },
    ran: 0,
    of: 2,
    stop: { at: 0, why: "the page changed", final: false },
  });
  assert.doesNotMatch(out, /hunter22-secret/);
  assert.match(out, /\{\{password\}\} is the user's secret, ask them for it/);
  assert.match(out, /type "\{\{password\}\}"/);
  assert.match(out, /email = "you@example\.com"/, "ordinary values still travel");
});
