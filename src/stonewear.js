import * as THREE from 'three';

// Ideas adapted from 3dcodeverse scene_threejs (Apache-2.0):
// surface_wear (world-space breakup + convex edge polish) and aging/damp
// (vertical silt streaks, dust on upward faces). Original shader. No new
// lights, no brick grid, no change to the limestone maps.

const VERT = `
varying vec3 vWearP;
varying vec3 vWearN;
`;

const FRAG_HEAD = `
uniform vec4 uWear;
uniform float uWearSeed;
varying vec3 vWearP;
varying vec3 vWearN;
float wrH(vec2 p){
  return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
}
float wrV(vec2 p){
  vec2 i = floor(p);
  vec2 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  float a = wrH(i);
  float b = wrH(i + vec2(1.0, 0.0));
  float c = wrH(i + vec2(0.0, 1.0));
  float d = wrH(i + vec2(1.0, 1.0));
  return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
}
float wrTri(vec3 p, vec3 n){
  vec3 w = abs(n);
  w /= (w.x + w.y + w.z + 1e-4);
  return wrV(p.yz) * w.x + wrV(p.xz) * w.y + wrV(p.xy) * w.z;
}
`;

// uWear = (micro, edge, drip, dust). Declared in main() so the roughness
// chunk, which Three inserts later, can still see them.
const COLOR = `
  vec3 wn = normalize(vWearN);
  vec3 wp = vWearP + vec3(uWearSeed * 3.1, uWearSeed * 1.7, uWearSeed * 2.3);
  float lo = wrTri(wp * 1.65, wn);
  float hi = wrTri(wp * 6.2 + 4.1, wn);
  float fw = length(fwidth(wp));
  lo = mix(0.5, lo, 1.0 - smoothstep(0.45, 1.3, fw));
  hi = mix(0.5, hi, 1.0 - smoothstep(0.22, 0.75, fw * 2.1));
  float mb = clamp((lo - 0.5) * 1.7 + (hi - 0.5) * 1.05, -1.0, 1.0);
  float warm = clamp((lo - hi) * 1.6, -1.0, 1.0) * 0.07;
  diffuseColor.rgb *= vec3(1.0 + warm, 1.0 + warm * 0.18, 1.0 - warm);
  float luma = dot(diffuseColor.rgb, vec3(0.2126, 0.7152, 0.0722));
  diffuseColor.rgb = mix(diffuseColor.rgb, vec3(luma), max(-mb, 0.0) * uWear.x * 0.45);
  diffuseColor.rgb *= 1.0 + mb * uWear.x;

  vec3 dxp = dFdx(vWearP);
  vec3 dyp = dFdy(vWearP);
  float denom = max(dot(dxp, dxp) + dot(dyp, dyp), 1e-5);
  float curv = (dot(dFdx(wn), dxp) + dot(dFdy(wn), dyp)) / denom;
  float edge = smoothstep(1.4, 5.0, curv);
  edge *= smoothstep(0.34, 0.72, wrTri(vWearP * 8.5 + 2.0, wn));
  vec3 thin = mix(diffuseColor.rgb, vec3(luma), 0.4) * 1.1;
  diffuseColor.rgb = mix(diffuseColor.rgb, thin, clamp(edge * uWear.y, 0.0, 0.5));

  float wall = smoothstep(0.4, 0.88, 1.0 - abs(wn.y));
  float lane = wrH(floor(vWearP.xz * vec2(1.28, 0.52)) + uWearSeed);
  float band = smoothstep(0.8, 0.94, lane);
  float wob = (wrV(vec2(vWearP.x * 0.65, vWearP.y * 0.32)) - 0.5) * 0.4;
  float spine = abs(fract(dot(vWearP.xz, vec2(0.37, 0.15)) + wob) - 0.5);
  float thread = 1.0 - smoothstep(0.012, 0.04, spine);
  float gap = step(0.38, wrV(vec2(vWearP.y * 1.7, lane * 8.0)));
  float foot = smoothstep(3.1, 0.15, vWearP.y);
  float drip = wall * band * thread * gap * foot * uWear.z;
  diffuseColor.rgb = mix(diffuseColor.rgb, diffuseColor.rgb * vec3(0.52, 0.46, 0.38), clamp(drip, 0.0, 0.72));

  float upw = smoothstep(0.6, 0.94, wn.y);
  float film = smoothstep(0.42, 0.86, wrTri(vWearP * 2.15, wn));
  float dust = upw * film * uWear.w;
  vec3 settled = mix(diffuseColor.rgb, vec3(0.50, 0.45, 0.36), 0.4);
  diffuseColor.rgb = mix(diffuseColor.rgb, settled, clamp(dust, 0.0, 0.38));
`;

const ROUGH = `
  roughnessFactor = clamp(roughnessFactor * (1.0 - mb * uWear.x * 0.4), 0.04, 1.0);
  roughnessFactor = mix(roughnessFactor, max(0.08, roughnessFactor * 0.64), clamp(edge * uWear.y, 0.0, 1.0));
  roughnessFactor = min(1.0, roughnessFactor + dust * 0.07);
`;

export function wearMasonry(mat, opts = {}) {
  const micro = opts.micro ?? 0.08;
  const edge = opts.edge ?? 0.26;
  const drip = opts.drip ?? 0.5;
  const dust = opts.dust ?? 0.16;
  const seed = opts.seed ?? 1;
  const prev = mat.onBeforeCompile;
  // A constant key. Calling the previous one as a bare function drops `this`,
  // and Three's own key reads `this.onBeforeCompile`.
  mat.customProgramCacheKey = () => 'masonry-wear';
  mat.onBeforeCompile = (shader) => {
    if (prev) prev(shader);
    shader.uniforms.uWear = { value: new THREE.Vector4(micro, edge, drip, dust) };
    shader.uniforms.uWearSeed = { value: seed };
    shader.vertexShader = VERT + shader.vertexShader.replace(
      '#include <begin_vertex>',
      `#include <begin_vertex>
       vWearP = (modelMatrix * vec4(transformed, 1.0)).xyz;
       vWearN = normalize(mat3(modelMatrix) * objectNormal);`
    );
    shader.fragmentShader = FRAG_HEAD + shader.fragmentShader
      .replace('#include <color_fragment>', `#include <color_fragment>\n${COLOR}`)
      .replace('#include <roughnessmap_fragment>', `#include <roughnessmap_fragment>\n${ROUGH}`);
  };
  return mat;
}
