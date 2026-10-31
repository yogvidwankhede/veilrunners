import { CHECKPOINTS } from './level.js';
import { MECH } from './mech.js';

// ---------------------------------------------------------------------------
// THE STORY — seven beats, start to finish, authored as data.
//
// The structure follows the reference run beat for beat: entrance, platforming,
// the mechanism, the rhythm gauntlet, the lever-and-crane puzzle, the final
// puzzle, out. Each beat owns three things and nothing else:
//
//   enter(c)  one-off effects: lines, waking guardians, starting the flood
//   done(c)   the single condition that ends it
//   objective the sentence on the HUD while it runs
//
// Keeping the condition as a predicate over world state — rather than a flag
// some other system sets — means a beat cannot be skipped by a bug elsewhere,
// and a co-op guest arrives at the same beat as the host because it is looking
// at the same world.
//
// `c` is the context built by game.js: { game, mech, interact, say, any, me }.
// ---------------------------------------------------------------------------

// any living runner satisfying a test — co-op means EITHER player can trip a beat
const onFloor = (c, z) => c.any(p => (p.z || 0) >= z - 0.15);

// The pitch, shown on the menu so the goal is stated before the first step.
export const BRIEF = {
  title: 'THE CRADLE OF SILT',
  goal: 'Recover the Sun Disc of Ixchel and get back out alive.',
  lines: [
    'Four hundred years ago this tomb was sealed with the disc inside, and the',
    'masons who sealed it built the mechanism that is supposed to drown anyone',
    'who comes for it. Eleven years ago an expedition went in. Nothing came out.',
    'You are the twelfth attempt. Their rope is still hanging in the shaft.',
  ],
};

export const BEATS = [
  {
    key: 'entrance',
    title: 'I · THE DOOR THAT WAS SHUT',
    objective: 'Find a way deeper into the tomb',
    enter: c => {
      c.say('ARIA', 'Four hundred years sealed, and someone already broke the lock.');
      c.say('KESTREL', 'Eleven years ago. They never came back out of it either.');
      c.say('ARIA', 'Then we do this properly. Disc first, then the door, then home.');
      c.say('KESTREL', 'Front door is jammed solid. We go up and over.');
      c.say('ARIA', 'Read anything carved on the way. In here it is never decoration.');
    },
    done: c => onFloor(c, 2.5),
  },

  {
    key: 'ascent',
    title: 'II · THE NORTH GALLERY',
    objective: 'Climb to the mechanism floor',
    enter: c => {
      c.say('KESTREL', 'Stairs give out past the landing. Hands from here.');
      c.say('ARIA', 'Hold jump at a lip and you will catch it. Crouch at an edge to lower yourself.');
      c.say('KESTREL', 'There is rope on the wall up there. Theirs. Still knotted.');
    },
    done: c => c.any(p => (p.z || 0) >= 4.85 && p.x > 460),
  },

  {
    key: 'mechanism',
    title: 'III · THE COUNTERWEIGHT',
    objective: 'Work both levers at once, and survive what it wakes',
    enter: c => {
      c.say('ARIA', 'A drum, and a rope thick as my arm. Two levers, one either side.');
      c.say('KESTREL', 'It will not shift for one of us. Take the east, I have the west.');
      c.say('ARIA', `Alone? Throw one and run. You get about ${Math.round(MECH.cwGrace)} seconds before it sets again.`);
      c.say('KESTREL', 'Aria. The statues. They are not statues.');
    },
    done: c => c.mech.bridge >= 1 && !c.guardiansAlive(),
  },

  {
    key: 'gauntlet',
    title: 'IV · THE COUNTED FLOOR',
    objective: 'Cross the causeway on the rhythm',
    enter: c => {
      c.say('KESTREL', 'The floor is breathing.');
      c.say('ARIA', 'Three slabs, and they go in turn. Watch one full pass first.');
      c.say('ARIA', 'And RUN it — hold shift. At a walk the floor gets ahead of you.');
      c.say('KESTREL', 'There is a winch on this side. Wind it and the slabs lock.');
      c.say('ARIA', 'One of us winds, the other walks. Then we swap and you run it.');
    },
    done: c => c.any(p => p.x >= 992 && (p.z || 0) >= 4.85),
  },

  {
    key: 'crane',
    title: 'V · THE CRANE',
    objective: 'Hold the lever and get across the gap',
    enter: c => {
      c.say('ARIA', 'Lever here, gap there. Someone has to stay on it.');
      c.say('KESTREL', `Alone you get about ${Math.round(MECH.soloGrace)} seconds after you let go. Together, as long as you like.`);
      c.say('ARIA', 'This is where the eleventh expedition stopped. Mind the bones.');
    },
    done: c => c.any(p => (p.z || 0) >= 7.35 && p.x >= 1090),
  },

  {
    key: 'sanctum',
    title: 'VI · THREE FIRES',
    objective: 'Light the braziers in the order the glyphs give',
    enter: c => {
      c.say('KESTREL', 'Three braziers. And a slab over whatever we came for.');
      c.say('ARIA', c.interact.st.read.every(Boolean)
        ? 'Second, third, first. We have the whole verse.'
        : 'We did not read every glyph. We can still guess — a wrong one only resets it.');
      c.say('KESTREL', 'Guess carefully. The verse also says what happens when the seal lifts.');
    },
    done: c => c.interact.st.solved,
  },

  {
    key: 'escape',
    title: 'VII · THE TOMB CLOSES',
    objective: 'Take the sun disc and get out through the front door',
    enter: c => {
      c.say('ARIA', 'Take it. Take it and run.');
      c.say('KESTREL', 'That is water. That is a lot of water.');
      c.say('ARIA', 'This is the part they built it for. The disc leaves, the tomb fills.');
      c.say('KESTREL', 'The front door will have shifted. Go down, go west, do not stop.');
      c.say('ARIA', 'Eleven expeditions. We are not making it twelve.');
      c.mech.startFlood();
    },
    // Everyone out. Alone that is you; with a partner it is BOTH of you, so the
    // escape ends together at the door rather than with one runner leaving the
    // other in the water.
    done: c => (c.all || c.any)(p => p.x <= 120 && p.y > 340 && p.y < 580),
  },
];

export function createStory(game, ctx) {
  const s = {
    beat: 0,
    entered: -1,
    startedAt: 0,
    deaths: 0,
    finishedAt: 0,
    // Beat 7 only begins once the relic is actually in hand, so the flood
    // cannot start because somebody wandered into a trigger volume.
    gateRelic: true,
  };

  s.current = () => BEATS[Math.min(s.beat, BEATS.length - 1)];

  s.reset = () => { s.beat = 0; s.entered = -1; s.startedAt = game.t; s.deaths = 0; s.finishedAt = 0; };

  s.checkpoint = () => CHECKPOINTS[Math.min(s.beat, CHECKPOINTS.length - 1)];

  s.step = () => {
    // fire enter() exactly once per beat
    if (s.entered !== s.beat) {
      s.entered = s.beat;
      const b = BEATS[s.beat];
      if (b && b.enter) b.enter(ctx);
    }
    const b = BEATS[s.beat];
    if (!b) return false;

    // The sanctum beat hands over only when the relic has been picked up —
    // solving the puzzle opens the seal, taking the disc starts the flood.
    if (b.key === 'sanctum' && b.done(ctx)) {
      if (!ctx.interact.st.relicTaken) return false;
      s.beat++; return true;
    }
    if (b.done(ctx)) {
      if (s.beat === BEATS.length - 1) { s.finishedAt = game.t; return 'complete'; }
      s.beat++; return true;
    }
    return false;
  };

  return s;
}
