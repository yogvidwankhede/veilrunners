import * as THREE from 'three';
import { MAP, S } from './constants.js';
import { WATER, ROOMS, anchorLamps, roomAt } from './level.js';
import { flagstone, stoneWall, bark, makeEnvironment, ashlar, slabs, STONE_TILE, prng } from './textures.js';
import { wearMasonry } from './stonewear.js';
import { registerClimbable } from './climbable.js';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

// world-game (x:0..1200, y:0..900) -> 3D (X right, Z toward camera-south). Y up.
export const CX = MAP.w / 2, CZ = MAP.h / 2;
export const to3 = (gx, gy) => new THREE.Vector3((gx - CX) * S, 0, (gy - CZ) * S);
export const ARENA = { w: MAP.w * S, h: MAP.h * S };

function rng(seed){return()=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed/4294967296;};}

// BoxGeometry lays each face's UVs across 0..1, so a long wall showed one
// stretched copy of the map. Scale by the face size. The map is irregular
// broken stone, and 0.28 repeats per metre keeps the blocks large and uneven
// rather than a brick stamp.
// WORLD-SPACE UVs. Every stone surface takes its texture coordinates from where
// it actually is: a vertical face from (along the face, height), a horizontal
// one from (x, z), in units of STONE_TILE metres. Courses therefore run level
// and unbroken across neighbouring boxes, the way one built wall would, and
// nothing is ever stretched. Call after the mesh is positioned.
function worldUV(mesh) {
  mesh.updateMatrixWorld(true);
  const geo = mesh.geometry, pos = geo.attributes.position, nrm = geo.attributes.normal, uv = geo.attributes.uv;
  const v = new THREE.Vector3(), n = new THREE.Vector3(), nm = new THREE.Matrix3().getNormalMatrix(mesh.matrixWorld);
  const k = 1 / STONE_TILE;
  for (let i = 0; i < pos.count; i++) {
    v.fromBufferAttribute(pos, i).applyMatrix4(mesh.matrixWorld);
    n.fromBufferAttribute(nrm, i).applyMatrix3(nm).normalize();
    const ax = Math.abs(n.x), ay = Math.abs(n.y), az = Math.abs(n.z);
    if (ay >= ax && ay >= az) uv.setXY(i, v.x * k, v.z * k);
    else if (ax >= az) uv.setXY(i, v.z * k * Math.sign(n.x || 1), v.y * k);
    else uv.setXY(i, -v.x * k * Math.sign(n.z || 1), v.y * k);
  }
  uv.needsUpdate = true;
}

function tileBoxUVs(geo, sx, sy, sz) {
  const uv = geo.attributes.uv;
  const m = 0.28;
  const scales = [[sz, sy], [sz, sy], [sx, sz], [sx, sz], [sx, sy], [sx, sy]];
  for (let f = 0; f < 6; f++) {
    const [u, v] = scales[f];
    for (let i = 0; i < 4; i++) {
      const k = f * 4 + i;
      uv.setXY(k, uv.getX(k) * u * m, uv.getY(k) * v * m);
    }
  }
  uv.needsUpdate = true;
}

export function buildWorld(scene, renderer) {
  const R = rng(7);
  const g = new THREE.Group(); scene.add(g);

  // ---------- sky + fog ----------
  // Denser and darker than the old open arena: this is a space with a ceiling,
  // where depth comes from torchlight falling off, not haze over a horizon.
  // 0.038, measured against the room spacing: neighbouring rooms sit 11-18 m
  // apart and come out 20-35% fogged (depth, still readable), while far rooms
  // at 25-50 m come out 59-97% fogged and effectively stop existing. That is
  // the "I can see every trap in the tomb from here" fix. Warm near-black,
  // because the haze in here is lit from a lava lake, not from a blue sky.
  // Warm dust rather than black: distance should read as air in a lamp-lit
  // room, not as the edge of the world.
  scene.fog = new THREE.FogExp2(0x1c130c, 0.036);   // depth, not a blindfold
  const sky = new THREE.Mesh(new THREE.SphereGeometry(400, 32, 16),
    new THREE.ShaderMaterial({ side: THREE.BackSide, uniforms:{top:{value:new THREE.Color(0x070d10)},bot:{value:new THREE.Color(0x1a0a04)}},
      vertexShader:'varying vec3 p;void main(){p=position;gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.);}',
      fragmentShader:'varying vec3 p;uniform vec3 top;uniform vec3 bot;void main(){float h=clamp(p.y/300.+.3,0.,1.);gl_FragColor=vec4(mix(bot,top,h),1.);}'}));
  scene.add(sky);

  // ---------- lights ----------
  // There is no sun in a sealed tomb. What is left is a shaft of daylight
  // through the collapse above the entrance, and the torches. The old warm
  // 2.1-intensity key light is why this read as an outdoor clearing no matter
  // what geometry sat underneath it.
  // 0.30 was enough ambient to read an unlit chamber from across the tomb. At
  // 0.12 a room with no fire in it is genuinely dark, which is what makes the
  // discovery system do anything at all.
  // LIT. Blacking out undiscovered chambers made the tomb hard to read rather
  // than mysterious — you could not see where you were going. Progression is
  // gated by the PORTCULLIS now (level.js: gate_causeway), which is the honest
  // way round: you get to see the counted floor breathing from the chamber and
  // then have to earn your way onto it.
  // The GROUND half of the hemisphere is the lava's contribution to every
  // surface in the tomb. A hemisphere light is already in every material's
  // shader, so bouncing the lava up this way costs nothing, where lighting the
  // whole shaft with real point lights from below would cost a light per
  // fragment. The sky half stays cold so the contrast still reads as stone.
  // The sky half was 0x45515c, a cold blue-grey. Against pale stone and almost
  // no direct light the whole tomb came out teal — damp jungle, not dry burial
  // chamber. Neutral-warm, and brighter, because the chamber walls present
  // large faces that no lamp reaches and those were reading as black mass.
  const hemi = new THREE.HemisphereLight(0x5a5248, 0x5e2208, 0.78); scene.add(hemi);
  const sun = new THREE.DirectionalLight(0xbcd8e8, 0.78);
  sun.position.set(16, 52, 10); sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  const sc = sun.shadow.camera; sc.near = 1; sc.far = 160; sc.left=-45; sc.right=45; sc.top=38; sc.bottom=-38; sc.updateProjectionMatrix();
  sun.shadow.bias = -0.0004; sun.shadow.normalBias = 0.02;
  scene.add(sun); scene.add(sun.target);
  // Warm and dim. A cold blue fill painted the runner and every wall the same
  // cyan, which is what made the figure read as an untextured doll.
  const fill = new THREE.DirectionalLight(0x6b5344, 0.1); fill.position.set(-20, 18, -24); scene.add(fill);
  // the shaft itself, over the entrance hall, so the way in reads as the way out
  const shaft = new THREE.SpotLight(0xdcefff, 26, 70, 0.44, 0.65, 1.5);
  const shaftAt = to3(170, 420); shaft.position.set(shaftAt.x, 28, shaftAt.z);
  shaft.target.position.set(shaftAt.x, 0, shaftAt.z);
  scene.add(shaft); scene.add(shaft.target);
  makeEnvironment(renderer, scene); // IBL reflections + ambient
  // (the old 2048 px limestone with the noise "cracks" is no longer generated)
  // the cut stone every built surface now wears (textures.js: ashlar, slabs)
  const ashT = ashlar(1024), slabT = slabs(1024);

  // ---------- the lava floor, far below ----------
  // This used to be a 0x02090b plane: functionally black, so the shaft read as
  // nothing rather than as a drop. Lava does three jobs at once — it tells you
  // how far down "down" is, it justifies the warm light in a sealed tomb, and
  // it makes the abyss read as lethal before you test whether it is.
  //
  // Crust and cracks come from the same fbm: the crust is where the noise is
  // high, the glow is the inverse raised to a power so the bright veins are
  // thin. Two slow domain-warped flows make it creep rather than scroll, which
  // is what stops it reading as a texture sliding under a sheet of glass.
  const lavaMat = new THREE.MeshStandardMaterial({
    color: 0x120503, roughness: 1, metalness: 0, emissive: 0xff4a0a });
  lavaMat.userData.uT = { value: 0 };
  lavaMat.onBeforeCompile = (sh) => {
    sh.uniforms.uT = lavaMat.userData.uT;
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec2 vLava;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\n  vLava = position.xy;');
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', `#include <common>
        uniform float uT; varying vec2 vLava;
        float h21(vec2 p){ return fract(sin(dot(p, vec2(127.1,311.7))) * 43758.5453); }
        float vnoise(vec2 p){ vec2 i=floor(p), f=fract(p); f=f*f*(3.0-2.0*f);
          return mix(mix(h21(i), h21(i+vec2(1,0)), f.x),
                     mix(h21(i+vec2(0,1)), h21(i+vec2(1,1)), f.x), f.y); }
        float fbm(vec2 p){ float a=0.5, s=0.0;
          for(int i=0;i<4;i++){ s+=a*vnoise(p); p*=2.03; a*=0.5; } return s; }`)
      .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
        // 0.42, not 0.055. The plane is 600 units across and position.xy runs
        // -300..300, so 0.055 put roughly 33 noise cells over the whole lake —
        // 18 m per cell, which rendered as a blurry beige smear rather than as
        // lava. This gives ~1.2 m features, which is the scale crust breaks at.
        vec2 lp = vLava * 0.42;
        vec2 flow = vec2(fbm(lp*0.35 + uT*0.013), fbm(lp*0.35 - uT*0.011));
        float n = fbm(lp + flow*1.4 + vec2(0.0, uT*0.02));
        // Mostly CRUST with thin bright veins. The previous thresholds left
        // most of the surface glowing at emissive 2.9, and ACES tone mapping
        // desaturates anything that bright straight to white — which is why a
        // lava lake came out the colour of sand.
        float crust = smoothstep(0.30, 0.56, n);
        // pow 5.5: the veins have to be NARROW. Anything wider and ACES tone
        // mapping pulls the large bright area toward white, which is what made
        // a lava lake look like cracked dry earth. Narrow and very saturated
        // survives tone mapping as orange; wide and bright never does.
        float crack = pow(1.0 - crust, 5.5);
        float pulse = 0.85 + 0.15*sin(uT*0.7 + n*9.0);
        // deep red everywhere except the thin cores, which run up to yellow
        vec3 hot = mix(vec3(1.0,0.075,0.004), vec3(1.0,0.52,0.08), pow(crack,1.5));
        totalEmissiveRadiance = hot * crack * 5.5 * pulse;
        // a dull ember glow in the crust itself, kept red so it cannot wash out
        totalEmissiveRadiance += vec3(0.10,0.014,0.004) * (1.0 - crust);
        diffuseColor.rgb = mix(vec3(0.010,0.004,0.003), vec3(0.040,0.014,0.009), crust);`);
  };
  const lava = new THREE.Mesh(new THREE.PlaneGeometry(600, 600, 1, 1), lavaMat);
  lava.rotation.x = -Math.PI/2; lava.position.y = -11; g.add(lava);
  // NOT receiveShadow: it is the light source here, and a shadow cast onto a
  // lava lake from the chambers above reads as a hole in the lava.

  // ---------- sanctuary platform ----------
  // There is floor ONLY west of the inner wall (level.js: the hall, x 40..360).
  // Everything east sits at 5 m or higher over PITS.the-abyss, and drawing a
  // slab under all of it was the biggest single reason this read as a clearing
  // with walls standing on it rather than chambers hung in a drowned shaft.
  const HALL = { x0: 28, x1: 368, y0: 28, y1: 872 };
  const hallW = (HALL.x1 - HALL.x0) * S, hallD = (HALL.y1 - HALL.y0) * S;
  const hallC = to3((HALL.x0 + HALL.x1) / 2, (HALL.y0 + HALL.y1) / 2);
  const plat = new THREE.Mesh(new THREE.BoxGeometry(hallW, 2.2, hallD),
    new THREE.MeshStandardMaterial({ color: 0x14201f, roughness: 0.95 }));
  // Top at -0.15. The stone floor sits at 0.01 but its carved verts span 9 cm,
  // not the ±1.5 cm once assumed, and a lid at -0.04 still punched through
  // the deep joints as black triangles all over the entrance hall. The mass
  // is only there so the hall has a side; it must stay under the lowest vertex.
  plat.position.set(hallC.x, -1.25, hallC.z); plat.receiveShadow = true; plat.castShadow = true; g.add(plat);

  // One large patch of broken stone, repeated only enough to cover the hall.
  // A small repeat is what turned the floor into a grid.
  const floorGeo = new THREE.PlaneGeometry(hallW, hallD, 46, 100);
  const pos = floorGeo.attributes.position;
  for (let i=0;i<pos.count;i++) {
    let z = (R()-0.5) * 0.05;
    if (R() < 0.08) z -= 0.045;
    pos.setZ(i, z);
  }
  floorGeo.computeVertexNormals();
  // The hall is paved, in the same slabs as every walkable top, mapped in
  // world space so the courses meet the walls' coping square.
  const gt = slabT;
  const floor = new THREE.Mesh(floorGeo, wearMasonry(new THREE.MeshStandardMaterial({
    map:gt.map, normalMap:gt.normalMap, color:0xf4ead8,
    normalScale:new THREE.Vector2(0.85, 0.85), roughness:0.92, metalness:0, envMapIntensity:0.12 }),
    { micro: 0.07, edge: 0.22, drip: 0.08, dust: 0.1, seed: 1 }));
  floor.rotation.x = -Math.PI/2; floor.position.set(hallC.x, 0.01, hallC.z); floor.receiveShadow = true; g.add(floor);
  worldUV(floor);

  // ---------- water (turquoise stream pool) ----------
  // Darker and far less emissive. The old turquoise glowed hard enough to be a
  // light source and read as a swimming pool rather than four centuries of
  // standing groundwater.
  const waterMat = new THREE.MeshPhysicalMaterial({ color:0x123c3e, roughness:0.22, metalness:0,
    transmission:0.45, transparent:true, opacity:0.9, emissive:0x05191b, emissiveIntensity:0.12, ior:1.33 });
  // The flood of beat 7, not a puddle in one chamber: it spans the whole tomb
  // and mech.js drives its height. It starts at WATER.start (below the floor),
  // so for the first six beats this is invisible and costs one hidden plane.
  // Sized to the ENTRANCE HALL until the flood. At full map size this plane sat
  // at -1.2 m across the whole tomb, and since the only floor is in the hall it
  // showed through every gap in the architecture as a bright teal sheet hanging
  // in the abyss. mech.syncVisuals expands it when beat 7 starts.
  const water = new THREE.Mesh(new THREE.PlaneGeometry(MAP.w*S, MAP.h*S, 40, 30), waterMat);
  water.rotation.x = -Math.PI/2;
  water.userData.hallScale = [ (HALL.x1-HALL.x0)/MAP.w, (HALL.y1-HALL.y0)/MAP.h ];
  water.userData.hallPos = to3((HALL.x0+HALL.x1)/2, (HALL.y0+HALL.y1)/2);
  water.userData.fullPos = to3(MAP.w/2, MAP.h/2);
  water.scale.set(water.userData.hallScale[0], water.userData.hallScale[1], 1);
  water.position.set(water.userData.hallPos.x, WATER.start, water.userData.hallPos.z);
  water.renderOrder = 2; g.add(water);
  water.userData.base = water.geometry.attributes.position.array.slice();
  g.userData.water = water;

  // ---------- perimeter cliffs + canopy trees ----------
  const stoneMat = wearMasonry(new THREE.MeshStandardMaterial({ map:ashT.map, normalMap:ashT.normalMap, color:0xd2cbc0, roughness:0.94, metalness:0, envMapIntensity:0.16,
    normalScale:new THREE.Vector2(0.8, 0.8) }), { micro: 0.09, edge: 0.32, drip: 0.42, dust: 0.14, seed: 5 });
  // Bedrock buttresses outside the shell, for silhouette. The canopy trees that
  // used to ring this are gone: a tree ring around a sealed interior is what
  // made every screenshot look like a jungle clearing.
  for (let i=0;i<22;i++){ const a=i/22*Math.PI*2; const rad=Math.max(ARENA.w,ARENA.h)*0.60;
    const h=9+R()*7; const m=new THREE.Mesh(new THREE.CylinderGeometry(1.6+R()*1.2,2.6+R()*1.6,h,6), stoneMat);
    m.position.set(Math.cos(a)*rad*(1+R()*0.2), h/2-5, Math.sin(a)*rad*0.9*(1+R()*0.2));
    m.rotation.y=R()*6; m.castShadow=true; m.receiveShadow=true; g.add(m);
  }

  // ---------- sanctuary walls ----------
  const wallMat = wearMasonry(new THREE.MeshStandardMaterial({ map:ashT.map, normalMap:ashT.normalMap, color:0xf2ece2, roughness:0.9, metalness:0, envMapIntensity:0.18,
    normalScale:new THREE.Vector2(1.1, 1.1) }), { micro: 0.07, edge: 0.2, drip: 0.18, dust: 0.08, seed: 2 });
  // The caps were a flat bright cream that read as plastic and flattened every
  // silhouette against the sky. Mossy weathered stone instead, and it takes the
  // floor's normal map so the tops are not mirror-smooth.
  // The caps carried a flat colour and no map, so every walkable surface in the
  // tomb — which is most of what you look at — was untextured paint.
  // Dry, warm, slightly darker than the outer stone: a sealed chamber that has
  // never seen rain. Same maps, so it costs no extra texture memory.
  const chamberMat = wearMasonry(new THREE.MeshStandardMaterial({ map:ashT.map, normalMap:ashT.normalMap,
    color:0xe8ddcc, roughness:0.9, metalness:0, envMapIntensity:0.16,
    normalScale:new THREE.Vector2(1.1, 1.1) }), { micro: 0.07, edge: 0.18, drip: 0.16, dust: 0.06, seed: 3 });
  // Coping: the lip of every walkable edge, lighter and worn smoother than the
  // wall under it — the climbing affordance, carried by material, not paint.
  const coping = wearMasonry(new THREE.MeshStandardMaterial({ map:slabT.map, normalMap:slabT.normalMap,
    color:0xfff4e2, roughness:0.78, metalness:0, envMapIntensity:0.2, normalScale:new THREE.Vector2(0.5, 0.5) }),
    { micro: 0.05, edge: 0.4, drip: 0.0, dust: 0.04, seed: 9 });
  const wallTop = wearMasonry(new THREE.MeshStandardMaterial({ map:slabT.map, normalMap:slabT.normalMap,
    // 0x8a8273, not 0x76806c. The caps are every walkable surface in the tomb,
    // so an olive-green cap colour tinted the entire floor of every chamber and
    // the whole place read as a wet jungle ruin instead of a sealed dry tomb.
    color:0xeee3d0, roughness:0.88, metalness:0, envMapIntensity:0.14,
    normalScale:new THREE.Vector2(0.9,0.9) }), { micro: 0.07, edge: 0.28, drip: 0.0, dust: 0.3, seed: 4 });
  // BATCHING. Every static piece of masonry used to be its own mesh: a box and
  // a cap per level piece plus a dozen courses per chamber wall, each drawn
  // twice with the shadow pass — over half the frame's draw calls. Pieces that
  // never move and are never swapped for a carved model are merged per
  // material at the end. Anything with a mechanism id, and the pillars and
  // plinth a Meshy model may hide, stay separate.
  const batch = new Map();
  const toBatch = (mesh, { course = false, climb = true, blocker = false } = {}) => {
    const key = mesh.material.uuid + (course ? 'c' : '') + (climb ? 'h' : '') + (blocker ? 'b' : '');
    let b = batch.get(key); if (!b) batch.set(key, b = { mat: mesh.material, geos: [], course, climb, blocker });
    mesh.updateMatrixWorld(true);
    const geo = mesh.geometry.clone(); geo.applyMatrix4(mesh.matrixWorld); b.geos.push(geo);
  };
  const flushBatch = () => {
    for (const b of batch.values()) {
      const m = new THREE.Mesh(mergeGeometries(b.geos, false), b.mat);
      m.castShadow = true; m.receiveShadow = true; m.userData.course = b.course; m.userData.merged = true; g.add(m);
      if (b.climb) registerClimbable(m, false);
      if (b.blocker) blockers.push(m);
    }
    batch.clear();
  };
  const moving = {};   // id -> the meshes mech.js animates
  const blockers = [];  // solid wall boxes, for camera collision
  const byTag = {};    // tag or id -> every box/cap drawn for it
  for (let i=0;i<MAP.walls.length;i++){ const w=MAP.walls[i]; const c=to3(w.x+w.w/2, w.y+w.h/2);
    const hgt = w.top;   // from MAP, so traversal.js and the geometry cannot disagree
    // The outer shell is drawn from BELOW the abyss floor, not from y=0. The
    // chambers hang in a shaft, and a shaft needs walls going down past them or
    // the drop reads as the world simply ending.
    // A chamber wall is founded 6 m into the shaft rather than stopping at the
    // platform edge: seen from the causeway or from above the lava it then
    // reads as masonry standing on something, not as a panel hanging in air.
    const deep = w.tag === 'shell' ? 12.0 : (w.tag === 'chamberwall' ? 6.0 : 0);
    // Chamber walls are dry interior masonry, not the weathered outer stone:
    // the shared wallMat is a cool 0xcdd6cb that turns green in shadow.
    const faceMat = w.tag === 'chamberwall' ? chamberMat : wallMat;
    const boxGeo = new THREE.BoxGeometry(w.w*S, hgt + deep, w.h*S);
    const box=new THREE.Mesh(boxGeo, faceMat);
    box.position.set(c.x, hgt/2 - deep/2, c.z); box.castShadow=true; box.receiveShadow=true;
    worldUV(box);
    const merge = !w.id && w.tag !== 'pillar' && w.tag !== 'plinth';
    // The cap is the COPING: worn smooth along the lip, slabbed on top. It is
    // what tells you an edge can be walked or climbed, at a glance.
    const capGeo = new THREE.BoxGeometry(w.w*S+0.10, 0.16, w.h*S+0.10);
    // One material, not six: a material per face is six draw calls per cap, and
    // there is a cap on every piece of the level.
    const cap=new THREE.Mesh(capGeo, w.tag === 'shell' ? wallTop : coping);
    cap.position.set(c.x, hgt+0.05, c.z); cap.castShadow=true;
    worldUV(cap);
    if (merge) {
      // what the third-person camera must not sit behind, and (not the shell)
      // stone a hand can meet: carried by the merged mesh
      toBatch(box, { climb: w.tag !== 'shell', blocker: true });
      toBatch(cap, { climb: w.tag !== 'shell' });
    } else {
      g.add(box); g.add(cap);
      blockers.push(box);
    }
    if (w.id) moving[w.id] = { box, cap, baseBoxY: hgt/2, baseCapY: hgt+0.05, wall: w };
    // Addressable by tag AND by id, so a Meshy prop that IS this piece can switch
    // the procedural box off (placements carry `hides`). Otherwise you get a
    // carved pillar with a grey box standing inside it.
    (byTag[w.tag] = byTag[w.tag] || []).push({ box, cap });
    if (w.id) (byTag[w.id] = byTag[w.id] || []).push({ box, cap });
    // The shell is not a hold. Everything else is stone a hand can meet,
    // including the pieces a carved model later hides.
    if (w.tag !== 'shell' && !merge) { registerClimbable(box, false); registerClimbable(cap, false); }
    // ---- chamber walls get masonry, not a flat slab ----
    // A bare extruded box at a uniform height is what reads as unfinished. Real
    // chamber walls have a footing course, a cornice, engaged pilasters down
    // the face and a thickened jamb where they stop at a doorway. All of it is
    // the same stone material, so it costs geometry and no extra shader work.
    if (w.tag === 'chamberwall') {
      const alongX = w.w >= w.h;
      const L = (alongX ? w.w : w.h) * S, T = (alongX ? w.h : w.w) * S;
      // the platforms these stand on are all at 5 m; the course sits on that
      const FLOOR = 5.0;
      const span = (l, t) => alongX ? [l, t] : [t, l];       // -> [sizeX, sizeZ]
      const put = (sx, sy, sz, px, py, pz, mat) => {
        const geo = new THREE.BoxGeometry(sx, sy, sz);
        const m = new THREE.Mesh(geo, mat || wallMat);
        m.position.set(px, py, pz);
        worldUV(m);
        // Proud of the collision box. A hand or a foot planted on the inner
        // box ends up inside these courses, and a body can walk through them:
        // static masonry, climbable and baked into collision (course).
        toBatch(m, { course: true, climb: true });
        return m;
      };
      // footing course and cornice: proud of the face, top and bottom
      for (const [cy, ch, out, mat] of [[FLOOR + 0.45, 0.90, 0.26, wallMat],
                                        [hgt - 0.42,   0.62, 0.20, wallTop]]) {
        const [sx, sz] = span(L + out * 2, T + out * 2);
        put(sx, ch, sz, c.x, cy, c.z, mat);
      }
      // engaged pilasters every ~2.4 m between the two courses
      const shaftTop = hgt - 0.73, shaftBot = FLOOR + 0.90;
      const n = Math.max(1, Math.round(L / 2.4));
      for (let i = 0; i <= n; i++) {
        const t = n === 0 ? 0.5 : i / n;
        const off = (t - 0.5) * (L - 0.5);
        const [sx, sz] = span(0.52, T + 0.34);
        put(sx, shaftTop - shaftBot, sz,
            c.x + (alongX ? off : 0), (shaftTop + shaftBot) / 2, c.z + (alongX ? 0 : off));
      }
      // JAMBS: a wall only ever stops because there is a doorway there, so both
      // ends get a heavier post and a lintel stub rather than a sawn-off edge.
      for (const e of [-1, 1]) {
        const off = e * (L / 2 - 0.26);
        const [jx, jz] = span(0.62, T + 0.46);
        put(jx, hgt - FLOOR - 0.30, jz,
            c.x + (alongX ? off : 0), FLOOR + (hgt - FLOOR) / 2, c.z + (alongX ? 0 : off));
        const [lx, lz] = span(0.90, T + 0.52);
        put(lx, 0.34, lz, c.x + (alongX ? off : 0), hgt - 1.05, c.z + (alongX ? 0 : off), wallTop);
      }
      continue;                 // no vines: this is sealed stone, not a ruin face
    }

    // torch sconces on long walls
    if (w.id) continue;                       // mechanisms move: no sconces
    if (w.w>100||w.h>100){ const t=makeTorch(); const edge=to3(w.x+w.w, w.y+w.h/2); t.position.set(edge.x, hgt*0.7, edge.z); g.add(t); }
  }

  flushBatch();

  // ---------- FOUNDATIONS ----------
  // The lava is 11 m down. Every platform box started at y=0, so each chamber
  // was a block hovering eleven metres over nothing — the single biggest
  // reason the tomb read as boxes floating in a void rather than as a built
  // place. Every fixed piece over the abyss now stands on masonry that goes
  // down into the lava, flaring into a footing where it meets it. Spans that
  // move (the bridge, the slabs, the crane arm, the doors) stay spans.
  {
    const SPANS = new Set(['bridge_main', 'crane_arm', 'tile_a', 'tile_b', 'tile_c', 'door_front', 'door_sanctum', 'gate_causeway']);
    const LAVA = -11.2, parts = [], foot = [];
    const add = (list, sx, sy, sz, gx, gy, y) => {
      if (sx <= 0.01 || sz <= 0.01 || sy <= 0.01) return;
      const geo = new THREE.BoxGeometry(sx, sy, sz); const c3 = to3(gx, gy);
      const m = new THREE.Mesh(geo); m.position.set(c3.x, y, c3.z); worldUV(m);
      geo.applyMatrix4(m.matrixWorld); list.push(geo);
    };
    for (const w of MAP.walls) {
      if (w.tag === 'shell' || SPANS.has(w.id)) continue;
      if (w.x + w.w <= 360) continue;                          // the hall has a floor
      // only the part of the footprint over the abyss needs founding
      const x0 = Math.max(w.x, 360), wx = (w.x + w.w) - x0;
      const gx = x0 + wx / 2, gy = w.y + w.h / 2;
      const top = w.tag === 'chamberwall' ? -6 : 0;             // chamber walls already reach -6
      add(parts, wx * S, top - LAVA, w.h * S, gx, gy, (top + LAVA) / 2);
      // the footing: a course wider than the pier, standing in the lava
      add(foot, wx * S + 0.9, 1.4, w.h * S + 0.9, gx, gy, LAVA + 0.5);
    }
    const foundMat = wearMasonry(new THREE.MeshStandardMaterial({ map: ashT.map, normalMap: ashT.normalMap,
      color: 0xb59f85, roughness: 0.93, normalScale: new THREE.Vector2(1.1, 1.1) }), { micro: 0.09, edge: 0.2, drip: 0.5, dust: 0.0, seed: 14 });
    const footMat = wearMasonry(new THREE.MeshStandardMaterial({ map: ashT.map, normalMap: ashT.normalMap,
      color: 0x6e5644, roughness: 0.95, emissive: 0x2a0800, emissiveIntensity: 0.6 }), { micro: 0.1, edge: 0.2, drip: 0.0, dust: 0.0, seed: 15 });
    for (const [list, mat] of [[parts, foundMat], [foot, footMat]]) {
      if (!list.length) continue;
      const m = new THREE.Mesh(mergeGeometries(list, false), mat);
      m.receiveShadow = true; g.add(m);
    }
  }

  // ---------- the outer walls: pilasters and a frieze ----------
  // Four 12 m cliffs of identical block were what made the tomb read as a box
  // in a void. Engaged pilasters every ~4.4 m give the walls a rhythm a builder
  // would have given them, with a base where there is a floor to stand them on
  // and a capital under a carved frieze. All of it is merged into three meshes,
  // and it is MASONRY (userData.course): tools/bakecollision.mjs bakes it, so a
  // body meets the pilaster it can see, never a phantom and never a clip.
  {
    const parts = { shaft: [], cap: [], frieze: [] };
    const doors = MAP.walls.filter(w => w.tag === 'door');
    const lampsAt = anchorLamps().filter(L => L.kind === 'wall');
    const inHall = (gx) => gx < 368;                             // the only ground floor
    const keepClear = (gx, gy) => doors.some(d => gx > d.x - 30 && gx < d.x + d.w + 30 && gy > d.y - 30 && gy < d.y + d.h + 30)
      || lampsAt.some(L => Math.hypot(L.x - gx, L.y - gy) < 26);
    const OUT = 0.34, WIDE = 0.72, TOP = 11.2, FRIEZE = 3.35;
    // each inner face: [start, end, fixed coordinate, axis, inward normal]
    const faces = [
      { a0: 40, a1: 1160, c: 40,  alongX: true,  n: 1 },     // north, inner face y=40
      { a0: 40, a1: 1160, c: 860, alongX: true,  n: -1 },    // south, y=860
      { a0: 40, a1: 860,  c: 40,  alongX: false, n: 1 },     // west,  x=40
      { a0: 40, a1: 860,  c: 1160, alongX: false, n: -1 },   // east,  x=1160
    ];
    const add = (list, sx, sy, sz, gx, gy, y) => {
      const geo = new THREE.BoxGeometry(sx, sy, sz); const c3 = to3(gx, gy);
      const m = new THREE.Mesh(geo); m.position.set(c3.x, y, c3.z); worldUV(m);
      geo.applyMatrix4(m.matrixWorld); list.push(geo);
    };
    for (const f of faces) {
      const len = (f.a1 - f.a0) * S, n = Math.round(len / 4.4);
      const outU = OUT / S;
      for (let i = 0; i <= n; i++) {
        const t = f.a0 + (f.a1 - f.a0) * (i / n);
        const gx = f.alongX ? t : f.c + f.n * outU / 2, gy = f.alongX ? f.c + f.n * outU / 2 : t;
        if (keepClear(gx, gy)) continue;
        const base = inHall(gx) ? 0 : -12;
        const [sx, sz] = f.alongX ? [WIDE, OUT] : [OUT, WIDE];
        add(parts.shaft, sx, TOP - base, sz, gx, gy, (TOP + base) / 2);
        if (base === 0) {                                          // a plinth where it stands on paving
          const [bx, bz] = f.alongX ? [WIDE + 0.18, OUT + 0.1] : [OUT + 0.1, WIDE + 0.18];
          add(parts.cap, bx, 0.42, bz, gx + (f.alongX ? 0 : f.n * 0.05 / S), gy + (f.alongX ? f.n * 0.05 / S : 0), 0.21);
        }
        const [cx, cz] = f.alongX ? [WIDE + 0.22, OUT + 0.12] : [OUT + 0.12, WIDE + 0.22];
        add(parts.cap, cx, 0.36, cz, gx + (f.alongX ? 0 : f.n * 0.06 / S), gy + (f.alongX ? f.n * 0.06 / S : 0), TOP - 0.18);
      }
      // the frieze: a carved band 4 cm proud, above head height, the length of the wall
      const mid = (f.a0 + f.a1) / 2, fl = (f.a1 - f.a0) * S;
      const [fx, fz] = f.alongX ? [fl, 0.04] : [0.04, fl];
      const fgx = f.alongX ? mid : f.c + f.n * 0.02 / S, fgy = f.alongX ? f.c + f.n * 0.02 / S : mid;
      add(parts.frieze, fx, 0.5, fz, fgx, fgy, FRIEZE);
      add(parts.frieze, fx, 0.5, fz, fgx, fgy, 8.6);
    }
    const friezeMat = wearMasonry(new THREE.MeshStandardMaterial({ map: ashT.map, normalMap: ashT.normalMap,
      color: 0xa8957a, roughness: 0.94, normalScale: new THREE.Vector2(1.6, 1.6) }), { micro: 0.1, edge: 0.3, drip: 0.1, dust: 0.1, seed: 12 });
    for (const [k, mat] of [['shaft', chamberMat], ['cap', coping], ['frieze', friezeMat]]) {
      if (!parts[k].length) continue;
      const m = new THREE.Mesh(mergeGeometries(parts[k], false), mat);
      m.castShadow = k !== 'frieze'; m.receiveShadow = true; m.userData.course = true; g.add(m);
      registerClimbable(m, false);
    }
  }

  // ---------- the hall's architecture: piers, obelisks, the doorway ----------
  // Columns and obelisks are their collision boxes, dressed: a plinth and a
  // capital each, baked like the rest of the masonry, so what you walk round
  // is what you see. The screen wall's doorway gets its lintel — overhead, so
  // it never stops a body, and the camera treats it as stone.
  {
    const parts = [], dark = [];
    const add = (list, sx, sy, sz, gx, gy, y) => {
      const geo = new THREE.BoxGeometry(sx, sy, sz); const c3 = to3(gx, gy);
      const m = new THREE.Mesh(geo); m.position.set(c3.x, y, c3.z); worldUV(m);
      geo.applyMatrix4(m.matrixWorld); list.push(geo);
    };
    for (const w of MAP.walls) {
      const cx = w.x + w.w / 2, cy = w.y + w.h / 2, sx = w.w * S, sz = w.h * S;
      if (w.tag === 'column') {
        add(parts, sx + 0.36, 0.5, sz + 0.36, cx, cy, 0.25);
        add(parts, sx + 0.2, 0.18, sz + 0.2, cx, cy, 0.59);
        add(parts, sx + 0.44, 0.5, sz + 0.44, cx, cy, w.top - 1.2);
        add(dark, sx + 0.12, 0.3, sz + 0.12, cx, cy, w.top - 1.6);
      }
      if (w.tag === 'obelisk') add(parts, sx + 0.3, 0.6, sz + 0.3, cx, cy, 0.3);
    }
    // the arch crowns over the counted floor: a beam between each pair of legs
    const legs = MAP.walls.filter(w => w.tag === 'arch');
    for (const a of legs) {
      const b = legs.find(o => o !== a && o.x === a.x && o.y > a.y); if (!b) continue;
      const gx = a.x + a.w / 2, y0 = a.y, y1 = b.y + b.h, gy = (y0 + y1) / 2, len = (y1 - y0) * S;
      add(parts, a.w * S + 0.3, 0.5, len + 0.3, gx, gy, 10.95);      // cornice
      add(dark, a.w * S, 1.0, len, gx, gy, 10.2);                      // the crown
      add(dark, a.w * S - 0.1, 0.7, len - 2.6, gx, gy, 9.35);          // the soffit, stepped in
      add(parts, a.w * S + 0.3, 0.4, a.h * S + 0.3, gx, a.y + a.h / 2, 9.5); // imposts
      add(parts, a.w * S + 0.3, 0.4, b.h * S + 0.3, gx, b.y + b.h / 2, 9.5);
    }
    // the aqueduct: an arch between each pair of neighbouring piers, the last
    // span broken off where the arcade fell into the pit
    const piers = MAP.walls.filter(w => w.tag === 'aqueduct').sort((a, b) => a.x - b.x);
    piers.forEach((a, i) => {
      add(parts, a.w * S + 0.3, 0.4, a.h * S + 0.3, a.x + a.w / 2, a.y + a.h / 2, a.top - 0.2);
      const b = piers[i + 1];
      const x0 = a.x + a.w, x1 = b ? b.x : a.x + a.w + 50;     // the broken last span
      const gx = (x0 + x1) / 2, len = (x1 - x0) * S, gy = a.y + a.h / 2;
      add(dark, len, 0.9, a.h * S, gx, gy, a.top - 0.85);
      add(parts, len + 0.2, 0.36, a.h * S + 0.2, gx, gy, a.top + 0.18);
    });
    // the lintel over the crypt doorway (x 150..230 on the screen wall)
    const ld = MAP.walls.filter(w => w.tag === 'screen');
    if (ld.length === 2) {
      const x0 = Math.min(ld[0].x + ld[0].w, ld[1].x + ld[1].w), x1 = Math.max(ld[0].x, ld[1].x);
      const gx = (Math.min(...ld.map(w => w.x + w.w)) + Math.max(...ld.map(w => w.x))) / 2;
      const span = (Math.max(...ld.map(w => w.x)) - Math.min(...ld.map(w => w.x + w.w))) * S;
      const y0 = ld[0].y + ld[0].h / 2;
      add(parts, span + 1.2, 1.1, ld[0].h * S + 0.3, gx, y0, 4.75);
      add(dark, span + 0.6, 0.26, ld[0].h * S + 0.4, gx, y0, 4.1);
      void x0; void x1;
    }
    for (const [list, mat] of [[parts, coping], [dark, chamberMat]]) {
      if (!list.length) continue;
      const m = new THREE.Mesh(mergeGeometries(list, false), mat);
      m.castShadow = true; m.receiveShadow = true; m.userData.course = true; g.add(m);
      registerClimbable(m, false); blockers.push(m);
    }
    // obelisk caps: a pyramidion, gilded once and long since dulled
    const capMat = new THREE.MeshStandardMaterial({ color: 0x9a7a3e, roughness: 0.45, metalness: 0.6 });
    for (const w of MAP.walls.filter(w => w.tag === 'obelisk')) {
      const c3 = to3(w.x + w.w / 2, w.y + w.h / 2);
      const py = new THREE.Mesh(new THREE.ConeGeometry(w.w * S * 0.72, 0.9, 4), capMat);
      py.rotation.y = Math.PI / 4; py.position.set(c3.x, w.top + 0.45, c3.z); py.castShadow = true; g.add(py);
    }
  }

  // ---------- THE COUNTERWEIGHT WHEEL ----------
  // The mechanism you are working, made visible: a 5 m stone gear on the
  // chamber's north wall, behind the drum. It turns as the bridge drops, so
  // the levers read as moving something enormous rather than a number.
  const gear = new THREE.Group();
  {
    const gm = wearMasonry(new THREE.MeshStandardMaterial({ map: ashT.map, normalMap: ashT.normalMap, color: 0x9c8e7a,
      roughness: 0.8, metalness: 0.15 }), { micro: 0.1, edge: 0.45, drip: 0.2, dust: 0.1, seed: 16 });
    const bronze = new THREE.MeshStandardMaterial({ color: 0x6d5531, roughness: 0.42, metalness: 0.75 });
    const R0 = 2.4;
    const rim = new THREE.Mesh(new THREE.TorusGeometry(R0, 0.34, 10, 48), gm); gear.add(rim);
    for (let i = 0; i < 18; i++) {
      const a = i / 18 * Math.PI * 2;
      const t = new THREE.Mesh(new THREE.BoxGeometry(0.42, 0.5, 0.5), gm);
      t.position.set(Math.cos(a) * (R0 + 0.42), Math.sin(a) * (R0 + 0.42), 0); t.rotation.z = a; gear.add(t);
    }
    for (let i = 0; i < 6; i++) {
      const sp = new THREE.Mesh(new THREE.BoxGeometry(R0 * 2, 0.28, 0.3), gm); sp.rotation.z = i / 6 * Math.PI; gear.add(sp);
    }
    const hub = new THREE.Mesh(new THREE.CylinderGeometry(0.62, 0.62, 0.7, 20), bronze); hub.rotation.x = Math.PI / 2; gear.add(hub);
    // one mesh per material, not 26 parts
    {
      const byMat = new Map();
      for (const o of [...gear.children]) { o.updateMatrix(); const gg = o.geometry.clone(); gg.applyMatrix4(o.matrix);
        (byMat.get(o.material) || byMat.set(o.material, []).get(o.material)).push(gg); gear.remove(o); }
      for (const [mat, geos] of byMat) gear.add(new THREE.Mesh(mergeGeometries(geos.map(x => x.index ? x.toNonIndexed() : x), false), mat));
    }
    gear.traverse(o => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
    const at = to3(655, 150);
    gear.position.set(at.x, 8.4, at.z + 0.42);
    g.add(gear);
  }

  // ---------- THE CRADLE ----------
  // The tomb is named for it: a colossal stone basin slung on chains over the
  // lava in the chasm, between the gallery, the counterweight floor and the
  // bridge. Seen from all three, it is how you know where you are. Nothing
  // walks on it — it hangs over the pit, and the pit is the floor.
  const cradle = new THREE.Group();
  {
    const prof = [];
    for (let i = 0; i <= 14; i++) { const t = i / 14; prof.push(new THREE.Vector2(0.4 + Math.sin(t * Math.PI * 0.5) * 3.0, -1.6 + t * 2.6)); }
    prof.push(new THREE.Vector2(3.55, 1.0), new THREE.Vector2(3.55, 1.25), new THREE.Vector2(3.1, 1.25), new THREE.Vector2(2.9, 0.4));
    const bowlMat = wearMasonry(new THREE.MeshStandardMaterial({ map: ashT.map, normalMap: ashT.normalMap, color: 0xc2ad8c,
      roughness: 0.9, side: THREE.DoubleSide }), { micro: 0.1, edge: 0.3, drip: 0.5, dust: 0.3, seed: 17 });
    const bowl = new THREE.Mesh(new THREE.LatheGeometry(prof, 40), bowlMat);
    bowl.castShadow = true; bowl.receiveShadow = true; cradle.add(bowl);
    // silt heaped in it, glowing faintly from the lava under the basin's lip
    // the silt it holds glows a little, as if something under it is still warm:
    // the landmark has to read from every floor of the tomb, in the dark
    // It was one flat emissive disc, which read as an orange plate. Now a heaped
    // crust: dark silt, mottled, split by veins that carry the glow, and domed
    // and rucked so the light rakes across it.
    const siltTex = (() => {
      const N = 512, rnd = prng(31);
      const mk = () => { const c = document.createElement('canvas'); c.width = c.height = N; return [c, c.getContext('2d')]; };
      const [cc, cx] = mk(), [ec, ex] = mk();
      cx.fillStyle = '#4a3d30'; cx.fillRect(0, 0, N, N);
      ex.fillStyle = '#000'; ex.fillRect(0, 0, N, N);
      for (let i = 0; i < 900; i++) {                       // mottling: lumps of paler and darker silt
        const x = rnd() * N, y = rnd() * N, r = 4 + rnd() * 22, v = rnd();
        cx.fillStyle = v < 0.5 ? `rgba(30,22,16,${0.15 + rnd() * 0.25})` : `rgba(120,98,72,${0.08 + rnd() * 0.18})`;
        cx.beginPath(); cx.arc(x, y, r, 0, Math.PI * 2); cx.fill();
      }
      // veins: wandering cracks, glowing in the emissive map, dark-lipped in colour
      for (let k = 0; k < 26; k++) {
        let x = rnd() * N, y = rnd() * N, a = rnd() * Math.PI * 2;
        const pts = [[x, y]];
        for (let j = 0; j < 18; j++) { a += (rnd() - 0.5) * 0.9; x += Math.cos(a) * 12; y += Math.sin(a) * 12; pts.push([x, y]); }
        const w = 1.2 + rnd() * 3.2;
        for (const [g2, col, lw] of [[cx, 'rgba(18,10,6,0.9)', w + 3], [ex, 'rgba(255,150,50,0.55)', w + 5], [ex, 'rgba(255,205,120,1)', w]]) {
          g2.strokeStyle = col; g2.lineWidth = lw; g2.lineCap = 'round'; g2.lineJoin = 'round';
          g2.beginPath(); pts.forEach(([px, py], i) => i ? g2.lineTo(px, py) : g2.moveTo(px, py)); g2.stroke();
        }
      }
      const t1 = new THREE.CanvasTexture(cc), t2 = new THREE.CanvasTexture(ec);
      t1.colorSpace = t2.colorSpace = THREE.SRGBColorSpace;
      return { map: t1, emissiveMap: t2 };
    })();
    const siltGeo = new THREE.BufferGeometry();
    {
      // CircleGeometry has one ring; rebuild as a polar grid so it can be heaped
      const R = 2.95, RINGS = 14, SEG = 64, pos = [], uv = [], idx = [], rnd = prng(32);
      const bump = [...Array(9)].map(() => [rnd() * 4 - 2, rnd() * 4 - 2, 0.6 + rnd() * 0.9, (rnd() - 0.3) * 0.28]);
      for (let r = 0; r <= RINGS; r++) for (let sgm = 0; sgm <= SEG; sgm++) {
        const rr = R * r / RINGS, a = sgm / SEG * Math.PI * 2, x = Math.cos(a) * rr, y = Math.sin(a) * rr;
        let h = 0.32 * (1 - (rr / R) ** 2);                  // heaped in the middle
        for (const [bx, by, bw, bh] of bump) h += bh * Math.exp(-((x - bx) ** 2 + (y - by) ** 2) / (bw * bw));
        h *= 1 - (rr / R) ** 6;                              // and settles flat at the rim
        pos.push(x, y, h); uv.push(0.5 + x / (2 * R), 0.5 + y / (2 * R));
      }
      for (let r = 0; r < RINGS; r++) for (let sgm = 0; sgm < SEG; sgm++) {
        const a = r * (SEG + 1) + sgm, b = a + SEG + 1;
        idx.push(a, b, a + 1, b, b + 1, a + 1);
      }
      siltGeo.setIndex(idx);
      siltGeo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
      siltGeo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
      siltGeo.deleteAttribute('normal'); siltGeo.computeVertexNormals();
    }
    const siltMat = new THREE.MeshStandardMaterial({ map: siltTex.map, color: 0xb8a58c, roughness: 0.97,
      emissive: 0xffffff, emissiveMap: siltTex.emissiveMap, emissiveIntensity: 1.1 });
    const silt = new THREE.Mesh(siltGeo, siltMat);
    silt.rotation.x = -Math.PI / 2; silt.position.y = 0.5; silt.receiveShadow = true; cradle.add(silt);
    cradle.userData.silt = siltMat;
    // four chains to the vault, as instanced links: one draw call for all of them
    const link = new THREE.TorusGeometry(0.17, 0.05, 6, 12);
    const linkMat = new THREE.MeshStandardMaterial({ color: 0x3b3229, roughness: 0.55, metalness: 0.8 });
    const PER = 46, chains = new THREE.InstancedMesh(link, linkMat, PER * 4);
    const M = new THREE.Matrix4(), Q = new THREE.Quaternion(), V = new THREE.Vector3(), SC = new THREE.Vector3(1, 1, 1);
    let n = 0;
    for (let c = 0; c < 4; c++) {
      const a = c / 4 * Math.PI * 2 + Math.PI / 4;
      const from = new THREE.Vector3(Math.cos(a) * 3.3, 1.25, Math.sin(a) * 3.3);
      const to = new THREE.Vector3(Math.cos(a) * 1.6, 8.6, Math.sin(a) * 1.6);
      for (let i = 0; i < PER; i++) {
        V.lerpVectors(from, to, i / PER);
        Q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), (i % 2) * Math.PI / 2 + a);
        M.compose(V, Q, SC); chains.setMatrixAt(n++, M);
      }
    }
    chains.castShadow = true; cradle.add(chains);
    const at = to3(447, 300);
    cradle.position.set(at.x, 3.8, at.z);          // rim level with the 5 m floors
    g.add(cradle);
  }

  // ---------- central ritual floor ----------
  // On the mechanism floor at 5 m and dimmed: it used to glow in the middle of
  // open ground that no longer exists.
  const ritual = new THREE.Group(); const rc = to3(655,335); ritual.position.set(rc.x, 5.03, rc.z); g.add(ritual);
  for (const [r,em] of [[3.4,0.07],[2.7,0.12],[1.5,0.32]]){
    const ring=new THREE.Mesh(new THREE.TorusGeometry(r,0.07,8,64), new THREE.MeshStandardMaterial({color:0xc4a660,emissive:0xc4a660,emissiveIntensity:em,roughness:0.5,metalness:0.4}));
    ring.rotation.x=-Math.PI/2; ritual.add(ring);
  }
  const disc=new THREE.Mesh(new THREE.CircleGeometry(3.5,40),new THREE.MeshStandardMaterial({color:0x1d2b28,roughness:0.9}));
  disc.rotation.x=-Math.PI/2; disc.position.y=-0.02; ritual.add(disc);
  g.userData.ritual = ritual;

  // ---------- foliage: concealment bushes + scattered grass ----------
  const bushGroups=[];
  for (const b of MAP.bushes){ const grp=makeBush(b, R); g.add(grp); bushGroups.push(grp); }
  g.userData.bushes = bushGroups;
  // No grass field. It was ~2600 tufts of lawn over an interior, and most of it
  // now floats where the abyss is. Roots still break in at the concealment
  // volumes, which is the look a jungle tomb actually wants.
  const grass=new THREE.Group(); g.add(grass);

  // ---------------------------------------------------------------------
  // FIRE. The torch pass only hung sconces on walls longer than 100 units and
  // skipped every mechanism piece, which left most of the route unlit — you
  // could not see the floor you were being asked to time a run across.
  // These are placed deliberately, at the things you have to look at.
  // ---------------------------------------------------------------------
  // Every lamp is resolved against real geometry first (level.anchorLamps):
  // bracketed to a wall face and turned to face out of it, or stood on the
  // floor. Giving a lamp a bare (x,y,z) hangs it in mid-air, which is what it
  // was doing. These are the procedural stand-ins; the Meshy sconce and brazier
  // replace them through the `lamps` override when the pack is present.
  const lamps = [];
  for (const L of anchorLamps()) {
    const t = makeTorch();
    const c3 = to3(L.x, L.y);
    t.position.set(c3.x, L.z + (L.kind === 'wall' ? 0 : 0.1), c3.z);
    t.rotation.y = L.ry || 0;
    t.scale.setScalar(L.kind === 'wall' ? 1.15 : 1.5);
    t.userData.kind = 'lamp'; t.userData.lampKind = L.kind;
    // which chamber this lamp belongs to: it does not burn until that chamber
    // has been entered, which is what keeps the rest of the tomb black
    const lr = roomAt(L.x, L.y, L.z); t.userData.room = lr ? lr.id : null;
    // A route lamp overrides the torch's generic reach and brightness. It owns
    // no THREE.PointLight any more — this just edits the descriptor the pool
    // reads, which is why 45 fires cost 8 lights.
    const e = t.userData.emit;
    // Route lamps are the ONLY light in their chamber, so they carry further
    // and burn brighter than a wall sconce would: 1.7x the authored reach and
    // 1.6x the power. Undiscovered rooms have no lamp at all, so none of this
    // leaks into them.
    e.reach = (L.reach || e.reach) * 1.7;
    e.power = (L.power || e.power) * 1.6;
    t.userData.power = e.power;
    g.add(t); lamps.push(t);
  }

  // ---------------------------------------------------------------------
  // THE VAULT. A tomb is a room, and a room has a ceiling. Without one the dark
  // dome overhead reads as night sky and no amount of stone underfoot fixes it.
  //
  // The slabs face DOWN (FrontSide with the normal under them), so the third-
  // person camera — which rises to roughly 13 m over the 7.5 m tier — passes
  // through from above without blacking out the screen. They also cast no
  // shadow: the one shadow-casting light is the directional, and letting the
  // ceiling occlude it would put the whole interior in darkness.
  // ---------------------------------------------------------------------
  const CEIL = 12.4;
  const HOLE = { x0: 96, x1: 268, y0: 336, y1: 512 };     // the collapse, over the entrance
  const ceilMat = wearMasonry(new THREE.MeshStandardMaterial({ map: ashT.map, normalMap: ashT.normalMap,
    color: 0xc9bfae, roughness: 0.96, metalness: 0, side: THREE.FrontSide, envMapIntensity: 0.12,
    normalScale: new THREE.Vector2(0.7, 0.7) }), { micro: 0.06, edge: 0.1, drip: 0.12, dust: 0.0, seed: 6 });
  const slab = (x0, y0, x1, y1) => {
    const m = new THREE.Mesh(new THREE.PlaneGeometry((x1-x0)*S, (y1-y0)*S), ceilMat);
    m.rotation.x = Math.PI/2;                              // normal points DOWN
    const c2 = to3((x0+x1)/2, (y0+y1)/2);
    m.position.set(c2.x, CEIL, c2.z); m.receiveShadow = true; g.add(m);
    worldUV(m);
  };
  slab(0, 0, MAP.w, HOLE.y0);
  slab(0, HOLE.y1, MAP.w, MAP.h);
  slab(0, HOLE.y0, HOLE.x0, HOLE.y1);
  slab(HOLE.x1, HOLE.y0, MAP.w, HOLE.y1);

  // corbel beams across the vault, so it has structure rather than being a lid
  const beamMat2 = wearMasonry(new THREE.MeshStandardMaterial({ map: ashT.map, color: 0x5c6358, roughness: 0.95 }),
    { micro: 0.08, edge: 0.16, drip: 0.35, dust: 0.18, seed: 7 });
  for (let gx = 120; gx < MAP.w; gx += 170) {
    if (gx > HOLE.x0 - 60 && gx < HOLE.x1 + 60) continue;  // nothing across the opening
    const bm = new THREE.Mesh(new THREE.BoxGeometry(0.55, 0.62, MAP.h*S), beamMat2);
    const c2 = to3(gx, MAP.h/2); bm.position.set(c2.x, CEIL - 0.34, c2.z);
    bm.castShadow = true; bm.receiveShadow = true; g.add(bm);
  }
  // broken masonry around the lip of the collapse
  for (let i = 0; i < 14; i++) {
    const t = i / 14, edge = i % 2 === 0;
    const gx = edge ? (HOLE.x0 + (HOLE.x1-HOLE.x0)*t) : (i%4===1 ? HOLE.x0 : HOLE.x1);
    const gy = edge ? (i%4===0 ? HOLE.y0 : HOLE.y1) : (HOLE.y0 + (HOLE.y1-HOLE.y0)*t);
    const c2 = to3(gx, gy);
    const bl = new THREE.Mesh(new THREE.BoxGeometry(0.5+R()*0.6, 0.4+R()*0.5, 0.5+R()*0.6), beamMat2);
    bl.position.set(c2.x+(R()-0.5)*0.6, CEIL-0.25-R()*0.5, c2.z+(R()-0.5)*0.6);
    bl.rotation.set(R()*0.5, R()*3, R()*0.5); bl.castShadow = true; g.add(bl);
  }

  // ---------------------------------------------------------------------
  // AIR. A dark 416-mesh interior with nothing between the camera and the far
  // wall reads as a diorama: there is no evidence of a medium. Suspended silt
  // costs one draw call and does more for "this is a real place" than any
  // amount of extra geometry.
  // ---------------------------------------------------------------------
  // 1400 bright additive white points spread up to 13 m read as a STARFIELD,
  // which is exactly wrong indoors. Real suspended silt is sparse, sits low
  // because it is falling, and is only noticeable where a light catches it.
  // So: a third as many, confined to head height and below, dim, and NOT
  // additive — plus a denser handful inside the daylight shaft, which is the
  // one place in the tomb where motes genuinely should catch the eye.
  const MOTES = 0, SHAFT_MOTES = 40;
  const TOTAL = MOTES + SHAFT_MOTES;
  const dpos = new Float32Array(TOTAL * 3), dseed = new Float32Array(TOTAL);
  for (let i = 0; i < MOTES; i++) {
    dpos[i*3  ] = (R() - 0.5) * ARENA.w * 1.02;
    dpos[i*3+1] = R() * R() * 7.5 - 0.6;          // squared: most of it settles low
    dpos[i*3+2] = (R() - 0.5) * ARENA.h * 1.02;
    dseed[i] = R() * Math.PI * 2;
  }
  for (let i = MOTES; i < TOTAL; i++) {           // the column under the collapse
    const a = R() * Math.PI * 2, rr = Math.sqrt(R()) * 3.4;
    dpos[i*3  ] = shaftAt.x + Math.cos(a) * rr;
    dpos[i*3+1] = R() * 12;
    dpos[i*3+2] = shaftAt.z + Math.sin(a) * rr;
    dseed[i] = R() * Math.PI * 2;
  }
  const shaftGeo = new THREE.BufferGeometry();
  shaftGeo.setAttribute('position', new THREE.BufferAttribute(dpos.slice(MOTES * 3), 3));
  shaftGeo.setAttribute('seed', new THREE.BufferAttribute(dseed.slice(MOTES), 1));
  // A radial sprite. The default point is a hard square, and a field of those
  // reads as confetti rather than as dust in a light.
  const moteC = document.createElement('canvas'); moteC.width = moteC.height = 64;
  const moteG = moteC.getContext('2d');
  const moteGrad = moteG.createRadialGradient(32, 32, 0, 32, 32, 32);
  moteGrad.addColorStop(0, 'rgba(255,248,236,0.95)');
  moteGrad.addColorStop(0.35, 'rgba(255,248,236,0.22)');
  moteGrad.addColorStop(1, 'rgba(255,248,236,0)');
  moteG.fillStyle = moteGrad; moteG.fillRect(0, 0, 64, 64);
  const moteMap = new THREE.CanvasTexture(moteC);
  const uT = { value: 0 };
  const drift = (mat) => {
    mat.onBeforeCompile = sh => {
      sh.uniforms.uT = uT; mat.userData.sh = sh;
      sh.vertexShader = 'uniform float uT;\nattribute float seed;\n' + sh.vertexShader.replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
         transformed.y += sin(uT * 0.21 + seed) * 0.42;
         transformed.x += cos(uT * 0.13 + seed * 1.7) * 0.28;
         transformed.z += sin(uT * 0.11 + seed * 2.3) * 0.28;`);
    };
  };
  const dustMat = new THREE.PointsMaterial({ map: moteMap, color: 0xe7f2f8, size: 0.1, sizeAttenuation: true,
    transparent: true, opacity: 0.4, depthWrite: false, blending: THREE.NormalBlending, fog: true });
  drift(dustMat);
  dustMat.userData.uT = uT;
  const dust = new THREE.Points(shaftGeo, dustMat); dust.frustumCulled = false; g.add(dust);
  g.userData.dust = dust;

  // ---------------------------------------------------------------------
  // THE SHAFT. The spotlight over the entrance lights the floor but is itself
  // invisible — light in air is only visible when there is something in the
  // air. This is the cone you can see, and it is where the dust reads best.
  // ---------------------------------------------------------------------
  const beamGeo = new THREE.CylinderGeometry(1.0, 5.2, 27, 24, 1, true);
  const beamMat = new THREE.ShaderMaterial({ transparent: true, depthWrite: false,
    side: THREE.DoubleSide, blending: THREE.AdditiveBlending,
    uniforms: { uC: { value: new THREE.Color(0xa9d4ea) } },
    vertexShader: 'varying float h;varying vec3 vN;void main(){h=uv.y;vN=normalize(normalMatrix*normal);gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.);}',
    // fades out at the floor AND at grazing angles, so it never reads as a solid cone
    fragmentShader: 'varying float h;varying vec3 vN;uniform vec3 uC;void main(){float e=pow(1.0-abs(vN.z),1.6);float f=smoothstep(0.0,0.35,h)*smoothstep(1.0,0.55,h);gl_FragColor=vec4(uC,f*e*0.22);}' });
  const beam = new THREE.Mesh(beamGeo, beamMat);
  beam.position.set(shaftAt.x, 12.5, shaftAt.z); beam.renderOrder = 3; g.add(beam);

  // ---------------------------------------------------------------------
  // BRAZIER FIRES. The three braziers of the final puzzle had no light at all,
  // so solving it changed nothing you could see. main.js raises these as each
  // one is lit, which makes the sanctum brighten as the puzzle comes together.
  // ---------------------------------------------------------------------
  // ---------------------------------------------------------------------
  // THE LIGHT POOL. A FIXED number of point lights, reassigned every frame to
  // whichever emitters are nearest the camera. Fixed, because three.js bakes
  // the light count into the shader: letting it vary recompiles every material
  // in the scene the moment you cross a threshold, which is a far worse hitch
  // than the cost it saves.
  // ---------------------------------------------------------------------
  const POOL = 8;
  const lightPool = [];
  for (let i = 0; i < POOL; i++) {
    const L = new THREE.PointLight(0xffb14e, 0, 18, 2);
    L.position.set(0, -500, 0);          // parked below the world until assigned
    g.add(L); lightPool.push(L);
  }

  // Brazier fires are EMITTERS, not lights of their own. A PointLight sitting
  // at intensity 0 still occupies a slot in the shader's light array and is
  // still evaluated per fragment — switching it off saves nothing. These go
  // through the same pool as everything else and simply have zero power until
  // the puzzle lights them.
  const brazierEmitters = [['brazier_a',880,580],['brazier_b',970,580],['brazier_c',1060,580]]
    .map(([id, gx, gy]) => { const c = to3(gx, gy);
      return { id, pos: new THREE.Vector3(c.x, 8.9, c.z),
               color: new THREE.Color(0xffa23a), power: 0, reach: 17, room: 'sanctum' }; });

  // Everything that wants to emit: the route lamps plus the three brazier fires.
  // main.js picks the nearest POOL of these each frame.
  // One light, parked under the player at lava height and moved each frame by
  // main.js. Lighting a 64 m shaft from below with fixed lamps would need
  // dozens, and forward rendering charges every one of them in every fragment;
  // the glow is only ever observed where the player is, so one is enough.
  const lavaGlow = new THREE.PointLight(0xff5a16, 0, 26, 1.7);
  lavaGlow.position.set(0, -9.5, 0); scene.add(lavaGlow);

  const emitters = [];
  for (const t of lamps) {
    const e = t.userData.emit; if (!e) continue;
    const wp = new THREE.Vector3(); t.getWorldPosition(wp); wp.y += e.y;
    emitters.push({ pos: wp, color: e.color, power: e.power, reach: e.reach, src: t,
                    room: t.userData.room });
  }
  // ---------------------------------------------------------------------
  // FALLING MASONRY. A pool of blocks plus a dust ring for the tell: a hazard
  // the player cannot see coming is not difficulty, it is a coin toss.
  // ---------------------------------------------------------------------
  const debrisPool = [];
  const debMat = wearMasonry(new THREE.MeshStandardMaterial({ map:ashT.map, color:0x6a6a60, roughness:0.95 }),
    { micro: 0.1, edge: 0.24, drip: 0.3, dust: 0.2, seed: 8 });
  // The tell is the block's SHADOW gathering on the floor, with a little dust
  // at its rim. It was a flat unlit annulus in pale tan, which in a dark room
  // read as a white plastic washer lying on the stone.
  const tellTex = (() => {
    const c = document.createElement('canvas'); c.width = c.height = 128;
    const x = c.getContext('2d'), gr = x.createRadialGradient(64, 64, 0, 64, 64, 64);
    gr.addColorStop(0.0, 'rgba(8,5,3,0.85)'); gr.addColorStop(0.55, 'rgba(10,6,4,0.6)');
    gr.addColorStop(0.8, 'rgba(70,52,34,0.35)'); gr.addColorStop(1.0, 'rgba(70,52,34,0)');
    x.fillStyle = gr; x.fillRect(0, 0, 128, 128);
    const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; return t;
  })();
  const tellMat = new THREE.MeshBasicMaterial({ map:tellTex, transparent:true, opacity:0.0, depthWrite:false,
    polygonOffset:true, polygonOffsetFactor:-2, polygonOffsetUnits:-2 });
  for (let i = 0; i < 8; i++) {
    const grp = new THREE.Group();
    const blk = new THREE.Mesh(new THREE.BoxGeometry(0.55, 0.5, 0.6), debMat);
    blk.castShadow = true; grp.add(blk);
    const ring = new THREE.Mesh(new THREE.CircleGeometry(1.7, 28), tellMat.clone());
    ring.rotation.x = -Math.PI/2; grp.add(ring);
    grp.visible = false; g.add(grp);
    debrisPool.push({ grp, blk, ring });
  }

  return { group:g, sun, water, ritual, bushGroups, grass, moving, byTag, dust, dustMat, debrisPool,
           beam, brazierEmitters, blockers, lamps, lightPool, lavaMat, lavaGlow, gear, cradle,
           emitters: emitters.concat(brazierEmitters) };
}

let _bark=null;
function makeTree(x,z,R){ const t=new THREE.Group(); t.userData.kind='tree'; if(!_bark)_bark=bark(256).map;
  const trunk=new THREE.Mesh(new THREE.CylinderGeometry(0.22,0.4,5,8),new THREE.MeshStandardMaterial({map:_bark,color:0x8a6a4a,roughness:0.95,envMapIntensity:0.3}));
  trunk.position.y=1.1; trunk.castShadow=true; t.add(trunk);
  for(let i=0;i<4;i++){ const can=new THREE.Mesh(new THREE.IcosahedronGeometry(1.6+R()*0.9,0),new THREE.MeshStandardMaterial({color:[0x274a37,0x326044,0x3c6c49][i%3],roughness:1,flatShading:true}));
    can.position.set((R()-0.5)*1.4, 3.3+R()*1.2, (R()-0.5)*1.4); can.castShadow=true; t.add(can); }
  t.position.set(x,0,z); t.scale.setScalar(0.9+R()*0.7); return t; }

// Sixteen torches that were byte-identical — same #ffb14e, same intensity 6,
// same 9 m radius — read as one repeated asset rather than as sixteen fires.
// Varying hue, reach and brightness is most of what makes a lit room look lit.
let _torchN = 0;
function makeTorch(){ const grp=new THREE.Group();
  const v = (_torchN++ * 0.37) % 1;                       // deterministic spread
  const hue = 0.055 + v * 0.025;                          // deep amber -> pale gold
  const col = new THREE.Color().setHSL(hue, 0.85 - v * 0.2, 0.55 + v * 0.08);
  const reach = 7.5 + v * 5.5, power = 4.2 + v * 3.4;
  const post=new THREE.Mesh(new THREE.CylinderGeometry(0.04,0.05,0.5,6),new THREE.MeshStandardMaterial({color:0x3a2a1c,roughness:1})); grp.add(post);
  const flame=new THREE.Mesh(new THREE.ConeGeometry(0.1,0.28,8),new THREE.MeshStandardMaterial({color:0xffd27a,emissive:col,emissiveIntensity:3}));
  flame.position.y=0.4; grp.add(flame); grp.userData.flame=flame;
  // A torch DESCRIBES a light; it does not own one. three.js renders forward,
  // so every PointLight in the scene is evaluated in every fragment shader of
  // every lit material. 45 of them is roughly six times a sane forward budget
  // and was the lag. The lights themselves come from a small fixed pool that
  // follows the camera — see world.lightPool below.
  grp.userData.emit = { color: col, power, reach, y: 0.45 };
  grp.userData.power = power;                            // the flicker needs the base
  if(!window.__torches)window.__torches=[]; window.__torches.push(grp); return grp; }

function makeBush(b,R){
  // CONCEALMENT, drawn as what it is.
  //
  // These are hiding places: crouch inside one and the guardians lose you, so
  // they have to be enterable. Drawn as faceted icosahedra they read as
  // BOULDERS, which promise solidity they do not have — walking through a rock
  // is a bug even when the collision is deliberate. Roots and fronds say
  // "push through me" instead, and the mechanic stops looking broken.
  //
  // Still ONE draw call: everything merges, colour lives in vertex colours.
  const grp=new THREE.Group(); const c=to3(b.x+b.w/2,b.y+b.h/2);
  grp.position.set(c.x,0,c.z);
  const halfW=b.w*S*0.5, halfH=b.h*S*0.5;
  const parts=[]; const col=new THREE.Color();

  const push=(src,o,h,t)=>{
    // mergeGeometries refuses a mix of indexed and non-indexed inputs, and this
    // clump has both: CylinderGeometry is indexed, IcosahedronGeometry is not.
    // Merging returned null, `new Mesh(null)` threw, and the whole bundle died
    // on load — which is why this is normalised before anything else happens.
    const geo = src.index ? src.toNonIndexed() : src;
    if (geo !== src) src.dispose();
    o.updateMatrix(); geo.applyMatrix4(o.matrix);
    col.setHSL(0.255+t*0.05, 0.34+t*0.16, 0.055+t*0.05+h*0.05);
    const n=geo.attributes.position.count, cs=new Float32Array(n*3);
    for(let v=0;v<n;v++){ cs[v*3]=col.r; cs[v*3+1]=col.g; cs[v*3+2]=col.b; }
    geo.setAttribute('color', new THREE.BufferAttribute(cs,3));
    geo.deleteAttribute('uv'); geo.deleteAttribute('normal');
    geo.computeVertexNormals();
    parts.push(geo);
  };

  // ---- fronds: broad tapered blades fanning out of the floor ----
  const nF=Math.floor((b.w*b.h)/420)+16;
  for(let i=0;i<nF;i++){
    const a=R()*6.283, rr=Math.pow(R(),0.55);
    const px=Math.cos(a)*rr*halfW*0.95, pz=Math.sin(a)*rr*halfH*0.95;
    const len=0.55+R()*0.85, wid=0.09+R()*0.10;
    // a blade: four segments, narrowing and arcing over
    const g=new THREE.CylinderGeometry(wid*0.12, wid, len, 3, 4, true);
    const o=new THREE.Object3D();
    o.position.set(px, len*0.5, pz);
    o.rotation.set((R()-0.5)*0.9, R()*6.283, (R()-0.5)*0.9);
    o.scale.set(1, 1, 0.35);                       // flatten into a leaf
    push(g,o,len/1.4,R());
  }
  // ---- low leafy clusters, so the mass still reads at a distance ----
  const nC=Math.floor((b.w*b.h)/900)+5;
  for(let i=0;i<nC;i++){
    const a=R()*6.283, rr=Math.pow(R(),0.6);
    const g=new THREE.IcosahedronGeometry(0.17+R()*0.14, 0);
    const o=new THREE.Object3D();
    o.position.set(Math.cos(a)*rr*halfW*0.8, 0.12+R()*0.18, Math.sin(a)*rr*halfH*0.8);
    o.scale.set(1.5+R()*0.6, 0.30+R()*0.14, 1.5+R()*0.6);
    o.rotation.y=R()*6.283;
    push(g,o,0.2,R());
  }
  // ---- roots hanging down from above, which is what sells "tomb" ----
  const nR=Math.floor((b.w*b.h)/1100)+3;
  for(let i=0;i<nR;i++){
    const a=R()*6.283, rr=Math.pow(R(),0.5);
    const len=1.1+R()*1.5;
    const g=new THREE.CylinderGeometry(0.016, 0.055, len, 4, 2, true);
    const o=new THREE.Object3D();
    o.position.set(Math.cos(a)*rr*halfW*0.9, len*0.5+0.5, Math.sin(a)*rr*halfH*0.9);
    o.rotation.set((R()-0.5)*0.35, R()*6.283, (R()-0.5)*0.35);
    push(g,o,0.9,R()*0.4);
  }

  const merged=mergeGeometries(parts, false);
  parts.forEach(g=>g.dispose());
  // Double-sided: a leaf seen edge-on from inside the clump must not vanish,
  // and the player is MEANT to be inside it.
  const mat=new THREE.MeshStandardMaterial({ vertexColors:true, roughness:1,
    flatShading:true, side:THREE.DoubleSide });
  const mesh=new THREE.Mesh(merged, mat);
  mesh.castShadow=true;
  grp.add(mesh);
  grp.userData.leaf=mat; grp.userData.mesh=mesh;
  return grp; }

function makeGrassField(R){
  // The old field was 2600 flat rectangles spread uniformly over 66x50 m — one
  // blade per 1.3 m2, so every blade read as an isolated stick of litter. Grass
  // grows in tufts: cluster it, vary it, and leave bare ground between clumps.
  const blade=new THREE.PlaneGeometry(0.045,0.42,1,4);
  blade.translate(0,0.21,0);
  const pos=blade.attributes.position;
  for(let i=0;i<pos.count;i++){
    const y=pos.getY(i), t=Math.max(0,Math.min(1,y/0.42));
    pos.setX(i, pos.getX(i)*(1-t*0.85));     // taper to a point
    pos.setZ(i, pos.getZ(i)+t*t*0.12);       // curve forward so it is not a flat slab
  }
  blade.computeVertexNormals();

  const mat=new THREE.MeshStandardMaterial({color:0xffffff,roughness:1,side:THREE.DoubleSide});
  const TUFTS=2600, PER=14, N=TUFTS*PER;
  const inst=new THREE.InstancedMesh(blade,mat,N);
  const m=new THREE.Matrix4(), q=new THREE.Quaternion(), e=new THREE.Euler();
  const col=new THREE.Color();
  const onWall=(gx,gy)=>MAP.walls.some(w=>gx>w.x-18&&gx<w.x+w.w+18&&gy>w.y-18&&gy<w.y+w.h+18);
  let k=0;
  for(let t=0;t<TUFTS && k<N;t++){
    let gx,gy,tries=0;
    do { gx=20+R()*1160; gy=20+R()*860; tries++; } while(onWall(gx,gy) && tries<8);
    if(onWall(gx,gy)) continue;
    const lush=R();                                   // some tufts are fuller than others
    const count=4+Math.floor(lush*PER);
    for(let i=0;i<count && k<N;i++){
      const a=R()*6.283, rad=R()*0.55;                // blades sit close together
      const px=gx+Math.cos(a)*rad/S*0.05, py=gy+Math.sin(a)*rad/S*0.05;
      const p3=to3(px,py);
      e.set((R()-0.5)*0.5, R()*6.283, (R()-0.5)*0.5); // lean, not perfectly upright
      q.setFromEuler(e);
      const sc=0.55+R()*0.9+lush*0.35;
      m.compose(new THREE.Vector3(p3.x,0,p3.z),q,new THREE.Vector3(sc*0.9,sc,sc));
      inst.setMatrixAt(k,m);
      const h=0.26+R()*0.06, l=0.16+R()*0.16+lush*0.07;
      inst.setColorAt(k, col.setHSL(h,0.36+R()*0.2,l));
      k++;
    }
  }
  inst.count=k;
  inst.instanceMatrix.needsUpdate=true;
  if(inst.instanceColor) inst.instanceColor.needsUpdate=true;
  inst.receiveShadow=true;
  return inst; }
