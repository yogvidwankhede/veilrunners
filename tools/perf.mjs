// ---------------------------------------------------------------------------
// Frame time on the real GPU, measured, per quality tier.
//
// Headless Chromium with ANGLE on Metal uses this machine's GPU, so these are
// real numbers, not software rasteriser numbers. Reports p50/p95/p99 with
// vsync (what a player sees) at 2880x1620 for each tier, and again with the
// CPU throttled 4x to stand in for a weaker laptop. Fails if any tier misses
// its budget by more than 25% at p95.
//
//   npm start   (in another terminal)
//   node tools/perf.mjs
// ---------------------------------------------------------------------------
import * as pw from 'playwright-core';
const URL_ = process.env.URL || 'http://127.0.0.1:8080/';
const BUDGET = { high: 16.7, medium: 16.7, low: 33.3 };
const b = await pw.chromium.launch({ args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist'] });
let fails = 0;
console.log('\nFRAME TIME — real GPU, vsync on, 1440x810 @2x\n');
for (const throttle of [1, 4]) for (const q of ['high', 'medium', 'low']) {
  const ctx = await b.newContext({ viewport: { width: 1440, height: 810 }, deviceScaleFactor: 2 });
  await ctx.addInitScript(q => localStorage.setItem('veil.settings.v1', JSON.stringify({ quality: q, tutorial: false })), q);
  const page = await ctx.newPage();
  await page.goto(URL_);
  await page.waitForFunction(() => !document.getElementById('play').disabled, null, { timeout: 120000 });
  await page.evaluate(() => document.getElementById('play').click());
  await page.waitForFunction(() => __VEIL.game.t > 2500, null, { timeout: 60000 });
  if (throttle > 1) await (await ctx.newCDPSession(page)).send('Emulation.setCPUThrottlingRate', { rate: throttle });
  await page.keyboard.down('w'); await page.keyboard.down('Shift');
  await page.waitForTimeout(1200);
  await page.evaluate(() => { __VEIL.frames = null; __VEIL.profile(4); });
  await page.waitForFunction(() => !!__VEIL.frames, null, { timeout: 30000 });
  const f = await page.evaluate(() => __VEIL.frames);
  const over = f.p95 > BUDGET[q] * 1.25;
  if (over) fails++;
  console.log(`  ${over ? 'FAIL' : 'ok  '}  ${q.padEnd(6)} cpu x${throttle}  p50 ${String(f.p50).padStart(5)}  p95 ${String(f.p95).padStart(5)}  p99 ${String(f.p99).padStart(5)} ms  ` +
    `budget ${BUDGET[q]}  draw calls ${f.calls}  tris ${f.tris}`);
  await ctx.close();
}
await b.close();
console.log(fails ? `\nFAILED — ${fails} tier(s) over budget` : '\nPASSED — every tier inside its frame budget');
process.exit(fails ? 1 : 0);
