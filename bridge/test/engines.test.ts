import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_ORDER, cleanOrder, splitPlan } from "../../extension/engines.js";

const offered = [...DEFAULT_ORDER, "claude-opus-5-5"];

test("no stored value falls back to the default order", () => {
  assert.deepEqual(cleanOrder(undefined, offered), DEFAULT_ORDER);
  assert.deepEqual(cleanOrder("junk", offered), DEFAULT_ORDER);
});

test("the default is filtered to what the dropdown offers", () => {
  assert.deepEqual(cleanOrder(undefined, ["grok-4.7-medium"]), ["grok-4.7-medium"]);
});

test("junk, blanks, duplicates and unoffered ids are dropped; order is kept", () => {
  assert.deepEqual(cleanOrder([7, "", "gone", "gpt-6.1-sol", null, "gpt-6.1-sol", "claude-opus-5-5"], offered), [
    "gpt-6.1-sol",
    "claude-opus-5-5",
  ]);
});

test("at most three", () => {
  assert.deepEqual(cleanOrder(["claude-opus-5-5", ...DEFAULT_ORDER], offered), ["claude-opus-5-5", ...DEFAULT_ORDER.slice(0, 2)]);
});

test("an empty array stays empty", () => {
  assert.deepEqual(cleanOrder([], offered), []);
});

test("the plan splits on commas and spaces and drops empties", () => {
  assert.deepEqual(splitPlan(" a.com, b.com  c.com,, "), ["a.com", "b.com", "c.com"]);
  assert.deepEqual(splitPlan(""), []);
  assert.deepEqual(splitPlan(undefined), []);
});
