import { AsyncLocalStorage } from "node:async_hooks";

/**
 * Which run a piece of work belongs to, for parallel runs (Phase 21).
 *
 * Before this, every module kept its task's state in module globals: the page
 * the gate reads, the approvals, the mode, the step log, the Stop epoch. That
 * was right while one task ran at a time. Two at once would have shared one
 * gate's map of the page and one Stop. Threading a run id through every call
 * would change every signature in the bridge; AsyncLocalStorage carries it
 * through awaits instead, so a module asks `perRun` for its state and gets the
 * current run's copy.
 *
 * The run id is set where work enters: an MCP request (its X-Endo-Run header,
 * which each CLI fills from ENDO_RUN at spawn) and the panel's messages
 * (index.ts). Code that runs outside any run, the tests and the bench among
 * it, gets the run "", which behaves exactly like the single run before.
 */
const als = new AsyncLocalStorage<string>();
const maps: Map<string, unknown>[] = [];

export const runId = (): string => als.getStore() ?? "";

export const inRun = <T>(id: string, fn: () => T): T => als.run(id, fn);

/** A module's state, one copy per run, made on first use. */
export function perRun<T>(init: () => T): () => T {
  const states = new Map<string, T>();
  maps.push(states);
  return () => {
    const id = runId();
    let state = states.get(id);
    if (state === undefined) states.set(id, (state = init()));
    return state;
  };
}

/** A closed run's state, in every module, so a long-lived bridge does not keep them all. */
export function dropRun(id: string): void {
  for (const states of maps) states.delete(id);
}

/**
 * A run id as it arrives from a header or the panel, or "" if it is not one.
 * It keys maps, names an env var's value and rides in URLs, so it is held to a
 * short plain alphabet rather than trusted as a string.
 */
export const cleanRun = (raw: unknown): string =>
  typeof raw === "string" && /^[A-Za-z0-9_-]{1,40}$/.test(raw) ? raw : "";
