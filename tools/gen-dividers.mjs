// ---------------------------------------------------------------------------
// Generate the chamber walls, with their doorways cut by the actual route.
//
// The tomb was built as floating PLATFORMS: `floor`, `causeway`, `gallery` and
// the rest are all boxes whose `top` is a surface you stand on. Apart from the
// shell and four pillars there were almost no vertical surfaces at all, which
// is why you could stand in one chamber and read every trap in the next one.
//
// Walls are proposed in chunks along each chamber's perimeter and any chunk the
// recorded playthrough passes through is dropped, so a doorway always exists
// exactly where the route needs one. Regenerate with:
//   VEIL_PATH=/tmp/veilpath.json node tools/runthrough.mjs
//   node tools/gen-dividers.mjs
// ---------------------------------------------------------------------------
import { readFileSync } from 'fs';
const P = JSON.parse(readFileSync(process.env.VEIL_PATH || '/tmp/veilpath.json','utf8'));

const TOP = 11;        // 6 m above a 5 m floor: over the camera, under the 12.4 vault
const TH  = 16;        // wall thickness, game units
const CH  = 30;        // chunk length
const CLEAR = 34;      // keep this clear of the route (PAD is 14, so ~2.4 body widths)

// chambers to enclose: [name, x0, x1, y0, y1, sides]
const ROOMS = [
  ['chamber',  520, 790, 150, 520, 'NSEW'],
  ['gallery',  470, 610,  56, 200, 'NSE'],   // W is where the stair arrives
  ['sanctum',  860,1080, 600, 800, 'NS'],    // E/W already have 7.5 m sanctum walls
];

const near = (x, y) => {
  for (let i = 0; i < P.length; i++) {
    const dx = P[i][0] - x, dy = P[i][1] - y;
    if (dx*dx + dy*dy < CLEAR*CLEAR) return true;
  }
  return false;
};

const out = [];
for (const [name, x0, x1, y0, y1, sides] of ROOMS) {
  const runs = [];
  if (sides.includes('N')) runs.push(['x', x0, x1, y0 - TH/2]);
  if (sides.includes('S')) runs.push(['x', x0, x1, y1 + TH/2]);
  if (sides.includes('W')) runs.push(['y', y0, y1, x0 - TH/2]);
  if (sides.includes('E')) runs.push(['y', y0, y1, x1 + TH/2]);
  for (const [axis, a0, a1, fixed] of runs) {
    let open = 0, seg = null;
    const flush = () => { if (seg) { out.push({ name, axis, ...seg, fixed }); seg = null; } };
    for (let a = a0; a < a1; a += CH) {
      const b = Math.min(a + CH, a1), mid = (a + b) / 2;
      const blocked = axis === 'x' ? near(mid, fixed) : near(fixed, mid);
      if (blocked) { open++; flush(); continue; }
      if (seg && seg.b === a) seg.b = b; else { flush(); seg = { a, b }; }
    }
    flush();
    if (open) console.error(`  ${name} ${axis==='x'?'y='+fixed:'x='+fixed}: ${open} chunk(s) left open for the route`);
  }
}
console.error(`\n${out.length} wall segments\n`);
for (const s of out) {
  const [x, y, w, h] = s.axis === 'x'
    ? [s.a, s.fixed - TH/2, s.b - s.a, TH]
    : [s.fixed - TH/2, s.a, TH, s.b - s.a];
  console.log(`  box(${x}, ${y}, ${w}, ${h}, ${TOP}, 'chamberwall'),`);
}
