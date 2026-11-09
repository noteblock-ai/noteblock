// Find in page (⌘F): a small bar over the top-right of the page, like a browser's. The search
// itself runs in the page's runtime (app/runtime/runtime.js, "find in page"), which searches its
// own document and asks its embeds, and marks matches with CSS Custom Highlights — so it never
// reaches the app around the page and never changes the document the editor saves.
// The owner (App.jsx, Floating.jsx) calls open() / step(±1) from the menu, and refresh() when
// the page frame loads again. Esc (here, or in the page) closes it and puts focus back.
import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from "react";
import { formatAccelerator } from "./platform.js";
import { ChevronDown, CloseIcon } from "./icons.jsx";
import { isPageOrigin } from "./webBridge.js";

const DEBOUNCE = 120;
const WAIT = 1500;

const ChevronUp = (p) => <ChevronDown {...p} style={{ transform: "rotate(180deg)" }} />;

function post(win, msg) {
  try {
    win?.postMessage(msg, "*");
  } catch {
    /* frame gone */
  }
}

const FindBar = forwardRef(function FindBar({ frameRef, onOpenChange }, ref) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [matchCase, setMatchCase] = useState(false);
  const [count, setCount] = useState(null); // null: nothing searched yet
  const [active, setActive] = useState(-1);
  const input = useRef(null);
  const seq = useRef(0);
  const waiters = useRef([]);
  const back = useRef(null); // the element focus goes back to on close
  const live = useRef({ open: false, query: "", matchCase: false, count: null, active: -1, searched: null });
  live.current = { ...live.current, open, query, matchCase, count, active };
  const timer = useRef(0);

  const frameWin = () => frameRef.current?.contentWindow || null;

  // Answers from the page frame (find-count / find-shown / find-selection) and Esc from any page.
  useEffect(() => {
    const onMessage = (event) => {
      const msg = event.data;
      if (!msg || typeof msg !== "object" || msg.quire !== 1 || typeof msg.type !== "string") return;
      if (msg.type === "find-escape") {
        if (live.current.open && isPageOrigin(event.origin)) closeRef.current();
        return;
      }
      if (event.source !== frameWin()) return;
      const w = waiters.current.find((x) => x.type === msg.type && x.seq === msg.seq);
      if (w) w.resolve(msg);
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const ask = useCallback((msg, type) => {
    const win = frameWin();
    if (!win) return Promise.resolve(null);
    return new Promise((resolve) => {
      const w = { type, seq: msg.seq, resolve: null };
      const t = setTimeout(() => done(null), WAIT);
      function done(v) {
        clearTimeout(t);
        waiters.current = waiters.current.filter((x) => x !== w);
        resolve(v);
      }
      w.resolve = done;
      waiters.current.push(w);
      post(win, { quire: 1, ...msg });
    });
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const show = useCallback(
    (index) => {
      setActive(index);
      return ask({ type: "find-active", seq: ++seq.current, index }, "find-shown");
    },
    [ask],
  );

  /** Search for what's in the box now; resolves when the count is in. */
  const search = useCallback(async () => {
    clearTimeout(timer.current);
    timer.current = 0;
    const { query: q, matchCase: mc } = live.current;
    const n = ++seq.current;
    live.current.searched = { q, mc };
    if (!q.trim()) {
      post(frameWin(), { quire: 1, type: "find-clear" });
      setCount(null);
      setActive(-1);
      return;
    }
    const res = await ask({ type: "find", seq: n, query: q, matchCase: mc }, "find-count");
    if (n !== seq.current) return; // typed on since
    const c = res && typeof res.count === "number" ? res.count : 0;
    setCount(c);
    if (c > 0) await show(0);
    else setActive(-1);
  }, [ask, show]);

  // Live as you type (debounced); the case toggle searches at once.
  useEffect(() => {
    if (!open) return;
    clearTimeout(timer.current);
    timer.current = setTimeout(search, DEBOUNCE);
    return () => clearTimeout(timer.current);
  }, [query, open]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (open) search();
  }, [matchCase]); // eslint-disable-line react-hooks/exhaustive-deps

  const step = useCallback(
    async (dir) => {
      const cur = live.current;
      const s = cur.searched;
      if (!s || s.q !== cur.query || s.mc !== cur.matchCase || timer.current) {
        await search();
        return;
      }
      const c = cur.count;
      if (!c) return;
      show((((cur.active < 0 ? (dir > 0 ? -1 : 0) : cur.active) + dir) % c + c) % c);
    },
    [search, show],
  );

  const close = useCallback(() => {
    if (!live.current.open) return;
    clearTimeout(timer.current);
    timer.current = 0;
    seq.current++;
    setOpen(false);
    onOpenChange?.(false);
    setCount(null);
    setActive(-1);
    live.current.searched = null;
    post(frameWin(), { quire: 1, type: "find-clear", restore: true });
    const el = back.current;
    back.current = null;
    // The page frame gets focus back and its runtime puts the caret where it was.
    if (el && el.isConnected && el.focus) el.focus({ preventScroll: true });
    else frameRef.current?.focus();
  }, [onOpenChange]); // eslint-disable-line react-hooks/exhaustive-deps
  const closeRef = useRef(close);
  closeRef.current = close;

  const openBar = useCallback(async () => {
    const wasOpen = live.current.open;
    if (!wasOpen) {
      const a = document.activeElement;
      back.current = a && a !== document.body && a !== input.current ? a : frameRef.current;
    }
    // ⌘F with text selected in the page searches for it (one line, not too long).
    let picked = "";
    if (!wasOpen || document.activeElement !== input.current) {
      const res = await ask({ type: "find-selection", seq: ++seq.current }, "find-selection");
      const t = res && typeof res.text === "string" ? res.text.trim() : "";
      if (t && t.length <= 200 && !/\n/.test(t)) picked = t;
    }
    setOpen(true);
    onOpenChange?.(true);
    // Opening searches the box's text (picked or remembered) through the query effect.
    if (picked && picked !== live.current.query) setQuery(picked);
    requestAnimationFrame(() => {
      input.current?.focus();
      input.current?.select();
    });
  }, [ask, onOpenChange]); // eslint-disable-line react-hooks/exhaustive-deps

  /** The page frame loaded again (a reload, another page): search it afresh. */
  const refresh = useCallback(() => {
    if (!live.current.open) return;
    live.current.searched = null;
    setTimeout(() => live.current.open && search(), 150);
  }, [search]);

  useImperativeHandle(ref, () => ({ open: openBar, step, close, refresh, isOpen: () => live.current.open }), [openBar, step, close, refresh]);

  if (!open) return null;

  const status = !query.trim() || count == null ? "" : count === 0 ? "No results" : `${active + 1} of ${count}`;

  return (
    <div className="find-bar" role="search" aria-label="Find in page">
      <input
        ref={input}
        className="find-input"
        type="text"
        spellCheck={false}
        autoComplete="off"
        placeholder="Find in page"
        aria-label="Find in page"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            step(e.shiftKey ? -1 : 1);
          } else if (e.key === "Escape") {
            e.preventDefault();
            close();
          }
        }}
      />
      <span className={"find-count" + (count === 0 && query.trim() ? " is-none" : "")} aria-live="polite">
        {status}
      </span>
      <button
        type="button"
        className={"find-btn find-case" + (matchCase ? " is-on" : "")}
        aria-pressed={matchCase}
        aria-label="Match case"
        title="Match case"
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => setMatchCase((m) => !m)}
      >
        Aa
      </button>
      <span className="find-sep" aria-hidden="true" />
      <button type="button" className="find-btn" aria-label="Previous match" title={`Previous (${formatAccelerator("Shift+CmdOrCtrl+G")})`} disabled={!count} onMouseDown={(e) => e.preventDefault()} onClick={() => step(-1)}>
        <ChevronUp size={14} />
      </button>
      <button type="button" className="find-btn" aria-label="Next match" title={`Next (${formatAccelerator("CmdOrCtrl+G")})`} disabled={!count} onMouseDown={(e) => e.preventDefault()} onClick={() => step(1)}>
        <ChevronDown size={14} />
      </button>
      <button type="button" className="find-btn" aria-label="Close find" title="Close (Esc)" onMouseDown={(e) => e.preventDefault()} onClick={close}>
        <CloseIcon size={14} />
      </button>
    </div>
  );
});

export default FindBar;
