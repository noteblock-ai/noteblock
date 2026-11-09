// Noteblock AI: the system prompts, the tool definitions the model gets, and the input checks
// every tool call passes before it runs (docs/ai.md, "Tools the model gets"). The job loop and
// the tools' effects are in ai.mjs.
import { BRAND } from "../../core/brand.mjs";

export const AI_NAME = `${BRAND.name} AI`;

/** Permission keys, their defaults, and the values each can take (config.json ai.permissions). */
export const PERMISSION_DEFAULTS = {
  editPage: "allow",
  readPages: "allow",
  editOtherPages: "ask",
  createPages: "allow",
  openPages: "allow",
  trashPages: "ask",
  deleteFiles: "ask",
  fetchWeb: "allow",
  movePages: "allow",
  changeSettings: "ask",
};
export const PERMISSION_VALUES = new Set(["allow", "ask", "off"]);

// The system prompts are static, so they cache across jobs: everything job-specific goes in the
// user messages. PAGES is the part both share: what a page is and how to write one.
const PAGES = `# What a page is
A page is a folder in the vault holding a \`.noteblock\` manifest (managed by the app, never edit it), an entry file (index.html, or index.md for a markdown page) and any other files it needs (app.js, style.css). Tool paths are relative to the page ("index.html", "app.js"). Pages are named by their vault path ("Kyoto trip/Trip budget").

# Writing pages
- Top-level children of <body> that are p, h1-h4, ul, ol, blockquote, pre, table, hr, img or figure are text the user edits in place. Anything else at the top level (a div, a custom element, anything with data-app) is an app block: rendered live, not text-editable.
- Keep the user's prose. Never rewrite, reorder or reformat text you weren't asked to change. Prose the user should be able to edit goes outside the elements a script renders into.
- An app is \`<div id="root" data-app></div>\` plus a module script. React and htm come from the page's import map, so there is no build step and no JSX:
  \`\`\`js
  import React, { useState, useEffect } from "react";
  import { createRoot } from "react-dom/client";
  import html from "htm/react";

  await quire.ready;
  const items = quire.store.table("items");

  function App() {
    const [rows, setRows] = useState([]);
    useEffect(() => {
      const load = () => items.all().then(setRows);
      load();
      return items.subscribe(load);
    }, []);
    return html\`<ul>\${rows.map((r) => html\`<li key=\${r.id}>\${r.label}</li>\`)}</ul>
      <button onClick=\${() => items.insert({ label: "New" })}>Add</button>\`;
  }
  createRoot(document.getElementById("root")).render(html\`<\${App} />\`);
  \`\`\`
- Data lives in window.quire; every call returns a Promise. \`quire.store.table(name)\` has .all(), .get(id), .insert(obj), .update(id, patch), .remove(id) and .subscribe(cb) (returns an unsubscribe). Rows are schemaless JSON with id, _created and _updated; a table appears on its first insert, so there are no migrations. \`quire.kv.get(key)\` / \`quire.kv.set(key, value)\` hold settings. \`quire.query("Other/Page", table)\` reads another page's table. \`quire.page\` is {path, title, id, readOnly}: when readOnly is true, or a write rejects, disable inputs.
- Never load scripts, styles or fonts from a CDN or any other site: pages work offline. Refer to the page's own files with relative paths ("./app.js").
- Page code may fetch() public APIs that allow cross-origin requests for live data, for example https://api.frankfurter.dev/v1/latest?from=JPY&to=USD for exchange rates. Show a short message in the block when the request fails.
- Embeds: \`<quire-embed src="Sibling page"></quire-embed>\` shows another page inside this one. src is relative to the folder holding the current page; "/Folder/Page" starts from the vault root.
- Style: the default theme styles plain notes. App code uses the theme's CSS variables so it matches light and dark mode: --q-ground, --q-raised, --q-ink, --q-muted, --q-line, --q-accent, --q-accent-soft, --q-font, --q-mono, --q-radius. Keep apps calm and compact. In htm/React markup, \`style\` takes an object (style=\${{ gap: 12 }}), never a string; prefer className plus a <style> element scoped by the block's id.`;

/** Inline /ai blocks: build one app block where the marker is. */
export const SYSTEM_PROMPT = `You are ${AI_NAME}, the assistant built into ${BRAND.name}, a notes app where every page is a small web page. You build what the user asks for with the tools you have. You are always called ${AI_NAME}; never name the model or company behind you.

${PAGES}

# How to work
- You get the page's files and the list of pages up front. Read other files only when you need them.
- Your block is put in the page when you finish; nothing is saved before that.
- Don't ask the user questions. Make a sensible choice and carry on. When a tool returns an error, fix the call or do without it.
- When you are done, reply with one short plain sentence saying what you built, for example "Built a yen to dollar converter." That sentence is shown to the user as is: no markdown, no lists.`;

/** ⌘J: the assistant for the whole vault, in a saved, multi-turn conversation. */
export const CHAT_SYSTEM_PROMPT = `You are ${AI_NAME}, the assistant built into ${BRAND.name}, a notes app where every page is a small web page. The user talks to you in a chat that stays open across requests. You answer questions about their vault and the app, and you do things for them with your tools: change, build, create, move, rename and trash pages and folders, and change settings. You are always called ${AI_NAME}: never name the model or company behind you, and when asked what you are, you are ${AI_NAME}.

${PAGES}

# How to work
- Each request comes with the page the user has open (if any) and the list of pages. Read other files only when you need them. Earlier requests in the chat are context: "it" or "that" usually means what you last talked about.
- When the user asks a question, answer it plainly and briefly; use vault_stats, list_pages, read_file or get_settings to find out rather than guessing. Don't change anything unless they ask for a change.
- When they ask for a change, do it. Make the smallest change that does what was asked. Prefer edit_file: old_str must match the file exactly once, so include enough surrounding text to make it unique. Use write_file for a new file or when most of a file changes.
- Edits to existing pages' files are collected and applied together when you finish. Pages and folders you create, moves, trash and setting changes happen at once. Files of a page you created are saved right away.
- move_page takes the full new path: moving "Kyoto trip" into the folder "Travel" is to "Travel/Kyoto trip"; renaming keeps the folder and changes the last part. Create a folder before moving pages into it.
- Don't ask the user questions unless the request can't be done without an answer. Make a sensible choice and carry on. When a tool returns an error, fix the call or do without it; when the user declined a step, don't try it another way.
- Reply briefly: one or two sentences, or a short list when the answer is a list. You may use **bold**, \`code\` and "- " lists; no headings, no tables. Don't repeat the changes you made one by one; the app lists them under your reply. Never mention tool names.`;

const str = (description) => ({ type: "string", description });
const PAGE = str("Vault path of the page. Defaults to the page the request came from (the page the user has open).");

/** Every tool, by name: [definition, permission key or null for always]. */
const TOOLS = {
  read_file: {
    description: "Read a text file of a page (200 KB at most).",
    input_schema: { type: "object", properties: { page: PAGE, path: str("File path inside the page, e.g. index.html") }, required: ["path"] },
  },
  list_files: {
    description: "List the files of a page.",
    input_schema: { type: "object", properties: { page: PAGE }, required: [] },
  },
  list_pages: {
    description: "List every folder and page in the vault.",
    input_schema: { type: "object", properties: {}, required: [] },
  },
  vault_stats: {
    description:
      "Numbers about the vault: page and folder counts, total size, size and page count per top-level folder, the 10 biggest pages, the 10 pages with the most data rows, and the pages edited last.",
    input_schema: { type: "object", properties: {}, required: [] },
  },
  edit_file: {
    description: "Replace one exact piece of text in a page's file. old_str must occur exactly once in the file.",
    input_schema: {
      type: "object",
      properties: { page: PAGE, path: str("File path inside the page"), old_str: str("The exact text to replace"), new_str: str("The text to put in its place") },
      required: ["path", "old_str", "new_str"],
    },
  },
  write_file: {
    description: "Write a whole file of a page, creating it or replacing what is there.",
    eager_input_streaming: true,
    input_schema: { type: "object", properties: { page: PAGE, path: str("File path inside the page"), content: str("The full file contents") }, required: ["path", "content"] },
  },
  delete_file: {
    description: "Delete a file of a page.",
    input_schema: { type: "object", properties: { page: PAGE, path: str("File path inside the page") }, required: ["path"] },
  },
  create_page: {
    description: "Create a new, empty page. Its parent folder must exist (\"\" is the vault root). Returns the page's path.",
    input_schema: {
      type: "object",
      properties: { path: str("Vault path of the new page, e.g. \"Kyoto trip/Packing list\""), format: { type: "string", enum: ["html", "md"], description: "html (default) or md" } },
      required: ["path"],
    },
  },
  create_folder: {
    description: "Create a folder in the vault.",
    input_schema: { type: "object", properties: { path: str("Vault path of the new folder") }, required: ["path"] },
  },
  open_page: {
    description: "Show a page to the user.",
    input_schema: { type: "object", properties: { page: str("Vault path of the page"), new_tab: { type: "boolean", description: "Open it in a new tab" } }, required: ["page"] },
  },
  trash_page: {
    description: "Move a page (or folder) to the Trash.",
    input_schema: { type: "object", properties: { page: str("Vault path of the page or folder") }, required: ["page"] },
  },
  move_page: {
    description: "Move or rename a page or folder. to is the full new vault path; its parent folder must exist and nothing may be there yet.",
    input_schema: {
      type: "object",
      properties: { from: str("Vault path of the page or folder now"), to: str("Its full new vault path, e.g. \"Travel/Kyoto trip\"") },
      required: ["from", "to"],
    },
  },
  get_settings: {
    description: "The app's settings you can change with change_setting, with their current values and what each may be set to.",
    input_schema: { type: "object", properties: {}, required: [] },
  },
  change_setting: {
    description:
      "Change one app setting, as listed by get_settings: editor.textSize (13-22), editor.readableWidth, editor.font, editor.spellcheck, editor.defaultRenderer, confirmDelete, or shortcut.<id> (an Electron accelerator like \"CmdOrCtrl+K\"; \"\" clears it).",
    input_schema: {
      type: "object",
      properties: { key: str("The setting's key"), value: { type: ["string", "number", "boolean"], description: "The new value" } },
      required: ["key", "value"],
    },
  },
  fetch_url: {
    description: "GET a web page or API and return its text (100 KB at most).",
    input_schema: { type: "object", properties: { url: str("An http or https URL") }, required: ["url"] },
  },
  insert_block: {
    description:
      "Deliver the block you built. html is the block's HTML: the app container and an inline module script. files are extra files written beside the page's entry, as {path: content}. Call it once.",
    eager_input_streaming: true,
    input_schema: {
      type: "object",
      properties: {
        html: str("The block's HTML"),
        files: { type: "object", additionalProperties: { type: "string" }, description: "Extra files beside the entry, {path: content}" },
      },
      required: ["html"],
    },
  },
};

const BY_TARGET = {
  chat: [
    "read_file",
    "list_files",
    "list_pages",
    "vault_stats",
    "get_settings",
    "edit_file",
    "write_file",
    "delete_file",
    "create_page",
    "create_folder",
    "move_page",
    "trash_page",
    "change_setting",
    "open_page",
    "fetch_url",
  ],
  block: ["read_file", "list_files", "list_pages", "fetch_url", "insert_block"],
};

/** The tool definitions for a job's target, in a fixed order (it is part of the cached prefix). */
export function toolsFor(target) {
  return (BY_TARGET[target] || BY_TARGET.chat).map((name) => ({ name, ...TOOLS[name] }));
}

/** Is `name` a tool this target gets? */
export function hasTool(target, name) {
  return (BY_TARGET[target] || BY_TARGET.chat).includes(name);
}

/**
 * Check a parsed tool input against the tool's schema (the subset used above). Returns an
 * error sentence, or null when it is fine. Eager input streaming means the API does not
 * validate these, so every call goes through here first.
 */
export function validateInput(name, input) {
  const def = TOOLS[name];
  if (!def) return `Unknown tool: ${name}`;
  if (!input || typeof input !== "object" || Array.isArray(input)) return "The input must be an object.";
  const { properties, required } = def.input_schema;
  for (const key of required) if (input[key] === undefined || input[key] === null) return `Missing ${key}.`;
  for (const [key, schema] of Object.entries(properties)) {
    const v = input[key];
    if (v === undefined || v === null) continue;
    if (Array.isArray(schema.type) && !schema.type.includes(typeof v)) return `${key} must be a ${schema.type.join(" or ")}.`;
    if (schema.type === "string" && typeof v !== "string") return `${key} must be a string.`;
    if (schema.type === "boolean" && typeof v !== "boolean") return `${key} must be true or false.`;
    if (schema.enum && !schema.enum.includes(v)) return `${key} must be one of ${schema.enum.join(", ")}.`;
    if (schema.type === "object") {
      if (typeof v !== "object" || Array.isArray(v)) return `${key} must be an object.`;
      for (const [k, x] of Object.entries(v)) if (typeof x !== "string") return `${key}.${k} must be a string.`;
    }
  }
  return null;
}
