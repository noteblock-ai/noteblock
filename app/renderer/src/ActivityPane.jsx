// Settings → Activity & limits: memory, CPU and process count of Quire and every page backend,
// Stop / Restart / Logs per backend, and below them every limit in limits.mjs (page recovery and
// the backend watchdog), saved as soon as one changes. Polls quire:activity every 2 s while shown.
import { useEffect, useState } from "react";
import LimitsSection from "./LimitsSection.jsx";
import { BRAND } from "../../../core/brand.mjs";

const POLL_MS = 2000;

const DOT = { running: "is-ok", starting: "is-wait", crashed: "is-bad", exited: "is-off", stopped: "is-off" };

function stateLabel(p) {
  if (p.state === "stopped") return p.reason === "idle" ? "Stopped · idle" : p.reason === "cap" ? "Stopped · max running" : p.limitHit ? "Stopped · limit" : "Stopped";
  if (p.state === "crashed" && p.limitHit === "crashes") return "Crashed · gave up";
  return { running: "Running", starting: "Starting", crashed: "Crashed", exited: "Exited" }[p.state] || p.state;
}

/** Why Quire stopped it, for a limit (not idle / max running, which the label says). */
const limitReason = (p) => (p.limitHit && p.limitHit !== "idle" && p.limitHit !== "cap" && p.reason ? p.reason : "");

export function formatBytes(n) {
  if (n == null) return "—";
  const mb = n / (1024 * 1024);
  if (mb < 1) return "<1 MB";
  if (mb < 1000) return Math.round(mb) + " MB";
  return (mb / 1024).toFixed(mb < 10240 ? 2 : 1) + " GB";
}

const formatCpu = (c) => (c == null ? "—" : (c < 10 ? c.toFixed(1) : Math.round(c)) + "%");

function sinceLabel(ms, now) {
  if (!ms) return "—";
  const s = Math.max(0, Math.round((now - ms) / 1000));
  if (s < 45) return "just now";
  const m = Math.round(s / 60);
  if (m < 60) return m + " min ago";
  const h = Math.round(m / 60);
  if (h < 24) return h + (h === 1 ? " hour ago" : " hours ago");
  return new Date(ms).toLocaleDateString([], { month: "short", day: "numeric" });
}

const isUp = (p) => p.state !== "stopped";

export default function ActivityPane({ api, onOpenPage }) {
  const [snap, setSnap] = useState(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState({}); // page → true while a row action runs

  // Poll while this pane is mounted (the Activity tab is open) and the window is visible.
  useEffect(() => {
    let alive = true;
    let timer = null;
    const tick = async () => {
      timer = null;
      if (!document.hidden) {
        try {
          const next = await api.activity();
          if (!alive) return;
          setSnap(next);
          setError("");
        } catch (e) {
          if (alive) setError(String(e?.message || e));
        }
      }
      if (alive) timer = setTimeout(tick, POLL_MS);
    };
    api.activity().then(
      (next) => alive && setSnap(next),
      (e) => alive && setError(String(e?.message || e)),
    ).finally(() => alive && (timer = setTimeout(tick, POLL_MS)));
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [api]); // eslint-disable-line react-hooks/exhaustive-deps

  // A limit changed (it may have stopped backends at once): refresh the table now.
  const refresh = () => api.activity().then(setSnap, () => {});

  const rowAction = async (page, fn) => {
    if (busy[page]) return;
    setBusy((b) => ({ ...b, [page]: true }));
    try {
      await fn();
      setSnap(await api.activity());
    } catch (e) {
      setError(String(e?.message || e));
    } finally {
      setBusy((b) => ({ ...b, [page]: false }));
    }
  };

  const stopAll = async () => {
    if (busy["\0all"]) return;
    setBusy((b) => ({ ...b, "\0all": true }));
    try {
      setSnap(await api.stopAllBackends());
    } catch (e) {
      setError(String(e?.message || e));
    } finally {
      setBusy((b) => ({ ...b, "\0all": false }));
    }
  };

  if (!snap) return error ? <p className="settings-error" role="alert">{error}</p> : null;

  const now = snap.at;
  const rows = [...snap.backends].sort((a, b) => {
    if (isUp(a) !== isUp(b)) return isUp(a) ? -1 : 1;
    if (isUp(a)) return (b.memory || 0) - (a.memory || 0);
    return a.title.localeCompare(b.title) || a.name.localeCompare(b.name);
  });
  const max = snap.limits.maxRunning;
  const appProcs = snap.app.reduce((t, g) => t + g.processes, 0);

  return (
    <div className="activity-pane">
      <div className="activity-stats">
        <div className="activity-stat" data-setting="activity.memory">
          <span className="activity-stat-label">Total memory</span>
          <span className="activity-stat-value">{formatBytes(snap.totals.overall.memory)}</span>
          <span className="activity-stat-sub">{BRAND.name} and its page backends</span>
        </div>
        <div className="activity-stat">
          <span className="activity-stat-label">{BRAND.name} app</span>
          <span className="activity-stat-value">{formatBytes(snap.totals.app.memory)}</span>
          <span className="activity-stat-sub">
            {appProcs} {appProcs === 1 ? "process" : "processes"} · {formatCpu(snap.totals.app.cpu)} CPU
          </span>
        </div>
        <div className="activity-stat">
          <span className="activity-stat-label">Page backends</span>
          <span className="activity-stat-value">{formatBytes(snap.totals.backends.memory)}</span>
          <span className="activity-stat-sub">{max ? `${snap.running} running of ${max} max` : `${snap.running} running · no limit`}</span>
        </div>
      </div>
      <p className="settings-hint activity-note">Refreshes every 2s. Memory and processes count each backend's whole process tree.</p>

      {error ? <p className="settings-error activity-error" role="alert">{error}</p> : null}

      <div className="activity-section-head" data-setting="activity.backends">
        <span className="vault-field-label">Page backends</span>
        <button type="button" className="settings-button" disabled={!snap.running || busy["\0all"]} onClick={stopAll}>
          Stop all
        </button>
      </div>
      {!rows.length ? <p className="activity-empty">No page in this vault has a backend.</p> : null}
      {rows.length ? (
        <div className="activity-table" role="table" aria-label="Page backend processes">
          <div className="activity-tr activity-th" role="row">
            <span role="columnheader">Page</span>
            <span role="columnheader">State</span>
            <span role="columnheader" className="is-num">Processes</span>
            <span role="columnheader" className="is-num">Memory</span>
            <span role="columnheader" className="is-num">CPU</span>
            <span role="columnheader">Last used</span>
            <span role="columnheader" aria-label="Actions" />
          </div>
          {rows.map((p) => {
            const up = isUp(p);
            const working = !!busy[p.page] || !!busy["\0all"];
            return (
              <div key={p.page + "\0" + p.name} className={"activity-tr" + (up ? "" : " is-stopped")} role="row">
                <span role="cell" className="activity-page">
                  <button type="button" className="activity-page-link" title={"Open " + p.page} onClick={() => onOpenPage(p.page)}>
                    {p.title}
                  </button>
                  <span className="activity-proc" title={p.cmd}>
                    {p.name}
                    {p.port ? ` · :${p.port}` : ""}
                    {p.restarts ? ` · ${p.restarts} restarts` : ""}
                  </span>
                </span>
                <span role="cell" className="activity-state" title={p.reason && limitReason(p) ? p.reason : undefined}>
                  <span className="activity-state-line">
                    <span className={"backend-dot " + (DOT[p.state] || "is-off")} aria-hidden="true" />
                    {stateLabel(p)}
                  </span>
                  {limitReason(p) ? <span className="activity-why">{limitReason(p).replace(/ — .*$/, "")}</span> : null}
                </span>
                <span role="cell" className="is-num">{up && p.processes ? p.processes : "—"}</span>
                <span role="cell" className="is-num">{formatBytes(p.memory)}</span>
                <span role="cell" className="is-num">{formatCpu(p.cpu)}</span>
                <span role="cell" className="activity-when" title={p.uptimeMs ? `Up ${sinceLabel(now - p.uptimeMs, now).replace(" ago", "")}` : undefined}>
                  {sinceLabel(p.lastUsed, now)}
                </span>
                <span role="cell" className="activity-actions">
                  {up ? (
                    <button type="button" className="activity-act" disabled={working} onClick={() => rowAction(p.page, () => api.backendStop(p.page))}>
                      Stop
                    </button>
                  ) : null}
                  <button type="button" className="activity-act" disabled={working} onClick={() => rowAction(p.page, () => api.backendRestart(p.page))}>
                    {up ? "Restart" : "Start"}
                  </button>
                  <button type="button" className="activity-act" onClick={() => onOpenPage(p.page, { backend: true })} title="Open the page with its Backend panel">
                    Logs
                  </button>
                </span>
              </div>
            );
          })}
        </div>
      ) : null}

      {snap.builds.length ? (
        <>
          <div className="activity-section-head">
            <span className="vault-field-label">Builds running</span>
          </div>
          <div className="activity-table">
            {snap.builds.map((b) => (
              <div key={b.page} className="activity-tr" role="row">
                <span role="cell" className="activity-page">
                  <button type="button" className="activity-page-link" onClick={() => onOpenPage(b.page)}>
                    {b.page.split("/").pop()}
                  </button>
                  <span className="activity-proc">build</span>
                </span>
                <span role="cell" className="activity-state">
                  <span className="activity-state-line">
                    <span className="backend-dot is-wait" aria-hidden="true" />
                    Building
                  </span>
                </span>
                <span role="cell" />
                <span role="cell" className="is-num">{formatBytes(b.memory)}</span>
                <span role="cell" className="is-num">{formatCpu(b.cpu)}</span>
                <span role="cell" className="activity-when">{b.startedAt ? sinceLabel(b.startedAt, now).replace(" ago", "") : "—"}</span>
                <span role="cell" />
              </div>
            ))}
          </div>
        </>
      ) : null}

      <details className="activity-app" data-setting="activity.app">
        <summary>
          <span>{BRAND.name} app processes</span>
          <span className="activity-app-sum">{formatBytes(snap.totals.app.memory)}</span>
        </summary>
        <div className="activity-table activity-app-table">
          {snap.app.map((g) => (
            <div key={g.label} className="activity-tr" role="row">
              <span role="cell" className="activity-page">
                <span className="activity-app-label">{g.label}</span>
                <span className="activity-proc">
                  {g.processes} {g.processes === 1 ? "process" : "processes"}
                </span>
              </span>
              <span role="cell" />
              <span role="cell" className="is-num">{g.processes}</span>
              <span role="cell" className="is-num">{formatBytes(g.memory)}</span>
              <span role="cell" className="is-num">{formatCpu(g.cpu)}</span>
              <span role="cell" />
              <span role="cell" />
            </div>
          ))}
          {snap.pages ? (
            <>
              <div className="activity-tr activity-pages-sum" role="row">
                <span role="cell" className="activity-page">
                  <span className="activity-app-label">Pages</span>
                  <span className="activity-proc">
                    {snap.pages.processes} {snap.pages.processes === 1 ? "process" : "processes"}, {formatBytes(snap.pages.memory)} · one per open page or embed
                  </span>
                </span>
                <span role="cell" />
                <span role="cell" className="is-num">{snap.pages.processes}</span>
                <span role="cell" className="is-num">{formatBytes(snap.pages.memory)}</span>
                <span role="cell" />
                <span role="cell" />
                <span role="cell" />
              </div>
              {snap.pages.top.map((p) => (
                <div key={p.pid} className="activity-tr activity-page-proc" role="row">
                  <span role="cell" className="activity-page">
                    <span className="activity-page-titles">
                    {p.pages.map((pg, i) => (
                      <span key={pg.path}>
                        {i ? ", " : ""}
                        <button type="button" className="activity-page-link" onClick={() => onOpenPage?.(pg.path)}>
                          {pg.title}
                        </button>
                      </span>
                    ))}
                    </span>
                    <span className="activity-proc">pid {p.pid}</span>
                  </span>
                  <span role="cell" />
                  <span role="cell" className="is-num">1</span>
                  <span role="cell" className="is-num">{formatBytes(p.memory)}</span>
                  <span role="cell" />
                  <span role="cell" />
                  <span role="cell" />
                </div>
              ))}
            </>
          ) : null}
        </div>
      </details>

      <LimitsSection api={api} onChanged={refresh} />
    </div>
  );
}
