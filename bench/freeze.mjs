// Freezes the Phase 23 task set: 30 Online-Mind2Web tasks, chosen by a rule
// written before any run, so nobody (us included) can pick tasks that suit us.
//
// Rule: every one of the 300 tasks is eligible (no exclusions). Order them by
// sha256("endoplexity-p23" + task_id), walk that order, and keep a task while
// its level still needs one (10 easy, 10 medium, 10 hard) and its website's
// host is not taken yet, so no site counts twice.
//
// Each task carries the benchmark's own rubric (WebJudge o4-mini key points)
// and the human labels the Online-Mind2Web authors gave six other agents on
// the same task, so the slice compares like with like.
//
//   node bench/freeze.mjs   (writes bench/tasks.json)
import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";

// Pinned commits: the same input gives the same 30 tasks forever.
const FARA = "https://raw.githubusercontent.com/microsoft/fara/a675d6d61c41c47ae87bacefeab22caad18e3e84/webeval/data/om2w/Online_Mind2Web_06042025.json";
const OM2W = "https://raw.githubusercontent.com/OSU-NLP-Group/Online-Mind2Web/1a8db93168d5d7870402b7f453160e1c557153c8/data/evaluation_results/online_mind2web_evaluation_results";

const get = async (url) => {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${res.status} ${url}`);
  return res.text();
};
const tasks = JSON.parse(await get(FARA));
const labels = new Map(JSON.parse(await get(`${OM2W}/human_label.json`)).map((l) => [l.task_id, l]));
const judged = (await get(`${OM2W}/webjudge_o4-mini/browser_use_results.json`)).split("\n").filter(Boolean).map((l) => JSON.parse(l));
const keyPoints = new Map(judged.map((j) => [j.task_id, j.key_points.split("\n").map((s) => s.replace(/^\s*\d+\.\s*/, "").trim()).filter(Boolean)]));

const rank = (id) => createHash("sha256").update(`endoplexity-p23${id}`).digest("hex");
const want = { easy: 10, medium: 10, hard: 10 };
const hosts = new Set();
const picked = [];
for (const t of [...tasks].sort((a, b) => rank(a.task_id).localeCompare(rank(b.task_id)))) {
  const host = new URL(t.website).hostname.replace(/^www\./, "");
  if (!want[t.level] || hosts.has(host)) continue;
  want[t.level]--;
  hosts.add(host);
  const l = labels.get(t.task_id) ?? {};
  picked.push({
    id: t.task_id,
    level: t.level,
    website: t.website,
    task: t.confirmed_task,
    reference_length: t.reference_length,
    key_points: keyPoints.get(t.task_id) ?? [],
    // 1 success, 0 failure, 2 could not run (site blocked, captcha, bug), as labelled upstream.
    human_labels: Object.fromEntries(Object.entries(l).filter(([k]) => k.endsWith("_human_label")).map(([k, v]) => [k.replace("_human_label", ""), Number(v)])),
  });
}
if (picked.length !== 30) throw new Error(`picked ${picked.length}, want 30`);
writeFileSync(new URL("tasks.json", import.meta.url), JSON.stringify({ source: { tasks: FARA, labels: OM2W, rule: "see bench/freeze.mjs" }, tasks: picked }, null, 2) + "\n");
console.log(picked.map((t) => `${t.level.padEnd(6)} ${new URL(t.website).hostname.padEnd(28)} ${t.task.slice(0, 80)}`).join("\n"));
