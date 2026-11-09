// Noteblock Next: the build Rhett uses every day, one step ahead of what users get (docs/release.md).
// It has its own name, app id, settings and update feed, and opens the same vault as Noteblock, so:
// - settings start as a copy of Noteblock's, and each new version backs up page data first
// - only one of the two runs at a time, because both would write to that vault
import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { BRAND } from "../../core/brand.mjs";

const STABLE_ID = "org.harborapps.quire";
const NEXT_ID = "org.harborapps.quire.next";
const NEXT_APP = `/Applications/${BRAND.name} Next.app`;
const WATCH_MS = 15_000;
const QUIT_WAIT_MS = 10_000;
const KEEP_BACKUPS = 5;
const COPIED = ["config.json", "ports.json", "templates"];
const SKIP_DIRS = new Set([".git", "node_modules", ".noteblock", ".quire", "dist"]);

const nextConfigDir = () => path.join(os.homedir(), ".noteblock-next");

/** Before anything reads the config. The first launch starts from Noteblock's settings. */
export function useNextConfig() {
  const dir = nextConfigDir();
  if (!fs.existsSync(path.join(dir, "config.json"))) {
    fs.mkdirSync(dir, { recursive: true });
    const stable = path.join(os.homedir(), ".noteblock");
    for (const name of COPIED) {
      const from = path.join(stable, name);
      if (fs.existsSync(from)) fs.cpSync(from, path.join(dir, name), { recursive: true });
    }
  }
  // Both names, so a CLI this app spawns reads the same config.
  process.env.NOTEBLOCK_CONFIG_DIR = dir;
  process.env.QUIRE_CONFIG_DIR = dir;
}

function dataDirs(dir, out = []) {
  let entries = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    if (!e.isDirectory() || SKIP_DIRS.has(e.name)) continue;
    const full = path.join(dir, e.name);
    if (e.name === "data") out.push(full);
    else dataDirs(full, out);
  }
  return out;
}

/**
 * Page data isn't in the vault's git history, so a bad build could lose it for good. Copied once per
 * version, before the vault opens. Returns the backup's folder, or null if this version already has one.
 */
export function backupPageData(vault, version, root = path.join(nextConfigDir(), "backups")) {
  if (!vault) return null;
  const dest = path.join(root, version.replace(/[^\w.-]/g, "_"));
  if (fs.existsSync(dest)) return null;
  const tmp = `${dest}.partial`;
  fs.rmSync(tmp, { recursive: true, force: true });
  for (const dir of dataDirs(vault)) fs.cpSync(dir, path.join(tmp, path.relative(vault, dir)), { recursive: true });
  fs.mkdirSync(tmp, { recursive: true });
  fs.writeFileSync(path.join(tmp, "from.json"), JSON.stringify({ vault, version, at: new Date().toISOString() }, null, 2));
  fs.renameSync(tmp, dest);
  const old = fs.readdirSync(root).filter((n) => !n.endsWith(".partial")).map((n) => ({ n, at: fs.statSync(path.join(root, n)).mtimeMs })).sort((a, b) => b.at - a.at);
  for (const { n } of old.slice(KEEP_BACKUPS)) fs.rmSync(path.join(root, n), { recursive: true, force: true });
  return dest;
}

const output = (file, args) =>
  new Promise((resolve) => execFile(file, args, { timeout: 3000 }, (err, stdout) => resolve(err ? "" : String(stdout))));

async function otherRunning(id) {
  return /ASN:/.test(await output("/usr/bin/lsappinfo", ["find", `bundleid=${id}`]));
}

async function quitOther(id) {
  await output("/usr/bin/osascript", ["-e", `tell application id "${id}" to quit`]);
  const until = Date.now() + QUIT_WAIT_MS;
  while (Date.now() < until && (await otherRunning(id))) await new Promise((r) => setTimeout(r, 300));
  return !(await otherRunning(id));
}

/**
 * Keeps the two apps from running together. Noteblock only looks when Noteblock Next is installed,
 * so nobody else pays for this. Resolves once it's safe to open the vault.
 */
export async function oneAtATime({ next, app, dialog }) {
  if (process.platform !== "darwin" || (!next && !fs.existsSync(NEXT_APP))) return;
  const id = next ? STABLE_ID : NEXT_ID;
  const other = next ? BRAND.name : `${BRAND.name} Next`;
  const me = next ? `${BRAND.name} Next` : BRAND.name;
  let asking = false;
  const check = async () => {
    if (asking || !(await otherRunning(id))) return;
    asking = true;
    const { response } = await dialog.showMessageBox({
      type: "warning",
      message: `${other} is open too`,
      detail: "They share your vault, so only one should run at a time.",
      buttons: [`Quit ${other}`, `Quit ${me}`],
      defaultId: 0,
      cancelId: 1,
    });
    if (response === 1 || !(await quitOther(id))) app.quit();
    asking = false;
  };
  await check();
  setInterval(check, WATCH_MS).unref?.();
}
