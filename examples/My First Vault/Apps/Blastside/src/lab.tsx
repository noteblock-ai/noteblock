// Character lab: /?lab=character
// Left: the raw GLB clip. Right: the in-game CharacterView driven by a chosen state (same code as the game).
import { Canvas, useFrame, useThree } from "@react-three/fiber";
import { OrbitControls } from "@react-three/drei";
import { useEffect, useMemo, useState } from "react";
import * as THREE from "three";
import { clone as cloneSkinned } from "three/examples/jsm/utils/SkeletonUtils.js";
import RAPIER from "@dimforge/rapier3d-compat";
import { loadAssets, assets as A } from "./assets";
import { CharacterView, CHAR_SCALE, type CharState } from "./game/character";
import { Ragdolls } from "./game/ragdoll";
import { G_MAP, groups, SUITS, type WeaponId } from "@blastside/shared";

export const STATES = ["idle", "walk", "run", "crouch", "crouchWalk", "strafeL", "strafeR", "backpedal", "jump", "fall", "land", "aim", "shoot", "reload", "swap", "hit", "death", "ragdoll"] as const;
type LabState = (typeof STATES)[number];

interface LabCtl {
  state: LabState;
  speed: number;
  aimLayer: boolean;
  weapon: boolean;
  skeleton: boolean;
  weaponId: WeaponId;
  clip: string;
  pitch: number;
  turntable: boolean;
  fp: boolean;
  variants: boolean;
}

declare global { interface Window { __lab?: any } }

function Scene({ ctl }: { ctl: LabCtl }) {
  const { scene, camera } = useThree();
  const world = useMemo(() => {
    const w = new RAPIER.World({ x: 0, y: -24, z: 0 });
    w.createCollider(RAPIER.ColliderDesc.cuboid(20, 0.5, 20).setTranslation(0, -0.5, 0).setCollisionGroups(groups(G_MAP, 0xffff)));
    return w;
  }, []);
  const parts = useMemo(() => {
    // raw clip on the left
    const raw = cloneSkinned(A!.character.scene);
    raw.scale.setScalar(CHAR_SCALE);
    raw.position.set(-1.1, 0, 0);
    raw.rotation.y = Math.PI;
    raw.traverse((o) => { if ((o as THREE.Mesh).isMesh) { o.castShadow = true; (o as THREE.Mesh).frustumCulled = false; } });
    const rawMixer = new THREE.AnimationMixer(raw);
    const view = new CharacterView(0);
    view.root.position.set(1.1, 0, 0);
    const ragdolls = new Ragdolls(RAPIER, world, scene);
    const helperRaw = new THREE.SkeletonHelper(raw);
    const helperView = new THREE.SkeletonHelper(view.model);
    scene.add(raw, view.root, helperRaw, helperView);
    // Every suit colour, created the same way the game creates players (regression check)
    const variants = SUITS.map((_, i) => { const v = new CharacterView(i); v.root.position.set(-5.25 + i * 1.5, 0, -3); v.root.visible = false; scene.add(v.root); return v; });
    return { raw, rawMixer, view, ragdolls, helperRaw, helperView, variants };
  }, [scene, world]);

  useEffect(() => {
    scene.environment = A!.hdr;
    scene.environmentIntensity = 0.6;
    scene.background = new THREE.Color("#2a2433");
    const ground = new THREE.Mesh(new THREE.PlaneGeometry(14, 14).rotateX(-Math.PI / 2), new THREE.MeshStandardMaterial({ color: "#575061", roughness: 0.9 }));
    ground.receiveShadow = true;
    scene.add(ground);
    const grid = new THREE.GridHelper(14, 28, "#8a8197", "#6a6276");
    grid.position.y = 0.002;
    scene.add(grid);
    // 1.8 m reference posts
    for (const x of [-2.4, 2.4]) {
      const post = new THREE.Mesh(new THREE.BoxGeometry(0.04, 1.8, 0.04), new THREE.MeshBasicMaterial({ color: "#ff8a3d" }));
      post.position.set(x, 0.9, 0);
      scene.add(post);
    }
    const sun = new THREE.DirectionalLight("#ffe2c4", 2.4);
    sun.position.set(3, 6, 4);
    sun.castShadow = true;
    sun.shadow.mapSize.set(1024, 1024);
    scene.add(sun);
    scene.add(new THREE.HemisphereLight("#ffe7d0", "#3a3346", 0.5));
  }, [scene]);

  // raw clip
  useEffect(() => {
    const c = A!.character.animations.find((a) => a.name === ctl.clip);
    parts.rawMixer.stopAllAction();
    if (c) parts.rawMixer.clipAction(c).reset().play();
  }, [ctl.clip, parts]);

  // state changes that are events
  const [t0, setT0] = useState(0);
  useEffect(() => {
    const v = parts.view;
    parts.ragdolls.release(v);
    v.root.visible = true;
    v.revive();
    v.setWeaponImmediate(ctl.weaponId);
    setT0(performance.now());
    if (ctl.state === "reload") v.reload(1.5);
    if (ctl.state === "swap") v.switchWeapon(((ctl.weaponId + 1) % 3) as WeaponId);
    if (ctl.state === "hit") v.hit(35, true);
    if (ctl.state === "ragdoll") { v.root.updateMatrixWorld(true); parts.ragdolls.start(v, new THREE.Vector3(0, 0.3, 1)); }
  }, [ctl.state, ctl.weaponId, parts]);

  const rawSched = useMemo(() => ({ clip: "" }), []);
  useFrame((_, dtRaw) => {
    const dt = Math.min(dtRaw, 1 / 30) * ctl.speed;
    const { view, rawMixer, helperRaw, helperView } = parts;
    rawMixer.update(dt);
    helperRaw.visible = helperView.visible = ctl.skeleton;
    view.weapons.forEach((w, i) => (w.root.visible = ctl.weapon && i === view.weapon));
    const age = (performance.now() - t0) / 1000;
    const st = ctl.state;
    const sp = st === "walk" || st === "aim" ? 3.2 : st === "run" ? 6 : st === "strafeL" || st === "strafeR" ? 5 : st === "backpedal" ? 4 : 0;
    const s: CharState = { vx: 0, vz: 0, vy: 0, yaw: ctl.turntable ? performance.now() / 4000 : 0, pitch: ctl.pitch, grounded: true, aim: st === "aim", weapon: ctl.weaponId, reloading: st === "reload" && age < 1.5, dashing: false, alive: !(st === "death" || st === "ragdoll") };
    const fy = s.yaw;
    const f = new THREE.Vector3(-Math.sin(fy), 0, -Math.cos(fy)), r = new THREE.Vector3(Math.cos(fy), 0, -Math.sin(fy));
    let v = new THREE.Vector3();
    if (st === "walk" || st === "run" || st === "aim") v = f.clone().multiplyScalar(sp);
    if (st === "strafeL") v = r.clone().multiplyScalar(-sp);
    if (st === "strafeR") v = r.clone().multiplyScalar(sp);
    if (st === "backpedal") v = f.clone().multiplyScalar(-sp);
    s.vx = v.x; s.vz = v.z;
    // jump: the real airtime (v0 7.9 m/s, g 24 -> 0.66 s up and down), then 0.6 s on the ground
    if (st === "jump") { const k = age % 1.26; s.grounded = k > 0.66; s.vy = s.grounded ? 0 : 7.9 - 24 * k;
      // the raw figure follows the same schedule: Jump over the first 0.22 s, Jump_Idle in the air, Jump_Land on touchdown
      const want = k < 0.22 ? "Jump" : k < 0.66 ? "Jump_Idle" : "Jump_Land";
      if (rawSched.clip !== want) { rawSched.clip = want; const c = A!.character.animations.find((a) => a.name === want); if (c) { rawMixer.stopAllAction(); const a = rawMixer.clipAction(c); a.reset(); a.setLoop(want === "Jump_Idle" ? THREE.LoopRepeat : THREE.LoopOnce, Infinity); a.clampWhenFinished = true; a.timeScale = want === "Jump" ? c.duration / 0.22 : want === "Jump_Land" ? c.duration / 0.3 : 1; a.play(); } }
    } else rawSched.clip = "";
    if (st === "fall") { s.grounded = false; s.vy = -10; }
    if (st === "land") { s.grounded = (age % 1.2) > 0.4; s.vy = -6; }
    if (st === "shoot" && Math.floor(age * 10) !== Math.floor((age - dtRaw) * 10)) view.noteFire();
    if (!ctl.aimLayer) (view as any).actions.U_aim?.setEffectiveWeight(0);
    view.setFirstPerson(ctl.fp);
    const moving = Math.hypot(s.vx, s.vz) > 0.5;
    const tt = performance.now() / 1000;
    view.sway.set(moving ? Math.sin(tt * 8) * 0.012 : Math.sin(tt * 1.3) * 0.003, moving ? Math.abs(Math.cos(tt * 8)) * 0.012 : Math.sin(tt * 1.1) * 0.002, 0);
    view.crouch = st === "crouch" || st === "crouchWalk";
    if (st === "crouchWalk") { s.vx = f.x * 3; s.vz = f.z * 3; }
    if (st !== "ragdoll") view.update(dt, s);
    for (const [i, vv] of parts.variants.entries()) {
      vv.root.visible = ctl.variants;
      if (!ctl.variants) continue;
      vv.setWeaponImmediate(((ctl.weaponId + i) % 3) as WeaponId);
      vv.update(dt, { ...s, pitch: ctl.pitch + (i % 3 - 1) * 0.3, alive: s.alive });
    }
    if (ctl.fp) {
      const cam = camera as THREE.PerspectiveCamera;
      if (cam.fov !== 85) { cam.fov = 85; cam.updateProjectionMatrix(); }
      view.root.updateMatrixWorld(true);
      const eye = view.eyeWorld(new THREE.Vector3());
      cam.position.copy(eye);
      const cp = Math.cos(ctl.pitch);
      cam.lookAt(eye.x - Math.sin(s.yaw) * cp, eye.y + Math.sin(ctl.pitch), eye.z - Math.cos(s.yaw) * cp);
    } else if ((camera as THREE.PerspectiveCamera).fov !== 40) { (camera as THREE.PerspectiveCamera).fov = 40; (camera as THREE.PerspectiveCamera).updateProjectionMatrix(); }
    if (!ctl.aimLayer) (view as any).actions.U_aim?.setEffectiveWeight(0);
    world.timestep = Math.max(1 / 240, dt);
    world.step();
    parts.ragdolls.update(dt);
  });

  useEffect(() => {
    window.__lab = { parts, camera, cam: (x: number, y: number, z: number, tx = 0, ty = 0.9, tz = 0) => { camera.position.set(x, y, z); camera.lookAt(tx, ty, tz); } };
  }, [parts, camera]);
  return null;
}

export function Lab() {
  const [ready, setReady] = useState(false);
  const [ctl, setCtl] = useState<LabCtl>({ state: "idle", speed: 1, aimLayer: true, weapon: true, skeleton: false, weaponId: 0, clip: "Idle", pitch: 0, turntable: false, fp: false, variants: false });
  useEffect(() => { Promise.all([loadAssets(), RAPIER.init()]).then(() => setReady(true)); }, []);
  useEffect(() => { window.__labSet = (p: Partial<LabCtl>) => setCtl((c) => ({ ...c, ...p })); }, []);
  if (!ready) return <div style={{ color: "#fff", padding: 20, font: "14px system-ui" }}>loading…</div>;
  const clips = A!.character.animations.map((a) => a.name);
  const btn = (on: boolean): React.CSSProperties => ({ font: "12px system-ui", padding: "4px 8px", border: "1px solid #6a6276", background: on ? "#ff8a3d" : "transparent", color: on ? "#1b1424" : "#eee", cursor: "pointer" });
  return (
    <div style={{ position: "fixed", inset: 0 }}>
      <Canvas shadows camera={{ position: [0, 1.6, 4.6], fov: 40 }} gl={{ preserveDrawingBuffer: true }}>
        <Scene ctl={ctl} />
        {!ctl.fp && <OrbitControls target={[0, 0.9, 0]} />}
      </Canvas>
      <div style={{ position: "absolute", left: 10, top: 10, display: "flex", flexDirection: "column", gap: 6, maxWidth: 520 }}>
        <div style={{ color: "#bbb", font: "12px system-ui" }}>left: raw clip · right: in-game blend (CharacterView)</div>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>{STATES.map((s) => <button key={s} style={btn(ctl.state === s)} onClick={() => setCtl({ ...ctl, state: s })}>{s}</button>)}</div>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>{clips.map((c) => <button key={c} style={btn(ctl.clip === c)} onClick={() => setCtl({ ...ctl, clip: c })}>{c}</button>)}</div>
        <div style={{ display: "flex", gap: 10, color: "#ddd", font: "12px system-ui", alignItems: "center", flexWrap: "wrap" }}>
          <label>speed <input type="range" min={0.1} max={2} step={0.1} value={ctl.speed} onChange={(e) => setCtl({ ...ctl, speed: +e.target.value })} /> {ctl.speed}</label>
          <label>pitch <input type="range" min={-1} max={1} step={0.05} value={ctl.pitch} onChange={(e) => setCtl({ ...ctl, pitch: +e.target.value })} /></label>
          <label><input type="checkbox" checked={ctl.aimLayer} onChange={(e) => setCtl({ ...ctl, aimLayer: e.target.checked })} /> aim layer</label>
          <label><input type="checkbox" checked={ctl.weapon} onChange={(e) => setCtl({ ...ctl, weapon: e.target.checked })} /> weapon</label>
          <label><input type="checkbox" checked={ctl.skeleton} onChange={(e) => setCtl({ ...ctl, skeleton: e.target.checked })} /> skeleton</label>
          <label><input type="checkbox" checked={ctl.turntable} onChange={(e) => setCtl({ ...ctl, turntable: e.target.checked })} /> turntable</label>
          <label><input type="checkbox" checked={ctl.fp} onChange={(e) => setCtl({ ...ctl, fp: e.target.checked })} /> first person</label>
          <label><input type="checkbox" checked={ctl.variants} onChange={(e) => setCtl({ ...ctl, variants: e.target.checked })} /> all suits</label>
          {[0, 1, 2].map((w) => <button key={w} style={btn(ctl.weaponId === w)} onClick={() => setCtl({ ...ctl, weaponId: w as WeaponId })}>{["rifle", "scatter", "arc"][w]}</button>)}
        </div>
      </div>
    </div>
  );
}
declare global { interface Window { __labSet?: (p: Partial<LabCtl>) => void } }
