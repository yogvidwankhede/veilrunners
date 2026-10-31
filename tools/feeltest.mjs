// ---------------------------------------------------------------------------
// Does the character actually MOVE the way the constants say it does?
//
// The constants in MOVE are derived from published values (Unreal's
// CharacterMovementComponent defaults for a third-person character; GDC 2016
// "Building a Better Jump" for the asymmetric arc; the 0.05-0.15 s forgiveness
// windows that shipped platformers use). Deriving them is worth nothing if the
// integration does something else, so this drives the real modules and measures
// the behaviour that reaches the player.
// ---------------------------------------------------------------------------
import { TICK, MOVE, RULES, PHYS, S } from '../src/constants.js';
import { stepHorizontal } from '../src/move.js';
import { stepVertical, groundAt, findLedge, attachToLedge, blockedAt, hangGap } from '../src/traversal.js';
import { WALLS } from '../src/level.js';

let fails = 0;
const ok   = (m, d='') => console.log(`  ok    ${m}${d?'   '+d:''}`);
const bad  = (m, d='') => { console.log(`  FAIL  ${m}${d?'   '+d:''}`); fails++; };
const near = (name, got, want, tol, unit='s') =>
  Math.abs(got - want) <= tol ? ok(`${name}: ${got.toFixed(3)}${unit}`, `(target ${want}${unit} +/-${tol})`)
                              : bad(`${name}: ${got.toFixed(3)}${unit}`, `(target ${want}${unit} +/-${tol})`);

// a body standing on open floor in the entrance hall
// Open floor in the crypt with clear run north and south. This was (170,300),
// which is inside the entrance-hall cover box: the old mover let a wedged body
// keep walking, so every number below was measured from inside a wall.
const body = () => ({ x: 320, y: 480, z: 0, vx: 0, vy: 0, vz: 0, angle: 0,
  state: 'ground', ledge: null, regrab: 0, mps: 0, coyote: MOVE.coyote, cd: {} });
const run = (p, inp, n) => { for (let i = 0; i < n; i++) stepHorizontal(p, inp, TICK); };
const FWD = { mx: 0, my: 1, sprint: false, crouch: false, locked: false, carrying: false };
const STOP = { mx: 0, my: 0, sprint: false, crouch: false, locked: false, carrying: false };

console.log('\nMOVEMENT FEEL — measured against the published references\n');

// ---- 1. acceleration ----
{
  const p = body(); let t = 0;
  while (Math.hypot(p.vx, p.vy) < RULES.speed * 0.99 && t < 3) { stepHorizontal(p, FWD, TICK); t += TICK; }
  near('time to jog top speed', t, 0.183, 0.025);        // 40 / MOVE.accel, 1/60
  const q = body(); let t2 = 0;
  while (Math.hypot(q.vx, q.vy) < RULES.sprint * 0.99 && t2 < 3)
    { stepHorizontal(q, { ...FWD, sprint: true }, TICK); t2 += TICK; }
  // ONE acceleration for every gait, so the run simply takes longer:
  // 88 / 222 = 0.40 s. A second sprint accel would be a different mover.
  near('time to run top speed', t2, 0.400, 0.04);
}

// ---- 2. deceleration ----
{
  const p = body(); run(p, FWD, 60);
  const x0 = p.y; let t = 0;
  while (Math.hypot(p.vx, p.vy) > 0.5 && t < 2) { stepHorizontal(p, STOP, TICK); t += TICK; }
  near('time to a dead stop', t, 0.083, 0.02);
  const d = Math.abs(p.y - x0) * S;
  // A jog plant covers about 7 cm. Shorter than that is a teleport; longer
  // is the old 0.15 s slide.
  (d > 0.04 && d < 0.12) ? ok(`stop distance: ${d.toFixed(2)}m`, '(a plant, not a skid)')
                         : bad(`stop distance: ${d.toFixed(2)}m`, '(want 0.04-0.12m)');
}

// ---- 2b. reverse and sprint brake (Quake accel along wishdir, friction scales) ----
{
  const BACK = { mx: 0, my: -1, sprint: false, crouch: false, locked: false, carrying: false };
  const p = body(); run(p, FWD, 90);
  let t = 0;
  while ((p.vy || 0) > 0 && t < 2) { stepHorizontal(p, BACK, TICK); t += TICK; }
  // bevy direction_change_factor is 2 on a 180. Crossing to the new
  // direction has to beat starting from zero (0.183 s), or the factor is dead.
  near('180 reverse, moving the new way', t, 0.100, 0.025);
  t < 0.13 ? ok('reverse is faster than a stop-and-start')
           : bad(`reverse ${t.toFixed(3)}s is as slow as starting over`);
  const s = body(); run(s, { ...FWD, sprint: true }, 120);
  let t3 = 0;
  while (Math.hypot(s.vx, s.vy) > RULES.speed && t3 < 2) { stepHorizontal(s, STOP, TICK); t3 += TICK; }
  near('sprint falls under a walk', t3, 0.067, 0.02);
  t3 < 0.12 ? ok('a released sprint is under a walk inside 0.12s')
            : bad(`sprint still above a walk after ${t3.toFixed(3)}s`);
}

// ---- 3. turn rate ----
{
  const p = body(); p.angle = 0;
  let t = 0;                                             // 180 degrees from standing
  while (Math.abs(p.angle) < Math.PI - 0.02 && t < 2) {
    p.vx = p.vy = 0; p.mps = 0;
    stepHorizontal(p, { ...FWD, mx: -1, my: 0 }, TICK); t += TICK;
  }
  near('180 turn, standing', t, Math.PI / MOVE.turnRate, 0.05);
  if (MOVE.turnRateRun < MOVE.turnRate) ok('turning is slower at speed', `${MOVE.turnRate} -> ${MOVE.turnRateRun} rad/s`);
  else bad('turn rate does not fall off with speed');
}

// ---- 4. the jump arc ----
{
  // Targets DERIVED from the constants, not pasted in. The apex scale changes
  // gravity through the top of the arc, so the naive v/g figures are wrong —
  // and hardcoding the corrected ones means the next tuning pass silently
  // invalidates the test instead of failing it.
  const v0 = PHYS.jumpSpeed, gR = -MOVE.riseGravity, gF = -MOVE.fallGravity;
  const av = MOVE.apexVz, k = MOVE.apexScale;
  const t1 = (v0 - av) / gR,            h1 = (v0*v0 - av*av) / (2*gR);
  const t2 = av / (gR*k),               h2 = av*av / (2*gR*k);
  const apexWant = h1 + h2, tApexWant = t1 + t2;
  const t3 = av / (gF*k),               d3 = av*av / (2*gF*k);
  const rest = apexWant - d3;
  const t4 = (-av + Math.sqrt(av*av + 2*gF*rest)) / gF;
  const airWant = tApexWant + t3 + t4;

  const p = body(); p.vz = v0; p.state = 'air';
  let t = 0, apex = 0, tApex = 0;
  while (t < 3) { stepVertical(p, TICK, { up: 0, down: 0, side: 0 }); t += TICK;
    if (p.z > apex) { apex = p.z; tApex = t; }
    if (p.state === 'ground' && t > 0.05) break; }
  near('jump apex height', apex, +apexWant.toFixed(2), 0.07, 'm');
  near('time to apex (incl. hang)', tApex, +tApexWant.toFixed(3), 0.035);
  near('total airborne (incl. hang)', t, +airWant.toFixed(3), 0.05);
  t < 0.80 ? ok(`airborne ${t.toFixed(3)}s is tighter than a symmetric arc`, '(Unreal default ~0.86s)')
           : bad(`airborne ${t.toFixed(3)}s is as floaty as symmetric gravity`);
  const ratio = MOVE.fallGravity / MOVE.riseGravity;
  (ratio >= 1.8 && ratio <= 2.6) ? ok(`fall is ${ratio.toFixed(2)}x rise`, '(GDC guidance ~2x)')
                                 : bad(`fall is ${ratio.toFixed(2)}x rise`, '(want 1.8-2.6x)');
  // A released jump must be a real short hop, not the same arc with the
  // button ignored. jumpHeld === false is the only signal; unset stays full.
  const cut = body(); cut.vz = v0; cut.state = 'air'; cut.jumpHeld = false;
  let tc = 0, cutApex = 0;
  while (tc < 3) { stepVertical(cut, TICK, { up: 0, down: 0, side: 0 }); tc += TICK;
    if (cut.z > cutApex) cutApex = cut.z;
    if (cut.state === 'ground' && tc > 0.05) break; }
  (cutApex < apex * 0.72 && cutApex > 0.25)
    ? ok(`released jump apex ${cutApex.toFixed(2)}m`, `(held ${apex.toFixed(2)}m — a tap is a short hop)`)
    : bad(`released jump apex ${cutApex.toFixed(2)}m does not read as a short hop`, `(held ${apex.toFixed(2)}m)`);
  // how far a jump actually carries you, which is what a ledge gap is measured in
  console.log(`        reach: ${(RULES.speed*S*airWant).toFixed(2)}m walking, ${(RULES.sprint*S*airWant).toFixed(2)}m at a run`);
}

// ---- 5. coyote time ----
{
  // step off a ledge and try to jump after the window has part-elapsed
  const grace = [];
  for (const wait of [0.00, 0.05, 0.10, 0.14, 0.20]) {
    const p = body(); p.z = 3; p.state = 'air'; p.coyote = MOVE.coyote; p.x = 450; p.y = 300;
    let t = 0;
    while (t < wait) { stepVertical(p, TICK, { up: 0, down: 0, side: 0 }); t += TICK; }
    grace.push([wait, (p.coyote || 0) > 0]);
  }
  const lastOk = grace.filter(g => g[1]).pop();
  const firstNo = grace.find(g => !g[1]);
  if (lastOk && firstNo && lastOk[0] < firstNo[0])
    ok(`coyote window closes between ${lastOk[0]}s and ${firstNo[0]}s`, `(set ${MOVE.coyote}s; shipped games 0.05-0.15s)`);
  else bad('coyote window does not behave', JSON.stringify(grace));
  (MOVE.coyote >= 0.05 && MOVE.coyote <= 0.15) ? ok('coyote is inside the published range')
                                               : bad(`coyote ${MOVE.coyote}s is outside 0.05-0.15s`);
  (MOVE.jumpBuffer >= 0.05 && MOVE.jumpBuffer <= 0.20) ? ok('jump buffer is inside the published range')
                                                       : bad(`jump buffer ${MOVE.jumpBuffer}s is outside 0.05-0.20s`);

  // The human order, copied from game.js: the press is seen, then gravity,
  // then a buffered press fires if this tick landed, then the body moves.
  // Walking off the west-hall pillar (top 2.5) and pressing four air frames
  // later must still jump. Pressing while falling, a few frames before the
  // floor, must jump on touchdown.
  const pressTick = (p, inp, jump) => {
    let jumped = false;
    if (jump && p.state !== 'hang') {
      if (p.state === 'ground' || (p.coyote || 0) > 0) {
        p.vz = PHYS.jumpSpeed; p.state = 'air'; p.coyote = 0; jumped = true;
      } else p.jumpBuf = MOVE.jumpBuffer;
    }
    stepVertical(p, TICK, { up: 0, down: 0, side: 0 });
    if ((p.jumpBuf || 0) > 0) {
      p.jumpBuf -= TICK;
      if (p.state === 'ground') { p.vz = PHYS.jumpSpeed; p.state = 'air'; p.jumpBuf = 0; jumped = true; }
    }
    if (p.state === 'ground' || p.state === 'air') stepHorizontal(p, inp, TICK);
    return jumped;
  };
  {
    const p = body(); p.x = 118; p.y = 186; p.z = 2.5; p.coyote = MOVE.coyote;
    const off = { mx: 0, my: -1, sprint: false, crouch: false, locked: false, carrying: false };
    let air = 0, jumped = false;
    for (let i = 0; i < 200 && !jumped; i++) {
      const press = air === 4;
      const before = p.state;
      jumped = pressTick(p, off, press) && press;
      if (before !== 'air' && p.state === 'air') air = 1;
      else if (p.state === 'air') air++;
    }
    jumped && p.vz > 5 ? ok('coyote: jump four frames after leaving the pillar')
                       : bad('coyote did not jump four frames after walking off');
  }
  {
    const p = body(); p.x = 180; p.y = 480; p.z = 2.2; p.state = 'air'; p.vz = 0; p.coyote = 0;
    let armed = false, fired = false;
    for (let i = 0; i < 180 && !fired; i++) {
      const press = !armed && p.state === 'air' && p.z < 0.55 && p.z > 0.15 && p.vz < 0;
      if (press) armed = true;
      const jumped = pressTick(p, STOP, press);
      if (armed && jumped && p.vz > 5) fired = true;
    }
    fired ? ok('jump buffer: a press a few frames before landing fires')
          : bad('jump buffer did not fire on landing');
  }
}

// ---- 6. air control ----
{
  const ratio = MOVE.airAccel / MOVE.accel;
  (ratio > 0.05 && ratio <= 0.40) ? ok(`air control is ${ratio.toFixed(2)} of ground`, '(Unreal AirControl 0.05-0.2)')
                                 : bad(`air control ${ratio.toFixed(2)} is outside 0.05-0.35`);
}

// ---- 7. foot slip: the stride is driven by ground actually covered ----
{
  const p = body(); run(p, FWD, 120);
  const before = p.y;
  stepHorizontal(p, FWD, TICK);
  const moved = Math.abs(p.y - before) * S;
  const slip = Math.abs(moved / TICK - p.mps) / Math.max(p.mps, 1e-6);
  slip < 0.02 ? ok(`foot slip at top speed: ${(slip*100).toFixed(2)}%`, '(stride follows real ground covered)')
              : bad(`foot slip: ${(slip*100).toFixed(1)}%`);
}

// ---- 8. the grab verbs: Space must actually JUMP ----
{
  // The real reason the jump felt bad was not its arc. There was ONE grab
  // range of 34 u (1.87 m), and a grounded Space tried to grab before it
  // jumped — so near any architecture Space snapped you onto a wall face
  // (teleporting you up to 1.87 m sideways) instead of jumping. Two ranges
  // now: you grab from contact, and a RISING jump catches a ledge at the apex.
  // A face wider than the grab range, so distance-to-edge equals the offset
  // along the probe. The west hall pillar is narrower on purpose.
  // The hall pillars are now their carved 50 u footprint, under the 64 u this
  // needs; the third rubble heap is a 2.5 m face 135 u long with open floor.
  const w = WALLS.find(w => w.top>=2 && w.top<=PHYS.reach && w.w >= 64 && w.id==='rubble_3');
  if (!w) { bad('no grabbable face to probe'); }
  else {
    const at = d => ({ x:w.x + w.w/2, y:w.y - d, z:0, vz:0, state:'ground', regrab:0, ledge:null });
    let stand=0, air=0;
    for (let d=0.5; d<=60; d+=0.5) {
      // Count only the face being probed. Past the grab range the next
      // piece of the hall is in reach, and that is not this ledge.
      const gs = findLedge(at(d), PHYS.grabStand);
      const ga = findLedge(at(d), PHYS.grabRange);
      if (gs && gs.wall === w) stand=d;
      if (ga && ga.wall === w) air=d;
    }
    // THE FLUSH TEST. Collision holds the body PAD units off the face, so a
    // standing grab range below that is unsatisfiable and Space can only ever
    // jump. grabStand was 11 u against a 14 u body radius: standing climbs were
    // impossible, and only the apex grab worked.
    let flush = null;
    for (let d=40; d>=0; d-=0.25) { if (!blockedAt(w.x + w.w/2, w.y - d, 0)) flush = d; else break; }
    findLedge(at(flush), PHYS.grabStand)
      ? ok(`standing flush against the wall, Space grabs`, `(body stops at ${(flush*S).toFixed(2)}m, grabStand ${(PHYS.grabStand*S).toFixed(2)}m)`)
      : bad(`flush against the wall (${(flush*S).toFixed(2)}m) Space CANNOT grab — grabStand ${(PHYS.grabStand*S).toFixed(2)}m is inside the body radius`);
    near('standing grab reach', stand*S, +(PHYS.grabStand*S).toFixed(2), 0.06, 'm');
    near('airborne grab reach', air*S,   +(PHYS.grabRange*S).toFixed(2), 0.06, 'm');
    // The band, expressed against the body radius rather than a magic number:
    // it must EXCEED the flush distance (or it is unsatisfiable) and must stay
    // within a stride of it (or Space snaps to walls instead of jumping).
    const lo = flush*S, hi = flush*S + 0.40;
    (stand*S > lo && stand*S <= hi)
      ? ok(`standing grab needs contact (${(stand*S).toFixed(2)}m)`, `(reachable above ${lo.toFixed(2)}m, snappy above ${hi.toFixed(2)}m)`)
      : bad(`standing grab reach ${(stand*S).toFixed(2)}m is outside ${lo.toFixed(2)}-${hi.toFixed(2)}m`,
            stand*S <= lo ? 'unsatisfiable: inside the body radius' : 'too wide: Space will snap instead of jumping');
    // the band between the two ranges is where the fix is visible
    const mid = (PHYS.grabStand + PHYS.grabRange) / 2;
    !findLedge(at(mid), PHYS.grabStand)
      ? ok(`at ${(mid*S).toFixed(2)}m from a wall, a standing press JUMPS`, 'it used to snap to the wall')
      : bad(`at ${(mid*S).toFixed(2)}m a standing press still grabs`);
    findLedge(at(mid), PHYS.grabRange)
      ? ok('a rising jump catches that ledge at the apex', 'the jump accomplishes something')
      : bad('a rising jump cannot catch a ledge 1.1m away');
    // and the apex grab must not reach anything the floor could not already
    const tops = [...new Set(WALLS.map(x=>x.top))];
    const v0=PHYS.jumpSpeed, gR=-MOVE.riseGravity, av=MOVE.apexVz, k=MOVE.apexScale;
    const apex=(v0*v0-av*av)/(2*gR)+av*av/(2*gR*k);
    const unlocked = tops.filter(t => t > PHYS.reach && t <= apex + PHYS.reach);
    unlocked.length === 0
      ? ok('the apex grab unlocks no new surface', `(floor reaches ${PHYS.reach}m, apex ${(apex+PHYS.reach).toFixed(2)}m, no wall top between)`)
      : bad(`the apex grab newly reaches wall tops ${unlocked.join(', ')} — gating changed`);
  }
}

// ---- 9. the mantle must not climb OVER the ledge and settle back down ----
{
  // The literal complaint: "it is climbing above the object and then it stands
  // on it". A single curve driving height and forward travel together does
  // exactly that — it overshoots the top and drops onto it. The pull-up is
  // staged instead (rise, then step over), and this asserts the shape: the
  // feet never go above the surface they are climbing onto, and they do not
  // move forward before the body has cleared the lip.
  // A face wider than the grab range, so distance-to-edge equals the offset
  // along the probe. The west hall pillar is narrower on purpose.
  const w = WALLS.find(w => w.top>=2 && w.top<=PHYS.reach && w.w >= 64 && w.id==='rubble_3');
  const p = { x:w.x + w.w/2, y:w.y - 1, z:0, vx:0, vy:0, vz:0, angle:0,
              state:'ground', ledge:null, regrab:0, mantle:0, mps:0, cd:{} };
  const g = findLedge(p, PHYS.grabRange);
  if (!g) { bad('could not grab the probe pillar to test the mantle'); }
  else {
    attachToLedge(p, g);
    p.z === g.top - PHYS.hangBelow
      ? ok(`hang sits ${PHYS.hangBelow}m below the lip`, `(ledge ${g.top}m, feet ${p.z.toFixed(2)}m)`)
      : bad(`hang height is ${p.z.toFixed(2)}m, expected ${(g.top-PHYS.hangBelow).toFixed(2)}m`);
    const UP = { up:1, down:0, side:0 };
    let t=0, maxZ=-Infinity, overshoot=0, fwdBeforeClear=0;
    const y0 = p.y, nearLip = g.top - 0.12;
    while (t < 4) {
      stepVertical(p, TICK, UP); t += TICK;
      maxZ = Math.max(maxZ, p.z);
      if (p.z > g.top + 0.02) overshoot = Math.max(overshoot, p.z - g.top);
      // forward travel while still well below the lip is the "climbing through
      // the wall" read; a little is the hands committing, a lot is wrong
      if (p.z < nearLip - 0.35) fwdBeforeClear = Math.max(fwdBeforeClear, Math.abs(p.y - y0) * S);
      if (p.state === 'ground') break;
    }
    overshoot < 0.03
      ? ok('the mantle never rises above the ledge', `(peak ${maxZ.toFixed(2)}m, ledge ${g.top}m)`)
      : bad(`the mantle overshoots the ledge by ${overshoot.toFixed(2)}m then settles down onto it`);
    Math.abs(p.z - g.top) < 0.03
      ? ok('it finishes standing on the surface', `(${p.z.toFixed(2)}m)`)
      : bad(`it finishes at ${p.z.toFixed(2)}m, ledge is ${g.top}m`);
    fwdBeforeClear < 0.30
      ? ok(`almost no forward travel before clearing the lip`, `(${fwdBeforeClear.toFixed(2)}m — it rises first, then steps over)`)
      : bad(`moves ${fwdBeforeClear.toFixed(2)}m forward while still below the lip — it climbs through the wall`);
    near('mantle duration', t, PHYS.mantleTime, 0.08);
  }
}

// ---- 10. shimmying must not push the model into the wall ----
{
  // The screenshot showed the character buried in the stone with its hands out
  // in the open. The mesh correction that puts the hands on the lip is built on
  // how far the body stands off the face — and that was measured as the
  // straight-line distance to the point originally grabbed. Shimmy slides the
  // body along the tangent and never updates that point, so the measurement
  // grew with every step sideways and the correction drove the model inward.
  // A face wider than the grab range, so distance-to-edge equals the offset
  // along the probe. The west hall pillar is narrower on purpose.
  const w = WALLS.find(w => w.top>=2 && w.top<=PHYS.reach && w.w >= 64 && w.id==='rubble_3');
  const p = { x:w.x + w.w/2, y:w.y - 1, z:0, vx:0, vy:0, vz:0, angle:0,
              state:'ground', ledge:null, regrab:0, mantle:0, mps:0, cd:{} };
  const g = findLedge(p, PHYS.grabRange);
  if (!g) { bad('could not grab the probe pillar to test shimmy'); }
  else {
    attachToLedge(p, g);
    const gap0 = hangGap(p);
    let maxDrift = 0, moved = 0;
    const SIDE = { up:0, down:0, side:1 };
    for (let i = 0; i < 40; i++) {
      const x0 = p.x, y0 = p.y;
      stepVertical(p, TICK, SIDE);
      moved += Math.hypot(p.x-x0, p.y-y0) * S;
      maxDrift = Math.max(maxDrift, Math.abs(hangGap(p) - gap0));
    }
    moved > 0.25
      ? ok(`shimmied ${moved.toFixed(2)}m along the face`, `(${PHYS.shimmy} u/s)`)
      : bad(`shimmy moved only ${moved.toFixed(2)}m — the probe never slid, so this proves nothing`);
    maxDrift < 0.02
      ? ok('stand-off from the face is unchanged by shimmying', `(${gap0.toFixed(2)}m throughout)`)
      : bad(`stand-off drifted ${maxDrift.toFixed(2)}m while shimmying`,
            'the mesh correction will drive the model that far into the wall');
  }
}

// ---- 11. the vault is a button, not a collision response ----
{
  // It used to fire on contact alone: run at anything waist-high and the
  // character threw itself over it. You could not stand behind cover, and a
  // misjudged approach became a traversal you never asked for.
  const cover = { x: 130, y: 560, w: 90, h: 22, top: 1.1 };   // the crypt's low cover
  const mk = () => ({ x: cover.x + 12, y: cover.y - 40, z: 0, vx: 0, vy: 0, vz: 0,
                      angle: Math.PI/2, state:'ground', ledge:null, regrab:0, mantle:0,
                      vault:0, mps:0, cd:{} });
  const AT   = { mx: 0, my: 1, sprint: true, crouch: false, locked: false, carrying: false };
  const PRESS= { ...AT, vault: true };
  const runInto = inp => {
    const p = mk();
    for (let i = 0; i < 90 && p.state !== 'vault'; i++) stepHorizontal(p, inp, TICK);
    return p;
  };
  const noPress = runInto(AT), pressed = runInto(PRESS);
  noPress.state !== 'vault'
    ? ok('running into cover does NOT vault it', `(stopped at y=${noPress.y.toFixed(0)}, state ${noPress.state})`)
    : bad('running into cover still auto-vaults — the button is not being honoured');
  pressed.state === 'vault'
    ? ok('the same approach WITH the press vaults', '(contextual, but asked for)')
    : bad(`pressing vault at cover did nothing (state ${pressed.state}, speed ${pressed.mps.toFixed(2)} m/s)`);
}

// ---- 10. the catch is where the hands are, and nothing teleports ----
{
  const { catchLedge, lowMantle, STAND_REACH, PAD: BODY } = await import('../src/traversal.js');
  const w = WALLS.find(w => w.id === 'rubble_3');               // 2.5 m face, open floor north
  const at = (dy, z, vz) => ({ x: w.x + w.w / 2, y: w.y - dy, z, vz, vx: 0, vy: 0, angle: Math.PI / 2,
    state: 'air', regrab: 0, ledge: null });
  // A hop 1.2 m off the face reaches the lip's height but not the stone.
  let far = null; for (let z = 0; z <= 1.2; z += 0.02) far = far || catchLedge(at(BODY + 1.2 / S, z, 1));
  far ? bad('a hop 1.2 m from the face still snapped onto the ledge') : ok('a hop 1.2 m from the face does not snap to the ledge');
  // At the face, the catch fires only once the lip is at the hands.
  let caughtAt = null;
  for (let z = 0; z <= 1.2 && caughtAt == null; z += 0.02) if (catchLedge(at(BODY + 2, z, 1))) caughtAt = z;
  const rise = caughtAt == null ? null : w.top - caughtAt;
  (rise != null && rise <= 2.05 + 1e-6 && rise >= 1.15) ? ok(`at the face the hands take the lip ${rise.toFixed(2)} m above the feet`, '(within reach of raised arms)')
    : bad(`catch at the face fired at rise ${rise}`);
  // Turned away from it, falling past a lip is not a catch: a deliberate drop
  // must not snag on the ledge it just left.
  const away = at(BODY + 2, 0.8, -3); away.angle = -Math.PI / 2;
  catchLedge(away) ? bad('falling past a lip while facing away caught it') : ok('falling past a lip facing away does not catch it');
  // A waist-high ledge is climbed from the floor, never hung from underground.
  const cov = WALLS.find(v => v.tag === 'cover' && v.top < PHYS.hangBelow);
  const p = { x: cov.x + cov.w / 2, y: cov.y - BODY - 1, z: 0, vz: 0, vx: 0, vy: 0, angle: Math.PI / 2, state: 'ground', regrab: 0, ledge: null, mantle: 0 };
  const g = findLedge(p, PHYS.grabStand);
  if (!g) bad('no grab at the waist-high cover');
  else {
    lowMantle(p, g);
    let lowest = Infinity, n = 0;
    while (p.state === 'mantle' && n++ < 200) { stepVertical(p, TICK, { up: 0, down: 0, side: 0 }); lowest = Math.min(lowest, p.z); }
    (lowest >= -1e-6 && p.state === 'ground' && Math.abs(p.z - cov.top) < 1e-6)
      ? ok(`a ${cov.top} m ledge is climbed straight up from the floor`, `(feet never below ${lowest.toFixed(2)} m)`)
      : bad(`low climb went to ${lowest.toFixed(2)} m, ended ${p.state} at ${p.z}`);
  }
  STAND_REACH > PHYS.hangBelow ? ok(`standing reach ${STAND_REACH} m; higher lips need the jump`) : bad('standing reach below the hang height');
}

// ---- 11. edge assist: walking stops at a deadly drop, running goes over ----
{
  // On top of the 5 m inner wall, heading west over the entrance hall.
  const wall = WALLS.find(v => v.tag === 'wall_inner' && v.top === 5);
  const start = () => ({ x: wall.x + wall.w / 2, y: wall.y + 200, z: 5, vx: 0, vy: 0, vz: 0, angle: Math.PI, state: 'ground', regrab: 0, mps: 0, coyote: 0, cd: {} });
  const WEST = { mx: -1, my: 0, sprint: false, crouch: false, locked: false, carrying: false, edgeGuard: true };
  const walker = start();
  for (let i = 0; i < 120; i++) { stepHorizontal(walker, WEST, TICK); stepVertical(walker, TICK, { up: 0, down: 0, side: 0 }); }
  (walker.state === 'ground' && walker.z === 5) ? ok('walking toward a 5 m drop stops at the lip', `(stood ${((walker.x - wall.x) * S).toFixed(2)} m from the edge)`)
    : bad(`walked off a 5 m drop (z=${walker.z.toFixed(2)})`);
  const runner = start();
  for (let i = 0; i < 120; i++) { stepHorizontal(runner, { ...WEST, sprint: true }, TICK); stepVertical(runner, TICK, { up: 0, down: 0, side: 0 }); }
  runner.z < 5 ? ok('running at the same lip goes over it', '(the assist never blocks a committed move)') : bad('the edge assist blocked a sprint');
}

console.log(`\n${fails ? 'FAILED' : 'PASSED'} — ${fails} failure${fails===1?'':'s'}\n`);
process.exit(fails ? 1 : 0);
