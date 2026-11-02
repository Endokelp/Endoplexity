/**
 * The three text reflexes and what they ask: Pick (which element is "...?"),
 * Gate (does this click commit something?) and Obstacle (is this page a wall?).
 * reflex.ts is the machinery; this file is the questions, their lexical
 * backends, where their ground truth comes from, and what Act does with an answer.
 *
 * Lexical always answers, because it is free and is the baseline the model
 * backends are counted against; the reflex's chosen backend answers beside it.
 * In Shadow nothing here is awaited by the run. In Act only the chosen
 * backend's calibrated answer counts, and anything short of confident abstains.
 */

import { askPanel, callPanel } from "./relay.ts";
import { IRREVERSIBLE } from "./gate.ts";
import { labelFor, labelsOf, near, remember } from "./page.ts";
import {
  argmax,
  ask,
  backendOf,
  current,
  decide,
  newRow,
  provider,
  record,
  setTruth,
  shadowBudget,
  stateOf,
  temperature,
  type Probs,
  type Question,
  type Row,
} from "./reflex.ts";

type Where = { title: string; url: string };

// Field values never go into a state, logged or sent: a password, an email,
// anything the agent typed. ax.js writes them as ` = "..."` after the name and
// does not escape quotes inside, so cut at the marker rather than match a pair.
const redact = (line: string) => line.trim().replace(/^@\S+\s+/, "").split(' = "')[0];

// The query string and fragment are where session tokens live.
function bare(url: string): string {
  try {
    const u = new URL(url);
    return u.origin + u.pathname;
  } catch {
    return "";
  }
}

/**
 * The page's title and URL, which no page text carries. The panel's tab list is
 * a chrome.tabs read: it moves no ref and no delta baseline. Empty on failure;
 * a reflex with less state is still a reflex.
 */
async function where(): Promise<Where> {
  try {
    const m = /^\* id \d+ — "(.*)" (\S*)$/m.exec(await callPanel("tabs", {}));
    if (m) return { title: m[1], url: bare(m[2]) };
  } catch {}
  return { title: "", url: "" };
}

type Decision = { choice: string; p: number; backend: string };

/** Answer a row's question on Lexical and the chosen backend, log it, and decide if acting. */
async function consult(row: Row, lexical: Probs, act: boolean): Promise<Decision | null> {
  const reflex = row.reflex as "pick" | "gate" | "obstacle";
  const backend = backendOf(reflex);
  row.answers.lexical = { p: lexical, choice: argmax(lexical) };
  const p = backend === "lexical" ? null : provider(backend);
  if (p) {
    const t0 = performance.now();
    const got = await ask(p, row.state, { q: row.question! }, act ? p.budget : shadowBudget(p));
    // An abstention is logged too, choice null: it is how a budget that is too
    // tight for this machine shows up, and stats() leaves it out of agreement.
    row.answers[backend] = got ? { p: got.q, choice: argmax(got.q) } : { choice: null };
    row.answers[backend].ms = Math.round(performance.now() - t0);
  }
  record(row);
  const answer = row.answers[backend]?.p;
  if (!act || !answer) return null;
  const d = decide(answer, temperature(backend, reflex));
  return d && { ...d, backend };
}

const normalized = (p: Probs): Probs => {
  const sum = Object.values(p).reduce((a, b) => a + b, 0) || 1;
  return Object.fromEntries(Object.entries(p).map(([k, v]) => [k, v / sum]));
};

// ------------------------------------------------------------------- Pick

// Pick rows waiting for the model's next action, which is their truth.
let open: Row[] = [];
const OPEN_CAP = 20;

type Hit = { ref: string; line: string; p: number };

/**
 * Pick, behind `find`. undefined: not acting, answer as find always has.
 * null: Act abstained, list the candidates. A hit: Act chose this one.
 *
 * The options are find()'s own top 10, not the page: Laya has about 320 tokens
 * for the state and 192 for every option, and the lexical ranking is already
 * the coarse step. "None of these" is an option, as it is in find().
 */
export function pick(query: string, hits: Hit[]): Promise<{ line: string; p: number } | null> | undefined {
  const state = stateOf("pick");
  if (state === "off" || !hits.length) return undefined;
  const criteria: Record<string, string> = {};
  const refs: Record<string, string> = {};
  const lexical: Probs = {};
  hits.forEach((h, i) => {
    criteria[`o${i + 1}`] = redact(h.line);
    refs[`o${i + 1}`] = h.ref;
    lexical[`o${i + 1}`] = h.p;
  });
  criteria.none = "None of these";
  lexical.none = Math.max(0.01, 1 - hits.reduce((s, h) => s + h.p, 0));
  const row = newRow("pick", "", {
    question: { type: "choice", instructions: `Which element on this page is "${query}"?`, criteria },
    refs,
  });
  // Open before anything is awaited: the model's next action is the truth, and
  // it must find this row even if it lands before the tab list does.
  open = [...open.slice(-(OPEN_CAP - 1)), row];
  const run = where().then((w) => {
    row.state = [`Find: "${query}"`, `Page: ${w.title}`, `URL: ${w.url}`].join("\n");
    return consult(row, normalized(lexical), state === "act");
  });
  if (state !== "act") {
    run.catch(() => {});
    return undefined;
  }
  return run.then((d) => {
    if (!d || d.choice === "none") return null;
    const hit = hits[Number(d.choice.slice(1)) - 1];
    return hit ? { line: hit.line, p: d.p } : null;
  });
}

// ------------------------------------------------------------------- Gate

// Neutral keys, not yes/no: Laya's card warns its labels can lead its answer.
const GATE: Question = {
  type: "choice",
  instructions: "Does this action commit something that cannot be undone?",
  criteria: {
    a: "Yes: it submits, pays, sends, books, publishes or deletes something for real",
    b: "No: it can be undone, or it changes nothing permanent",
  },
};

/**
 * Gate on a click, given the label the regex just weighed. Returns a prompt to
 * add, in Act, when the chosen backend reads the click as irreversible and the
 * regex did not ask. Never removes a prompt: a click the regex already gates
 * (`asked`) is logged and never consulted for Act. Abstaining leaves the regex
 * as the whole gate, which is failing closed.
 */
export async function gate(ref: string, label: string, asked: boolean): Promise<string | null> {
  const state = stateOf("gate");
  if (state === "off") return null;
  const act = state === "act" && !asked;
  const row = newRow("gate", "", { question: GATE });
  const lexical = IRREVERSIBLE.test(label) ? { a: 0.9, b: 0.1 } : { a: 0.1, b: 0.9 };
  const run = where().then((w) => {
    row.state = [`Page: ${w.title}`, `URL: ${w.url}`, `Action: click ${redact(label)}`, "Nearby:", ...near(ref).map(redact)].join("\n");
    return consult(row, lexical, act);
  });
  if (!act) {
    run.catch(() => {});
    return null;
  }
  const d = await run;
  return d?.choice === "a" ? `click ${ref} ${label} — the Gate reflex (${d.backend}, p=${d.p}) reads this as irreversible` : null;
}

// --------------------------------------------------------------- Obstacle

const OBSTACLE: Question = {
  type: "choice",
  instructions: "What is this page showing?",
  criteria: {
    cookie: "A cookie or consent banner asking to accept or reject cookies",
    login: "A login wall: the site wants the visitor to sign in before going on",
    captcha: "A captcha, or a check that the visitor is human",
    error: "An error page: not found, access denied, or a server error",
    ready: "The page itself, ready to use",
  },
};

const CAPTCHA = /captcha|verify (that )?you are (a )?human|are you a robot|checking your browser/i;
const LOGIN_URL = /\/(log-?in|sign-?in|auth|sso)\b/i;
const LOGIN_TITLE = /\b(sign in|log in|login)\b/i;
const PASSWORD = /\[textbox\] "[^"]*password/i;
const ERROR = /\b(404|not found|access denied|forbidden|server error|something went wrong)\b/i;
const COOKIE = /\b(cookies?|consent)\b/i;
const CONSENT_CONTROL = /\[(button|link)\] "[^"]*\b(accept|reject|agree|allow|decline|necessary)\b/i;

function lexicalObstacle({ title, url }: Where, lines: string[]): Probs {
  const text = lines.join("\n");
  const hit = CAPTCHA.test(`${title}\n${text}`)
    ? "captcha"
    : LOGIN_URL.test(url) || LOGIN_TITLE.test(title) || PASSWORD.test(text)
      ? "login"
      : ERROR.test(title)
        ? "error"
        : COOKIE.test(text) && CONSENT_CONTROL.test(text)
          ? "cookie"
          : "ready";
  return Object.fromEntries(Object.keys(OBSTACLE.criteria).map((k) => [k, k === hit ? 0.8 : 0.05]));
}

// The page that arrived last, waiting for the model's next action as its truth.
let arrival: Row | null = null;

/** Obstacle on a page that just arrived. A decision only in Act. */
function obstacle(page: string): Promise<Decision | null> | null {
  const state = stateOf("obstacle");
  if (state === "off") return null;
  const lines = page
    .split("\n")
    .filter((l) => l.trim() && !l.trim().startsWith("… "))
    .slice(0, 40)
    .map(redact);
  const row = newRow("obstacle", "", { question: OBSTACLE });
  arrival = row;
  const run = where().then((w) => {
    row.state = [`Page: ${w.title}`, `URL: ${w.url}`, ...lines].join("\n");
    return consult(row, lexicalObstacle(w, lines), state === "act");
  });
  if (state !== "act") {
    run.catch(() => {});
    return null;
  }
  return run;
}

const REJECT = /\b(reject( all)?|decline|refuse|necessary only|only necessary|essential only)\b/i;
const ACCEPT = /\b(accept( all)?|agree|allow all)\b/i;

/**
 * After navigate, use_tab, back or forward: what Obstacle's Act does with the
 * page, as the result to return instead, or null to return the page as it is.
 *
 * Login and captcha pause for the human with the gate's own card: approving
 * means "I dealt with it, carry on". A cookie wall is answered only when the
 * user chose Reject or Accept, by clicking a control whose label says so and
 * never one the gate's regex would stop. The page the model receives is the
 * one it would have, plus what happened and the page after, so the delta it
 * reads next is against a page it has seen.
 */
export async function arrived(page: string, alive: () => boolean): Promise<{ text: string; isError?: true } | null> {
  const d = await obstacle(page);
  if (!d || !alive()) return null;
  const how = `Obstacle reflex, ${d.backend}, p=${d.p}`;
  if (d.choice === "login" || d.choice === "captcha") {
    const what = d.choice === "login" ? "a login wall" : "a captcha";
    const ok = await askPanel(`this page looks like ${what} (${how}). Deal with it yourself in the tab, then Approve to let the agent carry on. Deny stops here.`);
    if (!ok) return { text: `${page}\n\nblocked — the page showed ${what} and the human stopped here. Do not retry; report it.`, isError: true };
    if (!alive()) return null;
    try {
      const now = await callPanel("snapshot", {});
      remember(now);
      return { text: `${page}\n\n(the page showed ${what}; the human dealt with it. The page as it is now:)\n${now}` };
    } catch {
      return null;
    }
  }
  const cookies = current()?.cookies;
  if (d.choice !== "cookie" || !cookies || cookies === "agent") return null;
  const want = cookies === "reject" ? REJECT : ACCEPT;
  const hit = [...labelsOf(page)].find(([, l]) => /^\[(button|link)\]/.test(l) && want.test(l) && !IRREVERSIBLE.test(l));
  if (!hit) return null;
  try {
    const after = await callPanel("click", { ref: hit[0] }, hit[1]);
    remember(after);
    return { text: `${page}\n\n(${how}: answered a cookie banner with ${hit[1]}, per the user's cookie setting. The page now:)\n${after}` };
  } catch {
    return null;
  }
}

// ------------------------------------------------------------------ truth

const CONSENT = /\b(accept|reject|agree|consent|cookies?|necessary|decline|allow all)\b/i;
const SIGN_IN = /\b(sign in|log in|login|password)\b/i;

/**
 * The model acted on a ref: the truth for the Pick rows that offered it, and
 * for the last page's Obstacle row (a consent control means it was a cookie
 * wall, a sign-in control a login wall, anything else that it was ready).
 * Called with the model's intent, before the gate, whatever happens next.
 */
export function acted(ref: unknown): void {
  if (typeof ref !== "string") return;
  for (const row of open) {
    const key = Object.entries(row.refs ?? {}).find(([, r]) => r === ref)?.[0];
    if (key) setTruth(row, key, "auto");
  }
  open = open.filter((r) => r.truth === undefined);
  const label = labelFor(ref);
  if (arrival && label) {
    setTruth(arrival, CONSENT.test(label) ? "cookie" : SIGN_IN.test(label) ? "login" : "ready", "auto");
    arrival = null;
  }
}

/** A task ended or was stopped: what is still open never gets a truth. */
export function drop(): void {
  open = [];
  arrival = null;
}

// ------------------------------------------------------------------ Settle

/**
 * One Settle measurement from the panel (cdp.js): when the page would have
 * counted as settled, and whether it changed again after that inside today's
 * fixed wait, which is the truth. Logged only in Shadow; validated, because it
 * arrives over the socket.
 */
export function settled(raw: unknown): void {
  if (stateOf("settle") !== "shadow" || !raw || typeof raw !== "object") return;
  const { settledAt, changedAfter, waited } = raw as Record<string, unknown>;
  const ms = (v: unknown) => typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 60_000;
  if (!(settledAt === null || ms(settledAt)) || typeof changedAfter !== "boolean" || !ms(waited)) return;
  const row = newRow("settle", `settled at ${settledAt ?? "never"} of ${waited} ms`);
  // Never quiet inside the window: no answer to count.
  row.answers.cdp = settledAt === null ? { choice: null } : { choice: "settled", ms: settledAt as number };
  row.truth = changedAfter ? "changing" : "settled";
  row.by = "auto";
  record(row);
}
