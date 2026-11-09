// The pure half of the quire:// protocol: content types, the head injection (import map,
// theme, runtime) and the entry transform. No node imports, so the iOS app runs the same code
// in JavaScriptCore (mobile/host.mjs). protocol.mjs re-exports all of it.
import { indexBody, renderMarkdown } from "../../core/html.mjs";
import { RENDERERS } from "../../core/renderers.mjs";

export const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".htm": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
  ".ttf": "font/ttf",
  ".md": "text/plain; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".csv": "text/csv; charset=utf-8",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".pdf": "application/pdf",
  ".mov": "video/quicktime",
  ".m4a": "audio/mp4",
  ".ogg": "audio/ogg",
  ".avif": "image/avif",
  ".bmp": "image/bmp",
  ".wasm": "application/wasm",
};

/** The extension of a file name, lower-cased, with its dot (like path.extname). */
function extname(file) {
  const base = String(file).split("/").pop();
  const i = base.lastIndexOf(".");
  return i > 0 ? base.slice(i).toLowerCase() : "";
}

export function contentType(file) {
  return TYPES[extname(file)] || "application/octet-stream";
}

const IMPORT_MAP = {
  imports: {
    react: "quire://runtime/vendor/react.mjs",
    "react-dom/client": "quire://runtime/vendor/react-dom-client.mjs",
    htm: "quire://runtime/vendor/htm.mjs",
    "htm/react": "quire://runtime/vendor/htm-react.mjs",
  },
};

export function escAttr(s) {
  return String(s).replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** Editor settings (config.json "editor"), with defaults filled in and values clamped. */
export const EDITOR_FONTS = {
  default: 'var(--q-font)',
  serif: '"Iowan Old Style", Charter, "Palatino Linotype", Georgia, serif',
  system: 'system-ui, -apple-system, "Segoe UI", sans-serif',
  mono: "var(--q-mono)",
};
export const EDITOR_DEFAULTS = { textSize: 16, readableWidth: true, font: "default", spellcheck: true, defaultRenderer: "quire" };

export function editorPrefs(raw) {
  const e = raw && typeof raw === "object" ? raw : {};
  const size = Math.round(Number(e.textSize));
  return {
    textSize: Number.isFinite(size) ? Math.min(22, Math.max(13, size)) : EDITOR_DEFAULTS.textSize,
    readableWidth: e.readableWidth !== false,
    font: Object.hasOwn(EDITOR_FONTS, e.font) ? e.font : EDITOR_DEFAULTS.font,
    spellcheck: e.spellcheck !== false,
    defaultRenderer: RENDERERS.includes(e.defaultRenderer) ? e.defaultRenderer : EDITOR_DEFAULTS.defaultRenderer,
  };
}

/** The `:root{…}` rule theme.css reads its page typography from. */
export function editorCss(prefs) {
  const p = editorPrefs(prefs);
  return `:root{--q-text-size:${p.textSize}px;--q-measure:${p.readableWidth ? "700px" : "none"};--q-page-font:${EDITOR_FONTS[p.font]};}`;
}

/** The block injected right after `<head>`. `editor` (the user's editor settings) is left
 * out of published pages, which keep the theme's defaults. */
export function headInjection(pagePath, editor = null, extra = "") {
  return (
    `<meta name="quire-page" content="${escAttr(pagePath)}">` +
    (extra || "") +
    `<script type="importmap">${JSON.stringify(IMPORT_MAP)}</script>` +
    `<link rel="stylesheet" href="quire://runtime/theme.css">` +
    (editor
      ? `<style id="q-editor-prefs">${editorCss(editor)}</style>` +
        `<meta name="quire-spellcheck" content="${editorPrefs(editor).spellcheck ? "on" : "off"}">`
      : "") +
    `<script src="quire://runtime/runtime.js"></script>`
  );
}

/** Insert the runtime block right after `<head …>`, creating a head when there is none. */
export function injectHead(html, pagePath, baseHref = null, editor = null, extra = "") {
  // A <base> first, so an entry in a subfolder (a build's dist/index.html) resolves its
  // relative asset URLs against its own folder rather than the page root.
  const inj = (baseHref ? `<base href="${escAttr(baseHref)}">` : "") + headInjection(pagePath, editor, extra);
  const head = /<head(?:\s[^>]*)?>/i.exec(html);
  if (head) {
    const at = head.index + head[0].length;
    return html.slice(0, at) + inj + html.slice(at);
  }
  const htmlTag = /<html(?:\s[^>]*)?>/i.exec(html);
  if (htmlTag) {
    const at = htmlTag.index + htmlTag[0].length;
    return html.slice(0, at) + `<head>${inj}</head>` + html.slice(at);
  }
  const doctype = /^\s*<!doctype[^>]*>/i.exec(html);
  const at = doctype ? doctype[0].length : 0;
  return html.slice(0, at) + `<head>${inj}</head>` + html.slice(at);
}

/** Entry source → served document. format: "html" | "md". */
export function transformEntry(source, format, { pagePath, title, baseHref = null, editor = null, extra = "" }) {
  const html = format === "md" ? renderMarkdown(source, { title }) : source;
  return injectHead(indexBody(html), pagePath, baseHref, editor, extra);
}

