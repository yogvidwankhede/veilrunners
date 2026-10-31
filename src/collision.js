import * as THREE from 'three';

// ---------------------------------------------------------------------------
// Circular colliders for the Meshy props.
//
// `MAP.walls` only describes the architecture that was ported from the 2D game.
// The rocks and trees placed from placements.json were pure decoration — you
// walked straight through them. Each placement now registers a circle here, in
// game units, and game.js's `blocked()` consults it.
// ---------------------------------------------------------------------------

const PROPS = [];

export function clearProps() { PROPS.length = 0; }
export function addProp(x, y, r) { PROPS.push({ x, y, r }); }
export function propCount() { return PROPS.length; }

export function hitsProp(x, y, pad = 0) {
  for (let i = 0; i < PROPS.length; i++) {
    const p = PROPS[i], dx = x - p.x, dy = y - p.y, rr = p.r + pad;
    if (dx * dx + dy * dy < rr * rr) return true;
  }
  return false;
}

// True when (x,y) is already inside a prop and (nx,ny) is not farther from it.
// A body that clipped in may step back out. It may not be pushed deeper.
export function deepensProp(x, y, nx, ny, pad = 0) {
  for (let i = 0; i < PROPS.length; i++) {
    const p = PROPS[i];
    const d0 = Math.hypot(x - p.x, y - p.y);
    if (d0 >= p.r + pad) continue;
    const d1 = Math.hypot(nx - p.x, ny - p.y);
    if (d1 <= d0 + 1e-4) return true;
  }
  return false;
}

// FALLBACK collider radius for a prop with no explicit `r`.
//
// Measures the vertices in the bottom `frac` of the model, about their own
// centroid (not the bounding-box centre, which for a lopsided canopy is nowhere
// near the trunk), and takes a high percentile rather than the maximum so one
// stray branch does not set the radius. Still a guess — prefer an explicit `r`
// in placements.json for anything whose silhouette matters.
export function footprintRadius(proto, frac = 0.2, pct = 0.85) {
  proto.updateMatrixWorld(true);
  const bb = new THREE.Box3().setFromObject(proto);
  const cut = bb.min.y + (bb.max.y - bb.min.y) * frac;
  const pts = [];
  const v = new THREE.Vector3();
  proto.traverse(o => {
    const pos = o.isMesh && o.geometry && o.geometry.attributes.position;
    if (!pos) return;
    const stride = Math.max(1, Math.floor(pos.count / 8000));
    for (let i = 0; i < pos.count; i += stride) {
      v.fromBufferAttribute(pos, i).applyMatrix4(o.matrixWorld);
      if (v.y <= cut) pts.push(v.x, v.z);
    }
  });
  const n = pts.length / 2;
  if (!n) return 0;
  let sx = 0, sz = 0;
  for (let i = 0; i < n; i++) { sx += pts[i * 2]; sz += pts[i * 2 + 1]; }
  const cx = sx / n, cz = sz / n;
  const rs = new Float64Array(n);
  for (let i = 0; i < n; i++) rs[i] = Math.hypot(pts[i * 2] - cx, pts[i * 2 + 1] - cz);
  rs.sort();
  return rs[Math.min(n - 1, Math.floor(n * pct))];
}
export function propList() { return PROPS; }
