import { Canvas } from "@react-three/fiber";
import { useEffect, useRef, useState } from "react";
import * as THREE from "three";
import { loadAssets, loadFonts } from "./assets";
import { connectOffline, connectOnline, fetchStatus, initRapier, wakeServer, type Conn } from "./net/connection";
import { GameScene } from "./game/Game";
import { useUI } from "./game/store";
import { audio } from "./game/audio";
import { typing } from "./game/input";
import { Hud } from "./ui/Hud";

function randomPlayerName() {
  try {
    const saved = localStorage.getItem("blastside.player");
    if (saved) return saved;
    const n = `player-${100 + Math.floor(Math.random() * 900)}`;
    localStorage.setItem("blastside.player", n);
    return n;
  } catch { return `player-${100 + Math.floor(Math.random() * 900)}`; }
}

const embed = (new URLSearchParams(location.search).has("embed") || location.protocol === "quire:");
(window as any).__ui = useUI;
const forceOffline = new URLSearchParams(location.search).has("offline");

export function App() {
  const [conn, setConn] = useState<Conn | null>(null);
  const [ready, setReady] = useState(false);
  const overlayRef = useRef<HTMLDivElement>(null);
  const hostRef = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(true);
  const set = useUI((s) => s.set);

  // App is only imported once the player clicks Play (main.tsx), so going online here is expected.
  // Join flow: fonts, assets + physics in parallel with the server check; silently fall back to offline.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const name = randomPlayerName();
      set({ name, joinStatus: "Joining" });
      loadFonts();
      const assetsP = loadAssets();
      await initRapier();
      let c: Conn | null = null;
      if (!forceOffline) {
        const st = await fetchStatus(4000);
        if (st) {
          set({ serverPlaying: st.playing, serverAwake: st.awake });
          if (!st.awake) {
            set({ joinStatus: "Waking the server" });
            await wakeServer(20000);
          }
          try { c = await connectOnline(name, undefined, 10000); } catch (e) { console.warn("[bs] online join failed", e); }
        }
      }
      if (!c) c = await connectOffline(name, undefined);
      await assetsP;
      if (cancelled) { c.leave(); return; }
      c.onClose = () => {
        // lost the server mid-game: quietly continue offline
        setConn(null);
        connectOffline(name, undefined).then((o) => setConn(o));
      };
      setConn(c);
      set({ screen: "game", mode: c.mode, joinStatus: "", menu: true });
      setReady(true);
    })();
    return () => { cancelled = true; };
  }, [set]);

  // Pause rendering when hidden or scrolled off (embeds): <10% visible or tab hidden.
  useEffect(() => {
    const el = hostRef.current;
    if (!el) return;
    let ratio = 1;
    const update = () => {
      const v = document.visibilityState === "visible" && ratio >= 0.1;
      setVisible(v);
      if (!v) { if (document.pointerLockElement) document.exitPointerLock(); useUI.getState().set({ menu: true }); }
    };
    const io = new IntersectionObserver((entries) => { for (const e of entries) ratio = e.intersectionRatio; update(); }, { threshold: [0, 0.1, 0.2, 1] });
    io.observe(el);
    document.addEventListener("visibilitychange", update);
    return () => { io.disconnect(); document.removeEventListener("visibilitychange", update); };
  }, []);

  useEffect(() => { conn?.setPaused(!visible); audio.setSuspended(!visible); }, [visible, conn]);
  // Unlock audio on the first click or key anywhere (the same click that captures the mouse); while
  // playing, M mutes and F toggles full screen (a key press is a user gesture, so the click stays
  // free for pointer lock).
  useEffect(() => {
    const unlock = () => audio.init();
    const key = (e: KeyboardEvent) => {
      audio.init();
      if (typing(e) || e.metaKey || e.ctrlKey || e.altKey || !useUI.getState().locked) return;
      if (e.code === "KeyM") useUI.getState().set({ muted: audio.toggleMute() });
      if (e.code === "KeyF" && !e.repeat) {
        if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
        else (document.getElementById("root") ?? document.documentElement).requestFullscreen?.().catch(() => {});
      }
    };
    window.addEventListener("pointerdown", unlock, true);
    window.addEventListener("keydown", key, true);
    return () => { window.removeEventListener("pointerdown", unlock, true); window.removeEventListener("keydown", key, true); };
  }, []);

  const dpr = embed ? 1 : Math.min(1.5, window.devicePixelRatio || 1);

  return (
    <div ref={hostRef} className={`app${embed ? " embed" : ""}`}>
      {ready && conn && (
        <Canvas
          className="canvas"
          frameloop={visible ? "always" : "never"}
          shadows={{ type: THREE.PCFSoftShadowMap }}
          dpr={dpr}
          gl={{ antialias: false, powerPreference: "high-performance", stencil: false, preserveDrawingBuffer: new URLSearchParams(location.search).has("capture") }}
          camera={{ fov: 70, near: 0.1, far: 2000, position: [0, 10, 30] }}
          onPointerDown={() => audio.init()}
        >
          <GameScene key={conn.mode + conn.roomName} conn={conn} overlay={overlayRef.current!} />
        </Canvas>
      )}
      <div ref={overlayRef} className="overlay">
        <div className="dmgarcs" />
        <div className="hitmarker"><i /><i /><i /><i /></div>
      </div>
      <Hud ready={ready} />
    </div>
  );
}
