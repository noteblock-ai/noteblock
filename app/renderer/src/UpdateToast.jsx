// Bottom-right toast for app updates (state from app/main/updater.mjs). Updates download silently,
// so normally the only thing seen is "X is ready" with Restart and a dismiss; dismissed, the update
// goes in on the next quit. status.manual (the person asked, from the menu or Retry) also shows
// checking and download progress. "failed" only ever reaches here when the person asked.
import { useEffect, useState } from "react";
import { CloseIcon, Spinner } from "./icons.jsx";
import { readLocal, writeLocal } from "./tree.js";
import { BRAND } from "../../../core/brand.mjs";

const DISMISS_KEY = "quire.updateReadyDismissed";

function Dismiss({ onClick }) {
  return (
    <button type="button" className="update-toast-btn" style={{ padding: "0 8px" }} aria-label="Dismiss" title="Dismiss" onClick={onClick}>
      <CloseIcon size={12} />
    </button>
  );
}

export default function UpdateToast({ status, onRun, onShowLog }) {
  const [dismissed, setDismissed] = useState(() => readLocal(DISMISS_KEY, null));
  const [closedFailure, setClosedFailure] = useState(null);

  // Only on a new status: the menu's check brings a dismissed toast back, and dismissing
  // while that status is still current must stick.
  useEffect(() => {
    if (status?.manual && status.state === "ready") {
      setDismissed(null);
      writeLocal(DISMISS_KEY, null);
    }
  }, [status]);

  const state = status?.state;
  const busy = status?.manual && ["checking", "available", "downloading"].includes(state);
  if (!busy && state !== "ready" && state !== "failed") return null;
  if (state === "ready" && status.version === dismissed) return null;
  if (state === "failed" && status === closedFailure) return null;

  const dismissReady = () => {
    setDismissed(status.version);
    writeLocal(DISMISS_KEY, status.version);
  };

  return (
    <div className={"update-toast" + (state === "failed" ? " failed" : "")} role="status" aria-live="polite">
      {state === "checking" ? (
        <span className="update-toast-text">
          <Spinner size={12} />
          <span>Checking for updates…</span>
        </span>
      ) : busy ? (
        <span className="update-toast-text">
          <Spinner size={12} />
          <span>
            Downloading {BRAND.name} {status.version}… <span className="update-toast-pct">{Math.max(0, Math.min(100, status.percent || 0))}%</span>
          </span>
        </span>
      ) : state === "ready" ? (
        <>
          <span className="update-toast-text">{BRAND.name} {status.version} is ready</span>
          <div className="update-toast-actions">
            <button type="button" className="update-toast-btn primary" onClick={onRun} disabled={!!status.installing}>
              {status.installing ? "Restarting…" : "Restart to update"}
            </button>
            {status.installing ? null : <Dismiss onClick={dismissReady} />}
          </div>
        </>
      ) : (
        <>
          <span className="update-toast-text" title={status.error || undefined}>
            Update failed
          </span>
          <div className="update-toast-actions">
            <button type="button" className="update-toast-btn" onClick={onShowLog}>
              Show log
            </button>
            <button type="button" className="update-toast-btn primary" onClick={onRun}>
              Retry
            </button>
            <Dismiss onClick={() => setClosedFailure(status)} />
          </div>
        </>
      )}
    </div>
  );
}
