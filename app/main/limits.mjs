// Every limit Quire puts on pages and their backends, in one place: the defaults, the allowed
// ranges, and reading/writing them in ~/.noteblock/config.json. Settings → Activity & limits edits
// these; page recovery (main.mjs/App.jsx) and backend.mjs read them on every check, so a change
// applies without a restart. 0 turns a limit off wherever the range allows it.
import { loadConfig, saveConfig } from "../../core/index.mjs";

/**
 * Each limit: [config block, key, default, min, max, label]. `pages` and `backends` are the two
 * blocks in config.json; backends.idleMinutes / backends.maxRunning predate this file.
 */
export const LIMITS = {
  // Pages (the page's web content in the app window).
  unresponsiveSeconds: ["pages", "unresponsiveSeconds", 5, 1, 120, "Show “not responding” after (seconds)"],
  autoReloadCrashed: ["pages", "autoReloadCrashed", false, null, null, "Reload a crashed page by itself"],
  autoReloadLimit: ["pages", "autoReloadLimit", 3, 1, 20, "Stop auto-reloading after this many crashes in a minute"],
  errorBadge: ["pages", "errorBadge", true, null, null, "Show page errors in the top bar"],
  // Backends (the processes a page's .noteblock "backend.run" starts).
  idleMinutes: ["backends", "idleMinutes", 15, 0, 1440, "Stop idle backends after (minutes)"],
  maxRunning: ["backends", "maxRunning", 12, 0, 100, "Max running backends"],
  maxProcesses: ["backends", "maxProcesses", 64, 0, 4096, "Max processes per backend"],
  maxMemoryMB: ["backends", "maxMemoryMB", 1024, 0, 65536, "Max memory per backend (MB)"],
  cpuPercent: ["backends", "cpuPercent", 90, 0, 1600, "CPU limit per backend (%)"],
  cpuSeconds: ["backends", "cpuSeconds", 60, 1, 3600, "…for longer than (seconds)"],
  crashLimit: ["backends", "crashLimit", 5, 0, 100, "Give up after this many crashes"],
  crashWindowMinutes: ["backends", "crashWindowMinutes", 2, 1, 60, "…within (minutes)"],
  stopGraceSeconds: ["backends", "stopGraceSeconds", 5, 1, 60, "Force-kill a stopping backend after (seconds)"],
  checkSeconds: ["backends", "checkSeconds", 2, 1, 60, "Check backends every (seconds)"],
};

/** All limits with defaults filled in: {unresponsiveSeconds: 5, …}. */
export function limits() {
  const cfg = loadConfig();
  const out = {};
  for (const [name, [block, key, def, min, max]] of Object.entries(LIMITS)) {
    const v = (cfg[block] || {})[key];
    if (typeof def === "boolean") out[name] = typeof v === "boolean" ? v : def;
    else out[name] = typeof v === "number" && Number.isFinite(v) && v >= min && v <= max ? v : def;
  }
  return out;
}

/** For the Settings UI: [{name, block, key, value, default, min, max, label, kind}]. */
export function limitsSchema() {
  const now = limits();
  return Object.entries(LIMITS).map(([name, [block, key, def, min, max, label]]) => ({
    name, block, key, value: now[name], default: def, min, max, label, kind: typeof def === "boolean" ? "boolean" : "number",
  }));
}

/** Set some limits ({name: value}); throws a plain sentence on a bad value. Returns limits(). */
export function setLimits(patch = {}) {
  const cfg = loadConfig();
  for (const [name, value] of Object.entries(patch || {})) {
    const spec = LIMITS[name];
    if (!spec) throw new Error(`Unknown limit: ${name}`);
    const [block, key, def, min, max, label] = spec;
    let v = value;
    if (typeof def === "boolean") v = !!value;
    else {
      v = Number(value);
      if (!Number.isFinite(v) || v < min || v > max) throw new Error(`${label.replace(/\s*\(.*\)$/, "")} must be from ${min} to ${max}`);
    }
    cfg[block] = { ...(cfg[block] || {}), [key]: v };
  }
  saveConfig(cfg);
  return limits();
}

/** Put every limit back to its default. */
export function resetLimits() {
  const cfg = loadConfig();
  for (const [block, key] of Object.values(LIMITS)) if (cfg[block]) delete cfg[block][key];
  saveConfig(cfg);
  return limits();
}
