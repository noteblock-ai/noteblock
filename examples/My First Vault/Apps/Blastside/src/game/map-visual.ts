// Sunfall Keep visuals. Every collider from shared/map gets a kit piece fitted to it (so what you see is
// what you collide with), then decoration is scattered on top. Static meshes are merged per material.
import * as THREE from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import {
  buildGround, buildStaticBoxes, buildDecor, MAPDATA, boxQuat, ISLAND_R, ISLETS, ISLET_R, TOWER, COURTYARD, WORKSHOP, GARDEN, PADS, PICKUP_DEFS,
  type Box,
} from "@blastside/shared";
import { kitPiece } from "../assets";
import { withDetail, groundMaterial, type Detail } from "./materials";

type Placed = { obj: THREE.Object3D; matrix: THREE.Matrix4; detail?: Detail };

const _box = new THREE.Box3();

/** World matrices for every mesh in a kit piece, placed with `m`. */
function collect(piece: THREE.Object3D, m: THREE.Matrix4, out: Placed[], detail?: Detail) {
  piece.updateMatrixWorld(true);
  const inv = new THREE.Matrix4().copy(piece.matrixWorld).invert();
  piece.traverse((o) => {
    if ((o as THREE.Mesh).isMesh) {
      const local = new THREE.Matrix4().multiplyMatrices(inv, o.matrixWorld);
      out.push({ obj: o, matrix: new THREE.Matrix4().multiplyMatrices(m, local), detail });
    }
  });
}

const boundsCache = new Map<string, THREE.Box3>();
function pieceBounds(name: string): THREE.Box3 {
  let b = boundsCache.get(name);
  if (!b) {
    const p = kitPiece(name);
    p.updateMatrixWorld(true);
    const inv = new THREE.Matrix4().copy(p.matrixWorld).invert();
    b = new THREE.Box3();
    p.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (mesh.isMesh) {
        mesh.geometry.computeBoundingBox();
        const bb = mesh.geometry.boundingBox!.clone().applyMatrix4(new THREE.Matrix4().multiplyMatrices(inv, mesh.matrixWorld));
        b!.union(bb);
      }
    });
    boundsCache.set(name, b);
  }
  return b;
}

export class MapBuilder {
  placed: Placed[] = [];
  /** Place a piece: position, yaw, uniform or per-axis scale. */
  put(name: string, x: number, y: number, z: number, yaw = 0, s: number | [number, number, number] = 1, detail?: Detail) {
    const sc = typeof s === "number" ? new THREE.Vector3(s, s, s) : new THREE.Vector3(...s);
    const m = new THREE.Matrix4().compose(new THREE.Vector3(x, y, z), new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), yaw), sc);
    collect(kitPiece(name), m, this.placed, detail ?? defaultDetail(name));
  }
  /** Stretch a piece's bounds onto a box (centre, half extents, rotation). */
  fit(name: string, b: Box, swapXZ = false, detail?: Detail) {
    const pb = pieceBounds(name);
    const size = pb.getSize(new THREE.Vector3());
    const ctr = pb.getCenter(new THREE.Vector3());
    const hx = swapXZ ? b.h[2] : b.h[0], hz = swapXZ ? b.h[0] : b.h[2];
    const sc = new THREE.Vector3((hx * 2) / size.x, (b.h[1] * 2) / size.y, (hz * 2) / size.z);
    const q = boxQuat(b);
    const qq = new THREE.Quaternion(q.x, q.y, q.z, q.w);
    if (swapXZ) qq.multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI / 2));
    // m = T(c) * R * S * T(-ctr)
    const m = new THREE.Matrix4().compose(new THREE.Vector3(...b.c), qq, sc).multiply(new THREE.Matrix4().makeTranslation(-ctr.x, -ctr.y, -ctr.z));
    collect(kitPiece(name), m, this.placed, detail ?? defaultDetail(name));
  }
  /** Merge into one mesh per material. */
  build(): THREE.Group {
    const byMat = new Map<THREE.Material, THREE.BufferGeometry[]>();
    const add = (base: THREE.Material, d: Detail | undefined, geo: THREE.BufferGeometry) => {
      const mat = withDetail(base, d ?? natureDetail(base), DETAIL_OPTS[d ?? natureDetail(base)]);
      (byMat.get(mat) ?? byMat.set(mat, []).get(mat)!).push(geo);
    };
    for (const p of this.placed) {
      const mesh = p.obj as THREE.Mesh;
      const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
      if (mats.length > 1) {
        for (const g of mesh.geometry.groups) add(mats[g.materialIndex ?? 0], p.detail === "auto" as any ? undefined : p.detail, extractGroup(mesh.geometry, g.start, g.count).applyMatrix4(p.matrix));
      } else {
        add(mats[0], p.detail, normalizeGeo(mesh.geometry.clone()).applyMatrix4(p.matrix));
      }
    }
    const g = new THREE.Group();
    for (const [mat, geos] of byMat) {
      const merged = mergeGeometries(geos.map(normalizeGeo), false);
      if (!merged) continue;
      const m = new THREE.Mesh(merged, mat);
      m.castShadow = true;
      m.receiveShadow = true;
      g.add(m);
    }
    return g;
  }
}

const DETAIL_OPTS: Partial<Record<Detail, { strength?: number; normal?: number }>> = {
  stone: { strength: 0.95, normal: 1.1 },
  blocks: { strength: 0.85, normal: 1.0 },
  roof: { strength: 0.9, normal: 1.0 },
  wood: { strength: 0.8, normal: 0.8 },
  rock: { strength: 0.9, normal: 1.2 },
};

/** Which photo texture a kit piece gets (undefined = decide per material, for the nature kit). */
function defaultDetail(name: string): Detail | undefined {
  if (name.startsWith("castle/flag")) return "none";
  if (name.startsWith("castle/tree") || name.startsWith("castle/rocks")) return undefined;
  if (name.startsWith("castle/")) return "stone";
  if (name.startsWith("town/roof") || name === "town/chimney") return "roof";
  if (/town\/(stall|cart|planks|overhang|fence|poles|banner)/.test(name)) return name.includes("banner") ? "none" : "wood";
  if (name.startsWith("town/hedge") || name.startsWith("town/tree") || name.startsWith("town/lantern")) return "none";
  if (name.startsWith("town/")) return "blocks";
  if (name.startsWith("pirate/")) return "wood";
  return undefined;
}

function natureDetail(m: THREE.Material): Detail {
  const n = m.name.toLowerCase();
  if (n.includes("stone") || n.includes("rock") || n === "dirt") return "rock";
  if (n.includes("wood") || n.includes("bark")) return "wood";
  return "none";
}

/** Keep only position/normal/uv, non-indexed->indexed consistent, so geometries merge. */
function normalizeGeo(g: THREE.BufferGeometry): THREE.BufferGeometry {
  const keep = ["position", "normal", "uv"];
  for (const k of Object.keys(g.attributes)) if (!keep.includes(k)) g.deleteAttribute(k);
  // dequantize (meshopt-quantized attributes come in as normalized ints)
  for (const k of keep) {
    const a = g.getAttribute(k) as THREE.BufferAttribute | undefined;
    if (a && !(a.array instanceof Float32Array)) {
      const f = new Float32Array(a.count * a.itemSize);
      for (let i = 0; i < a.count; i++) for (let j = 0; j < a.itemSize; j++) f[i * a.itemSize + j] = a.getComponent(i, j);
      g.setAttribute(k, new THREE.BufferAttribute(f, a.itemSize));
    }
  }
  if (!g.getAttribute("uv")) g.setAttribute("uv", new THREE.BufferAttribute(new Float32Array(g.getAttribute("position").count * 2), 2));
  if (!g.getAttribute("normal")) g.computeVertexNormals();
  if (!g.index) {
    const n = g.getAttribute("position").count;
    g.setIndex(Array.from({ length: n }, (_, i) => i));
  }
  g.groups = [];
  return g;
}

function extractGroup(src: THREE.BufferGeometry, start: number, count: number) {
  const g = normalizeGeo(src.clone());
  const idx = g.index!.array.slice(start, start + count);
  g.setIndex(Array.from(idx));
  return g;
}

// ---------- procedural ground + island rock ----------
function groundMesh(): THREE.Mesh {
  const gd = buildGround();
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(gd.positions, 3));
  geo.setIndex(new THREE.BufferAttribute(gd.indices, 1));
  const colors = new Float32Array(gd.positions.length);
  const surf = new Float32Array(gd.zone.length);
  const c = new THREE.Color();
  const pal = [
    new THREE.Color("#8fb35a"), // base grass
    new THREE.Color("#b9a58a"), // courtyard flagstone
    new THREE.Color("#7aa84e"), // garden lawn
    new THREE.Color("#93b45c"), // islet
    new THREE.Color("#c8b294"), // stairs / slopes
  ];
  for (let i = 0; i < gd.zone.length; i++) {
    const x = gd.positions[i * 3], z = gd.positions[i * 3 + 2];
    c.copy(pal[gd.zone[i]]);
    // gentle noise so it isn't flat
    const n = Math.sin(x * 0.9 + z * 0.4) * 0.5 + Math.sin(x * 0.23 - z * 1.3) * 0.5;
    c.offsetHSL(0, 0, n * 0.03);
    // paved: courtyard, stairs, a ring path round the tower, and the east-west causeway to the bridges
    const r = Math.hypot(x, z);
    const path = gd.zone[i] === 0 && ((r > 7.4 && r < 9.6) || (Math.abs(z) < 1.6 && r > 9));
    const paved = gd.zone[i] === 1 || gd.zone[i] === 4 || path;
    surf[i] = paved ? 1 : 0;
    if (paved) c.set("#e8d6bf").offsetHSL(0, 0, n * 0.02);
    colors.set([c.r, c.g, c.b], i * 3);
  }
  geo.setAttribute("color", new THREE.BufferAttribute(colors, 3));
  geo.setAttribute("surf", new THREE.BufferAttribute(surf, 1));
  geo.computeVertexNormals();
  const m = new THREE.Mesh(geo, groundMaterial());
  m.receiveShadow = true;
  return m;
}

export function rockUnderside(cx: number, cz: number, r: number, depth: number, seed: number): THREE.BufferGeometry {
  // Inverted rocky cone: rings shrink as they go down, with noise.
  const seg = 48, rings = 7;
  const pos: number[] = [];
  const idx: number[] = [];
  let s = seed;
  const rnd = () => ((s = (s * 16807) % 2147483647) / 2147483647);
  const jitter = Array.from({ length: seg }, () => rnd());
  for (let k = 0; k <= rings; k++) {
    const t = k / rings;
    const rr = r * (1 - Math.pow(t, 1.3) * 0.96) + (k === 0 ? 0.3 : 0);
    const y = -0.05 - t * depth - (k === 0 ? 0 : 0.6);
    for (let i = 0; i < seg; i++) {
      const a = (i / seg) * Math.PI * 2;
      const n = 1 + (k === 0 ? 0 : (jitter[(i + k * 7) % seg] - 0.5) * 0.18);
      pos.push(cx + Math.cos(a) * rr * n, y + (k > 0 ? (jitter[(i * 3 + k) % seg] - 0.5) * depth * 0.08 : 0), cz + Math.sin(a) * rr * n);
    }
  }
  for (let k = 0; k < rings; k++)
    for (let i = 0; i < seg; i++) {
      const a = k * seg + i, b = k * seg + ((i + 1) % seg), c = (k + 1) * seg + i, d = (k + 1) * seg + ((i + 1) % seg);
      idx.push(a, b, c, b, d, c);
    }
  const tip = pos.length / 3;
  pos.push(cx, -depth * 1.15, cz);
  for (let i = 0; i < seg; i++) idx.push(rings * seg + i, rings * seg + ((i + 1) % seg), tip);
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  g.setIndex(idx);
  const ng = g.toNonIndexed();
  ng.computeVertexNormals();
  // colour by depth: soil top band, then stone
  const p = ng.getAttribute("position");
  const col = new Float32Array(p.count * 3);
  const top = new THREE.Color("#7a5a3c"), mid = new THREE.Color("#a08a74"), deep = new THREE.Color("#6c6878");
  const c = new THREE.Color();
  for (let i = 0; i < p.count; i++) {
    const t = Math.min(1, -p.getY(i) / depth);
    if (t < 0.08) c.copy(top); else c.copy(mid).lerp(deep, Math.min(1, (t - 0.08) / 0.9));
    c.offsetHSL(0, 0, ((i * 7919) % 13) / 13 * 0.06 - 0.03);
    col.set([c.r, c.g, c.b], i * 3);
  }
  ng.setAttribute("color", new THREE.BufferAttribute(col, 3));
  return ng;
}

export interface MapVisual {
  group: THREE.Group;
  pads: THREE.Object3D[];
}

export function buildMapVisual(): MapVisual {
  const group = new THREE.Group();
  group.add(groundMesh());
  // Undersides
  const rockGeos = [rockUnderside(0, 0, ISLAND_R + 0.2, 16, 7), ...ISLETS.map((i, k) => rockUnderside(i.x, i.z, ISLET_R + 0.2, 6, 31 + k))];
  // a closed lid just under the lawn so there's no sliver between the grass edge and the cliff top,
  // and the cliff is double-sided: from the very edge you never see through the island
  const lid = (cx: number, cz: number, r: number) => {
    // a ring only: a full disc would cover the sunken courtyard (it read as a mud pit you fell through)
    const g = new THREE.RingGeometry(r - 1.2, r, 64).rotateX(Math.PI / 2).translate(cx, -0.06, cz).toNonIndexed();
    const c = new THREE.Color("#7a5a3c");
    g.setAttribute("color", new THREE.BufferAttribute(new Float32Array(g.getAttribute("position").count * 3).map((_, i) => [c.r, c.g, c.b][i % 3]), 3));
    g.deleteAttribute("uv");
    return g;
  };
  rockGeos.push(lid(0, 0, ISLAND_R + 0.3), ...ISLETS.map((i) => lid(i.x, i.z, ISLET_R + 0.3)));
  const rockMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 1, flatShading: true, side: THREE.DoubleSide });
  const rock = new THREE.Mesh(mergeGeometries(rockGeos.map((g) => { if (g.getAttribute("uv")) g.deleteAttribute("uv"); return g; }))!, withDetail(rockMat, "rock", { strength: 0.95, normal: 1.3 }));
  rock.castShadow = true;
  rock.receiveShadow = true;
  group.add(rock);

  const B = new MapBuilder();
  const { boxes, cyls } = buildStaticBoxes();

  // Tower
  for (const c of cyls) B.fit("castle/tower-base", { c: c.c, h: [c.r, c.hh, c.r] });
  B.put("castle/tower-top", 0, TOWER.roof - 0.02, 0, 0, [10.1, 7, 10.1]);
  B.put("castle/flag-wide", 0, TOWER.roof, -3.6, 0, 3);
  B.put("castle/flag", 3.3, TOWER.roof, 2.4, 1, 2.6);

  for (const b of boxes) {
    switch (b.tag) {
      case "ramp": B.fit("castle/tower-square-base", b); break;
      case "ramprail": B.fit("town/wall-block-half", b); break;
      case "cwall": B.fit("castle/wall-half", { ...b, c: [b.c[0], b.c[1] - 0.02, b.c[2]] }, b.h[2] > b.h[0]); break;
      case "cover": B.fit("town/wall-block-half", b); break;
      case "wwall": B.fit("town/wall-block", b); break;
      case "wroof": B.fit("town/roof-flat", b); break;
      case "bench": B.fit("town/stall-bench", { ...b, h: [b.h[0], b.h[1], b.h[2]] }, true); break;
      case "hedge": B.fit("town/hedge-large", { ...b, c: [b.c[0], b.c[1] - 0.05, b.c[2]] }, b.h[0] > b.h[2]); break;
      case "pillar": B.fit("castle/tower-square-base", b, false, "stone"); break;
      case "bridge": {
        const len = b.h[0] * 2;
        const n = Math.round(len / 1.6);
        for (let k = 0; k < n; k++) {
          const x = b.c[0] - b.h[0] + (k + 0.5) * (len / n);
          B.fit("castle/bridge-straight", { c: [x, -0.6, b.c[2]], h: [len / n / 2 + 0.01, 0.6, b.h[2] + 0.12] }, true);
        }
        break;
      }
      case "block": B.fit("castle/tower-square-base", b); break;
      case "decor": break; // drawn from buildDecor()
      default: break;
    }
  }

  // Courtyard retaining walls (below ground level, inside the pit)
  const C = COURTYARD;
  // tops sit 4 cm above the lawn so the stone edge never z-fights with the grass
  const retain = (cx: number, cz: number, hx: number, hz: number) => B.fit("castle/tower-square-base", { c: [cx, C.depth / 2 + 0.02, cz], h: [hx, -C.depth / 2 + 0.02, hz] });
  retain((C.x0 + C.x1) / 2, C.z1 + 0.15, (C.x1 - C.x0) / 2, 0.3);
  retain(C.x0 - 0.15, (C.z0 + C.z1) / 2, 0.3, (C.z1 - C.z0) / 2);
  retain(C.x1 + 0.15, (C.z0 + 6.5) / 2, 0.3, (6.5 - C.z0) / 2);
  retain(C.x1 + 0.15, (9.5 + C.z1) / 2, 0.3, (C.z1 - 9.5) / 2);
  retain((C.x0 + -13.5) / 2, C.z0 - 0.15, (-13.5 - C.x0) / 2, 0.3);
  retain((-10.5 + C.x1) / 2, C.z0 - 0.15, (C.x1 - -10.5) / 2, 0.3);
  // Stairs down into the courtyard
  B.fit("town/stairs-wide-stone", { c: [C.x1 + 1.25, C.depth / 2, 8], h: [1.25, -C.depth / 2, 1.5], yaw: Math.PI / 2 }, true);
  B.fit("town/stairs-wide-stone", { c: [-12, C.depth / 2, C.z0 - 1.25], h: [1.5, -C.depth / 2, 1.25], yaw: Math.PI });
  // Garden retaining wall + stairs
  const G = GARDEN;
  const gw = (cx: number, cz: number, hx: number, hz: number) => B.fit("castle/tower-square-base", { c: [cx, G.height / 2 + 0.02, cz], h: [hx, G.height / 2 + 0.02, hz] });
  gw((G.x0 + 6.5) / 2, G.z1 - 0.15, (6.5 - G.x0) / 2, 0.15);
  gw((9.5 + G.x1) / 2, G.z1 - 0.15, (G.x1 - 9.5) / 2, 0.15);
  gw(G.x0 + 0.15, (G.z0 + -14) / 2, 0.15, (-14 - G.z0) / 2);
  gw(G.x0 + 0.15, (-11 + G.z1) / 2, 0.15, (G.z1 - -11) / 2);
  gw(G.x1 - 0.15, (G.z0 + G.z1) / 2, 0.15, (G.z1 - G.z0) / 2);
  gw((G.x0 + G.x1) / 2, G.z0 + 0.15, (G.x1 - G.x0) / 2, 0.15);
  B.fit("town/stairs-wide-stone", { c: [8, G.height / 2, G.z1 + 1.25], h: [1.5, G.height / 2, 1.25] });
  B.fit("town/stairs-wide-stone", { c: [G.x0 - 1.25, G.height / 2, -12.5], h: [1.25, G.height / 2, 1.5], yaw: -Math.PI / 2 }, true);
  // Arch tops across the pillars
  for (const [x, z] of MAPDATA.garden.arches) B.fit("castle/tower-square-base", { c: [x, G.height + 2.95, z], h: [0.36, 0.2, 1.75] }, false, "stone");

  // Workshop roof: a terracotta gable over the flat slab
  const W = WORKSHOP;
  const wcx = (W.x0 + W.x1) / 2, wcz = (W.z0 + W.z1) / 2;
  const roofLen = W.x1 - W.x0 + 0.8;
  const nR = 4;
  for (let k = 0; k < nR; k++) {
    const x = W.x0 - 0.4 + (k + 0.5) * (roofLen / nR);
    B.put("town/roof-gable", x, W.h + 0.28, wcz, Math.PI / 2, [(W.z1 - W.z0 + 0.9) / 1.1, 0.7, roofLen / nR / 1.08]);
  }
  B.put("town/chimney", W.x1 - 2, W.h + 0.3, wcz - 1.6, 0, 2);
  B.put("town/banner-red", W.x0 - 0.2, 1.4, wcz + 1.6, Math.PI, 1.6);

  // Courtyard dressing
  B.put("town/banner-red", C.x0 + 0.25, C.depth + 0.2, 8, 0, 1.4);

  // ---------- set dressing (Quaternius Stylized Nature MegaKit) ----------
  let seed = 1234;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  const blocked = (x: number, z: number, pad = 1) =>
    (x > C.x0 - pad && x < C.x1 + pad && z > C.z0 - pad && z < C.z1 + pad) ||
    (x > G.x0 - pad && x < G.x1 + pad && z > G.z0 - pad && z < G.z1 + pad) ||
    (x > W.x0 - pad && x < W.x1 + pad && z > W.z0 - pad && z < W.z1 + pad) ||
    Math.hypot(x, z) < TOWER.rampOuter + 1.2 ||
    (Math.abs(z) < 2.2 && Math.abs(x) > 16);
  // Solid dressing shared with the server collision (shared/decor.ts)
  for (const d of buildDecor()) { if (d.fit && d.box) B.fit(d.piece, d.box); else B.put(d.piece, d.p[0], d.p[1], d.p[2], d.yaw, d.scale); }
  for (let i = 0; i < 18; i++) {
    const x = G.x0 + 0.6 + rnd() * (G.x1 - G.x0 - 1.2), z = G.z0 + 0.6 + rnd() * (G.z1 - G.z0 - 1.2);
    if (Math.abs(z + 12) < 1.6) continue; // keep the arch lane clear
    B.put(["fol/Flower_3_Group", "fol/Clover_1", "fol/Grass_Common_Short", "fol/Plant_1"][i % 4], x, G.height, z, rnd() * 6, 0.55 + rnd() * 0.3);
  }
  // Grass tufts and pebbles scattered over the open lawn
  for (let i = 0; i < 140; i++) {
    const a = rnd() * Math.PI * 2, r = 9.5 + rnd() * 12.5;
    const x = Math.cos(a) * r, z = Math.sin(a) * r;
    if (blocked(x, z, 0.3)) continue;
    const rr = Math.hypot(x, z);
    if (rr > 7.2 && rr < 9.8) continue; // paved ring
    const kind = ["fol/Grass_Common_Short", "fol/Grass_Wispy_Tall", "fol/Grass_Common_Tall", "fol/Clover_1", "fol/Pebble_Round_2", "fol/Pebble_Square_3"][i % 6];
    B.put(kind, x, 0, z, rnd() * 6, kind.includes("Pebble") ? 1.4 : 0.45 + rnd() * 0.35);
  }
  for (const il of ISLETS) B.put("fol/Grass_Wispy_Tall", il.x - Math.sign(il.x) * 1.2, 0, il.z + 3.0, 0, 0.6);
  // Banners on the tower
  for (let k = 0; k < 4; k++) {
    const a = (k / 4) * Math.PI * 2 + Math.PI / 4;
    B.put("castle/flag-banner-long", Math.cos(a) * (TOWER.r + 0.02), 2.6, Math.sin(a) * (TOWER.r + 0.02), -a, [1, 1.7, 1.7]);
  }
  group.add(B.build());

  // Jump pads: glowing rings (animated by the game)
  const pads: THREE.Object3D[] = [];
  for (const p of PADS) {
    const pad = new THREE.Group();
    pad.position.set(...p.p);
    const base = new THREE.Mesh(new THREE.CylinderGeometry(1.25, 1.4, 0.18, 32), new THREE.MeshStandardMaterial({ color: "#3a4256", roughness: 0.6 }));
    base.position.y = 0.09;
    base.receiveShadow = true;
    pad.add(base);
    const glow = new THREE.Mesh(new THREE.CircleGeometry(1.05, 32).rotateX(-Math.PI / 2), new THREE.MeshStandardMaterial({ color: "#1FA6A0", emissive: "#28e0d4", emissiveIntensity: 2.2 }));
    glow.position.y = 0.19;
    pad.add(glow);
    for (let k = 0; k < 3; k++) {
      const ring = new THREE.Mesh(new THREE.TorusGeometry(0.9, 0.04, 8, 40).rotateX(Math.PI / 2), new THREE.MeshBasicMaterial({ color: "#8ffff6", transparent: true, opacity: 0.6, toneMapped: false }));
      ring.userData.ring = k;
      pad.add(ring);
    }
    pads.push(pad);
    group.add(pad);
  }
  void PICKUP_DEFS;
  void _box;
  return { group, pads };
}
