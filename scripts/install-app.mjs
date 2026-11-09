// Build the app and copy it into /Applications. Only from an up-to-date main, so the app you use
// every day is always something that merged (--any-branch to install whatever is checked out).
// A running copy is quit first and reopened after: replacing the bundle under a live process
// crashes it. --front reopens it in front, otherwise in the background.
//
// This is Rhett's install-from-source path (signed with the keychain's Developer ID when there is
// one, not notarized). Everyone else installs the DMG; in-app updates come from published
// releases either way (app/main/updater.mjs, docs/release.md).
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { BRAND } from "../core/brand.mjs";

// An install from before the rename stays where it is, like an auto-update leaves it (Squirrel
// replaces the bundle in place): /Applications/Quire.app. A fresh one is /Applications/<name>.app.
const LEGACY_APP = "/Applications/Quire.app";
const APP = fs.existsSync(LEGACY_APP) ? LEGACY_APP : `/Applications/${BRAND.name}.app`;
const BUNDLE_ID = JSON.parse(fs.readFileSync("package.json", "utf8")).build.appId;
const args = process.argv.slice(2);
const git = (...a) => execFileSync("git", a, { encoding: "utf8" }).trim();

if (!args.includes("--any-branch")) {
  const branch = git("rev-parse", "--abbrev-ref", "HEAD");
  if (branch !== "main") {
    console.error(`On ${branch}, not main. Run ${BRAND.name} Dev for a branch (pnpm dev), or pass --any-branch.`);
    process.exit(1);
  }
  git("fetch", "-q", "origin", "main");
  if (git("rev-parse", "HEAD") !== git("rev-parse", "origin/main")) {
    console.error("main isn't at origin/main. Pull first (git pull --ff-only), or pass --any-branch.");
    process.exit(1);
  }
  if (git("status", "--porcelain", "--untracked-files=no")) {
    console.error("main has uncommitted changes. Commit or stash them, or pass --any-branch.");
    process.exit(1);
  }
}

execFileSync("pnpm", ["dist"], { stdio: "inherit" });

const running = () => {
  try {
    // -a: include our own ancestors (macOS pgrep skips them by default).
    execFileSync("pgrep", ["-a", "-f", `${APP}/Contents/MacOS/`], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
};

const wasRunning = running();
if (wasRunning) {
  execFileSync("osascript", ["-e", `quit app id "${BUNDLE_ID}"`]);
  for (let i = 0; i < 50 && running(); i++) execFileSync("sleep", ["0.2"]);
  if (running()) throw new Error(`${BRAND.name} did not quit; close it and run this again`);
}
fs.rmSync(APP, { recursive: true, force: true });
fs.cpSync(`dist/mac-arm64/${BRAND.name}.app`, APP, { recursive: true, verbatimSymlinks: true });
console.log("Installed " + APP);
if (wasRunning || args.includes("--front")) execFileSync("open", args.includes("--front") ? [APP] : ["-g", APP]);
