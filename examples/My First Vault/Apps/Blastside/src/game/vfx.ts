// Pooled effects: tracers, muzzle flashes (+ lights), sparks, scorch decals, explosions, dust.
import * as THREE from "three";
import { assets } from "../assets";

const CELL = { muzzleA: 0, muzzleB: 1, spark: 2, scorch: 3, smoke: 4, ring: 5, glow: 6, star: 7 } as const;

function cellTexture(cell: number) {
  const t = assets!.vfx.clone();
  t.needsUpdate = true;
  t.repeat.set(0.25, 0.5);
  t.offset.set((cell % 4) * 0.25, 1 - (Math.floor(cell / 4) + 1) * 0.5);
  return t;
}

interface Tracer { mesh: THREE.Mesh; life: number; max: number }
interface Flash { sprite: THREE.Sprite; life: number; max?: number; base?: number }
interface Spark { p: THREE.Vector3; v: THREE.Vector3; life: number; max: number; color: THREE.Color; size: number }
interface Decal { mesh: THREE.Mesh; life: number }
interface Puff { sprite: THREE.Sprite; v: THREE.Vector3; life: number; max: number; grow: number; baseOpacity: number }
interface Wave { mesh: THREE.Mesh; life: number; max: number; radius: number }

const _v = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _m = new THREE.Matrix4();
const Z = new THREE.Vector3(0, 0, 1);

export class Vfx {
  readonly group = new THREE.Group();
  private tracers: Tracer[] = [];
  private flashes: Flash[] = [];
  private lights: { light: THREE.PointLight; life: number }[] = [];
  private sparks: Spark[] = [];
  private sparkMesh: THREE.InstancedMesh;
  private decals: Decal[] = [];
  private decalIdx = 0;
  private puffs: Puff[] = [];
  private waves: Wave[] = [];
  private tracerGeo: THREE.BufferGeometry;
  private mats: Record<string, THREE.Material> = {};
  shake = 0;

  constructor() {
    this.group.name = "vfx";
    const additive = (cell: number, color: string, opacity = 1) =>
      new THREE.SpriteMaterial({ map: cellTexture(cell), color, transparent: true, opacity, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false });
    this.mats.muzzleA = additive(CELL.muzzleA, "#ffd9a0");
    this.mats.muzzleB = additive(CELL.muzzleB, "#a0fff5");
    this.mats.muzzleC = additive(CELL.muzzleA, "#d6b8ff");
    this.mats.fire = additive(CELL.glow, "#ffb070");
    this.mats.smoke = new THREE.SpriteMaterial({ map: cellTexture(CELL.smoke), color: "#d8cfc4", transparent: true, opacity: 0.5, depthWrite: false });
    this.mats.dust = new THREE.SpriteMaterial({ map: cellTexture(CELL.smoke), color: "#cdbb9f", transparent: true, opacity: 0.35, depthWrite: false });

    // Tracers: stretched additive quads (cross of two planes so they read from any angle)
    const tg = new THREE.BufferGeometry();
    const w = 0.5;
    tg.setAttribute("position", new THREE.Float32BufferAttribute([-w, 0, 0, w, 0, 0, w, 0, 1, -w, 0, 0, w, 0, 1, -w, 0, 1, 0, -w, 0, 0, w, 0, 0, w, 1, 0, -w, 0, 0, w, 1, 0, -w, 1], 3));
    tg.setAttribute("uv", new THREE.Float32BufferAttribute([0, 0, 1, 0, 1, 1, 0, 0, 1, 1, 0, 1, 0, 0, 1, 0, 1, 1, 0, 0, 1, 1, 0, 1], 2));
    this.tracerGeo = tg;
    for (let i = 0; i < 48; i++) {
      const mat = new THREE.MeshBasicMaterial({ color: "#fff1c4", transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide, toneMapped: false });
      const mesh = new THREE.Mesh(this.tracerGeo, mat);
      mesh.visible = false;
      mesh.frustumCulled = false;
      this.group.add(mesh);
      this.tracers.push({ mesh, life: 0, max: 0.06 });
    }
    for (let i = 0; i < 18; i++) {
      const s = new THREE.Sprite(this.mats.muzzleA as THREE.SpriteMaterial);
      s.visible = false;
      this.group.add(s);
      this.flashes.push({ sprite: s, life: 0 });
    }
    for (let i = 0; i < 4; i++) {
      const l = new THREE.PointLight("#ffb46b", 0, 6, 2);
      this.group.add(l);
      this.lights.push({ light: l, life: 0 });
    }
    // Sparks: instanced elongated quads
    const sg = new THREE.BoxGeometry(0.03, 0.03, 0.22);
    const sm = new THREE.MeshBasicMaterial({ color: "#ffffff", toneMapped: false, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false });
    this.sparkMesh = new THREE.InstancedMesh(sg, sm, 400);
    this.sparkMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.sparkMesh.count = 0;
    this.sparkMesh.frustumCulled = false;
    this.group.add(this.sparkMesh);
    // Decals
    const dm = new THREE.MeshBasicMaterial({ map: cellTexture(CELL.scorch), color: "#2a2220", transparent: true, opacity: 0, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -4 });
    for (let i = 0; i < 24; i++) {
      const mesh = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), dm.clone());
      mesh.visible = false;
      this.group.add(mesh);
      this.decals.push({ mesh, life: 0 });
    }
  }

  tracer(from: THREE.Vector3, to: THREE.Vector3, color = "#fff1c4", width = 0.05, life = 0.07) {
    const t = this.tracers.find((x) => x.life <= 0) ?? this.tracers[0];
    const len = from.distanceTo(to);
    if (len < 0.2) return;
    const m = t.mesh;
    m.position.copy(from);
    _v.subVectors(to, from).normalize();
    _q.setFromUnitVectors(Z, _v);
    m.quaternion.copy(_q);
    m.scale.set(width, width, len);
    (m.material as THREE.MeshBasicMaterial).color.set(color);
    (m.material as THREE.MeshBasicMaterial).opacity = 1;
    m.visible = true;
    t.life = life; t.max = life;
  }

  /**
   * Muzzle burst: three additive petals at random angles, a hot core and a few sparks, ~70 ms.
   * `scale` shrinks it for the first-person viewmodel; `lightAt` puts the light at the real-world muzzle.
   */
  muzzle(at: THREE.Vector3, weapon: number, light = true, scale = 1, lightAt?: THREE.Vector3) {
    const mat = (weapon === 1 ? this.mats.muzzleB : weapon === 2 ? this.mats.muzzleC : this.mats.muzzleA) as THREE.SpriteMaterial;
    const base = (weapon === 1 ? 0.55 : 0.38) * scale;
    for (let i = 0; i < 3; i++) {
      const f = this.flashes.find((x) => x.life <= 0) ?? this.flashes[i];
      if (!f.sprite.userData.own) { f.sprite.material = mat.clone(); f.sprite.userData.own = true; }
      const m = f.sprite.material as THREE.SpriteMaterial;
      m.map = mat.map; m.color.copy(mat.color); m.rotation = Math.random() * Math.PI * 2;
      f.sprite.position.copy(at);
      f.sprite.scale.setScalar(base * (i === 0 ? 1 : 0.7 + Math.random() * 0.4));
      f.sprite.visible = true;
      f.life = 0.07;
      f.max = 0.07;
      f.base = f.sprite.scale.x;
    }
    if (scale === 1) this.sparksAt(at, null, 4, weapon === 1 ? "#9ffff6" : "#ffd28a", 3);
    if (light) {
      const l = this.lights.find((x) => x.life <= 0) ?? this.lights[0];
      l.light.position.copy(lightAt ?? at);
      l.light.color.set(weapon === 1 ? "#7ff7ea" : weapon === 2 ? "#c9a6ff" : "#ffb46b");
      l.light.intensity = 6;
      l.life = 0.05;
    }
  }

  sparksAt(p: THREE.Vector3, n: THREE.Vector3 | null, count = 12, color = "#ffd28a", speed = 6) {
    for (let i = 0; i < count; i++) {
      const dir = new THREE.Vector3(Math.random() - 0.5, Math.random() - 0.2, Math.random() - 0.5).normalize();
      if (n) dir.add(n.clone().multiplyScalar(1.2)).normalize();
      this.sparks.push({ p: p.clone(), v: dir.multiplyScalar(speed * (0.4 + Math.random() * 0.8)), life: 0.25 + Math.random() * 0.2, max: 0.45, color: new THREE.Color(color), size: 1 });
    }
    if (this.sparks.length > 400) this.sparks.splice(0, this.sparks.length - 400);
  }

  decal(p: THREE.Vector3, n: THREE.Vector3, size = 0.35) {
    const d = this.decals[this.decalIdx++ % this.decals.length];
    d.mesh.position.copy(p).addScaledVector(n, 0.02);
    d.mesh.lookAt(_v2.copy(p).add(n));
    d.mesh.rotateZ(Math.random() * Math.PI * 2);
    d.mesh.scale.setScalar(size * (0.8 + Math.random() * 0.5));
    (d.mesh.material as THREE.MeshBasicMaterial).opacity = 0.85;
    d.mesh.visible = true;
    d.life = 6;
  }

  puff(p: THREE.Vector3, opts: { dust?: boolean; size?: number; life?: number; v?: THREE.Vector3; grow?: number; opacity?: number } = {}) {
    const mat = ((opts.dust ? this.mats.dust : this.mats.smoke) as THREE.SpriteMaterial).clone();
    const s = new THREE.Sprite(mat);
    s.position.copy(p);
    s.scale.setScalar(opts.size ?? 0.6);
    mat.rotation = Math.random() * Math.PI * 2;
    const base = opts.opacity ?? mat.opacity;
    mat.opacity = base;
    this.group.add(s);
    this.puffs.push({ sprite: s, v: opts.v ?? new THREE.Vector3(0, 0.6, 0), life: opts.life ?? 0.8, max: opts.life ?? 0.8, grow: opts.grow ?? 1.5, baseOpacity: base });
  }

  explosion(p: THREE.Vector3, camPos: THREE.Vector3) {
    // fireball
    for (let i = 0; i < 6; i++) {
      const mat = (this.mats.fire as THREE.SpriteMaterial).clone();
      const s = new THREE.Sprite(mat);
      s.position.copy(p).add(new THREE.Vector3((Math.random() - 0.5) * 0.8, Math.random() * 0.6, (Math.random() - 0.5) * 0.8));
      s.scale.setScalar(1.5 + Math.random());
      this.group.add(s);
      this.puffs.push({ sprite: s, v: new THREE.Vector3(0, 1.5, 0), life: 0.35, max: 0.35, grow: 3, baseOpacity: 1 });
    }
    for (let i = 0; i < 8; i++) this.puff(p.clone().add(new THREE.Vector3((Math.random() - 0.5) * 1.5, 0.2, (Math.random() - 0.5) * 1.5)), { size: 1.4, life: 1.6, v: new THREE.Vector3((Math.random() - 0.5) * 2, 1 + Math.random(), (Math.random() - 0.5) * 2), grow: 2.2, opacity: 0.55 });
    this.sparksAt(p, new THREE.Vector3(0, 1, 0), 40, "#d9b8ff", 11);
    // shockwave ring
    const ring = new THREE.Mesh(new THREE.RingGeometry(0.7, 1, 48).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ color: "#c7a8ff", transparent: true, opacity: 0.9, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide, toneMapped: false }));
    ring.position.copy(p).add(new THREE.Vector3(0, 0.15, 0));
    this.group.add(ring);
    this.waves.push({ mesh: ring, life: 0.45, max: 0.45, radius: 4.5 });
    const l = this.lights[0];
    l.light.position.copy(p).add(new THREE.Vector3(0, 0.6, 0));
    l.light.color.set("#c9a6ff");
    l.light.intensity = 40;
    l.light.distance = 14;
    l.life = 0.18;
    const d = camPos.distanceTo(p);
    if (d < 8) this.shake = Math.max(this.shake, (1 - d / 8) * 0.6);
  }

  update(dt: number) {
    for (const t of this.tracers) {
      if (t.life <= 0) continue;
      t.life -= dt;
      const m = t.mesh.material as THREE.MeshBasicMaterial;
      m.opacity = Math.max(0, t.life / t.max);
      if (t.life <= 0) t.mesh.visible = false;
    }
    for (const f of this.flashes) {
      if (f.life <= 0) continue;
      f.life -= dt;
      const k = Math.max(0, f.life / (f.max ?? 0.07));
      // pop then shrink and fade: reads as a tiny burst rather than a flicker
      f.sprite.scale.setScalar((f.base ?? 0.5) * (0.6 + 0.6 * Math.sin((1 - k) * Math.PI * 0.9)));
      (f.sprite.material as THREE.SpriteMaterial).opacity = k;
      if (f.life <= 0) f.sprite.visible = false;
    }
    for (const l of this.lights) {
      if (l.life <= 0) continue;
      l.life -= dt;
      if (l.life <= 0) { l.light.intensity = 0; l.light.distance = 6; }
    }
    // sparks
    let n = 0;
    for (let i = this.sparks.length - 1; i >= 0; i--) {
      const s = this.sparks[i];
      s.life -= dt;
      if (s.life <= 0) { this.sparks.splice(i, 1); continue; }
      s.v.y -= 14 * dt;
      s.p.addScaledVector(s.v, dt);
    }
    for (const s of this.sparks) {
      if (n >= 400) break;
      _v.copy(s.v).normalize();
      _q.setFromUnitVectors(Z, _v);
      const k = s.life / s.max;
      _m.compose(s.p, _q, _v2.set(1, 1, Math.max(0.2, Math.min(2, s.v.length() / 6)) * k + 0.1));
      this.sparkMesh.setMatrixAt(n, _m);
      this.sparkMesh.setColorAt(n, s.color.clone().multiplyScalar(1.5 * k + 0.2));
      n++;
    }
    this.sparkMesh.count = n;
    this.sparkMesh.instanceMatrix.needsUpdate = true;
    if (this.sparkMesh.instanceColor) this.sparkMesh.instanceColor.needsUpdate = true;
    for (const d of this.decals) {
      if (d.life <= 0) continue;
      d.life -= dt;
      (d.mesh.material as THREE.MeshBasicMaterial).opacity = Math.min(0.85, d.life / 2);
      if (d.life <= 0) d.mesh.visible = false;
    }
    for (let i = this.puffs.length - 1; i >= 0; i--) {
      const p = this.puffs[i];
      p.life -= dt;
      if (p.life <= 0) { p.sprite.removeFromParent(); (p.sprite.material as THREE.Material).dispose(); this.puffs.splice(i, 1); continue; }
      p.sprite.position.addScaledVector(p.v, dt);
      p.v.multiplyScalar(Math.pow(0.3, dt));
      p.sprite.scale.multiplyScalar(1 + p.grow * dt * (p.life / p.max));
      (p.sprite.material as THREE.SpriteMaterial).opacity = p.baseOpacity * (p.life / p.max);
    }
    for (let i = this.waves.length - 1; i >= 0; i--) {
      const w = this.waves[i];
      w.life -= dt;
      const k = 1 - w.life / w.max;
      w.mesh.scale.setScalar(0.3 + k * w.radius);
      (w.mesh.material as THREE.MeshBasicMaterial).opacity = (1 - k) * 0.9;
      if (w.life <= 0) { w.mesh.removeFromParent(); w.mesh.geometry.dispose(); (w.mesh.material as THREE.Material).dispose(); this.waves.splice(i, 1); }
    }
    this.shake = Math.max(0, this.shake - dt * 1.5);
  }
}
