import type { Second } from "./second.ts";
import { perRun } from "./run.ts";

/**
 * The audit log (Phase 20): what a task did, in a form someone can read
 * afterwards without the screen recording. One entry per action the agent or a
 * replay took, with the tab it was on, the element, what was typed (secrets
 * redacted), the result, and the gate's question, the second key's verdict and
 * the human's answer when it asked. The panel's Export button turns it into a
 * Markdown file.
 *
 * ponytail: in memory, for the task under way and its replies; it dies with
 * the bridge, like the session it describes. Write it to ~/.endo per run if a
 * log that outlives a restart is ever asked for.
 */

export type Gated = { asked: string; second?: Second; approved: boolean };
type Entry = { at: Date; url: string; tool: string; on: string; value?: string; result: string; gate?: Gated };
export type Meta = { task: string[]; engines: string[]; mode: string; drawn: string[]; approved: string[]; second: boolean };

// ponytail: a cap, not a policy. A run this long hands over its first 2,000.
const CAP = 2_000;

// Off until index.ts turns it on: reading the tab URL for each entry is a call
// to the panel, and the tests' fake panels answer only what they expect.
let on = false;
// Per run (run.ts): each run has its own log.
const S = perRun(() => ({ entries: [] as Entry[], held: undefined as Gated | undefined, started: new Date(), secrets: [] as string[] }));

export const initAudit = () => void (on = true);
export const auditing = () => on;

/** A fresh task. A reply carries on the same log. */
export function resetAudit(): void {
  Object.assign(S(), { entries: [], held: undefined, started: new Date(), secrets: [] });
}

/** The gate asked about the action that is about to be recorded. */
export function gateDecided(g: Gated): void {
  S().held = g;
}

/**
 * One action. `secret` says the value went into a field whose label reads as
 * a password or a card number: it is written as redacted, and redacted out of
 * the task text too, where the user's own words can carry it.
 */
export function audited(e: Omit<Entry, "at" | "gate">, secret = false): void {
  const st = S();
  const gate = st.held;
  st.held = undefined;
  if (secret && e.value) {
    if (e.value.length >= 4) st.secrets = [...st.secrets, e.value];
    e = { ...e, value: "(redacted)" };
  }
  if (st.entries.length < CAP) st.entries = [...st.entries, { ...e, at: new Date(), ...(gate && { gate }) }];
}

// Page text and model text go in code spans: a label is written by a website,
// and a Markdown viewer would otherwise render its links and images.
const code = (s: string) => `\`${s.replaceAll("`", "'").replace(/[\r\n]+/g, " ").trim() || " "}\``;
const time = (d: Date) => d.toTimeString().slice(0, 8);
const hide = (s: string) => S().secrets.reduce((t, x) => t.replaceAll(x, "(redacted)"), s);

function second(s: Second | undefined): string {
  if (!s) return "second key off";
  return s.verdict ? `second key (${s.by}): **${s.verdict}**, ${code(s.reason)}` : `second key unavailable (${s.by}): ${code(s.reason)}`;
}

/** The file the panel saves. */
export function auditMarkdown(meta: Meta): { name: string; markdown: string } {
  const { entries, started } = S();
  const stamp = `${started.toLocaleDateString("en-CA")}-${time(started).slice(0, 5).replace(":", "")}`;
  const gates = entries.filter((e) => e.gate);
  const lines = [
    `# Endoplexity audit, ${started.toLocaleDateString("en-CA")} ${time(started)}`,
    "",
    `- Engine: ${meta.engines.join(", then ") || "no model ran"}`,
    `- Mode: ${meta.mode}`,
    `- Plan: ${meta.drawn.length ? meta.drawn.join(", ") : "any site"}${meta.approved.length ? `; approved during the run: ${meta.approved.join(", ")}` : ""}`,
    `- Second key: ${meta.second ? "on" : "off"}`,
    `- ${entries.length} actions, ${gates.length} approvals asked, ${gates.filter((e) => !e.gate!.approved).length} denied`,
    "",
    "## Task, in the user's words",
    "",
    ...meta.task.map((t) => t.split("\n").map((l) => `> ${l}`).join("\n")),
    "",
    "## Actions",
    "",
    "Times are local. Element labels, page URLs and the second key's reasons come from web pages and models, and are quoted as written.",
    "",
  ];
  if (!entries.length) lines.push("No actions were taken.");
  for (const [i, e] of entries.entries()) {
    const value = e.value === undefined ? "" : ` with ${code(e.value)}`;
    lines.push(`${i + 1}. ${time(e.at)} **${e.tool}**${e.on ? ` ${code(e.on)}` : ""}${value} on ${e.url ? code(e.url) : "an unread tab"}: ${code(e.result)}`);
    if (e.gate) {
      lines.push(`   - asked: ${code(e.gate.asked)}`);
      lines.push(`   - ${second(e.gate.second)}`);
      lines.push(`   - the human: **${e.gate.approved ? "approved" : "denied"}**`);
    }
  }
  // hide the whole file: a secret typed into a field the label check missed shows up in values, results and reasons too
  return { name: `endoplexity-audit-${stamp}.md`, markdown: hide(`${lines.join("\n")}\n`) };
}
