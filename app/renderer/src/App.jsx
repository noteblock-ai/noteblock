import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { formatAccelerator, isWin, words } from "./platform.js";
import Sidebar from "./Sidebar.jsx";
import SourceView from "./SourceView.jsx";
import FileView from "./FileView.jsx";
import Palette from "./Palette.jsx";
import TemplatePicker from "./TemplatePicker.jsx";
import Settings from "./Settings.jsx";
import { ChevronDown, ChevronLeft, ChevronRight, CloseIcon, CodeIcon, FileIcon, GlobeIcon, MenuIcon, PageIcon, PlusIcon, SidebarIcon, Spinner } from "./icons.jsx";
import ConfirmDialog from "./ConfirmDialog.jsx";
import TrustDialog from "./TrustDialog.jsx";
import SignInDialog from "./SignInDialog.jsx";
import { publishStep } from "./publishPlan.mjs";
import PublishMenu, { FolderPublishToast } from "./PublishMenu.jsx";
import { StableLabel } from "./PublishingPane.jsx";
import UpdateToast from "./UpdateToast.jsx";
import FindBar from "./FindBar.jsx";
import { codeEditorFind } from "./CodeEditor.jsx";
import { BackendPanel, BackendPill, MissingToolBanner } from "./BackendPanel.jsx";
import { RecoveryOverlay, usePageHealth } from "./RecoveryOverlay.jsx";
import { usePageSwap } from "./usePageSwap.js";
import { ErrorPanel, ErrorPill, addPageError } from "./PageErrors.jsx";
import { ancestry, collectLocks, findNode, findPageNode, firstPage, flatten, historyStep, pageOfOrigin, pageOfWindow, pageSrc, pageSrcIn, parentPath, readLocal, withAncestors, writeLocal } from "./tree.js";
import { embedFolder, isEmbed, isWeb } from "./webBridge.js";
import { BRAND } from "../../../core/brand.mjs";
import AiChat, { cleanError } from "./AiChat.jsx";

export const RENDERER_LABELS = { quire: `${BRAND.name} editor`, view: "Rendered", source: "Source + preview" };

const WRITE_METHODS = new Set(["store.insert", "store.update", "store.remove", "kv.set"]);

// Noteblock AI job states (docs/ai.md) that still need the job's page left alone by nobody:
// the page never locks; block jobs get a sidebar spinner, chat turns show in the ⌘J card.
const AI_RUNNING = new Set(["working", "ask", "ready", "applying"]);
const AI_FORWARD = new Set(["progress", "error", "done", "stopped"]);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const aiCount = (x) => (Array.isArray(x) ? x.length : Number(x) || 0);

const newTabId = () => Math.random().toString(36).slice(2, 10);

// Embed mode (webBridge.js): one vault folder, the sidebar scoped to it, no Settings, AI,
// publishing, tabs or other windows. Menu actions that would open those do nothing there.
const EMBED_BLOCKED = new Set(["settings", "import", "import-obsidian", "import-claude", "ai-bar", "new-tab", "new-from-template", "command-palette"]);
const inEmbedFolder = (p) => typeof p === "string" && p.startsWith(embedFolder + "/");
const EMBED_SIDEBAR_KEY = "nb:embed:sidebarHidden";
// The keyboard on the viewer's machine (the web renderer's platform is "web", not the OS).
const macKeys = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent || "");

/** Does a keydown match an Electron accelerator ("CmdOrCtrl+Shift+N")? Letters and digits only. */
function keyMatches(e, acc) {
  if (!acc) return false;
  const parts = String(acc).split("+");
  const key = parts.pop();
  if (!/^[A-Za-z0-9]$/.test(key)) return false;
  const want = { meta: false, ctrl: false, alt: false, shift: false };
  for (const m of parts) {
    if (m === "CmdOrCtrl" || m === "CommandOrControl") want[macKeys ? "meta" : "ctrl"] = true;
    else if (m === "Ctrl" || m === "Control") want.ctrl = true;
    else if (m === "Command" || m === "Cmd" || m === "Super" || m === "Meta") want.meta = true;
    else if (m === "Alt" || m === "Option") want.alt = true;
    else if (m === "Shift") want.shift = true;
  }
  const code = /^[0-9]$/.test(key) ? "Digit" + key : "Key" + key.toUpperCase();
  return e.code === code && e.metaKey === want.meta && e.ctrlKey === want.ctrl && e.altKey === want.alt && e.shiftKey === want.shift;
}

function TabBar({ tabs, active, tree, onShow, onClose, onNew, onMove }) {
  const nodes = useMemo(() => new Map(flatten(tree).map((n) => [n.path, n])), [tree]);
  const [drag, setDrag] = useState(null); // {id, over, after}: a tab being dragged to a new spot
  const dropAt = (e, t) => {
    const r = e.currentTarget.getBoundingClientRect();
    return { over: t.id, after: e.clientX > r.left + r.width / 2 };
  };
  return (
    <div className="tabbar" role="tablist" aria-label="Open pages">
      {tabs.map((t) => {
        const title = t.file ? t.file.split("/").pop() : t.path ? nodes.get(t.path)?.title || t.path.split("/").pop() : "New tab";
        const on = t.id === active;
        return (
          <div
            key={t.id}
            role="tab"
            aria-selected={on}
            className={
              "tab" +
              (on ? " is-active" : "") +
              (drag?.id === t.id ? " is-dragging" : "") +
              (drag && drag.over === t.id && drag.id !== t.id ? (drag.after ? " drop-after" : " drop-before") : "")
            }
            title={t.path ? t.path + (t.file ? "/" + t.file : "") : undefined}
            draggable
            onDragStart={(e) => {
              e.dataTransfer.effectAllowed = "move";
              e.dataTransfer.setData("text/plain", t.id);
              setDrag({ id: t.id, over: null, after: false });
            }}
            onDragOver={(e) => {
              if (!drag) return;
              e.preventDefault();
              const at = dropAt(e, t);
              if (at.over !== drag.over || at.after !== drag.after) setDrag({ ...drag, ...at });
            }}
            onDrop={(e) => {
              e.preventDefault();
              if (drag && drag.id !== t.id) onMove(drag.id, t.id, dropAt(e, t).after);
              setDrag(null);
            }}
            onDragEnd={() => setDrag(null)}
            onMouseDown={(e) => {
              if (e.button === 1) {
                e.preventDefault();
                onClose(t.id);
              } else if (e.button === 0 && !on) onShow(t);
            }}
          >
            {t.file ? <FileIcon size={13} className="tab-icon" /> : <PageIcon size={13} className="tab-icon" />}
            <span className="tab-title">{title}</span>
            <button
              type="button"
              className="tab-close"
              aria-label={"Close " + title}
              onMouseDown={(e) => e.stopPropagation()}
              onClick={() => onClose(t.id)}
            >
              <CloseIcon size={12} />
            </button>
          </div>
        );
      })}
      <button type="button" className="tab-new" aria-label="New tab" title="New tab" onClick={onNew}>
        <PlusIcon size={14} />
      </button>
    </div>
  );
}

function NoApp() {
  return (
    <div className="no-app">
      <h1>Open in the {BRAND.name} app</h1>
      <p>This window needs the {BRAND.name} desktop app to reach your vault.</p>
    </div>
  );
}

export default function App() {
  const api = typeof window !== "undefined" ? window.quireApp : null;
  if (!api) return <NoApp />;
  return <Shell api={api} />;
}

const byName = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

/** The tree with a just-created page in its place (the sort listTree uses), for the frame before the next read. */
function withNewNode(nodes, parent, node) {
  const name = node.path.split("/").pop();
  const add = (list) => {
    if (list.some((n) => n.path === node.path)) return list;
    const at = list.findIndex((n) => n.kind !== "folder" && byName.compare(n.path.split("/").pop(), name) > 0);
    const next = [...list];
    next.splice(at < 0 ? list.length : at, 0, node);
    return next;
  };
  if (!parent) return add(nodes);
  return nodes.map((n) => {
    if (n.kind !== "folder") return n;
    if (n.path === parent) return { ...n, children: add(n.children || []) };
    return parent.startsWith(n.path + "/") ? { ...n, children: withNewNode(n.children || [], parent, node) } : n;
  });
}

function Shell({ api }) {
  const embed = isEmbed;
  const [state, setState] = useState(null);
  const [tree, setTree] = useState([]);
  const [treeLoaded, setTreeLoaded] = useState(false);
  const [locks, setLocks] = useState([]);
  const [selected, setSelected] = useState(null);
  const [expanded, setExpanded] = useState(() => new Set());
  const [mode, setMode] = useState("quire"); // the renderer showing the page: "quire" | "view" | "source"
  const [builds, setBuilds] = useState({}); // page path → {state: "building"|"ok"|"error"|"blocked", output, ms}
  const [cmdAsks, setCmdAsks] = useState([]); // new commands waiting for Run / Don't run (app/main/trust.mjs)
  const [trustBusy, setTrustBusy] = useState(false);
  const [buildLogOpen, setBuildLogOpen] = useState(false);
  const [pageDirty, setPageDirty] = useState(false); // a built page with prose edits not saved yet (⌘S)
  const [pub, setPub] = useState(null); // {public, upToDate, busy, state?, error?, output?} for the selected page
  const [pubLogOpen, setPubLogOpen] = useState(false);
  const [pubTargets, setPubTargets] = useState(null); // {quireHost, cloudflare}: where Publish can put the selected page
  const [pubMenu, setPubMenu] = useState(null); // {anchor, items} while the Publish dropdown is open
  const [pubMove, setPubMove] = useState(null); // host to move a live page to, while asking
  const [signInAsk, setSignInAsk] = useState(null); // {kind, host, folder?, waiting?} while "Sign in to publish" is up
  const [folderJobs, setFolderJobs] = useState({}); // folder path → {folder, kind, state, public?, error?, output?, failed?}: its toast
  const [folderUnpublish, setFolderUnpublish] = useState(null); // {folder, name} while asking
  const folderKnown = useRef(new Map()); // folder path → its last folderPublishStatus, for a menu that can't wait on a hash
  const [hostingVersion, setHostingVersion] = useState(0);
  const pubHost = useRef(null); // host of the last publish, for "Try again"
  const [pageKey, setPageKey] = useState(0);
  const [previewKey, setPreviewKey] = useState(0);
  const [filesTick, setFilesTick] = useState(0);
  const [saveStatus, setSaveStatus] = useState(null);
  const [creating, setCreating] = useState(null); // {kind: "page"|"folder"|"template", parent: folder path, seq, template?, name?}
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [shortcuts, setShortcuts] = useState([]);
  const [showFiles, setShowFiles] = useState(false);
  const [sidebarHidden, setSidebarHidden] = useState(false);
  const [renaming, setRenaming] = useState(null); // the sidebar row being renamed: its path
  const [openFile, setOpenFile] = useState(null); // {page, file}: a page file open in the editor
  const [filesVersion, setFilesVersion] = useState(0);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [templateFor, setTemplateFor] = useState(null); // {folder}: the template picker is open
  const [otherVaults, setOtherVaults] = useState([]);
  const [update, setUpdate] = useState(null); // {state: "available"|"updating"|"failed"|…} from updater.mjs
  const [prefs, setPrefs] = useState({ confirmDelete: true });
  const [backend, setBackend] = useState(null); // the selected page's backend: {path, proxy, procs: [...]}
  const [backendOpen, setBackendOpen] = useState(false);
  const [backendTab, setBackendTab] = useState(null); // a process "Show log" asked for
  const [trashAsk, setTrashAsk] = useState(null); // {target, name, what, busy?, error?}: the confirm dialog
  // Open tabs: {id, path, file} (path null = a new, empty tab). The active one mirrors `selected`.
  const [tabs, setTabs] = useState([]);
  const [activeTab, setActiveTab] = useState(null);
  const [visits, setVisits] = useState({}); // tab id → {stack: page paths, at}: Back and Forward
  // Where new pages and folders go: a folder path, "" for the top level, null for the selected
  // page's folder (what selecting a page goes back to).
  const [folderFocus, setFolderFocus] = useState(null);
  const [focusReveal, setFocusReveal] = useState(0); // bumps when a crumb asks the sidebar to show the folder
  const [recent, setRecent] = useState([]); // recently opened page paths, newest first
  const [pageErrors, setPageErrors] = useState([]); // uncaught errors from the page on screen (PageErrors.jsx)
  const [errorsOpen, setErrorsOpen] = useState(false);
  const [errorBadge, setErrorBadge] = useState(true); // limits().errorBadge, re-read on every error

  const pageFrame = useRef(null);
  const previewFrame = useRef(null);
  const findBar = useRef(null);
  const contentEl = useRef(null);
  const storeKey = (k) => "quire:" + (state?.vault || "") + ":" + k;

  /* ---------------------------------------------------------------- load */

  // One listTree at a time; calls that land while one runs fold into a single rerun. An
  // import touches thousands of pages at once, and a listTree per change kept the app busy
  // for minutes.
  const treeLoad = useRef({ running: false, again: false });
  // A rename this window asked for, until its `moved` event: {from, header, followed}. A tree read
  // in that gap has neither name on the page on screen for sure, and without its node the frame's
  // src and the selection both change. aiMoved brings the new tree with the new selection.
  const moving = useRef(null);
  const movingGen = useRef(0);
  const setMoving = useCallback((m) => {
    moving.current = m;
    movingGen.current++;
  }, []);
  const refreshTree = useCallback(async () => {
    const st = treeLoad.current;
    if (st.running) {
      st.again = true;
      return;
    }
    st.running = true;
    try {
      do {
        st.again = false;
        try {
          const gen = movingGen.current;
          const t = (await api.listTree()) || [];
          if (moving.current || gen !== movingGen.current) continue;
          setTree(t);
          setLocks(collectLocks(t));
        } catch (e) {
          console.error("[quire] listTree failed", e);
        }
      } while (st.again);
    } finally {
      st.running = false;
      setTreeLoaded(true);
    }
  }, [api]);

  // Vault changes arrive in bursts; refresh the tree and file lists once per burst.
  const settleTimer = useRef(null);
  const refreshSoon = useCallback(() => {
    clearTimeout(settleTimer.current);
    settleTimer.current = setTimeout(() => {
      refreshTree();
      setFilesVersion((v) => v + 1);
    }, 120);
  }, [refreshTree]);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const s = await api.getState();
        if (!alive) return;
        setState(s || {});
        const prefix = "quire:" + (s?.vault || "") + ":";
        const params = new URLSearchParams(location.search);
        const linked = params.get("page");
        if (embed) {
          // One tab, no tab bar: the linked page or the last one seen in this folder, if it is in it.
          const saved = readLocal(prefix + "embed:" + embedFolder, null);
          const start = inEmbedFolder(linked) ? linked : inEmbedFolder(saved) ? saved : null;
          const tab = { id: newTabId(), path: start, file: null };
          activeTabRef.current = tab.id;
          setTabs([tab]);
          setActiveTab(tab.id);
          setSelected(start);
          refreshTree();
          return;
        }
        // A New Window (⌘⇧N) starts with one tab on the first page instead of this vault's saved tabs.
        const fresh = params.get("window") === "new";
        const open = new Set(readLocal(prefix + "expanded", []));
        if (linked) {
          const parts = linked.split("/");
          for (let i = 1; i < parts.length; i++) open.add(parts.slice(0, i).join("/"));
        }
        setExpanded(open);
        const savedTabs = fresh ? null : readLocal(prefix + "tabs", null);
        const tabList = Array.isArray(savedTabs?.list) && savedTabs.list.length ? savedTabs.list : [{ id: newTabId(), path: null, file: null }];
        const active = tabList.find((t) => t.id === savedTabs?.active) || tabList[0];
        const start = linked || active.path || (fresh || Array.isArray(savedTabs?.list) ? null : readLocal(prefix + "selected", null));
        activeTabRef.current = active.id;
        setTabs(tabList.map((t) => (t.id === active.id ? { ...t, path: start, file: linked ? null : t.file } : t)));
        setActiveTab(active.id);
        setSelected(start);
        if (start && active.file && !linked) setOpenFile({ page: start, file: active.file });
        setRecent(readLocal(prefix + "recent", []));
        setShowFiles(!!readLocal(prefix + "showFiles", false));
        setSidebarHidden(!!readLocal(prefix + "sidebarHidden", false));
      } catch (e) {
        console.error("[quire] getState failed", e);
        setState({});
      }
      refreshTree();
    })();
    return () => {
      alive = false;
    };
  }, [api, refreshTree]);

  // Fall back to the first page when the remembered one is gone (a new tab stays empty).
  useEffect(() => {
    if (!treeLoaded || !state) return;
    if (selected && (findPageNode(tree, selected) || flatten(tree).some((n) => n.kind === "file" && n.path === selected))) return;
    if (!selected && tabs.length > 1) return;
    const first = (embed ? firstPage(findNode(tree, embedFolder)?.children || []) : firstPage(tree))?.path || null;
    if (first !== selected) setSelected(first);
  }, [tree, treeLoaded, selected, state]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (state) writeLocal(storeKey("selected"), selected);
  }, [selected, state]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (state && embed && inEmbedFolder(selected)) writeLocal(storeKey("embed:" + embedFolder), selected);
  }, [selected, state]); // eslint-disable-line react-hooks/exhaustive-deps
  // Embed mode: the folder is made on first load when the vault doesn't have it yet.
  const folderMade = useRef(false);
  useEffect(() => {
    if (!embed || !treeLoaded || folderMade.current) return;
    folderMade.current = true;
    if (findNode(tree, embedFolder)) return;
    api.createFolder(embedFolder).then(
      () => refreshTree(),
      (e) => console.error("[quire] createFolder failed", e),
    );
  }, [treeLoaded]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (state) writeLocal(storeKey("showFiles"), showFiles);
  }, [showFiles, state]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (state) writeLocal(storeKey("sidebarHidden"), sidebarHidden);
  }, [sidebarHidden, state]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (state) writeLocal(storeKey("expanded"), [...expanded]);
  }, [expanded, state]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (state && tabs.length) writeLocal(storeKey("tabs"), { list: tabs, active: activeTab });
  }, [tabs, activeTab, state]); // eslint-disable-line react-hooks/exhaustive-deps
  // Page inspectors close when no tab shows their page any more (page-devtools.mjs).
  const openTabPages = tabs.map((t) => t.path).filter(Boolean).sort().join("\n");
  useEffect(() => {
    if (state) api.devtoolsOpenPages?.(openTabPages ? openTabPages.split("\n") : []).catch(() => {});
  }, [api, openTabPages, state]);
  useEffect(() => {
    if (state) writeLocal(storeKey("recent"), recent);
  }, [recent, state]); // eslint-disable-line react-hooks/exhaustive-deps

  /* ---------------------------------------------------------------- tabs */

  // What the active tab shows follows the selection.
  const activeTabRef = useRef(activeTab);
  useEffect(() => {
    if (!state) return;
    const file = openFile && openFile.page === selected ? openFile.file : null;
    setTabs((ts) => ts.map((t) => (t.id === activeTabRef.current && (t.path !== selected || t.file !== file) ? { ...t, path: selected, file } : t)));
    if (selected) setRecent((r) => (r[0] === selected ? r : [selected, ...r.filter((p) => p !== selected)].slice(0, 30)));
  }, [selected, openFile, state]);

  const tabsRef = useRef(tabs);
  tabsRef.current = tabs;

  const showTab = useCallback((tab) => {
    activeTabRef.current = tab.id;
    setActiveTab(tab.id);
    setSelected(tab.path || null);
    setOpenFile(tab.path && tab.file ? { page: tab.path, file: tab.file } : null);
    setFolderFocus(null);
    if (tab.path) setExpanded((prev) => withAncestors(prev, tab.path));
  }, []);

  // A new tab right after the active one: empty (⌘T, opens ⌘P) or showing `path`.
  const newTab = useCallback(
    (path = null, file = null) => {
      const tab = { id: newTabId(), path, file: path ? file : null };
      const from = activeTabRef.current; // read now: showTab below moves it before the update runs
      setTabs((ts) => {
        const at = ts.findIndex((t) => t.id === from);
        return [...ts.slice(0, at + 1), tab, ...ts.slice(at + 1)];
      });
      showTab(tab);
      if (!path) setPaletteOpen(true);
    },
    [showTab],
  );

  // ⌘-click on a page's own file (sidebar source view): the tab already showing it, else a new
  // one. A plain click opens it in the current tab, like a page.
  const openFileTab = useCallback(
    (page, file) => {
      const have = tabsRef.current.find((t) => t.path === page && t.file === file);
      if (have) showTab(have);
      else newTab(page, file);
    },
    [showTab, newTab],
  );

  // The last tab closes the window, like a browser.
  const closeTab = useCallback(
    (id = activeTabRef.current) => {
      const ts = tabsRef.current;
      if (ts.length <= 1) return window.close();
      const at = ts.findIndex((t) => t.id === id);
      const rest = ts.filter((t) => t.id !== id);
      setTabs(rest);
      setVisits(({ [id]: _closed, ...open }) => open);
      if (id === activeTabRef.current) showTab(rest[Math.min(at, rest.length - 1)]);
    },
    [showTab],
  );

  // Drag and drop: tab `id` lands just before (or after) tab `target`.
  const moveTab = useCallback((id, target, after) => {
    setTabs((ts) => {
      const tab = ts.find((t) => t.id === id);
      const rest = ts.filter((t) => t.id !== id);
      const at = rest.findIndex((t) => t.id === target);
      if (!tab || at < 0) return ts;
      rest.splice(after ? at + 1 : at, 0, tab);
      return rest;
    });
  }, []);

  const cycleTab = useCallback(
    (step) => {
      const ts = tabsRef.current;
      if (ts.length < 2) return;
      const at = ts.findIndex((t) => t.id === activeTabRef.current);
      showTab(ts[(at + step + ts.length) % ts.length]);
    },
    [showTab],
  );

  /* ---------------------------------------------------------------- locks */

  const lockFor = useCallback((path) => locks.find((l) => l.path === path) || null, [locks]);
  const currentLock = selected ? lockFor(selected) : null;
  const locked = !!currentLock;

  // When the current page's lock appears or disappears, main switches between snapshot and
  // live files, so reload what we show.
  const lockSeen = useRef({ path: null, locked: false });
  useEffect(() => {
    const prev = lockSeen.current;
    lockSeen.current = { path: selected, locked };
    if (prev.path === selected && prev.locked !== locked) {
      pageSwap.swap();
      setPreviewKey((k) => k + 1);
      setFilesTick((t) => t + 1);
      setFilesVersion((v) => v + 1);
    }
  }, [selected, locked]);

  /* ---------------------------------------------------------------- events */

  const selectedRef = useRef(selected);
  const treeRef = useRef(tree);
  treeRef.current = tree;
  selectedRef.current = selected;
  // "trusted" | "restricted" | "ask" (app/main/trust.mjs); "ask" behaves as restricted.
  const trustRef = useRef(null);
  trustRef.current = state?.trust || null;

  useEffect(() => {
    const offs = [];
    const on = (name, fn) => {
      if (typeof api[name] === "function") {
        const off = api[name](fn);
        if (typeof off === "function") offs.push(off);
      }
    };
    on("onTreeChanged", refreshSoon);
    // Vault trust changed (the prompt, Settings › Vault, another window): pages reload under the
    // new rules, and a built page that couldn't build gets its build now.
    on("onTrustChanged", (msg) => {
      if (!msg || !msg.trust) return;
      setState((s) => (s && (!msg.vault || msg.vault === s.vault) ? { ...s, trust: msg.trust } : s));
      pageSwap.swap();
      setPreviewKey((k) => k + 1);
      const cur = selectedRef.current;
      const n = cur ? findPageNode(treeRef.current, cur) : null;
      if (msg.trust === "trusted" && n?.build) api.buildPage?.(cur).catch(() => {});
      if (cur) api.backendStatus?.(cur).then((b) => cur === selectedRef.current && setBackend(b || null), () => {});
    });
    on("onTrustRequest", (req) => {
      if (req && req.page) setCmdAsks((list) => [...list.filter((r) => r.page !== req.page), req]);
    });
    on("onTrustAnswered", (msg) => setCmdAsks((list) => list.filter((r) => r.page !== msg?.page)));
    api.trustPending?.().then((list) => Array.isArray(list) && list.length && setCmdAsks(list), () => {});
    on("onLocksChanged", (next) => {
      if (Array.isArray(next)) setLocks(next);
      refreshSoon();
    });
    on("onUpdateStatus", (msg) => setUpdate(msg || null));
    on("onBackendStatus", (msg) => {
      if (msg && msg.path === selectedRef.current) setBackend(msg);
    });
    api.updateStatus?.().then((u) => setUpdate(u || null), () => {});
    on("onPublishStatus", (msg) => {
      if (msg?.folder) {
        const { folder, state } = msg;
        if (state === "done") folderKnown.current.set(folder, { public: msg.public, upToDate: msg.upToDate, busy: false });
        if (state === "signin") setSignInAsk({ kind: msg.kind || "publish", host: msg.host || "quire", folder });
        setFolderJobs((js) => {
          const { [folder]: cur, ...rest } = js;
          if (state === "publishing" || state === "unpublishing") return { ...rest, [folder]: { folder, kind: state === "unpublishing" ? "unpublish" : "publish", state } };
          if (state === "error")
            return { ...rest, [folder]: { folder, kind: cur?.kind || "publish", state, error: msg.error, output: msg.output, failed: msg.failed || [], code: msg.code || null, upgrade: !!msg.upgrade } };
          if (state === "done" && msg.public && cur?.kind !== "unpublish") return { ...rest, [folder]: { folder, kind: "publish", state, public: msg.public } };
          if (state === "done" && !msg.public && cur?.kind === "unpublish") return { ...rest, [folder]: { folder, kind: "unpublish", state: "gone" } };
          return rest;
        });
        return;
      }
      if (!msg || msg.path !== selectedRef.current) return;
      if (msg.state === "publishing" || msg.state === "unpublishing") setPub((p) => ({ ...(p || {}), path: msg.path, busy: true, state: msg.state }));
      else if (msg.state === "signin") {
        // The main process refused a Quire publish while signed out: ask here instead.
        setPub((p) => ({ ...(p || {}), busy: false, state: null }));
        setSignInAsk({ kind: msg.kind || "publish", host: msg.host || "quire" });
      } else if (msg.state === "error") {
        setPub((p) => ({ ...(p || {}), busy: false, state: "error", error: msg.error, output: msg.output, code: msg.code || null, upgrade: !!msg.upgrade }));
        setPubLogOpen(true);
      } else setPub({ public: msg.public, upToDate: msg.upToDate, busy: false });
    });
    on("onHostingChanged", () => setHostingVersion((v) => v + 1));
    on("onBuildStatus", (msg) => {
      if (!msg || typeof msg.path !== "string") return;
      setBuilds((b) => ({ ...b, [msg.path]: msg }));
      if (msg.state === "error" && msg.path === selectedRef.current) setBuildLogOpen(true);
      if (msg.state === "ok" && msg.path === selectedRef.current) setBuildLogOpen(false);
      if (msg.reload && msg.path === selectedRef.current) {
        pageSwap.swap();
        setPreviewKey((k) => k + 1);
      }
    });
    on("onPageFilesChanged", (path) => {
      const cur = selectedRef.current;
      if (cur && typeof path === "string" && (path === cur || path.startsWith(cur + "/"))) {
        pageSwap.swap();
        setPreviewKey((k) => k + 1);
        if (path === cur) setFilesTick((t) => t + 1);
      }
      refreshSoon();
    });
    // noteblock://open?path=… (main.mjs openLink): held until the vault and tree have loaded.
    on("onOpenPath", (path) => {
      if (embed || typeof path !== "string" || !path) return;
      pendingOpenRef.current = path;
      openPendingRef.current();
    });
    on("onMenu", (arg) => {
      const action = typeof arg === "string" ? arg : arg?.action || arg?.type;
      if (embed && EMBED_BLOCKED.has(action)) return;
      if (action === "new-page") startCreate("page", createIn());
      else if (action === "new-folder") startCreate("folder", createIn());
      else if (action === "new-from-template") setTemplateFor({ folder: createIn() });
      else if (action === "settings") setSettingsOpen(true);
      else if (action === "import") setSettingsOpen("import");
      else if (action === "import-obsidian") setSettingsOpen("import/obsidian");
      else if (action === "import-claude") setSettingsOpen("import/claude");
      else if (action === "trash") trashSelectedRef.current();
      else if (action === "backend") setBackendOpen((o) => !o);
      else if (action === "command-palette") setPaletteOpen((o) => !o);
      else if (action === "ai-bar") aiToggleRef.current();
      else if (action === "new-tab") newTabRef.current();
      else if (action === "close-tab") closeTabRef.current();
      else if (action === "find" || action === "find-next" || action === "find-previous") findActionRef.current(action);
      else if (action === "next-tab") cycleTabRef.current(1);
      else if (action === "prev-tab") cycleTabRef.current(-1);
      else if (action === "toggle-sidebar") setSidebarHidden((h) => !h);
      else if (action === "back") goVisitRef.current(-1);
      else if (action === "forward") goVisitRef.current(1);
      else if (/^tab-\d$/.test(action || "")) {
        const ts = tabsRef.current;
        const n = Number(action.slice(4));
        const tab = n === 9 ? ts[ts.length - 1] : ts[n - 1];
        if (tab) showTabRef.current(tab);
      }
      else if (action === "toggle-source") {
        // ⌘E steps through every renderer in RENDERER_LABELS order, then wraps.
        setOpenFile(null);
        setMode((m) => {
          const ids = Object.keys(RENDERER_LABELS);
          return ids[(ids.indexOf(m) + 1) % ids.length];
        });
      }
    });
    return () => offs.forEach((off) => off());
  }, [api, refreshTree, refreshSoon]);

  const newTabRef = useRef(newTab);
  newTabRef.current = newTab;
  const closeTabRef = useRef(closeTab);
  closeTabRef.current = closeTab;
  const cycleTabRef = useRef(cycleTab);
  cycleTabRef.current = cycleTab;
  const showTabRef = useRef(showTab);
  showTabRef.current = showTab;

  // ⌘F / ⌘G / ⇧⌘G: a code editor (Source + preview, a file) uses CodeMirror's own search; the
  // page itself gets the find bar (FindBar.jsx), which searches inside the page frame only.
  const findActionRef = useRef(null);
  findActionRef.current = (action) => {
    // Settings open: ⌘F (a menu accelerator, so it may never reach the dialog as a keydown) searches it.
    const settingsSearch = document.getElementById("settings-search");
    if (settingsSearch) {
      if (action === "find") settingsSearch.focus(), settingsSearch.select();
      return;
    }
    if (codeEditorFind(action, pageFrame.current ? null : contentEl.current)) return;
    const bar = findBar.current;
    if (!bar || !pageFrame.current) return;
    if (action === "find" || !bar.isOpen()) bar.open();
    else bar.step(action === "find-next" ? 1 : -1);
  };

  /* ---------------------------------------------------------------- selection */

  const select = useCallback((path) => {
    if (!path) return;
    setSelected(path);
    setOpenFile(null);
    setFolderFocus(null);
    // Make sure the row is visible.
    setExpanded((prev) => withAncestors(prev, path));
  }, []);

  // Every page a tab lands on is a visit, however it got there. Back and Forward move `at` first,
  // so they find themselves already there and add nothing.
  useEffect(() => {
    if (!state || !selected || !activeTab) return;
    setVisits((all) => {
      const h = all[activeTab];
      if (h && h.stack[h.at] === selected) return all;
      const stack = [...(h ? h.stack.slice(0, h.at + 1) : []), selected].slice(-100);
      return { ...all, [activeTab]: { stack, at: stack.length - 1 } };
    });
  }, [selected, activeTab, state]);

  const goVisit = (step) => {
    const h = visits[activeTabRef.current];
    const at = historyStep(h, step, treeRef.current);
    if (at < 0) return;
    setVisits((all) => ({ ...all, [activeTabRef.current]: { ...h, at } }));
    select(h.stack[at]);
  };
  const goVisitRef = useRef(goVisit);
  goVisitRef.current = goVisit;
  const canBack = useMemo(() => historyStep(visits[activeTab], -1, tree) >= 0, [visits, activeTab, tree]);
  const canForward = useMemo(() => historyStep(visits[activeTab], 1, tree) >= 0, [visits, activeTab, tree]);

  // The folder ⌘N, ⌃⌘N and the palette create in.
  const folderFocusRef = useRef(folderFocus);
  folderFocusRef.current = folderFocus;
  const createIn = useCallback(() => {
    const f = embed ? null : folderFocusRef.current;
    if (f === "" || (f && findNode(treeRef.current, f)?.kind === "folder")) return f;
    return parentPath(selectedRef.current || "");
  }, []);

  const selectFile = useCallback(
    (page, file) => {
      select(page);
      setOpenFile({ page, file });
    },
    [select],
  );

  const toggle = useCallback((path) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }, []);

  const expandTo = useCallback((folder) => {
    if (!folder) return;
    setExpanded((prev) => {
      const next = new Set(prev);
      const parts = folder.split("/");
      for (let i = 1; i <= parts.length; i++) next.add(parts.slice(0, i).join("/"));
      return next;
    });
  }, []);

  // Sidebar drag and drop. A move comes back through the "moved" event, like the assistant's.
  const onMoveInto = useCallback(
    async (from, folder, place) => {
      try {
        const m = await api.moveInto(from, folder, place);
        if (m) expandTo(folder);
        if (place) refreshTree(); // a new order is a dotfile change the "moved" event doesn't cover
      } catch (e) {
        window.alert(String(e?.message || e));
      }
    },
    [api, expandTo, refreshTree],
  );
  const onImportFiles = useCallback(
    async (sources, folder) => {
      try {
        const res = await api.importDropped(sources, folder);
        expandTo(res?.folder);
        refreshTree();
        if (res?.errors?.length) window.alert(res.errors.map((x) => x.error).join("\n"));
      } catch (e) {
        window.alert(String(e?.message || e));
      }
    },
    [api, expandTo, refreshTree],
  );

  // A crumb: open the folder and show it in the sidebar ("" is the vault root).
  const revealFolder = useCallback(
    (folder) => {
      expandTo(folder);
      setFolderFocus(folder);
      setFocusReveal((n) => n + 1);
      setSidebarHidden(false);
    },
    [expandTo],
  );
  // A deep link's path: a page opens; a folder is revealed and opens the page last viewed in it,
  // else its first page. An unknown path does nothing.
  const pendingOpenRef = useRef(null);
  const openPendingRef = useRef(null);
  const recentRef = useRef(recent);
  recentRef.current = recent;
  openPendingRef.current = () => {
    const path = pendingOpenRef.current;
    if (!path || !state || !treeLoaded) return;
    pendingOpenRef.current = null;
    const node = findNode(treeRef.current, path);
    if (!node) return;
    if (node.kind === "page") return select(path);
    if (node.kind !== "folder") return;
    expandTo(path);
    const last = recentRef.current.find((p) => p.startsWith(path + "/") && findPageNode(treeRef.current, p));
    const page = last || firstPage(node.children || [])?.path;
    if (page) select(page);
  };
  useEffect(() => {
    if (pendingOpenRef.current) openPendingRef.current();
  }, [tree, treeLoaded, state]);

  const seq = useRef(0);
  const startCreate = useCallback(
    (kind, parent, extra) => {
      // Embed mode: anything new lands in the folder (or a folder inside it), never above it.
      if (embed && parent !== embedFolder && !inEmbedFolder(parent)) parent = embedFolder;
      expandTo(parent);
      setCreating({ ...extra, kind, parent: parent || "", seq: ++seq.current });
    },
    [expandTo],
  );

  const onCreateSubmit = useCallback(
    async (kind, parent, name, here) => {
      const path = parent ? parent + "/" + name : name;
      if (kind === "template") {
        const node = await api.createFromTemplate(here.template, parent, name);
        setCreating(null);
        await refreshTree();
        select(node?.path || path);
      } else if (kind === "folder") {
        const node = await api.createFolder(path);
        setCreating(null);
        await refreshTree();
        expandTo(node?.path || path);
      } else {
        // One commit: the name field becomes the row and the page opens with it. The tree read
        // that follows only confirms it, and on a big vault it isn't quick.
        const node = await api.createPage(path, { format: "html" });
        setCreating(null);
        if (node) setTree((t) => withNewNode(t, parent, node));
        select(node?.path || path);
        refreshTree();
      }
    },
    [api, refreshTree, select, expandTo],
  );

  useEffect(() => {
    api.getShortcuts?.().then((list) => setShortcuts(list || []), () => {});
  }, [api]);
  const accel = (id) => shortcuts.find((s) => s.id === id)?.accelerator || undefined;

  /* ---------------------------------------------------------------- trash */

  useEffect(() => {
    api.getPrefs?.().then((p) => p && setPrefs(p), () => {});
  }, [api]);

  // Move a page, folder or file (vault-relative path) to the Trash, then select what's next.
  const doTrash = useCallback(
    async (ask) => {
      setTrashAsk((a) => (a ? { ...a, busy: true, error: "" } : a));
      const { target, pageFile } = ask;
      // The row after it (or before it) takes the selection, if it was selected.
      const list = flatten(embed ? findNode(tree, embedFolder)?.children || [] : tree).filter((n) => n.kind !== "folder");
      const gone = (p) => p === target || p.startsWith(target + "/");
      const at = list.findIndex((n) => gone(n.path));
      const next = (at < 0 ? [] : [...list.slice(at), ...list.slice(0, at).reverse()]).find((n) => !gone(n.path))?.path || null;
      try {
        await api.trash(target);
      } catch (e) {
        const error = String(e?.message || e);
        setTrashAsk((a) => (a ? { ...a, busy: false, error } : { ...ask, error }));
        return;
      }
      setTrashAsk(null);
      if (pageFile) setOpenFile(null);
      else if (selectedRef.current && gone(selectedRef.current)) setSelected(next);
      refreshTree();
      setFilesVersion((v) => v + 1);
    },
    [api, tree, refreshTree],
  );

  const requestTrash = useCallback(
    (ask) => {
      if (!ask || !ask.target) return;
      if (prefs.confirmDelete) setTrashAsk(ask);
      else doTrash(ask);
    },
    [prefs.confirmDelete, doTrash],
  );

  // What ⌘⌫ / File → Move to Trash acts on: the open file, else the selected page or file.
  const trashSelected = () => {
    if (!selected) return;
    const n = flatten(tree).find((x) => x.path === selected);
    if (!n) return;
    if (openFile && openFile.page === selected && n.kind === "page") {
      return requestTrash({ target: selected + "/" + openFile.file, name: openFile.file.split("/").pop(), what: "file", pageFile: true });
    }
    requestTrash({ target: n.path, name: n.title, what: n.kind });
  };
  const trashSelectedRef = useRef(trashSelected);
  trashSelectedRef.current = trashSelected;

  useEffect(() => {
    const onKey = (e) => {
      if (!(e.metaKey || e.ctrlKey) || e.key !== "Backspace" || e.shiftKey || e.altKey) return;
      const t = e.target;
      if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return; // deleting text
      if (document.querySelector(".settings-backdrop")) return;
      e.preventDefault();
      trashSelectedRef.current();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // A folder's publish job. The toast shows at once; publish-status events take it from there.
  const runFolderJob = useCallback(
    (folder, kind) => {
      setFolderJobs((js) => ({ ...js, [folder]: { folder, kind, state: kind === "unpublish" ? "unpublishing" : "publishing" } }));
      (kind === "unpublish" ? api.unpublishFolder(folder) : api.publishFolder(folder)).catch((e) => {
        setFolderJobs((js) => ({ ...js, [folder]: { folder, kind, state: "error", error: String(e?.message || e) } }));
      });
    },
    [api],
  );
  const startFolderJob = useCallback(
    (folder, kind) => {
      if (pubTargets?.quireSignedIn === false) return setSignInAsk({ kind, host: "quire", folder });
      runFolderJob(folder, kind);
    },
    [pubTargets, runFolderJob],
  );
  const closeFolderToast = useCallback((folder) => {
    setFolderJobs(({ [folder]: _gone, ...rest }) => rest);
  }, []);
  // Asked each time the menu opens, since it hashes the folder. A live folder that takes a while
  // still gets its menu: what the menu needs is whether it's live, and that rarely changes.
  const folderStatusForMenu = useCallback(
    (folder) => {
      const known = folderKnown.current;
      const fresh = api.folderPublishStatus(folder).then(
        (s) => {
          known.set(folder, s);
          return s;
        },
        () => known.get(folder) || null,
      );
      if (!known.has(folder)) return fresh;
      return Promise.race([fresh, new Promise((r) => setTimeout(() => r(known.get(folder)), 150))]);
    },
    [api],
  );

  // A plain file made a page. The new tree and the selection land together: the "remembered page
  // is gone" fallback must not see the page selected before the tree has it.
  const convertToPage = useCallback(
    async (path) => {
      try {
        const m = await api.convertToPage(path);
        const t = (await api.listTree()) || [];
        setTree(t);
        setLocks(collectLocks(t));
        select(m.to);
      } catch (e) {
        window.alert(String(e?.message || e));
      }
    },
    [api, select],
  );

  // Right-click: new page / folder in the folder that was clicked (or the clicked page's folder),
  // reveal, copy path, open in browser (pages), and Move to Trash. A page's own file (kind
  // "page-file") gets no New items.
  const onContextMenu = useCallback(
    async (e, node) => {
      e.preventDefault();
      const pageFile = node?.kind === "page-file";
      const folder = !node ? (embed ? embedFolder : "") : node.kind === "folder" ? node.path : parentPath(node.path);
      const folderPub = node?.kind === "folder" && api.folderPublishStatus ? (await folderStatusForMenu(node.path)) || { public: null } : null;
      if (embed) {
        // No Finder, templates or vault here: new items, the page in its own browser tab, Trash.
        const picked = await api
          .contextMenu([
            ...(pageFile
              ? []
              : [
                  { id: "new-page", label: "New page" },
                  { id: "new-folder", label: "New folder" },
                ]),
            ...(node?.kind === "page" ? [{ type: "separator" }, { id: "open-browser", label: "Open in new browser tab" }] : []),
            ...(node ? [{ type: "separator" }, { id: "trash", label: "Move to Trash" }] : []),
          ])
          .catch(() => null);
        if (picked === "new-page") startCreate("page", folder);
        else if (picked === "new-folder") startCreate("folder", folder);
        else if (picked === "open-browser") {
          // Opened before the call returns, or the browser blocks it as a popup.
          const tab = window.open("about:blank", "_blank");
          api.openInBrowser(node.path).then(
            (url) => (tab ? (tab.location.href = url || "/v/" + node.path + "/") : null),
            (err) => {
              tab?.close();
              window.alert(String(err?.message || err));
            },
          );
        } else if (picked === "trash") {
          requestTrash({ target: node.path, name: node.title, what: pageFile ? "file" : node.kind, pageFile: pageFile && node.page === selectedRef.current && openFile?.file === node.file });
        }
        return;
      }
      const items = [
        ...(pageFile
          ? []
          : [
              { id: "new-page", label: "New page", accelerator: accel("new-page") },
              { id: "new-from-template", label: "New from template…", accelerator: accel("new-from-template") },
              { id: "new-folder", label: "New folder", accelerator: accel("new-folder") },
              { type: "separator" },
            ]),
        ...(node && !pageFile ? [{ id: "rename", label: "Rename", accelerator: "F2" }] : []),
        ...(node?.kind === "file" && /\.(html?|md)$/i.test(node.path) ? [{ id: "convert-to-page", label: "Convert to page" }] : []),
        { id: "reveal", label: words.reveal },
        { id: "copy-path", label: "Copy path" },
        ...(node?.kind === "page" ? [{ id: "open-browser", label: "Open in browser" }] : []),
        ...(node?.kind === "page" || node?.kind === "folder"
          ? [
              node.searchExcludedBy && node.searchExcludedBy !== node.path
                ? { id: "search-inherited", label: `Excluded by ${node.searchExcludedBy}`, enabled: false }
                : { id: "search-toggle", label: node.searchExcluded ? "Include in search" : "Exclude from search" },
            ]
          : []),
        ...(!folderPub
          ? []
          : folderPub.busy
            ? [{ type: "separator" }, { id: "folder-busy", label: "Publishing…", enabled: false }]
            : folderPub.public
              ? [
                  { type: "separator" },
                  { id: "folder-copy", label: "Copy link" },
                  { id: "folder-open", label: "Open link" },
                  { id: "folder-publish", label: "Update published folder" },
                  { id: "folder-unpublish", label: "Unpublish folder" },
                ]
              : [{ type: "separator" }, { id: "folder-publish", label: "Publish folder" }]),
        ...(node ? [{ type: "separator" }, { id: "trash", label: words.moveToTrash, accelerator: "CmdOrCtrl+Backspace" }] : []),
      ];
      const picked = await api.contextMenu(items).catch(() => null);
      if (picked === "new-page") startCreate("page", folder);
      else if (picked === "new-folder") startCreate("folder", folder);
      else if (picked === "new-from-template") setTemplateFor({ folder });
      else if (picked === "rename") setRenaming(node.path);
      else if (picked === "convert-to-page") convertToPage(node.path);
      else if (picked === "reveal") api.reveal(node ? node.path : "");
      else if (picked === "copy-path") api.copyPath(node ? node.path : "").catch((err) => console.error("[quire] copy path failed", err));
      else if (picked === "open-browser") api.openInBrowser(node.path).catch((err) => window.alert(String(err?.message || err)));
      else if (picked === "folder-publish") startFolderJob(node.path, "publish");
      else if (picked === "folder-unpublish") setFolderUnpublish({ folder: node.path, name: node.title });
      else if (picked === "folder-copy") navigator.clipboard?.writeText(folderPub.public.url).catch(() => {});
      else if (picked === "folder-open") window.open(folderPub.public.url, "_blank");
      else if (picked === "search-toggle") api.setSearchExcluded(node.path, !node.searchExcluded).then(refreshTree, (err) => window.alert(String(err?.message || err)));
      else if (picked === "trash") {
        requestTrash({ target: node.path, name: node.title, what: pageFile ? "file" : node.kind, pageFile: pageFile && node.page === selectedRef.current && openFile?.file === node.file });
      }
    },
    [api, startCreate, shortcuts, requestTrash, openFile, folderStatusForMenu, startFolderJob, convertToPage], // eslint-disable-line react-hooks/exhaustive-deps
  );

  /* ---------------------------------------------------------------- Noteblock AI */

  // Jobs this window knows about (docs/ai.md): jobId → {jobId, seq, page, target ("chat" |
  // "block"), blockId, conversationId, prompt, state (working|ask|ready|applying|done|error|
  // stopped), progress, result, error}. Chat turns are drawn from the conversations (`chat`
  // events); jobs are for flush → apply → reload, the sidebar spinner and the /ai blocks.
  // aiMeta holds what event handlers need synchronously: {page, target, conversationId, mine
  // (started from this window), ready, applying}.
  const [aiJobs, setAiJobs] = useState({});
  const aiJobsRef = useRef(aiJobs);
  aiJobsRef.current = aiJobs;
  const aiMeta = useRef(new Map());
  const aiSeq = useRef(0);
  const [aiOpen, setAiOpen] = useState(false);
  const aiOpenRef = useRef(aiOpen);
  aiOpenRef.current = aiOpen;
  const [aiFocus, setAiFocus] = useState(0); // bumped on every open: focus the card, read ai.status() once
  const [aiDocked, setAiDocked] = useState(() => !!readLocal("quire:aiDocked", false));
  const [aiChats, setAiChats] = useState({}); // conversationId → conversation (no messages), from `chat` events
  const aiChatsRef = useRef(aiChats);
  aiChatsRef.current = aiChats;
  const [aiChatId, setAiChatId] = useState(null); // the open conversation, remembered per vault
  const aiChatIdRef = useRef(aiChatId);
  aiChatIdRef.current = aiChatId;
  const aiSaves = useRef(new Map()); // page → save RPCs from its frame still in flight
  const aiChanged = useRef(null); // {page, indexes, until}: blocks for the runtime to mark after the reload
  const frameLoaded = useRef(""); // selected + ":" + pageKey of the page frame that finished loading
  const frameKeyRef = useRef("");
  frameKeyRef.current = selected + ":" + pageKey;

  const aiMetaOf = (jobId) => {
    let m = aiMeta.current.get(jobId);
    if (!m) aiMeta.current.set(jobId, (m = { page: null, target: null, conversationId: null, mine: false, ready: false, applying: false }));
    return m;
  };
  const patchJob = useCallback((jobId, patch) => {
    const seq = ++aiSeq.current;
    setAiJobs((js) => {
      const cur = js[jobId] || { jobId, seq };
      return { ...js, [jobId]: { ...cur, ...(typeof patch === "function" ? patch(cur) : patch) } };
    });
  }, []);

  // The open conversation is remembered per vault, like the tabs.
  useEffect(() => {
    if (state) setAiChatId(readLocal(storeKey("aiChat"), null));
  }, [state?.vault]); // eslint-disable-line react-hooks/exhaustive-deps
  const pickAiChat = useCallback(
    (id) => {
      setAiChatId(id || null);
      writeLocal(storeKey("aiChat"), id || null);
    },
    [state?.vault], // eslint-disable-line react-hooks/exhaustive-deps
  );
  // A remembered or picked conversation this window has no copy of yet: read it once.
  useEffect(() => {
    if (!aiChatId || aiChatsRef.current[aiChatId] || !api.ai?.chat) return;
    let alive = true;
    api.ai.chat(aiChatId).then(
      (c) => {
        if (!alive) return;
        if (c && c.id) setAiChats((cs) => (cs[c.id] ? cs : { ...cs, [c.id]: c }));
        else if (aiChatIdRef.current === aiChatId) pickAiChat(null);
      },
      () => {},
    );
    return () => {
      alive = false;
    };
  }, [api, aiChatId, pickAiChat]);

  const postFrame = (msg) => {
    try {
      pageFrame.current?.contentWindow?.postMessage(msg, "*");
    } catch {
      /* frame gone */
    }
  };

  // After apply or undo: reload the page on screen, and mark the changed blocks once it loads.
  const aiReload = useCallback((page, indexes) => {
    if (!page || page !== selectedRef.current) return;
    aiChanged.current = Array.isArray(indexes) && indexes.length ? { page, indexes, until: Date.now() + 2500 } : null;
    pageSwap.swap();
    setPreviewKey((k) => k + 1);
    setFilesTick((t) => t + 1);
  }, []);

  // Did a chat turn touch `page` (its files, or the page itself)? From apply's `applied` when
  // it names files, and the turn's `changes` (their `page`). A bare count can't say: yes.
  const aiTouches = (page, result, jobId, conversationId) => {
    if (!page) return false;
    const under = (p) => typeof p === "string" && (p === page || p.startsWith(page + "/"));
    const applied = result?.applied;
    let unknown = typeof applied === "number" && applied > 0;
    if (Array.isArray(applied)) {
      for (const a of applied) {
        if (typeof a === "string") {
          if (under(a)) return true;
        } else if (a && typeof a === "object") {
          if (under(a.page) || under(a.path) || under(a.file)) return true;
          if (a.page == null && a.path == null) unknown = true;
        }
      }
    }
    const convs = conversationId ? [aiChatsRef.current[conversationId]] : Object.values(aiChatsRef.current);
    for (const c of convs) {
      const turn = (c?.turns || []).find((t) => t.jobId === jobId);
      if (turn && (turn.changes || []).some((ch) => under(ch.page))) return true;
    }
    return unknown;
  };

  // `ready`: flush the page's pending save first, then apply. A block job flushes its own page
  // when it is on screen; a chat job flushes whatever page is on screen, always.
  const aiApply = useCallback(
    async (jobId) => {
      const m = aiMetaOf(jobId);
      if (m.applying) return;
      m.applying = true;
      m.ready = false;
      patchJob(jobId, { state: "applying" });
      const page = m.page;
      const chat = m.target === "chat";
      const sel = selectedRef.current;
      try {
        if (sel && (chat || page === sel) && pageFrame.current && frameLoaded.current === frameKeyRef.current) {
          postFrame({ quire: 1, type: "save" });
          const t0 = Date.now();
          await sleep(250);
          while ((aiSaves.current.get(sel) || 0) > 0 && Date.now() - t0 < 3000) await sleep(50);
        }
        const result = (await api.ai.apply(jobId)) || {};
        patchJob(jobId, (cur) => ({ state: "done", result: { ...(cur.result || {}), ...result } }));
        if (chat) {
          const now = selectedRef.current;
          if (aiTouches(now, result, jobId, m.conversationId)) aiReload(now, page === now ? result.changed : null);
          refreshSoon();
        } else if (aiCount(result.applied) > 0) aiReload(page, result.changed);
      } catch (e) {
        patchJob(jobId, { state: "error", error: { code: "failed", message: cleanError(e) || "The changes didn't apply" } });
      } finally {
        m.applying = false;
      }
    },
    [api, patchJob, aiReload, refreshSoon], // eslint-disable-line react-hooks/exhaustive-deps
  );
  const aiMaybeApply = (jobId) => {
    const m = aiMetaOf(jobId);
    if (m.mine && m.ready && !m.applying && api.ai?.apply) aiApply(jobId);
  };

  // target "chat": {prompt, page (context or null), conversationId (none = a new one)};
  // target "block": {page, prompt, blockId}. Resolves to start's reply.
  const aiStart = useCallback(
    async ({ target, page = null, prompt, blockId = null, conversationId = null }) => {
      if (!api.ai?.start) throw new Error("Noteblock AI isn't in this build of the app");
      const chat = target === "chat";
      const res = await api.ai.start(
        chat ? { target: "chat", prompt, ...(conversationId ? { conversationId } : {}), ...(page ? { page } : {}) } : { target: "block", page, prompt, blockId },
      );
      const jobId = res?.jobId;
      const refused = res?.error ? Object.assign(new Error(res.error.message || ""), { code: res.error.code || "failed" }) : null;
      if (!jobId) throw refused || new Error("Noteblock AI didn't start");
      const m = aiMetaOf(jobId);
      m.mine = true;
      m.page = page;
      m.target = chat ? "chat" : "block";
      m.conversationId = res.conversationId || conversationId || null;
      patchJob(jobId, (cur) => ({ page, prompt, target: m.target, blockId, conversationId: m.conversationId, state: cur.state || "working" }));
      // A refused start (signed out, locked…) can still return a jobId, with the reason beside it.
      if (refused) {
        patchJob(jobId, { state: "error", error: { code: refused.code, message: refused.message } });
        if (chat && !res.conversationId) throw refused;
      }
      aiMaybeApply(jobId); // `ready` can beat start's reply
      return res;
    },
    [api, patchJob], // eslint-disable-line react-hooks/exhaustive-deps
  );

  // F2 renames the selected row. Inside a page the key never gets here: a page keeps its own keys.
  const renameSelectedRef = useRef(null);
  renameSelectedRef.current = () => {
    if (sidebarHidden) return;
    const focused = folderFocus ? findNode(tree, folderFocus) : null;
    const target = focused?.kind === "folder" ? focused : openFile && openFile.page === selected ? null : findNode(tree, selected);
    if (target) setRenaming(target.path);
  };
  useEffect(() => {
    const onKey = (e) => {
      if (e.key !== "F2" || e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return;
      const t = e.target;
      if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;
      if (document.querySelector(".settings-backdrop")) return;
      e.preventDefault();
      renameSelectedRef.current();
    };
    window.addEventListener("keydown", onKey);
    window.__quireStartRename = (path) => {
      setRenaming(path);
      return true;
    };
    return () => {
      window.removeEventListener("keydown", onKey);
      delete window.__quireStartRename;
    };
  }, []);

  // A successful rename comes back through the "moved" event, which also closes the field,
  // together with the new tree so the old name never flashes.
  const onRenameSubmit = useCallback(
    async (path, name) => {
      // The rename can change the page's header in its file: the typing on screen goes in first.
      if (path === selectedRef.current && pageFrame.current) {
        pageFrame.current.contentWindow?.postMessage({ quire: 1, type: "save" }, "*");
        const t0 = Date.now();
        await sleep(60);
        while ((aiSaves.current.get(path) || 0) > 0 && Date.now() - t0 < 3000) await sleep(50);
      }
      const mine = { from: path, header: false };
      setMoving(mine);
      try {
        if (!(await api.rename(path, name))) setRenaming(null);
      } finally {
        if (moving.current === mine) {
          setMoving(null);
          refreshSoon();
        }
      }
    },
    [api, refreshSoon, setMoving],
  );
  const onRenameCancel = useCallback(() => setRenaming(null), []);

  // `moved`: a page or folder moved (the assistant's move_page). Carry the selection, tabs,
  // open file, recent list and expanded folders over to the new paths, with the new tree in
  // the same update so the "remembered page is gone" fallback never sees the gap.
  const aiMoved = async (from, to) => {
    if (typeof from !== "string" || typeof to !== "string" || !from || from === to) return;
    const remap = (p) => (typeof p === "string" && (p === from || p.startsWith(from + "/")) ? to + p.slice(from.length) : p);
    let t = null;
    try {
      t = (await api.listTree()) || null;
    } catch {
      t = null;
    }
    if (t) {
      setTree(t);
      setLocks(collectLocks(t));
    }
    setRenaming((r) => (r === from ? null : remap(r)));
    setSelected((s) => remap(s));
    setFolderFocus((f) => remap(f));
    setVisits((all) => Object.fromEntries(Object.entries(all).map(([id, h]) => [id, { ...h, stack: h.stack.map(remap) }])));
    setTabs((ts) => ts.map((tab) => (tab.path && remap(tab.path) !== tab.path ? { ...tab, path: remap(tab.path) } : tab)));
    setOpenFile((f) => (f && remap(f.page) !== f.page ? { ...f, page: remap(f.page) } : f));
    setRecent((r) => r.map(remap));
    // The page's own header renamed it: its frame stays up, with the typing and caret in it.
    const mine = moving.current;
    if (mine?.from === from) {
      if (mine.header && selectedRef.current === from) {
        pageSwap.follow(to);
        if (frameLoaded.current === frameKeyRef.current) frameLoaded.current = to + ":" + frameKeyRef.current.slice(from.length + 1);
      }
      setMoving(null);
      mine.followed?.();
    }
    // …and open the folders the selected page now sits in, so the sidebar shows where it went.
    const sel = remap(selectedRef.current);
    const shown = sel && sel !== selectedRef.current ? sel.split("/").slice(0, -1).map((_, i, segs) => segs.slice(0, i + 1).join("/")) : [];
    setExpanded((prev) => new Set([...[...prev].map((k) => (k.startsWith("files:") ? "files:" + remap(k.slice(6)) : remap(k))), ...shown]));
    for (const m of aiMeta.current.values()) m.page = remap(m.page);
    refreshSoon();
  };

  const aiEventRef = useRef(null);
  aiEventRef.current = (ev) => {
    if (!ev || !ev.type) return;
    const { jobId, type } = ev;
    if (type === "chat") {
      const c = ev.conversation;
      const id = ev.conversationId || c?.id;
      if (!id || !c) return;
      setAiChats((cs) => ({ ...cs, [id]: c }));
      // A turn this window started stopped to ask: bring the card back to show the question.
      const turns = Array.isArray(c.turns) ? c.turns : [];
      const last = turns[turns.length - 1];
      if (last?.state === "ask" && last.jobId && aiMeta.current.get(last.jobId)?.mine && (!aiOpenRef.current || aiChatIdRef.current !== id)) {
        pickAiChat(id);
        if (!aiOpenRef.current) {
          setAiOpen(true);
          setAiFocus((f) => f + 1);
        }
      }
      return;
    }
    if (type === "moved") {
      aiMoved(ev.from, ev.to);
      return;
    }
    if (type === "settings") {
      // Changed through the same code as Settings: re-read what this window caches.
      api.getPrefs?.().then((p) => p && setPrefs(p), () => {});
      api.getShortcuts?.().then((list) => setShortcuts(list || []), () => {});
      return;
    }
    if (!jobId) return;
    const m = aiMetaOf(jobId);
    if (type === "open") {
      // The AI opened a page: only the window that asked follows it.
      if (!m.mine || typeof ev.page !== "string") return;
      if (ev.newTab) newTabRef.current(ev.page);
      else select(ev.page);
      return;
    }
    if (ev.page) m.page = ev.page;
    if (ev.target) m.target = ev.target === "chat" ? "chat" : "block";
    if (ev.conversationId) m.conversationId = ev.conversationId;
    const base = {};
    for (const k of ["page", "blockId", "prompt", "conversationId"]) if (ev[k] !== undefined) base[k] = ev[k];
    if (m.target) base.target = m.target;
    if (type === "progress") {
      patchJob(jobId, (cur) => ({ ...base, state: cur.state === "ready" || cur.state === "applying" ? cur.state : "working", ask: null, progress: ev.text || cur.progress }));
    } else if (type === "ask") {
      patchJob(jobId, { ...base, state: "ask", ask: { askId: ev.askId, title: ev.title, detail: ev.detail, permission: ev.permission } });
    } else if (type === "ready") {
      m.ready = true;
      patchJob(jobId, { ...base, state: "ready", summary: ev.summary });
      aiMaybeApply(jobId);
    } else if (type === "done") {
      m.ready = false;
      const result = {};
      for (const k of ["summary", "applied", "skipped", "changed"]) if (ev[k] !== undefined) result[k] = ev[k];
      patchJob(jobId, (cur) => ({ ...base, state: "done", result: { ...(cur.result || {}), ...result } }));
      // Another window applied it: this one still shows the page as it is now.
      if (!m.mine) {
        const now = selectedRef.current;
        if (m.target === "chat") {
          if (aiTouches(now, result, jobId, m.conversationId)) aiReload(now, ev.page === now ? ev.changed : null);
        } else if (ev.page === now && aiCount(ev.applied) > 0) aiReload(ev.page, ev.changed);
      }
    } else if (type === "error") {
      m.ready = false;
      patchJob(jobId, { ...base, state: "error", error: { code: ev.code || "failed", message: ev.message || "" } });
    } else if (type === "stopped") {
      m.ready = false;
      patchJob(jobId, { ...base, state: "stopped" });
    }
    // /ai block events go on to the page frame that draws the marker; chat events never do.
    if (AI_FORWARD.has(type) && m.target !== "chat" && ev.page && ev.page === selectedRef.current) {
      postFrame({ quire: 1, type: "ai", event: ev });
      pageSwap.bufferWindow()?.postMessage({ quire: 1, type: "ai", event: ev }, "*");
    }
  };

  useEffect(() => {
    if (typeof api.onAiEvent !== "function") return undefined;
    const off = api.onAiEvent((ev) => aiEventRef.current?.(ev));
    return typeof off === "function" ? off : undefined;
  }, [api]);

  // Jobs still running from before this window (re)loaded. One call, not a poll.
  useEffect(() => {
    api.ai?.jobs?.().then(
      (list) => {
        for (const j of Array.isArray(list) ? list : []) {
          if (!j?.jobId || !AI_RUNNING.has(j.state || "working")) continue;
          const m = aiMetaOf(j.jobId);
          m.mine = true; // assumption: the window that started it is gone or is this one
          m.page = j.page ?? null;
          m.target = j.target === "chat" ? "chat" : "block";
          m.conversationId = j.conversationId ?? null;
          const state = j.state === "ready" ? "ready" : "working";
          patchJob(j.jobId, (cur) => ({ page: m.page, target: m.target, blockId: j.blockId ?? null, conversationId: m.conversationId, prompt: j.prompt, state: cur.state || state }));
          if (state === "ready") {
            m.ready = true;
            aiMaybeApply(j.jobId);
          }
        }
      },
      () => {},
    );
  }, [api]); // eslint-disable-line react-hooks/exhaustive-deps

  // Page-frame RPCs for /ai blocks (runtime.js), answered here like `navigate`. Every frame job
  // is a block job now; an old `newpage` marker is treated as `block`.
  const aiFindBlockJob = async (page, blockId) => {
    let list = null;
    try {
      list = await api.ai?.jobs?.();
    } catch {
      list = null;
    }
    if (Array.isArray(list)) return list.find((j) => j.page === page && j.blockId === blockId && AI_RUNNING.has(j.state || "working")) || null;
    return Object.values(aiJobsRef.current).find((j) => j.page === page && j.blockId === blockId && AI_RUNNING.has(j.state)) || null;
  };
  const aiRpcRef = useRef(null);
  aiRpcRef.current = async (method, params, fromPage) => {
    if (!fromPage) throw new Error("Unknown page");
    if (!api.ai) throw new Error("Noteblock AI isn't in this build of the app");
    if (method === "ai.start") {
      const res = await aiStart({ target: "block", page: fromPage, prompt: String(params.prompt || ""), blockId: params.blockId || null });
      return { jobId: res.jobId };
    }
    const job = await aiFindBlockJob(fromPage, params.blockId);
    if (method === "ai.status") return { running: !!job };
    if (job) await api.ai.stop?.(job.jobId);
    return null;
  };

  // The sidebar spinner is for /ai block jobs; a chat turn shows its work in the card.
  const aiBusy = useMemo(
    () => new Set(Object.values(aiJobs).filter((j) => j.page && j.target !== "chat" && AI_RUNNING.has(j.state)).map((j) => j.page)),
    [aiJobs],
  );

  const focusPage = () => {
    try {
      pageFrame.current?.focus();
      pageFrame.current?.contentWindow?.focus();
    } catch {
      /* frame gone */
    }
  };
  const closeAi = useCallback(() => {
    setAiOpen(false);
    focusPage();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  // ⌘J (menu action `ai-bar`) toggles the card anywhere in the app, page or not.
  const aiToggleRef = useRef(null);
  aiToggleRef.current = () => {
    if (!api.ai || embed) return;
    if (aiOpenRef.current) return closeAi();
    setAiOpen(true);
    setAiFocus((f) => f + 1);
  };
  const aiToggleDock = useCallback(() => {
    setAiDocked((d) => {
      writeLocal("quire:aiDocked", !d);
      return !d;
    });
    setAiFocus((f) => f + 1);
  }, []);

  const aiSend = useCallback(
    async (prompt, page) => {
      const res = await aiStart({ target: "chat", prompt, page: page || null, conversationId: aiChatIdRef.current });
      if (res?.conversationId && res.conversationId !== aiChatIdRef.current) pickAiChat(res.conversationId);
      return res;
    },
    [aiStart, pickAiChat],
  );
  const aiStopTurn = useCallback((turn) => turn?.jobId && api.ai?.stop?.(turn.jobId)?.catch?.(() => {}), [api]);
  const aiAnswerTurn = useCallback(
    (turn, allow) => {
      if (!turn?.jobId || !turn.ask) return;
      api.ai?.answer?.(turn.jobId, turn.ask.askId, !!allow, false)?.catch?.(() => {});
    },
    [api],
  );
  const aiUndoTurn = useCallback(
    async (turn) => {
      const res = (await api.ai.undo(turn.jobId)) || {};
      const now = selectedRef.current;
      const m = aiMeta.current.get(turn.jobId);
      if (aiTouches(now, { applied: res.restored }, turn.jobId, m?.conversationId)) aiReload(now, []);
      refreshSoon();
      return res;
    },
    [api, aiReload, refreshSoon], // eslint-disable-line react-hooks/exhaustive-deps
  );

  // An Open link in a turn: a page opens as itself, a path inside a page opens that page's file.
  const aiOpenPage = useCallback(
    (p) => {
      if (typeof p !== "string" || !p) return;
      const nodes = flatten(treeRef.current);
      if (nodes.some((n) => n.path === p)) return select(p);
      const host = nodes.filter((n) => n.kind === "page" && p.startsWith(n.path + "/")).sort((x, y) => y.path.length - x.path.length)[0];
      if (host) selectFile(host.path, p.slice(host.path.length + 1));
      else select(p);
    },
    [select, selectFile],
  );

  /* ---------------------------------------------------------------- bridge */

  const lockedRef = useRef(locked);
  lockedRef.current = locked;

  // Web host: the page a message came from. The page frame (or the source preview) shows the
  // selected page; an embed inside it is found from its /v/<path>/ location.
  const pageOfSource = (win) => {
    if (!win) return null;
    if (win === pageFrame.current?.contentWindow || win === previewFrame.current?.contentWindow) return selectedRef.current;
    return pageOfWindow(treeRef.current, win);
  };

  useEffect(() => {
    const post = (win, msg) => {
      try {
        win?.postMessage(msg, "*");
      } catch {
        /* frame gone */
      }
    };
    /**
     * Did the person just click or type inside the frame `source` belongs to? Chromium gives this
     * window transient user activation (about 5 s) when a frame inside it gets a real click or
     * key press, and the page can't fake that. The focused element saying it was that frame (or
     * one holding it, for an embed) ties the gesture to it rather than to the app's own UI.
     */
    const gestureIn = (source) => {
      if (!navigator.userActivation?.isActive) return false;
      const active = document.activeElement;
      if (!active || active.tagName !== "IFRAME" || !active.contentWindow) return false;
      let w = source;
      for (let i = 0; w && i < 16; i++) {
        if (w === active.contentWindow) return true;
        if (w.parent === w || w.parent === window) return false;
        w = w.parent;
      }
      return false;
    };
    const onMessage = async (event) => {
      const msg = event.data;
      if (!msg || typeof msg !== "object" || msg.quire !== 1) return;
      // Which page sent it comes from the frame's origin (quire://p-<id>), never from the message.
      // On the web host every page shares one origin: the sending window says instead.
      const fromPage = isWeb ? pageOfSource(event.source) : pageOfOrigin(treeRef.current, event.origin);
      if (msg.type === "dirty") {
        if (fromPage && fromPage === selectedRef.current && !pageSwap.isBuffer(event.source)) setPageDirty(!!msg.dirty);
        return;
      }
      if (msg.type === "page-error") {
        if (!fromPage) return;
        setPageErrors((list) => addPageError(list, fromPage, msg.error));
        api.limits?.().then((l) => setErrorBadge(!!l.errorBadge), () => {});
        return;
      }
      if (msg.type === "embed-kill") {
        // An embed's Reload (runtime.js): end its hung process, never the page holding it.
        const cur = selectedRef.current;
        if (typeof msg.page === "string" && cur && fromPage) api.killPageProcess?.(pageSrcIn(treeRef.current, msg.page), { keep: pageSrcIn(treeRef.current, fromPage) }).catch(() => {});
        return;
      }
      if (msg.type === "header-rename") {
        // The caret left the page's header with a new name in it (runtime.js headerLeft). Refusals
        // are logged and nothing else: the header stays as typed.
        const source = event.source;
        const from = selectedRef.current;
        const answer = (result) => post(source, { quire: 1, type: "header-rename-result", ...result });
        const skip = (why) => {
          console.info(`[noteblock] header rename skipped: ${why}`);
          answer({ ok: false });
        };
        if (!api.rename || !from || !source || source !== pageFrame.current?.contentWindow || fromPage !== from) return skip("not the page on screen");
        if (lockedRef.current || pageBuildRef.current || modeRef.current !== "quire") return skip("the page isn't being edited here");
        const mine = { from, header: true };
        try {
          const followed = new Promise((resolve) => {
            mine.followed = resolve;
          });
          setMoving(mine);
          const m = await api.rename(from, String(msg.name || ""));
          if (!m) return answer({ ok: true });
          await Promise.race([followed, sleep(2000)]);
          answer({ ok: true, path: m.to });
          // Rewriting links changed this page's own file: the frame has to pick that up.
          if ((m.relinked || []).some((f) => f.startsWith(m.to + "/"))) setTimeout(() => pageSwap.swap(), 50);
        } catch (e) {
          skip(cleanError(e));
        } finally {
          if (moving.current === mine) {
            setMoving(null);
            refreshSoon();
          }
        }
        return;
      }
      if (msg.type !== "rpc") return;
      const source = event.source;
      if (!source) return;
      const { id, method } = msg;
      const params = msg.params || {};
      if (method === "navigate") {
        // A page or plain file opens as itself; a path inside a page opens that page's file.
        const p = typeof params.page === "string" ? params.page : "";
        const nodes = flatten(treeRef.current);
        if (!p || nodes.some((n) => n.path === p)) select(p || null);
        else {
          const host = nodes.filter((n) => n.kind === "page" && p.startsWith(n.path + "/")).sort((x, y) => y.path.length - x.path.length)[0];
          if (host) selectFile(host.path, p.slice(host.path.length + 1));
          else select(p);
        }
        post(source, { quire: 1, type: "rpc-result", id, result: null });
        return;
      }
      if (method === "ai.start") {
        // A page can start Noteblock AI only right after the person clicked or typed in it, and
        // never in restricted mode.
        const why = trustRef.current !== "trusted" ? "Restricted mode. Pages can't start Noteblock AI." : !gestureIn(source) ? "Noteblock AI starts from a click or key press in the page" : null;
        if (why) {
          post(source, { quire: 1, type: "rpc-result", id, error: why });
          return;
        }
      }
      if (method === "ai.start" || method === "ai.stop" || method === "ai.status") {
        try {
          const result = await aiRpcRef.current(method, params, fromPage);
          post(source, { quire: 1, type: "rpc-result", id, result: result === undefined ? null : result });
        } catch (e) {
          post(source, { quire: 1, type: "rpc-result", id, error: cleanError(e) });
        }
        return;
      }
      // Saves in flight per page: Noteblock AI waits for them before it applies (aiApply).
      const isSave = method === "save" && !!fromPage;
      if (isSave) aiSaves.current.set(fromPage, (aiSaves.current.get(fromPage) || 0) + 1);
      try {
        // The web bridge sends [origin, method, params, page]; the preload ignores the 4th.
        const result = await api.rpc(event.origin, method, params, fromPage);
        post(source, { quire: 1, type: "rpc-result", id, result: result === undefined ? null : result });
        if (WRITE_METHODS.has(method)) {
          const changed = { quire: 1, type: "store-changed", page: fromPage, table: params.table ?? null };
          post(pageFrame.current?.contentWindow, changed);
          post(previewFrame.current?.contentWindow, changed);
          post(pageSwap.bufferWindow(), changed);
        }
      } catch (e) {
        post(source, { quire: 1, type: "rpc-result", id, error: String(e?.message ?? e) });
      } finally {
        if (isSave) {
          const n = (aiSaves.current.get(fromPage) || 1) - 1;
          if (n > 0) aiSaves.current.set(fromPage, n);
          else aiSaves.current.delete(fromPage);
        }
      }
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [api, select, selectFile]);

  const pageBuildRef = useRef(false);
  const modeRef = useRef(mode);
  modeRef.current = mode;

  const onPageLoad = useCallback(() => {
    findBar.current?.refresh();
    const l = lockedRef.current;
    const edit = !l && modeRef.current === "quire";
    try {
      pageFrame.current?.contentWindow?.postMessage({ quire: 1, type: "mode", edit, readOnly: l || !edit, manualSave: !!pageBuildRef.current }, "*");
    } catch {
      /* frame gone */
    }
  }, []);

  // The page frame itself finished loading: remember which load it was (aiApply flushes only a
  // loaded frame), and mark the blocks Noteblock AI just changed.
  const onFrameLoad = useCallback(() => {
    frameLoaded.current = frameKeyRef.current;
    onPageLoad();
    const c = aiChanged.current;
    if (c && c.page === selectedRef.current && Date.now() < c.until) {
      try {
        pageFrame.current?.contentWindow?.postMessage({ quire: 1, type: "ai-changed", indexes: c.indexes }, "*");
      } catch {
        /* frame gone */
      }
    }
  }, [onPageLoad]);

  // Page reloads from a change to its files keep the old frame up until the new one is ready.
  const pageSwap = usePageSwap({
    frameRef: pageFrame,
    owner: selected,
    active: mode !== "source",
    pageKey,
    setPageKey,
    canBuffer: () => !pageBuildRef.current,
    onBufferLoad: (win) => {
      const l = lockedRef.current;
      const edit = !l && modeRef.current === "quire";
      try {
        win?.postMessage({ quire: 1, type: "mode", edit, readOnly: l || !edit, manualSave: !!pageBuildRef.current }, "*");
      } catch {
        /* frame gone */
      }
    },
    onVisibleLoad: onFrameLoad,
  });

  const onPreviewLoad = useCallback(() => {
    const l = lockedRef.current;
    try {
      previewFrame.current?.contentWindow?.postMessage({ quire: 1, type: "mode", edit: false, readOnly: l }, "*");
    } catch {
      /* frame gone */
    }
  }, []);

  // Lock state changed while the frame stays put: tell it right away (reload follows).
  useEffect(() => {
    onPageLoad();
  }, [locked, mode, onPageLoad]);

  /* ---------------------------------------------------------------- recovery */

  // Errors belong to one load of the page: a reload or another page starts a clean list.
  useEffect(() => {
    setPageErrors([]);
    setErrorsOpen(false);
  }, [selected, pageSwap.loadKey]);

  /* ---------------------------------------------------------------- mode */

  const prevMode = useRef(mode);
  useEffect(() => {
    if (prevMode.current === "source" && mode !== "source") setPageKey((k) => k + 1);
    if (mode !== "source") setSaveStatus(null);
    prevMode.current = mode;
  }, [mode]);

  // Opening a page shows it in its own renderer (`renderer` in its .noteblock, default Quire's editor).
  const pageNode = findPageNode(tree, selected);
  const homeRenderer = pageNode?.renderer || "quire";
  pageBuildRef.current = !!pageNode?.build;
  const rendererFor = useRef(null);
  useEffect(() => {
    if (!selected || !treeLoaded || rendererFor.current === selected) return;
    rendererFor.current = selected;
    setMode(homeRenderer);
  }, [selected, treeLoaded, homeRenderer]);

  const pickRenderer = useCallback(async () => {
    if (!selected) return;
    const items = [
      ...Object.entries(RENDERER_LABELS).map(([id, label]) => ({ id, label, type: "radio", checked: !(openFile && openFile.page === selected) && mode === id })),
      { type: "separator" },
      { id: "default", label: `Open this page in ${RENDERER_LABELS[mode]} by default`, type: "checkbox", checked: homeRenderer === mode, enabled: homeRenderer !== mode },
    ];
    if (pageNode?.build) items.push({ type: "separator" }, { id: "build", label: "Rebuild page" });
    items.push({ type: "separator" }, { id: "inspect", label: "Inspect page", accelerator: accel("developer-tools") });
    const picked = await api.contextMenu(items).catch(() => null);
    if (!picked) return;
    if (picked === "build") return api.buildPage(selected).catch(() => {});
    if (picked === "inspect") return api.inspectPage?.(selected).catch(() => {});
    if (picked === "default") {
      await api.setRenderer(selected, mode).catch(() => {});
      return refreshTree();
    }
    setOpenFile(null);
    setMode(picked);
  }, [api, selected, mode, homeRenderer, pageNode, refreshTree, openFile, shortcuts]); // eslint-disable-line react-hooks/exhaustive-deps

  const onSaved = useCallback(() => {
    setPreviewKey((k) => k + 1);
    setPageKey((k) => k + 1);
  }, []);

  // A file saved from the sidebar editor: main skips its own writes in the watcher, so
  // refresh what depends on it here (.noteblock, or an older .quire, changes the title, entry and format).
  const onFileSaved = useCallback(
    (file) => {
      onSaved();
      setFilesVersion((v) => v + 1);
      if (file === ".noteblock" || file === ".quire") refreshTree();
    },
    [onSaved, refreshTree],
  );

  useEffect(() => {
    if (!showFiles) setOpenFile(null);
  }, [showFiles]);
  useEffect(() => {
    if (openFile || mode !== "source") setSaveStatus(null);
  }, [openFile]); // eslint-disable-line react-hooks/exhaustive-deps

  /* Vault trust (app/main/trust.mjs): the prompt, the restricted bar's button, a new command. */
  const answerTrust = useCallback(
    async (choice) => {
      setTrustBusy(true);
      try {
        const trust = await api.setVaultTrust(choice);
        setState((s) => (s ? { ...s, trust } : s));
      } catch (e) {
        console.error("[noteblock] trust:", e);
      } finally {
        setTrustBusy(false);
      }
    },
    [api],
  );
  const answerCommand = useCallback(
    async (page, run) => {
      setCmdAsks((list) => list.filter((r) => r.page !== page));
      try {
        await api.answerCommands(page, run);
      } catch (e) {
        console.error("[noteblock] command answer:", e);
      }
    },
    [api],
  );

  // Renamed or moved vault: carry this window's remembered selection over to the new path.
  const onVaultChanged = useCallback(
    (next) => {
      const from = "quire:" + (state?.vault || "") + ":";
      const to = "quire:" + (next?.vault || "") + ":";
      if (from !== to) {
        for (const k of ["selected", "expanded", "showFiles", "sidebarHidden"]) {
          const v = readLocal(from + k, undefined);
          if (v !== undefined) writeLocal(to + k, v);
        }
      }
      setState((s) => ({ ...s, ...next }));
      refreshTree();
    },
    [state, refreshTree],
  );

  /* ---------------------------------------------------------------- palette */

  // A plain file sitting in a folder opens in the file view, like a page's own file.
  const selNode = useMemo(() => (selected ? flatten(tree).find((n) => n.path === selected) || null : null), [tree, selected]);
  const looseFile = selNode?.kind === "file";
  const fileOpen = looseFile ? selNode.title : openFile && openFile.page === selected ? openFile.file : null;
  const fileHost = looseFile ? parentPath(selected) : selected;

  useEffect(() => {
    if (!paletteOpen) return;
    api.vaultInfo?.().then((info) => setOtherVaults((info?.vaults || []).filter((v) => !v.current && !v.missing)), () => {});
  }, [api, paletteOpen]);

  const openFileFromPalette = useCallback(
    (page, file) => {
      setShowFiles(true);
      setExpanded((prev) => {
        const next = new Set(prev);
        next.add("files:" + page);
        const segs = file.split("/");
        for (let i = 1; i < segs.length; i++) next.add("files:" + page + "/" + segs.slice(0, i).join("/"));
        return next;
      });
      selectFile(page, file);
    },
    [selectFile],
  );

  const commands = useMemo(() => {
    const list = [
      { id: "new-page", label: "New page", accelerator: accel("new-page"), run: () => startCreate("page", createIn()) },
      { id: "new-from-template", label: "New page from template…", accelerator: accel("new-from-template"), run: () => setTemplateFor({ folder: createIn() }) },
      { id: "new-folder", label: "New folder", accelerator: accel("new-folder"), run: () => startCreate("folder", createIn()) },
      ...(canBack ? [{ id: "back", label: "Go back", accelerator: accel("back"), run: () => goVisitRef.current(-1) }] : []),
      ...(canForward ? [{ id: "forward", label: "Go forward", accelerator: accel("forward"), run: () => goVisitRef.current(1) }] : []),
      { id: "new-tab", label: "New tab", accelerator: accel("new-tab"), run: () => newTab() },
      ...(tabs.length > 1 ? [{ id: "close-tab", label: "Close tab", accelerator: accel("close-tab"), run: () => closeTab() }] : []),
    ];
    if (selected) {
      list.push(
        ...Object.entries(RENDERER_LABELS).map(([id, label]) => ({
          id: "renderer:" + id,
          label: "View page in " + label,
                    run: () => {
            setOpenFile(null);
            setMode(id);
          },
        })),
        ...(pageNode?.build ? [{ id: "build", label: "Rebuild page", run: () => api.buildPage(selected).catch(() => {}) }] : []),
        { id: "reveal-page", label: isWin ? "Show page in File Explorer" : "Reveal page in Finder", run: () => api.reveal(selected) },
      );
    }
    list.push(
      { id: "toggle-sidebar", label: sidebarHidden ? "Show sidebar" : "Hide sidebar", accelerator: accel("toggle-sidebar"), run: () => setSidebarHidden((h) => !h) },
      { id: "toggle-files", label: showFiles ? "Hide files in sidebar" : "Show files in sidebar", run: () => setShowFiles((v) => !v) },
      { id: "settings", label: "Settings", accelerator: accel("settings"), run: () => setSettingsOpen(true) },
      { id: "reveal-vault", label: isWin ? "Show vault in File Explorer" : "Reveal vault in Finder", run: () => api.reveal("") },
      { id: "open-vault", label: "Open folder as vault…", accelerator: accel("open-vault"), run: () => api.openVault().catch(() => {}) },
      { id: "create-vault", label: "Create vault…", run: () => api.createVault().catch(() => {}) },
      ...otherVaults.map((v) => ({ id: "vault:" + v.path, label: "Switch to vault: " + v.name, run: () => api.switchVault(v.path).catch(() => {}) })),
    );
    // Embed mode: only what stays on the page on screen (no tabs, sidebar, Settings or vaults).
    if (embed) return list.filter((c) => c.id.startsWith("renderer:") || c.id === "build");
    return list;
  }, [selected, mode, fileOpen, showFiles, sidebarHidden, otherVaults, shortcuts, api, startCreate, createIn, canBack, canForward, pageNode, tabs.length, newTab, closeTab]); // eslint-disable-line react-hooks/exhaustive-deps

  /* ---------------------------------------------------------------- embed */

  // Embed mode's folder: the sidebar shows its children, at full vault paths.
  const embedNode = embed ? findNode(tree, embedFolder) : null;
  const embedChildren = useMemo(() => embedNode?.children || [], [embedNode]);

  // Embed mode: the sidebar hides entirely (remembered per browser), ⌥⇧⌘B / Ctrl+Alt+Shift+B toggles it.
  const [sideHidden, setSideHidden] = useState(() => embed && !!readLocal(EMBED_SIDEBAR_KEY, false));
  useEffect(() => {
    if (embed) writeLocal(EMBED_SIDEBAR_KEY, sideHidden);
  }, [sideHidden]); // eslint-disable-line react-hooks/exhaustive-deps
  const toggleSidebarKey = macKeys ? "⌥⇧⌘B" : "Ctrl+Alt+Shift+B";

  // Embed mode's keys, for keydowns in this document (a page frame's keys never get here):
  // ⌥⇧⌘B this sidebar; ⌘B and ⌘⇧B go to the parent window (pw folds its own sidebars with them);
  // New page / New folder by the user's shortcuts, where the browser lets a page have them.
  const embedKeyRef = useRef(null);
  embedKeyRef.current = (e) => {
    const mod = macKeys ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey;
    if (mod && e.code === "KeyB") {
      if (e.altKey) {
        if (!e.shiftKey) return;
        e.preventDefault();
        setSideHidden((h) => !h);
        return;
      }
      if (window.parent === window) return;
      e.preventDefault();
      try {
        window.parent.postMessage({ pw: 1, type: "key", key: "b", shift: e.shiftKey }, "*");
      } catch {}
      return;
    }
    if (document.querySelector(".settings-backdrop, .confirm")) return;
    const kind = keyMatches(e, accel("new-page") || "CmdOrCtrl+N") ? "page" : keyMatches(e, accel("new-folder") || "CmdOrCtrl+Ctrl+N") ? "folder" : null;
    if (!kind) return;
    e.preventDefault();
    setSideHidden(false);
    startCreate(kind, parentPath(selectedRef.current || ""));
  };
  useEffect(() => {
    if (!embed) return;
    const onKey = (e) => embedKeyRef.current(e);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  /* ---------------------------------------------------------------- render */

  const node = findPageNode(tree, selected);
  const crumbs = selected ? ancestry(tree, selected) : [];
  const vaultName = state?.vaultName || "";
  const hasPages = flatten(tree).some((n) => n.kind === "page");
  const aiContext = selNode?.kind === "page" ? { path: selNode.path, title: selNode.title || selNode.path.split("/").pop() } : null;
  const aiCard =
    aiOpen && api.ai && !embed ? (
      <AiChat
        api={api}
        conversation={aiChatId ? aiChats[aiChatId] || null : null}
        docked={aiDocked}
        focusSeq={aiFocus}
        context={aiContext}
        jobs={aiJobs}
        onSend={aiSend}
        onStop={aiStopTurn}
        onAnswer={aiAnswerTurn}
        onUndo={aiUndoTurn}
        onOpenPage={aiOpenPage}
        onOpenChat={pickAiChat}
        onNewChat={() => pickAiChat(null)}
        onDock={aiToggleDock}
        onClose={closeAi}
        onOpenPlan={() => setSettingsOpen("plan")}
      />
    ) : null;

  // Publish state for the page on screen: re-read when it changes or its files do.
  useEffect(() => {
    setPageDirty(false);
    setPubLogOpen(false);
  }, [selected]);
  useEffect(() => {
    if (!selected || !api.publishStatus || looseFile || embed) return setPub(null);
    let alive = true;
    api.publishStatus(selected).then((s) => alive && setPub((p) => (p?.busy && p.path === selected ? p : s)), () => {});
    return () => {
      alive = false;
    };
  }, [api, selected, filesVersion, saveStatus, pageKey, looseFile]);

  // Where Publish can put the selected page (Quire always; Cloudflare when self-hosting is on).
  const pubLive = pub?.public?.host || null;
  useEffect(() => {
    if (!selected || !api.publishTargets || looseFile || embed) return setPubTargets(null);
    let alive = true;
    api.publishTargets(selected).then((t) => alive && setPubTargets(t), () => alive && setPubTargets(null));
    return () => {
      alive = false;
    };
  }, [api, selected, looseFile, hostingVersion, pubLive]);

  // The selected page's backend, if its .noteblock has one (it starts when the page loads).
  useEffect(() => {
    if (!selected || looseFile || !api.backendStatus) return setBackend(null);
    let alive = true;
    api.backendStatus(selected).then((s) => alive && setBackend(s || null), () => alive && setBackend(null));
    return () => {
      alive = false;
    };
  }, [api, selected, looseFile, filesVersion]);

  // ⌘S with focus outside the page (sidebar, top bar) still saves a built page's edits.
  useEffect(() => {
    const onKey = (e) => {
      if (!pageDirty || mode !== "quire") return;
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "s") {
        e.preventDefault();
        try {
          pageFrame.current?.contentWindow?.postMessage({ quire: 1, type: "save" }, "*");
        } catch {}
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [pageDirty, mode]);

  // The button goes busy on the click itself. publish-status takes over, and an error there or a
  // refused call here puts it back.
  const pubRefused = useCallback((page, e) => {
    setPub((p) => (p?.path === page ? { ...p, busy: false, state: "error", error: String(e?.message || e), output: "" } : p));
    setPubLogOpen(true);
  }, []);
  const doPublish = useCallback(
    (host) => {
      const page = selected;
      pubHost.current = host || null;
      setPub((p) => ({ ...(p || {}), path: page, busy: true, state: "publishing" }));
      api.publish(page, host || null).catch((e) => pubRefused(page, e));
    },
    [api, selected, pubRefused],
  );
  const doUnpublish = useCallback(() => {
    const page = selected;
    setPub((p) => ({ ...(p || {}), path: page, busy: true, state: "unpublishing" }));
    api.unpublish(page).catch((e) => pubRefused(page, e));
  }, [api, selected, pubRefused]);
  // Publish or unpublish, asking to sign in first when it needs a Quire account (never for Cloudflare).
  const startPublish = useCallback(
    (kind, host) => {
      if (publishStep({ kind, host, live: pub?.public, targets: pubTargets }) === "signin") return setSignInAsk({ kind, host: host || "quire" });
      if (kind === "unpublish") doUnpublish();
      else doPublish(host);
    },
    [pub, pubTargets, doPublish, doUnpublish],
  );

  const publishMenu = useCallback(
    (e) => {
      if (!selected || !pub) return;
      if (pub.busy) return;
      const anchor = e.currentTarget.getBoundingClientRect();
      const quireSub = pubTargets?.quireHost || null;
      if (!pub.public) {
        if (!pubTargets?.cloudflare) return startPublish("publish", "quire");
        // Both hosts, the default one first (Settings → Publishing → Publish to).
        const toQuire = { id: "to-quire", label: `Publish with ${BRAND.name}`, sub: pubTargets.quireSignedIn ? quireSub || `A link on ${BRAND.domain}` : "Sign in first" };
        const toCf = { id: "to-cloudflare", label: "Publish to your Cloudflare", sub: "A Worker in your own account" };
        return setPubMenu({ anchor, items: pubTargets.defaultHost === "cloudflare" ? [toCf, toQuire] : [toQuire, toCf] });
      }
      const live = pub.public;
      const onCf = live.host === "cloudflare";
      let host = live.url;
      try {
        host = new URL(live.url).host;
      } catch {}
      const items = [
        { id: "open", label: "Open", sub: host },
        { id: "copy", label: "Copy link" },
        ...(onCf && live.dashboardUrl ? [{ id: "dashboard", label: "Open in Cloudflare dashboard" }] : []),
        { type: "separator" },
        { id: "publish", label: pub.upToDate ? "Update" : "Publish changes", sub: pub.upToDate ? "Nothing new since the last publish" : null },
        ...(onCf ? [{ id: "move-quire", label: `Move to ${BRAND.name}`, sub: quireSub }] : pubTargets?.cloudflare ? [{ id: "move-cloudflare", label: "Move to your Cloudflare" }] : []),
        { type: "separator" },
        { id: "unpublish", label: "Unpublish", danger: true },
      ];
      setPubMenu({ anchor, items });
    },
    [selected, pub, pubTargets, startPublish],
  );

  const pickPublish = useCallback(
    (id) => {
      setPubMenu(null);
      const url = pub?.public?.url;
      if (id === "to-quire") startPublish("publish", "quire");
      else if (id === "to-cloudflare") startPublish("publish", "cloudflare");
      else if (id === "open" && url) window.open(url, "_blank");
      else if (id === "copy" && url) navigator.clipboard?.writeText(url).catch(() => {});
      else if (id === "dashboard" && pub?.public?.dashboardUrl) window.open(pub.public.dashboardUrl, "_blank");
      else if (id === "publish") startPublish("publish", pub?.public?.host || null);
      else if (id === "move-quire") setPubMove("quire");
      else if (id === "move-cloudflare") setPubMove("cloudflare");
      else if (id === "unpublish") startPublish("unpublish");
    },
    [pub, startPublish],
  );
  const closePubMenu = useCallback(() => setPubMenu(null), []);
  useEffect(() => setPubMenu(null), [selected]);

  // QUIRE_EVAL_APP screenshots open the dropdown with window.__quireOpenPublishMenu().
  useEffect(() => {
    window.__quireOpenPublishMenu = () => {
      const btn = document.querySelector(".publish-btn");
      if (btn) publishMenu({ currentTarget: btn });
      return !!btn;
    };
    // And the sign-in dialog, in its first or its waiting state, without opening a browser.
    window.__quireShowSignIn = (waiting) => {
      setSignInAsk({ kind: "publish", host: "quire", waiting: !!waiting });
      return true;
    };
    return () => {
      delete window.__quireOpenPublishMenu;
      delete window.__quireShowSignIn;
    };
  }, [publishMenu]);

  // The page iframe's heartbeat and the "stopped responding" / "crashed" card over it.
  const showingFrame = !!selected && !fileOpen && mode !== "source";
  const reloadPage = useCallback(() => setPageKey((k) => k + 1), []);
  const pageHealth = usePageHealth({
    api,
    frameRef: pageFrame,
    src: showingFrame ? pageSrc(selected, node?.id) : null,
    active: showingFrame,
    mountKey: selected + ":" + pageKey,
    onReload: reloadPage,
  });
  const titleFor = useCallback((p) => findPageNode(tree, p)?.title || String(p).split("/").pop() || p, [tree]);
  const openSourceFromCard = useCallback(async () => {
    if (!(await pageHealth.recover())) return;
    setOpenFile(null);
    setMode("source");
  }, [pageHealth]);

  // ⌘N with the sidebar hidden: its name field needs the sidebar, for as long as it's open.
  const sidebarGone = !embed && sidebarHidden && !creating;

  const statusText = useMemo(() => {
    if (saveStatus === "saving" || saveStatus === "dirty") return "Saving…";
    if (saveStatus === "saved") return "Saved";
    if (saveStatus === "error") return "Not saved";
    return null;
  }, [saveStatus]);

  return (
    <div className={"app" + (sidebarGone ? " is-sidebar-hidden" : "") + (embed ? " is-embed" : "")}>
      {/* Fixed drag strips for the hidden-inset title bar. Nothing interactive sits under them. */}
      {isWeb ? null : <div className="drag-strip drag-top" aria-hidden="true" />}
      {isWeb ? null : <div className="drag-strip drag-side" aria-hidden="true" />}

      {embed && sideHidden ? null : (
        <Sidebar
          vaultName={vaultName}
          tree={embed ? embedChildren : tree}
          root={embed ? embedFolder : ""}
          scoped={embed}
          onHide={() => setSideHidden(true)}
          hideLabel={`Hide sidebar (${toggleSidebarKey})`}
          selected={selected}
          expanded={expanded}
          onSelect={(p, e) => (!embed && e && (e.metaKey || e.ctrlKey) ? newTab(p) : select(p))}
          onToggle={toggle}
          lockFor={lockFor}
          aiBusy={aiBusy}
          creating={creating}
          onCreateSubmit={onCreateSubmit}
          onCreateCancel={() => setCreating(null)}
          onContextMenu={onContextMenu}
          onNew={(kind) => startCreate(kind, createIn())}
          api={api}
          showFiles={showFiles}
          onShowFiles={setShowFiles}
          openFile={fileOpen}
          onSelectFile={(page, file, e) => (!embed && e && (e.metaKey || e.ctrlKey) ? openFileTab(page, file) : selectFile(page, file))}
          filesVersion={filesVersion}
            onMoveInto={onMoveInto}
            onImportFiles={onImportFiles}
            focusedFolder={folderFocus}
            focusReveal={focusReveal}
            onFocusFolder={setFolderFocus}
            renaming={renaming}
            onRenameSubmit={onRenameSubmit}
            onRenameCancel={onRenameCancel}
        />
      )}

      <main className="main">
        {!embed && tabs.length > 1 ? (
          <TabBar tabs={tabs} active={activeTab} tree={tree} onShow={showTab} onClose={closeTab} onNew={() => newTab()} onMove={moveTab} />
        ) : null}
        <div className={"topbar" + (!embed && tabs.length > 1 ? " has-tabs" : "")}>
          <div className="topnav">
            {sidebarGone ? (
              <>
                {isWin ? (
                  // The sidebar's menu button is hidden with it.
                  <button
                    type="button"
                    className="topnav-menu"
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
                <button type="button" className="topnav-sidebar" aria-label="Show sidebar" title={"Show sidebar " + formatAccelerator(accel("toggle-sidebar"))} onClick={() => setSidebarHidden(false)}>
                  <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    <rect x="2" y="3" width="12" height="10" rx="2" />
                    <path d="M6.5 3v10" />
                  </svg>
                </button>
              </>
            ) : null}
            <button type="button" className="topnav-back" aria-label="Back" title={"Back " + formatAccelerator(accel("back"))} disabled={!canBack} onClick={() => goVisit(-1)}>
              <ChevronLeft size={16} />
            </button>
            <button type="button" className="topnav-forward" aria-label="Forward" title={"Forward " + formatAccelerator(accel("forward"))} disabled={!canForward} onClick={() => goVisit(1)}>
              <ChevronRight size={16} />
            </button>
          </div>
          <div className="crumbs">
            {embed && sideHidden ? (
              <button type="button" className="side-toggle side-show" title={`Show sidebar (${toggleSidebarKey})`} aria-label="Show sidebar" onClick={() => setSideHidden(false)}>
                <SidebarIcon size={15} />
              </button>
            ) : null}
            {state?.dev ? (
              <span className="dev-badge" title={`${BRAND.name} Dev: this checkout, with its own vault and settings`}>
                Dev · {state.dev}
              </span>
            ) : null}
            {state?.next ? (
              <span className="dev-badge next-badge" title={`${BRAND.name} Next: ahead of what users get, on your real vault`}>
                Next
              </span>
            ) : null}
            {embed ? null : (
              <span className="crumb">
                <button type="button" className="crumb-link crumb-vault" title={vaultName || BRAND.name} onClick={() => revealFolder("")}>
                  {vaultName || BRAND.name}
                </button>
              </span>
            )}
            {(crumbs.length ? (embed ? crumbs.filter((c) => inEmbedFolder(c.path)) : crumbs) : selected ? [{ path: selected, title: selected.split("/").pop() }] : []).map(
              (c, i, arr) => (
                <span key={c.path} className={"crumb" + (i === arr.length - 1 && !(fileOpen && !looseFile) ? " is-current" : "")}>
                  {embed && i === 0 ? null : <span aria-hidden="true">/</span>}
                  {i === arr.length - 1 ? (
                    fileOpen && !looseFile ? (
                      <button type="button" className="crumb-link" title={c.title} onClick={() => select(c.path)}>
                        {c.title}
                      </button>
                    ) : (
                      <span className="crumb-current" title={c.title}>{c.title}</span>
                    )
                  ) : c.kind === "folder" ? (
                    <button type="button" className="crumb-link crumb-folder" data-path={c.path} title={c.title} onClick={() => revealFolder(c.path)}>
                      {c.title}
                    </button>
                  ) : (
                    <button type="button" className="crumb-link" title={c.title} onClick={() => select(c.path)}>
                      {c.title}
                    </button>
                  )}
                </span>
              ),
            )}
            {fileOpen && !looseFile ? (
              <span className="crumb is-current">
                <span aria-hidden="true">/</span>
                <span className="crumb-current crumb-file" title={fileOpen}>{fileOpen}</span>
              </span>
            ) : null}
          </div>
          {statusText ? (
            <span className="save-hint" aria-live="polite">
              {statusText}
            </span>
          ) : null}
          {selected && builds[selected]?.state === "building" ? (
            <span className="save-hint build-hint" aria-live="polite">
              <Spinner size={12} />
              Building…
            </span>
          ) : selected && builds[selected]?.state === "error" ? (
            <button type="button" className="build-failed" onClick={() => setBuildLogOpen((o) => !o)}>
              Build failed
            </button>
          ) : selected && builds[selected]?.state === "blocked" && builds[selected]?.reason !== "restricted" ? (
            <span className="save-hint" title={builds[selected].output || ""}>
              Build not run
            </span>
          ) : null}
          {selected && pageDirty && !fileOpen && mode === "quire" ? (
            <span className="unsaved-hint" title={`Built pages save on ${formatAccelerator("CmdOrCtrl+S")}, then rebuild`}>
              <span className="unsaved-dot" aria-hidden="true" />
              Unsaved · {formatAccelerator("CmdOrCtrl+S")}
            </span>
          ) : null}
          {selected && !looseFile ? (
            <button
              type="button"
              className="renderer-pick"
              aria-label={"Renderer: " + (fileOpen ? "file" : RENDERER_LABELS[mode])}
              aria-haspopup="menu"
              onClick={pickRenderer}
            >
              {mode === "source" && !fileOpen ? <CodeIcon size={14} /> : null}
              {fileOpen ? "File" : RENDERER_LABELS[mode]}
              <ChevronDown size={14} />
            </button>
          ) : null}
          {selected && backend ? <BackendPill status={backend} open={backendOpen} onToggle={() => setBackendOpen((o) => !o)} /> : null}
          {selected && errorBadge ? <ErrorPill errors={pageErrors} open={errorsOpen} onToggle={() => setErrorsOpen((o) => !o)} /> : null}
          {selected && pub && !embed ? (
            <button
              type="button"
              className={"publish-btn" + (pub.public ? (pub.upToDate ? " is-live" : " is-stale") : "") + (pubMenu ? " is-open" : "")}
              onClick={publishMenu}
              disabled={pub.busy}
              aria-haspopup={pub.public || pubTargets?.cloudflare ? "menu" : undefined}
              aria-expanded={pubMenu ? true : undefined}
              title={pub.public ? pub.public.url : "Put this page on the web"}
            >
              <span className="publish-icon" aria-hidden="true">
                {pub.busy ? <Spinner size={12} /> : pub.public ? <span className="publish-dot" /> : <GlobeIcon size={14} />}
              </span>
              <StableLabel
                value={
                  pub.busy
                    ? pub.state === "unpublishing"
                      ? "Unpublishing…"
                      : "Publishing…"
                    : pub.public
                      ? pub.upToDate
                        ? "Live"
                        : "Changes not live"
                      : "Publish"
                }
                options={pub.public ? ["Live", "Changes not live", "Publishing…", "Unpublishing…"] : ["Publish", "Publishing…"]}
              />
              {pub.public || pubTargets?.cloudflare ? <ChevronDown size={14} /> : null}
            </button>
          ) : null}
        </div>

        {state?.trust && state.trust !== "trusted" ? (
          <div className="restricted-bar" role="status">
            <span>Restricted mode. Pages can't run commands or use the network.</span>
            <button type="button" className="restricted-trust" disabled={trustBusy} onClick={() => answerTrust("trusted")}>
              Trust vault
            </button>
          </div>
        ) : null}

        {currentLock ? (
          <div className="lock-banner" role="status">
            <Spinner size={14} />
            <div className="lock-text">
              <strong>{currentLock.by ? `${currentLock.by} is editing this page` : "This page is being edited"}</strong>
              {currentLock.message ? <span className="lock-msg">{currentLock.message}</span> : null}
              <span className="lock-note">You're seeing the version from before the edit started.</span>
            </div>
          </div>
        ) : null}

        {selected && backend ? (
          <MissingToolBanner
            status={backend}
            onShowLog={(name) => {
              setBackendTab(name);
              setBackendOpen(true);
            }}
          />
        ) : null}

        {selected && pubLogOpen && pub?.state === "error" ? (
          <div className="build-log" role="alert">
            <div className="build-log-head">
              <strong>Not published</strong>
              <span className="build-log-cmd pub-log-msg">{pub.error}</span>
              {pub.code === "plan_limit" && pub.upgrade ? (
                <button type="button" className="settings-button is-primary" onClick={() => setSettingsOpen("plan")}>
                  Upgrade to Pro
                </button>
              ) : null}
              <button type="button" className="settings-button" onClick={() => startPublish("publish", pubHost.current)}>
                Try again
              </button>
              <button type="button" className="settings-close" aria-label="Hide publish output" onClick={() => setPubLogOpen(false)}>
                ×
              </button>
            </div>
            {pub.output ? <pre>{pub.output}</pre> : null}
          </div>
        ) : null}
        {selected && backend && backendOpen ? <BackendPanel api={api} page={selected} status={backend} tab={backendTab} onClose={() => setBackendOpen(false)} /> : null}
        {selected && errorBadge && errorsOpen && pageErrors.length ? (
          <ErrorPanel
            api={api}
            errors={pageErrors}
            page={selected}
            titleFor={titleFor}
            onClear={() => {
              setPageErrors([]);
              setErrorsOpen(false);
            }}
            onClose={() => setErrorsOpen(false)}
          />
        ) : null}

        {selected && buildLogOpen && builds[selected]?.state === "error" ? (
          <div className="build-log" role="alert">
            <div className="build-log-head">
              <strong>Build failed</strong>
              <span className="build-log-cmd">{pageNode?.build}</span>
              <button type="button" className="settings-button" onClick={() => api.buildPage(selected).catch(() => {})}>
                Try again
              </button>
              <button type="button" className="settings-close" aria-label="Hide build output" onClick={() => setBuildLogOpen(false)}>
                ×
              </button>
            </div>
            <pre>{builds[selected].output || "No output"}</pre>
          </div>
        ) : null}

        <div className="content" ref={contentEl}>
          {!selected && embed ? (
            treeLoaded ? (
              <article className="blank embed-blank">
                <h1>{embedNode && flatten(embedNode.children || []).some((n) => n.kind === "page") ? "Pick a page" : "No pages yet"}</h1>
                <p>Pages in {embedNode?.title || embedFolder.split("/").pop()} show up in the sidebar.</p>
                <div>
                  <button
                    type="button"
                    className="embed-new"
                    onClick={() => {
                      setSideHidden(false);
                      startCreate("page", embedFolder);
                    }}
                  >
                    <PlusIcon size={13} />
                    New page
                  </button>
                </div>
              </article>
            ) : null
          ) : !selected ? (
            treeLoaded ? (
              <article className="blank">
                <h1>{!hasPages ? "No pages yet" : tabs.length > 1 ? "New tab" : "Pick a page"}</h1>
                <p>
                  {hasPages
                    ? `Choose a page in the sidebar, or press ${formatAccelerator("CmdOrCtrl+P")} to find one.`
                    : `Press ${formatAccelerator("CmdOrCtrl+N")} or right-click the sidebar to make one, or ask Claude to build one.`}
                </p>
              </article>
            ) : null
          ) : fileOpen ? (
            <FileView
              api={api}
              page={fileHost}
              file={fileOpen}
              locked={locked}
              onSaved={onFileSaved}
              onStatus={setSaveStatus}
              filesTick={filesTick}
            />
          ) : mode === "source" ? (
            <SourceView
              api={api}
              path={selected}
              id={node?.id}
              locked={locked}
              previewRef={previewFrame}
              previewKey={selected + ":" + previewKey}
              onPreviewLoad={onPreviewLoad}
              onSaved={onSaved}
              onStatus={setSaveStatus}
              filesTick={filesTick}
            />
          ) : (
            pageSwap.frames.map((f) => (
              <iframe
                key={f.id}
                ref={f.ref}
                className="page-frame"
                data-q-frame={f.role}
                style={f.style}
                aria-hidden={f.hidden || undefined}
                tabIndex={f.hidden ? -1 : undefined}
                title={node?.title || selected}
                sandbox="allow-scripts allow-same-origin allow-forms allow-pointer-lock"
                allow="fullscreen; autoplay"
                src={f.src || pageSrc(selected, node?.id)}
                onLoad={f.onLoad}
              />
            ))
          )}
          {showingFrame ? <FindBar ref={findBar} frameRef={pageFrame} /> : null}
          {aiDocked ? null : aiCard}
          {showingFrame ? (
            <RecoveryOverlay
              health={pageHealth.health}
              title={node?.title || selected.split("/").pop()}
              page={selected}
              titleFor={titleFor}
              onReload={pageHealth.reload}
              onOpenSource={openSourceFromCard}
              onWait={pageHealth.wait}
            />
          ) : null}
        </div>
      </main>
      {aiDocked ? aiCard : null}

      {paletteOpen ? (
        <Palette
          api={api}
          tree={embed ? (embedNode ? [embedNode] : []) : tree}
          commands={commands}
          recent={recent.filter((p) => p !== selected)}
          onOpenPage={(p, inNewTab) => (inNewTab ? newTab(p) : select(p))}
          onOpenFile={(page, file, inNewTab) => {
            if (inNewTab) newTab(page);
            openFileFromPalette(page, file);
          }}
          onClose={() => setPaletteOpen(false)}
        />
      ) : null}
      {templateFor && !embed ? (
        <TemplatePicker
          api={api}
          folder={templateFor.folder}
          onPick={(t) => startCreate("template", templateFor.folder, { template: t.path, name: t.title })}
          onClose={() => setTemplateFor(null)}
        />
      ) : null}
      {state?.trust === "ask" ? (
        <TrustDialog
          title="Do you trust the author of this vault?"
          body={`Pages in a trusted vault can run commands on ${words.computer} (backends and builds) and reach the network. In restricted mode pages can only show their own content.`}
          riskyLabel="Trust vault"
          safeLabel="Open in restricted mode"
          busy={trustBusy}
          onRisky={() => answerTrust("trusted")}
          onSafe={() => answerTrust("restricted")}
        />
      ) : cmdAsks.length ? (
        <TrustDialog
          key={cmdAsks[0].page}
          title={cmdAsks[0].commands.length > 1 ? "Run these commands?" : "Run this command?"}
          body={`“${cmdAsks[0].title || cmdAsks[0].page}” has ${cmdAsks[0].commands.length > 1 ? "commands" : "a command"} ${words.computer} hasn't run before. It came from outside ${BRAND.name}, for example a sync.`}
          commands={cmdAsks[0].commands}
          riskyLabel="Run"
          safeLabel="Don't run"
          busy={trustBusy}
          onRisky={() => answerCommand(cmdAsks[0].page, true)}
          onSafe={() => answerCommand(cmdAsks[0].page, false)}
        />
      ) : null}
      {trashAsk ? (
        <ConfirmDialog
          title={`Move “${trashAsk.name}” to the ${words.trash}?`}
          body={
            (trashAsk.what === "folder" ? `The folder and everything in it go to the ${words.trash}. ` : "") +
            `You can put it back from the ${words.trash}${isWin ? "" : " in Finder"}.`
          }
          confirmLabel={words.moveToTrash}
          busy={trashAsk.busy}
          error={trashAsk.error}
          onConfirm={() => doTrash(trashAsk)}
          onCancel={() => setTrashAsk(null)}
          onDontAsk={() => api.setPref("confirmDelete", false).then(setPrefs, () => {})}
        />
      ) : null}
      {pubMenu ? <PublishMenu anchor={pubMenu.anchor} items={pubMenu.items} onPick={pickPublish} onClose={closePubMenu} /> : null}
      {pubMove ? (
        <ConfirmDialog
          title={pubMove === "quire" ? `Move this page to ${BRAND.name}?` : "Move this page to your Cloudflare?"}
          body={
            pubMove === "quire"
              ? `It comes down from your Cloudflare account first, then goes up at ${pubTargets?.quireHost || `a ${BRAND.name} link`}. The old link stops working.`
              : `It comes down from ${BRAND.name} first, then goes up as a Worker in your account. The old link stops working.`
          }
          confirmLabel="Move"
          onConfirm={() => {
            const host = pubMove;
            setPubMove(null);
            startPublish("publish", host);
          }}
          onCancel={() => setPubMove(null)}
        />
      ) : null}
      {folderUnpublish ? (
        <ConfirmDialog
          title={`Unpublish “${folderUnpublish.name}”?`}
          body="The link stops working. The folder stays where it is."
          confirmLabel="Unpublish"
          onConfirm={() => {
            const { folder } = folderUnpublish;
            setFolderUnpublish(null);
            startFolderJob(folder, "unpublish");
          }}
          onCancel={() => setFolderUnpublish(null)}
        />
      ) : null}
      {signInAsk ? (
        <SignInDialog
          key={signInAsk.waiting ? "waiting" : "ask"}
          api={api}
          quireHost={signInAsk.folder ? null : pubTargets?.quireHost}
          noun={signInAsk.folder ? "Folders" : "Pages"}
          cloudflare={!signInAsk.folder && !!pubTargets?.cloudflare && signInAsk.kind === "publish"}
          initialWaiting={!!signInAsk.waiting}
          onSignedIn={() => {
            const { kind, host, folder } = signInAsk;
            setSignInAsk(null);
            setPubTargets((t) => (t ? { ...t, quireSignedIn: true } : t));
            if (folder) runFolderJob(folder, kind);
            else if (kind === "unpublish") doUnpublish();
            else doPublish(host);
          }}
          onCloudflare={() => {
            setSignInAsk(null);
            doPublish("cloudflare");
          }}
          onCancel={() => setSignInAsk(null)}
        />
      ) : null}
      {settingsOpen && !embed ? (
        <Settings
          key={typeof settingsOpen === "string" ? settingsOpen : "settings"}
          api={api}
          prefs={prefs}
          onPrefs={setPrefs}
          initialTab={typeof settingsOpen === "string" ? settingsOpen : "vault"}
          shortcuts={shortcuts}
          onShortcuts={setShortcuts}
          onVaultChanged={onVaultChanged}
          folders={flatten(tree).filter((n) => n.kind === "folder").map((n) => n.path)}
          page={selNode?.kind === "page" ? { path: selNode.path, title: selNode.title } : null}
          debug={!!state?.debug}
          onOpenAi={() => {
            setSettingsOpen(false);
            setAiOpen(true);
            setAiFocus((f) => f + 1);
          }}
          onOpenPage={(p, opts) => {
            setSettingsOpen(false);
            refreshTree();
            select(p);
            if (opts?.backend) setBackendOpen(true); // Settings → Activity → Logs
          }}
          onClose={() => setSettingsOpen(false)}
        />
      ) : null}
      {embed ? null : (
        <UpdateToast
          status={update}
          onRun={() => api.runUpdate().then(setUpdate, (err) => setUpdate({ state: "failed", error: String(err?.message || err) }))}
          onShowLog={() => api.revealUpdateLog()}
        />
      )}
      {Object.keys(folderJobs).length ? (
        <div className="folder-toasts">
          {Object.values(folderJobs).map((job) => (
            <FolderPublishToast
              key={job.folder}
              job={job}
              onRetry={() => startFolderJob(job.folder, job.kind)}
              onOpenPage={select}
              onUpgrade={() => setSettingsOpen("plan")}
              onDismiss={() => closeFolderToast(job.folder)}
            />
          ))}
        </div>
      ) : null}
    </div>
  );
}
