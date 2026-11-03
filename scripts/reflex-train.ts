/**
 * The distillation loop: `npm run reflex:train`.
 *
 * Every Shadow decision that got a truth (the model's next action, a person's
 * mark) is a labelled example of this user's own browsing. This fine-tunes
 * Laya on them, holds out a fixed fifth it never trains on, and reports
 * agreement on that fifth for the checkpoint in use before, the fine-tune,
 * the lexical rules, and Jev when it is set up, all on the same decisions.
 * The fine-tune replaces the checkpoint in use only if its held-out agreement
 * is higher. Nothing leaves the machine except the held-out states to Jev, and
 * only when the user has a key and accepted Jev's disclosure.
 *
 *   npm run reflex:train            train, compare, keep if better
 *   npm run reflex:train -- --dry   write the split and print the counts only
 *
 * The bridge picks a kept checkpoint up the next time it starts Laya.
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const { initReflexes, labelled, defaultHome, provider, ask, argmax, current } = await import("../bridge/src/reflex.ts");
const { trainedDir, layaModel } = await import("../bridge/src/laya.ts");

const dry = process.argv.includes("--dry");
const home = defaultHome();
const trainer = join(home, "laya", process.platform === "win32" ? "Scripts\\laya-train.exe" : "bin/laya-train");
const work = join(home, "train");
mkdirSync(work, { recursive: true });

initReflexes(home);
// Pick, Gate and Obstacle: the reflexes with a question a checkpoint answers.
// One row per distinct question: the same page asked about twice (a site
// visited on two runs) is one decision, and split by id it landed on both
// sides, which laya-train flagged as an eval overlapping its training data.
const sig = (r: { state: string; question?: unknown }) => createHash("sha1").update(r.state + JSON.stringify(r.question)).digest();
const rows = [
  ...new Map(
    labelled()
      .filter((r) => r.reflex !== "settle" && r.reflex !== "see")
      .map((r) => [sig(r).toString("hex"), r] as const),
  ).values(),
];

// A fixed fifth by content, so a decision is held out on every run and never trained on.
const heldOut = (r: (typeof rows)[number]) => sig(r)[0] % 5 === 0;
const test = rows.filter(heldOut);
const train = rows.filter((r) => !heldOut(r));
const line = (r: (typeof rows)[number]) =>
  JSON.stringify({ state: r.state, questions: { [r.reflex]: r.question }, expected: { [r.reflex]: r.truth } });
writeFileSync(join(work, "train.jsonl"), train.map(line).join("\n") + "\n");
writeFileSync(join(work, "eval.jsonl"), test.map(line).join("\n") + "\n");

const tally = (xs: typeof rows) =>
  Object.entries(Object.groupBy(xs, (r) => r.reflex)).map(([k, v]) => `${k} ${v!.length}`).join(", ");
console.log(`labelled decisions: ${rows.length} (${tally(rows)})`);
console.log(`train ${train.length}, held out ${test.length} (${tally(test)})`);
// ponytail: fixed floors. Fewer and the held-out number is a coin toss; the
// panel's Act rule wants 50 for the same reason.
if (train.length < 40 || test.length < 10) {
  console.log("not enough to train on yet: keep Shadow on and run tasks. Needs 40 to train and 10 held out.");
  process.exit(dry ? 0 : 1);
}
if (dry) process.exit(0);

// The checkpoint in use is the base the fine-tune starts from, and the "before".
const before = layaModel() === "endo" ? trainedDir() : "multilingual";
const out = join(work, "candidate");
rmSync(out, { recursive: true, force: true });
console.log(`fine-tuning ${before === "multilingual" ? "the base checkpoint" : "the current fine-tune"} ...`);
const run = spawnSync(
  trainer,
  [
    "--data", join(work, "train.jsonl"),
    "--eval", join(work, "eval.jsonl"),
    "--base", before,
    "--out", out,
    // Option order is shuffled: the lexical top answer is option 1 far more
    // often than not, and a model can learn the position instead of the page.
    "--shuffle-options",
    // A few hundred examples at the default 8 x 8 batch is a handful of optimizer
    // steps, which learned nothing in the Phase 16 spike.
    "--micro-batch", "8", "--grad-accum", "1", "--epochs", "6",
  ],
  { encoding: "utf8", env: { ...process.env, HF_HUB_DISABLE_TELEMETRY: "1", PYTHONIOENCODING: "utf-8" }, maxBuffer: 64 << 20 },
);
if (run.status !== 0) {
  console.error(run.stderr.slice(-2000));
  process.exit(1);
}
const report = JSON.parse(readFileSync(join(out, "train_report.json"), "utf8"));
const accOf = (x: any): number | null => (typeof x?.accuracy === "number" ? x.accuracy : null);
const was = accOf(report.before);
const now = accOf(report.after);

// The rules and the logged answers, on the same held-out rows.
const agree = (pick: (r: (typeof rows)[number]) => string | null | undefined) =>
  test.filter((r) => pick(r) === r.truth).length / test.length;
const pct = (x: number | null) => (x === null ? "n/a" : `${(x * 100).toFixed(1)}%`);
// The bar any number here has to clear: the answer the corpus gives most often,
// per reflex. On a log that is mostly "the top match" and "ready", a model that
// learned only that scores high and has learned nothing about pages.
const common = Object.fromEntries(
  Object.entries(Object.groupBy(train, (r) => r.reflex)).map(([k, v]) => {
    const n = Object.groupBy(v!, (r) => r.truth!);
    return [k, Object.keys(n).sort((a, b) => n[b]!.length - n[a]!.length)[0]];
  }),
);
console.log(`\nheld-out agreement on ${test.length} decisions:`);
console.log(`  most common answer  ${pct(agree((r) => common[r.reflex]))} (${Object.entries(common).map(([k, v]) => `${k}: ${v}`).join(", ")})`);
console.log(`  lexical rules       ${pct(agree((r) => r.answers.lexical?.choice))}`);
console.log(`  Laya before         ${pct(was)}`);
console.log(`  Laya fine-tuned     ${pct(now)}`);

const jev = current()?.jevAccepted ? provider("jev") : null;
if (jev) {
  let right = 0;
  for (const r of test) {
    const got = await ask(jev, r.state, { q: r.question! }, 10_000);
    if (got && argmax(got.q) === r.truth) right++;
  }
  console.log(`  Jev                 ${pct(right / test.length)}`);
} else console.log("  Jev                 not set up (no key, or its disclosure not accepted)");

if (was === null || now === null || now <= was) {
  console.log("\nkept the checkpoint in use: the fine-tune did not raise held-out agreement.");
  process.exit(0);
}
const dir = trainedDir();
if (existsSync(dir)) {
  rmSync(`${dir}.prev`, { recursive: true, force: true });
  renameSync(dir, `${dir}.prev`);
}
renameSync(out, dir);
console.log(`\nkept the fine-tune: ${dir}. Laya serves it from the bridge's next start.`);
