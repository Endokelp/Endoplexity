import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { dropRun, inRun } from "../src/run.ts";
import { labelFor, remember } from "../src/page.ts";
import { handleMcp, modeNow, relay, setMode, stop } from "../src/mcp.ts";
import { askPanel, callPanel, dropPanel, sendPanel, setPanel, settle } from "../src/relay.ts";

const A = '@f0e1 [button] "Alpha"';
const B = '@f0e1 [button] "Beta"';

function fakePanel() {
  const sent: Record<string, unknown>[] = [];
  return { readyState: 1, send: (raw: string) => sent.push(JSON.parse(raw)), sent };
}
const tick = () => new Promise((r) => setTimeout(r, 5));
async function frame(panel: ReturnType<typeof fakePanel>, n: number) {
  for (let i = 0; i < 200 && panel.sent.length <= n; i++) await tick();
  return panel.sent[n];
}

test("each run keeps its own page", () => {
  inRun("a", () => remember(A));
  inRun("b", () => remember(B));
  assert.equal(inRun("a", () => labelFor("@f0e1")), '[button] "Alpha"');
  assert.equal(inRun("b", () => labelFor("@f0e1")), '[button] "Beta"');
  assert.equal(labelFor("@f0e1"), undefined);
  dropRun("a");
  dropRun("b");
});

test("a mode set in one run leaves another at normal", () => {
  inRun("a", () => setMode("trust"));
  assert.equal(inRun("a", modeNow), "trust");
  assert.equal(inRun("b", modeNow), "normal");
  assert.equal(modeNow(), "normal");
  dropRun("a");
});

test("dropRun gives the run initial state again", () => {
  inRun("a", () => remember(A));
  dropRun("a");
  assert.equal(inRun("a", () => labelFor("@f0e1")), undefined);
});

test("frames carry the run, across an await", async () => {
  const panel = fakePanel();
  setPanel(panel as never);
  const call = inRun("a", async () => {
    await Promise.resolve();
    return callPanel("snapshot", {});
  });
  assert.equal((await frame(panel, 0)).run, "a");
  settle({ id: panel.sent[0].id as number, ok: true, value: "x" });
  await call;

  void inRun("b", () => askPanel("do it"));
  assert.equal(panel.sent[1].run, "b");
  inRun("a", () => sendPanel({ type: "note" }));
  assert.equal(panel.sent[2].run, "a");
  inRun("a", () => sendPanel({ type: "note", run: "z" }));
  assert.equal(panel.sent[3].run, "z");
  sendPanel({ type: "note" });
  assert.equal(panel.sent[4].run, "");
  dropPanel(panel as never);
});

test("Stop in one run does not stop another", async () => {
  const panel = fakePanel();
  setPanel(panel as never);
  // Two calls queued in run b; the second waits behind the first.
  const [first, second] = inRun("b", () => [relay("tabs", {}), relay("tabs", {})]);
  await frame(panel, 0);
  inRun("a", stop);
  settle({ id: panel.sent[0].id as number, ok: true, value: "tabs" });
  assert.equal((await first).isError, undefined);
  await frame(panel, 1);
  settle({ id: panel.sent[1].id as number, ok: true, value: "tabs" });
  assert.equal((await second).isError, undefined);

  // Control: Stop in run b itself does turn its queued call into "stopped".
  const [c, d] = inRun("b", () => [relay("tabs", {}), relay("tabs", {})]);
  await frame(panel, 2);
  inRun("b", stop);
  settle({ id: panel.sent[2].id as number, ok: true, value: "tabs" });
  await c;
  assert.match((await d).content[0].text, /stopped/);
  dropPanel(panel as never);
  dropRun("b");
});

test("the x-endo-run header reaches the tool callback through the MCP SDK", async () => {
  const panel = fakePanel();
  setPanel(panel as never);
  const server = createServer((req, res) => void handleMcp(req, res));
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as AddressInfo;
  const call = async (run?: string) => {
    const n = panel.sent.length;
    const post = fetch(`http://127.0.0.1:${port}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...(run && { "x-endo-run": run }) },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "tabs", arguments: {} } }),
    });
    const f = await frame(panel, n);
    settle({ id: f.id as number, ok: true, value: "tab list" });
    assert.match(await (await post).text(), /tab list/);
    return f.run;
  };
  try {
    assert.equal(await call("r9"), "r9");
    assert.equal(await call(), "");
  } finally {
    server.close();
    dropPanel(panel as never);
    dropRun("r9");
  }
});
