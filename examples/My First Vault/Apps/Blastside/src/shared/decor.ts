// Solid set dressing (trees, rocks, stalls, carts, lanterns, fountain): placed here so the server and the
// client agree on both the look and the collider. Soft stuff (grass, flowers, bushes, ferns) is client-only.
import { COURTYARD as C, GARDEN as G, WORKSHOP as W, ISLAND_R, ISLETS, TOWER, type Box, type Cyl, type V3 } from "./map.js";

export interface Decor { piece: string; p: V3; yaw: number; scale: number; box?: Box; cyl?: Cyl; /** draw the piece stretched onto `box` */ fit?: boolean }

function trunk(x: number, y: number, z: number, s: number): Cyl { return { c: [x, y + 1.6, z], r: 0.32 * s / 0.55, hh: 1.6 }; }
function rock(x: number, y: number, z: number, yaw: number, s: number): Box { return { c: [x, y + 0.85 * s, z], h: [1.35 * s, 0.9 * s, 1.2 * s], yaw, tag: "decor" }; }

export const SKILL_ROCK_Z = -1.1;
export function buildDecor(): Decor[] {
  const out: Decor[] = [];
  let seed = 1234;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  const blocked = (x: number, z: number, pad = 1) =>
    (x > C.x0 - pad && x < C.x1 + pad && z > C.z0 - pad && z < C.z1 + pad) ||
    (x > G.x0 - pad && x < G.x1 + pad && z > G.z0 - pad && z < G.z1 + pad) ||
    (x > W.x0 - pad && x < W.x1 + pad && z > W.z0 - pad && z < W.z1 + pad) ||
    Math.hypot(x, z) < TOWER.rampOuter + 1.2 ||
    (Math.abs(z) < 2.2 && Math.abs(x) > 16);
  const tree = (piece: string, x: number, y: number, z: number, yaw: number, s: number) => out.push({ piece, p: [x, y, z], yaw, scale: s, cyl: trunk(x, y, z, s) });
  // garden corners
  tree("fol/CommonTree_3", G.x1 - 1.1, G.height, G.z0 + 1.1, 0.4, 0.55);
  tree("fol/CommonTree_1", G.x0 + 1.3, G.height, G.z0 + 1.0, 2.1, 0.5);
  // rim ring
  for (let i = 0; i < 46; i++) {
    const a = (i / 46) * Math.PI * 2 + rnd() * 0.08;
    const r = ISLAND_R - 0.9 - rnd() * 1.2;
    const x = Math.cos(a) * r, z = Math.sin(a) * r;
    const yaw = rnd() * 6, sz = rnd();
    if (blocked(x, z, 0.6)) continue;
    const k = i % 5;
    if (k === 0 || k === 3) tree(i % 2 ? "fol/CommonTree_1" : "fol/Pine_1", x, 0, z, yaw, 0.55 + sz * 0.2);
    else if (k === 1) out.push({ piece: i % 3 ? "fol/Bush_Common_Flowers" : "fol/Bush_Common", p: [x, 0, z], yaw, scale: 0.9 + sz * 0.4 });
    else if (k === 2) { const s = 0.6 + sz * 0.5; out.push({ piece: `fol/Rock_Medium_${1 + (i % 3)}`, p: [x, -0.15, z], yaw, scale: s, box: rock(x, -0.15, z, yaw, s) }); }
    else out.push({ piece: "fol/Fern_1", p: [x, 0, z], yaw, scale: 0.9 });
  }
  // islets
  for (const il of ISLETS) {
    const sx = Math.sign(il.x);
    tree("fol/CommonTree_3", il.x + sx * 2.4, 0, il.z + 2.1, 1.3, 0.5);
    out.push({ piece: "fol/Rock_Medium_2", p: [il.x + sx * 2.6, -0.2, il.z - 2.0], yaw: 0.4, scale: 0.8, box: rock(il.x + sx * 2.6, -0.2, il.z - 2.0, 0.4, 0.8) });
    out.push({ piece: "fol/Bush_Common_Flowers", p: [il.x - sx * 2.6, 0, il.z - 2.4], yaw: 0, scale: 1 });
  }
  // The skill jump: a big rock against the workshop's north side. Its top (2.75 m) is 1.05 m under the roof
  // slab (3.8 m) with a 0.7 m gap, so a running jump clears it with ~0.25 m to spare (shared/test/jump.ts).
  out.push({ piece: "fol/Rock_Medium_1", p: [10, 0, -1.1], yaw: 0, scale: 1, fit: true, box: { c: [10, 1.375, SKILL_ROCK_Z], h: [1.15, 1.375, 1.0], tag: "decor" } });
  // workshop yard + courtyard props (the "pavilion" stall had no collider before)
  const wcz = (W.z0 + W.z1) / 2;
  out.push({ piece: "town/stall-red", p: [15.2, 0, 11.2], yaw: Math.PI, scale: 1.6, box: { c: [15.2, 1.0, 11.2], h: [0.82, 1.0, 0.82], tag: "decor" } });
  out.push({ piece: "town/cart", p: [18, 0, -2.6], yaw: 0.6, scale: 1.8, box: { c: [18, 0.5, -2.6], h: [0.8, 0.5, 1.2], yaw: 0.6, tag: "decor" } });
  out.push({ piece: "town/lantern", p: [W.x0 - 0.6, 0, wcz - 1.4], yaw: 0, scale: 1.3, cyl: { c: [W.x0 - 0.6, 1.0, wcz - 1.4], r: 0.16, hh: 1.0 } });
  out.push({ piece: "town/lantern", p: [C.x0 + 0.6, C.depth, C.z1 - 0.6], yaw: 0, scale: 1.3, cyl: { c: [C.x0 + 0.6, C.depth + 1.0, C.z1 - 0.6], r: 0.16, hh: 1.0 } });
  out.push({ piece: "town/fountain-round", p: [-12.5, C.depth, 9.5], yaw: 0, scale: 0.55, cyl: { c: [-12.5, C.depth + 0.08, 9.5], r: 0.55, hh: 0.08 } });
  return out;
}
