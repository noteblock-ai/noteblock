// Fetch the portable git Quire ships (dugite-native, the build GitHub Desktop uses) into
// build/tools/git/<platform>-<arch>/: both Mac architectures by default, the Windows ones
// (MinGit, cmd/git.exe) for a Windows build. The release and URL are pinned by
// the `dugite` devDependency (its script/embedded-git.json, checksums included); bump dugite to
// bump git. electron-builder copies both into Contents/Resources/git/ (package.json
// build.extraResources; mac.x64ArchFiles keeps the universal merge from lipo-ing them) and
// app/main/tools.mjs runs the one for process.arch. The Windows build copies win32-<arch> the
// same way (build.win.extraResources). Skips what's already there.
//   node scripts/fetch-tools.mjs                          both Mac arches
//   node scripts/fetch-tools.mjs arm64                    one (a bare arch means darwin)
//   node scripts/fetch-tools.mjs win32-x64 win32-arm64    the Windows ones
//   node scripts/fetch-tools.mjs --win                    same
import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
const embedded = require("dugite/script/embedded-git.json");
/** Bump when strip() changes, so existing folders are redone. */
const STAMP = "strip1 ";
const args = process.argv.slice(2).flatMap((a) => (a === "--win" ? ["win32-x64", "win32-arm64"] : a === "--mac" ? ["darwin-arm64", "darwin-x64"] : [a]));
const targets = (args.length ? args : ["arm64", "x64"]).map((a) => (a.includes("-") ? a : `darwin-${a}`));

for (const target of targets) {
  const entry = embedded[target];
  if (!entry) throw new Error(`dugite has no git for ${target}`);
  const out = path.join(root, "build", "tools", "git", target);
  const stamp = path.join(out, ".dugite-native");
  if (fs.existsSync(stamp) && fs.readFileSync(stamp, "utf8").trim() === STAMP + entry.name) continue;
  const cache = path.join(os.tmpdir(), "quire-tools", entry.name);
  if (!fs.existsSync(cache) || sha256(cache) !== entry.checksum) {
    console.log(`fetch-tools: downloading ${entry.name}`);
    const res = await fetch(entry.url);
    if (!res.ok) throw new Error(`fetch-tools: ${entry.url} answered ${res.status}`);
    fs.mkdirSync(path.dirname(cache), { recursive: true });
    fs.writeFileSync(cache, Buffer.from(await res.arrayBuffer()));
  }
  const sum = sha256(cache);
  if (sum !== entry.checksum) throw new Error(`fetch-tools: checksum mismatch for ${entry.name} (${sum})`);
  fs.rmSync(out, { recursive: true, force: true });
  fs.mkdirSync(out, { recursive: true });
  execFileSync("tar", ["-xzf", cache, "-C", out]);
  // On Windows, Git Credential Manager is the only credential store git has (no keychain
  // helper), so sync over https needs it: MinGit is kept whole.
  if (target.startsWith("darwin-")) strip(out);
  fs.writeFileSync(stamp, STAMP + entry.name + "\n");
  console.log(`fetch-tools: git for ${target} in ${path.relative(root, out)}`);
}

/**
 * dugite-native also carries Git Credential Manager (a .NET app, ~110 MB with its runtime),
 * git-lfs and scalar. Quire uses none of them: keep git and its own helpers only.
 */
function strip(dir) {
  const core = path.join(dir, "libexec", "git-core");
  for (const name of fs.readdirSync(core)) {
    const keep = (/^git(-|$)/.test(name) && !/^git-(credential-manager|lfs)/.test(name)) || name === "mergetools";
    if (!keep) fs.rmSync(path.join(core, name), { recursive: true, force: true });
  }
  fs.rmSync(path.join(dir, "bin", "scalar"), { force: true });
  for (const name of fs.readdirSync(core)) if (/^git-(credential-manager|lfs)/.test(name)) fs.rmSync(path.join(core, name), { force: true });
}

function sha256(file) {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}
