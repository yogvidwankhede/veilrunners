// Convert a single-mesh GLB into the OBJ+MTL+texture zip that Mixamo's
// auto-rigger accepts. Mixamo takes FBX/OBJ/ZIP, never GLB, and there is no
// Blender or FBX toolchain on this machine — so we write the OBJ ourselves.
//
//   node tools/glb-to-mixamo.mjs assets/runner.glb out/
//
// Upload the resulting .zip at mixamo.com -> Upload Character.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const [,, inGlb, outDirArg] = process.argv;
if (!inGlb) { console.error('usage: node tools/glb-to-mixamo.mjs <in.glb> [outDir]'); process.exit(1); }
const outDir = outDirArg || 'mixamo-upload';
fs.mkdirSync(outDir, { recursive: true });
const base = path.basename(inGlb, '.glb');

// ---- parse the GLB container ----
const buf = fs.readFileSync(inGlb);
if (buf.readUInt32LE(0) !== 0x46546C67) throw new Error('not a GLB');
const total = buf.readUInt32LE(8);
let off = 12, json = null, bin = null;
while (off < total) {
  const len = buf.readUInt32LE(off), type = buf.readUInt32LE(off + 4);
  const chunk = buf.subarray(off + 8, off + 8 + len);
  if (type === 0x4E4F534A) json = JSON.parse(chunk.toString('utf8'));
  if (type === 0x004E4942) bin = chunk;
  off += 8 + len;
}
const g = json;
if ((g.meshes || []).length !== 1) console.warn(`! ${g.meshes.length} meshes; Mixamo wants one. Merging all primitives.`);

// Buffer method names, not glTF type names: Node has readFloatLE, NOT
// readFloat32LE. Getting this wrong reads raw bytes and every coordinate
// silently lands in 0..255.
const COMP = { 5120: [1, 'readInt8'],    5121: [1, 'readUInt8'],
               5122: [2, 'readInt16LE'], 5123: [2, 'readUInt16LE'],
               5125: [4, 'readUInt32LE'], 5126: [4, 'readFloatLE'] };
const NUM = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4 };

function read(accIdx) {
  const a = g.accessors[accIdx];
  const [sz, method] = COMP[a.componentType] || [];
  if (!method) throw new Error('unsupported componentType ' + a.componentType);
  const n = NUM[a.type];
  const bv = g.bufferViews[a.bufferView];
  const stride = bv.byteStride || sz * n;
  const start = (bv.byteOffset || 0) + (a.byteOffset || 0);
  const get = bin[method].bind(bin);
  const out = new Array(a.count * n);
  for (let i = 0; i < a.count; i++)
    for (let c = 0; c < n; c++) out[i * n + c] = get(start + i * stride + c * sz);
  return out;
}

// ---- write the OBJ (positions / UVs / normals, one shared vertex stream) ----
const lines = [`# ${base} exported for Mixamo auto-rig`, `mtllib ${base}.mtl`, `o ${base}`];
let vBase = 1, tris = 0;
for (const mesh of g.meshes) for (const prim of mesh.primitives) {
  const P = read(prim.attributes.POSITION);
  const N = prim.attributes.NORMAL != null ? read(prim.attributes.NORMAL) : null;
  const T = prim.attributes.TEXCOORD_0 != null ? read(prim.attributes.TEXCOORD_0) : null;
  const count = P.length / 3;
  for (let i = 0; i < count; i++) lines.push(`v ${P[i*3].toFixed(6)} ${P[i*3+1].toFixed(6)} ${P[i*3+2].toFixed(6)}`);
  // glTF UVs have v pointing down, OBJ has it pointing up
  if (T) for (let i = 0; i < count; i++) lines.push(`vt ${T[i*2].toFixed(6)} ${(1 - T[i*2+1]).toFixed(6)}`);
  if (N) for (let i = 0; i < count; i++) lines.push(`vn ${N[i*3].toFixed(6)} ${N[i*3+1].toFixed(6)} ${N[i*3+2].toFixed(6)}`);
  lines.push(`usemtl ${base}_mat`, 's 1');
  const idx = prim.indices != null ? read(prim.indices) : [...Array(count).keys()];
  const f = i => { const k = vBase + i; return T && N ? `${k}/${k}/${k}` : T ? `${k}/${k}` : N ? `${k}//${k}` : `${k}`; };
  for (let i = 0; i < idx.length; i += 3) { lines.push(`f ${f(idx[i])} ${f(idx[i+1])} ${f(idx[i+2])}`); tris++; }
  vBase += count;
}
fs.writeFileSync(path.join(outDir, `${base}.obj`), lines.join('\n') + '\n');

// ---- base colour texture: Mixamo will not read webp, so transcode via sips ----
let texName = '';
const mat = (g.materials || [])[0];
const texIdx = mat?.pbrMetallicRoughness?.baseColorTexture?.index;
if (texIdx != null) {
  const tex = g.textures[texIdx];
  const src = tex.source ?? tex.extensions?.EXT_texture_webp?.source;
  const img = g.images[src];
  const bv = g.bufferViews[img.bufferView];
  const bytes = bin.subarray(bv.byteOffset || 0, (bv.byteOffset || 0) + bv.byteLength);
  const ext = (img.mimeType || '').includes('webp') ? 'webp' : (img.mimeType || '').includes('png') ? 'png' : 'jpg';
  const raw = path.join(outDir, `${base}_base.${ext}`);
  fs.writeFileSync(raw, bytes);
  texName = `${base}_base.png`;
  if (ext === 'png') texName = path.basename(raw);
  else {
    try {
      execFileSync('sips', ['-s', 'format', 'png', raw, '--out', path.join(outDir, texName)], { stdio: 'pipe' });
      fs.unlinkSync(raw);
    } catch (e) { texName = path.basename(raw); console.warn('! sips transcode failed, shipping', texName); }
  }
}
fs.writeFileSync(path.join(outDir, `${base}.mtl`),
  [`newmtl ${base}_mat`, 'Ka 1 1 1', 'Kd 1 1 1', 'Ks 0 0 0', 'd 1', 'illum 2',
   texName ? `map_Kd ${texName}` : ''].filter(Boolean).join('\n') + '\n');

// ---- zip it ----
const zip = `${base}-mixamo.zip`;
try {
  const parts = fs.readdirSync(outDir).filter(f => f !== zip);
  execFileSync('zip', ['-j', '-q', zip, ...parts], { cwd: path.resolve(outDir), stdio: 'pipe' });
} catch (e) { console.warn('! zip failed:', e.message); }

const kb = f => Math.round(fs.statSync(path.join(outDir, f)).size / 1024);
console.log(`vertices ${vBase - 1}, triangles ${tris}`);
for (const f of fs.readdirSync(outDir)) console.log(`  ${f}  ${kb(f)} KB`);
console.log(`\nMixamo auto-rig limit is 150k triangles — this is ${tris} (${(tris/150000*100).toFixed(0)}%).`);
