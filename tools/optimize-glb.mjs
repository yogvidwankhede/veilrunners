// Optimize a Meshy GLB for web: simplify geometry + 1K webp textures. No decoders needed at runtime.
// Usage: node tools/optimize-glb.mjs <in.glb> <out.glb> [ratio=0.03] [texSize=1024]
// Needs: npm i @gltf-transform/core @gltf-transform/extensions @gltf-transform/functions meshoptimizer sharp
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { weld, simplify, textureCompress, prune, dedup } from '@gltf-transform/functions';
import { MeshoptSimplifier } from 'meshoptimizer';
import sharp from 'sharp';
const [,, inf, outf, ratio='0.03', tex='1024'] = process.argv;
const io = new NodeIO().registerExtensions(ALL_EXTENSIONS); await MeshoptSimplifier.ready;
const doc = await io.read(inf);
const tris = () => doc.getRoot().listMeshes().flatMap(m=>m.listPrimitives()).reduce((n,p)=>n+(p.getIndices()?.getCount()||0)/3,0);
const before = tris();
await doc.transform(dedup(), weld({tolerance:0.0001}),
  simplify({ simplifier: MeshoptSimplifier, ratio: parseFloat(ratio), error: 0.01, lockBorder:false }),
  textureCompress({ encoder: sharp, targetFormat:'webp', resize:[+tex,+tex], quality:80 }), prune());
await io.write(outf, doc);
const fs = await import('node:fs');
console.log(`${outf}: faces ${Math.round(before)} -> ${Math.round(tris())}, ${(fs.statSync(outf).size/1024/1024).toFixed(2)} MB`);
