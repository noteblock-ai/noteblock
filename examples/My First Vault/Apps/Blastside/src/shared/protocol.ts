// Wire format. Messages ride Colyseus (msgpack); the 20 Hz snapshot is a packed binary blob.
import type { WeaponId } from "./constants.js";

export const ROOM_NAME = "arena";

/** Client -> server, 30 Hz. */
export interface StateMsg {
  s: number; // seq
  t: number; // client's estimate of server time (ms)
  p: [number, number, number];
  v: [number, number, number];
  y: number; // yaw
  pi: number; // pitch
  f: number; // flags: PF_*
  w: WeaponId;
}

/** Client -> server, one per shot. */
export interface FireMsg {
  t: number; // estimated server time of the shot (ms)
  w: WeaponId;
  o: [number, number, number]; // camera origin
  d: [number, number, number]; // camera forward (unit)
  m: [number, number, number]; // muzzle position
  seed: number;
  sp: number; // spread degrees at fire time (client bloom), clamped by server
}

export interface JoinOptions {
  name: string;
  suit?: number;
  v: number; // protocol version
}
export const PROTOCOL_VERSION = 1;

// Player flags (snapshot + state)
export const PF_ALIVE = 1;
export const PF_GROUNDED = 2;
export const PF_AIM = 4;
export const PF_DASH = 8;
export const PF_RELOAD = 16;
export const PF_SHIELD = 32;
export const PF_GLOW = 64;
export const PF_PROTECT = 128;
export const PF_BOT = 256;
export const PF_FIRE = 512; // fired since last snapshot
export const PF_LAUNCHED = 1024;
export const PF_AWAY = 2048;
export const PF_CROUCH = 4096;

export type Phase = "warmup" | "match" | "overtime" | "results";

export interface RosterEntry {
  id: number; // slot
  sid: string; // session id ("" for bots)
  name: string;
  suit: number;
  bot: boolean;
  k: number;
  d: number;
  score: number;
  streak: number;
  best: number;
  ping: number;
}

export interface MetaMsg {
  phase: Phase;
  ends: number; // server ms
  room: string;
  roster: RosterEntry[];
  winner?: number;
  pickups: number[]; // server ms when each pickup is back (0 = up)
  arcHolder: number; // slot or -1
}

export type GameEvent =
  | { e: "shot"; p: number; w: WeaponId; m: [number, number, number]; h: [number, number, number][] }
  | { e: "hit"; by: number; to: number; dmg: number; at: [number, number, number]; head: boolean; kill: boolean; shield: boolean; brk: boolean }
  | { e: "ko"; v: number; k: number; w: WeaponId | -1; fall: boolean; dir: [number, number, number]; self: boolean; pts: number }
  | { e: "boom"; at: [number, number, number]; by: number }
  | { e: "kb"; to: number; dv: [number, number, number] }
  | { e: "pick"; i: number; by: number }
  | { e: "spawn"; p: number; at: [number, number, number] }
  | { e: "corr"; p: [number, number, number] }
  | { e: "horn"; phase: Phase }
  | { e: "emote"; p: number; id: number };

export interface PlayerSnap {
  id: number;
  f: number;
  x: number; y: number; z: number;
  vx: number; vy: number; vz: number;
  yaw: number; pitch: number;
  w: WeaponId;
  hp: number;
  sh: number;
  ammo: number;
  arc: number;
}

export interface Snapshot {
  t: number; // server ms
  players: PlayerSnap[];
  grenades: { id: number; x: number; y: number; z: number }[];
  props: { i: number; x: number; y: number; z: number; qx: number; qy: number; qz: number; qw: number }[];
}

const P_BYTES = 1 + 2 + 6 + 6 + 2 + 2 + 1 + 1 + 1 + 1 + 1;

export function encodeSnapshot(s: Snapshot): Uint8Array {
  const size = 8 + 1 + s.players.length * P_BYTES + 1 + s.grenades.length * 8 + 1 + s.props.length * 11;
  const buf = new ArrayBuffer(size);
  const v = new DataView(buf);
  let o = 0;
  v.setFloat64(o, s.t, true); o += 8;
  v.setUint8(o++, s.players.length);
  const cm = (n: number) => Math.max(-32767, Math.min(32767, Math.round(n * 100)));
  for (const p of s.players) {
    v.setUint8(o++, p.id);
    v.setUint16(o, p.f, true); o += 2;
    v.setInt16(o, cm(p.x), true); o += 2; v.setInt16(o, cm(p.y), true); o += 2; v.setInt16(o, cm(p.z), true); o += 2;
    v.setInt16(o, cm(p.vx), true); o += 2; v.setInt16(o, cm(p.vy), true); o += 2; v.setInt16(o, cm(p.vz), true); o += 2;
    const yaw = ((p.yaw % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2);
    v.setUint16(o, Math.round((yaw / (Math.PI * 2)) * 65535), true); o += 2;
    v.setInt16(o, Math.round((p.pitch / Math.PI) * 32767), true); o += 2;
    v.setUint8(o++, p.w);
    v.setUint8(o++, Math.max(0, Math.min(255, Math.round(p.hp))));
    v.setUint8(o++, Math.max(0, Math.min(255, Math.round(p.sh))));
    v.setUint8(o++, Math.max(0, Math.min(255, p.ammo)));
    v.setUint8(o++, Math.max(0, Math.min(255, p.arc)));
  }
  v.setUint8(o++, s.grenades.length);
  for (const g of s.grenades) {
    v.setUint16(o, g.id & 0xffff, true); o += 2;
    v.setInt16(o, cm(g.x), true); o += 2; v.setInt16(o, cm(g.y), true); o += 2; v.setInt16(o, cm(g.z), true); o += 2;
  }
  v.setUint8(o++, s.props.length);
  const q = (n: number) => Math.round(Math.max(-1, Math.min(1, n)) * 127);
  for (const p of s.props) {
    v.setUint8(o++, p.i);
    v.setInt16(o, cm(p.x), true); o += 2; v.setInt16(o, cm(p.y), true); o += 2; v.setInt16(o, cm(p.z), true); o += 2;
    v.setInt8(o++, q(p.qx)); v.setInt8(o++, q(p.qy)); v.setInt8(o++, q(p.qz)); v.setInt8(o++, q(p.qw));
  }
  return new Uint8Array(buf);
}

export function decodeSnapshot(u8: Uint8Array): Snapshot {
  const v = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  let o = 0;
  const t = v.getFloat64(o, true); o += 8;
  const n = v.getUint8(o++);
  const players: PlayerSnap[] = [];
  for (let i = 0; i < n; i++) {
    const id = v.getUint8(o++);
    const f = v.getUint16(o, true); o += 2;
    const x = v.getInt16(o, true) / 100; o += 2; const y = v.getInt16(o, true) / 100; o += 2; const z = v.getInt16(o, true) / 100; o += 2;
    const vx = v.getInt16(o, true) / 100; o += 2; const vy = v.getInt16(o, true) / 100; o += 2; const vz = v.getInt16(o, true) / 100; o += 2;
    const yaw = (v.getUint16(o, true) / 65535) * Math.PI * 2; o += 2;
    const pitch = (v.getInt16(o, true) / 32767) * Math.PI; o += 2;
    const w = v.getUint8(o++) as WeaponId;
    const hp = v.getUint8(o++), sh = v.getUint8(o++), ammo = v.getUint8(o++), arc = v.getUint8(o++);
    players.push({ id, f, x, y, z, vx, vy, vz, yaw, pitch, w, hp, sh, ammo, arc });
  }
  const gn = v.getUint8(o++);
  const grenades = [];
  for (let i = 0; i < gn; i++) {
    const id = v.getUint16(o, true); o += 2;
    const x = v.getInt16(o, true) / 100; o += 2; const y = v.getInt16(o, true) / 100; o += 2; const z = v.getInt16(o, true) / 100; o += 2;
    grenades.push({ id, x, y, z });
  }
  const pn = v.getUint8(o++);
  const props = [];
  for (let k = 0; k < pn; k++) {
    const i = v.getUint8(o++);
    const x = v.getInt16(o, true) / 100; o += 2; const y = v.getInt16(o, true) / 100; o += 2; const z = v.getInt16(o, true) / 100; o += 2;
    let qx = v.getInt8(o++) / 127, qy = v.getInt8(o++) / 127, qz = v.getInt8(o++) / 127, qw = v.getInt8(o++) / 127;
    const l = Math.hypot(qx, qy, qz, qw) || 1;
    qx /= l; qy /= l; qz /= l; qw /= l;
    props.push({ i, x, y, z, qx, qy, qz, qw });
  }
  return { t, players, grenades, props };
}

/** Deterministic PRNG so the client draws the same pellets the server scores. */
export function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Spread a unit direction by a random cone of `deg`, returning directions for each pellet. */
export function spreadDirs(d: [number, number, number], deg: number, count: number, seed: number): [number, number, number][] {
  const rnd = mulberry32(seed);
  // basis
  const up: [number, number, number] = Math.abs(d[1]) > 0.95 ? [1, 0, 0] : [0, 1, 0];
  let rx = up[1] * d[2] - up[2] * d[1], ry = up[2] * d[0] - up[0] * d[2], rz = up[0] * d[1] - up[1] * d[0];
  const rl = Math.hypot(rx, ry, rz); rx /= rl; ry /= rl; rz /= rl;
  const ux = d[1] * rz - d[2] * ry, uy = d[2] * rx - d[0] * rz, uz = d[0] * ry - d[1] * rx;
  const out: [number, number, number][] = [];
  const maxA = (deg * Math.PI) / 180;
  for (let i = 0; i < count; i++) {
    // uniform in disc (pellets: first one through centre-ish)
    const a = Math.sqrt(rnd()) * maxA * (count > 1 && i === 0 ? 0.25 : 1);
    const th = rnd() * Math.PI * 2;
    const s = Math.tan(a);
    let x = d[0] + (rx * Math.cos(th) + ux * Math.sin(th)) * s;
    let y = d[1] + (ry * Math.cos(th) + uy * Math.sin(th)) * s;
    let z = d[2] + (rz * Math.cos(th) + uz * Math.sin(th)) * s;
    const l = Math.hypot(x, y, z);
    out.push([x / l, y / l, z / l]);
  }
  return out;
}
