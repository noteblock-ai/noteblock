// Noteblock AI conversations (docs/ai.md, "0.3.3: the ⌘J assistant"): one JSON file per
// conversation in configDir()/ai/<vault key>/<id>.json, never in the vault. A file holds the
// turns the window draws and `messages`, the full Messages API history the next turn sends
// (trimmed by trimHistory). ai.mjs owns the turns' life; this is plain storage.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { configDir, metaPath } from "../../core/index.mjs";

const ID = /^aic_[a-z0-9]{6,32}$/;
const KEEP_TURNS = 20;
const KEEP_OUTPUT_TURNS = 2;
export const OLD_OUTPUT = "(old output omitted)";
export const OLD_CONTEXT = "<context>(old context omitted)</context>";

/** The prompt as a title or commit message: one line, 60 characters at most. */
export function shortPrompt(prompt) {
  const s = String(prompt || "").replace(/\s+/g, " ").trim();
  return s.length > 60 ? s.slice(0, 59).trimEnd() + "…" : s;
}

/** vault.json `id` when it has one, else the first 16 hex of sha256(vault path). */
export function vaultKey(vault) {
  try {
    const meta = JSON.parse(fs.readFileSync(metaPath(vault, "vault.json"), "utf8"));
    if (typeof meta.id === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(meta.id)) return meta.id;
  } catch {}
  return crypto.createHash("sha256").update(path.resolve(vault)).digest("hex").slice(0, 16);
}

export function chatsDir(vault) {
  return path.join(configDir(), "ai", vaultKey(vault));
}

const fileOf = (vault, id) => {
  if (!ID.test(String(id || ""))) throw new Error(`No conversation ${id}`);
  return path.join(chatsDir(vault), `${id}.json`);
};

export const newChatId = () => "aic_" + crypto.randomBytes(8).toString("hex");
export const newTurnId = () => "ait_" + crypto.randomBytes(6).toString("hex");

/** A new, unsaved conversation titled after its first prompt. */
export function newChat(prompt, now = Date.now()) {
  return { id: newChatId(), title: shortPrompt(prompt), created: now, updated: now, turns: [], messages: [] };
}

/** The whole conversation (messages too), or null. */
export function readChat(vault, id) {
  let file;
  try {
    file = fileOf(vault, id);
  } catch {
    return null;
  }
  try {
    const c = JSON.parse(fs.readFileSync(file, "utf8"));
    if (!c || c.id !== id) return null;
    return { ...c, turns: Array.isArray(c.turns) ? c.turns : [], messages: Array.isArray(c.messages) ? c.messages : [] };
  } catch {
    return null;
  }
}

/** Write it whole (a temp file renamed over, so a crash never leaves half a conversation). */
export function writeChat(vault, chat) {
  const file = fileOf(vault, chat.id);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(chat));
  fs.renameSync(tmp, file);
}

export function removeChat(vault, id) {
  fs.rmSync(fileOf(vault, id), { force: true });
}

/** The conversation as the window gets it: everything but `messages`. */
export function publicChat(chat) {
  if (!chat) return null;
  const { messages, ...rest } = chat;
  return rest;
}

/** One line for the history list: the last turn's last change, else its reply, else its prompt. */
export function lastLine(chat) {
  const t = (chat.turns || []).at(-1);
  if (!t) return "";
  const change = (t.changes || []).at(-1);
  const s = change ? change.text : t.reply || (t.error && t.error.message) || t.prompt || "";
  const line = String(s).replace(/\s+/g, " ").trim();
  return line.length > 120 ? line.slice(0, 119).trimEnd() + "…" : line;
}

/** [{id, title, updated, turnCount, last}], newest first. */
export function listChats(vault) {
  let names = [];
  try {
    names = fs.readdirSync(chatsDir(vault));
  } catch {
    return [];
  }
  const out = [];
  for (const n of names) {
    if (!n.endsWith(".json")) continue;
    const c = readChat(vault, n.slice(0, -5));
    if (c) out.push({ id: c.id, title: c.title, updated: c.updated, turnCount: c.turns.length, last: lastLine(c) });
  }
  return out.sort((a, b) => (b.updated || 0) - (a.updated || 0));
}

/* ------------------------------------------------------------------ history */

/** A user message that starts a turn (the prompt), not one carrying tool results. */
export function isTurnStart(m) {
  if (!m || m.role !== "user") return false;
  if (typeof m.content === "string") return true;
  return Array.isArray(m.content) && !m.content.some((b) => b && b.type === "tool_result");
}

/**
 * What a request sends of the history: the last 20 turns, with tool_result contents (and the
 * page/vault context each prompt carried) older than the last 2 turns replaced by a stub.
 * `messages` ends with the new turn's own user message, which counts as one of them.
 */
export function trimHistory(messages, { keepTurns = KEEP_TURNS, keepOutputTurns = KEEP_OUTPUT_TURNS } = {}) {
  const starts = [];
  messages.forEach((m, i) => isTurnStart(m) && starts.push(i));
  if (!starts.length) return messages.slice();
  const from = starts[Math.max(0, starts.length - keepTurns)];
  const fresh = starts[Math.max(0, starts.length - keepOutputTurns)];
  return messages.slice(from).map((m, k) => {
    if (from + k >= fresh || !Array.isArray(m.content)) return m;
    return {
      ...m,
      content: m.content.map((b) => {
        if (b && b.type === "tool_result") return { ...b, content: OLD_OUTPUT };
        if (b && b.type === "text" && m.role === "user" && b.text.startsWith("<context>")) return { ...b, text: OLD_CONTEXT };
        return b;
      }),
    };
  });
}

/**
 * Close a turn's new messages so the next turn's request is valid: every tool_use answered,
 * ending on an assistant message. A turn that stopped or failed part way gets `note`.
 */
export function sealTurn(messages, note) {
  const out = messages.slice();
  const last = out.at(-1);
  if (last && last.role === "assistant" && Array.isArray(last.content)) {
    const uses = last.content.filter((b) => b.type === "tool_use");
    if (uses.length) out.push({ role: "user", content: uses.map((u) => ({ type: "tool_result", tool_use_id: u.id, is_error: true, content: "Stopped." })) });
  }
  if (!out.length || out.at(-1).role !== "assistant") out.push({ role: "assistant", content: [{ type: "text", text: note }] });
  return out;
}
