import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { MODELS } from "../src/models.ts";

// The dropdown and the allowlist are two hand-written lists. An option the
// bridge does not know is refused on Run as "unknown model"; an id the bridge
// knows but the panel does not offer is dead weight. Either way, drift here is
// only found by clicking.
test("the panel offers exactly the models the bridge accepts", () => {
  const html = readFileSync(fileURLToPath(new URL("../../extension/panel.html", import.meta.url)), "utf8");
  const select = /<select id="model"[\s\S]*?<\/select>/.exec(html)?.[0] ?? "";
  const offered = [...select.matchAll(/<option value="([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual([...offered].sort(), Object.keys(MODELS).sort());
});
