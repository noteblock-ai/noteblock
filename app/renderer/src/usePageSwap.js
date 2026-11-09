// Reloads the on-screen page iframe without a white frame: the new iframe loads underneath the old
// one, invisible but laid out, gets the same post-load steps and the old one's scroll position,
// then takes over. Used by the main window (App.jsx) and the floating note (Floating.jsx).
//
// swap() is for "this page's files changed". It falls back to a plain remount when there is nothing
// to buffer from (no frame, or no runtime answering in it) and for pages that shouldn't run twice:
// built pages (canBuffer), and pages with a canvas, video, playing audio, an embed or pointer lock
// (the runtime's swap-state). Changing pageKey any other way is a plain remount, and drops a swap.
//
// Unsaved typing: the old frame is asked to save first and the new one loads after that. Typing that
// lands while the new one loads saves and restarts the buffer. Only the 3 s deadline swaps past it,
// and then the old frame's pagehide saves it, as a remount always has: on disk, not yet on screen.
//
// follow(to) is for "the page on screen got a new path and its frame stays": the iframe keeps its
// React key and its src until the next load, and the app tells the frame its new path.
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";

const DEADLINE_MS = 3000; // from the first change of a burst: swap anyway
const ASK_MS = 250; // an old frame that doesn't answer in this long has no runtime, or is stuck
const SCROLL_MS = 1000;
const FLUSH_MS = 1000;
const PAINTED_MS = 400;
const RETIRE_MS = 150;

// Transparent, not the frame's usual --bg: until the new document's first paint reaches the screen,
// the element's own background is what would show, in white.
const BUFFER_STYLE = { position: "absolute", inset: 0, width: "100%", height: "100%", opacity: 0, pointerEvents: "none", background: "transparent" };
const ON_TOP_STYLE = { position: "absolute", inset: 0, width: "100%", height: "100%", background: "transparent" };
const RETIRING_STYLE = { pointerEvents: "none" };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function send(win, msg) {
  try {
    win?.postMessage(msg, "*");
  } catch {
    /* frame gone */
  }
}

let askSeq = 0;
/** Post `msg` to `win`; resolves with its reply (same type + "-reply"), or null after `ms`. */
function ask(win, msg, ms = ASK_MS) {
  return new Promise((resolve) => {
    if (!win) return resolve(null);
    const seq = ++askSeq;
    const finish = (value) => {
      clearTimeout(timer);
      window.removeEventListener("message", onMessage);
      resolve(value);
    };
    const onMessage = (e) => {
      const m = e.data;
      if (e.source === win && m && m.quire === 1 && m.type === msg.type + "-reply" && m.seq === seq) finish(m);
    };
    const timer = setTimeout(() => finish(null), ms);
    window.addEventListener("message", onMessage);
    send(win, { quire: 1, ...msg, seq });
  });
}

/**
 * owner: the page on screen; pageKey / setPageKey: its mount counter; frameRef: the visible iframe.
 * canBuffer(): may this page run twice for a moment? onBufferLoad(win): the post-load steps for a
 * frame that isn't visible yet. onVisibleLoad(): the post-load steps for the visible frame, on its
 * own load and again when a buffered frame takes over.
 * Returns {frames, swap, follow, isBuffer, bufferWindow, loadKey}: render one iframe per frames entry,
 * with its id as key and its ref, style, onLoad and hidden props, and its src when it has one. loadKey changes when a new load of the
 * page starts.
 */
export function usePageSwap({ frameRef, owner, active, pageKey, setPageKey, canBuffer, onBufferLoad, onVisibleLoad }) {
  const [buffer, setBuffer] = useState(null); // {id, owner, forKey}: loading underneath
  const [committed, setCommitted] = useState(null); // {id, owner, key, src?}: the frame that is `owner` at pageKey `key`: a buffer that took over, or one that followed a rename (with the src it loaded)
  const [retiring, setRetiring] = useState(null); // {id, owner}: the old frame, under the new one for one more paint

  const bufferRef = useRef(null);
  const gen = useRef(0); // bumped by every restart and cancel: an async step that sees a newer one stops
  const job = useRef(null); // {started, deadline, bufferId, state}: the swap under way
  const landing = useRef(null); // what the committed frame still has to do once React has it in frameRef
  const unrestored = useRef(null); // {id, state}: a frame that took over at the deadline, not loaded yet
  const seq = useRef(0);

  const visibleId = committed && committed.owner === owner && committed.key === pageKey ? committed.id : owner + ":" + pageKey;

  const latest = useRef(null);
  latest.current = { owner, pageKey, visibleId, canBuffer, onBufferLoad, onVisibleLoad };

  const stop = useCallback(() => {
    gen.current++;
    if (job.current) clearTimeout(job.current.deadline);
    job.current = null;
  }, []);

  const remount = useCallback(() => {
    stop();
    setBuffer(null);
    setPageKey((k) => k + 1);
  }, [stop, setPageKey]);

  const commit = useCallback(
    (state, loaded) => {
      const j = job.current;
      if (!j || !j.bufferId) return;
      const { owner: o, pageKey: key, visibleId: oldId } = latest.current;
      stop();
      const old = frameRef.current;
      landing.current = { id: j.bufferId, oldId, focus: !!old && document.activeElement === old, caret: state?.caret || null, loaded };
      unrestored.current = loaded ? null : { id: j.bufferId, state };
      setCommitted({ id: j.bufferId, owner: o, key: key + 1 });
      setRetiring({ id: oldId, owner: o });
      setBuffer(null);
      setPageKey(key + 1);
    },
    [frameRef, setPageKey, stop],
  );

  const run = useCallback(
    async (mine) => {
      const live = () => mine === gen.current;
      const old = frameRef.current;
      if (!old || window.__quireSwapOff || !latest.current.canBuffer()) return remount();
      let st = await ask(old.contentWindow, { type: "swap-state" });
      if (!live()) return;
      // Silent while a buffer is loading is that load holding their shared process: go on from what
      // the old frame last said.
      if (!st) st = job.current?.state;
      if (!st || st.heavy) return remount();
      if (st.pending) {
        send(old.contentWindow, { quire: 1, type: "save" });
        const t0 = Date.now();
        while (st?.pending && Date.now() - t0 < FLUSH_MS) {
          await sleep(50);
          if (!live()) return;
          st = await ask(old.contentWindow, { type: "swap-state" });
          if (!live()) return;
        }
      }
      if (!job.current) return;
      const { owner: o, pageKey: key } = latest.current;
      const id = "b" + ++seq.current;
      job.current.bufferId = id;
      job.current.state = st;
      setRetiring(null); // never a third frame
      setBuffer({ id, owner: o, forKey: key });
    },
    [frameRef, remount],
  );

  const swap = useCallback(() => {
    const mine = ++gen.current;
    if (!job.current) {
      const j = { bufferId: null, state: null };
      j.deadline = setTimeout(() => {
        if (job.current !== j) return;
        if (j.bufferId) commit(j.state, false);
        else remount();
      }, DEADLINE_MS);
      job.current = j;
    }
    run(mine);
  }, [commit, remount, run]);

  // Call in the same update that makes `to` the owner.
  const follow = useCallback(
    (to) => {
      const { pageKey: key, visibleId: id } = latest.current;
      stop();
      setBuffer(null);
      setCommitted({ id, owner: to, key, src: frameRef.current?.getAttribute("src") || undefined });
    },
    [frameRef, stop],
  );

  const bufferLoaded = useCallback(
    async (id) => {
      const mine = gen.current;
      const live = () => mine === gen.current && job.current?.bufferId === id;
      const win = bufferRef.current?.contentWindow;
      latest.current.onBufferLoad?.(win);
      const st = (await ask(frameRef.current?.contentWindow, { type: "swap-state" })) || job.current?.state;
      if (!live()) return;
      if (st?.pending) return swap(); // typed while this one loaded: save, load again
      await ask(win, { type: "scroll", y: st?.y || 0, height: st?.height || 0, view: st?.view || 0 }, SCROLL_MS);
      if (live()) commit(st, true);
    },
    [commit, frameRef, swap],
  );

  // A different page, the frame gone, or pageKey changed some other way (a Reload, the recovery
  // card): drop whatever was under way. `frames` below has already stopped rendering that buffer.
  useEffect(() => {
    stop();
    setBuffer(null);
    setRetiring(null);
  }, [owner, active, stop]);
  useEffect(() => {
    if (job.current?.bufferId && buffer && buffer.forKey !== pageKey) {
      stop();
      setBuffer(null);
    }
  }, [buffer, pageKey, stop]);
  useEffect(() => stop, [stop]);

  // The new frame is in frameRef now, on top of the old one. Once it says it has painted there,
  // and the app has too, the old one goes.
  useLayoutEffect(() => {
    const l = landing.current;
    if (!l || !committed || committed.id !== l.id) return;
    landing.current = null;
    if (l.loaded) latest.current.onVisibleLoad?.();
    if (l.focus) {
      try {
        frameRef.current?.focus();
        frameRef.current?.contentWindow?.focus();
      } catch {
        /* frame gone */
      }
    }
    if (l.focus && l.caret && l.loaded) send(frameRef.current?.contentWindow, { quire: 1, type: "swap-caret", caret: l.caret });
    ask(frameRef.current?.contentWindow, { type: "swap-painted" }, PAINTED_MS).then(() => {
      let raf = 0;
      const done = () => {
        cancelAnimationFrame(raf);
        clearTimeout(timer);
        setRetiring((r) => (r && r.id === l.oldId ? null : r));
      };
      const timer = setTimeout(done, RETIRE_MS);
      raf = requestAnimationFrame(() => {
        raf = requestAnimationFrame(done);
      });
    });
  }, [committed, frameRef]);

  const onFrameLoad = (id, event) => {
    if (event?.currentTarget?.dataset) event.currentTarget.dataset.qLoaded = "1";
    if (job.current?.bufferId === id) return void bufferLoaded(id);
    if (id !== latest.current.visibleId) return;
    latest.current.onVisibleLoad?.();
    const u = unrestored.current;
    if (u && u.id === id) {
      unrestored.current = null;
      if (u.state) send(frameRef.current?.contentWindow, { quire: 1, type: "scroll", seq: 0, y: u.state.y, height: u.state.height, view: u.state.view });
    }
  };

  const frames = [];
  const hasBuffer = buffer && buffer.owner === owner && buffer.forKey === pageKey;
  const hasRetiring = retiring && retiring.owner === owner && retiring.id !== visibleId;
  if (owner) {
    if (hasRetiring) frames.push({ id: retiring.id, role: "retiring", ref: null, style: RETIRING_STYLE, hidden: true });
    frames.push({ id: visibleId, role: "visible", ref: frameRef, style: hasRetiring ? ON_TOP_STYLE : undefined, hidden: false, src: committed?.id === visibleId ? committed.src : undefined });
    if (hasBuffer) frames.push({ id: buffer.id, role: "buffer", ref: bufferRef, style: BUFFER_STYLE, hidden: true });
    for (const f of frames) f.onLoad = (e) => onFrameLoad(f.id, e);
  }

  const isBuffer = useCallback((source) => !!source && bufferRef.current?.contentWindow === source, []);
  const bufferWindow = useCallback(() => bufferRef.current?.contentWindow || null, []);

  return { frames, swap, follow, isBuffer, bufferWindow, loadKey: hasBuffer ? buffer.id : visibleId };
}
