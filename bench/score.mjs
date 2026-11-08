// Reads every run's summary and the judges' verdicts, writes bench/results.json
// and prints the README tables.
//
//   node bench/score.mjs
//
// bench/judge/verdicts.json: { "<pid>": { "verdict": "success" | "failure", "reason": "..." } },
// the final verdict per packet after two blind judges and a second read of
// every disagreement (bench/METHOD.md).
import { existsSync, readFileSync, writeFileSync } from "node:fs";

const B = new URL("./", import.meta.url);
const read = (p) => JSON.parse(readFileSync(new URL(p, B), "utf8"));
const { tasks } = read("tasks.json");
const map = read("judge/map.json");
const verdicts = existsSync(new URL("judge/verdicts.json", B)) ? read("judge/verdicts.json") : {};
const level = Object.fromEntries(tasks.map((t) => [t.id, t.level]));

const median = (xs) => {
  const s = xs.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  if (!s.length) return null;
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const tokens = (s) => s.input_tokens + s.cache_read + s.cache_write + s.output_tokens;
// What a model had to read fresh or write: the cached prefix is billed at about a tenth.
const fresh = (s) => s.input_tokens + s.cache_write + s.output_tokens;
const actions = (s) => s.sequence.filter((n) => !/ToolSearch|getMcpTools/.test(n)).length;

const rows = {};
for (const [pid, { condition, task }] of Object.entries(map)) {
  const s = read(`runs/${condition}/${task}.summary.json`);
  (rows[condition] ??= []).push({ task, level: level[task], ok: verdicts[pid]?.verdict === "success", judged: !!verdicts[pid], ...s });
}

const results = {};
for (const [c, rs] of Object.entries(rows)) {
  const by = (l) => rs.filter((r) => r.level === l);
  results[c] = {
    model: rs[0].model,
    runs: rs.length,
    judged: rs.filter((r) => r.judged).length,
    success: rs.filter((r) => r.ok).length,
    easy: `${by("easy").filter((r) => r.ok).length}/${by("easy").length}`,
    medium: `${by("medium").filter((r) => r.ok).length}/${by("medium").length}`,
    hard: `${by("hard").filter((r) => r.ok).length}/${by("hard").length}`,
    median_wall_s: median(rs.map((r) => r.wall / 1000)),
    median_actions: median(rs.map(actions)),
    median_tokens: median(rs.map(tokens)),
    median_fresh_tokens: median(rs.map(fresh)),
    median_cost_usd: median(rs.map((r) => r.cost_usd ?? NaN)),
    total_cost_usd: rs.every((r) => r.cost_usd != null) ? rs.reduce((a, r) => a + r.cost_usd, 0) : null,
    screenshots_to_model: rs.reduce((a, r) => a + (r.screenshots ?? 0), 0),
    timeouts: rs.filter((r) => r.timedOut).length,
    errors: rs.filter((r) => r.error && !r.timedOut).length,
  };
}

// Paired: the same task, both runs judged successful, Endoplexity's Claude row
// against Claude in Chrome on the same CLI and model.
const paired = (a, b) => {
  if (!rows[a] || !rows[b]) return null;
  const B2 = Object.fromEntries(rows[b].map((r) => [r.task, r]));
  const both = rows[a].filter((r) => r.ok && B2[r.task]?.ok).map((r) => [r, B2[r.task]]);
  const ratio = (f) => median(both.map(([x, y]) => f(y) / f(x)));
  return { a, b, tasks: both.length, wall_x: ratio((r) => r.wall), tokens_x: ratio(tokens), fresh_tokens_x: ratio(fresh), cost_x: ratio((r) => r.cost_usd ?? NaN), actions_x: ratio(actions) };
};
const upstream = Object.fromEntries(Object.keys(tasks[0].human_labels).map((agent) => [agent, tasks.filter((t) => t.human_labels[agent] === 1).length]));
const out = { generated: new Date().toISOString(), results, paired: paired("claude-off", "cic-claude"), upstream_human_labels_same_30: upstream };
writeFileSync(new URL("results.json", B), JSON.stringify(out, null, 2) + "\n");

const f = (x, d = 0) => (x == null ? "n/a" : Number(x).toFixed(d));
console.log("| Condition | Success | Easy | Medium | Hard | Median time | Median actions | Median tokens | Median fresh tokens | Median cost | Screenshots to model | Timeouts | Errors |");
console.log("|---|---|---|---|---|---|---|---|---|---|---|---|---|");
for (const [c, r] of Object.entries(results))
  console.log(`| ${c} (${r.model}) | ${r.success}/${r.runs}${r.judged < r.runs ? ` (${r.judged} judged)` : ""} | ${r.easy} | ${r.medium} | ${r.hard} | ${f(r.median_wall_s)} s | ${f(r.median_actions)} | ${f(r.median_tokens)} | ${f(r.median_fresh_tokens)} | ${r.median_cost_usd == null ? "n/a" : `$${f(r.median_cost_usd, 3)}`} | ${r.screenshots_to_model} | ${r.timeouts} | ${r.errors} |`);
console.log("\nUpstream human labels, same 30 tasks:", Object.entries(upstream).map(([a, n]) => `${a} ${n}/30`).join(", "));
if (out.paired) console.log("\nPaired (Claude in Chrome / Endoplexity, both succeeded):", JSON.stringify(out.paired));
