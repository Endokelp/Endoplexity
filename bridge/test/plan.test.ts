import { test } from "node:test";
import assert from "node:assert/strict";
import { remember } from "../src/page.ts";
import { cleanPlan, offPlan, setPlan } from "../src/gate.ts";
import { dropPanel, setPanel, settle, settleGate } from "../src/relay.ts";
import { relay, setMode } from "../src/mcp.ts";

const PAGE = ['@f0e1 [textbox] "Email address"', '@f0e3 [button] "Confirm transfer"'].join("\n");
const TAB = '* id 1 — "Elsewhere" https://evil.test/a';

/** A panel that answers tool calls from `answers` and records every frame. */
function panel(answers: Record<string, string> = {}) {
  const sent: Record<string, any>[] = [];
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
async function gateOf(p: ReturnType<typeof panel>) {
  for (let i = 0; i < 50 && !p.sent.some((m) => m.type === "gate"); i++) await flush();
  return p.sent.find((m) => m.type === "gate");
}

test("the plan, cleaned: hosts only, subdomain and wildcard prefixes dropped, junk refused", () => {
  assert.deepEqual(cleanPlan(["https://Shop.Example.com/cart?x=1", "*.foo.org", "www.bar.net", "", 5, "not a host!!", "foo.org"]), [
    "shop.example.com",
    "foo.org",
    "bar.net",
  ]);
  assert.deepEqual(cleanPlan("example.com"), []);
});

test("off the plan: a navigate away and an action on a page outside it ask; inside, back and a tab switch do not", () => {
  setPlan(["example.com"]);
  assert.equal(offPlan("navigate", { url: "https://jobs.example.com/a" }, ""), null);
  assert.match(offPlan("navigate", { url: "https://evil.test/a" }, "https://example.com")!.asked, /evil\.test is outside this run's plan \(example\.com\)/);
  assert.match(offPlan("click", { ref: "@f0e3" }, "https://evil.test/")!.asked, /^click @f0e3/);
  assert.equal(offPlan("click", { ref: "@f0e3" }, "https://www.example.com/"), null);
  assert.equal(offPlan("back", {}, "https://evil.test/"), null);
  assert.equal(offPlan("use_tab", { id: 3 }, "https://evil.test/"), null);
  assert.equal(offPlan("scroll", {}, "https://evil.test/"), null);
  // Not knowing the site is not knowing it is allowed.
  assert.match(offPlan("type", { ref: "@f0e1" }, "")!.asked, /a site that could not be read/);
  // An example.com lookalike is not a subdomain of it.
  assert.ok(offPlan("navigate", { url: "https://notexample.com/" }, ""));
  setPlan([]);
  assert.equal(offPlan("navigate", { url: "https://evil.test/" }, ""), null);
});

test("the plan holds in trust mode, and an approved host stays approved for the task", async () => {
  remember(PAGE);
  setMode("trust", ["example.com"]);
  const p = panel({ tabs: TAB, navigate: '[heading] "Elsewhere"' });
  setPanel(p as never);
  const first = relay("navigate", { url: "https://evil.test/a" });
  const gate = await gateOf(p);
  assert.ok(gate, "trust let a navigation off the plan through");
  assert.match(gate.action, /evil\.test is outside this run's plan/);
  settleGate({ id: gate.id, approved: true });
  assert.equal((await first).isError, undefined);
  const asks = p.sent.filter((m) => m.type === "gate").length;
  assert.equal((await relay("navigate", { url: "https://www.evil.test/b" })).isError, undefined);
  assert.equal(p.sent.filter((m) => m.type === "gate").length, asks, "asked again about a host already approved");
  // A new task starts from the user's list again.
  setMode("trust", ["example.com"]);
  void relay("navigate", { url: "https://evil.test/c" });
  for (let i = 0; i < 50 && p.sent.filter((m) => m.type === "gate").length === asks; i++) await flush();
  assert.equal(p.sent.filter((m) => m.type === "gate").length, asks + 1);
  dropPanel(p as never);
  setMode("normal");
});
