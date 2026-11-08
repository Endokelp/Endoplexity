/**
 * The frozen task set (bench/tasks.json) through one engine, one task at a time.
 *
 *   node bench/suite.ts <model> <condition>     e.g. claude-sonnet-5-5 claude-off
 *
 * Each task is one `scripts/bench.ts` run starting on the task's website, so the
 * numbers come from the same harness as every earlier phase. Output per task in
 * bench/runs/<condition>/: <id>.jsonl (the raw stream), .summary.json, .final.txt
 * and .jpg, a screenshot of where the run ended taken over the test browser's
 * debugging port. The screenshot is for the judge: no model that drives ever
 * receives one. A task with a summary already is skipped, so a stopped suite
 * resumes where it was.
 *
 * Needs, per condition: a bridge (ENDO_PORT, ENDO_HOME, ENDO_MCP_CONFIG), the
 * test browser from `scripts/live.ts launch` on ENDO_LIVE_PORT, and its
 * `approve` loop. bench/README.md has the commands.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const [model, condition] = process.argv.slice(2);
if (!model || !condition) {
  console.error("usage: node bench/suite.ts <model> <condition>");
  process.exit(2);
}
const ROOT = fileURLToPath(new URL("../", import.meta.url));
const DIR = `bench/runs/${condition}`;
mkdirSync(new URL(`runs/${condition}`, import.meta.url), { recursive: true });
const DEV = `http://127.0.0.1:${process.env.ENDO_LIVE_PORT ?? 9333}`;
// ponytail: one cap for every engine. A run that needs longer is reported as a
// timeout, apart from stalls, rather than given a longer leash per engine.
const CAP_MS = Number(process.env.ENDO_BENCH_TIMEOUT ?? 600_000);

const { tasks } = JSON.parse(readFileSync(new URL("tasks.json", import.meta.url), "utf8"));

/** A JPEG of the tab whose URL the run ended on, and every other page tab closed. */
async function settle(finalTabs: string, file: string) {
  const url = /^\* id \d+ — ".*" (\S+)/m.exec(finalTabs)?.[1];
  const pages = (await (await fetch(`${DEV}/json/list`)).json()).filter((t: any) => t.type === "page" && /^https?:/.test(t.url));
  const end = pages.find((t: any) => t.url === url);
  if (end) {
    const ws = new WebSocket(end.webSocketDebuggerUrl);
    await new Promise((ok, fail) => ((ws.onopen = ok), (ws.onerror = fail)));
    const shot: any = await new Promise((ok) => {
      ws.onmessage = (m) => ok(JSON.parse(String(m.data)));
      ws.send(JSON.stringify({ id: 1, method: "Page.captureScreenshot", params: { format: "jpeg", quality: 60 } }));
    });
    ws.close();
    if (shot.result?.data) writeFileSync(file, Buffer.from(shot.result.data, "base64"));
  }
  // Tabs a run opened would pile up across thirty tasks. Without the end tab
  // found, nothing closes: it may be the one the panel holds.
  if (end) for (const t of pages) if (t !== end) await fetch(`${DEV}/json/close/${t.id}`).catch(() => {});
}

for (const [i, t] of tasks.entries()) {
  const base = `${DIR}/${t.id}`;
  if (existsSync(`${ROOT}${base}.summary.json`)) continue;
  console.log(`\n[${i + 1}/${tasks.length}] ${condition} ${t.level} ${t.website}\n${t.task}`);
  // cic:<model> is the comparison row, Claude in Chrome through the same CLI.
  const runner = model.startsWith("cic:") ? ["bench/cic.ts", model.slice(4)] : ["scripts/bench.ts", model];
  const r = spawnSync(process.execPath, [...runner, base, t.task], {
    cwd: ROOT,
    env: { ...process.env, ENDO_BENCH_URL: t.website, ENDO_BENCH_TIMEOUT: String(CAP_MS) },
    encoding: "utf8",
    // The cap plus time to read the end state; past this the harness is what hung.
    timeout: CAP_MS + 120_000,
  });
  if (!existsSync(`${ROOT}${base}.summary.json`)) {
    // The harness itself failed (panel gone, bridge down): stop rather than
    // record thirty failures that measure the setup.
    console.error(r.stdout?.slice(-2000), r.stderr?.slice(-2000));
    process.exit(1);
  }
  const s = JSON.parse(readFileSync(`${ROOT}${base}.summary.json`, "utf8"));
  await settle(s.final_tabs, `${ROOT}${base}.jpg`).catch((err) => console.warn(`no screenshot: ${err.message}`));
  console.log(`${(s.wall / 1000).toFixed(0)}s, ${s.tool_calls} calls${s.timedOut ? ", TIMED OUT" : ""}${s.error ? `, error: ${s.error.slice(0, 120)}` : ""}`);
}
console.log(`\n${condition}: done`);
