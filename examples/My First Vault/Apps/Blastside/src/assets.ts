import * as THREE from "three";
import { GLTFLoader, type GLTF } from "three/examples/jsm/loaders/GLTFLoader.js";
import { MeshoptDecoder } from "three/examples/jsm/libs/meshopt_decoder.module.js";
import { HDRLoader } from "three/examples/jsm/loaders/HDRLoader.js";

// Hosted site: same origin. Noteblock page (quire://…): heavy assets come from the hosted site (CORS, long cache).
export const BASE: string = (import.meta.env.VITE_ASSET_BASE as string | undefined) || `${import.meta.env.BASE_URL}g/`;

let fontsLoaded = false;
/** Barlow Condensed from the asset base. Network: only call this after the player clicks Play. */
export function loadFonts() {
  if (fontsLoaded) return;
  fontsLoaded = true;
  for (const w of [500, 600, 700]) {
    const f = new FontFace("Barlow Condensed", `url(${BASE}fonts/barlow-condensed-${w}.woff2) format("woff2")`, { weight: String(w), display: "swap" });
    f.load().then((ff) => document.fonts.add(ff)).catch(() => {});
  }
}

const loader = new GLTFLoader();
loader.setMeshoptDecoder(MeshoptDecoder);

export interface Assets {
  character: GLTF;
  weapons: GLTF;
  kit: GLTF;
  foliage: GLTF;
  hdr: THREE.DataTexture;
  vfx: THREE.Texture;
  /** retargeted Universal Animation Library clips (Dance, Sit, Roll, FoldArms) */
  extraClips: THREE.AnimationClip[];
}

let promise: Promise<Assets> | null = null;
export let assets: Assets | null = null;
export const progress = { loaded: 0, total: 6 };

function track<T>(p: Promise<T>): Promise<T> {
  return p.then((v) => { progress.loaded++; return v; });
}

export function loadAssets(): Promise<Assets> {
  if (promise) return promise;
  promise = (async () => {
    const extraP = fetch(BASE + "emotes.json").then((r) => r.json()).then((j) => (j.clips as any[]).map((c) => THREE.AnimationClip.parse(c))).catch(() => [] as THREE.AnimationClip[]);
    const [character, weapons, kit, foliage, hdr, vfx] = await Promise.all([
      track(loader.loadAsync(BASE + "character.glb")),
      track(loader.loadAsync(BASE + "weapons.glb")),
      track(loader.loadAsync(BASE + "kit.glb")),
      track(loader.loadAsync(BASE + "foliage.glb")),
      track(new HDRLoader().loadAsync(BASE + "kiara_1_dawn_1k.hdr")),
      track(new THREE.TextureLoader().loadAsync(BASE + "vfx.webp")),
    ]);
    await (await import("./game/materials")).loadDetailTextures();
    hdr.mapping = THREE.EquirectangularReflectionMapping;
    vfx.colorSpace = THREE.SRGBColorSpace;
    assets = { character, weapons, kit, foliage, hdr, vfx, extraClips: await extraP };
    (window as any).__assets = assets;
    // MegaKit stores wind masks in COLOR_0; we don't use them as colour (and merged maps drop the attribute).
    foliage.scene.traverse((o) => {
      const m = (o as THREE.Mesh).material as THREE.MeshStandardMaterial | undefined;
      if (m && (o as THREE.Mesh).isMesh) { m.vertexColors = false; m.side = THREE.DoubleSide; if (m.alphaTest > 0) m.alphaTest = 0.45; }
    });
    return assets;
  })();
  return promise;
}

/** Find a kit piece by name ("castle/wall"). */
export function kitPiece(name: string): THREE.Object3D {
  const key = THREE.PropertyBinding.sanitizeNodeName(name);
  const o = (name.startsWith("fol/") ? assets!.foliage : assets!.kit).scene.getObjectByName(key);
  if (!o) throw new Error("missing kit piece " + name);
  return o;
}
