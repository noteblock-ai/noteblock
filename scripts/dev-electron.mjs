// `pnpm dev` launches the app through this. On a Mac the menu bar, Dock and ⌘Tab name come from
// the bundle's Info.plist, which app.setName() can't change, so an unpackaged run says
// "Electron". This keeps a copy of Electron.app named "Noteblock Dev.app" (one per Electron
// version, in node_modules/.cache), with its plist renamed and re-signed ad hoc, and runs that.
// The copy matters: pnpm hard-links node_modules files to its global store, so editing the
// original Electron.app would rename it for every project using that Electron.
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
const NAME = "Noteblock Dev";

function devBinary() {
  const bin = require("electron"); // .../Electron.app/Contents/MacOS/Electron
  if (process.platform !== "darwin") return bin;
  const app = path.resolve(bin, "..", "..", "..");
  const version = JSON.parse(fs.readFileSync(require.resolve("electron/package.json"), "utf8")).version;
  const dir = path.join(ROOT, "node_modules", ".cache", "noteblock-dev", version);
  const copy = path.join(dir, `${NAME}.app`);
  const exe = path.join(copy, "Contents", "MacOS", "Electron");
  if (fs.existsSync(exe)) return exe;
  try {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(dir, { recursive: true });
    // ditto copies the bundle as real files (no hard links back into the pnpm store) and keeps symlinks.
    execFileSync("ditto", [app, copy]);
    const plist = path.join(copy, "Contents", "Info.plist");
    for (const key of ["CFBundleName", "CFBundleDisplayName"]) {
      execFileSync("plutil", ["-replace", key, "-string", NAME, plist]);
    }
    execFileSync("codesign", ["--force", "--deep", "--sign", "-", copy], { stdio: "ignore" });
    return exe;
  } catch (err) {
    console.warn(`[dev] couldn't make ${NAME}.app (${err.message}); running Electron as is`);
    fs.rmSync(dir, { recursive: true, force: true });
    return bin;
  }
}

const child = spawn(devBinary(), [".", ...process.argv.slice(2)], { cwd: ROOT, stdio: "inherit" });
child.on("exit", (code, signal) => process.exit(signal ? 1 : code ?? 0));
for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => child.kill(sig));
