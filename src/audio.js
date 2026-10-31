// ---------------------------------------------------------------------------
// AUDIO — synthesised, not sampled.
//
// The tomb had no sound at all, which matters most in beat 4: a rhythm puzzle
// you can only see is a far harder puzzle than the one that was designed, since
// half the information a player would normally use is missing.
//
// Everything here is generated with WebAudio primitives — filtered noise bursts,
// detuned oscillators, envelopes. No files, so nothing to download, nothing to
// licence, and the whole layer costs about 7 KB in the bundle instead of several
// megabytes of samples.
//
// The context starts SUSPENDED. Browsers refuse to play audio before a gesture,
// so it is resumed on the ENTER THE TOMB click and never before.
// ---------------------------------------------------------------------------

export function createAudio() {
  const AC = typeof window !== 'undefined' && (window.AudioContext || window.webkitAudioContext);
  if (!AC) return nullAudio();

  let ctx = null, master = null, noiseBuf = null, level = 1;
  const A = { enabled: true, ready: false };

  function init() {
    if (ctx) return;
    ctx = new AC();
    master = ctx.createGain(); master.gain.value = 0.55 * level;
    // A compressor keeps a torch crackle audible under a stone slab without the
    // slab clipping: the dynamic range of a tomb is wider than a browser's.
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -18; comp.knee.value = 24; comp.ratio.value = 6;
    comp.attack.value = 0.004; comp.release.value = 0.22;
    master.connect(comp); comp.connect(ctx.destination);

    // one second of white noise, reused by every noise-based voice
    noiseBuf = ctx.createBuffer(1, 44100, 44100);
    const d = noiseBuf.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    A.ready = true;
    startBeds();
  }

  A.resume = () => { init(); if (ctx && ctx.state === 'suspended') ctx.resume(); };
  // Master level from the settings slider, 0..1, under the mute toggle.
  const apply = () => { if (master) master.gain.value = A.enabled ? 0.55 * level : 0; };
  A.setVolume = v => { level = Math.max(0, Math.min(1, v)); apply(); };
  A.setEnabled = v => { A.enabled = v; apply(); };
  // Pausing suspends the context so a held torch bed does not drone on a menu.
  A.suspend = () => { if (ctx && ctx.state === 'running') ctx.suspend(); };
  A.toggle = () => { A.setEnabled(!A.enabled); return A.enabled; };

  const now = () => ctx.currentTime;
  const live = () => A.enabled && ctx && A.ready;

  // ---- voices -------------------------------------------------------------

  // a filtered burst of noise: footsteps, impacts, grit
  function burst({ dur = 0.12, freq = 800, q = 1, gain = 0.3, type = 'bandpass', decay = 1 }) {
    const src = ctx.createBufferSource(); src.buffer = noiseBuf;
    src.loop = true; src.playbackRate.value = 0.7 + Math.random() * 0.6;
    const f = ctx.createBiquadFilter(); f.type = type; f.frequency.value = freq; f.Q.value = q;
    const g = ctx.createGain();
    const t = now();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(gain, t + Math.min(0.012, dur * 0.2));
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur * decay);
    src.connect(f); f.connect(g); g.connect(master);
    src.start(t); src.stop(t + dur * decay + 0.02);
  }

  // a pitched body: stone, bells, the disc
  function tone({ f0 = 110, f1 = f0, dur = 0.4, gain = 0.22, type = 'sine', detune = 0 }) {
    const o = ctx.createOscillator(); o.type = type;
    const g = ctx.createGain();
    const t = now();
    o.frequency.setValueAtTime(f0, t);
    if (f1 !== f0) o.frequency.exponentialRampToValueAtTime(Math.max(20, f1), t + dur);
    o.detune.value = detune;
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(gain, t + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g); g.connect(master);
    o.start(t); o.stop(t + dur + 0.02);
  }

  // ---- impact voices ------------------------------------------------------
  // A descending pitch sweep on a square or sawtooth IS the 1980s arcade "you
  // died" sound, and no amount of mixing rescues it — the trope is the melody,
  // not the timbre. Real impact audio has no pitch in it: a broadband transient
  // for the contact, a lowpassed body for the mass, and a tail. Built from
  // those three instead.

  // the crack of contact: very short, very bright, no pitch
  function click({ dur = 0.028, freq = 3800, gain = 0.22 }) {
    burst({ dur, freq, q: 0.6, gain, type: 'highpass', decay: 1 });
  }
  // the body of a blow: lowpassed noise, which has mass and no note
  function thud({ dur = 0.22, freq = 190, gain = 0.3, decay = 1.3 }) {
    burst({ dur, freq, q: 0.9, gain, type: 'lowpass', decay });
  }
  // weight underneath it. A sine at a FIXED low pitch: felt, not heard as a note.
  function sub({ f = 46, dur = 0.5, gain = 0.18 }) {
    const o = ctx.createOscillator(); o.type = 'sine'; o.frequency.value = f;
    const g = ctx.createGain(); const t = now();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(gain, t + 0.015);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g); g.connect(master); o.start(t); o.stop(t + dur + 0.02);
  }
  // stone dragging on stone: a filter sweep, never an oscillator sweep
  function scrape({ dur = 0.5, from = 900, to = 240, gain = 0.2 }) {
    const src = ctx.createBufferSource(); src.buffer = noiseBuf; src.loop = true;
    const f = ctx.createBiquadFilter(); f.type = 'bandpass'; f.Q.value = 1.4;
    const g = ctx.createGain(); const t = now();
    f.frequency.setValueAtTime(from, t);
    f.frequency.exponentialRampToValueAtTime(to, t + dur);
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(gain, t + 0.03);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    src.connect(f); f.connect(g); g.connect(master);
    src.start(t); src.stop(t + dur + 0.02);
  }

  // ---- continuous beds ----------------------------------------------------
  let droneGain = null, waterGain = null, torchGain = null;
  function startBeds() {
    // a low room tone: two detuned saws through a steep lowpass
    droneGain = ctx.createGain(); droneGain.gain.value = 0.05; droneGain.connect(master);
    const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 180; lp.Q.value = 0.7;
    lp.connect(droneGain);
    for (const [f, d] of [[41.2, -6], [41.2, 7], [61.7, 3]]) {
      const o = ctx.createOscillator(); o.type = 'sawtooth';
      o.frequency.value = f; o.detune.value = d;
      const g = ctx.createGain(); g.gain.value = 0.3;
      o.connect(g); g.connect(lp); o.start();
    }
    // torch bed: looping noise through a resonant band, amplitude wobbling
    torchGain = ctx.createGain(); torchGain.gain.value = 0.0; torchGain.connect(master);
    const ts = ctx.createBufferSource(); ts.buffer = noiseBuf; ts.loop = true;
    const tf = ctx.createBiquadFilter(); tf.type = 'bandpass'; tf.frequency.value = 1150; tf.Q.value = 0.8;
    ts.connect(tf); tf.connect(torchGain); ts.start();
    // water bed, silent until the flood
    waterGain = ctx.createGain(); waterGain.gain.value = 0; waterGain.connect(master);
    const ws = ctx.createBufferSource(); ws.buffer = noiseBuf; ws.loop = true;
    const wf = ctx.createBiquadFilter(); wf.type = 'lowpass'; wf.frequency.value = 420; wf.Q.value = 0.5;
    ws.connect(wf); wf.connect(waterGain); ws.start();
  }

  // ---- one-shots ----------------------------------------------------------
  A.footstep = (speed = 1, crouch = false) => { if (!live()) return;
    burst({ dur: 0.075, freq: 240 + Math.random() * 180, q: 1.1,
            gain: (crouch ? 0.05 : 0.13) * (0.55 + speed * 0.5), decay: 1.4 });
    burst({ dur: 0.05, freq: 2400 + Math.random() * 1400, q: 0.8,
            gain: (crouch ? 0.012 : 0.035) * (0.5 + speed * 0.5) });
  };
  A.land = (k = 1) => { if (!live()) return;
    thud({ dur: 0.20, freq: 140, gain: 0.10 + k * 0.28, decay: 1.6 });
    if (k > 0.15) sub({ f: 44, dur: 0.28, gain: 0.05 + k * 0.14 });
  };
  A.jump = () => { if (!live()) return; burst({ dur: 0.06, freq: 520, q: 1.4, gain: 0.07 }); };
  A.grab = () => { if (!live()) return; burst({ dur: 0.1, freq: 900, q: 1.6, gain: 0.11, decay: 1.2 }); };
  A.hit = (kill = false) => { if (!live()) return;
    // the whack: a short noise crack on the contact frame, then the body of it
    click({ dur: 0.012, freq: 2400, gain: kill ? 0.34 : 0.30 });
    click({ dur: 0.016, freq: 6400, gain: 0.12 });
    thud({ dur: kill ? 0.28 : 0.16, freq: kill ? 160 : 220, gain: kill ? 0.32 : 0.24 });
    if (kill) sub({ f: 42, dur: 0.5, gain: 0.16 });
  };
  // Metal on metal genuinely IS tonal, so this one keeps a pitch — but a ring
  // that decays, not a slide. A parry should be the brightest thing in a fight.
  A.parry = () => { if (!live()) return;
    click({ dur: 0.02, freq: 6000, gain: 0.2 });
    tone({ f0: 2100, dur: 0.42, gain: 0.13, type: 'triangle' });
    tone({ f0: 3150, dur: 0.30, gain: 0.07, type: 'sine', detune: 9 }); };
  // The long grind of a mechanism moving. The weight is a FIXED sub, not a
  // sawtooth sliding downward — a slide turns a counterweight into a cartoon
  // falling off a cliff.
  A.stone = (len = 1.2, gain = 0.26) => { if (!live()) return;
    scrape({ dur: len, from: 520, to: 150, gain: gain * 0.9 });
    burst({ dur: len, freq: 90, q: 0.8, gain: gain * 0.8, type: 'lowpass', decay: 1 });
    sub({ f: 50, dur: len, gain: gain * 0.45 }); };
  // A slab dropping away: a short scrape as it releases, then the hollow of
  // the gap. This one has to CUT, because it is the rhythm of beat 4.
  A.tile = () => { if (!live()) return;
    click({ dur: 0.022, freq: 2600, gain: 0.14 });
    thud({ dur: 0.30, freq: 125, gain: 0.32, decay: 1.4 });
    sub({ f: 44, dur: 0.38, gain: 0.16 }); };
  // Bronze seizing in stone: a mechanical clunk, not a blip.
  A.lever = () => { if (!live()) return;
    click({ dur: 0.02, freq: 2900, gain: 0.12 });
    scrape({ dur: 0.22, from: 1100, to: 420, gain: 0.16 });
    thud({ dur: 0.2, freq: 200, gain: 0.2 }); };
  // Catching light: a rush of air, no note. The rising sine underneath it read
  // as a power-up pickup, which is the same mistake in the other direction.
  A.fire = () => { if (!live()) return;
    burst({ dur: 0.6, freq: 900, q: 0.4, gain: 0.26, decay: 1.25 });
    burst({ dur: 0.35, freq: 2600, q: 0.5, gain: 0.10 }); };
  // The braziers going out is stone resetting, not a buzzer. Same reasoning as
  // the death sound: the descending sawtooth was the cartoon, not the mix.
  A.wrong = () => { if (!live()) return;
    scrape({ dur: 0.75, from: 700, to: 170, gain: 0.22 });
    thud({ dur: 0.4, freq: 130, gain: 0.2, decay: 1.5 }); };
  A.relic = () => { if (!live()) return;
    [523.25, 659.25, 783.99, 1046.5].forEach((f, i) =>
      setTimeout(() => live() && tone({ f0: f, dur: 1.1, gain: 0.12, type: 'sine' }), i * 95)); };
  A.beat = () => { if (!live()) return;
    tone({ f0: 196, dur: 1.4, gain: 0.1, type: 'sine' });
    tone({ f0: 294, dur: 1.2, gain: 0.07, type: 'sine', detune: 4 }); };
  // Dying: an impact, then the room swallowing it. No melody, no glide — the
  // old descending sawtooth was a coin-op death jingle and nothing else.
  A.death = () => { if (!live()) return;
    thud({ dur: 0.45, freq: 120, gain: 0.40, decay: 1.5 });
    sub({ f: 38, dur: 1.5, gain: 0.24 });
    // the long dark tail: the sound leaving down a stone shaft
    burst({ dur: 1.8, freq: 320, q: 0.3, gain: 0.16, type: 'lowpass', decay: 1 }); };
  A.win = () => { if (!live()) return;
    [392, 523.25, 659.25, 783.99].forEach((f, i) =>
      setTimeout(() => live() && tone({ f0: f, dur: 1.6, gain: 0.13, type: 'triangle' }), i * 160)); };

  // ---- per-frame: the beds follow the world -------------------------------
  A.update = (dt, { nearestFire = 99, submersion = 0, flooding = false } = {}) => {
    if (!live()) return;
    const t = now();
    if (torchGain) {
      // crackle rises as you approach a fire, with a slow flutter on top
      const close = Math.max(0, 1 - nearestFire / 9);
      const flut = 0.82 + Math.sin(t * 7.3) * 0.1 + Math.sin(t * 17.7) * 0.06;
      torchGain.gain.setTargetAtTime(0.085 * close * close * flut, t, 0.12);
    }
    if (waterGain) {
      const w = flooding ? 0.1 + Math.min(1, submersion / 1.5) * 0.3 : 0;
      waterGain.gain.setTargetAtTime(w, t, 0.4);
    }
    if (droneGain) droneGain.gain.setTargetAtTime(flooding ? 0.09 : 0.05, t, 1.0);
  };

  return A;
}

function nullAudio() {
  const noop = () => {};
  return { enabled: false, ready: false, resume: noop, setEnabled: noop,
    toggle: () => false, update: noop, setVolume: noop, suspend: noop, footstep: noop, land: noop, jump: noop,
    grab: noop, hit: noop, parry: noop, stone: noop, tile: noop, lever: noop,
    fire: noop, wrong: noop, relic: noop, beat: noop, death: noop, win: noop };
}
