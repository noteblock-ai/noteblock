// Sunfall Keep, built from the design's map data (map-data.json, exported by the lookdev map generator).
// Units: metres. Origin: centre of the tower at ground level. North = -Z, East = +X. Waypoints in the
// data are [x, z, y]. Everything here is shared: the server collides with it, bots path over it, and the
// client fits kit pieces onto the same boxes (client/src/game/map-visual.ts).
import DATA from "./map-data.json" with { type: "json" };
import { buildDecor } from "./decor.js";

export type V3 = [number, number, number];

export const MAPDATA = DATA;
export const ISLAND_R = DATA.island.r;
export const ISLETS = DATA.islets.map((i) => ({ x: i.c[0], z: i.c[1], r: i.r }));
export const ISLET_R = DATA.islets[0].r;
export const BRIDGE_W = DATA.bridges[0].w;

export const TOWER = {
  r: DATA.tower.r,
  roof: DATA.tower.h,
  rampInner: DATA.ramp.r0,
  rampOuter: DATA.ramp.r1,
  rampStartDeg: DATA.ramp.a0,
  rampSweepDeg: DATA.ramp.sweep,
  segments: 24,
  parapetH: 1.0,
};

export const COURTYARD = {
  x0: DATA.courtyard.x[0], x1: DATA.courtyard.x[1], z0: DATA.courtyard.z[0], z1: DATA.courtyard.z[1],
  depth: DATA.courtyard.y, wallH: 1.1,
};
export const WORKSHOP = { x0: DATA.workshop.x[0], x1: DATA.workshop.x[1], z0: DATA.workshop.z[0], z1: DATA.workshop.z[1], h: DATA.workshop.h, wall: 0.35 };
export const GARDEN = { x0: DATA.garden.x[0], x1: DATA.garden.x[1], z0: DATA.garden.z[0], z1: DATA.garden.z[1], height: DATA.garden.y };
/** Second way onto the garden (south-east steps) so the G-NE link works both ways. */
export const GARDEN_STEPS_SE = { x: [12.5, 14.5] as [number, number], z: [-9.6, -8] as [number, number] };

export interface Box {
  c: V3;
  h: V3;
  /** yaw about Y (rad), then tilt about the box's local Z (raises local +X) */
  yaw?: number;
  pitch?: number;
  tag?: string;
}
export interface Cyl { c: V3; r: number; hh: number }

const inRect = (x: number, z: number, xr: number[], zr: number[]) => x >= xr[0] && x <= xr[1] && z >= zr[0] && z <= zr[1];

/** Height of walkable ground (not buildings) at x,z, or null off the island. */
export function groundHeight(x: number, z: number): number | null {
  const onIsland = x * x + z * z <= ISLAND_R * ISLAND_R;
  let onIslet = false;
  for (const i of ISLETS) if ((x - i.x) ** 2 + (z - i.z) ** 2 <= i.r * i.r) onIslet = true;
  if (!onIsland && !onIslet) return null;
  if (onIslet && !onIsland) return 0;
  const C = DATA.courtyard;
  if (inRect(x, z, C.x, C.z)) {
    for (const s of C.stairs) {
      if (!inRect(x, z, s.x, s.z)) continue;
      // stairs rise toward the rim on their `dir` side
      if (s.dir === "N") return C.y * ((z - s.z[0]) / (s.z[1] - s.z[0]));
      if (s.dir === "S") return C.y * ((s.z[1] - z) / (s.z[1] - s.z[0]));
      if (s.dir === "E") return C.y * ((s.x[1] - x) / (s.x[1] - s.x[0]));
      if (s.dir === "W") return C.y * ((x - s.x[0]) / (s.x[1] - s.x[0]));
    }
    return C.y;
  }
  const G = DATA.garden;
  if (inRect(x, z, G.x, G.z)) {
    const st = G.steps;
    if (inRect(x, z, st.x, st.z)) return G.y * ((x - st.x[0]) / (st.x[1] - st.x[0]));
    const se = GARDEN_STEPS_SE;
    if (inRect(x, z, se.x, se.z)) return G.y * ((se.z[1] - z) / (se.z[1] - se.z[0]));
    return G.y;
  }
  return 0;
}

export function groundZone(x: number, z: number): number {
  // 0 base, 1 courtyard floor, 2 garden lawn, 3 islet, 4 stairs
  const C = DATA.courtyard, G = DATA.garden;
  if (inRect(x, z, C.x, C.z)) return C.stairs.some((s) => inRect(x, z, s.x, s.z)) ? 4 : 1;
  if (inRect(x, z, G.x, G.z)) return inRect(x, z, G.steps.x, G.steps.z) || inRect(x, z, GARDEN_STEPS_SE.x, GARDEN_STEPS_SE.z) ? 4 : 2;
  if (x * x + z * z > ISLAND_R * ISLAND_R) return 3;
  return 0;
}

/** Ground mesh on a regular grid (render + trimesh collision). */
export function buildGround(step = 0.5) {
  const ext = 41;
  const n = Math.round((ext * 2) / step) + 1;
  const idx = (i: number, j: number) => i * n + j;
  const positions: number[] = [];
  const indices: number[] = [];
  const zone: number[] = [];
  const vmap = new Int32Array(n * n).fill(-1);
  for (let i = 0; i < n; i++)
    for (let j = 0; j < n; j++) {
      const x = -ext + j * step, z = -ext + i * step;
      const h = groundHeight(x, z);
      if (h === null) continue;
      vmap[idx(i, j)] = positions.length / 3;
      positions.push(x, h, z);
      zone.push(groundZone(x, z));
    }
  for (let i = 0; i < n - 1; i++)
    for (let j = 0; j < n - 1; j++) {
      const a = vmap[idx(i, j)], b = vmap[idx(i, j + 1)], c = vmap[idx(i + 1, j)], d = vmap[idx(i + 1, j + 1)];
      if (a >= 0 && b >= 0 && c >= 0 && d >= 0) indices.push(a, c, b, b, c, d);
      else {
        if (a >= 0 && c >= 0 && d >= 0 && b < 0) indices.push(a, c, d);
        if (a >= 0 && b >= 0 && d >= 0 && c < 0) indices.push(a, d, b);
        if (a >= 0 && b >= 0 && c >= 0 && d < 0) indices.push(a, c, b);
        if (b >= 0 && c >= 0 && d >= 0 && a < 0) indices.push(b, c, d);
      }
    }
  return { positions: new Float32Array(positions), indices: new Uint32Array(indices), zone: new Uint8Array(zone) };
}

/** A thin wall box between two points on the ground. */
function segBox(a: number[], b: number[], baseY: number, h: number, thick: number, tag: string): Box {
  const dx = b[0] - a[0], dz = b[1] - a[1];
  const len = Math.hypot(dx, dz);
  const yaw = -Math.atan2(dz, dx);
  return { c: [(a[0] + b[0]) / 2, baseY + h / 2, (a[1] + b[1]) / 2], h: [len / 2 + thick / 2, h / 2, thick / 2], yaw, tag };
}

/** Walls along one edge of a rect, leaving gaps; gaps may have a sill (window). */
function wallWithGaps(boxes: Box[], axis: "x" | "z", fixed: number, from: number, to: number, gaps: { lo: number; hi: number; bottom?: number; top?: number }[], baseY: number, h: number, t: number, tag: string) {
  const seg = (lo: number, hi: number, y0: number, y1: number) => {
    if (hi - lo <= 0.01 || y1 - y0 <= 0.01) return;
    const c = (lo + hi) / 2, hl = (hi - lo) / 2, cy = baseY + (y0 + y1) / 2, hy = (y1 - y0) / 2;
    boxes.push(axis === "x" ? { c: [fixed, cy, c], h: [t / 2, hy, hl], tag } : { c: [c, cy, fixed], h: [hl, hy, t / 2], tag });
  };
  const sorted = [...gaps].sort((p, q) => p.lo - q.lo);
  let cur = from - t / 2;
  for (const g of sorted) {
    seg(cur, g.lo, 0, h);
    if (g.bottom !== undefined) seg(g.lo, g.hi, 0, g.bottom);
    seg(g.lo, g.hi, g.top ?? h, h);
    cur = g.hi;
  }
  seg(cur, to + t / 2, 0, h);
}

export const DOOR_H = 2.4;
export const WINDOW_TOP = 2.2;

export function buildStaticBoxes(): { boxes: Box[]; cyls: Cyl[] } {
  const boxes: Box[] = [];
  const cyls: Cyl[] = [];
  const T = TOWER;
  cyls.push({ c: [0, T.roof / 2, 0], r: T.r, hh: T.roof / 2 });
  // Parapet ring with a gap where the ramp arrives
  const arrive = ((T.rampStartDeg + T.rampSweepDeg) * Math.PI) / 180;
  for (let k = 0; k < 20; k++) {
    const a = (k / 20) * Math.PI * 2;
    const da = Math.abs((((a - arrive) % (Math.PI * 2)) + Math.PI * 3) % (Math.PI * 2) - Math.PI);
    if (da < 0.4) continue;
    const r = T.r - 0.25;
    boxes.push({ c: [Math.cos(a) * r, T.roof + T.parapetH / 2, Math.sin(a) * r], h: [0.25, T.parapetH / 2, 0.85], yaw: -a, tag: "parapet" });
  }
  for (const s of rampSegments()) boxes.push(s);

  // Courtyard rim walls (1.1 m above ground level), open at the stairs
  const C = COURTYARD;
  const t = 0.3;
  const st = DATA.courtyard.stairs;
  const gapsOn = (dir: string) => st.filter((s) => s.dir === dir).map((s) => (dir === "N" || dir === "S" ? { lo: s.x[0], hi: s.x[1] } : { lo: s.z[0], hi: s.z[1] }));
  wallWithGaps(boxes, "z", C.z0 - t / 2, C.x0, C.x1, gapsOn("N"), 0, C.wallH, t, "cwall");
  wallWithGaps(boxes, "z", C.z1 + t / 2, C.x0, C.x1, gapsOn("S"), 0, C.wallH, t, "cwall");
  wallWithGaps(boxes, "x", C.x0 - t / 2, C.z0, C.z1, gapsOn("W"), 0, C.wallH, t, "cwall");
  wallWithGaps(boxes, "x", C.x1 + t / 2, C.z0, C.z1, gapsOn("E"), 0, C.wallH, t, "cwall");

  // Cover walls from the data (in the courtyard they stand on its floor)
  for (const cv of DATA.cover) {
    const mx = (cv.a[0] + cv.b[0]) / 2, mz = (cv.a[1] + cv.b[1]) / 2;
    const base = groundHeight(mx, mz) ?? 0;
    boxes.push(segBox(cv.a, cv.b, base, cv.h, 0.4, cv.h > 1.5 ? "wallcover" : "cover"));
  }

  // Workshop: walls with doors and the window from the data, roof slab, a bench
  const W = WORKSHOP, wt = W.wall;
  const doors = DATA.workshop.doors;
  const win = DATA.workshop.window;
  const gaps = (wall: string) => {
    const out: { lo: number; hi: number; bottom?: number; top?: number }[] = [];
    for (const d of doors) if (d.wall === wall) { const r = (d as any).x ?? (d as any).z; out.push({ lo: r[0], hi: r[1], top: DOOR_H }); }
    if (win.wall === wall) out.push({ lo: win.x[0], hi: win.x[1], bottom: win.sill, top: WINDOW_TOP });
    return out;
  };
  wallWithGaps(boxes, "x", W.x0, W.z0, W.z1, gaps("W"), 0, W.h, wt, "wwall");
  wallWithGaps(boxes, "x", W.x1, W.z0, W.z1, gaps("E"), 0, W.h, wt, "wwall");
  wallWithGaps(boxes, "z", W.z0, W.x0, W.x1, gaps("N"), 0, W.h, wt, "wwall");
  wallWithGaps(boxes, "z", W.z1, W.x0, W.x1, gaps("S"), 0, W.h, wt, "wwall");
  boxes.push({ c: [(W.x0 + W.x1) / 2, W.h + 0.15, (W.z0 + W.z1) / 2], h: [(W.x1 - W.x0) / 2 + 0.4, 0.15, (W.z1 - W.z0) / 2 + 0.4], tag: "wroof" });
  boxes.push({ c: [W.x1 - 1.0, 0.45, (W.z0 + W.z1) / 2 + 1.2], h: [0.5, 0.45, 1.3], tag: "bench" });

  // Garden: hedges and arches
  const G = GARDEN;
  for (const [a, b] of DATA.garden.hedges) boxes.push(segBox(a, b, G.height, 1.1, 0.7, "hedge"));
  for (const [x, z] of DATA.garden.arches) for (const dz of [-1.3, 1.3]) boxes.push({ c: [x, G.height + 1.4, z + dz], h: [0.3, 1.4, 0.3], tag: "pillar" });

  // Bridges + low rails
  for (const br of DATA.bridges) {
    const [x0, x1] = br.x;
    const cx = (x0 + x1) / 2, hx = (x1 - x0) / 2 + 0.8;
    boxes.push({ c: [cx, -0.2, 0], h: [hx, 0.2, br.w / 2], tag: "bridge" });
    boxes.push({ c: [cx, 0.35, -br.w / 2 - 0.1], h: [hx - 0.8, 0.35, 0.1], tag: "rail" });
    boxes.push({ c: [cx, 0.35, br.w / 2 + 0.1], h: [hx - 0.8, 0.35, 0.1], tag: "rail" });
  }
  // solid set dressing (shared/decor.ts)
  for (const d of buildDecor()) { if (d.box) boxes.push(d.box); if (d.cyl) cyls.push(d.cyl); }
  return { boxes, cyls };
}

export function rampSegments(): Box[] {
  const T = TOWER;
  const out: Box[] = [];
  const r = (T.rampInner + T.rampOuter) / 2;
  const w = T.rampOuter - T.rampInner;
  const a0 = (T.rampStartDeg * Math.PI) / 180;
  const sweep = (T.rampSweepDeg * Math.PI) / 180;
  const n = T.segments;
  const thick = 0.3;
  for (let k = 0; k < n; k++) {
    const t0 = k / n, t1 = (k + 1) / n;
    const am = a0 + sweep * ((t0 + t1) / 2);
    const y0 = T.roof * t0, y1 = T.roof * t1;
    const arc = (sweep / n) * r;
    const len = arc * 1.08;
    const pitch = Math.atan2(y1 - y0, arc);
    const ym = (y0 + y1) / 2 - (thick / 2) / Math.cos(pitch);
    const yaw = -am - Math.PI / 2;
    out.push({ c: [Math.cos(am) * r, ym, Math.sin(am) * r], h: [len / 2, thick / 2, w / 2 + 0.05], yaw, pitch, tag: "ramp" });
    const ro = T.rampOuter + 0.12;
    out.push({ c: [Math.cos(am) * ro, ym + 0.45, Math.sin(am) * ro], h: [((len * ro) / r) / 2, 0.3, 0.12], yaw, pitch, tag: "ramprail" });
  }
  return out;
}

export const SPAWNS: V3[] = DATA.spawns.map((s) => {
  let [x, z] = s.p;
  // keep spawns off walls (the ring passes through the workshop's east wall)
  if (inRect(x, z, [WORKSHOP.x0 - 0.5, WORKSHOP.x1 + 0.5], [WORKSHOP.z0 - 0.5, WORKSHOP.z1 + 0.5])) x = Math.min(x, WORKSHOP.x1 - 0.9);
  return [x, (groundHeight(x, z) ?? 0) + 0.05, z] as V3;
});

export type PickupKind = "health" | "shield" | "arc";
export interface PickupDef { kind: PickupKind; p: V3 }
export const PICKUP_DEFS: PickupDef[] = [
  ...DATA.health.map(([x, z]) => ({ kind: "health" as const, p: [x, groundHeight(x, z) ?? 0, z] as V3 })),
  ...DATA.shield.map(([x, z]) => ({ kind: "shield" as const, p: [x, groundHeight(x, z) ?? 0, z] as V3 })),
  { kind: "arc", p: [DATA.launcher[0], TOWER.roof, DATA.launcher[1]] },
];

// Jump pads: 14 m/s up and ~20 m/s across, flown at half gravity, 1.6 s to the tower roof.
export const PAD_GRAVITY_MUL = 0.5;
export interface PadDef { p: V3; target: V3; flightS: number }
export const PADS: PadDef[] = DATA.pads.map(([x, z]) => ({ p: [x, 0, z] as V3, target: [Math.sign(x) * 2.2, TOWER.roof + 0.2, z] as V3, flightS: 1.6 }));
export const PAD_RADIUS = 1.1;

export function padVelocity(pad: PadDef, g: number): V3 {
  const t = pad.flightS;
  const gg = g * PAD_GRAVITY_MUL;
  const dx = pad.target[0] - pad.p[0], dz = pad.target[2] - pad.p[2], dy = pad.target[1] - pad.p[1];
  return [dx / t, (dy + 0.5 * gg * t * t) / t, dz / t];
}

export interface PropDef { kind: "crate" | "barrel"; p: V3; yaw: number; half: V3 }
export const PROP_DEFS: PropDef[] = DATA.crates.map(([x, z], i) => {
  const kind = i % 3 === 2 ? "barrel" : "crate";
  return { kind, p: [x, groundHeight(x, z) ?? 0, z] as V3, yaw: (i * 0.7) % 1.5, half: kind === "crate" ? [0.5, 0.5, 0.5] as V3 : [0.42, 0.55, 0.42] as V3 };
});

// ---------- bot navigation graph ----------
export interface NavNode { id: string; p: V3; tag?: "health" | "shield" | "arc" | "pad" | "roof" }
export const NAV: { nodes: NavNode[]; links: [number, number][]; oneWay: [number, number][] } = (() => {
  const nodes: NavNode[] = [];
  const index = new Map<string, number>();
  const add = (id: string, x: number, y: number, z: number, tag?: NavNode["tag"]) => { index.set(id, nodes.length); nodes.push({ id, p: [x, y, z], tag }); return nodes.length - 1; };
  for (const [id, w] of Object.entries(DATA.waypoints)) {
    const [x, z, y] = w as number[];
    const tag = id === "T" ? "arc" : id === "JW" || id === "JE" ? "pad" : undefined;
    add(id, x, y, z, tag);
  }
  // Pickup nodes, linked to their nearest waypoint
  const links: [number, number][] = [];
  const oneWay: [number, number][] = [];
  const nearest = (x: number, y: number, z: number, skip?: number) => {
    let best = 0, bd = Infinity;
    nodes.forEach((n, i) => {
      if (i === skip) return;
      const d = (n.p[0] - x) ** 2 + (n.p[2] - z) ** 2 + ((n.p[1] - y) * 4) ** 2;
      if (d < bd) { bd = d; best = i; }
    });
    return best;
  };
  // Ramp: replace the straight RB-RM-RT hops with points every 25 degrees along the spiral
  const T = TOWER;
  const rr = (T.rampInner + T.rampOuter) / 2;
  const rampIds: number[] = [index.get("RB")!];
  for (let a = 25; a < T.rampSweepDeg; a += 25) {
    const ang = ((T.rampStartDeg + a) * Math.PI) / 180;
    rampIds.push(add(`R${a}`, Math.cos(ang) * rr, (T.roof * a) / T.rampSweepDeg, Math.sin(ang) * rr));
  }
  rampIds.push(index.get("RT")!);
  for (let i = 0; i < rampIds.length - 1; i++) links.push([rampIds[i], rampIds[i + 1]]);
  for (const [a, b] of DATA.edges) {
    if ((a === "RB" && b === "RM") || (a === "RM" && b === "RT")) continue;
    const ia = index.get(a)!, ib = index.get(b)!;
    if (a === "RM" && b === "WD1") { oneWay.push([ia, ib]); continue; } // drop off the ramp
    links.push([ia, ib]);
  }
  // RM sits on the ramp; tie it to the nearest spiral points
  const rm = index.get("RM")!;
  const near1 = nearest(nodes[rm].p[0], nodes[rm].p[1], nodes[rm].p[2], rm);
  links.push([rm, near1]);
  for (const [a, b] of DATA.jumps) oneWay.push([index.get(a)!, index.get(b)!]);
  // a roof point each side
  const top = index.get("T")!;
  for (const [x, z] of [[2.5, 0], [-2.5, 0], [0, 2.5], [0, -2.5]]) links.push([top, add(`T${x},${z}`, x, T.roof, z, "roof")]);
  for (const def of PICKUP_DEFS) {
    if (def.kind === "arc") continue;
    const i = add(`${def.kind}@${def.p[0]},${def.p[2]}`, def.p[0], def.p[1], def.p[2], def.kind);
    links.push([i, nearest(def.p[0], def.p[1], def.p[2], i)]);
  }
  return { nodes, links, oneWay };
})();
