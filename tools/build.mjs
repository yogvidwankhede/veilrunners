// Rebuild bundle + the three HTML outputs. Run from the VEILRUNNERS folder.
// Needs: npm i three@0.160.0 esbuild  (in this folder or a sibling build dir)
import { execSync } from 'node:child_process';
import fs from 'node:fs'; import path from 'node:path';
import { fileURLToPath } from 'node:url';
// fileURLToPath, not url.pathname — the project path can contain spaces (%20).
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
execSync(`npx esbuild "${ROOT}/src/main.js" --bundle --format=iife ${process.env.NOMINIFY ? "" : "--minify"} --outfile="${ROOT}/dist.bundle.js"`, {stdio:'inherit'});
const css = fs.readFileSync(`${ROOT}/src/styles.css`,'utf8'); const js = fs.readFileSync(`${ROOT}/dist.bundle.js`,'utf8');
const pl = JSON.parse(fs.readFileSync(`${ROOT}/placements.json`,'utf8'));
const b64 = f => fs.readFileSync(`${ROOT}/assets/${f}`).toString('base64');
const HEAD = `<!doctype html><html lang="en"><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,viewport-fit=cover"/><title>VEILRUNNERS — The Cradle of Silt</title><meta name="description" content="A third-person challenge tomb in the browser. Recover the Sun Disc and get out before the tomb floods. Solo or co-op."/><meta name="theme-color" content="#050d0f"/><link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 64 64'%3E%3Crect width='64' height='64' rx='12' fill='%23050d0f'/%3E%3Cpath d='M32 8 52 32 32 56 12 32Z' fill='none' stroke='%23d7a54a' stroke-width='4'/%3E%3Ccircle cx='32' cy='32' r='7' fill='%23ffd98a'/%3E%3C/svg%3E"/><link rel="preconnect" href="https://fonts.googleapis.com"/><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin/><link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Cinzel:wght@500;600;700&family=Rajdhani:wght@500;600;700&display=swap"/><style>${css}</style></head><body>\n<div id="app"></div>\n`;
const has = f => fs.existsSync(`${ROOT}/assets/${f}`);
// Serialize every prop in placements.json generically, so a new field (like the
// collider radius `r`) reaches the inline build without touching this function.
// A placement names its own `file`. That used to be assumed to be `<key>.glb`,
// which stopped being true the moment three braziers, three crush pillars, two
// levers and two door slabs shared a model: the tomb is 18 placement keys over
// 14 files. The fallback keeps older placement files working.
const fileOf = (k, cfg) => (cfg && cfg.file) || `${k}.glb`;
const idOf = f => 'a_f_' + f.replace(/\.glb$/, '').replace(/[^A-Za-z0-9_]/g, '_');

function propList(includeTree){
  const tags=[`<script type="text/plain" id="a_runner">${b64('runner.glb')}</script>`], props=[];
  const emitted=new Set();
  for (const [k,cfg] of Object.entries(pl)){
    const file = fileOf(k,cfg);
    if (!has(file) || (k==='tree' && !includeTree)) continue;
    // ONE base64 blob per file, referenced by every key that uses it. Emitting
    // per key would inline the brazier three times and the lever twice.
    if (!emitted.has(file)) { emitted.add(file);
      tags.push(`<script type="text/plain" id="${idOf(file)}">${b64(file)}</script>`); }
    props.push(`${k}:{data:g("${idOf(file)}"),${JSON.stringify(cfg).slice(1,-1)}}`);
  }
  return { tags, props };
}
// The Mixamo rig (base + clips) for the offline build. ~6.9 MB of FBX becomes
// ~9.2 MB of base64, which only the embedded build can carry — the artifact build
// has a 10 MB ceiling.
const ANIM_KEYS = {
  base:'breathing-idle', walk:'walking', run:'running', falling:'falling',
  hangGrab:'hang-grab', hangIdle:'hang-idle', hangShimmy:'hang-shimmy', hangDrop:'hang-drop',
  climbUp:'climb-up', climbTop:'climb-top', jump:'jump',
  crouchIdle:'crouch-idle', crouchWalk:'crouch-walk',
  attack:'attack', block:'block', roll:'roll', hit:'hit', death:'death',
};
function inlineAnim(){
  const parts=[];
  for (const [key,file] of Object.entries(ANIM_KEYS)){
    const f=`${ROOT}/assets/anim/${file}.fbx`;
    if(!fs.existsSync(f)) continue;
    parts.push(`<script type="text/plain" id="an_${key}">${fs.readFileSync(f).toString('base64')}</script>`);
  }
  if(!parts.length) return '';
  const keys=Object.keys(ANIM_KEYS).filter(k=>fs.existsSync(`${ROOT}/assets/anim/${ANIM_KEYS[k]}.fbx`));
  return parts.join('\n')+`\n<script>window.__FBX_ANIM__=Object.fromEntries(${JSON.stringify(keys)}.map(k=>[k,document.getElementById('an_'+k).textContent.trim()]));</script>`;
}

function inline(includeTree){
  const { tags, props } = propList(includeTree);
  return tags.join('\n')+`\n<script>const g=i=>document.getElementById(i).textContent.trim();window.__MESHY_ASSETS__={runner:g("a_runner"),props:{${props.join(',')}}};</script>`;
}
// Keep the served manifest in step with placements.json — they used to be two
// hand-maintained copies of the same data and had already drifted.
{
  const man={ runner: has('runner.glb')?'runner.glb':null,
    relic: has('sundisc.glb')?'sundisc.glb':(has('relic.glb')?'relic.glb':null),
    guardian: has('guardian.glb')?'guardian.glb':null, props:{} };
  for (const [k,cfg] of Object.entries(pl)){
    const file=fileOf(k,cfg); if (has(file)) man.props[k]={ ...cfg, file };
  }
  fs.writeFileSync(`${ROOT}/assets/manifest.json`, JSON.stringify(man,null,1));
  const n=Object.keys(man.props).length, f=new Set(Object.values(man.props).map(c=>c.file)).size;
  console.log(`manifest: ${n} placement key${n===1?'':'s'} over ${f} model${f===1?'':'s'}`);
}

fs.writeFileSync(`${ROOT}/index.html`, HEAD+`<script>${js}</script></body></html>`);
fs.writeFileSync(`${ROOT}/index-embedded.html`, HEAD+inline(true)+inlineAnim()+`<script>${js}</script></body></html>`);
fs.writeFileSync(`${ROOT}/index-artifact.html`, HEAD+inline(false)+`<script>${js}</script></body></html>`);
console.log('built index.html, index-embedded.html, index-artifact.html');

// ---- dist/: exactly what a deploy needs, nothing it does not ----------------
// assets/ also holds the Meshy originals and the hi-res sources (~250 MB). The
// game loads the manifest's models and the rig's clips, ~16 MB. Stage those
// and the page beside serve.mjs, and dist/ is the whole production server; the
// same folder minus serve.mjs is a static deploy for solo play.
{
  const DIST = `${ROOT}/dist`;
  fs.rmSync(DIST, { recursive: true, force: true });
  fs.mkdirSync(`${DIST}/assets/anim`, { recursive: true });
  const man = JSON.parse(fs.readFileSync(`${ROOT}/assets/manifest.json`, 'utf8'));
  const files = new Set(['manifest.json', ...Object.values(man.props).map(c => c.file),
    man.runner, man.relic, man.guardian].filter(Boolean));
  for (const f of files) fs.copyFileSync(`${ROOT}/assets/${f}`, `${DIST}/assets/${f}`);
  for (const f of Object.values(ANIM_KEYS)) {
    const src = `${ROOT}/assets/anim/${f}.fbx`;
    if (fs.existsSync(src)) fs.copyFileSync(src, `${DIST}/assets/anim/${f}.fbx`);
  }
  fs.copyFileSync(`${ROOT}/index.html`, `${DIST}/index.html`);
  fs.copyFileSync(`${ROOT}/serve.mjs`, `${DIST}/serve.mjs`);
  fs.writeFileSync(`${DIST}/package.json`, JSON.stringify({ name: 'veilrunners-server', private: true, type: 'module',
    scripts: { start: 'NODE_ENV=production node serve.mjs' },
    dependencies: { ws: JSON.parse(fs.readFileSync(`${ROOT}/package.json`, 'utf8')).dependencies.ws } }, null, 2) + '\n');
  let bytes = 0; const walk = d => { for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = `${d}/${e.name}`; if (e.isDirectory()) walk(p); else bytes += fs.statSync(p).size; } };
  walk(DIST);
  console.log(`dist/: ${(bytes / 1e6).toFixed(1)} MB staged for deploy`);
}
