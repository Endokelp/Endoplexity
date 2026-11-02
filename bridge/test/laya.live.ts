// Against the real sidecar, so not in `npm test`: it loads a 1.3 GB checkpoint.
// `npm run test:laya` after `npm run laya-setup`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { installed, startLaya, stopLaya, status } from "../src/laya.ts";

const GATE = { type: "choice", instructions: "Does this action commit something that cannot be undone?", criteria: { a: "Yes", b: "No" } };
const call = (base: string, auth?: string) =>
  fetch(`${base}/v1/systemone`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(auth ? { authorization: auth } : {}) },
    body: JSON.stringify({ model: "multilingual", state: 'Action: click [button] "Place order"', questions: { gate: GATE } }),
  });
const post = (base: string, auth?: string) => call(base, auth).then((r) => r.status);

test("the real sidecar refuses a missing or wrong key, answers the right one, and stops", { skip: !installed() && "run npm run laya-setup first", timeout: 240_000 }, async () => {
  const ep = await startLaya();
  assert.ok(ep, `laya did not start: ${status().note}`);
  assert.match(ep.base, /^http:\/\/127\.0\.0\.1:\d+$/);
  assert.equal(await post(ep.base), 401);
  assert.equal(await post(ep.base, "Bearer wrong-key"), 401);
  assert.equal(await post(ep.base, `Bearer ${ep.key}`), 200);

  const t0 = performance.now();
  const p = (await (await call(ep.base, `Bearer ${ep.key}`)).json()).answers.gate.probabilities;
  console.log(`  one Gate question: ${Math.round(performance.now() - t0)} ms, p=${JSON.stringify(p)}`);
  assert.ok(Math.abs(p.a + p.b - 1) < 1e-3);

  stopLaya();
  await new Promise((r) => setTimeout(r, 2_000));
  assert.equal(await post(ep.base, `Bearer ${ep.key}`).catch(() => 0), 0, "still answering after stopLaya()");
  assert.equal(existsSync(join(process.env.ENDO_HOME ?? join(homedir(), ".endo"), "laya.pid")), false);
});
