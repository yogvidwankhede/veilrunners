// A headless co-op guest. Connects to the relay, sends movement input for a few
// seconds, and reports the snapshots the host sends back. Lets the host run in a
// visible browser tab while the partner is driven from here — two browser tabs
// cannot both be foregrounded, and a hidden tab has its frame loop throttled.
import WebSocket from 'ws';

const room = process.argv[2] || 'test';
const secs = +(process.argv[3] || 4);
const ws = new WebSocket(`ws://localhost:8080/net?room=${room}`);
let role = '?', snaps = 0, firstSelf = null, lastSelf = null, lastHost = null, lastPhase = null;

ws.on('open', () => console.log(`connected to room "${room}"`));
ws.on('message', buf => {
  const m = JSON.parse(buf.toString());
  if (m.t === 'hello') { role = m.host ? 'HOST' : 'GUEST'; console.log(`role: ${role}, peers ${m.peers}`); }
  if (m.t === 's') {
    snaps++;
    lastPhase = m.phase;
    const me = m.p.find(r => r[0] === 1), host = m.p.find(r => r[0] === 0);
    if (me) { if (!firstSelf) firstSelf = me; lastSelf = me; }
    if (host) lastHost = host;
  }
});

setTimeout(() => {
  // walk north-east for `secs`
  const iv = setInterval(() => {
    ws.send(JSON.stringify({ t: 'i', ts: Date.now(), mx: 0.7, my: 0.7, fwd: 1, strafe: 0,
      sp: 1, cr: 0, it: 0, at: 0, dg: 0, jp: 0, bl: 0 }));
  }, 16);
  setTimeout(() => {
    clearInterval(iv);
    console.log(`\nsnapshots received: ${snaps} in ${secs}s  (~${(snaps / secs).toFixed(0)} Hz, expected 20)`);
    console.log(`host phase: ${lastPhase}`);
    if (firstSelf && lastSelf) {
      const d = Math.hypot(lastSelf[1] - firstSelf[1], lastSelf[2] - firstSelf[2]);
      console.log(`partner moved ${d.toFixed(0)} units under our input  (${firstSelf[1]},${firstSelf[2]}) -> (${lastSelf[1]},${lastSelf[2]})`);
      console.log(`partner state="${lastSelf[5]}" hp=${lastSelf[6]} z=${lastSelf[3]}`);
    } else console.log('NO SNAPSHOTS — host is not broadcasting');
    if (lastHost) console.log(`host body at (${lastHost[1]},${lastHost[2]}) z=${lastHost[3]} state="${lastHost[5]}"`);
    ws.close(); process.exit(0);
  }, secs * 1000);
}, 600);
