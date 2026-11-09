import { useFrame, useThree } from "@react-three/fiber";
import { EffectComposer, Bloom, N8AO, SMAA, ToneMapping, Vignette } from "@react-three/postprocessing";
import { ToneMappingMode } from "postprocessing";
import { useEffect, useMemo, useRef } from "react";
import * as THREE from "three";
import { assets } from "../assets";
import { GameClient } from "./client";
import { useUI } from "./store";
import type { Conn } from "../net/connection";
import { buildBackdrop } from "./backdrop";

// Sunset: low sun in the west-south-west.
export const SUN_DIR = new THREE.Vector3(-0.8, 0.16, 0.45).normalize();

declare global { interface Window { __bs?: GameClient } }

function World({ conn, overlay }: { conn: Conn; overlay: HTMLElement }) {
  const { scene, camera, gl } = useThree();
  const client = useMemo(() => new GameClient(conn, scene, camera as THREE.PerspectiveCamera, gl.domElement, overlay), [conn]);
  const sun = useRef<THREE.DirectionalLight>(null!);
  useEffect(() => {
    window.__bs = client;
    scene.environment = assets!.hdr;
    scene.environmentIntensity = 0.55;
    scene.fog = new THREE.FogExp2("#efae94", 0.0024);
    scene.background = new THREE.Color("#efae94");
    const back = buildBackdrop(SUN_DIR);
    scene.add(back);
    return () => { client.dispose(); scene.remove(back); window.__bs = undefined; };
  }, [client, scene]);
  useEffect(() => {
    const l = sun.current;
    l.target.position.set(0, 0, 0);
    scene.add(l.target);
  }, [scene]);
  useFrame((_, dt) => {
    client.update(dt);
    // keep the shadow camera on the arena
    const l = sun.current;
    l.position.copy(SUN_DIR).multiplyScalar(60);
  });
  return (
    <>
      <directionalLight
        ref={sun}
        color="#ffc896"
        intensity={2.8}
        castShadow
        shadow-mapSize={[2048, 2048]}
        shadow-bias={-0.0004}
        shadow-normalBias={0.04}
        shadow-camera-left={-34}
        shadow-camera-right={34}
        shadow-camera-top={34}
        shadow-camera-bottom={-34}
        shadow-camera-near={1}
        shadow-camera-far={140}
      />
      <hemisphereLight args={["#ffd7b8", "#5b4a6e", 0.35]} />
    </>
  );
}

export function Effects({ quality }: { quality: "high" | "low" }) {
  return (
    <EffectComposer multisampling={0} enableNormalPass={false}>
      {quality === "high" ? <N8AO halfRes aoRadius={1.6} intensity={2.2} distanceFalloff={1.2} quality="performance" /> : <></>}
      <Bloom mipmapBlur luminanceThreshold={0.9} luminanceSmoothing={0.2} intensity={0.7} />
      <ToneMapping mode={ToneMappingMode.ACES_FILMIC} />
      <Vignette eskil={false} offset={0.25} darkness={0.45} />
      <SMAA />
    </EffectComposer>
  );
}

export function GameScene({ conn, overlay }: { conn: Conn; overlay: HTMLElement }) {
  const quality = useUI((s) => (s.settings.quality === "low" ? "low" : "high"));
  return (
    <>
      <World conn={conn} overlay={overlay} />
      <Effects quality={quality} />
    </>
  );
}
