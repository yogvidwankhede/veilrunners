// ---------------------------------------------------------------------------
// A full headless playthrough of THE CRADLE OF SILT.
//
// This drives the REAL modules — traversal.js, mech.js, interact.js, story.js —
// against a minimal stand-in for game.js, walking a body from the entrance to
// the front door with actual physics: gravity, ledge grabs, mantles, the tile
// cycle, the crane window, the flood.
//
// It is deliberately NOT a browser test. The three.js renderer needs a GPU, so a
// browser playthrough cannot run on a headless box or in CI, and the thing most
// worth guarding — that the tomb can be finished at all — has nothing to do with
// rendering. What this cannot catch is anything visual; that needs real eyes.
//
// The one thing it reimplements is movement intent (which waypoint to walk at,
// when to climb, when it is safe to step on a tile). That mirrors the ally AI in
// game.js; if the two drift, this test gets easier than the game, never harder.
// ---------------------------------------------------------------------------
import { TICK, PHYS, MOVE, MAP, RULES, S } from '../src/constants.js';
import { stepHorizontal, killMomentum } from '../src/move.js';
import { groundAt, blockedAt, findLedge, attachToLedge, stepVertical, vaultTarget, catchLedge, lowMantle, STAND_REACH } from '../src/traversal.js';
import { createMech, MECH, tileState } from '../src/mech.js';
import { createInteract } from '../src/interact.js';
import { createCaptions } from '../src/captions.js';
import { createStory, BEATS } from '../src/story.js';
import { CHECKPOINTS, WATER } from '../src/level.js';

// ---- the stand-in for game.js: the same contract, none of the rendering ----
const game = {
  t: 0, phase: 'playing', won: false, players: [], events: [],
  relics: [{ id: 0, x: 983, y: 626, z: 6.0, owner: null, availableAt: 0 }],
  event(text) { this.events.push({ text, at: this.t }); },
  carrying(p) { return this.relics.find(r => r.owner === p.id); },
  elapsed() { return this.t - (this.story ? this.story.startedAt : 0); },
};
const mkBody = (id, name, sp) => ({
  id, name, isBot: false, x: sp.x, y: sp.y, z: groundAt(sp.x, sp.y), vz: 0,
  angle: 0, hp: 100, state: 'ground', ledge: null, regrab: 0, mantle: 0, vault: 0,
  under: 0, deadUntil: 0, invuln: 0, cd: {}, bot: {}, vis: 1, mps: 0, gait: 0,
});
const me = mkBody(0, 'ARIA', { x: 136, y: 440 });
game.players = [me];

const grabs = { stand: 0, apex: 0 };
const PATH = [], FILM = [];
const mech = createMech(game);
const captions = createCaptions();
const interact = createInteract(game, mech, captions);
game.mech = mech; game.interact = interact; game.captions = captions;
const ctx = {
  game, mech, interact,
  say: (w, l) => captions.say(w, l),
  any: fn => game.players.some(q => !q.deadUntil && fn(q)),
  me: () => me,
  wakeGuardians: () => { ctx._awake = true; },
  guardiansAlive: () => !!ctx._awake && !ctx._cleared,
};
const story = createStory(game, ctx);
game.story = story;
story.startedAt = 0;

// ---------------------------------------------------------------------------
// The route. Each leg is a point to stand on; `use` presses interact there,
// `hold` keeps it pressed for a while (the crane), `clear` stands in for the
// combat beat, which has its own tests.
// ---------------------------------------------------------------------------
const ROUTE = [
  { beat: 0, at: [96, 348],   z: 0.0, use: 'glyph_1', label: 'glyph I, on the screen wall' },
  { beat: 0, at: [190, 345],  z: 0.0, label: 'to the crypt doorway' },
  { beat: 0, at: [190, 270],  z: 0.0, label: 'through into the stair hall' },
  // Through the GAP BETWEEN THE TWO HALL PILLARS. The far west is not a route:
  // the pillar at (90,150) spans x 90..146 and its east pad still reaches
  // x=160. The west side now clears the shell. The route uses x 160..218.
  { beat: 0, at: [188, 250],  z: 0.0, label: 'between the hall pillars' },
  { beat: 0, at: [188, 172],  z: 0.0, label: 'the foot of the stairs' },
  { beat: 0, at: [300, 100],  z: 2.5, label: 'up the stairs (ends beat I)' },
  { beat: 1, at: [380, 100],  z: 2.5, label: 'gallery, turning east' },
  { beat: 1, at: [440, 168],  z: 5.0, label: 'climb to 5 m' },
  { beat: 1, at: [530, 122],  z: 5.0, label: 'round the end of the chamber wall' },
  { beat: 1, at: [565, 116],  z: 5.0, use: 'glyph_2', label: 'glyph II (ends beat II)' },
  // Beat 3 is the co-op task: both levers must count at once. Solo that is a
  // sprint between them inside MECH.cwGrace, which is what this leg walks.
  // Down the chamber's CLEAR WEST STRIP (x 520..542). The centre is taken by
  // the altar (pad x 604..706, y 284..386) and the four pillars, which between
  // them leave only this strip and a matching one at x 768..790 running the
  // full depth of the room.
  { beat: 2, at: [530, 220],  z: 5.0, label: 'onto the mechanism floor' },
  { beat: 2, at: [530, 330],  z: 5.0, label: 'down the west strip' },
  { beat: 2, at: [592, 404],  z: 5.0, hold: 'lever_cw_a', label: 'the west lever' },
  { beat: 2, at: [724, 404],  z: 5.0, hold: 'lever_cw_b', run: true, label: 'the east lever (bridge drops)' },
  { beat: 2, clear: true, label: 'clear the chamber' },
  { beat: 3, at: [812, 370],  z: 5.0, label: 'the causeway approach' },
  { beat: 3, at: [1008, 370], z: 5.0, tiles: true, label: 'cross the counted floor' },
  { beat: 4, at: [1012, 400], z: 5.0, hold: 'lever_crane', label: 'hold the crane lever' },
  { beat: 4, at: [1060, 370], z: 5.0, label: 'onto the crane arm' },
  { beat: 4, at: [1124, 340], z: 7.5, label: 'the tower (ends beat V)' },
  { beat: 5, at: [1145, 300], z: 7.5, use: 'glyph_3', label: 'glyph III' },
  // South along the tower, THEN west onto the sanctum ring. The tower runs
  // y 250..560 and the ring's north edge is y 528; a straight line from the
  // tower top to the braziers leaves the geometry and drops into the abyss.
  // The fires are solid (r 0.80 m). The route steps north of them, still
  // inside the 48-unit use radius, instead of walking through the bowls.
  { beat: 5, at: [1120, 530], z: 7.5, label: 'south along the tower' },
  { beat: 5, at: [1100, 580], z: 7.5, label: 'onto the sanctum ring' },
  { beat: 5, at: [1100, 544], z: 7.5, label: 'north of the fires' },
  // b, c, a — and C sits between the tower and B, so the route deliberately
  // walks past an unlit brazier twice. That only works because use is an edge.
  { beat: 5, at: [970, 544],  z: 7.5, use: 'brazier_b', label: 'brazier II' },
  { beat: 5, at: [1060, 544], z: 7.5, use: 'brazier_c', label: 'brazier III' },
  { beat: 5, at: [880, 544],  z: 7.5, use: 'brazier_a', label: 'brazier I' },
  { beat: 5, at: [983, 680],  z: 6.0, use: 'relic', label: 'the sun disc' },
  // Stand AT the west wall on the sanctum floor first, then climb. Walking
  // straight at the 7.5 m ring from the plinth leaves the 5.6 m floor at x=860
  // before the wall is ever in grab range, and there is nothing under x<860.
  { beat: 6, at: [884, 700],  z: 5.6, label: 'to the sanctum west wall' },
  // Further north on the ring. At y=700 the target sits right on the lip where
  // the rubble heap ends, and the wall is only 40 units (2.2 m) wide — with
  // momentum now carried between ticks the body rolls straight over it.
  { beat: 6, at: [838, 650],  z: 7.5, label: 'back onto the ring' },
  { beat: 6, at: [775, 650],  z: 5.0, label: 'the rubble chain' },
  { beat: 6, at: [632, 685],  z: 4.3, label: 'rubble' },
  { beat: 6, at: [497, 735],  z: 2.5, label: 'rubble' },
  { beat: 6, at: [405, 785],  z: 2.1, label: 'rubble' },
  // Straight WEST off the rubble onto the wall. The rubble is x 360..450 and the
  // wall is x 330..360, so they touch only along x=360 — heading for a point
  // further north leaves the rubble over open abyss before the wall is in reach.
  { beat: 6, at: [345, 785],  z: 5.0, label: 'up the inner wall' },
  { beat: 6, at: [345, 520],  z: 5.0, label: 'north along the wall top' },
  { beat: 6, at: [260, 600],  z: 0.0, label: 'down into the flooding hall' },
  { beat: 6, at: [70, 455],   z: 0.0, label: 'THE FRONT DOOR' },
];

const log = [];
let fails = 0;
const say = (tag, m) => { log.push(`${tag}  ${m}`); if (tag === 'FAIL') fails++; };

// one simulation tick, mirroring the order in game.js: tomb first, then bodies
function tick(want) {
  game.t += TICK * 1000;
  mech.step(TICK);
  interact.beginTick();
  captions.step(TICK);

  // Vertical first, then horizontal — the same order game.js uses. The
  // horizontal step is now the GAME'S OWN module (src/move.js), including the
  // vault, so this harness can no longer be an easier version of the game by
  // accident. That was a live risk while both held a copy of the intent.
  let vs = stepVertical(me, TICK, want.vert || { up: 0, down: 0, side: 0 });
  // APEX GRAB, as the game does it: a RISING jump catches a ledge in reach.
  // Without it the harness's jump accomplishes nothing and it can only climb
  // from contact, which is not how the player climbs.
  // The game's own catch rule (traversal.catchLedge): the hands must arrive.
  if (vs === 'air' && me.regrab <= 0) {
    const g = catchLedge(me);
    if (g) { attachToLedge(me, g); grabs.apex++; vs = me.state; }
  }
  if (vs === 'hang' || vs === 'mantle' || vs === 'vault') killMomentum(me);
  else stepHorizontal(me, { mx: want.dx, my: want.dy, sprint: !!want.sprint, crouch: false,
                            locked: false, carrying: false }, TICK);
  // Record the route. Ceilings are derived from where the player actually goes,
  // so a roof can never be dropped through a line the playthrough travels.
  // AFTER the if/else above, not between them — put here it captured the `else`
  // and horizontal movement silently stopped running whenever recording was on.
  if (process.env.VEIL_PATH) PATH.push([Math.round(me.x), Math.round(me.y), +me.z.toFixed(2)]);
  // tools/playfilm.mjs replays these in the real renderer: where the body was,
  // which way it was going, and the tomb's state at that moment.
  if (process.env.VEIL_FILM && Math.round(game.t / 1000 / TICK) % 30 === 0)
    FILM.push({ x: +me.x.toFixed(1), y: +me.y.toFixed(1), z: +me.z.toFixed(2), state: me.state,
      vx: +(me.vx || 0).toFixed(2), vy: +(me.vy || 0).toFixed(2), beat: story.beat, t: +(game.t / 1000).toFixed(1), mech: mech.pack() });
  // EVERY tick, pressed or not. interact.step tracks the button edge, and it
  // cannot see the release if it is only called while the button is down — the
  // edge then fires exactly once per session and every later press is ignored.
  interact.step(TICK, me, !!want.use);

  // hazards, same rules as game.js
  const pit = mech.pitAt(me);
  if (pit) return `fell into ${pit}`;
  if (mech.submersion(me) > MECH.drownDepth) {
    me.under += TICK;
    if (me.under >= MECH.drownGrace) return 'drowned';
  } else me.under = Math.max(0, me.under - TICK * 2);

  const adv = story.step();
  if (adv === 'complete') { game.phase = 'results'; game.won = true; }
  return null;
}

// How a competent player crosses: do not step on and hope, WAIT on the solid
// approach until a start time from which the whole run is clear, then commit and
// never stop. Stopping halfway is what kills you, because the tile you paused on
// is the next one to go.
const TILE_OF = x => x >= 840 && x < 890 ? 0 : x >= 890 && x < 940 ? 1 : x >= 940 && x < 990 ? 2 : -1;
// The crossing is no longer at a constant speed: the body ACCELERATES. Assuming
// top speed from the first step predicts arrival times that are up to a third of
// a second early, which is most of a tile. So simulate it: start where the run
// actually starts, at the speed actually carried, and integrate.
function crossingClear(t0, x0, v0) {
  let x = x0, v = v0, t = t0;
  for (let n = 0; n < 600 && x < 992; n++) {
    v = Math.min(RULES.sprint, v + MOVE.accel * TICK);   // you RUN this one
    x += v * TICK; t += TICK;
    const i = TILE_OF(x);
    if (i >= 0 && tileState(t, i).off) return false;
  }
  return x >= 992;
}

console.log('\nTHE CRADLE OF SILT · headless playthrough');
console.log(`tick ${(TICK * 1000).toFixed(2)}ms · walk ${(RULES.speed * S).toFixed(2)} m/s · flood ${WATER.flood}m over ${WATER.floodSeconds}s\n`);

let died = null;
for (const leg of ROUTE) {
  if (leg.clear) { ctx._cleared = true; say('ok  ', `${leg.label}`); continue; }
  const [tx, ty] = leg.at;
  let done = false, bestD = Infinity, noProgress = 0, sidestep = 0;
  let committed = false, waitedFor = 0; const legStart = game.t / 1000;
  const MAXT = 60 / TICK;                          // 60 simulated seconds per leg
  for (let i = 0; i < MAXT && !done; i++) {
    const d = Math.hypot(tx - me.x, ty - me.y);
    // Walking straight at a target wedges on any corner. Real players sidestep;
    // so does the ally AI in game.js. Without this the harness reports level
    // bugs that are really pathfinding bugs in the harness.
    if (d < bestD - 0.5) { bestD = d; noProgress = 0; }
    // Never sidestep on the causeway: it is 104 units wide with an abyss either
    // side, and the correct response to a missing tile is to wait for it.
    else if (++noProgress > 26 && sidestep <= 0 && !leg.tiles) { sidestep = 22; noProgress = 0; }
    if (sidestep > 0) sidestep--;
    const dz = leg.z - me.z;
    const want = { dx: 0, dy: 0, vert: { up: 0, down: 0, side: 0 }, use: false };

    // A mantle and a vault are COMMITTED: they take no input and must not be
    // interrupted. Re-grabbing mid-mantle resets z to the hang height every
    // tick, which parks the body forever at exactly (top - hangBelow).
    if (me.state === 'mantle' || me.state === 'vault') { /* let it play out */ }
    else if (me.state === 'hang') want.vert.up = 1;        // always finish a climb
    else if (d < 12 && Math.abs(dz) < 0.5) done = true;
    else {
      if (dz > 0.5 && me.state === 'ground') {             // need to get higher
        // MIRROR THE GAME'S TWO VERBS. This used to call findLedge(me) with the
        // DEFAULT range, which is the airborne one — so the harness could grab
        // from 1.65 m away while the player needs contact, making the test
        // easier than the game, the one direction it must never drift.
        let g = me.regrab <= 0 ? findLedge(me, PHYS.grabStand) : null;
        if (g && g.top - me.z > STAND_REACH) g = null;     // the game jumps for these
        if (g && g.top - me.z < PHYS.hangBelow - 0.05) { lowMantle(me, g); grabs.stand++; }
        else if (g) { attachToLedge(me, g); grabs.stand++; }
        else me.vz = PHYS.jumpSpeed;                       // jump, and catch it on the way up
      }
      if (d > 1) {
        let dx = (tx - me.x) / d, dy = (ty - me.y) / d;
        if (sidestep > 0) {
          // Sidestep to whichever side still has floor. Rotating one fixed way
          // walked the body straight off the gallery edge into the abyss.
          const a = { x: -dy, y: dx }, b = { x: dy, y: -dx };
          const ok = c => groundAt(me.x + c.x * 30, me.y + c.y * 30) >= me.z - 1.0;
          const pick = ok(a) ? a : (ok(b) ? b : null);
          if (pick) { dx = pick.x; dy = pick.y; } else { dx = 0; dy = 0; }
        }
        if (leg.tiles) {
          // still on the solid approach: wait for a clear run, then commit
          if (!committed) {
            // Wait on the solid approach until the WHOLE run is clear from here
            // at this speed, then commit and never stop. Stopping halfway is
            // what kills you: the tile you paused on is the next one to go.
            const vNow = Math.hypot(me.vx || 0, me.vy || 0);
            if (me.x < 838 && crossingClear(game.t / 1000, me.x, vNow)) {
              committed = true; waitedFor = game.t / 1000 - legStart;
            } else if (me.x < 838) { dx = 0; dy = 0; }
          }
        }
        want.dx = dx; want.dy = dy; if (leg.tiles || leg.run) want.sprint = true;
      }
    }
    // Button UP while travelling: press verbs are edge-triggered, so holding
    // it across the walk spends the edge before arriving at the thing.
    want.use = false;

    const cause = tick(want);
    if (cause) { died = `${cause} at (${me.x.toFixed(0)},${me.y.toFixed(0)}) z=${me.z.toFixed(2)} during "${leg.label}"`; break; }
    if (game.phase === 'results') { done = true; break; }
  }
  // Come to a stop at each waypoint. The body carries velocity between ticks
  // now, so arriving at a leg still moving means the next decision is made from
  // a position the harness never actually chose.
  killMomentum(me);
  if (died) break;
  if (!done) { say('FAIL', `could not reach "${leg.label}" (${tx},${ty}) z=${leg.z} — stopped at (${me.x.toFixed(0)},${me.y.toFixed(0)}) z=${me.z.toFixed(2)} state=${me.state}`); break; }

  if (leg.hold) {
    // hold the lever and watch the arm come in, then confirm the grace window
    let peakLive = 0;
    for (let i = 0; i < 1.8 / TICK; i++) { tick({ dx: 0, dy: 0, use: true }); peakLive = Math.max(peakLive, (mech.cwLive || []).length); }
    say('ok  ', `held ${leg.hold}: crane=${mech.crane.toFixed(2)} armOff=${mech.byId.crane_arm.off} grace=${mech.craneGrace.toFixed(1)}s`);
    for (let i = 0; i < 0.5 / TICK; i++) tick({ dx: 0, dy: 0, use: false });
    say('ok  ', `released: grace=${mech.craneGrace.toFixed(1)}s armOff=${mech.byId.crane_arm.off}`);
    if (leg.hold === 'lever_cw_a')
      say(mech.cwLatch.lever_cw_a > 0 ? 'ok  ' : 'FAIL',
          `west lever latched for ${(mech.cwLatch.lever_cw_a||0).toFixed(1)}s — now run`);
    if (leg.hold === 'lever_cw_b') {
      for (let i = 0; i < 2.0 / TICK; i++) { tick({ dx: 0, dy: 0, use: true }); peakLive = Math.max(peakLive, (mech.cwLive || []).length); }
      // The peak, not the last tick: the first lever's latch may lapse once
      // the bridge is already down, and that is the mechanism working.
      say(peakLive === 2 ? 'ok  ' : 'FAIL', `both levers live together: ${peakLive}/2`);
      say(mech.bridge >= 1 ? 'ok  ' : 'FAIL', `bridge=${mech.bridge.toFixed(2)} off=${mech.byId.bridge_main.off}`);
    }
  } else if (leg.use) {
    for (let i = 0; i < 0.4 / TICK; i++) tick({ dx: 0, dy: 0, use: true });
    const it = interact.byId[leg.use];
    const fired = it.used || it.lit;
    say(fired ? 'ok  ' : 'FAIL', `${leg.label}: ${leg.use} ${fired ? 'fired' : 'DID NOT FIRE'} at (${me.x.toFixed(0)},${me.y.toFixed(0)}) z=${me.z.toFixed(2)}`);

    if (leg.use === 'brazier_a') {
      for (let i = 0; i < 2.2 / TICK; i++) tick({ dx: 0, dy: 0 });
      say(interact.st.solved ? 'ok  ' : 'FAIL', `puzzle solved=${interact.st.solved} seal=${mech.seal.toFixed(2)} sealOff=${mech.byId.door_sanctum.off}`);
    }
    if (leg.use === 'relic') {
      say(interact.st.relicTaken ? 'ok  ' : 'FAIL', `disc taken=${interact.st.relicTaken}`);
      for (let i = 0; i < 0.3 / TICK; i++) tick({ dx: 0, dy: 0 });
      say(mech.flooding ? 'ok  ' : 'FAIL', `flood started=${mech.flooding}`);
    }
  } else {
    const extra = leg.tiles ? `  waited ${waitedFor.toFixed(2)}s for a clear run` : '';
    say('ok  ', `reached ${leg.label}  (${me.x.toFixed(0)},${me.y.toFixed(0)}) z=${me.z.toFixed(2)} t=${(game.t / 1000).toFixed(1)}s beat=${story.beat}${extra}`);
  }
}

console.log(log.join('\n'));
if (died) { console.log(`\nFAIL  ${died}`); fails++; }
console.log(`\nbeat reached: ${story.beat + 1}/${BEATS.length}  "${story.current().title}"`);
console.log(`phase: ${game.phase}   won: ${game.won}`);
console.log(`run time: ${(game.elapsed() / 1000).toFixed(1)}s simulated   deaths: ${story.deaths}`);
console.log(`glyphs: ${interact.st.read.filter(Boolean).length}/3   puzzle resets: ${interact.st.failures}`);
if (mech.flooding) console.log(`water: ${mech.waterZ.toFixed(2)}m after ${mech.floodT.toFixed(1)}s of flooding`);
const complete = game.phase === 'results' && game.won;
if (!complete) fails++;
// Which grab verb carried the climbs? Space used to try a grab from 1.87 m
// away before it would jump, so most presses near architecture never produced
// a jump. The standing grab now needs contact and a RISING jump catches a
// ledge at the apex — this proves the playthrough actually uses that path
// rather than the tight standing range having quietly broken climbing.
{
  const st = grabs.stand, ap = grabs.apex;
  console.log(`\ngrabs: ${st} from contact, ${ap} caught at a jump apex`);
  if (st + ap === 0) { console.log('  FAIL  the run climbed nothing — the grab path is dead'); fails++; }
  else console.log('  ok    the climbs still work with a contact-only standing grab');
}

if (process.env.VEIL_FILM) (await import('fs')).writeFileSync(process.env.VEIL_FILM, JSON.stringify(FILM));
if (process.env.VEIL_PATH) {
  (await import('fs')).writeFileSync(process.env.VEIL_PATH, JSON.stringify(PATH));
  console.log(`\npath: ${PATH.length} samples -> ${process.env.VEIL_PATH}`);
}
console.log(`\n${fails ? 'FAILED' : 'PASSED'} — the tomb was ${complete ? 'completed' : 'NOT completed'}, ${fails} failure${fails === 1 ? '' : 's'}\n`);
process.exit(fails ? 1 : 0);
