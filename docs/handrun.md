# Verifying it by hand

Type a task in the box and hit **Run**; **Stop** kills the agent; **Reply**
(ctrl+Enter) answers it without starting over. The `endo` object stays on the
panel's own devtools console because that is still the only way to reach the CDP
layer directly.

## What the panel shows

The transcript is a conversation, not a log. Your task, the agent's answer with
markdown actually rendered (tables included), and **one collapsed line per tool
call** — `went to greenhouse.io`, `clicked "Submit application"` — that you open
when you want the args and the result. A live line under the transcript says what
it is doing right now; the cost lands as a chip at the end.

The strip under the title bar is **which tab is being driven**, and its state:
`⏳` running, `✅` done, `❌` failed. Read it before believing an action failed —
the worst bug this project has had was a form filled perfectly in a tab nobody
was watching, with every tool returning success.

With two or more tasks going, a row of pills appears above it, one per lane.
Each pill carries the lane's state the same way, plus `!` when that run is
waiting on an approval; the approval card names the run it is for. A lane that
is not running has a close button, which moves it to History.

Everything the bridge sends is still kept verbatim under **Raw log** at the
bottom, including messages the conversation drops. `endo.log()` returns it as a
string, which is what to paste into a bug report.

## How much it may do without asking

The dropdown next to the model, and it shows in the strip at all times:

| Mode | What it asks about |
|---|---|
| **Watch me** | every action that changes something — click, type, key, select, upload, navigate, tab switches, back/forward. Approving one stops it asking about that kind again for the rest of the task, or it is unusable |
| **Normal** | only actions whose label reads irreversible — submit, pay, buy, delete, send, book. The default |
| **Trust it** | nothing. This is the off switch for the only safety feature there is, which is why it stays on screen in red while it is set |

The mode is chosen in the panel, sent with the task, and enforced in the bridge.
It is never in a prompt and the model never sees it, so nothing the agent says
can widen its own permissions. An unrecognised mode falls back to **Normal**,
never to **Trust it**.

Consent walls no longer stop a run: `accept` and `agree` came out of the
irreversible list, because every "Accept all" cookie banner was halting the task
for a human — and those dialogs block the page underneath, so the agent burned
turns on a dialog it could not dismiss without approval.

## Setup (once)

```
npm install
npm run setup
```

Writes a `.vbs` launcher to the Windows Startup folder and prints where. From then
on the bridge starts at login, invisibly — no console window, no token to paste.
Re-running `npm run setup` overwrites the `.vbs`; that's expected, not a warning
sign.

The autostarted bridge is silent by design, so its output goes to
`.endo-bridge.log` at the repo root — that's the first place to look when
something isn't working.

`git pull` does not restart the bridge — the old process keeps running on the old
code until something kills it. Kill `node` in Task Manager, then double-click
`Endoplexity.vbs` (Startup folder, or the repo root if Setup fell back there) to
bring it back, or just log out and in. `Endoplexity.vbs` is also the manual start:
double-click it any time instead of running `npm start` in a terminal.

## The check

Reload the Endoplexity card on `chrome://extensions` (the bridge is already
running — see Setup above), open the side panel, right-click inside it →
**Inspect**, and paste:

```js
await endo.selftest(); await endo.measure()
```

`selftest()` is the tool gate; `measure()` is the Phase 3 one — it snapshots a
real page the way Phase 2 serialized it and the way it does now, and prints the
ratio. No agent run, so it costs nothing.

It navigates the active tab to the OOPIF fixture itself and prints PASS/FAIL per
check. Nothing to open, nothing to compare by eye. The fixture is now a two-step
form, so the checks click **Continue** partway through, then exercise a native
dropdown (incl. an option whose markup has stray whitespace, and a nonsense value
that must fail with the option list in the error) and the file-upload path (incl.
a page with no file input at all).

The Phase 7 reachability checks run last, on a fresh load of the same fixture, on
purpose: every snapshot mints a new ref generation, so a hover or a scroll woven
into the form flow would make the submit ref stale before the reload does — and
the stale-ref check would then pass having proved nothing. They cover hover
revealing a `display:none` menu item, a wheel event loading content that is not in
the DOM until you scroll, back/forward, opening and switching tabs (the opened tab
is closed again), and reading past the line cap with `from:`.

Pass a path to also exercise the upload happy path — the panel can't fabricate a
file on disk, so without one that single check prints as `SKIP`, distinct from
and not counted against PASS/FAIL:

```js
await endo.selftest("C:\\path\\to\\some.pdf")
```

The fixture (`bridge/test/fixtures/`) serves its form from `localhost` while the
host page comes from `127.0.0.1` — different sites to Chrome, so the frame gets
its own renderer exactly like a Greenhouse, Lever or Workday embed. That makes
the trap reproducible offline instead of hostage to someone's careers page.

The tab under test must not have its own devtools open — only one debugger can
attach at a time. The panel's inspector is a different target, so it is fine.

## Driving it by hand

```js
await endo.attach();                          // a drivable tab, or attach(tabId)
endo.state();                                 // attached frames + live ref count
console.log(await endo.snapshot());           // @f0e1 [button] "…", refs per frame
console.log(await endo.snapshot({full:true})); // …plus body text
await endo.type("@f1e1", "Ada");
console.log(await endo.click("@f1e4"));       // returns the page it produced
console.log(await endo.key("Enter"));         // so does this

console.log(await endo.hover("@f0e2"));       // hover-open menus
console.log(await endo.scroll("down"));       // a wheel, so lazy content loads
console.log(await endo.scroll("down","@f0e9")); // …inside that ref's scroller
console.log(await endo.go("back"));           // and go("forward")
console.log(await endo.tabs());               // * marks the attached one
console.log(await endo.useTab(null, "https://example.com")); // or useTab(id)
console.log(await endo.snapshot({from: 300})); // read past the 300-line cap
```

`scroll` is not how you reach something below the fold — the accessibility tree
covers the whole document and `click` scrolls to its own target. It is for
content that is not in the DOM yet (infinite feeds, lazy lists) and for scrolling
an open dropdown instead of the page behind it.

Refs are `@f<frame>e<n>` and die on the next `snapshot()` or any navigation —
including the snapshot `click` and `key` take on their way out, so always act on
the refs from the page the last action handed back.

Snapshots list actionable elements only. Body text costs the agent on every turn
after it is read, so reading tasks pass `full: true` rather than everything
paying for it by default.

## Applying with a resume

There is no Profile pane and deliberately no second copy of your details in the
panel: `read_file` hands the agent the real resume through the same allow-list
`upload` uses, so "fill this from my resume" is answered from the document
itself. Anything a form asks for that isn't in the file — work authorisation,
a start date — goes in the prompt.

The resume uploads by KEY, never a path — the model only ever sees a
name like `resume` in the tool description, never a filesystem path (it runs in
the browser process, which can read anything you can). `files.ts` is the one
place a key becomes an absolute path, and it reads two maps, neither of them
anything the model writes:

- **`.endo-attachments.json`**, written when you drop a file on the composer,
  paste one, or use the paperclip. The bytes come over the panel socket — a
  browser file input hands over a name and a File and deliberately never a path
  — and the bridge stores its own copy under `.endo-attachments/`. The key is
  rebuilt from the filename using `[a-z0-9_]` only, so `My CV.pdf` becomes
  `my_cv` and a name cannot describe a location.
- **`.endo-files.json`**, hand-edited, for a file you would rather leave where
  it is. Copy `.endo-files.example.json` to start one:

  ```json
  { "resume": "C:\\Users\\you\\Documents\\resume.pdf" }
  ```

Neither is committed. On a key collision the hand-edited entry wins and the
attachment takes `resume_2`, so both stay reachable. The panel draws a chip per
key; hand-configured ones have no `×`, because deleting out of a map you
maintain by hand is not the panel's business.

## On a real job site

Same calls, real page. Only one URL shape exercises the OOPIF path:

- `job-boards.greenhouse.io/<company>/jobs/<id>` — Greenhouse is the **top**
  frame. Fine for the tools, does not test OOPIF.
- a careers page embedding `boards.greenhouse.io/embed/job_app?…` in an iframe —
  the real trap, and what `selftest()` reproduces offline.

Don't submit an application you don't mean to send. The approval gate catches the
real submit and waits for you — 60 seconds of silence counts as a denial.

## The cost number

The Phase 7 gate is a measurement, not a feature: one real form fill, end to end,
against Phase 3's google baseline of **$0.0984 / 111,872 tokens / 9 turns**.

Nothing to set up — the panel already prints it. Open the job page, type the task,
hit **Run**, and read the last line of the log when it finishes:

```
— $0.1234 · 148,020 tokens · 12 turns · 96s
```

Two things make that number a lie if you skip them:

- **Start the run fresh** (Run, not Reply). A reply continues a transcript and
  bills the whole conversation again, so it measures the pair, not the task.
- **One task per number.** The bridge holds one session; a second Run resets it.

`cursor` reports no price, only tokens — a `$` will simply be missing there
rather than printed as zero.
