// ---------------------------------------------------------------------------
// The co-op RULES: with two runners, the gates need both of them.
//
// cooptest proves the wire works. This proves the design: with a human
// partner in slot 1 there is no solo window anywhere — the counterweight wants
// both hands at once, the crane is a relay across two levers, a crouched
// partner boosts you higher than you can jump, and the tomb lets you out only
// together. The same sequences alone still work the solo way.
// Drives the real Game in-process; no network.
// ---------------------------------------------------------------------------
const { Game } = await import('../src/game.js');
const { TICK, PHYS, S } = await import('../src/constants.js');
const { MECH } = await import('../src/mech.js');
const { BEATS } = await import('../src/story.js');

let fails = 0;
const ok = m => console.log('  ok    ' + m);
const bad = m => { fails++; console.log('  FAIL  ' + m); };
const scene = { add() {}, remove() {} };
const still = { mx: 0, my: 0, fwd: 0, strafe: 0, sprint: false, crouch: false, interact: false, attack: false, dodge: false, jump: false, jumpHeld: true, block: false };
const wire = (o = {}) => ({ mx: 0, my: 0, fwd: 0, strafe: 0, sp: 0, cr: 0, it: 0, at: 0, dg: 0, jp: 0, jh: 1, bl: 0, nm: 'NYX', ...o });

function newRun(coop) {
  const g = new Game(scene); g.init('ARIA');
  if (coop) Object.assign(g.players[1], { isBot: false, remote: true, ally: true, dormant: false, name: 'NYX' });
  return g;
}
function stand(p, x, y, z) {
  Object.assign(p, { x, y, z, px: x, py: y, pz: z, vx: 0, vy: 0, vz: 0, state: 'ground', ledge: null, regrab: 0 });
}
const run = (g, sec, me = still, partner = wire()) => { g.remoteInput = partner; for (let i = 0; i < sec / TICK; i++) g.update(TICK, me); };

console.log('\nCO-OP RULES — two runners, no solo windows\n');

// ---- who counts as co-op ----
{
  const solo = newRun(false), duo = newRun(true);
  (!solo.isCoop() && duo.isCoop()) ? ok('a human in slot 1 makes it a co-op run; the dormant ally does not') : bad('isCoop is wrong');
}

// ---- the counterweight: alone you sprint between levers; together, at once ----
for (const coop of [false, true]) {
  const g = newRun(coop);
  const a = g.players[0], b = g.players[1];
  stand(a, 592, 404, 5); stand(b, 724, 404, 5);
  // west lever for a second, then the east lever 2 s later — the solo sprint
  run(g, 1.0, { ...still, interact: true }, wire());
  if (!coop) { stand(a, 724, 404, 5); }
  run(g, 2.0, still, wire());
  if (coop) run(g, 1.0, still, wire({ it: 1 })); else run(g, 1.0, { ...still, interact: true }, wire());
  const dropped = g.mech.bridgeReleased;
  if (coop) dropped ? bad('co-op: one lever then the other 2 s later still dropped the bridge') : ok('co-op: the levers must be held together — a lever then the other 2 s later does nothing');
  else dropped ? ok('solo: the sprint between the levers still drops the bridge') : bad('solo sprint no longer works');
  if (coop) {
    run(g, 0.5, { ...still, interact: true }, wire({ it: 1 }));
    g.mech.bridgeReleased ? ok('co-op: both hands at once drops the bridge') : bad('co-op: both held and nothing happened');
  }
}

// ---- the crane: a relay ----
{
  const g = newRun(true);
  const a = g.players[0], b = g.players[1];
  stand(a, 1012, 400, 5); stand(b, 1104, 440, 7.5);
  run(g, 1.0, { ...still, interact: true }, wire());
  const out = g.mech.crane;
  run(g, 1.2, still, wire());
  const after = g.mech.crane;
  (out >= 1 && after < 0.92) ? ok(`co-op: the arm is out only while held (${out.toFixed(2)} held, ${after.toFixed(2)} 1.2 s after letting go)`)
    : bad(`co-op crane: held ${out}, after ${after}`);
  run(g, 1.0, still, wire({ it: 1 }));
  g.mech.crane >= 1 ? ok('co-op: the partner on the far lever brings the arm back for the runner left behind') : bad('the far lever does not work the crane');
  const s = newRun(false); stand(s.players[0], 1012, 400, 5);
  run(s, 1.0, { ...still, interact: true }); run(s, 3.0);
  s.mech.crane >= 1 ? ok(`solo: the arm still stays out after letting go (${MECH.soloGrace} s window)`) : bad('solo crane window lost');
}

// ---- the boost ----
{
  const peak = coop => {
    const g = newRun(true);
    const a = g.players[0], b = g.players[1];
    stand(a, 300, 300, 0); stand(b, 300 + 12, 300, 0);       // 0.66 m apart, open floor
    run(g, 0.3, still, wire({ cr: coop ? 1 : 0 }));
    let top = 0;
    g.remoteInput = wire({ cr: coop ? 1 : 0 });
    g.update(TICK, { ...still, jump: true });
    for (let i = 0; i < 90; i++) { g.update(TICK, still); top = Math.max(top, a.z); }
    return top;
  };
  const alone = peak(false), boosted = peak(true);
  (boosted > alone + 0.8) ? ok(`a crouched partner boosts the jump: apex ${alone.toFixed(2)} m alone, ${boosted.toFixed(2)} m off their back`)
    : bad(`boost apex ${boosted} vs ${alone}`);
}

// ---- out together ----
{
  const g = newRun(true);
  const a = g.players[0], b = g.players[1];
  g.story.beat = BEATS.length - 1; g.story.entered = g.story.beat;
  stand(a, 90, 455, 0); stand(b, 600, 300, 5);
  run(g, 0.5, still, wire());
  g.phase === 'playing' ? ok('co-op: one runner at the door does not end the run') : bad('the run ended with the partner still inside');
  stand(b, 95, 470, 0);
  run(g, 0.3, still, wire());
  g.phase === 'results' && g.won ? ok('co-op: both at the door, and the tomb is run') : bad(`both at the door: phase ${g.phase}`);
  const s = newRun(false);
  s.story.beat = BEATS.length - 1; s.story.entered = s.story.beat;
  stand(s.players[0], 90, 455, 0); run(s, 0.3);
  s.phase === 'results' ? ok('solo: reaching the door ends the run') : bad('solo exit broken');
}

console.log(fails ? `\nFAILED — ${fails}` : '\nPASSED — every co-op gate needs both runners');
process.exit(fails ? 1 : 0);
