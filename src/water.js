import * as THREE from 'three';
import { MAP, S } from './constants.js';

// ---------------------------------------------------------------------------
// Wet stone at the foot of the east stair pier. A thin streak runs down a
// groove in the west face and ends in an irregular puddle. Neither mesh is
// solid, and neither is a climbable ledge. The west corridor (x 40..90) is
// nowhere near this.
// ---------------------------------------------------------------------------

const CX = MAP.w / 2, CZ = MAP.h / 2;
const wX = gx => (gx - CX) * S;
const wZ = gy => (gy - CZ) * S;

export const SILT = {
  room: 'hall',
  basin: { x: 237.2, y: 188.0, z: 0.028 },
  land:  { x: 241.8, y: 187.8, z: 0.03 },
};

const PEBBLE_AT = { x: 235.4, y: 189.2 };

export function siltWave(x, z, t) {
  return Math.sin(x * 3.4 + t * 1.35) * 0.007
       + Math.sin(z * 2.6 - t * 1.05 + 0.4) * 0.004;
}

function smooth(t) {
  const u = Math.min(1, Math.max(0, t));
  return u * u * (3 - 2 * u);
}

// Three overlapping lobes, warped a little, so the outline is a puddle
// rather than one ellipse. Values below 1 are inside.
function lobe(gx, gy, cx, cy, rx, ry) {
  const dx = (gx - cx) / rx, dy = (gy - cy) / ry;
  return dx * dx + dy * dy;
}
function waterField(gx, gy) {
  const warp = Math.sin(gx * 0.9 + 0.4) * 0.35 + Math.sin(gy * 1.15 + 1.7) * 0.28;
  const a = lobe(gx, gy + warp * 0.15, 239.6, 187.4, 3.6, 2.5);
  const b = lobe(gx + warp * 0.1, gy, 234.6, 189.5, 4.0, 2.3);
  const c = lobe(gx, gy, 237.2, 185.2, 2.4, 1.9);
  return Math.min(a, b, c);
}

export function surfaceRest(gx, gy) {
  if (waterField(gx, gy) > 1) return null;
  return SILT.basin.z;
}

export function pushCurrent() {}

function faceX(z) {
  const toe = 243.2, shaft = 246.8;
  if (z <= 0.16) return toe;
  if (z >= 0.42) return shaft;
  const u = (z - 0.16) / 0.26;
  return toe + (shaft - toe) * smooth(u);
}

function radialSprite() {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const g = c.getContext('2d');
  const rad = g.createRadialGradient(32, 32, 0, 32, 32, 28);
  rad.addColorStop(0, 'rgba(255,255,255,0.4)');
  rad.addColorStop(0.45, 'rgba(255,255,255,0.08)');
  rad.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = rad;
  g.fillRect(0, 0, 64, 64);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.LinearSRGBColorSpace;
  return t;
}

function pushVert(dst, x, y, z, alpha, deep, ripple) {
  dst.pos.push(x, y, z);
  dst.rest.push(y);
  dst.alpha.push(alpha);
  dst.deep.push(deep);
  dst.ripple.push(ripple);
}

// One thin rivulet painted on the face. Width is along the wall.
function addRivulet(dst, y0, phase) {
  const down = 24, across = 3;
  const base = dst.pos.length / 3;
  for (let iz = 0; iz <= down; iz++) {
    const t = iz / down;
    const bury = t < 0.08 ? (1 - t / 0.08) : 0;
    const foot = t > 0.84 ? smooth((t - 0.84) / 0.16) : 0;
    const zWall = 1.02 + (0.06 - 1.02) * smooth(t);
    const z = zWall * (1 - foot) + 0.03 * foot;
    const gy = y0 + Math.sin(t * 6.4 + phase) * 0.28 + Math.sin(t * 2.3 + phase) * 0.16;
    let x = faceX(Math.max(0.06, zWall)) - 0.42 + bury * 1.8;
    x -= foot * 2.4;
    const gap = Math.sin(t * 9.0 + phase * 1.7);
    const broken = gap > 0.72 ? 0.05 : (gap > 0.38 ? 0.35 : 1);
    const half = 0.28 * broken;
    const body = broken * (0.4 + 0.6 * Math.sin(Math.min(1, t * 1.05) * Math.PI));
    for (let ix = 0; ix <= across; ix++) {
      const s = ix / across;
      const edge = Math.sin(s * Math.PI);
      const a = edge * edge * 0.55 * body * (t < 0.03 ? t / 0.03 : 1);
      pushVert(dst, wX(x + (s - 0.5) * 0.06), z, wZ(gy + (s - 0.5) * 2 * half), a, edge * body, 0);
    }
  }
  const stride = across + 1;
  for (let iz = 0; iz < down; iz++) {
    for (let ix = 0; ix < across; ix++) {
      const a = base + iz * stride + ix;
      const b = a + 1, c = a + stride, d = c + 1;
      dst.idx.push(a, d, b, a, c, d);
    }
  }
}

// Grid over the foot of the pier. Cells outside the field are left out, so
// the mesh has no oval silhouette.
function addFieldMesh(dst, limit, yOf, style) {
  const x0 = 229.5, x1 = 244.2, y0 = 182.6, y1 = 192.8;
  const nx = 18, ny = 12;
  const base = dst.pos.length / 3;
  const field = [];
  for (let iy = 0; iy <= ny; iy++) {
    for (let ix = 0; ix <= nx; ix++) {
      const gx = x0 + (x1 - x0) * (ix / nx);
      const gy = y0 + (y1 - y0) * (iy / ny);
      const f = waterField(gx, gy);
      field.push(f);
      const e = f >= limit ? 0 : smooth(Math.min(1, (limit - f) / 0.28));
      const deep = smooth(Math.min(1, Math.max(0, (0.72 - f) / 0.72)));
      pushVert(dst, wX(gx), yOf(f), wZ(gy), style.alpha(e, deep), style.deep(deep), style.ripple(e, deep));
    }
  }
  const stride = nx + 1;
  for (let iy = 0; iy < ny; iy++) {
    for (let ix = 0; ix < nx; ix++) {
      const a = iy * stride + ix;
      const b = a + 1, c = a + stride, d = c + 1;
      if (field[a] > limit && field[b] > limit && field[c] > limit && field[d] > limit) continue;
      dst.idx.push(base + a, base + b, base + d, base + a, base + d, base + c);
    }
  }
}

function buildWater() {
  const dst = { pos: [], rest: [], alpha: [], deep: [], ripple: [], idx: [] };
  addRivulet(dst, 186.7, 0.4);
  addRivulet(dst, 188.5, 2.1);
  addFieldMesh(dst, 1.02,
    f => SILT.basin.z + (f < 0.7 ? 0.004 : 0),
    {
      alpha: (e, deep) => e * (0.22 + 0.48 * deep),
      deep: deep => deep,
      ripple: (e, deep) => e * deep,
    }
  );
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(dst.pos, 3));
  geo.setAttribute('aAlpha', new THREE.Float32BufferAttribute(dst.alpha, 1));
  geo.setAttribute('aDeep', new THREE.Float32BufferAttribute(dst.deep, 1));
  geo.setAttribute('aRipple', new THREE.Float32BufferAttribute(dst.ripple, 1));
  geo.setIndex(dst.idx);
  geo.computeVertexNormals();
  geo.computeBoundingSphere();
  if (geo.boundingSphere) geo.boundingSphere.radius += 0.3;
  return { geo, rest: new Float32Array(dst.rest), ripple: new Float32Array(dst.ripple) };
}

function findFloor(scene) {
  let floor = null;
  scene.traverse(o => {
    if (floor || !o.isMesh || !o.geometry) return;
    const n = o.geometry.attributes.position && o.geometry.attributes.position.count;
    if (o.geometry.type === 'PlaneGeometry' && n > 4000 && Math.abs(o.position.y - 0.01) < 0.03) floor = o;
  });
  return floor;
}

function floorUV(floor, wx, wz) {
  const width = floor.geometry.parameters.width;
  const height = floor.geometry.parameters.height;
  const lx = wx - floor.position.x;
  const ly = floor.position.z - wz;
  return [lx / width + 0.5, ly / height + 0.5];
}

function gameOfFloorVert(floor, i) {
  const p = floor.geometry.attributes.position;
  const lx = p.getX(i), ly = p.getY(i);
  const worldX = lx + floor.position.x;
  const worldZ = -ly + floor.position.z;
  return [worldX / S + CX, worldZ / S + CZ];
}

// Darken the actual hall floor under the puddle. The plane is coarse, so this
// is a soft stain; the finer mesh above it carries the ragged edge.
function darkenFloor(floor) {
  const p = floor.geometry.attributes.position;
  const col = new Float32Array(p.count * 3);
  for (let i = 0; i < p.count; i++) {
    const [gx, gy] = gameOfFloorVert(floor, i);
    const f = waterField(gx, gy);
    const wet = f > 1.55 ? 0 : smooth(Math.min(1, (1.55 - f) / 0.9));
    const k = 1 - wet * 0.48;
    col[i * 3] = k;
    col[i * 3 + 1] = k * (1 - wet * 0.04);
    col[i * 3 + 2] = k * (1 - wet * 0.06);
  }
  floor.geometry.setAttribute('color', new THREE.BufferAttribute(col, 3));
  floor.material.vertexColors = true;
  floor.material.needsUpdate = true;
}

function buildWet(floor) {
  const pos = [], uv = [], alpha = [], idx = [];
  const x0 = 228.5, x1 = 244.8, y0 = 182.0, y1 = 193.4;
  const nx = 16, ny = 11;
  const field = [];
  const limit = 1.45;
  for (let iy = 0; iy <= ny; iy++) {
    for (let ix = 0; ix <= nx; ix++) {
      const gx = x0 + (x1 - x0) * (ix / nx);
      const gy = y0 + (y1 - y0) * (iy / ny);
      const f = waterField(gx, gy);
      field.push(f);
      const wx = wX(gx), wz = wZ(gy);
      pos.push(wx, 0.018, wz);
      if (floor) uv.push(...floorUV(floor, wx, wz));
      else uv.push(0.5, 0.5);
      const e = f >= limit ? 0 : smooth(Math.min(1, (limit - f) / 0.55));
      alpha.push(e * 0.92);
    }
  }
  const stride = nx + 1;
  for (let iy = 0; iy < ny; iy++) {
    for (let ix = 0; ix < nx; ix++) {
      const a = iy * stride + ix;
      const b = a + 1, c = a + stride, d = c + 1;
      if (field[a] > limit && field[b] > limit && field[c] > limit && field[d] > limit) continue;
      idx.push(a, b, d, a, d, c);
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  geo.setAttribute('aAlpha', new THREE.Float32BufferAttribute(alpha, 1));
  geo.setIndex(idx);
  geo.computeVertexNormals();
  return geo;
}

function waterMaterial() {
  const mat = new THREE.MeshStandardMaterial({
    color: 0xffffff,
    roughness: 0.72,
    metalness: 0,
    transparent: true,
    opacity: 1,
    depthWrite: false,
    side: THREE.DoubleSide,
    emissive: 0x000000,
    emissiveIntensity: 0,
    envMapIntensity: 0.05,
    polygonOffset: true,
    polygonOffsetFactor: -3,
    polygonOffsetUnits: -3,
  });
  mat.customProgramCacheKey = () => 'trickle-flow';
  mat.onBeforeCompile = shader => {
    shader.uniforms.uTime = { value: 0 };
    shader.vertexShader = 'attribute float aAlpha;\nattribute float aDeep;\nattribute float aRipple;\nvarying float vAlpha;\nvarying float vDeep;\nvarying float vRipple;\nvarying vec3 vWPos;\n'
      + shader.vertexShader.replace(
        '#include <begin_vertex>',
        '#include <begin_vertex>\nvAlpha = aAlpha;\nvDeep = aDeep;\nvRipple = aRipple;\nvWPos = (modelMatrix * vec4(transformed, 1.0)).xyz;'
      );
    // Ripples travel: down the face where the sheet is off the floor, and
    // slowly across the puddle. Depth still darkens the thicker water.
    shader.fragmentShader = 'uniform float uTime;\nvarying float vAlpha;\nvarying float vDeep;\nvarying float vRipple;\nvarying vec3 vWPos;\n'
      + shader.fragmentShader
        .replace('#include <normal_fragment_maps>', `
          #include <normal_fragment_maps>
          float falling = smoothstep(0.08, 0.32, vWPos.y);
          vec3 q = vWPos;
          q.y += uTime * (0.1 + falling * 0.85);
          q.x -= uTime * (1.0 - falling) * 0.26;
          q.z -= uTime * (1.0 - falling) * 0.05;
          float w1 = q.x * 34.0 + q.z * 7.0;
          float w2 = q.z * 26.0 + q.y * 16.0;
          float amp = vRipple * 0.2;
          vec3 worldN = vec3(cos(w1) * amp, 1.0, cos(w2) * amp);
          normal = normalize(mix(normal, normalize(mat3(viewMatrix) * worldN), clamp(vRipple, 0.0, 1.0)));
        `)
        .replace('#include <color_fragment>', `
          #include <color_fragment>
          vec3 deepCol = vec3(0.03, 0.10, 0.24);
          vec3 thinCol = vec3(0.07, 0.18, 0.34);
          float depth = clamp(vDeep, 0.0, 1.0);
          diffuseColor.rgb = mix(thinCol, deepCol, depth);
          diffuseColor.rgb *= exp(-depth * 0.55);
          float lip = smoothstep(0.55, 0.08, depth) * clamp(vAlpha, 0.0, 1.0);
          diffuseColor.rgb += vec3(0.06, 0.09, 0.12) * lip * 0.45;
          diffuseColor.a *= clamp(vAlpha, 0.0, 1.0);
        `);
    mat.userData.shader = shader;
  };
  return mat;
}

function wetMaterial(floor) {
  const src = floor && floor.material;
  const mat = new THREE.MeshStandardMaterial({
    map: src && src.map ? src.map : null,
    color: 0x3a322c,
    roughness: 0.84,
    metalness: 0,
    transparent: true,
    opacity: 1,
    depthWrite: false,
    envMapIntensity: 0.04,
    polygonOffset: true,
    polygonOffsetFactor: -1,
    polygonOffsetUnits: -1,
  });
  mat.customProgramCacheKey = () => 'damp-stone';
  mat.onBeforeCompile = shader => {
    shader.uniforms.uTime = { value: 0 };
    shader.vertexShader = 'attribute float aAlpha;\nvarying float vAlpha;\nvarying vec3 vWPos;\n'
      + shader.vertexShader.replace(
        '#include <begin_vertex>',
        '#include <begin_vertex>\nvAlpha = aAlpha;\nvWPos = (modelMatrix * vec4(transformed, 1.0)).xyz;'
      );
    shader.fragmentShader = 'uniform float uTime;\nvarying float vAlpha;\nvarying vec3 vWPos;\n'
      + shader.fragmentShader
        .replace('#include <color_fragment>', `
          #include <color_fragment>
          float wet = clamp(vAlpha, 0.0, 1.0);
          diffuseColor.rgb *= mix(1.0, 0.78, wet);
          float s = uTime * 0.7;
          float a = sin((vWPos.x + vWPos.z * 0.65) * 40.0 + s);
          float b = sin((vWPos.x * 0.85 - vWPos.z) * 53.0 - s * 1.25);
          float knot = pow(max(a, 0.0) * max(b, 0.0), 1.4);
          diffuseColor.rgb += vec3(0.05, 0.09, 0.14) * knot * wet;
          diffuseColor.a *= wet;
        `)
        .replace('#include <roughnessmap_fragment>', `
          #include <roughnessmap_fragment>
          roughnessFactor = mix(roughnessFactor, 0.4, clamp(vAlpha, 0.0, 1.0) * 0.85);
        `);
    mat.userData.shader = shader;
  };
  return mat;
}

const POOL = 16;
function makeParticles() {
  const pos = new Float32Array(POOL * 3);
  const col = new Float32Array(POOL * 3);
  const size = new Float32Array(POOL);
  const alpha = new Float32Array(POOL);
  for (let i = 0; i < POOL; i++) pos[i * 3 + 1] = -30;
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('aColor', new THREE.BufferAttribute(col, 3));
  geo.setAttribute('aSize', new THREE.BufferAttribute(size, 1));
  geo.setAttribute('aAlpha', new THREE.BufferAttribute(alpha, 1));
  const mat = new THREE.ShaderMaterial({
    uniforms: { uMap: { value: radialSprite() } },
    transparent: true,
    depthWrite: false,
    blending: THREE.NormalBlending,
    vertexShader: `
      attribute float aSize;
      attribute float aAlpha;
      attribute vec3 aColor;
      varying float vA;
      varying vec3 vC;
      void main() {
        vA = aAlpha;
        vC = aColor;
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        gl_PointSize = aSize * (120.0 / max(0.2, -mv.z));
        gl_Position = projectionMatrix * mv;
      }
    `,
    fragmentShader: `
      uniform sampler2D uMap;
      varying float vA;
      varying vec3 vC;
      void main() {
        vec4 tex = texture2D(uMap, gl_PointCoord);
        if (tex.a < 0.05 || vA < 0.01) discard;
        gl_FragColor = vec4(vC, tex.a * vA * 0.7);
      }
    `,
  });
  const pts = new THREE.Points(geo, mat);
  pts.frustumCulled = false;
  pts.renderOrder = 6;
  const slots = [];
  for (let i = 0; i < POOL; i++) slots.push({ life: 0, max: 1, x: 0, y: -30, z: 0, vx: 0, vy: 0, vz: 0, size: 0.03, cr: 1, cg: 1, cb: 1 });
  return { pts, slots, head: 0, pos, col, size, alpha };
}

export function createSilt(scene) {
  const floor = findFloor(scene);
  if (floor) darkenFloor(floor);

  const wet = new THREE.Mesh(buildWet(floor), wetMaterial(floor));
  wet.name = 'trickle-wet';
  wet.receiveShadow = true;
  wet.castShadow = false;
  wet.renderOrder = 2;
  scene.add(wet);

  const { geo, rest, ripple } = buildWater();
  const mat = waterMaterial();
  const mesh = new THREE.Mesh(geo, mat);
  mesh.name = 'trickle';
  mesh.receiveShadow = false;
  mesh.castShadow = false;
  mesh.renderOrder = 4;
  scene.add(mesh);

  const pebble = new THREE.Mesh(
    new THREE.DodecahedronGeometry(0.045, 0),
    new THREE.MeshStandardMaterial({ color: 0x5c5148, roughness: 0.94, metalness: 0 })
  );
  pebble.name = 'trickle-stone';
  pebble.scale.set(1.2, 0.38, 0.85);
  pebble.castShadow = false;
  pebble.receiveShadow = true;
  const pebbleY = (surfaceRest(PEBBLE_AT.x, PEBBLE_AT.y) ?? SILT.basin.z) - 0.014;
  pebble.position.set(wX(PEBBLE_AT.x), pebbleY, wZ(PEBBLE_AT.y));
  pebble.rotation.set(0.4, 1.1, 0.2);
  scene.add(pebble);
  const pebbleRest = { x: pebble.rotation.x, z: pebble.rotation.z, y: pebble.position.y };

  const parts = makeParticles();
  scene.add(parts.pts);

  const stepped = new WeakMap();
  let foamAcc = 0;
  const stats = { alive: 0, foam: 0, splashes: 0, floaters: 1, t: 0 };

  const emit = (x, y, z, vx, vy, vz, life, size, cr, cg, cb) => {
    const s = parts.slots[parts.head];
    parts.head = (parts.head + 1) % POOL;
    s.life = life; s.max = life;
    s.x = x; s.y = y; s.z = z;
    s.vx = vx; s.vy = vy; s.vz = vz;
    s.size = size; s.cr = cr; s.cg = cg; s.cb = cb;
  };

  const api = {
    mesh, bowl: wet, stats, SILT,
    update(dt, t, players) {
      stats.t = t;
      const pa = geo.attributes.position;
      for (let i = 0; i < pa.count; i++) {
        const x = pa.getX(i), z = pa.getZ(i);
        pa.setY(i, rest[i] + siltWave(x, z, t) * ripple[i]);
      }
      pa.needsUpdate = true;
      if (mat.userData.shader) mat.userData.shader.uniforms.uTime.value = t;
      const wetSh = wet.material.userData.shader;
      if (wetSh) wetSh.uniforms.uTime.value = t;

      pebble.position.y = pebbleRest.y + siltWave(pebble.position.x, pebble.position.z, t) * 0.25;
      pebble.rotation.x = pebbleRest.x + Math.sin(t * 0.6) * 0.02;
      pebble.rotation.z = pebbleRest.z + Math.cos(t * 0.45) * 0.02;

      foamAcc += dt;
      if (foamAcc > 1.1) {
        foamAcc = 0;
        stats.foam++;
        const { land } = SILT;
        emit(wX(land.x + (Math.random() - 0.5) * 0.8), land.z + 0.008, wZ(land.y + (Math.random() - 0.5) * 0.5),
          0, 0.008, 0,
          0.18, 0.022,
          0.55, 0.66, 0.74);
      }

      if (players) for (const p of players) {
        if (!p || p.deadUntil) { stepped.set(p, false); continue; }
        const h = surfaceRest(p.x, p.y);
        const inW = h != null && Math.abs((p.z || 0) - h) < 0.35;
        const was = stepped.get(p) || false;
        if (inW && !was) {
          stats.splashes++;
          const x = wX(p.x), z = wZ(p.y);
          for (let i = 0; i < 4; i++) {
            const a = Math.random() * Math.PI * 2;
            const sp = 0.06 + Math.random() * 0.14;
            emit(x, h + 0.015, z,
              Math.cos(a) * sp, 0.05 + Math.random() * 0.1, Math.sin(a) * sp,
              0.18, 0.03,
              0.4, 0.55, 0.7);
          }
        }
        stepped.set(p, inW);
      }

      let alive = 0;
      for (let i = 0; i < POOL; i++) {
        const s = parts.slots[i];
        const o = i * 3;
        if (s.life <= 0) {
          parts.alpha[i] = 0;
          parts.pos[o + 1] = -30;
          continue;
        }
        s.life -= dt;
        s.x += s.vx * dt; s.y += s.vy * dt; s.z += s.vz * dt;
        const k = Math.max(0, s.life / s.max);
        parts.pos[o] = s.x; parts.pos[o + 1] = s.y; parts.pos[o + 2] = s.z;
        parts.col[o] = s.cr; parts.col[o + 1] = s.cg; parts.col[o + 2] = s.cb;
        parts.size[i] = s.size;
        parts.alpha[i] = k * 0.55;
        alive++;
      }
      stats.alive = alive;
      parts.pts.geometry.attributes.position.needsUpdate = true;
      parts.pts.geometry.attributes.aColor.needsUpdate = true;
      parts.pts.geometry.attributes.aSize.needsUpdate = true;
      parts.pts.geometry.attributes.aAlpha.needsUpdate = true;
    },
  };
  return api;
}
