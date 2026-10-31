import { INTERACTABLES, BRAZIER_ORDER } from './level.js';

// ---------------------------------------------------------------------------
// INTERACTABLES — glyphs, levers, braziers, the relic.
//
// One rule decides everything here: a 'pull' lever fires once on the press, a
// 'hold' lever only counts while a body is standing on it RIGHT NOW. That
// single distinction is what makes the tomb work for one player and for two
// without a second code path — mech.js turns a held count into a crane arm,
// and the solo grace window stands in for the partner who is not there.
// ---------------------------------------------------------------------------

const near = (p, it) =>
  Math.hypot(p.x - it.x, p.y - it.y) < it.r && Math.abs((p.z || 0) - it.z) < 1.9;

export function createInteract(game, mech, captions) {
  const items = INTERACTABLES.map(d => ({ ...d, used: false, lit: false }));
  const byId = Object.fromEntries(items.map(i => [i.id, i]));

  const st = {
    read: [false, false, false],   // which glyphs have been read
    order: [],                     // braziers lit so far, in order
    solved: false,
    failures: 0,
    relicTaken: false,
  };

  const GLYPH_LINE = [
    'The second fire wakes the sun.',
    'Then the third, at the tomb’s right hand.',
    'The first fire is lit last, or the sun drowns.',
  ];

  // What this body could use right now, and whether it is allowed to.
  function usable(it) {
    if (it.kind === 'relic') return st.solved && !st.relicTaken;
    if (it.kind === 'brazier') return !it.lit && !st.solved;
    if (it.kind === 'glyph') return !it.used;
    if (it.kind === 'lever' && it.mode === 'pull') return !it.used;
    return true;                                    // a hold lever is always usable
  }

  const api = {
    st, items, byId,

    // The item this body is standing at, for the HUD prompt.
    near(p) {
      let best = null, bestD = Infinity;
      for (const it of items) {
        if (!near(p, it)) continue;
        const d = Math.hypot(p.x - it.x, p.y - it.y);
        if (d < bestD) { bestD = d; best = it; }
      }
      return best;
    },

    // `pressing` is the interact button held this tick. Returns a hint string
    // when something happened, so the caller can surface it.
    step(dt, p, pressing) {
      // EDGE, not held. Every press verb fires on the frame the button goes
      // down, because holding it while walking is a completely normal thing to
      // do and continuous firing makes it catastrophic: crossing the sanctum
      // ring with the button down lit the braziers in the order you happened to
      // pass them, resetting the puzzle over and over. A hold lever is the one
      // thing that genuinely wants the continuous signal.
      const edge = pressing && !p._usePressed;
      p._usePressed = pressing;

      const it = api.near(p);
      if (!it || !pressing) return null;

      if (it.kind === 'lever' && it.mode === 'hold') {
        if (it.id === 'lever_crane' || it.id === 'lever_crane_far') mech.craneHold++;
        mech.holds.add(it.id);        // mech decides what a given lever gates
        it.held = true;
        return null;
      }
      if (!edge || !usable(it)) return null;

      if (it.kind === 'glyph') {
        it.used = true; st.read[it.reveals] = true;
        captions.say('GLYPH', GLYPH_LINE[it.reveals]);
        game.event(`${p.name} read a glyph (${st.read.filter(Boolean).length}/3)`);
        return 'glyph';
      }

      if (it.kind === 'lever' && it.mode === 'pull') {
        it.used = true;
        if (it.id === 'lever_counterweight') {
          mech.releaseBridge();
          captions.say('ARIA', 'Counterweight’s going. Bridge is coming down.');
          game.event('the counterweight falls — the bridge is down');
        }
        return 'lever';
      }

      if (it.kind === 'brazier') {
        it.lit = true; st.order.push(it.slot);
        const i = st.order.length - 1;
        if (st.order[i] !== BRAZIER_ORDER[i]) {
          // Wrong order: snuff everything and let them try again. A tomb puzzle
          // that kills you for guessing teaches nothing except to stop guessing.
          st.failures++; st.order = [];
          for (const b of items) if (b.kind === 'brazier') b.lit = false;
          captions.say('ARIA', 'Wrong one. They all went out.');
          game.event('the braziers gutter and die');
          return 'wrong';
        }
        if (st.order.length === BRAZIER_ORDER.length) {
          st.solved = true; mech.openSeal();
          captions.say('ARIA', 'That’s it. The seal is sinking.');
          game.event('the seal over the plinth sinks away');
          return 'solved';
        }
        captions.say('ARIA', `${st.order.length} of 3.`);
        return 'lit';
      }

      if (it.kind === 'relic') {
        st.relicTaken = true; it.used = true;
        return 'relic';
      }
      return null;
    },

    // Called once per tick BEFORE step, so `held` reflects only this tick.
    beginTick() { for (const it of items) it.held = false; },

    reset() {
      for (const it of items) { it.used = false; it.lit = false; it.held = false; }
      for (const q of game.players || []) q._usePressed = false;
      st.read = [false, false, false]; st.order = [];
      st.solved = false; st.failures = 0; st.relicTaken = false;
    },

    // netcode: the guest needs the same lit braziers and the same read glyphs
    pack: () => [
      st.read.map(Number).join(''), st.order.join(''),
      st.solved ? 1 : 0, st.relicTaken ? 1 : 0, st.failures,
      items.filter(i => i.used).map(i => i.id).join(','),
    ],
    apply(a) {
      if (!a) return;
      const [read, order, solved, taken, failures, used] = a;
      st.read = String(read).padEnd(3, '0').split('').map(c => c === '1');
      st.order = String(order).split('').filter(Boolean).map(Number);
      st.solved = !!solved; st.relicTaken = !!taken; st.failures = failures;
      const u = new Set(String(used).split(',').filter(Boolean));
      for (const it of items) {
        it.used = u.has(it.id);
        if (it.kind === 'brazier') it.lit = st.order.includes(it.slot);
      }
    },
  };
  return api;
}
