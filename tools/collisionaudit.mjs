// ---------------------------------------------------------------------------
// Collision audit: does what stops the body match what the player can see?
//
// Runs in the real page with every model loaded, because the carved meshes
// add colliders that the Node suites never build. For every floor cell on the
// tomb's walkable surfaces it asks the game's own blockedAt() whether a body
// may stand there, and asks the visible geometry whether anything is actually
// within a body radius. A cell the collision refuses but the stone does not
// fill is an invisible wall; the report names what caused each one.
//
//   node tools/collisionaudit.mjs            report, and snaps/collision-map.png
//   node tools/collisionaudit.mjs --strict   exit 1 if any phantom area remains
// Needs a running server on :8080 (npm start) and Playwright's chromium.
// ---------------------------------------------------------------------------
import * as pw from 'playwright-core';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const URL_ = process.env.URL || 'http://127.0.0.1:8080/';
const strict = process.argv.includes('--strict');

const b = await pw.chromium.launch({ args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const page = await b.newPage({ viewport: { width: 800, height: 600 } });
page.on('pageerror', e => console.log('page error', String(e)));
await page.goto(URL_);
await page.waitForFunction(() => !document.getElementById('play').disabled, null, { timeout: 120000 });
// open every gate the mechanisms own, so the audit sees the finished tomb's floor too
const res = await page.evaluate(() => {
  const V = __VEIL, C = V.col, MAP = V.MAP, THREE = V.THREE, S = 0.055;
  const R = C.PHYS.bodyRadius != null ? C.PHYS.bodyRadius : 0.36;   // metres: a person, not the pad
  const ray = new THREE.Raycaster();
  const meshes = []; V.scene.traverse(o => { if (o.isMesh && o.visible && o.geometry && !o.isSkinnedMesh && !(o.material && o.material.transparent && o.material.opacity < 0.5)) meshes.push(o); });
  const visible = o => { for (let x = o; x; x = x.parent) if (x.visible === false) return false; return true; };
  const live = meshes.filter(visible);
  const dirs = []; for (let i = 0; i < 12; i++) dirs.push(new THREE.Vector3(Math.cos(i / 12 * Math.PI * 2), 0, Math.sin(i / 12 * Math.PI * 2)));
  const o = new THREE.Vector3(), down = new THREE.Vector3(0, -1, 0);
  // what is physically within reach of a body standing here?
  function solidNear(x, y, z) {
    const wx = (x - MAP.w / 2) * S, wz = (y - MAP.h / 2) * S;
    for (const h of [0.6, 1.25]) {
      o.set(wx, z + h, wz);
      for (const d of dirs) { ray.set(o, d); ray.far = R; ray.near = 0; if (ray.intersectObjects(live, false).length) return true; }
    }
    o.set(wx, z + 1.8, wz); ray.set(o, down); ray.far = 1.8 - 0.5;   // a surface between knee and head height, right here
    if (ray.intersectObjects(live, false).length) return true;
    return false;
  }
  // Attribute a blocked cell to what the game's own blockedAt consults.
  const PAD = C.PAD;
  const which = (x, y, z) => {
    const out = [];
    for (const w of MAP.walls) { if (w.off) continue;
      if (x > w.x - PAD && x < w.x + w.w + PAD && y > w.y - PAD && y < w.y + w.h + PAD && z < w.top - C.PHYS.stepUp)
        out.push('wall:' + (w.id || w.tag || '?') + (x > w.x && x < w.x + w.w && y > w.y && y < w.y + w.h ? '' : ':pad')); }
    if (C.gridBlocked(x, y, z, C.PHYS.bodyRadius)) out.push('baked stone near ' + Math.round(x / 20) * 20 + ',' + Math.round(y / 20) * 20);
    return out;
  };
  // floor cells: every surface a body can stand on, sampled on a 6-unit grid
  const STEP = 6, cells = [], phantom = new Map();
  let walk = 0, blockedN = 0, phantomN = 0;
  const surfaces = new Set([0]); for (const w of MAP.walls) if (!w.off) surfaces.add(w.top);
  for (let y = 25; y < MAP.h - 25; y += STEP) for (let x = 25; x < MAP.w - 25; x += STEP) {
    const z = C.groundAt(x, y);
    // only cells next to somewhere a body can actually be: open floor within 2 m
    const blocked = C.blockedAt(x, y, z);
    if (!blocked) { walk++; cells.push([x, y, 0]); continue; }
    let nearOpen = false;
    for (let a = 0; a < 8 && !nearOpen; a++) { const nx = x + Math.cos(a * Math.PI / 4) * 30, ny = y + Math.sin(a * Math.PI / 4) * 30;
      if (Math.abs(C.groundAt(nx, ny) - z) < 0.05 && !C.blockedAt(nx, ny, z)) nearOpen = true; }
    if (!nearOpen) continue;
    blockedN++;
    if (solidNear(x, y, z)) { cells.push([x, y, 1]); continue; }
    phantomN++; cells.push([x, y, 2]);
    for (const k of which(x, y, z)) phantom.set(k, (phantom.get(k) || 0) + 1);
  }
  return { walk, blockedN, phantomN, cellArea: (STEP * S) ** 2, cells, top: [...phantom.entries()].sort((a, b) => b[1] - a[1]), R, mapW: MAP.w, mapH: MAP.h, walls: MAP.walls.filter(w => !w.off).map(w => [w.x, w.y, w.w, w.h]) };
});
const m2 = n => (n * res.cellArea).toFixed(1) + ' m²';
console.log(`body radius ${res.R} m · open floor ${m2(res.walk)} · blocked edge ${m2(res.blockedN)} · PHANTOM ${m2(res.phantomN)}`);
console.log('phantom area by cause (a cell can have several causes):');
for (const [k, n] of res.top.slice(0, 30)) console.log('  ' + m2(n).padStart(9) + '  ' + k);
// a top-down picture: grey walls, green open floor, white real contact, red phantom
const png = await page.evaluate(r => {
  const sc = 1.2, c = document.createElement('canvas'); c.width = r.mapW * sc; c.height = r.mapH * sc;
  const g = c.getContext('2d'); g.fillStyle = '#111'; g.fillRect(0, 0, c.width, c.height);
  g.fillStyle = '#444'; for (const [x, y, w, h] of r.walls) g.fillRect(x * sc, y * sc, w * sc, h * sc);
  const col = ['#2d6', '#ddd', '#f22'];
  for (const [x, y, k] of r.cells) { g.fillStyle = col[k]; g.fillRect((x - 3) * sc, (y - 3) * sc, 6 * sc, 6 * sc); }
  return c.toDataURL('image/png');
}, res);
fs.mkdirSync(path.join(root, 'snaps'), { recursive: true });
fs.writeFileSync(path.join(root, 'snaps/collision-map.png'), Buffer.from(png.split(',')[1], 'base64'));
await b.close();
console.log('map: snaps/collision-map.png');
process.exit(strict && res.phantomN * res.cellArea > 0.5 ? 1 : 0);
