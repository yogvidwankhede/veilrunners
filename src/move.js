import { MAP, RULES, PHYS, MOVE, S } from './constants.js';
import { blockedAt, vaultTarget, groundAt } from './traversal.js';
import { pushCurrent } from './water.js';

// ---------------------------------------------------------------------------
// HORIZONTAL LOCOMOTION — one implementation, shared.
//
// This used to live inline in game.js, and tools/runthrough.mjs had its own
// copy of the intent. Two copies of movement means the test can be easier than
// the game and nobody finds out. Both import this now.
//
// The model is velocity-based: the stick sets a TARGET velocity and a TARGET
// facing, and the body accelerates and rotates toward them at bounded rates.
// The ported version assigned both directly, which is why a character with real
// mocap on it still read as a cursor being dragged around a map.
// ---------------------------------------------------------------------------

const clampMap = (v, hi) => Math.max(25, Math.min(hi - 25, v));

// Quake III PM_Friction (bg_pmove.c). `control` is stopspeed while you are
// under it, otherwise the speed itself, so a crawl still dies and a sprint
// sheds speed in proportion to how fast it is going. Below 1 unit/s the
// horizontal velocity is zeroed, which is Quake's dead-stop.
// friction here is 1/s. Quake's pm_friction is 6 against a 320 run. Ours is
// MOVE.decel / walk speed: under stopspeed the drop is constant (the jog
// plant), and above it the drop scales with speed (the sprint sheds faster).
function applyFriction(vx, vy, dt, stopspeed, friction) {
  const speed = Math.hypot(vx, vy);
  if (speed < 1) return { vx: 0, vy: 0 };
  const control = speed < stopspeed ? stopspeed : speed;
  const drop = control * friction * dt;
  const next = Math.max(0, speed - drop);
  const scale = next / speed;
  return { vx: vx * scale, vy: vy * scale };
}

// Quake III PM_Accelerate, q2 style: add along wishdir only, and only while
// the speed in that direction is under wishspeed. It does not brake. The
// coefficient is MOVE.accel (units/s^2) on our 1/60 tick, not Quake's
// `accel * wishspeed`, because that form reaches every gait in the same
// time and this game keeps one acceleration for walk and run.
function accelerate(vx, vy, dx, dy, wishspeed, accel, dt) {
  const currentspeed = vx * dx + vy * dy;
  const addspeed = wishspeed - currentspeed;
  if (addspeed <= 0) return { vx, vy };
  const accelspeed = Math.min(addspeed, accel * dt);
  return { vx: vx + accelspeed * dx, vy: vy + accelspeed * dy };
}

// bevy_tnua walk.rs: acceleration is `1.5 - 0.5 * dot(wish, velocity)`.
// Aligned is 1×, a 90° turn is 1.5×, a reverse is 2×. Straight-line time
// to top speed is unchanged.
function directionFactor(vx, vy, dx, dy) {
  const speed = Math.hypot(vx, vy);
  if (speed < 1e-3) return 1;
  const dot = Math.max(-1, Math.min(1, (vx * dx + vy * dy) / speed));
  return 1.5 - 0.5 * dot;
}

// shortest signed angle from a to b
export function angleDelta(a, b) {
  let d = b - a;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  return d;
}

// The direction the body is being pushed, normalised. Shared so the vault
// predicate and the movement step cannot disagree about which way you are going.
function intentDir(inp) {
  let dx = inp.locked ? 0 : inp.mx, dy = inp.locked ? 0 : inp.my;
  const len = Math.hypot(dx, dy);
  if (len > 1) { dx /= len; dy /= len; }
  return { dx, dy, len };
}

/**
 * Can this body vault the thing in front of it RIGHT NOW?
 *
 * Returns the vault target, or null. Exported because game.js has to answer the
 * same question before it decides what the jump button does: Space in front of
 * low cover should vault it, not jump straight up in front of it.
 */
export function vaultIntent(p, inp) {
  if (p.state !== 'ground') return null;
  const { dx, dy, len } = intentDir(inp);
  if (len <= 0.05) return null;
  if ((p.mps || 0) <= PHYS.vaultMinSpeed) return null;
  if (blockedAt(p.x, p.y, p.z)) return null;          // wedged: let them out instead
  // only when something is actually in the way
  const sx = (p.vx || 0) * (1 / 60), sy = (p.vy || 0) * (1 / 60);
  const bx = !blockedAt(clampMap(p.x + sx, MAP.w), p.y, p.z);
  const by = !blockedAt(p.x, clampMap(p.y + sy, MAP.h), p.z);
  if (bx && by) return null;
  const v = vaultTarget(p, dx, dy);
  if (!v || blockedAt(v.toX, v.toY, p.z)) return null;
  return v;
}

/**
 * One tick of ground/air movement.
 *   p    the body. Reads/writes x, y, vx, vy, angle, mps, state.
 *   inp  { mx, my, sprint, crouch, locked, carrying }
 * Returns the metres actually covered, which is what drives the stride.
 */
export function stepHorizontal(p, inp, dt) {
  const onGround = p.state === 'ground';

  let speed = inp.crouch ? RULES.crouch : inp.sprint ? RULES.sprint : RULES.speed;
  if (inp.carrying) speed *= RULES.carrier;
  if (p.dodgeUntil > (p.game ? p.game.t : 0)) speed *= 2.5;

  let dx = inp.locked ? 0 : inp.mx, dy = inp.locked ? 0 : inp.my;
  const len = Math.hypot(dx, dy);
  if (len > 1) { dx /= len; dy /= len; }
  const wants = len > 0.05;

  // ---- facing: rotate toward the stick at a bounded rate ----
  // Movement still goes in the INPUT direction while the body catches up, which
  // is what keeps a third-person character responsive; it is only the mesh's
  // heading that is rate-limited. Turning instantly is a one-frame 180 pivot.
  if (wants) {
    const want = Math.atan2(dy, dx);
    if (p.angle === undefined) p.angle = want;
    const frac = Math.min(1, (p.mps || 0) / (RULES.speed * S));
    const rate = MOVE.turnRate + (MOVE.turnRateRun - MOVE.turnRate) * frac;
    const d = angleDelta(p.angle, want);
    const max = rate * dt;
    const turn = Math.abs(d) <= max ? d : Math.sign(d) * max;
    p.angle += turn;
    p.omega = turn / Math.max(dt, 1e-4);     // rad/s, for the turn-in-place blend
    p.moving = Math.min(1, len);
  } else { p.moving = 0; p.omega = (p.omega || 0) * 0.8; }

  // ---- velocity ----
  // Ground, no stick: PM_Friction on the whole vector. Stopspeed is the walk
  // speed, friction is decel/walk, so a jog plants in ~0.08 s. Above the walk
  // speed the drop scales with speed, so a sprint is back under a walk faster
  // than the jog itself stops.
  // Ground, stick held: PM_Accelerate along the wish, then PM_Friction on the
  // part of the velocity the wish does not claim. Friction on the wish
  // itself would fight MOVE.accel and the run would never reach top speed.
  // Air: PM_AirMove calls PM_Friction, but ground friction only runs while
  // walking, so a jump keeps the speed it left the floor with. Steering is
  // PM_Accelerate at airAccel. The rejected component bleeds at airDecel
  // (bevy uses one air acceleration for every air change) so a strafe does
  // not skate and a small correction still exists.
  const stopspeed = RULES.speed;
  const friction = MOVE.decel / RULES.speed;
  let vx = p.vx || 0, vy = p.vy || 0;
  if (!wants) {
    if (onGround) {
      const f = applyFriction(vx, vy, dt, stopspeed, friction);
      vx = f.vx; vy = f.vy;
    }
  } else if (onGround) {
    const steered = accelerate(vx, vy, dx, dy, speed, MOVE.accel * directionFactor(vx, vy, dx, dy), dt);
    const along = steered.vx * dx + steered.vy * dy;
    const px = steered.vx - along * dx, py = steered.vy - along * dy;
    const shed = applyFriction(px, py, dt, stopspeed, friction);
    let kept = along;
    if (kept > speed) {
      const braked = applyFriction(kept, 0, dt, stopspeed, friction);
      kept = Math.max(speed, braked.vx);
    }
    vx = kept * dx + shed.vx;
    vy = kept * dy + shed.vy;
  } else {
    const steered = accelerate(vx, vy, dx, dy, speed, MOVE.airAccel * directionFactor(vx, vy, dx, dy), dt);
    const along = steered.vx * dx + steered.vy * dy;
    const px = steered.vx - along * dx, py = steered.vy - along * dy;
    const airFric = MOVE.airDecel / RULES.speed;
    const shed = applyFriction(px, py, dt, stopspeed, airFric);
    vx = along * dx + shed.vx;
    vy = along * dy + shed.vy;
  }
  p.vx = vx;
  p.vy = vy;

  const ox = p.x, oy = p.y;
  const wedged = blockedAt(p.x, p.y, p.z);
  // EDGE ASSIST. Walking (not running) stops at a drop deeper than EDGE_DROP,
  // the way a third-person climber plants at a lip instead of stepping off
  // it. Running, jumping, or crouching into a hang all still go over: the
  // assist only takes away the drop nobody meant.
  const guard = inp.edgeGuard && onGround && !inp.sprint;
  // The drop is probed a quarter-metre ahead of the body's centre, so the
  // runner plants with the toes at the lip rather than half over it.
  const gl = Math.hypot(p.vx || 0, p.vy || 0) || 1, gx = (p.vx || 0) / gl * EDGE_PROBE, gy = (p.vy || 0) / gl * EDGE_PROBE;
  const blocked = (x, y) => blockedAt(x, y, p.z) || (guard && groundAt(x + gx, y + gy) < p.z - EDGE_DROP);

  // ---- vault low cover, with real speed behind it ----
  const sx = p.vx * dt, sy = p.vy * dt;
  const nx = clampMap(p.x + sx, MAP.w), ny = clampMap(p.y + sy, MAP.h);
  const bx = !blocked(nx, p.y);
  const by = !blocked(p.x, ny);
  // VAULT IS A BUTTON, not a collision response. This used to fire on contact
  // alone: walk into anything waist-high at any speed and the character threw
  // itself over it, so cover could not be stood behind and a misjudged approach
  // became an unasked-for traversal. `inp.vault` is the jump press.
  if (inp.vault && !wedged && (!bx || !by) && wants && (p.mps || 0) > PHYS.vaultMinSpeed) {
    const v = vaultTarget(p, dx, dy);
    if (v && !blockedAt(v.toX, v.toY, p.z)) {
      p.state = 'vault'; p.vault = 0;
      p.vx0 = p.x; p.vy0 = p.y; p.vz0 = p.z;
      p.vx1 = v.toX; p.vy1 = v.toY; p.vaultOver = v.over;
      // the arc's length sets its time: never faster than ~1.6x a sprint at
      // its peak, so a vault reads as a vault and not as a blink to the far side
      p.vaultDur = Math.max(PHYS.vaultTime, (v.dist || 0) * S * 1.5 / (RULES.sprint * S * 1.6));
      return 0;
    }
  }

  if (p.state !== 'vault') {
    if (wedged) {
      // COLLISION RECOVERY. A body inside stone — a respawn, a mantle that
      // set down against a prop, a partner's snapshot — is walked out toward
      // the nearest free ground, whatever the stick says. It never gets to
      // dig deeper, and it never stays trapped.
      depenetrate(p, dt);
    } else if (!blocked(nx, ny)) {
      p.x = nx; p.y = ny;
    } else if (bx || by) {
      // Slide along the face: keep the axis that is free. Against a straight
      // wall this is the whole of collide-and-slide.
      if (bx) p.x = nx; else p.vx = 0;
      if (by) p.y = ny; else p.vy = 0;
    } else {
      // Both axes blocked: a corner, or the curve of a pillar or a pile. Swing
      // the step a little either way and take the free one that keeps the
      // most of the intended direction, so the body flows around rounded
      // stone instead of stopping dead on it.
      const step = Math.hypot(sx, sy);
      let best = null, bestDot = 0.2;
      if (step > 1e-4) {
        const ux = sx / step, uy = sy / step;
        for (const deg of SLIDE_ANGLES) {
          const a = deg * Math.PI / 180, ca = Math.cos(a), sa = Math.sin(a);
          const tx = ux * ca - uy * sa, ty = ux * sa + uy * ca;
          const dot = ca;
          if (dot <= bestDot) continue;
          const qx = clampMap(p.x + tx * step * dot, MAP.w), qy = clampMap(p.y + ty * step * dot, MAP.h);
          if (!blocked(qx, qy)) { best = { qx, qy, tx, ty, dot }; bestDot = dot; }
        }
      }
      if (best) {
        p.x = best.qx; p.y = best.qy;
        const sp = Math.hypot(p.vx, p.vy) * best.dot;
        p.vx = best.tx * sp; p.vy = best.ty * sp;
      } else { p.vx = 0; p.vy = 0; }
    }
  }

  // Water push, if a basin defines one. The stair spout does not.
  pushCurrent(p, dt);

  const moved = Math.hypot(p.x - ox, p.y - oy) * S;     // metres this tick
  p.mps = moved / Math.max(dt, 1e-4);
  return moved;
}

// metres: a drop deeper than this is not walked off by accident (see guard)
const EDGE_DROP = 2.6;
const EDGE_PROBE = 0.25 / S;   // game units ahead of the centre

// Deflections tried, in order, when both axes of a step are blocked.
const SLIDE_ANGLES = [20, -20, 40, -40, 60, -60, 75, -75];

// Find the nearest free point around a body that is inside stone and move it
// there at up to RECOVER u/s. Rings out to ~1.6 m; past that the body is not
// clipping a surface, it has been put somewhere wrong, and it is left alone
// for the checkpoint logic.
const RECOVER = 140;
export function depenetrate(p, dt) {
  if (!blockedAt(p.x, p.y, p.z)) return true;
  for (let r = 2; r <= 30; r += 2) {
    const n = Math.max(8, Math.round(r * 1.6));
    let found = null, bd = Infinity;
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2;
      const qx = p.x + Math.cos(a) * r, qy = p.y + Math.sin(a) * r;
      if (blockedAt(qx, qy, p.z)) continue;
      // prefer the way the body was already going
      const d = -(Math.cos(a) * (p.vx || 0) + Math.sin(a) * (p.vy || 0));
      if (d < bd) { bd = d; found = { qx, qy }; }
    }
    if (found) {
      const dx = found.qx - p.x, dy = found.qy - p.y, L = Math.hypot(dx, dy);
      const k = Math.min(1, (RECOVER * dt) / L);
      p.x += dx * k; p.y += dy * k;
      p.vx = 0; p.vy = 0;
      return false;
    }
  }
  return false;
}

// Zero the horizontal carry. Called when control is taken away — a hang, a
// mantle, a respawn — so the body does not resume a second later still moving.
export function killMomentum(p) { p.vx = 0; p.vy = 0; p.mps = 0; }
