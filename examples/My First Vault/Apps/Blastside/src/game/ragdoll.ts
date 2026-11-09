// Client-side ragdolls: 11 Rapier bodies on spherical joints, driven from the killing shot. Max 4 live.
import * as THREE from "three";
import type RAPIER_NS from "@dimforge/rapier3d-compat";
import { G_MAP, G_PROP, G_RAGDOLL, groups } from "@blastside/shared";
import type { CharacterView } from "./character";

type R = typeof RAPIER_NS;

interface Part {
  name: string;
  bone: string;
  tip: string | null; // child bone defining the capsule end
  radius: number;
  parent: string | null; // parent part
  body?: RAPIER_NS.RigidBody;
  offset?: THREE.Matrix4; // body -> bone
}

const PARTS: Omit<Part, "body" | "offset">[] = [
  { name: "pelvis", bone: "Hips", tip: "Abdomen", radius: 0.17, parent: null },
  { name: "spine", bone: "Abdomen", tip: "Neck", radius: 0.18, parent: "pelvis" },
  { name: "head", bone: "Head", tip: null, radius: 0.24, parent: "spine" },
  { name: "uarmL", bone: "UpperArmL", tip: "LowerArmL", radius: 0.075, parent: "spine" },
  { name: "larmL", bone: "LowerArmL", tip: "Middle1L", radius: 0.07, parent: "uarmL" },
  { name: "uarmR", bone: "UpperArmR", tip: "LowerArmR", radius: 0.075, parent: "spine" },
  { name: "larmR", bone: "LowerArmR", tip: "Middle1R", radius: 0.07, parent: "uarmR" },
  { name: "ulegL", bone: "UpperLegL", tip: "LowerLegL", radius: 0.1, parent: "pelvis" },
  { name: "llegL", bone: "LowerLegL", tip: "FootL", radius: 0.09, parent: "ulegL" },
  { name: "ulegR", bone: "UpperLegR", tip: "LowerLegR", radius: 0.1, parent: "pelvis" },
  { name: "llegR", bone: "LowerLegR", tip: "FootR", radius: 0.09, parent: "ulegR" },
];
// Bones driven by a part without being its own body (feet hang off Root in this rig).
const EXTRA: { bone: string; part: string }[] = [
  { bone: "Root", part: "pelvis" },
  { bone: "Body", part: "pelvis" },
  { bone: "FootL", part: "llegL" },
  { bone: "FootR", part: "llegR" },
];
const ORDER = ["Root", "Body", "Hips", "Abdomen", "Head", "UpperArmL", "LowerArmL", "UpperArmR", "LowerArmR", "UpperLegL", "LowerLegL", "UpperLegR", "LowerLegR", "FootL", "FootR"];

interface Live {
  view: CharacterView;
  parts: Map<string, Part>;
  joints: RAPIER_NS.ImpulseJoint[];
  extras: { bone: string; part: string; offset: THREE.Matrix4 }[];
  age: number;
}

const _m = new THREE.Matrix4();
const _m2 = new THREE.Matrix4();
const _p = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _s = new THREE.Vector3();

export class Ragdolls {
  private live: Live[] = [];
  constructor(private R: R, private world: RAPIER_NS.World, _root: THREE.Object3D) {}

  start(view: CharacterView, dir: THREE.Vector3): boolean {
    if (this.live.length >= 4) {
      view.die(); // Death clip instead
      return false;
    }
    const R = this.R;
    view.root.updateMatrixWorld(true);
    const parts = new Map<string, Part>();
    const bw = (name: string) => view.bones[name]?.getWorldPosition(new THREE.Vector3());
    const impulse = dir.clone().setY(Math.max(0.2, dir.y)).normalize().multiplyScalar(5.5);
    for (const def of PARTS) {
      const bone = view.bones[def.bone];
      if (!bone) continue;
      const a = bw(def.bone)!;
      let b = def.tip ? bw(def.tip) : a.clone().add(new THREE.Vector3(0, 0.3, 0));
      if (!b) b = a.clone().add(new THREE.Vector3(0, 0.2, 0));
      const mid = a.clone().add(b).multiplyScalar(0.5);
      const axis = b.clone().sub(a);
      const len = axis.length();
      axis.normalize();
      const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), axis);
      const body = this.world.createRigidBody(
        R.RigidBodyDesc.dynamic().setTranslation(mid.x, mid.y, mid.z).setRotation(q).setLinearDamping(0.15).setAngularDamping(0.8).setCcdEnabled(def.name === "spine" || def.name === "pelvis"),
      );
      const half = Math.max(0.01, len / 2 - def.radius * 0.5);
      const shape = def.name === "head" ? R.ColliderDesc.ball(def.radius) : R.ColliderDesc.capsule(half, def.radius);
      this.world.createCollider(shape.setDensity(def.name === "spine" || def.name === "pelvis" ? 900 : 600).setFriction(0.9).setRestitution(0.05).setCollisionGroups(groups(G_RAGDOLL, G_MAP | G_PROP)), body);
      const k = def.name === "spine" || def.name === "pelvis" || def.name === "head" ? 1 : 0.6;
      body.setLinvel({ x: impulse.x * k, y: impulse.y * k + 1.2, z: impulse.z * k }, true);
      body.setAngvel({ x: (Math.random() - 0.5) * 4, y: (Math.random() - 0.5) * 2, z: (Math.random() - 0.5) * 4 }, true);
      // offset from body frame to bone world matrix
      const bodyM = new THREE.Matrix4().compose(mid, q, new THREE.Vector3(1, 1, 1));
      const offset = bodyM.clone().invert().multiply(bone.matrixWorld);
      parts.set(def.name, { ...def, body, offset });
    }
    const joints: RAPIER_NS.ImpulseJoint[] = [];
    for (const p of parts.values()) {
      if (!p.parent) continue;
      const parent = parts.get(p.parent);
      if (!parent?.body || !p.body) continue;
      const pivot = bw(p.bone)!;
      const toLocal = (body: RAPIER_NS.RigidBody, w: THREE.Vector3) => {
        const t = body.translation(), r = body.rotation();
        const inv = new THREE.Quaternion(r.x, r.y, r.z, r.w).invert();
        return w.clone().sub(new THREE.Vector3(t.x, t.y, t.z)).applyQuaternion(inv);
      };
      const a1 = toLocal(parent.body, pivot), a2 = toLocal(p.body, pivot);
      const jd = R.JointData.spherical({ x: a1.x, y: a1.y, z: a1.z }, { x: a2.x, y: a2.y, z: a2.z });
      const j = this.world.createImpulseJoint(jd, parent.body, p.body, true);
      j.setContactsEnabled(false);
      joints.push(j);
    }
    const extras = EXTRA.filter((e) => view.bones[e.bone] && parts.get(e.part)?.body).map((e) => {
      const body = parts.get(e.part)!.body!;
      const t = body.translation(), r = body.rotation();
      const bodyM = new THREE.Matrix4().compose(new THREE.Vector3(t.x, t.y, t.z), new THREE.Quaternion(r.x, r.y, r.z, r.w), new THREE.Vector3(1, 1, 1));
      return { ...e, offset: bodyM.invert().multiply(view.bones[e.bone].matrixWorld) };
    });
    view.mixer.stopAllAction();
    this.live.push({ view, parts, joints, extras, age: 0 });
    return true;
  }

  release(view: CharacterView) {
    const i = this.live.findIndex((l) => l.view === view);
    if (i < 0) return;
    const l = this.live[i];
    for (const j of l.joints) this.world.removeImpulseJoint(j, false);
    for (const p of l.parts.values()) if (p.body) this.world.removeRigidBody(p.body);
    this.live.splice(i, 1);
    view.resetPose(); // the ragdoll wrote position/rotation/scale into bones the clips never touch
  }

  center(view: CharacterView): THREE.Vector3 | null {
    const l = this.live.find((x) => x.view === view);
    const b = l?.parts.get("pelvis")?.body;
    if (!b) return null;
    const t = b.translation();
    return new THREE.Vector3(t.x, t.y, t.z);
  }

  blast(at: THREE.Vector3, strength: number) {
    for (const l of this.live) for (const p of l.parts.values()) {
      if (!p.body) continue;
      const t = p.body.translation();
      const d = new THREE.Vector3(t.x - at.x, t.y - at.y, t.z - at.z);
      const dist = d.length();
      if (dist > 5) continue;
      d.normalize().multiplyScalar(strength * (1 - dist / 5) * p.body.mass() * 0.6);
      p.body.applyImpulse({ x: d.x, y: d.y + strength * 0.3 * p.body.mass() * 0.3, z: d.z }, true);
    }
  }

  update(dt: number) {
    for (let i = this.live.length - 1; i >= 0; i--) {
      const l = this.live[i];
      l.age += dt;
      if (l.age > 4) { l.view.root.visible = false; this.release(l.view); continue; }
      const v = l.view;
      for (const name of ORDER) {
        const part = [...l.parts.values()].find((p) => p.bone === name);
        const extra = l.extras.find((e) => e.bone === name);
        const body = part?.body ?? (extra ? l.parts.get(extra.part)?.body : undefined);
        const offset = part?.offset ?? extra?.offset;
        const bone = v.bones[name];
        if (!body || !offset || !bone) continue;
        const t = body.translation(), r = body.rotation();
        _m.compose(_p.set(t.x, t.y, t.z), _q.set(r.x, r.y, r.z, r.w), _s.set(1, 1, 1)).multiply(offset);
        bone.parent!.updateMatrixWorld(true);
        _m2.copy(bone.parent!.matrixWorld).invert().multiply(_m);
        _m2.decompose(bone.position, bone.quaternion, _s);
        bone.updateMatrixWorld(true);
      }
    }
  }
}
