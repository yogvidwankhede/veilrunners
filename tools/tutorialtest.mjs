// The tutorial is presentation, but a note that never clears is a soft lock on
// the player's attention. This drives tutorial.js against a stub DOM with the
// same signals main.js feeds it, and checks every note clears when its verb is
// performed, and that verbs learned early are never asked for again.
const els = new Map();
const mk = id => { const e = { id, className: '', textContent: '', innerHTML: '', attrs: {},
  setAttribute(k, v) { this.attrs[k] = v; }, appendChild(c) { els.set(c.id, c); } }; els.set(id, e); return e; };
mk('hud');
globalThis.document = {
  createElement: () => { const e = mk('_'); return e; },
  getElementById: id => els.get(id) || mk(id),
};
const { createTutorial } = await import('../src/tutorial.js');
let fails = 0;
const ok = (c, m) => { console.log((c ? '  ok    ' : '  FAIL  ') + m); if (!c) fails++; };

const tut = createTutorial();
const card = () => els.get('tut');
const me = { x: 0, y: 0, z: 0, state: 'ground', mps: 0, vz: 0 };
const base = { enabled: true, me, beat: 0, dev: 'kb', lookDelta: 0, strike: false, holdingLever: false, guardiansAwake: false, S: 0.055 };
const run = (sec, over = {}, each) => { for (let i = 0; i < sec * 60; i++) { each && each(i); tut.update(1 / 60, { ...base, ...over }); } };
const title = () => (card().className === 'off' ? null : els.get('tutt').textContent);

run(0.5);
ok(title() === 'Look around', 'the first note asks the player to look');
run(1, { lookDelta: 0.05 });
run(1.5);
ok(title() === 'Move', 'looking clears it and the move note follows');
run(2, {}, () => { me.x += 1; });
run(1.5);
ok(title() === 'Run', 'walking clears move');
me.mps = 4.5; run(1.2); me.mps = 0; run(1.5);
ok(title() === 'Jump', 'running clears run');
me.state = 'air'; me.vz = 3; run(0.2); me.state = 'ground'; me.vz = 0; run(1.5);
ok(title() === 'Your objective', 'a jump clears jump');
run(8);
ok(title() === null, 'with the opening lessons learned, nothing nags in the first chamber');
run(0.5, { beat: 1 });
ok(title() === 'Catch a ledge', 'the climb lesson waits for the gallery');
me.state = 'hang'; run(1.5, { beat: 1 }); 
ok(title() === 'On the ledge', 'a catch moves on to the ledge controls');
me.state = 'mantle'; run(1.5, { beat: 1 }); me.state = 'ground';
run(1, { beat: 2 });
ok(title() === 'Work the mechanism', 'the lever lesson waits for the counterweight');
run(1.5, { beat: 2, holdingLever: true });
run(0.5, { beat: 2 });
ok(title() === null, 'the combat note waits for the statues to wake');
run(0.5, { beat: 2, guardiansAwake: true });
ok(title() === 'The statues wake', 'waking statues bring the combat note');
run(1, { beat: 3, guardiansAwake: true });
ok(title() === 'The counted floor', 'the counted floor gets its own note');
me.x = 1000; me.z = 5; run(1.5, { beat: 3 });
run(1, { beat: 4 });
ok(title() === 'The crane', 'crossing the slabs clears it; the crane note follows');
run(1.5, { beat: 4, holdingLever: true }); run(0.5, { beat: 5 });
ok(title() === 'Three fires', 'holding the crane lever clears it; the fires note follows');
run(1.5, { beat: 5, glyphs: 1 }); run(0.5, { beat: 6 });
ok(title() === 'Get out', 'reading a glyph clears it; the escape note follows');
me.mps = 5; run(2.5, { beat: 6 }); me.mps = 0; run(1, { beat: 6 });
ok(tut.done, 'running for the door retires the last note');

// co-op: the boost lesson appears in the gallery, and only with a partner
const tc = createTutorial();
const mc = { x: 0, y: 0, z: 0, state: 'ground', mps: 0, vz: 0 };
for (let i = 0; i < 60; i++) tc.update(1 / 60, { ...base, me: mc, beat: 1, coop: true });
mc.state = 'hang'; for (let i = 0; i < 90; i++) tc.update(1 / 60, { ...base, me: mc, beat: 1, coop: true });
mc.state = 'mantle'; for (let i = 0; i < 90; i++) tc.update(1 / 60, { ...base, me: mc, beat: 1, coop: true });
mc.state = 'ground'; for (let i = 0; i < 60; i++) tc.update(1 / 60, { ...base, me: mc, beat: 1, coop: true });
ok(title() === 'Boost your partner', 'with a partner, the gallery teaches the boost');
for (let i = 0; i < 90; i++) tc.update(1 / 60, { ...base, me: mc, beat: 1, coop: true, crouch: true });
for (let i = 0; i < 30; i++) tc.update(1 / 60, { ...base, me: mc, beat: 1, coop: true });
ok(title() === null, 'crouching for the partner clears it');

// a player who already climbed before the note arrives is not taught to climb
const t2 = createTutorial();
for (let i = 0; i < 60; i++) t2.update(1 / 60, { ...base, beat: 3, me: { ...me, x: 0, z: 0, mps: 0, state: 'ground' } });
ok(els.get('tutt').textContent === 'The counted floor', 'arriving late skips every stale lesson to the one for this chamber');

// turned off in settings, it shows nothing but still learns
const t3 = createTutorial();
t3.update(1 / 60, { ...base, enabled: false });
ok(els.get('tut').className === 'off', 'disabled guidance shows no card');
console.log(fails ? `FAILED — ${fails}` : 'PASSED — every note clears on its verb');
process.exit(fails ? 1 : 0);
