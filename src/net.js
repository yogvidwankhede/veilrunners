// ---------------------------------------------------------------------------
// Two-player co-op. Host-authoritative with local prediction.
//
// Why this model: co-op PvE has no cheating incentive, no hitscan to lag-
// compensate, and tolerates latency far better than a competitive mode. So one
// player's browser owns the simulation and the other sends input — the game
// rules stay in game.js and are never duplicated server-side. The relay in
// serve.mjs forwards bytes and simulates nothing.
//
// Both ends run the same fixed-step sim (see constants.TICK). The guest predicts
// locally so its own movement is instant, then every snapshot reconciles: remote
// entities snap to authority, the local player eases toward it unless the error
// is large enough that easing would look like rubber-banding.
// ---------------------------------------------------------------------------

export const SNAPSHOT_HZ = 20;
const HARD_SNAP = 2.5;        // game units of error past which we stop easing and cut
const EASE = 0.25;            // per-snapshot correction applied to the local player

export function createNet({ game, url, room, onStatus }) {
  const net = {
    connected: false, isHost: false, peers: 1, slot: 0,
    latencyMs: 0, lastSnapshot: 0, ws: null,
    remoteInput: null,          // host: newest input from the guest
    pending: null,              // guest: newest snapshot awaiting apply
    localName: '',
  };

  const ws = new WebSocket(`${url}?room=${encodeURIComponent(room)}`);
  net.ws = ws;
  const say = m => onStatus && onStatus(m);

  ws.onopen = () => { net.connected = true; say('connected'); };
  // A dropped socket must never freeze a run. The host already owns the world
  // and just hands the partner's body back to the tomb; a guest takes the
  // world over from the last snapshot and plays on alone.
  const dropped = msg => {
    const was = net.connected; net.connected = false; say(msg);
    if (!was || net.full) return;
    if (net.isHost || game.localId !== 1) { if (net.peers >= 2) returnSlot(game, 1); net.peers = 1; return; }
    net.isHost = true; net.peers = 1; net.pending = null;
    game.authority = true;
    const hostBody = game.players[0];
    if (hostBody) { hostBody.remote = false; hostBody.isBot = true; hostBody.ally = true; hostBody.dormant = true; }
  };
  ws.onclose = () => dropped(net.full ? 'room is full — two runners already' : 'connection lost — playing on alone');
  ws.onerror = () => { if (!net.connected) say('could not reach the co-op server'); };

  ws.onmessage = ev => {
    let m; try { m = JSON.parse(ev.data); } catch { return; }
    switch (m.t) {
      case 'hello':
        net.isHost = m.host; net.peers = m.peers;
        net.slot = m.host ? 0 : 1;
        if (m.host) { game.authority = true; game.localId = 0; }
        else if (game.phase === 'playing') net.attach();
        say(m.host ? 'hosting — waiting for a partner' : 'joined as partner');
        break;
      case 'join':
        net.peers++; say('partner joined');
        if (net.isHost) handoffSlot(game, 1);        // bot 1 becomes the guest
        break;
      case 'leave':
        net.peers = Math.max(1, net.peers - 1); say('partner left');
        if (net.isHost) returnSlot(game, 1);         // give it back to the AI
        break;
      case 'promote':
        // The host left. We keep the body we were already playing (slot 1)
        // and take over the simulation. The departed host becomes a statue.
        net.isHost = true;
        game.authority = true;
        { const hostBody = game.players[0];
          if (hostBody) { hostBody.remote = false; hostBody.isBot = true; hostBody.ally = true; hostBody.dormant = true; } }
        say('partner left — you are host');
        break;
      case 'full':                                   // the relay refused a third runner
        net.full = true; game.authority = true; game.localId = 0;
        break;
      case 'i':                                      // guest input -> host
        // Never trust the wire with the shape of an input: a hand-made packet
        // with mx: 50 would be a speed hack on the host's simulation.
        if (net.isHost) { net.remoteInput = cleanInput(m); net.latencyMs = Math.max(0, Date.now() - (+m.ts || Date.now())); }
        break;
      case 's':                                      // snapshot -> guest
        if (!net.isHost) { net.pending = m; net.lastSnapshot = performance.now(); }
        break;
    }
  };

  // ---- host: pack the authoritative state ----
  net.snapshot = () => {
    const p = game.players.map(x => [
      x.id, +x.x.toFixed(1), +x.y.toFixed(1), +x.z.toFixed(2), +x.angle.toFixed(2),
      x.state, x.hp, x.score, +(x.gait || 0).toFixed(2), x.crouch ? 1 : 0, x.deadUntil ? 1 : 0,
      x.name || '',
    ]);
    const r = game.relics.map(x => [x.id, +x.x.toFixed(1), +x.y.toFixed(1), +(x.z || 0).toFixed(2),
      x.owner === null ? -1 : x.owner, Math.round(x.availableAt)]);
    // The TOMB has to travel too, not just the bodies in it. A guest whose
    // bridge is still raised walks into a chasm the host has already bridged,
    // and a guest with different braziers sees a puzzle nobody solved. The
    // collapsing tiles are the exception: they are a pure function of game.t,
    // which is already in this packet, so sending them would be redundant.
    return { t: 's', ts: Date.now(), gt: Math.round(game.t), phase: game.phase, p, r,
      m: game.mech ? game.mech.pack() : null,
      it: game.interact ? game.interact.pack() : null,
      b: game.story ? game.story.beat : 0,
      rm: game.rooms ? game.rooms.pack() : '',   // discovery is per-TEAM
      dt: game.story ? game.story.deaths : 0,
      won: game.won ? 1 : 0 };
  };
  net.sendSnapshot = () => {
    if (!net.connected || !net.isHost || net.peers < 2) return;
    ws.send(JSON.stringify(net.snapshot()));
  };

  // ---- guest: ship input every tick ----
  net.sendInput = h => {
    if (!net.connected || net.isHost) return;
    ws.send(JSON.stringify({ t: 'i', ts: Date.now(),
      mx: +h.mx.toFixed(3), my: +h.my.toFixed(3), fwd: +h.fwd.toFixed(2), strafe: +h.strafe.toFixed(2),
      sp: h.sprint ? 1 : 0, cr: h.crouch ? 1 : 0, it: h.interact ? 1 : 0,
      at: h.attack ? 1 : 0, dg: h.dodge ? 1 : 0, jp: h.jump ? 1 : 0,
      jh: h.jumpHeld ? 1 : 0, bl: h.block ? 1 : 0,
      nm: net.localName || '' }));
  };

  // ---- guest: reconcile prediction against authority ----
  net.applySnapshot = () => {
    const m = net.pending; if (!m) return; net.pending = null;
    // A small lead or lag is normal at 20 Hz. Rewriting the clock every packet
    // rewinds mechanisms that are a pure function of game.t. Only correct a
    // real split — a guest who joined late, or a stall.
    if (typeof m.gt === 'number' && Math.abs(game.t - m.gt) > 250) game.t = m.gt;
    if (m.phase !== game.phase && m.phase === 'results') game.phase = 'results';
    for (const row of m.p) {
      const [id, x, y, z, angle, state, hp, score, gait, crouch, dead, name] = row;
      const p = game.players[id]; if (!p) continue;
      p.hp = hp; p.score = score; p.gait = gait; p.crouch = !!crouch;
      if (name && id !== net.slot) p.name = String(name).replace(/[^\w .'-]/g, '').slice(0, 16);
      p.state = state; p.deadUntil = dead ? (p.deadUntil || game.t + 1) : 0;
      if (id === net.slot) {
        // our own body: ease, so a small disagreement is invisible rather than a jerk
        const err = Math.hypot(p.x - x, p.y - y);
        if (err > HARD_SNAP) { p.x = x; p.y = y; p.z = z; p.px = x; p.py = y; p.pz = z; }
        else { p.x += (x - p.x) * EASE; p.y += (y - p.y) * EASE; p.z += (z - p.z) * EASE; }
      } else {
        // someone else's body: authority wins outright, render interpolates it
        p.px = p.x; p.py = p.y; p.pz = p.z; p.pangle = p.angle;
        p.x = x; p.y = y; p.z = z; p.angle = angle;
      }
    }
    for (const row of m.r) {
      const [id, x, y, z, owner, availableAt] = row;
      const r = game.relics[id]; if (!r) continue;
      r.px = r.x; r.py = r.y;
      r.x = x; r.y = y; r.z = z; r.owner = owner < 0 ? null : owner; r.availableAt = availableAt;
    }
    // ---- the world the host believes in ----
    if (game.mech && m.m) game.mech.apply(m.m);
    if (game.interact && m.it) game.interact.apply(m.it);
    if (game.rooms && m.rm) game.rooms.apply(m.rm);
    if (game.story && typeof m.b === 'number') {
      // Only ever forward. The guest also runs story.step() locally against the
      // same world, so it usually arrives on its own; this closes the gap when a
      // beat fired on a trigger only the host's body crossed.
      if (m.b > game.story.beat) game.story.beat = m.b;
      if (typeof m.dt === 'number') game.story.deaths = m.dt;
    }
    if (m.won) game.won = true;
  };

  net.close = () => { try { ws.close(); } catch {} };
  // Call after game.init. The match reset rebuilds the runners as a solo pair;
  // this puts the socket's role back onto those bodies.
  net.attach = () => {
    if (!game.players.length) return;
    net.localName = (net.localName || '').slice(0, 16);
    if (net.isHost) {
      game.authority = true;
      game.localId = 0;
      net.slot = 0;
      if (net.peers >= 2) handoffSlot(game, 1);
    } else if (net.connected) {
      claimGuest(game, net.localName);
      net.slot = 1;
    }
  };
  return net;
}

const unit = v => { v = +v; return Number.isFinite(v) ? Math.max(-1, Math.min(1, v)) : 0; };
const bit = v => (v ? 1 : 0);
function cleanInput(m) {
  // the move vector is a direction: renormalise anything longer than 1
  let mx = unit(m.mx), my = unit(m.my);
  const l = Math.hypot(mx, my); if (l > 1) { mx /= l; my /= l; }
  return { mx, my, fwd: unit(m.fwd), strafe: unit(m.strafe), sp: bit(m.sp), cr: bit(m.cr), it: bit(m.it),
    at: bit(m.at), dg: bit(m.dg), jp: bit(m.jp), jh: bit(m.jh), bl: bit(m.bl),
    nm: String(m.nm || '').replace(/[^\w .'-]/g, '').slice(0, 16) };
}

// Slot 1 stops being an AI and starts taking input off the wire.
function handoffSlot(game, slot) {
  const p = game.players[slot]; if (!p) return;
  p.isBot = false; p.remote = true; p.ally = true; p.dormant = false;
  if (!p.name || p.name === 'KESTREL') p.name = 'PARTNER';
}
function returnSlot(game, slot) {
  const p = game.players[slot]; if (!p) return;
  p.isBot = true; p.remote = false; p.ally = true; p.dormant = true; p.name = 'KESTREL';
}
// The guest plays slot 1. Slot 0 is the host's body, drawn from snapshots.
function claimGuest(game, name) {
  game.authority = false;
  game.localId = 1;
  const host = game.players[0];
  const me = game.players[1];
  if (host) { host.isBot = false; host.remote = true; host.dormant = false; }
  if (me) {
    me.isBot = false; me.remote = false; me.ally = true; me.dormant = false;
    me.name = name || me.name || 'PARTNER';
  }
}
