// ---------------------------------------------------------------------------
// Is THE CRADLE OF SILT actually completable? Pure data, no browser.
//
// This exists because the failure it catches is silent and total: a tomb with
// one unreachable ledge, one buried lever or one escape route under the flood
// line is not a hard level, it is an unfinishable one, and you find out twelve
// minutes into a playthrough. Every rule below is the same rule traversal.js
// and mech.js use at runtime, read from the same constants.
// ---------------------------------------------------------------------------
import { WALLS, INTERACTABLES, CHECKPOINTS, SPAWNS, PITS, WATER, BRAZIER_ORDER, TIER, anchorLamps, LAMP_SNAP } from '../src/level.js';
import { PHYS, RULES, S, MAP } from '../src/constants.js';
import { groundAt, blockedAt } from '../src/traversal.js';
import { MECH } from '../src/mech.js';
import fsx from 'node:fs';

const PAD = PHYS.bodyRadius / S, GRAB = PHYS.grabRange, REACH = PHYS.reach, MIN = PHYS.minLedge, STEP = PHYS.stepUp;
const STEP_UP = PHYS.stepUp;   // `STEP` is also the flood-fill grid size below
const MOVING = ['bridge_main', 'crane_arm', 'door_sanctum', 'door_front', 'gate_causeway', 'tile_a', 'tile_b', 'tile_c'];
let fails = 0, warns = 0;
const bad  = m => { console.log('  FAIL  ' + m); fails++; };
const warn = m => { console.log('  warn  ' + m); warns++; };
const ok   = m => console.log('  ok    ' + m);

// horizontal gap between two footprints (0 when they overlap)
const gap = (a, b) => {
  const dx = Math.max(0, Math.max(a.x - (b.x + b.w), b.x - (a.x + a.w)));
  const dy = Math.max(0, Math.max(a.y - (b.y + b.h), b.y - (a.y + a.h)));
  return Math.hypot(dx, dy);
};
const covers = (w, x, y) => x > w.x && x < w.x + w.w && y > w.y && y < w.y + w.h;
const surfaceAt = (x, y, live) => {
  let h = 0, host = null;
  for (const w of live) if (covers(w, x, y) && w.top > h) { h = w.top; host = w; }
  return { z: h, host };
};
const inPit = (x, y) => PITS.find(q => x > q.x && x < q.x + q.w && y > q.y && y < q.y + q.h);

// Which pieces exist in a given mechanism state. `open` = the fully-solved tomb.
function liveSet({ bridge = false, crane = false, sealOpen = false, frontOpen = false, tiles = true } = {}) {
  return WALLS.filter(w => {
    if (w.id === 'bridge_main')  return bridge;
    if (w.id === 'crane_arm')    return crane;
    if (w.id === 'door_sanctum') return !sealOpen;
    if (w.id === 'door_front')   return !frontOpen;
    if (w.id === 'gate_causeway') return !bridge;    // rises with the counterweight
    if (w.id && w.id.startsWith('tile_')) return tiles;
    return true;
  });
}

// Reachable surfaces, by the runtime rule: walk up a step, or climb a rise
// between minLedge and reach, from the ground or from somewhere you already are.
function reachable(live) {
  const got = new Set();
  let changed = true;
  while (changed) {
    changed = false;
    live.forEach((w, i) => {
      if (got.has(i)) return;
      if (w.top <= STEP || (w.top >= MIN && w.top <= REACH)) { got.add(i); changed = true; return; }
      for (const j of got) {
        const o = live[j];
        if (gap(o, w) > GRAB + PAD) continue;
        const rise = w.top - o.top;
        if (rise <= STEP || (rise >= MIN && rise <= REACH)) { got.add(i); changed = true; return; }
      }
    });
  }
  return got;
}

console.log(`\nTHE CRADLE OF SILT · completability`);
console.log(`reach ${REACH}m · minLedge ${MIN}m · stepUp ${STEP}m · grab ${GRAB}u · pad ${PAD}u`);

// ---------------------------------------------------------------------------
console.log('\n[1] every surface reachable in the fully-opened tomb');
const openLive = liveSet({ bridge: true, crane: true, sealOpen: true, frontOpen: true });
const openGot = reachable(openLive);
// BARRIERS are meant to be unclimbable: the 12 m shell (a tomb you can walk out
// over the top of is not a tomb) and the 11 m chamber walls (whose whole job is
// to stand between you and the next chamber). Both are excluded from the
// reachability sweep and asserted the other way round instead — if one of them
// ever becomes climbable, that is the failure.
// The hall's screen wall, its columns and the door's obelisks are barriers too:
// architecture to walk around, never to stand on.
const BARRIER = new Set(['shell', 'chamberwall', 'screen', 'column', 'obelisk', 'arch', 'aqueduct']);
const unreach = openLive.map((w, i) => ({ w, i })).filter(({ w, i }) => !BARRIER.has(w.tag) && !openGot.has(i));
const playable = openLive.filter(w => !BARRIER.has(w.tag)).length;
if (!unreach.length) ok(`${playable}/${playable} playable surfaces reachable`);
else unreach.forEach(({ w }) => bad(`unreachable ${w.tag}${w.id ? '#' + w.id : ''} at (${w.x},${w.y}) top ${w.top}m`));
const climbed = openLive.map((w, i) => ({ w, i })).filter(({ w, i }) => BARRIER.has(w.tag) && openGot.has(i));
if (climbed.length) climbed.forEach(({ w }) =>
  bad(`${w.tag} at (${w.x},${w.y}) top ${w.top}m is CLIMBABLE — it is meant to be a barrier`));
else ok(`${openLive.filter(w=>BARRIER.has(w.tag)).length} barriers hold: nothing climbs the shell or a chamber wall`);

// ---------------------------------------------------------------------------
console.log('\n[2] beat 2 works with the bridge still RAISED (that is the point of it)');
const shutLive = liveSet({});                       // nothing opened yet
const shutGot = reachable(shutLive);
const mechFloor = shutLive.findIndex(w => w.tag === 'floor' && w.top === TIER.mid);
if (mechFloor < 0) bad('no mechanism floor in the data');
else if (shutGot.has(mechFloor)) ok('mechanism floor reachable before the bridge drops, via the gallery');
else bad('mechanism floor NOT reachable with the bridge up — beat 3 is unreachable');

// ---------------------------------------------------------------------------
console.log('\n[2b] the crane is genuinely the gate: no crane, no tower');
{
  const noCrane = liveSet({ bridge: true, crane: false, sealOpen: true, frontOpen: true });
  const got = reachable(noCrane);
  const tower = noCrane.findIndex(w => w.tag === 'tower');
  if (tower < 0) bad('no tower in the data');
  else if (got.has(tower)) bad('the tower is reachable WITHOUT the crane — beat 5 can be skipped');
  else ok('the tower is unreachable until the crane arm swings in');
}

// ---------------------------------------------------------------------------
console.log('\n[3] interactables stand on a reachable surface at their stated height');
for (const it of INTERACTABLES) {
  const { z, host } = surfaceAt(it.x, it.y, openLive);
  if (!host && it.z > 0.05) { bad(`${it.id} floats at z=${it.z} over open ground`); continue; }
  // 0.5, not 1.2. A 1.2 m tolerance passed a lever that was sitting inside a
  // 6.05 m altar while claiming to be on the 5 m floor — reachable from neither.
  const dz = Math.abs(z - it.z);
  if (dz > 0.5) { bad(`${it.id} says z=${it.z} but the surface under it is ${z.toFixed(2)} (${host ? host.tag : 'ground'}) — off by ${dz.toFixed(2)}m`); continue; }
  const idx = host ? openLive.indexOf(host) : -1;
  if (idx >= 0 && !openGot.has(idx)) { bad(`${it.id} sits on an unreachable ${host.tag}`); continue; }
  if (inPit(it.x, it.y) && it.z <= inPit(it.x, it.y).z) { bad(`${it.id} is inside ${inPit(it.x, it.y).name}`); continue; }
  ok(`${it.id.padEnd(20)} z=${it.z} on ${host ? host.tag : 'ground'}`);
}

// ---------------------------------------------------------------------------
console.log('\n[4] checkpoints are solid, dry and outside the walls');
CHECKPOINTS.forEach((c, i) => {
  const { z, host } = surfaceAt(c.x, c.y, openLive);
  const pit = inPit(c.x, c.y);
  if (Math.abs(z - c.z) > 0.6) bad(`checkpoint ${i} says z=${c.z}, surface is ${z.toFixed(2)}`);
  else if (pit && c.z <= pit.z) bad(`checkpoint ${i} is inside ${pit.name}`);
  else if (host && host.id) warn(`checkpoint ${i} stands on MOVING piece ${host.id} — it can vanish under a respawn`);
  else ok(`checkpoint ${i} (${c.x},${c.y}) z=${c.z} on ${host ? host.tag : 'ground'}`);
});

// ---------------------------------------------------------------------------
console.log('\n[5] spawns are not buried');
SPAWNS.forEach((s, i) => {
  const hit = openLive.find(w => !MOVING.includes(w.id) && s.x > w.x - PAD && s.x < w.x + w.w + PAD
    && s.y > w.y - PAD && s.y < w.y + w.h + PAD && w.top > STEP);
  const { z } = surfaceAt(s.x, s.y, openLive);
  if (hit && z < hit.top - 0.1) bad(`spawn ${i} (${s.x},${s.y}) is wedged in ${hit.tag} top ${hit.top}m`);
  else ok(`spawn ${i} (${s.x},${s.y}) stands at z=${z.toFixed(2)}`);
});

// ---------------------------------------------------------------------------
// [6] THE ESCAPE. Walk a surface graph west from the sanctum to the front door
// and maximise the LOWEST surface on the route: that minimum is the deepest the
// flood can reach you before you are past it.
console.log('\n[6] the escape route west, and whether the flood beats it');
{
  const live = liveSet({ bridge: true, crane: true, sealOpen: true, frontOpen: true });
  const start = live.findIndex(w => w.tag === 'sanctumfloor');
  const doorY = 455, doorX = 92;
  // best[i] = the highest achievable "lowest surface so far" on a route to i
  const best = new Array(live.length).fill(-Infinity);
  best[start] = live[start].top;
  let moved = true;
  while (moved) {
    moved = false;
    for (let i = 0; i < live.length; i++) {
      if (best[i] === -Infinity) continue;
      for (let k = 0; k < live.length; k++) {
        if (k === i) continue;
        const a = live[i], b = live[k];
        if (gap(a, b) > GRAB + PAD) continue;
        const rise = b.top - a.top;
        if (!(rise <= STEP || (rise >= MIN && rise <= REACH))) continue;   // too tall to climb
        const v = Math.min(best[i], b.top);
        if (v > best[k] + 1e-9) { best[k] = v; moved = true; }
      }
    }
  }
  // the last elevated piece you can be on before dropping to the door
  let bestFloor = -Infinity, via = null;
  for (let i = 0; i < live.length; i++) {
    if (best[i] === -Infinity) continue;
    const w = live[i];
    if (w.x > 400) continue;                       // must actually be in the west half
    if (best[i] > bestFloor) { bestFloor = best[i]; via = w; }
  }
  if (bestFloor === -Infinity) bad('NO route from the sanctum to the west half of the tomb');
  else {
    ok(`route exists; lowest surface on the best western route is ${bestFloor.toFixed(2)}m (${via.tag} at ${via.x},${via.y})`);
    const rate = (WATER.flood - WATER.start) / WATER.floodSeconds;      // m/s
    const tFor = z => (z + MECH.drownDepth - WATER.start) / rate + MECH.drownGrace;
    const routeDeadline = WATER.flood - bestFloor > MECH.drownDepth ? tFor(bestFloor) : Infinity;
    const doorDeadline  = tFor(0);
    console.log(`        flood: ${WATER.start}m -> ${WATER.flood}m over ${WATER.floodSeconds}s (${rate.toFixed(3)} m/s)`);
    if (routeDeadline === Infinity) ok(`the elevated route NEVER floods (water tops out ${(WATER.flood - bestFloor).toFixed(2)}m over it, drown needs ${MECH.drownDepth}m)`);
    else if (routeDeadline < 25) bad(`the elevated route floods at t+${routeDeadline.toFixed(0)}s — not enough to cross`);
    else ok(`the elevated route floods at t+${routeDeadline.toFixed(0)}s`);
    if (WATER.flood <= MECH.drownDepth) bad(`the flood tops out at ${WATER.flood}m, under the ${MECH.drownDepth}m drown depth — beat 7 has no stakes at all`);
    else if (doorDeadline < 20) bad(`the front door drowns at t+${doorDeadline.toFixed(0)}s — unreachable`);
    else if (doorDeadline > 90) warn(`the front door drowns at t+${doorDeadline.toFixed(0)}s — no urgency`);
    else ok(`front door (z=0) becomes lethal at t+${doorDeadline.toFixed(0)}s — the deadline`);
  }
}

// ---------------------------------------------------------------------------
console.log('\n[7] the gauntlet: does a crossing actually EXIST?');
{
  // The old check was "is at least one tile solid" — necessary, and nowhere near
  // sufficient. It passed a tuning in which no start time permitted a crossing
  // at all. So solve it: run a body east at walking speed from the approach and
  // see whether it is ever standing on a tile that is gone.
  // The RUN, not the walk. The stagger is tuned to 50/sprint on purpose — the
  // gap opens ahead of a running player and closes behind them — so solving the
  // crossing at walking pace measures a beat nobody is meant to attempt.
  const X0 = 840, X1 = 990, SPEED = RULES.sprint;        // units, units/s
  const tileOf = x => x >= 840 && x < 890 ? 0 : x >= 890 && x < 940 ? 1 : x >= 940 && x < 990 ? 2 : -1;
  const offAt = (T, i) => { const c = MECH.tileCycle;
    const t = (((T + i * MECH.tileStagger) % c) + c) % c;
    return t >= MECH.tileWarn && t < MECH.tileWarn + MECH.tileOpen; };

  const crosses = t0 => {
    for (let x = X0; x < X1; x += 1.5) {
      const i = tileOf(x); if (i < 0) continue;
      if (offAt(t0 + (x - X0) / SPEED, i)) return false;
    }
    return true;
  };
  // widest contiguous window of start times that work, over one cycle
  let best = 0, run = 0, bestAt = -1, total = 0;
  const STEP = 0.01;
  for (let t = 0; t < MECH.tileCycle; t += STEP) {
    if (crosses(t)) { run += STEP; total += STEP; if (run > best) { best = run; bestAt = t - run; } }
    else run = 0;
  }
  const cross = (X1 - X0) / SPEED;
  console.log(`        tile 50u at ${SPEED}u/s (a RUN) = ${cross.toFixed(2)}s to cross all three`);
  console.log(`        cycle ${MECH.tileCycle}s · warn ${MECH.tileWarn}s · open ${MECH.tileOpen}s · stagger ${MECH.tileStagger}s`);
  if (best <= 0) bad('NO start time permits a crossing — the causeway is impassable');
  else if (best < 0.35) bad(`only a ${best.toFixed(2)}s window to start a crossing — frame-perfect, not a puzzle`);
  else ok(`a ${best.toFixed(2)}s window to start (at t=${bestAt.toFixed(2)}s), ${(total / MECH.tileCycle * 100).toFixed(0)}% of the cycle works`);

  // All three gone at once is FINE, and it looks good: the span opens in a wave
  // and closes behind it. It is only a problem for somebody standing on a tile,
  // and the solver above already proves a crossing never puts you there. This is
  // reported, not failed — the earlier version failed on it and was wrong to.
  let noneSolid = 0;
  for (let i = 0; i <= 40000; i++) { const T = i / 1000;
    if (offAt(T, 0) && offAt(T, 1) && offAt(T, 2)) noneSolid++; }
  const perCycle = noneSolid / (40 / MECH.tileCycle);
  if (perCycle > 600) warn(`the whole span is open for ${perCycle.toFixed(0)}ms per cycle — long enough to look broken`);
  else ok(`the whole span is open for ${perCycle.toFixed(0)}ms per cycle (a wave, not a gap)`);
}

// ---------------------------------------------------------------------------
console.log('\n[8] the brazier puzzle is solvable and the glyphs cover it');
{
  const slots = INTERACTABLES.filter(i => i.kind === 'brazier').map(i => i.slot).sort();
  const order = [...BRAZIER_ORDER].sort();
  if (JSON.stringify(slots) !== JSON.stringify(order)) bad(`braziers are slots [${slots}] but the order wants [${order}]`);
  else ok(`${BRAZIER_ORDER.length} braziers, order [${BRAZIER_ORDER}] uses each exactly once`);
  const reveals = INTERACTABLES.filter(i => i.kind === 'glyph').map(i => i.reveals).sort();
  const need = BRAZIER_ORDER.map((_, i) => i);
  if (JSON.stringify(reveals) !== JSON.stringify(need)) bad(`glyphs reveal [${reveals}], the order needs [${need}]`);
  else ok(`${reveals.length} glyphs reveal every position in the order`);
}

// ---------------------------------------------------------------------------
// [9] THE 3D PROPS. placements.json is written by tools/generate-meshy.mjs and
// describes where each Meshy model stands. It is a SECOND description of the
// same tomb, so it drifts — these coordinates were written before several level
// edits and silently pointed at geometry that had moved, which showed up as
// floor tiles that did not animate and a seal in the wrong chamber.
console.log('\n[9] the Meshy placements against the level they describe');
{
  let pl = null;
  try { pl = JSON.parse(fsx.readFileSync(new URL('../placements.json', import.meta.url), 'utf8')); }
  catch { warn('no placements.json — run tools/generate-meshy.mjs'); }

  if (pl) {
    const byId = Object.fromEntries(WALLS.filter(w => w.id).map(w => [w.id, w]));
    const tags = new Set(WALLS.map(w => w.tag));
    const ids = new Set(Object.keys(byId));
    const inter = Object.fromEntries(INTERACTABLES.map(i => [i.id, i]));
    const centre = w => ({ x: w.x + w.w / 2, y: w.y + w.h / 2 });

    // every piece mech.js animates needs a placement under the SAME key, or the
    // model simply does not move with its collision
    const ANIMATED = ['tile_a', 'tile_b', 'tile_c', 'bridge_main', 'crane_arm', 'door_sanctum', 'door_front'];
    for (const id of ANIMATED) {
      if (!byId[id]) { bad(`mech animates "${id}" but no level piece has that id`); continue; }
      if (!pl[id]) warn(`no placement for "${id}" — it animates as a plain box (fine until the pack is generated)`);
    }

    for (const [k, cfg] of Object.entries(pl)) {
      for (const h of cfg.hides || [])
        if (!tags.has(h) && !ids.has(h)) bad(`placement "${k}" hides "${h}", which is neither a level tag nor an id`);

      const at = (cfg.at || [])[0];
      if (!at) { bad(`placement "${k}" has no positions`); continue; }

      if (byId[k]) {
        const c = centre(byId[k]);
        const d = Math.hypot(at.x - c.x, at.y - c.y);
        if (d > 40) bad(`placement "${k}" at (${at.x},${at.y}) is ${d.toFixed(0)}u from the piece it names, centre (${c.x},${c.y})`);
        else {
          // a prop that REPLACES a surface must have its top at that surface
          const top = (at.z || 0) + (cfg.targetH || 0);
          const off = Math.abs(top - byId[k].top);
          if ((cfg.hides || []).includes(k) && off > 0.6)
            bad(`placement "${k}" tops out at ${top.toFixed(2)}m but the surface it replaces is ${byId[k].top}m`);
          else ok(`${k.padEnd(20)} matches its piece (${d.toFixed(0)}u, top ${top.toFixed(2)}m)`);
        }
      } else if (inter[k]) {
        const i = inter[k];
        const d = Math.hypot(at.x - i.x, at.y - i.y);
        if (d > 30) bad(`placement "${k}" at (${at.x},${at.y}) is ${d.toFixed(0)}u from interactable ${k} at (${i.x},${i.y})`);
        else if (Math.abs((at.z || 0) - i.z) > 0.6) bad(`placement "${k}" z=${at.z} but interactable ${k} is at z=${i.z}`);
        else ok(`${k.padEnd(20)} matches its interactable (${d.toFixed(0)}u)`);
      }

      // nothing may stand in mid-air or inside the abyss
      for (const q of cfg.at) {
        const { z } = surfaceAt(q.x, q.y, openLive);
        const pit = inPit(q.x, q.y);
        // A prop that REPLACES a piece legitimately rises out of the void: the
        // escape heaps start at z=0 in the abyss and top out where you stand.
        const replaces = (cfg.hides || []).includes(k);
        // Some dressing BELONGS at the bottom of a pit — spikes are there so
        // the lethality is something you can see before you find out the other
        // way. Declared in the data, like every other deliberate exception.
        // NOT `inPit` — that is the module-level helper used two lines up, and
        // shadowing it in this block puts it in a temporal dead zone.
        const pitIsIntended = !!cfg.inPitByDesign;
        if (pit && !replaces && !pitIsIntended && (q.z || 0) <= pit.z)
          bad(`placement "${k}" at (${q.x},${q.y}) z=${q.z||0} is inside ${pit.name}`);
        // A bracketed prop is MEANT to be off the floor; section [10] checks
        // those against the wall face they claim instead.
        else if ((q.z || 0) > z + 1.0 && !byId[k] && !cfg.wallMounted)
          warn(`placement "${k}" at (${q.x},${q.y}) floats ${((q.z||0)-z).toFixed(2)}m above the surface`);
      }
    }
    const n = Object.keys(pl).length, f = new Set(Object.values(pl).map(c => c.file)).size;
    ok(`${n} placement keys over ${f} models`);
  }
}

// ---------------------------------------------------------------------------
console.log('\n[10] no lamp hangs in mid-air');
{
  const res = anchorLamps();
  const wall = res.filter(l => l.kind === 'wall').length;
  for (const L of res) {
    if (L.kind === 'wall') {
      // must be within a plausible bracket reach of the face it claims
      if (L.dist > LAMP_SNAP) bad(`lamp ${L.i} claims a wall ${L.dist}u away`);
    } else {
      // a floor lamp has to stand on something that exists
      const { z, host } = surfaceAt(L.x, L.y, openLive);
      if (!host && L.z > 0.05) bad(`lamp ${L.i} floats at z=${L.z.toFixed(2)} over open ground`);
      else if (Math.abs(z - L.z) > 0.5) bad(`lamp ${L.i} stands at ${L.z.toFixed(2)} but the surface is ${z.toFixed(2)}`);
    }
  }
  ok(`${res.length} lamps: ${wall} bracketed to walls, ${res.length - wall} standing on real surfaces`);
}

// ---------------------------------------------------------------------------
console.log('\n[11] the escape chain has no holes in it');
{
  // Walking off one heap toward the next must never cross open air. A gap is
  // survivable at speed and fatal at a walk, which means it is a bug that only
  // appears for the player who is being careful.
  const chain = ['rubble_1','rubble_2','rubble_3','rubble_4']
    .map(id => WALLS.find(w => w.id === id)).filter(Boolean);
  for (let i = 0; i < chain.length - 1; i++) {
    const a = chain[i], b = chain[i+1];
    const gapX = Math.max(0, Math.max(a.x - (b.x + b.w), b.x - (a.x + a.w)));
    const gapY = Math.max(0, Math.max(a.y - (b.y + b.h), b.y - (a.y + a.h)));
    if (gapX > 0 || gapY > 0)
      bad(`${a.id} -> ${b.id}: ${gapX.toFixed(0)}x${gapY.toFixed(0)}u of open air between them`);
    else ok(`${a.id} -> ${b.id} overlap (drop ${(a.top - b.top).toFixed(2)}m)`);
  }
}

// ---------------------------------------------------------------------------
console.log('\n[12] nothing reachable is a tightrope');
{
  // Any surface the player can CLIMB ONTO is a surface they will walk along.
  // Under about 1.5 m that stops being a walkway and becomes a balance beam
  // over a lethal drop, which is a different game than this one.
  const MIN_W = 1.5;                      // metres
  // the highest surface immediately OUTSIDE this piece, on any side
  const nearestFloorAround = w => {
    const pts = [[w.x - 20, w.y + w.h/2], [w.x + w.w + 20, w.y + w.h/2],
                 [w.x + w.w/2, w.y - 20], [w.x + w.w/2, w.y + w.h + 20]];
    let hi = 0;
    for (const [x, y] of pts) {
      let h = 0;
      for (const o of openLive) {
        if (o === w) continue;
        if (x > o.x && x < o.x + o.w && y > o.y && y < o.y + o.h && o.top > h) h = o.top;
      }
      if (h > hi) hi = h;
    }
    return hi;
  };
  let worst = null;
  for (let i = 0; i < openLive.length; i++) {
    const w = openLive[i];
    if (!openGot.has(i)) continue;        // unreachable: nobody walks it
    if (w.tag === 'shell' || w.top <= STEP) continue;
    // Narrow only MATTERS over a drop. The 1.1 m vault blocks in the entrance
    // hall are 1.2 m across and 5 m long, and stepping off one costs nothing
    // because there is a floor right underneath. Flagging those taught the test
    // to cry wolf about the one surface class that is completely harmless.
    const dropBelow = w.top - nearestFloorAround(w);
    if (dropBelow < 2.5) continue;
    const narrow = Math.min(w.w, w.h) * S;
    if (narrow >= MIN_W) continue;
    // a short piece is a step or a block you stand ON, not a path along
    const long = Math.max(w.w, w.h) * S;
    if (long < 3.0) continue;
    if (!worst || narrow < worst.n) worst = { w, n: narrow, l: long };
    bad(`${w.tag}${w.id ? '#' + w.id : ''} at (${w.x},${w.y}) is ${narrow.toFixed(2)}m wide and ${long.toFixed(1)}m long at ${w.top}m — a tightrope`);
  }
  if (!worst) ok(`every reachable walkway is at least ${MIN_W}m across`);
}

// ---------------------------------------------------------------------------
console.log('\n[12b] no zero-width seams between abutting surfaces');
{
  // insideWall() uses strict > and <, so two pieces that merely TOUCH leave a
  // hole of zero width where groundAt() returns 0. A body whose x lands on it
  // for one tick reads as standing over the abyss. Found at x=840 on the
  // causeway; the staircase had always avoided it by overlapping by a unit.
  const save = new Map();
  for (const w of WALLS) if (w.id) { save.set(w, w.off); w.off = false; }
  let holes = 0, first = null;
  for (const [y, x0, x1, want, label] of [
    [368, 792, 1028, 5.0, 'the causeway, approach to landing'],
    [100, 122, 448,  0.0, 'the staircase run'],
    [660, 702, 848,  5.0, 'rubble_1'],
  ]) {
    for (let x = x0; x <= x1; x += 1) {
      const g = groundAt(x, y);
      if (g < 0.2 && want > 0.2) { holes++; if (!first) first = `${label} at x=${x}`; }
    }
  }
  for (const [w, off] of save) w.off = off;
  if (holes) bad(`${holes} one-unit holes in walkable floor — first: ${first}`);
  else ok('no seams: every abutting pair overlaps');
}

console.log('\n[13] the beats cannot be walked past');
{
  // Scoped deliberately. A whole-tomb flood would have to model the ledge grab
  // (which reaches 34 units sideways) and the vault, and a crude version of
  // those answers a question nobody asked. tools/runthrough.mjs already proves
  // the route end to end; what is NOT proven anywhere else is whether a player
  // standing in the chamber can simply walk onto the counted floor without
  // touching the levers. So: flood from inside the chamber, on the flat.
  const STEP = 8;
  const floodFromChamber = (gateUp) => {
    const save = new Map();
    for (const w of WALLS) if (w.id) { save.set(w, w.off);
      if (w.id === 'gate_causeway') w.off = gateUp;
      else if (w.id.startsWith('tile_')) w.off = false;   // solid: best case for a skip
      else if (w.id === 'bridge_main' || w.id === 'crane_arm') w.off = true;
      else w.off = false;
    }
    const key = (x, y) => (x | 0) * 100000 + (y | 0);
    const sx = 600, sy = 300;                      // middle of the chamber floor
    const seen = new Set([key(sx, sy)]);
    const q = [[sx, sy, groundAt(sx, sy)]];
    while (q.length) {
      const [x, y, h] = q.pop();
      for (const [dx, dy] of [[STEP,0],[-STEP,0],[0,STEP],[0,-STEP]]) {
        const nx = x + dx, ny = y + dy;
        if (nx < 500 || nx > 1050 || ny < 140 || ny > 540) continue;   // this storey only
        const gh = groundAt(nx, ny);
        if (Math.abs(gh - h) > STEP_UP) continue;  // WALKING only: no climbing past a gate
        if (blockedAt(nx, ny, h)) continue;
        const pit = inPit(nx, ny); if (pit && gh <= pit.z) continue;
        const k = key(nx, ny);
        if (seen.has(k)) continue;
        seen.add(k); q.push([nx, ny, gh]);
      }
    }
    for (const [w, off] of save) w.off = off;
    return seen;
  };
  // Probe ON THE LATTICE. The flood samples from (600,300) in 8-unit steps, so
  // a probe at an arbitrary coordinate is never a cell it visited — which reads
  // as "unreachable" for a floor it crossed perfectly well.
  const onFloor = (seen, x, y) => {
    for (let a = x - STEP; a <= x + STEP; a += STEP)
      for (let b = y - STEP; b <= y + STEP; b += STEP)
        if (seen.has((a|0)*100000 + (b|0))) return true;
    return false; };

  const shut = floodFromChamber(false), open = floodFromChamber(true);
  const CX2 = 912, CY2 = 364;                      // middle of the counted floor, on the lattice
  if (onFloor(shut, CX2, CY2)) bad('the counted floor can be WALKED to with the gate down — beat 3 is skippable');
  else ok(`the gate seals it: the chamber flood stops at ${shut.size} cells`);
  if (onFloor(open, CX2, CY2)) ok(`and opens to ${open.size} cells once the counterweight drops`);
  else bad('the counted floor is unreachable even with the gate up — beat 4 would be impossible');
}

// ---- the collision bake must describe THIS level ----
{
  const { BAKE } = await import('../src/collisionmap.js');
  const { bakeHash } = await import('./bakehash.mjs');
  const h = bakeHash();
  console.log('\n[14] the baked collision map matches the level');
  if (!BAKE.cells) bad('src/collisionmap.js is empty: run node tools/bakecollision.mjs');
  else if (BAKE.hash !== h) bad(`collision bake is stale (${BAKE.hash} vs ${h}): placements.json or level.js changed — run node tools/bakecollision.mjs`);
  else ok(`bake ${BAKE.hash}: ${BAKE.cells} cells of carved stone`);
}

console.log(`\n${fails ? 'FAILED' : 'PASSED'} — ${fails} failure${fails === 1 ? '' : 's'}, ${warns} warning${warns === 1 ? '' : 's'}\n`);
process.exit(fails ? 1 : 0);
