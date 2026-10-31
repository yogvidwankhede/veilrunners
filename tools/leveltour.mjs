// ---------------------------------------------------------------------------
// A photographic tour of the level with the real renderer: an overview and a
// player-height view of every chamber, as a contact sheet. For judging the
// environment art the way a player meets it.
//   node tools/leveltour.mjs        (npm start running)   -> snaps/tour.jpg
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
// [label, game x, game y, z, camera yaw, pitch]  — a player standing there, looking on
const SHOTS = [
  ['the crypt, to the screen wall', 175, 760, 0, Math.PI, 0.12],
  ['the crypt doorway', 190, 380, 0, Math.PI, 0.1],
  ['front door and obelisks', 150, 455, 0, -Math.PI / 2, 0.15],
  ['stair hall', 190, 260, 0, Math.PI * 0.8, 0.2],
  ['the counterweight wheel', 655, 330, 5, Math.PI, 0.02],
  ['the Cradle, from the inner wall', 352, 470, 5, Math.PI * 0.62, 0.15],
  ['the Cradle, from the gallery', 380, 110, 2.5, 0.25, 0.2],
  ['north gallery', 300, 160, 0, Math.PI * 0.75, 0.35],
  ['gallery top', 420, 100, 2.5, -Math.PI / 2, 0.25],
  ['mechanism chamber', 540, 300, 5, -Math.PI / 2, 0.3],
  ['counterweight levers', 660, 470, 5, Math.PI, 0.3],
  ['the counted floor, under the arches', 812, 370, 5, Math.PI / 2, 0.08],
  ['the aqueduct, on the escape', 775, 650, 5, -Math.PI / 2 - 0.5, 0.1],
  ['crane gap', 1010, 370, 5, -Math.PI / 2, 0.3],
  ['tower', 1120, 330, 7.5, 0, 0.35],
  ['sanctum', 1000, 545, 7.5, 0, 0.45],
  ['rubble escape', 700, 650, 5, Math.PI / 2, 0.3],
  ['flood hall', 260, 600, 0, Math.PI / 2 + 0.4, 0.25],
];
const shots = [];
for (const [label, x, y, z, yaw, pitch] of SHOTS) {
  await page.evaluate(([x, y, z, yaw, pitch]) => { const V = __VEIL, q = V.game.players[0];
    Object.assign(q, { x, y, z, px: x, py: y, pz: z, vx: 0, vy: 0, vz: 0, state: 'ground' });
    V.camYaw = yaw; V.camPitch = pitch; }, [x, y, z, yaw, pitch]);
  await page.waitForTimeout(900);
  shots.push([label, (await page.screenshot({ type: 'jpeg', quality: 80 })).toString('base64')]);
}
// overview: hold the camera high over the middle of the tomb
await page.evaluate(() => { const V = __VEIL, T = V.THREE; V.camHold = { pos: new T.Vector3(-10, 34, 30), at: new T.Vector3(2, 2, 0) }; });
await page.waitForTimeout(900);
shots.unshift(['overview', (await page.screenshot({ type: 'jpeg', quality: 80 })).toString('base64')]);
const sheet = await page.evaluate(fr => new Promise(res => {
  const cols = 3, w = 640, h = 360, rows = Math.ceil(fr.length / cols);
  const c = document.createElement('canvas'); c.width = cols * w; c.height = rows * h; const g = c.getContext('2d'); let n = 0;
  fr.forEach(([label, d], i) => { const im = new Image(); im.onload = () => { const x = (i % cols) * w, y = Math.floor(i / cols) * h;
    g.drawImage(im, x, y, w, h); g.fillStyle = 'rgba(0,0,0,.6)'; g.fillRect(x, y, 260, 26); g.fillStyle = '#fff'; g.font = '18px sans-serif'; g.fillText(label, x + 8, y + 19);
    if (++n === fr.length) res(c.toDataURL('image/jpeg', 0.85)); }; im.src = 'data:image/jpeg;base64,' + d; });
}), shots);
fs.mkdirSync(path.join(root, 'snaps'), { recursive: true });
fs.writeFileSync(path.join(root, 'snaps/tour.jpg'), Buffer.from(sheet.split(',')[1], 'base64'));
await b.close();
console.log('snaps/tour.jpg');
