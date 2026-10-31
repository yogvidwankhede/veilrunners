import * as THREE from 'three';
import { FBXLoader } from 'three/examples/jsm/loaders/FBXLoader.js';
import { clone as cloneSkinned } from 'three/examples/jsm/utils/SkeletonUtils.js';
import { MAP, S, PHYS } from './constants.js';
import { climbTargets, solidBoxes, surfaceVisible } from './climbable.js';

// ---------------------------------------------------------------------------
// Real rigged character: Mixamo auto-rig + mocap clips.
//
// Mixamo exports no glTF, only FBX, so this is FBXLoader rather than GLTFLoader.
// The base file carries the skinned mesh (With Skin); every other clip is exported
// Without Skin at ~150 KB and binds onto the same skeleton by bone name.
//
// Clip natural speeds are MEASURED, not assumed — see `tools/clipspeed.html`. An
// in-place clip has no root motion, so its intended travel speed is recovered from
// the feet: during stance a foot slides backward exactly as fast as the character
// would move forward, and one Mixamo locomotion clip is a full two-step cycle.
// ---------------------------------------------------------------------------

export const CLIP_MPS = { walk: 1.97, run: 3.71, crouchWalk: 1.12 };   // measured; see tools/clipspeed.html
// Playback rate bounds. Outside these a clip either crawls or turns into a sewing
// machine, so past them we accept foot slip instead.
const MIN_RATE = 0.6, MAX_RATE = 1.9;
// Speeds either side of the walk/run crossover, in m/s.
const WALK_TOP = 2.5, RUN_BOTTOM = 3.0;

// Mixamo ships MeshPhongMaterial, which ignores the scene's IBL and tonemapping.
function muteCatchlights(tex) {
  const run = () => {
    const img = tex && tex.image;
    if (!img || !img.width || tex.userData._eyesMuted) return;
    const c = document.createElement('canvas');
    c.width = img.width; c.height = img.height;
    const ctx = c.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(img, 0, 0);
    const id = ctx.getImageData(0, 0, c.width, c.height);
    const d = id.data;
    for (let i = 0; i < d.length; i += 4) {
      const r = d[i], g = d[i + 1], b = d[i + 2];
      // Painted catchlights are the only near-white texels on this cloak.
      if (r > 186 && g > 176 && b > 170 && b + 14 >= r) {
        d[i] = 36; d[i + 1] = 28; d[i + 2] = 22;
      }
    }
    ctx.putImageData(id, 0, 0);
    tex.image = c;
    tex.userData._eyesMuted = true;
    tex.needsUpdate = true;
  };
  if (tex.image && tex.image.width) run();
  else if (tex.image && tex.image.addEventListener)
    tex.image.addEventListener('load', () => { run(); tex.needsUpdate = true; }, { once: true });
}

function toStandard(root) {
  root.traverse(o => {
    if (!o.isMesh || !o.material) return;
    // A character that casts no shadow has no contact with the floor and always
    // reads as hovering. This is one skinned mesh; it is worth the shadow pass.
    // And it RECEIVES. It did not, so the sun reached the runner through twelve
    // metres of tomb: in every dark chamber the floor sat in the walls' shadow
    // while the runner stood in full daylight, a pale figure on black stone.
    o.castShadow = true; o.receiveShadow = true;
    const conv = m => {
      if (!m || m.isMeshStandardMaterial) return m;
      if (m.map) muteCatchlights(m.map);
      const s = new THREE.MeshStandardMaterial({
        map: m.map || null, normalMap: m.normalMap || null,
        color: m.color ? m.color.clone() : new THREE.Color(0xffffff),
        // Cloth stays matte so the hood does not throw a white specular disc.
        // Leather is tightened in the shader from the albedo, not by a glitter map.
        roughness: 0.9, metalness: 0.0, envMapIntensity: 0.08,
      });
      if (s.map) s.map.colorSpace = THREE.SRGBColorSpace;
      s.name = m.name;
      s.onBeforeCompile = (sh) => {
        sh.fragmentShader = sh.fragmentShader
          .replace('#include <normal_fragment_maps>', `#include <normal_fragment_maps>
          {
            float weave = fract(sin(dot(vMapUv * vec2(240.0, 190.0), vec2(12.9898, 78.233))) * 43758.5453);
            normal = normalize(normal + vec3(weave - 0.5, fract(weave * 17.0) - 0.5, 0.0) * 0.22);
          }`)
          .replace('#include <roughnessmap_fragment>', `#include <roughnessmap_fragment>
          {
            float cloth = smoothstep(0.02, 0.16, diffuseColor.b - diffuseColor.r);
            float leather = smoothstep(0.03, 0.18, diffuseColor.r - diffuseColor.b);
            roughnessFactor = mix(roughnessFactor, 0.96, cloth);
            roughnessFactor = mix(roughnessFactor, 0.78, leather * (1.0 - cloth));
          }`);
      };
      return s;
    };
    o.material = Array.isArray(o.material) ? o.material.map(conv) : conv(o.material);
  });
}

const b64ToBuf = b64 => { const raw = atob(b64); const u = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) u[i] = raw.charCodeAt(i); return u.buffer; };

// Load the base character plus a named set of animation-only clips. Each entry is
// either a URL string (served build) or { data: <base64> } (the offline build,
// where there is no server to fetch from).
export async function loadFbxRunner(sources, note) {
  const loader = new FBXLoader();
  const get = src => typeof src === 'string'
    ? loader.loadAsync(src)
    : Promise.resolve(loader.parse(b64ToBuf(src.data), ''));
  const base = await get(sources.base);
  let skin = null;
  base.traverse(o => { if (o.isSkinnedMesh && !skin) skin = o; });
  if (!skin) throw new Error('base FBX has no SkinnedMesh');
  toStandard(base);

  const clips = {};
  if (base.animations[0]) { clips.idle = base.animations[0]; clips.idle.name = 'idle'; }
  const boneNames = new Set(skin.skeleton.bones.map(b => b.name));
  for (const [name, src] of Object.entries(sources)) {
    if (name === 'base') continue;
    try {
      const g = await get(src);
      const c = g.animations[0];
      if (!c) { note && note(`clip ${name}: no animation`); continue; }
      // every track must target a bone this skeleton actually has
      const targets = new Set(c.tracks.map(t => t.name.split('.')[0]));
      const bound = [...targets].filter(n => boneNames.has(n)).length;
      if (!bound) { note && note(`clip ${name}: does not bind to this rig`); continue; }
      c.name = name;
      clips[name] = c;
    } catch (e) { note && note(`clip ${name} failed: ${e.message}`); }
  }
  return { proto: base, skin, clips };
}

// Per-character animation. Returns `anim(phase, gait, crouch, mps, player)` — the
// same shape the procedural rig uses, so main.js does not care which is driving.
// Every action is always playing; only the weights move, which gives free
// crossfades between locomotion and the climbing states.
// ---------------------------------------------------------------------------
// BLEND TIMES, per transition. Time constant in seconds: the weight is about
// two thirds of the way to the new clip after this long, and eases the rest
// of the way. A fixed fraction per frame was frame-rate dependent, and a
// linear ramp arrives at full weight and stops dead, which is the pop.
// Reactions stay short so a flinch is still a flinch.
// ---------------------------------------------------------------------------
const BLEND = {
  idle: 0.10, walk: 0.10, run: 0.10,
  crouchIdle: 0.24, crouchWalk: 0.22,
  falling: 0.16, jump: 0.11, jumpDown: 0.12,
  hangGrab: 0.16, hangIdle: 0.08, hangShimmy: 0.18, hangDrop: 0.14,
  climbUp: 0.18, climbTop: 0.16,
  block: 0.09,
  attack: 0.05, roll: 0.04, hit: 0.035, death: 0.14,
};
const BLEND_DEFAULT = 0.18;
const FALL_DIVE = 0.5;
const HANG_KNEE = 2.27;  // rad at the knee in a braced hang: long legs, toes on the face   // s of falling before the skydive clip takes over

export function makeFbxLocomotion(mixer, clips) {
  const act = {}, w = {};
  // The way down is the jump clip's landing approach, held on its own action
  // so it can cross-fade with the push-off instead of scrubbing through the
  // split leap that lies between them in the clip.
  if (clips.jump && !clips.jumpDown) { clips = { ...clips, jumpDown: clips.jump.clone() }; clips.jumpDown.name += '_down'; }
  for (const k of Object.keys(clips)) {
    act[k] = mixer.clipAction(clips[k]);
    if (k === 'attack' || k === 'roll' || k === 'hit' || k === 'death') {
      act[k].setLoop(THREE.LoopOnce, 1); act[k].clampWhenFinished = true;
    }
    act[k].play();
    w[k] = k === 'idle' ? 1 : 0;
    act[k].setEffectiveWeight(w[k]);
  }
  const rate = (mps, natural) => Math.min(MAX_RATE, Math.max(MIN_RATE, mps / natural));
  const pick = (t, k) => { if (act[k]) t[k] = 1; else t.idle = 1; };   // graceful if a clip is missing

  let smooth = 0, fallT = 0;
  return (phase, gait, crouch, mps = 0, p = null, dt = 1 / 60) => {
    // The blend reads a smoothed speed. Accelerating eases in. A stop
    // follows the body: the old 12/s tail kept the stride playing after
    // the feet had already planted.
    const follow = mps + 0.04 < smooth ? 36 : 12;
    smooth += (mps - smooth) * Math.min(1, dt * follow);
    const v = smooth;
    const state = (p && p.state) || 'ground';
    const t = {};
    for (const k of Object.keys(act)) t[k] = 0;

    // Combat beats everything below it: a swing you cannot see is a swing the
    // other player cannot react to, which is what makes the whole system fair.
    const now = p && p.game ? p.game.t : 0;
    // The catch clip only while the hands are still travelling to the lip.
    // catchT is unset for calibration and for a hang that has already settled,
    // and those must stay on hangIdle — that pose is what the hand offset was
    // measured from.
    if (p && p.deadUntil && act.death)                    pick(t, 'death');
    else if (p && p.hitUntil > now && act.hit)            pick(t, 'hit');
    else if (p && p.rollEnd > now && act.roll)            pick(t, 'roll');
    else if (p && p.atkUntil > now && act.attack)         pick(t, 'attack');
    else if (p && p.blocking && act.block)                pick(t, 'block');
    // hang-shimmy, climb-up and climb-top are LADDER clips: the hands take
    // turns and the feet step on rungs. Every climb in this tomb is a body
    // hauling itself onto a block, so the braced hang is the only clip, and
    // the hands and feet are planted on that block afterwards.
    // The hang-grab clip swings the knees forward through the face as the
    // hands land; the braced hang is the pose a body against stone takes, and
    // the catch slide in main.js already carries the hands up to the lip.
    else if (state === 'hang')   pick(t, 'hangIdle');
    else if (state === 'mantle') {
      // The climb-top clip, locked to the climb's progress below; main.js
      // warps its root motion onto the simulated path. It hands over to idle
      // only once the clip itself has stood up.
      const u = (p && p.mantle) || 0;
      if (act.climbTop) {
        const k = u < 0.9 ? 0 : (u - 0.9) / 0.1;
        t.climbTop = 1 - k; t.idle = k;
      } else {
        const k = u < 0.50 ? 0 : Math.min(1, (u - 0.50) / 0.50);
        const s = k * k * (3 - 2 * k);
        t.hangIdle = 1 - s; t.idle = s;
      }
    }
    else if (state === 'vault')  pick(t, act.jump ? 'jump' : 'falling');   // no vault clip; the jump tuck is the closest
    // rising reads as a jump, falling as a fall — same airborne state, different clip
    // THE AIR. The skydive clip (arms flung wide, knees up, pitched forward)
    // is a long fall and nothing else: an ordinary jump comes down on the
    // jump clip's own upright knee-up, and only a fall that keeps going
    // past half a second spreads into the dive.
    else if (state === 'air') {
      if (p && p.vz > 0) fallT = 0; else fallT += dt;
      pick(t, p && p.vz > 0 && act.jump ? 'jump' : fallT < FALL_DIVE && act.jumpDown ? 'jumpDown' : 'falling');
    }
    else if (crouch && act.crouchIdle) {
      if (v < 0.25 || !act.crouchWalk) t.crouchIdle = 1;
      else { const k = Math.min(1, v / CLIP_MPS.crouchWalk); t.crouchIdle = 1 - k; t.crouchWalk = k; }
    }
    // TURN IN PLACE. There is no turn clip in the Mixamo set, so a stationary
    // pivot would otherwise be a sliding statue. Feeding a little walk in by
    // angular speed makes the legs shuffle through the turn, which is most of
    // what the real clip buys. Capped low: any more and it reads as walking on
    // the spot rather than turning.
    else if (v < 0.15 && Math.abs(p && p.omega || 0) > 0.6 && act.walk) {
      const k = Math.min(0.48, Math.abs(p.omega) / 12);
      t.idle = 1 - k; t.walk = k;
    }
    else if (v < 0.15)           t.idle = 1;
    else if (v < WALK_TOP)   { const k = Math.min(1, (v - 0.15) / (WALK_TOP - 0.15)); t.idle = 1 - k; t.walk = k; }
    else if (v < RUN_BOTTOM) { const k = (v - WALK_TOP) / (RUN_BOTTOM - WALK_TOP); t.walk = 1 - k; t.run = k; }
    else                         t.run = 1;
    if (!act.run && t.run) { t.walk = (t.walk || 0) + t.run; t.run = 0; }

    // LANDING. There is no landing clip either, so the crouch pose stands in:
    // blended over the locomotion in proportion to the impact and decayed by
    // game.js, it reads as knees absorbing a drop instead of the character
    // arriving at the floor already walking.
    const la = (p && p.landAnim) || 0;
    if (la > 0.01 && state === 'ground' && act.crouchIdle) {
      const k = Math.min(0.8, la * 0.8);
      for (const key of Object.keys(t)) t[key] *= (1 - k);
      t.crouchIdle = (t.crouchIdle || 0) + k;
    }

    for (const k of Object.keys(act)) {
      // a one-shot that is being asked for again must rewind, or it sits on its
      // clamped last frame and the second swing never animates
      if ((t[k] || 0) > 0.5 && w[k] < 0.5 && (k==='attack'||k==='roll'||k==='hit')) act[k].reset().play();
      // Per-transition, and in SECONDS rather than per-frame: the old 0.25 of
      // the remainder every frame meant a 120 Hz machine blended twice as fast
      // as a 60 Hz one, so the animation felt different on different hardware.
      const tau = BLEND[k] || BLEND_DEFAULT;
      const rate = 1 - Math.exp(-dt / tau);
      w[k] += ((t[k] || 0) - w[k]) * rate;
      act[k].setEffectiveWeight(w[k]);
    }
    // Playback rate tracks the ground actually covered. MIN_RATE used to
    // keep a stopped clip marching, which is the feet skating through a plant.
    // A turn in place has no velocity, so that shuffle keeps its own rate.
    const turning = v < 0.15 && Math.abs((p && p.omega) || 0) > 0.6;
    const clipRate = (mps, natural) => mps < natural * MIN_RATE
      ? Math.max(0, mps / natural)
      : rate(mps, natural);
    if (act.walk) act.walk.setEffectiveTimeScale(turning
      ? Math.min(MAX_RATE, Math.max(0.35, Math.abs(p.omega) / 10))
      : clipRate(v, CLIP_MPS.walk));
    if (act.run) act.run.setEffectiveTimeScale(clipRate(v, CLIP_MPS.run));
    if (act.crouchWalk) act.crouchWalk.setEffectiveTimeScale(clipRate(v, CLIP_MPS.crouchWalk));

    // Traversal clips are authored at their own length. The simulation owns the
    // move (mantleTime, vaultTime), so the clip is locked to that 0..1 — the
    // same job Unreal's animation warping does, without a motion-warping node.
    // timeScale 0 stops the mixer advancing the clip on its own clock.
    // phase 0..1 across the WHOLE clip. The traversal clips are not that:
    // climb-top is a 4 s pull-up whose last second is already standing, and
    // the jump's landing is the second half. Playing all of either one on a
    // sub-second move is the scramble. `span` picks a window inside the clip.
    const lockClip = (action, phase, span) => {
      if (!action) return;
      const dur = action.getClip().duration || 1;
      const a = span ? span[0] : 0, b = span ? span[1] : 1;
      const u = Math.min(1, Math.max(0, phase));
      action.timeScale = 0;
      action.time = Math.min(dur * 0.999, (a + u * (b - a)) * dur);
    };
    if (p && state === 'mantle' && act.climbTop) {
      const dur = act.climbTop.getClip().duration || 4;
      lockClip(act.climbTop, (p.mantle || 0), [CLIMB_SPAN[0] / dur, CLIMB_SPAN[1] / dur]);
    // Stay frozen on the last climb frame while it fades out: released at once,
    // the clip played its own step-down under the blend and sank a boot 0.2 m
    // into the floor on the first frame of standing.
    } else if (act.climbTop && act.climbTop.timeScale === 0 && w.climbTop < 0.01) act.climbTop.timeScale = 1;
    // jump: 0–0.36 is the takeoff through the tuck. Past the apex the falling
    // clip takes over, so the landing half of this clip never plays in the air.
    if (state !== 'air') fallT = 0;
    if (p && state === 'vault') lockClip(act.jump, p.vault || 0, [0.10, 0.58]);
    else if (p && state === 'air' && p.vz > 0) {
      // Up: the push-off, body upright and a knee driving. Past 0.2 of the
      // clip it opens into a split leap with the torso pitched flat, which
      // read as a dive on every jump and as a frozen sprawl against a wall.
      const u = 1 - Math.min(1, Math.max(0, p.vz / PHYS.jumpSpeed));
      lockClip(act.jump, u, [0.10, 0.19]);
    }
    // Down: the upright knee-up the clip lands from, the knee rising as the
    // ground comes up.
    if (act.jumpDown) lockClip(act.jumpDown, Math.min(1, fallT / 0.4), [0.60, 0.68]);
    else if (act.jump && act.jump.timeScale === 0) act.jump.timeScale = 1;
    // hang-grab: 0.30s–0.90s of 1.27s is the reach. The rest is standing, then
    // a settled hang the idle clip already owns.
  };
}

// SkeletonUtils.clone SHARES materials between clones. `setCarrying` writes
// `emissive` on the material, so without this every runner turned blue the moment
// any one of them picked up a relic.
export function isolateMaterials(root) {
  root.traverse(o => {
    if (!o.isMesh || !o.material) return;
    o.material = Array.isArray(o.material) ? o.material.map(m => m.clone()) : o.material.clone();
  });
}

export { cloneSkinned };

// ---------------------------------------------------------------------------
// RIG CALIBRATION.
//
// Two numbers decide whether a climb looks like a climb, and neither can be
// guessed: they are properties of the Mixamo clips, not of this game.
//
//   lift  — how far ABOVE the body origin the hands sit in the hang pose
//   reach — how far FORWARD of the body origin they sit
//   drop  — how far above the body origin the feet sit while standing
//
// Measured once per rig by posing the skeleton and reading the bone positions,
// so swapping the character later re-derives them instead of inheriting
// hand-tuned constants that were only ever right for one FBX.
// ---------------------------------------------------------------------------
export function calibrateRig(mixer, anim, model, root) {
  const V = new THREE.Vector3(), R = new THREE.Vector3();
  const settle = (state, n = 90) => {
    const fake = { state, cd: {}, game: { t: 0 }, vz: 0, shimmying: false };
    for (let i = 0; i < n; i++) { anim(0, 0, false, 0, fake); mixer.update(1 / 60); }
    model.updateMatrixWorld(true);
    root.getWorldPosition(R);
  };
  const bones = pat => {
    const out = [];
    model.traverse(o => { if (o.isBone && pat.test(o.name.toLowerCase())) out.push(o); });
    return out;
  };
  // Bone positions in the ROOT'S OWN SPACE, not world space. The body is
  // rotated to face whatever wall it grabbed, so a "how far forward are the
  // hands" measured along world Z is whatever the yaw happened to be at
  // calibration time — it read -0.07 m for a pose whose hands are nearly two
  // metres forward, and the correction built on it threw the model through the
  // wall. In root space, +Z is always the facing direction.
  const avgLocal = (list, axis) => {
    if (!list.length) return null;
    let t = 0;
    for (const b of list) { b.getWorldPosition(V); root.worldToLocal(V); t += V[axis]; }
    return t / list.length;
  };
  const lowestLocal = list => {
    let lo = Infinity;
    for (const b of list) { b.getWorldPosition(V); root.worldToLocal(V); lo = Math.min(lo, V.y); }
    return isFinite(lo) ? lo : null;
  };

  // feet, standing. Local Y above the body origin is exactly the float.
  settle('ground');
  const feet = bones(/toe|foot/);
  const drop = lowestLocal(feet) ?? 0;
  // Ankle above the lowest boot vertex. Planting the ankle on the origin
  // leaves that much sole in the floor. Measured on the standing pose.
  const sole = ankleAboveSole(model);

  // hands, hanging. In root space the model faces +Z, into the wall.
  settle('hang');
  const hands = bones(/(left|right)hand$/);
  const lift = avgLocal(hands, 'y') ?? 0;
  const reach = avgLocal(hands, 'z') ?? 0;
  settle('ground', 30);     // leave it standing
  return { drop, lift, reach, sole };
}

function skinnedOf(model) {
  if (model.userData.vrSkin) return model.userData.vrSkin;
  const list = [];
  model.traverse(o => { if (o.isSkinnedMesh) list.push(o); });
  model.userData.vrSkin = list;
  return list;
}

function boneName(sm, index) {
  const si = sm.geometry.attributes.skinIndex;
  const sw = sm.geometry.attributes.skinWeight;
  let best = 0, bi = 0;
  for (let k = 0; k < 4; k++) {
    const w = sw.getComponent(index, k);
    if (w > best) { best = w; bi = si.getComponent(index, k); }
  }
  const bone = sm.skeleton.bones[bi | 0];
  return bone ? bone.name.toLowerCase() : '';
}

// ---------------------------------------------------------------------------
// BONE PROXIES — the skinned silhouette, at a fraction of the cost.
//
// Every clearance test below used to CPU-skin the whole mesh: getVertexPosition
// blends four bone matrices per vertex, and each vertex also paid a regex on
// its bone name. For four runners that was most of a 60 ms frame on an M4 Max.
//
// A proxy is the same idea as a ragdoll's capsules: each bone carries a small
// fixed sample of the vertices it dominates, stored in that bone's own space
// once, from the bind pose. At runtime a point costs one matrix multiply and
// the bone-name filter runs per bone, not per vertex. The error is rigid-vs-
// blended skinning near a joint — a centimetre or two — which is below what
// any of these corrections act on.
// ---------------------------------------------------------------------------
const PROXY_PER_BONE = 56;
const PROXY_PER_FOOT = 180;      // the sole has to be found to the millimetre
const _pM = new THREE.Matrix4(), _pB = new THREE.Matrix4();
function proxiesOf(model) {
  if (model.userData.vrProxy) return model.userData.vrProxy;
  const out = [];
  const v = new THREE.Vector3();
  model.updateMatrixWorld(true);
  for (const sm of skinnedOf(model)) {
    const pos = sm.geometry.attributes.position;
    const si = sm.geometry.attributes.skinIndex, sw = sm.geometry.attributes.skinWeight;
    const byBone = new Map();
    for (let i = 0; i < pos.count; i++) {
      let best = 0, bi = 0;
      for (let k = 0; k < 4; k++) { const w = sw.getComponent(i, k); if (w > best) { best = w; bi = si.getComponent(i, k) | 0; } }
      let l = byBone.get(bi); if (!l) byBone.set(bi, l = []); l.push(i);
    }
    for (const [bi, idx] of byBone) {
      const bone = sm.skeleton.bones[bi]; if (!bone) continue;
      const name = bone.name.toLowerCase();
      const cap = /foot|toe/.test(name) ? PROXY_PER_FOOT : PROXY_PER_BONE;
      const stride = Math.max(1, idx.length / cap);
      const pts = [];
      for (let f = 0; f < idx.length; f += stride) {
        v.fromBufferAttribute(pos, idx[Math.floor(f)]).applyMatrix4(sm.bindMatrix).applyMatrix4(sm.skeleton.boneInverses[bi]);
        pts.push(v.x, v.y, v.z);
      }
      out.push({ sm, bone, name, pts: new Float32Array(pts) });
    }
  }
  model.userData.vrProxy = out;
  return out;
}
// Visit every proxy point whose bone name passes `inc` and fails `exc`, in
// world space. `fn(v)` may return true to stop early.
const _filterCache = new WeakMap();
function eachProxy(model, inc, exc, fn) {
  const all = proxiesOf(model);
  let cache = _filterCache.get(all); if (!cache) _filterCache.set(all, cache = new Map());
  const key = inc.source + '|' + (exc ? exc.source : '');
  let list = cache.get(key);
  if (!list) { list = all.filter(p => inc.test(p.name) && !(exc && exc.test(p.name))); cache.set(key, list); }
  let lastSm = null;
  for (const pr of list) {
    if (pr.sm !== lastSm) { lastSm = pr.sm; _pM.multiplyMatrices(pr.sm.matrixWorld, pr.sm.bindMatrixInverse); }
    _pB.multiplyMatrices(_pM, pr.bone.matrixWorld);
    const e = _pB.elements, a = pr.pts;
    for (let i = 0; i < a.length; i += 3) {
      const x = a[i], y = a[i + 1], z = a[i + 2];
      _scan.set(e[0] * x + e[4] * y + e[8] * z + e[12], e[1] * x + e[5] * y + e[9] * z + e[13], e[2] * x + e[6] * y + e[10] * z + e[14]);
      if (fn(_scan) === true) return;
    }
  }
}

// Metres the ankle bone sits above the sole in the standing pose.
function ankleAboveSole(model) {
  model.updateMatrixWorld(true);
  const V = new THREE.Vector3();
  let ankle = Infinity;
  model.traverse(o => {
    if (!o.isBone || !/foot$/i.test(o.name)) return;
    o.getWorldPosition(V);
    ankle = Math.min(ankle, V.y);
  });
  let sole = Infinity;
  for (const sm of skinnedOf(model)) {
    sm.skeleton.update();
    const n = sm.geometry.attributes.position.count;
    const step = 1;
    for (let i = 0; i < n; i += step) {
      if (!/foot|toe/.test(boneName(sm, i))) continue;
      sm.getVertexPosition(i, V);
      sm.localToWorld(V);
      if (V.y < sole) sole = V.y;
    }
  }
  if (!isFinite(ankle) || !isFinite(sole)) return 0.11;
  return Math.max(0.02, +(ankle - sole).toFixed(4));
}

// ---------------------------------------------------------------------------
// POSE POLISH — foot plant, turn lean, landing compression.
//
// Foot IK is the Unreal two-bone solve (thigh, knee, foot) with the animated
// knee as the pole, so the bend stays in the plane the clip already chose.
// Bone LENGTHS never change: the old pass moved the foot joint, which stretches
// the shin into a spike the moment the ground is past the ankle. A law-of-cosines
// solve only rotates the hip and the knee.
//
// The body stands on the TALLEST surface under it, so only a foot that is
// hanging above a lower tread gets pulled down. Pelvis pull-down is wrong here:
// dropping the hips would push the higher foot through the step it is already on.
//
// Lean is what a turn-in-place clip is for, and this set does not have one.
// Shoulders yaw against the hips while turning on the spot, and bank into the
// turn while moving. Spine is a sibling of the legs under the hips, so this
// does not move the feet the IK just planted.
// ---------------------------------------------------------------------------
const _vA = new THREE.Vector3(), _vB = new THREE.Vector3(), _vC = new THREE.Vector3();
const _vD = new THREE.Vector3(), _vE = new THREE.Vector3(), _vF = new THREE.Vector3();
const _kneeBefore = new THREE.Vector3(), _idealKnee = new THREE.Vector3(), _end = new THREE.Vector3();
const _qA = new THREE.Quaternion(), _qB = new THREE.Quaternion(), _qC = new THREE.Quaternion();
const _qThigh = new THREE.Quaternion(), _qKnee = new THREE.Quaternion();
const _eLean = new THREE.Euler(0, 0, 0, 'YXZ');
const _mBasis = new THREE.Matrix4();
const _ray = new THREE.Raycaster();
const _origin = new THREE.Vector3();
const _dir = new THREE.Vector3();
const _nSave = new THREE.Vector3();
const _palmN = new THREE.Vector3();
const _UP = new THREE.Vector3(0, 1, 0);
const _seatBox = new THREE.Box3();
const _scan = new THREE.Vector3();
const damp = (cur, tgt, speed, dt) => cur + (tgt - cur) * (1 - Math.exp(-speed * dt));
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const IK_ANKLE = 0.11;   // fallback; calibrateRig measures the real sole gap
const IK_MAX = 0.42;     // m — one stair tread. Beyond that, leave the clip alone.

function chainsOf(p) {
  if (p._pose) return p._pose;
  const legs = [], spines = [], arms = [];
  p.model.traverse(o => {
    if (!o.isBone) return;
    const n = o.name.toLowerCase();
    if (/(left|right)foot$/.test(n) && o.parent && o.parent.parent)
      legs.push({ foot: o, knee: o.parent, thigh: o.parent.parent, thighLen: 0, shin: 0 });
    else if (/(left|right)hand$/.test(n) && o.parent && o.parent.parent)
      arms.push({ hand: o, elbow: o.parent, shoulder: o.parent.parent,
        side: n.includes('left') ? -1 : 1, upper: 0, fore: 0 });
    else if (/spine\d*$/.test(n)) spines.push(o);
  });
  spines.sort((a, b) => a.name.length - b.name.length || a.name.localeCompare(b.name));
  p._pose = { legs, spines, arms };
  return p._pose;
}

// Rotate `bone` so the direction toward `fromWorld` (a child joint) swings onto
// the direction toward `toWorld`. Twist is whatever the clip already had.
function swingBone(bone, fromWorld, toWorld) {
  bone.getWorldPosition(_vA);
  _vB.copy(fromWorld).sub(_vA);
  _vC.copy(toWorld).sub(_vA);
  if (_vB.lengthSq() < 1e-8 || _vC.lengthSq() < 1e-8) return;
  _vB.normalize(); _vC.normalize();
  if (_vB.dot(_vC) > 0.9995) return;
  _qA.setFromUnitVectors(_vB, _vC);
  bone.getWorldQuaternion(_qB);
  _qB.premultiply(_qA);
  bone.parent.getWorldQuaternion(_qC);
  bone.quaternion.copy(_qC.invert().multiply(_qB));
  bone.updateMatrixWorld(true);
}

function solveLeg(leg, groundAt, dt, plant, sole) {
  const { foot, knee, thigh } = leg;
  foot.getWorldPosition(_vD);
  knee.getWorldPosition(_vE);
  thigh.getWorldPosition(_vF);
  if (!leg.shin) {
    leg.shin = _vD.distanceTo(_vE);
    leg.thighLen = _vE.distanceTo(_vF);
  }
  if (leg.shin < 0.05 || leg.thighLen < 0.05) return;
  const gnd = groundAt(_vD.x / S + MAP.w / 2, _vD.z / S + MAP.h / 2);
  const want = gnd + (sole || IK_ANKLE);
  const drop = _vD.y - want;
  // Only the stance foot. A swing foot within 40 cm used to be dragged onto
  // the floor, which is the skate. A foot that has sunk a few centimetres is
  // lifted back onto the stone.
  // A foot below the stone under it is inside the stone, stance or swing: on
  // a stair the body still on the lower tread draws its leading foot 36 cm
  // into the next one. Lift it onto the tread, at once (easing it up would
  // show it sunk for a few frames). Anything deeper than a step is not a
  // stair but a wall, and the body's own collision answers for that.
  const buried = drop < -0.02 && drop > -(PHYS.stepUp + 0.06);
  if (!buried && (!plant || drop > 0.12 || drop < -0.14)) { leg._y = _vD.y; return; }
  leg._y = buried ? want : (leg._y == null ? want : damp(leg._y, want, 18, dt));

  // Clamp onto the reachable annulus. Past the shin+thigh the foot stays as
  // close as the leg allows and no further — it cannot stretch.
  _vA.set(_vD.x, leg._y, _vD.z).sub(_vF);
  const raw = _vA.length();
  if (raw < 1e-4) return;
  const maxR = leg.thighLen + leg.shin - 1e-3;
  const minR = Math.abs(leg.thighLen - leg.shin) + 1e-3;
  const dist = clamp(raw, minR, maxR);
  _vB.copy(_vA).multiplyScalar(1 / raw);         // unit axis, hip -> target
  const cosHip = clamp((dist * dist + leg.thighLen * leg.thighLen - leg.shin * leg.shin)
    / (2 * dist * leg.thighLen), -1, 1);
  const hipAngle = Math.acos(cosHip);

  // Pole: the knee where the clip put it, so we never flip the bend backwards.
  _vC.copy(_vE).sub(_vF);
  _vC.addScaledVector(_vB, -_vC.dot(_vB));
  if (_vC.lengthSq() < 1e-6) return;
  _vC.normalize();
  _vA.crossVectors(_vB, _vC);
  if (_vA.lengthSq() < 1e-8) return;
  _vA.normalize();
  _vC.copy(_vB).applyAxisAngle(_vA, hipAngle);   // thigh direction, bent toward the pole
  _kneeBefore.copy(_vE);
  _idealKnee.copy(_vF).addScaledVector(_vC, leg.thighLen);
  _end.copy(_vF).addScaledVector(_vB, dist);
  // A bad solve pops a knee backwards. Keep the clip pose if the foot does
  // not actually arrive — a hanging foot is the old look, a pretzel is worse.
  _qThigh.copy(thigh.quaternion);
  _qKnee.copy(knee.quaternion);
  swingBone(thigh, _kneeBefore, _idealKnee);
  foot.getWorldPosition(_vD);
  swingBone(knee, _vD, _end);
  foot.getWorldPosition(_vD);
  if (_vD.distanceTo(_end) > 0.08) {
    thigh.quaternion.copy(_qThigh);
    knee.quaternion.copy(_qKnee);
    thigh.updateMatrixWorld(true);
  }
}

// The jump and the mantle clips carry root motion: the hips rise inside the
// skeleton as well as the simulation raising the body. Playing both stacks
// them, so a 1.3 m jump draws as nearly two metres and a mantle climbs past
// the lip it is stepping onto. While those clips own the pose, the hip
// translation is put back to the standing position and the simulation keeps
// the travel. Rotations — the tuck, the pull, the step — stay.
function holdRoot(p) {
  if (!p._hips) {
    p.model.traverse(o => { if (!p._hips && o.isBone && /hips$/i.test(o.name)) p._hips = o; });
  }
  const hips = p._hips;
  if (!hips) return;
  const catching = p.state === 'hang' && p.catchT != null && p.catchT < PHYS.catchTime;
  // Mantle no longer plays the ladder clip, so its hip track must not be
  // pinned to the standing pose — that would pull the braced hang apart.
  const lock = p.state === 'air' || p.state === 'vault' || catching;
  if (lock) { if (p._hipBind) hips.position.copy(p._hipBind); return; }
  if (!p._hipBind && p.state === 'ground') p._hipBind = hips.position.clone();
}

// Two-bone reach. `target` and `pole` are world-space points. Lengths stay
// the clip's bone lengths; a target past the reach is pulled in, never stretched.
function solveChain(chain, target, pole) {
  const { hand, elbow, shoulder } = chain;
  const upper = shoulder, mid = elbow, end = hand;
  end.getWorldPosition(_vD);
  mid.getWorldPosition(_vE);
  upper.getWorldPosition(_vF);
  if (!chain.upper) {
    chain.fore = _vD.distanceTo(_vE);
    chain.upper = _vE.distanceTo(_vF);
  }
  if (chain.fore < 0.05 || chain.upper < 0.05) return false;
  _vA.copy(target).sub(_vF);
  const raw = _vA.length();
  if (raw < 1e-4) return false;
  const maxR = chain.upper + chain.fore - 1e-3;
  const minR = Math.abs(chain.upper - chain.fore) + 1e-3;
  const dist = clamp(raw, minR, maxR);
  _vB.copy(_vA).multiplyScalar(1 / raw);
  const cosHip = clamp((dist * dist + chain.upper * chain.upper - chain.fore * chain.fore)
    / (2 * dist * chain.upper), -1, 1);
  const hipAngle = Math.acos(cosHip);
  _vC.copy(pole).sub(_vF);
  _vC.addScaledVector(_vB, -_vC.dot(_vB));
  if (_vC.lengthSq() < 1e-6) return false;
  _vC.normalize();
  _end.copy(_vA);
  _vA.crossVectors(_vB, _vC);
  if (_vA.lengthSq() < 1e-8) return false;
  _vA.normalize();
  _vC.copy(_vB).applyAxisAngle(_vA, hipAngle);
  _kneeBefore.copy(_vE);
  _idealKnee.copy(_vF).addScaledVector(_vC, chain.upper);
  _end.copy(_vF).addScaledVector(_vB, dist);
  _qThigh.copy(upper.quaternion);
  _qKnee.copy(mid.quaternion);
  swingBone(upper, _kneeBefore, _idealKnee);
  end.getWorldPosition(_vD);
  swingBone(mid, _vD, _end);
  end.getWorldPosition(_vD);
  if (_vD.distanceTo(_end) > 0.08) {
    upper.quaternion.copy(_qThigh);
    mid.quaternion.copy(_qKnee);
    upper.updateMatrixWorld(true);
    return false;
  }
  return true;
}

// Where this body's hands and feet belong on the block it is actually holding.
// The point is recomputed from where the body is NOW, so a shimmy walks the
// grip along the edge and a narrow pillar pulls the hands together instead of
// leaving them out in the air past the corners.
function ledgeContacts(p) {
  const g = p.ledge;
  const w = g && g.wall;
  if (!w) return null;
  const gapU = (p.x - g.ex) * g.nx + (p.y - g.ey) * g.ny;
  let fx = p.x - g.nx * gapU;
  let fy = p.y - g.ny * gapU;
  const along = Math.abs(g.nx) > 0.5 ? w.h : w.w;
  const thick = Math.abs(g.nx) > 0.5 ? w.w : w.h;
  const half = Math.max(0.06 / S, Math.min(0.17 / S, along * 0.5 - 0.6));
  const inset = Math.min(0.11 / S, Math.max(0.04 / S, thick * 0.5 - 0.4));
  if (Math.abs(g.nx) > 0.5) {
    fx = g.nx < 0 ? w.x : w.x + w.w;
    const lo = w.y + half, hi = w.y + w.h - half;
    fy = lo < hi ? Math.min(hi, Math.max(lo, fy)) : (w.y + w.h * 0.5);
  } else {
    fy = g.ny < 0 ? w.y : w.y + w.h;
    const lo = w.x + half, hi = w.x + w.w - half;
    fx = lo < hi ? Math.min(hi, Math.max(lo, fx)) : (w.x + w.w * 0.5);
  }
  const tx = -g.ny, ty = g.nx;
  const palm = g.top + 0.02;
  const wx = (x, y) => ({ x: (x - MAP.w / 2) * S, z: (y - MAP.h / 2) * S });
  const hand = (s) => wx(fx + tx * half * s - g.nx * inset, fy + ty * half * s - g.ny * inset);
  // Feet stay on the vertical face. The hand inset would push them into the stone.
  const sole = (s) => wx(fx + tx * half * 0.8 * s, fy + ty * half * 0.8 * s);
  const left = hand(1), right = hand(-1);
  const depth = thick * S * 0.55;
  return {
    intoX: -g.nx, intoZ: -g.ny,
    left: { ...left, y: palm }, right: { ...right, y: palm },
    // Both feet at one height. A ladder puts them on alternating rungs.
    footY: Math.max((p.z || 0) + 0.2, g.top - 1.12),
    leftFoot: sole(1), rightFoot: sole(-1),
    outX: g.nx, outZ: g.ny,
    depth,
  };
}

function toWorld(c, y, out) {
  out.set(c.x, y, c.z);
  return out;
}

// The box only says where the hold is. The carved mesh — pillar, rubble,
// stair, door, wall — is what the palm actually meets. A carved model wins
// over the grey box when both are in range, and a hidden stand-in is ignored.
function stickToSurface(x, y, z, outX, outZ, mode, reach) {
  const meshes = climbTargets();
  if (!meshes.length) return null;
  // A carved model often sits inside the collision box, so the lip of the box
  // is empty air. Walk the probe inward across that piece until it meets
  // stone, and stop at the first surface so the hands stay on the near edge.
  const limit = Math.max(mode === 'top' ? 1.6 : 0.75, reach || 0);
  const steps = Math.min(mode === 'top' ? 18 : 5, Math.ceil(limit / 0.2) + 1);
  // Outward first on a top: a cornice stands proud of the collision box, and
  // the hands belong on that near lip. Inward still runs, for a carving that
  // sits inside its box. The first hit is the surface closest to the body.
  const samples = [];
  if (mode === 'top') samples.push(-0.36, -0.18, 0);
  else samples.push(0);
  for (let s = 1; s < steps; s++) samples.push(s * 0.2);
  for (let i = 0; i < samples.length; i++) {
    const inward = samples[i];
    // A face ray that starts inside the volume hits the far side and plants
    // the foot in the stone. Keep the origin on the player's side of the face.
    if (mode === 'face' && inward > 0.75) break;
    const sx = x - outX * inward;
    const sz = z - outZ * inward;
    if (mode === 'top') {
      _origin.set(sx, y + 1.35, sz);
      _dir.set(0, -1, 0);
      _ray.far = 3.4;
    } else {
      _origin.set(sx + outX * 0.9, y, sz + outZ * 0.9);
      _dir.set(-outX, 0, -outZ);
      if (_dir.lengthSq() < 1e-6) return null;
      _dir.normalize();
      _ray.far = 2.6;
    }
    _ray.set(_origin, _dir);
    const hits = _ray.intersectObjects(meshes, false);
    let pick = null;
    for (let i = 0; i < hits.length; i++) {
      const h = hits[i];
      if (!surfaceVisible(h.object) || !h.face) continue;
      if (Math.abs(h.point.y - y) > (mode === 'top' ? 1.6 : 0.95)) continue;
      // A pillar beside the ledge is not the ledge. A boot planted on it is
      // the leg stuck out straight. Stay near the point we meant to hold.
      const hx = h.point.x - x, hy = h.point.y - y, hz = h.point.z - z;
      const lim = mode === 'top' ? 0.70 : 0.38;
      if (hx * hx + hy * hy + hz * hz > lim * lim) continue;
      // A hit metres past the face is the back of the wall, not the hold.
      if (mode === 'face' && (x - h.point.x) * outX + (z - h.point.z) * outZ > 0.9) continue;
      if (!pick) { pick = h; continue; }
      if (h.object.userData.artifact && !pick.object.userData.artifact && h.distance < pick.distance + 0.45)
        pick = h;
    }
    if (!pick) continue;
    _nSave.copy(pick.face.normal).transformDirection(pick.object.matrixWorld).normalize();
    if (mode === 'top' && _nSave.y < 0) _nSave.negate();
    if (mode === 'face' && _nSave.x * outX + _nSave.z * outZ < 0) _nSave.negate();
    _origin.copy(pick.point).addScaledVector(_nSave, mode === 'top' ? 0.04 : 0.02);
    // The foot bone is the ankle. Left on the polygon, the boot is inside the
    // course. Sit it proud of the face.
    if (mode === 'face') { _origin.x += outX * 0.04; _origin.z += outZ * 0.04; }
    return true;
  }
  return null;
}

// Fingers lie on THIS surface. Local Y was measured pointing up in the hang
// clip, which is a hand wrapped over a bar. Here it follows the stone, and
// the palm presses along the surface normal — flat on a cap, into a face.
function layHand(hand, intoX, intoZ, side, normal) {
  const n = normal || _UP;
  _vC.copy(n).multiplyScalar(-1);
  _vA.set(intoX, 0, intoZ);
  _vA.addScaledVector(n, -_vA.dot(n));
  if (_vA.lengthSq() < 1e-4) _vA.set(0, 1, 0).addScaledVector(n, -n.y);
  if (_vA.lengthSq() < 1e-6) return;
  _vA.normalize();
  _vC.addScaledVector(_vA, -_vC.dot(_vA)).normalize();
  _vB.crossVectors(_vC, _vA).multiplyScalar(side);
  if (_vB.lengthSq() < 1e-6) return;
  _vB.normalize();
  _vC.crossVectors(_vA, _vB).normalize();
  _qA.setFromRotationMatrix(_mBasis.makeBasis(_vB, _vA, _vC));
  hand.parent.getWorldQuaternion(_qB);
  hand.quaternion.copy(_qB.invert().multiply(_qA));
}

// The collision lip is sometimes empty: a fitted model sits inside the box, or
// off to one side of it. On the grab, slide along that same face until the
// hands are over stone. A raised mechanism (the bridge, metres above its box)
// is left alone — there is no surface here to hold.
function seatOnStone(p) {
  const g = p.ledge, w = g && g.wall;
  if (!w) return;
  const c = ledgeContacts(p);
  if (!c) return;
  if (stickToSurface(c.left.x, c.left.y, c.left.z, c.outX, c.outZ, 'top', c.depth)) return;
  const x0 = (w.x - MAP.w / 2) * S - 0.4, x1 = (w.x + w.w - MAP.w / 2) * S + 0.4;
  const z0 = (w.y - MAP.h / 2) * S - 0.4, z1 = (w.y + w.h - MAP.h / 2) * S + 0.4;
  let best = null, bestD = 1.7;
  for (const m of climbTargets()) {
    if (!m.userData.artifact || !surfaceVisible(m)) continue;
    _seatBox.setFromObject(m);
    if (_seatBox.max.x < x0 || _seatBox.min.x > x1 || _seatBox.max.z < z0 || _seatBox.min.z > z1) continue;
    const cx = Math.min(_seatBox.max.x, Math.max(_seatBox.min.x, c.left.x));
    const cz = Math.min(_seatBox.max.z, Math.max(_seatBox.min.z, c.left.z));
    const dy = _seatBox.max.y - c.left.y;
    if (Math.abs(dy) > 1.5) continue;
    const d = Math.hypot(cx - c.left.x, dy, cz - c.left.z);
    if (d < bestD) bestD = d, best = {
      x: cx, z: cz,
      mx: (_seatBox.min.x + _seatBox.max.x) / 2,
      mz: (_seatBox.min.z + _seatBox.max.z) / 2,
    };
  }
  if (!best || bestD < 0.08) return;
  // The grip is two hands, not a point. Step past the near edge so the
  // outer hand is on the carving and not still out on the empty lip.
  const ix = best.mx - best.x, iz = best.mz - best.z;
  const il = Math.hypot(ix, iz);
  if (il > 1e-4) { best.x += ix / il * 0.24; best.z += iz / il * 0.24; }
  const tx = -g.ny, ty = g.nx;
  const wx = (g.ex - MAP.w / 2) * S, wz = (g.ey - MAP.h / 2) * S;
  const slide = ((best.x - wx) * tx + (best.z - wz) * ty) / S;
  let nex = g.ex + tx * slide, ney = g.ey + ty * slide;
  if (Math.abs(g.nx) > 0.5) {
    ney = Math.min(w.y + w.h - 1, Math.max(w.y + 1, ney));
    nex = g.nx < 0 ? w.x : w.x + w.w;
  } else {
    nex = Math.min(w.x + w.w - 1, Math.max(w.x + 1, nex));
    ney = g.ny < 0 ? w.y : w.y + w.h;
  }
  const gap = (p.x - g.ex) * g.nx + (p.y - g.ey) * g.ny;
  g.ex = nex; g.ey = ney;
  p.x = nex + g.nx * gap;
  p.y = ney + g.ny * gap;
}

// How far `point` sits outside the stone face, in metres. Positive is outside.
// The ray starts on the body's side and walks into the wall, so the first
// face it meets is the one the torso has to clear — a proud course, not the
// far side of the block.
function outsideFace(x, y, z, outX, outZ) {
  const meshes = climbTargets();
  if (!meshes.length) return null;
  _origin.set(x + outX * 0.95, y, z + outZ * 0.95);
  _dir.set(-outX, 0, -outZ);
  if (_dir.lengthSq() < 1e-6) return null;
  _dir.normalize();
  _ray.far = 1.9;
  _ray.set(_origin, _dir);
  const hits = _ray.intersectObjects(meshes, false);
  for (let i = 0; i < hits.length; i++) {
    const h = hits[i];
    if (!surfaceVisible(h.object) || !h.face) continue;
    if (Math.abs(h.point.y - y) > 0.55) continue;
    _nSave.copy(h.face.normal).transformDirection(h.object.matrixWorld);
    if (_nSave.x * outX + _nSave.z * outZ < 0.2) continue;
    return (x - h.point.x) * outX + (z - h.point.z) * outZ;
  }
  return null;
}

// Clearance of the skinned vertex furthest into the stone. `out` points out of
// the face, toward the body. Hands are not included: they belong on the lip.
function meshClearance(model, outX, outZ, pred) {
  const near = [];
  eachProxy(model, pred, null, v => {
    const d = v.x * outX + v.z * outZ;
    if (near.length < 5 || d < near[4].d) {
      const slot = { x: v.x, y: v.y, z: v.z, d };
      if (near.length < 5) near.push(slot); else near[4] = slot;
      near.sort((a, b) => a.d - b.d);
    }
  });
  let best = null;
  for (let i = 0; i < near.length; i++) {
    const g = outsideFace(near[i].x, near[i].y, near[i].z, outX, outZ);
    if (g == null) continue;
    best = best == null ? g : Math.min(best, g);
  }
  return best;
}

// The collision box stands proud of a carved pillar. Clearance has to be
// against the stone the camera sees. One ray from the body, which the pad
// keeps outside, finds that face; per-vertex rays start inside it and miss.
function visibleHangGap(p, c) {
  if (!p.ledge || !p.mesh) return null;
  const y = Math.max(0.5, (p.z || 0) + 0.85);
  _origin.set(p.mesh.position.x + c.outX * 0.2, y, p.mesh.position.z + c.outZ * 0.2);
  _dir.set(-c.outX, 0, -c.outZ);
  if (_dir.lengthSq() < 1e-6) return null;
  _dir.normalize();
  _ray.far = 2.8;
  _ray.set(_origin, _dir);
  const hits = _ray.intersectObjects(climbTargets(), false);
  let fx = 0, fz = 0, found = false;
  for (let i = 0; i < hits.length; i++) {
    const h = hits[i];
    if (!surfaceVisible(h.object) || !h.face) continue;
    _nSave.copy(h.face.normal).transformDirection(h.object.matrixWorld);
    if (_nSave.x * c.outX + _nSave.z * c.outZ < 0.35) continue;
    fx = h.point.x; fz = h.point.z; found = true;
    break;
  }
  if (!found) return null;
  let best = Infinity;
  // The thigh already reaches the carving while the chest is still back at
  // the collision box. Measuring the thigh here froze the body a leg's length
  // off the stone.
  eachProxy(p.model, /spine|neck|head|hips|pelvis/, null, v => {
    const g = (v.x - fx) * c.outX + (v.z - fz) * c.outZ;
    if (g < best) best = g;
  });
  return best === Infinity ? null : best;
}

// How far the boot mesh sticks past the ankle toward the wall.
function bootPast(model, bx, bz, outX, outZ) {
  let extra = 0;
  eachProxy(model, /foot|toe/, null, v => {
    const d = (bx - v.x) * outX + (bz - v.z) * outZ;
    if (d > extra) extra = d;
  });
  return extra;
}

function lowestSole(model) {
  let best = null;
  eachProxy(model, /foot|toe/, null, v => {
    if (!best) best = { x: v.x, y: v.y, z: v.z };
    else if (v.y < best.y) { best.x = v.x; best.y = v.y; best.z = v.z; }
  });
  return best;
}

// A fitted carving sits inside its collision box. Parking the chest on the box
// leaves the hands at the end of a straight arm. Remember how much closer the
// mesh has to sit so the shoulder is a bent-elbow from the grip; the frame
// loop eases the mesh there. The hip and chest then veto that slide: the
// joints have to stay far enough off the face that the body in front of them
// is outside the stone.
function braceBody(p, c, arms) {
  if (!p.wrap || !arms.length) return;
  const arm = arms[0];
  const anchor = arm.side < 0 ? c.left : c.right;
  arm.shoulder.getWorldPosition(_vF);
  toWorld(anchor, anchor.y, _end);
  if (stickToSurface(_end.x, _end.y, _end.z, c.outX, c.outZ, 'top', c.depth)) _end.copy(_origin);
  const vert = _vF.y - _end.y;
  const applied = p.wrap.position.z - (p._push || 0);
  // The elbow bend is the arm IK. Sliding the whole mesh toward the grip is
  // what left the hips on one side of the stone and the boots on the other.
  // Sit the chest about 10 cm off the visible face and no closer.
  const SKIN = 0.10;
  const tight = visibleHangGap(p, c);
  let brace = Math.min(applied, 0);
  if (tight != null) {
    const maxZ = p.wrap.position.z + (tight - SKIN);
    // Inward chase lives with the foot plane, below. Here, only back out
    // if the chest has crossed the stone.
    if (tight < SKIN) brace = Math.min(brace, maxZ - (p._push || 0));
  }
  p._brace = Math.max(-0.9, Math.min(0.9, brace));
  const appliedY = p.wrap.position.y - (p._lift || 0);
  // A positive correction lifts the shoulders into the slab and the hood
  // follows. Only a drop is allowed, and only enough to put the shoulder
  // under the grip.
  const wantY = appliedY - (vert + 0.18);
  p._braceY = Math.max(-0.35, Math.min(0, wantY));
}

// Elbow below the grip and a little off the wall. A pole a metre to the
// side wings the arm so the side view is a straight reach, not a bent hang.
function bendElbow(c, side) {
  // In the profile plane: below the grip and out from the stone, so a
  // camera looking along the wall sees the elbow drop, not a straight arm.
  _idealKnee.set(
    _end.x + c.outX * 0.42 - c.intoZ * side * 0.06,
    _end.y - 0.2,
    _end.z + c.outZ * 0.42 + c.intoX * side * 0.06
  );
}

// Palm on the top of the lip. A hit deeper than the anchor sinks the
// fingers into the slab.
function shoulderToLip(arm, c, p) {
  const clav = arm.shoulder && arm.shoulder.parent;
  const face = c.leftFoot;
  if (!clav || !clav.isBone || !face || !/shoulder|clavicle/i.test(clav.name)) return;
  arm.shoulder.getWorldPosition(_vF);
  const depth = (_vF.x - face.x) * c.outX + (_vF.z - face.z) * c.outZ;
  const want = 0.14;
  _end.set(
    _vF.x + c.outX * (want - depth),
    Math.min(_vF.y + 0.1, (p.ledge.top || _vF.y) - 0.16),
    _vF.z + c.outZ * (want - depth)
  );
  swingBone(clav, _vF, _end);
}

function keepHandOnLip(p, c, arm) {
  // Palm on the outer edge, directly above this shoulder. A wide grip
  // locks the arm straight; the reference hang is compact, elbows bent down.
  const face = c.leftFoot;
  if (face && arm && arm.shoulder) {
    arm.shoulder.getWorldPosition(_vF);
    const depth = (_vF.x - face.x) * c.outX + (_vF.z - face.z) * c.outZ;
    _end.x = _vF.x + c.outX * (0.12 - depth);
    _end.z = _vF.z + c.outZ * (0.12 - depth);
  }
  const lip = (p.ledge && p.ledge.top || 0) + 0.015;
  if (_end.y < lip) _end.y = lip;
  const edge = (p.ledge && p.ledge.top || 0) + 0.04;
  if (_end.y > edge) _end.y = edge;
}

// The hang offset puts the hands on the collision lip. The hood sits above
// the hands in this clip and comes up through the cap. Tuck the neck so the
// hood clears the underside. Moving the whole mesh did that by dragging the
// hips off the bones, and the free leg stretched out beside the block.
function dropHoodUnderLip(p, c, arms, w) {
  const wll = p.ledge && p.ledge.wall;
  if (!wll || !p.wrap || p.state !== 'hang') return;
  if (p.catchT != null && p.catchT < PHYS.catchTime) return;
  p.mesh.updateMatrixWorld(true);
  // Head tipped a little off the stone, about 30 degrees, so the hood clears
  // the lip. This aimed the head 0.16 m out for 0.05 m up, near horizontal,
  // and on top of the hang clip's own look-up it threw the head right back
  // with the throat stretched at the camera. Whatever hood is still in the
  // slab after this, the drop below lowers. The aim is fixed to the neck,
  // so it does not keep folding the head each frame.
  {
    let neck = null, head = null;
    p.model.traverse(o => {
      if (!o.isBone) return;
      if (/neck$/i.test(o.name)) neck = o;
      else if (/head$/i.test(o.name)) head = o;
    });
    if (neck && head) {
      neck.getWorldPosition(_vE);
      head.getWorldPosition(_vD);
      _end.set(_vE.x + c.outX * 0.06, _vE.y + 0.11, _vE.z + c.outZ * 0.06);
      swingBone(neck, _vD, _end);
      p.mesh.updateMatrixWorld(true);
    }
  }
  // Cap underside is 3 cm under the collision lip. Stay under that, with room
  // for the hang bob, so the hood is not shaved by the slab. Any head or
  // shoulder counts — a hood that leans back off the footprint still comes
  // through the top of the slab in the shot.
  const under = p.ledge.top - 0.09;
  let high = -Infinity;
  eachProxy(p.model, /head|neck|clavicle|shoulder/, /hand|finger|forearm/, v => { if (v.y > high) high = v.y; });
  const drop = Math.min(0.2, high > under ? high - under : 0);
  // Shoulders sit so far under the lip that the arms lock straight. Raise
  // the whole rig until the hood is just under the slab, so the elbow has
  // room to bend. Bones and mesh move together.
  const ceiling = p.ledge.top - 0.04;
  if (high > 0 && high < ceiling - 0.01) {
    p._braceY = Math.min(0.18, Math.max(p._braceY || 0, ceiling - high));
  }
  // The hood is skinned to the head. Pitching the neck lifts the back of the
  // hood into the lip, so this only lowers the head bone when it itself is
  // still in the slab, and only a little.
  if (drop > 0.02) {
    let neck = null, head = null;
    p.model.traverse(o => {
      if (!o.isBone) return;
      if (/neck$/i.test(o.name)) neck = o;
      else if (/head$/i.test(o.name)) head = o;
    });
    if (neck && head) {
      head.getWorldPosition(_vD);
      if (_vD.y > under) {
        _end.copy(_vD);
        _end.y = Math.max(under, _vD.y - drop);
        _end.x += c.outX * 0.04;
        _end.z += c.outZ * 0.04;
        swingBone(neck, _vD, _end);
      }
    }
  }
  p.mesh.updateMatrixWorld(true);
  // Hands may rest on the cap. They may not occupy the slab. The palm bone
  // sits on the polygon; the fingers hang below it, so lift the target by
  // however far the lowest finger is still inside the cap.
  const capTop = p.ledge.top + 0.13, capBot = p.ledge.top - 0.05;
  const minX = (wll.x - MAP.w / 2) * S - 0.08, maxX = (wll.x + wll.w - MAP.w / 2) * S + 0.08;
  const minZ = (wll.y - MAP.h / 2) * S - 0.08, maxZ = (wll.y + wll.h - MAP.h / 2) * S + 0.08;
  let lowHand = Infinity;
  eachProxy(p.model, /hand|finger|thumb/, null, v => {
    if (v.x < minX || v.x > maxX || v.z < minZ || v.z > maxZ) return;
    if (v.y >= capTop || v.y < capBot) return;
    if (v.y < lowHand) lowHand = v.y;
  });
  const raise = lowHand < capTop ? Math.min(0.18, capTop + 0.02 - lowHand) : 0;
  for (const arm of arms) {
    const anchor = arm.side < 0 ? c.left : c.right;
    arm.hand.getWorldPosition(_vD);
    toWorld(anchor, anchor.y, _end);
    let palmUp = true;
    if (stickToSurface(_end.x, _end.y, _end.z, c.outX, c.outZ, 'top', c.depth)) {
      _end.copy(_origin);
      _palmN.copy(_nSave);
      palmUp = false;
    }
    _end.y += raise;
    keepHandOnLip(p, c, arm);
    _end.x += c.outX * 0.03;
    _end.z += c.outZ * 0.03;
    _end.lerp(_vD, 1 - w);
    bendElbow(c, arm.side);
    if (solveChain(arm, _end, _idealKnee)) layHand(arm.hand, c.intoX, c.intoZ, arm.side, palmUp ? _UP : _palmN);
  }
}

function plantOnLedge(p, spines) {
  const climbing = p.state === 'hang' || p.state === 'mantle';
  if (!climbing || !p.ledge) return;
  if (p.state === 'hang' && p._seatLedge !== p.ledge) {
    p._seatLedge = p.ledge;
    seatOnStone(p);
  }
  let w = 1;
  if (p.state === 'hang' && p.catchT != null && p.catchT < PHYS.catchTime) {
    const u = p.catchT / PHYS.catchTime;
    w = u * u * (3 - 2 * u);
  } else if (p.state === 'mantle') {
    const u = p.mantle || 0;
    w = u < 0.58 ? 1 : u > 0.86 ? 0 : 1 - (u - 0.58) / 0.28;
  }
  if (w <= 0.02) return;
  const c = ledgeContacts(p);
  const { arms, legs } = p._pose;
  if (!c || !arms.length) return;

  // Chest toward the stone. A dead hang is a straight vertical body, which is
  // the ladder silhouette; leaning in is how a person actually holds a block.
  const lean = w * (p.state === 'mantle' ? Math.max(0, 1 - (p.mantle || 0) / 0.7) : 1);
  if (spines.length && lean > 0.01 && c.leftFoot) {
    const bone = spines[0];
    bone.getWorldQuaternion(_qB);
    _vA.set(-c.outZ, 0, c.outX);
    if (_vA.lengthSq() > 1e-6) {
      _qA.setFromAxisAngle(_vA.normalize(), 0.28 * lean);
      _qB.premultiply(_qA);
      bone.parent.getWorldQuaternion(_qC);
      bone.quaternion.copy(_qC.invert().multiply(_qB));
      bone.updateMatrixWorld(true);
    }
  }
  braceBody(p, c, arms);

  const footW = p.state === 'mantle' ? w * Math.max(0, 1 - (p.mantle || 0) / 0.5) : w;
  for (const arm of arms) shoulderToLip(arm, c, p);
  p.model.updateMatrixWorld(true);
  for (const arm of arms) {
    const anchor = arm.side < 0 ? c.left : c.right;
    arm.hand.getWorldPosition(_vD);
    toWorld(anchor, anchor.y, _end);
    let palmUp = true;
    if (stickToSurface(_end.x, _end.y, _end.z, c.outX, c.outZ, 'top', c.depth)) {
      _end.copy(_origin);
      _palmN.copy(_nSave);
      palmUp = false;
    }
    keepHandOnLip(p, c, arm);
    _end.lerp(_vD, 1 - w);
    bendElbow(c, arm.side);
    if (solveChain(arm, _end, _idealKnee)) layHand(arm.hand, c.intoX, c.intoZ, arm.side, palmUp ? _UP : _palmN);
  }
  // Chest clear of the face first, so the hip the boot braces from is already
  // outside the stone. Feet plant after that pull.
  p.mesh.updateMatrixWorld(true);
  const sunk = visibleHangGap(p, c);
  if (sunk != null && sunk < 0.10) {
    const pull = Math.min(0.08, 0.10 - sunk);
    p.wrap.position.z -= pull;
    // The frame loop eases wrap.z toward _push + brace. Match that target to
    // the corrected mesh, or the next frame walks the chest back into the lip.
    p._brace = Math.max(-0.9, Math.min(0.9, p.wrap.position.z - (p._push || 0)));
    p.mesh.updateMatrixWorld(true);
    for (const arm of arms) {
      const anchor = arm.side < 0 ? c.left : c.right;
      toWorld(anchor, anchor.y, _end);
      let palmUp = true;
      if (stickToSurface(_end.x, _end.y, _end.z, c.outX, c.outZ, 'top', c.depth)) {
        _end.copy(_origin);
        _palmN.copy(_nSave);
        palmUp = false;
      }
      keepHandOnLip(p, c, arm);
      bendElbow(c, arm.side);
      if (solveChain(arm, _end, _idealKnee)) layHand(arm.hand, c.intoX, c.intoZ, arm.side, palmUp ? _UP : _palmN);
    }
  }
  // Hood under the slab before the boots brace, so the feet plant on the
  // face at the height the chest actually hangs.
  dropHoodUnderLip(p, c, arms, w);
  if (footW > 0.15 && p.ledge.wall) {
    // Both boots on THIS face, at one height, under their own hip. A ray from
    // the hip accepts the first climbable it meets, which planted one foot on
    // a neighbouring course and left the other leg in the clip.
    const wll = p.ledge.wall;
    const minX = (wll.x - MAP.w / 2) * S + 0.08;
    const maxX = (wll.x + wll.w - MAP.w / 2) * S - 0.08;
    const minZ = (wll.y - MAP.h / 2) * S + 0.08;
    const maxZ = (wll.y + wll.h - MAP.h / 2) * S - 0.08;
    const face = c.leftFoot;
    // The carved face sits inside the collision box. Plant on that stone,
    // and only on a hit that still lies on this wall.
    let planeX = face.x, planeZ = face.z;
    _origin.set(p.mesh.position.x + c.outX * 0.2, Math.max((p.z || 0) + 0.9, 0.7), p.mesh.position.z + c.outZ * 0.2);
    _dir.set(-c.outX, 0, -c.outZ);
    if (_dir.lengthSq() > 1e-6) {
      _dir.normalize();
      _ray.far = 2.8;
      _ray.set(_origin, _dir);
      const hits = _ray.intersectObjects(climbTargets(), false);
      for (let i = 0; i < hits.length; i++) {
        const h = hits[i];
        if (!surfaceVisible(h.object) || !h.face) continue;
        if (h.point.x < minX - 0.3 || h.point.x > maxX + 0.3 || h.point.z < minZ - 0.3 || h.point.z > maxZ + 0.3) continue;
        _nSave.copy(h.face.normal).transformDirection(h.object.matrixWorld);
        if (_nSave.x * c.outX + _nSave.z * c.outZ < 0.35) continue;
        planeX = h.point.x; planeZ = h.point.z;
        break;
      }
    }
    // The hips sit on the collision box while the carving is further in,
    // and that gap is what stretches the legs. Walk the whole rig toward
    // the same plane the boots use, and stop a hand's width off it.
    {
      let depthSum = 0, depthN = 0;
      for (const arm of arms) {
        const leg = legs.find(l => (arm.side < 0) === /left/i.test(l.foot.name));
        if (!leg) continue;
        leg.thigh.getWorldPosition(_vF);
        depthSum += (_vF.x - planeX) * c.outX + (_vF.z - planeZ) * c.outZ;
        depthN++;
      }
      if (depthN) {
        const depth = depthSum / depthN;
        const step = depth > 0.22 ? Math.min(0.1, depth - 0.18)
          : depth < 0.1 ? -Math.min(0.08, 0.14 - depth) : 0;
        if (step) {
          p.wrap.position.z += step;
          p._brace = Math.max(-0.9, Math.min(0.9, p.wrap.position.z - (p._push || 0)));
          p.mesh.updateMatrixWorld(true);
        }
      }
    }
    // An open knee, about 130 degrees. A right angle folded the legs up
    // under the body, a squat against the stone that read as a jump frozen
    // on the wall; a hanging climber's legs hang long with the toes on the
    // face. Both boots share that height, under their own hip.
    let ySum = 0, yN = 0;
    for (const arm of arms) {
      const leg = legs.find(l => (arm.side < 0) === /left/i.test(l.foot.name));
      if (!leg) continue;
      leg.thigh.getWorldPosition(_vF);
      leg.knee.getWorldPosition(_vE);
      leg.foot.getWorldPosition(_vD);
      if (!leg.thighLen) {
        leg.thighLen = _vF.distanceTo(_vE);
        leg.shin = _vE.distanceTo(_vD);
      }
      // The ankle sits a boot-length off the face, so the hip-to-ankle
      // span is shorter than the hip-to-wall span. Aim the 90° at the ankle.
      const horiz = Math.max(0.06, Math.abs((_vF.x - planeX) * c.outX + (_vF.z - planeZ) * c.outZ) - 0.14);
      const tl = leg.thighLen || 0.42, sl = leg.shin || 0.4;
      const reach = Math.sqrt(tl * tl + sl * sl - 2 * tl * sl * Math.cos(HANG_KNEE));
      const vert = Math.sqrt(Math.max(0.18 * 0.18, reach * reach - Math.min(horiz, reach * 0.85) ** 2));
      ySum += _vF.y - vert;
      yN++;
    }
    const footY = yN ? ySum / yN : c.footY;
    for (let pass = 0; pass < 2; pass++) {
      for (const arm of arms) {
        const leg = legs.find(l => (arm.side < 0) === /left/i.test(l.foot.name));
        if (!leg) continue;
        leg.thigh.getWorldPosition(_vF);
        const dist = (_vF.x - planeX) * c.outX + (_vF.z - planeZ) * c.outZ;
        _end.set(_vF.x - c.outX * dist, footY, _vF.z - c.outZ * dist);
        if (Math.abs(c.outX) > 0.5) _end.z = Math.max(minZ, Math.min(maxZ, _end.z));
        else _end.x = Math.max(minX, Math.min(maxX, _end.x));
        leg.foot.getWorldPosition(_vD);
        const boot = Math.max(0.05, Math.min(0.12, bootPast(p.model, _vD.x, _vD.z, c.outX, c.outZ)));
        _end.x += c.outX * boot;
        _end.z += c.outZ * boot;
        _end.y = footY;
        _end.lerp(_vD, 1 - footW);
        // Knee off the stone, halfway down, so the bend points away from the
        // face and the boot stays under the hip.
        _idealKnee.set(
          _end.x + c.outX * 0.22 - c.intoZ * arm.side * 0.05,
          (_vF.y + _end.y) * 0.5,
          _end.z + c.outZ * 0.32 + c.intoX * arm.side * 0.05
        );
        solveChain({ hand: leg.foot, elbow: leg.knee, shoulder: leg.thigh,
          upper: leg.thighLen, fore: leg.shin, side: arm.side }, _end, _idealKnee);
        // The hang clip leaves the boot stuck out sideways. Point the toe
        // down this face so the sole braces instead of kicking.
        const toe = leg.foot.children.find(o => o.isBone && /toe/i.test(o.name));
        if (toe) {
          leg.foot.getWorldPosition(_vD);
          toe.getWorldPosition(_vE);
          _end.set(_vD.x - c.outX * 0.04, _vD.y - 0.28, _vD.z - c.outZ * 0.04);
          swingBone(leg.foot, _vE, _end);
        }
      }
      if (pass === 0) p.mesh.updateMatrixWorld(true);
    }
  }
}

// World-space nudge into the mesh's local wrap. Yaw lives on the mesh, so a
// sideways push is not wrap.z.
function nudgeWrap(p, wx, wy, wz) {
  _vA.set(wx, wy, wz);
  p.mesh.getWorldQuaternion(_qB).invert();
  _vA.applyQuaternion(_qB);
  p.wrap.position.x += _vA.x;
  p.wrap.position.y += _vA.y;
  p.wrap.position.z += _vA.z;
}

// The collision pad stops the origin. A hip still enters the next stair riser
// during a step-up, and a cloak enters a prop whose mesh is proud of its
// circle. Push the skinned mesh out of the visible box. Feet are left to the
// sole lift — shoving a boot sideways walks it off the stone it stands on.
const _nearBoxes = [];
function pushOutOfMasonry(p) {
  const boxes = solidBoxes();
  if (!boxes.length || !p.wrap) return;
  p.mesh.updateMatrixWorld(true);
  const AIR = 0.04;
  const px = p.mesh.position.x, pz = p.mesh.position.z;
  // Broad phase first: almost every frame there is no masonry within reach,
  // and then there is nothing to skin at all.
  const near = _nearBoxes; near.length = 0;
  for (let b = 0; b < boxes.length; b++) {
    const box = boxes[b];
    if (box.isEmpty()) continue;
    if (box.max.x < px - 1.2 || box.min.x > px + 1.2 || box.max.z < pz - 1.2 || box.min.z > pz + 1.2) continue;
    near.push(box);
  }
  if (!near.length) return;
  let best = 0, nx = 0, nz = 0;
  // LeftLeg is the calf on this rig. The boot counts too: a step-up puts the
  // forward foot through the next riser, and the top-skin test below leaves
  // the foot that's actually standing on a slab alone.
  eachProxy(p.model, /head|neck|clavicle|spine|hips|pelvis|leg|thigh|calf|foot|toe/, /hand|finger/, _scan => {
      for (let b = 0; b < near.length; b++) {
        const box = near[b];
        if (_scan.y < box.min.y || _scan.y > box.max.y) continue;
        // The slab under the boots. Clearing it sideways throws the stance off
        // the step. The sole lift owns that surface.
        if (_scan.y > box.max.y - 0.18 && (p.z || 0) >= box.max.y - 0.25) continue;
        const minX = box.min.x - AIR, maxX = box.max.x + AIR;
        const minZ = box.min.z - AIR, maxZ = box.max.z + AIR;
        if (_scan.x < minX || _scan.x > maxX || _scan.z < minZ || _scan.z > maxZ) continue;
        const faces = [
          { pen: _scan.x - minX, nx: -1, nz: 0 },
          { pen: maxX - _scan.x, nx: 1, nz: 0 },
          { pen: _scan.z - minZ, nx: 0, nz: -1 },
          { pen: maxZ - _scan.z, nx: 0, nz: 1 },
        ];
        let face = faces[0];
        for (let f = 1; f < faces.length; f++) if (faces[f].pen < face.pen) face = faces[f];
        // The middle of a thick wall is not a silhouette clip. A stair the
        // step-up lets the body enter is about 1.7 m deep, so this still
        // catches a hip buried in the next riser.
        if (face.pen >= 1.6) continue;
        if (face.pen > best) { best = face.pen; nx = face.nx; nz = face.nz; }
      }
  });
  if (best <= 0.001) return;
  const push = Math.min(best, 0.4);
  nudgeWrap(p, nx * push, 0, nz * push);
}

// Airborne clips drop the boots through the floor, and a kicked foot reaches
// past the collision pad into a wall the origin never crosses. Lift or pull
// the mesh; the simulation origin stays where the pad put it.
function keepBodyClear(p, groundAt) {
  if (!p.wrap || !p.model || !p.mesh) return;
  const wx0 = p.wrap.position.x, wz0 = p.wrap.position.z;
  clearBody(p, groundAt);
  // CAP. Each nudge below is right for its frame, but on the ground they
  // ACCUMULATED: a boot in the next stair riser every stride pushed the mesh
  // back faster than main.js lets the offset fade, and the runner was drawn up
  // to a metre behind the body, sliding backwards up the stairs while running
  // forwards. Out of a climb or hang, these nudges may carry the mesh at most
  // 15 cm horizontally; an offset already larger (a climb's tail) only fades.
  if (p.state === 'ground' || p.state === 'air') {
    const L0 = Math.hypot(wx0, wz0), cap = Math.max(0.15, L0);
    const L1 = Math.hypot(p.wrap.position.x, p.wrap.position.z);
    if (L1 > cap) { p.wrap.position.x *= cap / L1; p.wrap.position.z *= cap / L1; }
  }
}
function clearBody(p, groundAt) {
  // The floor under the BODY. A foot that has swung into a wall used to read
  // the wall top and launch the mesh onto it.
  if (groundAt && (p.state === 'ground' || p.state === 'air')) {
    p.mesh.updateMatrixWorld(true);
    const low = lowestSole(p.model);
    const g = groundAt(p.x, p.y);
    // Hall flagstone peaks about 3.5 cm above the collision plane. Every other
    // walkable surface wears a 16 cm cap whose lid is 13 cm above the box top.
    const surface = g > 0.2 ? g + 0.14 : g + 0.04;
    if (low && low.y < surface && (p.z || 0) - low.y < 0.6) {
      const below = surface - low.y;
      if (below < 0.22) p.wrap.position.y += below;
    }
  }
  pushOutOfMasonry(p);
  p.mesh.updateMatrixWorld(true);
  // Save the facing direction before the clearance scan. That scan reuses
  // _scan for vertex positions, and feeding a world position back in as a
  // direction throws the mesh metres off the wall.
  _scan.set(0, 0, 1).applyEuler(p.mesh.rotation);
  const fl = Math.hypot(_scan.x, _scan.z);
  if (fl < 1e-4) return;
  const fx = _scan.x / fl, fz = _scan.z / fl;
  const clear = meshClearance(p.model, -fx, -fz, /foot|toe|spine|hips|pelvis|upleg/);
  const OUT = 0.04;
  if (clear != null && clear < OUT) {
    const need = Math.min(0.4, OUT - clear);
    nudgeWrap(p, -fx * need, 0, -fz * need);
  }
}

// ---------------------------------------------------------------------------
// ROOT MOTION OF THE CLIMB. The climb-top clip carries the body from a braced
// hang to standing on the block: the hips rise ~1.9 and travel ~1.5 forward
// inside the skeleton. main.js warps that motion so it starts where the hang
// left the body and ends exactly where the simulation stands it — the same
// job Unreal's motion warping does. This samples the hips track in the WRAP's
// space (the mesh frame the hang offset lives in), once per runner.
// ---------------------------------------------------------------------------
export const CLIMB_SPAN = [0.25, 2.85];          // seconds of climb-top: pull-up to standing
export function climbRootSampler(p) {
  if (p._climbRoot !== undefined) return p._climbRoot;
  p._climbRoot = null;
  if (!p.mixer || !p.wrap || !p.model) return null;
  const act = p.mixer._actions.find(a => a.getClip().name === 'climbTop');
  if (!act) return null;
  const clip = act.getClip();
  let hips = null; p.model.traverse(o => { if (!hips && o.isBone && /hips$/i.test(o.name)) hips = o; });
  const tr = clip.tracks.find(t => /hips/i.test(t.name) && /\.position$/.test(t.name));
  if (!hips || !tr || !hips.parent) return null;
  p.wrap.updateMatrixWorld(true);
  const M = new THREE.Matrix4().copy(p.wrap.matrixWorld).invert().multiply(hips.parent.matrixWorld);
  const interp = tr.createInterpolant();
  const at = t => { const r = interp.evaluate(t); return new THREE.Vector3(r[0], r[1], r[2]).applyMatrix4(M); };
  // Standing hip height, from the idle pose holdRoot records on the ground.
  // Read on demand: the sampler can exist before the runner has stood still.
  let idle = null;
  p._climbRoot = { at, r0: at(CLIMB_SPAN[0]), r1: at(CLIMB_SPAN[1]),
    get idle() { if (!idle && p._hipBind) idle = p._hipBind.clone().applyMatrix4(M); return idle; } };
  return p._climbRoot;
}

// Exact-vs-proxy probe for tools/perf checks: lowest sole and the highest
// head point, both ways, on a posed model.
export function proxyProbe(model) {
  model.updateMatrixWorld(true);
  const exact = { sole: Infinity, head: -Infinity }, prox = { sole: Infinity, head: -Infinity };
  const V = new THREE.Vector3();
  for (const sm of skinnedOf(model)) {
    sm.skeleton.update();
    for (let i = 0; i < sm.geometry.attributes.position.count; i++) {
      const n = boneName(sm, i);
      const foot = /foot|toe/.test(n), head = /head|neck/.test(n);
      if (!foot && !head) continue;
      sm.getVertexPosition(i, V); sm.localToWorld(V);
      if (foot) exact.sole = Math.min(exact.sole, V.y);
      if (head) exact.head = Math.max(exact.head, V.y);
    }
  }
  eachProxy(model, /foot|toe/, null, v => { prox.sole = Math.min(prox.sole, v.y); });
  eachProxy(model, /head|neck/, null, v => { prox.head = Math.max(prox.head, v.y); });
  return { exact, prox };
}

export function applyPosePolish(p, dt, groundAt) {
  if (!p || !p.model || !p.mixer) return;
  holdRoot(p);
  const { legs, spines } = chainsOf(p);
  p.mesh.updateMatrixWorld(true);

  // Landing compression. A few percent, on the same 0..1 the crouch blend uses,
  // so the pose, the camera dip and the silhouette agree about the impact.
  if (p.wrap) {
    const la = p.state === 'ground' ? (p.landAnim || 0) : 0;
    const sy = 1 - la * 0.045;
    p.wrap.scale.set(1 + la * 0.02, sy, 1 + la * 0.02);
    if (la > 0) p.model.updateMatrixWorld(true);
  }

  const sole = (p.rig && p.rig.sole) || IK_ANKLE;
  if (p.state === 'ground' && groundAt && legs.length) {
    const drops = [];
    for (const leg of legs) {
      leg.foot.getWorldPosition(_vD);
      const gnd = groundAt(_vD.x / S + MAP.w / 2, _vD.z / S + MAP.h / 2);
      drops.push(_vD.y - (gnd + sole));
    }
    const lowest = Math.min(...drops);
    for (let i = 0; i < legs.length; i++) {
      const stance = drops[i] < 0.12 && drops[i] - lowest < 0.035;
      solveLeg(legs[i], groundAt, dt, stance, sole);
    }
  }

  if (p.state === 'ground' || p.state === 'air') keepBodyClear(p, groundAt);

  if (p.state === 'hang' || p.state === 'mantle') {
    plantOnLedge(p, spines);
    return;
  }
  if (!spines.length || p.state === 'air' || p.state === 'vault') return;
  const omega = p.omega || 0;
  const moving = (p.mps || 0) > 0.45;
  // Moving: bank into the turn. Standing: shoulders lag the hips (the turn clip).
  const bankT = moving ? clamp(-omega * 0.02, -0.2, 0.2) : 0;
  const yawT = moving ? clamp(-omega * 0.006, -0.06, 0.06) : clamp(-omega * 0.04, -0.38, 0.38);
  const pitchT = p.state === 'ground' ? (p.landAnim || 0) * 0.28 : 0;
  p._bank = damp(p._bank || 0, bankT, 8, dt);
  p._yawL = damp(p._yawL || 0, yawT, 7, dt);
  p._pitchL = damp(p._pitchL || 0, pitchT, 10, dt);
  const n = spines.length;
  for (let i = 0; i < n; i++) {
    const k = (i + 1) / n;
    _eLean.set(p._pitchL * k, p._yawL * k, p._bank * k);
    _qA.setFromEuler(_eLean);
    spines[i].quaternion.multiply(_qA);
  }
}
