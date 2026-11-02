// Installs Laya, the local decision model the reflexes can use, into its own
// venv at ~/.endo/laya: laya[serve] at the pinned version, then the checkpoint,
// so the first start does not download 1.3 GB behind the user's back. Nothing
// runs until a reflex is set to Laya in the panel; the bridge starts it then.
//
// With an NVIDIA GPU, torch comes from PyTorch's CUDA index: Laya answered a
// Gate question in about 0.1 s on an RTX 4050 and about 0.4 to 1 s on the same
// laptop's CPU, and Act's budget is 0.25 s.
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { LAYA_VERSION, REPO } from "../bridge/src/laya.ts";

const home = process.env.ENDO_HOME ?? path.join(homedir(), ".endo");
const venv = path.join(home, "laya");
const py = path.join(venv, process.platform === "win32" ? "Scripts\\python.exe" : "bin/python");
// ponytail: one CUDA build, the newest PyTorch publishes for Windows and Python
// 3.12 as of 2026-11-01. Another driver generation may want cu126.
const CUDA = { torch: "2.14.1", index: "https://download.pytorch.org/whl/cu130" };

const has = (cmd, args) => spawnSync(cmd, args, { stdio: "ignore", shell: false }).status === 0;
function run(cmd, args) {
  console.log(`> ${cmd} ${args.join(" ")}`);
  const r = spawnSync(cmd, args, { stdio: "inherit" });
  if (r.status !== 0) {
    console.error(`failed: ${cmd} exited ${r.status ?? r.error?.message}`);
    process.exit(1);
  }
}

mkdirSync(home, { recursive: true });
const uv = has("uv", ["--version"]);
const gpu = has("nvidia-smi", ["-L"]);
// pip and uv take the same package arguments; only the way in differs.
const install = (...pkgs) => (uv ? run("uv", ["pip", "install", "--python", py, ...pkgs]) : run(py, ["-m", "pip", "install", ...pkgs]));

if (uv) run("uv", ["venv", venv, "--python", "3.12", "--allow-existing"]);
else run(process.platform === "win32" ? "python" : "python3", ["-m", "venv", venv]);
// torch first, so laya's torch>=2.0 is already met and pip keeps the CUDA build.
if (gpu) install(`torch==${CUDA.torch}`, "--index-url", CUDA.index);
install(`laya[serve]==${LAYA_VERSION}`);
run(py, [
  "-c",
  `from huggingface_hub import snapshot_download\nfrom laya.revisions import PINNED_REVISIONS as P\nsnapshot_download(${JSON.stringify(REPO)}, revision=P[${JSON.stringify(REPO)}])`,
]);
// The bridge counts Laya as installed only with this beside the venv, so a
// half-finished run of this script is not mistaken for a working one.
writeFileSync(path.join(venv, ".endo-laya"), `${LAYA_VERSION}\n`);
console.log(`Laya ${LAYA_VERSION} installed in ${venv} (${gpu ? "CUDA" : "CPU"}). Pick it as a reflex backend in the panel.`);
