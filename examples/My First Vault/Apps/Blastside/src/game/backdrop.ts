// Backdrop: distant floating islands, a sea of clouds under the fort, haze bands at the horizon.
import * as THREE from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import { assets } from "../assets";
import { rockUnderside } from "./map-visual";

function cloudTexture() {
  const t = assets!.vfx.clone();
  t.needsUpdate = true;
  t.repeat.set(0.25, 0.5);
  t.offset.set(0, 0); // smoke cell (index 4: col 0, row 1)
  return t;
}

function skyDome(sunDir: THREE.Vector3) {
  return new THREE.Mesh(
    new THREE.SphereGeometry(1600, 48, 24),
    new THREE.ShaderMaterial({
      side: THREE.BackSide, depthWrite: false, fog: false, toneMapped: true,
      uniforms: {
        uSun: { value: sunDir.clone().normalize() },
        uZenith: { value: new THREE.Color("#2c3a78") },
        uHigh: { value: new THREE.Color("#7c6aa8") },
        uHorizon: { value: new THREE.Color("#f2a98a") },
        uSunHorizon: { value: new THREE.Color("#ffb066") },
        uBelow: { value: new THREE.Color("#c98aa0") },
      },
      vertexShader: "varying vec3 vDir; void main(){ vDir = normalize(position); vec4 p = projectionMatrix*modelViewMatrix*vec4(position,1.0); gl_Position = p.xyww; }",
      fragmentShader: `
        uniform vec3 uSun, uZenith, uHigh, uHorizon, uSunHorizon, uBelow; varying vec3 vDir;
        void main(){
          vec3 d = normalize(vDir);
          float h = d.y;
          float sunAmt = max(dot(d, uSun), 0.0);
          vec3 hor = mix(uHorizon, uSunHorizon, pow(sunAmt, 3.0));
          vec3 col = h > 0.0 ? mix(hor, mix(uHigh, uZenith, smoothstep(0.25, 0.9, h)), smoothstep(0.0, 0.45, h)) : mix(hor, uBelow, smoothstep(0.0, -0.25, h));
          // sun disc and glow (bright enough for bloom)
          col += vec3(1.0, 0.62, 0.32) * pow(sunAmt, 64.0) * 1.6;
          col += vec3(1.0, 0.8, 0.55) * smoothstep(0.9992, 0.9996, sunAmt) * 6.0;
          col += vec3(1.0, 0.55, 0.3) * pow(sunAmt, 8.0) * 0.35;
          gl_FragColor = vec4(col, 1.0);
          #include <colorspace_fragment>
        }`,
    }),
  );
}

export function buildBackdrop(sunDir: THREE.Vector3): THREE.Group {
  const g = new THREE.Group();
  g.name = "backdrop";
  const sky = skyDome(sunDir);
  sky.renderOrder = -10;
  sky.frustumCulled = false;
  g.add(sky);
  // Distant islands
  const geos: THREE.BufferGeometry[] = [];
  const tops: THREE.BufferGeometry[] = [];
  const islands: [number, number, number, number][] = [
    // angle deg, distance, radius, y
    [200, 150, 16, -8], [235, 210, 26, 6], [300, 170, 12, -20], [140, 190, 20, 12], [95, 240, 30, -4], [20, 200, 18, -14], [330, 260, 34, 10], [170, 320, 40, -30], [60, 330, 26, 22],
  ];
  islands.forEach(([deg, dist, r, y], i) => {
    const a = (deg * Math.PI) / 180;
    const x = Math.cos(a) * dist, z = Math.sin(a) * dist;
    const rock = rockUnderside(0, 0, r, r * 0.9, 101 + i * 13);
    rock.translate(x, y, z);
    geos.push(rock);
    const top = new THREE.CylinderGeometry(r * 1.01, r * 1.0, 0.6, 32, 1).toNonIndexed();
    top.translate(x, y - 0.25, z);
    const col = new Float32Array(top.getAttribute("position").count * 3);
    const c = new THREE.Color("#7f9e52");
    for (let k = 0; k < col.length; k += 3) col.set([c.r, c.g, c.b], k);
    top.setAttribute("color", new THREE.BufferAttribute(col, 3));
    tops.push(top);
    // a few cone trees on top
    const n = Math.round(r / 4);
    for (let t = 0; t < n; t++) {
      const ta = t * 2.4 + i;
      const tr = (t / n) * r * 0.7;
      const tree = new THREE.ConeGeometry(1.6 + (t % 3) * 0.6, 6 + (t % 4) * 1.5, 7).toNonIndexed();
      tree.translate(x + Math.cos(ta) * tr, y + 3, z + Math.sin(ta) * tr);
      const tc = new Float32Array(tree.getAttribute("position").count * 3);
      const cc = new THREE.Color(t % 2 ? "#4f7a3c" : "#5f8a44");
      for (let k = 0; k < tc.length; k += 3) tc.set([cc.r, cc.g, cc.b], k);
      tree.setAttribute("color", new THREE.BufferAttribute(tc, 3));
      tops.push(tree);
    }
  });
  const mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 1, flatShading: true, fog: true });
  const isl = new THREE.Mesh(mergeGeometries([...geos, ...tops.map((t) => { t.deleteAttribute("uv"); t.deleteAttribute("normal"); t.computeVertexNormals(); return t; })].map((x) => { if (x.getAttribute("uv")) x.deleteAttribute("uv"); return x; }))!, mat);
  g.add(isl);

  // Cloud sea: big soft sprites below and around
  const tex = cloudTexture();
  const layers: [number, number, number, string, number][] = [
    // count, y, size, colour, opacity
    [70, -26, 70, "#f6c6ae", 0.8],
    [50, -42, 120, "#d79aa8", 0.9],
    [22, -12, 40, "#ffe3cc", 0.45],
    [30, 70, 160, "#ffd2b4", 0.35],
  ];
  let seed = 7;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  for (const [count, y, size, color, opacity] of layers) {
    const m = new THREE.SpriteMaterial({ map: tex, color, transparent: true, opacity, depthWrite: false, fog: false });
    for (let i = 0; i < count; i++) {
      const a = rnd() * Math.PI * 2;
      const r = 20 + Math.pow(rnd(), 0.7) * 320;
      const s = new THREE.Sprite(m);
      s.position.set(Math.cos(a) * r, y + (rnd() - 0.5) * 8, Math.sin(a) * r);
      s.scale.setScalar(size * (0.7 + rnd() * 0.7));
      s.renderOrder = -1;
      g.add(s);
    }
  }
  // Far haze ring at the horizon (warm band), softens where sky meets clouds
  const ring = new THREE.Mesh(
    new THREE.CylinderGeometry(900, 900, 220, 64, 1, true),
    new THREE.ShaderMaterial({
      transparent: true, depthWrite: false, side: THREE.BackSide, fog: false,
      uniforms: { c1: { value: new THREE.Color("#ffb98e") }, c2: { value: new THREE.Color("#e7a0a6") } },
      vertexShader: "varying float vy; void main(){ vy = position.y; gl_Position = projectionMatrix*modelViewMatrix*vec4(position,1.0); }",
      fragmentShader: "uniform vec3 c1; uniform vec3 c2; varying float vy; void main(){ float t = clamp((vy+110.0)/220.0,0.0,1.0); float a = smoothstep(1.0,0.35,t)*0.85; gl_FragColor = vec4(mix(c2,c1,t), a); }",
    }),
  );
  ring.position.y = -60;
  g.add(ring);
  return g;
}
