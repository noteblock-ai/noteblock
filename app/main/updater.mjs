// Updates from published releases (electron-updater, generic provider). The feed is
// siteUrl("/updates/") (core/brand.mjs) + latest-mac.yml / latest.yml, written into version.json at build time
// (scripts/write-version.mjs); the old host keeps serving the same files for 0.2.x. QUIRE_UPDATE_URL overrides it for testing. `pnpm release`
// (scripts/release.mjs) publishes the feed, the zips and the DMG.
//
// A check on launch (after 10s), every CHECK_EVERY_MS and from the menu; a found update downloads
// right away, then the toast offers "Restart to update" (quitAndInstall). Ignored, it goes in on
// the next quit (autoInstallOnAppQuit). Every step has a timeout and every error lands in
// configDir()/update.log.
//
// Background checks are silent: only "ready" reaches the person, and a failure just logs and waits
// for the next check. Anything the person asked for (the menu's check, Retry, Restart) sets
// `manual`, and then the toast also shows checking, progress and failures.
//
// States sent to the window, all with {manual}: idle | checking | current | available {version}
// (for a moment, the download starts next) | downloading {version, percent} | ready {version} |
// failed {error, log, retry: "check"|"download"}.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { BRAND } from "../../core/brand.mjs";
import { configDir } from "../../core/index.mjs";

// electron and electron-updater load on first use: ipc.mjs (which imports this) runs under plain
// node in the smoke scripts.
let autoUpdater = null;
let CancellationToken = null;
let electronApp = null;
const HERE = path.dirname(fileURLToPath(import.meta.url));
const VERSION_FILE = path.join(HERE, "version.json");
const APP_VERSION = (() => {
  try {
    return JSON.parse(fs.readFileSync(path.join(HERE, "..", "..", "package.json"), "utf8")).version;
  } catch {
    return null;
  }
})();
const isPackaged = () => !!electronApp?.isPackaged;
export const CHECK_EVERY_MS = 30 * 60 * 1000;
const CHECK_TIMEOUT_MS = 60 * 1000;
const STALL_TIMEOUT_MS = 2 * 60 * 1000; // no download progress for this long is a failure
const DOWNLOAD_TIMEOUT_MS = 30 * 60 * 1000;
const INSTALL_TIMEOUT_MS = 2 * 60 * 1000;

/** @returns {{sha?: string, branch?: string, builtAt?: string, updateUrl?: string} | null} null in dev */
export function readVersion() {
  try {
    return JSON.parse(fs.readFileSync(VERSION_FILE, "utf8"));
  } catch {
    return null;
  }
}

const logPath = () => path.join(configDir(), "update.log");
function log(level, ...parts) {
  const line = `${new Date().toISOString()} ${level} ${parts.map((p) => (p instanceof Error ? p.stack || p.message : typeof p === "string" ? p : JSON.stringify(p))).join(" ")}\n`;
  try {
    fs.mkdirSync(configDir(), { recursive: true });
    fs.appendFileSync(logPath(), line);
  } catch {
    /* nowhere to log */
  }
}

const state = {
  status: { state: "idle" },
  notify: () => {},
  configured: false,
  download: null, // {token, stall, overall}
  checking: null, // Promise while a check runs
  manual: false, // the person asked for what's running, so the toast reports it
};

function set(status) {
  state.status = { ...status, manual: state.manual };
  state.notify(state.status);
  return state.status;
}

export function updateStatus() {
  return { ...state.status, current: { ...(readVersion() || {}), version: APP_VERSION } };
}

// Noteblock Next doesn't update itself: it's ad-hoc signed, which the macOS updater refuses.
// scripts/install-next.sh (the `noteblock-next` command) installs the newest build instead.
const feedUrl = () => process.env.QUIRE_UPDATE_URL || (readVersion()?.channel === "next" ? null : readVersion()?.updateUrl) || null;

async function configure() {
  if (state.configured) return true;
  const url = feedUrl();
  if (!url) return false;
  electronApp = (await import("electron")).app;
  const pkg = (await import("electron-updater")).default;
  autoUpdater = pkg.autoUpdater;
  CancellationToken = pkg.CancellationToken;
  autoUpdater.logger = { info: (m) => log("info", m), warn: (m) => log("warn", m), error: (m) => log("error", m), debug: () => {} };
  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = true; // a downloaded update also goes in on a normal quit
  autoUpdater.allowDowngrade = false;
  autoUpdater.setFeedURL({ provider: "generic", url });
  autoUpdater.on("download-progress", (p) => {
    if (!state.download) return;
    armStall();
    set({ state: "downloading", version: state.status.version, percent: Math.floor(p.percent || 0) });
  });
  // Fired once the zip is on disk, before Squirrel.Mac has fetched and verified it (no progress
  // events during that part, so the stall timer stops; the overall timeout still applies).
  autoUpdater.on("update-downloaded", () => {
    if (state.download) clearTimeout(state.download.stall);
    if (state.status.state === "downloading") set({ ...state.status, percent: 100 });
  });
  state.configured = true;
  log("info", `${BRAND.name} ${APP_VERSION}, feed ${url}`);
  return true;
}

function fail(error, retry) {
  log("error", `${retry} failed: ${error}`);
  // Nobody asked for this one: stay quiet, the next check tries again.
  if (!state.manual) return set({ state: "idle" });
  return set({ state: "failed", error: String(error), log: logPath(), retry });
}

const withTimeout = (promise, ms, what) =>
  new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`${what} timed out after ${ms / 1000}s`)), ms);
    promise.then(
      (v) => (clearTimeout(t), resolve(v)),
      (e) => (clearTimeout(t), reject(e)),
    );
  });

async function runCheck(manual) {
  if (manual) state.manual = true;
  if (["downloading", "ready"].includes(state.status.state) || state.checking) {
    if (manual && state.status.state !== "ready") set(state.status); // a silent run becomes visible
    return state.checking || updateStatus();
  }
  if (!(await configure())) return { ...updateStatus(), error: "This build has no update feed." };
  if (!isPackaged() && !process.env.QUIRE_UPDATE_URL) return updateStatus(); // dev: never
  if (state.checking) return state.checking;
  if (!manual) state.manual = false;
  set({ state: "checking" });
  state.checking = withTimeout(autoUpdater.checkForUpdates(), CHECK_TIMEOUT_MS, "Update check")
    .then((res) => {
      const version = res?.updateInfo?.version;
      if (res?.isUpdateAvailable && version) {
        set({ state: "available", version });
        // After whoever awaited this check has seen "available".
        setImmediate(() => {
          if (state.status.state === "available") startDownload();
        });
      } else set({ state: "current" });
    })
    .catch((err) => {
      log("error", "check failed", err);
      set({ state: "idle", error: "Couldn't check for updates: " + (err?.message || err) });
    })
    .then(() => {
      state.checking = null;
      return updateStatus();
    });
  return state.checking;
}

/** The person asked (menu). Background checks go through runCheck(false). */
export function checkForUpdate() {
  return runCheck(true);
}

/** notify(status) pushes to the window. Packaged builds only (main.mjs decides). */
export function startUpdateChecks(notify) {
  state.notify = notify;
  if (!feedUrl()) return;
  setTimeout(() => runCheck(false), 10000);
  setInterval(() => runCheck(false), CHECK_EVERY_MS).unref?.();
}

function armStall() {
  const d = state.download;
  if (!d) return;
  clearTimeout(d.stall);
  d.stall = setTimeout(() => abortDownload(`Download stalled (no progress for ${STALL_TIMEOUT_MS / 60000} minutes)`), STALL_TIMEOUT_MS);
}

function endDownload() {
  const d = state.download;
  if (!d) return null;
  state.download = null;
  clearTimeout(d.stall);
  clearTimeout(d.overall);
  return d;
}

function abortDownload(reason) {
  const d = endDownload();
  if (!d) return;
  try {
    d.token.cancel();
  } catch {
    /* already done */
  }
  fail(reason, "download");
}

/** Download the version in "available". */
function startDownload() {
  if (state.download) return updateStatus();
  const version = state.status.version;
  const token = new CancellationToken();
  state.download = { token, stall: null, overall: null };
  state.download.overall = setTimeout(() => abortDownload(`Download timed out after ${DOWNLOAD_TIMEOUT_MS / 60000} minutes`), DOWNLOAD_TIMEOUT_MS);
  armStall();
  log("info", `downloading ${version}`);
  autoUpdater.downloadUpdate(token).then(
    () => {
      if (!endDownload()) return; // timed out meanwhile
      log("info", `${version} downloaded, ready to install`);
      // Not manual from here on: the toast's dismiss stands until the menu asks again.
      state.manual = false;
      set({ state: "ready", version });
    },
    (err) => {
      if (!endDownload()) return;
      fail(err?.message || err, "download");
    },
  );
  return set({ state: "downloading", version, percent: 0 });
}

/** Restart / Retry from the toast: install what's ready, else check and download. */
export async function runUpdate() {
  state.manual = true;
  if (state.status.state === "ready") return installUpdate();
  if (state.download) return set(state.status);
  if (state.status.state !== "available") {
    await checkForUpdate();
    if (state.download) return updateStatus();
    if (state.status.state !== "available") return state.status.state === "current" ? updateStatus() : fail(state.status.error || "No update found", "check");
  }
  return startDownload();
}

/** "Restart to update": quit, swap the bundle, reopen. relaunch: false only quits (tests). */
export function installUpdate({ relaunch = true } = {}) {
  if (state.status.state !== "ready") return updateStatus();
  state.manual = true; // a refused install has to say so
  log("info", `installing ${state.status.version}${relaunch ? "" : " (no relaunch)"}`);
  // Squirrel.Mac may still be verifying the new bundle; quitAndInstall waits for it.
  autoUpdater.autoRunAppAfterInstall = relaunch;
  setImmediate(() => {
    try {
      autoUpdater.quitAndInstall(false, relaunch);
    } catch (err) {
      fail(err?.message || err, "download");
    }
  });
  // Still here a while later means Squirrel refused the bundle (it logs why): say so.
  const version = state.status.version;
  const onError = (err) => {
    clearTimeout(timer);
    if (state.status.installing) fail(`Couldn't install ${version}: ${err?.message || err}`, "download");
  };
  const timer = setTimeout(() => {
    autoUpdater.removeListener("error", onError);
    if (state.status.installing) fail(`${BRAND.name} didn't restart within ${INSTALL_TIMEOUT_MS / 1000}s`, "download");
  }, INSTALL_TIMEOUT_MS);
  timer.unref?.();
  autoUpdater.once("error", onError);
  return set({ ...state.status, installing: true });
}
