// ---------------------------------------------------------------------------
// The headless playthrough, replayed in the real renderer: the runner stands
// where the bot stood, the tomb is in the state it was in then (gates, bridge,
// crane, flood), and the camera sits behind the direction of travel. This is
// what a player meets along the route, not a teleport into a sealed room.
//   VEIL_FILM=/tmp/film.json node tools/runthrough.mjs
//   FILM=/tmp/film.json node tools/playfilm.mjs [every=3]   -> snaps/playfilm-N.jpg
// ---------------------------------------------------------------------------
import * as pw from 'playwright-core';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const film = JSON.parse(fs.readFileSync(process.env.FILM || '/tmp/film.json', 'utf8'));
const every = +(process.argv[2] || 3);
const b = await pw.chromium.launch({ args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist'] });
const ctx = await b.newContext({ viewport: { width: 960, height: 540 } });
await ctx.addInitScript(() => localStorage.setItem('veil.settings.v1', JSON.stringify({ quality: 'high', tutorial: false, marker: false, captions: false, hints: false })));
const page = await ctx.newPage();
page.on('pageerror', e => console.log('page error', String(e)));
await page.goto(process.env.URL || 'http://127.0.0.1:8080/');
await page.waitForFunction(() => !document.getElementById('play').disabled, null, { timeout: 120000 });
await page.evaluate(() => document.getElementById('play').click());
await page.waitForFunction(() => __VEIL.game.t > 3000);
await page.addStyleTag({ content: '#hud,#chapter,#marker,#tut{display:none!important}' });
const shots = []; let yaw = Math.PI;
for (let i = 0; i < film.length; i += every) {
  const f = film[i];
  if (f.state !== 'ground') continue;
  if (Math.hypot(f.vx, f.vy) > 3) yaw = Math.atan2(f.vx, f.vy);
  await page.evaluate(([f, yaw]) => { const V = __VEIL, q = V.game.players[0];
    V.game.mech.apply(f.mech);
    Object.assign(q, { x: f.x, y: f.y, z: f.z, px: f.x, py: f.y, pz: f.z, vx: 0, vy: 0, vz: 0, state: 'ground', ledge: null, deadUntil: 0, hp: 100 });
    V.camYaw = yaw; V.camPitch = 0.22; }, [f, yaw]);
  await page.waitForTimeout(700);
  await page.evaluate(f => __VEIL.game.mech.apply(f.mech), f);
  await page.waitForTimeout(150);
  shots.push([`t=${f.t}s beat ${f.beat + 1} (${f.x | 0},${f.y | 0}) z${f.z}`, (await page.screenshot({ type: 'jpeg', quality: 75 })).toString('base64')]);
}
fs.mkdirSync(path.join(root, 'snaps'), { recursive: true });
const PER = 12;
for (let s = 0; s * PER < shots.length; s++) {
  const fr = shots.slice(s * PER, s * PER + PER);
  const sheet = await page.evaluate(fr => new Promise(res => {
    const cols = 3, w = 640, h = 360, rows = Math.ceil(fr.length / cols);
    const c = document.createElement('canvas'); c.width = cols * w; c.height = rows * h; const g = c.getContext('2d'); let n = 0;
    fr.forEach(([label, d], i) => { const im = new Image(); im.onload = () => { const x = (i % cols) * w, y = Math.floor(i / cols) * h;
      g.drawImage(im, x, y, w, h); g.fillStyle = 'rgba(0,0,0,.6)'; g.fillRect(x, y, 330, 26); g.fillStyle = '#fff'; g.font = '17px sans-serif'; g.fillText(label, x + 8, y + 19);
      if (++n === fr.length) res(c.toDataURL('image/jpeg', 0.82)); }; im.src = 'data:image/jpeg;base64,' + d; });
  }), fr);
  fs.writeFileSync(path.join(root, `snaps/playfilm-${s}.jpg`), Buffer.from(sheet.split(',')[1], 'base64'));
  console.log(`snaps/playfilm-${s}.jpg`);
}
await b.close();
