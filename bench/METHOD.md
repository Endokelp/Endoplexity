# How the Phase 23 numbers were made

Everything here can be rerun from this folder. The raw evidence (every run's
event stream, the page it ended on, its final screenshot, the judge packets)
is attached to the GitHub release as `endoplexity-bench-raw.zip`.

## The tasks

30 tasks from [Online-Mind2Web](https://github.com/OSU-NLP-Group/Online-Mind2Web)
(300 real tasks on 136 live websites, CC-BY-4.0), chosen by a rule written and
committed before the first run (`bench/freeze.mjs`, commit `597aec8`):

- every one of the 300 tasks was eligible, with no exclusions;
- tasks were ordered by `sha256("endoplexity-p23" + task_id)`;
- walking that order, a task was kept while its difficulty level still needed
  one (10 easy, 10 medium, 10 hard) and its website was not already used.

The task file and the upstream labels are read from pinned commits, so the
same 30 come out every time. Each task carries its rubric (the benchmark's own
WebJudge key points) and the human success labels the Online-Mind2Web authors
gave six agents on that same task.

## The conditions

| Condition | What ran | Reflexes |
|---|---|---|
| `claude-off` | Endoplexity, `claude-sonnet-5-5` through the `claude` CLI | Off |
| `claude-act` | Endoplexity, same model | Act where earned: Gate and Settle. Pick and Obstacle stay in Shadow (not yet 50 decisions at 95%) |
| `cursor-off` | Endoplexity, `grok-4.7-medium` through `cursor-agent` (18 of 30 tasks, see below) | Off |
| `codex-off` | Endoplexity, `gpt-6.1-sol` through `codex exec` | Off |
| `cic-claude` | Claude in Chrome 1.0.105 (Anthropic's extension), driven by `claude -p --chrome`, same model | n/a |

Claude in Chrome is the one competitor that can be measured the same way:
the same CLI, the same model, the same token accounting, with only the browser
tools swapped (`--tools ToolSearch --allowedTools "mcp__claude-in-chrome__*"`,
no settings, no other MCP servers). Endoplexity's Claude row runs with
`--tools ToolSearch,Agent` and its own tools, the way the product runs.

## The environment

- One Windows 11 laptop (Core Ultra 9 185H, 32 GB), home connection, runs on
  2026-11-07 and 2026-11-08.
- The Claude subscription's session limit hit at 22:10 on 2026-11-07, while
  21 Claude in Chrome tasks were still to run: each ended in two seconds with
  "You've hit your session limit" and no model turn. Those 21 measured the
  quota, not the product, so they were set aside (not deleted) and run again on
  2026-11-08 with nothing else changed. No Endoplexity run hit a limit.
- Chrome for Testing 148, a fresh profile per condition, 1280x900 window,
  occlusion throttling off. Each condition had its own bridge, port and reflex
  home, and conditions ran side by side.
- Each Endoplexity run starts on the task's website, named in the prompt the
  way the panel names a page. Claude in Chrome starts with no tab of its own,
  so it is told "Start at <website>" and spends one navigate getting there.
  The owner's own Chrome had Claude in Chrome connected too, so each of its
  runs first called `select_browser` with the test browser's device id (one
  extra turn, which its time and tokens include and its action count does
  not).
- Mode `normal`. Every approval the gate asked for was approved by the harness
  (`scripts/live.ts approve`) and logged; Online-Mind2Web tasks stop short of
  purchases and accounts. The second key was off (the bench starts runs below
  the panel, where it is switched on).
- A 10-minute cap per run. A run that hits it is a **timeout**, counted apart
  from **errors** (a CLI that ended in an error, including a usage limit).

## What is measured

- **Success**: judged, below.
- **Time**: from the CLI's spawn to its exit, model latency included.
- **Actions**: tool calls, not counting schema discovery (`ToolSearch`).
- **Tokens**: as the CLI reports them: input, cache read, cache write,
  output. "Fresh tokens" leaves out the cache read, which is billed at about a
  tenth. Vendors count differently, so compare tokens within a vendor.
- **Cost**: the API-equivalent dollar figure the `claude` CLI reports. On a
  subscription it is already paid for; it is shown to compare work done.
  `cursor-agent` and `codex` report no cost.
- **Screenshots to the model**: image blocks inside tool results, counted
  from the raw stream.

## Judging

Every run became a packet (`bench/packets.mjs`): the task, its key points, how
the run ended, the final answer, the action list, the final page's text, and a
screenshot of the final page taken by the harness after the run. A packet does
not name the engine or the product. The screenshot is for the judge only: no
model that drives ever receives one.

Two judges read every packet independently, with the rules in
[JUDGE.md](JUDGE.md), each side in its own order. Who judged, in the end:

- **Claude Sonnet 5.5 subagents** cast both votes on `claude-off`,
  `claude-act` and `codex-off`, and some votes on the rest, until the Claude
  usage limit ran out on 2026-11-08.
- **Codex (`gpt-6.1-sol`)**, two independent passes, cast most of the
  remaining votes on `cic-claude` and `cursor-off` until its own limit ran
  out; Claude Opus 5.5 cast the last five second votes.
- **Every split was read a third time by Claude Opus 5.5**, and that verdict
  stands: 7 of 123 two-vote packets.
- **15 Claude in Chrome packets were judged once, by Claude Opus 5.5.** After
  judging began, their end state turned out to be a previous task's tab:
  `bench/cic.ts` took the first page tab, but Claude in Chrome works in a tab
  of its own. Every vote cast on those packets had judged another task's page,
  so all were discarded. Each packet was rebuilt from the run's own stream
  (the last URL the agent saw, the last page text it read, its last
  screenshot) and judged afresh. `cic.ts` now picks the tab the agent last
  saw.

Final verdicts with their reasons are in `bench/judge/verdicts.json`. A Claude
model judging runs that include Claude's is a bias risk that blind packets
reduce and do not remove; so is mixing two judge families across rows.

## The upstream comparison

The same 30 tasks were run in 2025 by the Online-Mind2Web authors on six
agents and labelled by humans. Those labels are shown beside our numbers for
context. They are not a head-to-head: different months, sites that have
changed since, human judges instead of model judges, and each agent's own
browser. Newer self-reported scores on the full 300 exist (Browser Use Cloud
reports 97%, judged by its own agentic judge); they are not on this slice.

## Not run, and why

- **Cursor's last 12 tasks.** `cursor-off` ran the first 19 tasks in the frozen
  order before its harness stopped with the session that drove it. The 19th
  (drugs.com) lost its panel mid-run as the harness went down; the agent
  itself answered "the interaction check did not run", so it measured the
  harness and was set aside like the usage-limit runs. The owner was waiting
  to use Cursor in their own browser, which a bench bridge blocks, so the row
  is reported over the 18 it ran (5 easy, 9 medium, 4 hard), and its success
  is not compared with the 30-task rows.
- **Five logged-in tasks** on the owner's accounts, in the original plan:
  skipped by the owner's choice, so nothing ran in a personal browser.
- **Codex with reflexes in Act**, and **Cursor with reflexes in Act**: Act
  changes the bridge's waits and prompts, not the model, so it was measured
  once, on Claude. Codex runs also use a quota the owner was using.
- **Gemini in Chrome (auto browse)** and **ChatGPT agent**: no measurement.
  Auto browse is US-only on Google AI Pro or Ultra and runs inside Google's
  service; ChatGPT agent runs in OpenAI's cloud browser. Neither reports tokens
  to its user, so only time and success could be measured, by hand.
- **Perplexity Comet**: a separate browser with a server-side agent and no
  token reporting; same reason.

## Competitors

Facts in the README's comparison table, checked 2026-11-07:

- Comet and Claude in Chrome tool shapes: read from their shipped extension
  code on 2026-10-31 (Comet `comet-agent` 2026.10.29.1608, Claude in Chrome
  1.0.104), static read only, nothing copied.
- ChatGPT agent: 40 tasks a month on Plus, 400 on Pro, in a virtual browser
  ([OpenAI help](https://help.openai.com/en/articles/11752874-chatgpt-agent)).
- Gemini in Chrome auto browse: Google AI Pro and Ultra, US
  ([Google](https://blog.google/products-and-platforms/products/chrome/gemini-in-chrome-android-auto-browse/)).
- Opera Neon: $19.90 a month
  ([Engadget](https://www.engadget.com/ai/operas-ai-browser-will-cost-you-20-a-month-123022110.html)).
- Browser Use: MIT library with your own model key; its cloud reports 97% on
  Online-Mind2Web, self-reported
  ([Browser Use](https://browser-use.com/posts/online-mind2web-benchmark)).
- Claude in Chrome: paid Claude plans.
- Perplexity Comet: browser free; agent limits on paid plans are not published
  as numbers.

## Rerun

```bash
node bench/freeze.mjs                                   # the same 30 tasks
# per condition: a bridge on its own port and home, the harness browser, its approve loop
ENDO_PORT=8801 ENDO_HOME=/tmp/h1 ENDO_MCP_CONFIG=/tmp/h1/mcp.json npm start
ENDO_BRIDGE_PORT=8801 ENDO_LIVE_PORT=9341 node scripts/live.ts launch
ENDO_LIVE_PORT=9341 node scripts/live.ts approve
ENDO_MCP_CONFIG=/tmp/h1/mcp.json ENDO_LIVE_PORT=9341 node bench/suite.ts claude-sonnet-5-5 claude-off
node bench/packets.mjs          # blind packets for the judges
node bench/score.mjs            # results.json and the tables
```

Cursor and Codex read their MCP address from one bridge-owned home each, which
the bridge started last rewrites, at startup only. To run both at once, copy
`~/.endo-codex/config.toml` after starting Codex's bridge, start Cursor's,
then copy it back (how `codex-off` and `cursor-off` ran on 2026-11-08).
