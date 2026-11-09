// One rigged character: layered animation (locomotion lower body, weapon upper body, additive hit react),
// procedural aim pitch / leg yaw / recoil / reload / swap, weapons in the hand socket, suit tint, hit flash.
import * as THREE from "three";
import { clone as cloneSkinned } from "three/examples/jsm/utils/SkeletonUtils.js";
import { assets } from "../assets";
import { SUITS, type WeaponId } from "@blastside/shared";

export const CHAR_SCALE = 0.86;

// Bone groups (Quaternius rig: feet + pole targets are children of Root, the rest hangs off Body/Hips).
const LOWER = new Set(["Root", "Body", "Hips", "UpperLegL", "LowerLegL", "FootL", "UpperLegR", "LowerLegR", "FootR", "PoleTargetL", "PoleTargetR", "CharacterArmature"]);

function filterClip(clip: THREE.AnimationClip, keep: (bone: string) => boolean, name: string) {
  const tracks = clip.tracks.filter((t) => keep(t.name.split(".").slice(0, -1).join(".")));
  return new THREE.AnimationClip(name, clip.duration, tracks);
}

/** Static pose from one moment of a clip. */
function poseClip(clip: THREE.AnimationClip, t: number, name: string) {
  const tracks = clip.tracks.map((tr) => {
    const v = (tr as any).createInterpolant().evaluate(t).slice();
    const T = tr.constructor as any;
    return new T(tr.name, [0], Array.from(v));
  });
  return new THREE.AnimationClip(name, 0.5, tracks);
}

export interface WeaponRig {
  root: THREE.Object3D;
  muzzle: THREE.Object3D;
  mag?: THREE.Object3D;
}

/** Per-weapon placement in the hand socket (tuned in ?lookdev). */
export const WEAPON_FIT: Record<WeaponId, { pos: [number, number, number]; rot: [number, number, number]; scale: number; muzzle: [number, number, number]; gripL: [number, number, number]; mag?: [number, number, number] }> = {
  0: { pos: [0, -0.06, -0.12], rot: [0, 0, 0], scale: 1.7, muzzle: [0, 0.04, -0.34], gripL: [-0.07, -0.05, -0.17], mag: [0, -0.12, -0.02] },
  1: { pos: [0, -0.06, -0.08], rot: [0, 0, 0], scale: 1.6, muzzle: [0, 0.02, -0.22], gripL: [-0.1, -0.06, -0.12] },
  2: { pos: [0, -0.04, -0.06], rot: [0, 0, 0], scale: 1.6, muzzle: [0, 0.0, -0.3], gripL: [-0.1, -0.08, -0.12] },
};

const WEAPON_NODE: Record<WeaponId, string> = { 0: "rifle", 1: "scatter", 2: "arc" };

export function makeWeapon(w: WeaponId): WeaponRig {
  const src = assets!.weapons.scene.getObjectByName(WEAPON_NODE[w])!;
  const root = new THREE.Group();
  const model = src.clone(true);
  model.position.set(0, 0, 0);
  root.add(model);
  root.traverse((o) => { if ((o as THREE.Mesh).isMesh) { o.castShadow = true; } });
  const muzzle = new THREE.Object3D();
  root.add(muzzle);
  let mag: THREE.Object3D | undefined;
  if (w === 0) {
    mag = assets!.weapons.scene.getObjectByName("mag")!.clone(true);
    root.add(mag);
  }
  return { root, muzzle, mag };
}

export interface CharState {
  /** velocity in world space */
  vx: number; vz: number; vy: number;
  yaw: number;
  pitch: number;
  grounded: boolean;
  aim: boolean;
  weapon: WeaponId;
  reloading: boolean;
  dashing: boolean;
  alive: boolean;
}

const UP = new THREE.Vector3(0, 1, 0);
const PROCEDURAL_BONES = ["Root", "Body", "Hips", "Abdomen", "Torso", "Neck", "Head", "UpperArmL", "LowerArmL", "UpperArmR", "LowerArmR", "ShoulderL", "ShoulderR"];
let SOCKET_ALIGN: { q: THREE.Quaternion; s: number } | null = null;
const _q = new THREE.Quaternion();
const _q2 = new THREE.Quaternion();
const _v = new THREE.Vector3();
const _m = new THREE.Matrix4();

export class CharacterView {
  readonly root = new THREE.Group();
  readonly model: THREE.Object3D;
  readonly mixer: THREE.AnimationMixer;
  readonly bones: Record<string, THREE.Bone> = {};
  readonly socket: THREE.Object3D;
  readonly weapons: WeaponRig[];
  readonly suitMats: THREE.MeshStandardMaterial[] = [];
  readonly allMats: THREE.MeshStandardMaterial[] = [];
  private actions: Record<string, THREE.AnimationAction> = {};
  private clips: Record<string, THREE.AnimationClip> = {};
  weapon: WeaponId = 0;
  private legYaw = 0;
  private aimPitch = 0;
  private recoil = 0;
  private reloadT = -1;
  private swapT = -1;
  private pendingWeapon: WeaponId | null = null;
  private flashT = 0;
  private hitLean = 0;
  private hitLeanDir = 1;
  private airT = 0;
  private landT = 9;
  private jumpT = 9;
  private wasGrounded = true;
  private dashT = 0;
  private deadT = -1;
  private lookdevClip: string | null = null;
  glow = false;
  /** first-person view of this character: head hidden, full pitch on the torso */
  firstPerson = false;
  crouch = false;
  private crouchW = 0;
  setFirstPerson(on: boolean) {
    this.firstPerson = on;
    this.model.traverse((o) => { if (o.name === "Character_Hazmat_Head" || o.name.startsWith("Character_Hazmat_Head")) o.visible = !on; });
  }
  /** Eye point for the first-person camera (world space), just in front of the head bone. */
  eyeWorld(out = new THREE.Vector3()) {
    const h = this.bones["Head"];
    h.getWorldPosition(out);
    out.y += 0.12;
    const fy = this.root.rotation.y;
    out.x += -Math.sin(fy) * 0.12; out.z += -Math.cos(fy) * 0.12;
    return out;
  }
  /**
   * First-person viewmodel: shrink the whole character toward the eye by `s` so the arms and gun sit a few
   * centimetres from the camera and can never clip into world geometry (classic viewmodel trick; the
   * camera's near plane drops to 1 cm in first person).
   */
  static VM_SCALE = 0.12;
  applyViewmodel(eye: THREE.Vector3, on: boolean, pitch = 0) {
    const s = on ? CharacterView.VM_SCALE : 1;
    if (on) {
      this.root.position.sub(eye).multiplyScalar(s).add(eye);
      // pitch the viewmodel about the eye with the camera, so the gun stays put on screen
      if (pitch) {
        const right = new THREE.Vector3(1, 0, 0).applyQuaternion(this.root.quaternion);
        const q = new THREE.Quaternion().setFromAxisAngle(right, pitch);
        this.root.position.sub(eye).applyQuaternion(q).add(eye);
        this.root.quaternion.premultiply(q);
      }
      // sit lower, a touch right and further out, so you see forearms and gun rather than whole arms
      const fy = this.root.rotation.y;
      const fx = -Math.sin(fy), fz = -Math.cos(fy), rx = Math.cos(fy), rz = -Math.sin(fy);
      this.root.position.x += fx * 0.035 + rx * 0.012;
      this.root.position.z += fz * 0.035 + rz * 0.012;
      this.root.position.y -= 0.028;
      this.root.scale.setScalar(s);
    } else this.root.scale.setScalar(1);
    this.model.traverse((o) => { if ((o as THREE.Mesh).isMesh) o.castShadow = !on; });
    this.root.updateMatrixWorld(true);
  }
  /** weapon sway offset in first person (set by the controller), metres in socket space */
  sway = new THREE.Vector3();
  protect = false;
  visible = true;
  suit: number;

  constructor(suit: number) {
    this.suit = suit;
    const src = assets!.character;
    this.model = cloneSkinned(src.scene);
    this.model.scale.setScalar(CHAR_SCALE);
    this.model.rotation.y = Math.PI; // model faces +Z; our yaw 0 looks down -Z
    this.root.add(this.model);
    this.model.traverse((o) => {
      if ((o as THREE.Bone).isBone) this.bones[o.name] = o as THREE.Bone;
      const mesh = o as THREE.SkinnedMesh;
      if (mesh.isMesh) {
        mesh.castShadow = true;
        mesh.receiveShadow = false;
        mesh.frustumCulled = false;
        const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
        const cloned = mats.map((m) => {
          const c = (m as THREE.MeshStandardMaterial).clone();
          this.allMats.push(c);
          if (c.name === "Hazmat_Main") this.suitMats.push(c);
          return c;
        });
        mesh.material = Array.isArray(mesh.material) ? cloned : cloned[0];
      }
    });
    this.setSuit(suit);
    // The hand socket sits in bone units (the rig is authored at 100x); a child group brings it back to
    // character metres and orients it so weapon-local -Z is the aim direction and +Y is up in the aim pose.
    const hand = this.model.getObjectByName("socket_hand_r") ?? this.bones["Index1R"];
    this.socket = new THREE.Group();
    hand.add(this.socket);
    this.weapons = ([0, 1, 2] as WeaponId[]).map((w) => {
      const rig = makeWeapon(w);
      this.socket.add(rig.root);
      rig.root.visible = w === 0;
      return rig;
    });
    this.applyWeaponFit();

    this.mixer = new THREE.AnimationMixer(this.model);
    for (const c of src.animations) this.clips[c.name] = c;
    for (const c of assets!.extraClips ?? []) this.clips[c.name] = c;
    const lower = (n: string) => LOWER.has(n);
    const upper = (n: string) => !LOWER.has(n);
    const mk = (clip: THREE.AnimationClip | undefined, name: string, keep: (b: string) => boolean, loop = true) => {
      if (!clip) return;
      const a = this.mixer.clipAction(filterClip(clip, keep, name));
      a.setLoop(loop ? THREE.LoopRepeat : THREE.LoopOnce, Infinity);
      a.clampWhenFinished = !loop;
      a.enabled = true;
      a.setEffectiveWeight(0);
      a.play();
      this.actions[name] = a;
    };
    const C = this.clips;
    // Calm "Idle" for the legs: Idle_Shoot loops a 0.33 s recoil bob through the hips, which nods the whole aim.
    mk(C.Idle ?? C.Idle_Shoot, "L_idle", lower);
    mk(C.Walk, "L_walk", lower);
    mk(C.Run, "L_run", lower);
    // Jump clips carry ~0.5 m of vertical Body motion; physics already moves us, so drop it (in place).
    const inPlace = (b: string) => lower(b);
    const strip = (c: THREE.AnimationClip | undefined) => c && new THREE.AnimationClip(c.name, c.duration, c.tracks.filter((t) => t.name !== "Body.position"));
    mk(strip(C.Jump_Idle), "L_air", inPlace);
    mk(strip(C.Jump), "L_jump", inPlace, false);
    mk(strip(C.Jump_Land), "L_land", inPlace, false);
    // crouch (retargeted UAL clips), legs only so the aim layer keeps working
    mk(C.CrouchIdle, "L_cidle", lower);
    mk(C.CrouchWalk, "L_cwalk", lower);
    // Upper body: a held aim pose from Idle_Shoot, plus a run-carry pose for sprinting.
    const aimPose = poseClip(C.Idle_Shoot ?? C.Idle, 0.0, "aimpose");
    mk(aimPose, "U_aim", upper);
    mk(C.Run_Gun ?? C.Run, "U_run", upper);
    mk(C.Death, "F_death", () => true, false);
    mk(C.Wave, "F_wave", () => true);
    mk(C.Yes, "F_yes", () => true);
    // Additive hit react
    if (C.HitReact) {
      const add = THREE.AnimationUtils.makeClipAdditive(C.HitReact.clone());
      const a = this.mixer.clipAction(add);
      a.blendMode = THREE.AdditiveAnimationBlendMode;
      a.setLoop(THREE.LoopOnce, 1);
      a.clampWhenFinished = false;
      a.setEffectiveWeight(0);
      this.actions.A_hit = a;
    }
    this.actions.L_idle?.setEffectiveWeight(1);
    this.actions.U_aim?.setEffectiveWeight(1);
    this.model.traverse((o) => { if ((o as THREE.Bone).isBone) this.bindPose.push({ b: o, p: o.position.clone(), q: o.quaternion.clone(), s: o.scale.clone() }); });
    this.restoreProcedural(); // captures the bind pose
    this.alignSocket();
  }

  /** Orient the socket from the aim pose: weapon -Z = character forward, +Y = up. Cached per rig. */
  private alignSocket() {
    if (!SOCKET_ALIGN) {
      this.mixer.update(0);
      this.root.updateMatrixWorld(true);
      const parent = this.socket.parent!;
      const pq = new THREE.Quaternion(), ps = new THREE.Vector3(), pp = new THREE.Vector3();
      parent.matrixWorld.decompose(pp, pq, ps);
      // desired world orientation: root's frame (yaw 0, character looks down -Z)
      const want = this.root.getWorldQuaternion(new THREE.Quaternion());
      const local = pq.clone().invert().multiply(want);
      SOCKET_ALIGN = { q: local, s: CHAR_SCALE / ps.x };
    }
    this.socket.quaternion.copy(SOCKET_ALIGN.q);
    this.socket.scale.setScalar(SOCKET_ALIGN.s);
  }

  setSuit(suit: number) {
    this.suit = suit;
    const col = new THREE.Color(SUITS[suit % SUITS.length].color);
    for (const m of this.suitMats) { m.color.copy(col); m.roughness = 0.55; }
  }

  applyWeaponFit() {
    for (const w of [0, 1, 2] as WeaponId[]) {
      const f = WEAPON_FIT[w], rig = this.weapons[w];
      rig.root.position.set(...f.pos);
      rig.root.rotation.set(...f.rot);
      rig.root.scale.setScalar(f.scale);
      rig.muzzle.position.set(...f.muzzle);
      if (rig.mag && f.mag) rig.mag.position.set(...f.mag);
    }
  }

  muzzleWorld(out = new THREE.Vector3()) {
    this.model.updateMatrixWorld();
    return this.weapons[this.weapon].muzzle.getWorldPosition(out);
  }

  // ---------- events ----------
  /** recoil is a critically-damped-ish spring: a shot adds velocity, no snapping */
  fire() { this.recoilVel += 26; }
  private recoilVel = 0;
  reload(durS: number) { this.reloadT = 0; this.reloadDur = durS; }
  private reloadDur = 1.5;
  hit(dmg: number, fromFront: boolean) {
    this.flashT = 0.06;
    this.hitLean = Math.min(1, dmg / 40);
    this.hitLeanDir = fromFront ? 1 : -1;
    const a = this.actions.A_hit;
    if (a) { a.reset(); a.setEffectiveWeight(Math.min(1, dmg / 40)); a.play(); }
  }
  switchWeapon(w: WeaponId) {
    if (w === this.weapon && this.pendingWeapon === null) return;
    this.pendingWeapon = w;
    this.swapT = 0;
  }
  setWeaponImmediate(w: WeaponId) {
    this.weapon = w;
    this.pendingWeapon = null;
    this.weapons.forEach((r, i) => (r.root.visible = i === w));
  }
  die() {
    this.deadT = 0;
  }
  /** Every bone's local transform as loaded (bind pose), for a full reset after a ragdoll. */
  private bindPose: { b: THREE.Object3D; p: THREE.Vector3; q: THREE.Quaternion; s: THREE.Vector3 }[] = [];
  resetPose() {
    for (const e of this.bindPose) { e.b.position.copy(e.p); e.b.quaternion.copy(e.q); e.b.scale.copy(e.s); }
    this.legYaw = 0; this.recoil = 0; this.recoilVel = 0; this.hitLean = 0; this.reloadT = -1; this.swapT = -1;
    this.forceMixerWrite();
    this.model.updateMatrixWorld(true);
  }
  revive() {
    this.resetPose();
    this.deadT = -1;
    this.mixer.stopAllAction();
    for (const a of Object.values(this.actions)) { if (a !== this.actions.A_hit) { a.reset(); a.setEffectiveWeight(0); a.play(); } }
    this.actions.L_idle?.setEffectiveWeight(1);
    this.actions.U_aim?.setEffectiveWeight(1);
  }
  celebrate(kind: "wave" | "yes") {
    this.lookdevClip = null;
    this.mixer.stopAllAction();
    const a = this.actions[kind === "wave" ? "F_wave" : "F_yes"];
    a.reset(); a.setEffectiveWeight(1); a.play();
    this.celebrating = true;
  }
  celebrating = false;

  // ---------- emotes ----------
  emoting: string | null = null;
  private emoteT = 0;
  private emoteAction: THREE.AnimationAction | null = null;
  emote(clipName: string, loop: boolean) {
    const clip = this.clips[clipName];
    if (!clip) return;
    this.stopEmote(true);
    const a = this.mixer.clipAction(clip);
    a.reset();
    a.setLoop(loop ? THREE.LoopRepeat : THREE.LoopOnce, Infinity);
    a.clampWhenFinished = true;
    a.setEffectiveWeight(1);
    a.play();
    this.emoteAction = a;
    this.emoting = clipName;
    this.emoteT = 0;
    this.emoteLoop = loop;
    this.weapons.forEach((w) => (w.root.visible = false));
  }
  private emoteLoop = false;
  stopEmote(silent = false) {
    if (this.emoteAction) this.emoteAction.stop();
    this.emoteAction = null;
    const was = this.emoting;
    this.emoting = null;
    if (was && !silent) { this.revive(); this.weapons.forEach((w, i) => (w.root.visible = i === this.weapon)); }
  }

  // ---------- per frame ----------
  update(dt: number, s: CharState) {
    if (this.celebrating) { this.restoreProcedural(); this.mixer.update(dt); this.snapshotMixerPose(); return; }
    if (this.emoting && s.alive) {
      this.root.rotation.y = s.yaw;
      this.emoteT += dt;
      // the emote owns the whole body; other actions fade out under it
      for (const [k, a] of Object.entries(this.actions)) if (k !== "A_hit") a.setEffectiveWeight(Math.max(0, a.getEffectiveWeight() - dt * 8));
      const dur = this.emoteAction!.getClip().duration;
      if (!this.emoteLoop && this.emoteT > dur / Math.abs(this.emoteAction!.timeScale || 1) + 0.1) { this.stopEmote(); return; }
      this.restoreProcedural();
      this.mixer.update(dt);
      return;
    }
    this.root.rotation.y = s.yaw;
    if (!s.alive) {
      if (this.deadT < 0) this.die();
      this.deadT += dt;
      const d = this.actions.F_death;
      if (d && d.getEffectiveWeight() < 1) {
        for (const [k, a] of Object.entries(this.actions)) if (k !== "F_death") a.setEffectiveWeight(0);
        d.reset(); d.setEffectiveWeight(1); d.play();
      }
      this.restoreProcedural();
      this.mixer.update(dt);
      this.snapshotMixerPose();
      return;
    }
    // local velocity
    const sy = Math.sin(s.yaw), cy = Math.cos(s.yaw);
    const fwd = s.vx * -sy + s.vz * -cy;
    const right = s.vx * cy + s.vz * -sy;
    const speed = Math.hypot(s.vx, s.vz);

    // airborne / jump / landing, timed to the real airtime (rise ~0.33 s at 24 m/s^2)
    const W = this.actions;
    const takeoff = !s.grounded && this.wasGrounded && s.vy > 1;
    const touchdown = s.grounded && !this.wasGrounded && this.airT > 0.12;
    if (!s.grounded) this.airT += dt; else this.airT = 0;
    this.wasGrounded = s.grounded;
    if (takeoff) { this.jumpT = 0; if (W.L_jump) { W.L_jump.reset(); W.L_jump.timeScale = W.L_jump.getClip().duration / 0.22; W.L_jump.play(); } }
    if (touchdown) { this.landT = 0; if (W.L_land) { W.L_land.reset(); W.L_land.timeScale = W.L_land.getClip().duration / 0.3; W.L_land.play(); } }
    this.jumpT += dt;
    this.landT += dt;
    if (s.dashing) this.dashT = 0.18; else this.dashT = Math.max(0, this.dashT - dt);

    // locomotion weights
    const inJump = !s.grounded && this.jumpT < 0.22;
    const air = !s.grounded && (this.airT > 0.08 || inJump) ? 1 : 0;
    const jumpW = inJump ? 1 : 0;
    const airW = air && !inJump ? 1 : 0;
    const landW = s.grounded && this.landT < 0.3 ? (1 - this.landT / 0.3) : 0;
    const walkW = air ? 0 : THREE.MathUtils.clamp(speed / 2.2, 0, 1) * (1 - THREE.MathUtils.clamp((speed - 2.6) / 2.2, 0, 1));
    const runW = air ? 0 : THREE.MathUtils.clamp((speed - 2.6) / 2.2, 0, 1);
    const idleW = air ? 0 : 1 - THREE.MathUtils.clamp(speed / 1.2, 0, 1);
    const ground = (walkW + runW + idleW) || 1;
    this.crouchW += ((this.crouch && !air ? 1 : 0) - this.crouchW) * Math.min(1, dt * 10);
    const cw = this.crouchW;
    const k = (1 - landW) * (1 - cw);
    const cMove = THREE.MathUtils.clamp(speed / 1.4, 0, 1);
    W.L_cidle?.setEffectiveWeight(cw * (1 - cMove));
    W.L_cwalk?.setEffectiveWeight(cw * cMove);
    if (W.L_cwalk) W.L_cwalk.timeScale = (fwd < -0.3 ? -1 : 1) * Math.max(0.6, speed / 1.6);
    this.fade(W.L_walk, (walkW / ground) * k * (1 - air), dt);
    this.fade(W.L_run, (runW / ground) * k * (1 - air), dt);
    this.fade(W.L_idle, (idleW / ground) * k * (1 - air), dt);
    this.fade(W.L_air, airW, dt, 14);
    W.L_jump?.setEffectiveWeight(jumpW);
    W.L_land?.setEffectiveWeight(landW);
    // playback rate so feet don't slide; backwards plays reversed
    const back = fwd < -0.3 && Math.abs(fwd) > Math.abs(right) * 0.6;
    const dir = back ? -1 : 1;
    if (W.L_walk) W.L_walk.timeScale = dir * Math.max(0.6, speed / 1.9);
    if (W.L_run) W.L_run.timeScale = dir * Math.max(0.7, speed / 5.6);

    // upper body: aim pose, sprint carry when running and not shooting
    const carry = !s.aim && Math.abs(this.recoil) < 0.02 && speed > 4 && this.sinceFire > 0.6 && !s.reloading ? 0.55 : 0;
    this.fade(W.U_run, carry, dt, 8);
    this.fade(W.U_aim, 1 - carry, dt, 8);
    this.sinceFire += dt;

    // Bones we pose procedurally go back to rest first: the mixer only overwrites bones its clips have
    // tracks for, so anything else (Root has none) would accumulate our rotations frame after frame.
    this.restoreProcedural();
    this.mixer.update(dt);
    this.snapshotMixerPose();

    // ---- procedural layer (after the mixer) ----
    // leg yaw toward move direction (+-70 deg), upper body counter-rotates to keep aiming
    let target = 0;
    if (speed > 0.6 && !air) {
      let a = Math.atan2(-right, fwd); // + = left
      if (back) a = Math.atan2(right, -fwd);
      target = THREE.MathUtils.clamp(a, -1.2, 1.2);
    }
    this.legYaw += (target - this.legYaw) * Math.min(1, dt * 10);
    this.model.updateMatrixWorld(true);
    this.rotateBoneWorld("Root", UP, this.legYaw);
    this.rotateBoneWorld("Abdomen", UP, -this.legYaw);

    // aim pitch across the spine; hit lean; dash lean; recoil
    const right3 = _v.set(1, 0, 0).applyQuaternion(this.root.quaternion).clone();
    // camera pitch (+ = looking up) spread over the spine: 30 % / 40 % / 30 %, clamped to +-70 deg
    const pitch = THREE.MathUtils.clamp(s.pitch, -1.22, 1.22);
    const lean = this.hitLean * 0.25 * this.hitLeanDir;
    const dashLean = (this.dashT / 0.18) * 0.35;
    // First person: the arms (on Torso) must follow the full view pitch so the gun stays on the crosshair.
    // first person pitches the whole viewmodel about the eye instead (applyViewmodel), not the spine
    const pa = this.firstPerson ? 0 : 0.3, pt = this.firstPerson ? 0 : 0.4, pn = this.firstPerson ? 0 : 0.3;
    // (verified in the lab: a positive rotation about right3 raises the aim)
    this.rotateBoneWorld("Abdomen", right3, pitch * pa + lean * 0.5 + dashLean);
    // (first person: a small upward bias so the barrel points at the crosshair instead of the floor)
    this.rotateBoneWorld("Torso", right3, pitch * pt + (this.firstPerson ? 0.12 : 0) + lean * 0.5 - this.recoil * 0.025);
    this.rotateBoneWorld("Neck", right3, pitch * pn);
    this.aimPitch = pitch;
    this.rotateBoneWorld("UpperArmR", right3, -this.recoil * 0.04);
    this.hitLean = Math.max(0, this.hitLean - dt * 4);

    // weapon swap / reload / recoil on the weapon itself
    const rig = this.weapons[this.weapon];
    const f = WEAPON_FIT[this.weapon];
    rig.root.position.set(...f.pos);
    rig.root.rotation.set(...f.rot);
    if (this.firstPerson) { rig.root.position.add(this.sway); rig.root.rotateZ(this.sway.x * 2); }
    {
      const k = 700, c = 2 * Math.sqrt(k) * 0.75;
      const h = Math.min(dt, 1 / 60);
      for (let t = 0; t < dt - 1e-6; t += h) {
        this.recoilVel += (-k * this.recoil - c * this.recoilVel) * h;
        this.recoil += this.recoilVel * h;
      }
      if (Math.abs(this.recoil) > 1e-4) rig.root.translateZ((0.035 * this.recoil) / f.scale); // slides back toward the shoulder
    }
    if (this.swapT >= 0) {
      this.swapT += dt;
      const k = this.swapT / 0.3;
      if (k >= 0.5 && this.pendingWeapon !== null) this.setWeaponImmediate(this.pendingWeapon);
      const dip = Math.sin(Math.min(1, k) * Math.PI);
      this.weapons[this.weapon].root.rotateX(dip * 0.9);
      if (k >= 1) this.swapT = -1;
    } else if (this.reloadT >= 0 && s.reloading) {
      this.reloadT += dt;
      const k = this.reloadT / this.reloadDur;
      const env = Math.sin(Math.min(1, k) * Math.PI);
      rig.root.rotateZ(env * 0.6);
      rig.root.rotateX(env * 0.35);
      if (rig.mag) rig.mag.visible = !(this.reloadT > 0.35 && this.reloadT < 1.1);
      this.rotateBoneWorld("UpperArmL", right3, env * 0.25);
      if (k >= 1) this.reloadT = -1;
    } else {
      this.reloadT = -1;
      if (rig.mag) rig.mag.visible = true;
    }

    // keep the barrel on the aim: rotate the gun arm by whatever pitch error is left (third person)
    if (!this.firstPerson && this.swapT < 0 && this.reloadT < 0) {
      this.model.updateMatrixWorld(true);
      const r = this.weapons[this.weapon];
      const a = r.muzzle.getWorldPosition(new THREE.Vector3());
      const b = r.root.getWorldPosition(new THREE.Vector3());
      const d = a.sub(b);
      const have = Math.atan2(d.y, Math.hypot(d.x, d.z));
      const err = THREE.MathUtils.clamp(this.aimPitch - have, -0.6, 0.6);
      if (Math.abs(err) > 0.005) this.rotateBoneWorld("UpperArmR", right3, err);
    }
    // left hand on the fore-grip (two-bone IK), skipped mid-reload/swap so the hand can leave the gun
    if (this.swapT < 0 && this.reloadT < 0 && !this.celebrating) {
      const fitNow = WEAPON_FIT[this.weapon];
      const tgt = this.weapons[this.weapon].root.localToWorld(_v.set(...fitNow.gripL).clone());
      this.ikArm("UpperArmL", "LowerArmL", "Middle1L", tgt);
    }

    // hit flash + glow + spawn protection shimmer
    this.flashT = Math.max(0, this.flashT - dt);
    const e = this.flashT > 0 ? 1.2 : 0;
    const glow = this.glow ? 0.35 + 0.15 * Math.sin(performance.now() / 120) : 0;
    const prot = this.protect ? 0.25 + 0.2 * Math.sin(performance.now() / 60) : 0;
    for (const m of this.allMats) {
      m.emissive.setRGB(e + prot * 0.4, e + prot * 0.8, e + prot);
      m.emissiveIntensity = 1;
    }
    if (glow) for (const m of this.suitMats) { m.emissive.copy(m.color).multiplyScalar(glow + e); }
  }

  private rest = new Map<THREE.Bone, THREE.Quaternion>();
  private restPos = new Map<THREE.Bone, THREE.Vector3>();
  /**
   * Before each mixer update: bones we bend procedurally go back to their rest pose (bones no clip animates,
   * like Root, would otherwise accumulate), and the mixer is told to rewrite everything. Three's mixer skips
   * writing a property whose value didn't change since its last write, which would leave our reset in place.
   */
  private restoreProcedural() {
    this.forceMixerWrite();
    if (!this.rest.size) {
      for (const n of PROCEDURAL_BONES) { const b = this.bones[n]; if (b) { this.rest.set(b, b.quaternion.clone()); this.restPos.set(b, b.position.clone()); } }
    }
    for (const [b, q] of this.rest) { b.quaternion.copy(q); b.position.copy(this.restPos.get(b)!); }
  }
  /** Make the mixer write every bound property on its next update (it skips "unchanged" values). */
  private snapshotMixerPose() {}
  forceMixerWrite() {
    // The next update accumulates into accu[_accuIndex ^ 1] and compares it with accu[_accuIndex]:
    // poison the latter so every binding counts as changed.
    const idx = (this.mixer as any)._accuIndex as number;
    for (const pm of (this.mixer as any)._bindings as { buffer: Float64Array | Float32Array; valueSize: number }[]) {
      const st = pm.valueSize, off = (idx + 1) * st;
      pm.buffer.fill(1e30, off, off + st); // finite: zero-weight bindings lerp it away with t=1
    }
  }

  sinceFire = 9;
  noteFire() { this.sinceFire = 0; this.fire(); }

  private fade(a: THREE.AnimationAction | undefined, w: number, dt: number, rate = 12) {
    if (!a) return;
    const cur = a.getEffectiveWeight();
    a.setEffectiveWeight(cur + (w - cur) * Math.min(1, dt * rate));
  }

  /** Rotate a bone about a world-space axis by angle (after the mixer has posed it). */
  private rotateBoneWorld(name: string, axisWorld: THREE.Vector3, angle: number) {
    const b = this.bones[name];
    if (!b || Math.abs(angle) < 1e-5) return;
    const parent = b.parent!;
    parent.updateMatrixWorld(true);
    _m.extractRotation(parent.matrixWorld);
    _q.setFromRotationMatrix(_m).invert();
    const axis = axisWorld.clone().applyQuaternion(_q).normalize();
    _q2.setFromAxisAngle(axis, angle);
    b.quaternion.premultiply(_q2);
    b.updateMatrixWorld(true);
  }

  /** Analytic two-bone IK in world space (shoulder, elbow, palm), elbow pointing down and out. */
  private ikArm(upperName: string, lowerName: string, endName: string, target: THREE.Vector3) {
    const up = this.bones[upperName], lo = this.bones[lowerName], end = this.bones[endName];
    if (!up || !lo || !end) return;
    this.model.updateMatrixWorld(true);
    const S = up.getWorldPosition(new THREE.Vector3());
    const E = lo.getWorldPosition(new THREE.Vector3());
    const H = end.getWorldPosition(new THREE.Vector3());
    const a = S.distanceTo(E), b = E.distanceTo(H);
    const c = Math.min(S.distanceTo(target), a + b - 1e-3);
    // 1) elbow angle
    const u = S.clone().sub(E), v = H.clone().sub(E);
    const th0 = u.angleTo(v);
    const th = Math.acos(THREE.MathUtils.clamp((a * a + b * b - c * c) / (2 * a * b), -1, 1));
    const n = u.clone().cross(v);
    if (n.lengthSq() < 1e-10) n.set(1, 0, 0).applyQuaternion(this.root.quaternion);
    this.rotateBoneWorld(lowerName, n.normalize(), th - th0);
    // 2) swing the upper arm so the palm reaches the target
    const H2 = end.getWorldPosition(new THREE.Vector3());
    const from = H2.sub(S).normalize(), to = target.clone().sub(S).normalize();
    const q = new THREE.Quaternion().setFromUnitVectors(from, to);
    const axis = new THREE.Vector3(q.x, q.y, q.z);
    const ang = 2 * Math.acos(THREE.MathUtils.clamp(q.w, -1, 1));
    if (axis.lengthSq() > 1e-12) this.rotateBoneWorld(upperName, axis.normalize(), ang);
    // 3) twist about shoulder->target so the elbow hangs down and outward
    const E3 = lo.getWorldPosition(new THREE.Vector3());
    const axisT = to.clone();
    const pole = new THREE.Vector3(-0.6, -1, 0.2).applyQuaternion(this.root.quaternion).normalize();
    const eDir = E3.sub(S); eDir.sub(axisT.clone().multiplyScalar(eDir.dot(axisT)));
    const pDir = pole.clone().sub(axisT.clone().multiplyScalar(pole.dot(axisT)));
    if (eDir.lengthSq() > 1e-8 && pDir.lengthSq() > 1e-8) {
      eDir.normalize(); pDir.normalize();
      let tw = eDir.angleTo(pDir);
      if (eDir.clone().cross(pDir).dot(axisT) < 0) tw = -tw;
      this.rotateBoneWorld(upperName, axisT, tw);
    }
  }

  // ---------- lookdev ----------
  playRaw(name: string) {
    this.lookdevClip = name;
    this.mixer.stopAllAction();
    const a = this.mixer.clipAction(this.clips[name]);
    a.reset(); a.setEffectiveWeight(1); a.play();
  }
  lookdevUpdate(dt: number) {
    if (this.lookdevClip) { this.mixer.update(dt); return; }
    this.update(dt, this.lookdevState);
  }
  lookdevState: CharState = { vx: 0, vz: 0, vy: 0, yaw: 0, pitch: 0, grounded: true, aim: false, weapon: 0, reloading: false, dashing: false, alive: true };

  dispose() {
    this.mixer.stopAllAction();
    this.root.removeFromParent();
  }
}
