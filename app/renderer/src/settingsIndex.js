// Settings search (the field at the top of the Settings nav): everything a person can find.
// Each row: id (the data-setting attribute on the row in its pane, or a section/sub-page id),
// tab (and sub, for an Import source), label as the pane renders it, context (section › sub-page),
// keywords (synonyms people type). `page: true` rows open a section or sub-page and don't look for
// a row; `near` names the row to show instead when the target is hidden (e.g. Dictionary while
// Spellcheck is off). Added a setting to a pane? Add a row here and put data-setting on it.
// Keyboard shortcuts are added from the live shortcut list (settingsSearchIndex below).
import { words } from "./platform.js";
import { BRAND } from "../../../core/brand.mjs";

export const SECTION_LABELS = {
  vault: "Vault",
  editor: "Editor",
  sync: "Sync",
  ai: `${BRAND.name} AI`,
  publishing: "Publishing",
  plan: "Plan",
  tools: "Tools",
  import: "Import",
  shortcuts: "Keyboard shortcuts",
  floating: "Floating note",
  templates: "Templates",
  activity: "Activity & limits",
};

const S = SECTION_LABELS;
const LIMITS_CTX = `${S.activity} › Limits`;

export const SETTINGS_INDEX = [
  // Sections
  { id: "vault", tab: "vault", page: true, label: S.vault, context: "Section", keywords: ["folder", "location", "notes", "library"] },
  { id: "editor", tab: "editor", page: true, label: S.editor, context: "Section", keywords: ["appearance", "typing", "writing", "text"] },
  { id: "sync", tab: "sync", page: true, label: S.sync, context: "Section", keywords: ["git", "github", "backup", "remote", "repo"] },
  { id: "ai", tab: "ai", page: true, label: S.ai, context: "Section", keywords: ["claude", "assistant", "llm", "ai permissions", "chat"] },
  { id: "publishing", tab: "publishing", page: true, label: S.publishing, context: "Section", keywords: ["publish", "share", "web", "hosting", "domain", "website"] },
  { id: "plan", tab: "plan", page: true, label: S.plan, context: "Section", keywords: ["pro", "billing", "subscription", "upgrade", "credits", "pricing", "payment"] },
  { id: "tools", tab: "tools", page: true, label: S.tools, context: "Section", keywords: ["git", "node", "pnpm", "wrangler", "binaries", "programs"] },
  { id: "import", tab: "import", page: true, label: S.import, context: "Section", keywords: ["bring in", "migrate", "obsidian", "artifacts"] },
  { id: "shortcuts", tab: "shortcuts", page: true, label: S.shortcuts, context: "Section", keywords: ["hotkey", "hotkeys", "keybinding", "keybindings", "keys", "keyboard"] },
  { id: "floating", tab: "floating", page: true, label: S.floating, context: "Section", keywords: ["quick note", "always on top", "scratch", "popup"] },
  { id: "templates", tab: "templates", page: true, label: S.templates, context: "Section", keywords: ["starter", "new page from template", "blueprint"] },
  { id: "activity", tab: "activity", page: true, label: S.activity, context: "Section", keywords: ["memory", "cpu", "processes", "backends", "performance", "task manager"] },

  // Vault
  { id: "vault.name", tab: "vault", label: "Name", context: S.vault, keywords: ["vault name", "rename vault"] },
  { id: "vault.location", tab: "vault", label: "Location", context: S.vault, keywords: ["path", "folder", "move vault", words.reveal.toLowerCase(), "finder", "explorer"] },
  { id: "vault.others", tab: "vault", label: "Other vaults", context: S.vault, keywords: ["switch vault", "recent vaults", "vault list"] },
  {
    id: "vault.confirmDelete",
    tab: "vault",
    label: `Ask before moving pages and files to the ${words.trash}`,
    context: S.vault,
    keywords: ["trash", "recycle bin", "delete", "confirm", "warning"],
  },
  { id: "vault.searchExclude", tab: "vault", label: "Exclude from search", context: S.vault, keywords: ["archive", "hide", "palette", "unsearchable", "ignore", "folders"] },
  { id: "vault.open", tab: "vault", label: "Open folder as vault…", context: S.vault, keywords: ["open vault", "add vault"] },
  { id: "vault.create", tab: "vault", label: "Create vault…", context: S.vault, keywords: ["new vault"] },

  // Editor
  { id: "editor.textSize", tab: "editor", label: "Text size", context: S.editor, keywords: ["font size", "zoom", "bigger", "smaller", "larger"] },
  { id: "editor.font", tab: "editor", label: "Font", context: S.editor, keywords: ["typeface", "serif", "mono", "geist"] },
  { id: "editor.readableWidth", tab: "editor", label: "Readable line width", context: S.editor, keywords: ["line length", "width", "column", "full width", "wide"] },
  { id: "editor.spellcheck", tab: "editor", label: "Spellcheck", context: S.editor, keywords: ["spelling", "spell check", "typos"] },
  { id: "editor.dictionary", tab: "editor", near: "editor.spellcheck", label: "Dictionary", context: S.editor, keywords: ["spelling", "words", "add to dictionary"] },
  { id: "editor.defaultView", tab: "editor", label: "Default view for new pages", context: S.editor, keywords: ["renderer", "mode", "source", "markdown"] },

  // Sync
  { id: "sync.status", tab: "sync", label: "Sync status", context: S.sync, keywords: ["last synced", "conflicts"] },
  { id: "sync.remote", tab: "sync", label: "Repo", context: S.sync, keywords: ["git", "github", "remote", "repository", "backup", "url"] },
  { id: "sync.auto", tab: "sync", label: "Sync automatically", context: S.sync, keywords: ["auto sync", "git", "backup", "on", "off"] },
  { id: "sync.every", tab: "sync", label: "Check for changes every", context: S.sync, keywords: ["interval", "frequency", "pull", "how often"] },
  { id: "sync.now", tab: "sync", label: "Sync now", context: S.sync, keywords: ["push", "pull", "git"] },

  // Noteblock AI (AiPane.jsx AI_PERMISSIONS)
  { id: "ai.account", tab: "ai", label: "Model and today's spend", context: S.ai, keywords: ["usage", "limit", "cost", "model", "haiku", "account", "credits"] },
  { id: "ai.editPage", tab: "ai", label: "Edit the page you asked from", context: `${S.ai} › What ${BRAND.name} AI may do`, keywords: ["ai permissions", "allow", "ask"] },
  { id: "ai.readPages", tab: "ai", label: "Read other pages", context: `${S.ai} › What ${BRAND.name} AI may do`, keywords: ["ai permissions", "privacy"] },
  { id: "ai.editOtherPages", tab: "ai", label: "Edit other pages", context: `${S.ai} › What ${BRAND.name} AI may do`, keywords: ["ai permissions"] },
  { id: "ai.createPages", tab: "ai", label: "Create pages and folders", context: `${S.ai} › What ${BRAND.name} AI may do`, keywords: ["ai permissions", "new page"] },
  { id: "ai.openPages", tab: "ai", label: "Open pages and tabs", context: `${S.ai} › What ${BRAND.name} AI may do`, keywords: ["ai permissions", "navigate"] },
  { id: "ai.trashPages", tab: "ai", label: "Move pages to Trash", context: `${S.ai} › What ${BRAND.name} AI may do`, keywords: ["ai permissions", "delete", "trash", "remove"] },
  { id: "ai.deleteFiles", tab: "ai", label: "Delete files inside a page", context: `${S.ai} › What ${BRAND.name} AI may do`, keywords: ["ai permissions", "remove"] },
  { id: "ai.fetchWeb", tab: "ai", label: "Fetch from the web", context: `${S.ai} › What ${BRAND.name} AI may do`, keywords: ["ai permissions", "internet", "network", "url", "api"] },
  { id: "ai.movePages", tab: "ai", label: "Move and rename pages", context: `${S.ai} › What ${BRAND.name} AI may do`, keywords: ["ai permissions", "rename"] },
  { id: "ai.changeSettings", tab: "ai", label: "Change settings", context: `${S.ai} › What ${BRAND.name} AI may do`, keywords: ["ai permissions", "preferences"] },

  // Publishing
  { id: "publishing.account", tab: "publishing", label: `${BRAND.name} account`, context: S.publishing, keywords: ["sign in", "sign out", "login", "log out", "publish", "sites"] },
  // Plan (PlanPane.jsx)
  { id: "plan.current", tab: "plan", label: "Plan", context: S.plan, keywords: ["pro", "free", "subscription", "renew", "cancel", "manage billing", "invoices", "card"] },
  { id: "plan.upgrade", tab: "plan", near: "plan.current", label: "Upgrade to Pro", context: S.plan, keywords: ["pro", "yearly", "monthly", "subscribe", "pricing"] },
  { id: "plan.credits", tab: "plan", label: "AI credits", context: S.plan, keywords: ["noteblock ai", "usage", "limit", "credits left"] },
  { id: "plan.buy", tab: "plan", near: "plan.credits", label: "Buy credits", context: S.plan, keywords: ["credit pack", "top up", "more credits"] },
  { id: "plan.sites", tab: "plan", label: "Published sites", context: S.plan, keywords: ["sites", "storage", "limit", "usage"] },
  { id: "publishing.selfhost", tab: "publishing", label: "Self-hosting", context: S.publishing, keywords: ["cloudflare", "worker", "own domain", "domain", "publish"] },
  { id: "publishing.cloudflare", tab: "publishing", near: "publishing.selfhost", label: "Log in to Cloudflare", context: `${S.publishing} › Self-hosting`, keywords: ["cloudflare", "wrangler", "log out"] },
  { id: "publishing.default", tab: "publishing", near: "publishing.selfhost", label: "Publish to", context: `${S.publishing} › Self-hosting`, keywords: ["default host", "publish", "domain", "cloudflare"] },

  // Tools (main/tools.mjs NAMES)
  { id: "tools.git", tab: "tools", label: "Git", context: S.tools, keywords: ["history", "sync", "version control"] },
  { id: "tools.node", tab: "tools", label: "Node", context: S.tools, keywords: ["nodejs", "javascript", "builds", "backends"] },
  { id: "tools.pnpm", tab: "tools", label: "pnpm", context: S.tools, keywords: ["npm", "packages", "builds", "install"] },
  { id: "tools.wrangler", tab: "tools", label: "wrangler", context: S.tools, keywords: ["cloudflare", "publish"] },

  // Import and its sources (IMPORT_SOURCES in Settings.jsx)
  { id: "import.obsidian", tab: "import", sub: "obsidian", page: true, label: "Obsidian", context: S.import, keywords: ["markdown", "vault", "migrate", "md"] },
  { id: "import.obsidian.vault", tab: "import", sub: "obsidian", label: "Vault", context: `${S.import} › Obsidian`, keywords: ["choose obsidian vault", "source"] },
  { id: "import.obsidian.format", tab: "import", sub: "obsidian", label: "Import as", context: `${S.import} › Obsidian`, keywords: ["markdown pages", "html", "format"] },
  { id: "import.obsidian.where", tab: "import", sub: "obsidian", label: "Put it in", context: `${S.import} › Obsidian`, keywords: ["destination", "folder"] },
  { id: "import.claude", tab: "import", sub: "claude", page: true, label: "Claude artifacts", context: S.import, keywords: ["claude.ai", "artifact", "anthropic", "claude code"] },
  { id: "import.claude.which", tab: "import", sub: "claude", label: "Which ones", context: `${S.import} › Claude artifacts`, keywords: ["all my artifacts", "most recent", "only these"] },
  { id: "import.claude.shared", tab: "import", sub: "claude", label: "Include artifacts shared with me", context: `${S.import} › Claude artifacts`, keywords: ["shared"] },
  { id: "import.claude.update", tab: "import", sub: "claude", label: "Update ones already imported", context: `${S.import} › Claude artifacts`, keywords: ["refresh", "reimport"] },
  { id: "import.claude.where", tab: "import", sub: "claude", label: "Put it in", context: `${S.import} › Claude artifacts`, keywords: ["destination", "folder"] },
  { id: "import.claude.prompt", tab: "import", sub: "claude", label: "Copy prompt", context: `${S.import} › Claude artifacts`, keywords: ["show prompt", "claude code", "paste"] },
  { id: "import.files", tab: "import", sub: "files", page: true, label: "HTML or markdown files", context: S.import, keywords: ["html", "md", "files", "upload", "downloaded artifact"] },
  { id: "import.files.where", tab: "import", sub: "files", label: "Put it in", context: `${S.import} › HTML or markdown files`, keywords: ["destination", "folder"] },
  { id: "import.files.choose", tab: "import", sub: "files", label: "Choose files…", context: `${S.import} › HTML or markdown files`, keywords: ["pick files", "upload"] },

  // Keyboard shortcuts (each shortcut row comes from the live list, below)
  { id: "shortcuts.priority", tab: "shortcuts", label: "When a page also uses a shortcut", context: S.shortcuts, keywords: ["page first", `${BRAND.name.toLowerCase()} first`, "conflict", "priority", "hotkey"] },
  { id: "shortcuts.reset", tab: "shortcuts", label: "Reset all to defaults", context: S.shortcuts, keywords: ["restore shortcuts", "hotkey", "keybinding"] },

  // Floating note
  { id: "floating.enabled", tab: "floating", label: "Show and hide it with a shortcut from any app", context: S.floating, keywords: ["global shortcut", "enable floating note", "always on top"] },
  { id: "floating.shortcut", tab: "floating", label: "Show / hide floating note", context: S.floating, keywords: ["hotkey", "keybinding", "global shortcut"] },
  { id: "floating.page", tab: "floating", label: "Page", context: S.floating, keywords: ["which note", "floating page"] },
  { id: "floating.open", tab: "floating", label: "Open floating note", context: S.floating, keywords: ["show floating note"] },

  // Templates
  { id: "templates.folder", tab: "templates", label: "Folder", context: S.templates, keywords: ["templates folder", "location", words.reveal.toLowerCase()] },
  { id: "templates.list", tab: "templates", label: "Templates", context: S.templates, keywords: ["delete template", "my templates"] },
  { id: "templates.save", tab: "templates", label: "Save current page as template…", context: S.templates, keywords: ["new template", "make template"] },
  { id: "templates.restore", tab: "templates", label: "Restore starter templates", context: S.templates, keywords: ["reset templates", "defaults"] },

  // Activity & limits (labels from main/limits.mjs LIMITS, as LimitsSection shows them)
  { id: "activity.memory", tab: "activity", label: "Total memory", context: S.activity, keywords: ["ram", "usage", "cpu", "processes"] },
  { id: "activity.backends", tab: "activity", label: "Page backends", context: S.activity, keywords: ["stop all", "restart", "logs", "servers", "processes"] },
  { id: "activity.app", tab: "activity", label: `${BRAND.name} app processes`, context: S.activity, keywords: ["memory", "electron", "renderer"] },
  { id: "activity.limits", tab: "activity", label: "Limits", context: S.activity, keywords: ["reset limits", "watchdog", "caps"] },
  { id: "limits.unresponsiveSeconds", tab: "activity", label: "Show “not responding” after", context: `${LIMITS_CTX} › Pages`, keywords: ["hang", "frozen", "unresponsive", "timeout"] },
  { id: "limits.autoReloadCrashed", tab: "activity", label: "Reload a crashed page by itself", context: `${LIMITS_CTX} › Pages`, keywords: ["crash", "auto reload", "recovery"] },
  { id: "limits.autoReloadLimit", tab: "activity", label: "Stop auto-reloading after this many crashes in a minute", context: `${LIMITS_CTX} › Pages`, keywords: ["crash loop", "auto reload"] },
  { id: "limits.errorBadge", tab: "activity", label: "Show page errors in the top bar", context: `${LIMITS_CTX} › Pages`, keywords: ["console errors", "error count", "badge"] },
  { id: "limits.idleMinutes", tab: "activity", label: "Stop idle backends after", context: `${LIMITS_CTX} › Backends`, keywords: ["idle", "sleep", "timeout"] },
  { id: "limits.maxRunning", tab: "activity", label: "Max running backends", context: `${LIMITS_CTX} › Backends`, keywords: ["how many", "cap"] },
  { id: "limits.maxProcesses", tab: "activity", label: "Max processes per backend", context: `${LIMITS_CTX} › Backends`, keywords: ["fork", "process limit"] },
  { id: "limits.maxMemoryMB", tab: "activity", label: "Max memory per backend", context: `${LIMITS_CTX} › Backends`, keywords: ["ram", "memory limit", "mb"] },
  { id: "limits.cpuPercent", tab: "activity", label: "CPU limit per backend", context: `${LIMITS_CTX} › Backends`, keywords: ["cpu", "processor", "percent"] },
  { id: "limits.cpuSeconds", tab: "activity", label: "…for longer than", context: `${LIMITS_CTX} › CPU limit per backend`, keywords: ["cpu seconds", "cpu time"] },
  { id: "limits.crashLimit", tab: "activity", label: "Give up after this many crashes", context: `${LIMITS_CTX} › Backends`, keywords: ["crash", "restart"] },
  { id: "limits.crashWindowMinutes", tab: "activity", label: "…within", context: `${LIMITS_CTX} › Give up after this many crashes`, keywords: ["crash window", "minutes"] },
  { id: "limits.stopGraceSeconds", tab: "activity", label: "Force-kill a stopping backend after", context: `${LIMITS_CTX} › Backends`, keywords: ["kill", "grace", "sigkill", "shutdown"] },
  { id: "limits.checkSeconds", tab: "activity", label: "Check backends every", context: `${LIMITS_CTX} › Backends`, keywords: ["poll", "interval", "watchdog"] },
];

/** The static index plus one row per keyboard shortcut (their labels live in main/shortcuts.mjs). */
export function settingsSearchIndex(shortcuts = []) {
  const keys = shortcuts.map((s) => ({
    id: "shortcuts." + s.id,
    tab: "shortcuts",
    label: s.label,
    context: S.shortcuts,
    keywords: ["shortcut", "hotkey", "keybinding"],
  }));
  return [...SETTINGS_INDEX, ...keys];
}

const norm = (s) => String(s).toLowerCase().replace(/[“”"'’…]/g, "").trim();
const wordsOf = (s) => norm(s).split(/[^a-z0-9.]+/).filter(Boolean);

/** One query word against one entry: label prefix > label word prefix > label substring > keyword > context. */
function scoreToken(t, e) {
  const label = norm(e.label);
  if (label.startsWith(t)) return 100;
  if (wordsOf(e.label).some((w) => w.startsWith(t))) return 80;
  if (label.includes(t)) return 60;
  const kws = (e.keywords || []).map(norm);
  if (kws.some((k) => k === t || k.startsWith(t) || k.split(" ").some((w) => w.startsWith(t)))) return 45;
  if (kws.some((k) => k.includes(t))) return 35;
  if (norm(e.context).includes(t)) return 20;
  return 0;
}

/** Entries matching every word of the query, best first; ties keep index order. */
export function searchSettings(index, query) {
  const q = norm(query);
  if (!q) return [];
  const tokens = q.split(/\s+/);
  const out = [];
  index.forEach((e, i) => {
    let total = 0;
    for (const t of tokens) {
      const s = scoreToken(t, e);
      if (!s) return;
      total += s;
    }
    const label = norm(e.label);
    if (tokens.length > 1 && label.startsWith(q)) total += 50;
    else if (tokens.length > 1 && (e.keywords || []).some((k) => norm(k).includes(q))) total += 30;
    if (label === q) total += 20;
    out.push({ e, total, i });
  });
  return out.sort((a, b) => b.total - a.total || a.i - b.i).slice(0, 40).map((r) => r.e);
}
