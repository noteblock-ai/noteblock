import { Client, type Room } from "colyseus.js";
import RAPIER from "@dimforge/rapier3d-compat";
import {
  MatchSim, decodeSnapshot, PROTOCOL_VERSION, ROOM_NAME, TICK_HZ, SNAP_HZ, OFFLINE_BOTS,
  type FireMsg, type GameEvent, type MetaMsg, type Snapshot, type StateMsg,
} from "@blastside/shared";

export interface Conn {
  mode: "online" | "offline";
  slot: number;
  roomName: string;
  rtt: number;
  serverNow(): number;
  sendState(m: StateMsg): void;
  sendFire(m: FireMsg): void;
  sendReload(): void;
  sendEmote(id: number): void;
  onSnap: (s: Snapshot) => void;
  onMeta: (m: MetaMsg) => void;
  onEvent: (e: GameEvent) => void;
  onClose: (code: number) => void;
  leave(): void;
  /** pause: offline sim stops; online keeps the socket (server marks you away) */
  setPaused(p: boolean): void;
}

const noop = () => {};

export function gameEndpoint(): string {
  const q = new URLSearchParams(location.search).get("server");
  if (q) return q;
  // VITE_SERVER_URL=https://play.noteblock.ai pnpm dev  -> dev client against the real server
  const env = import.meta.env.VITE_SERVER_URL as string | undefined;
  if (env) return env.replace(/^ws/, "http").replace(/\/$/, "") + (env.endsWith("/gs") ? "" : "/gs");
  if (location.protocol === "http:" || location.protocol === "https:") return `${location.origin}/gs`;
  return "https://play.noteblock.ai/gs"; // brand source: quire/core/brand.mjs
}

export interface ServerStatus { ok: boolean; awake: boolean; playing: number; rooms: number }

export async function fetchStatus(timeoutMs = 4000): Promise<ServerStatus | null> {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const r = await fetch(`${gameEndpoint()}/status`, { signal: ctl.signal, cache: "no-store" });
    if (!r.ok) return null;
    return (await r.json()) as ServerStatus;
  } catch {
    return null;
  } finally {
    clearTimeout(t);
  }
}

export async function wakeServer(timeoutMs = 25000): Promise<boolean> {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const r = await fetch(`${gameEndpoint()}/wake`, { method: "POST", signal: ctl.signal });
    return r.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(t);
  }
}

class OnlineConn implements Conn {
  mode = "online" as const;
  slot = -1;
  roomName = "";
  rtt = 80;
  private offsets: number[] = [];
  private offset = 0;
  onSnap: Conn["onSnap"] = noop;
  onMeta: Conn["onMeta"] = noop;
  onEvent: Conn["onEvent"] = noop;
  onClose: Conn["onClose"] = noop;
  private pingTimer: ReturnType<typeof setInterval> | undefined;
  constructor(private room: Room) {}

  init(welcome: { slot: number; room: string; t: number }) {
    this.slot = welcome.slot;
    this.roomName = welcome.room;
    this.offset = welcome.t - Date.now();
    this.room.onMessage("s", (b: Uint8Array) => this.onSnap(decodeSnapshot(b instanceof Uint8Array ? b : new Uint8Array(b))));
    this.room.onMessage("m", (m: MetaMsg) => this.onMeta(m));
    this.room.onMessage("e", (e: GameEvent) => this.onEvent(e));
    this.room.onMessage("po", (m: { c: number; s: number }) => {
      const now = performance.now();
      const rtt = now - m.c;
      this.rtt = this.rtt * 0.7 + rtt * 0.3;
      const off = m.s + rtt / 2 - (Date.now() - (now - m.c) / 2 - rtt / 2 + rtt / 2);
      this.offsets.push(m.s + rtt / 2 - Date.now());
      if (this.offsets.length > 5) this.offsets.shift();
      const sorted = [...this.offsets].sort((a, b) => a - b);
      this.offset = sorted[Math.floor(sorted.length / 2)];
      void off;
      this.room.send("ping", { ms: this.rtt });
    });
    this.room.onLeave((code) => { clearInterval(this.pingTimer); this.onClose(code); });
    const ping = () => this.room.send("p", { c: performance.now() });
    ping();
    setTimeout(ping, 300);
    setTimeout(ping, 700);
    this.pingTimer = setInterval(ping, 2000);
  }
  serverNow() { return Date.now() + this.offset; }
  sendState(m: StateMsg) { this.room.send("st", m); }
  sendFire(m: FireMsg) { this.room.send("f", m); }
  sendReload() { this.room.send("r"); }
  sendEmote(id: number) { this.room.send("em", { id }); }
  leave() { clearInterval(this.pingTimer); this.room.leave(true).catch(() => {}); }
  setPaused() {}
}

export async function connectOnline(name: string, suit: number | undefined, timeoutMs: number): Promise<Conn> {
  const client = new Client(gameEndpoint());
  const lab = new URLSearchParams(location.search).has("lab");
  const join = client.joinOrCreate(lab ? "arena_lab" : ROOM_NAME, { name, suit, v: PROTOCOL_VERSION });
  const room = await Promise.race([
    join,
    new Promise<never>((_, rej) => setTimeout(() => rej(new Error("timeout")), timeoutMs)),
  ]);
  const conn = new OnlineConn(room);
  const welcome = await new Promise<{ slot: number; room: string; t: number }>((res, rej) => {
    const t = setTimeout(() => rej(new Error("no welcome")), 5000);
    room.onMessage("welcome", (w) => { clearTimeout(t); res(w); });
  });
  conn.init(welcome);
  return conn;
}

/** Offline: the same MatchSim the server runs, with 5 bots, ticking in this page. */
class OfflineConn implements Conn {
  mode = "offline" as const;
  slot = -1;
  roomName = "Offline";
  rtt = 0;
  onSnap: Conn["onSnap"] = noop;
  onMeta: Conn["onMeta"] = noop;
  onEvent: Conn["onEvent"] = noop;
  onClose: Conn["onClose"] = noop;
  private sim: MatchSim;
  private timer: ReturnType<typeof setInterval>;
  private t0 = performance.now();
  private simTime = 0;
  private paused = false;
  private snapAcc = 0;
  private last = performance.now();
  private readonly sid = "local";
  constructor(name: string, suit: number | undefined) {
    this.sim = new MatchSim(RAPIER, { roomName: "Offline", botFill: OFFLINE_BOTS + 1, now: () => this.simTime, offline: true });
    const p = this.sim.addHuman(this.sid, name, suit)!;
    this.slot = p.slot;
    this.timer = setInterval(() => this.step(), 1000 / TICK_HZ);
    queueMicrotask(() => this.onMeta(this.sim.meta()));
  }
  private step() {
    const now = performance.now();
    let dt = Math.min(0.1, (now - this.last) / 1000);
    this.last = now;
    if (this.paused) return;
    this.simTime += dt * 1000;
    this.sim.tick(dt);
    for (const o of this.sim.drain()) this.onEvent(o.ev);
    this.snapAcc += dt;
    if (this.snapAcc >= 1 / SNAP_HZ - 0.002) {
      this.snapAcc = 0;
      // round-trip through the wire format so offline exercises the same decode path
      this.onSnap(decodeSnapshot(this.sim.snapshot()));
    }
    if (this.sim.metaDirty) { this.sim.metaDirty = false; this.onMeta(this.sim.meta()); }
    void this.t0;
  }
  serverNow() { return this.simTime; }
  sendState(m: StateMsg) { this.sim.onState(this.sid, m); }
  sendFire(m: FireMsg) { this.sim.onFire(this.sid, m); }
  sendReload() { this.sim.onReload(this.sid); }
  sendEmote(id: number) { this.sim.onEmote(this.sid, id); }
  leave() { clearInterval(this.timer); this.sim.dispose(); }
  setPaused(p: boolean) { this.paused = p; this.last = performance.now(); }
}

let rapierReady: Promise<void> | null = null;
export function initRapier() {
  if (!rapierReady) rapierReady = RAPIER.init();
  return rapierReady;
}

export async function connectOffline(name: string, suit: number | undefined): Promise<Conn> {
  await initRapier();
  return new OfflineConn(name, suit);
}
