/**
 * Learn once, replay free (Phase 17). A run the user saves becomes a skill: a
 * file they own that replays with no model. A note the user approves comes back
 * on every later arrival at its site, for every engine.
 *
 * This file is the store and the bookkeeping: the trace of the current task,
 * turning it into a skill, placing a recorded target on the live page, and the
 * proposals waiting for the user. The replay loop is in mcp.ts, because each
 * step has to pass the same gate and the same lock as a model's call.
 *
 * A person writes every file here, never a model on its own. The model that
 * proposes a note has just read untrusted pages, and a saved note reaches every
 * later run on every engine. So a file is written only when the user approves a
 * proposal in the panel, and what is written is the text the bridge holds, not
 * anything the approval message carried.
 */

import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { z } from "zod";
import { controls, labelFor, near } from "./page.ts";
import { defaultHome } from "./reflex.ts";
import { redact } from "./reflexes.ts";

const ACTIONS = ["navigate", "use_tab", "click", "type", "select", "key", "scroll", "hover", "upload", "back", "forward"] as const;
type Action = (typeof ACTIONS)[number];
const RECORDED = new Set<string>(ACTIONS);
// What each step cannot replay without. A skill file can come from someone
// else, so this is checked on load, not trusted.
const NEEDS: Record<Action, (keyof SkillStep)[]> = {
  navigate: ["url"],
  use_tab: ["url"],
  click: ["target"],
  type: ["target", "text"],
  select: ["target", "value"],
  hover: ["target"],
  key: ["name"],
  upload: ["file"],
  scroll: [],
  back: [],
  forward: [],
};

// A ref is a backend node id and dies with the page, so a step names its
// element the way a person would: what it reads, what sits around it, which
// frame. Values are cut from the neighbours (redact), as everywhere a page
// line is kept.
const target = z.object({
  label: z.string().max(300),
  near: z.array(z.string().max(300)).max(6),
  frame: z.string().regex(/^f\d{1,3}$/),
});
const step = z.object({
  do: z.enum(ACTIONS),
  target: target.optional(),
  url: z.string().max(2000).regex(/^(https?|file):/).optional(),
  text: z.string().max(5000).optional(),
  value: z.string().max(500).optional(),
  name: z.string().max(20).optional(),
  direction: z.enum(["down", "up"]).optional(),
  file: z.string().max(100).optional(),
  match: z.string().max(200).optional(),
});
const skillFile = z.object({
  name: z.string().min(1).max(60),
  host: z.string().max(253),
  task: z.string().max(4000),
  steps: z.array(step).min(1).max(200),
  vars: z.record(z.string().regex(/^\w{1,40}$/), z.string().max(5000)),
  saved: z.string().max(40),
});
export type Target = z.infer<typeof target>;
export type SkillStep = z.infer<typeof step>;
export type Skill = z.infer<typeof skillFile>;

// A field whose value is never written down. Its var starts empty, and a replay
// with no value for it stops at that step and hands over.
// ponytail: a label heuristic; the accessibility tree does not say "password".
// Exported for the audit log, which redacts a value typed into one the same way.
export const SECRET = /password|passcode|\bpin\b|cvc|cvv|security code|card number/i;
const VAR = /\{\{(\w+)\}\}/g;
const NOTE_CAP = 500;
const NOTES_PER_TASK = 3;
const MAX_STEPS = 200;

// ------------------------------------------------------------------ store

// null until index.ts calls initSkills(): tests that import mcp.ts never record,
// read ~/.endo, or send the fake panel a tab read it did not expect.
let home: string | null = null;
export function initSkills(dir = defaultHome()): void {
  home = dir;
}

/** A URL's host as a file name: [a-z0-9._-], never starting with a dot. */
export function hostOf(url: string): string {
  try {
    const u = new URL(url);
    if (u.protocol === "file:") return "file";
    return u.hostname.toLowerCase().replace(/[^a-z0-9.-]/g, "_").replace(/^\.+/, "_");
  } catch {
    return "";
  }
}

const slug = (s: string, sep = "-", max = 60) =>
  s.toLowerCase().replace(/[^a-z0-9]+/g, sep).replace(new RegExp(`^\\${sep}+|\\${sep}+$`, "g"), "").slice(0, max);

// host/name. The host part cannot be "." or "..", so no id leaves skills/.
const ID = /^([a-z0-9_][a-z0-9._-]{0,252})\/([a-z0-9][a-z0-9-]{0,59})$/;
function fileOf(id: unknown): string {
  const m = typeof id === "string" ? ID.exec(id) : null;
  if (!home || !m) throw new Error(`no skill called ${JSON.stringify(id)}`);
  return join(home, "skills", m[1], `${m[2]}.json`);
}

/** A skill file, checked as untrusted input: the shape, and what each step needs. */
export function load(id: unknown): Skill {
  const path = fileOf(id);
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    throw new Error(`no skill called ${JSON.stringify(id)}`);
  }
  const parsed = skillFile.safeParse(raw);
  if (!parsed.success) throw new Error(`the skill ${id} is not a skill file: ${parsed.error.issues[0]?.message}`);
  const bad = parsed.data.steps.findIndex((s) => NEEDS[s.do].some((k) => s[k] === undefined));
  if (bad >= 0) throw new Error(`step ${bad + 1} of ${id} (${parsed.data.steps[bad].do}) is missing what it needs`);
  return parsed.data;
}

function write(id: string, skill: Skill): string {
  const path = fileOf(id);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(skill, null, 2));
  changed?.();
  return id;
}

/** A new skill under a name not already taken: saving never overwrites one. */
function saveNew(skill: Skill, name: unknown): string {
  const stem = slug(typeof name === "string" ? name : "") || slug(skill.name) || "skill";
  let id = `${skill.host}/${stem}`;
  for (let n = 2; existsSync(fileOf(id)); n++) id = `${skill.host}/${stem.slice(0, 55)}-${n}`;
  return write(id, { ...skill, name: id.split("/")[1] });
}

export function remove(id: unknown): void {
  const path = fileOf(id);
  if (existsSync(path)) unlinkSync(path);
  changed?.();
}

const entries = (dir: string) => {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
};

/** Every saved skill, as the panel's sheet and run_skill's description list them. */
export function list() {
  if (!home) return [];
  const out = [];
  for (const host of entries(join(home, "skills"))) {
    for (const file of entries(join(home, "skills", host))) {
      if (!file.endsWith(".json")) continue;
      const id = `${host}/${file.slice(0, -5)}`;
      try {
        const s = load(id);
        const secret = Object.keys(s.vars).filter((k) => s.vars[k] === "");
        out.push({ id, name: s.name, host: s.host, task: s.task, steps: s.steps.length, vars: s.vars, secret });
      } catch {}
    }
  }
  return out;
}

// ------------------------------------------------------------------ trace

let trace: SkillStep[] = [];
// Why this task's trace cannot become a skill, or "".
let broken = "";
let words = "";
let replayed = false;
let heal: { id: string; skill: Skill; base: number; at: number } | null = null;
let notes = 0;

/** A fresh task: the user's own words, which become the skill's task. */
export function begin(task: string): void {
  trace = [];
  broken = "";
  words = task.slice(0, 4000);
  replayed = false;
  heal = null;
  notes = 0;
}

/** What a ref points at, as a step records it. Taken before the action, from the page the model read. */
export function targetOf(ref: unknown): Target | undefined {
  if (typeof ref !== "string") return undefined;
  const label = labelFor(ref);
  if (!label) return undefined;
  const around = near(ref).map(redact).filter(Boolean).slice(0, 6).map((l) => l.slice(0, 300));
  return { label: label.slice(0, 300), near: around, frame: /^@(f\d{1,3})e/.exec(ref)?.[1] ?? "f0" };
}

/**
 * The first action of a task that did not start by navigating: the page it
 * started on has to become step 1, or a replay would act on whatever is open.
 */
export const needsStart = (tool: string) =>
  !!home && !trace.length && !broken && RECORDED.has(tool) && tool !== "navigate" && tool !== "use_tab";

/** Step 1 from the tab's URL (origin and path: a query string is where session tokens live). */
export function start(url: string): void {
  if (/^(https?|file):/.test(url)) trace.push({ do: "navigate", url });
  else broken ||= "it started on a page it cannot return to";
}

/** A model's action that ran. Reads are not steps; an element with no label cannot be placed again. */
export function track(tool: string, args: Record<string, unknown>, at?: Target): void {
  if (!home || !RECORDED.has(tool)) return;
  if (tool === "use_tab" && typeof args.url !== "string") return void (broken ||= "it switched to another tab");
  if ((NEEDS[tool as Action].includes("target") || (tool === "scroll" && args.ref)) && !at) {
    return void (broken ||= `it used ${tool} on an element with no label`);
  }
  if (trace.length >= MAX_STEPS) return void (broken ||= `it took more than ${MAX_STEPS} steps`);
  const s: SkillStep = { do: tool as Action };
  if (at) s.target = at;
  for (const k of ["url", "text", "value", "name", "direction", "file", "match"] as const) {
    if (typeof args[k] === "string") (s as Record<string, unknown>)[k] = args[k];
  }
  trace.push(s);
}

/** A replay is starting: where its steps begin in this task's trace. */
export function replaying(): number {
  replayed = true;
  return trace.length;
}

/** A replayed step, recorded as the skill has it, {{vars}} and all. */
export const replayedStep = (s: SkillStep) => void trace.push(s);

/** The replay stopped at step `at` for want of a target: what the model does next is the heal. */
export function stopped(id: string, skill: Skill, base: number, at: number): void {
  heal = { id, skill, base, at };
}

// ------------------------------------------------------------------ replay

/** The ref on the page now for a recorded target, or why there is none. */
export function locate(t: Target): { ref: string } | { why: string } {
  const same = [...controls()].filter(([, l]) => l === t.label).map(([ref]) => ref);
  if (same.length === 1) return { ref: same[0] };
  if (!same.length) return { why: `nothing on the page reads ${t.label}` };
  // Several read the same ("Remove" on every row): the one among the same
  // neighbours, then in the same frame, or none.
  const score = (ref: string) => {
    const around = new Set(near(ref).map(redact));
    return t.near.filter((l) => around.has(l)).length + (ref.startsWith(`@${t.frame}e`) ? 0.5 : 0);
  };
  const [a, b] = same.map((ref) => [ref, score(ref)] as const).sort((x, y) => y[1] - x[1]);
  return a[1] > b[1] ? { ref: a[0] } : { why: `${same.length} controls read ${t.label}` };
}

/** A step's text with its {{vars}} filled, or the first var with no value. */
export function fill(text: string, vars: Record<string, string>): { text: string } | { missing: string } {
  let missing = "";
  const out = text.replace(VAR, (_, k: string) => {
    const v = Object.hasOwn(vars, k) ? vars[k] : "";
    if (!v) missing ||= k;
    return v;
  });
  return missing ? { missing } : { text: out };
}

/** Values the panel or the model passed for a run: strings only, under known-shaped names. */
export function cleanVars(raw: unknown): Record<string, string> {
  if (!raw || typeof raw !== "object") return {};
  return Object.fromEntries(
    Object.entries(raw).filter(([k, v]) => /^\w{1,40}$/.test(k) && typeof v === "string" && v.length <= 5000),
  ) as Record<string, string>;
}

/** One line per step, for a proposal card and a hand-off. Page text in it is a label, quoted. */
export function describe(s: SkillStep, i: number): string {
  const on = s.target?.label ?? "";
  const what: Record<Action, string> = {
    navigate: `go to ${s.url}`,
    use_tab: `open a tab at ${s.url}`,
    click: `click ${on}`,
    hover: `hover ${on}`,
    type: `type "${s.text}" into ${on}`,
    select: `choose "${s.value}" in ${on}`,
    key: `press ${s.name}`,
    scroll: `scroll ${s.direction ?? "down"}${on && ` in ${on}`}`,
    upload: `attach the file "${s.file}"`,
    back: "go back",
    forward: "go forward",
  };
  return `${i + 1}. ${what[s.do]}`;
}

/**
 * Steps as a skill: every value the model typed or chose becomes a {{var}},
 * defaulting to what it typed, so a replay with no vars repeats the run and a
 * replay with vars fills a different one. A step already holding a var (a
 * replayed one) keeps it.
 */
function asSkill(steps: SkillStep[], base: Record<string, string>, name: string, task: string): Skill {
  const vars = { ...base };
  const secrets: [string, string][] = [];
  const used = new Set(steps.flatMap((s) => [s.text, s.value].flatMap((t) => [...(t ?? "").matchAll(VAR)].map((m) => m[1]))));
  const out = steps.map((s) => {
    const field = s.do === "type" ? "text" : s.do === "select" ? "value" : null;
    const raw = field ? s[field] : undefined;
    if (!field || raw === undefined || new RegExp(VAR.source).test(raw)) return s;
    const label = s.target?.label ?? "";
    const stem = slug(/"([^"]*)"/.exec(label)?.[1] ?? "", "_", 30) || "value";
    // A healed tail that fills the same field the old tail did keeps its var
    // and the saved default: the value the model typed was this run's, which
    // may have been one the user passed in, not the one to keep.
    if (Object.hasOwn(base, stem) && !used.has(stem)) {
      used.add(stem);
      return { ...s, [field]: `{{${stem}}}` };
    }
    let k = stem;
    for (let n = 2; Object.hasOwn(vars, k); n++) k = `${stem}_${n}`;
    vars[k] = SECRET.test(label) ? "" : raw;
    if (SECRET.test(label) && raw.length >= 4) secrets.push([raw, k]);
    used.add(k);
    return { ...s, [field]: `{{${k}}}` };
  });
  // A var whose step the heal replaced is not a value the skill asks for any more.
  const kept = Object.fromEntries(Object.entries(vars).filter(([k]) => used.has(k)));
  // The task is the user's own words, and those can carry the password too
  // ("Password 'hunter22'"): seen live, P17, in a file that kept it out of vars.
  const said = secrets.reduce((t, [raw, k]) => t.replaceAll(raw, `{{${k}}}`), task);
  return { name, host: hostOf(out[0]?.url ?? ""), task: said, steps: out, vars: kept, saved: new Date().toISOString() };
}

/** A step with the run's values in place of its vars, where it has them: what the model is shown. */
export function filled(s: SkillStep, vars: Record<string, string>): SkillStep {
  const put = (t?: string) => t?.replace(VAR, (m, k: string) => (Object.hasOwn(vars, k) && vars[k] ? vars[k] : m));
  return { ...s, ...(s.text !== undefined && { text: put(s.text) }), ...(s.value !== undefined && { value: put(s.value) }) };
}

// --------------------------------------------------------------- proposals

type Proposal =
  | { id: string; kind: "note"; host: string; text: string }
  | { id: string; kind: "skill"; skill: Skill }
  | { id: string; kind: "heal"; skillId: string; skill: Skill; old: Skill; from: number };

let proposals: Proposal[] = [];
let pseq = 0;
// A page that talks the model into proposing on every turn should cost the
// user a short list, not a wall.
const PROPOSALS_CAP = 8;

function propose(p: Proposal): void {
  proposals = [...proposals.slice(-(PROPOSALS_CAP - 1)), p];
  changed?.();
}

/**
 * The task ended. A clean end offers what it did as a skill, or, after a replay
 * that stopped and was finished by the model, the change to the skill. Neither
 * is written until the user approves it.
 */
export function finish(ok: boolean): void {
  const h = heal;
  heal = null;
  if (!home || !ok || broken) return;
  if (h) {
    const next = asSkill(trace.slice(h.base), h.skill.vars, h.skill.name, h.skill.task);
    if (!next.steps.length || JSON.stringify(next.steps) === JSON.stringify(h.skill.steps)) return;
    propose({ id: `p${++pseq}`, kind: "heal", skillId: h.id, skill: { ...next, host: h.skill.host }, old: h.skill, from: h.at });
    return;
  }
  // A run of navigates is reading, not a procedure worth keeping.
  if (replayed || trace.length < 2 || !trace.some((s) => s.target) || !hostOf(trace[0].url ?? "")) return;
  const name = slug(words.split(/\s+/).slice(0, 5).join(" "), "-", 40) || "skill";
  // One offer at a time: the newest run is the one the user just watched.
  proposals = proposals.filter((p) => p.kind !== "skill");
  propose({ id: `p${++pseq}`, kind: "skill", skill: asSkill(trace, {}, name, words) });
}

/** The proposals as the panel draws them: a title, lines, and a hint. */
export function pending() {
  return proposals.map((p) => {
    if (p.kind === "note") {
      return {
        id: p.id,
        kind: p.kind,
        title: `Save a note about ${p.host}?`,
        lines: [p.text],
        hint: "The agent proposed this after reading pages, so read it as you would a stranger's. A saved note is shown to every engine whenever a run arrives at this site.",
      };
    }
    if (p.kind === "skill") {
      const vars = Object.entries(p.skill.vars).map(([k, v]) => (v ? `${k} = "${v}"` : `${k} (asked for on every run)`));
      return {
        id: p.id,
        kind: p.kind,
        title: "Save this run as a skill?",
        lines: [...p.skill.steps.map(describe), ...(vars.length ? ["", `values: ${vars.join(", ")}`] : [])],
        hint: "It replays with no model. A step it cannot place on the page goes to the model you pick.",
        name: p.skill.name,
      };
    }
    return {
      id: p.id,
      kind: p.kind,
      title: `Update the skill ${p.skillId}?`,
      lines: [
        ...p.old.steps.slice(p.from).map((s, i) => `- ${describe(s, p.from + i)}`),
        ...p.skill.steps.slice(p.from).map((s, i) => `+ ${describe(s, p.from + i)}`),
      ],
      hint: `The replay stopped at step ${p.from + 1}; this is what the model did from there.`,
    };
  });
}

/** The user's answer to a proposal, by id. Returns what was written, or null. */
export function answer(id: unknown, approved: unknown, name?: unknown): string | null {
  const p = proposals.find((x) => x.id === id);
  if (!p) return null;
  proposals = proposals.filter((x) => x !== p);
  changed?.();
  if (approved !== true) return null;
  if (p.kind === "note") {
    writeNote(p.host, p.text);
    return `saved a note about ${p.host}`;
  }
  if (p.kind === "skill") return `saved the skill ${saveNew(p.skill, name)}`;
  return `updated the skill ${write(p.skillId, p.skill)}`;
}

// ------------------------------------------------------------------- notes

const notePath = (host: string) => join(home!, "sites", `${host}.md`);

/** note_site: queue a note for the user. Never writes. */
export function proposeNote(host: string, text: string): string {
  if (!home) return "error: notes are not available in this bridge";
  if (!host) return "error: there is no page to note anything about yet";
  if (notes >= NOTES_PER_TASK) return `error: ${NOTES_PER_TASK} notes are already waiting for the user from this run — do not propose more`;
  const clean = text.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim().slice(0, NOTE_CAP);
  if (!clean) return "error: the note is empty";
  notes++;
  propose({ id: `p${++pseq}`, kind: "note", host, text: clean });
  return "proposed — the user sees it and decides, and nothing is saved unless they approve it. Carry on with the task.";
}

function writeNote(host: string, text: string): void {
  mkdirSync(join(home!, "sites"), { recursive: true });
  appendFileSync(notePath(host), `- ${text}\n`);
}

export const hasNotes = () => !!home && entries(join(home, "sites")).some((f) => f.endsWith(".md"));

/** The saved notes about a host, cut to what a tool result carries on arrival. */
export function noteFor(host: string): string {
  if (!home || !host) return "";
  let text = "";
  try {
    text = readFileSync(notePath(host), "utf8").trim();
  } catch {
    return "";
  }
  return text.length > NOTE_CAP ? `${text.slice(0, NOTE_CAP)}…` : text;
}

// One listener, for index.ts to push the skill list and the proposals.
let changed: (() => void) | null = null;
export const onSkillsChange = (fn: () => void) => void (changed = fn);
