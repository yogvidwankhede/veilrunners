// ---------------------------------------------------------------------------
// Is every placed prop guarded by something solid?
//
// This bug class has bitten twice. A generated model is scaled by HEIGHT, but
// what decides whether you can walk into it is its WIDTH, and Meshy models are
// routinely two or three times wider than they are tall. A prop with
// `solid: false` and no level box behind it is a hollow shell you walk into and
// see straight out of, because the meshes are single-sided.
//
// Reads the GLB bounds directly (gltf-transform, no browser, no GPU) and
// applies the same targetH and `fit` maths assets.js uses.
// ---------------------------------------------------------------------------
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { NodeIO } from '@gltf-transform/core';
// the optimised GLBs carry EXT_texture_webp from the texture pass
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { WALLS, LAMP_STANDOFF } from '../src/level.js';
import { S } from '../src/constants.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const io = new NodeIO().registerExtensions(ALL_EXTENSIONS);
let fails = 0, warns = 0;
const ok = m => console.log(`  ok    ${m}`);
const bad = m => { console.log(`  FAIL  ${m}`); fails++; };
const warn = m => { console.log(`  warn  ${m}`); warns++; };

// model-space bounds straight off the POSITION accessors
async function modelSize(file) {
  const doc = await io.read(path.join(ROOT, 'assets', file));
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (const mesh of doc.getRoot().listMeshes())
    for (const prim of mesh.listPrimitives()) {
      const pos = prim.getAttribute('POSITION'); if (!pos) continue;
      const mn = pos.getMin([]), mx = pos.getMax([]);
      for (let i = 0; i < 3; i++) { lo[i] = Math.min(lo[i], mn[i]); hi[i] = Math.max(hi[i], mx[i]); }
    }
  return [hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]];
}

const pl = JSON.parse(fs.readFileSync(path.join(ROOT, 'placements.json'), 'utf8'));
const byId = Object.fromEntries(WALLS.filter(w => w.id).map(w => [w.id, w]));
const byTag = {};
for (const w of WALLS) (byTag[w.tag] = byTag[w.tag] || []).push(w);

console.log('\nPROP COLLIDERS — can you walk inside anything?\n');

for (const [k, cfg] of Object.entries(pl)) {
  const file = cfg.file || `${k}.glb`;
  if (!fs.existsSync(path.join(ROOT, 'assets', file))) continue;

  const [sx, sy, sz] = await modelSize(file);
  const base = (cfg.targetH || 2) / (sy || 1);

  // the same `fit` maths assets.js applies
  let fitXZ = 1;
  if (cfg.fit) {
    const piece = byId[k] || (cfg.hides || []).map(h => byId[h]).find(Boolean) || (byTag[k] || [])[0];
    if (piece && sx > 1e-4 && sz > 1e-4) {
      const want = Math.min((piece.w * S) / (sx * base), (piece.h * S) / (sz * base));
      fitXZ = Math.max(cfg.fitMin || 0.30, Math.min(cfg.fitMax || 2.5, want));
    }
  }
  const visR = Math.max(sx, sz) * base * fitXZ / 2;      // metres, visual half-width

  // What actually stops you. A prop NAMED after a level piece is guarded by it,
  // and so is one simply STANDING ON or set into a box that is at least as tall
  // as the prop's own base — the drum on its altar, a glyph tablet set into a
  // wall. Missing that second case reported both as unguarded when the
  // architecture around them already does the job.
  // EVERY placement, not just the first. `solid` is now per-copy, because a prop
  // can be set flush into a wall in one place (no collider wanted — a collider
  // would only stop you getting close enough to read it) and stand freestanding
  // in another (where its absence is 1.7 m of carved stone you walk through).
  // Judging cfg.at[0] and assuming the rest match is how that shipped.
  const copies = (cfg.at || [{ x: 0, y: 0, z: 0 }]);
  let worst = null;
  for (const pt of copies) {
    const covering = WALLS.filter(w =>
      pt.x > w.x - 8 && pt.x < w.x + w.w + 8 &&
      pt.y > w.y - 8 && pt.y < w.y + w.h + 8 &&
      w.top >= (pt.z || 0) - 0.1);
    const backing = byId[k] || (cfg.hides || []).map(h => byId[h]).find(Boolean)
                  || ((cfg.hides || []).map(h => (byTag[h] || [])[0]).find(Boolean))
                  || covering.sort((a, b) => (b.w * b.h) - (a.w * a.h))[0];
    const boxR = backing ? Math.max(backing.w, backing.h) * S / 2 : 0;
    const ptSolid = pt.solid != null ? pt.solid : (cfg.solid !== false);
    const rCfg = pt.r != null ? pt.r : cfg.r;
    const colR = !ptSolid ? 0 : (rCfg != null ? rCfg * fitXZ : null);
    const guard = Math.max(boxR, colR || 0);
    const gap = visR - guard;
    if (!worst || gap > worst.gap) worst = { gap, guard, colR, pt };
  }
  const { gap, guard, colR, pt } = worst;
  const where = copies.length > 1 ? ` (worst of ${copies.length}: ${pt.x},${pt.y})` : '';
  const label = `${k.padEnd(20)} visual ${visR.toFixed(2)}m  guard ${guard.toFixed(2)}m`;
  // A deliberate walk-through must SAY so in the placement, not be silenced
  // here. Hanging ropes, cloth, and pit spikes are the cases that remain.
  if (cfg.allowWalkThrough) { ok(`${label}  — walk-through by design: ${cfg.allowWalkThrough}`); continue; }
  if (colR === null) { warn(`${label}  — collider is auto-derived, not declared`); continue; }
  if (gap <= 0.6) { ok(label + where); continue; }
  // A prop you can walk inside is a defect, not a note. This was a `warn` for
  // everything under 1.2 m, so a 1.7 m glyph slab with NO collider at all sat
  // in the entrance hall printing a warning on every run and shipping anyway.
  bad(`${label}${where}  — you can walk ${gap.toFixed(2)}m INSIDE this`);
}

// ---- wall-mounted props must actually touch their wall ----------------------
// LAMP_STANDOFF is how far a bracketed lamp sits proud of the face. If it
// exceeds half the model's depth the back face floats clear of the stone and
// the lamp reads as hanging in mid-air, which is exactly what it did at 13 u.
{
  const cfg = pl.wall_lamp;
  if (!cfg) warn('no wall_lamp placement to check the standoff against');
  else {
    const [lx, ly, lz] = await modelSize(cfg.file);
    {
      const scale = cfg.targetH / ly;
      const half = Math.max(lx, lz) * scale / 2;             // metres
      const off = LAMP_STANDOFF * S;                          // metres
      const gap = off - half;
      (gap >= -0.02 && gap <= 0.12)
        ? ok(`wall_lamp sits on its wall`, `(standoff ${off.toFixed(3)}m vs half-depth ${half.toFixed(3)}m -> ${(gap*1000).toFixed(0)}mm reveal)`)
        : bad(`wall_lamp standoff ${off.toFixed(3)}m vs half-depth ${half.toFixed(3)}m`,
              gap > 0.12 ? `back face floats ${gap.toFixed(3)}m off the wall — it reads as hanging`
                         : `it is buried ${(-gap).toFixed(3)}m inside the wall`);
    }
  }
}

console.log(`\n${fails ? 'FAILED' : 'PASSED'} — ${fails} failure${fails === 1 ? '' : 's'}, ${warns} warning${warns === 1 ? '' : 's'}\n`);
process.exit(fails ? 1 : 0);
