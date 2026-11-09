import { useEffect, useState } from "react";
import { EMOTES, RULES, SUITS, WEAPONS, type RosterEntry } from "@blastside/shared";
import { audio } from "../game/audio";
import { saveSettings } from "../game/store";
import { useUI } from "../game/store";

// Weapon glyphs: flat silhouettes, 24x10 viewBox.
export function Glyph({ w, className }: { w: number; className?: string }) {
  const paths: Record<number, string> = {
    0: "M1 4h14l2-2h4v2h2v2h-6l-1 1h-4l-1 3H8l1-3H4L1 6z", // rifle
    1: "M1 3h16l1-1h4v5h-5l-2 1h-3l-1 2H8l1-2H1z", // scatter
    2: "M2 2h12a3 3 0 0 1 3 3v0a3 3 0 0 1-3 3h-2l-1 2H8l1-2H2z M17 4h5v2h-5z", // arc
    [-1]: "M12 1v5M9 4l3 3 3-3M4 9h16", // fall
  };
  return (
    <svg className={`glyph ${className ?? ""}`} viewBox="0 0 24 10" aria-hidden="true">
      {w === -1 ? <path d={paths[-1]} fill="none" stroke="currentColor" strokeWidth="1.6" /> : <path d={paths[w] ?? paths[0]} fill="currentColor" />}
    </svg>
  );
}

const fmt = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;

function useNow(ms = 250) {
  const [, f] = useState(0);
  useEffect(() => { const t = setInterval(() => f((x) => x + 1), ms); return () => clearInterval(t); }, [ms]);
}

function serverNow() {
  return window.__bs ? window.__bs.conn.serverNow() : Date.now();
}

function Segments({ value, max, count, className }: { value: number; max: number; count: number; className: string }) {
  const per = max / count;
  return (
    <div className={`segs ${className}`}>
      {Array.from({ length: count }, (_, i) => {
        const fill = Math.max(0, Math.min(1, (value - i * per) / per));
        return <span key={i}><b style={{ transform: `scaleX(${fill})` }} /></span>;
      })}
    </div>
  );
}

function TopCenter() {
  useNow(250);
  const meta = useUI((s) => s.meta);
  const me = useUI((s) => s.mySlot);
  if (!meta) return null;
  const left = Math.max(0, (meta.ends - serverNow()) / 1000);
  const sorted = [...meta.roster].sort((a, b) => b.score - a.score || a.d - b.d);
  const mine = meta.roster.find((r) => r.id === me);
  const leader = sorted.find((r) => r.id !== me) ?? sorted[0];
  const iLead = mine && sorted[0]?.id === me;
  const label = meta.phase === "warmup" ? "Warm-up" : meta.phase === "overtime" ? "Overtime" : meta.phase === "results" ? "Round over" : `First to ${RULES.scoreToWin}`;
  return (
    <div className="topc">
      <div className="score you">
        <em>{mine?.score ?? 0}</em>
        <small>You</small>
      </div>
      <div className="clock">
        <strong>{fmt(left)}</strong>
        <small>{label}</small>
      </div>
      <div className="score">
        <em>{leader?.score ?? 0}</em>
        <small>{iLead ? leader?.name ?? "—" : `${leader?.name ?? "—"}`}</small>
      </div>
    </div>
  );
}

function KillFeed() {
  useNow(500);
  const rows = useUI((s) => s.killfeed);
  const now = performance.now();
  const small = useUI((s) => s.small);
  const live = rows.filter((r) => now - r.t < 6000).slice(small ? -2 : -5);
  return (
    <ul className="feed">
      {live.map((r) => (
        <li key={r.id} className={r.you ? "you" : ""}>
          {r.self || !r.killer ? (
            <>
              <span className="n" style={{ color: SUITS[r.victimSuit % SUITS.length].color }}>{r.victim}</span>
              <Glyph w={-1} />
            </>
          ) : (
            <>
              <span className="n" style={{ color: SUITS[r.killerSuit % SUITS.length].color }}>{r.killer}</span>
              <Glyph w={r.fall ? -1 : r.weapon} />
              <span className="n" style={{ color: SUITS[r.victimSuit % SUITS.length].color }}>{r.victim}</span>
            </>
          )}
        </li>
      ))}
    </ul>
  );
}

function Vitals() {
  const hud = useUI((s) => s.hud);
  return (
    <div className="vitals">
      <div className="hpnum">
        <em className={hud.hp < 30 ? "low" : ""}>{Math.max(0, Math.round(hud.hp))}</em>
        {hud.shield > 0 && <span className="sh">+{Math.round(hud.shield)}</span>}
      </div>
      <Segments value={hud.shield} max={RULES.maxShield} count={5} className="shield" />
      <Segments value={hud.hp} max={RULES.maxHealth} count={10} className="hp" />
    </div>
  );
}

function Ammo() {
  const hud = useUI((s) => s.hud);
  const ws = WEAPONS[hud.weapon];
  return (
    <div className="ammo">
      <div className="count">
        <em className={hud.ammo === 0 ? "empty" : ""}>{hud.ammo}</em>
        <span>/{hud.mag}</span>
      </div>
      <div className="wname">
        <Glyph w={hud.weapon} />
        {hud.reloading ? "Reloading" : ws.name}
      </div>
      <div className="slots">
        {[0, 1, 2].map((w) => (
          <span key={w} className={`${w === hud.weapon ? "on" : ""} ${w === 2 && hud.arc <= 0 ? "off" : ""}`}>{w + 1}</span>
        ))}
        <span className={`dash ${hud.dashReady >= 1 ? "ready" : ""}`}><b style={{ transform: `scaleX(${hud.dashReady})` }} /></span>
      </div>
    </div>
  );
}

function Crosshair() {
  const hud = useUI((s) => s.hud);
  const [spread, setSpread] = useState(0);
  useEffect(() => {
    let raf = 0;
    const tick = () => { const c = window.__bs as any; if (c) setSpread(c.crosshairSpread?.() ?? 0); raf = requestAnimationFrame(tick); };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, []);
  if (!hud.alive) return null;
  const gap = 5 + spread * 9;
  return (
    <div className={`xhair w${hud.weapon}`} style={{ ["--gap" as any]: `${gap}px` }}>
      <i className="t" /><i className="b" /><i className="l" /><i className="r" /><s />
    </div>
  );
}

function Toast() {
  useNow(200);
  const t = useUI((s) => s.toast);
  if (!t || performance.now() - t.t > 1800) return null;
  return <div className="toast" key={t.t}>{t.text}</div>;
}

function Death() {
  const hud = useUI((s) => s.hud);
  useNow(200);
  if (hud.alive) return null;
  return (
    <div className="death">
      <small>{hud.killedBy ? "Blasted by" : "Knocked out"}</small>
      <strong style={hud.killedBy ? { color: SUITS[hud.killedBySuit % SUITS.length].color } : undefined}>{hud.killedBy ?? "The fall"}</strong>
      {hud.killedBy && <span>{hud.killedBy} has {hud.killerHp} health</span>}
      <em>Back in {Math.max(1, Math.ceil(hud.respawnIn))}</em>
    </div>
  );
}

function Table({ rows, me, compact }: { rows: RosterEntry[]; me: number; compact?: boolean }) {
  return (
    <table className="board">
      <thead>
        <tr><th /><th className="l">Player</th><th>K</th><th>D</th><th>{compact ? "" : "Ping"}</th></tr>
      </thead>
      <tbody>
        {rows.map((r, i) => (
          <tr key={r.id} className={r.id === me ? "you" : ""}>
            <td className="rank">{i + 1}</td>
            <td className="l"><i style={{ background: SUITS[r.suit % SUITS.length].color }} />{r.name}{r.bot && <b className="tag">bot</b>}{r.id === me && <b className="tag you">you</b>}</td>
            <td>{r.score}</td>
            <td>{r.d}</td>
            <td className="ping">{compact ? "" : r.bot ? "—" : r.ping}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function Scoreboard() {
  const open = useUI((s) => s.scoreboard);
  const meta = useUI((s) => s.meta);
  const me = useUI((s) => s.mySlot);
  const mode = useUI((s) => s.mode);
  if (!open || !meta || meta.phase === "results") return null;
  const rows = [...meta.roster].sort((a, b) => b.score - a.score || a.d - b.d);
  return (
    <div className="sb">
      <header><span>{mode === "offline" ? "Offline" : meta.room}</span><span>{rows.filter((r) => !r.bot).length} / 16</span></header>
      <Table rows={rows} me={me} />
    </div>
  );
}

function Results() {
  useNow(250);
  const meta = useUI((s) => s.meta);
  const me = useUI((s) => s.mySlot);
  if (!meta || meta.phase !== "results") return null;
  const rows = [...meta.roster].sort((a, b) => b.score - a.score || a.d - b.d);
  const w = rows.find((r) => r.id === meta.winner) ?? rows[0];
  const left = Math.max(0, Math.ceil((meta.ends - serverNow()) / 1000));
  return (
    <div className="results">
      <small>Round over</small>
      <h1 style={{ color: w ? SUITS[w.suit % SUITS.length].color : undefined }}>{w ? (w.id === me ? "You win" : `${w.name} wins`) : "Draw"}</h1>
      <p>{w?.score ?? 0} knockouts</p>
      <Table rows={rows.slice(0, 8)} me={me} compact />
      <footer>Next round in {left}</footer>
    </div>
  );
}

function EmoteWheel() {
  const sel = useUI((s) => s.wheel);
  if (sel === null) return null;
  const n = EMOTES.length;
  const R = 118, r0 = 62;
  return (
    <div className="wheel">
      <svg viewBox="-160 -160 320 320" width="320" height="320">
        <circle r={R + 18} className="ring" />
        <circle r={r0 - 14} className="ring inner" />
        {EMOTES.map((e, i) => {
          const a0 = ((i - 0.5) / n) * Math.PI * 2 - Math.PI / 2, a1 = ((i + 0.5) / n) * Math.PI * 2 - Math.PI / 2;
          const p = (a: number, r: number) => `${Math.cos(a) * r},${Math.sin(a) * r}`;
          const d = `M${p(a0 + 0.02, r0)} L${p(a0 + 0.02, R + 14)} A${R + 14},${R + 14} 0 0 1 ${p(a1 - 0.02, R + 14)} L${p(a1 - 0.02, r0)} A${r0},${r0} 0 0 0 ${p(a0 + 0.02, r0)}Z`;
          const am = (i / n) * Math.PI * 2 - Math.PI / 2;
          return (
            <g key={e.id} className={i === sel ? "seg on" : "seg"}>
              <path d={d} />
              <text x={Math.cos(am) * ((R + r0) / 2 + 6)} y={Math.sin(am) * ((R + r0) / 2 + 6) + 5}>{e.name}</text>
              <text className="k" x={Math.cos(am) * (r0 + 2)} y={Math.sin(am) * (r0 + 2) + 4}>{i + 1}</text>
            </g>
          );
        })}
      </svg>
      <span className="hint">Release E</span>
    </div>
  );
}

function SoundToggle({ big }: { big?: boolean }) {
  const muted = useUI((s) => s.muted);
  const volume = useUI((s) => s.volume);
  const set = useUI((s) => s.set);
  const toggle = () => { const m = audio.toggleMute(); set({ muted: m }); };
  return (
    <div className={`sound${big ? " big" : ""}`} onMouseDown={(e) => e.stopPropagation()} onClick={(e) => e.stopPropagation()}>
      <button title="Sound (M)" onClick={toggle} aria-label={muted ? "Unmute" : "Mute"}>
        <svg viewBox="0 0 20 16" width="20" height="16"><path d="M2 5h3l5-4v14l-5-4H2z" fill="currentColor" />{muted ? <path d="M13 5l5 6M18 5l-5 6" stroke="currentColor" strokeWidth="1.6" /> : <path d="M13 4.5c1.6 1 1.6 6 0 7M15.5 2.5c3 2 3 9 0 11" stroke="currentColor" strokeWidth="1.4" fill="none" />}</svg>
      </button>
      {big && (
        <input type="range" min={0} max={1} step={0.05} value={muted ? 0 : volume} onChange={(e) => {
          const v = +e.target.value;
          audio.setVolume(v);
          if (audio.muted && v > 0) { audio.toggleMute(); set({ muted: false }); }
          set({ volume: v });
          const st = useUI.getState().settings; saveSettings({ ...st, volume: v }); set({ settings: { ...st, volume: v } });
        }} />
      )}
      {big && <span className="mk">M</span>}
    </div>
  );
}

function Versions() {
  const [server, setServer] = useState<string>("…");
  useEffect(() => {
    import("../net/connection").then(({ gameEndpoint }) => fetch(`${gameEndpoint()}/version`).then((r) => r.json()).then((j) => setServer(j.server?.server ?? (j.server?.asleep ? "asleep" : "?"))).catch(() => setServer("offline")));
  }, []);
  return <div className="versions">client {(import.meta.env.VITE_CLIENT_SHA as string) || "dev"} · server {server}</div>;
}

function Paused() {
  const menu = useUI((s) => s.menu);
  const locked = useUI((s) => s.locked);
  const screen = useUI((s) => s.screen);
  void locked;
  if (screen !== "game" || !menu) return null;
  // Click anywhere (except the sound controls) to resume: pointer lock is requested right here, inside the
  // user gesture, and the game resumes even if the browser refuses the lock (drag-to-look fallback).
  const resume = (e: React.MouseEvent) => {
    if ((e.target as HTMLElement).closest(".sound")) return;
    const c = window.__bs;
    if (!c) return;
    audio.init();
    c.input.lock();
    useUI.getState().set({ menu: false });
  };
  return (
    <div className="paused" onMouseDown={resume}>
      <strong>Click to play</strong>
      <ul>
        <li><kbd>WASD</kbd>move</li><li><kbd>Mouse</kbd>aim</li><li><kbd>Space</kbd>jump</li><li><kbd>Shift</kbd>dash</li><li><kbd>C</kbd>crouch</li>
        <li><kbd>R</kbd>reload</li><li><kbd>1 2 3</kbd>weapons</li><li><kbd>E</kbd>emotes</li><li><kbd>V</kbd>first person</li><li><kbd>Tab</kbd>scores</li><li><kbd>F</kbd>full screen</li><li><kbd>Esc</kbd>pause</li>
      </ul>
      <SoundToggle big />
      <Versions />
    </div>
  );
}

export function Hud({ ready }: { ready: boolean }) {
  const status = useUI((s) => s.joinStatus);
  const mode = useUI((s) => s.mode);
  const hud = useUI((s) => s.hud);
  const meta = useUI((s) => s.meta);
  const screen = useUI((s) => s.screen);
  const [small, setSmall] = useState(false);
  useEffect(() => {
    const f = () => { const s = window.innerHeight < 480; setSmall(s); useUI.getState().set({ small: s }); };
    f();
    window.addEventListener("resize", f);
    return () => window.removeEventListener("resize", f);
  }, []);
  if (!ready || screen !== "game") {
    return (
      <div className="hud loading">
        <div className="join"><span>{status || "Joining"}</span><i /></div>
      </div>
    );
  }
  const results = meta?.phase === "results";
  return (
    <div className={`hud${small ? " small" : ""}${hud.lowHp ? " lowhp" : ""}`}>
      {mode === "offline" && <div className="tagline">Offline</div>}
      {!results && <TopCenter />}
      {!results && <KillFeed />}
      {!results && hud.alive && <Vitals />}
      {!results && hud.alive && <Ammo />}
      {!results && <Crosshair />}
      <Toast />
      {!results && <Death />}
      <Scoreboard />
      <Results />
      <EmoteWheel />
      <Paused />
    </div>
  );
}
