// VEILRUNNERS rules. The map was ported 1:1 from the 2D original; it is now a
// purpose-built tiered level — see level.js.
import { WALLS, BUSHES, ZONES, SPAWNS, RELICS } from './level.js';
// Movement was ported straight from the 2D game, where 150 units/s felt right in
// pixels. At S=0.055 that is 8.25 m/s for a 1.85 m character — faster than Usain
// Bolt — and no gait can look right under it. Retuned to a jog / run.
// target was 3, which an uncontested bot finishes in ~70 s — the 7-minute timer
// never mattered and a demo was over before anyone saw the map. Swept 3/5/8/10/12
// against idle-player matches: 8 gives a 2.7-minute median and leaves the timer a
// real backstop. See section 11 of HANDOFF.md for the table.
// crouch 60 was 3.30 m/s against a 1.12 m/s crouch-walk clip: 36% foot slip even at
// the 1.9x playback ceiling. 38 gives 2.09 m/s, which the clip covers, and makes
// crouching a real stealth trade rather than a slightly slower jog.
// WALK is the default, RUN is on shift. The ported numbers made the default
// 90 u/s = 4.95 m/s — a flat-out run — and sprint 125 = 6.88 m/s, which is
// faster than Usain Bolt averages over 100 m. Everything about the character
// read as hurrying because it genuinely never walked.
//   40 u/s = 2.20 m/s  brisk walk   (the walk clip's natural speed is 1.97)
//   88 u/s = 4.84 m/s  run          (the run clip's natural speed is 3.71)
//   20 u/s = 1.10 m/s  crouch       (the crouch-walk clip is 1.12 — a match)
// Keeping each tier near its clip's natural speed is what keeps foot slip at
// zero without the playback rate having to stretch to cover the difference.
export const RULES = { duration:420000, target:8, speed:40, sprint:88, crouch:20, carrier:0.86,
  attack:32, attackRange:65, attackCooldown:650, dodgeCooldown:3500, respawn:5000, extract:3000 };
// The level lives in level.js now. MAP keeps the same shape so collision.js,
// traversal.js and game.js are untouched by the rebuild.
export const MAP = {
  w:1200, h:900,
  walls: WALLS,
  bushes: BUSHES,
  zones: ZONES,
  spawns: SPAWNS,
  relics: RELICS,
};
// ---- bot AI ----
// The bots used to read every relic and every enemy on the map with no vision
// check, re-decide perfectly every tick, and claim relics without pressing the
// button the player has to hold. They finished 3/3 inside half a minute.
export const BOT = {
  sight: 380,        // world units they can perceive a relic or enemy within
  think: 420,        // ms committed to a goal before re-deciding
  thinkJitter: 450,  // + up to this, so four bots do not act in lockstep
  wander: 2200,      // ms before picking a new search point when nothing is visible
  aimNoise: 0.16,    // radians of heading error, so they do not travel on rails
};

// Team colours for runners (first is the player).
export const TEAM = [0x7fe3ff,0xee8f7e,0xbfa6ef,0x8bd682,0xe2d793,0xed9fce,0xffb14e,0x80cfb6];
// One world unit ~ 1.8cm; scale so the arena is a comfortable ~ 66 x 50 metres.
export const S = 0.055;

// ---- combat ----
// An attack is a timeline, not an instant. Damage lands only during `active`,
// which is what makes blocking, parrying and dodging possible at all — the
// ported version applied damage on the same frame the button went down.
export const COMBAT = {
  windup: 0.17,       // s before the blade is live (the tell)
  active: 0.12,       // s the hit window is open
  recover: 0.38,      // s locked out afterwards
  parryWindow: 0.26,  // s after raising guard that a hit is parried outright
  blockSoak: 0.25,    // fraction of damage taken through a held guard
  rollTime: 0.55,     // s of the dodge roll
  rollIFrames: 0.38,  // s of invulnerability inside it
  hitStun: 0.38,      // s of stagger after taking a hit
  parryStun: 0.75,    // s the attacker is stunned when parried
  hitStop: 0.075,     // s the whole sim freezes on a landed hit — the impact
  shake: 0.45,        // screen shake magnitude on a landed hit
};

// ---- locomotion feel ----
// The ported movement set velocity and facing DIRECTLY from the stick:
//   p.angle = atan2(dy,dx);  p.x += dx*speed*dt;
// which is instant top speed, instant stop and a one-frame 180 degree pivot.
// That combination is the single loudest "this is not a real character" signal
// a third-person game can emit, and no amount of mocap survives it.
//
// Accelerations are in game units/s^2 (top speed is 90 u/s, sprint 125).
export const MOVE = {
  // --- DERIVED FROM UNREAL'S CharacterMovementComponent, the de-facto baseline
  // for third-person action games, rather than from taste:
  //     MaxWalkSpeed              600 uu/s   = 6.00 m/s
  //     MaxAcceleration          2048 uu/s^2 = 20.5 m/s^2  -> 0.293 s to top speed
  //     BrakingDecelerationWalking 2048, with BrakingFrictionFactor 2.0
  //     AirControl                0.05 component default, 0.2 in the TP template
  //     RotationRate              360 deg/s component, 500 deg/s in the template
  // This game runs at 90 u/s (4.95 m/s), so the TIME constants carry over and
  // the rates are rescaled to our units.
  //
  // Quake PM_Accelerate / PM_Friction on the 1/60 tick, scaled to our
  // units (walk 40, sprint 88), not to Quake's 320. One accel for every
  // gait. 222 reaches a jog in ~0.18 s. 500 is the brake under stopspeed,
  // so a jog plants in ~0.08 s. Above the walk, friction is speed times
  // (decel/walk), so a sprint falls under a walk in well under 0.12 s.
  accel:      222,
  decel:      500,
  // Quake PM_AirMove accelerates with pm_airaccelerate (1) against
  // pm_accelerate (10). bevy_tnua's default air_acceleration is 20 against
  // a ground acceleration of 60, and that one number is used for every air
  // velocity change — there is no separate, weaker coast. 44 is 0.32 of the
  // ground accel: enough to correct a jump, not enough to fly it.
  airAccel:    44,
  airDecel:    44,

  // Radians/s. Unreal's template turns at a constant 500 deg/s (8.73 rad/s);
  // real third-person games slow it down with speed, because nobody pivots on
  // a sixpence at a sprint. These bracket the Unreal value.
  turnRate:    10.0,   // standing: 180 deg in 0.31 s
  turnRateRun:  6.5,   // sprinting: 180 deg in 0.48 s

  // ASYMMETRIC GRAVITY (GDC 2016, "Math for Game Programmers: Building a Better
  // Jump"). Rising and falling at the same rate is what "floaty" actually
  // means. Falling ~2.2x faster keeps the arc snappy while leaving the rise
  // readable enough to aim. With jumpSpeed 6.35 the held jump clears about
  // 1.14 m. A released jump falls at fall-gravity while it is still rising.
  riseGravity: -18,
  fallGravity: -40,
  // A beat of reduced gravity through the apex - not physical, it is the window
  // in which the player actually decides where to land.
  apexVz:      1.6,
  // 0.68, not 0.55. More than about a third off gravity through the top turns
  // "a moment to choose a landing" into hanging in the air, and the jump reads
  // as weak because the character spends most of it drifting. This keeps the
  // beat and loses the float: held apex about 1.10 m, airborne 0.65 s.
  apexScale:   0.68,

  // Forgiveness. Motor intent precedes the press by 80-120 ms, so a player who
  // commits at the edge issues the command while the character is already past
  // it. Published windows run 0.05-0.15 s; Celeste ships 5 frames (~83 ms).
  // Both of these are deliberate, and both look like bugs in a diff.
  coyote:      0.12,   // s after walking off a ledge that jump still works
  jumpBuffer:  0.12,   // s before landing that a jump press is remembered

  // Landing. Below landSoft nothing shows; at landHard it is at full strength.
  // Drives the camera dip and the animation, never the simulation.
  landSoft:     2.5,   // m/s
  landHard:    11.0,   // m/s
  stepSmooth:    16,   // 1/s the VISUAL height catches up over a step
};

// ---- traversal ----
// The simulation had no vertical axis at all: players were (x,y) and the mesh was
// pinned at y=0. Climbing needs height, so walls become surfaces you can stand on.
export const PHYS = {
  // The body is a 0.36 m capsule, a person's. The 2D game this was ported from
  // used 0.77 m (14 u), and every wall stopped you a stride short of the stone.
  bodyRadius: 0.36,
  gravity: -18,      // m/s^2, gamey rather than 9.81
  stepUp: 0.45,      // m you can walk up without climbing
  reach: 3.1,        // m the hands can reach above the feet. Must clear the
                     // tallest wall (2.8) or nothing in the map is grabbable.
  minLedge: 0.9,     // m below which it is a step, not a climb
  hangBelow: 1.55,   // feet sit this far under the ledge while hanging
  // TWO grab ranges, because one range cannot serve both cases. 34 units is
  // 1.87 m: with a single range that wide, pressing Space anywhere within two
  // metres of a grabbable face SNAPPED you onto the wall instead of jumping,
  // and attachToLedge teleports, so you also slid sideways up to 1.87 m. Most
  // jump presses near architecture never produced a jump at all.
  // MUST clear the body radius (PHYS.bodyRadius, 6.5 u) or a standing grab
  // is unreachable: collision stops you 14 u from the face, so 11 u could never
  // be satisfied and pressing Space against a wall would only ever jump.
  grabStand: 11.5,   // u (0.63 m) — a standing grab needs you AGAINST the face
  grabRange: 30,     // u (1.65 m) — an airborne reach toward a ledge, and bots
  shimmy: 55,        // game units/s sideways along a ledge
  // 0.90 s. The mantle clip's useful pull-and-step is 2.7 s long; shorter than
  // this and that motion is a blur. The feet still rise first and step over
  // second — only the clock changed.
  mantleTime: 1.15,  // s: the climb-top clip played at ~2.4x; quicker reads as a scramble
  dropGrace: 0.25,   // s after leaving a ledge before you can regrab
  // 6.35 m/s. 6.0 topped out near 1.0 m, a flinch in a tomb of 2.5 m
  // ledges. Higher than this and a jump from the floor can catch the 4.3 m
  // rubble, which skips a climb. ~1.14 m, still airborne under 0.7 s.
  jumpSpeed: 6.35,
  vaultMax: 1.45,    // m: obstacles up to here are vaulted, not climbed or blocked
  vaultTime: 0.42,   // s of the scripted arc over them
  vaultMinSpeed: 1.2,// m/s you must carry into it — a standing vault looks wrong
  // How long the hands take to REACH the lip after a grab. The body is parked
  // on the face immediately (the collision has to be), and the mesh slides
  // across this window so the catch is a reach instead of a teleport.
  catchTime: 0.22,
  edgeSnap: 26,      // game units from a ledge edge that counts as "at the edge"
};

// ---- simulation timing ----
// The simulation advances on a FIXED step and the render interpolates between
// steps. A variable step makes movement, cooldowns and attack windows depend on
// the frame rate, which breaks the moment the game leaves a 120 Hz Mac.
export const TICK_HZ = 60;
export const TICK = 1 / TICK_HZ;
// Longest real time one frame may feed the accumulator. Beyond this we drop the
// backlog rather than simulate it, so a stall cannot spiral into a freeze.
export const MAX_FRAME_DT = 0.25;
// Ticks one frame may run. This is the floor on real-time fidelity: at 8 steps a
// 7.5 fps device still simulates at full speed, below that the world runs slow
// rather than freezing. Measured at 5 the game ran 83% speed at 10 fps.
export const MAX_CATCHUP_STEPS = 8;
export const groundY = 0;
