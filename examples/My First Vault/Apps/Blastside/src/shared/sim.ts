// The match: authoritative rules, damage, grenades, pickups, props, bots.
// Runs inside the Colyseus room (server) and inside the page for offline play.
import type RAPIER_NS from "@dimforge/rapier3d-compat";
import {
  BOT_FILL, BOTS_VS_HUMANS, DEFAULT_BOT_DIFFICULTY, EMOTES, EMOTE_COOLDOWN_MS, GRENADE, HITBOX, MAX_REWIND_MS, MOVE, PICKUPS, ROOM_MAX, RULES, SUITS, WEAPONS, JUMP_VELOCITY,
  type Difficulty, type WeaponId,
} from "./constants.js";
import { createMapWorld, createProps, rayMap, G_GRENADE, G_MAP, G_PROP, groups, type PropBody, type Rapier, type World } from "./physics.js";
import { Motor, newMotorState, type MotorState, type MoveInput, MOTOR_EV_DASH } from "./movement.js";
import { PADS, PAD_RADIUS, PICKUP_DEFS, SPAWNS, type V3 } from "./map.js";
import {
  encodeSnapshot, spreadDirs, PF_AIM, PF_ALIVE, PF_BOT, PF_DASH, PF_FIRE, PF_GLOW, PF_GROUNDED, PF_PROTECT, PF_RELOAD, PF_SHIELD, PF_LAUNCHED, PF_AWAY, PF_CROUCH,
  type FireMsg, type GameEvent, type MetaMsg, type Phase, type RosterEntry, type StateMsg,
} from "./protocol.js";
import { BOT_NAMES } from "./names.js";
import { BotBrain } from "./bots.js";

export interface HistorySample { t: number; x: number; y: number; z: number }

export interface SimPlayer {
  slot: number;
  sid: string;
  name: string;
  suit: number;
  bot: boolean;
  x: number; y: number; z: number;
  vx: number; vy: number; vz: number;
  yaw: number; pitch: number;
  grounded: boolean; aim: boolean; dash: boolean; launched: boolean; crouch: boolean;
  alive: boolean;
  hp: number; shield: number;
  lastDamageT: number;
  respawnAt: number;
  protectUntil: number;
  weapon: WeaponId;
  ammo: [number, number, number];
  reloadUntil: number;
  reloadWeapon: WeaponId;
  nextFireT: number;
  bloom: number;
  k: number; d: number; score: number; streak: number; best: number;
  lastHitBy: number; lastHitT: number;
  history: HistorySample[];
  fired: boolean;
  ping: number;
  // humans
  lastAccept: { x: number; y: number; z: number; t: number };
  allowUntil: number;
  lastDashT: number;
  lastMsgT: number;
  msgWindowStart: number;
  msgCount: number;
  rejects: number;
  away: boolean;
  // bots
  motor?: Motor;
  ms?: MotorState;
  brain?: BotBrain;
  input?: MoveInput;
  recentDamage: { t: number; dmg: number }[];
  lastEmoteT: number;
}

export interface Grenade {
  id: number;
  owner: number;
  body: RAPIER_NS.RigidBody;
  fuseAt: number;
  bornT: number;
}

export interface Outgoing {
  /** session id to send to; undefined = everyone */
  to?: string;
  ev: GameEvent;
}

export interface SimOptions {
  roomName: string;
  botFill?: number;
  difficulty?: Difficulty;
  now?: () => number;
  /** local mode: snapshot all, no network validation for the single human */
  offline?: boolean;
}

const HIST_MS = 1000;

export class MatchSim {
  readonly R: Rapier;
  readonly world: World;
  readonly props: PropBody[];
  readonly players = new Map<number, SimPlayer>();
  readonly grenades: Grenade[] = [];
  readonly pickups: number[] = PICKUP_DEFS.map(() => 0); // ms when available (0 = available)
  arcHolder = -1;
  phase: Phase = "warmup";
  phaseEnds = 0;
  winner = -1;
  out: Outgoing[] = [];
  metaDirty = true;
  readonly opts: Required<Omit<SimOptions, "now">> & { now: () => number };
  private grenadeId = 1;
  private tSec = 0;
  private propSleepT: number[] = [];

  constructor(R: Rapier, opts: SimOptions) {
    this.R = R;
    this.opts = { difficulty: DEFAULT_BOT_DIFFICULTY, offline: false, now: () => Date.now(), ...opts, botFill: opts.botFill ?? BOT_FILL };
    const mp = createMapWorld(R);
    this.world = mp.world;
    this.props = createProps(R, this.world, false);
    this.phaseEnds = this.now() + RULES.warmupS * 1000;
    this.syncBots();
  }

  now() { return this.opts.now(); }

  // ---------- roster ----------
  private freeSlot(): number {
    for (let i = 0; i < 64; i++) if (!this.players.has(i)) return i;
    return -1;
  }
  humans() { return [...this.players.values()].filter((p) => !p.bot); }
  bots() { return [...this.players.values()].filter((p) => p.bot); }

  private newPlayer(slot: number, sid: string, name: string, suit: number, bot: boolean): SimPlayer {
    return {
      slot, sid, name, suit, bot, x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, yaw: 0, pitch: 0, grounded: true, aim: false, dash: false, launched: false, crouch: false,
      alive: false, hp: RULES.maxHealth, shield: 0, lastDamageT: 0, respawnAt: this.now() + 200, protectUntil: 0,
      weapon: 0, ammo: [WEAPONS[0].mag, WEAPONS[1].mag, 0], reloadUntil: 0, reloadWeapon: 0, nextFireT: 0, bloom: 0,
      k: 0, d: 0, score: 0, streak: 0, best: 0, lastHitBy: -1, lastHitT: 0, history: [], fired: false, ping: 0,
      lastAccept: { x: 0, y: 0, z: 0, t: 0 }, allowUntil: 0, lastDashT: -1e9, lastMsgT: this.now(), msgWindowStart: this.now(), msgCount: 0, rejects: 0, away: false,
      recentDamage: [],
      lastEmoteT: -1e9,
    };
  }

  addHuman(sid: string, name: string, suit?: number): SimPlayer | null {
    if (this.humans().length >= ROOM_MAX) return null;
    const slot = this.freeSlot();
    const used = new Set([...this.players.values()].map((p) => p.suit));
    let s = typeof suit === "number" && suit >= 0 && suit < SUITS.length && !used.has(suit) ? suit : -1;
    if (s < 0) for (let i = 0; i < SUITS.length; i++) if (!used.has(i)) { s = i; break; }
    if (s < 0) s = slot % SUITS.length;
    const p = this.newPlayer(slot, sid, name, s, false);
    p.respawnAt = this.now();
    this.players.set(slot, p);
    this.syncBots();
    this.metaDirty = true;
    return p;
  }

  removeHuman(sid: string) {
    for (const p of this.players.values()) if (p.sid === sid && !p.bot) {
      if (this.arcHolder === p.slot) this.dropArc(p);
      this.players.delete(p.slot);
    }
    this.syncBots();
    this.metaDirty = true;
  }

  bySid(sid: string) {
    for (const p of this.players.values()) if (p.sid === sid && !p.bot) return p;
    return undefined;
  }

  private syncBots() {
    const want = Math.max(0, this.opts.botFill - this.humans().length);
    const bots = this.bots();
    while (bots.length > want) {
      const b = bots.pop()!;
      if (this.arcHolder === b.slot) this.dropArc(b);
      b.motor?.dispose();
      this.players.delete(b.slot);
    }
    const usedNames = new Set([...this.players.values()].map((p) => p.name));
    let n = bots.length;
    while (n < want) {
      const slot = this.freeSlot();
      const name = BOT_NAMES.find((x) => !usedNames.has(x)) ?? `Bot${slot}`;
      usedNames.add(name);
      const used = new Set([...this.players.values()].map((p) => p.suit));
      let suit = 0;
      for (let i = 0; i < SUITS.length; i++) if (!used.has(i)) { suit = i; break; }
      const p = this.newPlayer(slot, "", name, suit, true);
      p.motor = new Motor(this.R, this.world, 0, -50 - slot * 3, 0);
      p.ms = newMotorState(0, -50, 0);
      p.brain = new BotBrain(this, p, this.opts.difficulty);
      p.input = { fwd: 0, right: 0, yaw: 0, jump: false, dash: false, aim: false };
      p.respawnAt = this.now() + 300 + Math.random() * 800;
      this.players.set(slot, p);
      n++;
    }
    this.metaDirty = true;
  }

  // ---------- inputs from humans ----------
  /** Returns false when the client should be kicked (flood). */
  rateCheck(p: SimPlayer): "ok" | "drop" | "kick" {
    const now = this.now();
    if (now - p.msgWindowStart > 1000) { p.msgWindowStart = now; p.msgCount = 0; }
    p.msgCount++;
    if (p.msgCount > 120) return "kick";
    if (p.msgCount > 40 + 10) return "drop"; // 30 Hz state + shots; small headroom
    return "ok";
  }

  onState(sid: string, m: StateMsg) {
    const p = this.bySid(sid);
    if (!p) return;
    p.lastMsgT = this.now();
    if (p.away) { p.away = false; this.metaDirty = true; }
    if (!p.alive) return;
    if (!Array.isArray(m.p) || m.p.length !== 3 || !m.p.every(Number.isFinite)) return;
    const now = this.now();
    p.yaw = Number.isFinite(m.y) ? m.y : p.yaw;
    p.pitch = Number.isFinite(m.pi) ? Math.max(-1.5, Math.min(1.5, m.pi)) : p.pitch;
    p.aim = !!(m.f & PF_AIM);
    p.grounded = !!(m.f & PF_GROUNDED);
    p.launched = !!(m.f & PF_LAUNCHED);
    p.crouch = !!(m.f & PF_CROUCH);
    const dashing = !!(m.f & PF_DASH);
    if (dashing && !p.dash) {
      if (now - p.lastDashT > (MOVE.dashCooldown - 0.3) * 1000) { p.lastDashT = now; p.allowUntil = Math.max(p.allowUntil, now + 400); }
    }
    p.dash = dashing;
    if (m.w === 0 || m.w === 1 || (m.w === 2 && p.ammo[2] > 0)) p.weapon = m.w;
    if (m.f & PF_RELOAD && p.reloadUntil < now && p.weapon !== 2) {
      const ws = WEAPONS[p.weapon];
      if (p.ammo[p.weapon] < ws.mag) {
        p.reloadUntil = now + ws.reloadS * 1000 * (ws.perShellReload ? 1 : 1);
        p.reloadWeapon = p.weapon;
      }
    }
    // Validate movement
    const la = p.lastAccept;
    const dt = Math.max(0.016, Math.min(0.5, (now - la.t) / 1000));
    const dx = m.p[0] - la.x, dy = m.p[1] - la.y, dz = m.p[2] - la.z;
    const horiz = Math.hypot(dx, dz);
    const allowance = now < p.allowUntil || this.nearPad(la.x, la.y, la.z) || p.launched;
    const maxH = allowance ? 40 * dt + 2.5 : 6.5 * dt + 0.6;
    const maxUp = allowance ? 30 * dt + 2 : JUMP_VELOCITY * dt + 0.8;
    let ok = horiz <= maxH && dy <= maxUp;
    if (ok && horiz + Math.abs(dy) > 0.05) {
      // Can't pass through walls: ray at chest height from the last accepted point.
      const len = Math.hypot(dx, dy, dz);
      const hit = rayMap(this.R, this.world, { x: la.x, y: la.y + 0.9, z: la.z }, { x: dx / len, y: dy / len, z: dz / len }, len);
      if (hit.toi < len - 0.35 && hit.collider && !this.isPropCollider(hit.collider)) ok = false;
    }
    if (ok) {
      p.x = m.p[0]; p.y = m.p[1]; p.z = m.p[2];
      if (Array.isArray(m.v) && m.v.length === 3) { p.vx = +m.v[0] || 0; p.vy = +m.v[1] || 0; p.vz = +m.v[2] || 0; }
      p.lastAccept = { x: p.x, y: p.y, z: p.z, t: now };
      p.rejects = 0;
    } else {
      p.rejects++;
      // Snap back (throttled)
      if (p.rejects === 1 || p.rejects % 10 === 0) this.out.push({ to: p.sid, ev: { e: "corr", p: [la.x, la.y, la.z] } });
      p.lastAccept.t = now;
    }
  }

  private isPropCollider(c: RAPIER_NS.Collider) {
    const b = c.parent();
    return !!b && this.props.some((pb) => pb.body.handle === b.handle);
  }

  private nearPad(x: number, y: number, z: number) {
    for (const pad of PADS) if ((x - pad.p[0]) ** 2 + (z - pad.p[2]) ** 2 < (PAD_RADIUS + 1.5) ** 2 && Math.abs(y - pad.p[1]) < 1.5) return true;
    return false;
  }

  onEmote(sid: string, id: number) {
    const p = this.bySid(sid);
    if (!p || !p.alive || !Number.isInteger(id) || id < 0 || id >= EMOTES.length) return;
    const now = this.now();
    if (now - p.lastEmoteT < EMOTE_COOLDOWN_MS) return;
    p.lastEmoteT = now;
    this.out.push({ ev: { e: "emote", p: p.slot, id } });
  }

  onReload(sid: string) {
    const p = this.bySid(sid);
    if (!p || !p.alive || p.weapon === 2) return;
    const ws = WEAPONS[p.weapon];
    if (p.ammo[p.weapon] < ws.mag && p.reloadUntil < this.now()) {
      p.reloadUntil = this.now() + ws.reloadS * 1000;
      p.reloadWeapon = p.weapon;
    }
  }

  onFire(sid: string, m: FireMsg) {
    const p = this.bySid(sid);
    if (!p || !p.alive) return;
    if (![m.o, m.d, m.m].every((a) => Array.isArray(a) && a.length === 3 && a.every(Number.isFinite))) return;
    const dl = Math.hypot(m.d[0], m.d[1], m.d[2]);
    if (dl < 0.5 || dl > 1.5) return;
    const d: V3 = [m.d[0] / dl, m.d[1] / dl, m.d[2] / dl];
    // origin/muzzle must be near the player
    const near = (a: V3, r: number) => Math.hypot(a[0] - p.x, a[1] - (p.y + 1.5), a[2] - p.z) < r;
    if (!near(m.o as V3, 4.5) || !near(m.m as V3, 2.5)) return;
    if (m.w !== 0 && m.w !== 1 && m.w !== 2) return;
    p.weapon = m.w;
    const t = Math.max(this.now() - MAX_REWIND_MS, Math.min(this.now(), +m.t || this.now()));
    this.fire(p, m.w, m.o as V3, d, m.m as V3, m.seed >>> 0, Math.max(0, Math.min(10, +m.sp || 0)), t);
  }

  // ---------- shooting ----------
  /** Shared by humans and bots. Returns false if the weapon couldn't fire. */
  fire(p: SimPlayer, w: WeaponId, o: V3, d: V3, muzzle: V3, seed: number, spreadDeg: number, rewindT: number): boolean {
    const now = this.now();
    const ws = WEAPONS[w];
    if (now + 25 < p.nextFireT) return false; // small tolerance for jitter
    if (p.reloadUntil > now && p.reloadWeapon === w && !ws.perShellReload) return false;
    if (p.ammo[w] <= 0) return false;
    if (ws.perShellReload && p.reloadUntil > now) p.reloadUntil = 0; // fire cancels shell reload
    p.ammo[w]--;
    p.nextFireT = Math.max(now, p.nextFireT) + 1000 / ws.rate;
    p.fired = true;
    if (p.protectUntil > now) p.protectUntil = 0; // spawn protection gone once you fire
    if (w === 2) {
      this.spawnGrenade(p, muzzle, d);
      if (p.ammo[2] <= 0) {
        this.arcHolder = -1;
        p.weapon = 0;
        this.pickups[this.arcIndex()] = now + PICKUPS.arcRespawnS * 1000;
        this.metaDirty = true;
      }
      return true;
    }
    const dirs = ws.pellets > 1 ? spreadDirs(d, Math.min(ws.spreadMaxDeg, spreadDeg || ws.spreadMaxDeg), ws.pellets, seed) : spreadDirs(d, Math.min(ws.spreadMaxDeg + 0.5, spreadDeg), 1, seed);
    const ends: V3[] = [];
    const dmgBy = new Map<number, { dmg: number; head: boolean; at: V3; dir: V3 }>();
    for (const dir of dirs) {
      const hit = this.trace(p, o, dir, muzzle, ws.range, rewindT);
      ends.push(hit.point);
      if (hit.victim) {
        const dist = Math.hypot(hit.point[0] - muzzle[0], hit.point[1] - muzzle[1], hit.point[2] - muzzle[2]);
        let f = 1;
        if (dist > ws.falloffStart) f = 1 - (1 - ws.falloffMin) * Math.min(1, (dist - ws.falloffStart) / (ws.falloffEnd - ws.falloffStart));
        // bots hit for less (skill knob), resolved by the same server trace as everyone else
        const dmg = ws.damage * f * (hit.head ? ws.headMult : 1) * (p.bot && p.brain ? p.brain.damageMul : 1);
        const cur = dmgBy.get(hit.victim.slot) ?? { dmg: 0, head: false, at: hit.point, dir };
        cur.dmg += dmg; cur.head ||= hit.head; cur.at = hit.point;
        dmgBy.set(hit.victim.slot, cur);
      }
    }
    this.out.push({ ev: { e: "shot", p: p.slot, w, m: [r2(muzzle[0]), r2(muzzle[1]), r2(muzzle[2])], h: ends.map((e) => [r2(e[0]), r2(e[1]), r2(e[2])] as V3) } });
    for (const [slot, h] of dmgBy) {
      const v = this.players.get(slot);
      if (!v) continue;
      if (p.bot && !v.bot) h.dmg = Math.min(h.dmg, BOTS_VS_HUMANS.damagePerHit * (w === 1 ? 2 : 1));
      this.damage(v, h.dmg, p, w, h.dir, h.head, h.at);
      if (w === 1 && v.alive) {
        // scatter knockback ~2 m/s at 4 m
        const dist = Math.hypot(v.x - p.x, v.z - p.z);
        const k = (WEAPONS[1].knockback ?? 0) * Math.max(0, Math.min(1.5, 4 / Math.max(1, dist))) * (h.dmg / 80);
        this.knock(v, [h.dir[0] * k, 0.5 * k, h.dir[2] * k]);
      }
    }
    return true;
  }

  /** Camera ray, then muzzle-to-point visibility. */
  trace(p: SimPlayer, o: V3, d: V3, muzzle: V3, range: number, rewindT: number): { point: V3; victim?: SimPlayer; head: boolean } {
    const exclude = p.motor?.collider;
    const m = rayMap(this.R, this.world, { x: o[0], y: o[1], z: o[2] }, { x: d[0], y: d[1], z: d[2] }, range, exclude);
    let best = Math.min(m.toi, range);
    let victim: SimPlayer | undefined;
    let head = false;
    for (const v of this.players.values()) {
      if (v === p || !v.alive) continue;
      const pos = this.posAt(v, rewindT);
      const k = v.crouch ? MOVE.crouchHeight / MOVE.capsuleHeight : 1;
      const hs = raySphere(o, d, [pos.x, pos.y + HITBOX.headY * k, pos.z], HITBOX.headRadius);
      if (hs < best) { best = hs; victim = v; head = true; }
      const bc = rayCapsule(o, d, [pos.x, pos.y + HITBOX.bodyBottom + HITBOX.bodyRadius, pos.z], [pos.x, pos.y + Math.max(HITBOX.bodyBottom + HITBOX.bodyRadius, (HITBOX.bodyTop - HITBOX.bodyRadius * 0.5) * k), pos.z], HITBOX.bodyRadius);
      if (bc < best) { best = bc; victim = v; head = false; }
    }
    let point: V3 = [o[0] + d[0] * best, o[1] + d[1] * best, o[2] + d[2] * best];
    // From the muzzle, the point must be visible (no shooting round corners).
    const mx = point[0] - muzzle[0], my = point[1] - muzzle[1], mz = point[2] - muzzle[2];
    const ml = Math.hypot(mx, my, mz);
    if (ml > 0.3) {
      const blk = rayMap(this.R, this.world, { x: muzzle[0], y: muzzle[1], z: muzzle[2] }, { x: mx / ml, y: my / ml, z: mz / ml }, ml - 0.05, exclude);
      if (blk.toi < ml - 0.15) {
        point = [muzzle[0] + (mx / ml) * blk.toi, muzzle[1] + (my / ml) * blk.toi, muzzle[2] + (mz / ml) * blk.toi];
        victim = undefined; head = false;
      }
    }
    return { point, victim, head };
  }

  posAt(v: SimPlayer, t: number) {
    const h = v.history;
    if (h.length === 0 || t >= h[h.length - 1].t) return { x: v.x, y: v.y, z: v.z };
    for (let i = h.length - 1; i > 0; i--) {
      const a = h[i - 1], b = h[i];
      if (a.t <= t && t <= b.t) {
        const k = (t - a.t) / Math.max(1, b.t - a.t);
        return { x: a.x + (b.x - a.x) * k, y: a.y + (b.y - a.y) * k, z: a.z + (b.z - a.z) * k };
      }
    }
    return { x: h[0].x, y: h[0].y, z: h[0].z };
  }

  damage(v: SimPlayer, amount: number, by: SimPlayer | null, w: WeaponId | -1, dir: V3, head: boolean, at: V3) {
    const now = this.now();
    if (!v.alive || v.protectUntil > now || this.phase === "results") return;
    let rest = amount;
    let shieldHit = false, broke = false;
    if (v.shield > 0) {
      shieldHit = true;
      const s = Math.min(v.shield, rest);
      v.shield -= s; rest -= s;
      if (v.shield <= 0) broke = true;
    }
    v.hp -= rest;
    v.lastDamageT = now;
    v.recentDamage.push({ t: now, dmg: amount });
    if (by && by !== v) { v.lastHitBy = by.slot; v.lastHitT = now; }
    const kill = v.hp <= 0;
    this.out.push({ ev: { e: "hit", by: by ? by.slot : -1, to: v.slot, dmg: Math.round(amount), at: [r2(at[0]), r2(at[1]), r2(at[2])], head, kill, shield: shieldHit, brk: broke } });
    v.brain?.onDamaged(by, amount);
    if (kill) this.knockout(v, by, w, dir, false);
  }

  knock(v: SimPlayer, dv: V3) {
    if (!v.alive) return;
    if (v.bot && v.motor && v.ms) v.motor.addImpulse(v.ms, dv[0], dv[1], dv[2]);
    else {
      v.allowUntil = this.now() + 1500;
      this.out.push({ to: v.sid, ev: { e: "kb", to: v.slot, dv: [r2(dv[0]), r2(dv[1]), r2(dv[2])] } });
    }
  }

  knockout(v: SimPlayer, by: SimPlayer | null, w: WeaponId | -1, dir: V3, fall: boolean) {
    if (!v.alive) return;
    const now = this.now();
    v.alive = false;
    v.hp = 0;
    v.respawnAt = now + RULES.respawnS * 1000;
    const scoring = this.phase === "match" || this.phase === "overtime";
    let killer = by;
    if (fall && !killer && v.lastHitBy >= 0 && now - v.lastHitT < RULES.fallCreditS * 1000) killer = this.players.get(v.lastHitBy) ?? null;
    const self = !killer || killer === v;
    const worth = v.streak >= RULES.streakGlow ? 2 : 1;
    if (scoring) {
      v.d++;
      if (self) v.score -= 1;
      else {
        killer!.k++;
        killer!.score += worth;
        killer!.streak++;
        killer!.best = Math.max(killer!.best, killer!.streak);
        // bots sometimes show off after a knockout
        if (killer!.bot && Math.random() < 0.22 && now - killer!.lastEmoteT > 6000) {
          killer!.lastEmoteT = now;
          const id = [0, 1, 2, 3][Math.floor(Math.random() * 4)];
          this.out.push({ ev: { e: "emote", p: killer!.slot, id } });
          killer!.brain?.pauseFor(EMOTES[id].loop ? 1800 : 1300);
        }
      }
    }
    v.streak = 0;
    if (this.arcHolder === v.slot) this.dropArc(v);
    this.out.push({ ev: { e: "ko", v: v.slot, k: self ? -1 : killer!.slot, w, fall, dir: [r2(dir[0]), r2(dir[1]), r2(dir[2])], self, pts: self ? -1 : worth } });
    v.brain?.onDied();
    this.metaDirty = true;
    if (scoring) this.checkWin();
  }

  private dropArc(p: SimPlayer) {
    p.ammo[2] = 0;
    if (p.weapon === 2) p.weapon = 0;
    this.arcHolder = -1;
    this.pickups[this.arcIndex()] = this.now() + PICKUPS.arcRespawnS * 1000;
    this.metaDirty = true;
  }

  arcIndex() { return PICKUP_DEFS.findIndex((d) => d.kind === "arc"); }

  // ---------- grenades ----------
  private spawnGrenade(p: SimPlayer, m: V3, d: V3) {
    const R = this.R;
    const body = this.world.createRigidBody(
      R.RigidBodyDesc.dynamic().setTranslation(m[0], m[1], m[2]).setLinvel(d[0] * GRENADE.speed + p.vx * 0.3, d[1] * GRENADE.speed + 1.5, d[2] * GRENADE.speed + p.vz * 0.3).setCcdEnabled(true).setAngularDamping(1),
    );
    this.world.createCollider(R.ColliderDesc.ball(GRENADE.radius).setRestitution(GRENADE.restitution).setFriction(0.6).setDensity(400).setCollisionGroups(groups(G_GRENADE, G_MAP | G_PROP)), body);
    this.grenades.push({ id: this.grenadeId++ & 0xffff, owner: p.slot, body, fuseAt: this.now() + GRENADE.fuseS * 1000, bornT: this.now() });
  }

  private explode(g: Grenade) {
    const t = g.body.translation();
    const c: V3 = [t.x, t.y, t.z];
    this.world.removeRigidBody(g.body);
    const owner = this.players.get(g.owner) ?? null;
    this.out.push({ ev: { e: "boom", at: [r2(c[0]), r2(c[1]), r2(c[2])], by: g.owner } });
    for (const v of [...this.players.values()]) {
      if (!v.alive) continue;
      const chest: V3 = [v.x, v.y + 0.9, v.z];
      const dx = chest[0] - c[0], dy = chest[1] - c[1], dz = chest[2] - c[2];
      const dist = Math.hypot(dx, dy, dz);
      if (dist > GRENADE.blastRadius) continue;
      if (dist > 0.3) {
        const blk = rayMap(this.R, this.world, { x: c[0], y: c[1], z: c[2] }, { x: dx / dist, y: dy / dist, z: dz / dist }, dist);
        if (blk.toi < dist - 0.3 && blk.collider && !this.isPropCollider(blk.collider)) continue;
      }
      const k = dist / GRENADE.blastRadius;
      let dmg = (GRENADE.maxDamage + (GRENADE.minDamage - GRENADE.maxDamage) * k) * (owner?.bot && owner.brain ? owner.brain.damageMul : 1);
      const self = v === owner;
      if (self) dmg *= GRENADE.selfMul;
      if (owner?.bot && !v.bot) dmg = Math.min(dmg, BOTS_VS_HUMANS.grenadeDamage);
      const hl = Math.hypot(dx, dz) || 1;
      const dir: V3 = [dx / hl, 0, dz / hl];
      const kf = 1 - k * 0.5;
      this.knock(v, [dir[0] * GRENADE.knockOut * kf, GRENADE.knockUp * kf + 2, dir[2] * GRENADE.knockOut * kf]);
      this.damage(v, dmg, self ? v : owner, 2, [dir[0], 0.4, dir[2]], false, chest);
    }
    // Props
    for (const pb of this.props) {
      const p = pb.body.translation();
      const dx = p.x - c[0], dy = p.y - c[1], dz = p.z - c[2];
      const dist = Math.hypot(dx, dy, dz);
      if (dist > GRENADE.blastRadius * 1.3) continue;
      const k = (1 - dist / (GRENADE.blastRadius * 1.3)) * pb.body.mass() * 10;
      const l = dist || 1;
      pb.body.applyImpulse({ x: (dx / l) * k, y: (Math.abs(dy / l) + 0.6) * k, z: (dz / l) * k }, true);
      pb.body.applyTorqueImpulse({ x: (Math.random() - 0.5) * k * 0.3, y: (Math.random() - 0.5) * k * 0.3, z: (Math.random() - 0.5) * k * 0.3 }, true);
    }
  }

  // ---------- tick ----------
  tick(dt: number) {
    const now = this.now();
    this.tSec += dt;
    this.phaseLogic(now);

    // Bots think and move
    for (const p of this.players.values()) {
      if (!p.bot || !p.motor || !p.ms || !p.input) continue;
      if (p.alive) {
        p.brain!.update(dt, now);
        const frozen = this.phase === "results";
        p.motor.step(p.ms, p.input, dt, this.tSec, frozen);
        if (p.ms.events & MOTOR_EV_DASH) p.lastDashT = now;
        p.x = p.ms.x; p.y = p.ms.y; p.z = p.ms.z;
        p.vx = p.ms.vx; p.vy = p.ms.vy; p.vz = p.ms.vz;
        p.grounded = p.ms.grounded; p.dash = this.tSec < p.ms.dashUntil; p.launched = p.ms.launched;
        p.aim = p.input.aim;
      }
    }

    // Physics: grenades + props
    this.world.timestep = dt;
    this.world.step();

    // Grenades: fuse or touch
    for (let i = this.grenades.length - 1; i >= 0; i--) {
      const g = this.grenades[i];
      const t = g.body.translation();
      let boom = now >= g.fuseAt || t.y < RULES.fallY;
      if (!boom && now - g.bornT > 60) {
        for (const v of this.players.values()) {
          if (!v.alive || (v.slot === g.owner && now - g.bornT < 400)) continue;
          const dx = v.x - t.x, dz = v.z - t.z, dy = v.y + 0.9 - t.y;
          if (dx * dx + dz * dz < GRENADE.touchRadius ** 2 && Math.abs(dy) < 1.1) { boom = true; break; }
        }
      }
      if (boom) {
        this.grenades.splice(i, 1);
        if (t.y < RULES.fallY) this.world.removeRigidBody(g.body);
        else this.explode(g);
      }
    }

    // Per-player upkeep
    for (const p of this.players.values()) {
      if (!p.alive) {
        if (now >= p.respawnAt && this.phase !== "results") this.respawn(p);
        continue;
      }
      // reload completes
      if (p.reloadUntil && now >= p.reloadUntil) {
        const ws = WEAPONS[p.reloadWeapon];
        if (ws.perShellReload) {
          p.ammo[p.reloadWeapon] = Math.min(ws.mag, p.ammo[p.reloadWeapon] + 1);
          p.reloadUntil = p.ammo[p.reloadWeapon] < ws.mag ? now + ws.reloadS * 1000 : 0;
        } else {
          p.ammo[p.reloadWeapon] = ws.mag;
          p.reloadUntil = 0;
        }
      }
      // regen (fast and to full when the last damage came from a bot)
      const lastBy = p.lastHitBy >= 0 ? this.players.get(p.lastHitBy) : undefined;
      if (!p.bot && (!lastBy || lastBy.bot) && now - p.lastDamageT > BOTS_VS_HUMANS.regenDelayS * 1000 && p.hp < RULES.maxHealth) p.hp = Math.min(RULES.maxHealth, p.hp + BOTS_VS_HUMANS.regenPerS * dt);
      else if (now - p.lastDamageT > RULES.regenDelayS * 1000 && p.hp < RULES.regenCap) p.hp = Math.min(RULES.regenCap, p.hp + RULES.regenPerS * dt);
      // fall
      if (p.y < RULES.fallY) { this.knockout(p, null, -1, [0, -1, 0], true); continue; }
      // pickups
      for (let i = 0; i < PICKUP_DEFS.length; i++) {
        if (this.pickups[i] !== 0) continue;
        const d = PICKUP_DEFS[i];
        if ((p.x - d.p[0]) ** 2 + (p.z - d.p[2]) ** 2 > PICKUPS.radius ** 2 || Math.abs(p.y - d.p[1]) > 1.6) continue;
        if (d.kind === "health" && p.hp < RULES.maxHealth) {
          p.hp = Math.min(RULES.maxHealth, p.hp + PICKUPS.healthAmount);
          this.pickups[i] = now + PICKUPS.healthRespawnS * 1000;
        } else if (d.kind === "shield" && p.shield < RULES.maxShield) {
          p.shield = Math.min(RULES.maxShield, p.shield + PICKUPS.shieldAmount);
          this.pickups[i] = now + PICKUPS.shieldRespawnS * 1000;
        } else if (d.kind === "arc" && this.arcHolder < 0) {
          p.ammo[2] = WEAPONS[2].mag;
          p.weapon = 2;
          this.arcHolder = p.slot;
          this.pickups[i] = Number.MAX_SAFE_INTEGER;
        } else continue;
        this.out.push({ ev: { e: "pick", i, by: p.slot } });
        this.metaDirty = true;
      }
      // history for lag comp
      p.history.push({ t: now, x: p.x, y: p.y, z: p.z });
      while (p.history.length && now - p.history[0].t > HIST_MS) p.history.shift();
      p.recentDamage = p.recentDamage.filter((r) => now - r.t < 1000);
      // idle humans
      if (!p.bot && !this.opts.offline && now - p.lastMsgT > 5000 && !p.away) { p.away = true; this.metaDirty = true; }
    }
    // pickups respawn
    for (let i = 0; i < this.pickups.length; i++) {
      if (this.pickups[i] !== 0 && this.pickups[i] !== Number.MAX_SAFE_INTEGER && now >= this.pickups[i]) {
        this.pickups[i] = 0;
        this.metaDirty = true;
      }
    }
  }

  private respawn(p: SimPlayer) {
    const now = this.now();
    const sp = this.pickSpawn(p);
    p.alive = true;
    p.hp = RULES.maxHealth;
    p.shield = 0;
    p.ammo = [WEAPONS[0].mag, WEAPONS[1].mag, 0];
    p.weapon = 0;
    p.reloadUntil = 0;
    p.protectUntil = now + RULES.spawnProtectS * 1000;
    p.lastHitBy = -1;
    p.x = sp[0]; p.y = sp[1]; p.z = sp[2];
    p.vx = p.vy = p.vz = 0;
    p.yaw = Math.atan2(sp[0], sp[2]); // face the centre
    p.history = [];
    p.lastAccept = { x: sp[0], y: sp[1], z: sp[2], t: now };
    p.allowUntil = now + 500;
    if (p.bot && p.motor && p.ms) {
      p.motor.teleport(p.ms, sp[0], sp[1], sp[2]);
      p.brain!.onSpawn();
    }
    this.out.push({ ev: { e: "spawn", p: p.slot, at: [r2(sp[0]), r2(sp[1]), r2(sp[2])] } });
  }

  /** Spawns whose capsule doesn't overlap map geometry (checked once). */
  private validSpawns: V3[] | null = null;
  private spawnList(): V3[] {
    if (!this.validSpawns) {
      const R = this.R;
      const shape = new R.Capsule(MOVE.capsuleHeight / 2 - MOVE.capsuleRadius, MOVE.capsuleRadius);
      this.validSpawns = SPAWNS.filter((s) => {
        let hit = false;
        this.world.intersectionsWithShape({ x: s[0], y: s[1] + MOVE.capsuleHeight / 2 + 0.05, z: s[2] }, { x: 0, y: 0, z: 0, w: 1 }, shape, () => { hit = true; return false; }, undefined, groups(0xffff, G_MAP));
        return !hit;
      });
      if (!this.validSpawns.length) this.validSpawns = SPAWNS;
    }
    return this.validSpawns;
  }

  private pickSpawn(p: SimPlayer): V3 {
    const enemies = [...this.players.values()].filter((o) => o !== p && o.alive);
    const list = this.spawnList();
    let best = list[Math.floor(Math.random() * list.length)];
    let bestScore = -Infinity;
    for (const s of list) {
      let nearest = Infinity;
      let seen = false;
      for (const e of enemies) {
        const dx = e.x - s[0], dy = e.y + 1.5 - (s[1] + 1.5), dz = e.z - s[2];
        const d = Math.hypot(dx, dy, dz);
        nearest = Math.min(nearest, d);
        if (d < 40) {
          const hit = rayMap(this.R, this.world, { x: s[0], y: s[1] + 1.5, z: s[2] }, { x: dx / d, y: dy / d, z: dz / d }, d);
          if (hit.toi >= d - 0.5) seen = true;
        }
      }
      const occupied = nearest < 2.5;
      const score = (seen ? -100 : 0) + (occupied ? -500 : 0) + Math.min(nearest, 60) + Math.random() * 4;
      if (score > bestScore) { bestScore = score; best = s; }
    }
    return best;
  }

  private phaseLogic(now: number) {
    if (now < this.phaseEnds) {
      return;
    }
    if (this.phase === "warmup") {
      this.startPhase("match");
      for (const p of this.players.values()) { p.k = p.d = p.score = p.streak = p.best = 0; }
      // everyone respawns fresh
      for (const p of this.players.values()) { if (p.alive) { p.alive = false; p.respawnAt = now; } }
    } else if (this.phase === "match") {
      const top = this.leaders();
      if (top.length > 1 && top[0].score > 0) this.startPhase("overtime");
      else this.endMatch(top[0]);
    } else if (this.phase === "overtime") {
      this.endMatch(this.leaders()[0]);
    } else if (this.phase === "results") {
      this.winner = -1;
      for (const p of this.players.values()) { p.k = p.d = p.score = p.streak = p.best = 0; p.alive = false; p.respawnAt = now; }
      for (let i = 0; i < this.pickups.length; i++) this.pickups[i] = 0;
      this.arcHolder = -1;
      this.startPhase("warmup");
    }
  }

  private startPhase(ph: Phase) {
    this.phase = ph;
    const s = ph === "warmup" ? RULES.warmupS : ph === "match" ? RULES.matchS : ph === "overtime" ? RULES.overtimeS : RULES.resultsS;
    this.phaseEnds = this.now() + s * 1000;
    this.metaDirty = true;
    this.out.push({ ev: { e: "horn", phase: ph } });
  }

  leaders() {
    const all = [...this.players.values()].sort((a, b) => b.score - a.score || a.d - b.d);
    if (!all.length) return [];
    return all.filter((p) => p.score === all[0].score);
  }

  private checkWin() {
    const top = this.leaders();
    if (!top.length) return;
    if (this.phase === "match" && top[0].score >= RULES.scoreToWin) this.endMatch(top[0]);
    else if (this.phase === "overtime" && top.length === 1) this.endMatch(top[0]);
  }

  private endMatch(w?: SimPlayer) {
    this.winner = w ? w.slot : -1;
    this.startPhase("results");
  }

  // ---------- output ----------
  snapshot(): Uint8Array {
    const now = this.now();
    const players = [...this.players.values()].map((p) => {
      let f = 0;
      if (p.alive) f |= PF_ALIVE;
      if (p.grounded) f |= PF_GROUNDED;
      if (p.aim) f |= PF_AIM;
      if (p.dash) f |= PF_DASH;
      if (p.reloadUntil > now) f |= PF_RELOAD;
      if (p.shield > 0) f |= PF_SHIELD;
      if (p.streak >= RULES.streakGlow) f |= PF_GLOW;
      if (p.protectUntil > now) f |= PF_PROTECT;
      if (p.bot) f |= PF_BOT;
      if (p.fired) f |= PF_FIRE;
      if (p.launched) f |= PF_LAUNCHED;
      if (p.away) f |= PF_AWAY;
      if (p.crouch) f |= PF_CROUCH;
      p.fired = false;
      return { id: p.slot, f, x: p.x, y: p.y, z: p.z, vx: p.vx, vy: p.vy, vz: p.vz, yaw: p.yaw, pitch: p.pitch, w: p.weapon, hp: Math.ceil(p.hp), sh: Math.ceil(p.shield), ammo: p.ammo[p.weapon], arc: p.ammo[2] };
    });
    const grenades = this.grenades.map((g) => { const t = g.body.translation(); return { id: g.id, x: t.x, y: t.y, z: t.z }; });
    const props = this.props.map((pb) => { const t = pb.body.translation(), q = pb.body.rotation(); return { i: pb.idx, x: t.x, y: t.y, z: t.z, qx: q.x, qy: q.y, qz: q.z, qw: q.w }; });
    return encodeSnapshot({ t: now, players, grenades, props });
  }

  meta(): MetaMsg {
    const roster: RosterEntry[] = [...this.players.values()].map((p) => ({ id: p.slot, sid: p.sid, name: p.name, suit: p.suit, bot: p.bot, k: p.k, d: p.d, score: p.score, streak: p.streak, best: p.best, ping: p.ping }));
    return { phase: this.phase, ends: this.phaseEnds, room: this.opts.roomName, roster, winner: this.winner >= 0 ? this.winner : undefined, pickups: [...this.pickups].map((v) => (v === Number.MAX_SAFE_INTEGER ? -1 : v)), arcHolder: this.arcHolder };
  }

  drain(): Outgoing[] {
    const o = this.out;
    this.out = [];
    return o;
  }

  dispose() {
    this.world.free();
  }
}

function r2(n: number) { return Math.round(n * 100) / 100; }

export function raySphere(o: V3, d: V3, c: V3, r: number): number {
  const ox = o[0] - c[0], oy = o[1] - c[1], oz = o[2] - c[2];
  const b = ox * d[0] + oy * d[1] + oz * d[2];
  const cc = ox * ox + oy * oy + oz * oz - r * r;
  const disc = b * b - cc;
  if (disc < 0) return Infinity;
  const t = -b - Math.sqrt(disc);
  return t >= 0 ? t : Infinity;
}

/** Ray vs capsule (segment a-b, radius r). */
export function rayCapsule(o: V3, d: V3, a: V3, b: V3, r: number): number {
  // vertical capsule special case (a,b share x,z): test infinite cylinder then caps
  const ax = a[0], az = a[2];
  const ox = o[0] - ax, oz = o[2] - az;
  const A = d[0] * d[0] + d[2] * d[2];
  let best = Infinity;
  if (A > 1e-8) {
    const B = ox * d[0] + oz * d[2];
    const C = ox * ox + oz * oz - r * r;
    const disc = B * B - A * C;
    if (disc >= 0) {
      const t = (-B - Math.sqrt(disc)) / A;
      if (t >= 0) {
        const y = o[1] + d[1] * t;
        if (y >= a[1] && y <= b[1]) best = t;
      }
    }
  }
  best = Math.min(best, raySphere(o, d, a, r), raySphere(o, d, b, r));
  return best;
}
