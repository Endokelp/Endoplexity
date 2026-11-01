import * as cdp from "./cdp.js";
import { measure, selftest } from "./selftest.js";
import { runTool } from "./tools.js";
import * as ui from "./transcript.js";
import { fresh, pack, startNew, titleOf } from "./sessions.js";
import { block as mentionBlock, label as mentionLabel } from "./mentions.js";
import { block as filesBlock, humanSize, toBase64 } from "./attachments.js";

// No token anywhere in here on purpose. The bridge identifies this panel by the
// Origin Chrome puts on the upgrade, which page script cannot forge — see the
// reasoning on authorize() in bridge/src/auth.ts.
const BRIDGE = "ws://127.0.0.1:8787";

// Tasks have buttons. The console stays exposed because it is still the only
// way to reach the CDP layer directly (`endo.snapshot()`, `await
// endo.selftest()`) — right-click the panel -> Inspect. `endo.task` drives the
// same path the Run button does, so the buttons never disagree with what is
// actually running.
globalThis.endo = {
  ...cdp,
  selftest,
  measure,
  task: (prompt) => {
    promptEl.value = prompt;
    runTask();
  },
  reply: (answer) => {
    promptEl.value = answer;
    runTask(true);
  },
  stop: () => stopBtn.click(),
  // A bug report is now one call and a copy, instead of selecting a <pre>.
  log: () => logEl.textContent,
};

const dot = document.getElementById("dot");
const status = document.getElementById("status");
const whereState = document.getElementById("where-state");
const whereTitle = document.getElementById("where-title");
const whereMode = document.getElementById("where-mode");
const logEl = document.getElementById("log");
const chatEl = document.getElementById("chat");
const stepEl = document.getElementById("step");
const promptEl = document.getElementById("prompt");
const runBtn = document.getElementById("run");
const replyBtn = document.getElementById("reply");
const stopBtn = document.getElementById("stop");
const modelEl = document.getElementById("model");
const modeEl = document.getElementById("mode");
const gate = document.getElementById("gate");
const gateAction = document.getElementById("gate-action");
const gateApprove = document.getElementById("gate-approve");
const gateDeny = document.getElementById("gate-deny");
const newBtn = document.getElementById("new");
const historyEl = document.getElementById("history");
const historyOpen = document.getElementById("history-open");
const viewingBar = document.getElementById("viewing");
const toCurrentBtn = document.getElementById("to-current");
const mentionsEl = document.getElementById("mentions");
const composerEl = document.querySelector(".composer");
const filesEl = document.getElementById("files");
const attachBtn = document.getElementById("attach");
const fileInput = document.getElementById("file-input");

ui.mount(chatEl, stepEl, logEl, () => save());

let socket = null;
// The bridge holds one task at a time, so at most one gate is ever open.
// Tracking its id (not just a boolean) lets a stale button click be told apart
// from a still-live one if a row somehow outlives its gate.
let pendingGateId = null;
// Whether the last run left a transcript the bridge can continue. The id itself
// stays bridge-side. Set from the bridge's `hello` on every connect, because a
// panel remount used to reset this to false and Reply went dark after a window
// switch even though the bridge still held the session.
let resumable = false;

/**
 * Sessions, newest first, with sessions[0] the live one. Mirrored into
 * chrome.storage.local so a transcript outlives both the panel document (Chrome
 * tears it down on every window switch) and the bridge.
 *
 * `viewing` is an index into it. Anything other than 0 is history: read-only,
 * Reply off, and never written back — sessions[0] is the only slot that grows.
 */
let sessions = [fresh()];
let viewing = 0;
let saveTimer = null;

/** Copy the live journal into the live slot. Cheap; the pack() caps it. */
function syncLive() {
  sessions[0].entries = pack(ui.snapshot());
}

/**
 * Debounced, because a running task journals a line every few hundred ms and
 * chrome.storage.local is a real write each time.
 */
function save() {
  // A history view replays into the journal, so saving from one would copy an
  // old transcript over the live slot.
  if (viewing !== 0) return;
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    syncLive();
    store();
    drawHistory();
  }, 400);
}

// chrome.storage.local rejects once the history outgrows the 10MB quota, and an
// unhandled rejection here is invisible: the transcript just quietly stops
// surviving window switches, which is the one thing sessions exist to do. Said
// once — a failing write repeats every 400ms and a note per write is its own bug.
let storageWarned = false;
function store() {
  chrome.storage.local.set({ sessions }).catch((err) => {
    console.warn("endo: history not saved —", err);
    if (storageWarned) return;
    storageWarned = true;
    ui.note("history could not be saved — storage is full, so older sessions may not survive a reload", true);
  });
}

const when = (at) =>
  new Date(at).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });

function drawHistory() {
  historyEl.replaceChildren();
  if (sessions.length === 1 && !sessions[0].entries.length) {
    const hint = document.createElement("div");
    hint.className = "hempty";
    hint.textContent = "nothing yet — finished sessions are kept here";
    return void historyEl.appendChild(hint);
  }
  sessions.forEach((session, index) => {
    const row = document.createElement("button");
    row.className = index === viewing ? "hrow on" : "hrow";
    const title = document.createElement("span");
    title.className = "htitle";
    title.textContent = titleOf(session);
    const stamp = document.createElement("span");
    stamp.className = "hwhen";
    stamp.textContent = index === 0 ? "current" : when(session.at);
    row.append(title, stamp);
    row.addEventListener("click", () => showSession(index));
    historyEl.appendChild(row);
  });
}

/**
 * Put a session on screen. Restoring a COPY of the entries matters: the journal
 * is appended to by anything that renders, and a history view that shared the
 * stored array would quietly grow an old session every time it printed a note.
 */
function showSession(index) {
  if (index !== 0 && runBtn.disabled) {
    return ui.note("a task is running — stop it or wait before opening an earlier session");
  }
  if (viewing === 0) syncLive(); // don't lose what has not been debounced yet
  viewing = index;
  ui.restore((sessions[index]?.entries ?? []).slice());
  viewingBar.classList.toggle("show", index !== 0);
  setBusy(false);
  drawHistory();
  historyOpen.open = false;
}

/**
 * Tell the bridge to forget its CLI session, or a Reply after the next remount
 * would resume the conversation New just archived.
 *
 * Latched rather than fire-and-forget: with the socket down there is nothing to
 * tell, but the bridge still holds the id, and its `hello` on reconnect would
 * light Reply straight back up on the fresh session. Deliberately not routed
 * through send(), whose "not connected" note would land in the empty transcript
 * this is part of creating.
 */
let dropPending = false;

function dropBridgeSession() {
  dropPending = true;
  if (socket?.readyState !== WebSocket.OPEN) return;
  socket.send(JSON.stringify({ type: "new-session" }));
  dropPending = false;
}

/** Start clean without losing what came before — the live one moves to History. */
function newSession() {
  syncLive();
  sessions = startNew(sessions);
  viewing = 0;
  viewingBar.classList.remove("show");
  ui.clear();
  dropBridgeSession();
  resumable = false;
  setBusy(false);
  store();
  drawHistory();
  promptEl.focus();
}

function setState(state, text) {
  dot.className = state;
  status.textContent = text;
}

/**
 * Which tab is being driven, and how it is going.
 *
 * This exists because of the worst failure this project has had: attach() bound
 * once and nothing re-bound it, so a panel left open kept driving whatever tab
 * was active when it first attached. A Greenhouse form was filled perfectly,
 * every tool returning success, in a tab nobody was watching. Re-attaching on a
 * fresh Run fixed the cause; showing the tab is what makes it visible when it
 * happens again for some other reason.
 */
const STATE_ICON = { idle: "#i-dot", run: "#i-live", done: "#i-check", fail: "#i-x" };

function setWhere(page, state) {
  if (page !== undefined) {
    whereTitle.textContent = page ? page.title || page.url : "no tab attached yet";
    whereTitle.title = page ? page.url : "";
    whereTitle.classList.toggle("idle", !page);
  }
  if (state !== undefined) {
    whereState.firstElementChild.setAttribute("href", STATE_ICON[state] ?? STATE_ICON.idle);
    // setAttribute, not .className: on an SVGElement className is a read-only
    // SVGAnimatedString, so assigning to it silently does nothing.
    whereState.setAttribute("class", state === "idle" ? "icon" : `icon ${state}`);
  }
}

function showMode() {
  whereMode.textContent = modeEl.selectedOptions[0].textContent;
  // Trust turns off the only safety feature there is, so it must never be
  // quietly in force — it stays on screen, coloured, the whole time it is set.
  whereMode.className = modeEl.value === "normal" ? "" : modeEl.value;
}

/** Returns false if there was nowhere to send it, so callers can bail. */
function send(payload) {
  if (socket?.readyState !== WebSocket.OPEN) {
    ui.note("not connected");
    return false;
  }
  socket.send(JSON.stringify(payload));
  return true;
}

function showGate({ id, action }) {
  pendingGateId = id;
  gateAction.textContent = action;
  gate.classList.add("show");
  ui.gateRow(action);
}

function hideGate() {
  pendingGateId = null;
  gate.classList.remove("show");
}

/** Approve/Deny share this — only the boolean differs. */
function replyGate(approved) {
  // A click can still land after the row is hidden (double-click, or the task
  // ended first) — with no pending id there is nothing left to resolve.
  if (pendingGateId === null) return;
  send({ type: "gate-reply", id: pendingGateId, approved });
  hideGate();
  ui.gateSettled(approved);
}

gateApprove.addEventListener("click", () => replyGate(true));
gateDeny.addEventListener("click", () => replyGate(false));

// Tools that land somewhere new, so the header has to be re-read afterwards.
const MOVES = new Set(["navigate", "use_tab", "back", "forward"]);

/** Run a tool the bridge asked for and answer it, however it went. */
async function answer({ id, name, args, label }) {
  // The row goes up before the call runs: this is the "watch it work" line, and
  // a step that only appears once it has finished is not one.
  const row = ui.tool(name, args, label);
  try {
    const value = await runTool(name, args);
    row.ok(value);
    if (MOVES.has(name)) setWhere(await cdp.currentPage().catch(() => null));
    send({ type: "tool-result", id, ok: true, value });
  } catch (err) {
    // Errors go back as results, not thrown away: "stale ref" is the model's cue
    // to snapshot again, and it can only act on what it is told.
    row.fail(err.message);
    send({ type: "tool-result", id, ok: false, error: err.message });
  }
}

// The phase gate is a number, so the number has to be on screen. Only the fields
// actually present get a slot: cursor's result carries neither a price nor a
// token count, and a printed "$0.0000 · 0 tokens" would read as a free run
// rather than an unreported one.
function cost(event) {
  // claude reports snake_case, cursor camelCase. Reading only one spelling is
  // how a run that cost 60k tokens prints as 0.
  const u = event.usage ?? {};
  const tokens =
    (u.input_tokens ?? u.inputTokens ?? 0) +
    (u.cache_creation_input_tokens ?? u.cacheWriteTokens ?? 0) +
    (u.cache_read_input_tokens ?? u.cacheReadTokens ?? 0) +
    (u.output_tokens ?? u.outputTokens ?? 0);
  const parts = [];
  if (event.total_cost_usd !== undefined) parts.push(`$${event.total_cost_usd.toFixed(4)}`);
  if (tokens) parts.push(`${tokens.toLocaleString()} tokens`);
  if (event.num_turns !== undefined) parts.push(`${event.num_turns} turns`);
  parts.push(`${Math.round((event.duration_ms ?? 0) / 1000)}s`);
  return parts.join(" · ");
}

/**
 * Everything the model has said this run, so the result event can be recognised
 * as a repeat of it.
 *
 * Both CLIs emit the final message twice — once as an assistant event, once as
 * the result's summary. This used to hold only the LATEST assistant text, which
 * is right only when the answer is the very last thing said. It is not, often:
 * a long answer arrives split across two assistant events, or a closing line
 * follows it — and then the result matched nothing and the whole answer printed
 * a second time under the first. Measured on grok, 2026-08-12, on a
 * three-tab research run.
 */
let said = [];
/** A repeat of anything said this run, including a run of messages joined. */
const alreadySaid = (text) => said.join("\n").includes(text);

/**
 * One task event -> the conversation.
 *
 * Tool calls are deliberately NOT read out of the model's events any more. The
 * bridge already tells the panel every call it must run, with its name and
 * args, so answer() renders them — which means claude's nested `tool_use` parts
 * and cursor's separate `tool_call` events both stop needing special cases, and
 * a gate-denied call correctly shows an approval row and no tool row.
 */
function show(event) {
  if (event.type === "assistant") {
    const text = (event.message?.content ?? [])
      .filter((part) => part.type !== "tool_use")
      .map((part) => part.text ?? "")
      .join("\n")
      .trim();
    if (!text) return;
    said.push(text);
    return ui.assistant(text);
  }
  // cursor's tool_call event is now redundant with answer()'s row.
  if (event.type === "tool_call") return;
  // The bridge terminal prints this too, but a fake-<function_calls> run is
  // diagnosed from the panel — so the evidence has to be in the same paste.
  // cursor's init has no tool list, so it reports what it does carry instead.
  if (event.type === "system" && event.subtype === "init") {
    return ui.note(
      event.tools
        ? `tools: ${event.tools.join(", ") || "(none)"}`
        : `model: ${event.model ?? "?"} · auth: ${event.apiKeySource ?? "?"}`,
    );
  }
  if (event.type === "retry") return ui.note(`↻ ${event.reason}`);
  if (event.type === "result") {
    const text = String(event.result ?? "").trim();
    // Usually a verbatim repeat of what was already said, but not always: cursor
    // can finish with result:"" after leaving its answer in thinking deltas
    // (measured on composer-2.5), so dropping it unconditionally would lose the
    // only copy on some runs.
    if (text && !alreadySaid(text)) ui.assistant(text);
    else if (!text && !said.length) {
      ui.note("the model produced no text — cursor sometimes leaves its answer in thinking deltas");
    }
    return ui.chip(cost(event));
  }
  // Red, not the housekeeping grey every other note uses: a run that ended in
  // failure is the one note that must not read like "reconnected".
  if (event.type === "done" && event.error) return ui.note(`failed — ${event.error}`, true);
  if (event.type === "failed") return ui.note(`failed — ${event.error}`, true);
}

// ---- connection -------------------------------------------------------------

let retryTimer = null;
let backoff = 1000;
let beat = null;
let missedPong = false;

function stopBeat() {
  if (beat) clearInterval(beat);
  beat = null;
}

function scheduleRetry() {
  if (retryTimer) return;
  retryTimer = setTimeout(() => {
    retryTimer = null;
    connect();
  }, backoff);
  backoff = Math.min(backoff * 2, 15_000);
}

function connect() {
  socket?.close();
  setState("", "connecting…");

  const ws = new WebSocket(BRIDGE);
  socket = ws;
  let opened = false;

  ws.onopen = () => {
    opened = true;
    backoff = 1000;
    setState("up", "connected");
    // A half-open socket after laptop sleep never fires onclose — the tab just
    // stops receiving. A ping nobody answers is the only way to notice, so an
    // unanswered one closes the socket and lets the retry ladder take over.
    missedPong = false;
    stopBeat();
    beat = setInterval(() => {
      if (missedPong) return ws.close();
      missedPong = true;
      ws.send(JSON.stringify({ type: "ping" }));
    }, 20_000);
  };

  ws.onmessage = (event) => {
    // Everything, including messages the conversation drops — this is the log
    // that settles "did the agent actually have the tools".
    ui.raw(`< ${event.data}`);
    const msg = JSON.parse(event.data);
    if (msg.type === "pong") return void (missedPong = false);
    if (msg.type === "tool") return void answer(msg);
    if (msg.type === "hello") {
      // A New pressed while the socket was down is only now reaching the bridge,
      // so this hello describes the session it is about to drop — don't believe
      // its `resumable`.
      const dropping = dropPending;
      if (dropping) dropBridgeSession();
      // What the panel cannot know after a remount.
      resumable = dropping ? false : msg.resumable === true;
      // Including which files exist: they live on the bridge's disk, and this
      // document is torn down and rebuilt on every window switch.
      files = msg.files ?? [];
      drawFiles();
      // Its events are about to start arriving, and they belong to the live
      // transcript — not to whatever archived one is on screen.
      if (msg.running && viewing !== 0) showSession(0);
      setBusy(msg.running === true);
      if (msg.running) ui.note("reconnected — the task that was running is still running");
      return;
    }
    // The bridge answers every attach and every remove with the whole list, so
    // the chips are never drawn from this side's guess about what a click did.
    if (msg.type === "files") {
      files = msg.files ?? [];
      return void drawFiles();
    }
    if (msg.type === "file-failed") return void ui.note(`could not attach — ${msg.error}`, true);
    if (msg.type === "gate") return void showGate(msg);
    if (msg.type === "task-event") {
      // "done" is the child exiting, however it went — including a Stop.
      if (msg.event.type === "done" || msg.event.type === "failed") {
        // The bridge annotates the terminal event rather than sending one of
        // its own, so Reply lights up in the same tick Run does.
        resumable = msg.event.resumable === true;
        setBusy(false);
        setWhere(undefined, msg.event.error ? "fail" : "done");
        // The bridge only denies-and-moves-on after its own 60s timeout, but the
        // task can also end first (Stop, crash) — either way the row must not
        // sit there looking answerable once nothing is listening.
        if (pendingGateId !== null) {
          hideGate();
          ui.note("gate unanswered — the bridge denied it when the task ended");
        }
      }
      return void show(msg.event);
    }
  };

  // A rejected upgrade closes without ever firing onopen, which is what both a
  // stopped bridge and a refused origin look like from here — the browser hides
  // the status line from page script, so the two are told apart by reading
  // .endo-bridge.log, which prints the origin it refused.
  ws.onclose = () => {
    if (ws !== socket) return; // superseded by a newer connect()
    stopBeat();
    setBusy(false);
    setState("down", opened ? "reconnecting…" : "bridge not running");
    if (!opened && backoff === 1000) {
      ui.note("no bridge on 127.0.0.1:8787 — it starts at login, or double-click Endoplexity.vbs. If it IS running, .endo-bridge.log says which origin it refused.");
    }
    scheduleRetry();
  };
}

// The bridge runs one task at a time, so the buttons say which one is possible.
function setBusy(on) {
  runBtn.disabled = on;
  // Never from a history view: the bridge holds one transcript, and it is the
  // live one — replying from an archived session would answer a different
  // conversation than the one on screen.
  replyBtn.disabled = on || !resumable || viewing !== 0;
  stopBtn.disabled = !on;
  // A new session while a task runs would leave the running task journalling
  // into it. Stop first.
  newBtn.disabled = on;
  if (!on) ui.step(null);
}

/** Run is a fresh conversation; Reply continues the last one. */
async function runTask(resume = false) {
  // The console path shares this, so the guard lives here rather than on the
  // button — otherwise endo.task() twice gets an "already running" failure back
  // and that clears the busy state out from under the task still going.
  if (resume ? replyBtn.disabled : runBtn.disabled) {
    // Reply is disabled for three different reasons — say which one applies.
    return ui.note(
      resume && viewing !== 0
        ? "you are reading an earlier session — go back to the current one to reply"
        : resume && !resumable
          ? "nothing to reply to yet"
          : "a task is already running — stop it first",
    );
  }

  // Run always drives the live session, so it takes you back to it first —
  // otherwise the new task's events would render into an archived transcript.
  if (viewing !== 0) showSession(0);

  const typed = promptEl.value.trim();
  // The placeholder is an example task, so falling back to it on a reply would
  // send the agent an answer it never asked for.
  if (resume && !typed) return ui.note("type your answer first");
  const prompt = typed || promptEl.placeholder;

  // Claim the slot before the await below, or a second Run lands in the window
  // where the guard has passed but nothing is disabled yet.
  setBusy(true);
  said = [];

  // A fresh Run drives the tab you are looking at NOW.
  //
  // attach() binds once and nothing ever re-bound it, so a panel left open kept
  // driving whatever tab happened to be active the first time it attached.
  // Measured 2026-08-09: attached to an about:blank tab, the user opened a
  // Greenhouse posting in a different tab and asked to apply, and the agent
  // navigated ITS tab there and filled the form — every call succeeded, every
  // value landed, none of it on the page being watched.
  //
  // Only on a fresh Run: there is no transcript and no refs yet, so re-binding
  // costs nothing. A reply must not — mid-conversation the agent is holding
  // refs, and they belong to the tab it has been looking at all along.
  //
  // `open: false`: re-binding must never CREATE a tab. With nothing drivable
  // open (a fresh window is one chrome://newtab), Run used to open an active
  // about:blank and drop you on it — a black page under a "started debugging
  // this browser" banner — for the whole of the model's first turn. The first
  // tool call opens the tab it needs, and navigates it immediately.
  if (!resume) {
    // The task names the group any tabs this run opens will land in, so three
    // pricing pages read as one piece of work rather than three strays. A reply
    // deliberately keeps the previous name: it is the same piece of work.
    cdp.nameRun(prompt);
    try {
      await cdp.detach();
      await cdp.attach(undefined, { open: false });
    } catch (err) {
      // Not fatal: runTool attaches lazily on the first call, so the task can
      // still run — it just loses the page context below.
      ui.note(`could not attach to the active tab — ${err.message}`);
    }
  }

  // "Apply to THIS job" is unanswerable unless the task says which page this is.
  // Without it the agent asked for a URL instead of acting — it has no way to
  // know a tab is even open. Skipped on a reply: it is already in the
  // transcript, and the agent has been looking at that page ever since.
  const page = resume ? null : await cdp.currentPage().catch(() => null);
  // Unlike the page line, this is NOT skipped on a reply: a tab mentioned in a
  // follow-up is new information, and the transcript cannot already hold it.
  const pointed = mentionBlock(prompt, mentions);
  // Also not skipped on a reply, and for a stronger reason than mentions: a
  // file can be attached DURING a conversation — "here's my cover letter too" —
  // and the transcript cannot already hold a key that did not exist when the
  // run started. It costs one line per file.
  const attached = filesBlock(files);
  // The bridge gets `sent`; the transcript below shows `prompt` alone, so the
  // conversation reads as what the human said rather than as plumbing.
  const sent = [page && `The page you are on is "${page.title}" — ${page.url}`, attached, pointed, prompt]
    .filter(Boolean)
    .join("\n\n");
  // The model rides along, but the bridge overrules it on a reply: a claude
  // transcript cannot be handed to cursor-agent.
  if (!send({ type: "task", prompt: sent, model: modelEl.value, mode: modeEl.value, resume })) {
    return setBusy(false);
  }
  ui.user(prompt);
  setWhere(resume ? undefined : page, "run");
  // Always. It used to be kept on a fresh Run, on the theory that a task is
  // worth re-running — but the task is already the heading of its own answer
  // two lines up, so what the box actually held was a stale copy sitting under
  // a live run, and the next task had to be typed around it.
  promptEl.value = "";
}

// Survives the panel closing, which Chrome does on every window switch.
modelEl.addEventListener("change", () => chrome.storage.local.set({ model: modelEl.value }));
modeEl.addEventListener("change", () => {
  chrome.storage.local.set({ mode: modeEl.value });
  showMode();
});

// The empty state's examples load the box rather than firing straight off — the
// point is to show what a task looks like, and an agent that starts driving the
// browser on a stray click is not a good first impression.
for (const seed of document.querySelectorAll(".seed")) {
  seed.addEventListener("click", () => {
    promptEl.value = seed.textContent.trim();
    promptEl.focus();
  });
}

newBtn.addEventListener("click", () => newSession());
toCurrentBtn.addEventListener("click", () => showSession(0));

// Wrapped, not passed directly — a listener is handed the MouseEvent, which as
// runTask's first argument would make every click a reply.
runBtn.addEventListener("click", () => runTask());
replyBtn.addEventListener("click", () => runTask(true));
stopBtn.addEventListener("click", () => {
  ui.note("stopping");
  send({ type: "stop" });
});

/* ---- attaching a file ------------------------------------------------------
 *
 * The gesture every assistant has and this panel did not: put a file in, and
 * the agent can read it or drop it into a form. Before this, a file reached the
 * agent only by hand-editing .endo-files.json with an absolute Windows path —
 * a config chore standing where a paperclip belongs.
 *
 * The bytes go to the bridge, not the path. A browser <input type="file">
 * hands over a name and a File object and deliberately never a real path, so
 * there is nothing to point `upload` at — the bridge writes its own copy and
 * mints the key. That the copy lands somewhere the bridge owns is the better
 * boundary anyway: `upload` runs DOM.setFileInputFiles in the BROWSER process,
 * which can read anything the user can.
 *
 * The list of files is the bridge's, not this document's. Chrome tears the side
 * panel down on every window switch, so a list kept here would take the chips
 * with it several times an hour; it arrives on every `hello`.
 */

/** Files the agent can reach, as the bridge last reported them. */
let files = [];

/** The one place this document builds a sprite icon rather than writing one in
 *  the HTML — a <use> needs the SVG namespace, and createElement gives an
 *  unknown inline element that renders nothing. Same trap as math.js's mml(). */
function spriteIcon(id) {
  const NS = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(NS, "svg");
  svg.setAttribute("class", "icon");
  svg.setAttribute("aria-hidden", "true");
  const use = document.createElementNS(NS, "use");
  use.setAttribute("href", id);
  svg.appendChild(use);
  return svg;
}

function drawFiles() {
  filesEl.replaceChildren();
  filesEl.classList.toggle("show", files.length > 0);
  for (const file of files) {
    const chip = document.createElement("div");
    // file-chip, not chip: `.chip` is the transcript's cost readout already.
    chip.className = file.fixed ? "file-chip fixed" : "file-chip";
    chip.setAttribute("role", "listitem");
    // The key is what the agent calls this file and the human never types it,
    // so it lives here rather than taking width in a 360px panel.
    chip.title = file.fixed
      ? `the agent calls this "${file.key}" — configured in .endo-files.json, so it is not removable here`
      : `the agent calls this "${file.key}"`;

    const name = document.createElement("span");
    name.className = "name";
    name.textContent = file.name;
    const size = document.createElement("span");
    size.className = "size";
    size.textContent = humanSize(file.size);
    chip.append(name, size);

    if (!file.fixed) {
      const remove = document.createElement("button");
      remove.className = "round";
      remove.title = `Remove ${file.name}`;
      remove.setAttribute("aria-label", `Remove ${file.name}`);
      remove.appendChild(spriteIcon("#i-x"));
      // The bridge deletes its copy and answers with the new list, so the chips
      // are never drawn from a guess about what the removal did.
      remove.addEventListener("click", () => send({ type: "detach-file", key: file.key }));
      chip.appendChild(remove);
    }
    filesEl.appendChild(chip);
  }
}

// Mirrors MAX_ATTACH_BYTES in bridge/src/files.ts. Checked here as well as
// there so a 300MB drop is refused before it is read into the panel's memory
// and base64'd — the bridge is the boundary, this is just not wasting a minute
// to reach it.
const MAX_ATTACH = 25 * 1024 * 1024;

async function attachFiles(list) {
  const picked = [...list];
  if (!picked.length) return;
  attachBtn.disabled = true;
  try {
    // One at a time: base64 is a third bigger than the file, and holding four
    // of those at once to save a few hundred ms on a loopback socket is a poor
    // trade.
    for (const file of picked) {
      if (file.size > MAX_ATTACH) {
        ui.note(`${file.name} is ${humanSize(file.size)} — the limit is ${humanSize(MAX_ATTACH)}`, true);
        continue;
      }
      try {
        const data = toBase64(await file.arrayBuffer());
        if (!send({ type: "attach-file", name: file.name, data })) return;
      } catch (err) {
        // A file that vanished or was never readable (a folder dropped as if it
        // were a file) rejects here rather than at the bridge.
        ui.note(`could not read ${file.name} — ${err.message}`, true);
      }
    }
  } finally {
    attachBtn.disabled = false;
  }
}

attachBtn.addEventListener("click", () => fileInput.click());
fileInput.addEventListener("change", () => {
  attachFiles(fileInput.files);
  // Or picking the same file twice in a row is silent: `change` does not fire
  // when the value has not changed.
  fileInput.value = "";
});

/*
 * Dropping a file. The whole document takes the drop; only the composer lights
 * up, because that is where the result appears.
 *
 * Document-wide is not generosity, it is the fix for a way to lose the panel
 * entirely: the default action for a drop is "open this", so a file landing
 * anywhere unhandled navigates the panel document to file:///… and the whole
 * side panel is gone — transcript, socket and all — until it is reopened. A
 * drop target that covers only the composer leaves every other pixel armed.
 */
const dragHasFiles = (event) => [...(event.dataTransfer?.types ?? [])].includes("Files");

// Counted, not toggled. Moving onto a CHILD element fires `dragleave` on the
// parent, so a plain add/remove pair flickers the highlight the whole way
// across the panel.
let dragDepth = 0;
const undrag = () => {
  dragDepth = 0;
  composerEl.classList.remove("drop");
};

document.addEventListener("dragenter", (event) => {
  if (!dragHasFiles(event)) return;
  dragDepth++;
  composerEl.classList.add("drop");
});
document.addEventListener("dragleave", (event) => {
  if (!dragHasFiles(event)) return;
  // relatedTarget is null exactly when the drag has left the window, which is
  // the one case the counter cannot be trusted to balance — a drag that leaves
  // over the panel's edge can skip a leave and strand the highlight on, with
  // nothing left to switch it off because the drop lands somewhere else.
  if (event.relatedTarget === null || --dragDepth <= 0) undrag();
});
// Without preventDefault on dragover there is no drop target at all: the browser
// takes the default action instead and `drop` never fires.
document.addEventListener("dragover", (event) => {
  if (dragHasFiles(event)) event.preventDefault();
});
document.addEventListener("drop", (event) => {
  if (!dragHasFiles(event)) return;
  event.preventDefault();
  undrag();
  attachFiles(event.dataTransfer.files);
});

// Pasting a file — a screenshot from the clipboard, or a file copied in
// Explorer. On the document, not the textarea: ctrl+V is the first thing you
// press after opening the panel, before you have clicked into anything, and a
// listener on the box would do nothing until you had. Only when there IS a
// file: an ordinary text paste falls straight through to whatever has focus.
document.addEventListener("paste", (event) => {
  const pasted = event.clipboardData?.files;
  if (!pasted?.length) return;
  event.preventDefault();
  attachFiles(pasted);
});

/* ---- @-mentioning a tab ----------------------------------------------------
 *
 * Comet's gesture: type @, pick one of the tabs you have open, and the agent is
 * told about it. Here that means the tab's id reaches the model in the shape
 * `use_tab` takes — which also spends the turn the agent would otherwise burn
 * calling `tabs` just to discover ids.
 *
 * The mentions themselves live in mentions.js; everything below is the menu.
 */

/** Tabs picked in this panel. Never cleared: block() drops any whose text is gone. */
let mentions = [];
/** The tabs currently on offer, in the order they are drawn. */
let offered = [];
/** Index of the `@` being completed, or -1 when the menu is closed. */
let mentionAt = -1;
let mentionPick = 0;
/** Guards against a slower tabs.query landing after a newer one. */
let mentionSeq = 0;

// Only at a word boundary: an email address in a form-filling task is a far
// commoner thing to type than a mention, and `foo@bar` must not open a menu.
// No spaces in the query — otherwise the menu stays open across a whole
// sentence, matching less and less until it looks broken.
const MENTION = /(?:^|\s)@([^\s@]*)$/;

function closeMentions() {
  mentionAt = -1;
  offered = [];
  mentionsEl.classList.remove("show");
  promptEl.setAttribute("aria-expanded", "false");
  promptEl.removeAttribute("aria-activedescendant");
}

function drawMentions() {
  mentionsEl.replaceChildren();
  if (!offered.length) {
    const none = document.createElement("div");
    none.className = "hempty";
    none.textContent = "no other tabs match";
    // replaceChildren just removed the row this pointed at.
    promptEl.removeAttribute("aria-activedescendant");
    return void mentionsEl.appendChild(none);
  }
  offered.forEach((tab, index) => {
    const row = document.createElement("button");
    row.className = index === mentionPick ? "hrow on" : "hrow";
    row.setAttribute("role", "option");
    // The id is what aria-activedescendant points at, so the highlighted row is
    // announced without focus ever leaving the textarea.
    row.id = `mention-${index}`;
    row.setAttribute("aria-selected", String(index === mentionPick));
    const title = document.createElement("span");
    title.className = "htitle";
    title.textContent = tab.title || tab.url;
    const host = document.createElement("span");
    host.className = "hwhen";
    host.textContent = URL.parse(tab.url ?? "")?.hostname ?? "";
    row.append(title, host);
    // mousedown, prevented: a click that first blurs the textarea would close
    // the menu out from under itself and lose the caret the label goes at.
    row.addEventListener("mousedown", (event) => event.preventDefault());
    row.addEventListener("click", () => pickMention(tab));
    mentionsEl.appendChild(row);
  });
  // Set here rather than in moveMention, so opening and arrowing both land it.
  promptEl.setAttribute("aria-activedescendant", `mention-${mentionPick}`);
}

async function openMentions(query, at) {
  const seq = ++mentionSeq;
  const q = query.toLowerCase();
  const open = await cdp.drivable().catch(() => []);
  if (seq !== mentionSeq) return; // a newer keystroke already asked
  mentionAt = at;
  mentionPick = 0;
  offered = open.filter((tab) => !q || `${tab.title ?? ""} ${tab.url ?? ""}`.toLowerCase().includes(q));
  drawMentions();
  mentionsEl.classList.add("show");
  promptEl.setAttribute("aria-expanded", "true");
}

function moveMention(by) {
  if (!offered.length) return;
  mentionPick = (mentionPick + by + offered.length) % offered.length;
  drawMentions();
  mentionsEl.children[mentionPick]?.scrollIntoView({ block: "nearest" });
}

function pickMention(tab) {
  const label = mentionLabel(tab);
  const before = promptEl.value.slice(0, mentionAt);
  const after = promptEl.value.slice(promptEl.selectionStart);
  promptEl.value = `${before}@${label} ${after}`;
  const caret = before.length + label.length + 2;

  // Keyed by id, so mentioning the same tab twice does not send it twice — the
  // second `@label` in the text simply matches the entry already here.
  if (!mentions.some((m) => m.id === tab.id)) {
    mentions.push({ id: tab.id, title: tab.title ?? "", url: tab.url ?? "", label });
  }
  closeMentions();
  promptEl.focus();
  promptEl.setSelectionRange(caret, caret);
}

promptEl.addEventListener("input", () => {
  const found = MENTION.exec(promptEl.value.slice(0, promptEl.selectionStart));
  if (!found) return closeMentions();
  openMentions(found[1], promptEl.selectionStart - found[1].length - 1);
});
// Safe because the rows never take focus: their mousedown is prevented.
promptEl.addEventListener("blur", () => closeMentions());

// Enter starts a fresh task; ctrl/cmd+Enter answers the agent; shift+Enter is a
// newline. Reply used to win the key outright whenever it was live, reasoning
// that the reflex after a question is to type and hit Enter. Measured
// 2026-08-09: Reply stays live forever after any finished task, so the far
// commoner reflex — type the NEXT task, hit Enter — silently resumed the
// previous conversation instead. It voided two cost measurements. The asymmetry
// decides it: a fresh Run is at worst more expensive, a wrong Reply is wrong.
promptEl.addEventListener("keydown", (event) => {
  // The menu gets the keys first, or Enter picks nothing and fires a task with
  // a half-typed `@verc` in it.
  if (mentionAt >= 0) {
    if (event.key === "Escape") return event.preventDefault(), closeMentions();
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      return event.preventDefault(), moveMention(event.key === "ArrowDown" ? 1 : -1);
    }
    if (event.key === "Enter" && !event.shiftKey && offered.length) {
      return event.preventDefault(), pickMention(offered[mentionPick]);
    }
  }
  if (event.key !== "Enter" || event.shiftKey) return;
  const resume = event.ctrlKey || event.metaKey;
  // Only guarded for a fresh run — a ctrl+Enter with nothing to reply to falls
  // through to runTask, which says so rather than swallowing the keystroke.
  if (!resume && runBtn.disabled) return;
  event.preventDefault();
  runTask(resume);
});

const stored = await chrome.storage.local.get(["model", "mode", "sessions"]);
// Only a model the dropdown still offers. Assigning one it does not (`sonnet`,
// from before the ids were spelled out) leaves the <select> on no option at all,
// so every Run would send "" and be refused as an unknown model.
if ([...modelEl.options].some((option) => option.value === stored.model)) modelEl.value = stored.model;
if (stored.mode) modeEl.value = stored.mode;
// The Profile pane was removed with P11a's read_file: the agent reads the real
// resume through the allow-list, so a second copy pasted into the panel was
// personal data kept for nothing. Drop what old installs already stored.
chrome.storage.local.remove("profile");
showMode();

// Before the first note, so the greeting does not land on top of a transcript
// that is being restored. Chrome tears this document down on every window
// switch, so "restore what was here" is the common path, not the rare one.
if (Array.isArray(stored.sessions) && stored.sessions.length) sessions = stored.sessions;
// No greeting note on an empty session: the empty state below the header says
// the same thing with three tasks you can actually click, and the note used to
// hide it on the way past.
if (sessions[0].entries.length) ui.restore(sessions[0].entries.slice());
drawHistory();

connect();
