import type { IncomingMessage, ServerResponse } from "node:http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import { callPanel, askPanel } from "./relay.ts";
import { check, reads, rememberApproval, resetApprovals, type Mode } from "./gate.ts";
import { remember, labelFor, labelsOf, find, hasPage } from "./page.ts";
import { keys, resolve } from "./files.ts";
import { extract, page } from "./docs.ts";
import { acted, arrived, drop, gate, pick } from "./reflexes.ts";

/**
 * The browser tools, written once. Both CLIs speak MCP, so Phase 5 gets these
 * for free — this file must never learn anything Claude-specific.
 *
 * Every handler is a relay: the bridge cannot touch Chrome, only the panel can.
 */

// Mirrors KEYS in extension/cdp.js. An enum rather than a string so a model
// guessing "Return" is corrected by the schema instead of failing at the panel.
const KEYS = ["Enter", "Tab", "Escape", "Backspace", "ArrowDown", "ArrowUp"] as const;

// The denial has to read like a tool result, not a crash — the model retried
// stale refs and slider-shaped errors fine before this, so it needs the same
// kind of plain-English steer here, telling it to stop rather than route around.
const DENIED = "blocked — the human denied this action. Do not retry it; stop and report what you were about to do.";

// A document arrives in one piece up to here, then pages with `from:` — see
// page() in docs.ts for why it is capped at all. ~8k characters is roughly 2k
// tokens and lets an ordinary CV or letter land whole, so the common case
// never costs a second call.
const READ_CAP = 8000;

// find() answers with one line instead of a list at or above this. A ranking
// cut, not odds: p is find()'s uncalibrated softmax. With the Pick reflex on
// Act, its calibrated decision replaces this cut (reflexes.ts pick()).
const CONFIDENT = 0.8;

// Shared by the two tools that ARRIVE somewhere. Reading a page is a different
// job from acting on one, and it is the job the arriving tool can do for free:
// without this a research task spends a whole extra model turn per source
// re-reading the page it was just handed — and every turn re-sends the ones
// before it. Deliberately not on click/key/back/forward: those are acting, and
// a schema field is paid on every turn by every run.
const full = z
  .boolean()
  .optional()
  .describe("Include the page's body text, for reading it rather than acting on it. Much larger — leave it off unless you need the prose.");

// The one chokepoint every tool call passes through, so the gate never has to
// be wired into five separate handlers: check the policy, ask the human if it
// says so, then relay to the panel. A tool failure the model can read is worth
// more than a dead turn: "stale ref" tells it to snapshot again, which is
// exactly the recovery we want — and a denial has to read the same way.
// Exported for gate.test.ts, which drives it directly rather than standing up
// a real MCP HTTP round trip just to see the isError shape.
const MODES = new Set<Mode>(["watch", "normal", "trust"]);
let mode: Mode | undefined;

/**
 * The human's autonomy choice for the run about to start. Anything that is not
 * one of the three known modes becomes undefined, which gate.ts treats as
 * `normal` — so a garbled message fails closed, never open.
 *
 * Clearing the approval memory here rather than from a second call in index.ts
 * is deliberate: a mode is only ever set at the start of a task, and the memory
 * is per-task, so they share one lifecycle and cannot be left out of step.
 */
export function setMode(next: unknown): void {
  mode = MODES.has(next as Mode) ? (next as Mode) : undefined;
  resetApprovals();
}

// Tools whose result is not a page: everything else in tools.js hands back the
// page it produced, and only pages may reach remember().
const NO_PAGE = new Set(["type", "tabs"]);

// The model-facing joint between an error and the page that came with it.
const FRESH = "\n\nthe page as it is now:\n";

/**
 * Read what gate.ts reads() asked for. undefined: nothing was asked. null: the
 * read failed, and check() asks the human rather than deciding on a guess:
 * an accessibility read can fail while a click still lands.
 */
async function readFor(need: "ref" | "page" | null, args: Record<string, unknown>) {
  if (!need) return undefined;
  try {
    if (need === "ref") return new Map([[String(args.ref), await callPanel("label", { ref: args.ref })]]);
    // Whole and uncut, and moving neither the model's refs nor its delta
    // baseline (cdp.js snapshot's `peek`). A frame that could not be read may
    // be where the Submit is, and not knowing is not "no".
    const page = await callPanel("snapshot", { peek: true });
    return /^\(frame \S+ unavailable:/m.test(page) ? null : labelsOf(page);
  } catch (err) {
    // Not on the page at all: the panel refuses the action itself the same
    // way, so there is nothing to weigh.
    return /^(stale|unknown) ref /.test((err as Error).message) ? new Map<string, string>() : null;
  }
}

/**
 * Ask the human if the policy says so: the denial to hand the model, or null
 * to go ahead. relay() and batch() both come through here, so a step inside a
 * batch asks exactly as the same call made on its own would.
 */
async function gated(name: string, args: Record<string, unknown>): Promise<string | null> {
  const need = reads(name, args, mode);
  const fresh = await readFor(need, args);
  let needs = check(name, args, mode, fresh);
  // The Gate reflex weighs the same fresh label the regex just did. It can add
  // a prompt the regex missed and never removes one: it is told the regex's
  // verdict, and a click already gated is only logged.
  const label = need === "ref" ? fresh?.get(String(args.ref)) : undefined;
  if (label) {
    const extra = await gate(String(args.ref), label, needs !== null);
    needs ??= extra;
  }
  if (!needs) return null;
  if (!(await askPanel(needs))) return DENIED;
  // Watch mode asks about a whole class of action, so approving one has to
  // stand for the rest of the task or it asks on every keystroke and nobody
  // uses it twice. gate.ts ignores this in `normal`, where each irreversible
  // action is meant to be answered on its own.
  rememberApproval(name, args);
  return null;
}

/**
 * One call at a time reaches the panel. A check and the action it clears must
 * meet the same page: run alongside, a use_tab between a click's read and the
 * click moved it to another tab's Submit, unasked (Phase 15 review). The model
 * can issue tool calls in parallel, so this is not hypothetical.
 * ponytail: one global lock. One tab is driven at a time anyway; Phase 21
 * (parallel runs) makes it per tab.
 */
let line: Promise<unknown> = Promise.resolve();
type Result = { content: { type: "text"; text: string }[]; isError?: boolean };
function serial(job: (task: number) => Promise<Result>): Promise<Result> {
  // The task a call belongs to is the one running when it was made, not when
  // its turn comes: a call queued behind a gate prompt can outlive a Stop.
  const task = epoch;
  const run = line.then(() => (task === epoch ? job(task) : STOPPED));
  line = run.catch(() => {});
  return run;
}

/**
 * Bumped when the human stops a task, or it ends (index.ts). Killing the CLI
 * stops new calls, not ones already in the bridge: a batch mid-way, or a call
 * waiting its turn, would go on clicking. Each checks this before it acts.
 */
let epoch = 0;
export function stop(): void {
  epoch++;
  drop();
}
const STOPPED: Result = { content: [{ type: "text", text: "stopped — the human stopped this task" }], isError: true };

export const relay = (name: string, args: Record<string, unknown>) => serial((task) => relayNow(name, args, task));

// The tools that land on a page, where the Obstacle reflex looks first.
const ARRIVALS = new Set(["navigate", "use_tab", "back", "forward"]);

async function relayNow(name: string, args: Record<string, unknown>, task: number): Promise<Result> {
  acted(args.ref);
  const denied = await gated(name, args);
  if (denied) return { content: [{ type: "text" as const, text: denied }], isError: true };
  // An approval can arrive after Stop: the prompt stays up until answered.
  if (task !== epoch) return STOPPED;
  try {
    // The label is what turns "clicked @f0e38" into "clicked Submit
    // application" in the panel. page.ts already keeps the ref->label map for
    // the gate, so this costs a lookup rather than a round trip.
    const text = await callPanel(name, args, typeof args.ref === "string" ? labelFor(args.ref) : undefined);
    if (!NO_PAGE.has(name)) remember(text);
    const swap = ARRIVALS.has(name) ? await arrived(text, () => task === epoch) : null;
    if (swap) return { content: [{ type: "text" as const, text: swap.text }], ...(swap.isError ? { isError: true } : {}) };
    return { content: [{ type: "text" as const, text }] };
  } catch (err) {
    const { message, page } = err as Error & { page?: string };
    // A failed action can carry the FRESH page (stale-ref recovery) — if that
    // page never reaches remember(), the gate's ref->label map goes stale on
    // exactly the page the model is about to act on next, and it silently
    // stops recognising a submit button. The page arrives as its own field
    // (relay.ts settle), never parsed out of the message: the message can echo
    // what the model sent, and the model must not write the gate's page.
    if (page !== undefined) remember(page);
    const text = `error: ${message}${page === undefined ? "" : FRESH + page}`;
    return { content: [{ type: "text" as const, text }], isError: true };
  }
}

const STEPS = ["click", "type", "select", "key", "scroll", "hover"] as const;
export type Step = {
  do: (typeof STEPS)[number];
  ref?: string;
  text?: string;
  value?: string;
  name?: (typeof KEYS)[number];
  direction?: "down" | "up";
};

// What each step needs, checked before the first one runs: a batch refused at
// step 9 must not already have typed into eight fields.
const NEEDS: Record<Step["do"], (keyof Step)[]> = {
  click: ["ref"],
  hover: ["ref"],
  type: ["ref", "text"],
  select: ["ref", "value"],
  key: ["name"],
  scroll: [],
};

/**
 * Many steps, one model turn. A 12-field form was 12 turns, and every turn
 * re-sends the whole conversation.
 *
 * Each step is the tool of the same name with the same args, through the same
 * gate. Steps run `quiet` (no page read, see after() in cdp.js) and ONE read at
 * the end returns the page, as a delta against the last page the model saw. By
 * ref, never coordinates: a ref does not move when the viewport does.
 */
export const batch = (steps: Step[]) => serial((task) => batchNow(steps, task));

async function batchNow(steps: Step[], task: number): Promise<Result> {
  const bad = steps.findIndex((s) => NEEDS[s.do].some((k) => s[k] === undefined));
  if (bad >= 0) {
    const { do: kind } = steps[bad];
    const text = `error: step ${bad + 1} (${kind}) needs ${NEEDS[kind].join(" and ")} — nothing ran`;
    return { content: [{ type: "text" as const, text }], isError: true };
  }

  const log: string[] = [];
  let page: string | undefined;
  let stopped = false;
  for (const [i, { do: name, ...args }] of steps.entries()) {
    const what = `${i + 1}. ${name} ${args.ref ?? args.name ?? args.direction ?? ""}`.trimEnd();
    if (task === epoch) acted(args.ref);
    const denied = task === epoch ? await gated(name, args) : null;
    if (task !== epoch) {
      log.push(`${what}: not run — the human stopped this task`);
      stopped = true;
      break;
    }
    if (denied) {
      log.push(`${what}: ${denied}`);
      stopped = true;
      break;
    }
    try {
      const label = typeof args.ref === "string" ? labelFor(args.ref) : undefined;
      log.push(`${what}: ${await callPanel(name, { ...args, quiet: true }, label)}`);
    } catch (err) {
      const { message, page: fresh } = err as Error & { page?: string };
      log.push(`${what}: error: ${message}`);
      page = fresh;
      stopped = true;
      break;
    }
  }

  let read = "";
  try {
    page ??= await callPanel("snapshot", {});
  } catch (err) {
    read = `(could not read the page: ${(err as Error).message})`;
  }
  // The page alone, never the step lines: those echo refs the model wrote.
  if (page !== undefined) remember(page);
  const head = stopped
    ? `batch stopped at step ${log.length} of ${steps.length}`
    : `batch: all ${steps.length} steps ran`;
  const text = `${head}\n${log.join("\n")}${FRESH}${page ?? read}`;
  return { content: [{ type: "text" as const, text }], ...(stopped ? { isError: true } : {}) };
}

function build() {
  const server = new McpServer({ name: "endo", version: "0.1.0" });

  server.registerTool(
    "snapshot",
    {
      description:
        "Read the current page as an indented accessibility outline. Actionable elements carry a ref like @f1e7 — pass those to click and type. Refs expire on the next snapshot or any navigation. You rarely need this: navigate, click and key already return the page they produced. Call it to re-read a page nothing has changed, or with full:true for body text.",
      inputSchema: {
        full: z
          .boolean()
          .optional()
          .describe("Include body text as well as actionable elements. Much larger — only for reading a page, not acting on it."),
        from: z
          .number()
          .int()
          .min(0)
          .optional()
          .describe("Start reading at this line, to see past a page that said it had more lines below. Refs do not change between pages of the same read."),
      },
    },
    (args) => relay("snapshot", args),
  );

  server.registerTool(
    "navigate",
    {
      description: "Point the tab at a URL, wait for the load, and return the loaded page. No snapshot needed afterwards.",
      inputSchema: { url: z.string().url().describe("Absolute URL including the scheme"), full },
    },
    (args) => relay("navigate", args),
  );

  server.registerTool(
    "click",
    {
      description:
        "Click an element with a real mouse event and return the page as it looks afterwards, with fresh refs. Takes a ref from the most recent snapshot. Do not call snapshot after this.",
      inputSchema: { ref: z.string().describe("A ref from the latest snapshot, e.g. @f1e7") },
    },
    ({ ref }) => relay("click", { ref }),
  );

  server.registerTool(
    "type",
    {
      description:
        "Focus a field and type into it one real keystroke at a time, so autocompletes and framework handlers fire. Does not clear what is already there. Returns only an acknowledgement, so fields are cheap to fill in a row — snapshot yourself if typing revealed something new.",
      inputSchema: {
        ref: z.string().describe("A ref from the latest snapshot, e.g. @f1e7"),
        text: z.string(),
      },
    },
    (args) => relay("type", args),
  );

  server.registerTool(
    "key",
    {
      description:
        "Press a single key at whatever currently has focus, e.g. Enter to submit a search box, and return the page as it looks afterwards. Do not call snapshot after this.",
      inputSchema: { name: z.enum(KEYS) },
    },
    ({ name }) => relay("key", { name }),
  );

  // The available keys are read fresh on every build() (every request, see
  // handleMcp below) — same lazy-read reasoning as files.ts itself, so a key
  // added while the bridge is running shows up in the description right away.
  const fileKeys = keys();
  // The no-files line names a recovery the human can perform in the window they
  // are already looking at, same rule as the snapshot cap notice: "add it to
  // .endo-files.json" sent people to a text editor for what is now a paperclip.
  const keysNote = fileKeys.length
    ? `Available keys: ${fileKeys.join(", ")}.`
    : "No files are available — tell the user to attach one with the paperclip in the panel's composer.";

  server.registerTool(
    "upload",
    {
      description:
        `Put one of the user's files into a file input on the page and return the page afterwards — do not call snapshot after this. Takes a KEY, never a path: only files the human attached or configured can be sent. ${keysNote} No ref needed: the real input is often hidden behind a styled button.`,
      inputSchema: {
        file: z.string().describe('A configured key, e.g. "resume" — not a file path'),
        match: z
          .string()
          .optional()
          .describe("Only needed when the page has more than one file input, which the result says — part of the wanted input's label, e.g. \"cover\""),
      },
    },
    async ({ file, match }) => {
      try {
        return await relay("upload", { path: resolve(file), match });
      } catch (err) {
        // Same rule as relay()'s own catch above: a tool failure the model
        // can read is worth more than a dead turn. resolve() throws
        // synchronously on a bad/missing key, before relay() ever runs — this
        // catch is what turns that into an isError result instead of an MCP
        // protocol error the model cannot see or recover from.
        return { content: [{ type: "text" as const, text: `error: ${(err as Error).message}` }], isError: true };
      }
    },
  );

  server.registerTool(
    "read_file",
    {
      description:
        `Read a configured document as text — pdf, docx, xlsx, pptx, csv, json, markdown or any text file. ` +
        `Takes a KEY, never a path, exactly like upload. ${keysNote} ` +
        `This is how you learn what is IN a file; upload attaches one to a form without ever reading it.`,
      inputSchema: {
        file: z.string().describe('A configured key, e.g. "resume" — not a file path'),
        from: z
          .number()
          .int()
          .min(0)
          .optional()
          .describe("Start reading at this character, to continue past a document that said it had more."),
      },
    },
    async ({ file, from }) => {
      try {
        // Deliberately not through relay(): this never touches Chrome, so
        // there is no page to return and nothing for the gate to weigh —
        // reading a file the human put in the allow-list themselves is not an
        // irreversible act. resolve() is the whole security boundary, and it
        // is the same one upload goes through.
        const text = page(await extract(resolve(file)), from, READ_CAP, file);
        return { content: [{ type: "text" as const, text }] };
      } catch (err) {
        return { content: [{ type: "text" as const, text: `error: ${(err as Error).message}` }], isError: true };
      }
    },
  );

  server.registerTool(
    "select",
    {
      description:
        "Choose an option in a NATIVE <select> and return the page afterwards — do not call snapshot after this. click cannot operate a native select: its popup is browser UI the renderer never sees. Most job forms instead use a custom combobox, which this refuses with an error telling you to click it open and click the option; that path works, so try this first and follow the error if it comes.",
      inputSchema: {
        ref: z.string().describe("A ref from the latest snapshot, e.g. @f1e7"),
        value: z.string().describe("The option's visible text or its value attribute"),
      },
    },
    (args) => relay("select", args),
  );

  server.registerTool(
    "scroll",
    {
      description:
        "Scroll the page a screenful and return it afterwards. You do NOT need this to reach something already in the snapshot — click scrolls to its target itself. Use it for content that has not loaded yet (infinite feeds, lazy lists), or pass a ref inside an open dropdown to scroll that dropdown instead of the page behind it.",
      inputSchema: {
        direction: z.enum(["down", "up"]).optional().describe("Default down"),
        ref: z
          .string()
          .optional()
          .describe("Scroll the scrollable area containing this ref, e.g. an open dropdown list, instead of the whole page"),
      },
    },
    (args) => relay("scroll", args),
  );

  server.registerTool(
    "hover",
    {
      description:
        "Move the mouse onto an element and return the page afterwards — for menus that open on hover, whose items are absent from the page until then.",
      inputSchema: { ref: z.string().describe("A ref from the latest snapshot, e.g. @f1e7") },
    },
    ({ ref }) => relay("hover", { ref }),
  );

  server.registerTool(
    "back",
    {
      description: "Go back one page in this tab's history and return the page that lands. Use it to undo a wrong click.",
      inputSchema: {},
    },
    () => relay("back", {}),
  );

  server.registerTool(
    "forward",
    { description: "Go forward one page in this tab's history and return the page that lands.", inputSchema: {} },
    () => relay("forward", {}),
  );

  server.registerTool(
    "tabs",
    {
      description:
        "List the open tabs with their ids; the one you are driving is starred. The only tool that does not return a page. Call it when a click seems to have done nothing — a link that opens a new tab leaves you on the old one.",
      inputSchema: {},
    },
    () => relay("tabs", {}),
  );

  server.registerTool(
    "use_tab",
    {
      description:
        "Switch to another tab, or open a new one, and return the page there. Every ref you are holding belongs to the tab you are leaving and stops working — read the page you get back.",
      inputSchema: {
        id: z.number().int().optional().describe("An id from tabs()"),
        url: z.string().url().optional().describe("Open a new tab here instead. Use navigate to move the tab you are already on."),
        full,
      },
    },
    (args) => relay("use_tab", args),
  );

  server.registerTool(
    "batch",
    {
      description:
        "Run up to 20 steps on refs you already have in ONE call (fill a form, tick boxes, choose options, then click) and get the page back once, at the end. Each step is the tool it names with the same arguments. Stops at the first step that fails or that the human denies, and returns the page as it is then. A step cannot use a ref that an earlier step revealed: those are not on your page yet.",
      inputSchema: {
        steps: z
          .array(
            z.object({
              do: z.enum(STEPS),
              ref: z.string().optional(),
              text: z.string().optional().describe("type"),
              value: z.string().optional().describe("select"),
              name: z.enum(KEYS).optional().describe("key"),
              direction: z.enum(["down", "up"]).optional().describe("scroll"),
            }),
          )
          .min(1)
          .max(20),
      },
    },
    ({ steps }) => batch(steps),
  );

  server.registerTool(
    "find",
    {
      description:
        'Find elements on the page you were last given from a description, e.g. "submit button" or "shipping email field", instead of reading the page again. Returns refs, most likely first, each with a probability.',
      inputSchema: {
        query: z.string().min(1),
        limit: z.number().int().min(1).max(10).optional().describe("Default 5"),
      },
    },
    async ({ query, limit }) => {
      // Answered from the page the bridge already holds, never by asking the
      // panel to read again: a read moves cdp.js's delta baseline, and one the
      // model never saw would make its next action's delta leave changes out.
      // Nor does the answer go through remember(): it is a subset of the page.
      if (!hasPage()) {
        return { content: [{ type: "text" as const, text: "error: no page read yet — navigate or snapshot first" }], isError: true };
      }
      const hits = find(query, limit);
      // Pick weighs the top 10 whatever the limit. undefined: not acting, so
      // the uncalibrated cut decides as before; null: Act abstained, list them.
      const picked = await pick(query, find(query, 10));
      const [top] = hits;
      const text = !top
        ? `nothing on the page matches "${query}" — snapshot to read it`
        : picked
          ? `best match ${picked.line} (p=${picked.p})`
          : picked === undefined && top.p >= CONFIDENT
            ? `best match ${top.line} (p=${top.p})`
            : hits.map((h) => `${h.line} (p=${h.p})`).join("\n");
      return { content: [{ type: "text" as const, text }] };
    },
  );

  return server;
}

async function readJson(req: IncomingMessage) {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const raw = Buffer.concat(chunks).toString("utf8");
  return raw ? JSON.parse(raw) : undefined;
}

/**
 * Stateless: a fresh server and transport per request. No session map to leak,
 * and two concurrent calls cannot collide on a JSON-RPC id or share a half-open
 * stream. Cheap — registering five tools costs nothing next to a page snapshot.
 */
export async function handleMcp(req: IncomingMessage, res: ServerResponse) {
  let body: unknown;
  try {
    body = req.method === "POST" ? await readJson(req) : undefined;
  } catch {
    return void res.writeHead(400, { "content-type": "application/json" }).end(
      JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } }),
    );
  }

  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  res.on("close", () => void transport.close());
  await build().connect(transport);
  await transport.handleRequest(req, res, body);
}
