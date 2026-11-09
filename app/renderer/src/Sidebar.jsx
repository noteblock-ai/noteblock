import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import PublishMenu from "./PublishMenu.jsx";
import { CheckIcon, ChevronDown, ChevronRight, CodeIcon, DbIcon, FileIcon, PageIcon, BlankIcon, FolderIcon, MenuIcon, PlusIcon, SearchIcon, SidebarIcon, Spinner } from "./icons.jsx";
import { isWin } from "./platform.js";
import { BRAND } from "../../../core/brand.mjs";

const INDENT = 16;

function lockTitle(lock) {
  return (lock?.by ? lock.by + " is editing" : "Being edited") + (lock?.message ? " — " + lock.message : "");
}

const pad = (depth) => 10 + depth * INDENT;

/** A folder's contents, with the guide line running down from its chevron (depth = the folder's). */
function Children({ depth, children }) {
  return <div className="tree-children" style={{ "--guide-x": pad(depth) + 3 + "px" }}>{children}</div>;
}

// Internal drags carry only this type, so they never look like a Finder drag or drop text anywhere.
const DRAG_TYPE = "application/x-noteblock-path";
const FOLDER_HOVER_MS = 600;
const VAULT_MENU_W = 260; // .pub-menu's min-width; .vault-menu-name keeps long names inside it

const parentOf = (p) => p.split("/").slice(0, -1).join("/");
const hasType = (e, type) => Array.from(e.dataTransfer?.types || []).includes(type);
const canMove = (from, folder) => folder !== from && !folder.startsWith(from + "/") && parentOf(from) !== folder;

/** The folder a drag event points at: rows say so in data-drop, anything else is the vault root. */
function dropFolderAt(e) {
  const hit = (el) => el?.closest?.("[data-drop]");
  let el = hit(e.target);
  // The tree itself under the pointer: the gap between two rows or beside one, not a root drop.
  if (!el && (e.target?.classList?.contains("tree") || e.target?.classList?.contains("tree-children"))) {
    const x = e.target.closest(".tree").getBoundingClientRect().left + 20;
    el = hit(document.elementFromPoint(x, e.clientY)) || hit(document.elementFromPoint(x, e.clientY + 1)) || hit(document.elementFromPoint(x, e.clientY - 1));
  }
  return el ? el.dataset.drop : "";
}

/**
 * A drag over a row's top or bottom edge: put the dragged row before or after that one, in its
 * folder (the folder's order, core/order.mjs). Null over a folder's middle (a move into it) and
 * off the rows. An open folder's bottom edge is its first child's top, so it counts as "into".
 */
function placeAt(e, expanded) {
  const row = e.target?.closest?.(".row[data-path]");
  if (!row || !row.closest(".tree")) return null;
  const r = row.getBoundingClientRect();
  const y = (e.clientY - r.top) / r.height;
  const anchor = row.dataset.path;
  if (row.classList.contains("is-folder")) {
    if (y < 0.28) return { anchor, after: false, row };
    if (y > 0.72 && !expanded.has(anchor)) return { anchor, after: true, row };
    return null;
  }
  return { anchor, after: y >= 0.5, row };
}

const titleOf = (n) => n.title || n.path.split("/").pop();

/**
 * The tree cut down to what matches `q` (lower case): pages whose title matches, folders whose
 * title matches (with everything in them), and folders on the way to a match.
 */
function filterTree(nodes, q) {
  if (!q) return nodes;
  const out = [];
  for (const n of nodes || []) {
    const hit = titleOf(n).toLowerCase().includes(q);
    if (n.kind === "folder") {
      if (hit) out.push(n);
      else {
        const children = filterTree(n.children || [], q);
        if (children.length) out.push({ ...n, children });
      }
    } else if (hit) out.push(n);
  }
  return out;
}

/** First page in a (filtered) tree, depth first. */
function firstPageIn(nodes) {
  for (const n of nodes || []) {
    if (n.kind === "page") return n;
    const inner = n.kind === "folder" ? firstPageIn(n.children) : null;
    if (inner) return inner;
  }
  return null;
}

/** Inline name field for a new page or folder, or (`rename`) for an existing row's new name. */
function NewRow({ kind, depth, parent, initial = "", rename = false, onSubmit, onCancel }) {
  const [name, setName] = useState(initial);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const inputRef = useRef(null);

  useEffect(() => {
    requestAnimationFrame(() => {
      const input = inputRef.current;
      input?.focus();
      input?.select();
      // A plain file keeps its extension unless you go after it.
      const dot = initial.lastIndexOf(".");
      if (rename && kind === "file" && dot > 0) input?.setSelectionRange(0, dot);
    });
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // A refused name: the field was disabled while it was tried, so put the cursor back.
  useEffect(() => {
    if (error) inputRef.current?.focus();
  }, [error]);

  const submit = async () => {
    const title = name.trim().replace(/\//g, "-");
    if (!title || busy) return;
    if (rename && title === initial) return onCancel();
    setBusy(true);
    setError("");
    try {
      await onSubmit(title);
    } catch (e) {
      setError(String(e?.message || e));
      setBusy(false);
    }
  };

  const Icon = kind === "folder" ? FolderIcon : kind === "file" ? FileIcon : PageIcon;
  const noun = kind === "folder" ? "Folder" : kind === "file" ? "File" : "Page";
  return (
    <div className={"new-page" + (rename ? " rename-row" : "")} data-drop={parent} style={{ paddingLeft: depth * INDENT }}>
      <div className="new-page-field">
        <Icon className="row-icon" />
        <input
          ref={inputRef}
          aria-label={rename ? "New name" : "New " + noun.toLowerCase() + " name"}
          placeholder={noun + " name"}
          value={name}
          disabled={busy}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              submit();
            } else if (e.key === "Escape") {
              e.preventDefault();
              onCancel();
            }
          }}
          onBlur={() => {
            if (busy) return;
            if (!name.trim() || (rename && name.trim() === initial)) onCancel();
          }}
        />
      </div>
      {error ? <div className="new-page-error" role="alert">{error}</div> : null}
    </div>
  );
}

/** The name field a row turns into while it's being renamed. */
function RenameRow({ node, depth, ctx }) {
  return (
    <NewRow
      rename
      kind={node.kind}
      depth={depth}
      parent={parentOf(node.path)}
      initial={node.title}
      onSubmit={(name) => ctx.onRenameSubmit(node.path, name)}
      onCancel={ctx.onRenameCancel}
    />
  );
}

function Rows({ nodes, depth, ctx }) {
  const { creating, parentKey } = ctx;
  const here = creating && creating.parent === parentKey ? creating : null;
  return (
    <>
      {here ? (
        <NewRow
          key={"new:" + here.kind + ":" + here.seq}
          kind={here.kind}
          depth={depth}
          parent={here.parent}
          initial={here.name || ""}
          onSubmit={(name) => ctx.onCreateSubmit(here.kind, here.parent, name, here)}
          onCancel={ctx.onCreateCancel}
        />
      ) : null}
      {nodes.map((n) =>
        n.kind === "folder" ? (
          <FolderRow key={n.path} node={n} depth={depth} ctx={ctx} />
        ) : n.kind === "file" ? (
          <PlainFileRow key={n.path} node={n} depth={depth} ctx={ctx} />
        ) : (
          <PageRow key={n.path} node={n} depth={depth} ctx={ctx} />
        ),
      )}
    </>
  );
}

function FolderRow({ node, depth, ctx }) {
  const open = ctx.forceOpen || ctx.expanded.has(node.path) || ctx.creating?.parent === node.path;
  return (
    <>
      {ctx.renaming === node.path ? <RenameRow node={node} depth={depth} ctx={ctx} /> : (
      <div className={"row is-folder" + (node.searchExcluded ? " is-search-excluded" : "") + (ctx.focusedFolder === node.path ? " is-focused" : "") + (ctx.dropOver === node.path ? " is-drop-target" : "")} data-path={node.path} data-drop={node.path} onContextMenu={(e) => ctx.onContextMenu(e, node)}>
        <button
          type="button"
          className="row-main"
          style={{ paddingLeft: pad(depth) }}
          aria-expanded={open}
          {...ctx.dragProps(node.path)}
          onClick={() => {
            ctx.onToggle(node.path);
            ctx.onFocusFolder(node.path);
          }}
        >
          <span className="row-chevron" aria-hidden="true">
            {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
          </span>
          <FolderIcon className="row-icon" />
          <span className="row-title">{node.title}</span>
        </button>
      </div>
      )}
      {open ? <Children depth={depth}><Rows nodes={node.children || []} depth={depth + 1} ctx={{ ...ctx, parentKey: node.path }} /></Children> : null}
    </>
  );
}

/** A plain file sitting in a folder (not inside a page). Opens in the file view. */
function PlainFileRow({ node, depth, ctx }) {
  const isSel = ctx.selected === node.path;
  if (ctx.renaming === node.path) return <RenameRow node={node} depth={depth} ctx={ctx} />;
  return (
    <div className={"row is-plain-file" + (node.searchExcluded ? " is-search-excluded" : "") + (isSel ? " is-selected" : "")} data-path={node.path} data-drop={parentOf(node.path)} onContextMenu={(e) => ctx.onContextMenu(e, node)}>
      <button
        type="button"
        className="row-main"
        style={{ paddingLeft: pad(depth) }}
        aria-current={isSel ? "page" : undefined}
        {...ctx.dragProps(node.path)}
        onClick={(e) => ctx.onSelect(node.path, e)}
      >
        <span className="row-chevron" aria-hidden="true" />
        <FileIcon className="row-icon" />
        <span className="row-title">{node.title}</span>
      </button>
    </div>
  );
}

function PageRow({ node, depth, ctx }) {
  const isSel = ctx.selected === node.path && !ctx.openFile;
  const lock = ctx.lockFor(node.path);
  const aiBusy = !lock && !!ctx.aiBusy?.has(node.path);
  const Icon = node.format === "none" ? BlankIcon : PageIcon;
  const filesKey = "files:" + node.path;
  const open = ctx.showFiles && ctx.expanded.has(filesKey);
  return (
    <>
      {ctx.renaming === node.path ? <RenameRow node={node} depth={depth} ctx={ctx} /> : (
      <div className={"row" + (node.searchExcluded ? " is-search-excluded" : "") + (isSel ? " is-selected" : "") + (ctx.showFiles ? " has-files" : "")} data-path={node.path} data-drop={parentOf(node.path)} onContextMenu={(e) => ctx.onContextMenu(e, node)}>
        <button
          type="button"
          className="row-main"
          style={{ paddingLeft: pad(depth) }}
          aria-current={isSel ? "page" : undefined}
          aria-expanded={ctx.showFiles ? open : undefined}
          {...ctx.dragProps(node.path)}
          onClick={(e) => ctx.onSelect(node.path, e)}
          title={lock ? lockTitle(lock) : aiBusy ? "Noteblock AI is working on this page" : undefined}
        >
          {ctx.showFiles ? (
            <span
              className="row-chevron is-toggle"
              aria-hidden="true"
              onClick={(e) => {
                e.stopPropagation();
                ctx.onToggle(filesKey);
              }}
            >
              {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
            </span>
          ) : (
            <span className="row-chevron" aria-hidden="true" />
          )}
          <Icon className="row-icon" />
          <span className="row-title">{node.title}</span>
          {lock ? <Spinner size={12} label={lockTitle(lock)} /> : aiBusy ? <Spinner size={12} label="Noteblock AI is working on this page" /> : null}
        </button>
      </div>
      )}
      {open ? <Children depth={depth}><PageFiles page={node.path} depth={depth + 1} ctx={ctx} /></Children> : null}
    </>
  );
}

/** A page's own files, fetched when its row is opened and again whenever files change. */
function PageFiles({ page, depth, ctx }) {
  const [files, setFiles] = useState(null);
  const [error, setError] = useState("");
  useEffect(() => {
    let alive = true;
    ctx.api.listFiles(page).then(
      (list) => alive && (setFiles(list || []), setError("")),
      (e) => alive && setError(String(e?.message || e)),
    );
    return () => {
      alive = false;
    };
  }, [ctx.api, page, ctx.filesVersion]);
  if (error) return <div className="file-empty" style={{ paddingLeft: pad(depth) + 20 }}>{error}</div>;
  if (!files) return null;
  if (!files.length) return <div className="file-empty" style={{ paddingLeft: pad(depth) + 20 }}>No files</div>;
  return <FileRows page={page} nodes={files} depth={depth} ctx={ctx} />;
}

function FileRows({ page, nodes, depth, ctx }) {
  return nodes.map((f) => {
    if (f.kind === "dir") {
      const key = "files:" + page + "/" + f.path;
      const open = ctx.expanded.has(key);
      return (
        <div key={f.path}>
          <div className="row is-folder is-file" data-drop={parentOf(page)}>
            <button type="button" className="row-main" style={{ paddingLeft: pad(depth) }} aria-expanded={open} onClick={() => ctx.onToggle(key)}>
              <span className="row-chevron" aria-hidden="true">
                {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
              </span>
              <FolderIcon className="row-icon" />
              <span className="row-title">{f.name}</span>
            </button>
          </div>
          {open ? <Children depth={depth}><FileRows page={page} nodes={f.children || []} depth={depth + 1} ctx={ctx} /></Children> : null}
        </div>
      );
    }
    const isSel = ctx.selected === page && ctx.openFile === f.path;
    const menu = (e) => ctx.onContextMenu(e, { kind: "page-file", path: page + "/" + f.path, title: f.name, page, file: f.path });
    return (
      <div key={f.path} className={"row is-file" + (isSel ? " is-selected" : "")} data-drop={parentOf(page)} onContextMenu={menu}>
        <button
          type="button"
          className="row-main"
          style={{ paddingLeft: pad(depth) }}
          aria-current={isSel ? "page" : undefined}
          onClick={(e) => ctx.onSelectFile(page, f.path, e)}
        >
          <span className="row-chevron" aria-hidden="true" />
          <FileIcon className="row-icon" />
          <span className="row-title">{f.name}</span>
        </button>
      </div>
    );
  });
}

export default function Sidebar({
  vaultName,
  tree,
  selected,
  expanded,
  onSelect,
  onToggle,
  lockFor,
  aiBusy,
  creating,
  onCreateSubmit,
  onCreateCancel,
  onContextMenu,
  onNew,
  api,
  showFiles,
  onShowFiles,
  openFile,
  onSelectFile,
  filesVersion,
  onMoveInto,
  onImportFiles,
  focusedFolder,
  focusReveal,
  onFocusFolder,
  renaming,
  onRenameSubmit,
  onRenameCancel,
  // Embed mode (App.jsx): `tree` is one folder's children and `root` that folder's vault path,
  // so the top level's new-page row is keyed by it. No vault row; a filter box instead; the
  // foot holds the button that hides the sidebar (onHide).
  root = "",
  scoped = false,
  onHide,
  hideLabel,
}) {
  const [dropOver, setDropOver] = useState(null); // the folder under a drag; "" is the vault root
  const [insertLine, setInsertLine] = useState(null); // {top, left}: where a reorder drop lands
  const dragging = useRef(null); // the path this window is dragging (dragover can't read the data)
  const hover = useRef({ folder: null, timer: null });
  const expandedRef = useRef(expanded);
  expandedRef.current = expanded;
  const treeEl = useRef(null);

  const rowFor = (path) => treeEl.current?.querySelector(`.row[data-path="${CSS.escape(path)}"]`);

  // The selected row stays in view however it got selected (⌘P, a link, the graph, Back).
  const hasTree = tree.length > 0;
  useEffect(() => {
    if (!selected) return;
    const row = treeEl.current?.querySelector(".row.is-selected") || rowFor(selected);
    row?.scrollIntoView({ block: "nearest" });
  }, [selected, openFile, hasTree]);

  // A folder crumb was clicked.
  useEffect(() => {
    if (focusReveal && focusedFolder) rowFor(focusedFolder)?.scrollIntoView({ block: "nearest" });
  }, [focusReveal]); // eslint-disable-line react-hooks/exhaustive-deps

  const clearDrop = () => {
    clearTimeout(hover.current.timer);
    hover.current = { folder: null, timer: null };
    setDropOver(null);
    setInsertLine(null);
  };

  // A reorder drop the dragged row can take: not onto itself, not into its own subtree.
  const usablePlace = (e) => {
    const place = placeAt(e, expandedRef.current);
    const from = dragging.current;
    if (!place || from == null) return null;
    const folder = parentOf(place.anchor);
    if (place.anchor === from || folder === from || folder.startsWith(from + "/")) return null;
    return place;
  };

  const dragProps = (path) => ({
    draggable: true,
    onDragStart: (e) => {
      e.dataTransfer.effectAllowed = "move";
      e.dataTransfer.setData(DRAG_TYPE, path);
      dragging.current = path;
    },
    onDragEnd: () => {
      dragging.current = null;
      clearDrop();
    },
  });

  const onDragOver = (e) => {
    const internal = hasType(e, DRAG_TYPE);
    if (!internal && !hasType(e, "Files")) return;
    const place = internal ? usablePlace(e) : null;
    if (place) {
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";
      const tree = treeEl.current;
      const t = tree.getBoundingClientRect();
      const r = place.row.getBoundingClientRect();
      const main = place.row.querySelector(".row-main");
      const left = (main ? main.getBoundingClientRect().left + parseFloat(main.style.paddingLeft || 0) : r.left) - t.left;
      const top = (place.after ? r.bottom : r.top) - t.top + tree.scrollTop;
      setInsertLine((cur) => (cur && cur.top === top && cur.left === left ? cur : { top, left }));
      setDropOver(null);
      clearTimeout(hover.current.timer);
      hover.current = { folder: null, timer: null };
      return;
    }
    setInsertLine(null);
    const folder = dropFolderAt(e) || root; // embed mode: its folder is the root
    if (internal && dragging.current != null && !canMove(dragging.current, folder)) return clearDrop();
    e.preventDefault();
    e.dataTransfer.dropEffect = internal ? "move" : "copy";
    setDropOver(folder);
    if (hover.current.folder === folder) return;
    clearTimeout(hover.current.timer);
    const timer = folder
      ? setTimeout(() => {
          if (!expandedRef.current.has(folder)) onToggle(folder);
        }, FOLDER_HOVER_MS)
      : null;
    hover.current = { folder, timer };
  };

  const onDrop = (e) => {
    const internal = hasType(e, DRAG_TYPE);
    if (!internal && !hasType(e, "Files")) return;
    e.preventDefault();
    const place = internal ? usablePlace(e) : null;
    const folder = dropFolderAt(e) || root; // embed mode: its folder is the root
    clearDrop();
    if (place) {
      const from = e.dataTransfer.getData(DRAG_TYPE) || dragging.current;
      if (from) onMoveInto(from, parentOf(place.anchor), { anchor: place.anchor.split("/").pop(), after: place.after });
      return;
    }
    if (internal) {
      const from = e.dataTransfer.getData(DRAG_TYPE);
      if (from && canMove(from, folder)) onMoveInto(from, folder);
      return;
    }
    const sources = Array.from(e.dataTransfer.files || []).map((f) => window.quireApp?.pathForFile?.(f)).filter(Boolean);
    if (sources.length) onImportFiles(sources, folder);
  };

  // A file dropped anywhere else in the window is refused here. Page iframes keep their own events.
  useEffect(() => {
    const isFiles = (e) => hasType(e, "Files") && !e.defaultPrevented;
    const refuse = (e) => {
      if (!isFiles(e)) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = "none";
    };
    const swallow = (e) => {
      if (isFiles(e)) e.preventDefault();
    };
    window.addEventListener("dragover", refuse);
    window.addEventListener("drop", swallow);
    return () => {
      window.removeEventListener("dragover", refuse);
      window.removeEventListener("drop", swallow);
      clearTimeout(hover.current.timer);
    };
  }, []);

  // The vault switcher. PublishMenu closes itself on any mousedown outside, the button included,
  // so a click on the button while it's open must not open it again.
  const [vaultMenu, setVaultMenu] = useState(null); // {anchor, items}
  const vaultMenuWasOpen = useRef(false);
  const closeVaultMenu = useCallback(() => setVaultMenu(null), []);

  const openVaultMenu = async (e) => {
    if (vaultMenuWasOpen.current) {
      vaultMenuWasOpen.current = false;
      return;
    }
    const r = e.currentTarget.getBoundingClientRect();
    const info = await api.vaultInfo?.().catch(() => null);
    const row = (label, current) => (
      <span className={"vault-menu-row" + (current ? " is-current" : "")}>
        <span className="vault-menu-check">{current ? <CheckIcon size={14} /> : null}</span>
        <span className="vault-menu-name">{label}</span>
      </span>
    );
    const vaults = (info?.vaults || []).filter((v) => !v.missing);
    setVaultMenu({
      // PublishMenu lines its right edge up with the anchor's: VAULT_MENU_W starts it at the button's left.
      anchor: { bottom: r.bottom, right: r.left + VAULT_MENU_W },
      items: [
        ...vaults.map((v) => ({ id: "vault:" + v.path, label: row(v.name, v.current), current: v.current })),
        ...(vaults.length ? [{ type: "separator" }] : []),
        { id: "open", label: row("Open vault…") },
        { id: "new", label: row("New vault…") },
      ],
    });
  };

  const pickVault = (id) => {
    const item = vaultMenu?.items.find((it) => it.id === id);
    setVaultMenu(null);
    const run = id === "open" ? api.openVault() : id === "new" ? api.createVault() : item?.current ? null : api.switchVault(id.slice("vault:".length));
    run?.catch((err) => window.alert(String(err?.message || err)));
  };

  const badge = (vaultName || "Q").trim().charAt(0).toUpperCase() || "Q";
  const [query, setQuery] = useState("");
  const q = scoped ? query.trim().toLowerCase() : "";
  const shown = useMemo(() => filterTree(tree, q), [tree, q]);
  const ctx = { selected, expanded, onSelect, onToggle, lockFor, aiBusy, creating, onCreateSubmit, onCreateCancel, onContextMenu, parentKey: root,
    api, showFiles, openFile, onSelectFile, filesVersion, dropOver, dragProps, focusedFolder, onFocusFolder, renaming, onRenameSubmit, onRenameCancel, forceOpen: !!q };

  return (
    <aside
      className={"sidebar" + (scoped ? " is-scoped" : "")}
      onDragOver={onDragOver}
      onDrop={onDrop}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget)) clearDrop();
      }}
    >
      {scoped ? (
        <label className="side-search">
          <SearchIcon size={13} />
          <input
            type="search"
            value={query}
            placeholder="Search pages"
            aria-label="Search pages"
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") setQuery("");
              else if (e.key === "Enter") {
                const first = firstPageIn(shown);
                if (first) onSelect(first.path);
              }
            }}
          />
        </label>
      ) : (
      <div className="vault">
        {isWin ? (
          // Windows has no menu bar at the top of the screen: File / Edit / View / Window / Help
          // pop up from here (Alt opens them too, main.mjs).
          <button
            type="button"
            className="app-menu-button"
            title="Menu (Alt)"
            aria-label="Menu"
            onClick={(e) => {
              const r = e.currentTarget.getBoundingClientRect();
              window.quireApp?.popupAppMenu?.(r.left, r.bottom + 4);
            }}
          >
            <MenuIcon size={15} />
          </button>
        ) : null}
        <button
          type="button"
          className="vault-switch"
          title="Switch vault"
          aria-haspopup="menu"
          aria-expanded={!!vaultMenu}
          onPointerDown={() => {
            vaultMenuWasOpen.current = !!vaultMenu;
          }}
          onClick={openVaultMenu}
        >
          <span className="vault-badge" aria-hidden="true">{badge}</span>
          <span className="vault-name">{vaultName || BRAND.name}</span>
          <ChevronDown size={12} className="vault-switch-chevron" />
        </button>
      </div>
      )}
      {vaultMenu ? <PublishMenu anchor={vaultMenu.anchor} items={vaultMenu.items} onPick={pickVault} onClose={closeVaultMenu} /> : null}

      <nav
        aria-label="Pages"
        ref={treeEl}
        className={"tree" + (dropOver === root ? " is-drop-root" : "") + (focusedFolder === "" ? " is-focus-root" : "")}
        data-focus={focusedFolder ?? undefined}
        onClick={(e) => {
          if (!e.target.closest("button, input, .row, .new-page, .tree-children")) onFocusFolder("");
        }}
        onContextMenu={(e) => {
          if (e.defaultPrevented) return;
          onContextMenu(e, null);
        }}
      >
        <div className="tree-label">
          <span>Pages</span>
          <button
            type="button"
            className="files-toggle"
            aria-pressed={showFiles}
            title={showFiles ? "Hide source files" : "Show source files"}
            onClick={() => onShowFiles(!showFiles)}
          >
            <CodeIcon size={13} />
            Source
          </button>
        </div>
        <Rows nodes={shown} depth={0} ctx={ctx} />
        {q && !shown.length ? <div className="file-empty side-none">No pages match</div> : null}

        <div className="add-rows">
          <button type="button" className="row-main add-row" onClick={() => onNew("page")}>
            <PlusIcon className="row-icon" />
            <span>New page</span>
          </button>
          <button type="button" className="row-main add-row add-folder" title="New folder" aria-label="New folder" onClick={() => onNew("folder")}>
            <FolderIcon className="row-icon" />
          </button>
        </div>
        {insertLine ? <div className="drop-line" style={{ top: insertLine.top, left: insertLine.left }} aria-hidden="true" /> : null}
      </nav>

      {scoped ? (
        <div className="sidebar-foot is-scoped">
          <button type="button" className="side-toggle" title={hideLabel} aria-label="Hide sidebar" onClick={onHide}>
            <SidebarIcon size={15} />
          </button>
        </div>
      ) : (
        <div className="sidebar-foot">
          <DbIcon size={14} />
          <span>On this device</span>
        </div>
      )}
    </aside>
  );
}
