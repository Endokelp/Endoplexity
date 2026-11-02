import { test } from "node:test";
import assert from "node:assert/strict";
import { delta, serialize, UNCHANGED } from "../../extension/ax.js";
import { remember, labelFor, find, hasPage } from "../src/page.ts";

const node = (id: string, role: string, extra: { name?: string; childIds?: string[]; backendDOMNodeId?: number } = {}) => ({
  nodeId: id,
  role: { value: role },
  name: { value: extra.name ?? "" },
  ...(extra.backendDOMNodeId === undefined ? {} : { backendDOMNodeId: extra.backendDOMNodeId }),
  childIds: extra.childIds ?? [],
  properties: [],
});

const page = (lines: string[]) => lines.join("\n");

test("a delta behind a prefix line still patches the labels", () => {
  remember(page(['@f0e1 [textbox] "Name"']));
  remember(`set "x" on file input "y" — succeeded\n${UNCHANGED}\n- @f0e1 [textbox] "Name"\n+ @f0e9 [button] "Submit"`);
  assert.equal(labelFor("@f0e9"), '[button] "Submit"');
  assert.equal(labelFor("@f0e1"), undefined);
});

test("a from: continuation merges instead of replacing", () => {
  remember(page(['@f0e1 [button] "Submit Application"', "… 5 more lines below — call snapshot with from: 5 to read on"]));
  remember(page(["… 5 earlier lines not shown (reading from line 5)", '@f0e7 [link] "Help"']));
  assert.equal(labelFor("@f0e1"), '[button] "Submit Application"');
  assert.equal(labelFor("@f0e7"), '[link] "Help"');
});

// Acks never get here (mcp.ts keeps them out), so a page with no refs is a
// page: an article after a form must not answer find() with the form's Submit.
test("a page with no refs replaces the last one", () => {
  remember(page(['@f0e1 [button] "Submit"']));
  remember(page(['[heading] "An article"']));
  assert.equal(labelFor("@f0e1"), undefined);
  assert.deepEqual(find("submit"), []);
  assert.ok(hasPage());
});

test("a delta's additions replace a ref already held, and its removals take every copy", () => {
  // Reads at from:0 then from:200 of one page, then a delta that re-adds a ref
  // the merge already holds: the Phase 15 review got Submit back twice here.
  remember(page(['@f0e200 [button] "Submit application"', "… 300 more lines below — call snapshot with from: 1 to read on"]));
  remember(page(["… 200 earlier lines not shown (reading from line 200)", '@f0e200 [button] "Submit application"']));
  remember(`${UNCHANGED}
+ @f0e200 [button] "Submit application"`);
  assert.equal(find("submit").length, 1);
  remember(`${UNCHANGED}
- @f0e200 [button] "Submit application"`);
  assert.equal(labelFor("@f0e200"), undefined);
  assert.deepEqual(find("submit"), []);
});

test("find survives a query word that names an Object.prototype key", () => {
  remember(page(['@f0e1 [button] "Go"']));
  assert.deepEqual(find("constructor toString"), []);
});

test("many equally good matches are still listed", () => {
  remember(page(Array.from({ length: 250 }, (_, i) => `@f0e${i} [button] "Like"`)));
  const hits = find("like button");
  assert.equal(hits.length, 5);
  assert.ok(hits.every((h) => h.p > 0 && h.p < 0.8));
});

test("find ranks the submit button first, and a plain Apply over Apply now", () => {
  remember(page(['@f0e1 [button] "Cancel"', '@f0e2 [button] "Submit application"', '@f0e3 [link] "Submit feedback"']));
  const [top] = find("submit button");
  assert.equal(top.ref, "@f0e2");
  assert.ok(top.p >= 0.8);
  assert.equal(top.line, '@f0e2 [button] "Submit application"');
  remember(page(['@f0e1 [button] "Apply now"', '@f0e2 [button] "Apply"']));
  assert.equal(find("apply")[0].ref, "@f0e2");
});

test("a query matching nothing returns []", () => {
  remember(page(['@f0e1 [button] "Cancel"']));
  assert.deepEqual(find("zebra"), []);
});

test("a role-only query returns every button without false confidence", () => {
  remember(page(['@f0e1 [button] "A"', '@f0e2 [button] "B"', '@f0e3 [button] "C"', '@f0e4 [link] "D"']));
  const r = find("button");
  assert.deepEqual(r.slice(0, 3).map((c) => c.ref).sort(), ["@f0e1", "@f0e2", "@f0e3"]); // the link trails at x0.4
  assert.ok(r.every((c) => c.p < 0.8));
});

test("heading context picks the right Name field", () => {
  remember(
    page([
      '[heading] "Billing"', '@f0e1 [textbox] "Name"',
      '[heading] "Shipping"', '@f0e2 [textbox] "Name"',
    ]),
  );
  assert.equal(find("shipping name field")[0].ref, "@f0e2");
  assert.equal(find("billing name field")[0].ref, "@f0e1");
});

test("works on real serialize() and delta() output, unnamed controls included", () => {
  const nodes = (extra: ReturnType<typeof node>[]) => [
    node("1", "RootWebArea", { name: "Apply", childIds: ["2", "3", ...extra.map((n) => n.nodeId)] }),
    node("2", "heading", { name: "Contact" }),
    node("3", "textbox", { backendDOMNodeId: 12 }),
    ...extra,
  ];
  const before = serialize(nodes([]), "f0");
  remember(before.text);
  const [textRef] = before.refs.keys();
  assert.equal(labelFor(textRef), undefined);
  assert.equal(find("textbox")[0].ref, textRef);
  const after = serialize(nodes([node("4", "button", { name: "Submit Application", backendDOMNodeId: 13 })]), "f0");
  remember(`set "x" succeeded\n${delta(before.text, after.text)}`);
  assert.equal(find("submit")[0].line.includes("Submit Application"), true);
});
