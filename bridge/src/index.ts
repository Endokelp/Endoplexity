import { createServer } from "node:http";
import { randomBytes } from "node:crypto";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { ChildProcess } from "node:child_process";
import { WebSocketServer, type WebSocket } from "ws";
import { authorize, authorizeMcp, ALLOWED_ORIGIN } from "./auth.ts";
import { handleMcp, modeNow, pageNow, report, resetSteps, runSkill, setMode, steps, stop } from "./mcp.ts";
import { planOf } from "./gate.ts";
import { guard } from "./second.ts";
import { auditMarkdown, initAudit, resetAudit } from "./audit.ts";
import { cleanOrder, handoffPrompt, limitOf, nextEngine } from "./failover.ts";
import {
  answer,
  begin,
  finish,
  initSkills,
  list as listSkills,
  load as loadSkill,
  onSkillsChange,
  pending,
  remove as removeSkill,
} from "./skills.ts";
import { setPanel, dropPanel, settle, settleGate, sendPanel, panelConnected } from "./relay.ts";
import { cleanRun, dropRun, inRun, runId } from "./run.ts";
import { writeMcpConfig, type Run } from "./claude.ts";
import { writeCursorConfig } from "./cursor.ts";
import { writeCodexConfig } from "./codex.ts";
import { MODELS } from "./models.ts";
import { attach, detach, list as listFiles } from "./files.ts";
import { clearLog, initReflexes, mark, needsLaya, onChange, panelState, saveSettings, writeJevKey } from "./reflex.ts";
import { resetSeeSpent, seeSpent, settled, where } from "./reflexes.ts";
import { startLaya, stopLaya } from "./laya.ts";

const HOST = "127.0.0.1"; // never 0.0.0.0 — this socket can drive a logged-in browser
// Overridable only so a second instance can be smoke-tested without evicting the
// one your panel is talking to. The extension always dials 8787.
const PORT = Number(process.env.ENDO_PORT ?? 8787);
const TOKEN_PATH = fileURLToPath(new URL("../../.endo-token", import.meta.url));

function loadToken(): string {
  if (existsSync(TOKEN_PATH)) return readFileSync(TOKEN_PATH, "utf8").trim();
  const token = randomBytes(24).toString("hex");
  writeFileSync(TOKEN_PATH, token, { mode: 0o600 });
  return token;
}

// Hand-run target for the CDP layer: host.html iframes form.html from the OTHER
// loopback hostname, which Chrome treats as a different site and puts in its own
// renderer. That is the Greenhouse/Lever/Workday shape, reproducible offline.
// An explicit map, not a path join — no traversal to get wrong.
const FIXTURES: Record<string, URL> = {
  "/fixtures/host.html": new URL("../test/fixtures/host.html", import.meta.url),
  "/fixtures/form.html": new URL("../test/fixtures/form.html", import.meta.url),
  "/fixtures/note.html": new URL("../test/fixtures/note.html", import.meta.url),
  "/fixtures/cookie.html": new URL("../test/fixtures/cookie.html", import.meta.url),
  // Shapes drawn on a canvas, with no element of their own: See's page.
  "/fixtures/canvas.html": new URL("../test/fixtures/canvas.html", import.meta.url),
  // A page that tells the agent to confirm a transfer: the second key's page.
  "/fixtures/inject.html": new URL("../test/fixtures/inject.html", import.meta.url),
};

const token = loadToken();
const configPath = writeMcpConfig(PORT, token);
const cursorDir = writeCursorConfig(PORT, token);
const codexDir = writeCodexConfig(PORT, token);
const wss = new WebSocketServer({ noServer: true });

// The reflex layer is inert until this: tests that import mcp.ts never start it.
initReflexes();
// The same for the audit log, which reads the tab's URL for every action.
initAudit();
const pushReflexes = () => void sendPanel(panelState());
// The sidecar runs only while a reflex is set to Laya: Off starts nothing.
function syncLaya() {
  if (!needsLaya()) return stopLaya();
  void startLaya().then(pushReflexes);
}
syncLaya();
// Every logged decision changes the counts; the panel hears at most every 2s.
let pushTimer: NodeJS.Timeout | null = null;
onChange(() => {
  pushTimer ??= setTimeout(() => {
    pushTimer = null;
    pushReflexes();
  }, 2_000);
});

// Skills and the proposals waiting for the user live here, not in the panel,
// which is torn down on every window switch: both ride on every connect and
// every change.
initSkills();
const pushSkills = () => {
  sendPanel({ type: "skills", skills: listSkills() });
  sendPanel({ type: "proposals", items: pending() });
};
onSkillsChange(pushSkills);

const http = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://${HOST}`);

  if (url.pathname === "/mcp") {
    if (!authorizeMcp(req.headers.origin, url.searchParams.get("token"), token)) {
      console.warn(`refused /mcp from origin=${req.headers.origin ?? "(none)"}`);
      return void res.writeHead(401).end();
    }
    return void (await handleMcp(req, res));
  }

  // claude.ts posts here when its reader subagent starts or hands back. A
  // route rather than a call because the bench runs that adapter in a process
  // of its own, and this is the one door both share. Same token, same refusal
  // of an Origin, as /mcp: what it does is small, but it is still the panel.
  if (url.pathname === "/forget" && req.method === "POST") {
    if (!authorizeMcp(req.headers.origin, url.searchParams.get("token"), token)) return void res.writeHead(401).end();
    console.log("reader handoff: the next read is a whole page");
    sendPanel({ type: "forget", run: cleanRun(url.searchParams.get("run")) });
    return void res.writeHead(204).end();
  }

  // scripts/run-task.ts posts a task here, from the OS scheduler or a terminal.
  // Same token and Origin rule as /mcp. The panel owns the debugger, so the run
  // starts there: it opens a tab of its own for it and sends the task back the
  // way Run does. With no panel open there is nothing to drive, and it says so.
  if (url.pathname === "/run" && req.method === "POST") {
    if (!authorizeMcp(req.headers.origin, url.searchParams.get("token"), token)) return void res.writeHead(401).end();
    let body: { task?: unknown; model?: unknown } = {};
    try {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk as Buffer);
      body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}") ?? {};
    } catch {}
    const reply = (code: number, payload: Record<string, unknown>) =>
      void res.writeHead(code, { "content-type": "application/json" }).end(JSON.stringify(payload));
    if (typeof body.task !== "string" || !body.task.trim()) return reply(400, { error: "no task" });
    if (body.model !== undefined && (typeof body.model !== "string" || !Object.hasOwn(MODELS, body.model))) {
      return reply(400, { error: `unknown model ${JSON.stringify(body.model)}` });
    }
    if (!panelConnected()) return reply(409, { error: "the side panel is not open: open Chrome and the Endoplexity panel" });
    const run = `s${randomBytes(4).toString("hex")}`;
    console.log(`scheduled (${run}): ${body.task}`);
    sendPanel({ type: "scheduled", run, task: body.task, ...(body.model !== undefined && { model: body.model }) });
    return reply(202, { run });
  }

  const fixture = FIXTURES[url.pathname];
  if (!fixture) return void res.writeHead(404).end();
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  res.end(readFileSync(fixture));
});

http.on("upgrade", (req, socket, head) => {
  if (!authorize(req.headers.origin)) {
    console.warn(`refused upgrade from origin=${req.headers.origin ?? "(none)"}`);
    socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws));
});

/**
 * Each run's state, by the run id the panel gave its lane (run.ts). One task at
 * a time per run: two agents in one tab would fight over every ref. Runs in
 * different lanes drive different tabs and share nothing but the panel.
 *
 *  - `running`: the CLI, or a skill replaying with no CLI (whose Stop is
 *    mcp.ts's epoch).
 *  - `asked`: the task as sent, then each reply and mid-run message, in the
 *    user's words. An engine taking over after a limit is sent all of it.
 *  - `queued`: mid-run messages no CLI has read yet. cursor and codex take no
 *    input mid-run, and claude stops reading once its run ends, so these go in
 *    a resume the moment the run is over.
 *  - `order` / `spent`: the user's failover order, and the engines that ran
 *    out on this task.
 *  - `stopping`: the human pressed Stop, so nothing carries the run on.
 *  - `ownWords`: the user's own words alone, without the page line and the files
 *    the panel puts in front of a task. The second key and the audit read
 *    this: a page title is page text, and the judge is told the task is the
 *    user's.
 *  - `session`: the transcript the next task can pick up, or null. A finished
 *    run is not a dead run: the CLI keeps its transcript on disk and `--resume`
 *    continues it. This is the difference between an agent that can ask a
 *    question and one that cannot: the first live Greenhouse run stopped to ask
 *    for applicant data and died there, because a fresh spawn per task left the
 *    answer nowhere to go. In memory on purpose, it dies with the bridge:
 *    resuming across a restart would mean resuming into a Chrome that has since
 *    moved on, and every ref in that transcript is already stale.
 *  - `secondOn`: the Second key setting the task started with.
 */
type Lane = {
  running: (Pick<ChildProcess, "kill"> & Pick<Run, "steer">) | null;
  model: string;
  asked: string[];
  ownWords: string[];
  queued: string[];
  order: string[];
  spent: string[];
  stopping: boolean;
  session: { id: string; model: string } | null;
  secondOn: boolean;
};
const lanes = new Map<string, Lane>();
/** The current run's state (run.ts), made on first use. */
function L(): Lane {
  const id = runId();
  let lane = lanes.get(id);
  if (!lane) {
    lane = { running: null, model: "", asked: [], ownWords: [], queued: [], order: [], spent: [], stopping: false, session: null, secondOn: false };
    lanes.set(id, lane);
  }
  return lane;
}

/**
 * claude spells it `session_id`; cursor's bundle carries that spelling, its
 * camelCase twin, and `chatId` — which is what its own `--resume [chatId]`
 * asks for. Read all three rather than pinning one and silently reporting
 * every resumable run as unresumable.
 */
const sessionOf = (event: Record<string, unknown>): string | undefined =>
  [event.session_id, event.sessionId, event.chatId].find(
    (value): value is string => typeof value === "string" && value.length > 0,
  );

// Twice now the agent has written its tool calls out as XML text instead of
// calling anything: one turn, zero real calls, then a confident report of a
// browser session that never happened. Both times the init event listed the
// tools, and the fake calls invented parameter names the real schemas do not
// have — so ToolSearch never returned and this is model-side, not config.
// Nothing in a prompt has fixed it; one respawn costs ~$0.05 and has recovered
// every time. The run is swallowed rather than shown: a hallucinated browser
// session in the log is worse than no log at all.
const FAKE_XML = /<function_calls>|<invoke name=/;

const usedTools = (event: Record<string, unknown>) => {
  // cursor reports tool calls as their own event; claude nests them in the message
  if (event.type === "tool_call") return true;
  // `?? []` does not fire on a truthy non-array, so a string `content` used to
  // reach `.some` and throw. Ask what it IS, not whether it is missing.
  const content = (event.message as { content?: unknown } | undefined)?.content;
  return event.type === "assistant" && Array.isArray(content) &&
    content.some((part) => (part as { type?: string })?.type === "tool_use");
};

function startTask(
  prompt: unknown,
  model: unknown,
  {
    isRetry = false,
    resume = false,
    words = undefined as unknown,
    handoff = false,
    asking = undefined as string | undefined,
    takeover = false,
    steered = false,
    fallbacks = undefined as unknown,
  } = {},
) {
  // Resolved at call time, never captured. A panel that drops and comes back
  // mid-run gets a different socket; a captured one would keep sending into
  // the dead original, so every tool call would still work (those go through
  // callPanel) while the panel showed nothing until the run ended.
  const run = runId();
  const lane = L();
  const send = (event: Record<string, unknown>) => void sendPanel({ type: "task-event", run, event });
  if (typeof prompt !== "string" || !prompt.trim()) return send({ type: "failed", error: "empty prompt" });
  if (lane.running) return send({ type: "failed", error: "a task is already running in this lane — stop it first" });

  // Resuming pins the CLI as well as the transcript — a claude session cannot be
  // handed to cursor-agent — so the panel's dropdown gets no vote on a reply.
  const resuming = resume ? lane.session : null;
  if (resume && !resuming) return send({ type: "failed", error: "no conversation to reply to" });

  // An unknown model used to fall back to sonnet. That silently ran Claude
  // whenever a cursor id was stale — which is precisely how you convince
  // yourself the cursor path works having never once exercised it. The panel's
  // <select> is the only producer, so the fallback protected nobody.
  const chosen = resuming ? resuming.model : model;
  if (typeof chosen !== "string" || !Object.hasOwn(MODELS, chosen)) {
    return send({ type: "failed", error: `unknown model ${JSON.stringify(model)}` });
  }
  // A fresh task abandons the old transcript before the new one reports its own
  // id, so a spawn that dies early cannot leave the previous session looking live.
  if (!resuming) lane.session = null;
  // The trace a skill is saved from. A reply is the same piece of work, a retry
  // is a run that did nothing, and a hand-off finishes a replay (or another
  // engine's run) whose steps are already in it: only a fresh task starts one.
  if (!resuming && !isRetry && !handoff && !takeover) begin(typeof words === "string" && words.trim() ? words : prompt);
  // Phase 18's state follows the same rule. A skill's hand-off keeps the
  // replay's steps; a delivered message is already in `asked`.
  const typed = typeof words === "string" && words.trim() ? words : prompt;
  if (!resuming && !isRetry && !takeover) {
    lane.asked = [asking ?? prompt];
    lane.queued = [];
    lane.spent = [];
    // A skill's hand-off keeps the skill's task, set by startSkill.
    if (!handoff) (resetSteps(), resetSeeSpent(), resetAudit(), (lane.ownWords = [typed]));
  } else if (resuming && !steered) {
    lane.asked.push(`Then the user replied:\n${prompt}`);
    lane.ownWords.push(`Then the user replied: ${typed}`);
  }
  if (!isRetry && !takeover && !steered) lane.stopping = false;
  if (fallbacks !== undefined) lane.order = cleanOrder(fallbacks);

  console.log(`${resuming ? "reply" : "task"} (${chosen}${run && `, run ${run}`}): ${prompt}`);
  let sawTool = false;
  let sawFake = false;
  let redo = false;
  let ended = false;
  const onEvent = (event: Record<string, unknown>) => {
    // A CLI that fails to spawn emits `error` and then `close`, so every adapter
    // reported a failed start twice: two red notes, and the end of the run
    // handled twice. One guard here rather than one per adapter.
    if (ended) return;
    // What See spent on Jev rides on the run's own cost line.
    if (event.type === "result" && seeSpent() > 0) event = { ...event, see_usd: seeSpent() };
    const terminal = event.type === "done" || event.type === "failed";
    if (terminal) ended = true;
    const id = sessionOf(event);
    if (id) lane.session = { id, model: chosen };
    if (usedTools(event)) sawTool = true;
    // Latched across the whole run, not read off the result event alone. That
    // was the bug: the fake XML is emitted in `assistant` events, and a run
    // that fakes its way through and then ends by asking a question has a
    // perfectly clean result event — measured 2026-08-04 on a Greenhouse form,
    // 14 faked calls, 1 turn, $0.06, and no retry because the last message
    // happened not to contain the pattern.
    if (FAKE_XML.test(JSON.stringify(event))) sawFake = true;
    // Only worth retrying a run that did nothing: once a real tool call has
    // landed, the same text pattern is the agent quoting itself, not faking.
    if (event.type === "result" && !sawTool && !isRetry && sawFake) redo = true;
    if (terminal) lane.running = null;
    // Whether this end carries the task on, decided before anything treats it
    // as over: a usage limit goes to the next engine on another CLI, and a
    // message the CLI could not read mid-run goes in as a reply.
    const limit = terminal && !redo && !lane.stopping ? limitOf(event) : null;
    const next = limit ? nextEngine(lane.order, [...lane.spent, chosen]) : null;
    const deliver = terminal && !redo && !next && !lane.stopping && !event.error && lane.queued.length > 0 && lane.session !== null;
    // A clean end offers the run as a skill, or a healed replay's change to
    // one. Not for the void run a retry replaces, nor for a task carrying on.
    if (terminal && !redo && !next && !deliver) finish(event.type === "done" && !event.error);
    // Anything of this task's still in the bridge (a batch mid-way, a queued
    // call) belongs to a CLI that is gone.
    if (terminal) stop();
    // Untruncated, because this is the one line that settles "did the agent
    // actually have the tools" — a model that emits fake <function_calls> XML as
    // text looks identical in the panel to one whose tools are missing.
    if (event.type === "system" && event.subtype === "init") {
      // cursor's init carries no tool list, so "tools: undefined" there is the
      // shape of its event, not a run that came up empty — say which.
      console.log(
        event.tools ? `  tools: ${JSON.stringify(event.tools)}` : `  ${event.model} (no tool list in init)`,
      );
    }
    console.log(`  ${JSON.stringify(event).slice(0, 200)}`);

    // Swallow the void run entirely, then respawn once the child is actually
    // gone. The panel stays busy throughout, so this reads as one slow task.
    if (redo) {
      if (!terminal) return;
      send({ type: "retry", reason: "the agent wrote its tool calls as text instead of calling them — retrying once" });
      // Never resumed: the point of the retry is to discard a transcript whose
      // only content is faked tool calls.
      return startTask(prompt, chosen, { isRetry: true });
    }
    if (!terminal) return send(event);
    // The two ways on keep the panel busy too: no terminal event reaches it.
    if (next) {
      lane.spent.push(chosen);
      return void takeOver(chosen, next, limit!);
    }
    if (deliver) {
      const text = lane.queued.join("\n\n");
      lane.queued = [];
      send({ type: "handoff", reason: `the run ended before ${chosen} could read your message, so it goes in as a reply` });
      return startTask(text, chosen, { resume: true, steered: true });
    }
    if (lane.queued.length) {
      sendPanel({ type: "note", text: `your message reached no agent: the run ${lane.stopping ? "was stopped" : "ended with an error"}. Reply to send it.` });
      lane.queued = [];
    }
    // The panel offers Reply off this flag, so it rides on the event that turns
    // the buttons back on rather than arriving as a message of its own. A run
    // killed by Stop is resumable too — that is the point, not an oversight.
    const end = limit ? { ...event, error: `${limit} (no engine on another CLI is set to take over: see Engines)` } : event;
    return send({ ...end, resumable: lane.session !== null });
  };

  lane.model = chosen;
  // The CLI's events arrive on its stdout, outside the run that spawned it, so
  // each is handled back inside it: everything onEvent calls reads this run's state.
  lane.running = MODELS[chosen](prompt, chosen, (event) => inRun(run, () => onEvent(event)), resuming?.id, run);
}

/**
 * The engine running `from` hit its usage limit: the task goes to `to`, fresh,
 * on the same tab, with what was asked, what was done and the page as it is.
 * The panel stays busy throughout, as for a retry.
 */
async function takeOver(from: string, to: string, why: string) {
  const run = runId();
  const lane = L();
  const send = (event: Record<string, unknown>) => void sendPanel({ type: "task-event", run, event });
  console.log(`usage limit on ${from} (${why}): ${to} takes over`);
  send({ type: "handoff", reason: `${from} hit its usage limit (${why}). ${to} carries on, on the same tab.` });
  // Held while the page is read, so a Stop has something to stop and no second
  // task can start in the gap.
  let dropped = false;
  lane.running = { kill: () => (dropped = true) };
  const at = await where();
  const page = await pageNow();
  lane.running = null;
  if (dropped || lane.stopping) return send({ type: "done", resumable: lane.session !== null });
  // Messages the old engine never read are in `asked` already.
  lane.queued = [];
  startTask(handoffPrompt({ from, asked: lane.asked, steps: steps(), where: at.url ? at : null, page }), to, { takeover: true });
}

/**
 * A message the user typed while a task runs. claude reads it mid-turn off
 * stdin; cursor and codex take nothing mid-run, so it waits for the run's end
 * and goes in as a reply.
 */
function steer(text: unknown) {
  if (typeof text !== "string" || !text.trim()) return;
  const lane = L();
  if (!lane.running) return void sendPanel({ type: "note", text: "nothing is running: Run or Reply to send it" });
  lane.asked.push(`While it ran, the user said: ${text}`);
  lane.ownWords.push(`While it ran, the user said: ${text}`);
  if (lane.running.steer?.(text)) return void sendPanel({ type: "note", text: `sent to the running agent (${lane.model})` });
  lane.queued.push(text);
  sendPanel({ type: "note", text: `queued: ${lane.model || "the agent"} reads it when this run ends` });
}

/**
 * The panel's Run skill: the saved steps with no model at all. A step the
 * replay cannot place goes, with the rest of the task, to the model the panel
 * has selected, as a fresh task; when that run ends well, finish() offers the
 * user the change to the skill.
 */
async function startSkill(id: unknown, vars: unknown, model: unknown, fallbacks: unknown) {
  const run = runId();
  const lane = L();
  const send = (event: Record<string, unknown>) => void sendPanel({ type: "task-event", run, event });
  if (lane.running) return send({ type: "failed", error: "a task is already running in this lane — stop it first" });
  // Checked before anything runs: the hand-off needs a model to go to.
  if (typeof model !== "string" || !Object.hasOwn(MODELS, model)) {
    return send({ type: "failed", error: `unknown model ${JSON.stringify(model)}` });
  }
  let task: string;
  try {
    task = loadSkill(id).task;
  } catch (err) {
    return send({ type: "failed", error: (err as Error).message });
  }
  // A replay is a fresh piece of work: a Reply after it must not resume the
  // conversation before it, which knows nothing of these steps.
  lane.session = null;
  begin(task);
  resetSteps();
  resetAudit();
  lane.ownWords = [task];
  lane.queued = [];
  lane.spent = [];
  lane.stopping = false;
  lane.order = cleanOrder(fallbacks);
  console.log(`skill: ${id}`);
  const t0 = Date.now();
  // Stop reaches a replay through mcp.ts's epoch, which index.ts's stop
  // handler bumps before it calls this.
  lane.running = { kill: () => true };
  lane.model = "";
  const r = await runSkill(String(id), vars);
  lane.running = null;
  console.log(`  ${report({ ...r, page: undefined })}`);
  // Typed while the replay ran, which reads nothing: the model taking over
  // reads it, and with no model it reaches nobody.
  const said = lane.queued.splice(0);
  if (!r.stop || r.stop.final) {
    if (!r.stop) send({ type: "result", result: `Replayed all ${r.of} steps of "${r.skill?.name}", with no model.`, num_turns: 0, duration_ms: Date.now() - t0 });
    if (said.length) sendPanel({ type: "note", text: "your message reached no agent: a replay reads nothing. Run it as a task to send it." });
    send({ type: "done", resumable: false, ...(r.stop && { error: report(r) }) });
    finish(!r.stop);
    return stop();
  }
  send({ type: "handoff", reason: `replay stopped at step ${r.stop.at + 1} of ${r.of} (${r.stop.why}) — handing the rest to ${model}` });
  // The skill's task is the one place its file reaches a prompt as a task: the
  // user just chose to run it. Everything else in the hand-off is framed as
  // page content by report().
  const told = (page: string | undefined) =>
    [
      `You are finishing a saved skill the user just ran, "${r.skill?.name}". Its task, as recorded when it was saved: ${task}`,
      report({ ...r, page }),
      ...(said.length ? [`While the replay ran, the user said:\n${said.join("\n")}`] : []),
    ].join("\n\n");
  // Asked without the page: an engine taking over after a limit gets the page
  // as it is by then, and was sent this one as well (seen live, P18).
  startTask(told(r.page), model, { handoff: true, asking: told(undefined) });
}

/**
 * The panel's Second key setting for the task about to start. Only an explicit
 * false turns it off: it adds a verdict to a prompt the gate shows anyway and
 * can approve nothing, so a garbled setting costs a CLI call, never a check.
 * The engine is read when the gate asks, since a failover changes it; a replay
 * runs none, so it judges as for the model it would hand over to.
 */
function guardRun(setting: unknown, model: unknown) {
  const lane = L();
  lane.secondOn = setting !== false;
  guard(lane.secondOn ? () => ({ engine: lane.model || String(model ?? ""), task: lane.ownWords }) : null);
}

/**
 * A panel that drops mid-run has 15 seconds to come back before the child is
 * killed. Chrome tears the side panel document down on every window switch, so
 * a drop is routine, not exceptional — and every tool call the agent makes
 * while nobody is listening fails (relay.ts rejects with "the panel
 * disconnected"), so an un-killed orphan just burns the subscription reading
 * errors. The agent's own retry habit covers the gap: by the time it routes
 * around a failed call, the panel is usually back.
 *
 * ponytail: 15s is the tuned knob, not a derived constant.
 */
const ORPHAN_GRACE_MS = 15_000;
let orphanTimer: NodeJS.Timeout | null = null;

wss.on("connection", (ws) => {
  console.log("panel connected");
  setPanel(ws);
  if (orphanTimer) {
    clearTimeout(orphanTimer);
    orphanTimer = null;
  }

  // What the panel cannot know on its own after a remount: whether a task is
  // still running, and whether the last one left a transcript to reply to.
  // `resumable` used to reset to false on every remount, which is why Reply
  // went dark after a window switch even though the bridge still had the id.
  //
  // The files ride along for the same reason. They live on disk here, not in
  // the panel — Chrome tears the side panel document down on every window
  // switch, so a list held there would take the chips with it and the user
  // would be re-attaching a resume several times an hour.
  //
  // Per run since Phase 21, as `runs`. `running` and `resumable` still describe
  // the run "", which is what a panel from before lanes drives.
  const runs = [...lanes].map(([run, lane]) => ({ run, running: lane.running !== null, resumable: lane.session !== null }));
  const plain = lanes.get("");
  ws.send(
    JSON.stringify({ type: "hello", runs, running: Boolean(plain?.running), resumable: Boolean(plain?.session), files: listFiles() }),
  );
  // The panel's Reflexes section and cdp.js's Settle state both come from here:
  // the panel holds no settings of its own across a remount.
  ws.send(JSON.stringify(panelState()));
  ws.send(JSON.stringify({ type: "skills", skills: listSkills() }));
  ws.send(JSON.stringify({ type: "proposals", items: pending() }));

  ws.on("message", (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return; // ponytail: malformed frames are dropped, no error channel needed until there is a protocol
    }
    // `"null"` and `"7"` parse cleanly and are not frames — reading .type off
    // either throws inside a ws handler, which takes the process with it.
    if (!msg || typeof msg !== "object") return;
    // Everything a message starts happens in the run of the lane that sent it
    // (run.ts), so a Stop or a task in one lane never reads another's state.
    inRun(cleanRun(msg.run), () => onMessage(ws, msg));
  });

  ws.on("close", () => {
    dropPanel(ws);
    console.log("panel disconnected");
    if (![...lanes.values()].some((lane) => lane.running) || orphanTimer) return;
    orphanTimer = setTimeout(() => {
      orphanTimer = null;
      const orphans = [...lanes.values()].filter((lane) => lane.running);
      if (!orphans.length) return;
      console.warn(`no panel for ${ORPHAN_GRACE_MS / 1000}s — killing the ${orphans.length === 1 ? "task" : "tasks"} it was driving`);
      for (const lane of orphans) lane.running?.kill();
    }, ORPHAN_GRACE_MS);
  });
});

/** One message from the panel, already inside the run of the lane that sent it. */
function onMessage(ws: WebSocket, msg: Record<string, any>) {
  if (msg.type === "ping") ws.send(JSON.stringify({ type: "pong", at: Date.now() }));
  else if (msg.type === "tool-result") settle(msg);
  else if (msg.type === "gate-reply") settleGate(msg);
  else if (msg.type === "task") {
    // The mode is the human's, so it arrives with the task and is enforced in
    // the bridge. It is never in a prompt and the model never sees it, so
    // nothing the agent says can widen its own permissions. The plan lock and
    // the second key ride with it, for the same reason.
    setMode(msg.mode, msg.plan);
    guardRun(msg.secondKey, msg.model);
    // The failover order is the human's too, and failover.ts admits only
    // models MODELS knows, so it can name no binary the dropdown cannot.
    startTask(msg.prompt, msg.model, { resume: msg.resume === true, words: msg.task, fallbacks: msg.fallbacks ?? [] });
  } else if (msg.type === "run-skill") {
    // Same rule as a task: the mode is the human's and arrives with the run.
    if (!L().running) (setMode(msg.mode, msg.plan), guardRun(msg.secondKey, msg.model));
    void startSkill(msg.id, msg.vars, msg.model, msg.fallbacks);
  } else if (msg.type === "steer") steer(msg.text);
  else if (msg.type === "audit") {
    // What this task did, as a file the panel saves. The engines are the ones
    // that ran out, then the one that ran last.
    const lane = L();
    const engines = [...new Set([...lane.spent, lane.model].filter(Boolean))];
    ws.send(JSON.stringify({ type: "audit", run: runId(), ...auditMarkdown({ task: lane.ownWords, engines, mode: modeNow(), ...planOf(), second: lane.secondOn }) }));
  }
  else if (msg.type === "proposal-reply") {
    // Writes only what the bridge holds for that id; `name` is a skill's
    // file name, which skills.ts reduces to [a-z0-9-].
    try {
      const saved = answer(msg.id, msg.approved, msg.name);
      if (saved) ws.send(JSON.stringify({ type: "note", text: saved }));
    } catch (err) {
      ws.send(JSON.stringify({ type: "reflex-failed", error: `not saved: ${(err as Error).message}` }));
    }
  } else if (msg.type === "delete-skill") {
    try {
      removeSkill(msg.id);
    } catch (err) {
      ws.send(JSON.stringify({ type: "reflex-failed", error: (err as Error).message }));
    }
  } else if (msg.type === "attach-file" || msg.type === "detach-file") {
    // The panel cannot hand over a path — an <input type="file"> gives a name
    // and bytes and nothing else — so the bytes come over this socket and the
    // copy on disk is what `upload` and `read_file` then resolve a key to.
    try {
      if (msg.type === "attach-file") {
        // base64 rather than a binary frame: the panel's protocol is one JSON
        // shape per message and a second one buys nothing here. A ~33% size
        // tax on a file that is sent once is not worth a framing branch.
        //
        // typeof, not String(): coercing an object gives "[object Object]",
        // and Buffer.from drops the characters outside the base64 alphabet
        // rather than throwing — so that decodes to nine real bytes and a
        // garbled message would WRITE A FILE instead of being refused. Same
        // family as the three P12a crashes: valid JSON that is not the shape
        // the reader assumed.
        if (typeof msg.data !== "string") throw new Error("attach-file carried no data");
        const added = attach(msg.name, Buffer.from(msg.data, "base64"));
        console.log(`attached "${added.key}" — ${added.name}, ${added.size} bytes`);
      } else {
        detach(msg.key);
        console.log(`detached "${msg.key}"`);
      }
      ws.send(JSON.stringify({ type: "files", files: listFiles() }));
    } catch (err) {
      // Named, and sent back rather than logged: the bridge runs windowless,
      // so a refusal nobody sees is a paperclip that silently does nothing.
      ws.send(JSON.stringify({ type: "file-failed", error: (err as Error).message }));
    }
  } else if (msg.type === "reflex-log") settled(msg.row);
  else if (msg.type === "reflex-settings" || msg.type === "reflex-mark" || msg.type === "reflex-clear" || msg.type === "reflex-status") {
    // Settings are sanitized in reflex.ts: an unknown value is the default,
    // and Act that a backend has not earned arrives as Shadow.
    if (msg.type === "reflex-settings") {
      saveSettings(msg.settings);
      syncLaya();
    } else if (msg.type === "reflex-mark") mark(msg.id, msg.truth);
    else if (msg.type === "reflex-clear") clearLog();
    pushReflexes();
  } else if (msg.type === "jev-key") {
    try {
      writeJevKey(msg.key);
    } catch (err) {
      ws.send(JSON.stringify({ type: "reflex-failed", error: `Jev key not saved: ${(err as Error).message}` }));
    }
    pushReflexes();
  } else if (msg.type === "stop") {
    // Killing the CLI stops its next call, not a batch already in the bridge.
    const lane = L();
    lane.stopping = true;
    stop();
    lane.running?.kill();
  }
  // The panel closed a lane (or, before lanes, archived its one transcript),
  // so its CLI session must go too: otherwise a Reply after the next remount
  // would resume the conversation the user just put away. The lane's state
  // goes with it in every module (run.ts). A task still running is left
  // alone; the panel closes only idle lanes.
  else if (msg.type === "close-run" || msg.type === "new-session") {
    const run = runId();
    if (lanes.get(run)?.running) return;
    lanes.delete(run);
    dropRun(run);
  }
}

// The bridge is started by a Startup .vbs with no window, so dying is silent:
// the panel just says "not connected" forever and the reason is in a log nobody
// knows to open. Staying up with one wedged task beats that, every time. This is
// a backstop, not an error channel — a throw reaching here is a bug to fix.
for (const fatal of ["uncaughtException", "unhandledRejection"] as const) {
  process.on(fatal, (err) => console.error(`${fatal}:`, err));
}

// Autostart means a second `npm start` is a normal mistake, not a rare one, and
// an unhandled EADDRINUSE prints a stack trace that reads like a broken install.
http.on("error", (err: NodeJS.ErrnoException) => {
  if (err.code !== "EADDRINUSE") throw err;
  console.log(`a bridge is already listening on ${HOST}:${PORT} — you don't need this one`);
  process.exit(0);
});

http.listen(PORT, HOST, () => {
  console.log(`bridge listening on ws://${HOST}:${PORT}`);
  // The token is no longer typed by anyone — the panel fetches it from /pair.
  // Printing the origin instead is what makes a refusal diagnosable: index.ts
  // logs the origin it refused, and this is the one it wanted.
  console.log(`paired extension: ${ALLOWED_ORIGIN}`);
  console.log(`mcp config for claude: ${configPath}`);
  console.log(`isolated cursor profile: ${cursorDir}`);
  console.log(`isolated codex home: ${codexDir}`);
});
