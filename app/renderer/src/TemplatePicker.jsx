import { useEffect, useMemo, useRef, useState } from "react";
import { PageIcon } from "./icons.jsx";
import { score } from "./Palette.jsx";

/** A command as the person should read it: nothing that hides or reorders text (newlines, bidi). */
const visibleCommand = (c) => c.replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2060-\u2069\ufeff]/g, (ch) => "\\u" + ch.charCodeAt(0).toString(16).padStart(4, "0"));

/**
 * ⌘⇧N: pick a template (title, category, description; typing filters), then the sidebar asks
 * for the page name. onPick(template) gets {path, title, …}.
 */
export default function TemplatePicker({ api, folder, onPick, onClose }) {
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const [list, setList] = useState(null);
  const [error, setError] = useState("");
  const [adding, setAdding] = useState(false);
  const [url, setUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [addError, setAddError] = useState("");
  const [confirm, setConfirm] = useState(null); // commands the repo wants to run
  const [focusPath, setFocusPath] = useState(null);
  const inputRef = useRef(null);
  const listRef = useRef(null);

  useEffect(() => {
    requestAnimationFrame(() => inputRef.current?.focus());
    api.listTemplates().then((s) => setList(s?.templates || []), (e) => (setList([]), setError(String(e?.message || e))));
  }, [api]);

  const items = useMemo(() => {
    const all = list || [];
    const q = query.trim();
    if (!q) return all;
    return all
      .map((t) => ({ t, s: Math.max(score(q, t.title), t.category ? score(q, t.category + "/" + t.title) - 50 : -1, t.description ? score(q, t.description) - 200 : -1) }))
      .filter((x) => x.s >= 0)
      .sort((a, b) => b.s - a.s)
      .map((x) => x.t);
  }, [list, query]);

  useEffect(() => setActive(0), [query]);
  useEffect(() => {
    listRef.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: "nearest" });
  }, [active]);
  useEffect(() => {
    if (focusPath) {
      const i = items.findIndex((t) => t.path === focusPath);
      if (i >= 0) setActive(i);
      setFocusPath(null);
    } else if (active >= items.length && items.length) setActive(items.length - 1);
  }, [items, focusPath, active]);

  const closeAdder = () => {
    setAdding(false);
    setUrl("");
    setAddError("");
    setConfirm(null);
    requestAnimationFrame(() => inputRef.current?.focus());
  };

  const addFromUrl = async (opts) => {
    if (busy || !url.trim()) return;
    setBusy(true);
    setAddError("");
    try {
      const res = await api.addTemplateFromUrl(url.trim(), opts);
      if (res.needsConfirm) {
        setConfirm(res.needsConfirm.commands);
        return;
      }
      const state = await api.listTemplates();
      setList(state?.templates || []);
      setQuery("");
      setFocusPath(res.added[0]?.path || null);
      closeAdder();
    } catch (e) {
      setConfirm(null);
      setAddError(String(e?.message || e));
    } finally {
      setBusy(false);
    }
  };

  const onAddKeyDown = (e) => {
    if (e.key === "Escape") {
      e.preventDefault();
      if (busy) onClose();
      else if (confirm) setConfirm(null);
      else closeAdder();
    } else if (e.key === "Enter" && !confirm) {
      e.preventDefault();
      addFromUrl({});
    }
  };

  const remove = (t) => {
    api.trashTemplate(t.path).then((s) => setList(s?.templates || []), (e) => setError(String(e?.message || e)));
  };

  const pick = (t) => {
    if (!t) return;
    onClose();
    onPick(t);
  };

  const onKeyDown = (e) => {
    if (e.key === "ArrowDown" || (e.ctrlKey && e.key === "n")) {
      e.preventDefault();
      setActive((a) => Math.min(a + 1, items.length - 1));
    } else if (e.key === "ArrowUp" || (e.ctrlKey && e.key === "p")) {
      e.preventDefault();
      setActive((a) => Math.max(a - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      pick(items[active]);
    } else if (e.key === "Escape") {
      e.preventDefault();
      onClose();
    }
  };

  const empty = list && !list.length;
  return (
    <div className="palette-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="palette template-picker" role="dialog" aria-modal="true" aria-label="New page from template">
        <input
          ref={inputRef}
          className="palette-input"
          placeholder={folder ? `New page in ${folder} from a template` : "New page from a template"}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={onKeyDown}
          role="combobox"
          aria-expanded="true"
          aria-controls="template-list"
          aria-activedescendant={items[active] ? "template-" + active : undefined}
          spellCheck={false}
        />
        <div className="palette-list" id="template-list" role="listbox" ref={listRef}>
          {empty ? (
            <div className="template-empty">
              <p>{error || "Your templates folder is empty. Add a page folder to it, or save a page as a template in Settings."}</p>
              <button type="button" className="settings-button" onClick={() => api.revealTemplate("")}>
                Open templates folder
              </button>
            </div>
          ) : items.length ? (
            items.map((t, i) => (
              <div
                key={t.path}
                id={"template-" + i}
                role="option"
                aria-selected={i === active}
                className="palette-item template-item"
                onMouseMove={() => i !== active && setActive(i)}
                onMouseDown={(e) => {
                  e.preventDefault();
                  pick(t);
                }}
              >
                <PageIcon size={14} className="palette-icon" />
                <span className="template-text">
                  <span className="template-title">
                    <span className="palette-label">{t.title}</span>
                    {t.category ? <span className="palette-sub">{t.category}</span> : null}
                  </span>
                  {t.description ? <span className="template-desc">{t.description}</span> : null}
                </span>
                {t.sourceUrl ? (
                  <button
                    type="button"
                    className="template-remove"
                    aria-label={`Remove ${t.title}`}
                    title="Remove template"
                    onMouseDown={(e) => {
                      e.preventDefault();
                      e.stopPropagation();
                      remove(t);
                    }}
                  >
                    ×
                  </button>
                ) : null}
              </div>
            ))
          ) : list ? (
            <div className="palette-empty">No matches</div>
          ) : null}
        </div>
        {api.addTemplateFromUrl ? (
          <div className="template-add" onKeyDown={adding ? onAddKeyDown : undefined}>
            {!adding ? (
              <button type="button" className="template-add-open" onClick={() => setAdding(true)}>
                Add from GitHub…
              </button>
            ) : confirm ? (
              <>
                <p className="template-add-warning">
                  This template runs code on your computer:{" "}
                  {confirm.map((c, i) => (
                    <code key={i}>{visibleCommand(c)}</code>
                  ))}
                </p>
                <div className="template-add-actions">
                  <button type="button" className="settings-button is-primary" autoFocus disabled={busy} onClick={() => addFromUrl({ allowCode: false })}>
                    Add without running it
                  </button>
                  <button type="button" className="settings-button" disabled={busy} onClick={() => addFromUrl({ allowCode: true, commands: confirm })}>
                    Add and allow
                  </button>
                </div>
              </>
            ) : (
              <div className="template-add-field">
                <input
                  autoFocus
                  className="settings-input template-name"
                  placeholder="https://github.com/owner/repo"
                  aria-label="GitHub address"
                  value={url}
                  readOnly={busy}
                  onChange={(e) => setUrl(e.target.value)}
                  spellCheck={false}
                />
                <button type="button" className="settings-button template-add-go" disabled={busy || !url.trim()} onClick={() => addFromUrl({})}>
                  {busy ? "Adding…" : "Add"}
                </button>
              </div>
            )}
            {addError ? <p className="template-add-error" role="alert">{addError}</p> : null}
          </div>
        ) : null}
        <div className="palette-foot" aria-hidden="true">
          <span><kbd>↵</kbd> use</span>
          <span><kbd>esc</kbd> close</span>
        </div>
      </div>
    </div>
  );
}
