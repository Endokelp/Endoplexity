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
const calls: { sessionId: string; method: string; params?: unknown }[] = [];
/** Set per test: answers for specific methods; undefined falls through to the defaults. */
let reply: (method: string) => unknown = () => undefined;
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

/** Every chrome.tabs.create / update, for the tests that care whether a tab was brought to the front. */
const tabOps: unknown[][] = [];

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
    sendCommand: async (target: { sessionId?: string }, method: string, params?: unknown) => {
      const sessionId = target.sessionId ?? "";
      calls.push({ sessionId, method, params });
      const message = fail(sessionId, method);
      if (message) throw new Error(message);
      const answer = reply(method);
      if (answer !== undefined) return answer;
      return method === "Accessibility.getFullAXTree" ? { nodes: axNodes() } : {};
    },
    onEvent: { addListener: (fn: Handler) => (onEvent = fn) },
    onDetach: { addListener: () => {} },
  },
  tabs: {
    get: async () => ({ id: 1, url: "https://example.test/", title: "t" }),
    query: async () => openTabs,
    create: async (o: unknown) => (tabOps.push(["create", o]), { id: (created++, newTabId) }),
    update: async (...a: unknown[]) => void tabOps.push(["update", ...a]),
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

// Leaving a page does not end its frames at once, and until Chrome detached
// them every read listed them (P18, measured on stackoverflow.com). A page
// back from the cache comes back with its frames still attached.
test("a frame of the page the tab left is not read, and comes back with that page", async () => {
  fail = () => null;
  axNodes = () => [];
  await cdp.attach(1);
  onEvent({ tabId: 1 }, "Page.frameNavigated", { frame: { url: "https://ads.test/", loaderId: "A" } });
  attachFrame("ad");
  const readsAd = async () => {
    calls.length = 0;
    await cdp.snapshot();
    return calls.some((call) => call.sessionId === "ad");
  };
  assert.equal(await readsAd(), true, "a frame of the page on screen is read");
  // The frame's own navigation is not the main frame's: it stays.
  onEvent({ tabId: 1, sessionId: "ad" } as never, "Page.frameNavigated", { frame: { url: "https://ads.test/2", loaderId: "C" } });
  assert.equal(await readsAd(), true, "a frame navigating itself was taken for the page moving on");
  onEvent({ tabId: 1 }, "Page.frameNavigated", { frame: { url: "https://example.test/", loaderId: "B" } });
  assert.equal(await readsAd(), false, "the page the tab left still had its frame read");
  onEvent({ tabId: 1 }, "Page.frameNavigated", { frame: { url: "https://ads.test/", loaderId: "A" } });
  assert.equal(await readsAd(), true, "a page back from the cache lost its frame");
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

test("attaching turns on focus emulation, so a page behind other windows still draws and takes input", async () => {
  // Without it a covered window's page is `hidden`: every mouse event waited
  // ~5 s for a frame and a hover landed after the read meant to show it. A
  // user's self-test failed exactly that behind a maximized DevTools window.
  fail = () => null;
  calls.length = 0;
  await cdp.attach(1);
  assert.ok(
    calls.some((c) => c.sessionId === "" && c.method === "Emulation.setFocusEmulationEnabled"),
    "the main session must be told to emulate focus on attach",
  );
  await cdp.detach();
});

// See: the panel half. A viewport position, not a node, so these pin the
// contract the rest depends on: capture only when On, dispatch on MAIN with no
// box model, and the gate's label naming what is really under the point.
const VIEW = {
  cssLayoutViewport: { clientWidth: 800, clientHeight: 600 },
  cssVisualViewport: { clientWidth: 800, clientHeight: 600, pageX: 0, pageY: 0 },
};
const seeReplies = (extra: Record<string, unknown> = {}) =>
  (reply = (method) => (method === "Page.getLayoutMetrics" ? VIEW : extra[method]));

test("See off: screenshot refuses, and nothing is captured", async () => {
  fail = () => null;
  seeReplies();
  await cdp.attach(1);
  cdp.setSee("off");
  calls.length = 0;
  await assert.rejects(cdp.screenshot(), /See is off/);
  cdp.setSee("bogus");
  assert.equal(cdp.getSee(), "off", "anything but act is off");
  assert.ok(!calls.some((c) => c.method === "Page.captureScreenshot"), "no capture while off");
  await cdp.detach();
});

test("See on: screenshot returns the jpeg, its size, and the viewport", async () => {
  fail = () => null;
  // 1x1 jpeg SOF only: enough for jpegSize, which is all that reads it.
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xc0, 0, 11, 8, 1, 144, 2, 128, 1, 0, 0, 0xff, 0xd9]);
  seeReplies({ "Page.captureScreenshot": { data: jpeg.toString("base64") } });
  await cdp.attach(1);
  cdp.setSee("act");
  const shot = await cdp.screenshot();
  assert.deepEqual([shot.width, shot.height, shot.viewport], [640, 400, { width: 800, height: 600 }]);
  const cap = calls.find((c) => c.method === "Page.captureScreenshot");
  // Clipped to the viewport the point is mapped in, or the scrollbar skews x.
  assert.deepEqual(cap?.params, { format: "jpeg", quality: 80, clip: { x: 0, y: 0, width: 800, height: 600, scale: 1 } });
  cdp.setSee("off");
  await cdp.detach();
});

test("a point ref clicks on MAIN at its point, with no box model", async () => {
  fail = () => null;
  seeReplies();
  await cdp.attach(1);
  const ref = await cdp.point(120, 130, "  the red circle ");
  assert.match(ref, /^@p\d+$/);
  calls.length = 0;
  await cdp.click(ref, { quiet: true });
  assert.ok(!calls.some((c) => c.method === "DOM.getBoxModel" || c.method === "DOM.scrollIntoViewIfNeeded"));
  const mouse = calls.filter((c) => c.method === "Input.dispatchMouseEvent");
  assert.equal(mouse.length, 3);
  for (const m of mouse) {
    assert.equal(m.sessionId, "", "MAIN");
    assert.deepEqual([(m.params as { x: number }).x, (m.params as { y: number }).y], [120, 130]);
  }
  assert.notEqual(await cdp.point(1, 1, "x"), ref, "a point ref is never reused");
  await cdp.detach();
});

test("a point ref is for click and hover only", async () => {
  fail = () => null;
  seeReplies();
  await cdp.attach(1);
  const ref = await cdp.point(10, 10, "dot");
  await assert.rejects(cdp.type(ref, "hi"), new RegExp(`${ref} is a point on the screen: only click and hover take it`));
  await assert.rejects(cdp.select(ref, "a"), /is a point on the screen/);
  await assert.rejects(cdp.scroll("down", ref), /is a point on the screen/);
  await cdp.snapshot();
  await cdp.hover(ref, { quiet: true });
  await cdp.detach();
});

test("a point ref dies with the page", async () => {
  fail = () => null;
  seeReplies();
  await cdp.attach(1);
  const ref = await cdp.point(10, 10, "dot");
  onEvent({ tabId: 1 }, "Page.frameNavigated", { frame: { url: "https://example.test/next", loaderId: "Z" } });
  await assert.rejects(cdp.click(ref), /stale ref/);
  await assert.rejects(cdp.click("@p999"), /unknown ref/);
  await cdp.detach();
});

test("labelOf a point ref names what is under it, and throws rather than fall back to the query", async () => {
  fail = () => null;
  seeReplies({
    "DOM.getNodeForLocation": { backendNodeId: 7 },
    "Accessibility.getPartialAXTree": { nodes: [{ backendDOMNodeId: 7, role: { value: "button" }, name: { value: "Delete" } }] },
  });
  await cdp.attach(1);
  const ref = await cdp.point(10, 10, "the trash icon");
  assert.equal(await cdp.labelOf(ref), '[point] "the trash icon" over [button] "Delete"');
  fail = (_s, method) => (method === "DOM.getNodeForLocation" ? "no node" : null);
  await assert.rejects(cdp.labelOf(ref), /no node/, "the model's own words are never the label");
  await cdp.detach();
});

test("labelOf a point over an icon inside a button reads the button's name, and an unnamed chain throws", async () => {
  fail = () => null;
  const svg = { nodeId: "2", parentId: "1", backendDOMNodeId: 7, role: { value: "image" } };
  const tree = (name?: string) => ({
    "DOM.getNodeForLocation": { backendNodeId: 7 },
    "Accessibility.getPartialAXTree": {
      nodes: [{ nodeId: "1", backendDOMNodeId: 6, role: { value: "button" }, ...(name ? { name: { value: name } } : {}) }, svg],
    },
  });
  seeReplies(tree("Place order"));
  await cdp.attach(1);
  const ref = await cdp.point(10, 10, "the cart icon");
  assert.equal(await cdp.labelOf(ref), '[point] "the cart icon" over [image] in [button] "Place order"');
  seeReplies(tree());
  await assert.rejects(cdp.labelOf(ref), /nothing readable/);
  await cdp.detach();
});

test("type sends a line break as text, never as an Enter key event", async () => {
  fail = () => null;
  reply = () => undefined;
  axNodes = () => axPage("Go").nodes;
  await cdp.attach(1);
  await cdp.snapshot();
  calls.length = 0;
  await cdp.type("@f0e11", "a\r\nb\rc");
  const keys = calls.filter((c) => c.method === "Input.dispatchKeyEvent").map((c) => (c.params as { text: string }).text);
  assert.ok(keys.every((t) => !/[\r\n]/.test(t)), "no key event carries a line break");
  assert.equal(keys.length, 6, "a, b, c: down and up");
  const ins = calls.filter((c) => c.method === "Input.insertText").map((c) => (c.params as { text: string }).text);
  assert.deepEqual(ins, ["\n", "\n"], "\\r\\n is one break, \\r another");
  await cdp.detach();
});

test("upload's result never carries the path it was given", async () => {
  fail = () => null;
  reply = (m) =>
    m === "DOM.getDocument" ? { root: { nodeId: 1 } }
    : m === "DOM.querySelectorAll" ? { nodeIds: [5] }
    : m === "DOM.getAttributes" ? { attributes: ["name", "resume"] }
    : undefined;
  axNodes = () => axPage("Go").nodes;
  await cdp.attach(1);
  const out = await cdp.upload("/home/me/secret/cv.pdf", undefined, { quiet: true });
  assert.match(out, /^set the file on file input "resume"/);
  assert.ok(!out.includes("secret"), "no path reaches the model");
  await cdp.detach();
  reply = () => undefined;
});

test("a background run opens its use_tab tab behind the one in front and never raises one", async () => {
  fail = () => null;
  reply = () => undefined;
  axNodes = () => axPage("Go").nodes;
  await cdp.attach(1);
  cdp.setBackground(true);
  tabOps.length = 0;
  await cdp.useTab(undefined, "https://other.test/", { quiet: true });
  assert.deepEqual(tabOps.find((o) => o[0] === "create")?.[1], { url: "https://other.test/", active: false });
  assert.ok(!tabOps.some((o) => o[0] === "update" && (o[2] as { active?: boolean })?.active), "no raise");
  cdp.setBackground(false);
  await cdp.detach();
});

test("with a frame attached, Act settle keeps at least the old 300 ms wait", async () => {
  fail = () => null;
  reply = (m) => (m === "Runtime.evaluate" ? { result: { value: 0 } } : undefined);
  axNodes = () => axPage("Go").nodes;
  cdp.setSettle("act");
  const timed = async () => {
    const t0 = Date.now();
    await cdp.key("Escape", { quiet: true });
    return Date.now() - t0;
  };
  await cdp.attach(1);
  assert.ok((await timed()) < 250, "a lone main frame is quiet in about 100 ms");
  attachFrame("fs1");
  assert.ok((await timed()) >= 290, "a frame's own changes are invisible, so wait the fixed time");
  await cdp.detach();
  cdp.setSettle("off");
  reply = () => undefined;
});

test("point() refuses a position outside the viewport, and a non-number", async () => {
  fail = () => null;
  seeReplies();
  await cdp.attach(1);
  for (const [x, y] of [[-1, 5], [5, -1], [800, 5], [5, 600], [NaN, 5], [Infinity, 5]]) {
    await assert.rejects(cdp.point(x, y, "q"), /outside/, `${x},${y}`);
  }
  await cdp.point(799, 599, "corner");
  await cdp.detach();
  reply = () => undefined;
});

test("a lane never takes a tab another lane is running on, nor any other tab of yours in its place", async () => {
  fail = () => null;
  // Lane B is driving tab 1, which is in front; tab 3 is some other page of yours.
  openTabs = [
    { id: 1, url: "https://busy.test/", active: true },
    { id: 3, url: "https://yours.test/", active: false },
  ];
  cdp.setTaken((id: number) => id === 1);
  created = 0;
  grouped.length = 0;
  cdp.nameRun("second task");

  assert.equal(await cdp.currentPage(), null, "the prompt names no page: the one in front is not this lane's");
  assert.equal(await cdp.attach(undefined, { open: false }), null, "the pre-Run re-attach takes nothing");
  await assert.rejects(cdp.attach(1), /another run/, "nor by id");

  // The first tool call opens a tab of its own, and it goes in the run's group.
  newTabId = 4;
  assert.equal(await cdp.attach(), 4);
  assert.equal(created, 1);
  assert.deepEqual(grouped.at(-1)?.tabIds, [4]);
  await assert.rejects(cdp.useTab(1), /another run/, "use_tab cannot reach it either");
  // Even a stale claim on its own tab leaves its own line as where() parses it.
  openTabs = [...openTabs, { id: 4, url: "https://own.test/", active: false }];
  cdp.setTaken((id: number) => id === 1 || id === 4);
  const list = await cdp.tabs();
  assert.match(list, /id 1 .*\(another run is driving this tab\)/);
  assert.match(list, /^\* id 4 — "" https:\/\/own\.test\/$/m);

  await cdp.detach();
  cdp.setTaken(() => false);
  newTabId = 2;
});
