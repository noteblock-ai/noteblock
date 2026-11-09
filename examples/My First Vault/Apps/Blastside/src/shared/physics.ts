import type RAPIER_NS from "@dimforge/rapier3d-compat";
import { buildGround, buildStaticBoxes, type Box, PROP_DEFS } from "./map.js";
import { MOVE } from "./constants.js";

export type Rapier = typeof RAPIER_NS;
export type World = RAPIER_NS.World;

// Collision groups: (membership << 16) | filter
export const G_MAP = 0x0001;
export const G_PROP = 0x0002;
export const G_PLAYER = 0x0004;
export const G_GRENADE = 0x0008;
export const G_RAGDOLL = 0x0010;
export const groups = (member: number, filter: number) => (member << 16) | filter;

/** Quaternion for a box: yaw about Y, then tilt about the box's local Z (raises local +X). */
export function boxQuat(b: Box) {
  const yaw = b.yaw ?? 0, tilt = b.pitch ?? 0;
  const qy = { x: 0, y: Math.sin(yaw / 2), z: 0, w: Math.cos(yaw / 2) };
  const qz = { x: 0, y: 0, z: Math.sin(tilt / 2), w: Math.cos(tilt / 2) };
  return qmul(qy, qz);
}

export function qmul(a: { x: number; y: number; z: number; w: number }, b: { x: number; y: number; z: number; w: number }) {
  return {
    w: a.w * b.w - a.x * b.x - a.y * b.y - a.z * b.z,
    x: a.w * b.x + a.x * b.w + a.y * b.z - a.z * b.y,
    y: a.w * b.y - a.x * b.z + a.y * b.w + a.z * b.x,
    z: a.w * b.z + a.x * b.y - a.y * b.x + a.z * b.w,
  };
}

export interface MapPhysics {
  world: World;
  ground: ReturnType<typeof buildGround>;
  statics: ReturnType<typeof buildStaticBoxes>;
}

/** Builds the static map into a Rapier world (gravity matches MOVE.gravity for grenades/props). */
export function createMapWorld(R: Rapier): MapPhysics {
  const world = new R.World({ x: 0, y: -MOVE.gravity, z: 0 });
  world.timestep = 1 / 30;
  const ground = buildGround();
  const fixed = world.createRigidBody(R.RigidBodyDesc.fixed());
  world.createCollider(R.ColliderDesc.trimesh(ground.positions, ground.indices).setCollisionGroups(groups(G_MAP, 0xffff)).setFriction(0.9), fixed);
  // Island underside is not walkable; a thick slab under the rim stops grenades falling through cracks.
  const statics = buildStaticBoxes();
  for (const b of statics.boxes) {
    const q = boxQuat(b);
    world.createCollider(
      R.ColliderDesc.cuboid(b.h[0], b.h[1], b.h[2]).setTranslation(b.c[0], b.c[1], b.c[2]).setRotation(q).setCollisionGroups(groups(G_MAP, 0xffff)).setFriction(0.8),
      fixed,
    );
  }
  for (const c of statics.cyls) {
    world.createCollider(R.ColliderDesc.cylinder(c.hh, c.r).setTranslation(c.c[0], c.c[1], c.c[2]).setCollisionGroups(groups(G_MAP, 0xffff)), fixed);
  }
  return { world, ground, statics };
}

export interface PropBody {
  idx: number;
  body: RAPIER_NS.RigidBody;
}

/** Props as dynamic bodies (server/offline) or kinematic followers (online client). */
export function createProps(R: Rapier, world: World, kinematic: boolean): PropBody[] {
  return PROP_DEFS.map((d, idx) => {
    const y = d.p[1] + d.half[1];
    const desc = (kinematic ? R.RigidBodyDesc.kinematicPositionBased() : R.RigidBodyDesc.dynamic())
      .setTranslation(d.p[0], y, d.p[2])
      .setRotation({ x: 0, y: Math.sin(d.yaw / 2), z: 0, w: Math.cos(d.yaw / 2) })
      .setLinearDamping(0.4)
      .setAngularDamping(0.6)
      .setCanSleep(true);
    const body = world.createRigidBody(desc);
    const cd = d.kind === "crate" ? R.ColliderDesc.cuboid(d.half[0], d.half[1], d.half[2]) : R.ColliderDesc.cylinder(d.half[1], d.half[0]);
    world.createCollider(cd.setDensity(d.kind === "crate" ? 60 : 45).setFriction(0.8).setRestitution(0.1).setCollisionGroups(groups(G_PROP, G_MAP | G_PROP | G_GRENADE | G_PLAYER | G_RAGDOLL)), body);
    return { idx, body };
  });
}

/** Raycast against map + props; returns distance or Infinity. */
export function rayMap(R: Rapier, world: World, o: { x: number; y: number; z: number }, d: { x: number; y: number; z: number }, maxToi: number, exclude?: RAPIER_NS.Collider) {
  const ray = new R.Ray(o, d);
  const hit = world.castRayAndGetNormal(ray, maxToi, true, undefined, groups(0xffff, G_MAP | G_PROP), exclude);
  if (!hit) return { toi: Infinity, normal: null as null | { x: number; y: number; z: number }, collider: null as RAPIER_NS.Collider | null };
  return { toi: hit.timeOfImpact, normal: hit.normal, collider: hit.collider };
}
