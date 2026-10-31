// ---------------------------------------------------------------------------
// The tutorial: field notes that teach one verb at a time, in the chambers
// where that verb is first needed.
//
// It is presentation only. It watches the local runner and the input, never
// writes to the simulation, so it cannot desync co-op and the headless suites
// never see it. Each note waits for its chamber, says what to press on the
// device actually in use, and clears the moment the player has done the thing
// — the test is "did it", never "did you read it".
// ---------------------------------------------------------------------------

// keys[device] -> how to say the input. device: 'kb' | 'pad' | 'touch'
const STEPS = [
  { id: 'look', beat: 0, title: 'Look around',
    keys: { kb: 'Move the <b>mouse</b>. Click the view first to capture it.', pad: 'Use the <b>right stick</b>.', touch: '<b>Drag</b> on the right side of the screen.' },
    done: s => s.lookTotal > 1.4 },
  { id: 'move', beat: 0, title: 'Move',
    keys: { kb: '<kbd>W</kbd><kbd>A</kbd><kbd>S</kbd><kbd>D</kbd> to walk.', pad: '<b>Left stick</b> to walk.', touch: 'Push the <b>left stick</b>.' },
    done: s => s.moved > 3 },
  { id: 'run', beat: 0, title: 'Run',
    keys: { kb: 'Hold <kbd>Shift</kbd> while moving.', pad: 'Hold <b>LB</b> or click <b>L3</b>.', touch: 'Push the stick all the way.' },
    done: s => s.runTime > 0.6 },
  { id: 'jump', beat: 0, title: 'Jump',
    keys: { kb: '<kbd>Space</kbd>. Tap for a hop, hold for the full arc.', pad: '<b>A</b> / <b>Cross</b>. Hold for the full arc.', touch: 'Tap <b>JUMP</b>. Hold for the full arc.' },
    done: s => s.jumped },
  { id: 'goal', beat: 0, title: 'Your objective',
    keys: { kb: 'It sits at the top of the screen. The <b>gold diamond</b> points the way, and the map marks what the chamber wants.',
      pad: 'It sits at the top of the screen. The <b>gold diamond</b> points the way.', touch: 'It sits at the top. The <b>gold diamond</b> points the way.' },
    done: s => s.noteAge > 6 },
  { id: 'grab', beat: 1, title: 'Catch a ledge',
    keys: { kb: 'Jump at a lip and <b>hold</b> <kbd>Space</kbd> to catch it. <kbd>C</kbd> at an edge lowers you into a hang.',
      pad: 'Jump at a lip and <b>hold A</b> to catch it. <b>Y</b> at an edge lowers you.', touch: 'Jump at a lip and <b>hold JUMP</b> to catch it.' },
    done: s => s.hung },
  { id: 'climb', beat: 1, title: 'On the ledge',
    keys: { kb: '<kbd>W</kbd> climbs up · <kbd>A</kbd>/<kbd>D</kbd> shimmy · <kbd>S</kbd> lets go.', pad: '<b>Up</b> climbs · <b>sideways</b> shimmies · <b>down</b> lets go.',
      touch: 'Stick <b>up</b> climbs · <b>sideways</b> shimmies · <b>down</b> lets go.' },
    done: s => s.mantled, needs: s => s.hung },
  { id: 'use', beat: 2, title: 'Work the mechanism',
    keys: { kb: '<b>Hold</b> <kbd>E</kbd> on a lever. Alone, throw one and sprint to the other before the ring empties.',
      pad: '<b>Hold X</b> on a lever. Alone, throw one and sprint to the other.', touch: '<b>Hold USE</b> on a lever. Alone, throw one and run to the other.' },
    done: s => s.usedLever },
  { id: 'fight', beat: 2, title: 'The statues wake',
    keys: { kb: '<b>Click</b> to strike · <kbd>F</kbd> guards · <kbd>Q</kbd> rolls clear.', pad: '<b>RT</b> strikes · <b>LT</b> guards · <b>B</b> rolls clear.',
      touch: '<b>STRIKE</b> · <b>GUARD</b> · <b>ROLL</b> clear.' },
    done: s => s.strikes >= 3 || s.beat >= 3, needs: s => s.guardiansAwake },
  { id: 'floor', beat: 3, title: 'The counted floor',
    keys: { kb: 'The slabs drop in turn. Watch one full pass, then hold <kbd>Shift</kbd> and <b>run</b> it without stopping.',
      pad: 'The slabs drop in turn. Watch one full pass, then <b>run</b> it without stopping.',
      touch: 'The slabs drop in turn. Watch one full pass, then push the stick all the way and <b>run</b>.' },
    coop: 'With a partner: one of you holds the <b>winch</b> and the slabs stay up.',
    done: s => s.crossed },
  { id: 'crane', beat: 4, title: 'The crane',
    keys: { kb: '<b>Hold</b> <kbd>E</kbd> on the lever to swing the arm out, then cross it. Alone it stays out about ten seconds.',
      pad: '<b>Hold X</b> on the lever to swing the arm out, then cross it.', touch: '<b>Hold USE</b> on the lever to swing the arm out, then cross it.' },
    coop: 'With a partner it is a relay: one holds, one crosses, then the far lever brings the arm back.',
    done: s => s.craneHeld },
  { id: 'fires', beat: 5, title: 'Three fires',
    keys: { kb: 'Press <kbd>E</kbd> at a glyph to read it. Light the braziers in the order the glyphs give. A wrong fire only resets the order.',
      pad: 'Press <b>X</b> at a glyph to read it, then light the braziers in that order.', touch: 'Tap <b>USE</b> at a glyph to read it, then light the braziers in that order.' },
    done: s => s.glyphs >= 1 },
  { id: 'flee', beat: 6, title: 'Get out',
    keys: { kb: 'The tomb is flooding. Hold <kbd>Shift</kbd> and run west, back through the crypt to the front door.',
      pad: 'The tomb is flooding. Run west, back through the crypt to the front door.', touch: 'The tomb is flooding. Run west, back to the front door.' },
    done: s => s.fleeRun > 1.5 },
  { id: 'boost', beat: 1, title: 'Boost your partner',
    keys: { kb: '<kbd>C</kbd> to crouch beside a wall. Your partner jumps off your back, a metre higher than alone.',
      pad: '<b>Y</b> to crouch beside a wall. Your partner jumps off your back.', touch: '<b>CROUCH</b> beside a wall. Your partner jumps off your back.' },
    done: s => s.crouchCoop > 0.6, skip: s => !s.coop },
];
// the lessons in the order a run meets them (the boost note is filed with the
// gallery; it is listed last only so it never reorders the solo count)
STEPS.sort((a, b) => a.beat - b.beat);

export function createTutorial() {
  const el = document.createElement('div');
  el.id = 'tut'; el.className = 'off';
  el.setAttribute('role', 'status'); el.setAttribute('aria-live', 'polite');
  el.innerHTML = '<small>FIELD NOTES <em id="tutn"></em></small><b id="tutt"></b><p id="tutk"></p>';
  document.getElementById('hud').appendChild(el);

  let idx = 0, shownId = null, noteAge = 0, clearT = 0, device = 'kb';
  const fresh = () => ({ lookTotal: 0, moved: 0, runTime: 0, jumped: false, hung: false, mantled: false,
    usedLever: false, strikes: 0, beat: 0, guardiansAwake: false, noteAge: 0,
    crossed: false, craneHeld: false, glyphs: 0, fleeRun: 0, coop: false, crouchCoop: 0 });
  const s = fresh();
  let lastX = null, lastY = null;

  const api = {
    reset() {
      idx = 0; shownId = null; noteAge = 0; clearT = 0; lastX = lastY = null;
      Object.assign(s, fresh());
      el.className = 'off';
    },
    get done() { return idx >= STEPS.length; },
    // Called every rendered frame while playing.
    update(dt, { enabled, me, beat, dev, lookDelta, strike, holdingLever, guardiansAwake, S,
                 coop = false, glyphs = 0, crouch = false }) {
      device = dev;
      if (!me) return;
      // ---- observe, whether or not a note is up: a player who already ran
      // before the run note arrives should not be told to run ----
      s.beat = beat; s.guardiansAwake = guardiansAwake;
      s.lookTotal += Math.abs(lookDelta);
      if (lastX != null) s.moved += Math.hypot(me.x - lastX, me.y - lastY) * S;
      lastX = me.x; lastY = me.y;
      if ((me.mps || 0) > 3.6 && me.state === 'ground') s.runTime += dt;
      if (me.state === 'air' && (me.vz || 0) > 0.5) s.jumped = true;
      if (me.state === 'hang') s.hung = true;
      if (me.state === 'mantle') s.mantled = true;
      if (holdingLever) s.usedLever = true;
      if (strike) s.strikes++;
      s.coop = coop; s.glyphs = glyphs;
      if (beat === 3 && me.x > 992 && (me.z || 0) > 4.5) s.crossed = true;   // off the far end of the slabs
      if (beat === 4 && holdingLever) s.craneHeld = true;
      if (beat === 6 && (me.mps || 0) > 3.6) s.fleeRun += dt;
      if (coop && crouch) s.crouchCoop += dt;

      if (!enabled) { el.className = 'off'; return; }
      // skip every note whose lesson is already learned, or whose chamber is behind us
      while (idx < STEPS.length) {
        const st = STEPS[idx];
        const stale = beat > st.beat;          // its chamber is behind us
        if (stale || (st.skip && st.skip(s)) || (shownId !== st.id && st.done(s))) { idx++; continue; }
        break;
      }
      const st = STEPS[idx];
      if (!st || beat < st.beat || (st.needs && !st.needs(s))) { el.className = 'off'; return; }
      if (shownId !== st.id) {
        shownId = st.id; noteAge = 0; clearT = 0;
        const live = STEPS.filter(x => !(x.skip && x.skip(s)));
        document.getElementById('tutn').textContent = `${live.indexOf(st) + 1} / ${live.length}`;
        document.getElementById('tutt').textContent = st.title;
        el.className = '';
      }
      document.getElementById('tutk').innerHTML = (st.keys[device] || st.keys.kb) + (s.coop && st.coop ? `<br><em>${st.coop}</em>` : '');
      noteAge += dt; s.noteAge = noteAge;
      if (clearT > 0) {
        // a beat of acknowledgement before the next note, so the player sees
        // the tick land rather than the card swap under them
        clearT -= dt;
        if (clearT <= 0) { idx++; shownId = null; el.className = 'off'; }
      } else if (st.done(s) && noteAge > 0.8) { clearT = 0.9; el.className = 'ok'; }
    },
  };
  return api;
}
