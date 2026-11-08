import { test } from "node:test";
import assert from "node:assert/strict";
import { delta, serialize, UNCHANGED } from "../../extension/ax.js";

// Minimal stand-ins for Accessibility.getFullAXTree nodes — only the fields the
// serializer reads.
const node = (
  nodeId: string,
  role: string,
  extra: {
    name?: string;
    value?: unknown;
    backendDOMNodeId?: number;
    childIds?: string[];
    ignored?: boolean;
    props?: Record<string, unknown>;
  } = {},
) => ({
  nodeId,
  ignored: extra.ignored ?? false,
  role: { value: role },
  name: { value: extra.name ?? "" },
  ...(extra.value === undefined ? {} : { value: { value: extra.value } }),
  ...(extra.backendDOMNodeId === undefined ? {} : { backendDOMNodeId: extra.backendDOMNodeId }),
  childIds: extra.childIds ?? [],
  properties: Object.entries(extra.props ?? {}).map(([name, v]) => ({ name, value: { value: v } })),
});

// A Greenhouse-shaped form: heading, two fields, a submit button buried under an
// ignored wrapper, and an unchecked checkbox.
const form = () => [
  node("1", "RootWebArea", { name: "Apply", childIds: ["2", "4", "5", "6", "9"] }),
  node("2", "heading", { name: "Apply for this job", childIds: ["3"] }),
  node("3", "StaticText", { name: "Apply for this job" }),
  node("4", "textbox", { name: "First Name", backendDOMNodeId: 11, props: { required: true } }),
  node("5", "textbox", { name: "Email", value: "a@b.com", backendDOMNodeId: 12 }),
  node("6", "generic", { ignored: true, childIds: ["7"] }),
  node("7", "button", { name: "Submit Application", backendDOMNodeId: 13, childIds: ["8"] }),
  node("8", "StaticText", { name: "Submit Application" }),
  node("9", "checkbox", { name: "Subscribe", backendDOMNodeId: 14, props: { checked: "false" } }),
];

test("a ref names the node, not its position, and is namespaced per frame", () => {
  const { refs } = serialize(form(), "f0");
  assert.deepEqual([...refs], [
    ["@f0e11", 11],
    ["@f0e12", 12],
    ["@f0e13", 13],
    ["@f0e14", 14],
  ]);

  // Same tree in an OOPIF must not collide with the main frame's refs.
  assert.deepEqual([...serialize(form(), "f1").refs.keys()], ["@f1e11", "@f1e12", "@f1e13", "@f1e14"]);
});

// The property every delta return rests on. With a walk counter, inserting one
// control at the top renumbered everything below it — so a ref the model was
// still holding silently came to mean a different element, and the only safe
// answer was to invalidate the whole page on every read.
test("a control appearing above the others does not renumber them", () => {
  const before = serialize(form(), "f0");
  const grown = form();
  grown[0]!.childIds!.unshift("0");
  grown.unshift(node("0", "button", { name: "Close banner", backendDOMNodeId: 99 }));
  const after = serialize(grown, "f0");

  assert.match(after.text, /@f0e99 \[button\] "Close banner"/);
  for (const [ref, id] of before.refs) {
    assert.equal(after.refs.get(ref), id, `${ref} must still mean the same node`);
  }
});

test("an actionable node with no backend id gets no ref, rather than one that cannot resolve", () => {
  const page = [
    node("1", "RootWebArea", { childIds: ["2"] }),
    node("2", "button", { name: "Ghost" }),
  ];
  const { text, refs } = serialize(page, "f0");
  assert.equal(refs.size, 0);
  assert.match(text, /^\[button\] "Ghost"$/m, "a ref that can only answer 'unknown ref' is worse than none");
});

test("renders role, name, value and only the flags that are on", () => {
  const { text } = serialize(form(), "f0");
  assert.match(text, /@f0e11 \[textbox\] "First Name" \(required\)/);
  assert.match(text, /@f0e12 \[textbox\] "Email" = "a@b\.com"$/m);
  assert.doesNotMatch(text, /checked/); // checked="false" is not a flag that is on
});

test("walks through ignored wrappers but drops text the control already announced", () => {
  const { text } = serialize(form(), "f0");
  assert.match(text, /@f0e13 \[button\] "Submit Application"/); // found under the ignored node
  assert.equal(text.match(/Submit Application/g)?.length, 1); // StaticText echo dropped
  assert.equal(text.match(/Apply for this job/g)?.length, 1);
});

// The Phase 3 gate in one test: body prose was the bulk of every snapshot and
// almost none of what the agent needed to act, since links and buttons carry
// their own labels. Reading tasks ask for it; acting ones no longer pay for it.
test("body prose is dropped by default and comes back with full", () => {
  const page = [
    node("1", "RootWebArea", { name: "Cat", childIds: ["2", "3", "4"] }),
    node("2", "heading", { name: "Cat" }),
    node("3", "StaticText", { name: "The cat is a small domesticated carnivore." }),
    node("4", "link", { name: "Read more", backendDOMNodeId: 7 }),
  ];

  const lean = serialize(page, "f0").text;
  assert.doesNotMatch(lean, /domesticated/); // the expensive half
  assert.match(lean, /\[heading\] "Cat"/); // orientation stays
  assert.match(lean, /@f0e7 \[link\] "Read more"/); // and everything actionable

  assert.match(serialize(page, "f0", { full: true }).text, /domesticated/);
});

// A live run died here: one slider on the page threw out of clean(), and since
// click/navigate/key all return the page, every action after it read as a failed
// action. The agent spent 19 turns and $0.22 concluding the browser was broken.
test("survives non-string AX values", () => {
  const page = [
    node("1", "RootWebArea", { name: "Cat", childIds: ["2", "3"] }),
    node("2", "slider", { name: "Volume", value: 0.5, backendDOMNodeId: 7 }),
    node("3", "checkbox", { name: "Mute", value: true, backendDOMNodeId: 8 }),
  ];
  const { text } = serialize(page, "f0");
  assert.match(text, /@f0e7 \[slider\] "Volume" = "0\.5"/);
  assert.match(text, /@f0e8 \[checkbox\] "Mute" = "true"/);
});

const many = () => [
  node("1", "RootWebArea", { childIds: Array.from({ length: 50 }, (_, i) => `b${i}`) }),
  ...Array.from({ length: 50 }, (_, i) => node(`b${i}`, "button", { name: `B${i}`, backendDOMNodeId: i })),
];

test("caps the payload and names the call that reads past the cap", () => {
  const lines = serialize(many(), "f0", { maxLines: 10 }).text.split("\n");
  assert.equal(lines.length, 11); // 10 kept + the notice
  assert.match(lines.at(-1)!, /40 more lines below/);
  // Greenhouse's country flyout overflowed this cap and the notice used to say
  // "scroll or narrow the page" — neither of which the agent could do. The
  // recovery it names now has to be a call that exists.
  assert.match(lines.at(-1)!, /from: 10/);
});

test("from: reads on where the cap stopped, without renumbering refs", () => {
  const head = serialize(many(), "f0", { maxLines: 10 });
  const rest = serialize(many(), "f0", { maxLines: 10, from: 10 });

  assert.match(head.text, /@f0e0 \[button\] "B0"/);
  assert.doesNotMatch(head.text, /"B10"/);
  assert.match(rest.text, /@f0e10 \[button\] "B10"/); // the node's own ref, on whichever page it lands
  assert.match(rest.text.split("\n")[0]!, /10 earlier lines not shown/);
  assert.match(rest.text, /from: 20/);

  // Every ref is minted during the walk, before the window is cut, so a ref the
  // agent can only see on a later page still resolves on the first one.
  assert.deepEqual([...head.refs], [...rest.refs]);
});

test("the last page of a paginated read has no read-on notice", () => {
  const { text } = serialize(many(), "f0", { maxLines: 10, from: 40 });
  assert.match(text, /"B49"/);
  assert.doesNotMatch(text, /more lines below/);
});

// An out-of-range `from` used to be the obvious way to get an empty page and a
// tool result that reads as a broken browser rather than a bad argument.
test("a from past the end returns just the marker, not a crash", () => {
  const { text } = serialize(many(), "f0", { maxLines: 10, from: 999 });
  assert.equal(text, "… 999 earlier lines not shown (reading from line 999)");
});

// ---- delta returns ----------------------------------------------------------
//
// Measured on real pages 2026-08-12: a snapshot taken after an action is 99.6%
// identical to the one before it — 260 lines, one of them new. Actions return
// the page they produced and every return is re-sent on every later turn, so a
// ten-turn form fill paid for that page fifty-five times.

test("typing into a field costs the line that changed, not the page", () => {
  const before = serialize(form(), "f0").text;
  const typed = form();
  typed[3] = node("4", "textbox", { name: "First Name", value: "Ada", backendDOMNodeId: 11, props: { required: true } });
  const after = serialize(typed, "f0").text;

  const patch = delta(before, after)!;
  assert.ok(patch.startsWith(UNCHANGED));
  assert.match(patch, /^- @f0e11 \[textbox\] "First Name" \(required\)$/m);
  assert.match(patch, /^\+ @f0e11 \[textbox\] "First Name" = "Ada" \(required\)$/m);
  assert.ok(patch.length < after.length, "a delta that is not shorter than the page is not worth sending");
  // The Submit button is not in the patch — which is exactly why the gate has
  // to merge rather than replace. See gate.test.ts.
  assert.doesNotMatch(patch, /Submit Application/);
});

test("a page that did not change at all says so in one line", () => {
  const text = serialize(form(), "f0").text;
  const patch = delta(text, text)!;
  assert.match(patch, /nothing/);
  assert.ok(patch.length < 120, `${patch.length} chars to say nothing happened`);
});

test("a page that moved too much is sent whole, not patched", () => {
  // Navigation, a flyout opening, a search returning results — a delta here is
  // no shorter than the page, and reassembling one is a wrong click waiting.
  const patch = delta(serialize(form(), "f0").text, serialize(many(), "f0").text);
  assert.equal(patch, null);
});

test("a delta is built from lines, so an unchanged control keeps its exact ref", () => {
  const before = serialize(form(), "f0").text;
  const grown = form();
  grown[0]!.childIds!.unshift("0");
  grown.unshift(node("0", "button", { name: "Close banner", backendDOMNodeId: 99 }));

  const patch = delta(before, serialize(grown, "f0").text)!;
  assert.match(patch, /^\+ @f0e99 \[button\] "Close banner"$/m);
  assert.doesNotMatch(patch, /^- /m, "nothing was removed — with positional refs every line below would have moved");
});

test("a double quote in a name or value becomes a single quote, so a line still parses", () => {
  const { text } = serialize([node("1", "button", { name: 'Place "order" now', value: 'say "hi"', backendDOMNodeId: 1 })], "f0");
  assert.equal(text.includes('""'), false);
  assert.match(text, /\[button\] "Place 'order' now" = "say 'hi'"/);
});
