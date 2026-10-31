// ---------------------------------------------------------------------------
// What is standing at a spot: every mesh whose bounds reach within r metres of
// a game point, with its name chain, material and size. For "what is that?".
//   node tools/whatshere.mjs "x,y,z[,r]" ...      (npm start running)
// ---------------------------------------------------------------------------
import * as pw from 'playwright-core';
const b = await pw.chromium.launch({ args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist'] });
const page = await (await b.newContext()).newPage();
await page.goto(process.env.URL || 'http://127.0.0.1:8080/');
await page.waitForFunction(() => !document.getElementById('play').disabled, null, { timeout: 120000 });
await page.evaluate(() => document.getElementById('play').click());
await page.waitForFunction(() => __VEIL.game.t > 300);
for (const arg of process.argv.slice(2)) {
  const [x, y, z, r = 1.5] = arg.split(',').map(Number);
  const out = await page.evaluate(([x, y, z, r]) => {
    const V = __VEIL, T = V.THREE, S = 0.055, MAP = V.MAP;
    const p = new T.Vector3((x - MAP.w / 2) * S, z + 1, (y - MAP.h / 2) * S), bx = new T.Box3(), res = [];
    V.scene.traverse(o => {
      if (!(o.isMesh || o.isInstancedMesh || o.isSkinnedMesh) || !o.visible) return;
      let vis = true; for (let q = o; q; q = q.parent) if (!q.visible) vis = false; if (!vis) return;
      if (o.isInstancedMesh) return;
      bx.setFromObject(o); if (bx.isEmpty() || bx.distanceToPoint(p) > r) return;
      const sz = bx.getSize(new T.Vector3()); if (sz.x > 30 || sz.z > 30) return;
      const chain = []; for (let q = o; q && q !== V.scene; q = q.parent) chain.push((q.name || q.type) + (Object.keys(q.userData).length ? JSON.stringify(q.userData).slice(0, 60) : ""));
      const m = Array.isArray(o.material) ? o.material[0] : o.material;
      res.push(`${chain.slice(0, 7).join('<')}  ${m && m.type} col=${m && m.color ? m.color.getHexString() : '-'} map=${!!(m && m.map)} size=${sz.toArray().map(n => n.toFixed(2)).join('x')} at=${bx.getCenter(new T.Vector3()).toArray().map(n => n.toFixed(1)).join(',')}`);
    });
    return res;
  }, [x, y, z, r]);
  console.log(`== ${arg}\n  ` + out.join('\n  '));
}
await b.close();
