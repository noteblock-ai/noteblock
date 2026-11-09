// Uncaught errors and unhandled rejections from the page on screen (and its embeds), forwarded
// by the page runtime. A top-bar pill ("2 errors") opens a panel listing them, newest first.

import { BRAND } from "../../../core/brand.mjs";
import { isWeb } from "./webBridge.js";

/** The page-relative file an error came from: "app.js", "index.html", "Other page/x.js". */
export function errorFile(source, page) {
  if (!source) return "";
  let s = String(source).replace(/[?#].*$/, "");
  // The web host (webBridge.js) serves the vault at /v/… and the runtime at /runtime/… on its own origin.
  if (isWeb && /^https?:\/\//.test(s)) {
    try {
      const u = new URL(s);
      if (u.origin === location.origin && u.pathname.startsWith("/v/")) s = "quire://vault/" + u.pathname.slice(3);
      else if (u.origin === location.origin && u.pathname.startsWith("/runtime/")) s = "quire://runtime/" + u.pathname.slice(9);
    } catch {
      /* not a URL */
    }
  }
  const host = /^quire:\/\/(vault|p-[a-z0-9]+)\//.exec(s);
  if (host) {
    try {
      s = decodeURIComponent(s.slice(host[0].length));
    } catch {
      s = s.slice(host[0].length);
    }
    const pre = page ? page + "/" : "";
    if (pre && s.startsWith(pre)) s = s.slice(pre.length);
    if (!s || s.endsWith("/")) s += "index.html";
  } else if (s.startsWith("quire://runtime/")) s = `${BRAND.name} runtime (` + s.slice("quire://runtime/".length) + ")";
  return s;
}

function where(e) {
  const f = errorFile(e.source, e.page);
  return f ? f + (e.line ? ":" + e.line + (e.column ? ":" + e.column : "") : "") : "";
}

/** Add or update one error (same key from the same page bumps its count). */
export function addPageError(list, page, error) {
  if (!error || typeof error.message !== "string") return list;
  const entry = { ...error, page: typeof page === "string" ? page : "" };
  const at = list.findIndex((x) => x.key === entry.key && x.page === entry.page);
  if (at >= 0) return list.map((x, i) => (i === at ? { ...x, count: Math.max(x.count || 1, entry.count || 1), time: entry.time } : x));
  return [entry, ...list].slice(0, 100);
}

export function ErrorPill({ errors, open, onToggle }) {
  if (!errors.length) return null;
  const n = errors.reduce((sum, e) => sum + (e.count || 1), 0);
  return (
    <button type="button" className={"error-pill" + (open ? " is-open" : "")} onClick={onToggle} aria-expanded={open} title="Errors from this page's scripts">
      <span className="error-dot" aria-hidden="true" />
      {n === 1 ? "1 error" : `${n} errors`}
    </button>
  );
}

export function ErrorPanel({ api, errors, page, titleFor, onClear, onClose }) {
  const list = [...errors].sort((a, b) => (b.time || 0) - (a.time || 0));
  const copy = (e) => {
    const text = e.message + "\n" + (e.stack && !e.stack.startsWith(e.message) ? e.stack : e.stack || (where(e) ? "    at " + where(e) : ""));
    (api.copyText ? api.copyText(text) : navigator.clipboard.writeText(text)).catch(() => {});
  };
  return (
    <div className="build-log error-panel" role="region" aria-label="Page errors">
      <div className="build-log-head">
        <strong>Page errors</strong>
        <span className="build-log-cmd">Cleared when the page reloads</span>
        <button type="button" className="settings-button" onClick={onClear}>
          Clear
        </button>
        <button type="button" className="settings-close" aria-label="Hide page errors" onClick={onClose}>
          ×
        </button>
      </div>
      <ul className="error-list">
        {list.map((e) => (
          <li key={e.page + "|" + e.key} className="error-item">
            <div className="error-main">
              <span className="error-message">{e.message}</span>
              <span className="error-meta">
                {where(e) ? <span className="error-where">{where(e)}</span> : null}
                {e.page && e.page !== page ? <span>in {titleFor(e.page)}</span> : null}
                {e.count > 1 ? <span>×{e.count}</span> : null}
                {e.time ? <span>{new Date(e.time).toLocaleTimeString()}</span> : null}
              </span>
            </div>
            <button type="button" className="settings-button error-copy" onClick={() => copy(e)}>
              Copy
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
