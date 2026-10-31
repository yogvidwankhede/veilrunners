// ---------------------------------------------------------------------------
// Bake the collision map from the scene the player actually sees.
//
// Loads the real page, waits for every carved model, then rasterises the
// triangles of each STATIC SOLID mesh — props whose placement is solid, and
// the masonry courses proud of the chamber walls — into a 10 cm grid. Each
// cell keeps the lowest and highest stone in its column. Mechanism pieces
// (doors, gate, tiles, crane, bridge) collide through their MAP.walls box,
// which mech.js switches off, so they are not baked.
//
// Writes src/collisionmap.js. Re-run after changing placements.json or the
// level's walls; tombtest fails when the bake is stale.
//
//   npm start          (in another terminal)
//   node tools/bakecollision.mjs
// ---------------------------------------------------------------------------
import * as pw from 'playwright-core';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { bakeHash } from './bakehash.mjs';
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const URL_ = process.env.URL || 'http://127.0.0.1:8080/';

const b = await pw.chromium.launch({ args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist'] });
const page = await b.newPage({ viewport: { width: 640, height: 480 } });
page.on('pageerror', e => console.log('page error', String(e)));
await page.goto(URL_);
await page.waitForFunction(() => !document.getElementById('play').disabled, null, { timeout: 120000 });
await page.waitForTimeout(1500);                       // props parse after the rig
const out = await page.evaluate(() => {
  const V = __VEIL, MAP = V.MAP, S = 0.055, THREE = V.THREE;
  const CELL = 0.1, OX = -MAP.w / 2 * S, OZ = -MAP.h / 2 * S;
  const W = Math.ceil(MAP.w * S / CELL), H = Math.ceil(MAP.h * S / CELL);
  const BOT = new Int16Array(W * H).fill(32767), TOP = new Int16Array(W * H).fill(-32767);
  const keyOf = o => { for (let q = o; q; q = q.parent) if (q.userData && q.userData.key) return q; return null; };
  const picked = [], counts = {};
  const all = []; V.scene.traverse(o => { if (o.isMesh && !o.isSkinnedMesh) all.push(o); });
  for (const m of all) {
    const root = keyOf(m);
    const take = m.userData.course || (root && root.userData.solid !== false);
    if (!take) continue;
    picked.push(m);
    const k = m.userData.course ? 'masonry course' : root.userData.key;
    counts[k] = (counts[k] || 0) + 1;
  }
  const mark = (x, y, z) => {
    const i = Math.floor((x - OX) / CELL), j = Math.floor((z - OZ) / CELL);
    if (i < 0 || j < 0 || i >= W || j >= H) return;
    const k = j * W + i, cm = Math.round(y * 100);
    if (cm < BOT[k]) BOT[k] = cm;
    if (cm > TOP[k]) TOP[k] = cm;
  };
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3(), t = new THREE.Vector3();
  let tris = 0;
  for (const m of picked) {
    m.updateMatrixWorld(true);
    const g = m.geometry, pos = g.attributes.position, idx = g.index;
    const n = idx ? idx.count : pos.count;
    for (let f = 0; f < n; f += 3) {
      const ia = idx ? idx.getX(f) : f, ib = idx ? idx.getX(f + 1) : f + 1, ic = idx ? idx.getX(f + 2) : f + 2;
      a.fromBufferAttribute(pos, ia).applyMatrix4(m.matrixWorld);
      b.fromBufferAttribute(pos, ib).applyMatrix4(m.matrixWorld);
      c.fromBufferAttribute(pos, ic).applyMatrix4(m.matrixWorld);
      tris++;
      // edges, densely: a vertical face projects to a line and has no interior
      for (const [p, q] of [[a, b], [b, c], [c, a]]) {
        const L = Math.hypot(q.x - p.x, q.z - p.z), steps = Math.max(1, Math.ceil(L / (CELL * 0.4)));
        for (let s = 0; s <= steps; s++) { t.lerpVectors(p, q, s / steps); mark(t.x, t.y, t.z); }
        if (L < CELL * 0.4) { mark(p.x, Math.min(p.y, q.y), p.z); mark(p.x, Math.max(p.y, q.y), p.z); }
      }
      // interior: every cell centre inside the projected triangle, at the
      // triangle's own height there
      const d = (b.z - c.z) * (a.x - c.x) + (c.x - b.x) * (a.z - c.z);
      if (Math.abs(d) < 1e-9) continue;
      const x0 = Math.min(a.x, b.x, c.x), x1 = Math.max(a.x, b.x, c.x), z0 = Math.min(a.z, b.z, c.z), z1 = Math.max(a.z, b.z, c.z);
      for (let j = Math.floor((z0 - OZ) / CELL); j <= Math.floor((z1 - OZ) / CELL); j++) {
        const cz = OZ + (j + 0.5) * CELL;
        for (let i = Math.floor((x0 - OX) / CELL); i <= Math.floor((x1 - OX) / CELL); i++) {
          const cx = OX + (i + 0.5) * CELL;
          const l1 = ((b.z - c.z) * (cx - c.x) + (c.x - b.x) * (cz - c.z)) / d;
          const l2 = ((c.z - a.z) * (cx - c.x) + (a.x - c.x) * (cz - c.z)) / d;
          const l3 = 1 - l1 - l2;
          if (l1 < 0 || l2 < 0 || l3 < 0) continue;
          mark(cx, l1 * a.y + l2 * b.y + l3 * c.y, cz);
        }
      }
    }
  }
  // sparse: [delta idx u32][bottom i16][top i16]
  const cells = [];
  for (let k = 0; k < W * H; k++) if (BOT[k] !== 32767) cells.push(k);
  const buf = new DataView(new ArrayBuffer(cells.length * 8));
  let prev = 0;
  cells.forEach((k, n) => { buf.setUint32(n * 8, k - prev, true); buf.setInt16(n * 8 + 4, BOT[k], true); buf.setInt16(n * 8 + 6, TOP[k], true); prev = k; });
  const u = new Uint8Array(buf.buffer); let s = '';
  for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode.apply(null, u.subarray(i, i + 0x8000));
  return { W, H, CELL, OX, OZ, data: btoa(s), cells: cells.length, tris, meshes: picked.length, counts };
});
await b.close();
const hash = bakeHash();
fs.writeFileSync(path.join(root, 'src/collisionmap.js'),
  `// GENERATED by tools/bakecollision.mjs from the loaded scene — do not edit.\n` +
  `// ${out.meshes} meshes, ${out.tris} triangles, ${out.cells} occupied ${out.CELL * 100} cm cells.\n` +
  `export const BAKE = ${JSON.stringify({ w: out.W, h: out.H, cell: out.CELL, ox: out.OX, oz: out.OZ, hash, cells: out.cells, data: out.data })};\n`);
console.log(`baked ${out.meshes} meshes (${out.tris} triangles) into ${out.cells} cells · ${(out.data.length / 1024).toFixed(0)} KB · hash ${hash}`);
for (const [k, n] of Object.entries(out.counts).sort()) console.log(`  ${String(n).padStart(4)}  ${k}`);
