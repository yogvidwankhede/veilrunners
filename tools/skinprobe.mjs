// Measure how far the posed runner sits inside visible stone.
// Positive clearance is outside the face. Negative is penetration.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

globalThis.window = globalThis;
globalThis.self = globalThis;
if (typeof document === 'undefined' || typeof document.createElementNS !== 'function') {
  const el = () => {
    const node = {
      width: 4, height: 4, style: {},
      getContext() { return { drawImage() {}, getImageData() { return { data: new Uint8ClampedArray(64) }; }, putImageData() {} }; },
      addEventListener() {},
      removeEventListener() {},
      setAttribute() {},
    };
    return node;
  };
  globalThis.document = { createElement: el, createElementNS: () => el() };
}
if (!URL.createObjectURL) URL.createObjectURL = () => 'blob:node';
if (!URL.revokeObjectURL) URL.revokeObjectURL = () => {};

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const THREE = await import('three');
const { FBXLoader } = await import('three/examples/jsm/loaders/FBXLoader.js');
const { GLTFLoader } = await import('three/examples/jsm/loaders/GLTFLoader.js');
const { MAP, S, PHYS } = await import('../src/constants.js');
const { blockedAt, attachToLedge, findLedge, groundAt, stepVertical } = await import('../src/traversal.js');
const { stepHorizontal } = await import('../src/move.js');
const { makeFbxLocomotion, calibrateRig, applyPosePolish } = await import('../src/fbxrunner.js');
const { registerClimbable, climbTargets } = await import('../src/climbable.js');
const { NodeIO } = await import('@gltf-transform/core');
const { ALL_EXTENSIONS } = await import('@gltf-transform/extensions');

const PAD = PHYS.bodyRadius / S;
const loader = new FBXLoader();
const parseFbx = file => {
  const buf = fs.readFileSync(path.join(ROOT, file));
  const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  return loader.parse(ab, '');
};

const sources = {
  base: 'assets/anim/breathing-idle.fbx',
  jump: 'assets/anim/jump.fbx',
  falling: 'assets/anim/falling.fbx',
  hangIdle: 'assets/anim/hang-idle.fbx',
};
const base = parseFbx(sources.base);
let skin = null;
base.traverse(o => { if (o.isSkinnedMesh && !skin) skin = o; });
if (!skin) throw new Error('no skin');
const clips = { idle: base.animations[0] };
clips.idle.name = 'idle';
const boneNames = new Set(skin.skeleton.bones.map(b => b.name));
for (const [name, file] of Object.entries(sources)) {
  if (name === 'base') continue;
  const g = parseFbx(file);
  const c = g.animations[0];
  if (!c) continue;
  c.name = name;
  clips[name] = c;
}
console.log('bones', boneNames.size, 'clips', Object.keys(clips).join(','));

const scene = new THREE.Scene();
const src = base;
const bb = new THREE.Box3().setFromObject(src);
const size = new THREE.Vector3(); bb.getSize(size);
const scale = 1.85 / (size.y || 1.9);
const feet = bb.min.y * scale;
const cx = (bb.min.x + bb.max.x) / 2 * scale;
const cz = (bb.min.z + bb.max.z) / 2 * scale;
const model = src;
model.scale.setScalar(scale);
model.position.set(-cx, -feet, -cz);
const wrap = new THREE.Group(); wrap.add(model);
const mesh = new THREE.Group(); mesh.add(wrap); scene.add(mesh);
const mixer = new THREE.AnimationMixer(model);
const anim = makeFbxLocomotion(mixer, clips);
const p = {
  id: 0, mesh, model, wrap, mixer, state: 'ground', z: 0, vz: 0, angle: 0,
  x: 200, y: 400, ledge: null, mantle: 0, catchT: null, shimmying: false,
  mps: 0, omega: 0, crouch: false, phase: 0, gait: 0, game: { t: 0 },
  cd: {}, landAnim: 0,
};
mesh.anim = anim;
p.rig = calibrateRig(mixer, anim, model, mesh);
model.position.y -= p.rig.drop;
p.rig.lift -= p.rig.drop;
console.log('rig', {
  drop: +p.rig.drop.toFixed(3),
  lift: +p.rig.lift.toFixed(3),
  reach: +p.rig.reach.toFixed(3),
  sole: p.rig.sole,
  scale: +scale.toFixed(4),
  bind: { x: +size.x.toFixed(3), y: +size.y.toFixed(3), z: +size.z.toFixed(3) },
});

const skinned = [];
model.traverse(o => { if (o.isSkinnedMesh) skinned.push(o); });
const v = new THREE.Vector3();
const boneOf = new Map();
function region(sm, i) {
  const key = sm.uuid + ':' + i;
  const hit = boneOf.get(key);
  if (hit) return hit;
  const si = sm.geometry.attributes.skinIndex;
  const sw = sm.geometry.attributes.skinWeight;
  let best = 0, bi = 0;
  for (let k = 0; k < 4; k++) {
    const w = sw.getComponent(i, k);
    if (w > best) { best = w; bi = si.getComponent(i, k); }
  }
  const name = (sm.skeleton.bones[bi]?.name || '').toLowerCase();
  let r = 'other';
  if (/hand|finger|thumb/.test(name)) r = 'hand';
  else if (/forearm|arm|shoulder|clavicle/.test(name)) r = 'arm';
  else if (/foot|toe/.test(name)) r = 'foot';
  else if (/leg|calf|thigh|upleg/.test(name)) r = 'thigh';
  else if (/hip|pelvis/.test(name)) r = 'hip';
  else if (/spine|chest|neck|head/.test(name)) r = 'torso';
  boneOf.set(key, r);
  return r;
}

function sample() {
  mesh.updateMatrixWorld(true);
  for (const sm of skinned) sm.skeleton.update();
  const pts = [];
  for (const sm of skinned) {
    const n = sm.geometry.attributes.position.count;
    for (let i = 0; i < n; i++) {
      sm.getVertexPosition(i, v);
      sm.localToWorld(v);
      pts.push({ x: v.x, y: v.y, z: v.z, r: region(sm, i) });
    }
  }
  return pts;
}

function faceCharacter(nx, ny) {
  // Face INTO the wall. Outward normal (nx,ny) points from face toward the body.
  p.angle = Math.atan2(-ny, -nx);
  const ia = p.angle;
  mesh.rotation.y = Math.atan2(Math.cos(ia), Math.sin(ia));
}

function place(gx, gy, gz) {
  p.x = gx; p.y = gy; p.z = gz;
  const wx = (gx - MAP.w / 2) * S;
  const wz = (gy - MAP.h / 2) * S;
  mesh.position.set(wx, gz, wz);
}

// Signed distance of a world point to a vertical face. Positive is outside.
function gapOf(pt, faceX, faceZ, outX, outZ) {
  return (pt.x - faceX) * outX + (pt.z - faceZ) * outZ;
}

function report(label, pts, face, originGap) {
  let min = Infinity, who = null;
  const by = {};
  for (const pt of pts) {
    const g = gapOf(pt, face.x, face.z, face.ox, face.oz);
    if (g < min) { min = g; who = pt; }
    const b = by[pt.r] || (by[pt.r] = Infinity);
    if (g < b) by[pt.r] = g;
  }
  const feet = pts.filter(q => q.r === 'foot');
  const minY = feet.reduce((m, q) => Math.min(m, q.y - (p.z || 0)), Infinity);
  const bits = Object.entries(by).sort((a, b) => a[1] - b[1])
    .map(([k, g]) => `${k} ${(g * 100).toFixed(1)}cm`).join('  ');
  console.log(`\n${label}`);
  console.log(`  origin-to-face ${(originGap * 100).toFixed(1)}cm   PAD ${(PAD * S * 100).toFixed(1)}cm`);
  console.log(`  outermost ${(min * 100).toFixed(1)}cm (${who && who.r})   sole-vs-origin ${(minY * 100).toFixed(1)}cm`);
  console.log(`  ${bits}`);
  return { min, who: who && who.r, by, minY, originGap };
}

function flushToward(x, y, z, dx, dy) {
  let lo = 0, hi = 1;
  const x0 = x, y0 = y;
  // hi is deep inside, lo is the start (must be free)
  if (blockedAt(x0, y0, z)) throw new Error(`start blocked ${x0},${y0}`);
  for (let i = 0; i < 24; i++) {
    const t = (lo + hi) / 2;
    const nx = x0 + dx * t, ny = y0 + dy * t;
    if (blockedAt(nx, ny, z)) hi = t; else lo = t;
  }
  return { x: x0 + dx * lo, y: y0 + dy * lo };
}

function settle(state, extra, n = 30) {
  Object.assign(p, extra);
  p.state = state;
  for (let i = 0; i < n; i++) {
    anim(0, 0, false, p.mps || 0, p, 1 / 60);
    mixer.update(1 / 60);
  }
  mesh.updateMatrixWorld(true);
}

function localExtents(pts) {
  mesh.updateMatrixWorld(true);
  const inv = mesh.matrixWorld.clone().invert();
  let maxZ = -Infinity, minZ = Infinity, minY = Infinity, maxR = 0;
  const tmp = new THREE.Vector3();
  for (const pt of pts) {
    tmp.set(pt.x, pt.y, pt.z).applyMatrix4(inv);
    maxZ = Math.max(maxZ, tmp.z);
    minZ = Math.min(minZ, tmp.z);
    minY = Math.min(minY, tmp.y);
    maxR = Math.max(maxR, Math.hypot(tmp.x, tmp.z));
  }
  return {
    maxZ: +maxZ.toFixed(3), minZ: +minZ.toFixed(3),
    minY: +minY.toFixed(3), maxR: +maxR.toFixed(3),
  };
}

function boneLocal(pat) {
  mesh.updateMatrixWorld(true);
  const out = [];
  model.traverse(o => {
    if (!o.isBone || !pat.test(o.name.toLowerCase())) return;
    o.getWorldPosition(v);
    mesh.worldToLocal(v);
    out.push(`${o.name} (${v.x.toFixed(3)},${v.y.toFixed(3)},${v.z.toFixed(3)})`);
  });
  return out.join(' | ');
}

// ---------- standing poses ----------
console.log('\n==== SKIN EXTENTS (mesh local, +Z is facing) ====');
wrap.position.set(0, 0, 0);
settle('ground', { vz: 0, catchT: null, ledge: null }, 40);
console.log('idle bones', boneLocal(/foot$|hand$|hips$/));
applyPosePolish(p, 1 / 60, groundAt);
let pts = sample();
console.log('idle', localExtents(pts));
{
  const feet = [];
  model.traverse(o => { if (o.isBone && /foot$/i.test(o.name)) { o.getWorldPosition(v); feet.push(v.y); } });
  console.log('foot bone world Y', feet.map(n => n.toFixed(3)).join(','), 'mesh Y', mesh.position.y.toFixed(3));
}

// jump clip window [0, 0.36] as vz falls from jumpSpeed to 0, then falling
const jumpSamples = [];
for (const u of [0, 0.25, 0.5, 0.75, 1]) {
  p.state = 'air'; p.vz = PHYS.jumpSpeed * (1 - u); p.jumpHeld = true;
  wrap.position.set(0, 0, 0);
  place(200, 400, 0);
  p.angle = 0;
  mesh.rotation.y = Math.atan2(1, 0);
  for (let i = 0; i < 4; i++) { anim(0, 0, false, 0, p, 1 / 60); mixer.update(1 / 60); }
  const ptsJ = sample();
  const e = localExtents(ptsJ);
  const inv = mesh.matrixWorld.clone().invert();
  const tmp = new THREE.Vector3();
  let who = '', best = -Infinity;
  const by = {};
  for (const pt of ptsJ) {
    tmp.set(pt.x, pt.y, pt.z).applyMatrix4(inv);
    by[pt.r] = Math.max(by[pt.r] || -Infinity, tmp.z);
    if (tmp.z > best) { best = tmp.z; who = pt.r; }
  }
  jumpSamples.push({ u, vz: +p.vz.toFixed(2), who, by, ...e });
}
console.log('jump window', jumpSamples.map(s => {
  const parts = Object.entries(s.by).sort((a, b) => b[1] - a[1]).map(([k, z]) => `${k} ${z.toFixed(2)}`).join(' ');
  return `u${s.u} vz${s.vz} +Z${s.maxZ.toFixed(3)} (${s.who}) feetY${s.minY.toFixed(3)} | ${parts}`;
}).join('\n  '));

p.state = 'air'; p.vz = -4; p.jumpHeld = true;
for (let i = 0; i < 40; i++) { anim(0, 0, false, 0, p, 1 / 60); mixer.update(1 / 60); }
console.log('falling settled', localExtents(sample()));

p.state = 'hang'; p.vz = 0; p.catchT = 1; p.ledge = null;
for (let i = 0; i < 40; i++) { anim(0, 0, false, 0, p, 1 / 60); mixer.update(1 / 60); }
console.log('hang bones', boneLocal(/hand$|hips$|spine/));
console.log('hang extents', localExtents(sample()));

// ---------- walls ----------
function wallFace(w, side) {
  // side: 'e','w','n','s' — the face, and the outward normal (toward the player)
  if (side === 'w') return { gx: w.x, gy: w.y + w.h / 2, ox: -1, oz: 0, nx: -1, ny: 0, approach: { x: w.x - 40, y: w.y + w.h / 2 } };
  if (side === 'e') return { gx: w.x + w.w, gy: w.y + w.h / 2, ox: 1, oz: 0, nx: 1, ny: 0, approach: { x: w.x + w.w + 40, y: w.y + w.h / 2 } };
  if (side === 'n') return { gx: w.x + w.w / 2, gy: w.y, ox: 0, oz: -1, nx: 0, ny: -1, approach: { x: w.x + w.w / 2, y: w.y - 40 } };
  return { gx: w.x + w.w / 2, gy: w.y + w.h, ox: 0, oz: 1, nx: 0, ny: 1, approach: { x: w.x + w.w / 2, y: w.y + w.h + 40 } };
}
function worldFace(f) {
  const wx = (f.gx - MAP.w / 2) * S;
  const wz = (f.gy - MAP.h / 2) * S;
  return { x: wx, z: wz, ox: f.ox, oz: f.oz };
}

function standAt(label, w, side, z = 0) {
  const f = wallFace(w, side);
  const dx = f.nx, dy = f.ny; // outward; walk against it
  // Slide along the face until the approach cell is actually free, then walk in.
  let pos = null;
  const alongX = Math.abs(f.nx) > 0.5;
  for (let i = 0; i < 80 && !pos; i++) {
    const shift = (i % 2 === 0 ? 1 : -1) * Math.ceil(i / 2) * 8;
    const x = alongX ? f.approach.x : f.gx + shift;
    const y = alongX ? f.gy + shift : f.approach.y;
    if (blockedAt(x, y, z)) continue;
    const candidate = flushToward(x, y, z, -dx * 120, -dy * 120);
    const gap = ((candidate.x - f.gx) * f.nx + (candidate.y - f.gy) * f.ny) * S;
    if (Math.abs(gap - PAD * S) < 0.04) pos = candidate;
  }
  if (!pos) throw new Error(`no flush contact for ${label}`);
  console.log(`  flush ${pos.x.toFixed(2)},${pos.y.toFixed(2)}`);
  place(pos.x, pos.y, z);
  faceCharacter(f.nx, f.ny);
  wrap.position.set(0, 0, 0);
  settle('ground', { vz: 0, ledge: null, catchT: null, x: pos.x, y: pos.y, z }, 20);
  place(pos.x, pos.y, z);
  faceCharacter(f.nx, f.ny);
  for (let i = 0; i < 8; i++) applyPosePolish(p, 1 / 60, groundAt);
  const pts = sample();
  const face = worldFace(f);
  const origin = gapOf({ x: mesh.position.x, z: mesh.position.z }, face.x, face.z, face.ox, face.oz);
  return report(`STAND ${label} @ (${pos.x.toFixed(2)},${pos.y.toFixed(2)},${z})`, pts, face, origin);
}

const shellW = MAP.walls.find(w => w.tag === 'shell' && w.x === 0 && w.w === 40);
const shellS = MAP.walls.find(w => w.tag === 'shell' && w.y === 860);
// east stair pier: the tall eastern step. stair(120,56,210,84) step i=5 is x=270..301, y=56..140, top~2.14
const stairs = MAP.walls.filter(w => w.tag === 'stair' && w.y === 56);
stairs.sort((a, b) => a.x - b.x);
const pier = stairs[stairs.length - 2];
console.log('\npier box', pier, 'shell west', shellW && shellW.x + shellW.w);

console.log('\n==== STANDING ====');
const standWall = standAt('west hall shell', shellW, 'e', 0);
const standPier = standAt('east stair pier south', pier, 's', 0);

// ---------- jump into the shell, held jump ----------
console.log('\n==== JUMP INTO WEST WALL ====');
addBox(shellW);
{
  const faceG = shellW.x + shellW.w;
  const face = worldFace(wallFace(shellW, 'e'));
  const me = {
    x: faceG + 50, y: 300, z: 0, vx: 0, vy: 0, angle: Math.PI, state: 'ground',
    mps: 4, vz: 0, coyote: 0.12, jumpHeld: true, game: { t: 0 }, ledge: null, regrab: 0,
  };
  let jumped = false, apex = null, down = null, kick = null, worstOrigin = Infinity;
  let crossed = 0;
  const log = [];
  for (let t = 0; t < 180; t++) {
    const before = me.x;
    if (!jumped && me.x < faceG + 22) {
      me.vz = PHYS.jumpSpeed; me.state = 'air'; me.jumpHeld = true; jumped = true;
    }
    stepHorizontal(me, { mx: -1, my: 0, sprint: true, crouch: false, locked: false, vault: false }, 1 / 60);
    if (me.state !== 'vault') stepVertical(me, 1 / 60, { up: 0, down: 0, side: 0 });
    const origin = (me.x - faceG) * S;
    if (origin < worstOrigin) worstOrigin = origin;
    if (before > faceG && me.x < faceG) crossed++;
    // endpoint was legal but the segment crossed the UNPADDED face with the body radius
    if (me.state === 'air' && Math.abs(me.vz) < 0.4 && !apex) apex = { t, x: me.x, z: me.z, vz: me.vz, origin };
    if (me.state === 'air' && me.vz > 1.2 && me.vz < 1.7 && origin < 0.9 && !kick) kick = { t, x: me.x, z: me.z, vz: me.vz, origin };
    if (me.state === 'air' && me.vz < -2 && me.z < 0.5 && !down) down = { t, x: me.x, z: me.z, vz: me.vz, origin };
    if (t % 8 === 0 || origin < 0.9) log.push(`t${t} x${me.x.toFixed(2)} z${me.z.toFixed(2)} vz${(me.vz||0).toFixed(2)} ${me.state} origin${(origin*100).toFixed(1)}cm`);
    if (jumped && me.state === 'ground' && t > 20) break;
  }
  console.log(log.join('\n'));
  console.log('worst origin clearance', (worstOrigin * 100).toFixed(1), 'cm; face crossings', crossed);
  console.log('apex', apex, 'down', down);

  function poseAir(sampleAt, tag) {
    place(sampleAt.x, 400, sampleAt.z);
    faceCharacter(1, 0); // outward normal of east face is +x; we face west, into the wall
    p.angle = Math.PI;
    mesh.rotation.y = Math.atan2(Math.cos(Math.PI), Math.sin(Math.PI));
    wrap.position.set(0, 0, 0);
    p.state = 'air'; p.vz = sampleAt.vz; p.jumpHeld = true; p.ledge = null;
    for (let i = 0; i < 8; i++) {
      anim(0, 0, false, 0, p, 1 / 60);
      mixer.update(1 / 60);
      applyPosePolish(p, 1 / 60, groundAt);
      place(sampleAt.x, 400, sampleAt.z);
      mesh.rotation.y = Math.atan2(Math.cos(Math.PI), Math.sin(Math.PI));
    }
    const pts = sample();
    const origin = (sampleAt.x - faceG) * S;
    console.log(`  wrap y ${wrap.position.y.toFixed(3)} z ${wrap.position.z.toFixed(3)}`);
    report(`JUMP ${tag}`, pts, face, origin);
  }
  poseAir({ x: faceG + PAD, z: 0, vz: PHYS.jumpSpeed }, 'takeoff');
  if (kick) poseAir(kick, 'kick');
  if (apex) poseAir(apex, 'apex');
  if (down) poseAir(down, 'descent');
}

// corner / nosing: southeast corner of the pier, airborne
console.log('\n==== JUMP INTO PIER CORNER ====');
{
  const faceG = pier.y + pier.h;
  const faceX = pier.x + pier.w;
  const me = {
    x: faceX + 30, y: faceG + 30, z: 0, vx: 0, vy: 0, angle: Math.PI * 0.75, state: 'ground',
    mps: 4, vz: 0, coyote: 0.12, jumpHeld: true, game: { t: 0 }, ledge: null, regrab: 0,
  };
  let jumped = false, minOx = Infinity, minOy = Infinity, tunnel = 0;
  for (let t = 0; t < 200; t++) {
    const bx = me.x, by = me.y;
    if (!jumped && me.x < faceX + 20 && me.y < faceG + 20) {
      me.vz = PHYS.jumpSpeed; me.state = 'air'; jumped = true;
    }
    stepHorizontal(me, { mx: -0.7, my: -0.7, sprint: true, locked: false, vault: false }, 1 / 60);
    if (me.state !== 'vault') stepVertical(me, 1 / 60, { up: 0, down: 0, side: 0 });
    const ox = (me.x - faceX) * S, oy = (me.y - faceG) * S;
    if (ox < minOx) minOx = ox;
    if (oy < minOy) minOy = oy;
    // segment crossed a face while both endpoints tested free — the sweep hole
    const midBlocked = blockedAt((bx + me.x) / 2, (by + me.y) / 2, me.z);
    const endFree = !blockedAt(me.x, me.y, me.z);
    const startFree = !blockedAt(bx, by, me.z);
    if (startFree && endFree && midBlocked) tunnel++;
    if (jumped && me.state === 'ground' && t > 30) break;
  }
  console.log(`pier corner origin gap east ${(minOx*100).toFixed(1)}cm south ${(minOy*100).toFixed(1)}cm  mid-segment tunnels ${tunnel}`);
}

// ---------- climbing ----------
console.log('\n==== CLIMB ====');
function addBox(w) {
  const cX = (w.x + w.w / 2 - MAP.w / 2) * S;
  const cZ = (w.y + w.h / 2 - MAP.h / 2) * S;
  const geo = new THREE.BoxGeometry(w.w * S, w.top, w.h * S);
  const box = new THREE.Mesh(geo, new THREE.MeshStandardMaterial());
  box.position.set(cX, w.top / 2, cZ);
  scene.add(box);
  registerClimbable(box, false);
  const cap = new THREE.Mesh(new THREE.BoxGeometry(w.w * S + 0.10, 0.16, w.h * S + 0.10), new THREE.MeshStandardMaterial());
  cap.position.set(cX, w.top + 0.05, cZ);
  scene.add(cap);
  registerClimbable(cap, false);
  return { box, cap };
}

const pillar = MAP.walls.find(w => w.tag === 'pillar' && w.x === 90 && w.y === 150);
const gallery = MAP.walls.find(w => w.tag === 'gallery' && w.x === 330 && w.y === 56);
addBox(pillar);
addBox(gallery);
addBox(pier);
climbTargets();

// Hang offset, copied from main.js so the probe measures the shipped pose.
function applyHangWrap(dt = 1 / 60) {
  const sstep = u => { const x = Math.min(1, Math.max(0, u)); return x * x * (3 - 2 * x); };
  const mantle = p.state === 'mantle' ? (p.mantle || 0) : 0;
  const rise = mantle > 0 ? sstep(mantle / 0.62) : 0;
  const over = mantle > 0 ? sstep((mantle - 0.45) / 0.55) : 0;
  let hold = 1;
  if (p.state === 'hang' && p.catchT != null && p.catchT < PHYS.catchTime)
    hold = sstep(p.catchT / PHYS.catchTime);
  else if (p.state === 'mantle') hold = 1 - over;
  const gap = ((p.x - p.ledge.ex) * p.ledge.nx + (p.y - p.ledge.ey) * p.ledge.ny) * S;
  const chest = 0.15 * hold * (1 - rise);
  const CLEAR = 0.24;
  let push = (gap - p.rig.reach) * hold;
  push = gap > CLEAR ? Math.min(push, gap - CLEAR) : 0;
  p._push = push;
  push += (p._brace || 0) * hold;
  let wy = (PHYS.hangBelow - p.rig.lift) * hold + chest;
  p._lift = wy;
  wy += (p._braceY || 0) * hold;
  const k = 1 - Math.exp(-10 * dt);
  wrap.position.x += (0 - wrap.position.x) * k;
  wrap.position.y += (wy - wrap.position.y) * k;
  wrap.position.z += (push - wrap.position.z) * k;
  return { gap, push: wrap.position.z, wy: wrap.position.y, brace: p._brace, braceY: p._braceY };
}

function hangOn(label, w, side) {
  const f = wallFace(w, side);
  const grab = {
    wall: w, top: w.top,
    ex: Math.abs(f.nx) > 0.5 ? f.gx : w.x + w.w / 2,
    ey: Math.abs(f.ny) > 0.5 ? f.gy : w.y + w.h / 2,
    nx: f.nx, ny: f.ny,
  };
  // park on the middle of that face
  if (Math.abs(f.nx) > 0.5) grab.ey = w.y + w.h / 2;
  else grab.ex = w.x + w.w / 2;
  p.catchT = 1; p._seatLedge = null; p._brace = 0; p._braceY = 0;
  wrap.position.set(0, 0, 0);
  attachToLedge(p, grab);
  p.catchT = 1; // settled hang, not the reach
  place(p.x, p.y, p.z);
  faceCharacter(f.nx, f.ny);
  let last = null;
  for (let i = 0; i < 50; i++) {
    p.state = 'hang';
    anim(0, 0, false, 0, p, 1 / 60);
    mixer.update(1 / 60);
    last = applyHangWrap(1 / 60);
    applyPosePolish(p, 1 / 60, groundAt);
    place(p.x, p.y, p.z);
    faceCharacter(f.nx, f.ny);
  }
  const pts = sample();
  const face = worldFace(f);
  const origin = gapOf({ x: mesh.position.x, z: mesh.position.z }, face.x, face.z, face.ox, face.oz);
  console.log(`  wrap z ${last.push.toFixed(3)} y ${last.wy.toFixed(3)} gap ${last.gap.toFixed(3)} brace ${(last.brace||0).toFixed(3)} braceY ${(last.braceY||0).toFixed(3)}`);
  const bones = [];
  model.traverse(o => {
    if (!o.isBone) return;
    const n = o.name.toLowerCase();
    if (!/hips$|spine2$|hand$|foot$|thigh$|upleg$/.test(n)) return;
    o.getWorldPosition(v);
    const g = gapOf(v, face.x, face.z, face.ox, face.oz);
    bones.push(`${o.name.replace('mixamorig','')} ${(g*100).toFixed(1)}cm`);
  });
  console.log('  bones', bones.join('  '));
  // also the lip plane (top of the wall) for the hands
  const lip = w.top;
  const hands = pts.filter(q => q.r === 'hand');
  const handLip = hands.reduce((m, q) => Math.min(m, Math.abs(q.y - lip)), Infinity);
  console.log(`  hand-to-lip ${hands.length ? (handLip * 100).toFixed(1) : 'n/a'}cm  (n=${hands.length})`);
  const sunk = pts.filter(q => gapOf(q, face.x, face.z, face.ox, face.oz) < 0 && (q.r === 'hand' || q.r === 'arm'));
  const below = sunk.filter(q => q.y < lip - 0.04);
  const over = sunk.filter(q => q.y >= lip - 0.04);
  const minBelow = below.reduce((m, q) => Math.min(m, q.y - lip), 0);
  console.log(`  sunk hand/arm ${sunk.length}  over-lip ${over.length}  below-lip ${below.length}  deepest ${(minBelow * 100).toFixed(1)}cm`);
  // The visible lip is the cap: 16 cm thick, centered 5 cm above the collision
  // top, and 5 cm proud of every face. A vertex can be outside the box face
  // and still inside this slab.
  const cap = {
    minX: (w.x - MAP.w / 2) * S - 0.05, maxX: (w.x + w.w - MAP.w / 2) * S + 0.05,
    minZ: (w.y - MAP.h / 2) * S - 0.05, maxZ: (w.y + w.h - MAP.h / 2) * S + 0.05,
    minY: w.top - 0.03, maxY: w.top + 0.13,
  };
  const depthIn = (pt, box) => {
    if (pt.x < box.minX || pt.x > box.maxX || pt.z < box.minZ || pt.z > box.maxZ || pt.y < box.minY || pt.y > box.maxY) return null;
    return -Math.min(pt.x - box.minX, box.maxX - pt.x, pt.z - box.minZ, box.maxZ - pt.z, pt.y - box.minY, box.maxY - pt.y);
  };
  const worst = {};
  let hoodY = -Infinity;
  for (const pt of pts) {
    if (pt.r === 'torso' || pt.r === 'head') hoodY = Math.max(hoodY, pt.y);
    const d = depthIn(pt, cap);
    if (d == null) continue;
    if (worst[pt.r] == null || d < worst[pt.r]) worst[pt.r] = d;
  }
  const bits = Object.entries(worst).map(([k, d]) => `${k} ${(d * 100).toFixed(1)}cm`).join('  ') || 'none';
  console.log(`  CAP volume y[${cap.minY.toFixed(2)},${cap.maxY.toFixed(2)}] hoodTop ${(hoodY * 100).toFixed(1)}cm (lip ${(lip * 100).toFixed(1)} capTop ${(cap.maxY * 100).toFixed(1)}) inside ${bits}`);
  const joints = {};
  model.traverse(o => {
    if (!o.isBone) return;
    const n = o.name.toLowerCase();
    if (/hips$|spine2$|head$|leftfoot$|rightfoot$|leftleg$|rightleg$|leftupleg$|rightupleg$|leftforearm$|rightforearm$|leftarm$|rightarm$|lefthand$|righthand$/.test(n)) {
      const p3 = new THREE.Vector3();
      o.getWorldPosition(p3);
      joints[n.replace('mixamorig', '')] = p3;
    }
  });
  const hip = joints.hips, chest = joints.spine2, head = joints.head;
  if (hip && chest) {
    const dx = chest.x - hip.x, dy = chest.y - hip.y, dz = chest.z - hip.z;
    const horiz = Math.hypot(dx, dz);
    const pitch = Math.atan2(horiz, dy) * 180 / Math.PI;
    console.log(`  TORSO hip→chest pitch ${pitch.toFixed(1)}° off vertical  chestY ${(chest.y*100).toFixed(1)} hipY ${(hip.y*100).toFixed(1)} headY ${head ? (head.y*100).toFixed(1) : '?'}`);
  }
  for (const side of ['left', 'right']) {
    const shoulder = joints[side + 'arm'], elbow = joints[side + 'forearm'], hand = joints[side + 'hand'];
    if (shoulder && elbow && hand) {
      const a = shoulder.clone().sub(elbow), b = hand.clone().sub(elbow);
      const bend = Math.acos(Math.max(-1, Math.min(1, a.dot(b) / (a.length() * b.length())))) * 180 / Math.PI;
      const reach = shoulder.distanceTo(elbow) + elbow.distanceTo(hand);
      console.log(`  ${side} elbow ${bend.toFixed(0)}° span ${(shoulder.distanceTo(hand)*100).toFixed(0)} arm ${(reach*100).toFixed(0)} handY ${(hand.y*100).toFixed(0)} shoulderY ${(shoulder.y*100).toFixed(0)} dXZ ${((hand.x-shoulder.x)*100).toFixed(0)},${((hand.z-shoulder.z)*100).toFixed(0)}`);
    }
    const foot = joints[side + 'foot'], knee = joints[side + 'leg'], thigh = joints[side + 'upleg'];
    if (!foot || !knee || !thigh) continue;
    const g = gapOf(foot, face.x, face.z, face.ox, face.oz);
    const a = thigh.clone().sub(knee), b = foot.clone().sub(knee);
    const bend = Math.acos(Math.max(-1, Math.min(1, a.dot(b) / (a.length() * b.length())))) * 180 / Math.PI;
    console.log(`  ${side} foot gap ${(g*100).toFixed(1)}cm y ${(foot.y*100).toFixed(1)}cm knee ${bend.toFixed(0)}° (180=straight)`);
  }
  return report(`HANG ${label}`, pts, face, origin);
}

hangOn('hall pillar south', pillar, 's');
hangOn('gallery south lip', gallery, 's');

console.log('\n==== FLOOR SOLES (visible flagstone peaks at +3.5cm) ====');
{
  wrap.position.set(0, 0, 0);
  place(200, 400, 0);
  p.angle = 0; mesh.rotation.y = Math.atan2(1, 0);
  p.ledge = null; p.catchT = null; p.state = 'ground'; p.vz = 0;
  const kEase = 1 - Math.exp(-10 / 60);
  for (let i = 0; i < 40; i++) {
    anim(0, 0, false, 0, p, 1 / 60);
    mixer.update(1 / 60);
    wrap.position.x += (0 - wrap.position.x) * kEase;
    wrap.position.y += (0 - wrap.position.y) * kEase;
    wrap.position.z += (0 - wrap.position.z) * kEase;
    applyPosePolish(p, 1 / 60, groundAt);
    place(200, 400, 0);
    mesh.rotation.y = Math.atan2(1, 0);
  }
  const ptsF = sample();
  let minAll = Infinity, minFoot = Infinity, minHip = Infinity, minChest = Infinity;
  for (const pt of ptsF) {
    minAll = Math.min(minAll, pt.y);
    if (pt.r === 'foot') minFoot = Math.min(minFoot, pt.y);
    if (pt.r === 'hip') minHip = Math.min(minHip, pt.y);
    if (pt.r === 'torso') minChest = Math.min(minChest, pt.y);
  }
  console.log(`  all ${(minAll*100).toFixed(1)}cm  boot ${(minFoot*100).toFixed(1)}cm  hip ${(minHip*100).toFixed(1)}cm  chest ${(minChest*100).toFixed(1)}cm  wrapY ${wrap.position.y.toFixed(3)}`);
  console.log(`  vs flagstone peak: boot ${((minFoot - 0.035)*100).toFixed(1)}cm  (negative is inside the stone)`);
}

console.log('\n==== SIDEWAYS AGAINST STAIR CAP AND CHAMBER COURSE ====');
{
  // Stair south face is one plane; the cap sticks 5cm past it. Stand PAD off
  // the box, body facing ALONG the wall so the hip is the part in the stone.
  const stair = stairs[3];
  const faceG = stair.y + stair.h;
  const x = stair.x + stair.w / 2;
  const y = faceG + PAD;
  place(x, y, 0);
  // face east, wall is to the south (character's right if facing east? angle 0 faces +X)
  p.angle = 0;
  mesh.rotation.y = Math.atan2(Math.cos(0), Math.sin(0));
  wrap.position.set(0, 0, 0);
  p.state = 'ground'; p.ledge = null; p.z = 0;
  for (let i = 0; i < 12; i++) applyPosePolish(p, 1 / 60, groundAt);
  const ptsS = sample();
  const capZ = (faceG - MAP.h / 2) * S + 0.05; // proud south
  const boxZ = (faceG - MAP.h / 2) * S;
  let hip = Infinity, thigh = Infinity, chest = Infinity, hood = Infinity, boot = Infinity;
  let hoodY = -Infinity;
  for (const pt of ptsS) {
    const gCap = pt.z - capZ; // positive is south of the cap, outside
    if (pt.r === 'hip') hip = Math.min(hip, gCap);
    if (pt.r === 'thigh') thigh = Math.min(thigh, gCap);
    if (pt.r === 'torso') { chest = Math.min(chest, gCap); hoodY = Math.max(hoodY, pt.y); }
    if (pt.r === 'foot') boot = Math.min(boot, pt.y);
  }
  console.log(`  stair side @ (${x.toFixed(0)},${y.toFixed(0)}) cap gap hip ${(hip*100).toFixed(1)} thigh ${(thigh*100).toFixed(1)} chest ${(chest*100).toFixed(1)} bootY ${(boot*100).toFixed(1)} hoodY ${(hoodY*100).toFixed(1)}`);
  // facing the stair
  faceCharacter(0, 1);
  wrap.position.set(0, 0, 0);
  for (let i = 0; i < 12; i++) applyPosePolish(p, 1 / 60, groundAt);
  const ptsN = sample();
  hip = thigh = chest = Infinity;
  for (const pt of ptsN) {
    const gCap = (pt.z - capZ);
    if (pt.r === 'hip') hip = Math.min(hip, gCap);
    if (pt.r === 'thigh') thigh = Math.min(thigh, gCap);
    if (pt.r === 'torso') chest = Math.min(chest, gCap);
  }
  console.log(`  stair facing cap gap hip ${(hip*100).toFixed(1)} thigh ${(thigh*100).toFixed(1)} chest ${(chest*100).toFixed(1)} box would be +5cm more`);

  // Chamber footing course, 26cm proud of the box. Player on the 5m floor,
  // PAD off the box. Hip height is inside the course (5.0..5.9).
  const cw = MAP.walls.find(w => w.tag === 'chamberwall' && w.x === 550 && w.y === 134);
  const fy = cw.y + cw.h + PAD;
  const fx = cw.x + cw.w / 2;
  place(fx, fy, 5);
  faceCharacter(0, 1);
  wrap.position.set(0, 0, 0);
  p.state = 'ground'; p.z = 5;
  for (let i = 0; i < 12; i++) applyPosePolish(p, 1 / 60, groundAt);
  const ptsC = sample();
  const courseZ = (cw.y + cw.h - MAP.h / 2) * S + 0.26;
  hip = thigh = chest = Infinity; let footC = Infinity;
  for (const pt of ptsC) {
    if (pt.y < 5.0 || pt.y > 5.95) continue; // the footing course band
    const g = pt.z - courseZ;
    if (pt.r === 'hip') hip = Math.min(hip, g);
    if (pt.r === 'thigh') thigh = Math.min(thigh, g);
    if (pt.r === 'torso') chest = Math.min(chest, g);
    if (pt.r === 'foot') footC = Math.min(footC, g);
  }
  console.log(`  course facing gap (hip band) hip ${(hip*100).toFixed(1)} thigh ${(thigh*100).toFixed(1)} chest ${(chest*100).toFixed(1)} boot ${(footC*100).toFixed(1)}`);
}

console.log('\n==== STEP-UP INTO THE NEXT RISER (shot 2) ====');
{
  // Step-up lets the origin enter the next box once z >= top - stepUp.
  // That is the pose where the hip cuts into the masonry.
  const step = (i) => stairs.find(w => Math.abs(w.x - (120 + (210 / 7) * i)) < 0.5);
  const lower = step(1), upper = step(2);
  addBox(lower); addBox(upper);
  // solidBoxes caches for the current millisecond. The boxes above were added
  // in the same tick as the previous sample, so wait one tick before reading.
  await new Promise(r => setTimeout(r, 5));
  const gx = upper.x + 8, gy = upper.y + upper.h / 2, gz = lower.top;
  console.log(`  blocked at intrusion ${blockedAt(gx, gy, gz)}  lower top ${lower.top.toFixed(3)} upper top ${upper.top.toFixed(3)}`);
  place(gx, gy, gz);
  p.angle = 0;
  mesh.rotation.y = Math.atan2(1, 0);
  wrap.position.set(0, 0, 0);
  p.state = 'ground'; p.ledge = null; p.z = gz;
  anim(0, 0, false, 0, p, 1 / 60);
  mixer.update(1 / 60);
  const before = sample();
  const faceX = (upper.x - MAP.w / 2) * S;
  const capX = faceX - 0.05;
  // Positive is outside the west cap face (west of it). Negative is inside the step.
  const gap = (pts, plane) => {
    const o = { hip: Infinity, thigh: Infinity, torso: Infinity, foot: Infinity };
    for (const pt of pts) {
      if (pt.y < gz - 0.05 || pt.y > upper.top + 0.16) continue;
      // The cap only exists in its own height band. Below it the visible
      // face is the step box, 5 cm behind the cap's overhang.
      const surface = pt.y >= upper.top - 0.03 ? plane : plane + 0.05;
      const g = surface - pt.x;
      if (o[pt.r] != null) o[pt.r] = Math.min(o[pt.r], g);
    }
    return o;
  };
  const fmt = o => Object.entries(o).map(([k, v]) => `${k} ${(v * 100).toFixed(1)}cm`).join('  ');
  console.log('  BEFORE vs cap face', fmt(gap(before, capX)));
  const kEase = 1 - Math.exp(-10 / 60);
  for (let i = 0; i < 24; i++) {
    wrap.position.x += (0 - wrap.position.x) * kEase;
    wrap.position.y += (0 - wrap.position.y) * kEase;
    wrap.position.z += (0 - wrap.position.z) * kEase;
    applyPosePolish(p, 1 / 60, groundAt);
    place(gx, gy, gz);
    mesh.rotation.y = Math.atan2(1, 0);
  }
  const after = sample();
  console.log('  AFTER  vs cap face', fmt(gap(after, capX)), `wrap ${wrap.position.x.toFixed(3)},${wrap.position.y.toFixed(3)},${wrap.position.z.toFixed(3)}`);
}

// ---------- props: visual half-width vs declared collider ----------
console.log('\n==== PROP HALF-WIDTHS ====');
const io = new NodeIO().registerExtensions(ALL_EXTENSIONS);
const pl = JSON.parse(fs.readFileSync(path.join(ROOT, 'placements.json'), 'utf8'));
const { WALLS } = await import('../src/level.js');
const byId = Object.fromEntries(WALLS.filter(w => w.id).map(w => [w.id, w]));
const byTag = {};
for (const w of WALLS) (byTag[w.tag] = byTag[w.tag] || []).push(w);
for (const [k, cfg] of Object.entries(pl)) {
  if (cfg.solid === false && !(cfg.at || []).some(a => a.solid)) continue;
  const file = cfg.file || `${k}.glb`;
  const fp = path.join(ROOT, 'assets', file);
  if (!fs.existsSync(fp)) continue;
  const doc = await io.read(fp);
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (const mesh of doc.getRoot().listMeshes())
    for (const prim of mesh.listPrimitives()) {
      const pos = prim.getAttribute('POSITION'); if (!pos) continue;
      const mn = pos.getMin([]), mx = pos.getMax([]);
      for (let i = 0; i < 3; i++) { lo[i] = Math.min(lo[i], mn[i]); hi[i] = Math.max(hi[i], mx[i]); }
    }
  const sx = hi[0] - lo[0], sy = hi[1] - lo[1], sz = hi[2] - lo[2];
  const base = (cfg.targetH || 2) / (sy || 1);
  let fitXZ = 1;
  if (cfg.fit) {
    const piece = byId[k] || (cfg.hides || []).map(h => byId[h]).find(Boolean) || (byTag[k] || [])[0];
    if (piece && sx > 1e-4 && sz > 1e-4) {
      const want = Math.min((piece.w * S) / (sx * base), (piece.h * S) / (sz * base));
      fitXZ = Math.max(cfg.fitMin || 0.30, Math.min(cfg.fitMax || 2.5, want));
    }
  }
  const visR = Math.max(sx, sz) * base * fitXZ / 2;
  for (const pt of (cfg.at || [{}])) {
    const ptSolid = pt.solid != null ? pt.solid : cfg.solid !== false;
    if (!ptSolid) continue;
    const rCfg = pt.r != null ? pt.r : cfg.r;
    const colR = rCfg != null ? rCfg * (pt.s || 1) * fitXZ : null;
    const gap = colR == null ? null : +(visR - colR).toFixed(3);
    if (gap == null || gap > 0.02) {
      console.log(`${k} @ ${pt.x ?? '?'},${pt.y ?? '?'}  visual ${visR.toFixed(3)}  collider ${colR == null ? 'auto' : colR.toFixed(3)}  inside ${gap == null ? '?' : gap}`);
    }
  }
}
console.log('\nstand wall outermost', (standWall.min * 100).toFixed(1), 'pier', (standPier.min * 100).toFixed(1));
