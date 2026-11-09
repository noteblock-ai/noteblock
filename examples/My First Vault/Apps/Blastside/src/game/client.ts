// The game, imperative: local prediction, remote interpolation, shooting, effects, HUD feed.
import * as THREE from "three";
import RAPIER from "@dimforge/rapier3d-compat";
import {
  createMapWorld, createProps, rayMap, Motor, newMotorState, spreadDirs, raySphere, rayCapsule,
  EYE, EMOTES, HITBOX, INPUT_HZ, INTERP_DELAY_MS, MAX_EXTRAPOLATE_MS, MOVE, PICKUP_DEFS, PROP_DEFS, RULES, SUITS, WEAPONS,
  MOTOR_EV_DASH, MOTOR_EV_JUMP, MOTOR_EV_LAND, MOTOR_EV_PAD,
  PF_ALIVE, PF_AIM, PF_CROUCH, PF_DASH, PF_FIRE, PF_GLOW, PF_GROUNDED, PF_LAUNCHED, PF_PROTECT, PF_RELOAD,
  type GameEvent, type MetaMsg, type MotorState, type PlayerSnap, type Snapshot, type V3, type WeaponId, type PropBody,
} from "@blastside/shared";
import type { Conn } from "../net/connection";
import { CharacterView } from "./character";
import { Vfx } from "./vfx";
import { audio } from "./audio";
import { Input } from "./input";
import { useUI, rosterName } from "./store";
import { buildMapVisual, type MapVisual } from "./map-visual";
import { assets, kitPiece } from "../assets";
import { Ragdolls } from "./ragdoll";

interface Remote {
  slot: number;
  view: CharacterView;
  alive: boolean;
  lastFlags: number;
  weapon: WeaponId;
  reloading: boolean;
  stepT: number;
  lastAnimT: number;
  ragdolled: boolean;
}

const _v = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _v3 = new THREE.Vector3();

const FP_EYE = 1.52;
const wrap = (a: number) => { while (a > Math.PI) a -= Math.PI * 2; while (a < -Math.PI) a += Math.PI * 2; return a; };
const lerpAngle = (a: number, b: number, t: number) => a + wrap(b - a) * t;

export class GameClient {
  readonly root = new THREE.Group();
  readonly world: RAPIER.World;
  readonly props: PropBody[];
  readonly motor: Motor;
  readonly ms: MotorState;
  readonly vfx = new Vfx();
  readonly ragdolls: Ragdolls;
  readonly input: Input;
  readonly map: MapVisual;
  readonly views = new Map<number, Remote>();
  private snaps: Snapshot[] = [];
  meta: MetaMsg | null = null;
  yaw = 0;
  pitch = -0.08;
  private recoilPitch = 0;
  private recoilYaw = 0;
  private kickPitch = 0;
  alive = false;
  private aliveSince = 0;
  private deadAt = 0;
  private deathPos = new THREE.Vector3();
  private killer = -1;
  weapon: WeaponId = 0;
  private lastWeapon: WeaponId = 1;
  ammo: [number, number, number] = [WEAPONS[0].mag, WEAPONS[1].mag, 0];
  private reloadUntil = 0;
  private reloadWeapon: WeaponId = 0;
  private nextFireT = 0;
  private swapUntil = 0;
  private bloom = 0;
  private seq = 0;
  private sendAcc = 0;
  private fireSeed = (Math.random() * 1e9) | 0;
  private clock = 0;
  private hudAcc = 0;
  private fovCur: number = EYE.fov;
  private aimBlend = 0;
  private camBack = EYE.back;
  private mine: PlayerSnap | null = null;
  private protect = false;
  private grenadeVis = new Map<number, { mesh: THREE.Object3D; trail: THREE.Vector3[]; line: THREE.Line; last: number }>();
  private propVis: THREE.Object3D[] = [];
  private pickupVis: THREE.Object3D[] = [];
  private arcPillar: THREE.Mesh | null = null;
  private stepAcc = 0;
  private damageArcs: { angle: number; t: number; from: V3 }[] = [];
  paused = false;
  /** first person (V) */
  fp = false;
  private fpEye = new THREE.Vector3();
  /** until the server gives us a spawn: no body, an establishing shot of the fort */
  private everSpawned = false;
  private crouchToggle = false;
  private crouchBlend = 0;
  private swayV = new THREE.Vector3();
  private swayT = 0;
  /** capture harness: fixed camera */
  debugCam: { pos: [number, number, number]; target: [number, number, number] } | null = null;
  private podium: CharacterView[] = [];
  private resultsShown = false;
  private overlay: HTMLElement;
  private hitmarkerEl: HTMLElement | null = null;
  private lastServerAmmoSync = 0;
  private lastFireLocal = 0;
  fps = 60;

  constructor(readonly conn: Conn, readonly scene: THREE.Scene, readonly camera: THREE.PerspectiveCamera, dom: HTMLElement, overlay: HTMLElement) {
    this.overlay = overlay;
    const mp = createMapWorld(RAPIER);
    this.world = mp.world;
    this.props = createProps(RAPIER, this.world, true);
    this.motor = new Motor(RAPIER, this.world, 0, -100, 0);
    this.ms = newMotorState(0, -100, 0);
    this.ragdolls = new Ragdolls(RAPIER, this.world, this.root);
    this.input = new Input(dom);
    this.input.onLockChange = (locked) => {
      useUI.getState().set({ locked, menu: !locked && useUI.getState().screen === "game" ? useUI.getState().menu : useUI.getState().menu });
      if (!locked && this.alive) useUI.getState().set({ menu: true });
      if (locked) useUI.getState().set({ menu: false });
    };
    this.map = buildMapVisual();
    this.root.add(this.map.group);
    this.root.add(this.vfx.group);
    this.buildProps();
    this.buildPickups();
    scene.add(this.root);

    conn.onSnap = (s) => this.onSnap(s);
    conn.onMeta = (m) => this.onMeta(m);
    conn.onEvent = (e) => this.onEvent(e);
    useUI.getState().set({ mySlot: conn.slot, mode: conn.mode });
    this.applySettings();
  }

  applySettings() {
    const s = useUI.getState().settings;
    this.input.sensitivity = s.sens;
    this.input.invertY = s.invertY;
    audio.setVolume(s.volume);
  }

  dispose() {
    this.input.dispose();
    this.root.removeFromParent();
    for (const v of this.views.values()) v.view.dispose();
    for (const p of this.podium) p.dispose();
    this.world.free();
  }

  // ---------- scene pieces ----------
  private buildProps() {
    for (const d of PROP_DEFS) {
      const src = kitPiece(d.kind === "crate" ? "pirate/crate" : "pirate/barrel");
      const obj = src.clone(true);
      const b = new THREE.Box3().setFromObject(obj);
      const size = b.getSize(new THREE.Vector3());
      const ctr = b.getCenter(new THREE.Vector3());
      const holder = new THREE.Group();
      obj.position.sub(ctr);
      obj.scale.set((d.half[0] * 2) / size.x, (d.half[1] * 2) / size.y, (d.half[2] * 2) / size.z);
      obj.position.multiply(obj.scale);
      obj.traverse((o) => { if ((o as THREE.Mesh).isMesh) { o.castShadow = true; o.receiveShadow = true; } });
      holder.add(obj);
      holder.position.set(d.p[0], d.p[1] + d.half[1], d.p[2]);
      holder.rotation.y = d.yaw;
      this.root.add(holder);
      this.propVis.push(holder);
    }
  }

  private buildPickups() {
    for (const d of PICKUP_DEFS) {
      const g = new THREE.Group();
      g.position.set(d.p[0], d.p[1], d.p[2]);
      const base = new THREE.Mesh(new THREE.CylinderGeometry(0.55, 0.65, 0.12, 24), new THREE.MeshStandardMaterial({ color: "#4a5062", roughness: 0.7 }));
      base.position.y = 0.06;
      base.receiveShadow = true;
      g.add(base);
      const item = new THREE.Group();
      item.position.y = 0.9;
      item.name = "item";
      if (d.kind === "health") {
        const m = new THREE.MeshStandardMaterial({ color: "#3ccf6e", emissive: "#2aff7a", emissiveIntensity: 0.9, roughness: 0.4 });
        item.add(new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.16, 0.16), m));
        item.add(new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.5, 0.16), m));
      } else if (d.kind === "shield") {
        const m = new THREE.MeshStandardMaterial({ color: "#1fb5ac", emissive: "#3ff7ee", emissiveIntensity: 0.9, roughness: 0.3, metalness: 0.2 });
        const hex = new THREE.Mesh(new THREE.CylinderGeometry(0.3, 0.3, 0.12, 6).rotateX(Math.PI / 2), m);
        item.add(hex);
        const ring = new THREE.Mesh(new THREE.TorusGeometry(0.4, 0.03, 6, 6), m);
        item.add(ring);
      } else {
        const arc = assets!.weapons.scene.getObjectByName("arc")!.clone(true);
        arc.scale.setScalar(2.2);
        arc.rotation.y = Math.PI / 2;
        item.add(arc);
        const pillar = new THREE.Mesh(new THREE.CylinderGeometry(0.5, 0.9, 30, 24, 1, true), new THREE.MeshBasicMaterial({ color: "#9b7bff", transparent: true, opacity: 0.18, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide, toneMapped: false }));
        pillar.position.y = 15;
        g.add(pillar);
        this.arcPillar = pillar;
      }
      item.traverse((o) => { if ((o as THREE.Mesh).isMesh) o.castShadow = true; });
      g.add(item);
      const glow = new THREE.PointLight(d.kind === "health" ? "#55ff9a" : d.kind === "shield" ? "#55fff5" : "#a98bff", 1.5, 4, 2);
      glow.position.y = 0.9;
      g.add(glow);
      this.root.add(g);
      this.pickupVis.push(g);
    }
  }

  // ---------- network ----------
  private onSnap(s: Snapshot) {
    this.snaps.push(s);
    while (this.snaps.length > 40) this.snaps.shift();
    const me = s.players.find((p) => p.id === this.conn.slot);
    if (me) {
      this.mine = me;
      const nowAlive = !!(me.f & PF_ALIVE);
      if (!nowAlive && this.alive) this.onLocalDeath();
      if (nowAlive && !this.alive && this.clock - this.deadAt > 0.5) {
        // spawn event may have been missed
        this.respawnLocal([me.x, me.y, me.z]);
      }
      this.protect = !!(me.f & PF_PROTECT);
      // keep arc ammo authoritative, and resync other ammo when idle
      this.ammo[2] = me.arc;
      if (this.weapon === 2 && me.arc <= 0) this.selectWeapon(0, true);
      if (this.clock - this.lastFireLocal > 0.6 && this.clock > this.reloadUntil && this.clock - this.lastServerAmmoSync > 1 && me.w === this.weapon && this.weapon !== 2) {
        if (Math.abs(me.ammo - this.ammo[this.weapon]) > 1) this.ammo[this.weapon] = me.ammo;
        this.lastServerAmmoSync = this.clock;
      }
    }
    // roster views
    for (const p of s.players) if (!this.views.has(p.id)) this.addView(p.id);
    for (const id of [...this.views.keys()]) if (!s.players.some((p) => p.id === id)) this.removeView(id);
    // props: kinematic followers for the local controller
    for (const pr of s.props) {
      const pb = this.props[pr.i];
      if (pb) pb.body.setNextKinematicTranslation({ x: pr.x, y: pr.y, z: pr.z }), pb.body.setNextKinematicRotation({ x: pr.qx, y: pr.qy, z: pr.qz, w: pr.qw });
    }
  }

  private onMeta(m: MetaMsg) {
    const prev = this.meta;
    this.meta = m;
    for (const r of m.roster) {
      const v = this.views.get(r.id);
      if (v && v.view.suit !== r.suit) v.view.setSuit(r.suit);
    }
    for (let i = 0; i < this.pickupVis.length; i++) {
      const up = m.pickups[i] === 0;
      const item = this.pickupVis[i].getObjectByName("item")!;
      item.visible = up;
      this.pickupVis[i].children.forEach((c) => { if ((c as THREE.PointLight).isPointLight) (c as THREE.PointLight).intensity = up ? 1.5 : 0; });
      if (PICKUP_DEFS[i].kind === "arc" && this.arcPillar) this.arcPillar.visible = up;
    }
    if (m.phase !== "results") { this.resultsShown = false; this.clearPodium(); }
    if (prev?.phase === "results" && m.phase === "warmup") this.weapon = 0;
    useUI.getState().set({ meta: m });
  }

  private nameOf(slot: number) { return rosterName(this.meta, slot)?.name ?? "?"; }
  private suitOf(slot: number) { return rosterName(this.meta, slot)?.suit ?? 0; }

  private onEvent(e: GameEvent) {
    const me = this.conn.slot;
    switch (e.e) {
      case "shot": {
        if (e.p === me) return; // drawn locally
        const v = this.views.get(e.p);
        const m = v ? v.view.muzzleWorld(new THREE.Vector3()) : new THREE.Vector3(...e.m);
        v?.view.noteFire();
        this.vfx.muzzle(m, e.w, true);
        for (const h of e.h) {
          const end = new THREE.Vector3(...h);
          this.vfx.tracer(m, end, e.w === 1 ? "#9ffff6" : "#ffe7b0", e.w === 1 ? 0.035 : 0.05);
          this.impact(end, m);
        }
        audio.play(e.w === 1 ? "scatter" : "rifle", { at: [m.x, m.y, m.z], vol: 0.8 });
        break;
      }
      case "hit": {
        const victim = this.views.get(e.to);
        if (victim) {
          const att = this.views.get(e.by);
          let front = true;
          if (att) {
            const dx = att.view.root.position.x - victim.view.root.position.x, dz = att.view.root.position.z - victim.view.root.position.z;
            const fy = victim.view.root.rotation.y;
            front = -Math.sin(fy) * dx + -Math.cos(fy) * dz > 0;
          }
          victim.view.hit(e.dmg, front);
          if (e.shield) this.vfx.sparksAt(new THREE.Vector3(...e.at), null, 10, "#5ff7ff", 4);
        }
        if (e.by === me && e.to !== me) {
          this.hitmarker(e.kill ? "kill" : e.head ? "head" : "hit");
          audio.play("hit", { rate: e.head ? 1.5 : 1.1, vol: 0.8, jitter: 0 });
          if (e.brk) audio.play("shield", { vol: 0.7 });
          this.damageNumber(e.at, e.dmg, e.head, e.kill);
        }
        if (e.to === me) {
          const att = this.views.get(e.by);
          const from: V3 = att ? [att.view.root.position.x, 0, att.view.root.position.z] : [this.ms.x, 0, this.ms.z];
          this.damageArcs.push({ angle: 0, t: 1, from });
          this.kickPitch += 0.009;
          audio.play("land", { vol: 0.55, rate: 0.8 });
          if (e.brk) audio.play("shield", { vol: 0.9 });
        }
        break;
      }
      case "ko": {
        const victimName = this.nameOf(e.v);
        const killerName = e.k >= 0 ? this.nameOf(e.k) : "";
        const rows = useUI.getState().killfeed.slice(-5);
        const victimBot = rosterName(this.meta, e.v)?.bot;
        const killerBot = e.k >= 0 ? rosterName(this.meta, e.k)?.bot : false;
        // design: bots never appear in the kill feed
        if (!(victimBot && (killerBot || e.k < 0))) {
          rows.push({ id: Math.random(), killer: killerName, victim: victimName, weapon: e.w, fall: e.fall, self: e.self, you: e.v === me || e.k === me, killerSuit: e.k >= 0 ? this.suitOf(e.k) : 0, victimSuit: this.suitOf(e.v), t: performance.now() });
        }
        useUI.getState().set({ killfeed: rows });
        const v = this.views.get(e.v);
        if (v && e.v === me) { v.view.applyViewmodel(_v3, false); v.view.setFirstPerson(false); v.view.root.position.set(this.ms.x, this.ms.y, this.ms.z); v.view.root.visible = true; }
        if (v) {
          v.alive = false;
          if (e.v !== me || true) this.startRagdoll(v, e.dir);
        }
        if (e.k === me && e.v !== me) {
          audio.play("kill", { vol: 0.7 });
          useUI.getState().set({ toast: { text: `+${e.pts} · Blasted ${victimName}`, t: performance.now() } });
        }
        if (e.v === me) {
          audio.play("crunch", { vol: 0.6, rate: 0.7 });
          this.killer = e.k;
          this.onLocalDeath();
        }
        break;
      }
      case "boom": {
        const p = new THREE.Vector3(...e.at);
        this.vfx.explosion(p, this.camera.position);
        this.vfx.decal(p.clone().add(new THREE.Vector3(0, 0.05, 0)), new THREE.Vector3(0, 1, 0), 2.4);
        audio.play("boom", { at: e.at, vol: 1 });
        audio.play("crunch", { at: e.at, vol: 0.7 });
        // ragdolls get pushed too
        this.ragdolls.blast(p, 9);
        break;
      }
      case "kb":
        if (e.to === me) this.motor.addImpulse(this.ms, e.dv[0], e.dv[1], e.dv[2]);
        break;
      case "pick":
        if (e.by === me) audio.play("pickup", { vol: 0.8 });
        else audio.play("pickup", { at: PICKUP_DEFS[e.i].p, vol: 0.6 });
        break;
      case "spawn":
        if (e.p === me) this.respawnLocal(e.at);
        else {
          const v = this.views.get(e.p);
          if (v) { this.ragdolls.release(v.view); v.ragdolled = false; v.view.revive(); v.alive = true; v.view.root.visible = true; }
        }
        break;
      case "corr":
        this.motor.teleport(this.ms, e.p[0], e.p[1], e.p[2]);
        break;
      case "emote": {
        const v = this.views.get(e.p);
        const em = EMOTES[e.id];
        if (v && em && v.alive) {
          v.view.emote(em.clip, em.loop);
          if (e.p === me) this.emoteStart = this.clock;
          else audio.play("pickup", { at: [v.view.root.position.x, v.view.root.position.y + 1, v.view.root.position.z], vol: 0.25, rate: 1.4 });
        }
        break;
      }
      case "horn":
        audio.play("horn", { vol: 0.5, rate: e.phase === "match" ? 1 : 0.8 });
        if (e.phase === "match") useUI.getState().set({ toast: { text: "Fight! First to 15", t: performance.now() } });
        if (e.phase === "overtime") useUI.getState().set({ toast: { text: "Overtime: next knockout wins", t: performance.now() } });
        break;
    }
  }

  private impact(end: THREE.Vector3, from: THREE.Vector3) {
    // decal + sparks when the end point is on the map (not on a player)
    const dir = _v.subVectors(end, from).normalize();
    const hit = rayMap(RAPIER, this.world, { x: end.x - dir.x * 0.3, y: end.y - dir.y * 0.3, z: end.z - dir.z * 0.3 }, { x: dir.x, y: dir.y, z: dir.z }, 0.6, this.motor.collider);
    if (hit.toi < 0.6 && hit.normal) {
      const n = new THREE.Vector3(hit.normal.x, hit.normal.y, hit.normal.z);
      this.vfx.sparksAt(end, n, 8);
      this.vfx.decal(end, n, 0.3);
    } else {
      this.vfx.sparksAt(end, null, 6, "#ff9a6b", 4);
    }
  }

  private addView(slot: number) {
    const suit = this.suitOf(slot);
    const view = new CharacterView(suit);
    view.root.visible = false; // shown once it has a real position (never pops in at the origin)
    this.root.add(view.root);
    this.views.set(slot, { slot, view, alive: false, lastFlags: 0, weapon: 0, reloading: false, stepT: 0, lastAnimT: 0, ragdolled: false });
  }
  private removeView(slot: number) {
    const v = this.views.get(slot);
    if (!v) return;
    this.ragdolls.release(v.view);
    v.view.dispose();
    this.views.delete(slot);
  }

  private startRagdoll(v: Remote, dir: V3) {
    if (v.ragdolled) return;
    v.ragdolled = this.ragdolls.start(v.view, new THREE.Vector3(dir[0], dir[1], dir[2]));
  }

  private onLocalDeath() {
    if (!this.alive || !this.everSpawned) return;
    this.alive = false;
    this.deadAt = this.clock;
    this.deathPos.set(this.ms.x, this.ms.y, this.ms.z);
    this.reloadUntil = 0;
    const kv = this.killer >= 0 ? this.views.get(this.killer) : undefined;
    useUI.getState().set({ hud: { ...useUI.getState().hud, alive: false, killedBy: this.killer >= 0 ? this.nameOf(this.killer) : null, killedBySuit: this.killer >= 0 ? this.suitOf(this.killer) : 0, killedByWeapon: 0, killerHp: kv ? this.lastHp(this.killer) : 0 } });
  }

  private lastHp(slot: number) {
    const s = this.snaps[this.snaps.length - 1];
    return s?.players.find((p) => p.id === slot)?.hp ?? 0;
  }

  private respawnLocal(at: V3) {
    this.motor.teleport(this.ms, at[0], at[1], at[2]);
    this.yaw = Math.atan2(at[0], at[2]);
    this.pitch = -0.08;
    this.swoop = { t: this.clock, pos: this.camera.position.clone(), quat: this.camera.quaternion.clone() };
    this.alive = true;
    this.everSpawned = true;
    this.aliveSince = this.clock;
    this.killer = -1;
    this.ammo = [WEAPONS[0].mag, WEAPONS[1].mag, 0];
    this.weapon = 0;
    this.reloadUntil = 0;
    this.bloom = 0;
    const v = this.views.get(this.conn.slot);
    if (v) { this.ragdolls.release(v.view); v.ragdolled = false; v.view.revive(); v.view.setWeaponImmediate(0); v.alive = true; v.view.root.visible = true; }
    useUI.getState().set({ hud: { ...useUI.getState().hud, alive: true, killedBy: null } });
  }

  // ---------- weapons ----------
  private selectWeapon(w: WeaponId, force = false) {
    if (w === this.weapon && !force) return;
    if (w === 2 && this.ammo[2] <= 0) return;
    if (w !== this.weapon) this.lastWeapon = this.weapon;
    this.weapon = w;
    this.swapUntil = this.clock + 0.3;
    if (this.reloadUntil > this.clock) this.reloadUntil = 0;
    this.views.get(this.conn.slot)?.view.switchWeapon(w);
  }

  private startReload() {
    const ws = WEAPONS[this.weapon];
    if (this.weapon === 2 || this.ammo[this.weapon] >= ws.mag || this.reloadUntil > this.clock) return;
    this.reloadWeapon = this.weapon;
    this.reloadUntil = this.clock + ws.reloadS;
    this.conn.sendReload();
    this.views.get(this.conn.slot)?.view.reload(ws.reloadS);
    audio.play("reload", { vol: 0.6 });
  }

  private tickReload() {
    if (this.reloadUntil && this.clock >= this.reloadUntil) {
      const ws = WEAPONS[this.reloadWeapon];
      if (ws.perShellReload) {
        this.ammo[this.reloadWeapon] = Math.min(ws.mag, this.ammo[this.reloadWeapon] + 1);
        audio.play("reload2", { vol: 0.5, rate: 1.2 });
        if (this.ammo[this.reloadWeapon] < ws.mag && this.weapon === this.reloadWeapon) {
          this.reloadUntil = this.clock + ws.reloadS;
          this.views.get(this.conn.slot)?.view.reload(ws.reloadS);
        } else this.reloadUntil = 0;
      } else {
        this.ammo[this.reloadWeapon] = ws.mag;
        this.reloadUntil = 0;
        audio.play("reload2", { vol: 0.6 });
      }
    }
  }

  private tryFire(camPos: THREE.Vector3, fwd: THREE.Vector3) {
    const w = this.weapon;
    const ws = WEAPONS[w];
    if (this.clock < this.swapUntil || this.clock < this.nextFireT) return;
    if (this.reloadUntil > this.clock && !ws.perShellReload) return;
    if (this.ammo[w] <= 0) { audio.play("reload", { vol: 0.4, rate: 2.2 }); this.nextFireT = this.clock + 0.25; if (w !== 2) this.startReload(); return; }
    if (ws.perShellReload && this.reloadUntil > this.clock) this.reloadUntil = 0;
    this.ammo[w]--;
    this.nextFireT = Math.max(this.clock, this.nextFireT) + 1 / ws.rate;
    this.lastFireLocal = this.clock;
    const myView = this.views.get(this.conn.slot);
    // In first person the visible gun is the shrunken viewmodel; the real muzzle is scaled back out from the eye.
    const vmMuzzle = myView ? myView.view.muzzleWorld(new THREE.Vector3()) : camPos.clone();
    const fpShot = this.fp && myView && myView.view.root.scale.x < 0.99;
    const muzzle = fpShot ? this.fpEye.clone().add(vmMuzzle.clone().sub(this.fpEye).divideScalar(CharacterView.VM_SCALE)) : vmMuzzle;
    const fxMuzzle = fpShot ? vmMuzzle : muzzle;
    myView?.view.noteFire();
    const aimMul = (this.input.aim ? ws.aimSpreadMul : 1) * (this.ms.crouched ? MOVE.crouchSpreadMul : 1);
    const spread = ws.pellets > 1 ? ws.spreadMaxDeg * aimMul : Math.min(ws.spreadMaxDeg, ws.spreadMinDeg + this.bloom) * aimMul;
    const seed = (this.fireSeed = (this.fireSeed * 1664525 + 1013904223) >>> 0);
    const d: V3 = [fwd.x, fwd.y, fwd.z];
    // origin: start the camera ray at the player's depth so walls behind you don't count
    const o: V3 = [camPos.x, camPos.y, camPos.z];
    this.conn.sendFire({ t: this.conn.serverNow() - INTERP_DELAY_MS, w, o, d, m: [muzzle.x, muzzle.y, muzzle.z], seed, sp: spread });
    // recoil
    this.recoilPitch += (ws.recoilDeg * Math.PI) / 180;
    this.recoilYaw += ((Math.random() - 0.5) * 0.4 * Math.PI) / 180 * (w === 1 ? 4 : 1);
    if (ws.bloomPerShotDeg) this.bloom = Math.min(ws.spreadMaxDeg - ws.spreadMinDeg, this.bloom + ws.bloomPerShotDeg);
    this.vfx.muzzle(fxMuzzle, w, true, fpShot ? CharacterView.VM_SCALE : 1, muzzle);
    audio.play(w === 1 ? "scatter" : w === 2 ? "arc" : "rifle", { vol: w === 1 ? 0.9 : 0.7 });
    if (w === 2) {
      if (this.ammo[2] <= 0) setTimeout(() => this.selectWeapon(this.lastWeapon === 2 ? 0 : this.lastWeapon, true), 350);
      return;
    }
    const dirs = ws.pellets > 1 ? spreadDirs(d, Math.min(ws.spreadMaxDeg, spread), ws.pellets, seed) : spreadDirs(d, Math.min(ws.spreadMaxDeg + 0.5, spread), 1, seed);
    for (const dir of dirs) {
      const end = this.traceLocal(o, dir, ws.range, muzzle);
      // first person: start at the viewmodel muzzle a little way out so it doesn't fill the screen
      const from = fpShot ? fxMuzzle.clone().lerp(end.point, 0.02) : muzzle;
      this.vfx.tracer(from, end.point, w === 1 ? "#9ffff6" : "#ffe7b0", (w === 1 ? 0.035 : 0.05) * (fpShot ? 0.6 : 1));
      if (!end.player) this.impact(end.point, muzzle);
      else this.vfx.sparksAt(end.point, null, 5, "#ffd0a0", 3);
    }
    if (this.ammo[w] <= 0) setTimeout(() => this.startReload(), 150);
  }

  /** Same rule as the server (camera ray, then muzzle visibility) against what we currently see. */
  private traceLocal(o: V3, d: V3, range: number, muzzle: THREE.Vector3): { point: THREE.Vector3; player: boolean } {
    const m = rayMap(RAPIER, this.world, { x: o[0], y: o[1], z: o[2] }, { x: d[0], y: d[1], z: d[2] }, range, this.motor.collider);
    let best = Math.min(m.toi, range);
    let player = false;
    for (const v of this.views.values()) {
      if (v.slot === this.conn.slot || !v.alive) continue;
      const p = v.view.root.position;
      const hs = raySphere(o, d, [p.x, p.y + HITBOX.headY, p.z], HITBOX.headRadius);
      const bc = rayCapsule(o, d, [p.x, p.y + HITBOX.bodyBottom + HITBOX.bodyRadius, p.z], [p.x, p.y + HITBOX.bodyTop - HITBOX.bodyRadius * 0.5, p.z], HITBOX.bodyRadius);
      const t = Math.min(hs, bc);
      if (t < best) { best = t; player = true; }
    }
    const point = new THREE.Vector3(o[0] + d[0] * best, o[1] + d[1] * best, o[2] + d[2] * best);
    const md = _v.subVectors(point, muzzle);
    const ml = md.length();
    if (ml > 0.3) {
      md.divideScalar(ml);
      const blk = rayMap(RAPIER, this.world, { x: muzzle.x, y: muzzle.y, z: muzzle.z }, { x: md.x, y: md.y, z: md.z }, ml - 0.05, this.motor.collider);
      if (blk.toi < ml - 0.15) return { point: muzzle.clone().addScaledVector(md, blk.toi), player: false };
    }
    return { point, player };
  }

  /** Play an emote: locally now, the server relays it (2 s cooldown). */
  playEmote(id: number) {
    const em = EMOTES[id];
    const v = this.views.get(this.conn.slot);
    if (!em || !v || !this.alive || this.clock - this.lastEmoteT < 2) return;
    this.lastEmoteT = this.clock;
    this.emoteStart = this.clock;
    v.view.emote(em.clip, em.loop);
    this.conn.sendEmote(id);
  }
  private lastEmoteT = -10;
  private emoteStart = -10;
  /** emote wheel: open while E is held; selection from mouse direction or 1-7 */
  wheel = { open: false, x: 0, y: 0, sel: -1 };

  /** 0..1 for the crosshair: current spread relative to the weapon's widest. */
  crosshairSpread() {
    const ws = WEAPONS[this.weapon];
    if (ws.pellets > 1) return 0.9 * (this.input.aim ? ws.aimSpreadMul : 1);
    const s = (ws.spreadMinDeg + this.bloom) * (this.input.aim ? ws.aimSpreadMul : 1);
    const moving = Math.hypot(this.ms.vx, this.ms.vz) > 1 ? 0.15 : 0;
    return Math.min(1, s / ws.spreadMaxDeg + moving + (this.ms.grounded ? 0 : 0.25));
  }

  // ---------- per frame ----------
  update(dtRaw: number) {
    const dt = Math.min(dtRaw, 0.05);
    this.clock += dt;
    this.fps = this.fps * 0.95 + (1 / Math.max(1e-3, dtRaw)) * 0.05;
    const ui = useUI.getState();
    const phase = this.meta?.phase ?? "warmup";
    const frozen = phase === "results" || ui.menu;
    const pressed = this.input.consumePressed();
    const look = this.input.consumeLook();

    // ---- emote wheel (hold E) ----
    const eHeld = this.input.keys.has("KeyE") && this.alive && !frozen;
    if (eHeld && !this.wheel.open) { this.wheel = { open: true, x: 0, y: 0, sel: -1 }; ui.set({ wheel: -1 } as any); }
    if (this.wheel.open) {
      this.wheel.x += look.x; this.wheel.y += look.y;
      const r = Math.hypot(this.wheel.x, this.wheel.y);
      if (r > 400) { this.wheel.x *= 400 / r; this.wheel.y *= 400 / r; }
      if (r > 30) {
        const a = (Math.atan2(this.wheel.x, -this.wheel.y) + Math.PI * 2) % (Math.PI * 2);
        this.wheel.sel = Math.round(a / ((Math.PI * 2) / EMOTES.length)) % EMOTES.length;
      }
      for (let k = 0; k < EMOTES.length; k++) if (pressed.has(`Digit${k + 1}`)) { this.wheel.sel = k; pressed.delete(`Digit${k + 1}`); }
      if ((ui as any).wheel !== this.wheel.sel) ui.set({ wheel: this.wheel.sel } as any);
      if (!eHeld) {
        if (this.wheel.sel >= 0) this.playEmote(this.wheel.sel);
        this.wheel.open = false;
        ui.set({ wheel: null } as any);
      }
      look.x = 0; look.y = 0; // the mouse drives the wheel, not the camera
    }
    // moving or shooting cancels your emote
    const myV = this.views.get(this.conn.slot);
    if (myV?.view.emoting && this.clock - this.emoteStart > 0.25) {
      const ax = this.input.axis();
      if (ax.fwd || ax.right || this.input.fire || this.input.keys.has("Space")) myV.view.stopEmote();
    }

    // ---- look ----
    if (!frozen) {
      const sens = 0.0022 * this.input.sensitivity * (this.input.aim ? 0.75 : 1);
      this.yaw -= look.x * sens;
      this.pitch -= look.y * sens * (this.input.invertY ? -1 : 1);
      this.pitch = Math.max(-1.25, Math.min(1.2, this.pitch));
      // viewmodel sway lags behind the look and bobs with the stride
      this.swayV.x += (-look.x * 0.00008 - this.swayV.x) * 0.2;
      this.swayV.y += (look.y * 0.00008 - this.swayV.y) * 0.2;
    }
    // ---- weapons input ----
    if (this.alive && !frozen) {
      if (pressed.has("Digit1")) this.selectWeapon(0);
      if (pressed.has("Digit2")) this.selectWeapon(1);
      if (pressed.has("Digit3")) this.selectWeapon(2);
      if (pressed.has("KeyQ")) this.selectWeapon(this.lastWeapon);
      const wh = this.input.consumeWheel();
      if (wh) {
        const order: WeaponId[] = this.ammo[2] > 0 ? [0, 1, 2] : [0, 1];
        const i = order.indexOf(this.weapon);
        this.selectWeapon(order[(i + (wh > 0 ? 1 : order.length - 1)) % order.length]);
      }
      if (pressed.has("KeyR")) this.startReload();
    }
    if (pressed.has("KeyV")) { this.fp = !this.fp; ui.set({ fp: this.fp } as any); }
    if (pressed.has("Tab")) ui.set({ scoreboard: true });
    if (!this.input.keys.has("Tab") && ui.scoreboard) ui.set({ scoreboard: false });
    this.tickReload();
    const ws = WEAPONS[this.weapon];
    if (ws.bloomRecoverDegPerS) this.bloom = Math.max(0, this.bloom - ws.bloomRecoverDegPerS * dt * (this.input.fire ? 0.15 : 1));

    // ---- local movement (prediction) ----
    const axis = this.input.axis();
    // crouch: C toggles (primary: Ctrl+click is right-click on a Mac), holding Ctrl also works
    if (pressed.has("KeyC") && !frozen) this.crouchToggle = !this.crouchToggle;
    const wantCrouch = this.alive && (this.crouchToggle || this.input.keys.has("ControlLeft") || this.input.keys.has("ControlRight"));
    const inp = { fwd: axis.fwd, right: axis.right, yaw: this.yaw, jump: this.input.keys.has("Space"), dash: this.input.keys.has("ShiftLeft") || this.input.keys.has("ShiftRight"), aim: this.input.aim, crouch: wantCrouch };
    if (this.alive) {
      // fixed sub-steps for stability
      let left = dt;
      while (left > 1e-4) {
        const h = Math.min(left, 1 / 60);
        this.motor.step(this.ms, inp, h, this.clock - left + h, frozen);
        left -= h;
        const ev = this.ms.events;
        if (ev & MOTOR_EV_JUMP) audio.play("jump", { vol: 0.5 });
        if (ev & MOTOR_EV_LAND) { audio.play("land", { vol: 0.5 }); this.vfx.puff(new THREE.Vector3(this.ms.x, this.ms.y + 0.1, this.ms.z), { dust: true, size: 0.8, life: 0.6 }); }
        if (ev & MOTOR_EV_DASH) { audio.play("dash", { vol: 0.6 }); this.vfx.puff(new THREE.Vector3(this.ms.x, this.ms.y + 0.3, this.ms.z), { dust: true, size: 1, life: 0.5 }); }
        if (ev & MOTOR_EV_PAD) audio.play("pad", { vol: 0.8 });
      }
      this.world.step();
      // footsteps
      const sp = Math.hypot(this.ms.vx, this.ms.vz);
      if (this.ms.grounded && sp > 1.5) {
        this.stepAcc += dt * sp;
        if (this.stepAcc > 2.1) { this.stepAcc = 0; audio.play(`step${(Math.random() * 5) | 0}` as any, { vol: 0.35 }); }
      }
    } else {
      this.world.step();
    }

    // ---- camera ----
    const aimTarget = this.input.aim && this.alive && !frozen ? 1 : 0;
    this.aimBlend += (aimTarget - this.aimBlend) * Math.min(1, dt * 12);
    this.recoilPitch *= Math.pow(0.001, dt / 0.12 / 3);
    this.recoilYaw *= Math.pow(0.001, dt / 0.12 / 3);
    this.kickPitch *= Math.pow(0.001, dt / 0.12 / 3);
    const viewPitch = this.pitch + this.recoilPitch + this.kickPitch;
    const viewYaw = this.yaw + this.recoilYaw; // the camera stays put while emoting (Rhett)
    const baseFov = ui.settings.fov;
    const fov = baseFov + (EYE.aimFov - EYE.fov) * this.aimBlend;
    if (Math.abs(fov - this.fovCur) > 0.01) { this.fovCur = fov; this.camera.fov = fov; this.camera.updateProjectionMatrix(); }
    const fwd = new THREE.Vector3(-Math.sin(viewYaw) * Math.cos(viewPitch), Math.sin(viewPitch), -Math.cos(viewYaw) * Math.cos(viewPitch));
    const right = new THREE.Vector3(Math.cos(viewYaw), 0, -Math.sin(viewYaw));
    const fpNow = this.fp && this.alive && !frozen;
    if (fpNow) {
      if (this.camera.near !== 0.01) { this.camera.near = 0.01; this.camera.updateProjectionMatrix(); }
      const f2 = baseFov + 15 + (EYE.aimFov - EYE.fov) * this.aimBlend * 0.6;
      if (Math.abs(f2 - this.camera.fov) > 0.01) { this.camera.fov = f2; this.fovCur = f2; this.camera.updateProjectionMatrix(); }
    } else if (this.camera.near !== 0.1) { this.camera.near = 0.1; this.camera.updateProjectionMatrix(); }
    let pivot: THREE.Vector3;
    let back = EYE.back + (EYE.aimBack - EYE.back) * this.aimBlend;
    this.crouchBlend += ((this.ms.crouched ? 1 : 0) - this.crouchBlend) * Math.min(1, dt * 10);
    if (this.alive) {
      pivot = new THREE.Vector3(this.ms.x, this.ms.y + EYE.up - 0.5 * this.crouchBlend, this.ms.z);
    } else {
      // death cam: pull back and watch the ragdoll
      const rag = this.views.get(this.conn.slot);
      const p = rag ? this.ragdolls.center(rag.view) ?? this.deathPos : this.deathPos;
      pivot = new THREE.Vector3(p.x, p.y + 1.0, p.z);
      back = 4.5 + Math.min(1.5, this.clock - this.deadAt) * 1.2;
    }
    const shoulder = pivot.clone().addScaledVector(right, EYE.right * 0.5);
    const desired = shoulder.clone().addScaledVector(right, EYE.right * 0.5).addScaledVector(fwd, -back);
    const toCam = _v.subVectors(desired, shoulder);
    const dist = toCam.length();
    toCam.divideScalar(dist);
    const hit = rayMap(RAPIER, this.world, { x: shoulder.x, y: shoulder.y, z: shoulder.z }, { x: toCam.x, y: toCam.y, z: toCam.z }, dist + 0.25, this.motor.collider);
    const camDist = Math.min(dist, Math.max(0.4, hit.toi - 0.25));
    this.camBack += (camDist - this.camBack) * (camDist < this.camBack ? 1 : Math.min(1, dt * 6));
    const camPos = shoulder.clone().addScaledVector(toCam, this.camBack);
    if (this.vfx.shake > 0) camPos.add(new THREE.Vector3((Math.random() - 0.5) * this.vfx.shake, (Math.random() - 0.5) * this.vfx.shake, (Math.random() - 0.5) * this.vfx.shake).multiplyScalar(0.4));

    if (!this.everSpawned && !this.debugCam) {
      const t = this.clock * 0.08 + 0.6;
      this.camera.position.set(Math.cos(t) * 46, 20, Math.sin(t) * 46);
      this.camera.lookAt(0, 2, 0);
    } else if (this.debugCam) {
      this.camera.position.set(...this.debugCam.pos);
      this.camera.lookAt(...this.debugCam.target);
    } else if (phase === "results" && this.meta) {
      this.showPodium(dt);
    } else if (fpNow) {
      this.fpEye.set(this.ms.x, this.ms.y + FP_EYE - 0.5 * this.crouchBlend, this.ms.z);
      if (this.vfx.shake > 0) this.fpEye.add(new THREE.Vector3((Math.random() - 0.5) * this.vfx.shake * 0.15, (Math.random() - 0.5) * this.vfx.shake * 0.15, 0));
      this.camera.position.copy(this.fpEye);
      this.camera.lookAt(_v2.copy(this.fpEye).add(fwd));
    } else if (!this.alive && this.everSpawned) {
      this.deathCamera(dt);
    } else {
      this.camera.position.copy(camPos);
      this.camera.lookAt(_v2.copy(camPos).add(fwd));
    }
    // swoop into a fresh spawn from wherever the death camera was
    if (this.alive && this.swoop && !this.debugCam) {
      const k = Math.min(1, (this.clock - this.swoop.t) / 0.55);
      const e = 1 - Math.pow(1 - k, 3);
      const q = this.camera.quaternion.clone();
      this.camera.position.lerpVectors(this.swoop.pos, this.camera.position, e);
      this.camera.quaternion.slerpQuaternions(this.swoop.quat, q, e);
      if (k >= 1) this.swoop = null;
    }
    audio.setListener(this.camera.position.x, this.camera.position.y, this.camera.position.z, fwd.x, fwd.y, fwd.z);

    // ---- shooting ----
    if (this.alive && !frozen && this.input.locked && this.input.fire) {
      if (ws.auto || this.clock - this.lastFireLocal > 1 / ws.rate) {
        const before = this.ammo[this.weapon];
        this.tryFire(this.camera.position.clone(), fwd);
        if (!ws.auto && before !== this.ammo[this.weapon]) this.input.fire = false; // semi-auto: one per click
      }
    }

    // ---- send state ----
    this.sendAcc += dt;
    if (this.sendAcc >= 1 / INPUT_HZ) {
      this.sendAcc = 0;
      let f = 0;
      if (this.ms.grounded) f |= PF_GROUNDED;
      if (this.input.aim) f |= PF_AIM;
      if (this.clock < this.ms.dashUntil) f |= PF_DASH;
      if (this.reloadUntil > this.clock) f |= PF_RELOAD;
      if (this.ms.launched) f |= PF_LAUNCHED;
      if (this.ms.crouched) f |= PF_CROUCH;
      if (this.alive) this.conn.sendState({ s: this.seq++, t: this.conn.serverNow(), p: [r3(this.ms.x), r3(this.ms.y), r3(this.ms.z)], v: [r3(this.ms.vx), r3(this.ms.vy), r3(this.ms.vz)], y: r3(this.yaw), pi: r3(this.pitch), f, w: this.weapon });
      else this.conn.sendState({ s: this.seq++, t: this.conn.serverNow(), p: [r3(this.ms.x), r3(this.ms.y), r3(this.ms.z)], v: [0, 0, 0], y: r3(this.yaw), pi: r3(this.pitch), f: 0, w: this.weapon });
    }

    // ---- remote interpolation + animation ----
    this.updateViews(dt);
    this.updateWorldObjects(dt);
    this.ragdolls.update(dt);
    this.vfx.update(dt);

    // ---- HUD ----
    this.hudAcc += dt;
    if (this.hudAcc > 1 / 15) {
      this.hudAcc = 0;
      this.pushHud();
    }
    this.updateDamageArcs(dt);
  }

  private updateViews(dt: number) {
    const renderT = this.conn.serverNow() - INTERP_DELAY_MS;
    const snaps = this.snaps;
    let a: Snapshot | undefined, b: Snapshot | undefined;
    for (let i = snaps.length - 1; i >= 0; i--) if (snaps[i].t <= renderT) { a = snaps[i]; b = snaps[i + 1]; break; }
    if (!a && snaps.length) a = snaps[0];
    for (const v of this.views.values()) {
      const isMe = v.slot === this.conn.slot;
      if (isMe) {
        v.alive = this.alive;
        v.view.glow = !!(this.mine && this.mine.f & PF_GLOW);
        v.view.protect = this.protect;
        if (!this.everSpawned) { v.view.root.visible = false; continue; }
        if (!this.alive) { if (!v.ragdolled) { v.view.update(dt, this.charState(this.ms.vx, this.ms.vz, 0, this.yaw, this.pitch, true, false, false, false, false)); } continue; }
        const fpNow = this.fp && !(this.meta?.phase === "results");
        v.view.root.position.set(this.ms.x, this.ms.y, this.ms.z);
        v.view.root.scale.setScalar(1);
        v.view.setFirstPerson(fpNow);
        if (fpNow) {
          const sp = Math.hypot(this.ms.vx, this.ms.vz);
          this.swayT += dt * (sp > 0.5 && this.ms.grounded ? sp * 1.6 : 1.2);
          const bob = sp > 0.5 && this.ms.grounded ? 0.012 : 0.002;
          v.view.sway.set(this.swayV.x + Math.sin(this.swayT) * bob, this.swayV.y + Math.abs(Math.cos(this.swayT)) * bob, 0);
        }
        if (v.view.weapon !== this.weapon && v.view["pendingWeapon"] === null) v.view.switchWeapon(this.weapon);
        v.view.crouch = this.ms.crouched;
        v.view.update(dt, this.charState(this.ms.vx, this.ms.vz, this.ms.vy, this.yaw, this.pitch + this.recoilPitch, this.ms.grounded, this.input.aim, this.reloadUntil > this.clock, this.clock < this.ms.dashUntil, true));
        if (fpNow) {
          v.view.applyViewmodel(_v3.set(this.ms.x, this.ms.y + FP_EYE - 0.5 * this.crouchBlend, this.ms.z), true, this.pitch + this.recoilPitch);
          // first person: others see your emote; you just don't see your own viewmodel during it
          v.view.root.visible = !v.view.emoting;
        } else {
          v.view.applyViewmodel(_v3, false);
          v.view.root.visible = this.camBack > 0.9; // hide when the camera is jammed into the head
        }
        continue;
      }
      if (!a) continue;
      const pa = a.players.find((p) => p.id === v.slot);
      if (!pa) continue;
      const pb = b?.players.find((p) => p.id === v.slot);
      let x = pa.x, y = pa.y, z = pa.z, yaw = pa.yaw, pitch = pa.pitch, vx = pa.vx, vz = pa.vz, vy = pa.vy;
      let flags = pa.f;
      if (pb && b) {
        const k = Math.max(0, Math.min(1, (renderT - a.t) / Math.max(1, b.t - a.t)));
        // don't interpolate across a respawn teleport
        const jump = Math.hypot(pb.x - pa.x, pb.z - pa.z) > 8;
        if (!jump) {
          x = pa.x + (pb.x - pa.x) * k; y = pa.y + (pb.y - pa.y) * k; z = pa.z + (pb.z - pa.z) * k;
          yaw = lerpAngle(pa.yaw, pb.yaw, k); pitch = pa.pitch + (pb.pitch - pa.pitch) * k;
          vx = pa.vx + (pb.vx - pa.vx) * k; vz = pa.vz + (pb.vz - pa.vz) * k; vy = pa.vy + (pb.vy - pa.vy) * k;
        } else if (k > 0.5) { x = pb.x; y = pb.y; z = pb.z; yaw = pb.yaw; }
        flags = k > 0.5 ? pb.f : pa.f;
      } else {
        const ex = Math.min(MAX_EXTRAPOLATE_MS, renderT - a.t) / 1000;
        if (ex > 0) { x += vx * ex; y += vy * ex; z += vz * ex; }
      }
      const alive = !!(flags & PF_ALIVE);
      if (alive && !v.alive && !v.ragdolled) { v.view.revive(); }
      if (alive && v.ragdolled) { this.ragdolls.release(v.view); v.ragdolled = false; v.view.revive(); }
      v.alive = alive;
      const w = (pb ?? pa).w;
      if (w !== v.view.weapon) v.view.switchWeapon(w);
      if (v.view.emoting && (Math.hypot(vx, vz) > 0.8 || flags & PF_FIRE)) v.view.stopEmote();
      const reloading = !!(flags & PF_RELOAD);
      if (reloading && !v.reloading) v.view.reload(WEAPONS[w].reloadS);
      v.reloading = reloading;
      v.view.glow = !!(flags & PF_GLOW);
      v.view.protect = !!(flags & PF_PROTECT);
      v.view.crouch = !!(flags & PF_CROUCH);
      if (v.ragdolled) continue;
      v.view.root.position.set(x, y, z);
      v.view.root.visible = alive || v.ragdolled;
      // remote players beyond 30 m animate at 15 Hz
      const far = v.view.root.position.distanceTo(this.camera.position) > 30;
      v.lastAnimT += dt;
      if (!far || v.lastAnimT > 1 / 15) {
        v.view.update(v.lastAnimT, this.charState(vx, vz, vy, yaw, pitch, !!(flags & PF_GROUNDED) || Math.abs(vy) < 0.5, !!(flags & PF_AIM), reloading, !!(flags & PF_DASH), alive));
        v.lastAnimT = 0;
      } else v.view.root.rotation.y = yaw;
      // remote footsteps (quiet, positional)
      const sp = Math.hypot(vx, vz);
      if (sp > 2 && flags & PF_GROUNDED) {
        v.stepT += dt * sp;
        if (v.stepT > 2.2) { v.stepT = 0; audio.play(`step${(Math.random() * 5) | 0}` as any, { at: [x, y, z], vol: 0.25 }); }
      }
    }
  }

  private charState(vx: number, vz: number, vy: number, yaw: number, pitch: number, grounded: boolean, aim: boolean, reloading: boolean, dashing: boolean, alive: boolean) {
    return { vx, vz, vy, yaw, pitch, grounded, aim, weapon: this.weapon, reloading, dashing, alive };
  }

  private updateWorldObjects(dt: number) {
    const t = performance.now() / 1000;
    // pickups bob + spin
    for (const g of this.pickupVis) {
      const item = g.getObjectByName("item")!;
      item.rotation.y = t * 1.6;
      item.position.y = 0.9 + Math.sin(t * 2.2 + g.position.x) * 0.12;
    }
    if (this.arcPillar) {
      // the light pillar fades out as the camera gets close: on the tower roof the camera was inside the
      // additive cylinder and it flickered across the middle of the screen
      const d = Math.hypot(this.camera.position.x, this.camera.position.z);
      const near = THREE.MathUtils.smoothstep(d, 1.5, 7);
      (this.arcPillar.material as THREE.MeshBasicMaterial).opacity = (0.11 + Math.sin(t * 1.5) * 0.02) * near;
    }
    // pads: rings rise
    for (const pad of this.map.pads) for (const c of pad.children) {
      if (c.userData.ring === undefined) continue;
      const k = ((t * 0.9 + c.userData.ring / 3) % 1);
      c.position.y = 0.2 + k * 2.2;
      c.scale.setScalar(1 - k * 0.35);
      ((c as THREE.Mesh).material as THREE.MeshBasicMaterial).opacity = 0.7 * (1 - k);
    }
    // props + grenades from interpolated snapshots
    const renderT = this.conn.serverNow() - INTERP_DELAY_MS;
    const snaps = this.snaps;
    let a: Snapshot | undefined, b: Snapshot | undefined;
    for (let i = snaps.length - 1; i >= 0; i--) if (snaps[i].t <= renderT) { a = snaps[i]; b = snaps[i + 1]; break; }
    if (!a) return;
    const k = b ? Math.max(0, Math.min(1, (renderT - a.t) / Math.max(1, b.t - a.t))) : 0;
    const qa = new THREE.Quaternion(), qb = new THREE.Quaternion();
    for (const pa of a.props) {
      const pb = b?.props.find((p) => p.i === pa.i) ?? pa;
      const vis = this.propVis[pa.i];
      if (!vis) continue;
      vis.position.set(pa.x + (pb.x - pa.x) * k, pa.y + (pb.y - pa.y) * k, pa.z + (pb.z - pa.z) * k);
      qa.set(pa.qx, pa.qy, pa.qz, pa.qw); qb.set(pb.qx, pb.qy, pb.qz, pb.qw);
      vis.quaternion.copy(qa).slerp(qb, k);
    }
    const seen = new Set<number>();
    for (const ga of a.grenades) {
      seen.add(ga.id);
      const gb = b?.grenades.find((g) => g.id === ga.id) ?? ga;
      let gv = this.grenadeVis.get(ga.id);
      if (!gv) {
        const mesh = new THREE.Group();
        const core = assets!.weapons.scene.getObjectByName("grenade")!.clone(true);
        core.scale.setScalar(1.6);
        core.position.y = -0.18;
        mesh.add(core);
        const glow = new THREE.Mesh(new THREE.SphereGeometry(0.16, 12, 12), new THREE.MeshBasicMaterial({ color: "#caa8ff", toneMapped: false }));
        mesh.add(glow);
        const l = new THREE.PointLight("#a77bff", 3, 4, 2);
        mesh.add(l);
        const line = new THREE.Line(new THREE.BufferGeometry().setFromPoints(Array.from({ length: 16 }, () => new THREE.Vector3())), new THREE.LineBasicMaterial({ color: "#b892ff", transparent: true, opacity: 0.8, toneMapped: false }));
        line.frustumCulled = false;
        this.root.add(mesh, line);
        gv = { mesh, trail: [], line, last: 0 };
        this.grenadeVis.set(ga.id, gv);
      }
      gv.mesh.position.set(ga.x + (gb.x - ga.x) * k, ga.y + (gb.y - ga.y) * k, ga.z + (gb.z - ga.z) * k);
      gv.mesh.rotation.x += dt * 9;
      gv.trail.push(gv.mesh.position.clone());
      if (gv.trail.length > 16) gv.trail.shift();
      const pts = [...gv.trail];
      while (pts.length < 16) pts.unshift(pts[0]);
      gv.line.geometry.setFromPoints(pts);
    }
    for (const [id, gv] of this.grenadeVis) if (!seen.has(id)) { gv.mesh.removeFromParent(); gv.line.removeFromParent(); this.grenadeVis.delete(id); }
    void dt;
  }

  /**
   * Death camera, always the same shot: ~0.6 s close on your ragdoll (or where you fell), then an eased
   * pull-back to the wide establishing orbit of the fort for the rest of the countdown. (It used to follow
   * the ragdoll's pelvis, so falls off the island and the "4 ragdolls live" fallback made it zoom out
   * only sometimes.)
   */
  private deathCamera(dt: number) {
    const t = this.clock - this.deadAt;
    const rag = this.views.get(this.conn.slot);
    let focus = (rag && this.ragdolls.center(rag.view)) || this.deathPos;
    if (focus.y < this.deathPos.y - 6) focus = this.deathPos; // don't chase a body into the void
    const closeTarget = new THREE.Vector3(focus.x, Math.max(focus.y, this.deathPos.y) + 0.8, focus.z);
    const yaw = this.yaw + t * 0.25;
    const close = closeTarget.clone().add(new THREE.Vector3(Math.sin(yaw) * 4.2, 2.2, Math.cos(yaw) * 4.2));
    const a = this.clock * 0.05 + Math.atan2(this.deathPos.z, this.deathPos.x);
    const wide = new THREE.Vector3(Math.cos(a) * 46, 22, Math.sin(a) * 46);
    const wideTarget = new THREE.Vector3(0, 2, 0);
    const k = THREE.MathUtils.smoothstep(t, 0.6, 1.9);
    const pos = close.lerp(wide, k), target = closeTarget.lerp(wideTarget, k);
    this.camera.position.lerp(pos, Math.min(1, dt * (t < 0.1 ? 60 : 8)));
    this.camera.lookAt(target);
  }
  private swoop: { t: number; pos: THREE.Vector3; quat: THREE.Quaternion } | null = null;

  // ---------- results podium ----------
  private clearPodium() {
    for (const p of this.podium) p.dispose();
    this.podium = [];
  }
  private showPodium(dt: number) {
    const m = this.meta!;
    if (!this.resultsShown) {
      this.resultsShown = true;
      this.clearPodium();
      const top = [...m.roster].sort((a, b) => b.score - a.score || a.d - b.d).slice(0, 3);
      const spots: [number, number, number][] = [[0, 7.0, 0.2], [1.6, 7.0, -0.5], [-1.6, 7.0, -0.5]];
      top.forEach((r, i) => {
        const c = new CharacterView(r.suit);
        c.root.position.set(...spots[i]);
        c.root.rotation.y = Math.PI; // face the podium camera (+Z side, clear of the roof flag)
        c.root.position.y += i === 0 ? 0.5 : 0.2;
        c.celebrate(i === 0 ? "wave" : "yes");
        this.root.add(c.root);
        this.podium.push(c);
      });
      // hide the live players near the podium
    }
    for (const p of this.podium) p.update(dt, p.lookdevState);
    const t = this.clock;
    const cam = new THREE.Vector3(Math.sin(t * 0.15) * 1.2, 9.0, 6.4);
    this.camera.position.lerp(cam, 0.08);
    this.camera.lookAt(0, 8.6, 0);
  }

  // ---------- HUD ----------
  private pushHud() {
    const ui = useUI.getState();
    const me = this.mine;
    const respawnIn = this.alive ? 0 : Math.max(0, RULES.respawnS - (this.clock - this.deadAt));
    const hud = {
      ...ui.hud,
      hp: me ? me.hp : 100,
      shield: me ? me.sh : 0,
      ammo: this.ammo[this.weapon],
      mag: WEAPONS[this.weapon].mag,
      weapon: this.weapon,
      arc: this.ammo[2],
      reloading: this.reloadUntil > this.clock,
      dashReady: Math.max(0, Math.min(1, 1 - (this.ms.dashReadyT - this.clock) / MOVE.dashCooldown)),
      alive: this.alive,
      respawnIn,
      protect: this.protect,
      lowHp: !!me && me.hp < 30 && this.alive,
      killerHp: this.killer >= 0 ? this.lastHp(this.killer) : ui.hud.killerHp,
    };
    ui.set({ hud, fps: Math.round(this.fps) });
  }

  private hitmarker(kind: "hit" | "head" | "kill") {
    const el = this.overlay.querySelector<HTMLElement>(".hitmarker");
    if (!el) return;
    el.className = `hitmarker show ${kind}`;
    void el.offsetWidth;
    clearTimeout((el as any)._t);
    (el as any)._t = setTimeout(() => (el.className = "hitmarker"), 140);
  }

  private damageNumber(at: V3, dmg: number, head: boolean, kill: boolean) {
    const el = document.createElement("div");
    el.className = `dmgnum${head ? " head" : ""}${kill ? " kill" : ""}`;
    el.textContent = String(dmg);
    this.overlay.appendChild(el);
    const p = new THREE.Vector3(at[0], at[1] + 0.2, at[2]);
    const start = performance.now();
    const step = () => {
      const k = (performance.now() - start) / 600;
      if (k >= 1) { el.remove(); return; }
      const q = p.clone().add(new THREE.Vector3(0, k * 0.8, 0)).project(this.camera);
      if (q.z > 1) { el.style.opacity = "0"; } else {
        const w = this.overlay.clientWidth, h = this.overlay.clientHeight;
        el.style.transform = `translate(${((q.x + 1) / 2) * w}px, ${((1 - q.y) / 2) * h}px) translate(-50%, -50%) scale(${1 + (1 - k) * 0.2})`;
        el.style.opacity = String(1 - k * k);
      }
      requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }

  private updateDamageArcs(dt: number) {
    const host = this.overlay.querySelector<HTMLElement>(".dmgarcs");
    if (!host) return;
    this.damageArcs = this.damageArcs.filter((a) => (a.t -= dt) > 0);
    while (host.children.length < this.damageArcs.length) { const d = document.createElement("div"); d.className = "dmgarc"; host.appendChild(d); }
    while (host.children.length > this.damageArcs.length) host.lastChild!.remove();
    this.damageArcs.forEach((a, i) => {
      const dx = a.from[0] - this.ms.x, dz = a.from[2] - this.ms.z;
      const ang = Math.atan2(-dx, -dz) - this.yaw; // 0 = in front
      const el = host.children[i] as HTMLElement;
      el.style.transform = `rotate(${-ang}rad)`;
      el.style.opacity = String(Math.min(1, a.t * 1.5));
    });
  }
}

function r3(n: number) { return Math.round(n * 1000) / 1000; }
void SUITS; void _v3; void PF_LAUNCHED;
