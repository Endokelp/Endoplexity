// The hands. Drives the active tab over chrome.debugger — no model involved.
//
// Two things here are load-bearing and were built first on purpose:
//
//  1. Flat auto-attach. Greenhouse, Lever and Workday put their forms in
//     cross-origin iframes, which are separate renderer targets. The main
//     frame's AX tree contains nothing for them, so every OOPIF gets its own
//     CDP session and its own slice of the snapshot, with refs namespaced per
//     frame (@f1e7). Retrofitting this would mean rewriting the ref system.
//  2. Refs die. Every snapshot mints a new generation; navigation bumps it.
//     Acting on an old ref fails loudly instead of clicking whatever inherited
//     that backend node id — the single most common failure mode in every
//     agentic-browser clone surveyed.
//
// Requires Chrome 125+, where chrome.debugger.sendCommand accepts a sessionId.

import { delta, labelOf as lineLabel, serialize } from "./ax.js";

const MAIN = ""; // the tab's own session — sendCommand target with no sessionId

let tabId = null;
let sessions = new Map(); // sessionId -> { tag, url }
let refs = new Map(); // "@f0e3" -> { sessionId, backendNodeId, generation }
let generation = 0;
let frameSeq = 0;

const send = (sessionId, method, params = {}) =>
  chrome.debugger.sendCommand(sessionId ? { tabId, sessionId } : { tabId }, method, params);

function reset() {
  tabId = null;
  mainDoc = null;
  sessions = new Map();
  refs = new Map();
  frameSeq = 0;
  inflight.clear();
  netLog = [];
}

// Bumped without clearing refs, so a ref minted before the page moved is still
// found and can be reported as stale rather than as unknown.
function invalidate(why) {
  generation++;
  console.log(`endo: refs invalidated (${why})`);
}

// Chrome does not always send Target.detachedFromTarget for an OOPIF whose
// renderer went away, so `sessions` accumulates corpses: every later snapshot
// pays a failed round trip and a line of noise per dead frame, forever — three
// at once were seen on a real run. Nothing else can tell us they are gone, so
// the failure IS the notification. Drop on the error that means "this session
// no longer exists" and nothing broader: an Accessibility or DOM error is a
// live frame having a bad moment, and forgetting it would lose a real frame.
const GONE = /session with given id|target closed/i;
const dropIfDead = (sessionId, err) => sessionId !== MAIN && GONE.test(err.message) && sessions.delete(sessionId);

/**
 * The main frame's document now (its loaderId). A frame session belongs to the
 * document that was current when it attached, and leaving a page does not end
 * its frames at once: Chrome detaches them when it gets round to it. Until
 * then every read listed them. Measured 2026-11-02: example.com read right
 * after stackoverflow.com came back 1,902 characters, its own page being 25,
 * the rest ad frames of the page it had left; the same dead sessions are the
 * P17 timeout on leaving that site. Not deleted on navigation: going back
 * restores a cached page with its frames still attached, under its old
 * loaderId, and they count again.
 */
let mainDoc = null;
const current = () => [...sessions].filter(([id, frame]) => id === MAIN || frame.doc === mainDoc);

function setupSession(sessionId) {
  // Nested OOPIFs: each new session needs its own auto-attach or a frame two
  // levels deep never attaches.
  // ponytail: waitForDebuggerOnStart stays false, so a target that appears and
  // navigates in the same tick can be missed. Snapshot is on demand and can
  // just be re-run. Flip it (plus Runtime.runIfWaitingForDebugger) only if a
  // frame turns out to be reliably absent.
  send(sessionId, "Target.setAutoAttach", {
    autoAttach: true,
    waitForDebuggerOnStart: false,
    flatten: true,
  }).catch((err) => console.warn(`endo: setAutoAttach failed on ${sessionId || "main"}`, err));
  send(sessionId, "Page.enable").catch(() => {});
  // A new tab is a new debugger attachment: Network starts disabled again.
  if (sessionId === MAIN && settleState !== "off") send(MAIN, "Network.enable").catch(() => {});
}

function onEvent(source, method, params) {
  if (source.tabId !== tabId) return;

  // Settle's network half: main-frame session only. A frame's own traffic is its
  // business and a chatty ad iframe would hold the page "busy" forever.
  if (settleState !== "off" && !source.sessionId && method.startsWith("Network.")) trackNet(method, params);

  if (method === "Target.attachedToTarget") {
    const { sessionId, targetInfo } = params;
    // Auto-attach also hands us workers and service workers. They have no
    // accessibility tree, so registering them would put a permanent
    // "(frame unavailable)" line in every snapshot of any real site.
    if (targetInfo.type !== "iframe") return;
    sessions.set(sessionId, { tag: `f${++frameSeq}`, url: targetInfo.url, doc: mainDoc });
    console.log(`endo: frame f${frameSeq} attached — ${targetInfo.url}`);
    setupSession(sessionId);
  }

  if (method === "Target.detachedFromTarget") {
    // Only frames we actually track, or a worker shutting down would nuke every
    // ref on the page for no reason.
    if (sessions.delete(params.sessionId)) invalidate("frame detached");
  }

  // Only a session's own root frame; sub-frame navigations inside one document
  // do not move the nodes we hold.
  if (method === "Page.frameNavigated" && !params.frame.parentId) {
    const frame = sessions.get(source.sessionId ?? MAIN);
    if (frame) frame.url = params.frame.url;
    invalidate("navigation");
    if (!source.sessionId) {
      inflight.clear();
      mainDoc = params.frame.loaderId ?? null;
    }
  }
}

// chrome://, the web store and other extensions are closed to chrome.debugger AND
// to tabs.update, so a tab showing one is a dead end, not a starting point.
const DRIVABLE = /^(https?|file):/;

/*
 * Parallel runs (Phase 21). The panel loads one copy of this module per lane
 * (`cdp.js?lane=<id>`), so each lane has its own tab, refs and frames, and
 * tells each copy which tabs the other lanes hold. A second attach to a held
 * tab would take it from the lane driving it: attach() releases an attachment
 * of ours it finds there, by design, for the panel's own remounts.
 */
let taken = () => false;
/** The panel's answer to "is this tab another lane's?". */
export const setTaken = (fn) => void (taken = fn);
const busyTab = (id) => new Error(`tab ${id} is being driven by another run in this panel`);

/**
 * The tab to drive when nobody named one.
 *
 * The active tab is the obvious guess and the wrong one often enough to matter:
 * the panel is normally opened from chrome://extensions, which fails every tool
 * with "Cannot access a chrome:// URL" and cannot even be navigated away from.
 * Fall back to another drivable tab in the window, and open one if there is none.
 */
//
// When another lane is driving the tab in front, nothing here is this lane's
// to take: not that tab, and not some other tab of yours it was never pointed
// at. The caller opens a tab of its own instead.
const findDrivable = (tabs) => {
  if (tabs.some((t) => t.active && taken(t.id))) return undefined;
  const free = tabs.filter((t) => !taken(t.id));
  return free.find((t) => t.active && DRIVABLE.test(t.url ?? "")) ?? free.find((t) => DRIVABLE.test(t.url ?? ""));
};

async function pickTab(open) {
  const usable = findDrivable(await chrome.tabs.query({ currentWindow: true }));
  if (usable) return usable.id;
  // Nothing drivable is open, and opening one is only right for a caller that
  // is about to USE it. The panel re-attaches on every fresh Run, before the
  // model has done anything — creating an active tab there yanks you off the
  // page you were on to stare at a blank one with a debugger banner for the
  // whole first turn. The first tool call opens it instead, and navigate()
  // lands a real page on it in the same breath.
  if (!open) return null;
  // No wait: about:blank is already loaded, and navigate() waits for its own.
  const opened = await chrome.tabs.create({ url: "about:blank", active: true });
  // Opened by the run, so it is the run's: rule 3 on joinGroup().
  await joinGroup(opened.id);
  return opened.id;
}

/**
 * A run that must not take the tab in front gets one of its own, in the
 * background and in its group: a scheduled run (scripts/run-task.ts) starts
 * while you may be working, and is never handed the page you are on.
 */
export async function attachOwn() {
  const opened = await chrome.tabs.create({ url: "about:blank", active: false });
  await joinGroup(opened.id);
  return attach(opened.id);
}

/**
 * The page the agent is about to work on, for the task prompt to name — or null
 * if nothing drivable is open yet.
 *
 * Goes through the same picker `attach()` does rather than reading the active
 * tab, because the two disagreeing is worse than having no context at all: the
 * prompt would name one page while every tool call landed on another. Unlike
 * `pickTab()` this never opens a tab — building a prompt must not have side
 * effects, and a run with no page to drive should say so, not invent one.
 */
export async function currentPage() {
  const tab =
    tabId !== null ? await chrome.tabs.get(tabId) : findDrivable(await chrome.tabs.query({ currentWindow: true }));
  return tab ? { url: tab.url ?? "", title: tab.title ?? "" } : null;
}

/**
 * Attach to a tab (defaults to a drivable one) and wire up OOPIF discovery.
 *
 * `open: false` means "attach only if there is already something to drive" —
 * it returns null instead of opening a tab. See pickTab().
 */
export async function attach(target, { open = true } = {}) {
  if (tabId !== null) throw new Error(`already attached to tab ${tabId} — detach() first`);

  const id = target ?? (await pickTab(open));
  if (id == null) {
    if (!open) return null;
    throw new Error("no tab to drive");
  }
  if (taken(id)) throw busyTab(id);

  try {
    await chrome.debugger.attach({ tabId: id }, "1.3");
  } catch (err) {
    // An attachment belongs to the extension, not to this document: one made by
    // a panel Chrome has since torn down (every window switch) outlives it and
    // refuses this one, so a remount mid-task, or use_tab back to a tab driven
    // before it, failed with "Another debugger is already attached" (seen live,
    // P17). That one is ours to release. DevTools' is not, and detaching it
    // fails, so the original error stands.
    if (!/already attached/i.test(err.message)) throw err;
    await chrome.debugger.detach({ tabId: id }).catch(() => {
      throw err;
    });
    await chrome.debugger.attach({ tabId: id }, "1.3");
  }
  tabId = id;
  sessions.set(MAIN, { tag: "f0", url: "" });
  invalidate("attached");
  // Before auto-attach, so the page's frames attach under the document they
  // belong to rather than under none.
  mainDoc = (await send(MAIN, "Page.getFrameTree").catch(() => null))?.frameTree?.frame?.loaderId ?? null;
  setupSession(MAIN);
  // A covered or minimized window makes the page `hidden`: it stops making
  // frames, every mouse event waits ~5 s for one, and a hover can land after
  // the read meant to show it (a user's self-test, behind a maximized DevTools
  // window). Focus emulation keeps the driven page visible, as Playwright does
  // for every page it drives. Measured: hover 5.4 s -> 0.38 s.
  await send(MAIN, "Emulation.setFocusEmulationEnabled", { enabled: true }).catch(() => {});

  const tab = await chrome.tabs.get(id);
  console.log(`endo: attached to tab ${id} — ${tab.url}`);
  return id;
}

/**
 * Resolves when the tab finishes loading. Attach the listener BEFORE navigating.
 * With a timeout it also resolves on giving up — a page holding one analytics
 * beacon open never reaches `complete`, and a listener left behind would fire on
 * every tab update for the life of the panel.
 */
export function loaded(id, timeoutMs) {
  return new Promise((resolve) => {
    const finish = () => {
      chrome.tabs.onUpdated.removeListener(done);
      resolve();
    };
    const done = (updated, info) => {
      if (updated === id && info.status === "complete") finish();
    };
    chrome.tabs.onUpdated.addListener(done);
    if (timeoutMs) setTimeout(finish, timeoutMs);
  });
}

/** Point the attached tab at a URL and wait for the load to finish. */
export async function navigate(url) {
  requireAttached();
  // Listener first: a cached page can finish loading before we would hear it.
  // Deliberately uncapped, unlike go() and settle(): returning early here hands
  // back a half-loaded page that reads as fine and types into nothing, which is
  // far worse than the relay's 30s deadline firing and saying so out loud. If a
  // beacon-hung page ever does strand this, fix it with the evidence in hand.
  const ready = loaded(tabId);
  await chrome.tabs.update(tabId, { url });
  await ready;
  console.log(`endo: navigated to ${url}`);
  return `navigated to ${url}`;
}

/**
 * A page that loaded and reads as nothing. Measured 2026-11-02: stackoverflow
 * in a fresh profile is Cloudflare's "Just a moment..." check first, an empty
 * accessibility tree that reloads itself once and only then navigates to the
 * real page, ~2.8 s in all, and navigate handed the model the empty string.
 * Waiting for one more load caught the check's own reload, so this waits for
 * the page to read as something. Each read forgets the last: the model has
 * seen none of them, so a patch against an empty one would describe nothing it
 * holds. Failing that, the result says what the tab says instead of nothing.
 * ponytail: navigate only, where it was seen; a click into one would want it too.
 */
export async function emptyPage(options) {
  for (const t0 = Date.now(); Date.now() - t0 < 8_000; ) {
    await new Promise((r) => setTimeout(r, 500));
    forget();
    const again = await snapshot(options);
    if (again.trim()) return again;
  }
  // Collapsed: a title is the page's text, and a newline in it could forge a line.
  const title = String((await chrome.tabs.get(tabId)).title ?? "").replace(/\s+/g, " ").trim();
  return `(the page "${title}" has nothing to read yet: a browser check or a redirect may still be running. Read it again with snapshot.)`;
}

/**
 * Walk the tab's own session history and return the page that lands.
 *
 * Page.getNavigationHistory + navigateToHistoryEntry, NOT chrome.tabs.goBack.
 * The tab API takes no argument and reports every refusal as the same opaque
 * "Cannot find a next page in history." — for going BACK as well as forward,
 * since Chromium reuses one error string for both. That told us nothing about
 * why, and it is the message this self-test actually hit. The entry list is
 * what devtools' own back button drives, it costs one extra call on the session
 * we already own, and it lets the failure name the whole history — so a run
 * that cannot go back says what it can see instead of leaving it to guesswork.
 *
 * Named `go`, not `history`, because a module-level `history` would shadow the
 * global one for the whole file.
 */
export async function go(direction, options) {
  requireAttached();
  const { currentIndex, entries } = await send(MAIN, "Page.getNavigationHistory");
  const target = entries[currentIndex + (direction === "forward" ? 1 : -1)];
  if (!target) {
    const where = direction === "forward" ? "end" : "start";
    throw new Error(
      `cannot go ${direction} — already at the ${where} of this tab's history, ` +
        `entry ${currentIndex + 1} of ${entries.length}: ${entries.map((e) => e.url).join(" → ")}`,
    );
  }
  // Listener first, same reason navigate() does it: a bfcache restore can finish
  // before we would hear about it.
  const ready = loaded(tabId, 10_000);
  await send(MAIN, "Page.navigateToHistoryEntry", { entryId: target.id });
  await ready;
  console.log(`endo: went ${direction} to ${target.url}`);
  return snapshot(options);
}

/**
 * The drivable tabs in this window, so a click that opened a new tab is not a
 * dead end. The attached one is starred — without that the model cannot tell
 * which of five tabs its refs belong to.
 *
 * Filtered by DRIVABLE for the same reason attach() is: offering a chrome://
 * tab the agent then cannot attach to is worse than not listing it.
 */
/*
 * Tabs the agent OPENS go into one named group per run.
 *
 * Rejected once, for a real reason: the common failure of this feature is
 * groups that multiply and are never cleaned up. Three rules keep that from
 * happening here, and they are the whole implementation.
 *
 *  1. One group id per run, not per tab. `use_tab` opening five pages produces
 *     one group, because the id is only allocated when it is null.
 *  2. A remembered id is checked to still exist before it is reused. Chrome
 *     deletes a group when its last tab closes, so a stale id would otherwise
 *     throw on every later open for the rest of the session.
 *  3. Only tabs the agent itself opened ever join. A group is a change to
 *     someone's window, and pulling in the tab the human already had open —
 *     the one they were reading when they pressed Run — is not ours to make.
 *
 * There is deliberately no cleanup path: Chrome removes an empty group on its
 * own, and a run's tabs are the user's to keep or close.
 */
let group = null;
let groupName = "";

/** Name the group the next opened tabs go into. A fresh Run; replies keep it. */
export function nameRun(title) {
  group = null;
  groupName = String(title ?? "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 32);
}

async function joinGroup(id) {
  if (!groupName) return;
  try {
    // Rule 2. `get` on a group Chrome has already dropped rejects, which is the
    // check — there is no "does this group exist" call.
    if (group !== null && !(await chrome.tabGroups.get(group).catch(() => null))) group = null;
    const fresh = group === null;
    group = await chrome.tabs.group(fresh ? { tabIds: [id] } : { groupId: group, tabIds: [id] });
    if (fresh) await chrome.tabGroups.update(group, { title: groupName, color: "green" });
  } catch (err) {
    // Never fatal: the page is open and drivable, it is just loose in the tab
    // strip. Failing the tool call over cosmetics would lose the whole run.
    console.log(`endo: could not group tab ${id} — ${err.message}`);
  }
}

/** The same list as data, for the panel's @-menu. One filter, one definition. */
export async function drivable() {
  return (await chrome.tabs.query({ currentWindow: true })).filter((t) => DRIVABLE.test(t.url ?? ""));
}

export async function tabs() {
  const open = await drivable();
  if (!open.length) return "no drivable tabs open";
  return open
    .map((t) => `${t.id === tabId ? "*" : " "} id ${t.id} — "${t.title ?? ""}" ${t.url}${t.id !== tabId && taken(t.id) ? " (another run is driving this tab)" : ""}`)
    .join("\n");
}

/**
 * Switch to an existing tab by id, or open a new one at a url and switch to it.
 * Returns the page there, so the agent is never left holding refs from a tab it
 * has moved off.
 *
 * Only one debugger can attach to a tab, and cdp.js tracks exactly one, so
 * switching is detach-then-attach — which throws away every ref, deliberately:
 * they belong to the old tab's renderer and would resolve to nothing here.
 */
// A scheduled run must not pull its tabs to the front (scripts/run-task.ts).
let background = false;
export const setBackground = (on) => void (background = !!on);

export async function useTab(id, url, options) {
  requireAttached();
  const undrivable = (where) =>
    new Error(`cannot drive ${where} — only http, https and file pages accept the debugger`);

  // Both paths check BEFORE detaching, because attaching to a chrome:// tab
  // fails and doing that after the detach would leave the agent attached to
  // nothing while still holding refs it believes are live.
  //
  // The url is checked as a string rather than by reading the tab back after
  // creating it: a tab Chrome has only just opened reports url:"" and carries
  // the real one in pendingUrl until the navigation commits, so reading .url
  // there rejects every new tab as undrivable.
  if (url && !DRIVABLE.test(url)) throw undrivable(url);
  if (!url && taken(id)) throw busyTab(id);
  const target = url ? (await chrome.tabs.create({ url, active: !background })).id : id;
  if (target == null) throw new Error("use_tab needs an id from tabs(), or a url to open");
  // Only a tab we just opened — see the rules on joinGroup().
  if (url) await joinGroup(target);
  if (!url) {
    const tab = await chrome.tabs.get(target);
    if (!DRIVABLE.test(tab.url ?? "")) throw undrivable(`tab ${target} (${tab.url})`);
  }

  if (target !== tabId) {
    await detach();
    await attach(target);
    if (!background) await chrome.tabs.update(target, { active: true });
  }
  // A freshly created tab is usually still loading; settle() waits on exactly
  // that and needs no separate path.
  await settle();
  console.log(`endo: using tab ${target}`);
  return snapshot(options);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/*
 * Settle: "the page stopped changing", measured instead of guessed.
 *
 * State is "off" (the fixed wait below, untouched: no Network.enable, no
 * evaluate), "shadow" (same timing as off, but measured alongside so the bridge
 * can log how often the guess would have been right) or "act" (wait for quiet).
 * Quiet means no DOM mutation and no main-frame request in flight for QUIET_MS.
 */
let settleState = "off";
let onSettleFn = null;
const inflight = new Set(); // main-frame requestIds not yet finished
let netLog = []; // [{ t, kind }] for settledAt(); only kept while not off
let lastNetT = 0;
const QUIET_MS = 100;
// WebSocket and EventSource are long-lived by design: never "idle". Document is
// left to settle()'s own `loading` check: a cross-site iframe's document request
// is reported starting on the main session and finishing only on the frame's own
// (measured in headless Chrome on the OOPIF fixture), so counting it held every
// page with such an iframe "busy" forever.
const NO_NET = /^(WebSocket|EventSource|Document)$/;

export const onSettle = (fn) => void (onSettleFn = fn);

export function setSettle(state) {
  const next = state === "shadow" || state === "act" ? state : "off";
  const was = settleState;
  settleState = next;
  if (tabId === null || (was === "off") === (next === "off")) return;
  send(MAIN, next === "off" ? "Network.disable" : "Network.enable").catch(() => {});
  inflight.clear();
  netLog = [];
}

function trackNet(method, params) {
  const t = Date.now();
  let kind;
  if (method === "Network.requestWillBeSent" && !NO_NET.test(params.type ?? "")) {
    inflight.add(params.requestId);
    kind = "net-start";
  } else if (method === "Network.loadingFinished" || method === "Network.loadingFailed") {
    // Only ids we counted: a WebSocket's end must not read as a request ending.
    if (!inflight.delete(params.requestId)) return;
    kind = "net-end";
  } else return;
  lastNetT = t;
  netLog.push({ t, kind });
  if (netLog.length > 500) netLog.shift();
}

// Runs in the page. One observer, parked on a page-global under a name nothing
// else uses; the array is capped so a page that mutates constantly costs memory
// for 200 numbers, not a leak. Idempotent: a second call finds the first.
const OBSERVE = `(() => {
  const w = window;
  if (!w.__endoSettle) {
    const log = [];
    const mo = new MutationObserver(() => { log.push(Date.now()); if (log.length > 200) log.shift(); });
    mo.observe(document, { subtree: true, childList: true, characterData: true, attributes: true,
      attributeFilter: ["aria-expanded", "aria-hidden", "aria-checked", "aria-selected", "aria-disabled", "disabled", "hidden", "open", "value", "checked"] });
    w.__endoSettle = { log, mo };
  }
  return true;
})()`;
const LAST = "(window.__endoSettle?.log.at(-1) ?? 0)";
// null, not [], when the observer is gone: the click navigated and this is a
// new document, which says nothing about whether the old one went quiet.
const COLLECT = `(() => {
  const s = window.__endoSettle;
  if (!s) return null;
  s.mo.disconnect();
  delete window.__endoSettle;
  return s.log;
})()`;

async function evalMain(expression) {
  const { result, exceptionDetails } = await send(MAIN, "Runtime.evaluate", { expression, returnByValue: true });
  if (exceptionDetails) throw new Error(exceptionDetails.exception?.description ?? exceptionDetails.text);
  return result.value;
}

/**
 * The earliest time T in [t0 + quietMs, until] with no event in (T - quietMs, T]
 * and no request in flight at T, or null. Events are { t, kind: "dom" | "net-start"
 * | "net-end" }; a request already open at t0 is a "net-start" at t0.
 *
 * The only T worth testing are t0 + quietMs and each event's t + quietMs: between
 * those the window cannot become quieter, so the earliest quiet T is one of them.
 */
export function settledAt(t0, events, quietMs, until) {
  const candidates = [t0 + quietMs, ...events.map((e) => e.t + quietMs)].filter((T) => T >= t0 + quietMs && T <= until);
  for (const T of candidates.sort((a, b) => a - b)) {
    let open = 0;
    let busy = false;
    for (const e of events) {
      if (e.t <= T && e.t > T - quietMs) busy = true;
      if (e.t <= T) open += e.kind === "net-start" ? 1 : e.kind === "net-end" ? -1 : 0;
    }
    if (!busy && open <= 0) return T;
  }
  return null;
}

/** Did the page change (a DOM event) after T, up to `until`? Null T: nothing settled. */
export const changedAfter = (T, events, until) =>
  T !== null && events.some((e) => e.kind === "dom" && e.t > T && e.t <= until);

// Shadow: the fixed wait stays exactly as it was; the measurement rides inside it.
async function shadowSettle() {
  let start;
  try {
    await evalMain(OBSERVE);
    start = Date.now();
  } catch {
    return sleep(300); // measurement failed: behave as "off", report nothing
  }
  const open = [...inflight];
  netLog = [];
  await sleep(300);
  try {
    const dom = await evalMain(COLLECT);
    // A navigation logged as "settled, nothing changed" would count as agreement.
    if (dom === null) return;
    const events = [
      ...open.map(() => ({ t: start, kind: "net-start" })),
      ...netLog.filter((e) => e.t >= start),
      ...dom.map((t) => ({ t, kind: "dom" })),
    ];
    const until = start + 300;
    const T = settledAt(start, events, QUIET_MS, until);
    onSettleFn?.({ settledAt: T === null ? null : T - start, changedAfter: changedAfter(T, events, until), waited: 300 });
  } catch {
    // Navigation destroyed the context, or the evaluate threw: no report. Never the action's problem.
  }
}

async function actSettle() {
  const t0 = Date.now();
  try {
    await evalMain(OBSERVE);
    // ponytail: 1000ms is the knob. Long enough for a React re-render or a fetch
    // that fires on click, short enough that a page with a chatty poll (which
    // never goes quiet) costs 700ms more than today's wait, not a hang.
    for (;;) {
      const now = Date.now();
      const last = await evalMain(LAST);
      if (inflight.size === 0 && now - Math.max(last, lastNetT, t0) >= QUIET_MS) break;
      if (now - t0 >= 1000) break;
      await sleep(25);
    }
    // The observer and network tracking watch the main frame only, so with a
    // frame attached an action inside it looks quiet at once: keep the old wait.
    if (current().length > 1) await sleep(Math.max(0, 300 - (Date.now() - t0)));
    await evalMain(COLLECT);
  } catch {
    // Context gone or evaluate refused: the rest of the fixed wait, as if off.
    await sleep(Math.max(0, 300 - (Date.now() - t0)));
  }
}

/**
 * Let the page finish reacting before it gets read.
 *
 * The fixed 300ms covers the common case, a handler that mutates the DOM without
 * navigating — there is no event for "React finished rendering". If the action
 * did start a load, wait for that instead, but capped: a page holding one
 * analytics beacon open stays `loading` indefinitely, and the tool call has its
 * own 30s deadline in the relay that a hang here would burn.
 */
async function settle() {
  if (settleState === "act") await actSettle();
  else if (settleState === "shadow") await shadowSettle();
  else await sleep(300);
  const tab = await chrome.tabs.get(tabId);
  if (tab.status === "loading") await loaded(tabId, 10_000);
}

/**
 * The end of every action: settle, then hand back the page it produced.
 *
 * `quiet` is batch's middle steps (bridge/src/mcp.ts). They still settle, so
 * the next step meets a page that has reacted, but they must NOT read it:
 * every read moves sinceLast()'s baseline, and a read the model never sees
 * would make the batch's final delta silently omit whatever changed during it.
 */
async function after(options, ack = "done") {
  await settle();
  return options?.quiet ? ack : snapshot(options);
}

export async function detach() {
  if (tabId === null) return;
  const id = tabId;
  reset();
  await chrome.debugger.detach({ tabId: id });
  console.log(`endo: detached from tab ${id}`);
}

/**
 * Read the page. Returns indented text with a ref on everything actionable;
 * refs are valid only until the next snapshot or navigation.
 */
export async function snapshot(options) {
  requireAttached();
  // Pinned for the whole read: if a frame navigates midway, invalidate() bumps
  // the counter past this and EVERY ref from this snapshot reads as stale.
  // Reading the live counter per ref would mark only the early frames stale and
  // silently bless the rest.
  //
  // Read, not bumped. A snapshot used to invalidate the last one because refs
  // were positional and a re-read renumbered them; they are keyed on the node
  // now, so re-reading a page the model is working on no longer throws away
  // everything it knows about that page. Only invalidate() bumps — navigation,
  // a detached frame, a new attachment — which are the events that really do
  // end a ref's meaning.
  const gen = generation;
  // A peek is the gate's own read (bridge/src/mcp.ts): the whole page, uncut,
  // so a Submit outside the model's window still counts. It is nobody's view,
  // so it moves neither the refs the model holds nor sinceLast()'s baseline.
  const peek = options?.peek === true;
  const minted = new Map();

  const out = [];
  for (const [sessionId, frame] of current()) {
    // A frame that auto-attached before it had navigated was recorded with an
    // empty URL, and Page.frameNavigated cannot repair it: inside an OOPIF's own
    // session that event still carries a parentId, so the handler above skips it.
    // ponytail: ask once, only when unknown — no cost on the steady-state path,
    // and a frame that later renavigates keeps a stale but non-empty label, which
    // is orientation for the model rather than correctness.
    if (!frame.url) {
      const info = await send(sessionId, "Target.getTargetInfo").catch(() => null);
      frame.url = info?.targetInfo?.url ?? "";
    }
    if (frame.tag !== "f0") out.push(`\n--- frame ${frame.tag} — ${frame.url}`);
    try {
      await send(sessionId, "Accessibility.enable");
      const { nodes } = await send(sessionId, "Accessibility.getFullAXTree");
      const { text, refs: frameRefs } = serialize(nodes, frame.tag, peek ? { maxLines: Infinity } : options);
      for (const [ref, backendNodeId] of frameRefs) {
        minted.set(ref, { sessionId, backendNodeId, generation: gen });
      }
      out.push(text);
    } catch (err) {
      // Frames come and go mid-snapshot; one dead frame must not kill the read.
      // A frame that is gone for good says nothing worth a line — it is not
      // "unavailable", it does not exist, and the model cannot act on it.
      if (dropIfDead(sessionId, err)) console.log(`endo: frame ${frame.tag} is gone — dropped`);
      else out.push(`(frame ${frame.tag} unavailable: ${err.message})`);
    }
  }
  if (peek) return out.join("\n");
  // Points are not in the AX tree, so a re-read must not drop them.
  for (const [ref, hit] of refs) if (hit.point) minted.set(ref, hit);
  refs = minted;
  return sinceLast(out.join("\n"), gen);
}

/** The page as the model was last shown it, so an unchanged one is not re-sent. */
let shown = { generation: -1, text: "", run: 0 };

/**
 * Make the next read a full page. The bridge calls this when claude's reader
 * subagent starts and when it hands back: the two share `shown` but not their
 * contexts, so a delta against the other's read describes a page never read.
 */
export function forget() {
  shown = { generation: -1, text: "", run: 0 };
}

/**
 * How many deltas may follow one full page.
 *
 * Not a tuning knob so much as a floor under the worst case: the CLIs manage
 * their own context and can compact a long conversation, and a model whose full
 * page has been compacted away cannot patch a delta onto anything. Five bounds
 * how far back the page it is patching can be, at a cost of one full page in six.
 */
const DELTA_RUN = 5;

function sinceLast(text, gen) {
  // A different generation is a different page — navigation, a new tab, a
  // dropped frame — so there is nothing to be a delta against.
  const base = shown.generation === gen && shown.run < DELTA_RUN ? shown.text : null;
  const patch = base === null ? null : delta(base, text);
  // The full text is always what gets remembered, never the patch: the next
  // delta has to describe the page, not the last description of it.
  shown = { generation: gen, text, run: patch === null ? 0 : shown.run + 1 };
  return patch ?? text;
}

function requireAttached() {
  if (tabId === null) throw new Error("not attached — call attach() first");
}

function resolve(ref) {
  requireAttached();
  const hit = refs.get(ref);
  if (!hit) throw new Error(`unknown ref ${ref} — call snapshot() first`);
  if (hit.generation !== generation) {
    throw new Error(`stale ref ${ref} — the page changed, call snapshot() again`);
  }
  return hit;
}

/**
 * What a ref is right now, read fresh from that one node, for the gate
 * (bridge/src/mcp.ts readFor): a click is decided on the element it is about to
 * land on, not on the page the model read some steps ago. Throws "stale ref" /
 * "unknown ref" like every action, which the bridge reads as "nothing to weigh".
 */
export async function labelOf(ref) {
  const hit = resolve(ref);
  if (hit.point) return pointLabel(hit);
  const { sessionId, backendNodeId } = hit;
  await send(sessionId, "Accessibility.enable");
  const { nodes } = await send(sessionId, "Accessibility.getPartialAXTree", { backendNodeId, fetchRelatives: false });
  const node = nodes.find((n) => n.backendDOMNodeId === backendNodeId) ?? nodes[0];
  if (!node) throw new Error(`no accessibility node for ${ref}`);
  return lineLabel(node);
}

// See: where `find` said something is, as a viewport position (CSS px) rather
// than a node. The counter never repeats, so a point from an earlier page can
// only read as stale, never as a different point.
let seeState = "off";
let pointSeq = 0;

export const setSee = (state) => void (seeState = state === "act" ? "act" : "off");
export const getSee = () => seeState;

/** Pixel size of a JPEG, read from its SOF marker. */
export function jpegSize(bytes) {
  for (let i = 2; i + 9 < bytes.length; ) {
    if (bytes[i] !== 0xff) { i++; continue; }
    const m = bytes[i + 1];
    if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) {
      return { height: (bytes[i + 5] << 8) | bytes[i + 6], width: (bytes[i + 7] << 8) | bytes[i + 8] };
    }
    i += m === 0xd8 || m === 0x01 || (m >= 0xd0 && m <= 0xd7) ? 2 : 2 + ((bytes[i + 2] << 8) | bytes[i + 3]);
  }
  throw new Error("screenshot is not a readable JPEG");
}

/** The viewport's own screenshot, for Jev. Refuses unless See is on: the panel's check, not the bridge's. */
export async function screenshot() {
  if (seeState !== "act") throw new Error("See is off: no screenshot taken");
  requireAttached();
  const { cssVisualViewport: v } = await send(MAIN, "Page.getLayoutMetrics");
  // Clipped to the viewport the point is mapped in: unclipped, the image also
  // holds the scrollbar strip, and a box's fraction of it lands up to 15 px
  // left of the thing at the right edge (measured: 2534 px wide against 2504).
  const clip = { x: v.pageX, y: v.pageY, width: v.clientWidth, height: v.clientHeight, scale: 1 };
  let { data } = await send(MAIN, "Page.captureScreenshot", { format: "jpeg", quality: 80, clip });
  let bytes = Uint8Array.from(atob(data), (c) => c.charCodeAt(0));
  let { width, height } = jpegSize(bytes);
  // Jev takes 256..1568 px a side; a hidpi viewport can exceed it.
  const scale = Math.min(1, 1568 / Math.max(width, height));
  if (scale < 1) {
    width = Math.round(width * scale);
    height = Math.round(height * scale);
    const canvas = new OffscreenCanvas(width, height);
    canvas.getContext("2d").drawImage(await createImageBitmap(new Blob([bytes])), 0, 0, width, height);
    bytes = new Uint8Array(await (await canvas.convertToBlob({ type: "image/jpeg", quality: 0.8 })).arrayBuffer());
    data = btoa(bytes.reduce((s, b) => s + String.fromCharCode(b), ""));
  }
  console.log(`endo: screenshot ${width}x${height}`);
  return { data, width, height, viewport: { width: v.clientWidth, height: v.clientHeight } };
}

/** Mint a point ref at a viewport position. Clickable and hoverable, nothing else. */
export async function point(x, y, query) {
  requireAttached();
  const { cssLayoutViewport: v } = await send(MAIN, "Page.getLayoutMetrics");
  if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || y < 0 || x >= v.clientWidth || y >= v.clientHeight) {
    throw new Error(`point ${x},${y} is outside the ${v.clientWidth}x${v.clientHeight} viewport`);
  }
  const ref = `@p${++pointSeq}`;
  refs.set(ref, { point: { x, y }, query: String(query ?? "").trim().slice(0, 200), sessionId: MAIN, generation });
  return ref;
}

const ACTIONABLE = /^(button|link|menuitem\w*|checkbox|radio|switch|tab|option|combobox|textbox|searchbox)$/;

/**
 * What is really under a point, for the gate: the node there plus its ancestors
 * up to the nearest actionable one, because a click on the <svg> inside
 * <button aria-label="Place order"> lands on the button. Throws on any failure or
 * when nothing in the chain has a name: the bridge reads a throw as "ask the
 * human", and the model's own query text is never what the gate decides on.
 */
async function pointLabel({ point: { x, y }, query }) {
  await send(MAIN, "DOM.getDocument", { depth: 0 });
  const { backendNodeId } = await send(MAIN, "DOM.getNodeForLocation", { x: Math.floor(x), y: Math.floor(y), includeUserAgentShadowDOM: true });
  await send(MAIN, "Accessibility.enable");
  const { nodes } = await send(MAIN, "Accessibility.getPartialAXTree", { backendNodeId, fetchRelatives: true });
  const byId = new Map(nodes.map((n) => [n.nodeId, n]));
  const chain = [];
  for (let n = nodes.find((n) => n.backendDOMNodeId === backendNodeId); n && chain.length < 20; n = byId.get(n.parentId)) {
    chain.push(n);
    if (ACTIONABLE.test(n.role?.value ?? "")) break;
  }
  if (!chain.some((n) => n.name?.value)) throw new Error("nothing readable under that point");
  return `[point] "${query}" over ${chain.map(lineLabel).join(" in ")}`;
}

const noPoint = (ref) => {
  throw new Error(`${ref} is a point on the screen: only click and hover take it`);
};

/** Centre of a ref in its own frame's coordinates, scrolled into view first. */
async function centreOf(ref) {
  const hit = resolve(ref);
  if (hit.point) return hit.point;
  const { sessionId, backendNodeId } = hit;
  await send(sessionId, "DOM.scrollIntoViewIfNeeded", { backendNodeId });
  const { model } = await send(sessionId, "DOM.getBoxModel", { backendNodeId });
  const [x1, y1, x2, y2, x3, y3, x4, y4] = model.content;
  return { x: (x1 + x2 + x3 + x4) / 4, y: (y1 + y2 + y3 + y4) / 4 };
}

/**
 * Click at the element's centre with a real mouse event, dispatched to the
 * element's OWN session so the coordinates and the widget receiving them share
 * one space.
 *
 * Mouse events sent to the tab's main session are hit-tested by the root
 * renderer alone and never cross into an out-of-process iframe. Measured on the
 * fixture: the same submit button does nothing at translated root coords
 * 104,362 on MAIN, and submits at frame coords 79,197 on the frame's session.
 * So an OOPIF box model needs no translation — just the matching session.
 *
 * Keyboard is the opposite and stays on MAIN: key events follow focus, and the
 * browser routes those into the focused OOPIF widget for us.
 *
 * Returns the page as it looks afterwards. A click is the one action that
 * reliably changes what the agent needs to see next, and asking for that
 * separately cost a whole model turn — which re-sends the entire conversation,
 * not just the snapshot. Phase 2 spent six of them on one search.
 */
export async function click(ref, options) {
  // ponytail: a point inside a cross-site iframe is dispatched on MAIN, which
  // never reaches an OOPIF (above). Upgrade: hit-test the frame, re-dispatch there.
  const { sessionId } = resolve(ref);
  const { x, y } = await centreOf(ref);
  const base = { x, y, button: "left", clickCount: 1 };
  await send(sessionId, "Input.dispatchMouseEvent", { ...base, type: "mouseMoved", buttons: 0 });
  await send(sessionId, "Input.dispatchMouseEvent", { ...base, type: "mousePressed", buttons: 1 });
  await send(sessionId, "Input.dispatchMouseEvent", { ...base, type: "mouseReleased", buttons: 0 });
  console.log(`endo: click ${ref} at ${Math.round(x)},${Math.round(y)}`);
  return after(options);
}

/**
 * Move the mouse onto an element and return the page it revealed.
 *
 * Hover-open menus have no click to drive them: the items simply do not exist
 * in the DOM (or are display:none, which keeps them out of the AX tree) until
 * something is hovering. Same session rule as click — a mouseMoved sent to MAIN
 * is hit-tested by the root renderer and never reaches an OOPIF.
 */
export async function hover(ref, options) {
  const { sessionId } = resolve(ref);
  const { x, y } = await centreOf(ref);
  await send(sessionId, "Input.dispatchMouseEvent", { type: "mouseMoved", x, y, button: "none", buttons: 0 });
  console.log(`endo: hover ${ref} at ${Math.round(x)},${Math.round(y)}`);
  return after(options);
}

/**
 * Scroll the page — or, with a ref, whatever scrollable thing that ref sits in.
 *
 * A real wheel event, not window.scrollBy(), for two reasons: it is trusted, so
 * the IntersectionObserver behind an infinite feed actually fires and appends
 * the next batch; and it is hit-tested at a point, so a wheel over an open
 * combobox flyout scrolls the flyout rather than the document behind it. That
 * second case is the one real ATS forms hit.
 *
 * Note this is NOT what makes below-the-fold elements reachable — the AX tree
 * covers the whole document and centreOf() already scrolls a ref into view
 * before clicking it. What scrolling buys is content that is not in the DOM yet.
 */
export async function scroll(direction = "down", ref, options) {
  requireAttached();
  if (ref && resolve(ref).point) noPoint(ref);
  const sessionId = ref ? resolve(ref).sessionId : MAIN;
  // The frame's own viewport when a ref names one — an OOPIF's metrics are its
  // own, so a wheel inside it must be aimed and sized in that space.
  const { cssLayoutViewport: view, cssVisualViewport: from, cssContentSize: size } = await send(sessionId, "Page.getLayoutMetrics");
  const at = ref ? await centreOf(ref) : { x: view.clientWidth / 2, y: view.clientHeight / 2 };
  // Just under a screenful, the way Page Down behaves: a full one can step over
  // a lazy-load trigger, and the overlap keeps the model oriented between reads.
  const deltaY = Math.round(view.clientHeight * 0.8) * (direction === "up" ? -1 : 1);
  await send(sessionId, "Input.dispatchMouseEvent", {
    type: "mouseWheel",
    x: at.x,
    y: at.y,
    deltaX: 0,
    deltaY,
    button: "none",
    buttons: 0,
  });
  console.log(`endo: scroll ${direction} ${deltaY}px at ${Math.round(at.x)},${Math.round(at.y)}`);
  // The scroll lands on the compositor's next frame, not when the event is
  // acked: ~0.1 s normally, ~1 s in a minimized window, which draws one frame a
  // second (measured). Waited out by the document's offset so the read after
  // sees what the scroll loaded. Not at the edge already: nothing would move.
  // ponytail: the document only; a ref-scoped scroll is not waited for.
  const edge = deltaY > 0 ? size.height - from.pageY - from.clientHeight < 1 : from.pageY < 1;
  for (const t0 = Date.now(); !ref && !edge && Date.now() - t0 < 1500; await sleep(50)) {
    if ((await send(MAIN, "Page.getLayoutMetrics")).cssVisualViewport.pageY !== from.pageY) break;
  }
  return after(options);
}

/**
 * Type into a ref, one trusted keystroke per character, so React's onChange and
 * every autocomplete widget that listens for keydown actually fire.
 */
export async function type(ref, text) {
  if (resolve(ref).point) noPoint(ref);
  const { sessionId, backendNodeId } = resolve(ref);
  await send(sessionId, "DOM.focus", { backendNodeId });
  // ponytail: per-char, no batching. Design doc's ceiling is ~200 chars before
  // Input.insertText is worth it; nothing typed into a form field is near that.
  // A line break as a key event is Enter, which submits a form with no gate
  // (type is never gated). insertText puts a newline in a <textarea> and an
  // <input> drops it, so nothing submits. "\r\n" counts as one break.
  for (const ch of text.replace(/\r\n|\r/g, "\n")) {
    if (ch === "\n") {
      await send(MAIN, "Input.insertText", { text: "\n" });
      continue;
    }
    // Alphanumerics carry their US-layout key code, which is what handlers that
    // sniff event.keyCode expect. Everything else goes through as text only —
    // a full layout table is not worth 200 lines here.
    const windowsVirtualKeyCode = /[a-z0-9]/i.test(ch) ? ch.toUpperCase().charCodeAt(0) : 0;
    const base = { text: ch, unmodifiedText: ch, key: ch, windowsVirtualKeyCode };
    await send(MAIN, "Input.dispatchKeyEvent", { ...base, type: "keyDown" });
    await send(MAIN, "Input.dispatchKeyEvent", { ...base, type: "keyUp" });
  }
  console.log(`endo: typed ${text.length} chars into ${ref}`);
}

const KEYS = {
  Enter: { windowsVirtualKeyCode: 13, code: "Enter", key: "Enter", text: "\r" },
  Tab: { windowsVirtualKeyCode: 9, code: "Tab", key: "Tab" },
  Escape: { windowsVirtualKeyCode: 27, code: "Escape", key: "Escape" },
  Backspace: { windowsVirtualKeyCode: 8, code: "Backspace", key: "Backspace" },
  ArrowDown: { windowsVirtualKeyCode: 40, code: "ArrowDown", key: "ArrowDown" },
  ArrowUp: { windowsVirtualKeyCode: 38, code: "ArrowUp", key: "ArrowUp" },
};

/** Press a named key at whatever currently has focus. Returns the page after it. */
export async function key(name, options) {
  requireAttached();
  const spec = KEYS[name];
  if (!spec) throw new Error(`unknown key ${name} — have ${Object.keys(KEYS).join(", ")}`);
  const { text, ...rest } = spec; // text belongs on keyDown only, or Enter types twice
  await send(MAIN, "Input.dispatchKeyEvent", { ...rest, text, type: "keyDown" });
  await send(MAIN, "Input.dispatchKeyEvent", { ...rest, type: "keyUp" });
  console.log(`endo: key ${name}`);
  return after(options);
}

/**
 * Set a file on a page's file input by filesystem path — no ref, deliberately.
 *
 * Job forms (Greenhouse, Lever, Ashby) hide <input type=file> behind a styled
 * button or dropzone, so the input is frequently missing from the AX tree
 * entirely — there is no ref to hand this on exactly the sites that matter.
 * DOM.setFileInputFiles works on a hidden input and fires a real change
 * event, which is what those forms listen for. No ref also means nothing
 * here can go stale.
 */
export async function upload(path, match, options) {
  requireAttached();
  const hits = [];
  for (const [sessionId, frame] of current()) {
    try {
      const { root } = await send(sessionId, "DOM.getDocument", { depth: 0 });
      const { nodeIds } = await send(sessionId, "DOM.querySelectorAll", {
        nodeId: root.nodeId,
        selector: "input[type=file]",
      });
      for (const nodeId of nodeIds) {
        const { attributes } = await send(sessionId, "DOM.getAttributes", { nodeId });
        const attrs = {};
        for (let i = 0; i < attributes.length; i += 2) attrs[attributes[i]] = attributes[i + 1];
        // Whitespace collapsed: the label is the page's text and lands in the
        // result's first line, and one carrying a newline could forge a line the
        // bridge parses as page (the delta marker, a ref) in front of the real one.
        const label = String(attrs["aria-label"] ?? attrs.name ?? attrs.id ?? attrs.accept ?? "(unlabelled)").replace(/\s+/g, " ").trim();
        hits.push({ sessionId, nodeId, label });
      }
    } catch (err) {
      // Frames come and go; one dead frame must not kill the whole operation.
      if (dropIfDead(sessionId, err)) console.log(`endo: frame ${frame.tag} is gone — dropped`);
      else console.warn(`endo: upload scan skipped frame ${frame.tag}`, err);
    }
  }

  if (hits.length === 0) {
    throw new Error("no file input on this page — the upload control may be behind a button that has to be clicked first");
  }

  // Greenhouse's standard form carries a "Resume/CV" AND a "Cover Letter"
  // input, so first-wins on its own would make the second permanently
  // unreachable — and the "others:" line below would be reporting a choice
  // the model has no way to make.
  const wanted = match?.trim().toLowerCase();
  const pool = wanted ? hits.filter((h) => h.label.toLowerCase().includes(wanted)) : hits;
  if (!pool.length) {
    throw new Error(`no file input matching "${match}" — found: ${hits.map((h) => h.label).join(", ")}`);
  }

  const [chosen, ...rest] = pool;
  await send(chosen.sessionId, "DOM.setFileInputFiles", { files: [path], nodeId: chosen.nodeId });
  console.log(`endo: upload "${path}" -> input "${chosen.label}"`);
  await settle();
  const page = await snapshot(options);
  // "succeeded" said plainly, because the page below often contradicts it: a
  // React form re-renders its attach UI after settle()'s 300ms, so a Greenhouse
  // upload that worked hands back a page still reading "No file chosen".
  // Measured 2026-08-04. Without this line the agent reads its own success as a
  // failure and retries — the trap the whole "actions return the page" design
  // already walked into once.
  // No path in the text: the model never sees one.
  let prefix = `set the file on file input "${chosen.label}" — succeeded; the page below may still show the old state for a moment`;
  if (rest.length) {
    prefix += ` (first of ${pool.length} — others: ${rest.map((h) => h.label).join(", ")}; pass match to pick one)`;
  }
  return `${prefix}\n${page}`;
}

/**
 * Runs INSIDE the page via Runtime.callFunctionOn (see select() below) — never
 * called locally, only stringified, so DOM globals here are fine unresolved.
 */
function pickOption(value) {
  // String(), not .toLowerCase() on the raw value: a ref can resolve to a node
  // with no tagName at all, and throwing in here surfaces as an exception the
  // caller reads as success — see select()'s exceptionDetails check.
  const tag = this.tagName;
  // Greenhouse, Lever and Ashby all use a custom combobox — an <input> plus a
  // flyout listbox — not a native <select>, so this is the COMMON case on real
  // ATS forms, not an edge case. click() drives those fine (the flyout's
  // options land in the AX tree with their own refs), so the error hands back
  // the recovery instead of just refusing.
  if (tag !== "SELECT") {
    return `error: not a <select> — got ${String(tag).toLowerCase()}. This is a custom combobox: click this ref to open its flyout, then click the option you want in the page that comes back. Typing into it first usually filters a long list.`;
  }
  const target = String(value).trim();
  const opts = [...this.options];
  let match = opts.find((o) => o.value === target);
  if (!match) match = opts.find((o) => o.text.trim() === target);
  if (!match) {
    const needle = target.toLowerCase();
    match = opts.find((o) => o.text.trim().toLowerCase().includes(needle));
  }
  if (!match) {
    const available = opts.map((o) => o.text.trim()).slice(0, 20).join(", ");
    return `error: no option matching "${target}" — available: ${available}`;
  }
  this.selectedIndex = match.index;
  // React listens for one, plain forms for the other — fire both.
  this.dispatchEvent(new Event("input", { bubbles: true }));
  this.dispatchEvent(new Event("change", { bubbles: true }));
  return match.text.trim();
}

/**
 * Choose an option in a native <select> by value or visible text.
 *
 * A native select's popup is rendered by the BROWSER, not the renderer, so
 * Input.dispatchMouseEvent — hit-tested by the renderer — can never land on
 * an option inside it. click() cannot drive a dropdown at all; this is the
 * only route: set selectedIndex directly from inside the page and fire the
 * events a dropdown listener actually waits for.
 */
export async function select(ref, value, options) {
  if (resolve(ref).point) noPoint(ref);
  const { sessionId, backendNodeId } = resolve(ref);
  const { object } = await send(sessionId, "DOM.resolveNode", { backendNodeId });
  const { result, exceptionDetails } = await send(sessionId, "Runtime.callFunctionOn", {
    objectId: object.objectId,
    functionDeclaration: pickOption.toString(),
    arguments: [{ value }],
    returnByValue: true,
  });

  // A throw inside the page leaves `result` holding the exception and `value`
  // undefined, which would otherwise read as success and hand back a page with
  // the dropdown silently unset — a required field left blank on a form the
  // agent then submits. Fail loudly instead.
  if (exceptionDetails) {
    throw new Error(`select failed inside the page: ${exceptionDetails.exception?.description ?? exceptionDetails.text}`);
  }

  const outcome = result.value;
  if (typeof outcome === "string" && outcome.startsWith("error:")) {
    throw new Error(outcome.slice("error: ".length));
  }
  console.log(`endo: select ${ref} -> "${outcome}"`);
  return after(options, `selected "${outcome}"`);
}

/** What is attached right now — for eyeballing state from the console. */
export const state = () => ({
  tabId,
  generation,
  frames: [...sessions.values()],
  refs: refs.size,
});

chrome.debugger.onEvent.addListener(onEvent);
chrome.debugger.onDetach.addListener((source, reason) => {
  if (source.tabId !== tabId) return;
  console.warn(`endo: debugger detached (${reason})`);
  reset();
});
