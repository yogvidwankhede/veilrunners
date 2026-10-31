// ---------------------------------------------------------------------------
// THE CRADLE OF SILT — a challenge tomb, authored as data.
//
// Modelled on a Shadow of the Tomb Raider co-op challenge tomb: one sealed
// space, seven beats, an ending. Not an arena with a score — a route with a
// lock on it, and the lock is the level.
//
// Every piece is the same primitive the 2D port already supported: an
// axis-aligned box with a `top` in metres. Pieces a mechanism moves carry an
// `id`; mech.js writes `top` on those and nothing else in the engine notices,
// because groundAt()/blockedAt() read MAP.walls live every tick.
//
// Coordinates are game units (1200 x 900). Heights are METRES. S = 0.055, so
// the tomb is about 66 x 50 m and 12 m tall.
// ---------------------------------------------------------------------------

// Climb reach is 3.1 m from the feet (PHYS.reach), so no surface may sit more
// than that above the one you reach it from. tools/tombtest.mjs asserts it for
// every piece and for every beat-critical route.
export const TIER = { ground: 0, low: 2.5, mid: 5.0, high: 7.5, peak: 9.6 };

const box = (x, y, w, h, top, tag, id) => ({ x, y, w, h, top, tag, id });

// A walkable staircase: `steps` boxes rising from `from` to `to`. Each rise must
// stay under PHYS.stepUp (0.45 m) or the player has to climb it instead of walk.
function stair(x, y, w, h, from, to, steps, axis = 'x') {
  const out = [];
  for (let i = 0; i < steps; i++) {
    const t = from + (to - from) * ((i + 1) / steps);
    out.push(axis === 'x'
      ? box(x + (w / steps) * i, y, w / steps + 1, h, t, 'stair')
      : box(x, y + (h / steps) * i, w, h / steps + 1, t, 'stair'));
  }
  return out;
}

export const WALLS = [
  // ---------- outer shell: 12 m. Nothing climbs out of a tomb. ----------
  box(0,    0,   1200, 40,  12, 'shell'),
  box(0,    860, 1200, 40,  12, 'shell'),
  box(0,    0,   40,   900, 12, 'shell'),
  box(1160, 0,   40,   900, 12, 'shell'),

  // =======================================================================
  // BEAT 1 — ENTRANCE HALL   (x 40..330, ground)
  // Flooded antechamber. Low rubble to vault, broken pillars to climb, and a
  // front door that stays shut until the tomb cracks it open in beat 7.
  // =======================================================================
  box(40,  400, 26, 110, TIER.mid, 'door', 'door_front'),
  // ---- THE STAIR HALL and THE CRYPT ----
  // The hall was one 16 x 45 m room with a few blocks in it: nothing to make
  // you feel you had arrived anywhere. A 9 m screen wall now divides it (9, so the 5 m inner wall it meets is no step onto it). South
  // of it is the crypt you wake in, under the collapse, with its colonnade and
  // the sealed front door; north of it, through one doorway, is the stair hall
  // and the way up. You see the doorway from the spawn, and nothing past it.
  box(40,  300, 110, 22, 9.0, 'screen'),
  box(230, 300, 100, 22, 9.0, 'screen'),
  // the colonnade: full-height columns, two each side of the nave, clear of
  // the pool of light under the shaft and of the walk to the front door
  box(105, 627, 26, 26, 11, 'column'),
  box(105, 777, 26, 26, 11, 'column'),
  box(217, 627, 26, 26, 11, 'column'),
  box(217, 777, 26, 26, 11, 'column'),
  // two obelisks keep the front door, 5.5 m: past even a jump's reach, there to be seen
  box(66, 366, 22, 22, 5.5, 'obelisk'),
  box(66, 522, 22, 22, 5.5, 'obelisk'),
  box(130, 560, 90, 22, 1.10, 'cover'),
  box(215, 430, 24, 80, 1.25, 'cover'),
  // West face inset from x=74 to x=90. The shell's east face is x=40, so the
  // old box left a 1.87 m gap and, after the 0.77 m body pad on both sides,
  // 0.33 m of clear width. The body wedged in that corner and a floor grab
  // fired on the south face. The east face stays at x=146 so the route
  // between the pillars is unchanged. Clear width against this box is 1.21 m.
  // The placed pillar's circle is pulled back to this face in placements.json
  // (r 0.44, before the shared fit). The default circle reached the shell.
  // The four hall pillars are the CARVED pillar's footprint: 50 u (2.75 m)
  // square, centred where it stands. They were 72 u boxes behind a 50 u
  // model, which is 0.6 m of invisible stone on every face — the collision
  // audit's single largest phantom.
  box(85,  161, 50, 50, TIER.low, 'pillar'),
  box(85,  671, 50, 50, TIER.low, 'pillar'),
  box(243, 671, 50, 50, TIER.low, 'pillar'),

  // =======================================================================
  // BEAT 2 — THE NORTH GALLERY   (ground -> 2.5 -> 5.0)
  // The stairs are the honest route up; the pillar at (232,150) is the
  // shortcut for anyone who would rather climb.
  // =======================================================================
  // The run is 210 wide, not 180: at 180 the top step ended at x=301 and the
  // gallery began at x=330, leaving a 29-unit hole at 2.5 m that dropped you
  // back into the hall. Each of the 7 rises is 0.36 m, under PHYS.stepUp.
  ...stair(120, 56, 210, 84, TIER.ground, TIER.low, 7, 'x'),
  // There is deliberately NO landing slab across y 140..194. One used to sit
  // here and it walled the foot of the staircase off from the entrance hall:
  // a 2.5 m barrier between the player and the only route up. You now reach
  // the stairs along the open west side of the hall.
  box(243, 161, 50, 50, TIER.low, 'pillar'),      // the climb-it-instead shortcut
  box(330, 56,  120, 84, TIER.low, 'gallery'),
  box(400, 140, 90,  60, TIER.mid, 'ledge'),       // 2.5 -> 5.0, a real climb
  box(470, 56,  140, 144, TIER.mid, 'gallery'),    // onto the mechanism floor

  // ---------- inner wall: 5 m, the hall cannot simply be walked out of -----
  // 44 units (2.4 m) across, not 30 (1.65 m). You can climb onto this from the
  // gallery and the escape route runs along the top of it, so it is a walkway
  // whether it was meant to be one or not — and at 1.65 m walking it read as a
  // tightrope over the abyss.
  box(330, 194, 44, 666, TIER.mid, 'wall_inner'),

  // =======================================================================
  // THE CHASM   (x 360..520, y 194..860)
  // No geometry at all: groundAt() returns 0 wherever no wall covers a point,
  // which means a hole in the architecture is a floor and not a hole. PITS
  // makes this one lethal. The only way across low is the main bridge, and the
  // main bridge is raised until the counterweight drops in beat 3.
  // =======================================================================
  box(360, 430, 160, 64, TIER.mid, 'bridge', 'bridge_main'),

  // =======================================================================
  // BEAT 3 — MECHANISM CHAMBER   (x 520..790, y 150..520, floor 5.0)
  // Four pillars at 7.5 ring a counterweight drum. Pulling the lever drops
  // the bridge and wakes what was sleeping on the floor.
  // =======================================================================
  box(520, 150, 270, 370, TIER.mid, 'floor'),
  // Pulled clear of the north edge. At y=168 the north-west pillar's pad zone
  // (x 526..602) sat across the ONLY join between the gallery and this floor,
  // which overlap on x 520..610 — leaving about six usable units for a body
  // twenty-eight across. The chamber was effectively sealed from the route in.
  box(556, 206, 48,  48,  TIER.high, 'pillar'),
  box(706, 206, 48,  48,  TIER.high, 'pillar'),
  box(556, 430, 48,  48,  TIER.high, 'pillar'),
  box(706, 430, 48,  48,  TIER.high, 'pillar'),
  box(618, 298, 74,  74,  6.05,      'altar'),     // the drum itself

  // =======================================================================
  // BEAT 4 — THE COLLAPSING CAUSEWAY   (x 790..1030, y 318..422, floor 5.0)
  // Three floor tiles over a pit, retracting out of phase on a fixed cycle
  // (MECH.tileCycle). Cross on the rhythm or fall through.
  //
  // The first design had pistons rising out of the floor, which on inspection
  // only LIFTS whoever is standing on one — a lift, not a hazard, because this
  // engine has surfaces and no ceilings. Taking the floor away instead is the
  // same beat and is something the engine can actually express.
  //
  // The cycle is a pure function of the simulation tick, so both ends of a
  // co-op session agree on the phase without anybody transmitting it.
  // =======================================================================
  // THE GATE. The chamber floor ends at x=790 and the causeway begins at x=790:
  // they touch, so beat 4 could be walked into without ever doing beat 3. The
  // counterweight gated the BRIDGE, which is only an alternative route.
  //
  // A portcullis rather than darkness: you can see the counted floor breathing
  // from the chamber, which is the point — the tomb shows you what is coming
  // and then makes you earn it. It lifts when the counterweight drops.
  box(784, 318, 14,  104, TIER.high, 'door', 'gate_causeway'),
  // EACH PIECE IS ONE UNIT WIDER THAN ITS SPACING, so consecutive pieces
  // overlap. insideWall() uses strict > and <, so two surfaces that merely
  // ABUT leave a zero-width seam where groundAt() returns 0 — a one-tick hole
  // in the floor at exactly x=840. The staircase already does this (`w/steps+1`
  // in stair()); the causeway did not, and a body whose x landed on the seam
  // would read as standing over the abyss.
  // TWO ARCHES stride over the counted floor, feet in the lava either side of
  // it, so the timing run happens through a gateway rather than along a plank.
  // The legs stand just off the causeway's edges; the crowns are 9.6 m up.
  box(862, 294, 24, 22, 11, 'arch'),
  box(862, 424, 24, 22, 11, 'arch'),
  box(958, 294, 24, 22, 11, 'arch'),
  box(958, 424, 24, 22, 11, 'arch'),
  box(790, 318, 51,  104, TIER.mid, 'causeway'),            // approach, solid
  box(840, 318, 51,  104, TIER.mid, 'tile', 'tile_a'),
  box(890, 318, 51,  104, TIER.mid, 'tile', 'tile_b'),
  box(940, 318, 51,  104, TIER.mid, 'tile', 'tile_c'),
  box(990, 318, 40,  104, TIER.mid, 'causeway'),            // landing, solid

  // =======================================================================
  // BEAT 5 — THE CRANE GAP   (x 1030..1090, about 3.3 m of nothing)
  // The arm swings in only while the lever is held: by a partner, or by the
  // solo grace window. Stand on it when it retracts and you go down with it.
  // =======================================================================
  box(1030, 342, 60, 56, TIER.mid, 'crane', 'crane_arm'),

  // ---------- the tower: 7.5, and the bridge to the sanctum ---------------
  // It runs south to y=560 so it ABUTS the sanctum ring. At y 250..500 there was
  // a 60-unit gap to the ring and the grab range is 48, which made the whole of
  // beat 6 unreachable. Note it does NOT reach the causeway landing either
  // (60 units of gap at x 1030..1090): that gap is the crane, and it is the gate.
  box(1090, 250, 70, 310, TIER.high, 'tower'),

  // =======================================================================
  // BEAT 6 — THE SANCTUM   (x 820..1120, y 560..840)
  // A sunken chamber ringed by a 7.5 m walkway. The three braziers stand on
  // the walkway; the doorway slab drops to 5.6 when they are lit in the order
  // the glyphs give, and the relic is on the plinth inside.
  // =======================================================================
  // The north side the fires stand on stays 40 units (y 560..600) so it
  // still meets the west arm and the drop into the sanctum at the same edges.
  // An APRON north of that (y 528..560, x 860..1120, 3.96 m of depth together)
  // is where you walk past the braziers. It starts at x 860, not 820: carried
  // to the west corner it lands within grab range of the mechanism floor and
  // the crane stops being the gate to the tower.
  box(820,  560, 300, 40,  TIER.high, 'sanctum'),      // north lip, y 560..600
  box(860,  528, 260, 32,  TIER.high, 'sanctum'),      // apron, y 528..560
  box(820,  800, 300, 40,  TIER.high, 'sanctum'),      // south, y 800..840
  box(820,  560, 40,  280, TIER.high, 'sanctum'),      // west,  x 820..860
  box(1080, 560, 40,  280, TIER.high, 'sanctum'),      // east,  x 1080..1120
  box(860,  600, 220, 200, 5.60,      'sanctumfloor'),
  // 6.0, not 6.4. From the sanctum floor at 5.6 a 0.8 m rise lands in the dead
  // zone between stepUp (0.45) and minLedge (0.9): too tall to walk up, too
  // short to count as a ledge. 0.4 m is a step you simply walk onto.
  box(940,  640, 86,  80,  6.00,      'plinth'),
  // The seal over the plinth, not a door in the wall: you enter the sanctum by
  // dropping off the 7.5 m ring (1.9 m down, and climbable back out), so a
  // doorway would gate nothing. This gates the relic, which is the actual prize.
  box(934,  634, 98,  92,  7.60,      'door', 'door_sanctum'),

  // =======================================================================
  // THE SOUTH RUIN   (the escape route west, at 2.5 and 5.0)
  // Beat 7 floods the tomb to 3.2 m, so the run home is NOT the ground floor.
  // This is the chain of blocks that makes the escape survivable, and every
  // rise in it is under PHYS.reach.
  // =======================================================================
  // Each carries an id so a Meshy heap can replace it: they are four different
  // heights, so one shared placement key cannot represent all of them.
  // The heaps OVERLAP. At 120 and 110 wide they left 20-unit holes between
  // them — about 1.1 m of nothing. That was survivable only because the old
  // default speed was 4.95 m/s, fast enough to clear a 20-unit gap inside the
  // 0.19 s the body took to fall the 0.7 m onto the next heap. Walking at
  // 2.2 m/s you simply drop through, which is how the holes were found.
  // THE AQUEDUCT: a ruined arcade along the south wall, piers in the lava, the
  // skyline of the escape. It points west, which is home. Nothing stands on it.
  box(458, 834, 24, 22, 8.4, 'aqueduct'),
  box(578, 834, 24, 22, 8.4, 'aqueduct'),
  box(698, 834, 24, 22, 8.4, 'aqueduct'),
  box(700, 600, 150, 100, TIER.mid, 'rubble', 'rubble_1'),   // x 700..850
  box(560, 640, 145, 90,  4.30,     'rubble', 'rubble_2'),   // x 560..705
  box(430, 690, 135, 90,  TIER.low, 'rubble', 'rubble_3'),   // x 430..565
  // 2.1, not 1.9: from 1.9 up onto the 5 m inner wall is a 3.1 m rise, which is
  // EXACTLY PHYS.reach. A route whose last climb sits on the limit works until
  // somebody retunes reach by a centimetre and the escape silently closes.
  box(360, 740, 90,  90,  2.10,     'rubble', 'rubble_4'),

  // ---------- chamber walls: 11 m, with the doorways cut by the route --------
  // Everything above is a PLATFORM — `floor`, `gallery`, `causeway` and the
  // rest are boxes whose `top` is a surface you stand on. Apart from the shell
  // and four pillars the tomb had almost no vertical surfaces at all, so you
  // stood in one chamber and read every trap in the next.
  //
  // A roof was the wrong answer to that: it only blocks the view by being low
  // enough to force the camera under it, which is a lid over the player's head.
  // Walls block the same sight line standing up, and a tomb is chambers divided
  // by walls anyway. 11 m clears the camera (which sits ~5 m over a 5 m floor)
  // and stops under the 12.4 m vault. A 6 m rise is far past PHYS.reach, so
  // none of these is climbable and none of them opens a new route.
  //
  // GENERATED, not hand-placed — tools/gen-dividers.mjs proposes chunks along
  // each chamber's perimeter and drops any the recorded playthrough passes
  // through, so a doorway exists exactly where the route needs one:
  //   VEIL_PATH=/tmp/veilpath.json node tools/runthrough.mjs
  //   node tools/gen-dividers.mjs
  box(550, 134, 240, 16, 11, 'chamberwall'),
  box(520, 520, 270, 16, 11, 'chamberwall'),
  box(504, 360, 16, 160, 11, 'chamberwall'),
  box(790, 150, 16, 180, 11, 'chamberwall'),
  box(790, 420, 16, 100, 11, 'chamberwall'),
  box(470, 40, 140, 16, 11, 'chamberwall'),
  box(470, 200, 30, 16, 11, 'chamberwall'),
  box(560, 200, 50, 16, 11, 'chamberwall'),
  box(610, 56, 16, 144, 11, 'chamberwall'),
  box(860, 800, 220, 16, 11, 'chamberwall'),
];

// Concealment volumes: crouch inside one and the guardians lose you.
export const BUSHES = [
  // Not on top of the spawn. At (150,380) this filled the opening shot with
  // leaves and hid the hall behind the one thing the player is standing in.
  { x: 240, y: 340, w: 86,  h: 120 },
  { x: 560, y: 200, w: 120, h: 80  },
  { x: 880, y: 720, w: 120, h: 70  },
];

// -----------------------------------------------------------------------
// LETHAL FLOOR. A pit is a region where being at or under `z` kills. That is
// what makes a bridge worth dropping and a gap worth bridging.
// -----------------------------------------------------------------------
export const PITS = [
  // THE ABYSS: everything east of the inner wall, at floor level.
  //
  // This is not decoration, it is the fix for a soft-lock. Every chamber east of
  // x=360 sits at 5 m or higher over empty space, and groundAt() returns 0 where
  // no piece covers a point — so stepping off the causeway put you on an
  // invisible floor 5 m below the only surface you could climb, alive and
  // permanently stuck. Falling in the east half now kills and returns you to the
  // beat's checkpoint, which is both recoverable and what the fiction says.
  //
  // Nothing east of x=360 is legitimately stood on below 2.1 m, so this cannot
  // catch a player who is where they should be. The entrance hall (x 40..360)
  // stays dry floor: it is where beat 1 happens and where beat 7 ends.
  { x: 360, y: 40, w: 800, h: 820, z: 0.40, name: 'the abyss' },

  // The tile gaps and the crane gap, 4.6 m up: a separate, higher line so that
  // losing the floor kills you AS it happens rather than after a five-metre
  // fall. The read matters — "the slab went away" instead of "I died later".
  { x: 840, y: 318, w: 250, h: 104, z: 4.60, name: 'the causeway drop' },
];

// -----------------------------------------------------------------------
// INTERACTABLES. `kind` drives behaviour in interact.js:
//   glyph   — read once, reveals one entry of the brazier order
//   lever   — mode 'pull' fires once; mode 'hold' needs continuous presence
//   brazier — light, in order
//   relic   — the prize, and the trigger for beat 7
// -----------------------------------------------------------------------
export const INTERACTABLES = [
  { id: 'glyph_1', kind: 'glyph', x: 96,   y: 348, z: TIER.ground, r: 52,
    label: 'READ THE GLYPH', reveals: 0 },
  { id: 'glyph_2', kind: 'glyph', x: 575,  y: 118, z: TIER.mid,    r: 52,
    label: 'READ THE GLYPH', reveals: 1 },
  { id: 'glyph_3', kind: 'glyph', x: 1148, y: 300, z: TIER.high,   r: 52,
    label: 'READ THE GLYPH', reveals: 2 },

  // THE COUNTERWEIGHT TAKES TWO. A drum wound with rope thick as your arm does
  // not come loose under one pair of hands, and this is the tomb's first real
  // co-op task: a lever either side of the altar, both held at the same moment.
  // Alone you pull one and run — MECH.cwGrace is the window to reach the other,
  // and the chamber is sized so that is a genuine sprint rather than a formality.
  { id: 'lever_cw_a', kind: 'lever', mode: 'hold', x: 592, y: 404,
    z: TIER.mid, r: 54, label: 'HOLD THE WEST LEVER', pair: 'lever_cw_b', beat: 2 },
  { id: 'lever_cw_b', kind: 'lever', mode: 'hold', x: 724, y: 404,
    z: TIER.mid, r: 54, label: 'HOLD THE EAST LEVER', pair: 'lever_cw_a', beat: 2 },

  { id: 'lever_crane', kind: 'lever', mode: 'hold', x: 1012, y: 400,
    z: TIER.mid, r: 58, label: 'HOLD THE CRANE LEVER', beat: 4 },
  // THE FAR LEVER. The crane is a relay with two: whoever crossed holds this
  // one on the tower, and the arm comes back out for the runner left behind.
  // Alone it is simply a second way to work the same arm.
  { id: 'lever_crane_far', kind: 'lever', mode: 'hold', x: 1104, y: 440,
    z: TIER.high, r: 54, label: 'HOLD THE CRANE LEVER', beat: 4 },

  // THE WINCH — the tomb's best argument for a second player.
  // Held, it jams the counted floor: every slab locks solid and the crossing
  // becomes a walk. It sits on the APPROACH side, so whoever works it does not
  // get to use it — they wind while their partner crosses, then run the rhythm
  // themselves. Alone it gives a few seconds and no more.
  { id: 'lever_winch', kind: 'lever', mode: 'hold', x: 802, y: 332,
    z: TIER.mid, r: 54, label: 'WIND THE WINCH', beat: 3 },

  { id: 'brazier_a', kind: 'brazier', x: 880,  y: 580, z: TIER.high, r: 48, label: 'LIGHT THE BRAZIER', slot: 0 },
  { id: 'brazier_b', kind: 'brazier', x: 970,  y: 580, z: TIER.high, r: 48, label: 'LIGHT THE BRAZIER', slot: 1 },
  { id: 'brazier_c', kind: 'brazier', x: 1060, y: 580, z: TIER.high, r: 48, label: 'LIGHT THE BRAZIER', slot: 2 },

  { id: 'relic', kind: 'relic', x: 983, y: 680, z: 6.00, r: 54, label: 'TAKE THE SUN DISC' },
];

// The order the braziers must be lit in. Each glyph reveals one entry, so a
// player who read none has to brute-force six permutations instead.
export const BRAZIER_ORDER = [1, 2, 0];

// -----------------------------------------------------------------------
// CHECKPOINTS, one per beat. Dying returns you to the beat you are in, not to
// a five-second timer at a random spawn: respawn roulette is a deathmatch
// convention and it would undo a puzzle route every time.
// -----------------------------------------------------------------------
export const CHECKPOINTS = [
  { x: 150,  y: 460, z: TIER.ground },   // 0 entrance hall
  { x: 170,  y: 252, z: TIER.ground },   // 1 below the stairs, clear of the 2.5 m gallery lip
  { x: 530,  y: 240, z: TIER.mid },      // 2 mechanism chamber, in the clear west strip
  { x: 812,  y: 370, z: TIER.mid },      // 3 approach, before the tiles
  { x: 1008, y: 370, z: TIER.mid },      // 4 landing, past the tiles
  { x: 1124, y: 340, z: TIER.high },     // 5 tower top
  { x: 1000, y: 760, z: 5.60 },          // 6 sanctum floor, clear of the plinth
];

// Co-op spawns: both runners start side by side in the entrance hall. Beyond
// slot 1 these are guardian posts, placed where beat 3 wakes them.
export const SPAWNS = [
  { x: 136, y: 440 }, { x: 188, y: 450 },
  { x: 600, y: 210 }, { x: 700, y: 440 },
  { x: 640, y: 300 }, { x: 560, y: 400 },
  { x: 900, y: 700 }, { x: 1000, y: 700 },
];

// ---------------------------------------------------------------------------
// FIRE LAMPS. Placed at what the player has to SEE: the foot and head of every
// climb, both sides of the collapsing causeway, the crane gap, each lever, and
// the sanctum ring. `z` is the surface they stand on, `h` their height above it.
// Without these the tomb was lit only by sconces that happened to land on long
// walls, which left the timing beat in the dark.
// ---------------------------------------------------------------------------
export const LAMPS = [
  // entrance hall + the stairs
  { x: 120, y: 250, z: 0,         reach: 20, power: 11 },
  { x: 120, y: 620, z: 0,         reach: 20, power: 11 },
  { x: 300, y: 420, z: 0,         reach: 20, power: 10 },
  { x: 150, y: 170, z: 0,         reach: 16, power: 9  },
  // the gallery, 2.5 m
  { x: 300, y: 100, z: TIER.low,  reach: 16, power: 9  },
  { x: 430, y: 100, z: TIER.low,  reach: 16, power: 9  },
  // the mechanism chamber, 5 m
  { x: 560, y: 190, z: TIER.mid,  reach: 20, power: 11 },
  { x: 750, y: 190, z: TIER.mid,  reach: 20, power: 11 },
  { x: 560, y: 470, z: TIER.mid,  reach: 20, power: 11 },
  { x: 750, y: 470, z: TIER.mid,  reach: 20, power: 11 },
  { x: 660, y: 430, z: TIER.mid,  reach: 14, power: 8, h: 1.1 },   // over the lever
  // the collapsing causeway: BOTH ends, so you can read the rhythm
  { x: 806, y: 336, z: TIER.mid,  reach: 22, power: 13 },
  { x: 806, y: 404, z: TIER.mid,  reach: 22, power: 13 },
  { x: 1014,y: 336, z: TIER.mid,  reach: 22, power: 13 },
  { x: 1014,y: 404, z: TIER.mid,  reach: 22, power: 13 },
  // the tower and the sanctum ring
  { x: 1124,y: 270, z: TIER.high, reach: 18, power: 10 },
  { x: 1124,y: 520, z: TIER.high, reach: 18, power: 10 },
  { x: 836, y: 600, z: TIER.high, reach: 18, power: 10 },
  { x: 836, y: 800, z: TIER.high, reach: 18, power: 10 },
  { x: 1104,y: 800, z: TIER.high, reach: 18, power: 10 },
  // the sanctum floor, under the ring
  { x: 880, y: 760, z: 5.60,      reach: 16, power: 9  },
  // the escape route west
  { x: 775, y: 650, z: TIER.mid,  reach: 18, power: 10 },
  { x: 620, y: 685, z: 4.30,      reach: 18, power: 10 },
  { x: 485, y: 735, z: TIER.low,  reach: 18, power: 10 },
  { x: 345, y: 520, z: TIER.mid,  reach: 18, power: 10 },
];

// ---------------------------------------------------------------------------
// ROOMS.
//
// The tomb is one continuous volume, which means that standing in the entrance
// hall you could see every chamber in the level at once — the whole back side,
// every mechanism, the sanctum. That is not a lighting problem, it is a
// STRUCTURE problem: a tomb is a sequence of rooms you have not been in yet.
//
// A room is discovered the first time a runner stands in it, and until then its
// lamps do not burn and its contents are not drawn. With the ambient pulled
// right down, an undiscovered chamber is simply black — which is both the
// correct read and, incidentally, far fewer draw calls.
//
// `z` bounds matter as much as the footprint: the gallery sits directly above
// part of the hall, and without them walking the hall would light the gallery.
// ---------------------------------------------------------------------------
export const ROOMS = [
  { id: 'hall',     name: 'THE ENTRANCE HALL',  x: 20,   y: 20,  w: 360, h: 860, zMin: -2,  zMax: 2.2 },
  { id: 'gallery',  name: 'THE NORTH GALLERY',  x: 100,  y: 30,  w: 380, h: 190, zMin: 2.0, zMax: 6.2 },
  { id: 'chasm',    name: 'THE CHASM',          x: 355,  y: 190, w: 175, h: 680, zMin: 3.5, zMax: 6.5 },
  { id: 'chamber',  name: 'THE COUNTERWEIGHT',  x: 505,  y: 135, w: 300, h: 400, zMin: 4.0, zMax: 8.5 },
  { id: 'causeway', name: 'THE COUNTED FLOOR',  x: 775,  y: 295, w: 275, h: 150, zMin: 4.0, zMax: 8.5 },
  { id: 'tower',    name: 'THE TOWER',          x: 1040, y: 230, w: 140, h: 350, zMin: 4.0, zMax: 11 },
  { id: 'sanctum',  name: 'THE SANCTUM',        x: 800,  y: 520, w: 340, h: 340, zMin: 4.5, zMax: 11 },
  { id: 'southrun', name: 'THE SOUTH RUIN',     x: 340,  y: 560, w: 520, h: 300, zMin: 1.5, zMax: 6.5 },
];

export function roomAt(x, y, z) {
  for (const r of ROOMS)
    if (x > r.x && x < r.x + r.w && y > r.y && y < r.y + r.h && z >= r.zMin && z <= r.zMax)
      return r;
  return null;
}

// ---------------------------------------------------------------------------
// LAMP ANCHORING.
//
// A lamp given a bare (x,y,z) hangs in mid-air, which is exactly what it looked
// like. A real one is either BRACKETED TO A WALL, facing out of it, or STANDING
// ON THE FLOOR. So every lamp is resolved against the geometry: find the
// nearest wall face that is tall enough to carry a bracket, snap to it and take
// the outward normal for its rotation; if nothing is close enough, stand it on
// whatever surface is underneath instead.
//
// This is exported rather than done inside world.js so tools/tombtest.mjs can
// check the same resolution and fail the build if any lamp still floats.
// ---------------------------------------------------------------------------
export const LAMP_SNAP = 110;        // units: how far a lamp will reach for a wall
// 5 u (0.275 m), not 13 u (0.715 m). The sconce model is 0.451 m deep, so a
// 0.715 m standoff left its BACK FACE floating 0.49 m clear of the wall — the
// bracket pointed at nothing and the lamp read as hanging in mid-air. Half the
// model's depth puts the back on the stone; the extra 0.05 m is the reveal.
// propcheck asserts this against the actual GLB so it cannot drift again.
export const LAMP_STANDOFF = 5;      // units it sits proud of the face
export const LAMP_WALL_H = 2.0;      // m up the wall a bracket is mounted

function surfaceUnder(x, y, z) {
  let h = 0;
  for (const w of WALLS) {
    if (w.top > z + 0.35) continue;                       // above us: not a floor
    if (x > w.x && x < w.x + w.w && y > w.y && y < w.y + w.h && w.top > h) h = w.top;
  }
  return h;
}

// nearest point on a box's outer edge, and the outward normal there
function faceOf(w, x, y) {
  const cx = Math.min(Math.max(x, w.x), w.x + w.w);
  const cy = Math.min(Math.max(y, w.y), w.y + w.h);
  const dl = Math.abs(x - w.x), dr = Math.abs(x - (w.x + w.w));
  const dt = Math.abs(y - w.y), db = Math.abs(y - (w.y + w.h));
  const m = Math.min(dl, dr, dt, db);
  if (m === dl) return { x: w.x,       y: cy, nx: -1, ny: 0 };
  if (m === dr) return { x: w.x + w.w, y: cy, nx: 1,  ny: 0 };
  if (m === dt) return { x: cx, y: w.y,       nx: 0,  ny: -1 };
  return            { x: cx, y: w.y + w.h, nx: 0,  ny: 1 };
}

export function anchorLamps() {
  return LAMPS.map((L, i) => {
    const base = L.z || 0;
    let best = null, bestD = Infinity;
    for (const w of WALLS) {
      if (w.id) continue;                                  // never bracket to a moving part
      if (w.top < base + 1.2) continue;                    // too short to carry a bracket
      if (w.top > base + 9) continue;                      // the shell: a lamp there reads as floating
      const f = faceOf(w, L.x, L.y);
      const d = Math.hypot(L.x - f.x, L.y - f.y);
      if (d > LAMP_SNAP || d >= bestD) continue;
      bestD = d; best = { w, f };
    }
    if (best) {
      const { f, w } = best;
      return {
        i, kind: 'wall',
        x: f.x + f.nx * LAMP_STANDOFF,
        y: f.y + f.ny * LAMP_STANDOFF,
        z: Math.min(base + LAMP_WALL_H, w.top - 0.35),
        ry: Math.atan2(f.nx, f.ny),                        // face out of the wall
        reach: L.reach, power: L.power, host: w.tag, dist: +bestD.toFixed(1),
      };
    }
    return {
      i, kind: 'floor',
      x: L.x, y: L.y, z: surfaceUnder(L.x, L.y, base + 0.5),
      ry: 0, reach: L.reach, power: L.power, host: null, dist: null,
    };
  });
}

// The water line. Beat 7 raises it; every other beat reads it as decoration.
// The flood of beat 7. `flood` is where the water stops, `floodSeconds` how
// long it takes to get there. You drown when the water is more than DROWN_DEPTH
// above your feet for DROWN_GRACE seconds (see mech.js), so the real deadline at
// the front door (z=0) is when the line passes 1.2 m — about 41 s in. The last
// act is therefore a descent INTO the water, which is the point.
export const WATER = { start: -1.2, flood: 3.0, floodSeconds: 75 };

// Kept so world.js and the minimap keep their old shapes. The tomb has no
// extraction circles any more — the exit is the front door.
// The way out, on the hall side of the front door. Not under the spawn:
// at (140, 460) the seal sat under the runner's feet and read as the goal.
export const ZONES = [{ x: 78, y: 455 }];
export const RELICS = [{ x: 983, y: 680, z: 6.00 }];
