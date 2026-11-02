// The Reflexes settings sheet. Draws the bridge's last `reflexes` message and
// reports what the user changes; it owns no settings of its own, because this
// document is torn down on every window switch and the bridge is the truth.
//
// The controls are built once and updated in place (a rebuild per message would
// eat focus and a half-typed Jev key). Only the review list is rebuilt. Every
// string from the bridge goes in through textContent / .title / .value, never
// innerHTML.

const REFLEXES = [
  ["pick", "Pick", "which element", true],
  ["gate", "Gate", "is this irreversible", true],
  ["obstacle", "Obstacle", "cookie wall, login, captcha, error", true],
  ["settle", "Settle", "has the page stopped changing", false],
];
const BACKENDS = [
  ["lexical", "Lexical"],
  ["laya", "Laya"],
  ["jev", "Jev"],
];
const COOKIES = [
  ["agent", "Leave it to the agent"],
  ["reject", "Reject non-essential"],
  ["accept", "Accept"],
];
const ACT_HINT = "Act unlocks after 50 shadow decisions at 95% agreement";
const JEV_DISCLOSURE =
  "Jev is TypeSafe's hosted model. With Jev on, the page text a reflex reads (button labels, nearby lines, the page title and URL, never field values) is sent to TypeSafe. Their privacy policy says they do not train on it, and gives no retention period.";

function el(tag, props = {}, ...kids) {
  const node = Object.assign(document.createElement(tag), props);
  node.append(...kids);
  return node;
}

function option(value, text) {
  return el("option", { value, textContent: text });
}

/** "Laya: 48 of 50 agreed (96%)" — no percentage when nothing was counted. */
export function agreement(name, { agreed, of }) {
  return `${name}: ${agreed} of ${of} agreed` + (of > 0 ? ` (${Math.round((agreed / of) * 100)}%)` : "");
}

/** `root` is the sheet inside the footer <details>; `send` is panel.js's send(). */
export function initReflexes(root, send) {
  let last = null;
  const rows = {};

  // Always a fresh copy: the message is the last truth and must not be edited.
  const commit = (edit) => {
    if (!last) return;
    const settings = structuredClone(last.settings);
    edit(settings);
    send({ type: "reflex-settings", settings });
  };

  const master = el("input", { type: "checkbox", id: "rx-enabled" });
  master.addEventListener("change", () => commit((s) => (s.enabled = master.checked)));
  const head = el("label", { className: "rx-switch" }, master, " Reflexes");

  const list = el("div", { className: "rx-list" });
  for (const [key, name, hint, hasBackend] of REFLEXES) {
    const row = { state: null, backend: null, stats: el("div", { className: "rx-stats" }) };
    row.state = el("select", { id: `rx-${key}-state`, ariaLabel: `${name} state` });
    row.state.append(option("off", "Off"), option("shadow", "Shadow"), option("act", "Act"));
    row.state.addEventListener("change", () => commit((s) => (s[key].state = row.state.value)));
    const line = el("div", { className: "rx-line" },
      el("div", { className: "rx-name" }, el("b", { textContent: name }), el("span", { textContent: hint })),
      row.state,
    );
    if (hasBackend) {
      row.backend = el("select", { id: `rx-${key}-backend`, ariaLabel: `${name} backend` });
      for (const [b, label] of BACKENDS) row.backend.append(option(b, label));
      row.backend.addEventListener("change", () => commit((s) => (s[key].backend = row.backend.value)));
      line.append(row.backend);
    }
    rows[key] = row;
    list.append(line, row.stats);
    if (key === "obstacle") {
      const cookies = el("select", { id: "rx-cookies", ariaLabel: "Cookie banners" });
      for (const [v, label] of COOKIES) cookies.append(option(v, label));
      cookies.addEventListener("change", () => commit((s) => (s.cookies = cookies.value)));
      rows.cookies = cookies;
      list.append(el("div", { className: "rx-line" }, el("div", { className: "rx-name" }, el("span", { textContent: "Cookie banners" })), cookies));
    }
  }

  const status = el("div", { className: "rx-status" });

  const accept = el("input", { type: "checkbox", id: "rx-jev-accept" });
  accept.addEventListener("change", () => commit((s) => (s.jevAccepted = accept.checked)));
  const keyInput = el("input", { type: "password", id: "rx-jev-key", autocomplete: "off", spellcheck: false, ariaLabel: "Jev key", placeholder: "Jev key" });
  const save = el("button", { type: "button", className: "rx-btn", textContent: "Save" });
  save.addEventListener("click", () => {
    // The key goes to the bridge and nowhere else: not storage, not a field of ours.
    if (send({ type: "jev-key", key: keyInput.value.trim() })) keyInput.value = "";
  });
  const jev = el("div", { className: "rx-jev" },
    el("p", { textContent: JEV_DISCLOSURE }),
    el("label", { className: "rx-switch" }, accept, " I accept"),
    el("div", { className: "rx-keyrow" }, keyInput, save),
  );

  const reviewTitle = el("div", { className: "label", textContent: "Would have asked about" });
  const review = el("div", { className: "rx-review" });

  const logLine = el("span");
  const clear = el("button", { type: "button", className: "rx-btn", textContent: "Clear log" });
  // Two clicks, not confirm(): a dialog from a side panel is not something this
  // panel relies on anywhere, and a confirm that never shows is a button that
  // silently does nothing.
  let armed = null;
  clear.addEventListener("click", () => {
    if (!armed) {
      clear.textContent = "Click again to delete it";
      armed = setTimeout(() => ((armed = null), (clear.textContent = "Clear log")), 4000);
      return;
    }
    clearTimeout(armed);
    armed = null;
    clear.textContent = "Clear log";
    send({ type: "reflex-clear" });
  });
  const foot = el("div", { className: "rx-foot" }, logLine, clear);

  root.append(head, list, status, jev, reviewTitle, review, foot);

  function drawReview(items) {
    review.replaceChildren();
    reviewTitle.hidden = review.hidden = !items.length;
    for (const r of items) {
      const buttons = Object.entries(r.options ?? {}).map(([key, text]) => {
        const b = el("button", { type: "button", className: "rx-btn", textContent: String(text) });
        b.addEventListener("click", () => {
          if (send({ type: "reflex-mark", id: r.id, truth: key })) for (const x of buttons) x.disabled = true;
        });
        return b;
      });
      review.append(el("div", { className: "rx-item" },
        el("div", { className: "rx-what", textContent: String(r.what) }),
        el("div", { className: "rx-meta", textContent: `${r.reflex} · ${r.backend} · p=${Number(r.p).toFixed(2)}` }),
        el("div", { className: "rx-opts" }, ...buttons),
      ));
    }
  }

  function apply(msg) {
    last = msg;
    const { settings, backends = {}, stats = {}, act = {}, review: items = [], log = {} } = msg;
    master.checked = settings.enabled === true;
    for (const [key, name, , hasBackend] of REFLEXES) {
      const row = rows[key];
      const cfg = settings[key] ?? {};
      row.state.value = cfg.state ?? "off";
      const gate = act[key] ?? {};
      const backend = hasBackend ? cfg.backend : "cdp";
      const canAct = gate[backend] === true;
      row.state.querySelector('option[value="act"]').disabled = !canAct;
      row.state.querySelector('option[value="act"]').title = canAct ? "" : ACT_HINT;
      row.state.title = canAct ? "" : ACT_HINT;
      if (hasBackend) {
        row.backend.value = cfg.backend ?? "lexical";
        for (const o of row.backend.options) {
          const b = backends[o.value];
          o.disabled = !(b?.ready === true);
          o.title = b?.note ?? "";
        }
      }
      row.stats.replaceChildren();
      const mine = stats[key] ?? {};
      for (const [b, label] of hasBackend ? BACKENDS : [["cdp", "CDP"]]) {
        if (mine[b]) row.stats.append(el("div", { textContent: agreement(label, mine[b]) }));
      }
      row.stats.hidden = !row.stats.childElementCount;
    }
    rows.cookies.value = settings.cookies ?? "agent";
    status.replaceChildren();
    for (const [b, label] of BACKENDS.slice(1)) {
      const info = backends[b];
      // The note, not `ready`: ready means "can be chosen", and Laya can be
      // chosen while it is still starting or after it has failed.
      if (info) status.append(el("div", { textContent: `${label}: ${info.note || (info.ready ? "ready" : "not ready")}` }));
    }
    accept.checked = settings.jevAccepted === true;
    drawReview(items);
    logLine.textContent = `${log.rows ?? 0} decisions logged, ${((log.bytes ?? 0) / 1024).toFixed(1)} KB`;
  }

  return { apply };
}
