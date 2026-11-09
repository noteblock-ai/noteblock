// Noteblock AI, the main-process half (docs/ai.md, "Main process" and "0.3.3"). A job runs the
// agent loop against the hosting server's Messages API pass-through (noteblock.ai/api/ai/v1/messages,
// which holds the key and picks the model) and records the page edits it wants as ops on a
// snapshot. Nothing reaches the page until apply, which replays the ops on the files as they
// are then (skipping, never forcing, the ones that no longer fit) and commits them as one
// commit. Pages the job creates are written directly: nobody else is editing them.
//
// Two kinds of job: "block" (an inline /ai marker becomes an app block) and "chat" (one turn of
// a saved ⌘J conversation, ai-chats.mjs). A chat turn can also create, move and trash pages and
// change settings; those happen at once and are recorded so the turn's commit and its undo
// cover them.
//
// Plain Node apart from what it is handed: createAi({getVault, send, onWritten, onRebuild,
// trash, move, getPrefs, setPref, getShortcuts, setShortcut}). ipc.mjs wires it to IPC;
// scripts/smoke-ai.mjs drives it against a fake server.
import crypto from "node:crypto";
import fs from "node:fs";
import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import Anthropic, { APIConnectionError, APIError, APIUserAbortError } from "@anthropic-ai/sdk";
import { parse } from "node-html-parser";
import { BRAND } from "../../core/brand.mjs";
import {
  findPage,
  listTree,
  readSearchExclude,
  walkTree,
  editFile,
  createPage,
  createFolder,
  getLock,
  listLocks,
  beginEdit,
  releaseEdit,
  loadConfig,
  saveConfig,
  commitPaths,
  authorFor,
  indexBody,
  renderMarkdown,
  pageFilePath,
  buildInfo,
  isBuildOutput,
  checkMove,
  movePath,
  RENDERERS,
} from "../../core/index.mjs";
import { flushAutosaves, scheduleAutosave } from "./autosave.mjs";
import { markSelfWrite } from "./watcher.mjs";
import { hostingBase, apiToken } from "./hosting.mjs";
import { billingFake, fakeAiCredits } from "./billing-debug.mjs";
import { EDITOR_FONTS } from "./transform.mjs";
import { AI_NAME, PERMISSION_DEFAULTS, PERMISSION_VALUES, SYSTEM_PROMPT, CHAT_SYSTEM_PROMPT, toolsFor, hasTool, validateInput } from "./ai-tools.mjs";
import { shortPrompt, newChat, newTurnId, readChat, writeChat, removeChat, listChats, publicChat, trimHistory, sealTurn } from "./ai-chats.mjs";

export { shortPrompt };

// The worker replaces the model with the configured one; this is what we'd want anyway.
const MODEL = "claude-haiku-5-5";
const MAX_TOKENS = 32000;
const MAX_TURNS = 25;
const UPFRONT_BYTES = 200 * 1024;
const READ_CAP = 200 * 1024;
const FETCH_CAP = 100 * 1024;
const FETCH_TIMEOUT_MS = 15_000;
const PREVIEW_CHARS = 800;
const PREVIEW_EVERY_MS = 100;
const KEEP_JOBS = 100;
const ACTIVE = new Set(["running", "asking", "ready", "applying"]);
const SKIP_DIRS = new Set(["data", "node_modules", ".git"]);

const MSG = {
  signedOut: `Sign in to ${BRAND.name} to use ${AI_NAME}.`,
  off: `${AI_NAME} isn't on for this account.`,
  limit: `${AI_NAME} is paused until tomorrow.`,
  credits: `You're out of ${AI_NAME} credits.`,
  network: `Can't reach ${AI_NAME}. Check your connection and try again.`,
  failed: `${AI_NAME} ran into a problem. Try again.`,
  refusal: `${AI_NAME} can't help with that one.`,
  stillWorking: `${AI_NAME} is still working on the last one.`,
  offSetting: "Turned off in Settings",
};

/* ------------------------------------------------------------------ apply holds */

// A page frame's save that lands after apply (before the window reloads the frame) carries the
// old data-q-i numbering and would write its regions over the result. While an apply or undo
// runs on a page, and for a few seconds after, the page's "save" RPC is refused (ipc.mjs).
const HOLD_AFTER_MS = 3000;
/** vault\0page → hold until (ms; Infinity while running). */
const holds = new Map();

/** Is a Noteblock AI apply or undo running on this page, or just finished? */
export function isApplying(vault, pagePath) {
  const key = vault + "\0" + pagePath;
  const until = holds.get(key);
  if (until == null) return false;
  if (Date.now() < until) return true;
  holds.delete(key);
  return false;
}

function hold(vault, pages, until) {
  for (const p of pages) holds.set(vault + "\0" + p, until);
}

/* ------------------------------------------------------------------ permissions */

/** The permission map (config.json ai.permissions over the defaults). */
export function aiPermissions(cfg = loadConfig()) {
  const saved = cfg.ai && typeof cfg.ai.permissions === "object" && cfg.ai.permissions ? cfg.ai.permissions : {};
  const out = { ...PERMISSION_DEFAULTS };
  for (const key of Object.keys(out)) if (PERMISSION_VALUES.has(saved[key])) out[key] = saved[key];
  return out;
}

/** patch: {editOtherPages: "allow", …}. Unknown keys or values throw. Returns the new map. */
export function setAiPermissions(patch) {
  const p = patch && typeof patch === "object" ? patch : {};
  for (const [k, v] of Object.entries(p)) {
    if (!(k in PERMISSION_DEFAULTS)) throw new Error(`Unknown permission: ${k}`);
    if (!PERMISSION_VALUES.has(v)) throw new Error(`${k} must be allow, ask or off`);
  }
  const cfg = loadConfig();
  saveConfig({ ...cfg, ai: { ...(cfg.ai || {}), permissions: { ...aiPermissions(cfg), ...p } } });
  return aiPermissions();
}

/* ------------------------------------------------------------------ small helpers */

const readText = (abs) => {
  try {
    return fs.readFileSync(abs, "utf8");
  } catch {
    return null;
  }
};

/** Non-overlapping occurrences of `needle` in `hay`. */
function occurrences(hay, needle) {
  if (!needle) return 0;
  let n = 0;
  for (let i = hay.indexOf(needle); i !== -1; i = hay.indexOf(needle, i + needle.length)) n++;
  return n;
}

const replaceOnce = (hay, needle, value) => {
  const i = hay.indexOf(needle);
  return hay.slice(0, i) + value + hay.slice(i + needle.length);
};

const escapeRe = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** The runtime's `/ai` marker for `id` in a file: {start, end} of the whole element, or null. */
export function findMarker(html, id) {
  if (typeof html !== "string") return null;
  const re = new RegExp(`<div\\b(?=[^>]*\\sdata-q-ai\\s*=\\s*(["'])${escapeRe(id)}\\1)[^>]*>[\\s\\S]*?<\\/div\\s*>`, "i");
  const m = re.exec(html);
  return m ? { start: m.index, end: m.index + m[0].length } : null;
}

const PARSE_OPTS = { comment: true, lowerCaseTagName: false, blockTextElements: { script: true, noscript: true, style: true, pre: true } };

/** Top-level blocks in core/html.mjs indexBody numbering: [{i, html}] (html without data-q-i). */
function topBlocks(html) {
  const indexed = indexBody(html);
  const root = parse(indexed, PARSE_OPTS);
  const container = root.querySelector("body") || root.querySelector("html") || root;
  const out = [];
  for (const n of container.childNodes) {
    if (n.nodeType !== 1) continue;
    const i = n.getAttribute && n.getAttribute("data-q-i");
    if (i == null) continue;
    out.push({ i: Number(i), html: indexed.slice(n.range[0], n.range[1]).replace(/\s+data-q-i="\d+"/, "") });
  }
  return out;
}

/** data-q-i indexes of the new entry's top-level blocks whose HTML was not there before. */
export function changedIndexes(before, after, format = "html") {
  if (typeof after !== "string") return [];
  const html = (s) => (format === "md" ? renderMarkdown(s || "") : s || "");
  try {
    const old = new Set(topBlocks(html(before)).map((b) => b.html));
    return topBlocks(html(after))
      .filter((b) => !old.has(b.html))
      .map((b) => b.i);
  } catch {
    return [];
  }
}

/** The string value of `content` / `html` in a partial JSON buffer, roughly unescaped, tail only. */
export function previewOf(json) {
  const m = [...json.matchAll(/"(content|html)"\s*:\s*"/g)].pop();
  if (!m) return null;
  const ESC = { n: "\n", t: "\t", r: "", '"': '"', "\\": "\\", "/": "/", b: "", f: "" };
  let out = "";
  for (let i = m.index + m[0].length; i < json.length; i++) {
    const c = json[i];
    if (c === '"') break; // the end of the value
    if (c !== "\\") {
      out += c;
      continue;
    }
    const n = json[i + 1];
    if (n === undefined) break; // cut mid-escape
    if (n === "u") {
      const hex = json.slice(i + 2, i + 6);
      if (!/^[0-9a-fA-F]{4}$/.test(hex)) break;
      out += String.fromCharCode(parseInt(hex, 16));
      i += 5;
    } else {
      out += ESC[n] ?? n;
      i += 1;
    }
  }
  return out.length > PREVIEW_CHARS ? out.slice(-PREVIEW_CHARS) : out;
}

/** A page's own files (not data/, node_modules, dot files or build output), entry first. */
function pageFileNames(node) {
  const info = node.build ? buildInfo(node.dir) : null;
  const all = [];
  const walk = (rel) => {
    let entries = [];
    try {
      entries = fs.readdirSync(rel ? path.join(node.dir, ...rel.split("/")) : node.dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.name.startsWith(".") || SKIP_DIRS.has(e.name)) continue;
      const r = rel ? rel + "/" + e.name : e.name;
      if (e.isDirectory()) walk(r);
      else if (e.isFile() && !(info && isBuildOutput(info, r))) all.push(r);
    }
  };
  walk("");
  const first = editFile(node);
  return all.sort((a, b) => (a === first ? -1 : b === first ? 1 : a.localeCompare(b)));
}

/** A page's text files, entry first: [{rel, content}] within the byte budget, plus the rest's names. */
function pageTextFiles(node, budget = UPFRONT_BYTES) {
  const all = pageFileNames(node);
  const files = [];
  const others = [];
  let used = 0;
  for (const rel of all) {
    const abs = path.join(node.dir, ...rel.split("/"));
    let buf;
    try {
      buf = fs.readFileSync(abs);
    } catch {
      continue;
    }
    if (buf.subarray(0, 8192).includes(0) || used + buf.length > budget) {
      others.push(rel);
      continue;
    }
    used += buf.length;
    files.push({ rel, content: buf.toString("utf8") });
  }
  return { files, others };
}

function vaultListing(vault) {
  const lines = [];
  for (const n of walkTree(listTree(vault))) {
    if (n.searchExcluded) continue;
    if (lines.length >= 500) {
      lines.push("…");
      break;
    }
    if (n.kind === "folder") lines.push(`${n.path}/ (folder)`);
    else if (n.kind === "page") lines.push(n.title && n.title !== n.path.split("/").pop() ? `${n.path} (page, titled "${n.title}")` : `${n.path} (page)`);
  }
  // Left out of what the AI browses, but it can still reach them when asked by path.
  const excluded = readSearchExclude(vault);
  if (excluded.length) lines.push(`(Not listed because the user excluded them from search: ${excluded.join(", ")}. Don't bring them up unless asked; they still open by exact path.)`);
  return lines.join("\n") || "(no pages)";
}

const parentOf = (p) => p.split("/").slice(0, -1).join("/");
const nameOf = (p) => p.split("/").pop();

/** "1.2 MB" */
function size(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
}

/** Bytes under dir (data/ included; node_modules and .git not), and the newest mtime outside data/. */
function dirSize(dir) {
  let bytes = 0;
  let edited = 0;
  const walk = (d, inData) => {
    let entries = [];
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.name === "node_modules" || e.name === ".git") continue;
      const abs = path.join(d, e.name);
      if (e.isDirectory()) walk(abs, inData || (d === dir && e.name === "data"));
      else if (e.isFile()) {
        try {
          const st = fs.statSync(abs);
          bytes += st.size;
          if (!inData && e.name !== ".DS_Store") edited = Math.max(edited, st.mtimeMs);
        } catch {}
      }
    }
  };
  walk(dir, false);
  return { bytes, edited };
}

/** Rows in a page's store files (every user's), 0 when it has none. */
function dataRows(node) {
  let n = 0;
  let names = [];
  try {
    names = fs.readdirSync(path.join(node.dir, "data")).filter((f) => f.endsWith(".sqlite"));
  } catch {
    return 0;
  }
  for (const f of names) {
    let db = null;
    try {
      db = new DatabaseSync(path.join(node.dir, "data", f), { readOnly: true });
      n += Number(db.prepare("SELECT count(*) AS n FROM rows").get().n) || 0;
    } catch {
    } finally {
      try {
        db?.close();
      } catch {}
    }
  }
  return n;
}

/** vault_stats: counts, sizes, the biggest and busiest pages, the ones edited last. */
export function vaultStats(vault) {
  const pages = [];
  let folders = 0;
  for (const n of walkTree(listTree(vault))) {
    if (n.kind === "folder") folders++;
    if (n.kind !== "page") continue;
    const { bytes, edited } = dirSize(n.dir);
    pages.push({ path: n.path, bytes, edited, rows: dataRows(n) });
  }
  const groups = new Map();
  for (const p of pages) {
    const top = p.path.includes("/") ? p.path.split("/")[0] : "(top level)";
    const g = groups.get(top) || { folder: top, pages: 0, bytes: 0 };
    g.pages++;
    g.bytes += p.bytes;
    groups.set(top, g);
  }
  const total = dirSize(vault).bytes - dirSize(path.join(vault, ".noteblock")).bytes - dirSize(path.join(vault, ".quire")).bytes;
  const by = (k) => [...pages].sort((a, b) => b[k] - a[k]).slice(0, 10);
  return {
    pages: pages.length,
    folders,
    totalSize: size(total),
    totalBytes: total,
    topLevel: [...groups.values()].sort((a, b) => b.bytes - a.bytes).map((g) => ({ ...g, size: size(g.bytes) })),
    biggestPages: by("bytes").map((p) => ({ page: p.path, size: size(p.bytes), bytes: p.bytes })),
    mostDataRows: by("rows")
      .filter((p) => p.rows > 0)
      .map((p) => ({ page: p.path, rows: p.rows })),
    lastEdited: by("edited")
      .filter((p) => p.edited > 0)
      .map((p) => ({ page: p.path, edited: new Date(p.edited).toISOString() })),
  };
}

// A step goes into a chat turn's list as it starts ("Reading Trip budget") and is put in the
// past tense once the next one starts ("Read Trip budget"). "Thinking" only ever shows while current.
const PAST = [
  ["Reading ", "Read "],
  ["Looking at ", "Looked at "],
  ["Editing ", "Edited "],
  ["Writing ", "Wrote "],
  ["Deleting ", "Deleted "],
  ["Creating ", "Created "],
  ["Moving ", "Moved "],
  ["Renaming ", "Renamed "],
  ["Fetching ", "Fetched "],
  ["Changing ", "Changed "],
  ["Opening ", "Opened "],
  ["Building ", "Built "],
];
export function pastTense(step) {
  if (step === "Thinking") return null;
  for (const [now, then] of PAST) if (step.startsWith(now)) return then + step.slice(now.length);
  return step;
}

/** A page or folder move in plain words: "Moving Kyoto trip into Travel", "Renamed A to B". */
function moveText(from, to, past = false) {
  const name = nameOf(from);
  if (parentOf(from) === parentOf(to)) return `${past ? "Renamed" : "Renaming"} ${name} to ${nameOf(to)}`;
  const into = parentOf(to);
  const tail = into ? `into ${nameOf(into)}` : "to the top level";
  return `${past ? "Moved" : "Moving"} ${name}${nameOf(to) !== name ? ` (now ${nameOf(to)})` : ""} ${tail}`;
}

/* ------------------------------------------------------------------ settings */

// What change_setting may touch (docs/ai.md): the editor settings, confirmDelete and the
// shortcuts. Never sign-in, sync, keys or ai.permissions.
const EDITOR_SETTINGS = {
  textSize: { label: "Text size", type: "number", min: 13, max: 22 },
  readableWidth: { label: "Readable width", type: "boolean" },
  font: { label: "Font", type: "choice", choices: Object.keys(EDITOR_FONTS) },
  spellcheck: { label: "Spellcheck", type: "boolean" },
  defaultRenderer: { label: "Default view for new pages", type: "choice", choices: RENDERERS },
};

/** The value as the person reads it in a change line. */
function shownValue(setting, v) {
  if (setting.type === "boolean") return v ? "on" : "off";
  if (setting.type === "accelerator") return v ? String(v) : "none";
  return String(v);
}

/** The value change_setting was given, made into the setting's type, or throw. */
function settingValue(setting, value) {
  if (setting.type === "number") {
    const n = Number(value);
    if (!Number.isInteger(n) || n < setting.min || n > setting.max) throw new Error(`${setting.label} must be a whole number from ${setting.min} to ${setting.max}`);
    return n;
  }
  if (setting.type === "boolean") {
    if (typeof value === "boolean") return value;
    const s = String(value).toLowerCase();
    if (s === "true" || s === "on") return true;
    if (s === "false" || s === "off") return false;
    throw new Error(`${setting.label} is on or off: true or false`);
  }
  if (setting.type === "choice") {
    if (!setting.choices.includes(value)) throw new Error(`${setting.label} must be one of ${setting.choices.join(", ")}`);
    return value;
  }
  if (typeof value !== "string") throw new Error("A shortcut is an Electron accelerator like \"CmdOrCtrl+K\", or \"\" for none");
  return value.trim();
}

/** A page-relative path the model may write: inside the page, not data/, node_modules or a dot file. */
function writableRel(dir, rel) {
  pageFilePath(dir, rel); // throws on "..", empty
  const segs = String(rel).split("/").filter(Boolean);
  if (SKIP_DIRS.has(segs[0]) || segs.some((s) => s.startsWith("."))) throw new Error(`${rel} can't be changed`);
  return segs.join("/");
}

class Stop extends Error {}

/** An API failure as an ai-event error {code, message}. */
function errorOf(err) {
  if (err instanceof APIUserAbortError || err instanceof Stop) return { code: "stopped" };
  if (err instanceof APIConnectionError) return { code: "network", message: MSG.network };
  if (err instanceof APIError) {
    const type = err.type || err.error?.error?.type;
    const said = typeof err.error?.error?.message === "string" ? err.error.error.message : null;
    if (type === "noteblock_ai_off") return { code: "off", message: said || MSG.off };
    if (type === "noteblock_ai_limit") return { code: "limit", message: said || MSG.limit };
    if (type === "noteblock_ai_credits") return { code: "credits", message: said || MSG.credits };
    if (type === "authentication_error" || err.status === 401) return { code: "signed-out", message: MSG.signedOut };
    return { code: "failed", message: MSG.failed };
  }
  return { code: "failed", message: MSG.failed };
}

/* ------------------------------------------------------------------ the jobs */

/**
 * @param {{
 *   getVault: () => string,
 *   send?: (event: object) => void,                 // an ai-event, to every window
 *   onWritten?: (pagePath: string, sender: any) => void, // a page changed on disk
 *   onRebuild?: (vault: string, node: object) => void,   // a built page needs a build
 *   trash?: (relPath: string, opts?: {commit?: boolean}) => Promise<void>, // the app's Move to Trash
 *   move?: (from: string, to: string) => Promise<{from: string, to: string, kind: string}>, // move a page or folder
 *   getPrefs?: () => {confirmDelete: boolean, editor: object}, // Settings, as the window reads them
 *   setPref?: (key: string, value: any) => void,     // the same code as Settings
 *   getShortcuts?: () => {id: string, label: string, accelerator: string}[],
 *   setShortcut?: (id: string, accelerator: string) => void,
 * }} deps
 */
export function createAi({
  getVault,
  send = () => {},
  onWritten = () => {},
  onRebuild = () => {},
  trash = null,
  move = null,
  getPrefs = null,
  setPref = null,
  getShortcuts = null,
  setShortcut = null,
}) {
  /** @type {Map<string, any>} */
  const jobs = new Map();

  // A chat turn locks each page it is about to change, like `quire edit` does for Claude Code: the
  // app shows the page read-only with "Noteblock AI is editing this page" and the version from
  // before, and switches to the result when the lock goes (after apply, or when the turn ends).
  // Locks left by a run of the app that quit mid-turn have no job any more: release them.
  try {
    const v = getVault();
    for (const l of listLocks(v)) if (l.aiJob) releaseEdit(v, l.id);
  } catch {}

  /** A lock on `node` held by someone other than this job (its own lock is no obstacle). */
  const foreignLock = (job, node) => {
    const l = node.lock || getLock(job.vault, node.id);
    return l && !(job && l.aiJob === job.jobId) ? l : null;
  };

  /** Lock `node` for a chat turn before its first staged change (no-op for block jobs and pages it made). */
  function lockForTurn(job, node) {
    if (job.target !== "chat" || job.locks.has(node.path) || isCreated(job, node)) return;
    try {
      flushAutosaves();
    } catch {}
    beginEdit(job.vault, node.path, { by: AI_NAME, message: shortPrompt(job.prompt), force: false, extra: { aiJob: job.jobId } });
    job.locks.set(node.path, node.id);
  }

  /** Drop every lock the job holds: the page shows what's on disk again. */
  function releaseLocks(job) {
    if (!job.locks || !job.locks.size) return;
    for (const id of job.locks.values()) {
      try {
        releaseEdit(job.vault, id);
      } catch {}
    }
    job.locks.clear();
  }
  // Without the app's move (tests), the plain one: no page backends to stop then.
  const moveDep =
    move ||
    (async (from, to) => {
      try {
        flushAutosaves();
      } catch {}
      return movePath(getVault(), from, to);
    });

  const publicJob = (j) => ({
    jobId: j.jobId,
    page: j.page,
    target: j.target,
    blockId: j.blockId,
    prompt: j.prompt,
    state: j.state,
    ...(j.conversationId ? { conversationId: j.conversationId, turnId: j.turnId } : {}),
  });
  const emit = (j, type, extra = {}) => {
    try {
      send({
        jobId: j.jobId,
        page: j.page,
        target: j.target,
        blockId: j.blockId,
        prompt: j.prompt,
        ...(j.conversationId ? { conversationId: j.conversationId, turnId: j.turnId } : {}),
        type,
        ...extra,
      });
    } catch (err) {
      console.error("[quire] ai-event failed:", err.message);
    }
    if (j.chat && TURN_EVENTS.has(type)) turnEvent(j, type, extra);
  };
  const progress = (j, text, extra = {}) => {
    j.progress = text;
    emit(j, "progress", { text, ...extra });
  };

  /* ---------------------------------------------------------------- conversations */

  /** vault\0id → the conversation (messages too), one object shared by every job of it. */
  const chats = new Map();
  /** vault\0id of conversations deleted while a job of theirs still ran: never saved again. */
  const deleted = new Set();

  /** A conversation from the cache or disk (null when there is none). */
  function loadChat(vault, id) {
    const key = vault + "\0" + id;
    if (chats.has(key)) return chats.get(key);
    const c = readChat(vault, id);
    if (!c) return null;
    // First read in this run of the app: a turn still "working" ended with the last run, and
    // the undo data of every turn went with it.
    for (const t of c.turns) {
      if (t.state === "working" || t.state === "ask") {
        t.state = "stopped";
        t.ask = null;
        t.endedAt = t.endedAt || c.updated;
      }
      t.undoable = false;
    }
    chats.set(key, c);
    return c;
  }

  const turnOf = (j) => (j.chat ? j.chat.turns.find((t) => t.id === j.turnId) : null);

  /** Save the job's conversation and tell every window (the `chat` event). */
  function chatChanged(j) {
    if (!j.chat || deleted.has(j.vault + "\0" + j.chat.id)) return;
    j.chat.updated = Date.now();
    try {
      writeChat(j.vault, j.chat);
    } catch (err) {
      console.error("[quire] ai conversation save failed:", err.message);
    }
    emit(j, "chat", { conversation: publicChat(j.chat) });
  }

  /** A change the turn made, in plain words ({kind, text, page?}); the window lists them. */
  function addChange(j, change) {
    const t = turnOf(j);
    if (!t) return;
    t.changes.push(change);
    chatChanged(j);
  }

  const TURN_EVENTS = new Set(["progress", "ask", "ready", "done", "error", "stopped"]);

  /** The current step goes into the past tense, and "Thinking" goes. */
  function settleStep(t) {
    const i = t.steps.length - 1;
    if (i < 0) return;
    const past = pastTense(t.steps[i]);
    if (past == null) t.steps.pop();
    else t.steps[i] = past;
  }

  /** Keep the job's turn in step with what the job just told the windows, then save it. */
  function turnEvent(j, type, extra) {
    const t = turnOf(j);
    if (!t) return;
    if (type === "progress") {
      if (extra.text === j.lastStep) return;
      j.lastStep = extra.text;
      settleStep(t);
      t.steps.push(extra.text);
    } else if (type === "ask") {
      t.state = "ask";
      t.ask = { askId: extra.askId, title: extra.title, detail: extra.detail, permission: extra.permission };
    } else if (type === "ready") {
      t.reply = j.reply || "";
    } else {
      settleStep(t);
      t.state = type;
      t.ask = null;
      t.endedAt = Date.now();
      if (type === "error") t.error = { code: extra.code, message: extra.message };
      if (type === "done") {
        t.skipped = extra.skipped || [];
        t.undoable = t.changes.some((c) => c.kind !== "open");
      }
    }
    chatChanged(j);
  }

  function prune() {
    if (jobs.size <= KEEP_JOBS) return;
    for (const [id, j] of jobs) {
      if (jobs.size <= KEEP_JOBS) break;
      if (ACTIVE.has(j.state)) continue;
      jobs.delete(id);
      // Its undo data goes with it.
      const t = turnOf(j);
      if (t && t.undoable) {
        t.undoable = false;
        chatChanged(j);
      }
    }
    const held = new Set([...jobs.values()].filter((j) => j.chat).map((j) => j.vault + "\0" + j.chat.id));
    for (const key of chats.keys()) if (!held.has(key)) chats.delete(key);
  }

  function jobOf(jobId) {
    const j = jobs.get(String(jobId || ""));
    if (!j) throw new Error(`No ${AI_NAME} job ${jobId}`);
    return j;
  }

  /** What a job did at once and never applied still gets committed, by the next autosave. */
  function settleCreated(j) {
    for (const p of j.created) scheduleAutosave(j.vault, p);
    for (const x of j.immediate) if (x.kind !== "setting") scheduleAutosave(j.vault, null);
  }

  /** [{id, title, updated, turnCount, last}], newest first. */
  function listConversations() {
    return listChats(getVault());
  }

  function getConversation(id) {
    return publicChat(loadChat(getVault(), String(id || "")));
  }

  function deleteConversation(id) {
    const vault = getVault();
    const cid = String(id || "");
    for (const j of jobs.values()) if (j.conversationId === cid && j.vault === vault && ACTIVE.has(j.state)) stop(j.jobId);
    deleted.add(vault + "\0" + cid);
    chats.delete(vault + "\0" + cid);
    removeChat(vault, cid);
    return null;
  }

  /* ---------------------------------------------------------------- status */

  async function status() {
    const token = await apiToken();
    const out = { signedIn: false, enabled: false, limitReached: false, model: null, buildModel: null, spentTodayCents: null, limitCents: null };
    // Settings → Debug: made-up credits, no network (billing-debug.mjs).
    if (billingFake()) {
      const fake = fakeAiCredits();
      return { ...out, signedIn: true, enabled: fake.credits.left > 0, model: "claude-haiku-5-5", ...fake };
    }
    if (!token) return out;
    let res;
    try {
      res = await fetch(hostingBase() + "/api/ai/status", { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(10_000) });
    } catch {
      // Unknown: let a start find out (it ends with a network error then).
      return { ...out, signedIn: true, enabled: true, offline: true };
    }
    if (res.status === 401) return out;
    let data = {};
    try {
      data = await res.json();
    } catch {}
    if (!res.ok) return { ...out, signedIn: true, enabled: res.status !== 403, limitReached: res.status === 429 };
    const limit = Number(data.limitCents) || 0;
    const spent = Number(data.spentTodayCents) || 0;
    return {
      signedIn: true,
      enabled: !!data.enabled,
      limitReached: limit > 0 && spent >= limit,
      model: data.model || null,
      buildModel: data.buildModel || null,
      spentTodayCents: data.spentTodayCents ?? null,
      limitCents: data.limitCents ?? null,
      // Plans and billing (docs/hosting-api.md): credits replace the daily dollar limit.
      ...(data.credits && typeof data.credits === "object" ? { credits: data.credits, plan: data.plan || null } : {}),
    };
  }

  /* ---------------------------------------------------------------- start / stop / answer */

  function newJob(fields) {
    return {
      jobId: "aij_" + crypto.randomBytes(6).toString("hex"),
      state: "running",
      abort: new AbortController(),
      startedAt: Date.now(),
      snap: new Map(), // own page's files at the start: rel → content
      base: new Map(), // key → content when first seen (null = didn't exist)
      view: new Map(), // key → staged content (null = deleted)
      ops: [], // {kind: "edit"|"write"|"delete", page, rel, old_str?, new_str?, content?}
      created: new Set(), // pages it created (written directly)
      locks: new Map(), // page path → id: pages this chat turn has locked (lockForTurn)
      immediate: [], // what it did at once: {kind: "move", from, to} | {kind: "create"|"folder"|"trash", path} | {kind: "setting", key, before, after}
      block: null,
      ask: null,
      summary: "",
      reply: "",
      undo: null,
      commit: null,
      applyResult: null,
      conversationId: null,
      turnId: null,
      chat: null,
      ...fields,
    };
  }

  /** The reply to a start refused before the loop ran; the error event follows it. */
  function refuse(job, code, message) {
    job.state = "error";
    // After the reply carrying the jobId, so the window knows whose error it is.
    setTimeout(() => emit(job, "error", { code, message }), 30);
    return { jobId: job.jobId, ...(job.conversationId ? { conversationId: job.conversationId } : {}), error: { code, message } };
  }

  async function start(opts = {}) {
    // 0.3.1's targets: a "newpage" marker builds in place now, and ⌘J is the chat.
    const block = opts.target === "block" || (opts.target === "newpage" && opts.blockId);
    return block ? startBlock(opts) : startChat(opts);
  }

  async function startBlock({ page, prompt, blockId } = {}) {
    const vault = getVault();
    const text = String(prompt || "").trim();
    if (!text) throw new Error(`Say what ${AI_NAME} should do.`);
    if (!blockId) throw new Error("A block job needs its marker's id");
    const node = findPage(vault, page);
    const bid = String(blockId);
    for (const j of jobs.values()) if (j.blockId === bid && j.page === node.path && ACTIVE.has(j.state)) return { jobId: j.jobId };

    const job = newJob({ vault, page: node.path, target: "block", blockId: bid, prompt: text });
    jobs.set(job.jobId, job);
    prune();
    const lock = node.lock || getLock(vault, node.id);
    if (lock) return refuse(job, "locked", `${lock.by || "An agent"} is editing this page`);
    const token = await apiToken();
    if (!token) return refuse(job, "signed-out", MSG.signedOut);
    run(job, node, token).catch((err) => console.error("[quire] ai job failed:", err));
    return { jobId: job.jobId };
  }

  /** One turn of a conversation: a new one without conversationId. One working turn each. */
  async function startChat({ conversationId, prompt, page } = {}) {
    const vault = getVault();
    const text = String(prompt || "").trim();
    if (!text) throw new Error(`Say what ${AI_NAME} should do.`);
    let node = null;
    if (page) {
      try {
        node = findPage(vault, page);
      } catch {}
    }
    let chat;
    if (conversationId) {
      chat = loadChat(vault, String(conversationId));
      if (!chat) throw new Error("That conversation is gone.");
      for (const j of jobs.values()) if (j.conversationId === chat.id && j.vault === vault && ACTIVE.has(j.state)) throw new Error(MSG.stillWorking);
    } else {
      chat = newChat(text);
      chats.set(vault + "\0" + chat.id, chat);
      deleted.delete(vault + "\0" + chat.id);
    }

    const job = newJob({ vault, page: node ? node.path : null, target: "chat", blockId: null, prompt: text, conversationId: chat.id, turnId: newTurnId(), chat });
    jobs.set(job.jobId, job);
    chat.turns.push({
      id: job.turnId,
      jobId: job.jobId,
      prompt: text,
      page: job.page,
      at: job.startedAt,
      endedAt: null,
      state: "working",
      steps: [],
      reply: "",
      changes: [],
      skipped: [],
      ask: null,
      error: null,
      undoable: false,
    });
    prune();
    chatChanged(job);
    const token = await apiToken();
    if (!token) return refuse(job, "signed-out", MSG.signedOut);
    run(job, node, token).catch((err) => console.error("[quire] ai job failed:", err));
    return { jobId: job.jobId, conversationId: chat.id };
  }

  function stop(jobId) {
    const j = jobs.get(String(jobId || ""));
    if (!j || !ACTIVE.has(j.state) || j.state === "applying") return null;
    j.state = "stopped";
    j.abort.abort();
    if (j.ask) j.ask.resolve({ stop: true });
    releaseLocks(j);
    settleCreated(j);
    emit(j, "stopped");
    return null;
  }

  function answer(jobId, askId, allow, always = false) {
    const j = jobOf(jobId);
    if (j.ask && j.ask.askId === askId) j.ask.resolve({ allow: !!allow, always: !!allow && !!always });
    return null;
  }

  function list() {
    return [...jobs.values()].map(publicJob);
  }

  /* ---------------------------------------------------------------- the loop */

  /** A block job's one user message: the request, what to build, the page's files, the pages. */
  function firstMessage(job, node) {
    const { files, others } = pageTextFiles(node);
    for (const f of files) job.snap.set(f.rel, f.content);
    const entry = editFile(node);
    const id = job.blockId;
    const task =
      `Build what the request asks for as exactly one self-contained app block and deliver it with insert_block. ` +
      `It replaces the placeholder the user left in ${entry} (the element with data-q-ai="${id}"); don't edit the page's files. ` +
      `The block's HTML is \`<div data-app id="${id}"></div>\` followed by an inline \`<script type="module">\` that renders into document.getElementById("${id}"), importing React, createRoot and htm as usual. ` +
      `Prefix every store table and kv key with "${id}_" so it never collides with the rest of the page, and scope any CSS under #${id}.`;
    const parts = [
      `<request>\n${job.prompt}\n</request>`,
      task,
      `The page the request came from is "${node.path}"${node.title !== nameOf(node.path) ? ` (titled "${node.title}")` : ""}, a ${node.format === "md" ? "markdown" : "HTML"} page whose entry file is ${entry}.`,
      `<page_files>\n${files.map((f) => `<file path="${f.rel}">\n${f.content}\n</file>`).join("\n")}\n</page_files>`,
    ];
    if (others.length) parts.push(`Other files of this page, not shown: ${others.join(", ")}`);
    parts.push(`<pages>\n${vaultListing(job.vault)}\n</pages>`);
    return parts.join("\n\n");
  }

  /**
   * A chat turn's user message: the prompt, then the context (the open page's entry file within
   * the budget, its other files' names, the vault listing) as a second block, which
   * trimHistory stubs out once the turn is old.
   */
  function chatMessage(job, node) {
    let where = "The user has no page open.";
    const ctx = [];
    if (node) {
      const entry = editFile(node);
      const titled = node.title !== nameOf(node.path) ? ` (titled "${node.title}")` : "";
      where = `The user has the page "${node.path}"${titled} open, a ${node.format === "md" ? "markdown" : "HTML"} page whose entry file is ${entry}. "This page" means it, and tools default to it.`;
      const lock = node.lock || getLock(job.vault, node.id);
      if (lock) where += ` ${lock.by || "An agent"} is editing it right now, so it can't be changed.`;
      const content = readText(path.join(node.dir, entry));
      if (content != null && Buffer.byteLength(content) <= UPFRONT_BYTES && !content.slice(0, 8192).includes("\0")) {
        job.snap.set(entry, content);
        ctx.push(`<page_files>\n<file path="${entry}">\n${content}\n</file>\n</page_files>`);
      } else if (content != null) {
        ctx.push(`${entry} is too big to show here; read parts of it with read_file.`);
      }
      const others = pageFileNames(node).filter((f) => f !== entry);
      if (others.length) ctx.push(`Other files of this page, not shown: ${others.slice(0, 100).join(", ")}${others.length > 100 ? ", …" : ""}`);
    }
    ctx.push(`<pages>\n${vaultListing(job.vault)}\n</pages>`);
    return [
      { type: "text", text: `<request>\n${job.prompt}\n</request>\n\n${where}` },
      { type: "text", text: `<context>\n${ctx.join("\n\n")}\n</context>` },
    ];
  }

  /** The request's messages with a cache breakpoint on the last block (a copy: never saved). */
  function cacheTail(messages) {
    const last = messages.at(-1);
    if (!last) return messages;
    const blocks = typeof last.content === "string" ? [{ type: "text", text: last.content }] : last.content.slice();
    if (!blocks.length) return messages;
    blocks[blocks.length - 1] = { ...blocks[blocks.length - 1], cache_control: { type: "ephemeral" } };
    return [...messages.slice(0, -1), { ...last, content: blocks }];
  }

  async function streamTurn(job, client, messages, tools) {
    const chat = job.target === "chat";
    const stream = client.messages.stream(
      {
        model: MODEL,
        max_tokens: MAX_TOKENS,
        system: [{ type: "text", text: chat ? CHAT_SYSTEM_PROMPT : SYSTEM_PROMPT, cache_control: { type: "ephemeral" } }],
        tools,
        // A conversation's history is a long, stable prefix: cache it too.
        messages: chat ? cacheTail(messages) : messages,
      },
      { signal: job.abort.signal },
    );
    const live = job.target === "block";
    const blocks = new Map(); // index → {name, buf, at, said}
    stream.on("streamEvent", (event) => {
      try {
        if (event.type === "content_block_start" && event.content_block.type === "tool_use") {
          const name = event.content_block.name;
          blocks.set(event.index, { name, buf: "", at: 0, said: false });
          if (name === "insert_block") progress(job, "Building the block");
        } else if (event.type === "content_block_delta" && event.delta.type === "input_json_delta") {
          const b = blocks.get(event.index);
          if (!b || (b.name !== "write_file" && b.name !== "insert_block")) return;
          b.buf += event.delta.partial_json;
          if (b.name === "write_file" && !b.said) {
            const m = /"path"\s*:\s*"([^"\\]{1,200})"/.exec(b.buf);
            if (m) {
              b.said = true;
              b.path = m[1];
              if (!live) progress(job, `Writing ${m[1]}`);
            }
          }
          const now = Date.now();
          if (live && now - b.at >= PREVIEW_EVERY_MS) {
            const preview = previewOf(b.buf);
            if (preview != null) {
              b.at = now;
              b.sent = b.buf.length;
              progress(job, b.name === "insert_block" ? "Building the block" : `Writing ${b.path || "a file"}`, { preview });
            }
          }
        } else if (event.type === "content_block_stop" && live) {
          // The last of the code, which the throttle may have held back.
          const b = blocks.get(event.index);
          if (!b || !b.buf || b.sent === b.buf.length) return;
          const preview = previewOf(b.buf);
          if (preview != null) progress(job, b.name === "insert_block" ? "Building the block" : `Writing ${b.path || "a file"}`, { preview });
        }
      } catch {}
    });
    return stream.finalMessage();
  }

  async function run(job, node, token) {
    const chat = job.target === "chat";
    let messages = [];
    let from = 0; // where this turn's own messages start in `messages`
    let finished = false;
    try {
      if (node) progress(job, `Reading ${node.title || node.path}`);
      const client = new Anthropic({
        baseURL: hostingBase() + "/api/ai",
        authToken: token,
        apiKey: null,
        maxRetries: 1,
        defaultHeaders: { "x-noteblock-purpose": chat ? "chat" : "build" },
      });
      const tools = toolsFor(job.target);
      if (chat) {
        const ask = { role: "user", content: chatMessage(job, node) };
        messages = trimHistory([...job.chat.messages, ask]);
        from = messages.length - 1;
      } else {
        messages = [{ role: "user", content: firstMessage(job, node) }];
      }
      let badStreams = 0;
      for (let turn = 0; turn < MAX_TURNS && !finished; turn++) {
        if (job.state === "stopped") return;
        if (turn === 0) progress(job, "Thinking");
        let msg;
        try {
          msg = await streamTurn(job, client, messages, tools);
        } catch (err) {
          // A tool input the SDK couldn't parse at all: no tool_use to answer, so ask again.
          if (!(err instanceof APIError) && !(err instanceof Stop) && !job.abort.signal.aborted && ++badStreams <= 2) {
            turn--;
            continue;
          }
          throw err;
        }
        messages.push({ role: "assistant", content: msg.content });
        if (msg.stop_reason === "refusal") throw Object.assign(new Error("refusal"), { aiCode: "failed", aiMessage: MSG.refusal });
        const said = msg.content
          .filter((b) => b.type === "text")
          .map((b) => b.text)
          .join("\n\n")
          .trim();
        if (said) {
          const text = said.replace(/\s+/g, " ");
          job.summary = text.length > 300 ? text.slice(0, 299) + "…" : text;
          job.reply = said;
        }
        const uses = msg.content.filter((b) => b.type === "tool_use");
        if (!uses.length) {
          finished = true;
          break;
        }
        const results = [];
        for (const use of uses) {
          if (msg.stop_reason === "max_tokens") {
            results.push(toolError(use, "Your reply was cut off at the length limit before this call was complete, so it did not run. Make smaller calls, for example several edit_file calls instead of one large write_file."));
          } else {
            results.push(await runTool(job, use));
          }
          if (job.state === "stopped") return;
        }
        messages.push({ role: "user", content: results });
      }
      if (job.state === "stopped") return;
      if (job.target === "block" && !job.block) throw Object.assign(new Error("no block"), { aiCode: "failed", aiMessage: `${AI_NAME} didn't build the block. Try again.` });
      if (!job.summary) job.summary = finished ? "Done." : "Stopped after too many steps.";
      if (!job.reply) job.reply = job.summary;
      job.state = "ready";
      emit(job, "ready", { summary: job.summary });
    } catch (err) {
      if (job.state === "stopped") return;
      const e = err.aiCode ? { code: err.aiCode, message: err.aiMessage } : errorOf(err);
      if (e.code === "stopped") {
        job.state = "stopped";
        releaseLocks(job);
        settleCreated(job);
        emit(job, "stopped");
        return;
      }
      if (e.code === "failed" && !err.aiCode) console.error("[quire] ai:", err);
      job.state = "error";
      releaseLocks(job);
      settleCreated(job);
      emit(job, "error", e);
    } finally {
      // The turn's messages join the conversation, closed so the next turn's request is valid.
      if (chat && messages.length > from) {
        const note = finished ? null : job.state === "stopped" ? "(The user stopped this request before it finished.)" : job.state === "ready" ? "(Stopped after too many steps.)" : "(This request failed before it finished.)";
        job.chat.messages.push(...sealTurn(messages.slice(from), note || "(Done.)"));
        chatChanged(job);
      }
    }
  }

  /* ---------------------------------------------------------------- tools */

  const toolError = (use, message) => ({ type: "tool_result", tool_use_id: use.id, is_error: true, content: String(message) });

  async function runTool(job, use) {
    const name = use.name;
    if (!hasTool(job.target, name)) return toolError(use, `${name} isn't available for this request.`);
    // Eager input streaming: the API didn't validate the input, and the SDK's parser is tolerant.
    let input = use.input;
    const raw = use.__json_buf;
    if (typeof raw === "string" && raw.trim()) {
      try {
        input = JSON.parse(raw);
      } catch {
        return toolError(use, JSON.stringify({ INVALID_JSON: raw }));
      }
    }
    const bad = validateInput(name, input);
    if (bad) return toolError(use, `Invalid input for ${name}: ${bad}`);
    try {
      const out = await TOOLS[name](job, input);
      return { type: "tool_result", tool_use_id: use.id, content: typeof out === "string" ? out : JSON.stringify(out) };
    } catch (err) {
      if (err instanceof Stop || job.abort.signal.aborted) {
        if (job.state !== "stopped") stop(job.jobId);
        return toolError(use, "Stopped.");
      }
      return toolError(use, (err && err.message) || String(err));
    }
  }

  /** Clear a step set to Ask with the person, or throw. */
  async function permit(job, key, title, detail) {
    const v = aiPermissions()[key];
    if (v === "allow") return;
    if (v === "off") throw new Error(MSG.offSetting);
    const askId = "ask_" + crypto.randomBytes(4).toString("hex");
    const was = job.state;
    job.state = "asking";
    const got = await new Promise((resolve) => {
      job.ask = { askId, resolve };
      emit(job, "ask", { askId, title, detail, permission: key });
    });
    job.ask = null;
    if (got.stop) throw new Stop();
    job.state = was === "asking" ? "running" : was;
    const t = turnOf(job);
    if (t) {
      t.state = "working";
      t.ask = null;
      chatChanged(job);
    }
    if (got.always) setAiPermissions({ [key]: "allow" });
    if (!got.allow) throw new Error("The person said no, so this step was skipped.");
  }

  /** The page a tool call means: `page`, else the request's page (the one open in a chat). */
  function pageFor(job, ref) {
    if (ref) return findPage(job.vault, ref);
    if (!job.page) throw new Error("No page is open; say which page with page.");
    return findPage(job.vault, job.page);
  }

  const keyOf = (pagePath, rel) => pagePath + "\0" + rel;

  /** The content a job sees for a file: staged, else as first seen (the snapshot for its own page). */
  function seen(job, node, rel) {
    const key = keyOf(node.path, rel);
    if (job.view.has(key)) return job.view.get(key);
    if (!job.base.has(key)) {
      const own = node.path === job.page && job.snap.has(rel);
      job.base.set(key, own ? job.snap.get(rel) : readText(pageFilePath(node.dir, rel)));
    }
    return job.base.get(key);
  }

  const isCreated = (job, node) => job.created.has(node.path);
  /** A file in a progress line. A chat names the page ("Trip budget", "Trip budget/style.css"). */
  const label = (job, node, rel) => {
    if (job.target === "chat") return rel === editFile(node) || rel === node.entry ? node.title || node.path : `${node.title || node.path}/${rel}`;
    return node.path === job.page || isCreated(job, node) ? rel : `${rel} in ${node.title || node.path}`;
  };

  /** Gate a change to `node`: its own page is editPage, another page editOtherPages, a page it made free. */
  async function permitWrite(job, node, rel, verb) {
    if (isCreated(job, node)) return;
    const lock = foreignLock(job, node);
    if (lock) throw new Error(`${lock.by || "An agent"} is editing ${node.path}`);
    if (node.path === job.page) await permit(job, "editPage", `Change ${node.title || node.path}?`, `${AI_NAME} wants to ${verb} ${rel}.`);
    else await permit(job, "editOtherPages", `Change ${node.title || node.path}?`, `${AI_NAME} wants to ${verb} ${rel} in ${node.path}.`);
    lockForTurn(job, node);
  }

  async function permitRead(job, node) {
    if (node.path === job.page || isCreated(job, node)) return;
    return permit(job, "readPages", `Read ${node.title || node.path}?`, `${AI_NAME} wants to read ${node.path}.`);
  }

  /** A page this job created: written to disk now. */
  function writeDirect(job, node, rel, content) {
    const abs = pageFilePath(node.dir, rel);
    if (content === null) fs.rmSync(abs, { force: true });
    else {
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, content);
    }
    // Not marked as our own write: the watcher tells a window showing this page to reload.
  }

  /** A setting change_setting may change: {key, section, label, type, …}, or throw. */
  function settingOf(key) {
    if (!getPrefs || !setPref) throw new Error("Changing settings isn't available here");
    if (key.startsWith("editor.") && Object.hasOwn(EDITOR_SETTINGS, key.slice(7))) return { key, name: key.slice(7), section: "Editor", ...EDITOR_SETTINGS[key.slice(7)] };
    if (key === "confirmDelete") return { key, section: "General", label: "Ask before moving to the Trash", type: "boolean" };
    if (key.startsWith("shortcut.")) {
      const sc = (getShortcuts ? getShortcuts() : []).find((x) => x.id === key.slice(9));
      if (!sc || !setShortcut) throw new Error(`No shortcut ${key.slice(9)}; get_settings lists them`);
      return { key, id: sc.id, section: "Shortcuts", label: sc.label, type: "accelerator" };
    }
    throw new Error(`${key} isn't a setting ${AI_NAME} can change; get_settings lists the ones it can`);
  }

  function readSetting(s) {
    if (s.type === "accelerator") return (getShortcuts().find((x) => x.id === s.id) || {}).accelerator || "";
    const prefs = getPrefs();
    return s.key === "confirmDelete" ? prefs.confirmDelete : prefs.editor[s.name];
  }

  /** Through the same code as Settings (ipc.mjs): saved, pushed into open pages, menu rebuilt. */
  function writeSetting(s, value) {
    if (s.type === "accelerator") setShortcut(s.id, value);
    else setPref(s.key, value);
  }

  /** Point every running job of this vault at a page's new path after a move. */
  function remapJobs(vault, from, to) {
    const re = (p) => (p === from ? to : typeof p === "string" && p.startsWith(from + "/") ? to + p.slice(from.length) : p);
    const reKey = (m) => new Map([...m].map(([k, v]) => [re(k.split("\0")[0]) + "\0" + k.split("\0")[1], v]));
    for (const j of jobs.values()) {
      if (j.vault !== vault || !(ACTIVE.has(j.state) || j.state === "done")) continue;
      for (const op of j.ops) op.page = re(op.page);
      j.base = reKey(j.base);
      j.view = reKey(j.view);
      j.created = new Set([...j.created].map(re));
      // So undo trashes a created page where it is now (moves keep their own history).
      for (const x of j.immediate) if (x.kind === "create" || x.kind === "folder") x.path = re(x.path);
      if (j.page) {
        j.page = re(j.page);
        const t = turnOf(j);
        if (t && j.state !== "done") t.page = j.page;
      }
    }
  }

  /** Move a page or folder now (the app's move: autosaves flushed, backends and stores closed). */
  async function moveNow(job, from, to) {
    const m = await moveDep(from, to);
    remapJobs(job.vault, m.from, m.to);
    emit(job, "moved", { from: m.from, to: m.to });
    return m;
  }

  const TOOLS = {
    async read_file(job, { page, path: rel }) {
      const node = pageFor(job, page);
      await permitRead(job, node);
      const clean = String(rel).split("/").filter(Boolean).join("/");
      pageFilePath(node.dir, clean);
      if (clean.split("/")[0] === "data") throw new Error("data/ holds the page's database, not text");
      const content = isCreated(job, node) ? readText(pageFilePath(node.dir, clean)) : seen(job, node, clean);
      if (content == null) throw new Error(`No file ${clean} in ${node.path}`);
      if (content.slice(0, 8192).includes("\0")) throw new Error(`${clean} isn't a text file`);
      if (Buffer.byteLength(content) > READ_CAP) throw new Error(`${clean} is over 200 KB`);
      progress(job, node.path === job.page && job.target !== "chat" ? `Reading ${clean}` : `Reading ${node.title || node.path}`);
      return content;
    },

    async list_files(job, { page }) {
      const node = pageFor(job, page);
      await permitRead(job, node);
      const out = [];
      const walk = (rel) => {
        let entries = [];
        try {
          entries = fs.readdirSync(rel ? path.join(node.dir, ...rel.split("/")) : node.dir, { withFileTypes: true });
        } catch {
          return;
        }
        for (const e of entries) {
          if (e.name === "node_modules" || e.name === ".git" || e.name === ".DS_Store") continue;
          const r = rel ? rel + "/" + e.name : e.name;
          if (e.isDirectory()) walk(r);
          else if (e.isFile()) out.push(`${r} (${fs.statSync(path.join(node.dir, ...r.split("/"))).size} bytes)`);
        }
      };
      walk("");
      // Files this job wrote but hasn't applied yet.
      for (const [key, v] of job.view) {
        const [p, rel] = key.split("\0");
        if (p === node.path && v !== null && !out.some((l) => l.startsWith(rel + " ("))) out.push(`${rel} (new, not applied yet)`);
      }
      progress(job, `Looking at ${node.title || node.path}`);
      return out.join("\n") || "(no files)";
    },

    async list_pages(job) {
      progress(job, "Looking at your pages");
      return vaultListing(job.vault);
    },

    async vault_stats(job) {
      progress(job, "Looking at your vault");
      return vaultStats(job.vault);
    },

    async get_settings(job) {
      if (!getPrefs) throw new Error("Settings aren't available here");
      progress(job, "Looking at your settings");
      const prefs = getPrefs();
      const out = [];
      for (const [name, s] of Object.entries(EDITOR_SETTINGS)) {
        out.push({ key: `editor.${name}`, label: `Editor › ${s.label}`, value: prefs.editor[name], ...(s.type === "number" ? { min: s.min, max: s.max } : s.type === "choice" ? { choices: s.choices } : { type: s.type }) });
      }
      out.push({ key: "confirmDelete", label: "General › Ask before moving to the Trash", value: prefs.confirmDelete, type: "boolean" });
      for (const sc of getShortcuts ? getShortcuts() : []) out.push({ key: `shortcut.${sc.id}`, label: `Shortcuts › ${sc.label}`, value: sc.accelerator, default: sc.default });
      return out;
    },

    async change_setting(job, { key, value }) {
      const s = settingOf(String(key));
      const next = settingValue(s, value);
      const before = readSetting(s);
      if (before === next) return `${s.label} is already ${shownValue(s, next)}.`;
      await permit(job, "changeSettings", `Change ${s.label}?`, `${AI_NAME} wants to set ${s.section} › ${s.label} to ${shownValue(s, next)}.`);
      progress(job, `Changing ${s.label}`);
      writeSetting(s, next);
      const after = readSetting(s);
      job.immediate.push({ kind: "setting", key: s.key, before, after });
      addChange(job, { kind: "setting", text: `Settings › ${s.section}: ${s.label}, ${shownValue(s, before)} → ${shownValue(s, after)}` });
      emit(job, "settings", { keys: [s.key] });
      return `Set ${s.section} › ${s.label} to ${shownValue(s, after)}.`;
    },

    async move_page(job, { from, to }) {
      const m = checkMove(job.vault, from, to);
      const rename = parentOf(m.from) === parentOf(m.to);
      await permit(
        job,
        "movePages",
        `${rename ? "Rename" : "Move"} ${nameOf(m.from)}?`,
        rename ? `${AI_NAME} wants to rename ${m.from} to ${nameOf(m.to)}.` : `${AI_NAME} wants to move ${m.from} to ${m.to}.`,
      );
      progress(job, moveText(m.from, m.to));
      const done = await moveNow(job, m.from, m.to);
      job.immediate.push({ kind: "move", from: done.from, to: done.to });
      for (const p of done.relinked || []) job.immediate.push({ kind: "relink", path: p });
      addChange(job, { kind: "move", text: moveText(done.from, done.to, true), ...(done.kind === "page" ? { page: done.to } : {}) });
      return `Moved ${done.from} to ${done.to}.`;
    },

    async edit_file(job, { page, path: rel, old_str, new_str }) {
      const node = pageFor(job, page);
      const clean = writableRel(node.dir, rel);
      await permitWrite(job, node, clean, "edit");
      if (!old_str) throw new Error("old_str is empty. Use write_file to create a file.");
      const cur = isCreated(job, node) ? readText(pageFilePath(node.dir, clean)) : seen(job, node, clean);
      if (cur == null) throw new Error(`No file ${clean} in ${node.path}`);
      const n = occurrences(cur, old_str);
      if (n === 0) throw new Error(`old_str wasn't found in ${clean}. Read the file again and copy the text exactly.`);
      if (n > 1) throw new Error(`old_str occurs ${n} times in ${clean}. Include more of the surrounding text so it matches once.`);
      const next = replaceOnce(cur, old_str, new_str);
      progress(job, `Editing ${label(job, node, clean)}`);
      if (isCreated(job, node)) writeDirect(job, node, clean, next);
      else {
        job.ops.push({ kind: "edit", page: node.path, rel: clean, old_str, new_str });
        job.view.set(keyOf(node.path, clean), next);
      }
      return `Edited ${clean}.`;
    },

    async write_file(job, { page, path: rel, content }) {
      const node = pageFor(job, page);
      const clean = writableRel(node.dir, rel);
      await permitWrite(job, node, clean, "write");
      progress(job, `Writing ${label(job, node, clean)}`);
      if (isCreated(job, node)) writeDirect(job, node, clean, content);
      else {
        seen(job, node, clean); // records what was there (the base apply compares with)
        job.ops.push({ kind: "write", page: node.path, rel: clean, content });
        job.view.set(keyOf(node.path, clean), content);
      }
      return `Wrote ${clean} (${Buffer.byteLength(content)} bytes).`;
    },

    async delete_file(job, { page, path: rel }) {
      const node = pageFor(job, page);
      const clean = writableRel(node.dir, rel);
      if (clean === node.entry || clean === editFile(node)) throw new Error(`${clean} is the page itself; use trash_page to remove a page`);
      const cur = isCreated(job, node) ? readText(pageFilePath(node.dir, clean)) : seen(job, node, clean);
      if (cur == null) throw new Error(`No file ${clean} in ${node.path}`);
      if (!isCreated(job, node)) {
        await permitWrite(job, node, clean, "delete");
        await permit(job, "deleteFiles", `Delete ${clean}?`, `${AI_NAME} wants to delete ${clean} from ${node.path}.`);
      }
      progress(job, `Deleting ${label(job, node, clean)}`);
      if (isCreated(job, node)) writeDirect(job, node, clean, null);
      else {
        job.ops.push({ kind: "delete", page: node.path, rel: clean });
        job.view.set(keyOf(node.path, clean), null);
      }
      return `Deleted ${clean}.`;
    },

    async create_page(job, { path: p, format }) {
      await permit(job, "createPages", `Create ${p}?`, `${AI_NAME} wants to make a new page, ${p}.`);
      const node = createPage(job.vault, p, { format: format === "md" ? "md" : "html" });
      job.created.add(node.path);
      job.immediate.push({ kind: "create", path: node.path });
      progress(job, `Creating ${nameOf(node.path)}`);
      addChange(job, { kind: "create", text: `Created ${nameOf(node.path)}`, page: node.path });
      return `Created the page "${node.path}". Its entry file is ${node.entry} (a blank page). Write its files with page set to "${node.path}".`;
    },

    async create_folder(job, { path: p }) {
      await permit(job, "createPages", `Create the folder ${p}?`, `${AI_NAME} wants to make a new folder, ${p}.`);
      const f = createFolder(job.vault, p);
      job.immediate.push({ kind: "folder", path: f.path });
      progress(job, `Creating ${nameOf(f.path)}`);
      addChange(job, { kind: "folder", text: `Created folder ${nameOf(f.path)}` });
      return `Created the folder "${f.path}".`;
    },

    async open_page(job, { page, new_tab }) {
      const node = findPage(job.vault, page);
      await permit(job, "openPages", `Open ${node.title || node.path}?`, `${AI_NAME} wants to show you ${node.path}.`);
      emit(job, "open", { page: node.path, newTab: !!new_tab });
      addChange(job, { kind: "open", text: `Opened ${node.title || nameOf(node.path)}`, page: node.path });
      return `Opened ${node.path}.`;
    },

    async trash_page(job, { page }) {
      if (!trash) throw new Error("Moving pages to the Trash isn't available here");
      const rel = String(page).split("/").filter(Boolean).join("/");
      if (!rel) throw new Error("Which page?");
      let st = null;
      try {
        st = fs.statSync(path.join(job.vault, ...rel.split("/")));
      } catch {}
      if (!st) throw new Error(`No page or folder ${rel}`);
      if (!st.isDirectory()) throw new Error(`${rel} isn't a page or folder; delete_file removes a file of a page`);
      await permit(job, "trashPages", `Move ${rel} to the Trash?`, `${AI_NAME} wants to move ${rel} to the Trash.`);
      progress(job, `Moving ${nameOf(rel)} to the Trash`);
      // The turn's commit takes the removal along with everything else it did.
      await trash(rel, { commit: false });
      for (const p of [...job.created]) if (p === rel || p.startsWith(rel + "/")) job.created.delete(p);
      job.immediate.push({ kind: "trash", path: rel });
      addChange(job, { kind: "trash", text: `Moved ${nameOf(rel)} to the Trash` });
      return `Moved ${rel} to the Trash.`;
    },

    async fetch_url(job, { url }) {
      let u;
      try {
        u = new URL(url);
      } catch {
        throw new Error("That isn't a URL");
      }
      if (u.protocol !== "http:" && u.protocol !== "https:") throw new Error("Only http and https URLs");
      await permit(job, "fetchWeb", `Fetch ${u.host}?`, `${AI_NAME} wants to load ${u.href}.`);
      progress(job, `Fetching ${u.host}`);
      let res;
      try {
        res = await fetch(u, { redirect: "follow", signal: AbortSignal.any([job.abort.signal, AbortSignal.timeout(FETCH_TIMEOUT_MS)]) });
      } catch (err) {
        if (job.abort.signal.aborted) throw new Stop();
        throw new Error(`Couldn't load ${u.href}: ${err.message}`);
      }
      let text = await res.text();
      const cut = Buffer.byteLength(text) > FETCH_CAP;
      if (cut) text = Buffer.from(text).subarray(0, FETCH_CAP).toString("utf8");
      return `HTTP ${res.status} ${res.headers.get("content-type") || ""}\n\n${text}${cut ? "\n…(cut at 100 KB)" : ""}`;
    },

    async insert_block(job, { html, files }) {
      const node = findPage(job.vault, job.page);
      await permitWrite(job, node, editFile(node), "build a block in");
      const h = String(html).trim();
      if (!/\sdata-app\b/i.test(h)) throw new Error("The block's HTML needs its container element with data-app.");
      if (/data-q-ai\s*=/.test(h)) throw new Error("The block must not contain the placeholder.");
      const extra = {};
      for (const [rel, content] of Object.entries(files || {})) {
        const clean = writableRel(node.dir, rel);
        if (clean === node.entry || clean === editFile(node)) throw new Error(`${clean} is the page's entry; the block's HTML goes in html`);
        seen(job, node, clean);
        extra[clean] = content;
      }
      job.block = { html: h, files: extra };
      progress(job, "Block ready");
      return "Got the block. Finish with one short sentence saying what you built.";
    },
  };

  /* ---------------------------------------------------------------- apply / undo */

  async function apply(jobId, { sender = null } = {}) {
    const job = jobOf(jobId);
    // A second call (the window retrying, two windows) gets the first call's result.
    if (job.applyResult) return job.applyResult;
    if (job.state !== "ready") throw new Error(`Nothing to apply (${job.state})`);
    job.state = "applying";
    // A chat job may have no page open (job.page null).
    const held = new Set([job.page, ...job.ops.map((o) => o.page)].filter(Boolean));
    hold(job.vault, held, Infinity);
    try {
      job.applyResult = applyNow(job, sender);
      return job.applyResult;
    } catch (err) {
      hold(job.vault, held, Date.now() + HOLD_AFTER_MS);
      job.state = "error";
      releaseLocks(job);
      emit(job, "error", { code: "failed", message: `${AI_NAME} couldn't save the changes: ${err.message}` });
      throw err;
    }
  }

  function applyNow(job, sender) {
    const vault = job.vault;
    // The person's own last edits get their own commit first (they're on disk: the window
    // flushed the page's save before calling apply).
    try {
      flushAutosaves();
    } catch {}
    const nodes = new Map();
    const nodeOf = (p) => {
      if (!nodes.has(p)) nodes.set(p, findPage(vault, p));
      return nodes.get(p);
    };
    const absOf = (key) => {
      const [p, rel] = key.split("\0");
      return pageFilePath(nodeOf(p).dir, rel);
    };
    const disk = new Map(); // key → content when apply began
    const atStart = (key) => {
      if (!disk.has(key)) disk.set(key, readText(absOf(key)));
      return disk.get(key);
    };
    const work = new Map(); // key → content to write (null = remove)
    const current = (key) => (work.has(key) ? work.get(key) : atStart(key));
    const skipped = [];
    let applied = 0;

    const ops = [...job.ops];
    if (job.block) for (const [rel, content] of Object.entries(job.block.files)) ops.push({ kind: "write", page: job.page, rel, content });
    for (const op of ops) {
      const key = keyOf(op.page, op.rel);
      const file = op.page === job.page ? op.rel : `${op.page}/${op.rel}`;
      let node;
      try {
        node = nodeOf(op.page);
      } catch {
        skipped.push({ file, reason: "The page is gone" });
        continue;
      }
      const lock = foreignLock(job, node);
      if (lock) {
        skipped.push({ file, reason: `${lock.by || "An agent"} is editing ${node.path}` });
        continue;
      }
      if (op.kind === "edit") {
        const cur = current(key);
        const n = cur == null ? 0 : occurrences(cur, op.old_str);
        if (n !== 1) {
          skipped.push({ file, reason: n === 0 ? "The text it changed was edited or removed" : "The text it changed now appears more than once" });
          continue;
        }
        work.set(key, replaceOnce(cur, op.old_str, op.new_str));
      } else {
        if (atStart(key) !== job.base.get(key)) {
          skipped.push({ file, reason: `The file changed after ${AI_NAME} read it` });
          continue;
        }
        work.set(key, op.kind === "write" ? op.content : null);
      }
      applied++;
    }

    // The page the request came from: the block's page, the page open in a chat (or none, or
    // gone by now: trashed in this very turn).
    let entryNode = null;
    try {
      if (job.page) entryNode = nodeOf(job.page);
    } catch {}
    const entryKey = entryNode ? keyOf(job.page, editFile(entryNode)) : null;
    // The /ai marker becomes the block.
    if (job.blockId) {
      const cur = entryKey ? current(entryKey) : null;
      const m = findMarker(cur, job.blockId);
      if (!m) {
        // The person deleted the placeholder: the job ends, nothing of it lands.
        job.state = "stopped";
        settleCreated(job);
        hold(vault, [job.page], Date.now() + HOLD_AFTER_MS);
        emit(job, "stopped");
        return { applied: 0, skipped: [], summary: job.summary, changed: [], commit: null, stopped: true };
      }
      work.set(entryKey, cur.slice(0, m.start) + job.block.html + cur.slice(m.end));
      applied++;
    }

    const undo = [];
    const touched = new Set();
    const paths = [];
    for (const [key, next] of work) {
      const before = atStart(key);
      if (next === before) continue;
      const abs = absOf(key);
      markSelfWrite(abs);
      if (next === null) fs.rmSync(abs, { force: true });
      else {
        fs.mkdirSync(path.dirname(abs), { recursive: true });
        fs.writeFileSync(abs, next);
      }
      const [p, rel] = key.split("\0");
      undo.push({ key, page: p, rel, abs, before, after: next });
      touched.add(p);
      paths.push(p + "/" + rel);
    }
    for (const p of job.created) paths.push(p);
    // What a chat turn did at once goes in the same commit: both ends of a move, new folders, trash.
    for (const x of job.immediate) {
      if (x.kind === "move") paths.push(x.from, x.to);
      else if (x.path) paths.push(x.path);
    }
    if (job.target === "chat") recordFileChanges(job, undo, nodeOf);

    let commit = null;
    try {
      commit = commitPaths(vault, `${AI_NAME}: ${shortPrompt(job.prompt)}`, paths, { author: authorFor(AI_NAME) });
    } catch (err) {
      console.error("[quire] ai commit failed:", err.message);
      for (const p of touched) scheduleAutosave(vault, p);
    }
    const changed = entryNode ? changedIndexes(atStart(entryKey), current(entryKey), /\.md$/i.test(editFile(entryNode)) ? "md" : "html") : [];

    job.undo = undo;
    job.commit = commit;
    job.state = "done";
    releaseLocks(job);
    for (const p of new Set([...touched, ...job.created])) {
      try {
        onRebuild(vault, findPage(vault, p));
      } catch {}
      onWritten(p, sender);
    }
    hold(vault, new Set([job.page, ...job.ops.map((o) => o.page)].filter(Boolean)), Date.now() + HOLD_AFTER_MS);
    emit(job, "done", { summary: job.summary, applied, skipped, changed });
    return { applied, skipped, summary: job.summary, changed, commit };
  }

  /** A chat turn's applied file changes, one line per file: "Edited Trip budget", "Created Trip budget/style.css". */
  function recordFileChanges(job, undo, nodeOf) {
    const t = turnOf(job);
    if (!t) return;
    for (const u of undo) {
      let node = null;
      try {
        node = nodeOf(u.page);
      } catch {}
      const title = node ? node.title || u.page : u.page;
      const entry = node && (u.rel === editFile(node) || u.rel === node.entry);
      if (u.after === null) t.changes.push({ kind: "delete", text: `Deleted ${title}/${u.rel}`, page: u.page });
      else if (u.before === null) t.changes.push({ kind: "write", text: `Created ${title}/${u.rel}`, page: u.page });
      else t.changes.push({ kind: "edit", text: entry ? `Edited ${title}` : `Edited ${title}/${u.rel}`, page: u.page });
    }
  }

  /**
   * Undo what a chat turn did at once, newest first: moves go back, pages and folders it
   * created go to the Trash, settings get their old values. Trashed pages stay in the Trash.
   */
  async function undoImmediate(job, skipped, paths) {
    let restored = 0;
    const exists = (p) => fs.existsSync(path.join(job.vault, ...p.split("/")));
    const keys = [];
    for (const x of [...job.immediate].reverse()) {
      try {
        if (x.kind === "move") {
          if (!exists(x.to) || exists(x.from)) {
            skipped.push({ file: x.to, reason: "It was moved or changed after" });
            continue;
          }
          await moveNow(job, x.to, x.from);
          paths.push(x.from, x.to);
        } else if (x.kind === "create" || x.kind === "folder") {
          if (!exists(x.path)) continue;
          if (!trash) {
            skipped.push({ file: x.path, reason: "Moving pages to the Trash isn't available here" });
            continue;
          }
          await trash(x.path, { commit: false });
          paths.push(x.path);
        } else if (x.kind === "relink") {
          paths.push(x.path); // undoing the move above rewrites these links back
          continue;
        } else if (x.kind === "trash") {
          skipped.push({ file: x.path, reason: "Put it back from the Trash" });
          continue;
        } else if (x.kind === "setting") {
          const s = settingOf(x.key);
          if (readSetting(s) !== x.after) {
            skipped.push({ file: `${s.section} › ${s.label}`, reason: "It was changed again after" });
            continue;
          }
          writeSetting(s, x.before);
          keys.push(x.key);
        }
        restored++;
      } catch (err) {
        skipped.push({ file: x.path || x.to || x.key, reason: (err && err.message) || String(err) });
      }
    }
    if (keys.length) emit(job, "settings", { keys });
    return restored;
  }

  async function undoJob(jobId, { sender = null } = {}) {
    const job = jobOf(jobId);
    if (job.state !== "done" || !job.undo) throw new Error("Nothing to undo");
    try {
      flushAutosaves();
    } catch {}
    const vault = job.vault;
    const skipped = [];
    const touched = new Set();
    const paths = [];
    let restored = 0;
    const held = new Set(job.undo.map((u) => u.page));
    hold(vault, held, Infinity);
    try {
      for (const u of [...job.undo].reverse()) {
        const file = u.page === job.page ? u.rel : `${u.page}/${u.rel}`;
        if (readText(u.abs) !== u.after) {
          skipped.push({ file, reason: "It changed after it was applied" });
          continue;
        }
        markSelfWrite(u.abs);
        if (u.before === null) fs.rmSync(u.abs, { force: true });
        else {
          fs.mkdirSync(path.dirname(u.abs), { recursive: true });
          fs.writeFileSync(u.abs, u.before);
        }
        restored++;
        touched.add(u.page);
        paths.push(u.page + "/" + u.rel);
      }
      restored += await undoImmediate(job, skipped, paths);
      try {
        commitPaths(vault, `Undo ${AI_NAME}: ${shortPrompt(job.prompt)}`, paths, { author: authorFor(AI_NAME) });
      } catch (err) {
        console.error("[quire] ai undo commit failed:", err.message);
        for (const p of touched) scheduleAutosave(vault, p);
      }
      job.state = "undone";
      const t = turnOf(job);
      if (t) {
        t.state = "undone";
        t.undoable = false;
        t.skipped = [...(t.skipped || []), ...skipped];
        chatChanged(job);
      }
    } finally {
      hold(vault, held, Date.now() + HOLD_AFTER_MS);
    }
    for (const p of touched) {
      try {
        onRebuild(vault, findPage(vault, p));
      } catch {}
      onWritten(p, sender);
    }
    return { restored, skipped };
  }

  return {
    status,
    start,
    stop,
    answer,
    apply,
    undo: undoJob,
    jobs: list,
    chats: listConversations,
    chat: getConversation,
    deleteChat: deleteConversation,
    permissions: () => aiPermissions(),
    setPermissions: (patch) => setAiPermissions(patch),
  };
}
