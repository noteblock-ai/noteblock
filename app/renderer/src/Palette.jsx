import { useEffect, useMemo, useRef, useState } from "react";
import { CodeIcon, FileIcon, PageIcon } from "./icons.jsx";
import { prettyAccelerator } from "./Settings.jsx";
import { formatAccelerator } from "./platform.js";
import { flatten, parentPath } from "./tree.js";

const LIMIT = 60;

/** Substring matches beat scattered ones; earlier and shorter beat later and longer. -1 = no match. */
export function score(query, text) {
  const q = query.toLowerCase();
  const t = text.toLowerCase();
  const at = t.indexOf(q);
  if (at !== -1) return 1000 - at - t.length / 100;
  let gaps = 0;
  let j = 0;
  for (let i = 0; i < t.length && j < q.length; i++) {
    if (t[i] === q[j]) j++;
    else if (j > 0) gaps++;
  }
  return j === q.length ? 500 - gaps - t.length / 100 : -1;
}

function filesOf(nodes, out = []) {
  for (const f of nodes || []) {
    if (f.kind === "dir") filesOf(f.children, out);
    else out.push(f.path);
  }
  return out;
}

/**
 * ⌘P: one list of commands, pages and every page's files. Empty query shows recent pages,
 * then commands, then the other pages; typing filters all of them. ⌘↵ opens in a new tab.
 * pagesOnly (the floating note's picker): just pages, sized for a small window.
 */
export default function Palette({ api, tree, commands = [], recent = [], onOpenPage, onOpenFile, onClose, pagesOnly = false }) {
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const [files, setFiles] = useState([]);
  const inputRef = useRef(null);
  const listRef = useRef(null);

  const pages = useMemo(() => flatten(tree).filter((n) => n.kind === "page" && !n.searchExcluded), [tree]);

  useEffect(() => {
    requestAnimationFrame(() => inputRef.current?.focus());
  }, []);

  // Files are listed when the palette opens; pages and commands are there right away.
  useEffect(() => {
    if (pagesOnly) return;
    let alive = true;
    Promise.all(
      pages.map((p) =>
        api.listFiles(p.path).then(
          (list) => filesOf(list).map((f) => ({ page: p.path, file: f })),
          () => [],
        ),
      ),
    ).then((all) => alive && setFiles(all.flat()));
    return () => {
      alive = false;
    };
  }, [api, pages, pagesOnly]);

  const items = useMemo(() => {
    const cmd = commands.map((c) => ({ kind: "command", key: "c:" + c.id, label: c.label, hint: c.accelerator, run: c.run }));
    const pg = pages.map((p) => ({ kind: "page", key: "p:" + p.path, label: p.title, sub: parentPath(p.path) || undefined, run: (tab) => onOpenPage(p.path, tab) }));
    const q = query.trim();
    if (!q) {
      const byPath = new Map(pg.map((it) => [it.key.slice(2), it]));
      const recents = recent.map((p) => byPath.get(p)).filter(Boolean).slice(0, 8);
      const seen = new Set(recents);
      return [...recents, ...cmd, ...pg.filter((it) => !seen.has(it))].slice(0, LIMIT);
    }
    const fl = files.map((f) => ({ kind: "file", key: "f:" + f.page + "/" + f.file, label: f.file, sub: f.page, run: (tab) => onOpenFile(f.page, f.file, tab) }));
    return [...cmd, ...pg, ...fl]
      .map((it) => {
        const s = Math.max(score(q, it.label), it.sub ? score(q, it.sub + "/" + it.label) - 50 : -1);
        // Commands and pages first when they match as well as a file.
        return { it, s: s < 0 ? s : s + (it.kind === "file" ? 0 : 10) };
      })
      .filter((x) => x.s >= 0)
      .sort((a, b) => b.s - a.s)
      .slice(0, LIMIT)
      .map((x) => x.it);
  }, [commands, pages, files, query, recent, onOpenPage, onOpenFile]);

  useEffect(() => setActive(0), [query]);
  useEffect(() => {
    listRef.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: "nearest" });
  }, [active]);

  const run = (it, inNewTab = false) => {
    if (!it) return;
    onClose();
    it.run(inNewTab && it.kind !== "command");
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
      run(items[active], e.metaKey || e.ctrlKey);
    } else if (e.key === "Escape") {
      e.preventDefault();
      onClose();
    }
  };

  return (
    <div className={"palette-backdrop" + (pagesOnly ? " is-compact" : "")} onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="palette" role="dialog" aria-modal="true" aria-label={pagesOnly ? "Pick a page" : "Command palette"}>
        <input
          ref={inputRef}
          className="palette-input"
          placeholder={pagesOnly ? "Go to a page" : "Go to a page or file, or run a command"}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={onKeyDown}
          role="combobox"
          aria-expanded="true"
          aria-controls="palette-list"
          aria-activedescendant={items[active] ? "palette-" + active : undefined}
          spellCheck={false}
        />
        <div className="palette-list" id="palette-list" role="listbox" ref={listRef}>
          {items.length ? (
            items.map((it, i) => {
              const Icon = it.kind === "command" ? CodeIcon : it.kind === "page" ? PageIcon : FileIcon;
              return (
                <div
                  key={it.key}
                  id={"palette-" + i}
                  role="option"
                  aria-selected={i === active}
                  className={"palette-item" + (it.kind === "file" ? " is-file" : "")}
                  onMouseMove={() => i !== active && setActive(i)}
                  onMouseDown={(e) => {
                    e.preventDefault();
                    run(it, e.metaKey || e.ctrlKey);
                  }}
                >
                  <Icon size={14} className="palette-icon" />
                  <span className="palette-label">{it.label}</span>
                  {it.sub ? <span className="palette-sub">{it.sub}</span> : null}
                  {it.hint ? <kbd className="palette-hint">{prettyAccelerator(it.hint)}</kbd> : null}
                </div>
              );
            })
          ) : (
            <div className="palette-empty">No matches</div>
          )}
        </div>
        <div className="palette-foot" aria-hidden="true">
          <span><kbd>↵</kbd> open</span>
          {pagesOnly ? null : (
            <span>
              <kbd>{formatAccelerator("CmdOrCtrl+Enter")}</kbd> new tab
            </span>
          )}
          <span><kbd>esc</kbd> close</span>
        </div>
      </div>
    </div>
  );
}
