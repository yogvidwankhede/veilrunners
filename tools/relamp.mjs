// Re-derive ONLY the lamp placements from level.anchorLamps(), in place.
//
// placements.json bakes positions that anchorLamps() computed at generation
// time, so changing LAMP_STANDOFF (or adding walls a lamp can now bracket to)
// does not reach the props until they are re-derived. The full generator talks
// to the Meshy API to make models; this only moves existing ones, so it needs
// no key and touches nothing else in the file.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { anchorLamps } from '../src/level.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const f = path.join(ROOT, 'placements.json');
const pl = JSON.parse(fs.readFileSync(f, 'utf8'));
const A = anchorLamps();

const before = { wall: pl.wall_lamp?.at?.length ?? 0, floor: pl.floor_lamp?.at?.length ?? 0 };
if (pl.wall_lamp)
  pl.wall_lamp.at = A.filter(L => L.kind === 'wall').map(L => ({ x: L.x, y: L.y, z: L.z - 0.45, ry: L.ry }));
if (pl.floor_lamp)
  pl.floor_lamp.at = A.filter(L => L.kind === 'floor').map(L => ({ x: L.x, y: L.y, z: L.z, ry: 0 }));

fs.writeFileSync(f, JSON.stringify(pl, null, 1));
console.log(`wall lamps  ${before.wall} -> ${pl.wall_lamp.at.length}`);
console.log(`floor lamps ${before.floor} -> ${pl.floor_lamp.at.length}`);
console.log('placements.json rewritten (lamps only)');
