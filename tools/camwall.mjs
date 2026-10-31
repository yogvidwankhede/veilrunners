// ---------------------------------------------------------------------------
// CAMERA IN STONE. The runner stands against every wall face in the tomb and
// the camera is turned all the way round; at no angle may the lens end up
// inside a block or inside the carved stone. A lens inside a wall shows the
// player the level from outside: the backs of walls, black shards, the void.
//   node tools/camwall.mjs          (needs `npm start` running)
// ---------------------------------------------------------------------------
import * as pw from 'playwright-core';
const b = await pw.chromium.launch({ args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist'] });
const ctx = await b.newContext({ viewport: { width: 640, height: 480 } });
await ctx.addInitScript(() => localStorage.setItem('veil.settings.v1', JSON.stringify({ quality: 'low', tutorial: false, marker: false, captions: false, hints: false })));
const page = await ctx.newPage();
page.on('pageerror', e => console.log('page error', String(e)));
await page.goto(process.env.URL || 'http://127.0.0.1:8080/');
await page.waitForFunction(() => !document.getElementById('play').disabled, null, { timeout: 120000 });
await page.evaluate(() => { localStorage.setItem('veil.mode', 'solo'); document.getElementById('play').click(); });
await page.waitForFunction(() => __VEIL.game.t > 2600, null, { timeout: 60000 });

const out = await page.evaluate(async () => {
  const V = __VEIL, g = V.game, q = g.players[0], MAP = V.MAP, S = 0.055, C = V.col;
  const hx = MAP.w / 2, hz = MAP.h / 2, cam = V.camera.position, T = V.THREE;
  const frame = () => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
  const d = new T.Vector3();
  // inside a level box, or inside a carved cell of the baked grid
  const inStone = p => {
    for (const w of MAP.walls) {
      if (w.off) continue;
      const x0 = (w.x - hx) * S, x1 = (w.x + w.w - hx) * S, z0 = (w.y - hz) * S, z1 = (w.y + w.h - hz) * S;
      if (p.x > x0 + 0.02 && p.x < x1 - 0.02 && p.z > z0 + 0.02 && p.z < z1 - 0.02 && p.y < w.top + 0.1) return `box ${MAP.walls.indexOf(w)} (top ${w.top})`;
    }
    // gridRayHit only looks from 0.3 m along its ray: start 0.3 m short
    return C.gridRayHit(p.x, p.y - 0.3, p.z, 0, 1, 0, 0.34) < Infinity ? 'carved' : null;
  };
  let tried = 0; const bad = [];
  for (const w of MAP.walls) {
    if (w.off) continue;
    const faces = [[w.x + w.w / 2, w.y, 0, -1], [w.x + w.w / 2, w.y + w.h, 0, 1], [w.x, w.y + w.h / 2, -1, 0], [w.x + w.w, w.y + w.h / 2, 1, 0]];
    for (const [fx, fy, nx, ny] of faces) {
      const sx = fx + nx * 9, sy = fy + ny * 9;
      // the shell's outer faces stand outside the tomb: nobody plays there
      if (sx < 0 || sy < 0 || sx > MAP.w || sy > MAP.h) continue;
      const gz = C.groundAt(sx, sy);
      if (C.blockedAt(sx, sy, gz) || w.top - gz < 1.2) continue;
      for (let a = 0; a < 8; a++) {
        Object.assign(q, { x: sx, y: sy, px: sx, py: sy, z: gz, pz: gz, vx: 0, vy: 0, vz: 0, state: 'ground', ledge: null });
        V.camYaw = Math.atan2(nx, ny) + a * Math.PI / 4; V.camPitch = a % 2 ? 0.55 : 0.16;
        for (let f = 0; f < 6; f++) await frame();
        // the counted floor's tiles drop and rise again; a runner the floor
        // came back up around is not a camera question
        if (C.blockedAt(q.x, q.y, q.z) || Math.abs(q.z - gz) > 0.1) continue;
        tried++;
        const s = inStone(cam);
        if (s) bad.push(`wall ${MAP.walls.indexOf(w)} face ${nx},${ny} turn ${a}: lens in ${s} at ${[cam.x, cam.y, cam.z].map(v => v.toFixed(2))} (runner z ${q.z.toFixed(2)} state ${q.state}, stood on ${gz})`);
      }
    }
  }
  return { tried, bad };
});
await b.close();
console.log(`camera: ${out.tried} views against the stone, ${out.bad.length} with the lens inside it`);
for (const l of out.bad.slice(0, 20)) console.log('  ' + l);
console.log(out.bad.length ? 'FAILED' : 'PASSED');
process.exit(out.bad.length ? 1 : 0);
