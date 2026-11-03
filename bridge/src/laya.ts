/**
 * Laya, the local decision model, as a sidecar the bridge starts only when a
 * reflex is set to use it. Nothing here runs, listens or downloads otherwise.
 *
 * laya-serve binds 0.0.0.0 with no authentication by default, which would put
 * an endpoint that reads page text on the network. So it is only ever started
 * bound to 127.0.0.1 with a random key in its environment, and the boot checks
 * both took: a request without the key must get 401, and the port must not be
 * reachable on the machine's LAN address. Either failing stops the sidecar and
 * Laya stays unavailable (measured honoured by the pinned 0.4.21 in the
 * Phase 16 spike; the check is what catches a later version that is not).
 */

import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { connect, createServer } from "node:net";
import { homedir, networkInterfaces } from "node:os";
import { join } from "node:path";

export const LAYA_VERSION = "0.4.21";
// multilingual (mmBERT-base, 322M) over english (ModernBERT-large, 421M): about
// twice as fast on this laptop's CPU in the spike (Gate 0.43 s against 0.95 s),
// and 1,024 tokens of context instead of 512.
const BASE = "multilingual";
export const REPO = "convaiinnovations/laya-multilingual";
// The Act budget. Shadow is not blocked on an answer and uses its own (reflex.ts).
// ponytail: set from the Phase 16 spike; GPU and CPU differ by an order of
// magnitude, so a machine without CUDA mostly abstains in Act. Measure there.
const BUDGET_MS = 250;
const BOOT_MS = 180_000;

const home = () => process.env.ENDO_HOME ?? join(homedir(), ".endo");
const venv = () => join(home(), "laya");
const python = () => join(venv(), process.platform === "win32" ? "Scripts\\python.exe" : "bin/python");
const pidFile = () => join(home(), "laya.pid");
// What `npm run reflex:train` keeps when held-out agreement rose: this user's
// own fine-tune of BASE, served under its own name in place of it.
export const trainedDir = () => join(home(), "laya-trained");
const TRAINED = "endo";
/** The checkpoint the sidecar serves: the user's fine-tune when one was kept. */
export const layaModel = () => (existsSync(join(trainedDir(), "rl_agent_config.json")) ? TRAINED : BASE);

export type Endpoint = { base: string; key: string; model: string; budget: number };

let child: ChildProcess | null = null;
let booting: Promise<Endpoint | null> | null = null;
let ready: Endpoint | null = null;
let note = "";

export const installed = () => existsSync(python()) && existsSync(join(venv(), ".endo-laya"));

export function status(): { ready: boolean; note: string } {
  if (!installed()) return { ready: false, note: "not installed: run npm run laya-setup" };
  // `ready` is "can be chosen": choosing it is what starts it.
  return { ready: true, note: ready ? "running" : booting ? "starting" : note || "starts when a reflex uses it" };
}

/** Where to ask Laya, or null while it is not up. reflex.ts abstains on null. */
export const endpoint = (): Endpoint | null => ready;

/** Start the sidecar if it is not running. Idempotent; resolves null on any failure. */
export function startLaya(): Promise<Endpoint | null> {
  if (booting) return booting;
  if (!installed()) return Promise.resolve(null);
  booting = boot().catch((err: Error) => {
    stopLaya();
    note = `failed: ${err.message}`;
    console.warn(`laya: ${note}`);
    return null;
  });
  return booting;
}

export function stopLaya(): void {
  child?.kill();
  child = null;
  ready = null;
  booting = null;
  try {
    unlinkSync(pidFile());
  } catch {}
}

async function boot(): Promise<Endpoint> {
  killStale();
  const port = await sparePort();
  const key = randomBytes(24).toString("hex");
  const model = layaModel();
  // python -c, so the pid file names a python, which is what killStale checks
  // for. On Windows the venv's python.exe is a launcher with the real
  // interpreter as its child; killing the launcher took the server down with
  // it (measured in the spike), so one kill is enough.
  const proc = spawn(python(), ["-c", "from laya.serve import main; main()"], {
    env: {
      ...process.env,
      LAYA_HOST: "127.0.0.1",
      LAYA_PORT: String(port),
      LAYA_API_KEY: key,
      // The reviewed Hugging Face commit laya pins for each checkpoint.
      LAYA_REVISION: "reviewed",
      LAYA_MODELS: model,
      LAYA_DEFAULT_MODEL: model,
      ...(model === TRAINED && { LAYA_EXTRA_MODELS: JSON.stringify({ [TRAINED]: trainedDir() }) }),
      LAYA_LOG_LEVEL: "warning",
      HF_HUB_DISABLE_TELEMETRY: "1",
    },
    // stderr must be read: a pipe nobody drains blocks the child once it fills,
    // and Hugging Face's progress bars fill it on the first download.
    stdio: ["ignore", "ignore", "pipe"],
    windowsHide: true,
  });
  child = proc;
  let tail = "";
  proc.stderr!.on("data", (d: Buffer) => void (tail = (tail + d.toString()).slice(-400)));
  proc.on("exit", (code) => {
    if (child !== proc) return;
    child = null;
    ready = null;
    booting = null;
    note = `exited (${code}): ${tail.trim().split("\n").pop() ?? ""}`;
  });
  writeFileSync(pidFile(), String(proc.pid));

  const base = `http://127.0.0.1:${port}`;
  const auth = { authorization: `Bearer ${key}` };
  const deadline = Date.now() + BOOT_MS;
  for (;;) {
    if (child !== proc) throw new Error(note || "laya-serve exited during startup");
    const health = await fetch(`${base}/health`, { headers: auth, signal: AbortSignal.timeout(2_000) })
      .then((r) => (r.ok ? r.json() : null))
      .catch(() => null);
    if (Array.isArray(health?.loaded) && health.loaded.includes(model)) break;
    if (Date.now() > deadline) throw new Error(`not ready after ${BOOT_MS / 1000}s`);
    await new Promise((r) => setTimeout(r, 1_000));
  }

  const open = await fetch(`${base}/v1/systemone`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  }).then((r) => r.status, () => 0);
  if (open !== 401) throw new Error(`laya-serve answered a request without its key (${open})`);
  if (await reachableOffLoopback(port)) throw new Error("laya-serve is reachable off loopback");

  // The first inference pays CUDA's warm-up, about 2 s on the first live run
  // against 0.1 to 0.2 s after, so the first decision of every session would
  // abstain in Act. Paid here instead, before anything is asked for real.
  await fetch(`${base}/v1/systemone`, {
    method: "POST",
    headers: { "content-type": "application/json", ...auth },
    body: JSON.stringify({ model, state: "warm-up", questions: { q: { type: "choice", instructions: "Warm up?", criteria: { a: "Yes", b: "No" } } } }),
  }).catch(() => {});

  note = "";
  ready = { base, key, model, budget: BUDGET_MS };
  console.log(`laya: ready on ${base} (${model})`);
  return ready;
}

const sparePort = () =>
  new Promise<number>((resolve, reject) => {
    const s = createServer();
    s.once("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const { port } = s.address() as { port: number };
      s.close(() => resolve(port));
    });
  });

/** Can the port be reached on this machine's first LAN address? false with no LAN. */
function reachableOffLoopback(port: number): Promise<boolean> {
  const lan = Object.values(networkInterfaces())
    .flat()
    .find((i) => i && i.family === "IPv4" && !i.internal)?.address;
  if (!lan) return Promise.resolve(false);
  return new Promise((resolve) => {
    const sock = connect({ host: lan, port, timeout: 500 });
    const done = (hit: boolean) => {
      sock.destroy();
      resolve(hit);
    };
    sock.once("connect", () => done(true));
    sock.once("error", () => done(false));
    sock.once("timeout", () => done(false));
  });
}

/**
 * A bridge killed without an exit handler leaves its sidecar holding a port and
 * a gigabyte or more of memory. The pid file names it; it is only killed if the
 * process under that pid is still a python, because pids get reused.
 */
function killStale(): void {
  let pid: number;
  try {
    pid = Number(readFileSync(pidFile(), "utf8"));
  } catch {
    return;
  }
  if (!Number.isInteger(pid) || pid <= 0) return;
  try {
    const name =
      process.platform === "win32"
        ? execFileSync("tasklist", ["/FI", `PID eq ${pid}`, "/FO", "CSV", "/NH"], { encoding: "utf8" })
        : execFileSync("ps", ["-p", String(pid), "-o", "comm="], { encoding: "utf8" });
    if (/python/i.test(name)) process.kill(pid);
  } catch {}
  try {
    unlinkSync(pidFile());
  } catch {}
}

process.on("exit", () => child?.kill());
