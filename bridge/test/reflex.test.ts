import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ask,
  clearLog,
  current,
  decide,
  fit,
  initReflexes,
  labelled,
  mark,
  needsLaya,
  newRow,
  record,
  temperature,
  panelState,
  saveSettings,
  stats,
  temper,
  type Provider,
} from "../src/reflex.ts";
import { acted, arrived, drop, gate, pick, see, seeSpent, resetSeeSpent, settled } from "../src/reflexes.ts";
import { setPanel, dropPanel, settle } from "../src/relay.ts";
import { endpoint, layaModel, trainedDir } from "../src/laya.ts";
import { remember } from "../src/page.ts";

// A fake systemone server on a spare port. `reply` decides each answer; every
// request it sees is kept, which is how "nothing left the machine" is asserted.
type Seen = { auth?: string; images?: string; body: any };
let server: Server;
let base = "";
let seen: Seen[] = [];
let reply: (body: any) => { status?: number; json?: unknown; stall?: boolean } = () => ({ status: 500 });

const read = async (req: IncomingMessage) => {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  return JSON.parse(Buffer.concat(chunks).toString("utf8") || "null");
};

// Answers every question with the same probabilities, over its own keys.
const answering = (pick: (keys: string[]) => Record<string, number>) => (body: any) => ({
  json: {
    answers: Object.fromEntries(
      Object.entries(body.questions).map(([id, q]: [string, any]) => [id, { type: "choice", probabilities: pick(Object.keys(q.criteria)) }]),
    ),
  },
});

const home = mkdtempSync(join(tmpdir(), "endo-reflex-"));
const keyFile = join(home, "jev-key");

before(async () => {
  server = createServer(async (req, res) => {
    const body = await read(req);
    seen.push({ auth: req.headers.authorization, images: req.headers["typesafe-danger-zone-images"] as string, body });
    const r = reply(body);
    if (r.stall) return; // never answers: the budget has to end it
    res.writeHead(r.status ?? 200, { "content-type": "application/json" }).end(JSON.stringify(r.json ?? {}));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  process.env.ENDO_JEV_BASE = base;
  process.env.ENDO_JEV_KEY_PATH = keyFile;
  writeFileSync(keyFile, "test-key-123456");
  initReflexes(home);
});

after(() => {
  server.closeAllConnections();
  server.close();
});

beforeEach(() => {
  seen = [];
  drop();
  clearLog();
});

const provider = (budget = 500): Provider => ({ base, key: "k-123456789", model: "m", budget });
const Q = { q: { type: "choice" as const, instructions: "which?", criteria: { a: "A", b: "B" } } };

async function until(ok: () => boolean, what: string) {
  for (let i = 0; i < 200 && !ok(); i++) await new Promise((r) => setTimeout(r, 10));
  assert.ok(ok(), what);
}

// ------------------------------------------------------------ calibration

test("temper softens with T > 1 and sharpens with T < 1, and keeps the argmax", () => {
  const p = { a: 0.8, b: 0.2 };
  assert.ok(temper(p, 2).a < 0.8 && temper(p, 2).a > 0.5);
  assert.ok(temper(p, 0.5).a > 0.8);
  assert.equal(Object.values(temper(p, 3)).reduce((s, v) => s + v, 0).toFixed(9), "1.000000000");
});

test("fit finds a softening temperature for an over-confident backend, and stays at 1 on too little data", () => {
  // Says 0.99 every time and is right 70% of the time: well over-confident.
  const samples = Array.from({ length: 100 }, (_, i) => ({ p: { a: 0.99, b: 0.01 }, truth: i % 10 < 7 ? "a" : "b" }));
  const t = fit(samples);
  assert.ok(t > 1, `expected T > 1, got ${t}`);
  // Calibrated, the top answer should sit near the 70% it actually earns.
  assert.ok(Math.abs(temper({ a: 0.99, b: 0.01 }, t).a - 0.7) < 0.15);
  assert.equal(fit(samples.slice(0, 10)), 1);
});

test("decide acts only above the threshold and the margin", () => {
  assert.deepEqual(decide({ a: 0.9, b: 0.1 }), { choice: "a", p: 0.9 });
  assert.equal(decide({ a: 0.8, b: 0.2 }), null, "under 0.85");
  assert.equal(decide({ a: 0.86, b: 0.7, c: 0 }), null, "margin under 0.2");
  // The temperature is applied before the threshold, not after.
  assert.equal(decide({ a: 0.9, b: 0.1 }, 3), null);
});

// -------------------------------------------------------------- abstain

test("ask returns the probabilities over exactly the asked keys, renormalized, with the bearer key", async () => {
  reply = answering(() => ({ a: 3, b: 1, extra: 9 }));
  const got = await ask(provider(), "state", Q);
  assert.deepEqual(got, { q: { a: 0.75, b: 0.25 } });
  assert.equal(seen[0].auth, "Bearer k-123456789");
  assert.equal(seen[0].body.state, "state");
  assert.deepEqual(Object.keys(seen[0].body.questions), ["q"]);
});

test("ask abstains on an error status, a missing answer, a missing key and a bad number", async () => {
  for (const r of [
    () => ({ status: 500 }),
    () => ({ json: { answers: {} } }),
    answering(() => ({ a: 1 })),
    answering(() => ({ a: Number.NaN, b: 1 })),
    answering(() => ({ a: -1, b: 2 })),
    () => ({ json: "not an object" }),
  ]) {
    reply = r;
    assert.equal(await ask(provider(), "s", Q), null);
  }
});

test("ask abstains when the backend runs over its budget", async () => {
  reply = () => ({ stall: true });
  const t0 = Date.now();
  assert.equal(await ask(provider(150), "s", Q), null);
  assert.ok(Date.now() - t0 < 1_000, "the budget ended it, not the server");
});

test("ask abstains when nothing is listening", async () => {
  assert.equal(await ask({ ...provider(), base: "http://127.0.0.1:9" }, "s", Q), null);
});

// ------------------------------------------------------------- settings

test("settings sanitize: unknown values are defaults, Act unearned is Shadow, Gate may Act at once", () => {
  const s = saveSettings({
    enabled: "yes",
    pick: { state: "act", backend: "lexical" },
    gate: { state: "act", backend: "nonsense" },
    obstacle: { state: "maybe" },
    settle: { state: "act" },
    cookies: "eat them",
  });
  assert.equal(s.enabled, true);
  assert.deepEqual(s.pick, { state: "shadow", backend: "lexical" });
  assert.deepEqual(s.gate, { state: "act", backend: "lexical" });
  assert.equal(s.obstacle.state, "shadow");
  assert.equal(s.settle.state, "shadow");
  assert.equal(s.cookies, "agent");
  assert.equal(s.jevAccepted, false);
});

// ----------------------------------------------------------- Off is off

const page = [
  '@f0e1 [textbox] "Email" = "me@example.com"',
  '@f0e2 [textbox] "Password" = "hunter2"',
  '@f0e3 [button] "Submit application"',
  '@f0e4 [link] "Privacy policy"',
].join("\n");
const hits = [
  { ref: "@f0e3", line: '@f0e3 [button] "Submit application"', p: 0.7 },
  { ref: "@f0e4", line: '@f0e4 [link] "Privacy policy"', p: 0.1 },
];

async function driveEveryHook() {
  remember(page);
  await pick("submit button", hits);
  await gate("@f0e3", '[button] "Submit application"', false);
  await arrived(page, () => true, async () => null);
  await new Promise((r) => setTimeout(r, 100));
}

test("with everything Off, no reflex sends a request and no sidecar is wanted", async () => {
  reply = answering((k) => Object.fromEntries(k.map((x, i) => [x, i === 0 ? 1 : 0])));
  const on = { state: "shadow", backend: "jev" };
  for (const off of [
    { enabled: false, pick: on, gate: on, obstacle: on, jevAccepted: true },
    { enabled: true, pick: { state: "off", backend: "jev" }, gate: { state: "off", backend: "jev" }, obstacle: { state: "off", backend: "jev" }, jevAccepted: true },
  ]) {
    saveSettings(off);
    await driveEveryHook();
    assert.equal(seen.length, 0, `requests left with ${JSON.stringify(off)}`);
    assert.equal(panelState().log.rows, 0);
  }
  saveSettings({ enabled: false, pick: { state: "shadow", backend: "laya" } });
  assert.equal(needsLaya(), false);
  assert.equal(endpoint(), null);
  assert.equal(existsSync(join(home, "laya.pid")), false);
});

test("Jev sends nothing until the disclosure is accepted, even with a key and Shadow on", async () => {
  reply = answering((k) => Object.fromEntries(k.map((x, i) => [x, i === 0 ? 1 : 0])));
  const on = { state: "shadow", backend: "jev" };
  saveSettings({ pick: on, gate: on, obstacle: on, jevAccepted: false });
  await driveEveryHook();
  assert.equal(seen.length, 0);
  // The positive control: the same drive with the disclosure accepted does ask,
  // so the zero above is the switch, not a hook that never fires.
  saveSettings({ pick: on, gate: on, obstacle: on, jevAccepted: true });
  await driveEveryHook();
  await until(() => seen.length === 3, `expected 3 requests, saw ${seen.length}`);
});

test("what is sent carries no field value, query string or ref", async () => {
  reply = answering((k) => Object.fromEntries(k.map((x) => [x, 1])));
  const on = { state: "shadow", backend: "jev" };
  saveSettings({ pick: on, gate: on, obstacle: on, jevAccepted: true });
  await driveEveryHook();
  await until(() => seen.length === 3, "three requests");
  const sent = JSON.stringify(seen.map((s) => s.body));
  for (const secret of ["hunter2", "me@example.com", "@f0e"]) assert.ok(!sent.includes(secret), `${secret} was sent`);
});

// --------------------------------------------------------------- truth

test("Pick's truth is the ref the model acts on next, and it is counted per backend", async () => {
  reply = answering((k) => Object.fromEntries(k.map((x) => [x, x === "o2" ? 0.9 : 0.01])));
  saveSettings({ pick: { state: "shadow", backend: "jev" }, jevAccepted: true });
  await pick("submit button", hits);
  acted("@f0e3");
  await until(() => panelState().log.rows === 1, "the row is logged");
  // Lexical ranked @f0e3 first and was right; the fake Jev said o2 and was not.
  assert.deepEqual(stats().pick, { lexical: { agreed: 1, of: 1 }, jev: { agreed: 0, of: 1 } });
});

test("a ref the Pick row never offered leaves it open, and drop() discards it", async () => {
  saveSettings({});
  await pick("submit button", hits);
  acted("@f0e99");
  drop();
  acted("@f0e3");
  await until(() => panelState().log.rows === 1, "logged");
  assert.deepEqual(stats().pick, {});
});

test("Obstacle's truth comes from the next control acted on", async () => {
  saveSettings({});
  remember('@f0e7 [button] "Accept all cookies"\n@f0e8 [link] "Jobs"');
  await arrived('@f0e7 [button] "Accept all cookies"\n[heading] "We use cookies"', () => true, async () => null);
  acted("@f0e7");
  await until(() => stats().obstacle.lexical?.of === 1, "counted");
  assert.deepEqual(stats().obstacle.lexical, { agreed: 1, of: 1 });
});

test("a mark only counts for an option the row asked about, and survives a restart", async () => {
  reply = answering((k) => Object.fromEntries(k.map((x) => [x, x === "a" ? 0.95 : 0.05])));
  saveSettings({ gate: { state: "shadow", backend: "jev" }, jevAccepted: true });
  remember('@f0e5 [button] "Finish"');
  await gate("@f0e5", '[button] "Finish"', false);
  await until(() => panelState().review.length === 1, "it is up for review: Jev would ask, the regex did not");
  const [row] = panelState().review;
  assert.equal(row.answer, "a");
  // What to mark is the click, not the page it was on: the state lists the URL first.
  assert.equal(row.what, 'Action: click [button] "Finish"');
  assert.equal(mark(row.id, "maybe"), false);
  assert.equal(mark("nope", "a"), false);
  assert.equal(mark(row.id, "a"), true);
  initReflexes(home);
  assert.deepEqual(stats().gate.jev, { agreed: 1, of: 1 });
  assert.equal(panelState().review.length, 0);
});

test("Gate in Act adds a prompt the regex missed, never for one it already asks, and abstains on silence", async () => {
  reply = answering((k) => Object.fromEntries(k.map((x) => [x, x === "a" ? 0.97 : 0.03])));
  saveSettings({ gate: { state: "act", backend: "jev" }, jevAccepted: true });
  remember('@f0e5 [button] "Finish"');
  assert.match((await gate("@f0e5", '[button] "Finish"', false)) ?? "", /Gate reflex \(jev, p=0\.97\)/);
  const asked = seen.length;
  assert.equal(await gate("@f0e3", '[button] "Submit application"', true), null);
  await until(() => seen.length === asked + 1, "the click the regex gates is still logged in the background");
  reply = () => ({ stall: true });
  assert.equal(await gate("@f0e5", '[button] "Finish"', false), null, "over budget: abstain, the regex stands");
});

// -------------------------------------------------------------- Settle

test("Settle rows are validated and counted against their own truth", async () => {
  saveSettings({});
  settled({ settledAt: 120, changedAfter: false, waited: 300 });
  settled({ settledAt: 150, changedAfter: true, waited: 300 });
  settled({ settledAt: null, changedAfter: false, waited: 300 });
  for (const bad of [null, "x", { settledAt: -1, changedAfter: false, waited: 300 }, { settledAt: 5, changedAfter: "no", waited: 300 }]) settled(bad);
  assert.equal(panelState().log.rows, 3);
  assert.deepEqual(stats().settle.cdp, { agreed: 1, of: 2 });
  saveSettings({ settle: { state: "off" } });
  settled({ settledAt: 120, changedAfter: false, waited: 300 });
  assert.equal(panelState().log.rows, 3);
});

test("clearing the log deletes the file", () => {
  saveSettings({});
  settled({ settledAt: 1, changedAfter: false, waited: 300 });
  assert.equal(existsSync(join(home, "reflex-log.jsonl")), true);
  clearLog();
  assert.equal(existsSync(join(home, "reflex-log.jsonl")), false);
  assert.equal(readFileSync(keyFile, "utf8"), "test-key-123456", "the key is untouched");
});

// ------------------------------------------------------------------- See

// A panel that answers See's two calls (and the tab list), keeping each call.
const SHOT = { data: "SCREENSHOT-BYTES", width: 1280, height: 800, viewport: { width: 1280, height: 800 } };
async function withPanel(shot: object, run: (calls: { name: string; args: any }[]) => Promise<void>) {
  const calls: { name: string; args: any }[] = [];
  const panel = {
    readyState: 1,
    send(raw: string) {
      const m = JSON.parse(raw);
      if (m.type !== "tool") return;
      calls.push({ name: m.name, args: m.args });
      setImmediate(() => {
        const value =
          m.name === "screenshot" ? JSON.stringify(shot) : m.name === "point" ? "@p1" : '* id 7 — "Sketch" http://127.0.0.1:8787/fixtures/canvas.html';
        settle({ id: m.id, ok: true, value });
      });
    },
  };
  setPanel(panel as never);
  try {
    await run(calls);
  } finally {
    dropPanel(panel as never);
  }
}
const boxed = (present: number, box = { top: 0.2, bottom: 0.4, left: 0.1, right: 0.3 }) => () => ({
  json: { answers: { present: { type: "noul", noul: present }, where: { type: "box", box, confidence: 0.9 } }, usage: { input_tokens: 4800 } },
});

test("See Off takes no screenshot and sends nothing, with Jev ready", async () => {
  reply = boxed(0.99);
  saveSettings({ jevAccepted: true });
  await withPanel(SHOT, async (calls) => {
    assert.equal(await see("the red circle"), null);
    assert.deepEqual(calls.map((c) => c.name), [], "no screenshot asked of the panel");
  });
  assert.equal(seen.length, 0);
});

test("See On: a confident box becomes a point ref at its centre; the image goes to Jev and nowhere else", async () => {
  reply = boxed(0.97);
  resetSeeSpent();
  saveSettings({ see: { state: "act" }, jevAccepted: true });
  await withPanel(SHOT, async (calls) => {
    const line = await see("the red circle");
    assert.equal(line, '@p1 [point] "the red circle" at 256,240 (See, from a screenshot: p=0.97)');
    const point = calls.find((c) => c.name === "point")!;
    assert.deepEqual(point.args, { x: 256, y: 240, query: "the red circle" }, "the box's centre, in viewport px");
  });
  assert.equal(seen.length, 1);
  const [req] = seen;
  assert.equal(req.images, "true", "TypeSafe's image opt-in header");
  assert.equal(req.body.model, "jev-1.14.0", "the moving aliases take no box");
  assert.equal(req.body.assets[req.body.state.screen].data_base64, "SCREENSHOT-BYTES");
  assert.ok(seeSpent() > 0, "the run's Jev cost is counted");
  // The truth is the model clicking it.
  acted("@p1");
  assert.deepEqual(stats().see.jev, { agreed: 1, of: 1 });
  assert.ok(!readFileSync(join(home, "reflex-log.jsonl"), "utf8").includes("SCREENSHOT-BYTES"), "an image is never logged");
});

test("See abstains on a weak presence, an inside-out box, and a screenshot Jev cannot take", async () => {
  saveSettings({ see: { state: "act" }, jevAccepted: true });
  for (const r of [boxed(0.4), boxed(0.99, { top: 0.5, bottom: 0.2, left: 0.1, right: 0.3 })]) {
    reply = r;
    await withPanel(SHOT, async (calls) => {
      assert.equal(await see("the red circle"), null);
      assert.ok(!calls.some((c) => c.name === "point"), "no point minted on an abstention");
    });
  }
  seen = [];
  reply = boxed(0.99);
  await withPanel({ ...SHOT, width: 3000 }, async () => assert.equal(await see("the red circle"), null));
  assert.equal(seen.length, 0, "an image outside 256 to 1568 px is not sent");
});

test("a Vercel AI Gateway key reaches Jev under the gateway's model ids", async () => {
  writeFileSync(keyFile, "vck_test-key-123456");
  try {
    reply = boxed(0.97);
    saveSettings({ see: { state: "act" }, pick: { state: "shadow", backend: "jev" }, jevAccepted: true });
    await withPanel(SHOT, async () => void (await see("the red circle")));
    assert.equal(seen.at(-1)!.body.model, "typesafe-ai/jev-1.14.0");
    assert.equal(seen.at(-1)!.auth, "Bearer vck_test-key-123456");
  } finally {
    writeFileSync(keyFile, "test-key-123456");
  }
});

// --------------------------------------------------------------- training

test("the training corpus is only rows with a truth the row asked about", async () => {
  reply = answering((k) => Object.fromEntries(k.map((x) => [x, x === "o2" ? 0.9 : 0.01])));
  saveSettings({ pick: { state: "shadow", backend: "jev" }, jevAccepted: true });
  remember("@f0e1 [button] \"Save\"\n@f0e2 [button] \"Submit\"");
  pick("submit", [
    { ref: "@f0e1", line: '@f0e1 [button] "Save"', p: 0.3 },
    { ref: "@f0e2", line: '@f0e2 [button] "Submit"', p: 0.6 },
  ]);
  pick("save", [{ ref: "@f0e1", line: '@f0e1 [button] "Save"', p: 0.9 }]);
  // Logged, not just asked: a row joins the log when its answer arrives.
  await until(() => panelState().log.rows === 2, "two Pick rows logged");
  acted("@f0e2"); // the first row's o2; the second row never offered it
  const rows = labelled();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].truth, "o2");
});

test("Laya serves the user's fine-tune once one was kept, and the base otherwise", () => {
  const was = process.env.ENDO_HOME;
  process.env.ENDO_HOME = mkdtempSync(join(tmpdir(), "endo-laya-"));
  try {
    assert.equal(layaModel(), "multilingual");
    mkdirSync(trainedDir(), { recursive: true });
    writeFileSync(join(trainedDir(), "rl_agent_config.json"), "{}");
    assert.equal(layaModel(), "endo");
  } finally {
    if (was === undefined) delete process.env.ENDO_HOME;
    else process.env.ENDO_HOME = was;
  }
});

test("a key Jev refuses (no credit) says so in the panel, and a later answer clears it", async () => {
  saveSettings({ pick: { state: "shadow", backend: "jev" }, jevAccepted: true });
  reply = () => ({ status: 403, json: { error: { message: "Free tier users do not have access to this model." } } });
  assert.equal(await ask(provider(), "s", Q), null);
  // provider() in this file is a stand-in on the same base as the real one.
  assert.match(panelState().backends.jev.note, /refused it \(403\)/);
  reply = answering((k) => Object.fromEntries(k.map((x) => [x, 1])));
  assert.ok(await ask(provider(), "s", Q));
  assert.equal(panelState().backends.jev.note, "key saved");
});

// ------------------------------------------------------- review fixes

test("Obstacle's cookie click goes through the caller's gated click, and a refusal abstains", async () => {
  for (let i = 0; i < 60; i++) record(newRow("obstacle", "s", { question: Q.q, answers: { jev: { choice: "cookie" } }, truth: "cookie" }));
  reply = answering((k) => Object.fromEntries(k.map((x) => [x, x === "cookie" ? 0.97 : 0.01])));
  saveSettings({ cookies: "reject", obstacle: { state: "act", backend: "jev" }, jevAccepted: true });
  const banner = '@f0e1 [button] "Reject all cookies"\n[heading] "We use cookies"';
  remember(banner);
  const clicked: string[] = [];
  await withPanel({}, async () => {
    const out = await arrived(banner, () => true, async (ref) => (clicked.push(ref), "NEXT PAGE"));
    assert.deepEqual(clicked, ["@f0e1"]);
    assert.match(out?.text ?? "", /NEXT PAGE/);
    assert.equal(await arrived(banner, () => true, async () => null), null);
  });
});

test("calibration only softens: one-class labels never sharpen an abstaining answer", () => {
  const samples = Array.from({ length: 30 }, () => ({ p: { a: 0.55, b: 0.3 }, truth: "a" }));
  assert.equal(fit(samples), 1);
  assert.equal(decide({ a: 0.55, b: 0.3 }, fit(samples)), null);
});

test("clearing the log turns Act back to Shadow, and Laya rows count only for the served model", () => {
  const row = (model: string) =>
    record(newRow("obstacle", "s", { question: Q.q, answers: { laya: { choice: "a", p: { a: 0.9, b: 0.1 }, model } }, truth: "a" }));
  const was = process.env.ENDO_HOME;
  process.env.ENDO_HOME = mkdtempSync(join(tmpdir(), "endo-laya-"));
  try {
    mkdirSync(trainedDir(), { recursive: true });
    writeFileSync(join(trainedDir(), "rl_agent_config.json"), "{}"); // served model is now "endo"
    saveSettings({});
    for (let i = 0; i < 60; i++) row("multilingual");
    assert.equal(stats().obstacle.laya, undefined, "rows from the other model are not evidence");
    for (let i = 0; i < 60; i++) row("endo");
    assert.equal(stats().obstacle.laya?.of, 60);
    // lexical earns Act on the same rows; clearing must revoke it at once.
    for (let i = 0; i < 60; i++) record(newRow("obstacle", "s", { question: Q.q, answers: { lexical: { choice: "a" } }, truth: "a" }));
    saveSettings({ obstacle: { state: "act", backend: "lexical" } });
    assert.equal(current()?.obstacle.state, "act");
    clearLog();
    assert.equal(current()?.obstacle.state, "shadow");
  } finally {
    if (was === undefined) delete process.env.ENDO_HOME;
    else process.env.ENDO_HOME = was;
  }
});

test("temperature fits on the served model's rows only", () => {
  const was = process.env.ENDO_HOME;
  process.env.ENDO_HOME = mkdtempSync(join(tmpdir(), "endo-laya-"));
  try {
    saveSettings({});
    const p = { a: 0.7, b: 0.3 };
    // Served model (untagged rows are the base) is always right: T stays 1. The other model's wrong rows would soften it.
    for (let i = 0; i < 30; i++) record(newRow("obstacle", "s", { answers: { laya: { choice: "a", p } }, truth: "a" }));
    for (let i = 0; i < 30; i++) record(newRow("obstacle", "s", { answers: { laya: { choice: "a", p, model: "endo" } }, truth: "b" }));
    assert.equal(temperature("laya", "obstacle"), 1);
  } finally {
    if (was === undefined) delete process.env.ENDO_HOME;
    else process.env.ENDO_HOME = was;
  }
});

test("a log write that fails never throws out of the caller", () => {
  saveSettings({});
  const path = join(home, "reflex-log.jsonl");
  rmSync(path, { force: true });
  mkdirSync(path); // appending to a directory fails
  try {
    assert.doesNotThrow(() => settled({ settledAt: 1, changedAfter: false, waited: 300 }));
  } finally {
    rmSync(path, { recursive: true });
  }
});

test("a foreign reflex name in the log is dropped, not fatal at startup", () => {
  const good = JSON.stringify(newRow("settle", "s", { answers: { cdp: { choice: "a" } }, truth: "a" }));
  const bad = JSON.stringify({ id: "rx", at: 1, reflex: "toString", state: "s", answers: { x: { choice: "a" } }, truth: "a" });
  writeFileSync(join(home, "reflex-log.jsonl"), `${bad}\n${good}\n`);
  assert.doesNotThrow(() => initReflexes(home));
  assert.equal(panelState().log.rows, 1);
});
