import { render } from "./md.js";

/**
 * The conversation view.
 *
 * What this replaces: one <pre> that every event was appended to as a
 * timestamped line — prose, tool calls with their raw JSON args, cost, errors,
 * all in the same monospace stream. A markdown table arrived as literal pipes
 * because the log was textContent. The verdict on that was fair: "it doesn't
 * look like an assistant, just looks like gibberish."
 *
 * The shape here: the answer is the content, and everything else is evidence.
 * Evidence is available, not loud — one grey sentence per tool call, folded,
 * behind an indent rail, at 11.5px. Open a row and the args and result are
 * there in full.
 *
 * Same rule as md.js and for the same reason: this carries page content from
 * arbitrary sites, so nothing here ever touches innerHTML.
 */

let chatEl = null;
let stepEl = null;
let rawEl = null;

/**
 * Everything rendered, as plain data, so a transcript can outlive the document
 * showing it. Chrome tears the side panel down on every window switch, so this
 * is not a nice-to-have: without it the conversation you are watching vanishes
 * the moment you click another window, while the task carries on running.
 *
 * The journal is the source of truth for persistence; the DOM is a view of it.
 */
let journal = [];
let replaying = false;
let onChange = () => {};

/** Wired once by the panel. Every call before this is a no-op, never a throw. */
export function mount(chat, step, raw, changed) {
  chatEl = chat;
  stepEl = step;
  rawEl = raw;
  if (changed) onChange = changed;
}

/** Journal an entry and tell the panel to save. Silent during a replay. */
function record(entry) {
  if (replaying) return entry;
  journal.push(entry);
  onChange();
  return entry;
}

/** A journalled entry changed in place (a tool call settling). */
function touch() {
  if (!replaying) onChange();
}

export const snapshot = () => journal;

// Pin to the bottom as things land, but never yank the view while someone is
// reading scrollback — the panel is narrow and a long snapshot scrolls a long way.
function add(node) {
  if (!chatEl) return node;
  // Hidden rather than removed: New Session brings it back, and its seed
  // buttons are wired once at load — a removed node takes its listeners with it.
  //
  // Notes are exempt, and that exemption is the whole reason the empty state is
  // ever seen: a note is the panel talking about itself (connection state, a
  // warning), not conversation, and the first thing a fresh panel did was post
  // one — which hid the empty state before anybody could read it. Measured in
  // headless: on a first run the invitation and its three example tasks
  // rendered and vanished in the same frame.
  if (!node.classList?.contains("note")) chatEl.querySelector(".empty")?.classList.add("gone");
  const atBottom = chatEl.scrollHeight - chatEl.scrollTop - chatEl.clientHeight < 60;
  chatEl.appendChild(node);
  if (atBottom) chatEl.scrollTop = chatEl.scrollHeight;
  return node;
}

function block(className, text) {
  const el = document.createElement("div");
  el.className = className;
  if (text !== undefined) el.textContent = String(text ?? "");
  return el;
}

/** What you typed, read back exactly as typed — never markdown-rendered. */
export const user = (text) => {
  record({ k: "user", text: String(text ?? "") });
  add(block("msg user", text));
};

export function assistant(md) {
  record({ k: "assistant", md: String(md ?? "") });
  const el = block("msg assistant");
  // md.js never throws on page data, but a renderer that did would take the
  // whole panel with it — actions return the page, so a broken render reads
  // as a broken action.
  try {
    el.appendChild(render(md));
  } catch (err) {
    el.textContent = String(md ?? "");
    note(`could not render that answer — ${err.message}`);
  }
  add(el);
}

export const note = (text, bad = false) => {
  record({ k: "note", text: String(text ?? ""), bad });
  add(block(bad ? "note bad" : "note", text));
};

export const chip = (text) => {
  record({ k: "chip", text: String(text ?? "") });
  add(block("chip", text));
};

/** The live "what is it doing right now" line. step(null) clears it. */
export function step(text) {
  if (!stepEl) return;
  stepEl.textContent = text ? String(text) : "";
  stepEl.classList.toggle("on", Boolean(text));
}

const host = (url) => {
  try {
    return new URL(String(url)).host;
  } catch {
    return String(url ?? "");
  }
};

const quoted = (label, ref) => (label ? label.replace(/^\[\w+\]\s*/, "") : String(ref ?? ""));

// One readable sentence per tool. The label comes from the bridge, which
// already keeps a ref->label map for the approval gate, so "clicked @f0e38"
// can read `clicked "Submit application"` for free.
const PHRASE = {
  navigate: (a) => `went to ${host(a.url)}`,
  use_tab: (a) => (a.url ? `opened ${host(a.url)}` : `switched to tab ${a.id}`),
  snapshot: (a) => (a.from ? "read further down the page" : "read the page"),
  click: (a, label) => `clicked ${quoted(label, a.ref)}`,
  type: (a, label) => `typed "${a.text}" into ${quoted(label, a.ref)}`,
  key: (a) => `pressed ${a.name}`,
  select: (a, label) => `chose "${a.value}" in ${quoted(label, a.ref)}`,
  upload: () => "attached a file",
  scroll: (a) => `scrolled ${a.direction ?? "down"}`,
  hover: (a, label) => `hovered ${quoted(label, a.ref)}`,
  back: () => "went back",
  forward: () => "went forward",
  tabs: () => "looked at the open tabs",
};

function summarise(name, args, label) {
  try {
    const phrase = PHRASE[name];
    // ponytail: an unknown tool prints its name and args rather than guessing.
    return phrase ? phrase(args ?? {}, label) : `${name} ${JSON.stringify(args ?? {})}`;
  } catch {
    return String(name);
  }
}

/**
 * Consecutive calls share one rail. Grouping them in a container rather than
 * styling each row's left border is what makes the line unbroken by
 * construction — the previous version cancelled the flex gap with a negative
 * margin per row and the rail still showed seams.
 */
function railFor() {
  const last = chatEl?.lastElementChild;
  if (last?.classList.contains("trace")) return last;
  return add(block("trace"));
}

/**
 * A tool call, rendered the moment it starts. Returns handles the caller
 * settles later — the call is already visible while it runs, which is the
 * whole point of showing steps live.
 */
export function tool(name, args, label) {
  const entry = record({ k: "tool", name, args, label });
  const row = document.createElement("details");
  // `running` is what puts the live node on the rail — the whole reason the row
  // goes up before the call rather than after it.
  row.className = "tool running";
  // #chat is a live region, so without this a twenty-call run is twenty
  // announcements. The trace recedes visually through size and weight; this is
  // the same decision for a screen reader. #step still narrates the current one.
  row.setAttribute("aria-live", "off");
  const summary = document.createElement("summary");
  summary.textContent = summarise(name, args, label);
  const body = document.createElement("pre");
  body.textContent = JSON.stringify(args ?? {}, null, 2);
  row.append(summary, body);

  const rail = railFor();
  rail.appendChild(row);
  if (chatEl && chatEl.scrollHeight - chatEl.scrollTop - chatEl.clientHeight < 120) {
    chatEl.scrollTop = chatEl.scrollHeight;
  }
  step(summary.textContent);

  const settle = (className, extra) => {
    row.classList.remove("running");
    row.classList.add(className);
    if (extra !== undefined) body.textContent += `\n\n${String(extra ?? "")}`;
    entry.state = className;
    entry.extra = String(extra ?? "");
    touch();
  };
  return {
    ok: (result) => settle("ok", result),
    fail: (message) => {
      settle("failed", message);
      // A span, not appended text: only the verdict is coloured, so a failure
      // is noticeable without turning a whole trace line into an alarm.
      const verdict = document.createElement("span");
      verdict.className = "verdict";
      verdict.textContent = " — failed";
      summary.appendChild(verdict);
    },
  };
}

let gateEl = null;
let gateEntry = null;

export function gateRow(action) {
  gateEntry = record({ k: "gate", action: String(action ?? "") });
  gateEl = block("gate-row", `approval asked — ${action}`);
  add(gateEl);
}

export function gateSettled(approved) {
  if (!gateEl) return;
  gateEl.textContent = `${approved ? "approved" : "denied"} — ${gateEl.textContent.replace(/^approval asked — /, "")}`;
  gateEl.classList.add(approved ? "ok" : "failed");
  if (gateEntry) gateEntry.approved = approved === true;
  gateEl = null;
  gateEntry = null;
  touch();
}

/**
 * The raw diagnostic log, kept verbatim and kept complete. It is what gets
 * pasted into a bug report, and it is the only way to tell a run whose tools
 * were missing from one that faked its tool calls as text — so it takes every
 * message received, including the ones the conversation view drops.
 *
 * Appended as a node, never `textContent +=`: that re-wrote the whole log on
 * every message, and a log of fifteen runs (761k characters) cost 118 ms of
 * the panel's one thread per message. Every lane's tool calls wait on that
 * thread, so with two runs going they took turns (measured, Phase 21).
 */
export function raw(line) {
  if (!rawEl) return;
  rawEl.append(`${new Date().toLocaleTimeString()}  ${line}\n`);
  // Reading scrollHeight lays the log out, ~5 ms at that size even folded
  // away. Followed only while it is open; the panel scrolls it on opening.
  if (rawEl.closest("details")?.open) rawEl.scrollTop = rawEl.scrollHeight;
}

export function clear() {
  journal = [];
  if (chatEl) {
    // Everything except the empty state, which is markup from panel.html with
    // listeners already bound to it — replaceChildren() would take it too.
    for (const node of [...chatEl.children]) if (!node.classList.contains("empty")) node.remove();
    chatEl.querySelector(".empty")?.classList.remove("gone");
  }
  gateEl = null;
  gateEntry = null;
  step(null);
}

/**
 * Rebuild a transcript from its journal — a reopened panel, or an earlier
 * session picked out of the history. Deliberately replays through the same
 * builders rather than storing HTML: the entries are the durable format, and
 * a stored string of markup is a stored XSS vector from arbitrary page text.
 */
export function restore(entries) {
  clear();
  replaying = true;
  try {
    for (const entry of entries ?? []) {
      if (entry.k === "user") user(entry.text);
      else if (entry.k === "assistant") assistant(entry.md);
      else if (entry.k === "note") note(entry.text, entry.bad);
      else if (entry.k === "chip") chip(entry.text);
      else if (entry.k === "gate") {
        gateRow(entry.action);
        if (entry.approved !== undefined) gateSettled(entry.approved);
      } else if (entry.k === "tool") {
        const row = tool(entry.name, entry.args, entry.label);
        if (entry.state === "ok") row.ok(entry.extra);
        else if (entry.state === "failed") row.fail(entry.extra);
      }
    }
  } finally {
    replaying = false;
  }
  journal = entries ?? [];
  // tool() sets the live step line as it goes; a replayed run is not running.
  step(null);
  if (chatEl) chatEl.scrollTop = chatEl.scrollHeight;
}
