// One paste, one verdict. `await endo.selftest()` in the side panel console
// drives the whole tool-layer gate: it navigates the tab to the OOPIF fixture,
// snapshots, fills the cross-origin form across its two steps, sets a native
// dropdown, clicks, and checks that refs go stale. Nothing to set up and
// nothing to eyeball. Pass a path — `endo.selftest("C:\\path\\to\\file.pdf")`
// — to also exercise the upload happy path; the panel cannot fabricate a file
// on disk, so that one check is skipped (visibly, not silently passed) when no
// path is given.

import * as cdp from "./cdp.js";
import { runTool } from "./tools.js";
// Imported, never copied — same reason gate.ts imports it. A drifted copy is a
// check that passes against a marker nothing emits any more.
import { UNCHANGED } from "./ax.js";

const FIXTURE = "http://127.0.0.1:8787/fixtures/host.html";
// The page host.html embeds, loaded top-level here purely as a second real URL
// for the history checks to move between.
const FORM = "http://localhost:8787/fixtures/form.html";
const FIELDS = [
  ["First name", "Ada"],
  ["Last name", "Lovelace"],
  ["Email", "ada@example.com"],
];
const KEYSTROKES = FIELDS.reduce((n, [, v]) => n + v.length, 0);

const refFor = (text, role, name) => text.match(new RegExp(`(@\\w+) \\[${role}\\] "${name}"`))?.[1];
const basename = (p) => p.split(/[\\/]/).pop();

async function throws(fn, needle) {
  try {
    await fn();
    return `no error, expected "${needle}"`;
  } catch (err) {
    return err.message.includes(needle) ? null : `got "${err.message}"`;
  }
}

/**
 * A throw anywhere in the checks used to take the whole report with it: the
 * console printed one red stack trace and nothing else, so every check that had
 * already PASSED was invisible and the run could not be read as working or
 * broken — which is worse than a plain FAIL. The checks run inside this, and
 * whatever they got through is printed either way.
 */
export async function selftest(filePath) {
  const results = [];
  const skips = [];
  const check = (label, detail) => results.push({ ok: !detail, label, detail: detail ?? "" });
  const skip = (label, reason) => skips.push({ label, reason });

  try {
    await runChecks(check, skip, filePath);
  } catch (err) {
    check(`the self-test stopped early — ${err.message}`, "every check below this point never ran");
  }
  return report(results, skips);
}

async function runChecks(check, skip, filePath) {
  // Not the active tab. The panel is normally opened from chrome://extensions,
  // which is closed to chrome.debugger, so the self-test died on "Cannot access
  // a chrome:// URL" before testing anything. attach() already knows how to pick
  // a drivable tab — the same trap that cost Phase 2 a whole live run.
  if (cdp.state().tabId === null) await cdp.attach();
  const tabId = cdp.state().tabId;

  // upload() takes no ref — it scans every attached frame's DOM for a file
  // input, deliberately, because the real thing is hidden from the AX tree on
  // real ATS pages. That means the one deterministic way to prove "no input
  // anywhere" is a page with genuinely no file input in any frame, so this
  // runs before the fixture (whose iframe has one) ever loads.
  await cdp.navigate("about:blank");
  check(
    "upload errors clearly when no frame has a file input",
    await throws(() => cdp.upload("resume.pdf"), "file input"),
  );

  await cdp.navigate(FIXTURE);

  let snap = await cdp.snapshot();
  const frames = cdp.state().frames;
  check(
    "OOPIF auto-attach",
    frames.some((f) => f.url.includes("/fixtures/form.html")) ? null : `frames: ${JSON.stringify(frames)}`,
  );

  const refs = FIELDS.map(([label]) => refFor(snap, "textbox", label));
  check("form fields found in the snapshot", refs.every(Boolean) ? null : `got ${refs}`);
  check(
    "fields live in a child frame, not f0",
    refs.every((r) => r && !r.startsWith("@f0")) ? null : `refs ${refs} came from the main frame`,
  );
  if (!refs.every(Boolean)) return;

  for (const [i, [, value]] of FIELDS.entries()) await cdp.type(refs[i], value);

  const cont = refFor(snap, "button", "Continue");
  check("Continue button found", cont ? null : "no Continue button in the snapshot");
  if (!cont) return;

  // Continue hides step 1 and reveals step 2 — the dropdown, the resume button
  // and Submit Application do not exist until this click.
  snap = await cdp.click(cont, { full: true });

  // Found once. It used to be re-found after every action because a snapshot
  // invalidated the one before it; refs are keyed on the node now, so the ref
  // survives the select, the upload and everything else below — and the checks
  // that follow are what proves that on a real page rather than in a stub.
  const submit = refFor(snap, "button", "Submit Application");
  const select = refFor(snap, "combobox", "Source");
  check("step 2 revealed after Continue", submit && select ? null : `submit=${submit} select=${select}`);
  if (!submit || !select) return;

  check(
    "select rejects a nonsense value and lists the options",
    await throws(() => cdp.select(select, "Mars Colony"), "LinkedIn"),
  );

  // "Referral" is the option whose markup has surrounding whitespace/newlines —
  // choosing it by the clean text proves the trim, not just that select() works.
  // batch's middle steps: the ack alone and no read. The read after it must
  // still report the change, which it would not ("nothing") had the quiet
  // step secretly read the page and moved the delta baseline.
  await cdp.snapshot();
  const ack = await cdp.select(select, "LinkedIn", { quiet: true });
  check("a quiet action returns its ack, not the page", ack === 'selected "LinkedIn"' ? null : `got ${ack.length} chars`);
  const after = await cdp.snapshot();
  // Reported, as a delta OR as the whole page. A native select moves three lines
  // (its value, and `selected` leaving one option for another), and on this
  // 14-line fixture six changed lines is over delta()'s 40% bar, so the whole
  // page is the right answer: asserting a delta here failed the first live run
  // with the code correct. A secret read would give "(nothing" and no new value.
  check(
    "the read after a quiet action reports what it changed",
    after.includes('"Source" = "LinkedIn"') && !after.includes("(nothing") ? null : after.slice(0, 120),
  );
  snap = await cdp.select(select, "Referral");

  if (filePath) {
    // No ref needed — upload() finds the input itself, which is the point of
    // the exercise: the "Attach resume" button on the page does nothing.
    snap = await cdp.upload(filePath);
    check(
      "an action on an unchanged page returns a patch, not the page",
      snap.startsWith("---") ? null : `got ${snap.length} chars of page instead`,
    );
  } else {
    skip("upload happy path", 'no filePath given — call selftest("C:/path/to/file.pdf") to exercise it');
  }

  snap = await cdp.click(submit, { full: true });
  // Report what the fixture actually said, not just that the expected string is
  // missing — "never submitted" and "submitted, miscounted" are different bugs
  // and they used to fail identically.
  const reported = snap.match(/submitted after \d+ keydowns/)?.[0];
  check(
    "trusted keystrokes reached the cross-origin form",
    reported === `submitted after ${KEYSTROKES} keydowns`
      ? null
      : (reported ?? "the form never submitted at all"),
  );
  check("typed values landed", FIELDS.every(([, v]) => snap.includes(v)) ? null : "a value is missing");
  check(
    "select set the dropdown to the whitespace-padded option's trimmed text",
    snap.includes('"source": "referral"') ? null : "chosen option missing from the submitted payload",
  );
  if (filePath) {
    check(
      "uploaded file's name reached the submitted payload",
      snap.includes(basename(filePath)) ? null : "file name missing from the submitted payload",
    );
  }

  check("unknown ref rejected", await throws(() => cdp.click("@f9e9"), "unknown ref"));

  const reloaded = cdp.loaded(tabId);
  await chrome.tabs.reload(tabId);
  await reloaded;
  check("refs go stale on navigation", await throws(() => cdp.click(submit), "stale ref"));

  // --- reachability (phase 7) ---
  //
  // Deliberately after the stale-ref check above, not woven into the form flow.
  // The reload has to be the thing that kills `submit` — a check that passes
  // because something else invalidated it first has proved nothing about
  // navigation. (Snapshots no longer invalidate anything, so this is easier to
  // hold to than it was, but the ordering is still what makes it meaningful.)
  await cdp.navigate(FIXTURE);

  let page = await cdp.snapshot();
  check(
    "the hover-only item is absent before hovering",
    page.includes("Hover-only item") ? "it was in the tree without any hover" : null,
  );
  const menu = refFor(page, "button", "Menu");
  check("hover target found", menu ? null : "no Menu button in the snapshot");
  if (menu) {
    page = await cdp.hover(menu);
    check(
      "hover reveals a menu item that was not in the tree",
      page.includes("Hover-only item") ? null : "still absent after hover",
    );
  }

  // Not "an element below the fold" — the AX tree already covers the whole
  // document and click scrolls to its own target. This is content that is not in
  // the DOM until a real wheel event fires the page's scroll handler, which is
  // what an infinite feed does and what scrolling-into-view can never reach.
  check(
    "the lazy item is absent before scrolling",
    page.includes("Loaded on scroll") ? "it was in the tree without any scroll" : null,
  );
  page = await cdp.scroll("down");
  check(
    "scroll loads content that was not in the DOM",
    page.includes("Loaded on scroll") ? null : "the page's scroll handler never fired",
  );
  const decoy = refFor(page, "button", "Decoy button in the main frame");
  if (decoy) {
    // The ref-scoped path — the one that scrolls an open dropdown rather than
    // the document behind it. Nothing to assert about a fixture with no flyout
    // beyond "it aims and dispatches without throwing".
    let failure = null;
    try {
      await cdp.scroll("up", decoy);
    } catch (err) {
      failure = err.message;
    }
    check("scroll accepts a ref to scope itself", failure);
  } else {
    skip("ref-scoped scroll", "no decoy button in the snapshot to scope to");
  }

  // Two real http pages, not about:blank. A tab's FIRST navigation away from the
  // initial empty document replaces that entry instead of pushing one, so a
  // history built through about:blank can leave nothing to go back to — which is
  // exactly what the first live run hit. Navigating between two served pages
  // pushes an entry every time, so this check tests back/forward rather than
  // Chrome's initial-entry rules.
  await cdp.navigate(FORM);
  page = await cdp.go("back");
  check("back returns to the previous page", page.includes("Apply for this job") ? null : "did not land on the host page");
  page = await cdp.go("forward");
  check(
    "forward returns to the page back left",
    page.includes("Apply for this job") ? "went back to the host page instead" : null,
  );

  // Clicking a LINK, which nothing above ever did: every other click check here
  // drives a button that rewrites the page in place, and `back`/`forward` go
  // through Page.navigateToHistoryEntry rather than the mouse. So "click" was
  // only ever proved on the half of the web that does not navigate. Measured
  // 2026-08-12 on Hacker News: both CLIs clicked a correctly-serialised
  // `[link] "200 comments"` and were handed the front page back, and neither
  // 27/27 nor the unit suite had anything to say about it.
  await cdp.navigate(FIXTURE);
  page = await cdp.snapshot();
  const away = refFor(page, "link", "Open the form on its own");
  check("the fixture's link is in the snapshot", away ? null : "no link found to click");
  if (away) {
    page = await cdp.click(away);
    // The host page's heading is the discriminator the back/forward checks
    // already use: gone means the tab really moved.
    check(
      "clicking a link navigates the tab",
      page.includes("Apply for this job") ? "still on the host page after the click" : null,
    );
    await cdp.navigate(FIXTURE);
  }

  const home = cdp.state().tabId;
  check("tabs stars the attached tab", new RegExp(`\\* id ${home} `).test(await cdp.tabs()) ? null : "not starred");

  page = await cdp.useTab(null, FIXTURE);
  const opened = cdp.state().tabId;
  check("use_tab opens a tab and attaches to it", opened !== home ? null : `still on tab ${home}`);
  check("the opened tab's page comes back", page.includes("Apply for this job") ? null : "no page from the new tab");
  await cdp.useTab(home);
  check("use_tab switches back by id", cdp.state().tabId === home ? null : `on tab ${cdp.state().tabId}`);
  // Or every run of this self-test leaves another tab behind.
  if (opened !== home) await chrome.tabs.remove(opened);

  // Through runTool, not cdp: `full` is threaded in tools.js, and this is the
  // only check in the file that exercises the path the model's calls actually
  // take. cdp.snapshot's own `full` is proved by the form checks above — what
  // can silently break here is the tool layer dropping the argument, which
  // reads as a working page that is merely missing every word on it.
  const lean = await runTool("navigate", { url: FIXTURE });
  const prose = await runTool("navigate", { url: FIXTURE, full: true });
  check(
    "navigate threads full: through to the page it returns",
    prose.length > lean.length ? null : `full:true gave ${prose.length} chars, lean gave ${lean.length}`,
  );

  const refsIn = (text) => new Set(text.match(/@\w+e\d+/g) ?? []);
  const head = await cdp.snapshot({ maxLines: 2 });
  check("a capped snapshot names the call that reads on", head.includes("from: 2") ? null : "no from: in the notice");
  const rest = await cdp.snapshot({ maxLines: 2, from: 2 });
  check("a later page says how far in it starts", rest.includes("earlier lines not shown") ? null : "no marker");
  check(
    "reading on returns refs the first page did not",
    [...refsIn(rest)].some((ref) => !refsIn(head).has(ref)) ? null : "same refs as the first page",
  );

  // The delta invariant, on a real page. Measured 2026-08-12: a snapshot taken
  // after an action is 99.6% identical to the one before it, and a ten-turn
  // task was paying for that page fifty-five times. Both halves are checked
  // here, because the saving is only safe if the second half holds.
  const first = await cdp.snapshot();
  const someRef = [...refsIn(first)][0];
  const again = await cdp.snapshot();
  check(
    "re-reading an untouched page costs one line, not a page",
    // Absolute, not a fraction of the page. An unchanged re-read is always the
    // same ~97-char marker, so measuring it as a ratio says more about the
    // fixture's size than about the delta: on this 379-char page a delta doing
    // exactly its job lands at 25.6% and fails a `length / 4` bar. Measured
    // 2026-08-14, and it is the mirror of the gotcha that says a delta test
    // needs a realistically sized page — a ratio bar needs one too.
    again.startsWith(UNCHANGED) && again.length < 200
      ? null
      : `${again.length} chars against ${first.length}`,
  );
  check(
    "and a ref from before that re-read still resolves",
    someRef && (await cdp.hover(someRef).then(() => null, (err) => err.message)),
  );
}

/**
 * Phase 3's number, on a real page and without spending an agent run.
 *
 * Serializes the same tree twice: once the way Phase 2 did (all prose, 1000-line
 * cap) and once the way it ships now. This is the term that dominates a task —
 * a snapshot is not paid once, it sits in the context and is re-sent on every
 * later turn, so cutting it compounds.
 *
 * Conservative on purpose: the 2-space -> 1-space indent change is not undone in
 * the "before" leg, so the real saving is a little larger than this prints.
 */
export async function measure(url = "https://www.google.com/search?q=cats") {
  if (cdp.state().tabId === null) await cdp.attach();
  await cdp.navigate(url);

  const before = await cdp.snapshot({ full: true, maxLines: 1000 });
  const after = await cdp.snapshot();
  // ~4 chars per token. Wrong in the third digit, right for a ratio.
  const tokens = (s) => Math.round(s.length / 4);
  const lines = (s) => s.split("\n").length;

  console.log(
    `${url}\n` +
      `  phase 2  ${lines(before)} lines, ~${tokens(before)} tokens\n` +
      `  phase 3  ${lines(after)} lines, ~${tokens(after)} tokens\n` +
      `  per snapshot: ${(tokens(before) / Math.max(tokens(after), 1)).toFixed(1)}x smaller`,
  );
  return { before: tokens(before), after: tokens(after) };
}

// Skips print distinctly and stay out of the pass/fail count — a check that
// silently reads as neither would either inflate the pass count or fail a run
// that has nothing wrong with it, both worse than saying plainly what didn't run.
function report(results, skips = []) {
  for (const r of results) console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.label}${r.detail ? ` — ${r.detail}` : ""}`);
  for (const s of skips) console.log(`SKIP  ${s.label} — ${s.reason}`);
  const failed = results.filter((r) => !r.ok).length;
  const verdict = failed ? `${failed}/${results.length} FAILED` : `all ${results.length} passed`;
  console.log(`\n${verdict}${skips.length ? `, ${skips.length} skipped` : ""}`);
  return failed === 0;
}
