// The floating note window (renderer/floating.html): one page iframe, the same quire:// page
// the main window shows, in the editor. It answers the page runtime's rpc messages the way
// App.jsx does, through the same quireApp.rpc → "quire:rpc" path, so saves autosave and commit
// like any edit. ⌘P opens a page picker that changes the note's page; a page that's gone shows
// an empty state instead of another page. The same heartbeat as the main window watches the
// note's page (RecoveryOverlay.jsx): a frozen or crashed note gets the card in the note.
// See app/main/floating.mjs.
import "@fontsource-variable/geist";
import "./styles.css";
import { useCallback, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { CloseIcon } from "./icons.jsx";
import Palette from "./Palette.jsx";
import FindBar from "./FindBar.jsx";
import { RecoveryOverlay, usePageHealth } from "./RecoveryOverlay.jsx";
import { usePageSwap } from "./usePageSwap.js";
import { findPageNode, pageOfOrigin, pageSrc } from "./tree.js";
import { applyPlatformClass } from "./platform.js";

applyPlatformClass();

const WRITE_METHODS = new Set(["store.insert", "store.update", "store.remove", "kv.set"]);

function post(win, msg) {
  try {
    win?.postMessage(msg, "*");
  } catch {
    /* frame gone */
  }
}

export default function Floating() {
  const api = window.quireApp;
  const [page, setPage] = useState(null); // {path, title, build, renderer}
  const [missing, setMissing] = useState(""); // the configured page, when it's gone
  const [error, setError] = useState("");
  const [tree, setTree] = useState(null);
  const treeRef = useRef(null);
  treeRef.current = tree;
  const [picking, setPicking] = useState(false);
  const [finding, setFinding] = useState(false);
  const findBar = useRef(null);
  const missingRef = useRef("");
  missingRef.current = missing;
  const [frameKey, setFrameKey] = useState(0);
  const [locked, setLocked] = useState(false);
  const frame = useRef(null);
  const pageRef = useRef(null);
  pageRef.current = page;
  const dirty = useRef(false);
  const lockedRef = useRef(false);
  lockedRef.current = locked;

  const reload = () => setFrameKey((k) => k + 1);
  const swapRef = useRef(null);
  const isBufferRef = useRef(null);

  // An inspector of the note's previous page closes when the note moves off it.
  useEffect(() => {
    api.devtoolsOpenPages?.(page ? [page.path] : []).catch(() => {});
  }, [api, page?.path]); // eslint-disable-line react-hooks/exhaustive-deps

  const load = useCallback(() => {
    api.floatingPage().then(
      (p) => {
        setError("");
        dirty.current = false;
        if (p && p.missing) {
          setMissing(p.missing);
          setPage(null);
          return;
        }
        setMissing("");
        setPage(p);
        reload();
      },
      (e) => setError(String(e?.message || e)),
    );
  }, [api]);

  // Lock state (and whether the page still exists) comes from the tree.
  const refreshTree = useCallback(async () => {
    const cur = pageRef.current;
    if (!cur && !missingRef.current) return;
    let tree;
    try {
      tree = await api.listTree();
    } catch {
      return;
    }
    setTree(tree);
    if (!cur) return load(); // showing the empty state: the page may be back
    const node = findPageNode(tree, cur.path);
    if (!node) return load(); // renamed, moved or deleted: the empty state
    const l = !!node.lock;
    if (l !== lockedRef.current) {
      setLocked(l);
      reload(); // main serves the snapshot while locked
    }
    if (node.title !== cur.title) setPage((p) => (p ? { ...p, title: node.title } : p));
  }, [api, load]);

  useEffect(() => {
    load();
    const offs = [
      api.onFloatingChanged?.(() => load()),
      api.onFloatingShown?.(() => frame.current?.focus()),
      api.onPageFilesChanged?.((p) => {
        const cur = pageRef.current;
        // Unsaved typing here wins over a reload.
        if (cur && typeof p === "string" && (p === cur.path || p.startsWith(cur.path + "/")) && !dirty.current) swapRef.current?.();
      }),
      api.onBuildStatus?.((msg) => {
        if (msg && msg.reload && msg.path === pageRef.current?.path) reload();
      }),
      api.onTreeChanged?.(() => refreshTree()),
      api.onLocksChanged?.(() => refreshTree()),
      // ⌘P (the app menu sends it here while the note is focused).
      api.onMenu?.((action) => {
        if (action === "command-palette") setPicking((o) => !o);
        // ⌘F / ⌘G / ⇧⌘G while the note is in front: find in the note's page.
        const bar = findBar.current;
        if (!bar || (action !== "find" && action !== "find-next" && action !== "find-previous")) return;
        if (action === "find" || !bar.isOpen()) bar.open();
        else bar.step(action === "find-next" ? 1 : -1);
      }),
    ];
    return () => offs.forEach((off) => off && off());
  }, [api, load, refreshTree]);

  useEffect(() => {
    refreshTree();
  }, [page?.path, missing]); // eslint-disable-line react-hooks/exhaustive-deps

  // The picker lists the vault's pages as they are now; main lets Esc close it (or the find bar).
  useEffect(() => {
    api.floatingPicking?.(picking || finding).catch(() => {});
  }, [api, picking, finding]);
  useEffect(() => {
    if (!picking) return;
    api.listTree().then(setTree, () => {});
  }, [api, picking]);

  const closePicker = () => {
    setPicking(false);
    requestAnimationFrame(() => frame.current?.focus());
  };

  const choose = (path) => {
    setPicking(false);
    if (path === pageRef.current?.path) return frame.current?.focus();
    api.setFloating({ page: path }).catch((e) => setError(String(e?.message || e))); // floating-changed reloads
  };

  const newNote = () => {
    api.newFloatingNote().catch((e) => setError(String(e?.message || e)));
  };

  // The page runtime's messages (window.top is this window).
  useEffect(() => {
    const onMessage = async (event) => {
      const msg = event.data;
      if (!msg || typeof msg !== "object" || msg.quire !== 1) return;
      // The sending page, from its frame's origin (quire://p-<id>); main checks it again for rpcs.
      const cur = pageRef.current;
      const fromPage = cur && cur.id && event.origin === "quire://p-" + cur.id ? cur.path : pageOfOrigin(treeRef.current, event.origin);
      if (msg.type === "dirty") {
        if (fromPage && fromPage === cur?.path && !isBufferRef.current?.(event.source)) dirty.current = !!msg.dirty;
        return;
      }
      if (msg.type === "embed-kill") {
        // An embed's Reload: end the embed's hung process, never the note's page.
        const t = typeof msg.page === "string" ? findPageNode(treeRef.current, msg.page) : null;
        const keeper = fromPage ? findPageNode(treeRef.current, fromPage) : null;
        if (t && keeper) api.killPageProcess?.(pageSrc(t.path, t.id), { keep: pageSrc(keeper.path, keeper.id) }).catch(() => {});
        return;
      }
      if (msg.type !== "rpc" || !event.source) return;
      const source = event.source;
      const { id, method } = msg;
      const params = msg.params || {};
      if (method === "navigate") {
        // Links to other pages don't move the note off its page.
        post(source, { quire: 1, type: "rpc-result", id, result: null });
        return;
      }
      try {
        const result = await api.rpc(event.origin, method, params);
        post(source, { quire: 1, type: "rpc-result", id, result: result === undefined ? null : result });
        if (method === "save") dirty.current = false;
        if (WRITE_METHODS.has(method)) post(frame.current?.contentWindow, { quire: 1, type: "store-changed", page: fromPage, table: params.table ?? null });
      } catch (e) {
        post(source, { quire: 1, type: "rpc-result", id, error: String(e?.message ?? e) });
      }
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [api]);

  const health = usePageHealth({
    api,
    frameRef: frame,
    src: page ? pageSrc(page.path, page.id) : null,
    active: !!page && !picking,
    mountKey: (page?.path || "") + ":" + frameKey,
    onReload: reload,
  });

  const sendMode = (win) => {
    const p = pageRef.current;
    const edit = !lockedRef.current && (p?.renderer || "quire") !== "view";
    post(win, { quire: 1, type: "mode", edit, readOnly: lockedRef.current || !edit, manualSave: !!p?.build });
  };
  const onLoad = () => {
    findBar.current?.refresh();
    sendMode(frame.current?.contentWindow);
    frame.current?.focus();
  };

  // A save from the main window reloads the note: the old frame stays up until the new one is ready.
  const pageSwap = usePageSwap({
    frameRef: frame,
    owner: page?.path || null,
    active: !!page,
    pageKey: frameKey,
    setPageKey: setFrameKey,
    canBuffer: () => !pageRef.current?.build,
    onBufferLoad: sendMode,
    onVisibleLoad: onLoad,
  });
  swapRef.current = pageSwap.swap;
  isBufferRef.current = pageSwap.isBuffer;

  return (
    <div className="floating">
      <header className="floating-bar">
        <span className="floating-title" title={page?.path}>
          {page?.title || (missing ? missing.split("/").pop() : "Floating note")}
          {locked ? <span className="floating-lock"> · read-only while Claude edits</span> : null}
        </span>
        <button type="button" className="floating-close" aria-label="Hide floating note" title="Hide (Esc)" onClick={() => api.hideFloating()}>
          <CloseIcon />
        </button>
      </header>
      {error ? (
        <p className="floating-error" role="alert">
          {error}
        </p>
      ) : missing ? (
        <div className="floating-gone">
          <p>This note was moved or deleted.</p>
          <div className="floating-gone-actions">
            <button type="button" className="settings-button" onClick={() => setPicking(true)}>
              Pick another page
            </button>
            <button type="button" className="settings-button is-primary" onClick={newNote}>
              New floating note
            </button>
          </div>
        </div>
      ) : page ? (
        <div className="floating-body">
          {pageSwap.frames.map((f) => (
            <iframe
              name="q-floating"
              key={f.id}
              ref={f.ref}
              className="floating-frame"
              data-q-frame={f.role}
              style={f.style}
              aria-hidden={f.hidden || undefined}
              tabIndex={f.hidden ? -1 : undefined}
              title={page.title}
              sandbox="allow-scripts allow-same-origin allow-forms allow-pointer-lock"
              allow="fullscreen; autoplay"
              src={pageSrc(page.path, page.id)}
              onLoad={f.onLoad}
            />
          ))}
          <FindBar ref={findBar} frameRef={frame} onOpenChange={setFinding} />
          <RecoveryOverlay health={health.health} title={page.title} page={page.path} titleFor={(p) => findPageNode(tree, p)?.title || p.split("/").pop()} onReload={health.reload} onWait={health.wait} />
        </div>
      ) : null}
      {picking ? <Palette api={api} tree={tree} pagesOnly onOpenPage={choose} onClose={closePicker} /> : null}
    </div>
  );
}

createRoot(document.getElementById("root")).render(<Floating />);
