// ---------------------------------------------------------------------------
// The baked collision map: what the carved stone actually occupies.
//
// MAP.walls is the level's architecture and is exact for it. Everything else
// that is solid — the carved props, the masonry courses proud of a chamber
// wall — used to collide as a circle or as the axis-aligned box around the
// mesh, padded again for the body. A rubble pile's box is mostly air, a circle
// around a lying drum is mostly air, and the audit measured 564 m² of floor a
// body could not enter with no stone within reach of it.
//
// tools/bakecollision.mjs rasterises the triangles of every static solid mesh,
// in the loaded scene, into a 10 cm grid. Each cell keeps the lowest and
// highest point of stone in its column. It is generated into collisionmap.js
// so the Node suites collide against exactly what the browser does.
// ---------------------------------------------------------------------------
import { MAP, S, PHYS } from './constants.js';
import { BAKE } from './collisionmap.js';

const EMPTY = 32767;
let W = 0, H = 0, CELL = 0.1, OX = 0, OZ = 0, BOT = null, TOP = null;

function b64bytes(b64) {
  if (typeof Buffer !== 'undefined') return new Uint8Array(Buffer.from(b64, 'base64'));
  const s = atob(b64), u = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) u[i] = s.charCodeAt(i);
  return u;
}

// Sparse on disk (cell index delta as uint16 runs, then bottom/top in cm),
// dense in memory: a lookup is two array reads.
function load(bake) {
  W = bake.w; H = bake.h; CELL = bake.cell; OX = bake.ox; OZ = bake.oz;
  BOT = new Int16Array(W * H).fill(EMPTY);
  TOP = new Int16Array(W * H).fill(-EMPTY);
  if (!bake.data) return;
  const u = b64bytes(bake.data);
  const dv = new DataView(u.buffer, u.byteOffset, u.byteLength);
  let idx = 0, o = 0;
  while (o < u.length) {
    idx += dv.getUint32(o, true); o += 4;
    BOT[idx] = dv.getInt16(o, true); TOP[idx] = dv.getInt16(o + 2, true); o += 4;
  }
}
load(BAKE);

export const bakeInfo = () => ({ w: W, h: H, cell: CELL, hash: BAKE.hash, cells: BAKE.cells || 0 });

// Is any stone within `r` metres of game point (x,y) that a body standing at
// height z can neither step over nor duck under?
export function gridBlocked(x, y, z, r) {
  if (!BOT) return false;
  const wx = (x - MAP.w / 2) * S, wz = (y - MAP.h / 2) * S;
  const lo = Math.round((z + PHYS.stepUp + 0.05) * 100);    // a step: walk over it
  const hi = Math.round((z + 1.7) * 100);                    // overhead: walk under it
  const c0 = Math.floor((wx - r - OX) / CELL), c1 = Math.floor((wx + r - OX) / CELL);
  const r0 = Math.floor((wz - r - OZ) / CELL), r1 = Math.floor((wz + r - OZ) / CELL);
  const rr = r * r;
  for (let j = Math.max(0, r0); j <= Math.min(H - 1, r1); j++) {
    const cz = OZ + (j + 0.5) * CELL, dz = Math.max(0, Math.abs(cz - wz) - CELL / 2);
    for (let i = Math.max(0, c0); i <= Math.min(W - 1, c1); i++) {
      const k = j * W + i;
      if (TOP[k] <= lo || BOT[k] >= hi) continue;
      const cx = OX + (i + 0.5) * CELL, dx = Math.max(0, Math.abs(cx - wx) - CELL / 2);
      if (dx * dx + dz * dz < rr) return true;   // nearest point of the cell is inside the body
    }
  }
  return false;
}

// The camera's spring arm against the carved stone. The arm used to collide
// only with the level's boxes, so a carved pillar or a pile of rubble between
// the runner and the lens put the camera inside the model. A march through the
// same grid the body collides with: 5 cm steps, metres in world space.
export function gridRayHit(ox, oy, oz, dx, dy, dz, far) {
  if (!BOT) return Infinity;
  for (let t = 0.3; t < far; t += 0.05) {
    const x = ox + dx * t, y = oy + dy * t, z = oz + dz * t;
    const i = Math.floor((x - OX) / CELL), j = Math.floor((z - OZ) / CELL);
    if (i < 0 || j < 0 || i >= W || j >= H) continue;
    const k = j * W + i, cm = y * 100;
    if (cm > BOT[k] - 4 && cm < TOP[k] + 4) return t;
  }
  return Infinity;
}
