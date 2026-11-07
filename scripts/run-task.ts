/**
 * Start a task from outside the panel: a terminal, or the OS scheduler.
 *
 *   node scripts/run-task.ts "<task>" [model]
 *   npm run task -- "<task>" [model]
 *
 * The run opens a lane of its own in the side panel, on a background tab of its
 * own, so it never lands in the conversation you are having or on the page you
 * are on. It runs only while Chrome and the panel are open: the panel owns the
 * debugger, and with no panel this exits 1 and says so. It returns once the
 * run has started; the result is in the panel. Mode, plan and second key are
 * the panel's own settings, and a gate nobody answers is denied after 60s.
 *
 * Every morning at 9, on Windows:
 *   schtasks /create /tn "Endoplexity morning" /sc daily /st 09:00
 *     /tr "node \"C:\path\to\Endoplexity\scripts\run-task.ts\" \"Summarise my unread notifications on github.com\""
 */
import { readFileSync } from "node:fs";

const [task, model] = process.argv.slice(2);
if (!task?.trim()) {
  console.error('usage: node scripts/run-task.ts "<task>" [model]');
  process.exit(2);
}

// The bridge's token, the same one the CLIs' MCP config carries: /run is
// refused without it, and refused from any web page whatever it carries.
const token = readFileSync(new URL("../.endo-token", import.meta.url), "utf8").trim();
const port = process.env.ENDO_PORT ?? 8787;

let res: Response;
try {
  res = await fetch(`http://127.0.0.1:${port}/run?token=${encodeURIComponent(token)}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ task, ...(model && { model }) }),
  });
} catch {
  console.error(`no bridge on 127.0.0.1:${port}: it starts at login, or double-click Endoplexity.vbs`);
  process.exit(1);
}
const body = (await res.json().catch(() => ({}))) as { run?: string; error?: string };
if (!res.ok) {
  console.error(body.error ?? `the bridge answered ${res.status}`);
  process.exit(1);
}
console.log(`started run ${body.run} in the side panel`);
