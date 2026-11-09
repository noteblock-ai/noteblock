// Triplanar detail texturing: real stone/roof/wood/ground photo textures (Poly Haven, CC0) projected in
// world space over the kit pieces, multiplied into their palette colour, plus triplanar normal maps.
import * as THREE from "three";
import { BASE } from "../assets";

export type Detail = "stone" | "blocks" | "roof" | "cobble" | "grass" | "rock" | "wood" | "none";

const FILES: Record<Exclude<Detail, "none">, string> = {
  stone: "stone_wall",
  blocks: "sandstone_blocks_08",
  roof: "clay_roof_tiles",
  cobble: "cobblestone_floor_08",
  grass: "forrest_ground_01",
  rock: "cliff_side",
  wood: "brown_planks_05",
};

/** metres per texture repeat */
const SCALE: Record<Exclude<Detail, "none">, number> = { stone: 2.6, blocks: 2.2, roof: 1.6, cobble: 2.4, grass: 4.5, rock: 7, wood: 1.6 };

interface TexSet { diff: THREE.Texture; nor: THREE.Texture; mean: THREE.Color }
const sets = new Map<string, TexSet>();

export async function loadDetailTextures() {
  const loader = new THREE.TextureLoader();
  await Promise.all(
    Object.entries(FILES).map(async ([k, f]) => {
      const [diff, nor] = await Promise.all([loader.loadAsync(`${BASE}tex/${f}_diff.webp`), loader.loadAsync(`${BASE}tex/${f}_nor.webp`)]);
      for (const t of [diff, nor]) { t.wrapS = t.wrapT = THREE.RepeatWrapping; t.anisotropy = 4; }
      diff.colorSpace = THREE.SRGBColorSpace;
      sets.set(k, { diff, nor, mean: meanColor(diff.image as HTMLImageElement) });
    }),
  );
}

function meanColor(img: HTMLImageElement | ImageBitmap): THREE.Color {
  const c = document.createElement("canvas");
  c.width = c.height = 16;
  const g = c.getContext("2d")!;
  g.drawImage(img as CanvasImageSource, 0, 0, 16, 16);
  const d = g.getImageData(0, 0, 16, 16).data;
  let r = 0, gg = 0, b = 0;
  for (let i = 0; i < d.length; i += 4) { r += d[i]; gg += d[i + 1]; b += d[i + 2]; }
  const n = d.length / 4;
  // into linear, like the sampler returns
  return new THREE.Color().setRGB(r / n / 255, gg / n / 255, b / n / 255, THREE.SRGBColorSpace);
}

const TRI_VERT_PARS = /* glsl */ `
varying vec3 vTriPos;
varying vec3 vTriNrm;
`;
const TRI_VERT = /* glsl */ `
vTriPos = (modelMatrix * vec4(transformed, 1.0)).xyz;
vTriNrm = normalize(mat3(modelMatrix) * objectNormal);
`;

const TRI_FRAG_PARS = /* glsl */ `
varying vec3 vTriPos;
varying vec3 vTriNrm;
uniform sampler2D tDetA; uniform sampler2D tNorA; uniform vec3 uMeanA; uniform float uScaleA;
uniform float uStrength; uniform float uNormal;
#ifdef TRI_TWO
uniform sampler2D tDetB; uniform sampler2D tNorB; uniform vec3 uMeanB; uniform float uScaleB;
varying float vSurf;
#endif
vec3 triW(vec3 n) { vec3 w = pow(abs(n), vec3(6.0)); return w / (w.x + w.y + w.z); }
vec3 triSample(sampler2D t, vec3 p, vec3 w, float s) {
  return texture2D(t, p.zy / s).rgb * w.x + texture2D(t, p.xz / s).rgb * w.y + texture2D(t, p.xy / s).rgb * w.z;
}
vec3 triNormal(sampler2D t, vec3 p, vec3 n, vec3 w, float s, float k) {
  vec3 tx = texture2D(t, p.zy / s).xyz * 2.0 - 1.0;
  vec3 ty = texture2D(t, p.xz / s).xyz * 2.0 - 1.0;
  vec3 tz = texture2D(t, p.xy / s).xyz * 2.0 - 1.0;
  tx.xy *= k; ty.xy *= k; tz.xy *= k;
  // whiteout blend
  tx = vec3(tx.xy + n.zy, abs(tx.z) * n.x);
  ty = vec3(ty.xy + n.xz, abs(ty.z) * n.y);
  tz = vec3(tz.xy + n.xy, abs(tz.z) * n.z);
  return normalize(tx.zyx * w.x + ty.xzy * w.y + tz.xyz * w.z);
}
`;

const TRI_COLOR = /* glsl */ `
{
  vec3 tw = triW(vTriNrm);
  vec3 det = triSample(tDetA, vTriPos, tw, uScaleA) / max(uMeanA, vec3(0.02));
  #ifdef TRI_TWO
  vec3 detB = triSample(tDetB, vTriPos, tw, uScaleB) / max(uMeanB, vec3(0.02));
  det = mix(det, detB, vSurf);
  #endif
  diffuseColor.rgb *= mix(vec3(1.0), det, uStrength);
}
`;

const TRI_NORMAL = /* glsl */ `
{
  vec3 tw = triW(vTriNrm);
  vec3 nW = triNormal(tNorA, vTriPos, vTriNrm, tw, uScaleA, uNormal);
  #ifdef TRI_TWO
  vec3 nB = triNormal(tNorB, vTriPos, vTriNrm, tw, uScaleB, uNormal);
  nW = normalize(mix(nW, nB, vSurf));
  #endif
  normal = normalize((viewMatrix * vec4(nW, 0.0)).xyz);
  #ifdef DOUBLE_SIDED
  normal *= faceDirection;
  #endif
}
`;

const cache = new Map<string, THREE.Material>();

/** A copy of `base` with triplanar detail `d` (cached per base+detail). */
export function withDetail(base: THREE.Material, d: Detail, opts: { strength?: number; normal?: number } = {}): THREE.Material {
  if (d === "none" || !(base as THREE.MeshStandardMaterial).isMeshStandardMaterial) return base;
  const key = `${base.uuid}:${d}:${opts.strength ?? ""}:${opts.normal ?? ""}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const set = sets.get(d);
  if (!set) return base;
  const m = (base as THREE.MeshStandardMaterial).clone();
  m.roughness = Math.max(m.roughness, 0.8);
  m.metalness = 0;
  const strength = opts.strength ?? 0.9;
  const nk = opts.normal ?? 1.0;
  m.onBeforeCompile = (sh) => {
    sh.uniforms.tDetA = { value: set.diff };
    sh.uniforms.tNorA = { value: set.nor };
    sh.uniforms.uMeanA = { value: new THREE.Vector3(set.mean.r, set.mean.g, set.mean.b) };
    sh.uniforms.uScaleA = { value: SCALE[d as Exclude<Detail, "none">] };
    sh.uniforms.uStrength = { value: strength };
    sh.uniforms.uNormal = { value: nk };
    sh.vertexShader = sh.vertexShader.replace("#include <common>", "#include <common>\n" + TRI_VERT_PARS).replace("#include <worldpos_vertex>", "#include <worldpos_vertex>\n" + TRI_VERT);
    sh.fragmentShader = sh.fragmentShader
      .replace("#include <common>", "#include <common>\n" + TRI_FRAG_PARS)
      .replace("#include <map_fragment>", "#include <map_fragment>\n" + TRI_COLOR)
      .replace("#include <normal_fragment_maps>", "#include <normal_fragment_maps>\n" + TRI_NORMAL);
  };
  m.customProgramCacheKey = () => `tri-${d}`;
  cache.set(key, m);
  return m;
}

/** Ground: vertex-coloured, blending grass (vSurf=0) and cobble (vSurf=1). */
export function groundMaterial(): THREE.MeshStandardMaterial {
  const m = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.95, metalness: 0, side: THREE.DoubleSide });
  const A = sets.get("grass"), B = sets.get("cobble");
  if (!A || !B) return m;
  m.onBeforeCompile = (sh) => {
    sh.defines = { ...(sh.defines ?? {}), TRI_TWO: "" };
    Object.assign(sh.uniforms, {
      tDetA: { value: A.diff }, tNorA: { value: A.nor }, uMeanA: { value: new THREE.Vector3(A.mean.r, A.mean.g, A.mean.b) }, uScaleA: { value: SCALE.grass },
      tDetB: { value: B.diff }, tNorB: { value: B.nor }, uMeanB: { value: new THREE.Vector3(B.mean.r, B.mean.g, B.mean.b) }, uScaleB: { value: SCALE.cobble },
      uStrength: { value: 1.0 }, uNormal: { value: 0.9 },
    });
    sh.vertexShader = sh.vertexShader
      .replace("#include <common>", "#include <common>\n" + TRI_VERT_PARS + "attribute float surf;\nvarying float vSurf;")
      .replace("#include <worldpos_vertex>", "#include <worldpos_vertex>\n" + TRI_VERT + "vSurf = surf;");
    sh.fragmentShader = sh.fragmentShader
      .replace("#include <common>", "#include <common>\n" + TRI_FRAG_PARS)
      .replace("#include <map_fragment>", "#include <map_fragment>\n" + TRI_COLOR)
      .replace("#include <normal_fragment_maps>", "#include <normal_fragment_maps>\n" + TRI_NORMAL);
  };
  m.customProgramCacheKey = () => "tri-ground";
  return m;
}
