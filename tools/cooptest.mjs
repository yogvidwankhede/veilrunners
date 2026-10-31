// Two browsers, one tomb. The host owns the simulation; the guest plays slot 1
// and only predicts. This drives both roles in-process against the real relay
// and the real Game, so a partner who is secretly controlling the host's body
// fails here instead of in a playtest.
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import WebSocket from 'ws';

globalThis.WebSocket = WebSocket;

const { Game } = await import('../src/game.js');
const { createNet } = await import('../src/net.js');
const { TICK } = await import('../src/constants.js');

const PORT = 8097;
const ROOM = 'cooptest';
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const scene = { add() {}, remove() {} };
const still = { mx: 0, my: 0, fwd: 0, strafe: 0, sprint: false, crouch: false,
  interact: false, attack: false, dodge: false, jump: false, jumpHeld: true, block: false };
// North, up the entrance hall. East of the partner spawn is the hall wall, which
// stops anyone after a step and made this read as dead input.
const walk = { ...still, mx: 0, my: -1, fwd: 1, sprint: true };

const srv = spawn(process.execPath, ['serve.mjs'], {
  cwd: root,
  env: { ...process.env, PORT: String(PORT) },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let srvLog = '';
srv.stdout.on('data', d => { srvLog += d; });
srv.stderr.on('data', d => { srvLog += d; });

function fail(msg) {
  console.log('FAIL  ' + msg);
  srv.kill();
  process.exit(1);
}

await new Promise((resolve, reject) => {
  const t = setTimeout(() => reject(new Error('server did not listen\n' + srvLog)), 8000);
  const wait = () => {
    if (srvLog.includes('' + PORT)) { clearTimeout(t); resolve(); }
  };
  srv.stdout.on('data', wait);
  srv.stderr.on('data', wait);
});

const hostGame = new Game(scene);
const guestGame = new Game(scene);
hostGame.init('ARIA');
guestGame.init('NYX');

const url = `ws://127.0.0.1:${PORT}/net`;
const hostNet = createNet({ game: hostGame, url, room: ROOM });
hostNet.localName = 'ARIA';
hostNet.room = ROOM;

await new Promise(r => {
  const t = setInterval(() => { if (hostNet.isHost && hostNet.connected) { clearInterval(t); r(); } }, 20);
});
hostNet.attach();

const guestNet = createNet({ game: guestGame, url, room: ROOM });
guestNet.localName = 'NYX';
guestNet.room = ROOM;

await new Promise(r => {
  const t = setInterval(() => {
    if (!guestNet.isHost && guestNet.connected && hostNet.peers >= 2) { clearInterval(t); r(); }
  }, 20);
});
guestNet.attach();

if (guestGame.localId !== 1) fail('guest is not playing slot 1');
if (guestGame.authority !== false) fail('guest thinks it owns the simulation');
if (!guestGame.players[1] || guestGame.players[1].remote) fail('guest slot 1 is not the local body');
if (!guestGame.players[0].remote) fail('guest is simulating the host as a local body');
if (!hostGame.players[1].remote || hostGame.players[1].isBot) fail('host did not hand the partner slot to the wire');

const start = { x: hostGame.players[1].x, y: hostGame.players[1].y };
const steps = 120; // 2 seconds
for (let i = 0; i < steps; i++) {
  guestNet.sendInput(walk);
  guestNet.applySnapshot();
  hostGame.remoteInput = hostNet.remoteInput;
  hostGame.update(TICK, still);
  hostNet.sendSnapshot();
  guestGame.update(TICK, walk);
  await new Promise(r => setTimeout(r, 8));
}

const partner = hostGame.players[1];
const moved = Math.hypot(partner.x - start.x, partner.y - start.y);
const guestBody = guestGame.players[1];
const agree = Math.hypot(guestBody.x - partner.x, guestBody.y - partner.y);
const hostBody = hostGame.players[0];
const hostDrift = Math.hypot(hostBody.x - 136, hostBody.y - 440);

console.log(`partner moved ${moved.toFixed(1)} units under guest input`);
console.log(`guest prediction is ${agree.toFixed(1)} units from the host's partner`);
console.log(`host body drifted ${hostDrift.toFixed(1)} units`);
console.log(`partner name on the host: ${partner.name}`);

// ---- a bad connection: 120 ms each way and 5% of packets lost ----
// A LAN test proves nothing about a real link. Both ends' sends are delayed
// and randomly dropped (seeded, so the run is reproducible), and the partner
// must still walk under guest input with the two simulations in agreement.
{
  let seed = 7; const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  let sent = 0, dropped = 0;
  for (const n of [hostNet, guestNet]) {
    const raw = n.ws.send.bind(n.ws);
    n.ws.send = (data) => { sent++; if (rnd() < 0.05) { dropped++; return; } setTimeout(() => { try { raw(data); } catch {} }, 120); };
  }
  const p1 = hostGame.players[1], from = { x: p1.x, y: p1.y };
  const back = { ...walk, my: 1 };          // walk back south, the way it came
  for (let i = 0; i < 150; i++) {
    guestNet.sendInput(back); guestNet.applySnapshot();
    hostGame.remoteInput = hostNet.remoteInput; hostGame.update(TICK, still);
    if (i % 3 === 0) hostNet.sendSnapshot();
    guestGame.update(TICK, back);
    await new Promise(r => setTimeout(r, 16));
  }
  await new Promise(r => setTimeout(r, 400));
  for (let i = 0; i < 30; i++) { guestNet.sendInput(still); guestNet.applySnapshot(); hostGame.remoteInput = hostNet.remoteInput; hostGame.update(TICK, still); hostNet.sendSnapshot(); guestGame.update(TICK, still); await new Promise(r => setTimeout(r, 16)); }
  await new Promise(r => setTimeout(r, 400)); guestNet.applySnapshot();
  const lagMoved = Math.hypot(p1.x - from.x, p1.y - from.y);
  const lagAgree = Math.hypot(guestGame.players[1].x - p1.x, guestGame.players[1].y - p1.y);
  console.log(`bad link (120 ms, ${dropped}/${sent} packets lost): partner moved ${lagMoved.toFixed(1)} u, settled ${lagAgree.toFixed(1)} u from the host`);
  if (lagMoved < 40) fail('on a 120 ms lossy link the partner barely moved');
  if (lagAgree > 25) fail(`on a lossy link the two ends settled ${lagAgree.toFixed(1)} u apart`);
}

srv.kill();
// The relay vanishing mid-run must not freeze the guest: it takes the world
// over from its last snapshot and plays on alone.
await new Promise(r => { const t0 = Date.now(); const t = setInterval(() => {
  if (!guestNet.connected || Date.now() - t0 > 3000) { clearInterval(t); r(); } }, 20); });
const tBefore = guestGame.t;
guestGame.update(TICK, walk);
if (guestNet.connected) fail('the guest never noticed the relay was gone');
if (!guestGame.authority || !guestNet.isHost) fail('a dropped guest did not take over the world');
if (guestGame.t <= tBefore) fail('the dropped guest\'s world stopped');
if (guestGame.localId !== 1 || guestGame.players[1].remote) fail('the dropped guest lost its own body');
console.log('relay lost: the guest plays on alone');
// The host lost its partner too and handed slot 1 back to the tomb. The lever
// check below drives the host's rules directly, so put the partner back.
await new Promise(r => setTimeout(r, 100));
Object.assign(hostGame.players[1], { isBot: false, remote: true, dormant: false });

// Both levers, one tick apart, through the host's real update. Solo this is a
// sprint between them inside a grace window. With a partner both hands are on
// at once and the bridge drops without anyone running.
function stand(p, x, y) {
  p.x = x; p.y = y; p.z = 5; p.vz = 0; p.state = 'ground'; p.ledge = null;
  p.px = x; p.py = y; p.pz = 5; p.vx = 0; p.vy = 0;
}
stand(hostGame.players[0], 592, 404);
stand(hostGame.players[1], 724, 404);
const hold = { ...still, interact: true };
hostGame.remoteInput = { mx: 0, my: 0, fwd: 0, strafe: 0, sp: 0, cr: 0, it: 1, at: 0, dg: 0, jp: 0, jh: 1, bl: 0, nm: 'NYX' };
for (let i = 0; i < 6; i++) hostGame.update(TICK, hold);
if (!hostGame.mech.bridgeReleased) fail('both levers were held and the bridge stayed up');
console.log('both levers held: the bridge drops without the solo run');

if (moved < 40) fail(`partner barely moved (${moved.toFixed(1)} units) — input is not driving slot 1`);
if (agree > 80) fail(`guest and host disagree about the partner by ${agree.toFixed(1)} units`);
if (hostDrift > 30) fail('guest input moved the host');
if (partner.name !== 'NYX') fail(`host did not learn the partner's name (got ${partner.name})`);
console.log('PASSED — guest plays slot 1, host stays put, both sims agree');
process.exit(0);
