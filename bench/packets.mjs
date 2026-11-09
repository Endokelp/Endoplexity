// Turns every finished run into a judge packet that does not say which engine
// or product ran it: bench/judge/packets/<pid>.md (+ <pid>.jpg when the run
// ended with a screenshot). bench/judge/map.json maps pid -> condition/task,
// and judges are never given it.
//
//   node bench/packets.mjs
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";

const B = new URL("./", import.meta.url);
const { tasks } = JSON.parse(readFileSync(new URL("tasks.json", B), "utf8"));
const out = new URL("judge/packets/", B);
mkdirSync(out, { recursive: true });

/** One line per tool call: the verb and the argument a judge can check. */
function trail(file) {
  const lines = [];
  for (const raw of readFileSync(file, "utf8").split("\n")) {
    if (!raw) continue;
    const e = JSON.parse(raw);
    const calls = [];
    if (e.type === "assistant") for (const p of e.message?.content ?? []) if (p.type === "tool_use") calls.push([p.name, p.input]);
    if (e.type === "tool_call" && e.subtype === "started") {
      const tc = e.tool_call ?? {};
      const kind = Object.keys(tc)[0];
      if (kind === "mcpToolCall") calls.push([tc[kind].args?.name, tc[kind].args?.args ?? tc[kind].args?.arguments]);
    }
    for (const [name, input] of calls) {
      const verb = String(name).replace(/^mcp__[^_]+(?:-[^_]+)*__/, "");
      if (/ToolSearch|getMcpTools|select_browser/.test(verb)) continue;
      lines.push(`- ${verb} ${JSON.stringify(input ?? {}).slice(0, 220)}`);
    }
  }
  return lines.length > 80 ? [...lines.slice(0, 40), `- ... ${lines.length - 80} more ...`, ...lines.slice(-40)] : lines;
}

const map = {};
for (const condition of readdirSync(new URL("runs/", B)).filter((d) => d !== "smoke")) {
  for (const t of tasks) {
    const base = fileURLToPath(new URL(`runs/${condition}/${t.id}`, B));
    if (!existsSync(`${base}.summary.json`)) continue;
    const s = JSON.parse(readFileSync(`${base}.summary.json`, "utf8"));
    const pid = createHash("sha256").update(`${condition}/${t.id}`).digest("hex").slice(0, 10);
    map[pid] = { condition, task: t.id };
    const final = existsSync(`${base}.final.txt`) ? readFileSync(`${base}.final.txt`, "utf8") : "(not captured)";
    const shot = `${base}.jpg`;
    if (existsSync(shot)) copyFileSync(shot, new URL(`${pid}.jpg`, out));
    const md = [
      `# Packet ${pid}`,
      `## Task\n${t.task}\n\nStarting website: ${t.website}`,
      `## Key points (all must be met)\n${t.key_points.map((k, i) => `${i + 1}. ${k}`).join("\n")}`,
      `## How the run ended\n${s.timedOut ? "Stopped by the 10-minute cap before it finished." : s.error ? `Ended with an error: ${s.error.slice(0, 300)}` : "The agent finished on its own."}`,
      `## The agent's final answer\n${s.answer?.trim() || "(no answer)"}`,
      `## Actions, in order\n${trail(`${base}.jsonl`).join("\n") || "(none)"}`,
      `## Open tabs and the final page (text, as captured after the run)\n${final.slice(0, 9000)}${final.length > 9000 ? "\n... (cut)" : ""}`,
      `## Screenshot of the final page\n${existsSync(shot) ? `${pid}.jpg in this folder` : "(none captured)"}`,
    ].join("\n\n");
    writeFileSync(new URL(`${pid}.md`, out), md);
  }
}
writeFileSync(new URL("judge/map.json", B), JSON.stringify(map, null, 1));
console.log(`${Object.keys(map).length} packets`);
