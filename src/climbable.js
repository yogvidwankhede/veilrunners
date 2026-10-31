// Every solid thing the hands can hold, and that the body cannot pass
// through: the carved props, the stone boxes, and the courses proud of a
// wall. Cloth, lamps and the pit spikes are not in here.
import * as THREE from 'three';

const ROOTS = [];
const MESHES = [];
const BOXES = [];

export function registerClimbable(root, artifact) {
  if (!root) return;
  ROOTS.push(root);
  root.traverse(o => {
    if (!o.isMesh) return;
    o.userData.artifact = !!artifact;
    MESHES.push(o);
  });
}

let _ready = -1;
function refresh() {
  const t = typeof performance !== 'undefined' ? (performance.now() | 0) : 0;
  if (_ready === t) return;
  _ready = t;
  for (const r of ROOTS) if (r.parent) r.updateMatrixWorld(true);
  for (let i = 0; i < MESHES.length; i++) {
    const b = BOXES[i] || (BOXES[i] = new THREE.Box3());
    // A merged batch's bounds span half the level: as a solid box it would read
    // as "inside stone" almost everywhere. Its collision is the walls and the
    // baked grid; its surface is still a climb target for the hands.
    if (MESHES[i].userData.merged) b.makeEmpty();
    else if (MESHES[i].parent && surfaceVisible(MESHES[i])) b.setFromObject(MESHES[i]);
    else b.makeEmpty();
  }
}

export function climbTargets() {
  refresh();
  return MESHES;
}

// World-space bounds of everything a body cannot enter. Empty until the
// scene exists, so the movement suites (which never build meshes) are unchanged.
export function solidBoxes() {
  refresh();
  return BOXES;
}

export function surfaceVisible(obj) {
  for (let o = obj; o; o = o.parent) if (o.visible === false) return false;
  return true;
}
