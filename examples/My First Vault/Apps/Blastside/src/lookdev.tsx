import { Canvas, useFrame, useThree } from "@react-three/fiber";
import { OrbitControls } from "@react-three/drei";
import { useEffect, useMemo, useState } from "react";
import * as THREE from "three";
import { loadAssets, assets as A } from "./assets";
import { CharacterView } from "./game/character";

declare global { interface Window { __ld: any } }

function Scene() {
  const { scene, camera } = useThree();
  const view = useMemo(() => {
    const v = new CharacterView(0);
    scene.add(v.root);
    return v;
  }, [scene]);
  useEffect(() => {
    scene.environment = A!.hdr;
    scene.background = new THREE.Color("#8a9bb5");
    const g = new THREE.Mesh(new THREE.CircleGeometry(4, 32).rotateX(-Math.PI / 2), new THREE.MeshStandardMaterial({ color: "#c9b79c" }));
    scene.add(g);
    const grid = new THREE.GridHelper(4, 8);
    scene.add(grid);
    const sun = new THREE.DirectionalLight("#ffd2a0", 2);
    sun.position.set(3, 5, 4);
    scene.add(sun);
    window.__ld = {
      view, camera,
      cam: (x: number, y: number, z: number, tx = 0, ty = 1, tz = 0) => { camera.position.set(x, y, z); camera.lookAt(tx, ty, tz); },
      bounds: () => { const b = new THREE.Box3().setFromObject(view.root); return [b.min.toArray(), b.max.toArray()]; },
    };
  }, [scene, view, camera]);
  useFrame((_, dt) => view.lookdevUpdate(dt));
  return null;
}

export function Lookdev() {
  const [ready, setReady] = useState(false);
  useEffect(() => { loadAssets().then(() => setReady(true)); }, []);
  if (!ready) return <div style={{ color: "#fff", padding: 20 }}>loading…</div>;
  return (
    <div style={{ position: "fixed", inset: 0 }}>
      <Canvas camera={{ position: [2.5, 1.6, 3], fov: 40 }} gl={{ preserveDrawingBuffer: true }}>
        <Scene />
        <OrbitControls target={[0, 1, 0]} />
      </Canvas>
    </div>
  );
}
