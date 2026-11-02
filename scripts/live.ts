/**
 * The side panel, driven from a terminal.
 *
 * Every "owed, needs the side panel" line since Phase 9 waited on a person to
 * reload an extension at chrome://extensions and paste a call into a console,
 * and most of them waited for weeks. Chrome for Testing still honours
 * --load-extension (branded Chrome dropped it in 137), so this starts one with
 * the extension read from disk, which also means it can never be a stale build.
 * It opens panel.html as a tab beside a drivable one and evaluates in it over
 * CDP; the panel connects to the bridge on 8787 like the real one does.
 *
 *   node scripts/live.ts launch [extensionDir]   start it, return once the panel says connected
 *   node scripts/live.ts eval "<js>"             run in the panel (awaited), print the result as JSON
 *   node scripts/live.ts page "<js>"             the same in the driven tab
 *   node scripts/live.ts approve                 click Approve on every gate until killed, logging each
 *   node scripts/live.ts shot <file.png>         screenshot the panel tab
 *   node scripts/live.ts close
 *
 * What it does not test: Chrome's own frame around a side panel (the toolbar
 * icon, the panel's real width, the teardown on a window switch). A panel in a
 * tab is the same document and code, not the same container.
 */
import { spawn } from "node:child_process";
import { readdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocket } from "ws";

const REPO = fileURLToPath(new URL("../", import.meta.url));
const { ALLOWED_ORIGIN } = await import(new URL("../bridge/src/auth.ts", import.meta.url).href);
const DEV = `http://127.0.0.1:${process.env.ENDO_LIVE_PORT ?? 9333}`;
const PANEL = `${ALLOWED_ORIGIN}/panel.html`;

function chrome(): string {
  if (process.env.ENDO_CHROME) return process.env.ENDO_CHROME;
  const root = join(homedir(), ".cache", "puppeteer", "chrome");
  const newest = readdirSync(root).filter((d) => d.startsWith("win64-")).sort().pop();
  if (!newest) throw new Error(`no Chrome for Testing under ${root}: npx @puppeteer/browsers install chrome@stable, or set ENDO_CHROME`);
  return join(root, newest, "chrome-win64", "chrome.exe");
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until<T>(probe: () => Promise<T>, what: string, ms = 20_000): Promise<T> {
  for (const t0 = Date.now(); Date.now() - t0 < ms; await sleep(250)) {
    try {
      const v = await probe();
      if (v) return v;
    } catch {}
  }
  throw new Error(`timed out waiting for ${what}`);
}

type Target = { id: string; type: string; url: string; webSocketDebuggerUrl: string };
const targets = async (): Promise<Target[]> => (await fetch(`${DEV}/json/list`)).json();

/** One CDP session on a target, for as many calls as the caller makes. */
async function session(url: string) {
  const ws = new WebSocket(url, { perMessageDeflate: false });
  await new Promise((ok, fail) => (ws.once("open", ok), ws.once("error", fail)));
  let seq = 0;
  const waiting = new Map<number, (m: any) => void>();
  ws.on("message", (raw) => {
    const m = JSON.parse(String(raw));
    waiting.get(m.id)?.(m);
    waiting.delete(m.id);
  });
  const send = (method: string, params: Record<string, unknown> = {}): Promise<any> =>
    new Promise((ok, fail) => {
      const id = ++seq;
      waiting.set(id, (m) => (m.error ? fail(new Error(m.error.message)) : ok(m.result)));
      ws.send(JSON.stringify({ id, method, params }));
    });
  return { send, close: () => ws.close() };
}

async function panel() {
  const t = (await targets()).find((x) => x.type === "page" && x.url.startsWith(PANEL));
  if (!t) throw new Error("no panel tab — run: node scripts/live.ts launch");
  return session(t.webSocketDebuggerUrl);
}

async function evaluate(s: Awaited<ReturnType<typeof panel>>, expression: string) {
  const r = await s.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
  return r.result.value;
}

const [cmd, arg] = process.argv.slice(2);

if (cmd === "launch") {
  try {
    await (await session((await (await fetch(`${DEV}/json/version`)).json()).webSocketDebuggerUrl)).send("Browser.close");
    await sleep(1000);
  } catch {}
  // A new profile every launch: Browser.close returns before Chrome lets go of
  // the old one, and reusing it raced into EPERM. The old ones are swept here.
  for (const old of readdirSync(tmpdir()).filter((d) => d.startsWith("endo-live-"))) {
    try {
      rmSync(join(tmpdir(), old), { recursive: true, force: true });
    } catch {}
  }
  const profile = join(tmpdir(), `endo-live-${Date.now()}`);
  const ext = resolve(arg ?? join(REPO, "extension"));
  const child = spawn(
    chrome(),
    [
      `--user-data-dir=${profile}`,
      `--remote-debugging-port=${new URL(DEV).port}`,
      `--load-extension=${ext}`,
      `--disable-extensions-except=${ext}`,
      "--no-first-run",
      "--no-default-browser-check",
      // The panel tab sits in the background while the driven tab is in front:
      // without these its timers (Settle's quiet window, the ping) are throttled.
      "--disable-background-timer-throttling",
      "--disable-renderer-backgrounding",
      "--disable-backgrounding-occluded-windows",
      // Windows marks a covered window occluded, the page goes `hidden`, it
      // stops producing frames, and every Input.dispatchMouseEvent then waits
      // ~5s for one (measured). A hover self-test hung on exactly that.
      "--disable-features=CalculateNativeWinOcclusion",
      "--window-size=1280,900",
      "http://127.0.0.1:8787/fixtures/host.html",
    ],
    { detached: true, stdio: "ignore" },
  );
  child.unref();
  await until(() => fetch(`${DEV}/json/version`).then((r) => r.ok), "Chrome for Testing");
  await fetch(`${DEV}/json/new?${PANEL}`, { method: "PUT" });
  const s = await until(() => panel(), "the panel tab");
  await until(async () => (await evaluate(s, `document.getElementById("status").textContent`)) === "connected", "the panel to connect to the bridge");
  s.close();
  // The page the agent drives goes in front, as it would be for a person.
  const page = (await targets()).find((x) => x.type === "page" && /^https?:/.test(x.url));
  if (page) await fetch(`${DEV}/json/activate/${page.id}`);
  console.log(`connected: ${ext}`);
} else if (cmd === "eval") {
  const s = await panel();
  console.log(JSON.stringify(await evaluate(s, arg ?? "null"), null, 2));
  s.close();
} else if (cmd === "page") {
  // The driven tab, for what a check has to arrange on the page itself (a
  // fixture's relabel flag). A second CDP client beside the extension's.
  const t = (await targets()).find((x) => x.type === "page" && /^(https?|file):/.test(x.url));
  if (!t) throw new Error("no drivable tab");
  const s = await session(t.webSocketDebuggerUrl);
  console.log(JSON.stringify(await evaluate(s, arg ?? "location.href"), null, 2));
  s.close();
} else if (cmd === "approve") {
  // Stands in for the person clicking Approve, so a gated step is still asked
  // and the ask is still logged: the evidence is the line printed here.
  const s = await panel();
  const click = `(() => {
    const g = document.getElementById("gate");
    if (!g.classList.contains("show")) return null;
    const a = document.getElementById("gate-action").textContent;
    document.getElementById("gate-approve").click();
    return a;
  })()`;
  for (;;) {
    const asked = await evaluate(s, click).catch(() => null);
    if (asked) console.log(`${new Date().toISOString()} approved: ${asked}`);
    await sleep(400);
  }
} else if (cmd === "shot") {
  const t = (await targets()).find((x) => x.type === "page" && x.url.startsWith(PANEL));
  if (!t) throw new Error("no panel tab");
  await fetch(`${DEV}/json/activate/${t.id}`);
  const s = await session(t.webSocketDebuggerUrl);
  await s.send("Emulation.setDeviceMetricsOverride", { width: 380, height: 760, deviceScaleFactor: 1, mobile: false });
  await sleep(300);
  const { data } = await s.send("Page.captureScreenshot", { format: "png" });
  writeFileSync(arg ?? "panel.png", Buffer.from(data, "base64"));
  await s.send("Emulation.clearDeviceMetricsOverride");
  const page = (await targets()).find((x) => x.type === "page" && /^https?:/.test(x.url));
  if (page) await fetch(`${DEV}/json/activate/${page.id}`);
  s.close();
  console.log(arg ?? "panel.png");
} else if (cmd === "close") {
  const v = await (await fetch(`${DEV}/json/version`)).json();
  await (await session(v.webSocketDebuggerUrl)).send("Browser.close").catch(() => {});
} else {
  console.error("usage: node scripts/live.ts launch [extensionDir] | eval \"<js>\" | approve | shot <file.png> | close");
  process.exit(2);
}
process.exit(0);
