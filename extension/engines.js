// The Engines sheet: the failover order for a task that hits a usage limit.
// The order lives in chrome.storage (panel.js owns that); this module only draws
// three selects and reports the cleaned order. It touches `document` only inside
// initEngines, so cleanOrder can be unit-tested from node.

export const DEFAULT_ORDER = ["claude-sonnet-5-5", "grok-4.7-medium", "gpt-6.1-sol"];
const SLOTS = ["1st", "2nd", "3rd"];
const NOTE =
  "If a model hits its usage limit, the task carries on with the first engine here on a different CLI, on the same tab. That engine's vendor then receives the page.";

/** Storage is untrusted: keep offered ids only, in order, deduped, at most 3. */
export function cleanOrder(stored, offered) {
  const src = Array.isArray(stored) ? stored : DEFAULT_ORDER;
  const out = [];
  for (const id of src) {
    if (typeof id === "string" && offered.includes(id) && !out.includes(id)) out.push(id);
  }
  return out.slice(0, SLOTS.length);
}

const SECOND_NOTE =
  "Before you approve an action, a model from another vendor than the running one says whether it serves your task: claude runs ask Codex, the others ask Claude Haiku. That vendor receives your task, the action, and the page lines around it.";

/** The Plan box's raw text as the list the bridge sanitizes: commas or spaces, no empties. */
export const splitPlan = (raw) => String(raw ?? "").split(/[\s,]+/).filter(Boolean);

/**
 * `root` is the sheet inside the footer <details>; returns the current order and
 * the Second key setting (a missing stored value means on).
 */
export function initEngines(root, modelSelect, stored, onChange, storedSecond, onSecond) {
  const offered = [...modelSelect.options].map((o) => o.value);
  const order = cleanOrder(stored, offered);
  const selects = SLOTS.map((name, i) => {
    const select = document.createElement("select");
    select.ariaLabel = `${name} engine`;
    select.append(new Option("none", ""));
    for (const o of modelSelect.options) select.append(new Option(o.textContent, o.value));
    select.value = order[i] ?? "";
    select.addEventListener("change", () => onChange(read()));
    return select;
  });
  const read = () => cleanOrder(selects.map((s) => s.value), offered);

  const note = document.createElement("p");
  note.className = "rx-note";
  note.textContent = NOTE;
  root.append(note);
  selects.forEach((select, i) => {
    const name = document.createElement("div");
    name.className = "rx-name";
    const b = document.createElement("b");
    b.textContent = SLOTS[i];
    name.append(b);
    const line = document.createElement("div");
    line.className = "rx-line";
    line.append(name, select);
    root.append(line);
  });

  const box = document.createElement("input");
  box.type = "checkbox";
  box.checked = storedSecond !== false;
  box.addEventListener("change", () => onSecond(box.checked));
  const label = document.createElement("label");
  label.className = "rx-switch";
  label.append(box, " Second key");
  const secondNote = document.createElement("p");
  secondNote.className = "rx-note";
  secondNote.textContent = SECOND_NOTE;
  root.append(label, secondNote);
  return { order: read, secondKey: () => box.checked };
}
