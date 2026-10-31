// ---------------------------------------------------------------------------
// CLIMB COVERAGE. Every face in the tomb a runner can climb, tried twice: once
// standing against it pressing jump, once from a running jump. Each try has to
// end with the runner standing on top. The feel suite proves a climb works on
// one wall; this proves it works on all of them.
//   node tools/climbcover.mjs
// ---------------------------------------------------------------------------
import * as THREE from 'three';
import { Game } from '../src/game.js';
import { TICK, MAP, S, PHYS } from '../src/constants.js';
import { groundAt, blockedAt } from '../src/traversal.js';
const ZERO = { mx:0,my:0,fwd:0,strafe:0,sprint:false,crouch:false,interact:false,block:false,attack:false,dodge:false,jump:false,jumpHeld:false };
const g = new Game(new THREE.Scene()); g.init('A');
for (const q of g.players) if (q.id !== 0) { q.gone = true; q.x = -9999; q.y = -9999; q.dormant = true; }
const me = g.players[0];
const res = { stand: [0,0], run: [0,0] }, fails = [];
function trial(w, f, mode) {
  const off = mode === 'stand' ? 9 : 60;
  const sx = f.px + f.nx * off, sy = f.py + f.ny * off;
  const gz = groundAt(sx, sy), gz2 = groundAt(f.px + f.nx * 9, f.py + f.ny * 9);
  if (Math.abs(gz - gz2) > 0.05 || blockedAt(sx, sy, gz)) return null;
  const rise = w.top - gz;
  if (rise < 0.95 || rise > (mode === 'stand' ? 2.25 : 3.0)) return null;
  Object.assign(me, { x:sx,y:sy,px:sx,py:sy,z:gz,pz:gz,vx:0,vy:0,vz:0,state:'ground',ledge:null,regrab:0,mantle:0,deadUntil:0,hp:100,angle:Math.atan2(-f.ny,-f.nx),pangle:Math.atan2(-f.ny,-f.nx),stunUntil:0 });
  g.phase = 'playing';
  const mx = -f.nx, my = -f.ny;
  let got = null;
  for (let i = 0; i < 240; i++) {
    const d = (me.x - f.px) * f.nx + (me.y - f.py) * f.ny;
    const jumpNow = mode === 'stand' ? (i === 20) : (d < 24 && !me._jumped);
    if (jumpNow) me._jumped = true;
    const inp = { ...ZERO, mx, my, fwd: 1, sprint: mode === 'run', jump: jumpNow, jumpHeld: jumpNow || (me.state==='air') };
    g.update(TICK, inp);
    if (me.ledge && me.ledge.wall === w) got = me.state;
    if (me.state === 'ground' && Math.abs((me.z||0) - w.top) < 0.05) { got = 'top'; break; }
  }
  me._jumped = false;
  return got;
}
for (const w of MAP.walls) {
  if (w.off) continue;
  const faces = [
    { px: w.x + w.w/2, py: w.y, nx: 0, ny: -1, n: 'N' }, { px: w.x + w.w/2, py: w.y + w.h, nx: 0, ny: 1, n: 'S' },
    { px: w.x, py: w.y + w.h/2, nx: -1, ny: 0, n: 'W' }, { px: w.x + w.w, py: w.y + w.h/2, nx: 1, ny: 0, n: 'E' }];
  for (const f of faces) for (const mode of ['stand', 'run']) {
    const r = trial(w, f, mode);
    if (r === null) continue;
    res[mode][1]++;
    if (r === 'top') res[mode][0]++;
    else fails.push(`${mode.padEnd(5)} ${f.n} of [${w.x},${w.y} ${w.w}x${w.h} top ${w.top}${w.tag?' '+w.tag:''}] -> ${r || 'nothing'}`);
  }
}
console.log(`\nCLIMB COVERAGE\n  standing grab: ${res.stand[0]}/${res.stand[1]} faces   running jump: ${res.run[0]}/${res.run[1]} faces`);
if (fails.length) console.log(fails.map(f => '  FAIL  ' + f).join('\n'));
const tried = res.stand[1] + res.run[1];
if (tried < 40) console.log(`  FAIL  only ${tried} faces were tried: the probe has lost the level`);
console.log(fails.length || tried < 40 ? `\nFAILED — ${fails.length} faces do not climb` : '\nPASSED — every climbable face climbs, standing and running');
process.exit(fails.length || tried < 40 ? 1 : 0);
