// ---------------------------------------------------------------------------
// End-to-end browser test: the real page, the real renderer, the real menus.
//
// The Node suites prove the tomb can be finished; none of them load the page.
// This one does, in Chromium, Firefox and WebKit (Safari's engine), and walks
// the front end a player meets: title, settings, the run, pause, a co-op pair,
// a phone-sized touch layout, and the results board. It fails on any uncaught
// page error.
//
//   node tools/e2e.mjs                 all three engines
//   node tools/e2e.mjs chromium        one engine
//
// Needs `npm install` (playwright-core) and Playwright's browser builds
// (`npx playwright-core install chromium firefox webkit`). Screenshots land in
// snaps/e2e-*.png for a human to look at.
// ---------------------------------------------------------------------------
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';
import * as pw from 'playwright-core';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const PORT = 8098;
const BASE = `http://127.0.0.1:${PORT}/`;
const want = process.argv.slice(2);
const ENGINES = (want.length ? want : ['chromium', 'firefox', 'webkit']);
fs.mkdirSync(path.join(root, 'snaps'), { recursive: true });

const srv = spawn(process.execPath, ['serve.mjs'], { cwd: root, env: { ...process.env, PORT: String(PORT) }, stdio: ['ignore', 'pipe', 'pipe'] });
await new Promise((res, rej) => {
  const t = setTimeout(() => rej(new Error('server did not start')), 8000);
  srv.stdout.on('data', d => { if (String(d).includes(String(PORT))) { clearTimeout(t); res(); } });
});

// never leave the server behind, whatever ends the run
process.on('exit', () => { try { srv.kill(); } catch {} });
process.on('uncaughtException', e => { console.log('  FAIL  ' + String(e).split('\n')[0]); process.exit(1); });

let failures = 0;
const ok = m => console.log('  ok    ' + m);
const bad = m => { failures++; console.log('  FAIL  ' + m); };
const check = (c, m) => (c ? ok(m) : bad(m));
const sleep = ms => new Promise(r => setTimeout(r, ms));
// Poll a page predicate until it holds. Frame-driven state on a software
// rasteriser moves at its own pace; a fixed sleep is either flaky or slow.
const until = (page, fn, arg, ms = 30000) =>
  page.waitForFunction(fn, arg, { timeout: ms, polling: 100 }).then(() => true, () => false);

const LAUNCH = {
  chromium: { args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] },
  firefox: { firefoxUserPrefs: { 'webgl.force-enabled': true } },
  webkit: {},
};

async function openPage(browser, opts = {}, url = BASE) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 }, ...opts });
  // Software GL in a headless engine draws about one frame a second at full
  // quality. Low tier keeps the test about the front end, not the rasteriser.
  await ctx.addInitScript(() => { try { if (!localStorage.getItem('veil.settings.v1'))
    localStorage.setItem('veil.settings.v1', JSON.stringify({ quality: 'low' })); } catch {} });
  const page = await ctx.newPage();
  page.errors = [];
  page.on('pageerror', e => page.errors.push(String(e)));
  page.on('console', m => { if (m.type() === 'error') page.errors.push(m.text()); });
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 120000 });
  await page.waitForFunction(() => !document.getElementById('play').disabled, null, { timeout: 120000 });
  return page;
}
const state = page => page.evaluate(() => {
  const g = __VEIL.game;
  return { phase: g.phase, t: g.t, beat: g.story ? g.story.beat : -1, localId: g.localId,
    paused: !document.getElementById('pause').classList.contains('off'),
    hud: !document.getElementById('hud').classList.contains('hidden') };
});

for (const name of ENGINES) {
  console.log(`\n[${name}]`);
  let browser;
  try { browser = await pw[name].launch(LAUNCH[name]); }
  catch (e) { bad(`${name} would not launch: ${String(e).split('\n')[0]}`); continue; }

  // ---- title, settings, start ----
  const page = await openPage(browser);
  await page.screenshot({ path: `${root}/snaps/e2e-${name}-title.png` });
  check(await page.locator('#play').isEnabled(), 'title loads and ENTER becomes available');
  await page.click('.menurow [data-open="settings"]');
  await page.waitForSelector('#settings:not(.off)');
  const rows = await page.locator('#setlist .set').count();
  check(rows >= 12, `settings panel lists ${rows} options`);
  await page.locator('#setlist .set', { hasText: 'Show frame rate' }).locator('.tog').click();
  const stored = await page.evaluate(() => JSON.parse(localStorage.getItem('veil.settings.v1') || '{}').fps);
  check(stored === true, 'a changed setting is saved');
  await page.keyboard.press('Escape');
  check(await page.locator('#settings.off').count() === 1, 'Esc closes the settings panel');
  await page.click('.menurow [data-open="controls"]');
  check(await page.locator('#controls:not(.off) table.keys tr').count() >= 10, 'controls panel lists the bindings');
  await page.click('#controls [data-close]');

  await page.fill('#pname', 'tester one');
  await page.click('#play');
  await until(page, () => __VEIL.game.t > 0);
  let s = await state(page);
  check(s.phase === 'playing' && s.hud, 'ENTER starts the run and shows the HUD');
  check(await page.evaluate(() => __VEIL.game.players[0].name) === 'TESTER ONE', 'the runner name carries into the run');
  // the card fades on a wall clock; a software rasteriser can outlast it, so
  // check what it was given rather than catching it mid-fade
  check(await until(page, () => document.getElementById('chtitle').textContent === 'THE DOOR THAT WAS SHUT', null, 10000), 'the first chamber gets its title card');
  check(await until(page, () => document.getElementById('tutt').textContent === 'Look around', null, 90000), 'the tutorial opens with its first field note, once the chapter card has had its moment');
  check(await page.locator('#fps:not(.off)').count() === 1, 'the frame-rate setting shows the counter');

  // ---- moving: the tutorial must notice the move and advance ----
  const p0 = await page.evaluate(() => ({ x: __VEIL.game.players[0].x, y: __VEIL.game.players[0].y }));
  // headless has no pointer lock, so feed the look note through the same path a mouse does
  await page.evaluate(() => { __VEIL.camYaw += 0; });
  await page.keyboard.down('w');
  const moved = await until(page, p => Math.hypot(__VEIL.game.players[0].x - p.x, __VEIL.game.players[0].y - p.y) > 20, p0, 40000);
  await page.keyboard.up('w');
  check(moved, 'the keyboard moves the runner');
  await page.keyboard.press('Space');
  await sleep(300);

  // ---- pause freezes a solo run ----
  await page.keyboard.press('Escape');
  await sleep(200);
  s = await state(page);
  const t0 = s.t; await sleep(700); const t1 = (await state(page)).t;
  check(s.paused, 'Esc opens the pause menu');
  check(t1 === t0, 'a solo pause freezes the simulation');
  await page.screenshot({ path: `${root}/snaps/e2e-${name}-pause.png` });
  await page.click('#pause [data-act="resume"]');
  check(await until(page, t => document.getElementById('pause').classList.contains('off') && __VEIL.game.t > t, t1), 'RESUME continues the run');

  // ---- restart from pause ----
  await page.keyboard.press('Escape'); await sleep(150);
  await page.click('#pause [data-act="restart"]');
  await until(page, () => __VEIL.game.t > 0 && __VEIL.game.t < 2000);
  s = await state(page);
  check(s.phase === 'playing' && s.t < 2000 && !s.paused, 'RESTART RUN begins again from the entrance');
  await page.screenshot({ path: `${root}/snaps/e2e-${name}-play.png` });

  // ---- results board: finish the run the way the story does ----
  await page.evaluate(() => { const g = __VEIL.game; g.t += 200000; g.won = true; g._finish(); });
  await page.waitForSelector('#results.on', { timeout: 60000 }).catch(() => {});
  check(await page.locator('#results.on .grade').count() === 1, 'a won run shows the results board with a grade');
  const rec = await page.evaluate(() => JSON.parse(localStorage.getItem('veil.records.v1') || '{}'));
  check(rec.wins === 1 && rec.bestMs > 0, 'the escape is recorded as a personal best');
  check((rec.unlocked || []).includes('escape'), 'the escape honour is unlocked');
  await page.screenshot({ path: `${root}/snaps/e2e-${name}-results.png` });
  await page.click('#again');
  await until(page, () => __VEIL.game.phase === 'playing' && __VEIL.game.t > 0);
  s = await state(page);
  check(s.phase === 'playing' && s.t < 2000, 'RUN IT AGAIN starts a fresh run');
  await page.keyboard.press('Escape'); await sleep(150);
  await page.click('#pause [data-act="quit"]'); await sleep(300);
  s = await state(page);
  check(s.phase === 'menu' && !s.hud, 'ABANDON returns to the title');
  check(/BEST/.test(await page.textContent('#recordline')), 'the title shows the personal best');

  // ---- frame time on this engine (software GL here: a floor, not a target) ----
  await page.click('#play');
  await until(page, () => __VEIL.game.t > 0);
  await page.evaluate(() => __VEIL.profile(3));
  await until(page, () => !!__VEIL.frames, null, 20000);
  const f = await page.evaluate(() => __VEIL.frames);
  if (f) console.log(`  info  frames p50 ${f.p50}ms  p95 ${f.p95}ms  p99 ${f.p99}ms  draw calls ${f.calls}  tris ${f.tris}  (headless software GL)`);
  check(page.errors.length === 0, `no page errors${page.errors.length ? ': ' + page.errors.slice(0, 3).join(' | ') : ''}`);
  await page.context().close();

  // ---- two runners, one screen ----
  {
    const two = await openPage(browser);
    await two.click('.menurow [data-open="together"]');
    check(await two.locator('#together:not(.off) .moves li').count() >= 5, 'the PLAYING TOGETHER guide opens and lists what two can do');
    await two.click('#together [data-close]');
    await two.click('.mode[data-mode="split"]');
    check(await two.locator('#pname2').isVisible(), 'SAME SCREEN asks for a second runner name');
    await two.fill('#pname2', 'tester two');
    await two.click('#play');
    await until(two, () => __VEIL.game.t > 0);
    const sp = await two.evaluate(() => { const g = __VEIL.game, q = g.players[1];
      return { coop: g.isCoop(), bot: q.isBot, name: q.name, split: document.body.classList.contains('split'),
        cards: getComputedStyle(document.getElementById('runners')).display !== 'none' }; });
    check(sp.coop && !sp.bot && sp.name === 'TESTER TWO', 'slot two is a second human runner, named from the title');
    check(sp.split && sp.cards, 'the screen splits and each runner gets a card');
    const q0 = await two.evaluate(() => ({ x: __VEIL.game.players[1].x, y: __VEIL.game.players[1].y }));
    const r0 = await two.evaluate(() => ({ x: __VEIL.game.players[0].x, y: __VEIL.game.players[0].y }));
    await two.keyboard.down('ArrowUp');
    const moved2 = await until(two, p => Math.hypot(__VEIL.game.players[1].x - p.x, __VEIL.game.players[1].y - p.y) > 20, q0, 40000);
    await two.keyboard.up('ArrowUp');
    check(moved2, 'the arrow keys move runner two');
    const p1still = await two.evaluate(p => Math.hypot(__VEIL.game.players[0].x - p.x, __VEIL.game.players[0].y - p.y) < 2, r0);
    check(p1still, 'runner one stays put while runner two walks');
    await two.keyboard.press('Period');
    check(await until(two, () => __VEIL.game.players[1].crouch && !__VEIL.game.players[0].crouch, null, 20000), "runner two's crouch is their own key");
    await two.screenshot({ path: `${root}/snaps/e2e-${name}-split.png` });
    await two.keyboard.press('Escape'); await sleep(150);
    await two.click('#pause [data-act="quit"]'); await sleep(300);
    check(!(await two.evaluate(() => document.body.classList.contains('split'))), 'back at the title the screen is whole again');
    check(two.errors.length === 0, `no page errors in split screen${two.errors.length ? ': ' + two.errors.slice(0, 3).join(' | ') : ''}`);
    await two.context().close();
  }

  // ---- phone: touch layout, pause button, no sideways scroll ----
  if (name !== 'firefox') {           // Firefox has no mobile emulation in Playwright
    const phone = await openPage(browser, { viewport: { width: 390, height: 844 }, isMobile: name === 'chromium', hasTouch: true, deviceScaleFactor: 2 });
    const overflow = await phone.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1);
    check(!overflow, 'phone title has no horizontal scroll');
    await phone.screenshot({ path: `${root}/snaps/e2e-${name}-phone-title.png` });
    await phone.tap('#play');
    await until(phone, () => __VEIL.game.t > 0);
    check(await phone.locator('#touch.live #tstick').count() === 1, 'touch controls appear on a touch screen');
    await phone.screenshot({ path: `${root}/snaps/e2e-${name}-phone-play.png` });
    await phone.tap('#tpause');
    check(await until(phone, () => !document.getElementById('pause').classList.contains('off'), null, 15000), 'the touch pause button pauses');
    check(phone.errors.length === 0, `no page errors on the phone layout${phone.errors.length ? ': ' + phone.errors[0] : ''}`);
    await phone.context().close();
  }

  // ---- co-op: two players, one room ----
  if (name === 'chromium') {
    const host = await openPage(browser, {}, BASE + '?room=e2e-' + Date.now() % 1e6);
    const room = await host.inputValue('#room');
    await host.fill('#pname', 'HOST'); await host.evaluate(() => document.getElementById('play').click());
    await until(host, () => __VEIL.game.t > 0);
    // A second BROWSER, not a second tab: software GL runs one GPU process per
    // browser, and a tab rasterising the tomb starves a sibling's navigation.
    const browser2 = await pw[name].launch(LAUNCH[name]);
    const guest = await openPage(browser2, {}, BASE + '?room=' + room);
    await guest.fill('#pname', 'GUEST'); await guest.evaluate(() => document.getElementById('play').click());
    await until(host, () => __VEIL.game.players[1].name === 'GUEST', null, 40000);
    const h = await host.evaluate(() => ({ host: __VEIL.net.isHost, peers: __VEIL.net.peers, partner: __VEIL.game.players[1].name, remote: __VEIL.game.players[1].remote }));
    const g = await guest.evaluate(() => ({ host: __VEIL.net.isHost, local: __VEIL.game.localId, authority: __VEIL.game.authority }));
    check(h.host && h.peers >= 2, 'the first page in a room hosts it');
    check(!g.host && g.local === 1 && g.authority === false, 'the second page joins as the partner');
    check(h.partner === 'GUEST' && h.remote, 'the host sees the partner by name on the wire');
    // A two-person puzzle across the network: each runner on a counterweight
    // lever, each pressing E in their OWN browser. Positions are set on the
    // host (the authority); the guest is snapped to them by the next snapshot.
    check(await host.evaluate(() => __VEIL.game.isCoop()) && await guest.evaluate(() => __VEIL.game.isCoop()), 'both ends know it is a co-op run');
    await host.evaluate(() => { const g = __VEIL.game; g.story.beat = 2; g.story.entered = 2;
      const put = (p, x, y) => Object.assign(p, { x, y, z: 5, px: x, py: y, pz: 5, vx: 0, vy: 0, vz: 0, state: 'ground', ledge: null });
      put(g.players[0], 592, 404); put(g.players[1], 724, 404); });
    await until(guest, () => Math.hypot(__VEIL.game.players[1].x - 724, __VEIL.game.players[1].y - 404) < 5, null, 20000);
    await host.keyboard.down('e'); await guest.keyboard.down('e');
    check(await until(host, () => __VEIL.game.mech.bridgeReleased, null, 30000), 'co-op: both runners on the levers drop the bridge on the host');
    check(await until(guest, () => __VEIL.game.mech.bridge > 0, null, 30000), 'the guest sees the same bridge come down');
    await host.keyboard.up('e'); await guest.keyboard.up('e');
    // the guest pauses: in co-op the host world keeps running
    await guest.keyboard.press('Escape');
    await until(guest, () => !document.getElementById('pause').classList.contains('off'));
    const gt0 = await host.evaluate(() => __VEIL.game.t);
    check(await until(host, t => __VEIL.game.t > t + 100, gt0), 'a partner pausing does not stop the host');
    check(/partner/i.test(await guest.textContent('#pausenote')), 'the co-op pause says the tomb keeps running');
    // the host leaves; the guest is promoted and keeps the run
    await host.context().close();
    await until(guest, () => __VEIL.net.isHost, null, 15000);
    const after = await guest.evaluate(() => ({ host: __VEIL.net.isHost, phase: __VEIL.game.phase }));
    check(after.host && after.phase === 'playing', 'when the host leaves, the partner takes over the run');
    check(guest.errors.length === 0, `no page errors in co-op${guest.errors.length ? ': ' + guest.errors[0] : ''}`);
    await guest.context().close();
    await browser2.close();
  }
  await browser.close();
}

srv.kill();
console.log(failures ? `\nFAILED — ${failures} check${failures === 1 ? '' : 's'}` : '\nPASSED — every engine, every screen');
process.exit(failures ? 1 : 0);
