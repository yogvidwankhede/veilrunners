// Can the level actually be climbed? Pure data, no browser.
// Uses the same rule traversal.js does: a ledge is grabbable when it sits
// between PHYS.minLedge and PHYS.reach above where you are standing, and your
// body is within PHYS.grabRange of its face.
import { WALLS, RELICS, SPAWNS, TIER } from '../src/level.js';
import { PHYS, S } from '../src/constants.js';

const PAD = PHYS.bodyRadius / S, GRAB = PHYS.grabRange, REACH = PHYS.reach, MIN = PHYS.minLedge, STEP = PHYS.stepUp;

// horizontal gap between two footprints (0 if they overlap)
const gap = (a, b) => {
  const dx = Math.max(0, Math.max(a.x - (b.x + b.w), b.x - (a.x + a.w)));
  const dy = Math.max(0, Math.max(a.y - (b.y + b.h), b.y - (a.y + a.h)));
  return Math.hypot(dx, dy);
};
// can you get from a surface at height `from` onto wall `w`?
const canReach = (from, w) => {
  const rise = w.top - from;
  if (rise <= STEP) return true;                 // walk up
  return rise >= MIN && rise <= REACH;           // climb up
};

const reached = new Set();           // indices of WALLS tops we can stand on
const frontier = [{ ground: true }]; // start on the floor
let changed = true;
while (changed) {
  changed = false;
  WALLS.forEach((w, i) => {
    if (reached.has(i)) return;
    // from the ground: anywhere on the map touches ground, so only height matters
    if (canReach(0, w)) { reached.add(i); changed = true; return; }
    // from another surface we can already stand on, if it is close enough
    for (const j of reached) {
      const o = WALLS[j];
      if (gap(o, w) > GRAB + PAD) continue;
      if (canReach(o.top, w)) { reached.add(i); changed = true; return; }
    }
  });
}

const tiers = {};
WALLS.forEach((w, i) => {
  const k = w.top.toFixed(1);
  tiers[k] = tiers[k] || { total: 0, ok: 0, tags: new Set() };
  tiers[k].total++; if (reached.has(i)) tiers[k].ok++;
  tiers[k].tags.add(w.tag);
});

console.log(`reach ${REACH} m · minLedge ${MIN} m · grabRange ${GRAB} units · stepUp ${STEP} m\n`);
console.log('height   reachable        pieces');
Object.keys(tiers).sort((a, b) => a - b).forEach(h => {
  const t = tiers[h];
  console.log(`${h.padStart(5)}m   ${String(t.ok + '/' + t.total).padStart(7)}  ${t.ok === t.total ? 'OK ' : 'XX '}  ${[...t.tags].join(', ')}`);
});

const unreachable = WALLS.map((w, i) => ({ w, i })).filter(({ i }) => !reached.has(i));
console.log(`\n${WALLS.length - unreachable.length}/${WALLS.length} surfaces reachable`);
if (unreachable.length) unreachable.forEach(({ w }) =>
  console.log(`  UNREACHABLE  ${w.tag} at (${w.x},${w.y}) top ${w.top}m`));

// every relic must sit on a surface you can actually get to
console.log('\nrelics:');
RELICS.forEach((r, n) => {
  if (r.z === 0) { console.log(`  relic${n} (${r.x},${r.y}) ground — OK`); return; }
  const host = WALLS.findIndex(w =>
    Math.abs(w.top - r.z) < 0.01 && r.x > w.x && r.x < w.x + w.w && r.y > w.y && r.y < w.y + w.h);
  if (host < 0) console.log(`  relic${n} (${r.x},${r.y}) z=${r.z} — FLOATING: no surface under it`);
  else console.log(`  relic${n} (${r.x},${r.y}) z=${r.z} on ${WALLS[host].tag} — ${reached.has(host) ? 'reachable' : 'UNREACHABLE'}`);
});

// spawns must not be inside a wall
console.log('\nspawns:');
SPAWNS.forEach((s, n) => {
  const bad = WALLS.find(w => s.x > w.x - PAD && s.x < w.x + w.w + PAD && s.y > w.y - PAD && s.y < w.y + w.h + PAD);
  console.log(`  spawn${n} (${s.x},${s.y}) ${bad ? 'INSIDE ' + bad.tag : 'clear'}`);
});
