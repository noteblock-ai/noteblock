import { useEffect, useMemo, useRef, useState } from "react";
import { formatAccelerator, isMac, isWin, words } from "./platform.js";
import { flatten } from "./tree.js";
import { RENDERER_LABELS } from "./App.jsx";
import ActivityPane from "./ActivityPane.jsx";
import ConfirmDialog from "./ConfirmDialog.jsx";
import PublishingPane from "./PublishingPane.jsx";
import AiPane from "./AiPane.jsx";
import AccountPane from "./AccountPane.jsx";
import FeedbackPane from "./FeedbackPane.jsx";
import PlanPane from "./PlanPane.jsx";
import DebugPane from "./DebugPane.jsx";
import ToolsPane from "./ToolsPane.jsx";
import { artifactPrompt } from "./artifactPrompt.js";
import { SECTION_LABELS, searchSettings, settingsSearchIndex } from "./settingsIndex.js";
import { BRAND } from "../../../core/brand.mjs";

const CODE_KEYS = {
  Comma: ",", Period: ".", Slash: "/", Semicolon: ";", Quote: "'", BracketLeft: "[", BracketRight: "]",
  Backslash: "\\", Minus: "-", Equal: "=", Backquote: "`", Space: "Space", Enter: "Enter", Tab: "Tab",
  Backspace: "Backspace", Delete: "Delete", ArrowUp: "Up", ArrowDown: "Down", ArrowLeft: "Left", ArrowRight: "Right",
  Home: "Home", End: "End", PageUp: "PageUp", PageDown: "PageDown",
};

/** Keyboard event → Electron accelerator, or null when it isn't a usable shortcut yet. */
function toAccelerator(e) {
  let key = null;
  if (/^Key[A-Z]$/.test(e.code)) key = e.code.slice(3);
  else if (/^Digit\d$/.test(e.code)) key = e.code.slice(5);
  else if (/^F\d{1,2}$/.test(e.code)) key = e.code;
  else key = CODE_KEYS[e.code] || null;
  if (!key) return null;
  const mods = [];
  // Off the Mac, Ctrl is the command key (CmdOrCtrl, like the defaults) and the Windows key is Super.
  if (e.ctrlKey) mods.push(isMac ? "Ctrl" : "CmdOrCtrl");
  if (e.altKey) mods.push("Alt");
  if (e.shiftKey) mods.push("Shift");
  if (e.metaKey) mods.push(isMac ? "CmdOrCtrl" : "Super");
  // Plain letters would fire while typing; require Cmd, Ctrl or Option (F-keys may stand alone).
  if (!e.metaKey && !e.ctrlKey && !e.altKey && !/^F\d/.test(key)) return null;
  return [...mods, key].join("+");
}

/** The shortcut label (platform.js formatAccelerator): ⇧⌘N on a Mac, Ctrl+Shift+N elsewhere. */
export const prettyAccelerator = (acc) => formatAccelerator(acc);

const PRIORITY_NOTE = { quire: `Always ${BRAND.name}`, page: "Page first" };

function ShortcutRow({ item, recording, onRecord, onCancel, onSet, onClear, error, onPriority, setting }) {
  // "…": this one shortcut follows the default, always goes to Quire, or lets the page go first.
  const pickPriority = async () => {
    const cur = item.priority || "default";
    const picked = await window.quireApp
      ?.contextMenu([
        { id: "default", label: "Default", type: "radio", checked: cur === "default" },
        { id: "quire", label: `Always ${BRAND.name}`, type: "radio", checked: cur === "quire" },
        { id: "page", label: "Page first", type: "radio", checked: cur === "page" },
      ])
      .catch(() => null);
    if (picked && picked !== cur) onPriority(picked === "default" ? null : picked);
  };
  return (
    <div className="shortcut-row" data-setting={setting}>
      <div className="shortcut-label">
        {item.label}
        {onPriority && item.priority ? <span className="shortcut-priority-note">{PRIORITY_NOTE[item.priority]}</span> : null}
      </div>
      <div className="shortcut-actions">
        {error ? <span className="shortcut-error" role="alert">{error}</span> : null}
        {item.accelerator !== item.default && !recording ? (
          <button type="button" className="shortcut-reset" onClick={() => onSet(item.default)} title={"Reset to " + prettyAccelerator(item.default)}>
            Reset
          </button>
        ) : null}
        <button
          type="button"
          className={"shortcut-key" + (recording ? " is-recording" : "") + (item.accelerator ? "" : " is-empty")}
          aria-label={`${item.label} shortcut: ${item.accelerator ? prettyAccelerator(item.accelerator) : "none"}. Click to change.`}
          onClick={() => (recording ? onCancel() : onRecord())}
        >
          {recording ? "Press keys…" : item.accelerator ? <kbd>{prettyAccelerator(item.accelerator)}</kbd> : "None"}
        </button>
        {item.accelerator && !recording ? (
          <button type="button" className="shortcut-clear" aria-label={`Remove ${item.label} shortcut`} title="Remove" onClick={onClear}>
            ×
          </button>
        ) : null}
        {onPriority ? (
          <button
            type="button"
            className="shortcut-more"
            aria-label={`${item.label}: when a page also uses it`}
            title="When a page also uses this shortcut"
            aria-haspopup="menu"
            onClick={pickPriority}
          >
            ⋯
          </button>
        ) : null}
      </div>
    </div>
  );
}

const EDITOR_DEFAULTS = { textSize: 16, readableWidth: true, font: "default", spellcheck: true, defaultRenderer: "quire" };
const FONT_LABELS = { default: "Default (Geist)", serif: "Serif", system: "System", mono: "Mono" };

function EditorPane({ api, prefs, onPrefs }) {
  const [editor, setEditor] = useState({ ...EDITOR_DEFAULTS, ...(prefs?.editor || {}) });
  const [error, setError] = useState("");
  useEffect(() => {
    if (prefs?.editor) setEditor((e) => ({ ...e, ...prefs.editor }));
  }, [prefs]);

  const set = (key, value) => {
    setEditor((e) => ({ ...e, [key]: value }));
    api.setPref("editor." + key, value).then(
      (p) => {
        setError("");
        onPrefs(p);
      },
      (err) => setError(String(err?.message || err)),
    );
  };
  const size = editor.textSize;

  return (
    <>
      <p className="settings-hint">Applies to every page. Pages with their own styles keep them.</p>
      <div className="editor-list">
        <div className="editor-row" data-setting="editor.textSize">
          <div className="editor-label" id="editor-size-label">Text size</div>
          <div className="editor-stepper" role="group" aria-labelledby="editor-size-label">
            <button type="button" className="settings-button" aria-label="Smaller text" disabled={size <= 13} onClick={() => set("textSize", size - 1)}>
              −
            </button>
            <span className="editor-stepper-value" aria-live="polite">{size}px</span>
            <button type="button" className="settings-button" aria-label="Larger text" disabled={size >= 22} onClick={() => set("textSize", size + 1)}>
              +
            </button>
          </div>
        </div>
        <div className="editor-row" data-setting="editor.font">
          <label className="editor-label" htmlFor="editor-font">Font</label>
          <select id="editor-font" className="settings-input editor-select" value={editor.font} onChange={(e) => set("font", e.target.value)}>
            {Object.entries(FONT_LABELS).map(([id, label]) => (
              <option key={id} value={id}>{label}</option>
            ))}
          </select>
        </div>
        <div className="editor-row" data-setting="editor.readableWidth">
          <label className="editor-label" htmlFor="editor-width">
            Readable line width
            <span className="editor-sub">Keep lines to about 700px instead of the full window.</span>
          </label>
          <input id="editor-width" type="checkbox" checked={editor.readableWidth} onChange={(e) => set("readableWidth", e.target.checked)} />
        </div>
        <div className="editor-row" data-setting="editor.spellcheck">
          <label className="editor-label" htmlFor="editor-spell">Spellcheck</label>
          <input id="editor-spell" type="checkbox" checked={editor.spellcheck} onChange={(e) => set("spellcheck", e.target.checked)} />
        </div>
        {editor.spellcheck && api.dictionaryWords ? <DictionaryRow api={api} /> : null}
        <div className="editor-row" data-setting="editor.defaultView">
          <label className="editor-label" htmlFor="editor-view">Default view for new pages</label>
          <select id="editor-view" className="settings-input editor-select" value={editor.defaultRenderer} onChange={(e) => set("defaultRenderer", e.target.value)}>
            {Object.entries(RENDERER_LABELS).map(([id, label]) => (
              <option key={id} value={id}>{label}</option>
            ))}
          </select>
        </div>
      </div>
      {error ? <p className="settings-error" role="alert">{error}</p> : null}
    </>
  );
}

/** Words added to the spellcheck dictionary (right-click › Add to Dictionary), removable here. */
function DictionaryRow({ api }) {
  const [words, setWords] = useState(null);
  const [draft, setDraft] = useState("");
  const [error, setError] = useState("");
  const load = () => api.dictionaryWords().then((w) => setWords(Array.isArray(w) ? w : []), () => setWords([]));
  useEffect(() => {
    load();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const run = (p) =>
    p.then(
      () => {
        setError("");
        load();
      },
      (err) => setError(String(err?.message || err).replace(/^Error invoking remote method '[^']+': (Error: )?/, "")),
    );
  const add = (e) => {
    e.preventDefault();
    const w = draft.trim();
    if (!w) return;
    run(api.addDictionaryWord(w));
    setDraft("");
  };
  return (
    <div className="editor-row editor-row-stack" data-setting="editor.dictionary">
      <div className="editor-label" id="editor-dict-label">
        Dictionary
        <span className="editor-sub">Words spellcheck accepts. Right-click a misspelled word to add it.</span>
      </div>
      <div className="dict" aria-labelledby="editor-dict-label">
        {words && words.length ? (
          <ul className="dict-words">
            {words.map((w) => (
              <li key={w} className="dict-word">
                <span>{w}</span>
                <button type="button" className="dict-remove" aria-label={"Remove " + w} onClick={() => run(api.removeDictionaryWord(w))}>
                  ×
                </button>
              </li>
            ))}
          </ul>
        ) : words ? (
          <p className="dict-empty">No words yet.</p>
        ) : null}
        <form className="dict-add" onSubmit={add}>
          <input className="settings-input" value={draft} onChange={(e) => setDraft(e.target.value)} placeholder="Add a word" aria-label="Add a word" />
          <button type="submit" className="settings-button" disabled={!draft.trim()}>
            Add
          </button>
        </form>
        {error ? <p className="settings-error" role="alert">{error}</p> : null}
      </div>
    </div>
  );
}

/** Settings › Vault: folders and pages left out of search, for this vault. */
function SearchExcludeField({ api }) {
  const [list, setList] = useState([]);
  const [nodes, setNodes] = useState([]);
  const [error, setError] = useState("");

  const load = async () => {
    const [next, tree] = await Promise.all([api.searchExclude(), api.listTree()]);
    const flat = [];
    const walk = (ns) => {
      for (const n of ns || []) {
        if (n.kind !== "file") flat.push(n);
        walk(n.children);
      }
    };
    walk(tree);
    setList(next);
    setNodes(flat);
  };
  const fail = (e) => setError(String(e?.message || e));
  useEffect(() => {
    load().catch(fail);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const set = (path, excluded) => {
    setError("");
    api.setSearchExcluded(path, excluded).then(load).catch(fail);
  };
  const addable = (kind) => nodes.filter((n) => n.kind === kind && !n.searchExcluded);
  const known = new Set(nodes.map((n) => n.path));

  return (
    <div className="vault-field" data-setting="vault.searchExclude">
      <span className="vault-field-label">Exclude from search</span>
      <p className="settings-hint">These stay in the sidebar but don't show up in the palette, page pickers or AI page lists.</p>
      {list.length ? (
        <div className="vault-list">
          {list.map((p) => (
            <div key={p} className="vault-row" data-search-exclude={p}>
              <div className="vault-row-text">
                <span className="vault-row-name">{p}</span>
                {known.has(p) ? null : <span className="vault-row-path">Not found</span>}
              </div>
              <button type="button" className="shortcut-clear" aria-label={"Include " + p + " in search"} title="Include in search" onClick={() => set(p, false)}>
                ×
              </button>
            </div>
          ))}
        </div>
      ) : null}
      <select
        className="settings-input"
        aria-label="Add a folder or page"
        data-search-exclude-add=""
        value=""
        onChange={(e) => e.target.value && set(e.target.value, true)}
      >
        <option value="">Add a folder or page…</option>
        {[["folder", "Folders"], ["page", "Pages"]].map(([kind, label]) =>
          addable(kind).length ? (
            <optgroup key={kind} label={label}>
              {addable(kind).map((n) => (
                <option key={n.path} value={n.path}>
                  {n.path}
                </option>
              ))}
            </optgroup>
          ) : null,
        )}
      </select>
      {error ? <p className="settings-error" role="alert">{error}</p> : null}
    </div>
  );
}

function VaultPane({ api, onVaultChanged, prefs, onPrefs }) {
  const [info, setInfo] = useState(null);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const load = async () => {
    try {
      const next = await api.vaultInfo();
      setInfo(next);
      setName(next?.vaultName || "");
    } catch (e) {
      setError(String(e?.message || e));
    }
  };
  useEffect(() => {
    load();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const run = async (fn) => {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      const next = await fn();
      if (next) onVaultChanged(next);
      await load();
    } catch (e) {
      setError(String(e?.message || e));
    } finally {
      setBusy(false);
    }
  };

  const commitName = () => {
    const clean = name.trim();
    if (!info || !clean || clean === info.vaultName) return setName(info?.vaultName || "");
    run(() => api.renameVault(clean));
  };

  if (!info) return error ? <p className="settings-error" role="alert">{error}</p> : null;
  const others = info.vaults.filter((v) => !v.current);

  return (
    <>
      <div className="vault-field" data-setting="vault.name">
        <label htmlFor="vault-name">Name</label>
        <input
          id="vault-name"
          className="settings-input"
          value={name}
          disabled={busy}
          onChange={(e) => setName(e.target.value)}
          onBlur={commitName}
          onKeyDown={(e) => {
            if (e.key === "Enter") e.currentTarget.blur();
            else if (e.key === "Escape") {
              e.stopPropagation();
              setName(info.vaultName);
            }
          }}
        />
        <p className="settings-hint">Renaming the vault renames its folder too.</p>
      </div>

      <div className="vault-field" data-setting="vault.location">
        <span className="vault-field-label">Location</span>
        <div className="vault-location">
          <code title={info.vault}>{info.vault}</code>
          <button type="button" className="settings-button" onClick={() => api.reveal("")}>
            {words.reveal}
          </button>
          <button type="button" className="settings-button" disabled={busy} onClick={() => run(() => api.moveVault())}>
            Move…
          </button>
        </div>
      </div>

      <div className="vault-field" data-setting="vault.trust">
        <span className="vault-field-label">Trust</span>
        <div className="vault-trust">
          <span className="vault-trust-state">{info.trust === "trusted" ? "Trusted" : "Restricted mode"}</span>
          <button
            type="button"
            className="settings-button"
            disabled={busy}
            onClick={() => run(async () => void (await api.setVaultTrust(info.trust === "trusted" ? "restricted" : "trusted")))}
          >
            {info.trust === "trusted" ? "Switch to restricted mode" : "Trust vault"}
          </button>
        </div>
        <p className="settings-hint">
          {info.trust === "trusted"
            ? `Pages can run commands on ${words.computer} (backends and builds) and reach the network.`
            : "Pages can only show their own content. Backends and builds don't run."}
        </p>
      </div>

      {error ? <p className="settings-error" role="alert">{error}</p> : null}

      <div className="vault-field" data-setting="vault.others">
        <span className="vault-field-label">Other vaults</span>
        {others.length ? (
          <div className="vault-list">
            {others.map((v) => (
              <div key={v.path} className="vault-row">
                <div className="vault-row-text">
                  <span className="vault-row-name">{v.name}</span>
                  <span className="vault-row-path">{v.missing ? "Not found · " + v.path : v.path}</span>
                </div>
                {v.missing ? null : (
                  <button type="button" className="settings-button" disabled={busy} onClick={() => run(() => api.switchVault(v.path))}>
                    Open
                  </button>
                )}
                <button
                  type="button"
                  className="shortcut-clear"
                  aria-label={"Remove " + v.name + " from the list"}
                  title="Remove from list"
                  onClick={() => run(() => api.forgetVault(v.path))}
                >
                  ×
                </button>
              </div>
            ))}
          </div>
        ) : (
          <p className="settings-hint">None yet.</p>
        )}
      </div>

      <div className="vault-field" data-setting="vault.confirmDelete">
        <label className="sync-toggle">
          <input
            type="checkbox"
            checked={prefs?.confirmDelete !== false}
            onChange={(e) => api.setPref("confirmDelete", e.target.checked).then(onPrefs, () => {})}
          />
          Ask before moving pages and files to the {words.trash}
        </label>
      </div>

      <SearchExcludeField api={api} />

      <div className="settings-foot vault-actions">
        <button type="button" className="settings-button" data-setting="vault.open" disabled={busy} onClick={() => run(() => api.openVault())}>
          Open folder as vault…
        </button>
        <button type="button" className="settings-button" data-setting="vault.create" disabled={busy} onClick={() => run(() => api.createVault())}>
          Create vault…
        </button>
      </div>
    </>
  );
}

const NEW_FOLDER = "\u0000new";
const TOP_LEVEL = "\u0000top";

const plural = (x, one, many) => `${Number(x).toLocaleString()} ${x === 1 ? one : many}`;

// Settings → Import is an index of sources; each source opens as its own page in the body.
const IMPORT_SOURCES = [
  { id: "obsidian", title: "Obsidian", sub: "A vault of markdown notes" },
  { id: "claude", title: "Claude artifacts", sub: "Pages you made on claude.ai" },
  { id: "files", title: "HTML or markdown files", sub: `Files on ${words.computer}` },
];

function ImportIcon({ id }) {
  const common = { width: 18, height: 18, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 1.6, strokeLinecap: "round", strokeLinejoin: "round", "aria-hidden": true };
  if (id === "obsidian")
    return (
      <svg {...common}>
        <path d="M12 2.8 19 8l-2.2 10.4L12 21.2l-4.8-2.8L5 8z" />
        <path d="M12 2.8 9.5 12l2.5 9.2M5 8l4.5 4L19 8" />
      </svg>
    );
  if (id === "claude")
    return (
      <svg {...common}>
        <path d="M12 3v4M12 17v4M3 12h4M17 12h4M5.6 5.6l2.8 2.8M15.6 15.6l2.8 2.8M18.4 5.6l-2.8 2.8M8.4 15.6l-2.8 2.8" />
      </svg>
    );
  return (
    <svg {...common}>
      <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" />
      <path d="M14 3v5h5M9 13h6M9 17h4" />
    </svg>
  );
}

function ImportSection({ label, htmlFor, setting, children }) {
  return (
    <div className="import-section" data-setting={setting}>
      {label ? (
        htmlFor ? (
          <label className="import-label" htmlFor={htmlFor}>
            {label}
          </label>
        ) : (
          <span className="import-label">{label}</span>
        )
      ) : null}
      {children}
    </div>
  );
}

function FolderPicker({ id, setting, where, setWhere, folderName, setFolderName, folders, vault, busy, dest, tail }) {
  return (
    <ImportSection label="Put it in" htmlFor={id} setting={setting}>
      <div className="import-where">
        <select id={id} className="settings-input" value={where} disabled={busy} onChange={(e) => setWhere(e.target.value)}>
          <option value={NEW_FOLDER}>A new folder</option>
          <option value={TOP_LEVEL}>{vault ? `The top of ${vault.vaultName}` : "The top of this vault"}</option>
          {folders.map((f) => (
            <option key={f} value={f}>
              {f}
            </option>
          ))}
        </select>
        {where === NEW_FOLDER ? (
          <input
            className="settings-input"
            aria-label="New folder name"
            placeholder="Folder name"
            value={folderName}
            disabled={busy}
            onChange={(e) => setFolderName(e.target.value)}
          />
        ) : null}
      </div>
      {where === NEW_FOLDER && !dest ? (
        <p className="settings-hint">Name the new folder.</p>
      ) : vault ? (
        <p className="settings-hint">
          Goes to <code className="import-path">{vault.vault + (dest ? "/" + dest : "")}</code>
          {dest ? null : ", next to everything already there"}.{tail ? " " + tail : ""}
        </p>
      ) : null}
    </ImportSection>
  );
}

function useFolder(initial) {
  const [where, setWhere] = useState(NEW_FOLDER);
  const [folderName, setFolderName] = useState(initial);
  const dest = where === NEW_FOLDER ? folderName.trim() : where === TOP_LEVEL ? "" : where;
  return { where, setWhere, folderName, setFolderName, dest, noDest: where === NEW_FOLDER && !dest };
}

function ImportFoot({ children }) {
  return <div className="import-foot">{children}</div>;
}

function ObsidianImport({ api, folders, vault, onOpenPage }) {
  const [source, setSource] = useState(null); // scanObsidian() result
  const [format, setFormat] = useState("md");
  const f = useFolder("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState(null);

  const pick = async () => {
    setError("");
    try {
      const next = await api.pickImportSource();
      if (!next) return;
      setSource(next);
      f.setFolderName(next.name);
      setResult(null);
    } catch (e) {
      setError(String(e?.message || e));
    }
  };

  const run = async () => {
    if (busy || !source || f.noDest) return;
    setBusy(true);
    setError("");
    try {
      setResult(await api.importObsidian({ source: source.source, dest: f.dest, format }));
    } catch (e) {
      setError(String(e?.message || e));
    } finally {
      setBusy(false);
    }
  };

  if (result)
    return (
      <div className="import-page" aria-live="polite">
        <ImportSection label="Done">
          <p className="import-done">
            Imported {plural(result.pages, "page", "pages")}
            {result.dest ? ` into ${result.dest}` : ""}
            {result.attachments || result.files ? `, with ${plural(result.attachments + result.files, "file", "files")}` : ""}.
          </p>
          {result.unresolved.length ? (
            <details className="import-details">
              <summary>{plural(result.unresolved.length, "link", "links")} didn't match a note and became plain text</summary>
              <ul>{result.unresolved.slice(0, 200).map((u, i) => <li key={i}>{u}</li>)}</ul>
            </details>
          ) : null}
        </ImportSection>
        <ImportFoot>
          <button type="button" className="settings-button" onClick={() => setResult(null)}>
            Import again
          </button>
          {result.first ? (
            <button type="button" className="settings-button is-primary" onClick={() => onOpenPage(result.first)}>
              Open
            </button>
          ) : null}
        </ImportFoot>
      </div>
    );

  const choice = (value, title, body) => (
    <label className={"import-choice" + (format === value ? " is-on" : "")}>
      <input type="radio" name="import-format" value={value} checked={format === value} onChange={() => setFormat(value)} />
      <span>
        <strong>{title}</strong>
        <span>{body}</span>
      </span>
    </label>
  );

  return (
    <div className="import-page">
      <p className="settings-hint import-intro">Your Obsidian vault isn't changed.</p>
      <ImportSection label="Vault" setting="import.obsidian.vault">
        <div className="import-pick">
          <span className={"import-pick-text" + (source ? "" : " is-empty")} title={source ? source.source : undefined}>
            {source ? source.source : "No vault chosen"}
          </span>
          <button type="button" className="settings-button" disabled={busy} onClick={pick}>
            {source ? "Change…" : "Choose…"}
          </button>
        </div>
        <p className="settings-hint">
          {source ? `${plural(source.notes, "note", "notes")}, ${plural(source.files, "other file", "other files")}` : "The folder that holds your .obsidian settings."}
        </p>
      </ImportSection>

      <ImportSection label="Import as" setting="import.obsidian.format">
        <div className="import-choices" role="radiogroup" aria-label="Import as">
          {choice("md", "Markdown pages", "Notes stay .md files, frontmatter and all")}
          {choice("html", `${BRAND.name} pages`, "Each note becomes an HTML page")}
        </div>
      </ImportSection>

      <FolderPicker id="import-where" setting="import.obsidian.where" {...f} folders={folders} vault={vault} busy={busy} tail="Obsidian's folders come along inside it." />

      {error ? <p className="settings-error" role="alert">{error}</p> : null}

      <ImportFoot>
        <button type="button" className="settings-button is-primary" disabled={busy || !source || f.noDest} onClick={run}>
          {busy ? "Importing…" : source ? `Import ${plural(source.notes, "note", "notes")}` : "Import"}
        </button>
      </ImportFoot>
    </div>
  );
}

function ClaudeImport({ api, folders, vault }) {
  const f = useFolder("Artifacts");
  const [which, setWhich] = useState("all");
  const [these, setThese] = useState("");
  const [recent, setRecent] = useState(10);
  const [shared, setShared] = useState(false);
  const [update, setUpdate] = useState(true);
  const [showPrompt, setShowPrompt] = useState(false);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState("");
  const copiedTimer = useRef(null);
  useEffect(() => () => clearTimeout(copiedTimer.current), []);

  const prompt = artifactPrompt({ vault: vault ? vault.vault : "~/Quire", folder: f.dest, which, these, recent, shared, update });

  const copy = async () => {
    try {
      if (api.copyText) await api.copyText(prompt);
      else await navigator.clipboard.writeText(prompt);
      setCopied(true);
      clearTimeout(copiedTimer.current);
      copiedTimer.current = setTimeout(() => setCopied(false), 1600);
    } catch (e) {
      setError(String(e?.message || e));
    }
  };

  const choice = (value, title, body) => (
    <label className={"import-choice" + (which === value ? " is-on" : "")}>
      <input type="radio" name="artifact-which" value={value} checked={which === value} onChange={() => setWhich(value)} />
      <span>
        <strong>{title}</strong>
        {body}
      </span>
    </label>
  );

  return (
    <div className="import-page">
      <p className="settings-hint import-intro">{BRAND.name} can't open claude.ai, so Claude Code fetches them from a prompt you paste in.</p>

      <ImportSection label="Which ones" setting="import.claude.which">
        <div className="import-choices" role="radiogroup" aria-label="Which ones">
          {choice("all", "All my artifacts", <span>Everything you've made</span>)}
          {choice(
            "recent",
            "The most recent",
            <span className="import-recent">
              <input
                type="number"
                min={1}
                max={200}
                className="settings-input"
                aria-label="How many"
                value={recent}
                onFocus={() => setWhich("recent")}
                onChange={(e) => setRecent(e.target.value)}
              />
              <span>by last update</span>
            </span>,
          )}
          {choice(
            "these",
            "Only these",
            which === "these" ? (
              <textarea
                className="settings-input import-these"
                rows={4}
                placeholder={"One link or name per line\nhttps://claude.ai/artifact/…\nTrip budget"}
                value={these}
                onChange={(e) => setThese(e.target.value)}
              />
            ) : (
              <span>Links or names</span>
            ),
          )}
        </div>
        <div className="import-checks">
          <label className="import-check" data-setting="import.claude.shared">
            <input type="checkbox" checked={shared} onChange={(e) => setShared(e.target.checked)} />
            <span>Include artifacts shared with me</span>
          </label>
          <label className="import-check" data-setting="import.claude.update">
            <input type="checkbox" checked={update} onChange={(e) => setUpdate(e.target.checked)} />
            <span>Update ones already imported</span>
          </label>
        </div>
      </ImportSection>

      <FolderPicker id="artifact-where" setting="import.claude.where" {...f} folders={folders} vault={vault} busy={false} />

      <ImportSection label="Prompt" setting="import.claude.prompt">
        <p className="settings-hint">Paste it into Claude Code. Pages appear in the sidebar as they land.</p>
        <button type="button" className="import-disclose" aria-expanded={showPrompt} onClick={() => setShowPrompt((s) => !s)}>
          <span className="import-disclose-caret" aria-hidden="true">›</span>
          {showPrompt ? "Hide prompt" : "Show prompt"}
        </button>
        {showPrompt ? <pre className="import-prompt" aria-label="Prompt">{prompt}</pre> : null}
      </ImportSection>

      {error ? <p className="settings-error" role="alert">{error}</p> : null}

      <ImportFoot>
        <span className={"import-copied" + (copied ? " is-on" : "")} aria-live="polite">
          {copied ? "Copied" : ""}
        </span>
        <button type="button" className="settings-button is-primary" disabled={f.noDest} onClick={copy}>
          Copy prompt
        </button>
      </ImportFoot>
    </div>
  );
}

function FilesImport({ api, folders, vault, onOpenPage }) {
  const f = useFolder("Imported");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState(null);

  const importFiles = async () => {
    if (busy || f.noDest) return;
    setBusy(true);
    setError("");
    try {
      const r = await api.importArtifactFiles({ folder: f.dest });
      if (r) setResult(r);
    } catch (e) {
      setError(String(e?.message || e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="import-page">
      <p className="settings-hint import-intro">Each .html or .md file becomes a page, such as an artifact downloaded from claude.ai.</p>

      <FolderPicker id="files-where" setting="import.files.where" {...f} folders={folders} vault={vault} busy={busy} />

      {result ? (
        <ImportSection label="Done">
          <p className="import-done" aria-live="polite">
            {result.pages ? `Imported ${plural(result.pages, "page", "pages")}${result.dest ? ` into ${result.dest}` : ""}.` : "Nothing imported."}
          </p>
          {result.errors.length ? (
            <ul className="import-errors">
              {result.errors.map((e, i) => (
                <li key={i}>
                  <code className="import-path">{e.source.split("/").pop()}</code> {e.error.replace(e.source, "").replace(/:\s*$/, "")}
                </li>
              ))}
            </ul>
          ) : null}
        </ImportSection>
      ) : null}

      {error ? <p className="settings-error" role="alert">{error}</p> : null}

      <ImportFoot>
        {result && result.pages === 1 ? (
          <button type="button" className="settings-button" onClick={() => onOpenPage(result.first)}>
            Open
          </button>
        ) : null}
        <button type="button" className="settings-button is-primary" data-setting="import.files.choose" disabled={busy || f.noDest} onClick={importFiles}>
          {busy ? "Importing…" : "Choose files…"}
        </button>
      </ImportFoot>
    </div>
  );
}

function ImportPane({ api, folders, onOpenPage, sub, onSub }) {
  const [vault, setVault] = useState(null); // {vault, vaultName}
  useEffect(() => {
    api.vaultInfo().then(setVault, () => {});
  }, [api]);

  const props = { api, folders, vault, onOpenPage };
  if (sub === "obsidian") return <ObsidianImport {...props} />;
  if (sub === "claude") return <ClaudeImport {...props} />;
  if (sub === "files") return <FilesImport {...props} />;

  return (
    <>
      <p className="settings-hint">Bring pages in from somewhere else. Originals aren't changed.</p>
      <div className="vault-list import-index">
        {IMPORT_SOURCES.map((s) => (
          <button key={s.id} type="button" className="import-row" data-import={s.id} onClick={() => onSub(s.id)}>
            <span className="import-row-icon">
              <ImportIcon id={s.id} />
            </span>
            <span className="vault-row-text">
              <span className="vault-row-name">{s.title}</span>
              <span className="import-sub">{s.sub}</span>
            </span>
            <span className="import-row-chevron" aria-hidden="true">
              ›
            </span>
          </button>
        ))}
      </div>
    </>
  );
}

function ago(iso) {
  const s = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 1000));
  if (s < 60) return "just now";
  if (s < 3600) return Math.round(s / 60) + " min ago";
  return new Date(iso).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

const SYNC_EVERY = [15, 30, 60, 300];
const everyLabel = (sec) => (sec < 60 ? `${sec} seconds` : sec === 60 ? "1 minute" : `${sec / 60} minutes`);
const conflictNote = (files) => (files.length === 1 ? `conflict copy saved: ${files[0]}` : `${files.length} conflict copies saved`);

function SyncPane({ api }) {
  const [info, setInfo] = useState(null);
  const [remote, setRemote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const apply = (next) => {
    setInfo(next);
    setRemote(next?.remote || "");
  };
  useEffect(() => {
    api.syncInfo().then(apply, (e) => setError(String(e?.message || e)));
    return api.onSyncStatus?.((s) => setInfo((i) => (i ? { ...i, syncing: s.syncing, last: s.last } : i)));
  }, [api]);

  const run = async (fn) => {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      apply(await fn());
    } catch (e) {
      setError(String(e?.message || e));
    } finally {
      setBusy(false);
    }
  };

  const commitRemote = () => {
    if (!info || remote.trim() === info.remote) return;
    run(() => api.setSyncRemote(remote.trim()));
  };

  if (!info) return error ? <p className="settings-error" role="alert">{error}</p> : null;
  const last = info.last;

  return (
    <>
      <p data-setting="sync.status" className={"sync-status" + (last && !last.ok && !info.syncing ? " is-error" : "")} aria-live="polite">
        {info.syncing
          ? "Syncing…"
          : !info.remote
            ? "Not set up."
            : !last
              ? info.enabled
                ? `On. Checks every ${everyLabel(info.everySec)}.`
                : "Off."
              : last.ok
                ? `Synced ${ago(last.at)}` +
                  (last.pushed > 0 || last.pulled > 0 ? ` · ${last.pushed} up, ${last.pulled} down` : "") +
                  (last.conflicts?.length ? ` · ${conflictNote(last.conflicts)}` : "")
                : last.error}
      </p>

      <div className="vault-field" data-setting="sync.remote">
        <label htmlFor="sync-remote">Repo</label>
        <input
          id="sync-remote"
          className="settings-input"
          placeholder="https://github.com/you/notes.git"
          value={remote}
          disabled={busy}
          spellCheck={false}
          onChange={(e) => setRemote(e.target.value)}
          onBlur={commitRemote}
          onKeyDown={(e) => {
            if (e.key === "Enter") e.currentTarget.blur();
            else if (e.key === "Escape") {
              e.stopPropagation();
              setRemote(info.remote);
            }
          }}
        />
        <p className="settings-hint">A private git repo. Your notes' history is pushed there and pulled from it. Page data in data/ stays on {words.computer}.</p>
      </div>

      <div className="vault-field" data-setting="sync.auto">
        <label className="sync-toggle">
          <input type="checkbox" checked={info.enabled} disabled={busy || !info.remote} onChange={(e) => run(() => api.setSyncEnabled(e.target.checked))} />
          Sync automatically
        </label>
      </div>

      <div className="vault-field" data-setting="sync.every">
        <label htmlFor="sync-every">Check for changes every</label>
        <select
          id="sync-every"
          className="settings-input"
          value={info.everySec}
          disabled={busy || !info.remote}
          onChange={(e) => run(() => api.setSyncEvery(Number(e.target.value)))}
        >
          {SYNC_EVERY.map((sec) => (
            <option key={sec} value={sec}>
              {everyLabel(sec)}
            </option>
          ))}
        </select>
        <p className="settings-hint">Edits are pushed a few seconds after you make them, and {BRAND.name} checks again when you come back to the window.</p>
      </div>

      {error ? <p className="settings-error" role="alert">{error}</p> : null}

      <div className="settings-foot">
        <button type="button" className="settings-button" data-setting="sync.now" disabled={busy || info.syncing || !info.remote} onClick={() => run(() => api.syncNow())}>
          Sync now
        </button>
      </div>
    </>
  );
}

/** Settings → Floating note: an always-on-top note window toggled by a global shortcut. */
function FloatingPane({ api, cfg, onCfg, recording, error, onRecord, onCancel, onSetShortcut }) {
  const [pages, setPages] = useState([]);
  const [busy, setBusy] = useState(false);
  const [fail, setFail] = useState("");

  useEffect(() => {
    api.getFloating().then(onCfg, (e) => setFail(String(e?.message || e)));
    api.listTree().then(
      (t) => setPages(flatten(t).filter((n) => n.kind === "page").map((n) => n.path)),
      () => {},
    );
  }, [api]); // eslint-disable-line react-hooks/exhaustive-deps

  const run = async (fn) => {
    if (busy) return;
    setBusy(true);
    setFail("");
    try {
      const next = await fn();
      if (next) onCfg(next);
    } catch (e) {
      setFail(String(e?.message || e));
    } finally {
      setBusy(false);
    }
  };

  if (!cfg) return fail ? <p className="settings-error" role="alert">{fail}</p> : null;
  // The default note is created the first time it opens, so it may not be in the tree yet.
  const options = [...new Set([cfg.defaultPage, ...pages])];
  if (!options.includes(cfg.page)) options.unshift(cfg.page);

  return (
    <>
      <p className="settings-hint">A small note that stays on top of every app. Any page works; edits save like they do here.</p>

      <div className="vault-field" data-setting="floating.enabled">
        <label className="sync-toggle">
          <input type="checkbox" checked={cfg.enabled} disabled={busy} onChange={(e) => run(() => api.setFloating({ enabled: e.target.checked }))} />
          Show and hide it with a shortcut from any app
        </label>
      </div>

      <div className="shortcut-list">
        <ShortcutRow
          setting="floating.shortcut"
          item={{ id: "floating", label: "Show / hide floating note", default: cfg.default, accelerator: cfg.shortcut }}
          recording={recording}
          error={error || (cfg.enabled && cfg.shortcut && !cfg.registered ? cfg.error : "")}
          onRecord={onRecord}
          onCancel={onCancel}
          onSet={onSetShortcut}
          onClear={() => onSetShortcut("")}
        />
      </div>

      <div className="vault-field" data-setting="floating.page">
        <label htmlFor="floating-page">Page</label>
        <select id="floating-page" className="settings-input" value={cfg.page} disabled={busy} onChange={(e) => run(() => api.setFloating({ page: e.target.value }))}>
          {options.map((p) => (
            <option key={p} value={p}>
              {p}
              {p === cfg.defaultPage && !pages.includes(p) ? " (created when it first opens)" : ""}
            </option>
          ))}
        </select>
        <p className="settings-hint">Esc or the shortcut hides it again.</p>
        {isWin && cfg.enabled ? <p className="settings-hint">While it's on, {BRAND.name} stays in the notification area after you close its last window, so the shortcut keeps working.</p> : null}
      </div>

      {fail ? <p className="settings-error" role="alert">{fail}</p> : null}

      <div className="settings-foot">
        <button type="button" className="settings-button" data-setting="floating.open" disabled={busy} onClick={() => run(async () => (await api.openFloating(), api.getFloating()))}>
          Open floating note
        </button>
      </div>
    </>
  );
}

function TemplatesPane({ api, page }) {
  const [info, setInfo] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [naming, setNaming] = useState(null); // the name for "Save current page as template"
  const [ask, setAsk] = useState(null); // template to move to the Trash

  const load = () => api.listTemplates().then(setInfo, (e) => setError(String(e?.message || e)));
  useEffect(() => {
    load();
    api.watchTemplates(true).catch(() => {});
    const off = api.onTemplatesChanged(load);
    return () => {
      off();
      api.watchTemplates(false).catch(() => {});
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const run = async (fn) => {
    if (busy) return false;
    setBusy(true);
    setError("");
    try {
      const next = await fn();
      if (next) setInfo(next);
      return true;
    } catch (e) {
      setError(String(e?.message || e));
      return false;
    } finally {
      setBusy(false);
    }
  };

  const save = async () => {
    const name = (naming || "").trim();
    if (!name || !page) return;
    if (await run(() => api.saveAsTemplate(page.path, name))) setNaming(null);
  };

  if (!info) return error ? <p className="settings-error" role="alert">{error}</p> : null;

  return (
    <>
      <p className="settings-hint">File → New Page from Template makes a new page from one of these. Each template is a page folder; subfolders group them.</p>
      <div className="vault-field" data-setting="templates.folder">
        <span className="vault-field-label">Folder</span>
        <div className="vault-location">
          <code title={info.dir}>{info.dir}</code>
          <button type="button" className="settings-button" onClick={() => api.revealTemplate("")}>
            {words.reveal}
          </button>
        </div>
      </div>

      {error ? <p className="settings-error" role="alert">{error}</p> : null}

      <div className="vault-field" data-setting="templates.list">
        <span className="vault-field-label">Templates</span>
        {info.templates.length ? (
          <div className="vault-list">
            {info.templates.map((t) => (
              <div key={t.path} className="vault-row">
                <div className="vault-row-text">
                  <span className="vault-row-name">{t.title}</span>
                  <span className="template-row-meta">
                    {[t.category, t.files === 1 ? "1 file" : t.files + " files"].filter(Boolean).join(" · ")}
                  </span>
                </div>
                <button type="button" className="settings-button" onClick={() => api.revealTemplate(t.path)}>
                  Reveal
                </button>
                <button type="button" className="settings-button" disabled={busy} onClick={() => setAsk(t)}>
                  Delete
                </button>
              </div>
            ))}
          </div>
        ) : (
          <p className="settings-hint">None yet.</p>
        )}
      </div>

      {naming != null ? (
        <div className="vault-field">
          <label htmlFor="template-name">Template name</label>
          <div className="vault-location">
            <input
              id="template-name"
              className="settings-input template-name"
              data-own-esc
              value={naming}
              disabled={busy}
              autoFocus
              onFocus={(e) => e.currentTarget.select()}
              onChange={(e) => setNaming(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") save();
                else if (e.key === "Escape") {
                  e.stopPropagation();
                  setNaming(null);
                }
              }}
            />
            <button type="button" className="settings-button is-primary" disabled={busy || !naming.trim()} onClick={save}>
              Save
            </button>
            <button type="button" className="settings-button" onClick={() => setNaming(null)}>
              Cancel
            </button>
          </div>
          <p className="settings-hint">Copies “{page?.title}” without its data.</p>
        </div>
      ) : null}

      <div className="settings-foot vault-actions">
        <button type="button" className="settings-button" data-setting="templates.save" disabled={busy || !page} title={page ? undefined : "Open a page first"} onClick={() => setNaming(page.title)}>
          Save current page as template…
        </button>
        <button type="button" className="settings-button" data-setting="templates.restore" disabled={busy} onClick={() => run(() => api.restoreTemplates())}>
          Restore starter templates
        </button>
      </div>

      {ask ? (
        <ConfirmDialog
          title={`Move “${ask.title}” to the ${words.trash}?`}
          body={`Pages already made from it stay as they are. You can put it back from the ${words.trash}${isWin ? "" : " in Finder"}.`}
          confirmLabel={words.moveToTrash}
          busy={busy}
          error={error}
          onConfirm={async () => {
            if (await run(() => api.trashTemplate(ask.path))) setAsk(null);
          }}
          onCancel={() => setAsk(null)}
        />
      ) : null}
    </>
  );
}

// The Debug section (DebugPane.jsx) is only in dev and Next builds: `debug` from getState().
const DEBUG_LABEL = "Debug";

export default function Settings({ api, prefs, onPrefs, initialTab = "vault", shortcuts, onShortcuts, onVaultChanged, folders = [], page = null, onOpenPage, onOpenAi, debug = false, onClose }) {
  // initialTab may name a sub-page: "import/claude" opens Import → Claude artifacts.
  const [tab, setTabState] = useState(String(initialTab).split("/")[0]);
  const [importSub, setImportSub] = useState(String(initialTab).split("/")[1] || null);
  const importSubRef = useRef(importSub);
  importSubRef.current = tab === "import" ? importSub : null;
  const [appVersion, setAppVersion] = useState(null);
  useEffect(() => {
    api.updateStatus?.().then((u) => setAppVersion(u?.current || null), () => {});
  }, [api]);
  const setTab = (t) => {
    setTabState(t);
    setImportSub(null);
  };
  // Opening a source focuses the back button; going back focuses the row it came from.
  const openImport = (id) => {
    setImportSub(id);
    requestAnimationFrame(() => dialogRef.current?.querySelector(".settings-back")?.focus());
  };
  const closeImport = () => {
    const from = importSubRef.current;
    setImportSub(null);
    requestAnimationFrame(() => dialogRef.current?.querySelector(`.import-row[data-import="${from}"]`)?.focus());
  };
  const [recording, setRecording] = useState(null);
  const [errors, setErrors] = useState({});
  const [floatingCfg, setFloatingCfg] = useState(null);
  const [priority, setPriority] = useState(null);
  useEffect(() => {
    api.getShortcutPriority?.().then(setPriority, () => {});
  }, [api]);

  // Search (top of the nav): while it has text the nav shows results from settingsIndex.js.
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const searchRef = useRef(null);
  const index = useMemo(() => settingsSearchIndex(shortcuts), [shortcuts]);
  const results = useMemo(() => searchSettings(index, query), [index, query]);
  useEffect(() => setActive(0), [query]);
  useEffect(() => {
    if (query) dialogRef.current?.querySelector(`#settings-result-${active}`)?.scrollIntoView({ block: "nearest" });
  }, [active, query]);
  const findTimer = useRef(null);
  useEffect(() => () => clearTimeout(findTimer.current), []);

  // Open the result's tab (and Import source), then wait for its pane to render the row (panes
  // load async), scroll it into view, flash it and focus its first control.
  const pick = (entry) => {
    if (!entry) return;
    setQuery("");
    setTabState(entry.tab);
    setImportSub(entry.sub || null);
    clearTimeout(findTimer.current);
    const navItem = () => dialogRef.current?.querySelector(`.settings-nav-item[data-tab="${entry.tab}"]`);
    if (entry.page) {
      requestAnimationFrame(() => (entry.sub ? dialogRef.current?.querySelector(".settings-back") : navItem())?.focus());
      return;
    }
    const started = Date.now();
    const look = () => {
      const root = dialogRef.current;
      if (!root) return;
      const late = Date.now() - started > 1500;
      const el = root.querySelector(`[data-setting="${entry.id}"]`) || (late && entry.near ? root.querySelector(`[data-setting="${entry.near}"]`) : null);
      if (!el) {
        if (late) return navItem()?.focus();
        findTimer.current = setTimeout(look, 50);
        return;
      }
      el.scrollIntoView({ block: "center" });
      el.classList.remove("is-found");
      void el.offsetWidth; // restart the flash if it's already on
      el.classList.add("is-found");
      setTimeout(() => el.classList.remove("is-found"), 1500);
      const control = el.matches("button, input, select, textarea, summary")
        ? el
        : [...el.querySelectorAll("button, input, select, textarea, summary")].find((c) => !c.disabled && c.offsetParent !== null);
      (control || navItem())?.focus({ preventScroll: true });
    };
    findTimer.current = setTimeout(look, 0);
  };

  const onSearchKey = (e) => {
    if (e.key === "Escape" && query) {
      e.preventDefault();
      setQuery("");
    } else if (!query) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        dialogRef.current?.querySelector(".settings-nav-item")?.focus();
      }
    } else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      if (results.length) setActive((a) => (a + (e.key === "ArrowDown" ? 1 : -1) + results.length) % results.length);
    } else if (e.key === "Enter") {
      e.preventDefault();
      pick(results[active]);
    }
  };

  const stopRecording = () => {
    setRecording(null);
    api.suspendShortcuts(false).catch(() => {});
  };

  const set = async (id, acc) => {
    try {
      if (id === "floating") setFloatingCfg(await api.setFloating({ shortcut: acc }));
      else onShortcuts(await api.setShortcut(id, acc));
      setErrors((e) => ({ ...e, [id]: "" }));
    } catch (err) {
      setErrors((e) => ({ ...e, [id]: String(err?.message || err) }));
    }
  };

  useEffect(() => {
    const onKey = (e) => {
      if (!recording && e.code === "KeyF" && (isMac ? e.metaKey : e.ctrlKey) && !e.altKey && !e.shiftKey) {
        e.preventDefault();
        e.stopPropagation();
        searchRef.current?.focus();
        searchRef.current?.select();
        return;
      }
      if (!recording) {
        // A confirm dialog inside a pane, or a field marked data-own-esc, handles its own Esc.
        if (e.key === "Escape" && !document.querySelector(".confirm") && !e.target?.closest?.("[data-own-esc]")) {
          e.preventDefault();
          // On an Import source page Esc goes back to the list first; Esc again closes.
          if (importSubRef.current) closeImport();
          else onClose();
        }
        return;
      }
      e.preventDefault();
      e.stopPropagation();
      if (e.key === "Escape") return stopRecording();
      if ((e.key === "Backspace" || e.key === "Delete") && !e.metaKey && !e.ctrlKey && !e.altKey) {
        const id = recording;
        stopRecording();
        return set(id, "");
      }
      const acc = toAccelerator(e);
      if (!acc) return;
      const id = recording;
      stopRecording();
      set(id, acc);
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [recording]); // eslint-disable-line react-hooks/exhaustive-deps

  // Keyboard: start on the current section, keep Tab inside the dialog (the page and sidebar
  // behind it are inert while it's open), and ↑/↓ move between sections in the nav.
  const dialogRef = useRef(null);
  useEffect(() => {
    dialogRef.current?.querySelector('.settings-nav-item[aria-current="page"]')?.focus();
  }, []);
  const onDialogKey = (e) => {
    if (recording) return;
    const root = dialogRef.current;
    if (!root) return;
    if (e.key === "Tab") {
      const all = [...root.querySelectorAll('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])')].filter(
        (el) => !el.disabled && el.offsetParent !== null,
      );
      if (!all.length) return;
      const i = all.indexOf(document.activeElement);
      const next = e.shiftKey ? (i <= 0 ? all.length - 1 : i - 1) : i === -1 || i === all.length - 1 ? 0 : i + 1;
      e.preventDefault();
      all[next].focus();
      return;
    }
    if ((e.key === "ArrowDown" || e.key === "ArrowUp") && e.target.classList?.contains("settings-nav-item")) {
      const items = [...root.querySelectorAll(".settings-nav-item")];
      const i = items.indexOf(e.target);
      if (i === 0 && e.key === "ArrowUp") {
        e.preventDefault();
        return searchRef.current?.focus();
      }
      const n = items[(i + (e.key === "ArrowDown" ? 1 : -1) + items.length) % items.length];
      e.preventDefault();
      n.focus();
      n.click();
    }
  };

  // Never leave the menu without its shortcuts.
  useEffect(() => () => api.suspendShortcuts(false).catch(() => {}), [api]);

  const record = (id) => {
    setErrors((e) => ({ ...e, [id]: "" }));
    setRecording(id);
    api.suspendShortcuts(true).catch(() => {});
  };

  return (
    <div className="settings-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="settings" role="dialog" aria-modal="true" aria-labelledby="settings-title" ref={dialogRef} onKeyDown={onDialogKey}>
        <nav className="settings-nav" aria-label="Settings sections">
          <div className="settings-nav-title" id="settings-title">Settings</div>
          <div className="settings-search">
            <label htmlFor="settings-search" className="settings-search-label">
              Search settings
            </label>
            <svg className="settings-search-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
              <circle cx="11" cy="11" r="7" />
              <path d="m20 20-3.5-3.5" />
            </svg>
            <input
              ref={searchRef}
              id="settings-search"
              type="search"
              className="settings-input settings-search-input"
              placeholder="Search settings"
              autoComplete="off"
              spellCheck={false}
              role="combobox"
              aria-expanded={!!query}
              aria-controls="settings-results"
              aria-autocomplete="list"
              aria-activedescendant={query && results.length ? `settings-result-${active}` : undefined}
              data-own-esc={query ? "" : undefined}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={onSearchKey}
            />
          </div>
          {query ? (
            <div className="settings-results" id="settings-results" role="listbox" aria-label="Matching settings">
              {results.length ? (
                results.map((r, i) => (
                  <div
                    key={r.id}
                    id={`settings-result-${i}`}
                    role="option"
                    aria-selected={i === active}
                    className={"settings-result" + (i === active ? " is-active" : "")}
                    onMouseDown={(e) => e.preventDefault()}
                    onMouseMove={() => i !== active && setActive(i)}
                    onClick={() => pick(r)}
                  >
                    <span className="settings-result-label">{r.label}</span>
                    <span className="settings-result-context">{r.context}</span>
                  </div>
                ))
              ) : (
                <p className="settings-results-empty" role="status">
                  No settings match
                </p>
              )}
            </div>
          ) : (
            [...Object.entries(SECTION_LABELS), ...(debug ? [["debug", DEBUG_LABEL]] : [])].map(([id, label]) => (
              <button key={id} type="button" className="settings-nav-item" data-tab={id} aria-current={tab === id ? "page" : undefined} onClick={() => setTab(id)}>
                {label}
              </button>
            ))
          )}
          {appVersion?.version ? (
            <div className="settings-nav-version" title={appVersion.sha ? `Built from ${appVersion.sha.slice(0, 7)}` : undefined}>
              {BRAND.name} {appVersion.version}
            </div>
          ) : null}
        </nav>
        <section className="settings-body">
          <div className="settings-head">
            {tab === "import" && importSub ? (
              <div className="settings-head-sub">
                <button
                  type="button"
                  className="settings-back"
                  onClick={closeImport}
                  onKeyDown={(e) => {
                    if (e.key === "Backspace" || e.key === "Delete") {
                      e.preventDefault();
                      closeImport();
                    }
                  }}
                >
                  <span aria-hidden="true">‹</span> Import
                </button>
                <h2>{IMPORT_SOURCES.find((s) => s.id === importSub)?.title || "Import"}</h2>
              </div>
            ) : (
            <h2>{tab === "debug" ? DEBUG_LABEL : SECTION_LABELS[tab]}</h2>
            )}
            <button type="button" className="settings-close" aria-label="Close settings" onClick={onClose}>
              ×
            </button>
          </div>
          {tab === "account" ? <AccountPane api={api} onOpenTab={setTab} /> : tab === "feedback" ? <FeedbackPane /> : tab === "vault" ? <VaultPane api={api} onVaultChanged={onVaultChanged} prefs={prefs} onPrefs={onPrefs} /> : tab === "editor" ? <EditorPane api={api} prefs={prefs} onPrefs={onPrefs} /> : tab === "sync" ? <SyncPane api={api} /> : tab === "ai" ? <AiPane api={api} shortcuts={shortcuts} onOpenTab={setTab} />: tab === "publishing" ? <PublishingPane api={api} /> : tab === "plan" ? <PlanPane api={api} /> : tab === "debug" && debug ? <DebugPane api={api} page={page} onOpenTab={setTab} onOpenAi={() => (onOpenAi ? onOpenAi() : onClose())} onClose={onClose} /> : tab === "tools" ? <ToolsPane api={api} /> : tab === "import" ? <ImportPane api={api} folders={folders} onOpenPage={onOpenPage} sub={importSub} onSub={openImport} /> : tab === "templates" ? <TemplatesPane api={api} page={page} /> : tab === "floating" ? (
            <FloatingPane
              api={api}
              cfg={floatingCfg}
              onCfg={setFloatingCfg}
              recording={recording === "floating"}
              error={errors.floating}
              onRecord={() => record("floating")}
              onCancel={stopRecording}
              onSetShortcut={(acc) => set("floating", acc)}
            />
          ) : tab === "activity" ? <ActivityPane api={api} onOpenPage={onOpenPage} /> : <>
          <div className="shortcut-priority" data-setting="shortcuts.priority">
            <div className="shortcut-priority-row">
              <div className="shortcut-priority-title" id="shortcut-priority-title">When a page also uses a shortcut</div>
              <div className="segmented" role="group" aria-labelledby="shortcut-priority-title">
                {[["quire", `${BRAND.name} first`], ["page", "Page first"]].map(([v, label]) => (
                  <button
                    key={v}
                    type="button"
                    aria-pressed={(priority?.default || "quire") === v}
                    onClick={async () => setPriority(await api.setShortcutPriority(v))}
                  >
                    {label}
                  </button>
                ))}
              </div>
            </div>
            <p className="settings-hint">{BRAND.name} first: {formatAccelerator("CmdOrCtrl+P")} and the rest always reach {BRAND.name}, like a browser. Page first: a page can take them over, and {BRAND.name} gets whatever the page ignores.</p>
          </div>
          <p className="settings-hint">Click a shortcut, then press the new keys. Esc cancels, ⌫ removes it.</p>
          <div className="shortcut-list">
            {shortcuts.map((s) => (
              <ShortcutRow
                key={s.id}
                setting={"shortcuts." + s.id}
                item={s}
                recording={recording === s.id}
                error={errors[s.id]}
                onRecord={() => record(s.id)}
                onCancel={stopRecording}
                onSet={(acc) => set(s.id, acc)}
                onClear={() => set(s.id, "")}
                onPriority={async (v) => onShortcuts(await api.setShortcutPriorityOverride(s.id, v))}
              />
            ))}
          </div>
          <div className="settings-foot">
            <button
              type="button"
              className="settings-button"
              data-setting="shortcuts.reset"
              onClick={async () => {
                onShortcuts(await api.resetShortcuts());
                setErrors({});
              }}
            >
              Reset all to defaults
            </button>
          </div>
          </>}
        </section>
      </div>
    </div>
  );
}
