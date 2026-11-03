import { test } from "node:test";
import assert from "node:assert/strict";
import { setPanel, dropPanel, settle, settleGate, callPanel, askPanel, panelConnected, sendPanel } from "../src/relay.ts";

// Enough of a WebSocket for the relay: it only ever reads readyState and sends.
function fakePanel() {
  const sent: Record<string, unknown>[] = [];
  return { readyState: 1, send: (raw: string) => sent.push(JSON.parse(raw)), sent };
}

test("routes an answer back to the call that is waiting for it", async () => {
  const panel = fakePanel();
  setPanel(panel as never);

  const first = callPanel("snapshot", {});
  const second = callPanel("click", { ref: "@f1e4" });
  assert.equal(panel.sent.length, 2);

  // Answered out of order on purpose — ids, not arrival order, decide.
  settle({ id: panel.sent[1].id as number, ok: true, value: "clicked" });
  settle({ id: panel.sent[0].id as number, ok: true, value: "the page" });

  assert.equal(await second, "clicked");
  assert.equal(await first, "the page");
  dropPanel(panel as never);
});

test("a tool failure rejects with the panel's own reason", async () => {
  const panel = fakePanel();
  setPanel(panel as never);
  const call = callPanel("click", { ref: "@f9e9" });
  settle({ id: panel.sent[0].id as number, ok: false, error: "unknown ref @f9e9" });
  await assert.rejects(call, /unknown ref @f9e9/);
  dropPanel(panel as never);
});

test("calls in flight fail when the panel goes away", async () => {
  const panel = fakePanel();
  setPanel(panel as never);
  const call = callPanel("snapshot", {});
  dropPanel(panel as never);
  await assert.rejects(call, /disconnected/);
  assert.equal(panelConnected(), false);
});

test("refuses to call at all with no panel connected", async () => {
  await assert.rejects(callPanel("snapshot", {}), /no side panel connected/);
});

test("task events follow the panel that reconnected, not the one that started the run", () => {
  // The bug this pins down: startTask captured the socket that sent the `task`
  // message, so a panel that dropped and came back mid-run received nothing for
  // the rest of the task while every tool call still worked. Reconnect logic in
  // the panel is decoration unless the send resolves the socket at call time.
  const first = fakePanel();
  const second = fakePanel();
  setPanel(first as never);
  setPanel(second as never);

  assert.equal(sendPanel({ type: "task-event", event: { type: "assistant" } }), true);
  assert.equal(first.sent.length, 0);
  assert.equal(second.sent.length, 1);
  assert.equal(second.sent[0].type, "task-event");
  dropPanel(second as never);
});

test("sendPanel reports failure rather than throwing with no panel", () => {
  assert.equal(sendPanel({ type: "task-event", event: {} }), false);
});

test("ignores an answer to a call that no longer exists", () => {
  const panel = fakePanel();
  setPanel(panel as never);
  // A late reply after a timeout must not throw or resolve anything.
  assert.doesNotThrow(() => settle({ id: 9999, ok: true, value: "too late" }));
  dropPanel(panel as never);
});

// The Obstacle card asks the human to solve something, not to allow it, so it
// renames the buttons; the answer is still the gate's yes or no.
test("a gate can rename its buttons, and one that does not sends no labels", async () => {
  const panel = fakePanel();
  setPanel(panel as never);
  const solved = askPanel("solve the captcha", { ok: "Continue", no: "Stop" });
  const plain = askPanel("click Submit");
  assert.equal(panel.sent[0].ok, "Continue");
  assert.equal(panel.sent[0].no, "Stop");
  assert.ok(!("ok" in panel.sent[1]) && !("no" in panel.sent[1]));
  settleGate({ id: panel.sent[0].id as number, approved: true });
  settleGate({ id: panel.sent[1].id as number, approved: false });
  assert.equal(await solved, true);
  assert.equal(await plain, false);
  dropPanel(panel as never);
});
