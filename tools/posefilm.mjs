// ---------------------------------------------------------------------------
// Film a traversal move from the side, frame by frame, with the real renderer.
//
// The animation layer is the one thing no Node suite can judge: whether hands
// meet the stone, whether a pose pops, whether the body clips. This drives the
// runner through a move with real key presses and writes a contact sheet.
//
//   node tools/posefilm.mjs climb     ledge: walk in, grab, hang, shimmy, climb
//   node tools/posefilm.mjs jump      open floor: run, jump, land
// Needs `npm start` running. Output: snaps/film-<move>.png
// ---------------------------------------------------------------------------
import * as pw from 'playwright-core';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const move = process.argv[2] || 'climb';
const b = await pw.chromium.launch({ args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist'] });
const ctx = await b.newContext({ viewport: { width: 1280, height: 960 } });
await ctx.addInitScript(() => localStorage.setItem('veil.settings.v1', JSON.stringify({ quality: 'high', tutorial: false, marker: false, captions: false, hints: false })));
const page = await ctx.newPage();
page.on('pageerror', e => console.log('page error', String(e)));
await page.goto(process.env.URL || 'http://127.0.0.1:8080/');
await page.waitForFunction(() => !document.getElementById('play').disabled, null, { timeout: 120000 });
await page.evaluate(() => document.getElementById('play').click());
// past the opening crane (2.4 s), or the first frames film it instead of the move
await page.waitForFunction(() => __VEIL.game.t > 2600);
await page.addStyleTag({ content: '#hud,#chapter,#marker,#tut{display:none!important}' });

const SETUPS = {
  // the 2.5 -> 5.0 ledge in the north gallery: clean masonry, a real climb.
  // Walk in, tap Space at the face (standing grab), shimmy, climb, stop.
  climb: { x: 425, y: 108, z: 2.5, yaw: 0, film: Math.PI / 2 - 0.55, pitch: 0.3, keys: [['w', 520], ['wait', 350], [' ', 140], ['wait', 900], ['d', 900], ['wait', 300], ['w', 1300]] },
  // the same ledge filmed square side-on, for the pull-up itself
  mantle: { x: 425, y: 108, z: 2.5, yaw: 0, film: Math.PI / 2, pitch: 0.1, keys: [['w', 420], [' ', 140], ['wait', 700], ['w', 1500]] },
  // a settled hang, square side-on: the head, the arms, the legs
  hangside: { x: 425, y: 108, z: 2.5, yaw: 0, film: Math.PI / 2 - 0.35, pitch: 0.1, keys: [['w', 520], ['wait', 350], [' ', 140], ['wait', 1500]] },
  // the player's own view of it: the camera behind, as played
  played: { x: 425, y: 100, z: 2.5, yaw: 0, pitch: 0.16, keys: [['w', 600], [' ', 140], ['w', 2200]] },
  // the carved pillar in the entrance hall: stand at its south face, grab
  pillar: { x: 268, y: 226, z: 0, yaw: Math.PI, film: Math.PI / 2 + 0.6, pitch: 0.25, keys: [['w', 400], ['wait', 300], [' ', 140], ['wait', 1400], ['a', 700], ['wait', 600]] },
  // the carved pillar as played: camera behind and above, the way it is
  // seen in the game when you hang on it
  pillarplay: { x: 268, y: 226, z: 0, yaw: Math.PI, ang: -Math.PI / 2, pitch: 0.55, keys: [['w', 400], ['wait', 300], [' ', 140], ['wait', 1600]] },
  // the stair hall: walk up three treads and stop on one, side-on
  stairs: { x: 112, y: 98, z: 0, yaw: Math.PI / 2, ang: 0, film: Math.PI, pitch: 0.12, keys: [['w', 1700], ['wait', 600], ['w', 500], ['wait', 600]] },
  // open hall floor: a run, a held jump, the landing
  jump: { x: 320, y: 480, z: 0, yaw: 0, film: Math.PI / 2, keys: [['w+shift', 650], [' ', 420, 'w+shift'], ['w+shift', 1000]] },
};
const st = SETUPS[move];
await page.evaluate(s => {
  const V = __VEIL, g = V.game, q = g.players[0];
  q.x = q.px = s.x; q.y = q.py = s.y; q.z = q.pz = s.z; q.vx = q.vy = q.vz = 0; q.state = 'ground';
  q.angle = q.pangle = s.ang != null ? s.ang : s.yaw === 0 ? Math.PI / 2 : -Math.PI / 2;
  V.camYaw = s.yaw; V.camPitch = s.pitch ?? 0.02; V.filmYaw = s.film;
}, st);
await page.evaluate(() => { __VEIL.renderer.toneMappingExposure = 2.4; });
await page.waitForTimeout(400);
const frames = [];
// Crop to the runner: project the chest to the screen and frame 2.6 m around it.
const shot = async () => {
  const c = await page.evaluate(() => { const V = __VEIL, q = V.game.players[0], m = q.mesh;
    let hip = null; m.traverse(o => { if (!hip && o.isBone && /hips$/i.test(o.name)) hip = o; });
    const v = new V.THREE.Vector3(); if (hip) hip.getWorldPosition(v); else { v.copy(m.position); v.y += 1.0; } const top = v.clone(); top.y += 1.4;
    v.project(V.camera); top.project(V.camera);
    const W = innerWidth, H = innerHeight, cx = (v.x + 1) / 2 * W, cy = (1 - v.y) / 2 * H;
    const half = Math.max(60, Math.abs(((1 - top.y) / 2 * H) - cy) * 1.15);
    return { x: Math.max(0, cx - half), y: Math.max(0, cy - half), width: Math.min(W, half * 2), height: Math.min(H, half * 2) }; });
  frames.push((await page.screenshot(process.env.FULL ? { type: 'jpeg', quality: 70 } : { type: 'jpeg', quality: 85, clip: c })).toString('base64'));
};
const log = [];
const state = () => page.evaluate(() => { const V = __VEIL, q = V.game.players[0], S = 0.055, MAP = V.MAP;
  let extra = '';
  const g = q.ledge;
  if (g) {
    let hip = null; q.mesh.traverse(o => { if (!hip && o.isBone && /hips$/i.test(o.name)) hip = o; });
    const v = new V.THREE.Vector3(); hip.getWorldPosition(v);
    const fx = (g.ex - MAP.w / 2) * S, fz = (g.ey - MAP.h / 2) * S;
    const gapHip = (v.x - fx) * g.nx + (v.z - fz) * g.ny;           // + outside the face
    const gapSim = ((q.x - g.ex) * g.nx + (q.y - g.ey) * g.ny) * S;
    extra = ` mantle=${(q.mantle || 0).toFixed(2)} simGap=${gapSim.toFixed(2)} hipGap=${gapHip.toFixed(2)} hipBelowLip=${(g.top - v.y).toFixed(2)} wrap=${q.wrap ? [q.wrap.position.x, q.wrap.position.y, q.wrap.position.z].map(n => n.toFixed(2)).join(',') : '-'} m0=${q._m0 ? JSON.stringify({ky:+q._m0.ky.toFixed(2),kz:+q._m0.kz.toFixed(2),W0:[q._m0.W0.y,q._m0.W0.z].map(n=>+n.toFixed(2)),R0:[q._m0.R0.y,q._m0.R0.z].map(n=>+n.toFixed(2))}) : '-'} cr=${q._climbRoot ? JSON.stringify({r1:[q._climbRoot.r1.y,q._climbRoot.r1.z].map(n=>+n.toFixed(2)), idle:q._climbRoot.idle&&[q._climbRoot.idle.y,q._climbRoot.idle.z].map(n=>+n.toFixed(2))}) : '-'} brace=${(q._brace||0).toFixed(2)} braceY=${(q._braceY||0).toFixed(2)} lift=${(q._lift||0).toFixed(2)} rig=${q.rig ? q.rig.reach.toFixed(2)+'/'+q.rig.lift.toFixed(2) : '-'}`;
  }
  // deepest any bone (with ~12 cm of flesh) goes inside the block being held
  let pen = 0, worst = '';
  const L = q.ledge || q._lastLedge; if (q.ledge) q._lastLedge = q.ledge;
  if (L && L.wall) {
    const w = L.wall, v = new V.THREE.Vector3();
    const x0 = (w.x - MAP.w / 2) * S, x1 = (w.x + w.w - MAP.w / 2) * S, z0 = (w.y - MAP.h / 2) * S, z1 = (w.y + w.h - MAP.h / 2) * S;
    q.mesh.traverse(o => { if (!o.isBone || /finger|thumb|hand|toe|end/i.test(o.name)) return; o.getWorldPosition(v);
      const d = Math.min(v.x - x0, x1 - v.x, v.z - z0, z1 - v.z, w.top - v.y) + 0.12;
      if (d > pen) { pen = d; worst = o.name.replace('mixamorig', ''); } });
  }
  if (q.wrap) extra += ` WRAP rx=${q.wrap.rotation.x.toFixed(2)} z=${q.wrap.position.z.toFixed(2)} y=${q.wrap.position.y.toFixed(2)} tilt=${(q._tilt||0).toFixed(2)} out=${(q._out||0).toFixed(2)}`;
  extra += ` PEN=${pen.toFixed(2)}${worst ? '(' + worst + ')' : ''}`;
  // the lower foot against the tread under it: below zero is inside the stone
  {
    let gap = Infinity; const v = new V.THREE.Vector3();
    q.mesh.traverse(o => { if (!o.isBone || !/(Left|Right)Foot$/.test(o.name)) return; o.getWorldPosition(v);
      gap = Math.min(gap, v.y - V.col.groundAt(v.x / S + MAP.w / 2, v.z / S + MAP.h / 2)); });
    extra += ` FOOT=${gap.toFixed(2)}`;
  }
  if (!V._visMeshes) { V._visMeshes = []; V.scene.traverse(o => { if (o.isMesh && !o.isSkinnedMesh && o.geometry && !(o.material && o.material.transparent)) V._visMeshes.push(o); }); }
  {
    const ray = new V.THREE.Raycaster(), up = new V.THREE.Vector3(0, 1, 0), v = new V.THREE.Vector3(); let inside = [];
    q.mesh.traverse(o => { if (!o.isBone || /finger|thumb|toe|end|hand/i.test(o.name)) return; o.getWorldPosition(v);
      ray.set(v, up); ray.far = 30;
      const hits = ray.intersectObjects(V._visMeshes.filter(m => m.visible && Math.abs(m.position.x - v.x) < 12 && Math.abs(m.position.z - v.z) < 12 || m.geometry.boundingSphere && m.geometry.boundingSphere.radius > 6), false);
      // inside a closed solid: the first surface above faces back toward the point
      if (hits.length && hits[0].face && hits[0].face.normal.clone().transformDirection(hits[0].object.matrixWorld).y > 0.2) inside.push(o.name.replace('mixamorig', ''));
    });
    extra += ` INSIDE=[${inside.join(',')}]`;
  }
  let op = 1; q.mesh.traverse(o => { if (o.isMesh && o.material && o.material.opacity < op) op = o.material.opacity; });
  const camD = V.camera.position.distanceTo(q.mesh.position);
  return `${q.state} z=${(q.z || 0).toFixed(2)} opacity=${op.toFixed(2)} camDist=${camD.toFixed(2)}${extra}`; });
for (const [k, ms, holdAlso] of st.keys) {
  const keys = k === 'wait' ? [] : k.split('+').map(x => x === ' ' ? 'Space' : x === 'shift' ? 'Shift' : x);
  if (holdAlso) for (const h of holdAlso.split('+')) await page.keyboard.down(h === 'shift' ? 'Shift' : h);
  for (const kk of keys) await page.keyboard.down(kk);
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { await shot(); log.push(`${k.padEnd(8)} ${await state()}`); await page.waitForTimeout(60); }
  for (const kk of keys) await page.keyboard.up(kk);
  if (holdAlso) for (const h of holdAlso.split('+')) await page.keyboard.up(h === 'shift' ? 'Shift' : h);
}
for (let i = 0; i < 6; i++) { await shot(); log.push(`rest     ${await state()}`); await page.waitForTimeout(90); }
// contact sheet
const sheet = await page.evaluate(fr => new Promise(res => {
  const cols = 6, w = 320, h = 240, rows = Math.ceil(fr.length / cols);
  const c = document.createElement('canvas'); c.width = cols * w; c.height = rows * h;
  const g = c.getContext('2d'); let n = 0;
  fr.forEach((d, i) => { const im = new Image(); im.onload = () => { g.drawImage(im, (i % cols) * w, Math.floor(i / cols) * h, w, h);
    g.fillStyle = '#fff'; g.font = '14px monospace'; g.fillText(String(i), (i % cols) * w + 6, Math.floor(i / cols) * h + 16);
    if (++n === fr.length) res(c.toDataURL('image/jpeg', 0.85)); }; im.src = 'data:image/jpeg;base64,' + d; });
}), frames);
fs.mkdirSync(path.join(root, 'snaps'), { recursive: true });
fs.writeFileSync(path.join(root, `snaps/film-${move}.jpg`), Buffer.from(sheet.split(',')[1], 'base64'));
log.forEach((l, i) => console.log(String(i).padStart(3), l));
await b.close();
