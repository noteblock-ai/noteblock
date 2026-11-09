// A page that stopped responding or crashed: the heartbeat that notices (usePageHealth) and the
// card shown over the page area (RecoveryOverlay). See docs/contract.md, "Crashes, freezes and
// errors", and app/main/page-health.mjs for the main-process half.
import { useCallback, useEffect, useRef, useState } from "react";

const PING_MS = 1000;
const CHECK_MS = 250;
// Crash times per page src, across remounts: auto-reload stops after autoReloadLimit a minute.
const crashLog = new Map();

/**
 * Heartbeat for the page iframe in `frameRef`, showing `src`. Pings it every second (the page
 * runtime pongs, and passes the ping on to its embeds); when the pongs stop for
 * limits().unresponsiveSeconds, main checks the frame's process: alive but not running script
 * → "frozen", gone → "crashed" (or "oom"). `mountKey` changes whenever the iframe is re-created.
 * Returns {health, reload, wait}: health is null or {state, pages, seconds, error?}.
 */
export function usePageHealth({ api, frameRef, src, active, mountKey, onReload }) {
  const [health, setHealth] = useState(null);
  const st = useRef(null);
  const onReloadRef = useRef(onReload);
  onReloadRef.current = onReload;

  useEffect(() => {
    setHealth(null);
    if (!active || !src || !api.probePage) {
      st.current = null;
      return;
    }
    const s = { mounted: Date.now(), lastPong: 0, lastPing: 0, snoozed: 0, seq: 0, probing: false, health: null, alive: true, unresponsive: 5 };
    st.current = s;
    const set = (h) => {
      s.health = h;
      setHealth(h);
    };
    const since = () => Math.max(s.lastPong, s.mounted, s.snoozed);

    const onMessage = (e) => {
      const m = e.data;
      if (!m || typeof m !== "object" || m.quire !== 1 || m.type !== "pong") return;
      if (!frameRef.current || e.source !== frameRef.current.contentWindow) return;
      s.lastPong = Date.now();
      if (typeof m.heap === "number") s.heap = Math.max(s.heap || 0, m.heap);
      if (s.health && s.health.state === "frozen") set(null); // it came back by itself
    };
    window.addEventListener("message", onMessage);

    const ping = setInterval(() => {
      // Our own timers were held back (window hidden, machine asleep): start the clock again.
      const now = Date.now();
      if (s.lastPing && now - s.lastPing > 2500) s.snoozed = now;
      s.lastPing = now;
      try {
        frameRef.current?.contentWindow?.postMessage({ quire: 1, type: "ping", seq: ++s.seq, unresponsive: s.unresponsive }, "*");
      } catch {
        /* frame gone */
      }
    }, PING_MS);

    const check = setInterval(async () => {
      if (s.probing || s.health) return;
      if (Date.now() - since() < 1500) return;
      s.probing = true;
      try {
        const lim = await api.limits(); // read on every check: a Settings change applies at once
        s.unresponsive = lim.unresponsiveSeconds;
        // The probe itself waits up to a second, so start it a second early.
        if (Date.now() - since() < Math.max(1500, lim.unresponsiveSeconds * 1000 - 1000)) return;
        const p = await api.probePage(src);
        if (!s.alive || Date.now() - since() < 1500) return; // a pong landed meanwhile
        if (p.state === "ok") {
          s.lastPong = Date.now(); // answers script, just doesn't pong (no runtime)
          return;
        }
        if (p.state === "frozen") {
          set({ state: "frozen", pages: p.pages || [], seconds: Math.round((Date.now() - since()) / 1000) });
          return;
        }
        // Out of memory: main saw its process at 1.5 GB+, or its JS heap (from the pongs) was over half its limit.
        const state = p.reason === "oom" || (s.heap || 0) > 0.5 ? "oom" : "crashed";
        const now = Date.now();
        const log = (crashLog.get(src) || []).filter((t) => now - t < 60000);
        if (lim.autoReloadCrashed && log.length < lim.autoReloadLimit) {
          crashLog.set(src, [...log, now]);
          onReloadRef.current();
          return;
        }
        crashLog.set(src, [...log, now]);
        set({ state, pages: [], autoReloaded: lim.autoReloadCrashed ? log.length : 0 });
      } catch (err) {
        console.error("[quire] page health check failed", err);
      } finally {
        s.probing = false;
      }
    }, CHECK_MS);

    return () => {
      s.alive = false;
      window.removeEventListener("message", onMessage);
      clearInterval(ping);
      clearInterval(check);
    };
  }, [api, frameRef, src, active, mountKey]);

  /** End a hung process first (a frozen frame can't be navigated from inside), then remount. */
  const recover = useCallback(async () => {
    const s = st.current;
    if (s && s.health && s.health.state === "frozen") {
      setHealth({ ...s.health, busy: true });
      try {
        await api.killPageProcess(src);
      } catch (err) {
        const h = { ...s.health, busy: false, error: String(err?.message || err) };
        s.health = h;
        setHealth(h);
        return false;
      }
    }
    return true;
  }, [api, src]);

  const reload = useCallback(async () => {
    if (await recover()) onReloadRef.current();
  }, [recover]);

  const wait = useCallback(() => {
    const s = st.current;
    if (!s) return;
    s.snoozed = Date.now();
    s.health = null;
    setHealth(null);
  }, []);

  return { health, reload, wait, recover };
}

const HEADLINE = { frozen: "stopped responding", crashed: "crashed", oom: "ran out of memory" };

/** The calm card over the page area. `titleFor(path)` names other pages on the same process. */
export function RecoveryOverlay({ health, title, page, titleFor, onReload, onOpenSource, onWait }) {
  if (!health) return null;
  const others = (health.pages || []).filter((p) => p !== page).map(titleFor);
  let detail;
  if (health.error) detail = health.error;
  else if (health.state === "frozen") {
    detail = `A script on this page has kept it busy for ${Math.max(1, health.seconds || 0)} seconds.`;
    if (others.length) detail += ` Also stuck: ${others.join(", ")}.`;
  } else if (health.state === "oom") detail = "It used more memory than a page can have, so its process was stopped.";
  else if (health.autoReloaded) detail = `It crashed ${health.autoReloaded + 1} times in the last minute, so it wasn't reloaded again.`;
  else detail = "Its process stopped unexpectedly. Your saved changes are safe.";
  return (
    <div className="recovery-backdrop">
      <div className="recovery-card" role="alertdialog" aria-labelledby="recovery-title" aria-describedby="recovery-detail">
        <h2 id="recovery-title">
          {title} {HEADLINE[health.state] || "stopped"}
        </h2>
        <p id="recovery-detail">{detail}</p>
        <div className="recovery-actions">
          <button type="button" className="settings-button is-primary" onClick={onReload} disabled={health.busy} autoFocus>
            Reload page
          </button>
          {onOpenSource ? (
            <button type="button" className="settings-button" onClick={onOpenSource} disabled={health.busy}>
              Open source
            </button>
          ) : null}
          {health.state === "frozen" ? (
            <button type="button" className="settings-button" onClick={onWait} disabled={health.busy}>
              Wait
            </button>
          ) : null}
        </div>
      </div>
    </div>
  );
}
