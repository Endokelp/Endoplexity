import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ask,
  clearLog,
  decide,
  fit,
  initReflexes,
  mark,
  needsLaya,
  panelState,
  saveSettings,
  stats,
  temper,
  type Provider,
} from "../src/reflex.ts";
import { acted, arrived, drop, gate, pick, settled } from "../src/reflexes.ts";
import { endpoint } from "../src/laya.ts";
import { remember } from "../src/page.ts";

// A fake systemone server on a spare port. `reply` decides each answer; every
// request it sees is kept, which is how "nothing left the machine" is asserted.
type Seen = { auth?: string; body: any };
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
    seen.push({ auth: req.headers.authorization, body });
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
  await arrived(page, () => true);
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
  await arrived('@f0e7 [button] "Accept all cookies"\n[heading] "We use cookies"', () => true);
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
