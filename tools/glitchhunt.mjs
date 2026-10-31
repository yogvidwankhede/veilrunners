// ---------------------------------------------------------------------------
// Hunts for teleports in the real page. From points along the recorded route
// it sprints in several directions (into walls, corners, props, off edges),
// jumping on some runs, and logs every rendered frame where the body or its
// mesh moved further than the run speed allows.
//   VEIL_FILM=/tmp/film.json node tools/runthrough.mjs
//   FILM=/tmp/film.json node tools/glitchhunt.mjs [every=6]
// ---------------------------------------------------------------------------
import * as pw from 'playwright-core';
import fs from 'node:fs';
const film = JSON.parse(fs.readFileSync(process.env.FILM || '/tmp/film.json', 'utf8'));
const every = +(process.argv[2] || 6);
const b = await pw.chromium.launch({ args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist'] });
const ctx = await b.newContext({ viewport: { width: 960, height: 540 } });
await ctx.addInitScript(() => localStorage.setItem('veil.settings.v1', JSON.stringify({ quality: 'high', tutorial: false, hints: false })));
const page = await ctx.newPage();
page.on('pageerror', e => console.log('page error', String(e)));
await page.goto(process.env.URL || 'http://127.0.0.1:8080/');
await page.waitForFunction(() => !document.getElementById('play').disabled, null, { timeout: 120000 });
await page.evaluate(() => document.getElementById('play').click());
await page.waitForFunction(() => __VEIL.game.t > 3500);
await page.evaluate(() => {
  const V = __VEIL, q = () => V.game.players[0], W = new V.THREE.Vector3();
  V._glitch = []; V._skip = 0; V._turn = 0; let last = null;
  const tick = () => {
    const p = q(); p.mesh.getWorldPosition(W);
    if (V._turn) V.camYaw += V._turn / 60;           // a mouse turns smoothly
    const now = performance.now();
    const C = V.camera.position; const cur = { t: now, x: p.x, y: p.y, z: p.z || 0, st: p.state, mx: W.x, my: W.y, mz: W.z, cx: C.x, cy: C.y, cz: C.z };
    if (last && V._skip <= 0) {
      const dt = (now - last.t) / 1000, S = 0.055;
      const dh = Math.hypot(cur.x - last.x, cur.y - last.y) * S, dz = cur.z - last.z;
      const dm = Math.hypot(cur.mx - last.mx, cur.mz - last.mz), dmy = cur.my - last.my;
      const lim = 5.6 * dt + 0.03;
      const bad = [];
      if (dh > lim) bad.push(`sim ${dh.toFixed(2)}m`);
      if (Math.abs(dz) > 0.5 && cur.st !== 'mantle' && last.st !== 'mantle') bad.push(`simZ ${dz.toFixed(2)}`);
      if (dm > lim + 0.05) bad.push(`mesh ${dm.toFixed(2)}m`);
      if (Math.abs(dmy) > 0.25) bad.push(`meshY ${dmy.toFixed(2)}`);
      const dc = Math.hypot(cur.cx - last.cx, cur.cy - last.cy, cur.cz - last.cz);
      if (dc > lim + 0.25) bad.push(`cam ${dc.toFixed(2)}m`);
      if (bad.length) V._glitch.push(`${bad.join(' ')}  ${last.st}->${cur.st} at (${cur.x | 0},${cur.y | 0}) z${cur.z.toFixed(2)} dt=${(dt * 1000).toFixed(0)}ms`);
    }
    if (V._skip > 0) V._skip--;
    last = cur; requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
});
const heads = [0, Math.PI / 2, Math.PI, -Math.PI / 2, Math.PI / 4, -3 * Math.PI / 4];
let runs = 0;
for (let i = 0; i < film.length; i += every) {
  const f = film[i]; if (f.state !== 'ground') continue;
  for (let h = 0; h < 3; h++) {
    const yaw = heads[(i / every + h * 2) % heads.length | 0];
    await page.evaluate(([f, yaw]) => { const V = __VEIL, q = V.game.players[0];
      V.game.mech.apply(f.mech); V._skip = 12;
      Object.assign(q, { x: f.x, y: f.y, z: f.z, px: f.x, py: f.y, pz: f.z, vx: 0, vy: 0, vz: 0, state: 'ground', ledge: null, hp: 100, deadUntil: 0 });
      V.camYaw = yaw; }, [f, yaw]);
    await page.waitForTimeout(250);
    const k2 = h === 1 ? (i % 2 ? 'a' : 'd') : null;
    await page.keyboard.down('w'); if (k2) await page.keyboard.down(k2); if (h !== 1) await page.keyboard.down('Shift');
    for (let s = 0; s < 6; s++) {          // turn the camera as a player does while running
      await page.evaluate(d => { __VEIL._turn = d; }, (s % 2 ? -1 : 1) * 1.0);
      await page.waitForTimeout(260);
      if (h === 2 && s === 2) { await page.keyboard.down(' '); await page.waitForTimeout(250); await page.keyboard.up(' '); }
    }
    await page.evaluate(() => { __VEIL._turn = 0; });
    await page.keyboard.up('w'); if (k2) await page.keyboard.up(k2); await page.keyboard.up('Shift');
    await page.waitForTimeout(250);
    runs++;
  }
}
const g = await page.evaluate(() => __VEIL._glitch);
console.log(`${runs} runs, ${g.length} glitch frames`);
const tally = {}; for (const s of g) { const k = s.replace(/[-0-9.]+m?/g, '#').split(' at ')[0]; tally[k] = (tally[k] || 0) + 1; }
console.log(tally);
console.log(g.slice(0, 60).join('\n'));
await b.close();
