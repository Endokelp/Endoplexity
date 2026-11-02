/**
 * The page as last read — the one place the bridge keeps it. Every
 * snapshot/navigate/click/key result relayed back is text produced by
 * extension/ax.js's serialize() (or delta()), shaped like
 *   @f0e38 [button] "Submit Application" (required)
 * gate.ts reads it as a ref -> label map to tell an irreversible click from an
 * ordinary one; find() reads the same lines to turn a description into refs.
 */

import { UNCHANGED } from "../../extension/ax.js";

// One actionable line out of serialize(): "@ref [role] "name"", optionally
// followed by a value or flags the gate does not need.
const LINE = /^\s*(@\S+)\s+(\[[a-zA-Z]+\]\s+"[^"]*")/;
// Any ref line, named or not, with its role, name and value for find().
const CONTROL = /^(\s*)(@\S+)\s+\[([a-zA-Z]+)\](?:\s+"([^"]*)")?(?:\s*=\s*"([^"]*)")?/;
const HEADING = /^\s*\[heading\]\s+"([^"]*)"/;
const CONTINUATION = /^… \d+ earlier lines not shown/;
const refOf = (line: string) => /^\s*(@\S+)/.exec(line)?.[1];

let lines: string[] = [];
let labels = new Map<string, string>();

/** The ref -> label map of a page's text, without keeping it (the gate's peek). */
export function labelsOf(text: string | string[]): Map<string, string> {
  const found = new Map<string, string>();
  for (const line of typeof text === "string" ? text.split("\n") : text) {
    const m = LINE.exec(line);
    if (m) found.set(m[1], m[2]);
  }
  return found;
}

function set(next: string[]): void {
  lines = next;
  labels = labelsOf(next);
}

const isMarker = (line: string) => line.trim().startsWith("… ");

/**
 * Parse a page the panel returned into the current page. Refs are per-page —
 * cdp.js mints a fresh generation on every snapshot and invalidates the last
 * one — so a full page replaces; a delta patches; a continuation window merges.
 *
 * Only ever handed a page: mcp.ts keeps acks ("typed 4 characters into
 * @f0e8", the tab list) and error text away from here. It used to infer "no
 * ref lines means an ack" instead, which left a ref-free page answering find()
 * with the controls of the one before it.
 */
export function remember(text: string): void {
  const all = text.split("\n");
  // A delta names only what CHANGED, so replacing the page with one would blind
  // the gate to every control that stayed put — and "Submit application" is
  // precisely the thing that does not move while a form is being filled. Patch
  // instead. The marker is matched as a LINE anywhere, not only at the start:
  // upload and batch results put step lines before the page, and a delta behind
  // such a prefix used to be ignored, leaving a new Submit button ungated.
  // UNCHANGED is imported from ax.js rather than written out again: a copy of
  // the marker could drift silently into a gate that never fires.
  const at = all.indexOf(UNCHANGED);
  if (at >= 0) {
    const next = [...lines];
    const patch = all.slice(at + 1).filter((l) => l[0] === "+" || l[0] === "-");
    // Removals come first in a delta, so a control whose label merely changed
    // is deleted and re-added in that order rather than deleted afterwards.
    let kept = next;
    for (const l of patch) {
      if (l[0] !== "-") continue;
      const gone = l.slice(1).trim();
      const ref = refOf(gone);
      // Every copy of a ref goes: a merged window can hold one twice.
      if (ref) kept = kept.filter((x) => refOf(x) !== ref);
      else {
        const i = kept.findIndex((x) => x.trim() === gone);
        if (i >= 0) kept.splice(i, 1);
      }
    }
    // ponytail: a delta line carries no position (ax.js drops the indent), so
    // additions land at the end with indent 0; their tree context is lost for
    // find(). Ceiling: have the extension send the line index if that matters.
    for (const l of patch) {
      if (l[0] !== "+") continue;
      const added = l.slice(1).trim();
      const ref = refOf(added);
      const i = ref ? kept.findIndex((x) => refOf(x) === ref) : -1;
      if (i >= 0) kept[i] = added;
      else kept.push(added);
    }
    set(kept);
    return;
  }
  if (all.some((l) => CONTINUATION.test(l))) {
    // A `from:` window of the same read: refs keep their meaning across
    // windows, so merge. Replacing would drop a Submit button read in the
    // first window and let it click ungated.
    const next = [...lines];
    for (const l of all) {
      if (isMarker(l)) continue;
      const ref = refOf(l);
      const i = ref ? next.findIndex((x) => refOf(x) === ref) : -1;
      if (i >= 0) next[i] = l;
      else next.push(l);
    }
    set(next);
    return;
  }
  set(all);
}

// Look up a ref's label without gating anything, for the UI to render e.g.
// `clicked "Submit application"` instead of a bare ref. Undefined for a
// stale/unknown ref — same "not on the current page" case check() treats as
// nothing worth blocking on.
export function labelFor(ref: string): string | undefined {
  return labels.get(ref);
}

export function controls(): Iterable<[ref: string, label: string]> {
  return labels;
}

export function hasPage(): boolean {
  return lines.length > 0;
}

/** Up to n lines either side of a ref's line, without it: what a control sits among, for a reflex. */
export function near(ref: string, n = 3): string[] {
  const i = lines.findIndex((l) => refOf(l) === ref);
  if (i < 0) return [];
  return [...lines.slice(Math.max(0, i - n), i), ...lines.slice(i + 1, i + 1 + n)].map((l) => l.trim());
}

// The score of the "none of these" pseudo-candidate find() weighs every match against.
const NONE = 0.35;
const STOP = new Set("the a an to on in for of and or with at by my this that please click press find".split(" "));
const FIELD = ["textbox", "searchbox", "combobox"];
const ROLES: Record<string, string[]> = {
  button: ["button"], link: ["link"],
  field: FIELD, input: FIELD, textbox: FIELD, box: FIELD, text: FIELD,
  checkbox: ["checkbox"], tick: ["checkbox"], radio: ["radio"],
  dropdown: ["combobox", "listbox"], select: ["combobox", "listbox"],
  combobox: ["combobox", "listbox"], picker: ["combobox", "listbox"],
  menu: ["menuitem", "menuitemcheckbox", "menuitemradio"], tab: ["tab"], option: ["option"],
  slider: ["slider"], range: ["slider"], switch: ["switch"], toggle: ["switch"],
};
const tokens = (s: string) => s.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];

function lev(a: string, b: string): number {
  let row = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const next = [i];
    for (let j = 1; j <= b.length; j++) {
      next[j] = Math.min(row[j] + 1, next[j - 1] + 1, row[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    row = next;
  }
  return row[b.length];
}

function sim(q: string, t: string): number {
  if (q === t) return 1;
  const [s, l] = q.length <= t.length ? [q, t] : [t, q];
  if (s.length >= 3 && l.startsWith(s)) return 0.8;
  if (q.length >= 4 && t.length >= 4 && lev(q, t) === 1) return 0.6;
  return 0;
}

const best = (q: string, ts: string[]) => ts.reduce((m, t) => Math.max(m, sim(q, t)), 0);

/**
 * Rank the page's controls against a plain description ("submit button").
 * ponytail: p is a softmax of a hand-made lexical score, not a calibrated
 * probability. Phase 16 wraps this as a reflex backend and calibrates it
 * against real pages; until then read p as a ranking aid, not odds.
 */
export function find(query: string, limit = 5): { ref: string; line: string; p: number }[] {
  const roles = new Set<string>();
  const words: string[] = [];
  for (const t of tokens(query)) {
    if (STOP.has(t)) continue;
    // Own keys only: "constructor" is on every object's prototype.
    if (Object.hasOwn(ROLES, t)) ROLES[t].forEach((r) => roles.add(r));
    else words.push(t);
  }
  if (!words.length && !roles.size) return [];

  const scored: { ref: string; line: string; score: number }[] = [];
  let heading = "";
  lines.forEach((raw, i) => {
    const h = HEADING.exec(raw);
    if (h) heading = h[1];
    const m = CONTROL.exec(raw);
    if (!m) return;
    const [, pad, ref, role, name = "", value = ""] = m;
    const nameT = tokens(`${name} ${value}`);
    // Context: the names of up to two indentation ancestors, plus the nearest
    // preceding heading (it is not an ancestor in the flat tree).
    const ctx = tokens(heading);
    let indent = pad.length;
    for (let j = i - 1, n = 0; j >= 0 && n < 2 && indent > 0; j--) {
      const pm = /^(\s*)/.exec(lines[j])![1].length;
      if (pm >= indent) continue;
      indent = pm;
      n++;
      ctx.push(...tokens(/"([^"]*)"/.exec(lines[j])?.[1] ?? ""));
    }
    let nameScore = 0.5;
    let matched = 0;
    if (words.length) {
      nameScore = words.reduce((s, q) => s + Math.max(best(q, nameT), 0.5 * best(q, ctx)), 0) / words.length;
      matched = nameT.filter((t) => words.some((q) => sim(q, t) > 0)).length;
    }
    let score = nameScore * (0.85 + (0.15 * matched) / Math.max(1, nameT.length));
    if (roles.size) score *= roles.has(role) ? 1 : 0.4;
    if (score > 0) scored.push({ ref, line: raw.trim(), score });
  });

  const T = 0.1;
  // A control that scores below "none of these" is not worth a line: the
  // role-mismatched padding, mostly. Cut on the score, not the rounded p, or
  // 250 equally good Like buttons each round to 0 and the answer is empty.
  const kept = scored.filter((c) => c.score >= NONE);
  const w = kept.map((c) => Math.exp(c.score / T));
  const total = w.reduce((a, b) => a + b, Math.exp(NONE / T));
  return kept
    .map((c, i) => ({ ...c, raw: w[i] / total }))
    .sort((a, b) => b.raw - a.raw)
    .slice(0, Math.min(10, Math.max(1, Math.trunc(limit) || 5)))
    .map(({ ref, line, raw }) => ({ ref, line, p: Math.max(0.01, Math.round(raw * 100) / 100) }));
}
