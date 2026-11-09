import { useEffect, useState } from "react";
import Switch from "./Switch.jsx";
import { words } from "./platform.js";
import { BRAND } from "../../../core/brand.mjs";

const home = (p) => String(p || "").replace(/^\/Users\/[^/]+/, "~");

function where(row) {
  if (row.fixed) return `Fetched once at this version, run with ${row.via}`;
  if (row.source === "builtin") return "Built in";
  if (row.source === "system") return `This Mac: ${home(row.path)}`;
  return "Not found";
}

/**
 * Settings → Tools: the git, Node and pnpm Quire runs for its own features, where each one
 * comes from, and a switch to use the Mac's instead.
 */
export default function ToolsPane({ api }) {
  const [rows, setRows] = useState(null);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    api.toolsInfo().then(setRows, (e) => setError(String(e?.message || e)));
  }, [api]);

  const setMode = async (id, mode) => {
    setBusy(id);
    setError("");
    setRows((rs) => rs.map((r) => (r.id === id ? { ...r, mode } : r)));
    try {
      setRows(await api.setToolMode(id, mode));
    } catch (e) {
      setError(String(e?.message || e));
    } finally {
      setBusy("");
    }
  };

  if (!rows) return error ? <p className="settings-error" role="alert">{error}</p> : null;
  return (
    <>
      <p className="settings-hint">
        {BRAND.name} brings its own copies of the tools its features use. Anything else a page's backend runs, like python3, comes from {words.computer}.
      </p>
      <div className="editor-list tools-list">
        {rows.map((r) => {
          const bad = r.missing || r.source === "none";
          return (
            <div className="editor-row tools-row" key={r.id} data-setting={"tools." + r.id}>
              <div className="tools-main">
                <span className={"backend-dot " + (bad ? "is-bad" : "is-ok")} aria-hidden="true" />
                <div className="editor-label">
                  <span className="tools-name">
                    {r.name}
                    {r.version ? <span className="tools-version">{r.version}</span> : null}
                  </span>
                  <span className={r.source === "system" ? "tools-where" : "editor-sub"}>{where(r)}</span>
                  <span className="editor-sub">{r.uses}</span>
                  {r.missing ? (
                    <span className="tools-missing" role="alert">
                      Not found on {words.computer}{r.source === "builtin" ? `, so ${BRAND.name}'s own is used` : ""}.
                      <button type="button" className="settings-button" disabled={!!busy} onClick={() => setMode(r.id, "builtin")}>
                        Use built-in
                      </button>
                    </span>
                  ) : null}
                </div>
              </div>
              {r.fixed ? null : (
                <label className="tools-switch" htmlFor={`tool-${r.id}`}>
                  <span id={`tool-${r.id}-label`}>Use the one on {words.computer}</span>
                  <Switch
                    id={`tool-${r.id}`}
                    labelledBy={`tool-${r.id}-label`}
                    checked={r.mode === "system"}
                    disabled={busy === r.id}
                    onChange={(on) => setMode(r.id, on ? "system" : "builtin")}
                  />
                </label>
              )}
            </div>
          );
        })}
      </div>
      <p className="settings-hint">Git here is for {BRAND.name}'s own history and sync. The quire command line tool uses {words.computers} git.</p>
      {error ? <p className="settings-error" role="alert">{error}</p> : null}
    </>
  );
}
