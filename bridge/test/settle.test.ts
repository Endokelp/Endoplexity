import { test } from "node:test";
import assert from "node:assert/strict";

// cdp.js registers chrome.debugger listeners at import time; the pure functions
// under test touch none of it.
const noop = { addListener() {} };
(globalThis as any).chrome = { debugger: { onEvent: noop, onDetach: noop } };
// @ts-ignore plain JS module, no declarations
const { settledAt, changedAfter } = await import("../../extension/cdp.js");

type Ev = { t: number; kind: "dom" | "net-start" | "net-end" };
const dom = (t: number): Ev => ({ t, kind: "dom" });

test("an empty window is quiet as soon as the quiet time has passed", () => {
  assert.equal(settledAt(1000, [], 100, 1300), 1100);
});

test("quiet is found after a burst", () => {
  const events = [dom(1010), dom(1040), dom(1090)];
  assert.equal(settledAt(1000, events, 100, 1300), 1190);
});

test("null when a request stays in flight to the end", () => {
  const events: Ev[] = [{ t: 1020, kind: "net-start" }, dom(1030)];
  assert.equal(settledAt(1000, events, 100, 1300), null);
});

test("a finished request lets the page settle after its end", () => {
  const events: Ev[] = [{ t: 1020, kind: "net-start" }, { t: 1150, kind: "net-end" }];
  assert.equal(settledAt(1000, events, 100, 1300), 1250);
});

test("a request already open at the start counts", () => {
  const events: Ev[] = [{ t: 1000, kind: "net-start" }];
  assert.equal(settledAt(1000, events, 100, 1300), null);
});

test("an event exactly at the window edge is outside it", () => {
  // T=1100 looks at (1000, 1100]: an event at 1000 is out, at 1100 is in.
  assert.equal(settledAt(1000, [dom(1000)], 100, 1300), 1100);
  assert.equal(settledAt(1000, [dom(1100)], 100, 1300), 1200);
});

test("null when the quiet time does not fit before until", () => {
  assert.equal(settledAt(1000, [dom(1050), dom(1120), dom(1190), dom(1260)], 100, 1300), null);
  // T exactly at until is allowed.
  assert.equal(settledAt(1000, [], 100, 1100), 1100);
});

test("changedAfter is true when a DOM event lands after T, up to until", () => {
  const events = [dom(1010), dom(1200)];
  const T = settledAt(1000, events, 100, 1300);
  assert.equal(T, 1110);
  assert.equal(changedAfter(T, events, 1300), true);
  assert.equal(changedAfter(T, events, 1150), false); // the 1200 event is past until
  assert.equal(changedAfter(1110, [dom(1110)], 1300), false); // at T, not after
  assert.equal(changedAfter(null, events, 1300), false);
});
