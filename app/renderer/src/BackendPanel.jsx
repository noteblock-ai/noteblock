import { useEffect, useRef, useState } from "react";
import { words } from "./platform.js";
import { BRAND } from "../../../core/brand.mjs";

const DOT = { running: "is-ok", starting: "is-wait", crashed: "is-bad", exited: "is-off", stopped: "is-off" };
const LABEL = { running: "Running", starting: "Starting", crashed: "Crashed", exited: "Exited", stopped: "Stopped" };

/** The top-bar pill for a page's backend: one dot for the worst process state. */
export function BackendPill({ status, open, onToggle }) {
  if (!status) return null;
  const states = status.procs.map((p) => p.state);
  const worst = ["crashed", "starting", "running", "exited", "stopped"].find((s) => states.includes(s)) || "stopped";
  return (
    <button type="button" className={"backend-pill" + (open ? " is-open" : "")} onClick={onToggle} aria-expanded={open} title="Backend processes and logs">
      <span className={"backend-dot " + DOT[worst]} aria-hidden="true" />
      Backend
    </button>
  );
}

/** Which `.noteblock` "requires" key a missing program belongs to: python3 → python. */
const FAMILY = { python3: "python", pip: "python", pip3: "python", npm: "node", npx: "node", uvx: "uv", gem: "ruby", bundle: "ruby" };

function requiredVersion(requires, tool) {
  if (!requires || !tool) return null;
  const t = tool.toLowerCase();
  for (const key of [t, FAMILY[t], t.replace(/[\d.]+$/, "")]) {
    const v = key && requires[key];
    if (v) return { key, version: v === "*" ? null : v };
  }
  return null;
}

/** "python 3.12, uv" from a .noteblock "requires". */
export const requiresLabel = (requires) =>
  requires ? Object.entries(requires).map(([k, v]) => (v === "*" ? k : `${k} ${v}`)).join(", ") : "";

/**
 * The banner over a page whose backend couldn't start because a program it runs isn't on this
 * Mac. Quire doesn't install it; it says what's missing and where to get it.
 */
export function MissingToolBanner({ status, onShowLog }) {
  const proc = status?.procs.find((p) => p.missingTool);
  if (!proc) return null;
  const req = requiredVersion(status.requires, proc.missingTool);
  const what = req?.version ? `${req.key[0].toUpperCase() + req.key.slice(1)} ${req.version} (` : null;
  return (
    <div className="lock-banner tool-banner" role="alert">
      <span className="backend-dot is-bad" aria-hidden="true" />
      <div className="lock-text">
        <strong>
          This page's backend needs {what}
          <code>{proc.missingTool}</code>
          {what ? ")" : ""}, which isn't on {words.computer}.
        </strong>
      </div>
      <span className="tool-banner-actions">
        <a className="settings-button" href={proc.missingHelp} target="_blank" rel="noreferrer">
          How to get it
        </a>
        <button type="button" className="settings-button" onClick={() => onShowLog(proc.name)}>
          Show log
        </button>
      </span>
    </div>
  );
}

/** Processes, ports and the selected one's log, with Restart / Stop. */
export function BackendPanel({ api, page, status, onClose, tab: initialTab = null }) {
  const [tab, setTab] = useState(initialTab);
  useEffect(() => {
    if (initialTab) setTab(initialTab);
  }, [initialTab]);
  const [log, setLog] = useState("");
  const pre = useRef(null);
  const name = tab && status?.procs.some((p) => p.name === tab) ? tab : status?.procs[0]?.name;

  useEffect(() => {
    if (!name) return;
    let alive = true;
    const load = () => api.backendLog(page, name).then((t) => alive && setLog(t || ""), () => {});
    load();
    const t = setInterval(load, 1000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [api, page, name]);
  useEffect(() => {
    const el = pre.current;
    if (el && el.scrollHeight - el.scrollTop - el.clientHeight < 80) el.scrollTop = el.scrollHeight;
  }, [log]);

  if (!status) return null;
  const running = status.procs.some((p) => p.state !== "stopped");
  return (
    <div className="build-log backend-panel" role="region" aria-label="Backend">
      <div className="build-log-head">
        <strong className="backend-title">Backend</strong>
        {status.requires ? (
          <span className="backend-requires" title={`From this page's .noteblock "requires". ${BRAND.name} doesn't install these.`}>
            Needs {requiresLabel(status.requires)}
          </span>
        ) : null}
        <span className="backend-tabs" role="tablist">
          {status.procs.map((p) => (
            <button
              key={p.name}
              type="button"
              role="tab"
              aria-selected={p.name === name}
              className={"backend-tab" + (p.name === name ? " is-on" : "")}
              onClick={() => setTab(p.name)}
              title={p.cmd}
            >
              <span className={"backend-dot " + DOT[p.state]} aria-hidden="true" />
              {p.name}
              <span className="backend-meta">
                {LABEL[p.state]}
                {p.port ? ` · :${p.port}` : ""}
                {p.name === status.proxy ? " · /api" : ""}
              </span>
            </button>
          ))}
        </span>
        <button type="button" className="settings-button" onClick={() => api.backendRestart(page).catch(() => {})}>
          {running ? "Restart" : "Start"}
        </button>
        {running ? (
          <button type="button" className="settings-button" onClick={() => api.backendStop(page).catch(() => {})}>
            Stop
          </button>
        ) : null}
        <button type="button" className="settings-close" aria-label="Hide backend" onClick={onClose}>
          ×
        </button>
      </div>
      <pre ref={pre}>{log || "No output yet"}</pre>
    </div>
  );
}
