import * as THREE from 'three';

// Procedural PBR textures generated on a canvas (no network needed). Each returns {map,normalMap,roughnessMap}.
function hash(x,y){ let n=Math.sin(x*127.1+y*311.7)*43758.5453; return n-Math.floor(n); }
function vnoise(x,y){ const xi=Math.floor(x),yi=Math.floor(y),xf=x-xi,yf=y-yi;
  const u=xf*xf*(3-2*xf),v=yf*yf*(3-2*yf);
  const a=hash(xi,yi),b=hash(xi+1,yi),c=hash(xi,yi+1),d=hash(xi+1,yi+1);
  return a+(b-a)*u+(c-a)*v+(a-b+d-c)*u*v; }
function fbm(x,y,oct=5){ let s=0,amp=0.5,f=1; for(let i=0;i<oct;i++){ s+=amp*vnoise(x*f,y*f); f*=2; amp*=0.5; } return s; }

function heightField(size,scale,oct){ const h=new Float32Array(size*size);
  for(let y=0;y<size;y++)for(let x=0;x<size;x++) h[y*size+x]=fbm(x/size*scale,y/size*scale,oct); return h; }

function normalFromHeight(h,size,strength=2.2){ const c=document.createElement('canvas'); c.width=c.height=size; const ctx=c.getContext('2d'); const img=ctx.createImageData(size,size); const d=img.data;
  const at=(x,y)=>h[((y+size)%size)*size+((x+size)%size)];
  for(let y=0;y<size;y++)for(let x=0;x<size;x++){ const dx=(at(x-1,y)-at(x+1,y))*strength, dy=(at(x,y-1)-at(x,y+1))*strength;
    const len=Math.hypot(dx,dy,1); const i=(y*size+x)*4;
    d[i]=(dx/len*0.5+0.5)*255; d[i+1]=(dy/len*0.5+0.5)*255; d[i+2]=(1/len*0.5+0.5)*255; d[i+3]=255; }
  ctx.putImageData(img,0,0); const t=new THREE.CanvasTexture(c); t.wrapS=t.wrapT=THREE.RepeatWrapping; return t; }

function canvasTex(size,draw,{srgb=true,repeat=1}={}){ const c=document.createElement('canvas'); c.width=c.height=size; const ctx=c.getContext('2d'); draw(ctx,size);
  const t=new THREE.CanvasTexture(c); t.wrapS=t.wrapT=THREE.RepeatWrapping; t.repeat.set(repeat,repeat); t.anisotropy=8; if(srgb)t.colorSpace=THREE.SRGBColorSpace; return t; }

// `dry` switches the palette from jungle moss to dry tomb limestone. The moss
// version paints green as the DOMINANT channel (g = 60 + n*30 + moss*28), which
// is correct for a rainforest floor and is why the sealed tomb read as a lawn.
export function mossStone(size=512, dry=false){ const h=heightField(size,7,6);
  const sstep=(e0,e1,x)=>{ const t=Math.min(1,Math.max(0,(x-e0)/(e1-e0))); return t*t*(3-2*t); };
  const map=canvasTex(size,(ctx)=>{ const img=ctx.createImageData(size,size),d=img.data;
    for(let y=0;y<size;y++)for(let x=0;x<size;x++){ const n=h[y*size+x];
      // The crack used to be a hard `> 0.62` cut straight to near-black, which
      // stamped hard-edged dark blobs across the floor and tiled visibly. Blend it.
      const crack=fbm(x/size*18+5,y/size*18,3);
      const c=sstep(0.52,0.74,crack);
      // large-scale drift breaks up the repeat; fine grain adds surface tooth
      const drift=fbm(x/size*2.1+11,y/size*2.1+3,2);
      const grain=fbm(x/size*64,y/size*64,2);
      const moss=Math.min(1,Math.max(0,(n-0.32)*2.1))*(0.55+drift*0.75);
      let r,g,b;
      if(dry){
        // Pale limestone with silt settled in the low spots: warm, slightly red,
        // and NEVER green-dominant. Silt collects where the height field dips.
        const silt=Math.min(1,Math.max(0,(0.52-n)*2.3))*(0.5+drift*0.7);
        r=104+n*30+silt*16+drift*11+grain*8;
        g= 99+n*29+silt*15+drift*10+grain*8;
        b= 86+n*24+silt*11+drift*8 +grain*7;
        r+=(44-r)*c*0.8; g+=(40-g)*c*0.8; b+=(34-b)*c*0.8;   // cracks go dark warm
      } else {
        r=42+n*26-moss*16+drift*10+grain*7;
        g=60+n*30+moss*28+drift*12+grain*7;
        b=48+n*20-moss*4 +drift*8 +grain*6;
        r+= (30-r)*c*0.75; g+=(42-g)*c*0.75; b+=(40-b)*c*0.75;
      }
      const i=(y*size+x)*4; d[i]=r;d[i+1]=g;d[i+2]=b;d[i+3]=255; }
    ctx.putImageData(img,0,0); });
  const roughnessMap=canvasTex(size,(ctx)=>{ const img=ctx.createImageData(size,size),d=img.data;
    for(let y=0;y<size;y++)for(let x=0;x<size;x++){ const n=h[y*size+x]; const v=200-n*90; const i=(y*size+x)*4; d[i]=d[i+1]=d[i+2]=v; d[i+3]=255; } ctx.putImageData(img,0,0); },{srgb:false});
  return { map, normalMap:normalFromHeight(h,size,2.6), roughnessMap }; }

// Periodic value noise. `period` is an integer lattice the texture wraps on,
// so a repeat of the canvas has no seam and no tile edge.
function vnoiseWrap(x, y, period, seed) {
  const xi = Math.floor(x), yi = Math.floor(y);
  const xf = x - xi, yf = y - yi;
  const su = xf * xf * (3 - 2 * xf), sv = yf * yf * (3 - 2 * yf);
  const P = period | 0;
  const h = (ix, iy) => {
    const a = ((ix % P) + P) % P, b = ((iy % P) + P) % P;
    return hash(a + seed * 13.1, b - seed * 7.7);
  };
  const a = h(xi, yi), b = h(xi + 1, yi), c = h(xi, yi + 1), d = h(xi + 1, yi + 1);
  return a + (b - a) * su + (c - a) * sv + (a - b + d - c) * su * sv;
}
function fbmWrap(u, v, oct, period, seed) {
  let s = 0, amp = 0.5, f = 1, norm = 0;
  for (let i = 0; i < oct; i++) {
    const p = period * f;
    s += amp * vnoiseWrap(u * p, v * p, p, seed + i * 17);
    norm += amp; f *= 2; amp *= 0.5;
  }
  return s / norm;
}

// Worn limestone. Low-frequency fields are built small and sampled smoothly;
// the 2048 canvas only adds grain. No filled polygon, no rectangle, no brick.
function field(n, period, oct, seed) {
  const a = new Float32Array(n * n);
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++)
    a[y * n + x] = fbmWrap(x / n, y / n, oct, period, seed);
  return a;
}
function sample(a, n, u, v) {
  const x = ((u % 1) + 1) % 1 * n, y = ((v % 1) + 1) % 1 * n;
  const x0 = Math.floor(x) % n, y0 = Math.floor(y) % n;
  const x1 = (x0 + 1) % n, y1 = (y0 + 1) % n;
  const tx = x - Math.floor(x), ty = y - Math.floor(y);
  const b00 = a[y0 * n + x0], b10 = a[y0 * n + x1];
  const b01 = a[y1 * n + x0], b11 = a[y1 * n + x1];
  return b00 + (b10 - b00) * tx + (b01 - b00) * ty + (b00 - b10 - b01 + b11) * tx * ty;
}
function wornLimestone(size, seed, courses) {
  const N = 384;
  const driftF = field(N, 3, 4, seed);
  const grainF = field(N, 14, 3, seed + 4);
  const siltF = field(N, 5, 3, seed + 9);
  const crackF = field(N, 9, 3, seed + 2);
  const hairF = field(N, 18, 2, seed + 6);
  const wobF = courses ? field(N, 4, 2, seed + 15) : null;
  const alongF = courses ? field(N, 3, 2, seed + 21) : null;
  const h = new Float32Array(size * size);
  const map = canvasTex(size, (ctx) => {
    const img = ctx.createImageData(size, size), d = img.data;
    for (let y = 0; y < size; y++) {
      const v = y / size;
      for (let x = 0; x < size; x++) {
        const u = x / size;
        const drift = sample(driftF, N, u, v);
        const grain = sample(grainF, N, u, v);
        const grit = ((((x * 374761393 + y * 668265263) ^ 0x5bd1e995) * 1274126177) >>> 0) / 4294967296 - 0.5;
        const siltN = sample(siltF, N, u, v);
        const crackN = sample(crackF, N, u, v);
        const crack = Math.min(1, Math.max(0, 1 - Math.abs(crackN - 0.52) * 26));
        const hair = Math.min(1, Math.max(0, 1 - Math.abs(sample(hairF, N, u, v) - 0.5) * 40));
        const silt = Math.min(1, Math.max(0, (0.40 - siltN) * 3.2));
        const chip = Math.min(1, Math.max(0, (grain - 0.74) * 7));
        let joint = 0, bed = 0;
        if (courses) {
          const wobble = (sample(wobF, N, u, v) - 0.5) * 0.55;
          const beds = 7.5;
          const cv = v * beds + wobble;
          const course = Math.floor(cv);
          const local = cv - course;
          const along = (sample(alongF, N, u + course * 0.17, v) - 0.5) * 0.5;
          const cu = u * 2.3 + along + hash(course + seed, 2) * 0.37;
          const cl = cu - Math.floor(cu);
          const hJ = local < 0.04 || local > 0.978;
          const vJ = cl < 0.03 && hash(course + seed, Math.floor(u * 5 + 3)) > 0.48;
          joint = (hJ || vJ) ? 1 : 0;
          bed = (hash(course + seed, 5) - 0.5) * 0.05;
        }
        let r = 134 + (drift - 0.5) * 18 + (grain - 0.5) * 14 + grit * 10 + bed * 70;
        let g = 124 + (drift - 0.5) * 16 + (grain - 0.5) * 12 + grit * 9 + bed * 62;
        let b = 108 + (drift - 0.5) * 14 + (grain - 0.5) * 10 + grit * 8 + bed * 48;
        const dark = Math.min(1, crack * 0.5 + hair * 0.18 + joint * 0.62 + chip * 0.3);
        const siltAmt = Math.min(1, silt * (0.5 + joint * 0.4) + chip * 0.2);
        r = r * (1 - dark * 0.42) - siltAmt * 26;
        g = g * (1 - dark * 0.42) - siltAmt * 24;
        b = b * (1 - dark * 0.38) - siltAmt * 20;
        const i = (y * size + x) * 4;
        d[i] = Math.max(0, Math.min(255, r));
        d[i + 1] = Math.max(0, Math.min(255, g));
        d[i + 2] = Math.max(0, Math.min(255, b));
        d[i + 3] = 255;
        h[y * size + x] = 0.55 + (drift - 0.5) * 0.1 + (grain - 0.5) * 0.16
          - crack * 0.26 - hair * 0.06 - joint * 0.3 - silt * 0.14 - chip * 0.1;
      }
    }
    ctx.putImageData(img, 0, 0);
  });
  return { map, normalMap: normalFromHeight(h, size, 1.55), roughnessMap: null };
}

export function stoneWall(size = 2048) {
  return wornLimestone(size, 4, true);
}

// The hall floor. Grain, cracks and silt. No slab fill, no brick rectangles.
export function flagstone(size = 2048) {
  return wornLimestone(size, 11, false);
}

export function bark(size=256){ const map=canvasTex(size,(ctx,s)=>{ const img=ctx.createImageData(s,s),d=img.data;
    for(let y=0;y<s;y++)for(let x=0;x<s;x++){ const streak=fbm(x/s*4,y/s*40,4); const n=fbm(x/s*12,y/s*12,3);
      const v=streak*0.6+n*0.4; const i=(y*s+x)*4; d[i]=50+v*40;d[i+1]=36+v*28;d[i+2]=26+v*18;d[i+3]=255; } ctx.putImageData(img,0,0); },{repeat:1});
  return { map }; }

// Image-based lighting: a soft gradient equirect env for grounded reflections + ambient.
export function makeEnvironment(renderer, scene){
  const pmrem=new THREE.PMREMGenerator(renderer); pmrem.compileEquirectangularShader();
  const c=document.createElement('canvas'); c.width=512; c.height=256; const ctx=c.getContext('2d');
  // An INTERIOR environment, not a sky. The old gradient was teal (#bfe9e4 ->
  // #4e8f8a -> #0c1f1c) and every PBR surface in the tomb sampled it, which put
  // a green cast on the entire level no matter what the albedo said. A sealed
  // room reflects its own walls: dark warm stone, with one cold patch overhead
  // where the collapse lets daylight in, and a warm floor bounce from torches.
  const g=ctx.createLinearGradient(0,0,0,256);
  g.addColorStop(0,'#2b2f33'); g.addColorStop(0.42,'#1b1a18');
  g.addColorStop(0.62,'#17130f'); g.addColorStop(1,'#0d0b09');
  ctx.fillStyle=g; ctx.fillRect(0,0,512,256);
  // the shaft: one cold opening overhead
  const sg=ctx.createRadialGradient(150,46,0,150,46,78);
  sg.addColorStop(0,'rgba(188,216,232,0.95)'); sg.addColorStop(1,'rgba(188,216,232,0)');
  ctx.fillStyle=sg; ctx.fillRect(60,0,180,140);
  // torchlight bounced off the floor, which is most of what a tomb reflects
  const fg=ctx.createLinearGradient(0,170,0,256);
  fg.addColorStop(0,'rgba(120,68,28,0)'); fg.addColorStop(1,'rgba(150,86,34,0.55)');
  ctx.fillStyle=fg; ctx.fillRect(0,170,512,86);
  const tex=new THREE.CanvasTexture(c); tex.mapping=THREE.EquirectangularReflectionMapping; tex.colorSpace=THREE.SRGBColorSpace;
  const env=pmrem.fromEquirectangular(tex).texture; scene.environment=env; tex.dispose(); pmrem.dispose(); return env;
}

// ---------------------------------------------------------------------------
// CUT STONE. The limestone generator above drew its "cracks" from a sharply
// thresholded noise field, which is what covered every surface in the tomb in
// wandering dark lines — it read as doodled, not built. These two are laid out
// the way masons lay stone: courses of blocks with recessed mortar for walls,
// staggered slabs for floors. Each block carries its own tone, a worn bevel in
// the normal map, fine grain, and only rarely a short hairline crack.
//
// Both tile over TILE metres and are sampled with world-space UVs
// (world.js: worldUV), so courses run level and continuous from one wall to
// the next instead of restarting at every box corner.
// ---------------------------------------------------------------------------
export const STONE_TILE = 4.8;               // metres one copy of a stone map covers

export function prng(seed) { return () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 4294967296; }; }

// rows: [{ y0, y1, blocks:[{x0,x1,tone,warm,crack}] }] across a 0..1 tile
function layRows(rnd, rowsN, minL, maxL) {
  const rows = [];
  for (let r = 0; r < rowsN; r++) {
    const y0 = r / rowsN, y1 = (r + 1) / rowsN;
    const blocks = [];
    let x = rnd() * maxL;                    // stagger: every course starts somewhere else
    const start = x;
    while (x < start + 1 - 1e-6) {
      const len = Math.min(minL + rnd() * (maxL - minL), start + 1 - x);
      // tone: each stone from a different bed in the quarry; age: some blocks
      // are greyed and pitted where others are still warm and tight-grained
      blocks.push({ x0: x, x1: x + len, tone: (rnd() - 0.5) * 0.26, warm: (rnd() - 0.5) * 0.12, age: rnd(),
        crack: rnd() < 0.12 ? { a: rnd() * Math.PI, o: rnd(), w: 0.3 + rnd() * 0.5 } : null, pit: rnd() });
      x += len;
    }
    rows.push({ y0, y1, blocks });
  }
  return rows;
}

function cutStone(size, { seed, rows, minL, maxL, joint, bevel, base, mortar, grainAmt }) {
  const rnd = prng(seed);
  const lay = layRows(rnd, rows, minL, maxL);
  const N = 256, grainF = field(N, 24, 3, seed + 3), mottleF = field(N, 4, 3, seed + 8), stainF = field(N, 2, 2, seed + 13);
  const h = new Float32Array(size * size);
  const map = canvasTex(size, ctx => {
    const img = ctx.createImageData(size, size), d = img.data;
    for (let py = 0; py < size; py++) {
      const v = py / size;
      const row = lay[Math.min(lay.length - 1, Math.floor(v * rows))];
      const rh = row.y1 - row.y0;
      const dyEdge = Math.min(v - row.y0, row.y1 - v) / rh;            // 0 at a bed joint
      for (let px = 0; px < size; px++) {
        const u = px / size;
        // which block (the row wraps horizontally)
        let uu = u; if (uu < row.blocks[0].x0) uu += 1;
        let blk = row.blocks[row.blocks.length - 1];
        for (const b of row.blocks) if (uu >= b.x0 && uu < b.x1) { blk = b; break; }
        const bw = blk.x1 - blk.x0;
        const dxEdge = Math.min(uu - blk.x0, blk.x1 - uu);
        // distance to the nearest joint, in tile units, then as a fraction of joint width
        const dEdge = Math.min(dxEdge, dyEdge * rh);
        // Chipped arrises: the bevel is eaten back unevenly along every edge,
        // so no two blocks meet in the same clean line.
        const chipN = sample(grainF, N, u * 2.7 + 0.3, v * 2.7);
        const jw = joint * (1 + Math.max(0, chipN - 0.62) * 9);
        const inJoint = dEdge < jw;
        const bev = inJoint ? 0 : Math.min(1, (dEdge - jw) / bevel);
        // grime that has settled into and beside the joints
        const grime = Math.max(0, 1 - (dEdge - jw) / (bevel * 3.5));
        const grain = sample(grainF, N, u, v), mottle = sample(mottleF, N, u, v), stain = sample(stainF, N, u, v);
        const grit = ((((px * 374761393 + py * 668265263) ^ 0x5bd1e995) * 1274126177) >>> 0) / 4294967296 - 0.5;
        // a short hairline inside the block, never across a joint
        let crack = 0;
        if (blk.crack && !inJoint) {
          const cx = (uu - blk.x0) / bw - blk.crack.o, cy = (v - row.y0) / rh - 0.5;
          const along = cx * Math.cos(blk.crack.a) + cy * Math.sin(blk.crack.a);
          const off = -cx * Math.sin(blk.crack.a) + cy * Math.cos(blk.crack.a) + (grain - 0.5) * 0.06;
          if (Math.abs(along) < blk.crack.w * 0.5) crack = Math.max(0, 1 - Math.abs(off) * size * rh * 0.9);
        }
        const pit = grain > 0.8 ? (grain - 0.8) * 5 : 0;
        const old = Math.max(0, blk.age - 0.55) * 2.2;                 // 0 young .. 1 weathered
        let k = 1 + blk.tone + (mottle - 0.5) * 0.2 + (grain - 0.5) * grainAmt * (1 + old) + grit * 0.06
                  - (1 - bev) * 0.08 - grime * 0.16 - pit * (0.12 + old * 0.2) - crack * 0.35
                  - Math.max(0, 0.45 - stain) * 0.3 - old * 0.07;
        let r = base[0] * k * (1 + blk.warm - old * 0.05), g = base[1] * k, bb = base[2] * k * (1 - blk.warm + old * 0.05);
        if (inJoint) { const m = 0.85 + grit * 0.2; r = mortar[0] * m; g = mortar[1] * m; bb = mortar[2] * m; }
        const i = (py * size + px) * 4;
        d[i] = Math.max(0, Math.min(255, r)); d[i + 1] = Math.max(0, Math.min(255, g)); d[i + 2] = Math.max(0, Math.min(255, bb)); d[i + 3] = 255;
        h[py * size + px] = inJoint ? 0.05 : 0.35 + 0.65 * Math.sqrt(bev) + (grain - 0.5) * (0.08 + old * 0.1) - pit * (0.12 + old * 0.15) - crack * 0.3
          + (mottle - 0.5) * 0.12;
      }
    }
    ctx.putImageData(img, 0, 0);
  });
  return { map, normalMap: normalFromHeight(h, size, 2.4) };
}

// Coursed ashlar for every vertical face: 8 courses over the tile, 0.6 m each.
export function ashlar(size = 1024) {
  return cutStone(size, { seed: 31, rows: 8, minL: 0.17, maxL: 0.36, joint: 0.0028, bevel: 0.006,
    base: [168, 150, 122], mortar: [92, 82, 68], grainAmt: 0.12 });
}
// Floor slabs: larger, squarer, worn smoother.
export function slabs(size = 1024) {
  return cutStone(size, { seed: 47, rows: 4, minL: 0.2, maxL: 0.34, joint: 0.0024, bevel: 0.004,
    base: [160, 146, 122], mortar: [84, 76, 62], grainAmt: 0.09 });
}
