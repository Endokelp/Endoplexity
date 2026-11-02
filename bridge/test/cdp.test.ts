import { test } from "node:test";
import assert from "node:assert/strict";

// cdp.js is the one extension module that is NOT DOM-free, so unlike ax/md/
// sessions it cannot just be imported: it registers chrome.debugger listeners at
// import time and throws on load without them. Hence the stub below, installed
// ONCE before a dynamic import — a top-level `import` would hoist above the stub,
// and a second stub would never be wired up, because the listeners are only
// registered on the first import.
//
// Scope: dead-OOPIF reaping, and which caller is allowed to OPEN a tab.
// Everything else in cdp.js is verified live by `endo.selftest()`, which drives
// a real Chrome; a stub deep enough to test clicking would only be testing the
// stub.

type Handler = (source: { tabId: number }, method: string, params: unknown) => void;

const DEAD = "Session with given id not found.";

/** Set per test: which (session, method) pairs blow up, and with what. */
let fail: (sessionId: string, method: string) => string | null = () => null;
/** Every sendCommand, so a reaped session can be shown to cost nothing later. */
const calls: { sessionId: string; method: string }[] = [];
let onEvent: Handler = () => {};
/** Set per test: what the window has open, and whether anyone opened a tab. */
let openTabs = [{ id: 1, url: "https://example.test/", active: true }];
let created = 0;
/** Every chrome.tabs.group call, and which group ids Chrome still knows about. */
const grouped: { groupId?: number; tabIds: number[] }[] = [];
const liveGroups = new Set<number>();
let nextGroup = 100;
/** The id chrome.tabs.create hands back next. */
let newTabId = 2;
/** Set per test: the AX tree getFullAXTree hands back. Empty unless a test cares. */
let axNodes: () => unknown[] = () => [];

/** Tabs another attachment holds: "ours" a torn-down panel's, "devtools" not ours to release. */
const held = new Map<number, "ours" | "devtools">();

(globalThis as unknown as { chrome: unknown }).chrome = {
  debugger: {
    attach: async ({ tabId }: { tabId: number }) => {
      if (held.has(tabId)) throw new Error(`Another debugger is already attached to the tab with id: ${tabId}.`);
    },
    detach: async ({ tabId }: { tabId: number }) => {
      if (held.get(tabId) === "devtools") throw new Error(`Debugger is not attached to the tab with id: ${tabId}.`);
      held.delete(tabId);
    },
    sendCommand: async (target: { sessionId?: string }, method: string) => {
      const sessionId = target.sessionId ?? "";
      calls.push({ sessionId, method });
      const message = fail(sessionId, method);
      if (message) throw new Error(message);
      return method === "Accessibility.getFullAXTree" ? { nodes: axNodes() } : {};
    },
    onEvent: { addListener: (fn: Handler) => (onEvent = fn) },
    onDetach: { addListener: () => {} },
  },
  tabs: {
    get: async () => ({ id: 1, url: "https://example.test/", title: "t" }),
    query: async () => openTabs,
    create: async () => ({ id: (created++, newTabId) }),
    update: async () => {},
    group: async (options: { groupId?: number; tabIds: number[] }) => {
      grouped.push(options);
      if (options.groupId !== undefined) return options.groupId;
      const id = nextGroup++;
      liveGroups.add(id);
      return id;
    },
    onUpdated: { addListener: () => {}, removeListener: () => {} },
  },
  tabGroups: {
    // Chrome deletes a group when its last tab closes, and `get` on a dropped
    // id rejects — which is the only way to ask whether one still exists.
    get: async (id: number) => {
      if (!liveGroups.has(id)) throw new Error("No group with id: " + id);
      return { id };
    },
    update: async () => {},
  },
};

const cdp = await import("../../extension/cdp.js");

const attachFrame = (sessionId: string) =>
  onEvent({ tabId: 1 }, "Target.attachedToTarget", {
    sessionId,
    targetInfo: { type: "iframe", url: "https://frame.test/" },
  });

test("a frame whose session is gone is dropped, and never costs a round trip again", async () => {
  fail = (sessionId) => (sessionId === "s1" ? DEAD : null);
  await cdp.attach(1);
  attachFrame("s1");
  assert.equal(cdp.state().frames.length, 2, "main + the attached frame");

  const first = await cdp.snapshot();
  assert.ok(!first.includes("unavailable"), `a gone frame should not narrate itself: ${first}`);
  assert.equal(cdp.state().frames.length, 1, "the dead frame is reaped on the failure that revealed it");

  calls.length = 0;
  await cdp.snapshot();
  assert.equal(
    calls.filter((call) => call.sessionId === "s1").length,
    0,
    "a reaped frame must not be spoken to again — that failed round trip per snapshot is the whole cost being removed",
  );

  await cdp.detach();
});

test("a live frame having a bad moment is kept, and still says so", async () => {
  fail = (sessionId, method) =>
    sessionId === "s1" && method === "Accessibility.getFullAXTree" ? "Accessibility agent is not enabled" : null;
  await cdp.attach(1);
  attachFrame("s1");

  const text = await cdp.snapshot();
  assert.match(text, /unavailable/, "a recoverable error still belongs in the page");
  assert.equal(cdp.state().frames.length, 2, "forgetting a live frame would lose it for the rest of the run");

  await cdp.detach();
});

test("with nothing drivable open, only the caller that will USE a tab opens one", async () => {
  fail = () => null;
  // A fresh window: one chrome://newtab, which takes neither debugger nor navigation.
  openTabs = [{ id: 1, url: "chrome://newtab/", active: true }];
  created = 0;

  // The panel's pre-Run re-attach. Opening an active blank tab here is what
  // dropped the user on a black page under a debugger banner for the whole
  // first turn, before the model had asked to go anywhere.
  assert.equal(await cdp.attach(undefined, { open: false }), null, "nothing to drive, so nothing attached");
  assert.equal(created, 0, "the re-attach must not create a tab");
  assert.equal(await cdp.currentPage(), null, "and the prompt names no page, because there is none");

  // The first tool call still gets one — that is where a tab is actually needed,
  // and navigate() puts a real page on it immediately.
  assert.equal(await cdp.attach(), 2, "the tool layer opens the tab it is about to drive");
  assert.equal(created, 1);

  await cdp.detach();
});

test("every tab a run opens lands in ONE named group", async () => {
  fail = () => null;
  openTabs = [{ id: 1, url: "https://example.test/", active: true }];
  await cdp.attach(1);
  grouped.length = 0;
  cdp.nameRun("compare the free tiers of vercel, netlify and cloudflare");

  for (const [tab, url] of [
    [21, "https://vercel.com/pricing"],
    [22, "https://netlify.com/pricing"],
    [23, "https://pages.cloudflare.com/"],
  ] as [number, string][]) {
    newTabId = tab;
    await cdp.useTab(undefined, url);
  }

  assert.equal(grouped.length, 3, "each opened tab is grouped");
  assert.equal(grouped[0].groupId, undefined, "the first allocates the group");
  assert.equal(
    new Set(grouped.slice(1).map((g) => g.groupId)).size,
    1,
    "and every later tab JOINS that one — a group per tab is the failure this feature is known for",
  );

  await cdp.detach();
});

test("a group Chrome has already dropped is not reused", async () => {
  fail = () => null;
  await cdp.attach(1);
  grouped.length = 0;
  cdp.nameRun("read two pages");

  newTabId = 31;
  await cdp.useTab(undefined, "https://a.test/");
  // The user closed every tab in it, so Chrome deleted the group.
  liveGroups.delete(nextGroup - 1);

  newTabId = 32;
  await cdp.useTab(undefined, "https://b.test/");
  assert.equal(
    grouped[1].groupId,
    undefined,
    "reusing a dead id throws on every open for the rest of the session — allocate a new one instead",
  );

  await cdp.detach();
});

test("a tab the human already had open is never dragged into a group", async () => {
  fail = () => null;
  openTabs = [{ id: 1, url: "https://example.test/", active: true }];
  await cdp.attach(1);
  grouped.length = 0;
  cdp.nameRun("look at this page");

  // No url: use_tab is switching to a tab that was already there.
  await cdp.useTab(1);
  assert.equal(grouped.length, 0, "grouping someone's own tabs is a change to their window, not ours to make");

  await cdp.detach();
});

// ---- delta returns -----------------------------------------------------------

/**
 * A page of ordinary size whose first button's label we can change between
 * reads. Ten controls, not three: a delta is only sent when the change is small
 * relative to the page, and on a three-line page nothing ever is.
 */
const axPage = (label: string) => ({
  nodes: [
    {
      nodeId: "1",
      ignored: false,
      role: { value: "RootWebArea" },
      name: { value: "P" },
      childIds: Array.from({ length: 10 }, (_, i) => `n${i}`),
      properties: [],
    },
    ...Array.from({ length: 10 }, (_, i) => ({
      nodeId: `n${i}`,
      ignored: false,
      role: { value: i === 0 ? "button" : "link" },
      name: { value: i === 0 ? label : i === 1 ? "Docs" : `Item ${i}` },
      backendDOMNodeId: 11 + i,
      childIds: [],
      properties: [],
    })),
  ],
});

test("re-reading a page the agent is working on costs the lines that moved", async () => {
  let label = "Go";
  fail = () => null;
  openTabs = [{ id: 1, url: "https://example.test/", active: true }];
  axNodes = () => axPage(label).nodes;
  await cdp.attach(1);

  const full = await cdp.snapshot();
  assert.match(full, /@f0e11 \[button\] "Go"/, "the first read is the whole page");

  assert.match(await cdp.snapshot(), /nothing/, "a page nobody touched is not worth re-sending");

  label = "Go now";
  const patch = await cdp.snapshot();
  assert.match(patch, /^\+ @f0e11 \[button\] "Go now"$/m);
  assert.doesNotMatch(patch, /Docs/, "the lines that did not move are not re-sent");
  assert.ok(patch.length < full.length);

  await cdp.detach();
});

test("a ref from an earlier read still resolves — that is what makes a delta safe", async () => {
  fail = () => null;
  axNodes = () => axPage("Go").nodes;
  await cdp.attach(1);

  await cdp.snapshot();
  const gen = cdp.state().generation;
  await cdp.snapshot();
  assert.equal(cdp.state().generation, gen, "a read no longer invalidates the read before it");

  await cdp.detach();
});

test("after five deltas the whole page is sent again", async () => {
  let label = "Go";
  fail = () => null;
  axNodes = () => axPage(label).nodes;
  await cdp.attach(1);

  await cdp.snapshot();
  const returns = [];
  for (let i = 0; i < 6; i++) {
    label = `Go ${i}`;
    returns.push(await cdp.snapshot());
  }
  // The CLIs compact long conversations, and a model whose full page has been
  // compacted away cannot patch a delta onto anything.
  assert.equal(returns.filter((r) => r.startsWith("---")).length, 5);
  assert.match(returns[5], /@f0e12 \[link\] "Docs"/, "the sixth is a whole page again");

  await cdp.detach();
});

test("navigating away sends the new page whole, never as a patch", async () => {
  fail = () => null;
  axNodes = () => axPage("Go").nodes;
  await cdp.attach(1);
  await cdp.snapshot();

  // What Page.frameNavigated does: a different page is not a delta of the last.
  onEvent({ tabId: 1 }, "Page.frameNavigated", { frame: { url: "https://other.test/" } });
  assert.match(await cdp.snapshot(), /@f0e12 \[link\] "Docs"/);

  await cdp.detach();
});

test("an attachment a torn-down panel left behind is released, and DevTools' is not", async () => {
  await cdp.detach();
  // Seen live (P17): the panel was closed and reopened mid-task, and use_tab
  // back to a tab the old document had driven failed for the rest of the run.
  held.set(7, "ours");
  assert.equal(await cdp.attach(7), 7);
  await cdp.detach();
  held.set(8, "devtools");
  await assert.rejects(cdp.attach(8), /Another debugger is already attached/);
  assert.equal(cdp.state().tabId, null, "a refused attach leaves nothing half-attached");
  held.clear();
});
