import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { to3 } from './world.js';
import { S, MAP } from './constants.js';
import { roomAt } from './level.js';
import { addProp, footprintRadius } from './collision.js';
import { registerClimbable } from './climbable.js';
import { loadFbxRunner } from './fbxrunner.js';

function b64ToBuf(b64){ const raw=atob(b64); const u=new Uint8Array(raw.length); for(let i=0;i<raw.length;i++)u[i]=raw.charCodeAt(i); return u.buffer; }

function applyRunner(game, gltf, note){
  game._runnerProto = gltf.scene; game._runnerAnims = gltf.animations || [];
  game._runnerOpts = null;
  if (game.players && game.players.length) game.upgradeRunners(game._runnerProto, game._runnerAnims, null);
  note && note('Realistic character loaded.');
}

// Mixamo rig: a skinned base plus animation-only clips. Served builds only — the
// FBX set is ~4.4 MB and does not belong inlined in a single HTML file.
const FBX_RUNNER = {
  base:      'assets/anim/breathing-idle.fbx',   // the only one With Skin
  walk:      'assets/anim/walking.fbx',
  run:       'assets/anim/running.fbx',
  falling:   'assets/anim/falling.fbx',
  hangGrab:  'assets/anim/hang-grab.fbx',        // idle -> braced hang
  hangIdle:  'assets/anim/hang-idle.fbx',
  hangShimmy:'assets/anim/hang-shimmy.fbx',
  hangDrop:  'assets/anim/hang-drop.fbx',
  climbUp:   'assets/anim/climb-up.fbx',
  climbTop:  'assets/anim/climb-top.fbx',        // the mantle over the ledge
  jump:      'assets/anim/jump.fbx',
  crouchIdle:'assets/anim/crouch-idle.fbx',
  crouchWalk:'assets/anim/crouch-walk.fbx',
  attack:    'assets/anim/attack.fbx',
  block:     'assets/anim/block.fbx',
  roll:      'assets/anim/roll.fbx',
  hit:       'assets/anim/hit.fbx',
  death:     'assets/anim/death.fbx',           // optional; skipped if absent
};
async function tryFbxRunner(game, note){
  try{
    // the offline build ships the clips inline; the served build fetches them
    const inline = (typeof window!=='undefined') && window.__FBX_ANIM__;
    const src = inline
      ? Object.fromEntries(Object.keys(FBX_RUNNER).map(k => [k, inline[k] ? {data:inline[k]} : FBX_RUNNER[k]]))
      : FBX_RUNNER;
    const { proto, clips } = await loadFbxRunner(src, note);
    const names = Object.keys(clips);
    if (!names.length) throw new Error('no clips');
    game._runnerProto = proto; game._runnerAnims = null;
    game._runnerOpts = { rigged:true, clips };
    if (game.players && game.players.length) game.upgradeRunners(proto, null, game._runnerOpts);
    note && note('Rigged character loaded (' + names.join(', ') + ').');
    return true;
  }catch(e){ note && note('Rigged character unavailable, using the static mesh.'); return false; }
}

// place a prop proto across its placement list, normalised to targetH with feet on the ground
// Props the quality tier can thin out. Trees are ~190k triangles each, so on a
// phone they dominate the budget far more than resolution does.
export const PLACED = {};

// Deterministic yaw for scattered dressing. Math.random() re-rolled every
// load, so a rubble pile faced a different way each time you entered.
function hashYaw(x, y) {
  const n = Math.sin(x * 12.9898 + y * 78.233) * 43758.5453;
  return (n - Math.floor(n)) * Math.PI * 2;
}

function placeProp(scene, world, proto, cfg, key){
  proto.traverse(o=>{ if(!o.isMesh) return;
    o.castShadow=true; o.receiveShadow=true;
    const mats = o.material ? (Array.isArray(o.material) ? o.material : [o.material]) : [];
    for (const m of mats) {
      // Stone in this tomb should not be a mirror. Meshy metals stay metallic;
      // everything else gets a roughness floor so highlights read as grit.
      if (m.envMapIntensity == null || m.envMapIntensity > 0.55) m.envMapIntensity = 0.5;
      if (m.roughness != null && (m.metalness || 0) < 0.45) m.roughness = Math.max(m.roughness, 0.62);
    }
  });
  const box=new THREE.Box3().setFromObject(proto); const size=new THREE.Vector3(); box.getSize(size);
  const base=(cfg.targetH||2)/(size.y||1); const feet=box.min.y*base; const cx=(box.min.x+box.max.x)/2, cz=(box.min.z+box.max.z)/2;
  if (cfg.override==='trees') world.group.traverse(o=>{ if(o.userData&&o.userData.kind==='tree')o.visible=false; });
  if (cfg.override==='bushes') (world.bushGroups||[]).forEach(b=>b.visible=false);
  // the Meshy sconce/brazier replaces the procedural torch at the same anchor
  if (cfg.override==='lamps') (world.lamps||[]).forEach(t=>{
    t.traverse(o=>{ if(o.isMesh) o.visible=false; });     // keep the light, drop the stand-in
  });
  // This prop IS that level piece now: stop drawing the procedural box for it.
  // Named by tag ('pillar') or by id ('tile_a'), see world.byTag.
  for (const t of cfg.hides || []) for (const h of (world.byTag && world.byTag[t]) || []) {
    h.box.visible = false; h.cap.visible = false; h.replaced = true;
  }
  // Collider radius. `cfg.r` (metres at scale 1) wins — deriving it from geometry
  // is guesswork for a tree, whose base holds only a few stray low branches and
  // whose bounding-box centre is not the trunk. Auto is the fallback.
  const solid = cfg.solid !== false;
  const rProto = (solid && cfg.r == null) ? footprintRadius(proto) : 0;
  // A prop that REPLACES a level piece should fill that piece's footprint. The
  // level's pillars are 2.6 m squares and the generated pillar model is about
  // 0.8 m across, which leaves nearly a metre of invisible wall on every side —
  // you get stopped by nothing. Widen it toward the box, but clamp: past about
  // 2.5x the model reads as a pancake, and a visible gap beats a smeared prop.
  let fitXZ = 1;
  if (cfg.fit){
    const piece = MAP.walls.find(w => w.id === key || (cfg.hides||[]).includes(w.id) || w.tag === key);
    if (piece && size.x > 1e-4 && size.z > 1e-4){
      // Scales DOWN as well as up. A prop that replaces a level box and is
      // WIDER than it overhangs into space the collision does not guard, and
      // since these models are single-sided you walk in and see straight
      // through the shell. That is what "it is hollow, I should not be able to
      // go in" was: a 9.4 m panel in front of a 1.65 m wall.
      const want = Math.min((piece.w*S)/(size.x*base), (piece.h*S)/(size.z*base));
      fitXZ = Math.max(cfg.fitMin || 0.30, Math.min(cfg.fitMax || 2.5, want));
    }
  }
  for (const pt of cfg.at||[]){ const m=proto.clone(true); const s=base*(pt.s||1);
    const p=to3(pt.x,pt.y); m.scale.set(s*fitXZ, s, s*fitXZ);
    // The tomb is five storeys, so a placement carries its own height. `pt.z` is
    // metres above the floor (the tier the prop stands on) and `cfg.y` lifts the
    // whole set — without this every prop sits at y=0 and the braziers meant for
    // the 7.5 m walkway end up buried under the entrance hall.
    const zBase = (pt.z!=null?pt.z:0) + (cfg.y||0);
    m.position.set(p.x - cx*s, zBase - feet*(pt.s||1), p.z - cz*s);
    const scatter = /rubble|urn|remains|rock/.test(key || '');
    m.rotation.y = pt.ry!=null ? pt.ry : (scatter ? hashYaw(pt.x, pt.y) : 0); scene.add(m);
    m.userData.baseY = m.position.y;        // mech.js animates from this
    // the chamber this prop belongs to; it is not drawn until that chamber opens
    const pr = roomAt(pt.x, pt.y, zBase); m.userData.room = pr ? pr.id : null;
    if(key){ (PLACED[key] = PLACED[key] || []).push(m); }
    // PER-PLACEMENT collision override. `solid` used to be a property of the
    // whole prop, which is wrong for anything placed both ways: the glyph slabs
    // are set flush INTO walls twice (where a collider would only stop you
    // getting close enough to read them) and freestanding once (where its
    // absence meant walking through 1.7 m of carved stone).
    const ptSolid = pt.solid != null ? pt.solid : solid;
    const rCfg = pt.r != null ? pt.r : cfg.r;
    const rm = ptSolid ? (rCfg != null ? rCfg*(pt.s||1)*fitXZ : rProto*s*fitXZ) : 0;   // metres
    if (rm > 0) addProp(pt.x, pt.y, rm/S);
    // Hands plant on this mesh, not on the box it stands in for. Cloth and
    // lamps have no surface a palm can hold.
    m.userData.key = key; m.userData.solid = ptSolid;
    if (!/lamp|rope|chain|banner|spike/i.test(key || '')) registerClimbable(m, true);
  }
}

export function tryLoadMeshyAssets(scene, world, game, note){
  const loader = new GLTFLoader();
  const A = (typeof window!=='undefined') && window.__MESHY_ASSETS__;
  if (A){ note && note('Loading realistic assets…');
    try{
      for (const [k,cfg] of Object.entries(A.props||{})){
        if (!cfg.data) continue;
        loader.parse(b64ToBuf(cfg.data), '', g=>placeProp(scene, world, g.scene, cfg, k));
      }
      // Prefer the rigged FBX when it is inlined. This branch used to return
      // immediately after the static GLB, so the offline build silently shipped
      // the unrigged mesh even with every clip embedded beside it.
      const haveRig = (typeof window!=='undefined') && window.__FBX_ANIM__;
      if (haveRig) {
        tryFbxRunner(game, note).then(ok => {
          if (!ok && A.runner) loader.parse(b64ToBuf(A.runner), '', g=>applyRunner(game,g,note));
        });
      } else if (A.runner) {
        loader.parse(b64ToBuf(A.runner), '', g=>applyRunner(game,g,note));
        note && note('Realistic assets loaded.');
      }
    }catch(e){ note && note('Asset decode failed.'); }
    return;
  }
  // Offline build: the rig is inlined, so run it even from file://
  if(!/^https?:$/.test(location.protocol)){
    if((typeof window!=='undefined') && window.__FBX_ANIM__) tryFbxRunner(game, note);
    else note && note('Procedural preview. Serve with npm start for the realistic asset pack.');
    return;
  }
  fetch('assets/manifest.json').then(r=>{ if(!r.ok) throw 0; return r.json(); }).then(async man=>{
    // the rigged FBX wins when it is present; the GLB is the fallback
    const rigged = await tryFbxRunner(game, note);
    if(!rigged && man.runner) loader.load('assets/'+man.runner, g=>applyRunner(game,g,note));

    // THE RELIC. manifest.relic has been written since the first asset pack and
    // nothing ever read it, so the sun disc the whole tomb is about was still
    // the procedural octahedron while a generated model sat unused on disk.
    if(man.relic) loader.load('assets/'+man.relic, g=>{
      game._relicProto = g.scene;
      if(game.relics && game.relics.length) game.upgradeRelics(g.scene);
    }, undefined, ()=>{});

    // THE GUARDIANS. Stone statues that wake: a separate model, not the runner
    // mesh under a different tint.
    if(man.guardian) loader.load('assets/'+man.guardian, g=>{
      game._guardianProto = g.scene;
      if(game._runnerProto) game.upgradeRunners(game._runnerProto, game._runnerAnims, game._runnerOpts);
    }, undefined, ()=>{});
    // One fetch per FILE, not per placement key. Three braziers, three crushers,
    // two levers and two door slabs all share a model, so the tomb's 18 keys map
    // to 14 files — without this cache the browser pulls four of them twice.
    const cache = new Map();
    const load = file => {
      if (!cache.has(file)) cache.set(file, new Promise((res, rej) =>
        loader.load('assets/' + file, g => res(g.scene), undefined, rej)));
      return cache.get(file);
    };
    for (const [k,cfg] of Object.entries(man.props||{})){
      if(!cfg.file) continue;
      load(cfg.file).then(proto => placeProp(scene, world, proto, cfg, k)).catch(()=>{});
    }
  }).catch(()=>{});
}
