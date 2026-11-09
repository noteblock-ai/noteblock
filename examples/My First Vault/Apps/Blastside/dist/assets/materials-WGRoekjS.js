import{r as e}from"./rolldown-runtime-BWaJ3C7D.js";import{Ba as t,Qi as n,Sr as r,Z as i,do as a,oa as o,t as s}from"./index-uPx1ernY.js";var c=e({groundMaterial:()=>x,loadDetailTextures:()=>f,withDetail:()=>b}),l={stone:`stone_wall`,blocks:`sandstone_blocks_08`,roof:`clay_roof_tiles`,cobble:`cobblestone_floor_08`,grass:`forrest_ground_01`,rock:`cliff_side`,wood:`brown_planks_05`},u={stone:2.6,blocks:2.2,roof:1.6,cobble:2.4,grass:4.5,rock:7,wood:1.6},d=new Map;async function f(){let e=new t;await Promise.all(Object.entries(l).map(async([t,r])=>{let[i,a]=await Promise.all([e.loadAsync(`${s}tex/${r}_diff.webp`),e.loadAsync(`${s}tex/${r}_nor.webp`)]);for(let e of[i,a])e.wrapS=e.wrapT=n,e.anisotropy=4;i.colorSpace=o,d.set(t,{diff:i,nor:a,mean:p(i.image)})}))}function p(e){let t=document.createElement(`canvas`);t.width=t.height=16;let n=t.getContext(`2d`);n.drawImage(e,0,0,16,16);let r=n.getImageData(0,0,16,16).data,a=0,s=0,c=0;for(let e=0;e<r.length;e+=4)a+=r[e],s+=r[e+1],c+=r[e+2];let l=r.length/4;return new i().setRGB(a/l/255,s/l/255,c/l/255,o)}var m=`
varying vec3 vTriPos;
varying vec3 vTriNrm;
`,h=`
vTriPos = (modelMatrix * vec4(transformed, 1.0)).xyz;
vTriNrm = normalize(mat3(modelMatrix) * objectNormal);
`,g=`
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
`,_=`
{
  vec3 tw = triW(vTriNrm);
  vec3 det = triSample(tDetA, vTriPos, tw, uScaleA) / max(uMeanA, vec3(0.02));
  #ifdef TRI_TWO
  vec3 detB = triSample(tDetB, vTriPos, tw, uScaleB) / max(uMeanB, vec3(0.02));
  det = mix(det, detB, vSurf);
  #endif
  diffuseColor.rgb *= mix(vec3(1.0), det, uStrength);
}
`,v=`
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
`,y=new Map;function b(e,t,n={}){if(t===`none`||!e.isMeshStandardMaterial)return e;let r=`${e.uuid}:${t}:${n.strength??``}:${n.normal??``}`,i=y.get(r);if(i)return i;let o=d.get(t);if(!o)return e;let s=e.clone();s.roughness=Math.max(s.roughness,.8),s.metalness=0;let c=n.strength??.9,l=n.normal??1;return s.onBeforeCompile=e=>{e.uniforms.tDetA={value:o.diff},e.uniforms.tNorA={value:o.nor},e.uniforms.uMeanA={value:new a(o.mean.r,o.mean.g,o.mean.b)},e.uniforms.uScaleA={value:u[t]},e.uniforms.uStrength={value:c},e.uniforms.uNormal={value:l},e.vertexShader=e.vertexShader.replace(`#include <common>`,`#include <common>
`+m).replace(`#include <worldpos_vertex>`,`#include <worldpos_vertex>
`+h),e.fragmentShader=e.fragmentShader.replace(`#include <common>`,`#include <common>
`+g).replace(`#include <map_fragment>`,`#include <map_fragment>
`+_).replace(`#include <normal_fragment_maps>`,`#include <normal_fragment_maps>
`+v)},s.customProgramCacheKey=()=>`tri-${t}`,y.set(r,s),s}function x(){let e=new r({vertexColors:!0,roughness:.95,metalness:0,side:2}),t=d.get(`grass`),n=d.get(`cobble`);return!t||!n||(e.onBeforeCompile=e=>{e.defines={...e.defines??{},TRI_TWO:``},Object.assign(e.uniforms,{tDetA:{value:t.diff},tNorA:{value:t.nor},uMeanA:{value:new a(t.mean.r,t.mean.g,t.mean.b)},uScaleA:{value:u.grass},tDetB:{value:n.diff},tNorB:{value:n.nor},uMeanB:{value:new a(n.mean.r,n.mean.g,n.mean.b)},uScaleB:{value:u.cobble},uStrength:{value:1},uNormal:{value:.9}}),e.vertexShader=e.vertexShader.replace(`#include <common>`,`#include <common>
`+m+`attribute float surf;
varying float vSurf;`).replace(`#include <worldpos_vertex>`,`#include <worldpos_vertex>
`+h+`vSurf = surf;`),e.fragmentShader=e.fragmentShader.replace(`#include <common>`,`#include <common>
`+g).replace(`#include <map_fragment>`,`#include <map_fragment>
`+_).replace(`#include <normal_fragment_maps>`,`#include <normal_fragment_maps>
`+v)},e.customProgramCacheKey=()=>`tri-ground`),e}export{c as n,b as r,x as t};