import { spawn } from "node:child_process";
import { CODEX_HOME, resolveCodex } from "./codex.ts";

/**
 * `npm run codex-login` — logs in to the bridge's own Codex home, for the same
 * reason cursor-login.ts exists: a login against `~/.codex` leaves the bridge
 * logged out with nothing on screen saying why. Importing CODEX_HOME from the
 * adapter is what keeps the login and the spawn from drifting apart.
 *
 * Interactive on purpose: it opens the browser and waits for the round trip.
 */
console.log(`logging in to ${CODEX_HOME}`);
spawn(resolveCodex(), ["login"], {
  stdio: "inherit",
  env: { ...process.env, CODEX_HOME },
}).on("close", (code) => {
  console.log(code === 0 ? "logged in — the Codex models are now selectable in the panel" : `login exited ${code}`);
  process.exitCode = code ?? 1;
});
