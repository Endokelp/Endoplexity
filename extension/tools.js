// The panel's half of the tool path. The bridge cannot touch Chrome, so every
// MCP tool call arrives here over the WebSocket and is run against cdp.js.
//
// Names and argument shapes must match bridge/src/mcp.ts — that file declares
// the schema the model sees, this one is the implementation behind it.

import * as cdp from "./cdp.js";

// Anything that moves the page hands back the page, because a separate snapshot
// call is a whole model turn and a turn re-sends the entire conversation. `type`
// is the exception on purpose: filling a six-field form must not cost six
// snapshots, and the page rarely changes between fields. If it does — an
// autocomplete list, a field that reveals another — the model can still ask.
//
// The two tools that ARRIVE somewhere also take `full`, so a reading task gets
// the prose with the page instead of paying a second turn to re-read it. Acting
// tools deliberately do not: they run mid-form, where body text is dead weight
// that every later turn re-sends.
const TOOLS = {
  snapshot: ({ full, from, peek }) => cdp.snapshot({ full, from, peek }),
  navigate: async ({ url, full }) => {
    await cdp.navigate(url);
    const page = await cdp.snapshot({ full });
    return page.trim() ? page : cdp.emptyPage({ full });
  },
  // `quiet` never comes from the model: the bridge sets it on batch steps, see
  // after() in cdp.js for why those must not read the page.
  click: ({ ref, quiet }) => cdp.click(ref, { quiet }),
  type: async ({ ref, text }) => {
    await cdp.type(ref, text);
    return `typed ${text.length} characters into ${ref}`;
  },
  key: ({ name, quiet }) => cdp.key(name, { quiet }),
  upload: ({ path, match }) => cdp.upload(path, match),
  select: ({ ref, value, quiet }) => cdp.select(ref, value, { quiet }),
  scroll: ({ direction, ref, quiet }) => cdp.scroll(direction, ref, { quiet }),
  hover: ({ ref, quiet }) => cdp.hover(ref, { quiet }),
  back: () => cdp.go("back"),
  forward: () => cdp.go("forward"),
  // The one tool here that returns no page: a tab list is orientation, and
  // paying for a snapshot of a tab the agent may not even switch to is the
  // opposite of what "actions return the page" is for.
  tabs: () => cdp.tabs(),
  // The gate's own read, never offered to the model (mcp.ts registers no such
  // tool): what the element about to be clicked is, right now.
  label: ({ ref }) => cdp.labelOf(ref),
  use_tab: ({ id, url, full }) => cdp.useTab(id, url, { full }),
};

export async function runTool(name, args) {
  const tool = TOOLS[name];
  if (!tool) throw new Error(`unknown tool ${name} — have ${Object.keys(TOOLS).join(", ")}`);
  // The agent has no attach tool and should not need one: whichever tool runs
  // first takes the active tab.
  if (cdp.state().tabId === null) await cdp.attach();
  try {
    return String((await tool(args ?? {})) ?? "ok");
  } catch (err) {
    // A stale/unknown ref used to cost a whole model turn to recover from:
    // click -> stale -> snapshot -> click. Handing back the fresh page with
    // the error means the model can act correctly on its NEXT turn instead
    // of spending one just re-snapshotting.
    // Not for the gate's label read: the model never sees its result, so a
    // recovery read there would move the delta baseline behind its back.
    if (name === "label" || !/stale ref|unknown ref/.test(err.message)) throw err;
    let page;
    try {
      page = await cdp.snapshot();
    } catch {
      throw err; // recovery itself failed — surface the real problem, not this one
    }
    // A field of its own, never appended to the message: the message can echo
    // what the model sent (select's "no option matching ..."), and the bridge
    // parses the page into its gate. Text the model wrote must never reach that.
    throw Object.assign(new Error(err.message), { page });
  }
}
