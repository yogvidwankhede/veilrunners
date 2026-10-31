// The inputs a collision bake depends on. When this changes the bake is stale.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
export function bakeHash() {
  const h = crypto.createHash('sha1');
  h.update(fs.readFileSync(path.join(root, 'placements.json')));
  h.update(fs.readFileSync(path.join(root, 'src/level.js')));
  h.update(fs.readFileSync(path.join(root, 'src/world.js')));        // the masonry it bakes
  return h.digest('hex').slice(0, 12);
}
