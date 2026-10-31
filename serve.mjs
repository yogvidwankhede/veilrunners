// ---------------------------------------------------------------------------
// VEILRUNNERS server: static files plus the co-op relay, one process, no deps
// beyond `ws`. This is both the dev server (`npm start`) and the production
// server (`NODE_ENV=production node serve.mjs`), so what is tested is what ships.
// ---------------------------------------------------------------------------
import http from 'node:http'; import fs from 'node:fs'; import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';

// fileURLToPath, not url.pathname — the project path can contain spaces (%20).
const root = path.dirname(fileURLToPath(import.meta.url));
const port = +process.env.PORT || 8080;
const DEV = process.env.NODE_ENV !== 'production';
const mime = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.json': 'application/json',
  '.glb': 'model/gltf-binary', '.fbx': 'application/octet-stream', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.webmanifest': 'application/manifest+json' };
const COMPRESSIBLE = new Set(['.html', '.js', '.json', '.css', '.svg', '.fbx']);
// What a browser may fetch. Source, tools, tests and the server itself are not
// public, even though they sit in the same folder.
const PUBLIC = [/^\/index\.html$/, /^\/assets\/[\w./-]+$/, /^\/favicon\.(ico|svg)$/];

// Gzip once, serve many: the page is ~1 MB of JS and every visitor gets the
// same bytes. Keyed by path and mtime so a rebuild is picked up without a restart.
const gz = new Map();
function gzipped(f, st) {
  const hit = gz.get(f);
  if (hit && hit.mtime === st.mtimeMs) return hit.buf;
  const buf = zlib.gzipSync(fs.readFileSync(f), { level: 9 });
  gz.set(f, { mtime: st.mtimeMs, buf });
  return buf;
}

const security = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'SAMEORIGIN',
  'Cross-Origin-Opener-Policy': 'same-origin',
};

const srv = http.createServer((req, res) => {
  // ---- DEV ONLY: POST a canvas dataURL here and it lands in snaps/ ----------
  // The three.js canvas can only be captured from inside the page. Off in
  // production: a public endpoint that writes files is not a debugging aid.
  if (DEV && req.method === 'POST' && req.url.startsWith('/__snap')) {
    let body = '';
    req.on('data', c => { body += c; if (body.length > 40e6) req.destroy(); });
    req.on('end', () => {
      try {
        const name = (new URL(req.url, 'http://x').searchParams.get('n') || 'snap').replace(/[^\w.-]/g, '');
        const b64 = body.replace(/^data:image\/\w+;base64,/, '');
        fs.mkdirSync(path.join(root, 'snaps'), { recursive: true });
        fs.writeFileSync(path.join(root, 'snaps', name + '.png'), Buffer.from(b64, 'base64'));
        res.writeHead(200, { 'Content-Type': 'text/plain' }); res.end('ok ' + name);
      } catch (e) { res.writeHead(500); res.end(String(e)); }
    });
    return;
  }
  if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405, { Allow: 'GET, HEAD' }); return res.end(); }

  let p;
  try { p = decodeURIComponent(req.url.split('?')[0]); } catch { res.writeHead(400); return res.end('bad request'); }
  if (p === '/healthz') { res.writeHead(200, { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' }); return res.end('ok'); }
  if (p === '/') p = '/index.html';
  // In dev the tools/*.html probes and snaps are reachable; in production only
  // the game is.
  if (!DEV && !PUBLIC.some(rx => rx.test(p))) { res.writeHead(404); return res.end('404'); }
  const f = path.join(root, p);
  if (!f.startsWith(root + path.sep)) { res.writeHead(404); return res.end('404'); }
  let st;
  try { st = fs.statSync(f); if (!st.isFile()) throw 0; } catch { res.writeHead(404); return res.end('404'); }

  const ext = path.extname(f);
  const headers = { ...security, 'Content-Type': mime[ext] || 'application/octet-stream',
    // The page names no hashed files, so it must always revalidate. Models and
    // clips change only when regenerated, and a day of caching saves the 7 MB
    // rig on every return visit.
    'Cache-Control': ext === '.html' ? 'no-cache' : 'public, max-age=86400',
    'Last-Modified': st.mtime.toUTCString(), Vary: 'Accept-Encoding' };
  if (req.headers['if-modified-since'] && new Date(req.headers['if-modified-since']) >= new Date(st.mtime.toUTCString())) {
    res.writeHead(304, headers); return res.end();
  }
  if (COMPRESSIBLE.has(ext) && /\bgzip\b/.test(req.headers['accept-encoding'] || '')) {
    const buf = gzipped(f, st);
    res.writeHead(200, { ...headers, 'Content-Encoding': 'gzip', 'Content-Length': buf.length });
    return res.end(req.method === 'HEAD' ? undefined : buf);
  }
  res.writeHead(200, { ...headers, 'Content-Length': st.size });
  if (req.method === 'HEAD') return res.end();
  fs.createReadStream(f).pipe(res);
});

// ---------------------------------------------------------------------------
// Co-op rooms. The first socket into a room is the HOST and runs the authoritative
// simulation; the second is the GUEST and sends input. The server is a relay
// — it never simulates — which keeps it cheap and means the game rules live in one
// place (the host's game.js) instead of being duplicated server-side.
//
// What the relay does enforce: two runners a room, a size and rate ceiling on
// every message, and direction — a guest can only send input to its host, and
// only a host can send world state. The host validates the input itself.
// ---------------------------------------------------------------------------
const MAX_PER_ROOM = 2;
const MAX_MSG = 16 * 1024;           // a snapshot is ~1.5 KB; input ~200 B
const MAX_RATE = 150;                // messages per second per socket (input is 60)
const MAX_ROOMS = 500;
const rooms = new Map();             // roomId -> { host, guests:Set }
const wss = new WebSocketServer({ server: srv, path: '/net', maxPayload: MAX_MSG });

wss.on('connection', (ws, req) => {
  const room = (new URL(req.url, 'http://x').searchParams.get('room') || 'veil').replace(/[^\w-]/g, '').slice(0, 24) || 'veil';
  let r = rooms.get(room);
  if (!r) {
    if (rooms.size >= MAX_ROOMS) { ws.close(1013, 'server busy'); return; }
    r = { host: null, guests: new Set() }; rooms.set(room, r);
  }
  const live = (r.host && r.host.readyState === 1 ? 1 : 0) + [...r.guests].filter(g => g.readyState === 1).length;
  if (live >= MAX_PER_ROOM) {
    ws.send(JSON.stringify({ t: 'full' }));
    ws.close(1008, 'room full');
    return;
  }

  const isHost = !r.host || r.host.readyState !== 1;
  if (isHost) r.host = ws; else r.guests.add(ws);
  ws._room = room; ws._host = isHost; ws._alive = true;
  ws._win = Date.now(); ws._count = 0;
  ws.send(JSON.stringify({ t: 'hello', host: isHost, room, peers: live + 1 }));
  if (!isHost && r.host && r.host.readyState === 1)
    r.host.send(JSON.stringify({ t: 'join' }));
  ws.on('pong', () => { ws._alive = true; });

  ws.on('message', (buf, isBinary) => {
    if (isBinary) return;
    const now = Date.now();
    if (now - ws._win > 1000) { ws._win = now; ws._count = 0; }
    if (++ws._count > MAX_RATE) return;                       // flood: drop, do not relay
    // Direction is enforced by message type, not just by who sent it: a guest
    // that sends a snapshot is not forwarded anywhere.
    const head = buf.subarray(0, 12).toString();
    const r2 = rooms.get(room); if (!r2) return;
    if (ws._host) {
      if (!head.startsWith('{"t":"s"')) return;
      for (const g of r2.guests) if (g.readyState === 1) g.send(buf, { binary: false });
    } else {
      if (!head.startsWith('{"t":"i"')) return;
      if (r2.host && r2.host.readyState === 1) r2.host.send(buf, { binary: false });
    }
  });

  ws.on('close', () => {
    const r2 = rooms.get(room); if (!r2) return;
    if (r2.host === ws) {
      r2.host = null;
      // promote a guest rather than dropping the session
      const next = [...r2.guests].find(g => g.readyState === 1);
      if (next) { r2.guests.delete(next); r2.host = next; next._host = true;
        next.send(JSON.stringify({ t: 'promote' })); }
    } else if (r2.guests.delete(ws)) {
      if (r2.host && r2.host.readyState === 1) r2.host.send(JSON.stringify({ t: 'leave' }));
    }
    if (!r2.host && !r2.guests.size) rooms.delete(room);
  });
});

// Heartbeat: a phone that walks out of Wi-Fi never sends a close. Without this
// its slot stays taken and the room reports full forever.
const beat = setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws._alive) { ws.terminate(); continue; }
    ws._alive = false; try { ws.ping(); } catch {}
  }
}, 15000);
wss.on('close', () => clearInterval(beat));

srv.listen(port, () => console.log(`VEILRUNNERS → http://localhost:${port}   (co-op relay on ws://localhost:${port}/net)${DEV ? '' : '   [production]'}`));
