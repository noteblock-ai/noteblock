// Install the CLI: symlink ~/.local/bin/noteblock and ~/.local/bin/quire → <repo>/cli/quire.mjs.
// Run: node scripts/setup-cli.mjs   (or pnpm setup-cli)
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const target = path.join(repo, "cli", "quire.mjs");
const binDir = path.join(os.homedir(), ".local", "bin");
const links = ["noteblock", "quire"].map((name) => path.join(binDir, name));

fs.mkdirSync(binDir, { recursive: true });
fs.chmodSync(target, 0o755);

const stat = (link) => {
  try {
    return fs.lstatSync(link);
  } catch {
    return null;
  }
};
// Check both before changing either, so a refusal leaves nothing half done.
for (const link of links) {
  const st = stat(link);
  if (st && !st.isSymbolicLink()) {
    console.error(`setup-cli: ${link} exists and is not a symlink; remove it yourself and rerun`);
    process.exit(1);
  }
}
for (const link of links) {
  if (stat(link)) fs.unlinkSync(link);
  fs.symlinkSync(target, link);
  console.log(`${link} → ${target}`);
}

// `noteblock-next`: installs the newest Noteblock Next build (scripts/install-next.sh).
const nextTarget = path.join(repo, "scripts", "install-next.sh");
const nextLink = path.join(binDir, "noteblock-next");
if (fs.existsSync(nextTarget)) fs.chmodSync(nextTarget, 0o755);
try {
  if (fs.lstatSync(nextLink).isSymbolicLink()) fs.unlinkSync(nextLink);
} catch {}
if (fs.existsSync(nextTarget) && !fs.existsSync(nextLink)) {
  fs.symlinkSync(nextTarget, nextLink);
  console.log(`${nextLink} → ${nextTarget}`);
}

const onPath = (process.env.PATH || "").split(path.delimiter).some((p) => path.resolve(p) === binDir);
console.log(onPath ? `${binDir} is on PATH; run: noteblock --help` : `${binDir} is NOT on PATH; add it, e.g. export PATH="$HOME/.local/bin:$PATH"`);
