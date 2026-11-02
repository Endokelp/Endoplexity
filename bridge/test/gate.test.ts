import { test } from "node:test";
import assert from "node:assert/strict";
import { delta, serialize, UNCHANGED } from "../../extension/ax.js";
import { remember, labelFor } from "../src/page.ts";
import { check, rememberApproval, resetApprovals } from "../src/gate.ts";
import { askPanel, setPanel, dropPanel, panelConnected, settle, settleGate } from "../src/relay.ts";
import { relay } from "../src/mcp.ts";

// Minimal stand-in for Accessibility.getFullAXTree nodes — same shape ax.test.ts
// uses, trimmed to the fields a role/name-only page needs. Real serialize()
// output is the point: if its line format ever drifts, this test breaks instead
// of the gate silently never matching a real page again.
const node = (nodeId: string, role: string, extra: { name?: string; backendDOMNodeId?: number; childIds?: string[] } = {}) => ({
  nodeId,
  ignored: false,
  role: { value: role },
  name: { value: extra.name ?? "" },
  ...(extra.backendDOMNodeId === undefined ? {} : { backendDOMNodeId: extra.backendDOMNodeId }),
  childIds: extra.childIds ?? [],
  properties: [],
});

// One irreversible action and one ordinary one on the same page, so a single
// remember() covers both branches of check().
const page = () => [
  node("1", "RootWebArea", { name: "Apply", childIds: ["2", "3"] }),
  node("2", "button", { name: "Submit Application", backendDOMNodeId: 11 }),
  node("3", "link", { name: "Read more", backendDOMNodeId: 12 }),
];

// A consent wall whose only control is "Accept all cookies" — the case the
// IRREVERSIBLE regex must no longer catch, since accept/agree came out of it.
const cookiePage = () => [
  node("1", "RootWebArea", { name: "Consent", childIds: ["2"] }),
  node("2", "button", { name: "Accept all cookies", backendDOMNodeId: 11 }),
];

// Enough of a WebSocket for the relay — same fake relay.test.ts uses.
function fakePanel() {
  const sent: Record<string, unknown>[] = [];
  return { readyState: 1, send: (raw: string) => sent.push(JSON.parse(raw)), sent };
}

test("gates a click whose label reads as irreversible", () => {
  const { text, refs } = serialize(page(), "f0");
  remember(text);
  const [submitRef] = refs.keys();
  assert.equal(check("click", { ref: submitRef }), `click ${submitRef} [button] "Submit Application"`);
  // Only click is gated — the same ref through any other tool is nobody's business.
  assert.equal(check("navigate", { ref: submitRef }), null);
});

test("lets an ordinary click through", () => {
  const { text, refs } = serialize(page(), "f0");
  remember(text);
  const [, linkRef] = refs.keys();
  assert.equal(check("click", { ref: linkRef }), null);
});

test("does not gate a ref that is not on the current page", () => {
  const { text } = serialize(page(), "f0");
  remember(text);
  // Stale or invented — the panel will reject it with "unknown/stale ref" on
  // its own, so there is nothing here worth blocking a human's time over.
  assert.equal(check("click", { ref: "@f0e999" }), null);
});

test("a 60s timeout denies without an answer", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const panel = fakePanel();
  setPanel(panel as never);

  const approved = askPanel('click @f0e38 [button] "Submit Application"');
  assert.equal(panel.sent.length, 1);
  assert.equal(panel.sent[0].type, "gate");

  t.mock.timers.tick(60_000);
  assert.equal(await approved, false);
  dropPanel(panel as never);
});

// The path that has to work. A broken settleGate looks exactly like a working
// one until you notice every approval sat for 60s and then denied itself.
test("an approved click is released to the panel", async () => {
  const { text, refs } = serialize(page(), "f0");
  remember(text);
  const [submitRef] = refs.keys();
  const panel = fakePanel();
  setPanel(panel as never);
  const flush = () => new Promise((r) => setImmediate(r));

  const result = relay("click", { ref: submitRef });
  await flush();
  // The gate decides on the element as it is now, read first (mcp.ts readFor).
  const read = panel.sent.find((m) => m.name === "label");
  assert.ok(read, "the click was weighed without reading what it lands on");
  settle({ id: read.id as number, ok: true, value: '[button] "Submit Application"' });
  await flush();
  const gate = panel.sent.find((m) => m.type === "gate");
  assert.ok(gate, "the click was relayed without ever asking");

  settleGate({ id: gate.id as number, approved: true });
  await flush();
  const call = panel.sent.find((m) => m.type === "tool" && m.name === "click");
  assert.ok(call, "approval did not release the click");

  settle({ id: call.id as number, ok: true, value: '@f0e1 [heading] "Thanks"' });
  assert.equal((await result).isError, undefined);
  dropPanel(panel as never);
});

test("gates Enter when the page carries a submit-ish control", () => {
  const { text, refs } = serialize(page(), "f0");
  remember(text);
  const [submitRef] = refs.keys();
  assert.equal(
    check("key", { name: "Enter" }),
    `press Enter — this page has ${submitRef} [button] "Submit Application"`,
  );
});

test("does not gate Enter on a page with only benign controls", () => {
  const benign = [
    node("1", "RootWebArea", { name: "Search", childIds: ["2"] }),
    node("2", "searchbox", { name: "Search", backendDOMNodeId: 11 }),
  ];
  const { text } = serialize(benign, "f0");
  remember(text);
  assert.equal(check("key", { name: "Enter" }), null);
});

test("a non-Enter key never gates, even on a page with a submit control", () => {
  const { text } = serialize(page(), "f0");
  remember(text);
  assert.equal(check("key", { name: "Tab" }), null);
});

test("a denied click returns an isError result telling the model not to retry", async () => {
  const { text, refs } = serialize(page(), "f0");
  remember(text);
  const [submitRef] = refs.keys();
  assert.equal(panelConnected(), false); // nothing connected — askPanel auto-denies

  const result = await relay("click", { ref: submitRef });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /do not retry/i);
});

test("a cookie-consent 'Accept all' button is not gated for click", () => {
  const { text, refs } = serialize(cookiePage(), "f0");
  remember(text);
  const [acceptRef] = refs.keys();
  assert.equal(check("click", { ref: acceptRef }), null);
});

test("a cookie-consent page does not gate Enter either", () => {
  const { text } = serialize(cookiePage(), "f0");
  remember(text);
  assert.equal(check("key", { name: "Enter" }), null);
});

test("watch gates a plain type that normal lets through", () => {
  const { text, refs } = serialize(page(), "f0");
  remember(text);
  const [, linkRef] = refs.keys();
  resetApprovals();
  assert.equal(check("type", { ref: linkRef, text: "hi" }), null);
  assert.equal(check("type", { ref: linkRef, text: "hi" }, "watch"), `type ${linkRef} [link] "Read more"`);
});

test("watch does not gate reads: snapshot, tabs, hover, scroll", () => {
  resetApprovals();
  assert.equal(check("snapshot", {}, "watch"), null);
  assert.equal(check("tabs", {}, "watch"), null);
  assert.equal(check("hover", { ref: "@f0e1" }, "watch"), null);
  assert.equal(check("scroll", {}, "watch"), null);
});

test("trust gates nothing, including a submit-labelled click", () => {
  const { text, refs } = serialize(page(), "f0");
  remember(text);
  const [submitRef] = refs.keys();
  assert.equal(check("click", { ref: submitRef }, "trust"), null);
});

test("an unknown or missing mode behaves exactly like normal — never like trust", () => {
  const { text, refs } = serialize(page(), "f0");
  remember(text);
  const [submitRef] = refs.keys();
  const expected = `click ${submitRef} [button] "Submit Application"`;
  assert.equal(check("click", { ref: submitRef }), expected); // mode omitted entirely
  assert.equal(check("click", { ref: submitRef }, undefined), expected);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  assert.equal(check("click", { ref: submitRef }, "yolo" as any), expected);
});

test("in watch, an approved tool stops re-asking for the rest of the task", () => {
  const { text, refs } = serialize(page(), "f0");
  remember(text);
  const [submitRef] = refs.keys();
  resetApprovals();
  assert.ok(check("click", { ref: submitRef }, "watch"));
  rememberApproval("click", { ref: submitRef });
  assert.equal(check("click", { ref: submitRef }, "watch"), null);
  resetApprovals();
});

test("in normal, a submit-labelled click keeps asking even after an approval was recorded", () => {
  const { text, refs } = serialize(page(), "f0");
  remember(text);
  const [submitRef] = refs.keys();
  rememberApproval("click", { ref: submitRef }); // as if watch mode had recorded it
  assert.equal(check("click", { ref: submitRef }), `click ${submitRef} [button] "Submit Application"`);
  resetApprovals();
});

test("labelFor returns the label for a known ref and undefined for an unknown one", () => {
  const { text, refs } = serialize(page(), "f0");
  remember(text);
  const [submitRef] = refs.keys();
  assert.equal(labelFor(submitRef), '[button] "Submit Application"');
  assert.equal(labelFor("@f0e999"), undefined);
});

// ---- deltas ------------------------------------------------------------------
//
// A page return can now be only what CHANGED since the model's last read. The
// gate reads those same returns, so it has to patch its ref->label map rather
// than replace it — the whole point of a form fill is that the Submit button
// does NOT change while the fields around it do.

// A form with enough fields that changing one is a small change — which is the
// only situation a delta is sent in at all.
const bigForm = (fourth: string) => [
  node("1", "RootWebArea", { name: "Apply", childIds: ["2", "3", "4", "5", "6", "7"] }),
  node("2", "button", { name: "Submit Application", backendDOMNodeId: 11 }),
  node("3", "link", { name: "Read more", backendDOMNodeId: 12 }),
  node("4", "textbox", { name: "First name", backendDOMNodeId: 13 }),
  node("5", "textbox", { name: "Last name", backendDOMNodeId: 14 }),
  node("6", "textbox", { name: "Email", backendDOMNodeId: 15 }),
  node("7", "textbox", { name: fourth, backendDOMNodeId: 16 }),
];

test("a delta does not blind the gate to the button that stayed put", () => {
  const before = serialize(bigForm("Phone"), "f0");
  remember(before.text);

  // The agent types into one field; the page comes back as a patch naming that
  // field and nothing else.
  const patch = delta(before.text, serialize(bigForm("Phone (mobile)"), "f0").text)!;
  assert.ok(patch, "a one-field change is exactly the case a delta is for");
  assert.doesNotMatch(patch, /Submit Application/, "the premise: the patch does not mention it");
  remember(patch);

  assert.equal(
    check("click", { ref: "@f0e11" }),
    `click @f0e11 [button] "Submit Application"`,
    "replacing the map with a patch would have let a real submit through ungated",
  );
  // And the patched line is current, not the old label.
  assert.equal(labelFor("@f0e16"), `[textbox] "Phone (mobile)"`);
});

test("a control the delta removed stops being gated", () => {
  remember(serialize(page(), "f0").text);
  remember(`${UNCHANGED}\n- @f0e11 [button] "Submit Application"`);
  assert.equal(check("click", { ref: "@f0e11" }), null, "it is not on the page any more");
});
