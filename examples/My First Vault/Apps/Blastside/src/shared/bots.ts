// Bot brain: Roam -> Engage -> Retreat (low HP, to health) -> Pickup. Waypoint graph + A*.
import { BOTS_VS_HUMANS, BOT_DIFFICULTY, GRENADE, HITBOX, MOVE, RULES, WEAPONS, type Difficulty, type WeaponId } from "./constants.js";
import { NAV, PICKUP_DEFS, groundHeight, type V3 } from "./map.js";
import { rayMap } from "./physics.js";
import type { MatchSim, SimPlayer } from "./sim.js";

type Mode = "roam" | "engage" | "retreat" | "pickup";

// Adjacency (bidirectional) + one-way pad launches to the roof.
const ADJ: number[][] = NAV.nodes.map(() => []);
for (const [a, b] of NAV.links) { ADJ[a].push(b); ADJ[b].push(a); }
const ROOF = NAV.nodes.findIndex((n) => n.tag === "arc");
for (const [a, b] of NAV.oneWay) ADJ[a].push(b);

function nearestNode(x: number, y: number, z: number): number {
  let best = 0, bd = Infinity;
  for (let i = 0; i < NAV.nodes.length; i++) {
    const p = NAV.nodes[i].p;
    const d = (p[0] - x) ** 2 + (p[2] - z) ** 2 + ((p[1] - y) * 3) ** 2;
    if (d < bd) { bd = d; best = i; }
  }
  return best;
}

function astar(from: number, to: number): number[] {
  const n = NAV.nodes.length;
  const g = new Float64Array(n).fill(Infinity);
  const f = new Float64Array(n).fill(Infinity);
  const came = new Int32Array(n).fill(-1);
  const open = new Set<number>([from]);
  const h = (i: number) => { const a = NAV.nodes[i].p, b = NAV.nodes[to].p; return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]); };
  g[from] = 0; f[from] = h(from);
  while (open.size) {
    let cur = -1, cf = Infinity;
    for (const o of open) if (f[o] < cf) { cf = f[o]; cur = o; }
    if (cur === to) break;
    open.delete(cur);
    for (const nb of ADJ[cur]) {
      const a = NAV.nodes[cur].p, b = NAV.nodes[nb].p;
      const cost = NAV.nodes[cur].tag === "pad" && nb === ROOF ? 4 : Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
      const ng = g[cur] + cost;
      if (ng < g[nb]) { g[nb] = ng; f[nb] = ng + h(nb); came[nb] = cur; open.add(nb); }
    }
  }
  if (came[to] < 0 && from !== to) return [to];
  const path = [to];
  let c = to;
  while (came[c] >= 0 && c !== from) { c = came[c]; path.unshift(c); }
  return path;
}

const rand = (a: number, b: number) => a + Math.random() * (b - a);
const wrap = (a: number) => { while (a > Math.PI) a -= Math.PI * 2; while (a < -Math.PI) a += Math.PI * 2; return a; };

export class BotBrain {
  mode: Mode = "roam";
  path: number[] = [];
  goal = -1;
  target: SimPlayer | null = null;
  seenT = 0; // when target was first spotted (reaction)
  lastSeenT = 0;
  trackStartT = 0;
  nextSenseT = 0;
  heard: { x: number; z: number; t: number } | null = null;
  burstLeft = 0;
  pauseUntil = 0;
  strafeDir = 1;
  strafeSwitchT = 0;
  aimErrX = 0; aimErrY = 0; // radians, smooth noise
  errTX = 0; errTY = 0; errSwapT = 0;
  stuckT = 0;
  lastProgress = { x: 0, z: 0, t: 0 };
  wantArc = false;
  aimHead = false;
  yawRate = 7; // rad/s
  dashToCover = false;
  private d;
  private jumpPulse = 0;
  private dashPulse = 0;

  constructor(private sim: MatchSim, private me: SimPlayer, diff: Difficulty) {
    this.d = BOT_DIFFICULTY[diff];
  }
  setDifficulty(diff: Difficulty) { this.d = BOT_DIFFICULTY[diff]; }
  get damageMul() { return this.d.damageMul; }

  /** stand still (emoting) */
  private frozenUntil = 0;
  private ignored = new Map<number, number>();
  private lookAroundUntil = 0;
  pauseFor(ms: number) { this.frozenUntil = this.sim.now() + ms; }

  onSpawn() {
    this.mode = "roam";
    this.target = null;
    this.path = [];
    this.wantArc = Math.random() < 0.5 && this.sim.pickups[this.sim.arcIndex()] === 0;
    this.goal = -1;
  }
  onDied() { this.target = null; this.path = []; }
  onDamaged(by: SimPlayer | null, amount: number) {
    if (by && by !== this.me && (!this.target || !this.canSee(this.target))) {
      this.heard = { x: by.x, z: by.z, t: this.sim.now() };
    }
    const recent = this.me.recentDamage.reduce((a, r) => a + r.dmg, 0);
    if (recent >= 40 && Math.random() < 0.7) this.dashPulse = 2;
    void amount;
  }

  private canSee(t: SimPlayer): boolean {
    const me = this.me;
    const ex = me.x, ey = me.y + 1.6, ez = me.z;
    const tx = t.x, ty = t.y + 1.1, tz = t.z;
    const dx = tx - ex, dy = ty - ey, dz = tz - ez;
    const d = Math.hypot(dx, dy, dz);
    if (d > 40) return false;
    const hit = rayMap(this.sim.R, this.sim.world, { x: ex, y: ey, z: ez }, { x: dx / d, y: dy / d, z: dz / d }, d, me.motor?.collider);
    return hit.toi >= d - 0.4;
  }

  private inFov(t: SimPlayer) {
    const me = this.me;
    const ang = Math.atan2(-(t.x - me.x), -(t.z - me.z));
    return Math.abs(wrap(ang - me.yaw)) < (100 / 2) * (Math.PI / 180);
  }

  private sense(now: number) {
    const me = this.me;
    // keep current target if still visible
    if (this.target) {
      if (!this.target.alive) this.target = null;
      else if (this.canSee(this.target)) { if (now - this.lastSeenT > 350) this.seenT = Math.max(this.seenT, now + this.d.holdSightMs * 0.6); this.lastSeenT = now; }
      else if (now - this.lastSeenT > this.d.loseSightMs) this.target = null;
    }
    if (!this.target || now - this.lastSeenT > 300) {
      let best: SimPlayer | null = null, bd = Infinity;
      for (const o of this.sim.players.values()) {
        if (o === me || !o.alive || o.protectUntil > now) continue;
        const d = Math.hypot(o.x - me.x, o.y - me.y, o.z - me.z);
        if (d > 40 || d >= bd) continue;
        const heardIt = o.fired && d < 25;
        if (!this.inFov(o) && !heardIt && d > 3) continue;
        if (!this.canSee(o)) continue;
        best = o; bd = d;
      }
      if (best && best !== this.target && !(this.ignored.get(best.slot)! > now)) {
        // sometimes they simply don't notice you
        if (Math.random() < this.d.noticeMissPct) { this.ignored.set(best.slot, now + 1500); return; }
        this.target = best;
        this.seenT = now + Math.max(this.d.holdSightMs, this.d.reactMs + rand(-this.d.reactJitter, this.d.reactJitter));
        this.trackStartT = now;
        this.lastSeenT = now;
        this.burstLeft = 0;
        this.pauseUntil = this.seenT;
      }
    }
    // hearing: shots within 25 m turn the head
    if (!this.target) {
      for (const o of this.sim.players.values()) {
        if (o === me || !o.alive || !o.fired) continue;
        if (Math.hypot(o.x - me.x, o.z - me.z) < 25) this.heard = { x: o.x, z: o.z, t: now };
      }
    }
  }

  private pathTo(node: number) {
    const me = this.me;
    const start = nearestNode(me.x, me.y, me.z);
    this.path = astar(start, node);
    this.goal = node;
    // drop the first node if we're already past it
    if (this.path.length > 1) {
      const p0 = NAV.nodes[this.path[0]].p, p1 = NAV.nodes[this.path[1]].p;
      const d0 = Math.hypot(p0[0] - me.x, p0[2] - me.z), d01 = Math.hypot(p1[0] - p0[0], p1[2] - p0[2]), d1 = Math.hypot(p1[0] - me.x, p1[2] - me.z);
      if (d1 < d01 && d0 < 4) this.path.shift();
    }
  }

  private pickRoamGoal() {
    // Prefer nodes near other players, sometimes random
    const others = [...this.sim.players.values()].filter((o) => o !== this.me && o.alive);
    if (Math.random() < this.d.wanderPct) {
      const picks = NAV.nodes.map((n, i) => (n.tag === "health" || n.tag === "shield" ? i : -1)).filter((i) => i >= 0);
      if (picks.length) return picks[Math.floor(Math.random() * picks.length)];
    }
    if (others.length && Math.random() < 0.6) {
      const o = others[Math.floor(Math.random() * others.length)];
      return nearestNode(o.x, o.y, o.z);
    }
    return Math.floor(Math.random() * NAV.nodes.length);
  }

  update(dt: number, now: number) {
    const me = this.me;
    const inp = me.input!;
    if (now < this.frozenUntil) { inp.fwd = 0; inp.right = 0; inp.jump = false; inp.dash = false; return; }
    if (now >= this.nextSenseT) { this.sense(now); this.nextSenseT = now + 200; }

    // ---- mode selection ----
    const healthIdx = PICKUP_DEFS.map((d, i) => (d.kind === "health" && this.sim.pickups[i] === 0 ? i : -1)).filter((i) => i >= 0);
    if (me.hp < 35 && healthIdx.length && this.mode !== "retreat") {
      this.mode = "retreat";
      let bi = healthIdx[0], bd = Infinity;
      for (const i of healthIdx) { const p = PICKUP_DEFS[i].p; const d = Math.hypot(p[0] - me.x, p[2] - me.z); if (d < bd) { bd = d; bi = i; } }
      const p = PICKUP_DEFS[bi].p;
      this.pathTo(nearestNode(p[0], p[1], p[2]));
    } else if (this.mode === "retreat" && (me.hp >= 60 || !this.path.length)) {
      this.mode = "roam";
    }
    if (this.target && this.mode !== "retreat") this.mode = "engage";
    else if (!this.target && this.mode === "engage") { this.mode = "roam"; this.path = []; }
    if (this.mode === "roam" && this.wantArc && this.sim.pickups[this.sim.arcIndex()] === 0 && me.ammo[2] === 0) {
      this.mode = "pickup";
      this.pathTo(ROOF);
    }
    if (this.mode === "pickup" && (me.ammo[2] > 0 || this.sim.pickups[this.sim.arcIndex()] !== 0)) { this.mode = "roam"; this.wantArc = false; this.path = []; }

    // ---- movement ----
    let moveX = 0, moveZ = 0; // desired world direction
    if (this.mode !== "engage" || !this.target) {
      if (!this.path.length) this.pathTo(this.pickRoamGoal());
      const nodeIdx = this.path[0];
      const node = NAV.nodes[nodeIdx].p;
      const dx = node[0] - me.x, dz = node[2] - me.z;
      const dist = Math.hypot(dx, dz);
      const reach = NAV.nodes[nodeIdx].tag === "pad" ? 0.6 : 1.3;
      if (dist < reach && Math.abs(node[1] - me.y) < 2.5) {
        this.path.shift();
        if (!this.target && Math.random() < this.d.lookAroundPct) this.lookAroundUntil = now + rand(900, 2000);
      } else {
        moveX = dx / dist; moveZ = dz / dist;
      }
      // While flying from a pad, don't fight it
      if (me.launched) { moveX = 0; moveZ = 0; }
    } else {
      const t = this.target;
      const dx = t.x - me.x, dz = t.z - me.z;
      const dist = Math.hypot(dx, dz) || 1;
      const ux = dx / dist, uz = dz / dist;
      if (now > this.strafeSwitchT) { this.strafeDir = Math.random() < 0.5 ? -1 : 1; this.strafeSwitchT = now + rand(600, 1400); if (Math.random() < 0.1) this.jumpPulse = 2; }
      const pref = me.weapon === 1 ? 5 : me.weapon === 2 ? 14 : 12;
      const radial = dist > pref + 3 ? 1 : dist < pref - 4 ? -0.6 : 0;
      // strafe perpendicular
      moveX = ux * radial + -uz * this.strafeDir * 0.9;
      moveZ = uz * radial + ux * this.strafeDir * 0.9;
      // if the target moved out of sight keep closing on last known position
      if (now - this.lastSeenT > 400) { moveX = ux; moveZ = uz; }
    }
    if (now < this.lookAroundUntil && !this.target) { moveX = 0; moveZ = 0; }
    // Edge safety: don't walk off the island (only checks on the main ground)
    const ml = Math.hypot(moveX, moveZ);
    if (ml > 0.01) {
      moveX /= ml; moveZ /= ml;
      const px = me.x + moveX * 1.6, pz = me.z + moveZ * 1.6;
      if (!this.groundAt(px, me.y, pz)) {
        if (this.mode === "engage") { this.strafeDir *= -1; moveX = -moveX; moveZ = -moveZ; }
        else if (!this.path.length || NAV.nodes[this.path[0]].p[1] < me.y - 3) { moveX = 0; moveZ = 0; }
      }
    }
    // stuck detection
    if (Math.hypot(me.x - this.lastProgress.x, me.z - this.lastProgress.z) > 1) this.lastProgress = { x: me.x, z: me.z, t: now };
    else if (ml > 0.1 && now - this.lastProgress.t > 1500) { this.jumpPulse = 2; this.path = []; this.lastProgress.t = now; }

    // ---- aim ----
    let wantYaw = me.yaw, wantPitch = 0;
    let fire = false;
    if (this.target && this.mode !== "retreat" || (this.target && now - this.lastSeenT < 200)) {
      const t = this.target!;
      const tracking = (now - this.trackStartT) / 1000;
      const distT = Math.hypot(t.x - me.x, t.z - me.z);
      const tSpeed = Math.hypot(t.vx, t.vz);
      const errDeg = this.d.aimTrackDeg + (this.d.aimStartDeg - this.d.aimTrackDeg) * Math.max(0, 1 - tracking / this.d.trackS)
        + Math.max(0, distT - 15) / 10 * this.d.rangeDegPer10m + (distT / 10) * 0.3 + tSpeed * this.d.strafeDegPerMs
        + (t.bot ? 0 : BOTS_VS_HUMANS.extraAimErrorDeg);
      if (now > this.errSwapT) { this.errTX = rand(-1, 1); this.errTY = rand(-1, 1); this.errSwapT = now + rand(250, 600); }
      this.aimErrX += (this.errTX - this.aimErrX) * Math.min(1, dt * 4);
      this.aimErrY += (this.errTY - this.aimErrY) * Math.min(1, dt * 4);
      const err = (errDeg * Math.PI) / 180;
      const ty = t.y + (this.aimHead ? HITBOX.headY : 1.0);
      const ex = me.x, ey = me.y + 1.5, ez = me.z;
      // lead the target a little (normal: crude)
      const lead = this.d.leadS;
      const ax = t.x + t.vx * lead - ex, ay = ty - ey, az = t.z + t.vz * lead - ez;
      const hd = Math.hypot(ax, az);
      wantYaw = Math.atan2(-ax, -az) + this.aimErrX * err;
      wantPitch = Math.atan2(ay, hd) + this.aimErrY * err * 0.7;
      // weapon choice
      const dist = Math.hypot(ax, ay, az);
      let w: WeaponId = 0;
      if (me.ammo[2] > 0 && dist > 6 && dist < 28) w = 2;
      else if (dist < 8 && me.ammo[1] > 0) w = 1;
      else if (me.ammo[0] <= 0 && me.ammo[1] > 0) w = 1;
      if (w !== me.weapon && me.reloadUntil < now) me.weapon = w;
      if (me.weapon === 2) {
        // ballistic pitch for the grenade
        const v = GRENADE.speed, g = MOVE.gravity;
        const disc = v ** 4 - g * (g * hd * hd + 2 * ay * v * v);
        if (disc >= 0) wantPitch = Math.atan((v * v - Math.sqrt(disc)) / (g * hd));
      }
      // fire control: reaction time, bursts
      if (now >= this.seenT && now - this.lastSeenT < 250) {
        if (this.burstLeft <= 0 && now >= this.pauseUntil) {
          this.burstLeft = Math.round(rand(this.d.burstMin, this.d.burstMax));
          this.aimHead = Math.random() < this.d.headPct;
          // sometimes a burst just doesn't happen (hesitation)
          if (Math.random() < this.d.whiffPct) { this.burstLeft = 0; this.pauseUntil = now + rand(400, 900); }
        }
        if (this.burstLeft > 0) fire = true;
      }
    } else if (this.heard && now - this.heard.t < 2500) {
      wantYaw = Math.atan2(-(this.heard.x - me.x), -(this.heard.z - me.z));
    } else if (now < this.lookAroundUntil) {
      wantYaw = me.yaw + Math.sin(now / 400) * 0.9 * dt * 3;
    } else if (ml > 0.1) {
      wantYaw = Math.atan2(-moveX, -moveZ);
    }
    const dy = wrap(wantYaw - me.yaw);
    const maxTurn = this.yawRate * dt * (this.target ? 1.4 : 1);
    me.yaw = wrap(me.yaw + Math.max(-maxTurn, Math.min(maxTurn, dy)));
    me.pitch += Math.max(-maxTurn, Math.min(maxTurn, wantPitch - me.pitch));

    // Convert desired world direction to the yaw frame for the motor.
    const sy = Math.sin(me.yaw), cy = Math.cos(me.yaw);
    // forward = (-sy, -cy), right = (cy, -sy)
    inp.fwd = moveX * -sy + moveZ * -cy;
    inp.right = moveX * cy + moveZ * -sy;
    inp.yaw = me.yaw;
    inp.aim = this.mode === "engage" && !!this.target && me.weapon === 0 && Math.random() < 0.02 ? !inp.aim : inp.aim && this.mode === "engage";
    inp.jump = this.jumpPulse > 0; if (this.jumpPulse > 0) this.jumpPulse--;
    inp.dash = this.dashPulse > 0; if (this.dashPulse > 0) this.dashPulse--;

    // ---- shoot ----
    if (fire && Math.abs(dy) < 0.25) {
      const ws = WEAPONS[me.weapon];
      if (me.ammo[me.weapon] <= 0 && me.weapon !== 2) {
        if (me.reloadUntil < now) { me.reloadUntil = now + ws.reloadS * 1000; me.reloadWeapon = me.weapon; }
      } else if (now >= me.nextFireT) {
        const cp = Math.cos(me.pitch);
        const d: V3 = [-Math.sin(me.yaw) * cp, Math.sin(me.pitch), -Math.cos(me.yaw) * cp];
        const o: V3 = [me.x, me.y + 1.5, me.z];
        const m: V3 = [me.x + d[0] * 0.8 + Math.cos(me.yaw) * 0.25, me.y + 1.35 + d[1] * 0.8, me.z + d[2] * 0.8 - Math.sin(me.yaw) * 0.25];
        const spread = ws.pellets > 1 ? ws.spreadMaxDeg : ws.spreadMinDeg + 0.4;
        if (this.sim.fire(me, me.weapon, o, d, m, (Math.random() * 2 ** 32) >>> 0, spread, now)) {
          this.burstLeft--;
          if (this.burstLeft <= 0) this.pauseUntil = now + rand(this.d.pauseMin, this.d.pauseMax);
        }
      }
    } else if (!this.target && me.weapon !== 2 && me.ammo[me.weapon] < WEAPONS[me.weapon].mag * 0.5 && me.reloadUntil < now) {
      const ws = WEAPONS[me.weapon];
      me.reloadUntil = now + ws.reloadS * 1000;
      me.reloadWeapon = me.weapon;
    }
    void RULES;
  }

  private groundAt(x: number, y: number, z: number): boolean {
    const g = groundHeight(x, z);
    if (g !== null && g > y - 3) return true;
    // ramps/roof/bridges: ray down
    const hit = rayMap(this.sim.R, this.sim.world, { x, y: y + 1, z }, { x: 0, y: -1, z: 0 }, 4, this.me.motor?.collider);
    return hit.toi < 4;
  }
}
