// The Skills sheet and the proposal cards. Both only draw what the bridge last
// sent and report what the user clicked; neither keeps a copy of the truth,
// because this document is torn down on every window switch. Every string from
// the bridge goes in through textContent / .value / .title, never as markup.

function el(tag, props = {}, ...kids) {
  const node = Object.assign(document.createElement(tag), props);
  node.append(...kids);
  return node;
}

/** Two clicks, not confirm(): a dialog from a side panel may never show. */
function twoClick(btn, label, armedLabel, go) {
  let armed = null;
  btn.addEventListener("click", () => {
    if (!armed) {
      btn.textContent = armedLabel;
      armed = setTimeout(() => ((armed = null), (btn.textContent = label)), 4000);
      return;
    }
    clearTimeout(armed);
    armed = null;
    btn.textContent = label;
    go();
  });
}

/**
 * `root` is the sheet in the footer <details>. `send` is panel.js's send().
 * `run(id, vars)` is panel.js's runSkill; it returns after the run was sent, and
 * `onRun` lets the caller close the sheet.
 */
export function initSkills(root, send, run, onRun = () => {}) {
  function apply({ skills = [] }) {
    root.replaceChildren();
    if (!skills.length) {
      return root.append(el("div", { className: "sk-empty", textContent: "No skills yet. When a run finishes, it offers to save itself as one." }));
    }
    for (const s of skills) {
      const inputs = {};
      const fields = Object.entries(s.vars ?? {}).map(([name, value]) => {
        const secret = (s.secret ?? []).includes(name);
        const input = el("input", {
          type: "text",
          value: secret ? "" : String(value ?? ""),
          autocomplete: "off",
          spellcheck: false,
        });
        // A password field, not a text one with dots: the browser must not offer
        // to remember or reveal it.
        if (secret) input.type = "password";
        inputs[name] = input;
        return el("label", { className: "sk-var" }, el("span", { textContent: name }), input);
      });

      const runBtn = el("button", { type: "button", className: "rx-btn sk-run", textContent: "Run" });
      runBtn.addEventListener("click", async () => {
        const vars = Object.fromEntries(Object.entries(inputs).map(([k, i]) => [k, i.value]));
        onRun();
        await run(s.id, vars);
      });
      const del = el("button", { type: "button", className: "rx-btn", textContent: "Delete" });
      twoClick(del, "Delete", "Click again to delete it", () => send({ type: "delete-skill", id: s.id }));

      root.append(el("div", { className: "sk-item" },
        el("b", { textContent: String(s.name) }),
        el("div", { className: "sk-meta", textContent: `${s.host} · ${s.steps} step${s.steps === 1 ? "" : "s"}` }),
        el("div", { className: "sk-task", textContent: String(s.task ?? "") }),
        ...fields,
        el("div", { className: "rx-opts" }, runBtn, del),
      ));
    }
  }
  apply({});
  return { apply };
}

const LABELS = {
  note: ["Save note", "Discard"],
  skill: ["Save skill", "Not now"],
  heal: ["Save changes", "Keep it as it was"],
};

/** `root` is the #proposals container. Renders exactly the set the bridge sent. */
export function initProposals(root, send) {
  const cards = new Map();

  function build(p) {
    const [yes, no] = LABELS[p.kind] ?? LABELS.note;
    const name = p.kind === "skill"
      ? el("input", { type: "text", className: "pc-name", maxLength: 60, value: String(p.name ?? ""), ariaLabel: "Skill name", spellcheck: false })
      : null;
    const body = el("pre", { className: "pc-lines" });
    for (const line of p.lines ?? []) {
      const text = String(line);
      const cls = text.startsWith("- ") ? "pc-del" : text.startsWith("+ ") ? "pc-add" : "";
      body.append(el("div", { className: cls, textContent: text }));
    }
    const yesBtn = el("button", { type: "button", className: "primary", textContent: yes });
    const noBtn = el("button", { type: "button", textContent: no });
    const reply = (approved) => {
      const msg = { type: "proposal-reply", id: p.id, approved };
      if (name && approved) msg.name = name.value.trim();
      // Disabled only if it went out; the bridge's next list removes the card.
      if (send(msg)) yesBtn.disabled = noBtn.disabled = true;
    };
    yesBtn.addEventListener("click", () => reply(true));
    noBtn.addEventListener("click", () => reply(false));
    return el("section", { className: "pc-card", ariaLabel: String(p.title) },
      el("b", { className: "pc-title", textContent: String(p.title) }),
      body,
      ...(p.hint ? [el("div", { className: "pc-hint", textContent: String(p.hint) })] : []),
      ...(name ? [name] : []),
      el("div", { className: "pc-pair" }, yesBtn, noBtn),
    );
  }

  function apply({ items = [] }) {
    const ids = new Set(items.map((p) => p.id));
    for (const [id, card] of cards) {
      if (!ids.has(id)) (card.remove(), cards.delete(id));
    }
    for (const p of items) {
      if (cards.has(p.id)) continue;
      const card = build(p);
      cards.set(p.id, card);
      root.append(card);
    }
  }

  return { apply };
}
