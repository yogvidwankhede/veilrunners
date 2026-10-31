#!/usr/bin/env node
/**
 * VEILRUNNERS — Meshy asset generator for THE CRADLE OF SILT.
 *
 * Generates the tomb's 3D asset pack (realistic PBR) with Meshy text-to-3D,
 * then writes assets/manifest.json with placements that match src/level.js.
 *
 * USAGE (from the VEILRUNNERS folder):
 *   export MESHY_KEY="msy_..."                 # your Meshy API key — never commit this
 *   node tools/generate-meshy.mjs              # the whole tomb, in impact order
 *   node tools/generate-meshy.mjs pillar brazier sundisc    # just these
 *   node tools/generate-meshy.mjs --manifest-only           # re-place what is already downloaded
 *
 * Output: assets/<name>.glb + assets/manifest.json. The game picks the manifest
 * up when served over http(s) and upgrades itself; nothing here runs in the
 * browser. Re-running skips any .glb that already exists, so deleting one file
 * regenerates exactly that asset.
 *
 * COST: each asset is a preview task plus a refine task. Generating all 14 is
 * ~28 Meshy tasks, so the catalogue below is ordered by how much each asset
 * changes what you actually see — a partial run still reads as a tomb.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { anchorLamps } from '../src/level.js';

const MANIFEST_ONLY = process.argv.includes('--manifest-only');
const KEY = process.env.MESHY_KEY;
if (!KEY && !MANIFEST_ONLY) {
  console.error('✖  Set MESHY_KEY first:  export MESHY_KEY="msy_..."');
  console.error('   (or run with --manifest-only to re-place assets you already have)');
  process.exit(1);
}
const API = 'https://api.meshy.ai/openapi';
// fileURLToPath, not .pathname: this project lives under "Application Support",
// and a raw pathname hands you %20 in every path.
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ASSETS = path.join(ROOT, 'assets');
fs.mkdirSync(ASSETS, { recursive: true });

const H = { 'Authorization': `Bearer ${KEY}`, 'Content-Type': 'application/json' };
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// ART DIRECTION. One shared suffix keeps fourteen separately-generated assets
// looking like one building. Without it you get fourteen good props that do not
// belong in the same room, which reads worse than fourteen plain boxes.
// ---------------------------------------------------------------------------
const STYLE = 'photorealistic physically based materials, weathered wet limestone and tarnished bronze, '
            + 'carved Mesoamerican temple glyphs, silt and moss in the crevices, lit for a flooded '
            + 'underground tomb, cohesive art direction, game-ready, clean topology, neutral lighting baked flat';

// Ordered by visual impact: a run that stops early still looks like a tomb.
const CATALOG = {
  pillar:      { prompt: `A broken ancient stone temple pillar, square carved column with glyph bands and a cracked top, ${STYLE}`, polycount: 9000,  out: 'pillar.glb' },
  wall_block:  { prompt: `A carved stone tomb wall segment, large fitted limestone blocks with a relief frieze of serpents, ${STYLE}`, polycount: 8000,  out: 'wall_block.glb' },
  brazier:     { prompt: `A carved stone temple brazier on a stepped base with a tarnished bronze bowl of embers, ${STYLE}`, polycount: 7000,  out: 'brazier.glb' },
  wall_lamp:   { prompt: `A wall-mounted temple torch sconce, carved stone bracket with a tarnished bronze fire bowl projecting from a flat back plate, the back plate flush so it sits against a wall, ${STYLE}`, polycount: 6000, out: 'wall_lamp.glb' },
  floor_lamp:  { prompt: `A tall standing temple fire basin on a carved stone column with a wide bronze bowl of burning coals, free standing on a flat base, ${STYLE}`, polycount: 7000, out: 'floor_lamp.glb' },
  sundisc:     { prompt: `An ancient golden sun disc relic, concentric carved rings and a central face, softly glowing, ${STYLE}`, polycount: 12000, out: 'sundisc.glb' },
  door_slab:   { prompt: `A heavy rectangular carved stone door slab with a central glyph seal and bronze fittings, ${STYLE}`, polycount: 6000,  out: 'door_slab.glb' },
  crush_pillar:{ prompt: `A square stone crusher block with a spiked underside and bronze guide rails, temple trap mechanism, ${STYLE}`, polycount: 7000,  out: 'crush_pillar.glb' },
  lever:       { prompt: `An ancient stone and tarnished bronze floor lever mechanism, long pull handle on a carved base, ${STYLE}`, polycount: 6000,  out: 'lever.glb' },
  rubble:      { prompt: `A pile of broken temple masonry, collapsed carved blocks and shattered slabs, ${STYLE}`, polycount: 7000,  out: 'rubble.glb' },
  glyph_wall:  { prompt: `A carved stone glyph tablet set in a wall frame, dense Mesoamerican pictograph relief, ${STYLE}`, polycount: 6000,  out: 'glyph_wall.glb' },
  guardian:    { prompt: `A stone temple guardian warrior statue, full body standing, feathered headdress and stone macana club, T-pose, ${STYLE}`, polycount: 20000, out: 'guardian.glb' },
  drum:        { prompt: `A giant ancient counterweight drum mechanism, stone cylinder wound with thick rope on a bronze axle, ${STYLE}`, polycount: 9000,  out: 'drum.glb' },
  crane:       { prompt: `An ancient temple crane arm, long timber beam with rope rigging and a bronze counterweight hook, ${STYLE}`, polycount: 8000,  out: 'crane.glb' },
  plinth:      { prompt: `A carved stone altar plinth, stepped square pedestal with a shallow offering bowl on top, ${STYLE}`, polycount: 6000,  out: 'plinth.glb' },
  stair_block: { prompt: `A worn stone temple staircase section, steep carved steps with cracked edges, ${STYLE}`, polycount: 6000,  out: 'stair_block.glb' },

  // ---- second pass: the things a tomb has that this one did not ----------
  rope:    { prompt: `A thick frayed hemp rope hanging straight down in one vertical length, knotted at intervals, dark with age, ${STYLE}`, polycount: 4000, out: 'rope.glb' },
  chain:   { prompt: `A heavy iron chain hanging straight down in one vertical length, thick oval links, rusted and pitted, ${STYLE}`, polycount: 5000, out: 'chain.glb' },
  spikes:  { prompt: `A floor trap of upward iron spikes set in a carved stone frame, rusted points, Mesoamerican temple, ${STYLE}`, polycount: 6000, out: 'spikes.glb' },
  winch:   { prompt: `An ancient capstan winch, a vertical wooden drum wound with rope with two long push bars, on a carved stone base, ${STYLE}`, polycount: 8000, out: 'winch.glb' },
  remains: { prompt: `Scattered human skeletal remains half buried in silt beside a broken clay pot, an old expedition that did not leave, ${STYLE}`, polycount: 6000, out: 'remains.glb' },
  gate:    { prompt: `A heavy iron portcullis gate of thick vertical bars in a carved stone frame, rusted, ${STYLE}`, polycount: 6000, out: 'gate.glb' },
  urn:     { prompt: `A cluster of three ancient clay burial urns, one cracked open, painted bands worn away, ${STYLE}`, polycount: 5000, out: 'urn.glb' },
  banner:  { prompt: `A long ragged cloth banner hanging vertically from a bronze rail, faded woven glyph pattern, torn at the bottom, ${STYLE}`, polycount: 4000, out: 'banner.glb' },
};

async function j(url, opt) {
  const r = await fetch(url, opt); const t = await r.text();
  let b; try { b = JSON.parse(t); } catch { b = t; }
  if (!r.ok) throw new Error(`${r.status} ${JSON.stringify(b)}`);
  return b;
}

async function textTo3D(prompt, polycount) {
  const prev = await j(`${API}/v2/text-to-3d`, { method: 'POST', headers: H, body: JSON.stringify({
    mode: 'preview', prompt, art_style: 'realistic', ai_model: 'meshy-5',
    topology: 'triangle', target_polycount: polycount, should_remesh: true }) });
  const previewId = prev.result;
  await poll('v2/text-to-3d', previewId, 'preview');
  const ref = await j(`${API}/v2/text-to-3d`, { method: 'POST', headers: H, body: JSON.stringify({
    mode: 'refine', preview_task_id: previewId, enable_pbr: true }) });
  const task = await poll('v2/text-to-3d', ref.result, 'refine');
  return task.model_urls?.glb;
}

async function poll(kind, id, label) {
  process.stdout.write(`   ${label} ${id} `);
  for (let i = 0; i < 240; i++) {
    const t = await j(`${API}/${kind}/${id}`, { headers: H });
    if (t.status === 'SUCCEEDED') { console.log(' ✓'); return t; }
    if (t.status === 'FAILED') throw new Error('task failed: ' + JSON.stringify(t.task_error || {}));
    process.stdout.write(`.${t.progress ?? 0}%`);
    await sleep(5000);
  }
  throw new Error('timeout after 20 min');
}

async function download(url, dest) {
  const r = await fetch(url); const buf = Buffer.from(await r.arrayBuffer());
  fs.writeFileSync(dest, buf);
  console.log(`   saved ${path.relative(ROOT, dest)} (${(buf.length / 1024 / 1024).toFixed(1)} MB)`);
}

// ---------------------------------------------------------------------------
// PLACEMENT. These coordinates are the tomb in src/level.js, and they are the
// reason props can no longer be pinned to the floor: the tomb is five storeys,
// so a placement carries `z` in metres and assets.js honours it.
//
// `key` is also the handle mech.js animates: a piece whose `top` moves at
// runtime gets its OWN key with a single placement, so PLACED[key][0] is that
// one mesh. Static dressing shares a key and lists many placements.
// ---------------------------------------------------------------------------
const T = { ground: 0, low: 2.5, mid: 5.0, high: 7.5 };

function placements() {
  // `z` is where the prop's FEET go. For a prop that REPLACES a surface (a floor
  // tile, the crane beam, the plinth) that means z = surfaceTop - targetH, or it
  // stands on top of the thing it is supposed to be.
  //
  // `hides` names level tags or ids whose procedural box should stop being drawn
  // because this prop is now that geometry. Without it you get a carved pillar
  // with a grey box inside it, and a floor tile drawn as a 5 m column.
  const T = { ground: 0, low: 2.5, mid: 5.0, high: 7.5 };
  return {
    // ---- the eight pillars: four ringing the drum at 5 m, four in the hall ---
    pillar: { file: 'pillar.glb', targetH: 2.55, r: 0.75, hides: ['pillar'], fit: true, at: [
      { x: 580, y: 230, z: T.mid }, { x: 730, y: 230, z: T.mid },
      { x: 580, y: 454, z: T.mid }, { x: 730, y: 454, z: T.mid },
      { x: 110, y: 186, z: T.ground }, { x: 110, y: 696, z: T.ground },
      { x: 268, y: 696, z: T.ground }, { x: 268, y: 186, z: T.ground },
    ]},

    // ---- relief panels on the face of the 5 m inner wall -------------------
    // SOLID, and much smaller. At targetH 4.6 the model measured 9.4 m across
    // against a 1.65 m wall, with no collider at all: you walked into it and,
    // because Meshy meshes are single-sided, saw straight out through the back.
    // 1.5 m, because the model is twice as wide as it is tall: at 2.6 m it
    // still stood 1.7 m proud of its collider and read as a building you could
    // walk into. At this size it is architectural trim along the wall.
    wall_block: { file: 'wall_block.glb', targetH: 1.5, r: 1.0, at: [
      { x: 359, y: 250, z: T.ground, ry: 0 }, { x: 359, y: 420, z: T.ground, ry: 0 },
      { x: 359, y: 590, z: T.ground, ry: 0 }, { x: 359, y: 760, z: T.ground, ry: 0 },
    ]},

    // ---- the three braziers of the final puzzle, on the 7.5 m ring ---------
    // Solid. The bowl is 2.72 m across; the north ledge is 3.96 m (y 528..600)
    // so an 0.80 m collider leaves a walkable strip along the north side.
    brazier_a: { file: 'brazier.glb', targetH: 1.5, solid: true, r: 0.8, at: [{ x: 880,  y: 580, z: T.high }] },
    brazier_b: { file: 'brazier.glb', targetH: 1.5, solid: true, r: 0.8, at: [{ x: 970,  y: 580, z: T.high }] },
    brazier_c: { file: 'brazier.glb', targetH: 1.5, solid: true, r: 0.8, at: [{ x: 1060, y: 580, z: T.high }] },

    // ---- LAMPS. Positions come from level.anchorLamps(), the same resolver
    // world.js uses, so the models land exactly where the lights are instead of
    // being a second hand-maintained list that drifts. Wall lamps carry the
    // outward normal as their rotation; floor lamps stand on the surface.
    // wallMounted tells tombtest this prop is BRACKETED and is not supposed to
    // touch a floor — otherwise its "floats above the surface" check fires on
    // all 21 of them, which is 21 warnings that are all false.
    wall_lamp: { file: 'wall_lamp.glb', targetH: 0.95, solid: false, override: 'lamps', wallMounted: true,
      at: anchorLamps().filter(L => L.kind === 'wall').map(L => ({ x: L.x, y: L.y, z: L.z - 0.45, ry: L.ry })) },
    floor_lamp: { file: 'floor_lamp.glb', targetH: 1.75, r: 0.42,
      at: anchorLamps().filter(L => L.kind === 'floor').map(L => ({ x: L.x, y: L.y, z: L.z, ry: 0 })) },

    // ---- the three glyph tablets that give the brazier order ---------------
    glyph_wall: { file: 'glyph_wall.glb', targetH: 1.7, solid: false, at: [
      { x: 96,   y: 300, z: T.ground, ry: Math.PI / 2 },
      { x: 530,  y: 120, z: T.mid,    ry: 0 },
      { x: 1124, y: 300, z: T.high,   ry: Math.PI / 2 },
    ]},

    // ---- levers. Own keys so the handle can animate later ------------------
    lever_cw_a:  { file: 'lever.glb', targetH: 1.4, r: 0.45, at: [{ x: 592,  y: 404, z: T.mid, ry: 0 }] },
    lever_cw_b:  { file: 'lever.glb', targetH: 1.4, r: 0.45, at: [{ x: 724,  y: 404, z: T.mid, ry: Math.PI }] },
    lever_crane: { file: 'lever.glb', targetH: 1.4, r: 0.45, at: [{ x: 1012, y: 400, z: T.mid }] },

    // ---- animated geometry. ONE key per moving piece, matching the level ids
    // in src/level.js exactly, because mech.js animates PLACED[id][0].
    tile_a: { file: 'crush_pillar.glb', targetH: 0.85, solid: false, hides: ['tile_a'], fit: true, at: [{ x: 865, y: 370, z: 5.0 - 0.85, ry: 0 }] },
    tile_b: { file: 'crush_pillar.glb', targetH: 0.85, solid: false, hides: ['tile_b'], fit: true, at: [{ x: 915, y: 370, z: 5.0 - 0.85, ry: 0 }] },
    tile_c: { file: 'crush_pillar.glb', targetH: 0.85, solid: false, hides: ['tile_c'], fit: true, at: [{ x: 965, y: 370, z: 5.0 - 0.85, ry: 0 }] },
    crane_arm:    { file: 'crane.glb',       targetH: 0.70, solid: false, hides: ['crane_arm'], fit: true,    at: [{ x: 1060, y: 370, z: 5.0 - 0.70, ry: 0 }] },
    bridge_main:  { file: 'stair_block.glb', targetH: 0.80, solid: false, hides: ['bridge_main'], fit: true,  at: [{ x: 440,  y: 462, z: 5.0 - 0.80, ry: 0 }] },
    door_sanctum: { file: 'door_slab.glb',   targetH: 2.00, solid: false, hides: ['door_sanctum'], at: [{ x: 983,  y: 680, z: 7.6 - 2.00, ry: 0 }] },
    door_front:   { file: 'door_slab.glb',   targetH: 4.80, solid: false, hides: ['door_front'],   at: [{ x: 53,   y: 455, z: 5.0 - 4.80, ry: Math.PI / 2 }] },

    // ---- the counterweight drum (on the altar) and the relic plinth --------
    drum:   { file: 'drum.glb',   targetH: 2.0,  r: 0.9, at: [{ x: 655, y: 335, z: 6.05 }] },
    plinth: { file: 'plinth.glb', targetH: 0.40, solid: false, hides: ['plinth'], at: [{ x: 983, y: 680, z: 6.0 - 0.40 }] },

    // ---- the escape route west: four heaps of collapsed masonry, each one
    // REPLACING its block. They rise out of the abyss to the height you stand
    // on, which is why each needs its own key — they are 5.0, 4.3, 2.5 and 2.1 m.
    rubble_1: { file: 'rubble.glb', targetH: 5.00, solid: false, hides: ['rubble_1'], fit: true, at: [{ x: 775, y: 650, z: 0 }] },
    rubble_2: { file: 'rubble.glb', targetH: 4.30, solid: false, hides: ['rubble_2'], fit: true, at: [{ x: 632, y: 685, z: 0 }] },
    rubble_3: { file: 'rubble.glb', targetH: 2.50, solid: false, hides: ['rubble_3'], fit: true, at: [{ x: 497, y: 735, z: 0 }] },
    rubble_4: { file: 'rubble.glb', targetH: 2.10, solid: false, hides: ['rubble_4'], fit: true, at: [{ x: 405, y: 785, z: 0 }] },

    // ---- loose masonry dressing on the entrance hall floor (west, dry) -----
    // SOLID. These two are free-standing heaps on the hall floor with no level
    // box behind them, so with solid:false you walked straight through the only
    // objects in the opening room.
    // ---- THE ELEVENTH EXPEDITION, and the tomb's own furniture -----------
    // The rope in the shaft is theirs and the story says so out loud; the bones
    // are on the landing where beat V tells you to mind them. Dressing that the
    // dialogue refers to is worth more than dressing that is merely present.
    winch:  { file: 'winch.glb', targetH: 1.5, r: 0.62, at: [{ x: 802, y: 332, z: T.mid }] },

    remains: { file: 'remains.glb', targetH: 0.55, r: 0.55, at: [
      { x: 1000, y: 340, z: T.mid },        // the landing, where beat V stops
      { x: 240,  y: 700, z: T.ground },     // one who got no further than the hall
    ]},

    urn: { file: 'urn.glb', targetH: 0.95, r: 0.48, at: [
      { x: 770,  y: 250, z: T.mid },
      { x: 1040, y: 760, z: 5.60 },
    ]},

    gate: { file: 'gate.glb', targetH: 3.6, solid: false, wallMounted: true,
      allowWalkThrough: 'set into the 5 m inner wall, which already blocks you',
      at: [{ x: 352, y: 300, z: T.ground, ry: Math.PI / 2 }] },

    // Hanging things: thin, soft, and you are meant to push through them.
    rope: { file: 'rope.glb', targetH: 2.5, solid: false,
      allowWalkThrough: 'a hanging rope, pushed aside not walked into', at: [
      { x: 404, y: 168, z: T.low },         // their rope, on the gallery climb
      { x: 884, y: 700, z: 5.60 },          // down into the sanctum
    ]},
    chain: { file: 'chain.glb', targetH: 4.6, solid: false, wallMounted: true,
      allowWalkThrough: 'hangs from the vault, well above head height', at: [
      { x: 600, y: 250, z: 7.2 },
      { x: 1000, y: 620, z: 8.0 },
    ]},
    banner: { file: 'banner.glb', targetH: 1.8, solid: false, wallMounted: true,
      allowWalkThrough: 'cloth hanging on a wall', at: [
      { x: 852, y: 700, z: 5.9, ry: Math.PI / 2 },
      { x: 1100, y: 420, z: 6.0, ry: Math.PI / 2 },
    ]},
    // At the bottom of the drops, so the lethality of a pit is something you
    // can SEE before you find out the other way.
    spikes: { file: 'spikes.glb', targetH: 0.7, solid: false, inPitByDesign: true,
      allowWalkThrough: 'lies at the bottom of a pit that is already fatal', at: [
      { x: 440, y: 420, z: 0 }, { x: 440, y: 640, z: 0 },
      { x: 915, y: 370, z: 0 },
    ]},

    // ---- SOLID fallen masonry, scattered through the rooms -----------------
    // These are rock and they STOP you. They are deliberately a separate thing
    // from the concealment volumes, which are foliage you push through: one
    // object cannot both read as stone and be walked into, and trying to make
    // the bushes do both jobs is what produced "I can go inside the rocks".
    // Positions are clear of every route, and tools/runthrough.mjs re-walks the
    // whole tomb, so it would fail if one of these sealed a corridor.
    rubble: { file: 'rubble.glb', targetH: 1.25, r: 0.80, at: [
      // entrance hall
      { x: 180, y: 620, z: T.ground }, { x: 286, y: 480, z: T.ground },
      { x: 120, y: 480, z: T.ground }, { x: 285, y: 620, z: T.ground },
      { x: 170, y: 760, z: T.ground }, { x: 240, y: 250, z: T.ground },
      // the mechanism chamber, clear of the pillars and the altar
      { x: 660, y: 180, z: T.mid },    { x: 650, y: 480, z: T.mid },
      // the sanctum floor, south of the plinth
      { x: 900, y: 770, z: 5.60 },
    ]},
  };
}

async function main() {
  const want = process.argv.slice(2).filter(a => !a.startsWith('--'));
  const names = want.length ? want : Object.keys(CATALOG);

  if (!MANIFEST_ONLY) {
    console.log(`VEILRUNNERS · THE CRADLE OF SILT · Meshy generation\n  ${names.length} assets: ${names.join(', ')}\n`);
    for (const name of names) {
      const spec = CATALOG[name];
      if (!spec) { console.warn(`? unknown asset "${name}" — known: ${Object.keys(CATALOG).join(', ')}`); continue; }
      const dest = path.join(ASSETS, spec.out);
      if (fs.existsSync(dest)) { console.log(`• ${name}: exists, skipping`); continue; }
      console.log(`• ${name}: generating…`);
      try {
        const url = await textTo3D(spec.prompt, spec.polycount);
        if (!url) throw new Error('no glb url in the finished task');
        await download(url, dest);
      } catch (e) { console.error(`   ✖ ${name} failed: ${e.message}`); }
    }
  }

  // Only place what actually downloaded, so a partial run still produces a
  // manifest the game can load rather than a pile of 404s.
  const props = placements();
  const have = f => fs.existsSync(path.join(ASSETS, f));
  const placed = Object.entries(props).filter(([, c]) => have(c.file));
  const manifest = {
    runner:   have('runner.glb') ? 'runner.glb' : null,
    relic:    have('sundisc.glb') ? 'sundisc.glb' : (have('relic.glb') ? 'relic.glb' : null),
    guardian: have('guardian.glb') ? 'guardian.glb' : null,
    props: Object.fromEntries(placed),
  };
  fs.writeFileSync(path.join(ASSETS, 'manifest.json'), JSON.stringify(manifest, null, 2));
  // placements.json is what tools/build.mjs reads, and build.mjs REWRITES
  // assets/manifest.json from it. Writing only the manifest here meant the next
  // build silently replaced this whole tomb with whatever placements.json still
  // held — which was the old jungle arena. One source of truth, written here.
  fs.writeFileSync(path.join(ROOT, 'placements.json'), JSON.stringify(Object.fromEntries(placed), null, 1));

  const missing = Object.entries(props).filter(([, c]) => !have(c.file)).map(([k]) => k);
  console.log(`\n✓ assets/manifest.json — ${placed.length} prop keys placed`
    + (missing.length ? `, ${missing.length} still procedural (${missing.join(', ')})` : ''));
  console.log('  wrote placements.json too — build.mjs reads that, not the manifest.');
  console.log('  Serve over http(s) (npm start) and the tomb upgrades itself.');
  console.log('  Large files: node tools/optimize-glb.mjs assets/<name>.glb');
}
main().catch(e => { console.error(e); process.exit(1); });
