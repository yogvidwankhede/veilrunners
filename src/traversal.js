import { MAP, PHYS, MOVE, S } from './constants.js';
import { gridBlocked } from './collisiongrid.js';

// ---------------------------------------------------------------------------
// Vertical traversal: gravity, walls as standable surfaces, and ledge climbing.
//
// The ported simulation was purely 2D — every actor was (x, y) and the mesh was
// drawn at y=0 — so walls could only ever be obstacles. Here each wall carries a
// `top` in metres, which makes it both a blocker (from below) and a floor (from
// above), and gives a ledge to grab.
//
// Heights are METRES. Horizontal positions stay in game units; `S` converts.
// ---------------------------------------------------------------------------

// A piece with `off: true` is not there at all: no floor, no blocker, no ledge.
// That is what a raised bridge or a retracted crane arm actually is, and faking
// it with a height would leave a standable surface in the middle of a chasm.
// mech.js owns the flag; every query below honours it.
// smoothstep over an arbitrary span, for staging one motion against another
const sstep = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };

// The body radius in game units. Every wall, ledge and stand-off derives from it.
export const PAD = PHYS.bodyRadius / S;
// metres past the body radius that a finished climb stands in from the lip
const MANTLE_INSET = 0.35;
// Where a climb onto this ledge finishes, in game units in from the lip:
// well onto the surface, but never past the middle of a narrow wall.
export function mantleInset(g) {
  const depth = g.nx !== 0 ? g.wall.w : g.wall.h;
  return Math.min(PAD + MANTLE_INSET / S, Math.max(PAD, depth * 0.5));
}

const insideWall = (w, x, y, pad = 0) =>
  x > w.x - pad && x < w.x + w.w + pad && y > w.y - pad && y < w.y + w.h + pad;

// Surface height under a point: the tallest wall whose footprint covers it, else 0.
export function groundAt(x, y) {
  let h = 0;
  for (const w of MAP.walls) if (!w.off && insideWall(w, x, y) && w.top > h) h = w.top;
  return h;
}

// A wall blocks only if you are below its top. Standing above it, you walk across.
export function blockedAt(x, y, z) {
  for (const w of MAP.walls) {
    if (w.off || !insideWall(w, x, y, PAD)) continue;
    if (z < w.top - PHYS.stepUp) return true;
  }
  // The carved stone, as baked from its triangles (collisiongrid.js).
  return gridBlocked(x, y, z, PHYS.bodyRadius);
}

// Closest point on a wall's outer edge to (x,y), plus the outward normal there.
// Used to park a hanging body against the face it grabbed.
function edgeOf(w, x, y) {
  const cx = Math.min(Math.max(x, w.x), w.x + w.w);
  const cy = Math.min(Math.max(y, w.y), w.y + w.h);
  // distance to each side; the nearest one is the face being grabbed
  const dl = Math.abs(x - w.x), dr = Math.abs(x - (w.x + w.w));
  const dt = Math.abs(y - w.y), db = Math.abs(y - (w.y + w.h));
  const m = Math.min(dl, dr, dt, db);
  if (m === dl) return { x: w.x,         y: cy, nx: -1, ny: 0 };
  if (m === dr) return { x: w.x + w.w,   y: cy, nx:  1, ny: 0 };
  if (m === dt) return { x: cx, y: w.y,          nx: 0, ny: -1 };
  return            { x: cx, y: w.y + w.h,  nx: 0, ny:  1 };
}

// A low obstacle directly ahead that should be vaulted rather than bumped into.
export function vaultTarget(p, dx, dy) {
  if (Math.hypot(dx, dy) < 0.01) return null;
  const ahead = { x: p.x + dx * (PAD + 10), y: p.y + dy * (PAD + 10) };
  for (const w of MAP.walls) {
    if (w.off || !insideWall(w, ahead.x, ahead.y, PAD)) continue;
    const rise = w.top - p.z;
    if (rise <= PHYS.stepUp || rise > PHYS.vaultMax) continue;   // step over, or too tall
    // Land clear on the far side, along the direction of travel: where this
    // line leaves the padded box, plus a short step. It used to take the box's
    // whole width or depth by the dominant axis, so a slanted approach to a
    // long piece of cover threw the runner up to 6 m in 0.42 s.
    const n = Math.hypot(dx, dy), ux = dx / n, uy = dy / n;
    const exitX = ux > 1e-6 ? (w.x + w.w + PAD - p.x) / ux : ux < -1e-6 ? (w.x - PAD - p.x) / ux : Infinity;
    const exitY = uy > 1e-6 ? (w.y + w.h + PAD - p.y) / uy : uy < -1e-6 ? (w.y - PAD - p.y) / uy : Infinity;
    const dist = Math.min(exitX, exitY) + 6;
    return { toX: p.x + ux * dist, toY: p.y + uy * dist, over: w.top, dist };
  }
  return null;
}

// Standing on a surface and at its edge? Returns the ledge you could drop onto.
// This is the inverse of findLedge: lowering yourself over an edge you are above.
export function edgeBelow(p) {
  if (p.z <= 0.05) return null;
  let best = null, bestD = Infinity;
  for (const w of MAP.walls) {
    if (w.off) continue;                                 // retracted: nothing to stand on
    if (Math.abs(w.top - p.z) > 0.08) continue;          // not the surface we are on
    if (!insideWall(w, p.x, p.y, PAD)) continue;         // not standing on it
    const e = edgeOf(w, p.x, p.y);
    const d = Math.hypot(p.x - e.x, p.y - e.y);
    if (d > PHYS.edgeSnap || d >= bestD) continue;
    bestD = d;
    best = { wall: w, top: w.top, ex: e.x, ey: e.y, nx: e.nx, ny: e.ny };
  }
  return best;
}

// Is there a ledge this body can grab from where it is? Returns a grab or null.
export function findLedge(p, range) {
  const maxD = range === undefined ? PHYS.grabRange : range;
  let best = null, bestD = Infinity;
  for (const w of MAP.walls) {
    if (w.off) continue;                                       // retracted: no ledge to grab
    const rise = w.top - p.z;
    if (rise < PHYS.minLedge || rise > PHYS.reach) continue;   // step, or out of reach
    const e = edgeOf(w, p.x, p.y);
    const d = Math.hypot(p.x - e.x, p.y - e.y);
    if (d > maxD || d >= bestD) continue;
    // must be approaching the face, not clinging to the far side
    if ((p.x - e.x) * e.nx + (p.y - e.y) * e.ny < -1) continue;
    // Shell corridor beside the west hall pillar. On the floor, brushing
    // that pier while walking the gap is not a lip. Anywhere else — the
    // north face the route can climb, the east face, a jump — still grabs.
    if ((p.z || 0) < 0.35 && w.tag === 'pillar' && w.y === 161 && w.x === 85
        && p.x < w.x + 4) continue;
    bestD = d;
    best = { wall: w, top: w.top, ex: e.x, ey: e.y, nx: e.nx, ny: e.ny };
  }
  return best;
}

// ---------------------------------------------------------------------------
// THE CATCH. A jump takes a ledge when the HANDS arrive at it, not when the
// body is merely within reach of one. The old apex grab fired on the first
// airborne tick if any lip was within 1.65 m and 3.1 m — so a hop beside a
// wall teleported the body a metre and a half sideways and up onto the stone
// before the arms had moved. Here the lip has to be where outstretched hands
// are at this instant (CATCH.lo..hi above the feet), the body has to be at
// the face (within CATCH.reach beyond its own radius), and it has to be
// facing or moving into it — so a deliberate drop off a lip never snags on
// the lip it just left, and a catch moves the body at most ~0.45 m.
// ---------------------------------------------------------------------------
export const CATCH = { lo: 1.15, hi: 2.05, reach: 0.50 };
// A lip this high above the feet is reached standing; higher needs a jump.
export const STAND_REACH = 2.3;

export function catchLedge(p) {
  const fx = Math.cos(p.angle || 0), fy = Math.sin(p.angle || 0);
  const maxPerp = PAD + CATCH.reach / S;
  let best = null, bestD = Infinity;
  for (const w of MAP.walls) {
    if (w.off) continue;
    const rise = w.top - (p.z || 0);
    if (rise < CATCH.lo || rise > CATCH.hi) continue;
    const e = edgeOf(w, p.x, p.y);
    const perp = (p.x - e.x) * e.nx + (p.y - e.y) * e.ny;          // + outside the face
    if (perp < -2 || perp > maxPerp) continue;
    const along = Math.hypot(p.x - e.x, p.y - e.y) ** 2 - perp * perp;
    if (along > PAD * PAD) continue;                                // off the end of the face
    const facing = -(fx * e.nx + fy * e.ny);
    const into = -((p.vx || 0) * e.nx + (p.vy || 0) * e.ny);
    if (facing < 0.35 && into < 10) continue;                       // turned away and not moving in
    if (perp < bestD) { bestD = perp; best = { wall: w, top: w.top, ex: e.x, ey: e.y, nx: e.nx, ny: e.ny }; }
  }
  return best;
}

// A ledge low enough to climb straight onto from the floor, without hanging:
// hanging parks the feet hangBelow under the lip, which for a waist-high
// ledge is underground. Starts the mantle from where the body stands.
export function lowMantle(p, grab) {
  p.ledge = grab;
  p.state = 'mantle';
  p.mantle = 0;
  p.vz = 0;
  p.mz0 = p.z || 0;
  p.mx0 = p.x; p.my0 = p.y;
  p.angle = Math.atan2(-grab.ny, -grab.nx);
}

// How far the body is standing off the face it is hanging from, in METRES.
//
// This must be the PERPENDICULAR distance to the wall face, not the distance to
// the point that was grabbed. Shimmying slides the body along the tangent and
// never updates `ledge.ex/ey`, so a straight-line distance grows with every
// step sideways — at PHYS.shimmy (55 u/s) one second of shimmy reported 3.1 m
// instead of 0.77 m, and the mesh correction built on it drove the character
// more than two metres into the stone.
export function hangGap(p) {
  const g = p.ledge; if (!g) return 0;
  // Signed: positive is outside the face, negative is already on the top.
  // The absolute value is what buried the mesh — once a mantle crossed the
  // lip the correction kept pushing "toward the wall" and the body went in.
  return ((p.x - g.ex) * g.nx + (p.y - g.ey) * g.ny) * S;
}

// Park the body on the face it just grabbed.
export function attachToLedge(p, grab) {
  p.ledge = grab;
  p.state = 'hang';
  p.vz = 0;
  p.z = grab.top - PHYS.hangBelow;
  p.x = grab.ex + grab.nx * PAD;
  p.y = grab.ey + grab.ny * PAD;
  p.angle = Math.atan2(-grab.ny, -grab.nx);   // face into the wall
  p.mantle = 0;
}

// One tick of vertical state. `want` is {up, down, side} in -1..1 from input.
// Returns the state name so the animation layer can follow it.
export function stepVertical(p, dt, want) {
  if (p.state === 'hang') {
    const g = p.ledge;
    if (want.down) {                     // let go
      p.state = 'air'; p.ledge = null; p.vz = -1; p.regrab = PHYS.dropGrace;
      return p.state;
    }
    if (want.up) {
      p.state = 'mantle'; p.mantle = 0; p.mz0 = undefined;
      p.mx0 = p.x; p.my0 = p.y;        // where the pull-up starts, for the step-over
      return p.state;
    }
    p.shimmying = !!want.side;
    if (want.side) {                     // shimmy along the face
      const tx = -g.ny, ty = g.nx;       // tangent of the grabbed face
      const nx = p.x + tx * want.side * PHYS.shimmy * dt;
      const ny = p.y + ty * want.side * PHYS.shimmy * dt;
      // Only slide while the ledge continues under the hands. Probe well inside
      // the footprint: at exactly PAD the point lands on the boundary, and
      // insideWall uses a strict >, so the ledge reads as absent and nothing moves.
      const probe = PAD + 6;
      const ahead = { x: nx - g.nx * probe, y: ny - g.ny * probe };
      // And only while the body has open air to hang in. At an inside corner the
      // adjoining wall's top carries the ledge on, so the hands test passes and
      // the hanging body slid straight into the stone of the next wall.
      const lead = { x: nx + tx * want.side * PAD * 0.9, y: ny + ty * want.side * PAD * 0.9 };
      const clear = groundAt(nx, ny) < g.top - 0.3 && groundAt(lead.x, lead.y) < g.top - 0.3;
      // The leading hand needs stone too, not just the body's centre line, or a
      // shimmy runs off the end of a block and hangs half a body over nothing.
      const hand = 0.22 / S;
      const reach = { x: ahead.x + tx * want.side * hand, y: ahead.y + ty * want.side * hand };
      if (clear && groundAt(ahead.x, ahead.y) >= g.top - 0.01 && groundAt(reach.x, reach.y) >= g.top - 0.01) { p.x = nx; p.y = ny; }
    }
    p.z = g.top - PHYS.hangBelow;
    return p.state;
  }

  if (p.state === 'vault') {
    p.vault += dt / (p.vaultDur || PHYS.vaultTime);
    const t = Math.min(1, p.vault);
    const ease = t * t * (3 - 2 * t);
    p.x = p.vx0 + (p.vx1 - p.vx0) * ease;
    p.y = p.vy0 + (p.vy1 - p.vy0) * ease;
    p.z = p.vz0 + Math.sin(t * Math.PI) * (p.vaultOver - p.vz0 + 0.42);   // arc over the lip
    if (t >= 1) { p.state = 'ground'; p.z = groundAt(p.x, p.y); p.vz = 0; }
    return p.state;
  }

  if (p.state === 'mantle') {
    const g = p.ledge;
    p.mantle += dt / PHYS.mantleTime;
    const t = Math.min(1, p.mantle);

    // TWO PHASES, staged against each other. Running the rise and the step-in
    // on the SAME curve — which is what this did — floats the body diagonally
    // up through the lip and sets it down on top, because it is moving inward
    // the whole time it is still below the surface. That is the "climbs above
    // the object then stands on it" look.
    //
    //   0.00 - 0.62   PULL UP. The body rises with the hands on the lip and
    //                 does not move inward at all: it stays against the face.
    //   0.42 - 1.00   STEP OVER. Once the chest is clearing, the body
    //                 translates in over the surface.
    //
    // The 0.2 of overlap is deliberate — a hard handover reads as two separate
    // moves rather than one continuous climb.
    const rise = sstep(0, 0.62, t);
    const over = sstep(0.42, 1, t);

    // From the hang, or from the floor for a low ledge (lowMantle sets mz0).
    const z0 = p.mz0 !== undefined ? p.mz0 : g.top - PHYS.hangBelow;
    p.z = z0 + rise * (g.top - z0);
    // Finish well onto the surface, not a body radius from the drop: the next
    // stray input used to walk you straight back off the lip you climbed.
    const inset = mantleInset(g);
    const inX = g.ex - g.nx * inset, inY = g.ey - g.ny * inset;
    const sx = p.mx0 !== undefined ? p.mx0 : p.x, sy = p.my0 !== undefined ? p.my0 : p.y;
    p.x = sx + (inX - sx) * over;
    p.y = sy + (inY - sy) * over;

    if (t >= 1) {
      p.state = 'ground'; p.ledge = null; p.z = g.top; p.vz = 0;
      p.mx0 = p.my0 = p.mz0 = undefined;
    }
    return p.state;
  }

  // ---- free body: gravity, then land on whatever surface is underneath ----
  if (p.regrab > 0) p.regrab -= dt;
  const wasAir = p.state === 'air';

  // ASYMMETRIC GRAVITY. One constant for both halves of the arc is what
  // "floaty" means: the fall takes as long as the rise, and the player spends
  // most of the jump waiting. Falling ~2.2x faster keeps it snappy. The apex
  // scale is a beat of reduced gravity through the top, which is the window in
  // which the decision about where to land is actually made.
  // A held jump keeps the full arc. A released one falls at fall-gravity
  // while it is still going up — the short hop. jumpHeld is only ever false
  // when input said so; tests and bots leave it unset and get the full arc.
  // The apex hang is the held jump's decision window, so a cut skips it.
  let gmul = p.vz > 0 ? MOVE.riseGravity : MOVE.fallGravity;
  if (p.vz > 0 && p.jumpHeld === false) gmul = MOVE.fallGravity;
  else if (Math.abs(p.vz) < MOVE.apexVz) gmul *= MOVE.apexScale;
  p.vz += gmul * dt;
  p.z += p.vz * dt;

  let gh = groundAt(p.x, p.y);
  // UP A STEP WITH THE BODY, NOT THE NAVEL. Ground was read under the centre
  // only, so a runner walking at a stair stood half inside the tread above
  // until the middle of them crossed its edge, legs drawn through the stone.
  // A step-sized rise anywhere under the body carries it, going up and
  // coming down alike (rising on one tick and dropping the next would bob a
  // runner walking beside a step). Only step-sized, only from the ground: a
  // real ledge is still left when the centre crosses it, so walk-offs,
  // drops and coyote time are exactly as they were.
  if (!wasAir) {
    const r = PHYS.bodyRadius * 0.7 / S, base = gh;
    for (const w of MAP.walls) {
      if (w.off || w.top <= gh || w.top - base > PHYS.stepUp || w.top > p.z + PHYS.stepUp) continue;
      if (insideWall(w, p.x, p.y, r)) gh = w.top;
    }
  }
  const drop = p.z - gh;
  // Godot CharacterBody3D::_snap_on_floor: snap only if we were on the floor
  // and velocity is not facing up, and only as far as the snap length. The
  // engine default is 0.1 m, which misses a 0.36 m stair, so the length is
  // PHYS.stepUp — the distance this tomb already treats as a step. A real
  // ledge (minLedge 0.9 m) is past it and still falls, coyote included.
  if (!wasAir && p.vz <= 0 && drop > 0 && drop <= PHYS.stepUp) {
    p.z = gh; p.vz = 0; p.state = 'ground';
    p.coyote = MOVE.coyote;
  } else if (p.z <= gh) {
    // Impact speed, for the camera dip and the animation. It is read on the
    // frame of touchdown only: sampling it every tick while standing still
    // would report the one tick of gravity the ground cancels.
    if (wasAir) {
      p.landImpact = Math.max(0, -p.vz);
      // 0..1 for the animation layer, on the same soft/hard scale the camera dip
      // uses, so the pose and the camera agree about how hard that was.
      p.landAnim = Math.min(1, Math.max(0,
        (p.landImpact - MOVE.landSoft) / (MOVE.landHard - MOVE.landSoft)));
    }
    p.z = gh; p.vz = 0; p.state = 'ground';
    p.coyote = MOVE.coyote;              // refreshed while there is ground underfoot
  } else {
    p.state = 'air';
    p.coyote = Math.max(0, (p.coyote || 0) - dt);
  }
  return p.state;
}
