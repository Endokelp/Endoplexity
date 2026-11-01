import { runClaude } from "./claude.ts";
import { runCursor } from "./cursor.ts";
import { runCodex } from "./codex.ts";

/**
 * The panel picks a model, not a CLI — one dropdown, and which binary answers is
 * an implementation detail. Doubles as the allowlist: this string reaches a spawn
 * argv, so an unknown one is refused rather than being passed through.
 *
 * Its own module so the bench routes a model the same way the bridge does. The
 * bench used to guess the CLI from the id's prefix, which would have sent every
 * grok-4.7 id to claude.
 *
 * Every id was checked against the CLI on 2026-11-01. Claude ids are spelled out
 * because the aliases lag: `haiku` resolved to claude-haiku-4-5 and `sonnet` to
 * claude-sonnet-5 in the init event, not to the 5.5 models. `fable` is absent
 * because this account answers it with "out of usage credits".
 *
 * Defaults per CLI are medium tiers for the reason sonnet was the default:
 * snapshot-read-click is not hard reasoning, and the bill scales with the tier.
 */
export const MODELS: Record<string, typeof runClaude> = {
  "claude-sonnet-5-5": runClaude,
  "claude-haiku-5-5": runClaude,
  "claude-opus-5-5": runClaude,
  "grok-4.7-medium": runCursor,
  "grok-4.7-high": runCursor,
  "grok-4.7-low-fast": runCursor,
  "gemini-3.8-flash-high": runCursor,
  "gpt-5.6-sol-high": runCursor,
  "composer-2.5": runCursor,
  "gpt-6.1-sol": runCodex,
};
