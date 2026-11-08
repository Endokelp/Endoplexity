import { test } from "node:test";
import assert from "node:assert/strict";
import { remember } from "../src/page.ts";
import { dropPanel, setPanel, settle, settleGate } from "../src/relay.ts";
import { relay, setMode } from "../src/mcp.ts";
import { audited, auditMarkdown, initAudit, resetAudit } from "../src/audit.ts";
import { guard } from "../src/second.ts";

// Its own file: the audit reads the tab's URL before every action once it is
// on, and node runs each test file in a process of its own.
initAudit();

const TAB = '* id 1 — "Sign in" https://bank.example/login';
const PAGE = ['@f0e1 [textbox] "Password"', '@f0e2 [textbox] "Name"', '@f0e3 [button] "Send `payment` [now](https://evil.test)"'].join("\n");
const meta = { task: ["Log in with password hunter22 and pay the bill"], engines: ["claude-sonnet-5-5"], mode: "normal", drawn: [], approved: [], second: true };

function panel() {
  const sent: Record<string, any>[] = [];
  const answers: Record<string, string> = { tabs: TAB, type: "typed", label: '[button] "Send `payment` [now](https://evil.test)"', click: '[heading] "Sent"' };
  return {
    readyState: 1,
    sent,
    send(raw: string) {
      const m = JSON.parse(raw);
      sent.push(m);
      if (m.type === "tool" && m.name in answers) queueMicrotask(() => settle({ id: m.id, ok: true, value: answers[m.name] }));
    },
  };
}
const flush = () => new Promise((r) => setTimeout(r, 5));

test("the export reads on its own: tab, tool, element, values with secrets redacted, and the gate with its verdict", async () => {
  resetAudit();
  remember(PAGE);
  setMode("normal");
  guard(() => ({ engine: "claude-sonnet-5-5", task: meta.task }), async () => ({ verdict: "warn", reason: "Check the `amount` first." }));
  const p = panel();
  setPanel(p as never);
  await relay("type", { ref: "@f0e1", text: "hunter22" });
  await relay("type", { ref: "@f0e2", text: "Ada" });
  const click = relay("click", { ref: "@f0e3" });
  let gate;
  for (let i = 0; i < 50 && !(gate = p.sent.find((m) => m.type === "gate")); i++) await flush();
  settleGate({ id: gate!.id, approved: false });
  await click;
  guard(null);
  dropPanel(p as never);

  const { name, markdown } = auditMarkdown(meta);
  assert.match(name, /^endoplexity-audit-\d{4}-\d{2}-\d{2}-\d{4}\.md$/);
  assert.equal(markdown.includes("hunter22"), false, "a password reached the audit file");
  assert.match(markdown, /\*\*type\*\* `\[textbox\] "Password"` with `\(redacted\)` on `https:\/\/bank\.example\/login`: `ok`/);
  assert.match(markdown, /with `Ada`/);
  assert.match(markdown, /> Log in with password \(redacted\) and pay the bill/);
  assert.match(markdown, /second key \(gpt-6\.1-sol\): \*\*warn\*\*, `Check the 'amount' first\.`/);
  assert.match(markdown, /the human: \*\*denied\*\*/);
  assert.match(markdown, /3 actions, 1 approvals asked, 1 denied/);
  // Page text stays in code spans: a label cannot close one and render a link.
  const clickLine = markdown.split("\n").find((l) => l.includes("**click**"))!;
  assert.equal(clickLine.split("`").length % 2, 1, "an odd number of backticks: the label broke out of its code span");
});

test("a fresh task starts an empty log", () => {
  resetAudit();
  assert.match(auditMarkdown(meta).markdown, /No actions were taken\./);
  assert.match(auditMarkdown(meta).markdown, /- Plan: any site\n/);
  assert.match(auditMarkdown({ ...meta, drawn: ["example.com"], approved: ["127.0.0.1"] }).markdown, /- Plan: example\.com; approved during the run: 127\.0\.0\.1\n/);
});

test("a secret is hidden everywhere in the export, not only in the task", () => {
  resetAudit();
  const at = { url: "https://bank.example/login", tool: "type", result: "ok" };
  audited({ ...at, on: '[textbox] "Password"', value: "hunter22" }, true);
  audited({ ...at, on: '[textbox] "Confirm password"', value: "hunter22" });
  const { markdown } = auditMarkdown(meta);
  assert.equal(markdown.includes("hunter22"), false);
  resetAudit();
});
