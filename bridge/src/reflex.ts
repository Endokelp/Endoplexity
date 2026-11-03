/**
 * The reflex layer's core: the settings, the one client every decision model is
 * asked through, calibration, and the decision log. What the questions ARE
 * lives in reflexes.ts; this file never learns what a button is.
 *
 * A reflex answers a fixed multiple-choice question with probabilities instead
 * of words, for no subscription tokens. Each has its own switch (Off, Shadow,
 * Act) and its own backend (Lexical, Laya, Jev). Shadow logs the answer beside
 * what actually happened and changes nothing; Act lets it decide, and is only
 * offered once Shadow has shown it agrees (see actAllowed).
 *
 * Failure is abstention: a backend that errors, runs over its budget, answers in
 * a shape it was not asked for, or is not set up, contributes nothing, and the
 * run goes exactly as it would without reflexes.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { endpoint as layaEndpoint, status as layaStatus } from "./laya.ts";

export type State = "off" | "shadow" | "act";
export type Backend = "lexical" | "laya" | "jev";
export type Reflex = "pick" | "gate" | "obstacle" | "settle" | "see";
export type Question = { type: "choice"; instructions: string; criteria: Record<string, string> };
export type Probs = Record<string, number>;
export type Box = { top: number; bottom: number; left: number; right: number };
export type Answer = { p?: Probs; choice: string | null; ms?: number; box?: Box };
export type Row = {
  id: string;
  at: number;
  reflex: Reflex;
  state: string;
  question?: Question;
  answers: Record<string, Answer>;
  // Option key -> ref, for Pick: the model's options carry no refs.
  refs?: Record<string, string>;
  truth?: string;
  by?: "auto" | "user";
};

type Setting = { state: State; backend: Backend };
export type Settings = {
  enabled: boolean;
  pick: Setting;
  gate: Setting;
  obstacle: Setting;
  settle: { state: State };
  // Jev only, and Off or Act: a point the model is never shown has no truth to
  // log, so See has no Shadow. Off until the user turns it on.
  see: { state: "off" | "act" };
  cookies: "agent" | "reject" | "accept";
  jevAccepted: boolean;
};

const STATES: State[] = ["off", "shadow", "act"];
const BACKENDS: Backend[] = ["lexical", "laya", "jev"];
const MODELED = ["pick", "gate", "obstacle"] as const;

// Shadow on Lexical is the default: it costs no request and no install.
const DEFAULTS: Settings = {
  enabled: true,
  pick: { state: "shadow", backend: "lexical" },
  gate: { state: "shadow", backend: "lexical" },
  obstacle: { state: "shadow", backend: "lexical" },
  settle: { state: "shadow" },
  see: { state: "off" },
  cookies: "agent",
  jevAccepted: false,
};

// Act acts only when the calibrated top answer clears THRESHOLD and beats the
// runner-up by MARGIN. Spec defaults; revisit with real shadow numbers.
const THRESHOLD = 0.85;
const MARGIN = 0.2;
// Act is offered after this many shadow decisions with a known truth, at this
// agreement or better. Gate is exempt: it can only add a prompt.
const ACT_AFTER = 50;
const ACT_AGREEMENT = 0.95;
// Shadow never blocks the run, so its budget only stops a dead backend from
// piling up open requests. Act budgets are per provider (laya.ts, JEV_BUDGET below).
const SHADOW_BUDGET_MS = 10_000;
// Page text in the log is personal data: it stays local and stays small.
const LOG_CAP = 5_000_000;

const JEV_BUDGET = 1_000;
// An image question: no measured number yet (P19's live run sets it).
const SEE_BUDGET = 8_000;

export type Provider = { base: string; key: string; model: string; budget: number };

let home = "";
// null until index.ts calls initReflexes(): the layer is inert in every test
// that imports mcp.ts without asking for it, so none of them writes a log row
// into the real ~/.endo or sends the fake panel a message it did not expect.
let settings: Settings | null = null;
let rows: Row[] = [];
let bytes = 0;
let seq = 0;

export const defaultHome = () => process.env.ENDO_HOME ?? join(homedir(), ".endo");
const settingsPath = () => join(home, "reflexes.json");
const logPath = () => join(home, "reflex-log.jsonl");
// Beside .endo-token and gitignored by name like it, never on a command line
// and never in the panel's storage. Overridable for tests only.
const keyPath = () =>
  process.env.ENDO_JEV_KEY_PATH ?? fileURLToPath(new URL("../../.endo-jev-key", import.meta.url));

export function initReflexes(dir = defaultHome()): void {
  home = dir;
  mkdirSync(home, { recursive: true });
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(settingsPath(), "utf8"));
  } catch {
    raw = undefined;
  }
  rows = readLog();
  // Read before sanitize: Act eligibility is counted from the log.
  settings = sanitize(raw);
}

export const current = (): Settings | null => settings;

/** The state a reflex runs in now: "off" whenever the layer is off or inert. */
export function stateOf(reflex: Reflex): State {
  if (!settings?.enabled) return "off";
  return settings[reflex].state;
}

export function backendOf(reflex: Exclude<Reflex, "settle">): Backend {
  return settings?.[reflex].backend ?? "lexical";
}

/**
 * Whatever the panel sent, as settings that cannot widen anything: an unknown
 * value falls back to the default, and Act on a backend that has not earned it
 * becomes Shadow. The panel only reflects actAllowed; this enforces it.
 */
export function sanitize(raw: unknown): Settings {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, any>;
  const pickState = (v: unknown, d: State) => (STATES.includes(v as State) ? (v as State) : d);
  const pickBackend = (v: unknown, d: Backend) => (BACKENDS.includes(v as Backend) ? (v as Backend) : d);
  const out: Settings = {
    enabled: typeof r.enabled === "boolean" ? r.enabled : DEFAULTS.enabled,
    pick: { ...DEFAULTS.pick },
    gate: { ...DEFAULTS.gate },
    obstacle: { ...DEFAULTS.obstacle },
    settle: { state: pickState(r.settle?.state, DEFAULTS.settle.state) },
    see: { state: r.see?.state === "act" ? "act" : "off" },
    cookies: ["agent", "reject", "accept"].includes(r.cookies) ? r.cookies : DEFAULTS.cookies,
    jevAccepted: r.jevAccepted === true,
  };
  for (const name of MODELED) {
    const backend = pickBackend(r[name]?.backend, DEFAULTS[name].backend);
    const state = pickState(r[name]?.state, DEFAULTS[name].state);
    out[name] = { backend, state: state === "act" && !actAllowed(name, backend) ? "shadow" : state };
  }
  if (out.settle.state === "act" && !actAllowed("settle", "cdp")) out.settle.state = "shadow";
  return out;
}

export function saveSettings(raw: unknown): Settings {
  settings = sanitize(raw);
  writeFileSync(settingsPath(), JSON.stringify(settings, null, 2));
  return settings;
}

// ---------------------------------------------------------------- providers

export function readJevKey(): string | null {
  try {
    const key = readFileSync(keyPath(), "utf8").trim();
    return key || null;
  } catch {
    return null;
  }
}

/** Write or (with "") remove the Jev key. The panel's input is the only producer. */
export function writeJevKey(key: unknown): void {
  if (typeof key !== "string") throw new Error("the key must be text");
  const k = key.trim();
  if (!k) return void (existsSync(keyPath()) && unlinkSync(keyPath()));
  if (!/^[\x21-\x7e]{8,256}$/.test(k)) throw new Error("that does not look like an API key");
  writeFileSync(keyPath(), k, { mode: 0o600 });
}

/**
 * Where to ask a backend, or null when it is not set up. Jev also needs the
 * disclosure accepted: without it, no page text leaves the machine, whatever
 * else is configured. Read at call time, so a key saved mid-run applies.
 */
export function provider(backend: Backend, image = false): Provider | null {
  if (backend === "laya") return image ? null : layaEndpoint();
  if (backend !== "jev" || !settings?.jevAccepted) return null;
  const key = readJevKey();
  if (!key) return null;
  // A TypeSafe key, or a Vercel AI Gateway key: the gateway serves Jev with no
  // waitlist (TypeSafe paused direct signups on 2026-09-22), same body, its
  // own model ids. Images need 1.14: the moving aliases do not take `box`.
  // ponytail: told apart by Vercel's vck_ key prefix. ENDO_JEV_BASE overrides
  // the base either way, which is how the tests reach a fake server.
  const vercel = key.startsWith("vck_");
  const base = process.env.ENDO_JEV_BASE ?? (vercel ? "https://ai-gateway.vercel.sh/typesafe" : "https://api.typesafe.ai");
  const model = image ? "jev-1.14.0" : vercel ? "jev" : "jev-latest";
  return { base, key, model: vercel ? `typesafe-ai/${model}` : model, budget: image ? SEE_BUDGET : JEV_BUDGET };
}

/**
 * The one client: Jev's `POST /v1/systemone`, which laya-serve speaks too.
 * Returns each question's probabilities over exactly the keys it was asked
 * about, or null. Never throws: every way this can fail is an abstention.
 *
 * Only `probabilities` is read. The two backends mean different things by
 * `confidence` (Laya's is normalized entropy, Jev's its own formula), so the
 * bridge works from probabilities alone and calibrates them itself.
 */
export async function ask(
  p: Provider,
  state: string,
  questions: Record<string, Question>,
  budget = p.budget,
): Promise<Record<string, Probs> | null> {
  try {
    const res = await fetch(`${p.base}/v1/systemone`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${p.key}` },
      body: JSON.stringify({ model: p.model, state, questions }),
      // Covers the body as well as the headers: a server that stalls mid-answer
      // abstains the same way as one that never answers.
      signal: AbortSignal.timeout(budget),
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { answers?: Record<string, { probabilities?: unknown }> };
    const out: Record<string, Probs> = {};
    for (const [id, q] of Object.entries(questions)) {
      const probs = normalize(body?.answers?.[id]?.probabilities, Object.keys(q.criteria));
      if (!probs) return null;
      out[id] = probs;
    }
    return out;
  } catch {
    return null;
  }
}

export type Seen = { present: number; box: Box; tokens: number };
const frac = (v: unknown): v is number => typeof v === "number" && v >= 0 && v <= 1;

/**
 * See's question, over a screenshot: is "query" there at all (`noul`), and
 * where (`box`). Both, because a box question always answers with a box, even
 * for something that is not on the screen. Jev 1.14's image request: the image
 * is an asset the state names, behind TypeSafe's opt-in header.
 * The answer is untrusted like any backend's: a box out of [0, 1] or inside
 * out is refused, and every failure is an abstention (null).
 */
export async function askBox(
  p: Provider,
  image: { data: string; format: "jpeg" | "png" },
  query: string,
): Promise<Seen | null> {
  try {
    const res = await fetch(`${p.base}/v1/systemone`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${p.key}`,
        "TypeSafe-Danger-Zone-Images": "true",
      },
      body: JSON.stringify({
        model: p.model,
        // A state label naming an asset id, as TypeSafe's own example does.
        state: { screen: "screen-1" },
        assets: { "screen-1": { type: "image", format: image.format, data_base64: image.data } },
        questions: {
          present: { type: "noul", instructions: `Is ${query} visible in \`screen\`?` },
          where: { type: "box", instructions: `${query} in \`screen\`` },
        },
      }),
      signal: AbortSignal.timeout(p.budget),
    });
    if (!res.ok) return null;
    const body = (await res.json()) as any;
    const present = body?.answers?.present?.noul;
    const box = body?.answers?.where?.box;
    if (!frac(present) || ![box?.top, box?.bottom, box?.left, box?.right].every(frac)) return null;
    if (!(box.top < box.bottom && box.left < box.right)) return null;
    const tokens = Number(body?.usage?.input_tokens);
    return {
      present,
      box: { top: box.top, bottom: box.bottom, left: box.left, right: box.right },
      tokens: Number.isFinite(tokens) && tokens > 0 ? tokens : 0,
    };
  } catch {
    return null;
  }
}

/** The shadow budget, for callers that are not blocking the run on the answer. */
export const shadowBudget = (p: Provider) => Math.max(p.budget, SHADOW_BUDGET_MS);

// A backend's numbers are untrusted input: finite, non-negative, over exactly
// the asked keys, and renormalized, or the answer is refused.
function normalize(raw: unknown, keys: string[]): Probs | null {
  if (!raw || typeof raw !== "object") return null;
  const vals = keys.map((k) => (raw as Record<string, unknown>)[k]);
  if (vals.some((v) => typeof v !== "number" || !Number.isFinite(v) || v < 0)) return null;
  const sum = (vals as number[]).reduce((a, b) => a + b, 0);
  if (!(sum > 0)) return null;
  return Object.fromEntries(keys.map((k, i) => [k, (vals[i] as number) / sum]));
}

// -------------------------------------------------------------- calibration

export const argmax = (p: Probs): string | null =>
  Object.entries(p).reduce<[string | null, number]>((m, [k, v]) => (v > m[1] ? [k, v] : m), [null, -1])[0];

/** Temperature scaling on probabilities: p^(1/T), renormalized. T > 1 softens. */
export function temper(p: Probs, t: number): Probs {
  const w = Object.entries(p).map(([k, v]) => [k, Math.pow(Math.max(v, 1e-9), 1 / t)] as const);
  const sum = w.reduce((a, [, v]) => a + v, 0);
  return Object.fromEntries(w.map(([k, v]) => [k, v / sum]));
}

const GRID = [0.25, 0.33, 0.5, 0.67, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 2, 2.5, 3, 4, 5];
// Fewer labelled answers than this and the fit is noise: leave T at 1.
const MIN_FIT = 20;

/** The T minimizing log loss on labelled answers, from a fixed grid. */
export function fit(samples: { p: Probs; truth: string }[]): number {
  if (samples.length < MIN_FIT) return 1;
  let best = 1;
  let loss = Infinity;
  for (const t of GRID) {
    const l = samples.reduce((s, x) => s - Math.log(Math.max(temper(x.p, t)[x.truth] ?? 0, 1e-9)), 0);
    if (l < loss) [best, loss] = [t, l];
  }
  return best;
}

/**
 * One temperature per (backend, reflex), fitted on the log.
 * ponytail: pooled over option counts, where the spec asks for one per count.
 * Pick's options run 2 to 11, so per-count buckets would each sit under MIN_FIT
 * for weeks. Split by count once the log is big enough to fill them.
 */
export function temperature(backend: string, reflex: Reflex): number {
  return fit(
    rows.flatMap((r) => {
      const p = r.reflex === reflex && r.truth !== undefined ? r.answers[backend]?.p : undefined;
      return p ? [{ p, truth: r.truth! }] : [];
    }),
  );
}

/** Act's rule: a calibrated answer that clears the threshold and the margin, or null (abstain). */
export function decide(p: Probs, t = 1): { choice: string; p: number } | null {
  const [top, next] = Object.entries(temper(p, t)).sort((a, b) => b[1] - a[1]);
  if (!top || top[1] < THRESHOLD || top[1] - (next?.[1] ?? 0) < MARGIN) return null;
  return { choice: top[0], p: Math.round(top[1] * 100) / 100 };
}

// --------------------------------------------------------------------- log

function readLog(): Row[] {
  let text = "";
  try {
    text = readFileSync(logPath(), "utf8");
    bytes = statSync(logPath()).size;
  } catch {
    bytes = 0;
    return [];
  }
  // Truth arrives after its row (the model's next action, a user's mark), as a
  // line of its own, so the log stays append-only; merged back here.
  const byId = new Map<string, Row>();
  for (const line of text.split("\n")) {
    let x: any;
    try {
      x = JSON.parse(line);
    } catch {
      continue;
    }
    if (typeof x?.id !== "string") continue;
    if (x.reflex) byId.set(x.id, x);
    else if (byId.has(x.id) && typeof x.truth === "string") Object.assign(byId.get(x.id)!, { truth: x.truth, by: x.by });
  }
  return [...byId.values()];
}

function append(entry: object): void {
  if (!settings) return;
  const line = JSON.stringify(entry) + "\n";
  appendFileSync(logPath(), line);
  bytes += Buffer.byteLength(line);
  if (bytes <= LOG_CAP) return;
  // Over the cap: keep the newest half, merged, and start the file again.
  rows = rows.slice(Math.floor(rows.length / 2));
  const kept = rows.map((r) => JSON.stringify(r) + "\n").join("");
  writeFileSync(logPath(), kept);
  bytes = Buffer.byteLength(kept);
}

export function newRow(reflex: Reflex, state: string, fields: Partial<Row> = {}): Row {
  return { id: `r${Date.now().toString(36)}${(++seq).toString(36)}`, at: Date.now(), reflex, state, answers: {}, ...fields };
}

const written = new Set<string>();

/** Log a finished row. A truth set before this rides along in the same line. */
export function record(row: Row): void {
  if (!settings) return;
  rows.push(row);
  written.add(row.id);
  append(row);
  changed?.();
}

/** Set a row's truth once. `by` says whether it was inferred or a person said so. */
export function setTruth(row: Row, truth: string, by: "auto" | "user"): void {
  if (row.truth !== undefined && by === "auto") return;
  row.truth = truth;
  row.by = by;
  if (written.has(row.id)) append({ id: row.id, truth, by });
  changed?.();
}

/** A mark from the panel, by row id. Only an option the row was asked about counts. */
export function mark(id: unknown, truth: unknown): boolean {
  const row = rows.find((r) => r.id === id);
  if (!row || typeof truth !== "string" || !row.question || !Object.hasOwn(row.question.criteria, truth)) return false;
  setTruth(row, truth, "user");
  return true;
}

export function clearLog(): void {
  rows = [];
  written.clear();
  bytes = 0;
  if (home && existsSync(logPath())) unlinkSync(logPath());
}

// ------------------------------------------------------------------ status

type Tally = { agreed: number; of: number };

/** Per reflex, per backend: how often its top answer matched the truth. */
export function stats(): Record<Reflex, Record<string, Tally>> {
  const out: Record<Reflex, Record<string, Tally>> = { pick: {}, gate: {}, obstacle: {}, settle: {}, see: {} };
  for (const r of rows) {
    if (r.truth === undefined) continue;
    for (const [b, a] of Object.entries(r.answers)) {
      if (a.choice === null) continue;
      const t = (out[r.reflex][b] ??= { agreed: 0, of: 0 });
      t.of++;
      if (a.choice === r.truth) t.agreed++;
    }
  }
  return out;
}

export function actAllowed(reflex: Reflex, backend: string): boolean {
  if (reflex === "gate") return true;
  const t = stats()[reflex][backend];
  return !!t && t.of >= ACT_AFTER && t.agreed / t.of >= ACT_AGREEMENT;
}

const GATE_OPTIONS = { a: "Irreversible", b: "Fine" };

/**
 * What the panel asks a person to mark, newest first: Gate decisions where a
 * model said "irreversible" and the regex did not ask ("would have asked
 * about"), and Obstacle pages a backend did not read as ready.
 */
export function review(limit = 10) {
  const out = [];
  for (const r of [...rows].reverse()) {
    if (out.length >= limit) break;
    if (r.truth !== undefined || !r.question) continue;
    for (const [backend, a] of Object.entries(r.answers)) {
      if (!a.p || backend === "lexical") continue;
      const wouldAsk = r.reflex === "gate" && a.choice === "a" && r.answers.lexical?.choice === "b";
      const blocked = r.reflex === "obstacle" && a.choice !== null && a.choice !== "ready";
      if (!wouldAsk && !blocked) continue;
      // The click for a Gate row, the page for an Obstacle row. Gate's state
      // lists the URL first, so one find() over both prefixes named the page.
      const lines = r.state.split("\n");
      const what = lines.find((l) => l.startsWith("Action: ")) ?? lines.find((l) => l.startsWith("URL: ")) ?? r.state.slice(0, 80);
      const options = r.reflex === "gate" ? GATE_OPTIONS : Object.fromEntries(Object.keys(r.question.criteria).map((k) => [k, k]));
      out.push({ id: r.id, reflex: r.reflex, what, backend, answer: a.choice, p: Math.round((a.p[a.choice!] ?? 0) * 100) / 100, options });
      break;
    }
  }
  return out;
}

export const logSize = () => ({ rows: rows.length, bytes });

function jevStatus(): { ready: boolean; note: string } {
  if (!readJevKey()) return { ready: false, note: "needs a key" };
  if (!settings?.jevAccepted) return { ready: false, note: "accept the disclosure first" };
  return { ready: true, note: "key saved" };
}

/** Everything the panel's Reflexes section draws, as one message. */
export function panelState() {
  const act = Object.fromEntries(
    MODELED.map((r) => [r, Object.fromEntries(BACKENDS.map((b) => [b, actAllowed(r, b)]))]),
  );
  return {
    type: "reflexes",
    settings: settings ?? sanitize(undefined),
    backends: { lexical: { ready: true, note: "" }, laya: layaStatus(), jev: jevStatus() },
    stats: stats(),
    act: { ...act, settle: { cdp: actAllowed("settle", "cdp") } },
    review: review(),
    log: logSize(),
  };
}

/** Does any reflex need the Laya sidecar running? */
export const needsLaya = () =>
  !!settings?.enabled && MODELED.some((r) => settings![r].state !== "off" && settings![r].backend === "laya");

// One listener, for index.ts to push fresh counts to the panel.
let changed: (() => void) | null = null;
export const onChange = (fn: () => void) => void (changed = fn);
