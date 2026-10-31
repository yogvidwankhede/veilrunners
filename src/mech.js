import { MAP, S } from './constants.js';
import { WATER, PITS } from './level.js';

// ---------------------------------------------------------------------------
// MECHANISMS — the moving parts of the tomb.
//
// Everything here writes `off`, `top` and `warn` onto the level pieces that
// carry an `id`. traversal.js reads MAP.walls live every tick, so a mechanism
// never has to tell the physics anything: it edits the world and the physics
// is already looking at it.
//
// DETERMINISM. The collapsing tiles are a pure function of SIMULATED seconds
// (game.t / 1000), never of wall-clock time or frame count. That is what lets
// a co-op guest predict the gauntlet locally and still agree with the host
// about which tile is gone, without a single byte describing the cycle. The
// moment this reads performance.now() the two ends drift apart and the guest
// starts falling through floors that are still there on the host.
// ---------------------------------------------------------------------------

export const MECH = {
  // ---- the collapsing causeway (beat 4) ----
  //
  // THE STAGGER IS NOT FREE. A tile is 50 units wide and a RUN is 88 units/s,
  // so crossing one takes ~0.568 s. The stagger is set to cycle MINUS that, so
  // each tile returns just before a runner moving at speed arrives on it: the
  // gap opens ahead of you and you cross in its wake. It is tuned to the run
  // and not the walk on purpose — you are meant to commit to this one.
  //
  // The first tuning used a 1.05 s stagger because it looked like a rhythm, and
  // it made the causeway IMPOSSIBLE — tile A required leaving after t=1.70 and
  // tile B required leaving before t=1.69, with no start time satisfying both.
  // tools/tombtest.mjs now solves the crossing instead of assuming one exists.
  tileCycle:   4.00,   // s for one full open/shut cycle
  tileWarn:    0.50,   // s of shudder before the floor goes — the tell
  tileOpen:    1.20,   // s the tile is actually gone
  tileStagger: 3.432,  // = tileCycle - 50/88, one tile-crossing at a RUN

  // ---- travel times. Each is long enough to read as a machine moving ----
  bridgeFall:  1.50,   // s for the main bridge to swing down
  craneSwing:  0.50,   // s for the crane arm to swing in or retract
  sealSink:    1.80,   // s for the plinth seal to sink
  frontOpen:   1.20,   // s for the front door to grind open

  // ---- the co-op gates ----
  // A partner holding a lever keeps it engaged indefinitely. Alone, you get
  // this long after letting go. Without it the tomb would be unplayable solo,
  // and a judge opening this in one browser is the likeliest way it gets seen.
  soloGrace:   10.0,    // the crane arm, beat 5
  cwGrace:      8.0,    // the twin counterweight levers, beat 3
  // With TWO runners there is no solo window. The counterweight wants both
  // hands inside this tolerance (nobody presses on the same frame), and the
  // crane arm swings out the moment nobody is on a crane lever — so it is a
  // relay: one holds, one crosses, and the far lever brings the other over.
  coopSync:     0.6,
  coopCrane:    0.25,
  winchGrace:   4.0,    // the winch that jams the counted floor, beat 4

  // ---- the collapse (beat 7) ----
  // Masonry comes down while the tomb fills. Telegraphed, always: `debrisTell`
  // is how long the dust falls before the block does, and a hazard with no tell
  // is not difficulty, it is a coin toss the player cannot see.
  debrisEvery:  1.45,   // s between impacts
  debrisTell:   0.70,   // s of warning before one lands
  debrisRadius: 1.70,   // m within which it hurts
  debrisDamage:   26,   // not lethal on its own: the water is the deadline

  // ---- the flood (beat 7) ----
  drownDepth:  1.20,   // m of water above the feet before you are in trouble
  drownGrace:  2.50,   // s of that before it kills, so brushing it is survivable
};

const TILES = ['tile_a', 'tile_b', 'tile_c'];

// Pure function of simulated seconds. Returns whether tile `i` is gone, and how
// close it is to going (0..1) so the renderer can shudder it first.
export function tileState(simSeconds, i) {
  const c = MECH.tileCycle;
  const t = (((simSeconds + i * MECH.tileStagger) % c) + c) % c;
  if (t < MECH.tileWarn) return { off: false, warn: t / MECH.tileWarn };
  if (t < MECH.tileWarn + MECH.tileOpen) return { off: true, warn: 1 };
  return { off: false, warn: 0 };
}

// A cheap integer hash. Deterministic across machines, which Math.random is
// not — and the collapse has to look the same to both players.
function hash2(n) {
  let h = (n * 374761393 + 668265263) | 0;
  h = (h ^ (h >> 13)) * 1274126177 | 0;
  return (h ^ (h >> 16)) >>> 0;
}

export function createMech(game) {
  const byId = {};
  for (const w of MAP.walls) if (w.id) byId[w.id] = w;

  const m = {
    byId,
    bridge: 0,          // 0 raised .. 1 down
    crane: 0,           // 0 stowed .. 1 spanning the gap
    seal: 0,            // 0 shut over the plinth .. 1 sunk
    front: 0,           // 0 shut .. 1 open
    craneHold: 0,       // bodies on the crane lever THIS tick (interact.js recounts)
    craneGrace: 0,      // s of solo window left after the last hand came off
    holds: new Set(),   // every hold lever with a hand on it this tick
    winchLatch: 0,      // s the winch stays wound after the last hand came off
    tilesJammed: false, // the counted floor locked solid
    cwLatch: {},        // id -> s of grace left since that lever was last held
    cwLive: [],         // which counterweight levers currently count, for the HUD
    bridgeReleased: false, sealReleased: false, frontReleased: false,
    flooding: false, floodT: 0, waterZ: WATER.start,
    warns: [0, 0, 0], heldLive: false,
    debris: [], _debrisIdx: -1,
  };

  m.reset = () => {
    m.bridge = m.crane = m.seal = m.front = 0;
    m.craneHold = m.craneGrace = 0;
    m.holds.clear(); m.cwLatch = {}; m.cwLive = []; m.winchLatch = 0; m.tilesJammed = false;
    m.bridgeReleased = m.sealReleased = m.frontReleased = false;
    m.flooding = false; m.floodT = 0; m.waterZ = WATER.start;
    m.debris.length = 0; m._debrisIdx = -1;
    if (byId.bridge_main)  byId.bridge_main.off = true;    // raised
    if (byId.crane_arm)    byId.crane_arm.off = true;      // stowed
    if (byId.door_sanctum) byId.door_sanctum.off = false;  // sealed
    if (byId.door_front)   byId.door_front.off = false;    // shut
    if (byId.gate_causeway) byId.gate_causeway.off = false; // down
  };
  m.reset();

  m.releaseBridge = () => { m.bridgeReleased = true; };
  m.openSeal      = () => { m.sealReleased = true; };
  m.openFront     = () => { m.frontReleased = true; };
  m.startFlood    = () => { m.flooding = true; m.frontReleased = true; };

  m.step = (dt) => {
    const T = game.t / 1000;                      // SIMULATED seconds. Never a clock.

    // ---- the winch: wound, it jams every slab solid ----
    // A pure boolean rather than a change to the cycle, deliberately: the tile
    // phase is a function of game.t and BOTH ends of a co-op session derive it
    // independently. Stretching the cycle would make them disagree about which
    // slab is where; jamming them is one bit, and it is in the snapshot.
    if (m.holds.has('lever_winch')) m.winchLatch = MECH.winchGrace;
    else if (m.winchLatch > 0) m.winchLatch = Math.max(0, m.winchLatch - dt);
    m.tilesJammed = m.winchLatch > 0;

    // ---- the collapsing causeway ----
    for (let i = 0; i < TILES.length; i++) {
      const w = byId[TILES[i]]; if (!w) continue;
      const st = m.tilesJammed ? { off: false, warn: 0 } : tileState(T, i);
      w.off = st.off; w.warn = st.warn; m.warns[i] = st.warn;
    }

    // ---- THE TWIN COUNTERWEIGHT LEVERS ----
    // Both must count at the same instant. A lever "counts" while a hand is on
    // it, and for cwGrace seconds after — which is exactly what turns a task
    // needing two people into one person running very fast. With a partner the
    // latch never matters, because neither lever ever leaves a hand.
    const coop = !!(game.isCoop && game.isCoop());
    m.coop = coop;
    for (const id of ['lever_cw_a', 'lever_cw_b']) {
      if (m.holds.has(id)) m.cwLatch[id] = coop ? MECH.coopSync : MECH.cwGrace;
      else if (m.cwLatch[id] > 0) m.cwLatch[id] = Math.max(0, m.cwLatch[id] - dt);
    }
    m.cwLive = ['lever_cw_a', 'lever_cw_b'].filter(id => m.holds.has(id) || m.cwLatch[id] > 0);
    if (m.cwLive.length === 2 && !m.bridgeReleased) m.releaseBridge();

    // ---- the main bridge: one-way, it never goes back up ----
    if (m.bridgeReleased && m.bridge < 1) m.bridge = Math.min(1, m.bridge + dt / MECH.bridgeFall);
    if (byId.bridge_main) byId.bridge_main.off = m.bridge < 1;
    // The portcullis rises with the counterweight: one mechanism, two effects,
    // which is why pulling the levers reads as opening the way forward rather
    // than as dropping a bridge somewhere you cannot see.
    if (byId.gate_causeway) byId.gate_causeway.off = m.bridge >= 1;

    // ---- the crane arm: held, or inside the solo window ----
    if (m.craneHold > 0) m.craneGrace = coop ? MECH.coopCrane : MECH.soloGrace;
    else if (m.craneGrace > 0) m.craneGrace = Math.max(0, m.craneGrace - dt);
    const wantCrane = (m.craneHold > 0 || m.craneGrace > 0) ? 1 : 0;
    // A RATE, not an exponential ease. An asymptotic lerp never reaches 1, so
    // the arm sat at 0.91 forever and never crossed the 0.92 standable line:
    // the mechanic worked on screen and could not be walked on. Machines move
    // at a speed, and this one completes its travel in exactly craneSwing.
    const rate = dt / MECH.craneSwing;
    m.crane = wantCrane > m.crane ? Math.min(wantCrane, m.crane + rate)
                                  : Math.max(wantCrane, m.crane - rate);
    // Only standable once it is nearly home: a half-swung beam you can walk on
    // would let you cross before the mechanism has done anything.
    if (byId.crane_arm) byId.crane_arm.off = m.crane < 0.92;
    // The HUD runs after step() and needs to know whether a hand was actually
    // on the lever this tick, which the counter no longer says once it is zeroed.
    m.heldLive = m.craneHold > 0;
    m.craneHold = 0;                              // interact.js recounts each tick
    m.holds.clear();

    // ---- the plinth seal and the front door ----
    if (m.sealReleased && m.seal < 1) m.seal = Math.min(1, m.seal + dt / MECH.sealSink);
    if (byId.door_sanctum) byId.door_sanctum.off = m.seal >= 1;
    if (m.frontReleased && m.front < 1) m.front = Math.min(1, m.front + dt / MECH.frontOpen);
    if (byId.door_front) byId.door_front.off = m.front >= 1;

    // ---- the flood ----
    if (m.flooding) {
      m.floodT = Math.min(WATER.floodSeconds, m.floodT + dt);
      m.waterZ = WATER.start + (WATER.flood - WATER.start) * (m.floodT / WATER.floodSeconds);

      // ---- falling masonry ----
      // Positions come from a HASH of the impact index, not Math.random: both
      // ends of a co-op session derive the same schedule from floodT alone and
      // nothing about the collapse has to be transmitted. The same reasoning as
      // the collapsing tiles, for the same reason.
      const idx = Math.floor(m.floodT / MECH.debrisEvery);
      if (idx !== m._debrisIdx) {
        m._debrisIdx = idx;
        const h = hash2(idx);
        // along the escape corridor: the west half and the southern ruin
        const gx = 70 + (h & 1023) / 1023 * 760;
        const gy = 120 + ((h >> 10) & 1023) / 1023 * 700;
        m.debris.push({ x: gx, y: gy, t: -MECH.debrisTell, hit: false });
      }
      for (let i = m.debris.length - 1; i >= 0; i--) {
        const d = m.debris[i];
        d.t += dt;
        if (d.t > 1.2) m.debris.splice(i, 1);
      }
    }
  };

  // Masonry that lands ON someone this tick. Returns the damage, 0 otherwise.
  m.debrisHit = (p) => {
    for (const d of m.debris) {
      if (d.hit || d.t < 0) continue;              // still falling: the tell
      if (Math.hypot(p.x - d.x, p.y - d.y) * S < MECH.debrisRadius) {
        d.hit = true;
        return MECH.debrisDamage;
      }
    }
    return 0;
  };

  // Is this body standing in something that kills? Returns a pit name or null.
  m.pitAt = (p) => {
    for (const q of PITS) {
      if (p.x > q.x && p.x < q.x + q.w && p.y > q.y && p.y < q.y + q.h && p.z <= q.z) return q.name;
    }
    return null;
  };

  // How far under the water this body's feet are, in metres (0 when dry).
  m.submersion = (p) => Math.max(0, m.waterZ - p.z);

  // ---- netcode: the guest must see the same tomb, not just the same bodies --
  m.pack = () => [
    +m.bridge.toFixed(2), +m.crane.toFixed(2), +m.seal.toFixed(2), +m.front.toFixed(2),
    m.flooding ? 1 : 0, +m.floodT.toFixed(1), +m.craneGrace.toFixed(1),
    +(m.cwLatch.lever_cw_a || 0).toFixed(1), +(m.cwLatch.lever_cw_b || 0).toFixed(1),
    +m.winchLatch.toFixed(1),
  ];
  m.apply = (a) => {
    if (!a) return;
    const [bridge, crane, seal, front, flooding, floodT, craneGrace, cwa, cwb, wl] = a;
    m.cwLatch.lever_cw_a = cwa || 0; m.cwLatch.lever_cw_b = cwb || 0;
    m.winchLatch = wl || 0; m.tilesJammed = m.winchLatch > 0;
    m.bridge = bridge; m.crane = crane; m.seal = seal; m.front = front;
    m.flooding = !!flooding; m.floodT = floodT; m.craneGrace = craneGrace;
    m.bridgeReleased = bridge > 0; m.sealReleased = seal > 0; m.frontReleased = front > 0;
    m.waterZ = WATER.start + (WATER.flood - WATER.start) * (m.floodT / WATER.floodSeconds);
    if (byId.bridge_main)  byId.bridge_main.off  = m.bridge < 1;
    if (byId.crane_arm)    byId.crane_arm.off    = m.crane < 0.92;
    if (byId.door_sanctum) byId.door_sanctum.off = m.seal >= 1;
    if (byId.door_front)   byId.door_front.off   = m.front >= 1;
    if (byId.gate_causeway) byId.gate_causeway.off = m.bridge >= 1;
  };

  // -----------------------------------------------------------------------
  // VISUALS. Separate from the simulation on purpose: this runs per FRAME with
  // a variable dt and may interpolate freely, because nothing it touches can
  // change the outcome of the game.
  // -----------------------------------------------------------------------
  m.syncVisuals = (world, placed, now) => {
    const mv = (world && world.moving) || {};
    const setPiece = (id, dy, dx, hide) => {
      const h = mv[id];
      const ps = placed && placed[id];
      const hasProp = !!(ps && ps.length);
      // When a Meshy prop has replaced this piece its box is hidden for good;
      // writing visible=true here every frame would switch it back on and draw
      // both. The prop is the geometry now.
      if (h && !hasProp) {
        h.box.position.y = h.baseBoxY + dy; h.cap.position.y = h.baseCapY + dy;
        h.box.position.x = h.box.userData.bx ?? (h.box.userData.bx = h.box.position.x);
        h.cap.position.x = h.cap.userData.bx ?? (h.cap.userData.bx = h.cap.position.x);
        h.box.position.x += dx; h.cap.position.x += dx;
        h.box.visible = h.cap.visible = !hide;
      }
      // the Meshy prop for the same piece, when the pack is loaded
      if (ps) for (const o of ps) {
        o.position.y = (o.userData.baseY || 0) + dy;
        o.position.x = (o.userData.bx ?? (o.userData.bx = o.position.x)) + dx;
        // RECORD the intent. main.js combines it with room discovery and sets
        // `visible` in exactly one place: writing it from two systems meant
        // whichever ran last won, and the room pass only ever turned props off
        // — so a prop hidden before its chamber opened never came back.
        o.userData.mechHide = hide;
      }
    };

    // tiles: shudder as they are about to go, then vanish
    for (let i = 0; i < TILES.length; i++) {
      const w = byId[TILES[i]]; if (!w) continue;
      const shake = w.warn > 0 && !w.off ? Math.sin(now * 60 + i) * 0.03 * w.warn : 0;
      setPiece(TILES[i], shake, shake * 0.5, !!w.off);
    }
    // the bridge swings down from 3.4 m above its seated height
    setPiece('bridge_main', (1 - m.bridge) * 3.4, 0, false);
    // the crane slides in from the east
    setPiece('crane_arm', 0, (1 - m.crane) * 2.6, false);
    // the seal sinks into the plinth, then stops being drawn
    setPiece('door_sanctum', -m.seal * 2.3, 0, m.seal >= 1);
    // the front door grinds down into the floor
    setPiece('door_front', -m.front * 5.2, 0, m.front >= 1);
    // the gate grinds down into the floor as the counterweight falls. It used
    // to lift 3.4 m, but the block is founded at 0 and stands 7.5 m, so lifted
    // it still filled the doorway and the runner walked through drawn stone.
    setPiece('gate_causeway', -m.bridge * 2.65, 0, m.bridge >= 1);

    if (world && world.water) {
      const w = world.water, u = w.userData;
      w.position.y = m.waterZ;
      // The pool is the antechamber until the tomb floods, then it is the tomb.
      // Easing the scale rather than snapping it keeps the water's edge from
      // jumping across the map on the frame the disc comes off the plinth.
      if (u.hallScale) {
        const k = m.flooding ? Math.min(1, m.floodT / 6) : 0;     // 6 s to spread
        w.scale.x = u.hallScale[0] + (1 - u.hallScale[0]) * k;
        w.scale.y = u.hallScale[1] + (1 - u.hallScale[1]) * k;
        w.position.x = u.hallPos.x + (u.fullPos.x - u.hallPos.x) * k;
        w.position.z = u.hallPos.z + (u.fullPos.z - u.hallPos.z) * k;
      }
    }
  };

  return m;
}
