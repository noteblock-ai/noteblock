import { useEffect, useRef, useState } from "react";
import { CloseIcon, Spinner } from "./icons.jsx";
import { StableLabel } from "./PublishingPane.jsx";

/**
 * The Publish button's dropdown: items with an optional second line, under `anchor` (a DOM
 * rect), right-aligned to it. Arrow keys move, Enter picks, Esc or a click outside closes.
 * items: [{id, label, sub?, danger?} | {type: "separator"}]
 */
export default function PublishMenu({ anchor, items, onPick, onClose }) {
  const ref = useRef(null);
  const choices = items.filter((it) => it.type !== "separator");
  const [active, setActive] = useState(0);

  useEffect(() => {
    ref.current?.focus();
    const onDown = (e) => {
      if (ref.current && !ref.current.contains(e.target)) onClose();
    };
    window.addEventListener("mousedown", onDown, true);
    window.addEventListener("blur", onClose);
    return () => {
      window.removeEventListener("mousedown", onDown, true);
      window.removeEventListener("blur", onClose);
    };
  }, [onClose]);

  const onKey = (e) => {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      onClose();
    } else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      setActive((a) => (a + (e.key === "ArrowDown" ? 1 : choices.length - 1)) % choices.length);
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (choices[active]) onPick(choices[active].id);
    }
  };

  const style = { top: Math.round(anchor.bottom + 6), right: Math.round(window.innerWidth - anchor.right) };
  return (
    <div ref={ref} className="pub-menu" role="menu" tabIndex={-1} style={style} onKeyDown={onKey}>
      {items.map((it, i) =>
        it.type === "separator" ? (
          <div key={"sep" + i} className="pub-menu-sep" role="separator" />
        ) : (
          <button
            key={it.id}
            type="button"
            role="menuitem"
            className={"pub-menu-item" + (choices[active] === it ? " is-active" : "") + (it.danger ? " is-danger" : "")}
            onMouseEnter={() => setActive(choices.indexOf(it))}
            onClick={() => onPick(it.id)}
          >
            <span className="pub-menu-label">{it.label}</span>
            {it.sub ? <span className="pub-menu-sub">{it.sub}</span> : null}
          </button>
        ),
      )}
    </div>
  );
}

/**
 * A folder's publish job, bottom right: busy, then its link, or what went wrong. "Unpublished"
 * goes away by itself; the link stays until it's dismissed.
 * job: {folder, kind: "publish"|"unpublish", state: "publishing"|"unpublishing"|"done"|"gone"|"error", public?, error?, output?, failed?,
 *      code?: "plan_limit", upgrade?: boolean (offer Upgrade to Pro)}
 */
export function FolderPublishToast({ job, onRetry, onOpenPage, onUpgrade, onDismiss }) {
  const [copied, setCopied] = useState(false);
  const [logOpen, setLogOpen] = useState(false);
  const name = job.folder.split("/").pop();
  const { state, kind } = job;

  useEffect(() => {
    if (state !== "gone") return;
    const t = setTimeout(onDismiss, 4000);
    return () => clearTimeout(t);
  }, [state]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(false), 1500);
    return () => clearTimeout(t);
  }, [copied]);

  const dismiss = (
    <button type="button" className="update-toast-btn" style={{ padding: "0 8px" }} aria-label="Dismiss" title="Dismiss" onClick={onDismiss}>
      <CloseIcon size={12} />
    </button>
  );

  if (state === "publishing" || state === "unpublishing") {
    return (
      <div className="update-toast folder-toast" role="status" aria-live="polite">
        <span className="update-toast-text">
          <Spinner size={12} />
          <span className="folder-toast-name">
            {state === "unpublishing" ? "Unpublishing" : "Publishing"} {name}…
          </span>
        </span>
      </div>
    );
  }
  if (state === "gone") {
    return (
      <div className="update-toast folder-toast" role="status" aria-live="polite">
        <span className="update-toast-text">
          <span className="folder-toast-name">{name} unpublished</span>
        </span>
        <div className="update-toast-actions">{dismiss}</div>
      </div>
    );
  }
  if (state === "done") {
    const url = job.public?.url || "";
    let host = url;
    try {
      host = new URL(url).host;
    } catch {}
    return (
      <div className="update-toast folder-toast" role="status" aria-live="polite">
        <span className="update-toast-text folder-toast-live">
          <span className="folder-toast-name">{name} is live</span>
          <span className="folder-toast-link" title={url}>
            {host}
          </span>
        </span>
        <div className="update-toast-actions">
          <button type="button" className="update-toast-btn primary" onClick={() => window.open(url, "_blank")}>
            Open
          </button>
          <button
            type="button"
            className="update-toast-btn"
            onClick={() =>
              navigator.clipboard?.writeText(url).then(
                () => setCopied(true),
                () => {},
              )
            }
          >
            <StableLabel value={copied ? "Copied" : "Copy"} options={["Copy", "Copied"]} />
          </button>
          {dismiss}
        </div>
      </div>
    );
  }
  return (
    <div className="update-toast folder-toast failed" role="alert">
      <div className="folder-toast-error">
        <span className="update-toast-text">
          <span className="folder-toast-name">{kind === "unpublish" ? `${name} wasn't unpublished` : `${name} wasn't published`}</span>
        </span>
        <span className="folder-toast-msg">{job.error}</span>
        {logOpen ? <pre className="folder-toast-log">{job.output}</pre> : null}
      </div>
      <div className="update-toast-actions">
        {job.failed?.length ? (
          <button type="button" className="update-toast-btn" onClick={() => onOpenPage(job.failed[0])}>
            Open page
          </button>
        ) : null}
        {job.code === "plan_limit" && job.upgrade && onUpgrade ? (
          <button type="button" className="update-toast-btn primary" onClick={onUpgrade}>
            Upgrade to Pro
          </button>
        ) : null}
        {job.output ? (
          <button type="button" className="update-toast-btn" onClick={() => setLogOpen((o) => !o)}>
            Log
          </button>
        ) : null}
        <button type="button" className={"update-toast-btn" + (job.code === "plan_limit" && job.upgrade && onUpgrade ? "" : " primary")} onClick={onRetry}>
          Try again
        </button>
        {dismiss}
      </div>
    </div>
  );
}
