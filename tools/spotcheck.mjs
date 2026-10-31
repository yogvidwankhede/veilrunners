// ---------------------------------------------------------------------------
// Close-up shots of named spots, plus what mesh sits under the screen centre.
//   node tools/spotcheck.mjs "x,y,z,yaw,pitch" ...   -> snaps/spot-N.jpg
// ---------------------------------------------------------------------------
import * as pw from 'playwright-core';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const b = await pw.chromium.launch({ args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist'] });
const ctx = await b.newContext({ viewport: { width: 960, height: 540 } });
await ctx.addInitScript(() => localStorage.setItem('veil.settings.v1', JSON.stringify({ quality: 'high', tutorial: false, marker: false, captions: false, hints: false })));
const page = await ctx.newPage();
page.on('pageerror', e => console.log('page error', String(e)));
await page.goto(process.env.URL || 'http://127.0.0.1:8080/');
await page.waitForFunction(() => !document.getElementById('play').disabled, null, { timeout: 120000 });
await page.evaluate(() => document.getElementById('play').click());
await page.waitForFunction(() => __VEIL.game.t > 300);
await page.addStyleTag({ content: '#hud,#chapter,#marker,#tut{display:none!important}' });
fs.mkdirSync(path.join(root, 'snaps'), { recursive: true });
let i = 0;
for (const spec of process.argv.slice(2)) {
  const [x, y, z, yaw, pitch] = spec.split(',').map(Number);
  await page.evaluate(([x, y, z, yaw, pitch]) => { const V = __VEIL, q = V.game.players[0];
    Object.assign(q, { x, y, z, px: x, py: y, pz: z, vx: 0, vy: 0, vz: 0, state: 'ground' });
    V.camYaw = yaw; V.camPitch = pitch; }, [x, y, z, yaw, pitch]);
  await page.waitForTimeout(900);
  const hits = await page.evaluate(() => { const V = __VEIL, T = V.THREE, rc = new T.Raycaster(), out = [];
    for (const [sx, sy] of [[0, 0], [0, -0.6], [-0.6, -0.6], [0.6, -0.6], [0, 0.5]]) {
      rc.setFromCamera(new T.Vector2(sx, sy), V.camera);
      const h = rc.intersectObjects(V.scene.children, true).find(h => h.object.visible && h.object.isMesh);
      if (h) { const m = h.object.material, mm = Array.isArray(m) ? m[h.face?.materialIndex || 0] : m;
        out.push(`${sx},${sy}: ${h.object.name || h.object.type} mat=${mm?.name || mm?.type} map=${!!mm?.map} d=${h.distance.toFixed(1)} ud=${JSON.stringify(h.object.userData).slice(0, 80)}`); } }
    return out; });
  console.log(spec, '\n  ' + hits.join('\n  '));
  fs.writeFileSync(path.join(root, `snaps/spot-${i++}.jpg`), await page.screenshot({ type: 'jpeg', quality: 85 }));
}
await b.close();
