import * as THREE from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { GTAOPass } from 'three/examples/jsm/postprocessing/GTAOPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { MAP, RULES, S, BOT, PHYS, TICK, MAX_FRAME_DT, MAX_CATCHUP_STEPS } from './constants.js';
import { buildWorld, to3 } from './world.js';
import { Game } from './game.js';
import { findLedge, groundAt, hangGap, mantleInset } from './traversal.js';
import * as traversalAPI from './traversal.js';
import * as collisionAPI from './collision.js';
import * as climbAPI from './climbable.js';
import * as gridAPI from './collisiongrid.js';
import { makeHUD, setObjective, fmtTime, setBeat, setCaption, setFlood, setHold, setRooms } from './hud.js';
import { BEATS } from './story.js';
import { roomAt, CHECKPOINTS } from './level.js';

// interactable id -> the placements.json key that draws it
const LEVER_PROP = { lever_winch: 'winch' };
import { MECH } from './mech.js';
import { MOVE } from './constants.js';
import { tryLoadMeshyAssets, PLACED } from './assets.js';
import { applyPosePolish, proxyProbe, climbRootSampler, CLIMB_SPAN } from './fbxrunner.js';
import { isTouch, createTouchControls } from './touch.js';
import { TIERS, guessTier, applyTier, makeAutoTuner } from './quality.js';
import { createNet, SNAPSHOT_HZ } from './net.js';
import { createAudio } from './audio.js';
import { createSilt } from './water.js';
import { settings, records, recordRun, gradeRun, ACHIEVEMENTS } from './prefs.js';
import { createUI, honour } from './ui.js';
import { createGamepad } from './gamepad.js';
import { createTutorial } from './tutorial.js';

// A lamp is not a point. With pure inverse-square falloff a runner who brushed
// past a fire bowl took ten times the light of one standing a metre off,
// and the cloak blew out to white for as long as they stood there. A 1 m
// source radius softens the near field and leaves the rest of the room alone.
THREE.ShaderChunk.lights_pars_begin = THREE.ShaderChunk.lights_pars_begin.replace(
  'float distanceFalloff = 1.0 / max( pow( lightDistance, decayExponent ), 0.01 );',
  'float distanceFalloff = 1.0 / ( pow( lightDistance, decayExponent ) + 1.0 );');

const app = document.getElementById('app');
makeHUD(app);
const canvas = document.createElement('canvas'); canvas.className='world'; app.prepend(canvas);

const renderer = new THREE.WebGLRenderer({ canvas, antialias:true, powerPreference:'high-performance' });
renderer.setPixelRatio(Math.min(1.5, window.devicePixelRatio||1));
renderer.setSize(innerWidth, innerHeight);
renderer.shadowMap.enabled = true; renderer.shadowMap.type = THREE.PCFSoftShadowMap;
// 1.08 left the stone unreadable in every chamber a lamp did not reach: a tomb
// can be dark and still let you see the masonry you are about to climb.
renderer.toneMapping = THREE.ACESFilmicToneMapping; renderer.toneMappingExposure = 1.32;
renderer.outputColorSpace = THREE.SRGBColorSpace;
// Counted per FRAME, not per pass: with a composer the per-pass reset left
// the profiler reporting only the last full-screen quad.
renderer.info.autoReset = false;

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(60, innerWidth/innerHeight, 0.1, 500);
camera.position.set(0, 10, 16);

const world = buildWorld(scene, renderer);
const silt = createSilt(scene);

const composer = new EffectComposer(renderer);
composer.addPass(new RenderPass(scene, camera));

// AMBIENT OCCLUSION. The pipeline was [Render, Bloom, Output] — nothing darkened
// where surfaces meet, so every prop looked pasted onto the floor rather than
// resting on it. This is the single biggest reason a lit scene reads as "CG".
// It goes BEFORE bloom so the contact darkening is part of what bloom samples.
// Half resolution. AO is low-frequency by nature — contact darkening a few
// centimetres wide — and the pass upsamples it with the scene's own depth, so
// half-res is visually the same and costs a quarter of the fill. Measured at
// 2880x1620 on an M4 Max: full-res AO was 5 ms p50 / 10 ms p95 of the frame.
const AO_SCALE = 0.5;
const gtao = new GTAOPass(scene, camera, innerWidth * AO_SCALE, innerHeight * AO_SCALE);
{ const set = gtao.setSize.bind(gtao); gtao.setSize = (w, h) => set(Math.max(1, Math.floor(w * AO_SCALE)), Math.max(1, Math.floor(h * AO_SCALE))); }
gtao.output = GTAOPass.OUTPUT.Default;
gtao.blendIntensity = 1.0;
gtao.updateGtaoMaterial({
  radius: 0.42,            // metres. Wide enough to ground a prop, short of blackening a room.
  distanceExponent: 1.0,
  thickness: 0.85,
  scale: 1.2,
  samples: 16,
  distanceFallOff: 1.0,
  screenSpaceRadius: false,
});
composer.addPass(gtao);

const bloom = new UnrealBloomPass(new THREE.Vector2(innerWidth/2, innerHeight/2), 0.16, 0.35, 0.94);
composer.addPass(bloom);
composer.addPass(new OutputPass());

const game = new Game(scene);

// ---- device tier ----
// Nothing here is trusted from a user-agent string alone; the tuner measures.
const qctx = { renderer, bloomPass: bloom, gtaoPass: gtao, world, game, placed: PLACED, current: TIERS.high };
applyTier(settings.quality === 'auto' ? guessTier() : settings.quality, qctx);
const autoTune = makeAutoTuner(qctx, t => applyAO(t.name));
const tuneFrame = ms => { if (settings.quality === 'auto') autoTune(ms); };
// AO is a full extra depth-normal pass plus a denoise. It is the first thing to
// go on a phone, and the auto-tuner steps down to it before touching resolution.
function applyAO(name){
  gtao.enabled = name !== 'low';
  gtao.blendIntensity = name === 'high' ? 1.0 : 0.72;
  gtao.updateGtaoMaterial({ samples: name === 'high' ? 16 : 8, radius: 0.42, thickness: 0.85 });
}
applyAO(qctx.current.name);

// ---- co-op ----
// Opt-in with ?room=NAME, or a room code typed on the title screen. Without
// one the game is single-player and none of this code runs.
const roomParam = new URLSearchParams(location.search).get('room');
let net = null, snapAcc = 0;
function ensureNet(room) {
  const want = String(room || '').trim().slice(0, 24);
  if (!want) return;
  if (net && net.room === want) return;
  if (net) { try { net.close(); } catch {} net = null; }
  const wsUrl = (location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/net';
  net = createNet({ game, url: wsUrl, room: want, onStatus: msg => {
    const c = document.getElementById('coop'); if (c) { c.textContent = 'CO-OP · ' + msg.toUpperCase(); c.classList.remove('off'); }
    if (game.phase === 'playing' && /joined|left|disconnected|failed|host/.test(msg)) ui.toast('CO-OP', msg.charAt(0).toUpperCase() + msg.slice(1), '⇄');
  }});
  net.room = want;
}
if (roomParam) {
  const field = document.getElementById('room');
  if (field) field.value = roomParam;
  ensureNet(roomParam);
}

// ---- touch ----
const touch = isTouch() ? createTouchControls(app) : null;
if (touch) document.body.classList.add('touch');
// the pads must not sit over the menu or the results board
const setTouchLive = on => { const el=document.getElementById('touch'); if(el) el.classList.toggle('live', on); };

// ---- input ----
const keys = new Set(), codes = new Set();
let crouch = false, attackEdge = false, dodgeEdge = false, jumpEdge = false, locked = false;
// Hold-versus-toggle latches for the three hold actions (settings.*Toggle).
let sprintLatch = false, useLatch = false, guardLatch = false;
let paused = false, lookAccum = 0, wantLock = false, lockedAt = 0;

// ---- how many runners, and on whose screen ----
// 'solo': one runner, the partner slot is the AI. 'split': two runners on one
// screen, each with their own half and their own camera. 'online': two
// browsers and a room code (net.js). Split is chosen on the title screen.
let mode = 'solo';
const splitLive = () => mode === 'split' && game.players[1] && !game.players[1].isBot;

// ONE CAMERA PER RUNNER. Yaw and pitch are the look device's; everything after
// is the spring arm's state. Solo and online use rigs[0] only.
function makeRig(ya = Math.PI) {
  return { ya, pitch: 0.16, focus: new THREE.Vector3(), ahead: new THREE.Vector3(), look: new THREE.Vector3(),
    shoulder: 0, ready: false, arm: 4, landDip: 0, fov: 60, crouch: false };
}
const rigs = [makeRig(), makeRig()];
const clampPitch = r => { r.pitch = Math.max(-0.12, Math.min(0.95, r.pitch)); };
// One entry point for every look device, so sensitivity and invert apply to
// all of them identically.
function look(dx, dy, r = rigs[0]) {
  const k = settings.sens;
  r.ya -= dx * k; r.pitch += dy * k * (settings.invertY ? -1 : 1); clampPitch(r);
  if (r === rigs[0]) lookAccum += Math.abs(dx * k) + Math.abs(dy * k);
}

// PLAYER TWO. The right-hand cluster of the keyboard, or a gamepad. With one
// pad plugged in it goes to player two, since player one has the mouse.
//   arrows move · Enter jump/climb · Right Shift run · / use · . crouch
//   , roll · ' strike · ; guard
// The keyboard has no second mouse, so on keys the camera swings in behind
// the runner as they move — the camera every couch platformer gives the
// keyboard player.
const P2KEYS = { up: ['ArrowUp'], down: ['ArrowDown'], left: ['ArrowLeft'], right: ['ArrowRight'],
  jump: ['Enter', 'NumpadEnter', 'Numpad0'], run: ['ShiftRight'], use: ['Slash', 'NumpadDecimal'],
  crouch: ['Period'], roll: ['Comma'], strike: ['Quote'], guard: ['Semicolon'] };
const P2CODES = new Set(Object.values(P2KEYS).flat());
const p2 = { jumpEdge: false, dodgeEdge: false, attackEdge: false, crouch: false, sprintLatch: false, lastKeys: 0 };
const p2has = k => P2KEYS[k].some(c => codes.has(c));
const padA = createGamepad(0), padB = createGamepad(1);
// whose pad is whose: two pads, one each; one pad in split, player two's
let pad = padA, pad2 = null;
function assignPads() {
  if (!splitLive()) { pad = padA; pad2 = null; return; }
  if (padB.connected) { pad = padA; pad2 = padB; } else { pad = null; pad2 = padA; }
}
// One tick of player two, in the shape a partner's packet has on the wire, so
// game.js takes it through the same door (see net.sendInput).
function p2Input(on) {
  const r = rigs[1], gp = pad2 && pad2.connected ? pad2 : null;
  const cl = v => Math.max(-1, Math.min(1, v));
  const fwd = on ? cl((p2has('up') ? 1 : 0) - (p2has('down') ? 1 : 0) + (gp ? gp.move.fwd : 0)) : 0;
  const strafe = on ? cl((p2has('right') ? 1 : 0) - (p2has('left') ? 1 : 0) + (gp ? gp.move.strafe : 0)) : 0;
  if (p2.sprintLatch && Math.hypot(fwd, strafe) < 0.1) p2.sprintLatch = false;
  // Keys have no look device: the camera swings in behind a runner on the
  // move, faster the faster they go, and never while they walk toward it.
  const q = game.players[1];
  const keysLately = performance.now() - p2.lastKeys < 4000 && !(gp && performance.now() - gp.lastUsed < 1500);
  if (on && keysLately && q && q.state === 'ground' && fwd > -0.2 && (q.mps || 0) > 0.5) {
    const want = Math.atan2(Math.cos(q.angle || 0), Math.sin(q.angle || 0));
    r.ya = lerpAngle(r.ya, want, Math.min(1, TICK * (0.9 + (q.mps || 0) * 0.35)));
  }
  const sprint = on && (settings.sprintToggle ? p2.sprintLatch : (p2has('run') || (gp && (gp.held.has('lb') || gp.held.has('l3')))));
  const inp = { mx: fwd * Math.sin(r.ya) - strafe * Math.cos(r.ya), my: fwd * Math.cos(r.ya) + strafe * Math.sin(r.ya),
    fwd, strafe, sp: sprint ? 1 : 0, cr: on && p2.crouch ? 1 : 0,
    it: on && (p2has('use') || !!(gp && gp.held.has('x'))) ? 1 : 0,
    at: on && p2.attackEdge ? 1 : 0, dg: on && p2.dodgeEdge ? 1 : 0, jp: on && p2.jumpEdge ? 1 : 0,
    jh: on && (p2has('jump') || !!(gp && gp.held.has('a'))) ? 1 : 0,
    bl: on && (p2has('guard') || !!(gp && gp.held.has('lt'))) ? 1 : 0 };
  p2.jumpEdge = p2.dodgeEdge = p2.attackEdge = false;
  r.crouch = !!inp.cr;
  return inp;
}
const NOPAD = { connected: false, move: { fwd: 0, strafe: 0 }, look: { x: 0, y: 0 }, held: new Set(), edges: new Set(), lastUsed: 0, consume: () => false, poll() {} };
// A real spacebar reports key " ". Some DOM taps report key "Space" and
// code "Space". Both have to count, or the press never becomes an edge.
const keyName = e => {
  const k = (e.key || '').toLowerCase();
  return (k === ' ' || k === 'space' || e.code === 'Space') ? ' ' : k;
};
addEventListener('keydown', e=>{ const k=keyName(e);
  // Typing a name or room code is not playing: a space there is a space.
  if(e.target && e.target.tagName==='INPUT'){ if(k==='escape') onEscape(); return; }
  if(k===' ')e.preventDefault();
  // Edge on the press, not on "the set didn't have it". A missed keyup used to
  // leave space in the set, and every later tap — coyote, buffer, a real
  // keydown — was swallowed because keys.has was already true.
  if(k==='escape'){ e.preventDefault(); onEscape(); return; }
  if(paused || game.phase!=='playing' || ui.depth) return;
  // Player two's keys belong to player two: no page scroll on the arrows, no
  // quick-find on / and '.
  if(splitLive() && P2CODES.has(e.code)){
    e.preventDefault(); codes.add(e.code); p2.lastKeys = performance.now();
    if(!e.repeat){
      if(P2KEYS.jump.includes(e.code)) p2.jumpEdge = true;
      if(P2KEYS.roll.includes(e.code)) p2.dodgeEdge = true;
      if(P2KEYS.strike.includes(e.code)) p2.attackEdge = true;
      if(P2KEYS.crouch.includes(e.code)) p2.crouch = !p2.crouch;
      if(P2KEYS.run.includes(e.code) && settings.sprintToggle) p2.sprintLatch = !p2.sprintLatch;
    }
    return;
  }
  if(!e.repeat){ if(k==='c')crouch=!crouch; if(k===' ')jumpEdge=true; if(k==='q')dodgeEdge=true; if(k==='j')attackEdge=true;
    if(k==='shift'&&settings.sprintToggle)sprintLatch=!sprintLatch;
    if(k==='e'&&settings.useToggle)useLatch=!useLatch;
    if(k==='f'&&settings.guardToggle)guardLatch=!guardLatch; }
  keys.add(k); codes.add(e.code); });
// Right Shift letting go must not let go of player one's Left Shift.
addEventListener('keyup', e=>{ codes.delete(e.code); if(!(splitLive() && P2CODES.has(e.code))) keys.delete(keyName(e)); });
canvas.addEventListener('click', ()=>{ if(game.phase==='playing' && !paused){ if(!locked && !touch)grabPointer(canvas); else attackEdge=true; } });
document.addEventListener('pointerlockchange', ()=>{
  const was = locked;
  locked = document.pointerLockElement===canvas;
  if (locked) lockedAt = performance.now();
  // The browser eats Esc to release the pointer, so the keydown never arrives:
  // losing the lock mid-run IS the pause request. A lock that drops within a
  // moment of being granted is the browser refusing it (an unfocused window,
  // an embedding frame), not the player asking to stop.
  if (was && !locked && game.phase==='playing' && !paused && !wantLock && performance.now()-lockedAt > 700) setPaused(true);
});
// Blur and tab-away clear held keys (a keyup that lands in another window is
// otherwise lost, and the runner keeps walking) and pause a solo run.
addEventListener('blur', ()=>{ keys.clear(); codes.clear(); });
document.addEventListener('visibilitychange', ()=>{ if(document.hidden){ keys.clear(); codes.clear(); if(game.phase==='playing' && !paused) setPaused(true); } });
addEventListener('mousemove', e=>{ if(!locked||paused)return; look(e.movementX*0.0024, e.movementY*0.0021); });
// The composer is sized to ONE view: the whole canvas, or half of it when two
// runners share the screen. `views` is how many it is sized for right now.
let views = 1;
function fitViews(){
  const n = splitLive() && game.phase==='playing' ? 2 : 1;
  views = n;
  renderer.setSize(innerWidth,innerHeight);
  composer.setSize(Math.floor(innerWidth/n), innerHeight);
  camera.aspect = (innerWidth/n)/innerHeight; camera.updateProjectionMatrix();
  document.body.classList.toggle('split', n === 2);
}
addEventListener('resize', fitViews);

// ---- menu / results ----
const screen=document.getElementById('screen'), hud=document.getElementById('hud');
document.getElementById('play').addEventListener('click', start);
document.getElementById('pname').addEventListener('keydown', e=>{ if(e.key==='Enter')start(); });
document.getElementById('room').addEventListener('keydown', e=>{ if(e.key==='Enter')start(); });
document.getElementById('pname2').addEventListener('keydown', e=>{ if(e.key==='Enter')start(); });
// ONE, TWO HERE, TWO ONLINE. Remembered between visits; a ?room= link is
// always online, and a touch screen has one pair of thumbs, so no split.
const modeBtns=[...document.querySelectorAll('.modes .mode')];
function setMode(m){
  if(m==='split' && isTouch()) m='solo';
  mode=m;
  for(const b of modeBtns){ const on=b.dataset.mode===m; b.classList.toggle('on',on); b.setAttribute('aria-checked',String(on)); }
  document.body.classList.remove('m-solo','m-split','m-online'); document.body.classList.add('m-'+m);
  try{ localStorage.setItem('veil.mode', m); }catch{}
}
for(const b of modeBtns) b.addEventListener('click', ()=>{ setMode(b.dataset.mode); if(b.dataset.mode==='online') document.getElementById('room').focus(); });
setMode(new URLSearchParams(location.search).get('room') ? 'online' : (()=>{ try{ return localStorage.getItem('veil.mode')||'solo'; }catch{ return 'solo'; } })());
function start(){ if(!assetsReady && !assetsWaitedOut) return;
  // Online needs a room to meet in. An empty one is a question, not a solo run.
  if(mode==='online' && !(document.getElementById('room').value||'').trim()){
    const f=document.getElementById('room'); f.focus(); f.classList.remove('nudge'); void f.offsetWidth; f.classList.add('nudge'); return; }
  const name=(document.getElementById('pname').value||'').trim().toUpperCase().slice(0,16)||'RUNNER';
  ui.closeAll(); setPaused(false, true);
  crouch=false; sprintLatch=useLatch=guardLatch=false; keys.clear();
  tutorial.reset(); lastBeat=-1; lastHp=100; hintShownAt=performance.now();
  introT = 0; endingT = -1; endingSkip = false; document.body.classList.remove('ending');
  document.getElementById('endcard')?.classList.remove('on');
  document.getElementById('hint').classList.toggle('fade', !settings.hints);
  const room = mode === 'online' ? (document.getElementById('room')?.value || '').trim() : '';
  if (room) ensureNet(room);
  else if (net) { net.close(); net = null; }
  if (net) net.localName = name.slice(0, 16);
  game.init(name); if (net) net.attach(); setTouchLive(true);
  // Two on one screen: slot 1 stops being the AI partner and takes player
  // two's input, through the same door a partner off the wire comes in by.
  if (mode === 'split') {
    const q = game.players[1];
    q.isBot = false; q.remote = true; q.ally = true; q.dormant = false;
    q.name = (document.getElementById('pname2').value || '').trim().toUpperCase().slice(0, 16) || 'KESTREL';
    game.remoteInput = null;
  }
  p2.crouch = false; p2.sprintLatch = false; codes.clear();
  for (const r of rigs) { r.ready = false; r.ya = Math.PI; r.pitch = 0.16; r.landDip = 0; }
  assignPads(); fitViews();
  audio.resume();            // browsers will not start audio before a gesture; this click is it
  snd.reset();
  screen.classList.add('hidden'); hud.classList.remove('hidden'); document.body.classList.remove('results');
  const old=document.getElementById('results'); if(old)old.classList.remove('on');
  if(!touch) grabPointer(canvas); }

// Solo, pausing stops the world. In co-op the host is the world for both
// runners, so it keeps running and the menu says so.
function coopLive(){ return !!(net && net.connected && net.peers >= 2); }
function setPaused(on, silent){
  paused = !!on;
  const pz=document.getElementById('pause');
  if(paused){
    keys.clear();
    document.getElementById('pausenote').textContent = coopLive()
      ? 'Co-op: the tomb keeps running for your partner.'
      : splitLive() ? `Both runners hold · ${BEATS[game.story?game.story.beat:0].title} · ${fmtTime(game.elapsed?game.elapsed():0)}` : `${BEATS[game.story?game.story.beat:0].title} · ${fmtTime(game.elapsed?game.elapsed():0)}`;
    pz.classList.remove('off');
    if(!coopLive()) audio.suspend();
    if(document.pointerLockElement) document.exitPointerLock?.();
    setTouchLive(false);
    setTimeout(()=>{ const b=pz.querySelector('button'); b&&b.focus({preventScroll:true}); },30);
  } else {
    pz.classList.add('off');
    if(!silent){ audio.resume(); setTouchLive(true); if(!touch){ wantLock=true; grabPointer(canvas); setTimeout(()=>wantLock=false,400); } }
    last = performance.now();
  }
}
function onEscape(){
  if(ui.depth){ ui.close(); return; }
  if(game.phase==='playing') setPaused(!paused);
}
function quitToTitle(){
  setPaused(false, true);
  if(net){ try{ net.close(); }catch{} net=null; }
  game.phase='menu'; fitViews();
  document.getElementById('coop').classList.add('off');
  document.getElementById('results')?.classList.remove('on'); document.body.classList.remove('results');
  hud.classList.add('hidden'); screen.classList.remove('hidden'); setTouchLive(false);
  document.exitPointerLock?.(); audio.suspend(); refreshRecordLine();
}
const ui = createUI({
  onSetting: (k, v) => applySetting(k, v),
  onAction: act => {
    if(act==='resume') setPaused(false);
    else if(act==='restart'){ setPaused(false, true); start(); }
    else if(act==='quit') quitToTitle();
  },
});
// The pause menu is not on the panel stack (Esc on it resumes), so its own
// buttons that open panels stack on top of it naturally.
function applySetting(k, v){
  if(k==='volume') audio.setVolume(v/100);
  if(k==='quality'){ const t = v==='auto' ? guessTier() : v; applyTier(t, qctx); applyAO(qctx.current.name); }
  if(k==='hints') document.getElementById('hint').classList.toggle('fade', !v);
  if(k==='captions' && !v) setCaption(null);
  if(k==='fps') document.getElementById('fps').classList.toggle('off', !v);
  if(k==='sprintToggle') sprintLatch=false;
  if(k==='useToggle') useLatch=false;
  if(k==='guardToggle') guardLatch=false;
}
const tutorial = createTutorial();
// introT: the opening crane down the shaft. endingT: the escape before the board.
let introT = 99, endingT = -1, endingSkip = false;
const INTRO = 2.4, ENDING = 5.2;
let resultsShown = false, lastBeat = -1, lastHp = 100, hintShownAt = 0, fpsAcc = 0, fpsN = 0;

function refreshRecordLine(){
  const el=document.getElementById('recordline'); if(!el) return;
  const got=(records.unlocked||[]).length;
  el.textContent = records.runs ? `BEST ${records.bestMs!=null?fmtTime(records.bestMs):'—'} · ${records.wins||0} ESCAPED · ${got}/${ACHIEVEMENTS.length} HONOURS` : '';
}
refreshRecordLine();

const feedEl=document.getElementById('feed'); let lastFeed='';
const mini=document.getElementById('minimap').getContext('2d');

// ---- cinematic menu orbit + optional Meshy asset load ----
// The title holds ENTER until the carved models and the rig are in, so the
// first step is never taken on stand-in geometry. A slow or failed load stops
// holding after a while: the stand-ins play the same rules.
let assetsReady = false, assetsWaitedOut = false, loadSteps = 0;
const playBtn = document.getElementById('play');
playBtn.disabled = true; playBtn.textContent = 'PREPARING…';
function markReady(){
  if(assetsReady) return; assetsReady = true;
  playBtn.disabled = false; playBtn.textContent = 'ENTER THE TOMB';
  document.getElementById('loadbar').style.width = '100%';
  setTimeout(()=>document.getElementById('load').classList.add('done'), 400);
  const n=document.getElementById('assetnote'); if(n) n.textContent = 'The tomb is ready';
}
setTimeout(()=>{ if(!assetsReady){ assetsWaitedOut = true; markReady(); } }, 20000);
tryLoadMeshyAssets(scene, world, game, msg=>{
  loadSteps++;
  document.getElementById('loadbar').style.width = Math.min(92, 10 + loadSteps * 14) + '%';
  const n=document.getElementById('assetnote');
  if (/^(Rigged character loaded|Realistic character loaded|Procedural preview|Rigged character unavailable|Asset decode failed)/.test(msg)) markReady();
  else if (n && !assetsReady) n.textContent = /Loading/.test(msg) ? 'Carving the tomb…' : 'Preparing the tomb…';
});
// props arrive after the tier was first applied; re-apply so thinning takes effect
setTimeout(()=>applyTier(qctx.current.name, qctx), 1500);
setTimeout(()=>applyTier(qctx.current.name, qctx), 5000);

// ---------------------------------------------------------------------------
// AUDIO. Wired by WATCHING state rather than by threading callbacks through the
// simulation: the game does not know sound exists, which keeps it out of the
// netcode and out of the tests.
// ---------------------------------------------------------------------------
const audio = createAudio();
for (const k of ['volume','fps']) applySetting(k, settings[k]);
const snd = (() => {
  const prev = {};
  const o = {
    reset(){ for(const k of Object.keys(prev)) delete prev[k]; },
    // fire `fn` when `v` changes, or when it rises if `rising`
    edge(k, v, fn, rising){
      const had = Object.prototype.hasOwnProperty.call(prev, k);
      const was = prev[k]; prev[k] = v;
      if (!had) return;
      if (rising ? (v > was) : (v !== was)) fn(was, v);
    },
  };
  return o;
})();
addEventListener('keydown', e=>{ if(e.key.toLowerCase()==='m' && !(e.target && e.target.tagName==='INPUT')){
  const on = audio.toggle();
  ui.toast('SOUND', on?'Sound on':'Muted · press M again', on?'♪':'×');
}});


// Profiling / debug hook. Nothing reads it in normal play, but without it the
// bundle is minified and there is no way to attribute a frame on real hardware.
window.__VEIL = { THREE, proxyProbe, col: { ...traversalAPI, ...collisionAPI, ...climbAPI, ...gridAPI, PHYS }, renderer, composer, scene, camera, world, game, silt, RULES, MAP, BOT, TICK, quality:qctx, TIERS, applyTier, touch, audio, get net(){return net;},
  get camYaw(){ return rigs[0].ya; }, set camYaw(v){ rigs[0].ya = v; },
  get camPitch(){ return rigs[0].pitch; }, set camPitch(v){ rigs[0].pitch = v; },
  rigs, get mode(){ return mode; }, set mode(v){ mode = v; },
  frames: null,
  profile(seconds = 4){ const t = []; const stop = performance.now() + seconds*1000;
    let prev = performance.now();
    const tick = () => { const now = performance.now(); t.push(now - prev); prev = now;
      if (now < stop) requestAnimationFrame(tick);
      else { t.sort((a,b)=>a-b); const q = p => t[Math.min(t.length-1, Math.floor(t.length*p))];
        const mean = t.reduce((a,b)=>a+b,0)/t.length;
        const sd = Math.sqrt(t.reduce((a,b)=>a+(b-mean)**2,0)/t.length);
        this.frames = { n:t.length, p50:+q(.5).toFixed(2), p95:+q(.95).toFixed(2),
          p99:+q(.99).toFixed(2), max:+t[t.length-1].toFixed(2), mean:+mean.toFixed(2),
          stddev:+sd.toFixed(2), fpsFromP50:+(1000/q(.5)).toFixed(1),
          calls: renderer.info.render.calls, tris: renderer.info.render.triangles,
          programs: renderer.info.programs.length, geometries: renderer.info.memory.geometries,
          textures: renderer.info.memory.textures, pixelRatio: renderer.getPixelRatio(),
          size: [renderer.domElement.width, renderer.domElement.height] }; } };
    requestAnimationFrame(tick); return 'profiling '+seconds+'s'; } };

const meOf = () => game.players[game.localId || 0] || game.players[0];
const lerp = (a, b, t) => a + (b - a) * t;
const lerpAngle = (a, b, t) => { let d = b - a;
  while (d >  Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  return a + d * t; };
const expk = (speed, dt) => 1 - Math.exp(-speed * dt);

// Camera collision scratch. Allocated once: a Vector3 per frame in the render
// loop is the classic way to hand the garbage collector a stutter.
const camDir = new THREE.Vector3();
const camLook = new THREE.Vector3();     // the ending crane's look point
// Unreal spring arm: CameraLagSpeed 10 on the FOLLOW POINT only. Mouse yaw and
// pitch write the arm direction directly — lagging those is what makes looking
// around feel drunk. Collision shortens the arm; it does not lag the look.
const CAM_LAG = 8;       // 1/s. 10 tracked the body so tightly a strafe
                         // looked glued. 8 leaves the body a step ahead.
                         // Mouse yaw and pitch are not in this filter.
const CAM_AHEAD = 4.5;   // 1/s, how fast the look-ahead offset catches velocity
const CAM_IN = 13;       // 1/s, into a wall. 90 was a snap: with a probe that sees the wall coming, an
                         // 75 ms ease is fast enough never to show the back face, and does not lurch
const CAM_OUT = 6;       // 1/s, back out — fast here jitters along a corner
const CAM_MIN = 0.85;    // m: closer than this and the near plane cuts the body
const CAM_SKIN = 0.32;   // m: stop short of the wall so the near plane stays clear
const CAM_HARD = 0.2;    // m: the nearest the lens may come to the look point when stone forces it
const _kv = new THREE.Vector3(), _head = new THREE.Vector3();
// The grid march skips its first 0.3 m (it starts at the camera's own pivot);
// for short rays from the head that is the whole ray, so look from behind.
function gridRayNear(o, d, far) {
  const t = gridAPI.gridRayHit(o.x - d.x * 0.3, o.y - d.y * 0.3, o.z - d.z * 0.3, d.x, d.y, d.z, far + 0.3);
  return t < Infinity ? Math.max(0, t - 0.3) : Infinity;
}
// The last word on where the lens goes. Everything after the arm (the rise
// over the shoulder, the landing dip, shake, the opening crane) moves the
// camera without asking the stone; one ray from the look point to the final
// position, and the lens stops short of whatever it meets.
function keepOutOfStone(look, pos) {
  _kv.subVectors(pos, look);
  const L = _kv.length(); if (L < 1e-4) return;
  _kv.divideScalar(L);
  const hit = Math.min(archRayHit(look, _kv, L + 0.25), gridRayNear(look, _kv, L + 0.25));
  let d = hit < L + 0.22 ? Math.max(CAM_HARD * 0.5, hit - 0.22) : L;
  // A march of 5 cm steps can slip past the corner of a carving and land
  // the lens just inside it: step back toward the runner until it is clear.
  for (let n = 0; n < 12 && d > CAM_HARD * 0.5 && stoneAt(look.x + _kv.x * d, look.y + _kv.y * d, look.z + _kv.z * d); n++) d -= 0.12;
  pos.copy(look).addScaledVector(_kv, d);
}
const stoneAt = (x, y, z) => gridAPI.gridRayHit(x, y - 0.3, z, 0, 1, 0, 0.36) < Infinity;

// ---------------------------------------------------------------------------
// THE VISIBLE FACE. The ledge is a collision box, but the hands and body meet
// the CARVED stone, which is proud of the box at a base moulding and inset at
// a fluted shaft. Three horizontal rays at the face (lip, chest, hip height)
// and one down onto the lip measure that stone, cached per ledge and
// re-measured as the body shimmies. Every number below is relative to the
// box face plane along its outward normal: + proud of it, - inset.
// ---------------------------------------------------------------------------
const _vfRay = new THREE.Raycaster(), _vfO = new THREE.Vector3(), _vfD = new THREE.Vector3();
const VF_OUT = 1.4;                       // m outside the box face the rays start
function visibleFace(p){
  const g = p.ledge; if(!g) return null;
  const at = { x: p.x, y: p.y };
  const c = p._vf;
  if(c && c.ledge === g && Math.hypot(c.x - at.x, c.y - at.y) < 2) return c;    // re-measure every 0.1 m of shimmy
  // meshes near this ledge only, so a ray is a handful of triangles tests
  if(!c || c.ledge !== g){
    const all = climbAPI.climbTargets(), wx = (g.ex - MAP.w/2) * S, wz = (g.ey - MAP.h/2) * S, near = [];
    for(const m of all){ if(!m.geometry) continue; if(!m.geometry.boundingSphere) m.geometry.computeBoundingSphere();
      m.getWorldPosition(_vfO); const r = m.geometry.boundingSphere.radius * Math.max(m.scale.x, m.scale.y, m.scale.z, 1) + 3;
      if(Math.hypot(_vfO.x - wx, _vfO.z - wz) < r + 3) near.push(m); }
    p._vfNear = near;
  }
  const fx = (p.x - g.nx * ((p.x - g.ex) * g.nx + (p.y - g.ey) * g.ny) - MAP.w/2) * S;   // body projected onto the face, world x
  const fz = (p.y - g.ny * ((p.x - g.ex) * g.nx + (p.y - g.ey) * g.ny) - MAP.h/2) * S;
  const proudAt = h => {
    _vfO.set(fx + g.nx * VF_OUT, h, fz + g.ny * VF_OUT); _vfD.set(-g.nx, 0, -g.ny);
    _vfRay.set(_vfO, _vfD); _vfRay.far = VF_OUT + 0.8;
    const hit = _vfRay.intersectObjects(p._vfNear, false).find(h => climbAPI.surfaceVisible(h.object));
    return hit ? VF_OUT - hit.distance : 0;
  };
  // The lip is the OUTERMOST edge near the top. A stepped coping (a cap set
  // on a wider slab, as on the carved pillars) was gripped by the cap, and the
  // slab under it stood 14 cm proud of the hands and shoved the chest off the
  // stone. Hands take the outer step; the ray from above finds its height.
  const lipProud = Math.max(proudAt(g.top - 0.08), proudAt(g.top - 0.2), proudAt(g.top - 0.32));
  // the lip's real height, from above, just in from the visible edge
  _vfO.set(fx + g.nx * (lipProud - 0.08), g.top + 1.2, fz + g.ny * (lipProud - 0.08)); _vfD.set(0, -1, 0);
  _vfRay.set(_vfO, _vfD); _vfRay.far = 1.6;
  const top = _vfRay.intersectObjects(p._vfNear, false).find(h => climbAPI.surfaceVisible(h.object));
  p._vf = { ledge: g, x: at.x, y: at.y, lip: lipProud, topDy: top ? Math.max(-0.2, Math.min(0.25, top.point.y - g.top)) : 0,
            bands: [[g.top - 0.6, proudAt(g.top - 0.6)], [g.top - 1.2, proudAt(g.top - 1.2)], [g.top - 1.8, proudAt(g.top - 1.8)]] };
  return p._vf;
}

// How far the hanging body's chest and hips stand off the VISIBLE stone, in
// metres, on the posed skeleton. The legs are left out on purpose: they bend,
// and the foot IK plants them on whatever the stone does at that height.
const HANG_SKIN = 0.06;
const HANG_TILT = 0.22;                   // rad, ~12.6 degrees: a lean, not a plank
const _hcV = new THREE.Vector3();
const HANG_BONES = /(hips|spine1|spine2|neck)$/i;
function hangClearance(p, vf){
  const g = p.ledge; if(!g || !p.model) return null;
  if(!p._hangBones){ p._hangBones = []; p.model.traverse(o => { if(o.isBone && HANG_BONES.test(o.name)) p._hangBones.push(o); }); }
  if(!p._hangBones.length) return null;
  const fx = (g.ex - MAP.w/2) * S, fz = (g.ey - MAP.h/2) * S;
  let best = Infinity;
  for(const b of p._hangBones){
    b.getWorldPosition(_hcV);
    let proud = 0, bd = Infinity;
    if(vf) for(const [h, pr] of vf.bands){ const d = Math.abs(h - _hcV.y); if(d < bd){ bd = d; proud = pr; } }
    const r = /hips/i.test(b.name) ? 0.15 : 0.13;           // flesh round the bone
    // Signed: carved stone that sits INSIDE the collision box is where the
    // body hangs against. Clamping an inset to zero measured clearance from
    // stone that is not there, and on the carved pillars that tilted the body
    // out to its limit and pushed it 0.4 m further, a diagonal plank hanging
    // half a metre off the stone it was holding.
    const d = (_hcV.x - fx) * g.nx + (_hcV.z - fz) * g.ny - r - proud;
    if(d < best) best = d;
  }
  return best;
}

// Soft contact disc. The directional only reaches where the shaft does, so
// inside a chamber the skinned mesh has no contact shadow and reads as hovering.
// A multiply-free radial disc under the feet is the same trick capsule shadows
// are in a third-person action game. One texture, a material per body.
const blobMap = (() => {
  const c = document.createElement('canvas'); c.width = c.height = 64;
  const g = c.getContext('2d');
  const grd = g.createRadialGradient(32, 32, 2, 32, 32, 32);
  grd.addColorStop(0, 'rgba(0,0,0,0.7)');
  grd.addColorStop(0.55, 'rgba(0,0,0,0.28)');
  grd.addColorStop(1, 'rgba(0,0,0,0)');
  g.fillStyle = grd; g.fillRect(0, 0, 64, 64);
  const t = new THREE.CanvasTexture(c);
  return t;
})();
function contactBlob() {
  const m = new THREE.Mesh(new THREE.CircleGeometry(0.58, 20),
    new THREE.MeshBasicMaterial({ map: blobMap, transparent: true, depthWrite: false, toneMapped: false }));
  m.rotation.x = -Math.PI / 2;
  m.renderOrder = 2;
  m.material.polygonOffset = true;
  m.material.polygonOffsetFactor = -2;
  scene.add(m);
  return m;
}

let last=performance.now(); let orbit=0; let acc=0; let alpha=1;
// Impact feel: a landed hit freezes the simulation for a few frames and kicks the
// camera. Without these a hit is just a number changing on a bar.
// Pointer lock rejects when the page is embedded somewhere that does not own
// the root document — an iframe, the artifact build, a preview pane. It returns
// a promise in modern browsers, so an unguarded call is an unhandled rejection
// on every click, and mouse-look simply does not engage. Neither is worth
// throwing over: fall back to moving the mouse without capture.
const grabPointer = el => { try { const r = el.requestPointerLock(); if (r && r.catch) r.catch(()=>{}); } catch {} };

let hitStop=0, shake=0, lastImpact=-1;

// Soft chips. A radial sprite, not a PointsMaterial square — those read as confetti.
function sparkTexture() {
  const c = document.createElement('canvas'); c.width = c.height = 64;
  const g = c.getContext('2d');
  const rg = g.createRadialGradient(32, 32, 0, 32, 32, 30);
  rg.addColorStop(0, 'rgba(255,236,210,1)');
  rg.addColorStop(0.28, 'rgba(232,168,96,0.85)');
  rg.addColorStop(0.62, 'rgba(140,78,40,0.28)');
  rg.addColorStop(1, 'rgba(60,32,16,0)');
  g.fillStyle = rg; g.fillRect(0, 0, 64, 64);
  const tex = new THREE.CanvasTexture(c); tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}
const sparkTex = sparkTexture();
const sparks = [];
for (let i = 0; i < 24; i++) {
  const m = new THREE.Sprite(new THREE.SpriteMaterial({
    map: sparkTex, transparent: true, depthWrite: false, color: 0xf0d2b0,
  }));
  m.visible = false; m.scale.setScalar(0.08); scene.add(m);
  sparks.push({ m, life: 0, max: 1, vx: 0, vy: 0, vz: 0 });
}
function burstSparks(imp) {
  const p = to3(imp.x, imp.y);
  const y = (imp.z || 0) + 1.05;
  let dx = (imp.nx || 0), dz = (imp.ny || 0);
  const hl = Math.hypot(dx, dz);
  if (hl < 0.2) { dx = 0; dz = 0; } else { dx /= hl; dz /= hl; }
  let n = 0;
  for (const s of sparks) {
    if (s.life > 0) continue;
    if (n >= 8) break;
    const spread = (Math.random() - 0.5) * 0.85;
    const spd = 1.6 + Math.random() * 2.2;
    s.vx = (dx + -dz * spread) * spd;
    s.vz = (dz + dx * spread) * spd;
    s.vy = 0.8 + Math.random() * 1.8;
    s.max = s.life = 0.16 + Math.random() * 0.12;
    const sc = 0.045 + Math.random() * 0.05;
    s.m.scale.setScalar(sc);
    s.m.position.set(p.x + dx * 0.2, y, p.z + dz * 0.2);
    s.m.material.opacity = 1;
    s.m.visible = true;
    n++;
  }
}
function tickSparks(dt) {
  for (const s of sparks) {
    if (s.life <= 0) continue;
    s.life -= dt;
    if (s.life <= 0) { s.m.visible = false; continue; }
    s.vy -= 9 * dt;
    s.m.position.x += s.vx * dt;
    s.m.position.y += s.vy * dt;
    s.m.position.z += s.vz * dt;
    s.m.material.opacity = Math.max(0, s.life / s.max);
    const k = 0.35 + 0.65 * (s.life / s.max);
    s.m.scale.setScalar(0.09 * k);
  }
}
function paintFlash(mesh, on) {
  if (!mesh) return;
  mesh.traverse(o => {
    if (!o.isMesh || !o.material) return;
    const mats = Array.isArray(o.material) ? o.material : [o.material];
    for (const m of mats) {
      if (!m.emissive) continue;
      if (on) {
        if (m.userData._em0 === undefined) {
          m.userData._em0 = m.emissive.getHex();
          m.userData._ei0 = m.emissiveIntensity || 0;
        }
        m.emissive.setHex(0xffffff);
        m.emissiveIntensity = 1;
      } else if (m.userData._em0 !== undefined) {
        m.emissive.setHex(m.userData._em0);
        m.emissiveIntensity = m.userData._ei0;
        delete m.userData._em0; delete m.userData._ei0;
      }
    }
  });
}
const _footV = new THREE.Vector3();
const camR = new THREE.Vector3(), camU = new THREE.Vector3(), camP = new THREE.Vector3(), UP = new THREE.Vector3(0, 1, 0);
// Ray against every solid level box (slab method). Boxes stand from below the
// lava to their coping; a box the eye is already inside is ignored.
function archRayHit(o, d, far) {
  let best = far === undefined ? Infinity : far + 1e-3, hit = Infinity;
  const hx = MAP.w / 2, hz = MAP.h / 2;
  for (const w of MAP.walls) {
    if (w.off) continue;
    const x0 = (w.x - hx) * S, x1 = (w.x + w.w - hx) * S, z0 = (w.y - hz) * S, z1 = (w.y + w.h - hz) * S;
    const y0 = -12, y1 = w.top + 0.13;
    let tn = -Infinity, tf = Infinity, inside = true;
    for (const [oo, dd, lo, hi] of [[o.x, d.x, x0, x1], [o.y, d.y, y0, y1], [o.z, d.z, z0, z1]]) {
      if (oo < lo || oo > hi) inside = false;
      if (Math.abs(dd) < 1e-9) { if (oo < lo || oo > hi) { tn = Infinity; break; } continue; }
      let a = (lo - oo) / dd, b = (hi - oo) / dd; if (a > b) [a, b] = [b, a];
      if (a > tn) tn = a; if (b < tf) tf = b;
    }
    if (inside || tn > tf || tf < 0) continue;
    if (tn >= 0 && tn < best) { best = tn; hit = tn; }
  }
  return hit;
}
// THE FRAMING. Over the shoulder and close, the way a third-person climber
// is shot: the runner stands a little left of centre, about a third of the
// frame tall, so a jump reads as a jump and the hands on a ledge can be seen.
// The old 4.85 m boom and a metre of lift put the camera six metres off and
// high above, and every climb played out as a small dark figure on a wall.
const BOOM = 3.2;         // m at a walk
const BOOM_RUN = 0.45;    // m more at a full run
const BOOM_CLIMB = 0.55;  // m more on a wall: the ledge above has to be in frame
const LIFT = 0.5;         // m the boom sits above the chest look-at
const SHOULDER = 0.42;    // m right of the spine; the runner sits left of centre
const _shR = new THREE.Vector3();
// Aim the shared camera down one runner's spring arm. `vi` is the view: the
// shake and the near-fade only belong to one of them.
function aimRig(r, me, dt, vi) {
  const base=to3(lerp(me.px,me.x,alpha),lerp(me.py,me.y,alpha));
  const mz=lerp(me.pz||0,me.z||0,alpha);
  const crouching = vi === 0 ? crouch : r.crouch;
  const look=r.look;
  look.set(base.x, mz + (crouching?1.0:1.45), base.z);
  if (!r.ready) { r.focus.copy(look); r.ahead.set(0,0,0); r.arm = BOOM; r.shoulder = 0; r.fov = settings.fov; r.ready = true; }
  else r.focus.lerp(look, expk(CAM_LAG, dt));
  // Look-ahead: a fraction of a second of velocity, clamped, so the frame
  // shows where you are going. Smoothed on its own so a stop does not snap.
  const hvx = (me.vx||0) * S, hvz = (me.vy||0) * S;
  const spdH = Math.hypot(hvx, hvz);
  const lead = spdH > 0.2 ? Math.min(0.9, spdH * 0.18) : 0;
  r.ahead.x += ((spdH > 0.2 ? hvx / spdH * lead : 0) - r.ahead.x) * expk(CAM_AHEAD, dt);
  r.ahead.z += ((spdH > 0.2 ? hvz / spdH * lead : 0) - r.ahead.z) * expk(CAM_AHEAD, dt);
  look.copy(r.focus).add(r.ahead);
  // The pivot lags the runner, and after a mantle or a teleport the lagging
  // point cuts the corner of the block just climbed. A pivot inside stone
  // blinds every ray below (a box the ray starts in is not seen), and the
  // lens followed it in. Pull it back to the clear side, along the line from
  // the runner's own head.
  _head.set(base.x, mz + (crouching?1.0:1.45), base.z);
  _kv.subVectors(look, _head);
  const lagD = _kv.length();
  if (lagD > 0.05) {
    _kv.divideScalar(lagD);
    const h = Math.min(archRayHit(_head, _kv, lagD + 0.2), gridRayNear(_head, _kv, lagD + 0.2));
    if (h < lagD + 0.15) look.copy(_head).addScaledVector(_kv, Math.max(0, h - 0.15));
  }

  const climbing = me.state==='hang' || me.state==='mantle';
  const sprintK = Math.min(1, spdH / (RULES.sprint * S));
  const boom = BOOM + sprintK * BOOM_RUN + (climbing ? BOOM_CLIMB : 0);
  // __VEIL.filmYaw turns only the camera (tools/posefilm.mjs films a move
  // side-on while the keys still steer relative to the player's yaw).
  const vya = (vi === 0 && window.__VEIL && window.__VEIL.filmYaw != null) ? window.__VEIL.filmYaw : r.ya;
  // THE SHOULDER. The look point slides right of the spine, but never through
  // stone: a runner with a wall at their right shoulder is framed centred.
  _shR.set(-Math.cos(vya), 0, Math.sin(vya));
  const wantSh = (vi === 0 && window.__VEIL && window.__VEIL.filmYaw != null) ? 0 : SHOULDER * (climbing ? 0.5 : 1);
  let sh = wantSh;
  if (sh > 0) {
    const hit = Math.min(archRayHit(look, _shR, sh + 0.3), gridAPI.gridRayHit(look.x, look.y, look.z, _shR.x, _shR.y, _shR.z, sh + 0.3));
    if (hit < Infinity) sh = Math.max(0, Math.min(sh, hit - 0.3));
  }
  r.shoulder += (sh - r.shoulder) * expk(sh < r.shoulder ? 14 : 4, dt);
  look.addScaledVector(_shR, r.shoulder);
  camDir.set(-Math.sin(vya)*Math.cos(r.pitch)*boom, Math.sin(r.pitch)*boom + LIFT, -Math.cos(vya)*Math.cos(r.pitch)*boom);
  const full = camDir.length() || 1e-4;
  camDir.divideScalar(full);
  // A PROBE, not a ray. One thin ray flickered between hit and miss as the
  // arm swept past a pillar's edge or a prop, and every flicker was a metre
  // of camera in one frame. Five rays (the axis and four at the rim of a
  // 0.3 m disc at the far end) see the obstacle coming, and the nearest wins.
  camR.crossVectors(camDir, UP).normalize(); camU.crossVectors(camR, camDir);
  let hitD = Infinity;
  for (let k = 0; k < 5; k++) {
    const ox = k === 0 ? 0 : (k === 1 ? 1 : k === 2 ? -1 : 0) * 0.3, oy = k < 3 ? 0 : (k === 3 ? 1 : -1) * 0.3;
    camP.copy(camDir).multiplyScalar(full).addScaledVector(camR, ox).addScaledVector(camU, oy);
    const len = camP.length(); camP.divideScalar(len);
    // the architecture, exactly, from the same boxes the body collides with
    // (an opened gate or a fallen slab is `off` there, so it no longer counts)
    hitD = Math.min(hitD, archRayHit(look, camP, len));
    // ...and the carved stone, from the baked grid
    hitD = Math.min(hitD, gridAPI.gridRayHit(look.x, look.y, look.z, camP.x, camP.y, camP.z, len));
  }
  // Short of the stone, always. This used to be held at CAM_MIN even when the
  // wall was nearer than that, so a runner with their back to a wall put the
  // lens half a metre inside it, looking out at the tomb from behind.
  const reach = hitD < Infinity ? Math.max(CAM_HARD, hitD - CAM_SKIN) : full;
  // Into a wall almost immediately. Back out slowly, or a corner chatters.
  r.arm += (reach - r.arm) * expk(reach < r.arm ? CAM_IN : CAM_OUT, dt);
  if (r.arm > reach && hitD < Infinity) r.arm = reach;
  camera.position.copy(look).addScaledVector(camDir, r.arm);
  // Pinned close by stone behind the runner: rise over the shoulder rather
  // than sit in the runner's head.
  if (r.arm < 1.6) camera.position.y += (1.6 - r.arm) * 1.1;
  if (camera.position.y < 0.7) camera.position.y = 0.7;
  if (r.landDip > 0.001) { camera.position.y -= r.landDip * 0.42; r.landDip *= Math.pow(0.02, dt); }
  else r.landDip = 0;
  keepOutOfStone(look, camera.position);
  // Tiny shake of the follow pivot. Same offset on the eye, so the arm
  // length stays and the spring (focus) does not absorb it.
  if (shake > 0.001) {
    if (vi === 0) shake *= Math.pow(0.0015, dt);
    const k = shake * 0.09;
    const ox = (Math.random() * 2 - 1) * k;
    const oy = (Math.random() * 2 - 1) * k * 0.45;
    const oz = (Math.random() * 2 - 1) * k;
    look.x += ox; look.y += oy; look.z += oz;
    camera.position.x += ox; camera.position.y += oy; camera.position.z += oz;
  }
  // THE OPENING. The first seconds of a run crane down the shaft onto the
  // runner, so the tomb is established before the player has to work in
  // it. Nothing waits on it: control is live from the first frame, and any
  // movement of the camera finishes it at once.
  if (introT < INTRO) {
    const k = Math.min(1, introT / INTRO), e = 1 - Math.pow(1 - k, 3);
    _introFrom.set(look.x - Math.sin(r.ya) * 9, look.y + 13, look.z - Math.cos(r.ya) * 9);
    camera.position.lerpVectors(_introFrom, camera.position, e);
  }
  if (shake > 0.001 || introT < INTRO) keepOutOfStone(look, camera.position);
  camera.lookAt(look);
  if (vi === 0 && window.__VEIL && window.__VEIL.camHold) {
    camera.position.copy(window.__VEIL.camHold.pos);
    camera.lookAt(window.__VEIL.camHold.at);
  }

  // SPEED FOV. A few degrees of widening at a sprint is most of what sells
  // speed in a third-person game; without it running and walking look the
  // same from behind. Eased, because a snapping FOV reads as a glitch. A half
  // screen is narrow, so it starts a little wider.
  const spd = Math.min(1, (me.mps||0) / (RULES.sprint*S));
  const wantFov = settings.fov + (views > 1 ? 6 : 0) + (spd*7 + r.landDip*3) * (0.4 + 0.6*settings.shake/100);
  r.fov += (wantFov - r.fov) * Math.min(1, dt*4.5);
  if (Math.abs(camera.fov - r.fov) > 0.01) { camera.fov = r.fov; camera.updateProjectionMatrix(); }
  // The marker and the name tag project through this camera before it is
  // rendered; with two views it still holds the other view's matrices.
  camera.updateMatrixWorld();
  // Right on top of the player the character fills the frame and the near
  // plane starts slicing through it, so fade it out instead. Not with two
  // views: the fade is on the material, and the other view would see it.
  const near = camera.position.distanceTo(look);
  if (me.mesh) { const f = views > 1 ? 1 : Math.min(1, Math.max(0, (near - CAM_MIN) / 0.9));
    me.mesh.traverse(o=>{ if(!o.isMesh||!o.material) return;
      for(const m of (Array.isArray(o.material)?o.material:[o.material])){
        if(f >= 1){ if(m.userData.vrFaded){ m.transparent=m.userData.vrWasT; m.opacity=1; m.userData.vrFaded=false; } }
        else { if(!m.userData.vrFaded){ m.userData.vrWasT=m.transparent; m.userData.vrFaded=true; }
               m.transparent=true; m.opacity=f; } } }); }
}
// The eight lights, given to the fires nearest THIS view's camera, and the
// lava's warmth under THIS view's runner. Run once per view: two runners in
// two chambers each get their own room lit.
function poolLights(viewer){
  if(world.lightPool && world.emitters){
    const cam=camera.position;
    // WHICH ROOM AM I IN. A point light has no idea a wall is in the way —
    // three.js does not shadow it unless you pay for a cube map per light, and
    // eight of those is 48 extra render passes a frame on a phone. So a lamp in
    // another chamber is DAMPED instead: you still get a suggestion of warmth
    // spilling through a doorway, but a fire behind two feet of stone no longer
    // lights your face. Not shadowing — occlusion at the room level, which is
    // the same thing the walls mean.
    const meNow = viewer;
    const myRoom = meNow ? roomAt(meNow.x, meNow.y, meNow.z || 0) : null;
    const myRoomId = myRoom ? myRoom.id : null;
    for(const e of world.emitters) e._d = e.pos.distanceToSquared(cam);
    // every fire in the tomb is a candidate; the pool still only pays for the
    // eight nearest, which is what keeps forward rendering affordable
    const near = world.emitters.slice().sort((a,b)=>a._d-b._d).slice(0, world.lightPool.length);
    for(let i=0;i<world.lightPool.length;i++){
      const L=world.lightPool[i], e=near[i];
      if(!e){ L.intensity=0; continue; }
      L.position.copy(e.pos); L.color.copy(e.color); L.distance=e.reach;
      if(e.power<=0.01){ L.intensity=0; continue; }   // an unlit brazier costs nothing
      const f=(e.src && e.src.userData.flicker) || 1;
      // fade the furthest one in and out with distance, or lamps pop as you walk
      const d=Math.sqrt(e._d), fade=Math.min(1, Math.max(0, (e.reach*2.2 - d) / (e.reach*0.8)));
      // Global gain on the lamp pool. The tomb is sealed and the only other
      // light is a lava lake 16 m below, so the fires have to carry the room;
      // at 1.0 every chamber read as murk with a bright patch under each lamp.
      // 0.14 through a wall. Not 0 — a doorway you have not reached yet should
      // still glow, and cutting it outright makes rooms snap on and off as you
      // cross a threshold, which reads worse than the leak did.
      const through = (e.room && myRoomId && e.room !== myRoomId) ? 0.14 : 1;
      L.intensity=e.power*f*fade*1.5*through;
    }
  }
  // the lava's warmth follows the runner this view belongs to
  if(world.lavaGlow){
    // Track the player horizontally and sit at lava height. Intensity falls off
    // with how far above the lava they are, so standing on the low ruins is
    // visibly warmer than being up the tower — the drop reads as a heat source.
    const L=world.lavaGlow, m=viewer;
    if(m && m.mesh){
      L.position.x = m.mesh.position.x; L.position.z = m.mesh.position.z;
      const above = Math.max(0, m.mesh.position.y - L.position.y);
      L.intensity = 16 * Math.max(0, 1 - above/26);
    } else L.intensity = 0;
  }
}
// A name over the other runner, in each view. Solo has nobody to name: the
// partner slot is a statue at the door.
const tagEls=[...document.querySelectorAll('#tags .tag')], tagV=new THREE.Vector3();
function placeTag(vi, viewer){
  const el=tagEls[vi]; if(!el) return;
  const mate = game.phase==='playing' && viewer ? game.players.find(q=>q!==viewer && !q.isBot && !q.deadUntil && q.mesh && q.id<2) : null;
  if(!mate){ if(!el.classList.contains('off')) el.classList.add('off'); return; }
  // over the HEAD, wherever the clip has put it: a hanging or climbing body
  // is a metre and more off its own origin
  if(mate._head===undefined){ mate._head=null; if(mate.model) mate.model.traverse(o=>{ if(!mate._head && o.isBone && /head$/i.test(o.name)) mate._head=o; }); }
  if(mate._head){ mate._head.getWorldPosition(tagV); tagV.y += 0.42; }
  else { tagV.copy(mate.mesh.position); tagV.y += mate.crouch ? 1.55 : 2.1; }
  const dist = Math.hypot((mate.x-viewer.x)*S, (mate.y-viewer.y)*S, (mate.z||0)-(viewer.z||0));
  tagV.project(camera);
  if(tagV.z>1 || Math.abs(tagV.x)>1.05 || Math.abs(tagV.y)>1.05){ el.classList.add('off'); return; }
  const W=innerWidth/views;
  el.style.transform=`translate(${vi*W+(tagV.x+1)/2*W}px,${(1-tagV.y)/2*innerHeight}px) translate(-50%,-100%)`;
  const cls='tag '+(mate.id===0?'p1':'p2');
  if(el.className!==cls) el.className=cls;
  const b=el.firstChild, sp=el.lastChild, txt=dist>4 ? Math.round(dist)+' m' : '';
  if(b.textContent!==mate.name) b.textContent=mate.name;
  if(sp.textContent!==txt) sp.textContent=txt;
}
// One view, or two side by side. The composer is sized to a single view
// (fitViews) and each pass renders into the canvas through the viewport.
function renderViews(dt){
  renderer.info.reset();
  const playing = game.phase==='playing';
  if (playing && introT < INTRO) { introT += dt; if (lookAccum > 0.02) introT = INTRO; }
  if (views === 1) {
    const me = meOf();
    if (playing && me) aimRig(rigs[0], me, dt, 0);
    poolLights(me);
    if (playing && me) drawMarker(me, 0);
    placeTag(0, playing ? me : null); placeTag(1, null);
    composer.render();
    return;
  }
  const W = Math.floor(innerWidth / 2), H = innerHeight;
  renderer.setScissorTest(true);
  for (let vi = 0; vi < 2; vi++) {
    const me = game.players[vi];
    aimRig(rigs[vi], me, dt, vi);
    poolLights(me);
    drawMarker(me, vi);
    placeTag(vi, me);
    renderer.setViewport(vi * W, 0, W, H); renderer.setScissor(vi * W, 0, W, H);
    composer.render();
  }
  renderer.setScissorTest(false);
  renderer.setViewport(0, 0, innerWidth, innerHeight);
}
function frame(now){ const dt=Math.min(MAX_FRAME_DT,(now-last)/1000); last=now;
  // torches flicker + water ripple + relic spin
  const t=now/1000;
  // Flame geometry flickers for every torch; the LIGHTS are a fixed pool.
  (window.__torches||[]).forEach((g,i)=>{ const f=0.7+Math.sin(t*12+i)*0.2+Math.random()*0.1;
    g.userData.flicker=f; if(g.userData.flame) g.userData.flame.scale.y=0.8+f*0.5; });
  // Assign the pool to the nearest emitters. Forward rendering evaluates every
  // light in every fragment, so what matters is the COUNT, not the total number
  // of fires in the level — 45 lamps light the tomb, 8 lights pay for it.
  // ---- the lava below ----
  // The crust creeps on its own clock. One uniform, one plane, no per-frame
  // geometry work; `t` is simulated seconds so it does not speed up on a fast
  // machine or stall on a slow one.
  if(world.lavaMat) world.lavaMat.userData.uT.value = t;
  // suspended silt drifts in the vertex shader; this is the only CPU cost
  if(world.dustMat && world.dustMat.userData.uT) world.dustMat.userData.uT.value = t;
  // the sanctum brightens as the puzzle comes together: the three braziers had
  // no light at all, so lighting one changed nothing you could see
  if(world.brazierEmitters && game.interact){
    for(const e of world.brazierEmitters){
      const it=game.interact.byId[e.id]; if(!it) continue;
      const want = it.lit ? 26 + Math.sin(t*9+e.id.charCodeAt(8))*4 : 0;
      e.power += (want - e.power) * Math.min(1, dt*3.5);
    }
  }
  if(world.water){ const pa=world.water.geometry.attributes.position, base=world.water.userData.base; for(let i=0;i<pa.count;i++){ const x=base[i*3],y=base[i*3+1]; pa.setZ(i, Math.sin(x*3+t*2)*0.04+Math.cos(y*3+t*1.5)*0.04); } pa.needsUpdate=true; }
  silt.update(dt, t, game.players, PLACED);
  if(world.ritual) world.ritual.rotation.y += dt*0.08;
  // the counterweight wheel turns with the bridge, the Cradle sways on its chains
  if(world.gear && game.mech) world.gear.rotation.z = -game.mech.bridge * Math.PI * 1.5;
  if(world.cradle){ world.cradle.rotation.z = Math.sin(t * 0.21) * 0.012;
    const sm = world.cradle.userData.silt;            // the warmth under the crust breathes
    if (sm) sm.emissiveIntensity = 1.0 + Math.sin(t * 0.7) * 0.18 + Math.sin(t * 1.9) * 0.06; }
  // Mechanism visuals run per FRAME with a variable dt, deliberately: nothing
  // syncVisuals touches can change the outcome, so it is free to interpolate.
  if(game.mech) game.mech.syncVisuals(world, PLACED, t);

  // ---- HOLD LEVERS: make holding one visible and audible ----
  // `audio.lever()` only ever fired on the `used` edge, which is a PULL lever.
  // A hold lever — the winch, the two counterweight levers, the crane — had no
  // sound and no movement at all: you stood there with E down and the only
  // acknowledgement anywhere was a small number on the HUD. That is what "the
  // lever logic is not proper" looks like from the player's seat. The handle
  // now throws over while it is held and springs back when released, with a
  // clack on each edge and a ratchet while it is being worked.
  if(game.interact && game.interact.items){
    for(const it of game.interact.items){
      if(it.kind!=='lever' || it.mode!=='hold') continue;
      // The prop key is not always the interactable id: the winch lever's model
      // is placed as `winch`. PLACED['lever_winch'] was simply undefined, so the
      // one lever the player is most likely to meet first animated not at all.
      const props = PLACED[LEVER_PROP[it.id] || it.id];
      const want = it.held ? 1 : 0;
      // ease toward the held pose: a handle that snaps reads as a teleport
      it._throw = (it._throw||0) + (want - (it._throw||0)) * Math.min(1, dt*9);
      if(props) for(const m of props){
        if(m.userData.leverRest===undefined) m.userData.leverRest = m.rotation.x;
        m.rotation.x = m.userData.leverRest + it._throw * 0.62;   // ~36 degrees over
      }
      if(it.held !== it._wasHeld){
        audio.lever();                      // clack on grab AND on release
        it._wasHeld = it.held;
      }
      // a ratchet while it is actually being worked, paced so it is a mechanism
      // rather than a buzz
      if(it.held){
        it._tick = (it._tick||0) + dt;
        if(it._tick > 0.28){ it._tick = 0; audio.stone(); }
      } else it._tick = 0;
    }
  }

  // ---- falling masonry: the tell, then the block ----
  if(world.debrisPool && game.mech){
    const D=game.mech.debris||[];
    for(let i=0;i<world.debrisPool.length;i++){
      const slot=world.debrisPool[i], d=D[i];
      if(!d){ if(slot.grp.visible) slot.grp.visible=false; continue; }
      slot.grp.visible=true;
      const c=to3(d.x,d.y);
      const gnd=groundAt(d.x,d.y);
      slot.grp.position.set(c.x, 0, c.z);
      if(d.t<0){
        // the TELL: dust ring brightening on the floor, block still above
        const k=1-(-d.t/MECH.debrisTell);
        slot.ring.position.y=gnd+0.02; slot.ring.material.opacity=0.15+k*0.85;
        slot.ring.scale.setScalar(1.25-k*0.45);          // the shadow tightens as it comes
        slot.blk.position.y=gnd+7.5-k*2.0;
        slot.blk.visible=k>0.35;
      } else {
        // the fall and the rubble it leaves
        const f=Math.min(1,d.t/0.22);
        slot.blk.visible=true;
        slot.blk.position.y=gnd+5.5*(1-f)+0.25;
        slot.ring.material.opacity=Math.max(0,1-d.t*1.6); slot.ring.scale.setScalar(0.8+d.t*0.4);
        if(d.t>0.22 && !slot._thud){ slot._thud=true; audio.land(1); shake=Math.max(shake,0.5*settings.shake/100); }
        if(d.t<0.05) slot._thud=false;
      }
    }
  }

  // ---- DISCOVERY: an unopened chamber is not drawn and is not lit ----
  // This runs AFTER mech.syncVisuals and only ever turns things OFF, so the
  // two compose: mech decides what a mechanism looks like inside a room the
  // player has reached, and this hides whole rooms they have not.
  // Everything is DRAWN and everything is LIT. The rooms system still tracks
  // where you have been — it drives the chamber counter and the feed, and the
  // netcode still carries it — but it no longer hides anything. Hiding made the
  // tomb unreadable rather than mysterious; the portcullis gates progress.
  for(const k in PLACED){ const list=PLACED[k];
    for(const m of list){ const show = !m.userData.mechHide;
      if(m.visible!==show) m.visible=show; } }

  // ---- SOUND ----
  if(game.phase==='playing' && game.mech){
    const me1=meOf(), mech=game.mech, inter=game.interact, story=game.story;
    // beds follow the world: torch crackle by proximity, water by the flood
    let nearFire=99;
    if(world.emitters){ const c=camera.position;
      for(const e of world.emitters){ if(e.power<=0.01) continue;
        const d=e.pos.distanceTo(c); if(d<nearFire) nearFire=d; } }
    audio.update(dt, { nearestFire:nearFire,
      submersion: me1?mech.submersion(me1):0, flooding: !!mech.flooding });

    // mechanisms: stone moving, and the tiles that ARE the rhythm of beat 4
    snd.edge('bridge', mech.bridgeReleased?1:0, ()=>audio.stone(1.6, 0.30), true);
    snd.edge('seal',   mech.sealReleased?1:0,   ()=>audio.stone(1.9, 0.28), true);
    snd.edge('front',  mech.frontReleased?1:0,  ()=>audio.stone(1.3, 0.26), true);
    snd.edge('crane',  mech.byId.crane_arm && !mech.byId.crane_arm.off?1:0,
             (was,v)=>audio.stone(0.6, v?0.22:0.16));
    for(const id of ['tile_a','tile_b','tile_c']){
      const w=mech.byId[id]; if(!w) continue;
      snd.edge('t_'+id, w.off?1:0, ()=>audio.tile());
    }
    if(inter){
      snd.edge('lit',    inter.st.order.length, ()=>audio.fire(), true);
      snd.edge('resets', inter.st.failures,     ()=>audio.wrong(), true);
      snd.edge('disc',   inter.st.relicTaken?1:0, ()=>audio.relic(), true);
      const used = inter.items.filter(i=>i.used).length;
      snd.edge('used',   used, (was,v)=>{ if(v>was && !inter.st.relicTaken) audio.lever(); }, true);
    }
    if(story){
      snd.edge('beat',   story.beat,   ()=>audio.beat(), true);
      snd.edge('deaths', story.deaths, ()=>audio.death(), true);
    }
    snd.edge('won', game.won?1:0, ()=>audio.win(), true);
  }
  game.relics.forEach(r=>{ if(r.mesh){ r.mesh.userData.gem.rotation.y+=dt*1.2; r.mesh.position.y=(r.z||0)+0.5+Math.sin(t*2+r.id)*0.12; } });
  const doorOpen = !!(game.mech && game.mech.front >= 1);
  game.zones.forEach(z=>{
    if(!z.mesh) return;
    z.mesh.visible = doorOpen;
    if(doorOpen && z.mesh.userData.runes) z.mesh.userData.runes.rotation.y+=dt*0.4;
  });

  lookAccum = 0;
  padA.poll(); padB.poll(); assignPads();
  if ((splitLive() && game.phase==='playing' ? 2 : 1) !== views) fitViews();
  for (const pd of [pad, pad2]) if (pd && pd.connected && game.phase==='playing') {
    if (pd.consume('start')) onEscape();
    if (paused && (pd.consume('a') || pd.consume('b'))) setPaused(false);
  }
  const live = game.phase==='playing' && !paused && !ui.depth;
  // Player two's buttons become edges here, like player one's below, and are
  // cleared only by the tick that reads them.
  if (live && pad2 && pad2.connected) {
    look(pad2.look.x * dt * 3.0, pad2.look.y * dt * 2.2, rigs[1]);
    if (pad2.consume('a')) p2.jumpEdge = true;
    if (pad2.consume('b')) p2.dodgeEdge = true;
    if (pad2.consume('y')) p2.crouch = !p2.crouch;
    if (pad2.consume('rt')) p2.attackEdge = true;
    if ((pad2.consume('lb') || pad2.consume('l3')) && settings.sprintToggle) p2.sprintLatch = !p2.sprintLatch;
  }
  if (!pad) pad = NOPAD;
  if (touch) {
    const d = touch.takeLook();                       // drag-to-look replaces pointer lock
    if (touch.consumeEdge('pause') && game.phase==='playing') onEscape();
    if (live) {
      look(d.dx * 0.0045, d.dy * 0.0040);
      if (touch.consumeEdge('c')) crouch = !crouch;
      if (touch.consumeEdge(' ')) jumpEdge = true;
      if (touch.consumeEdge('strike')) attackEdge = true;
      if (touch.consumeEdge('q')) dodgeEdge = true;
      if (touch.consumeEdge('e') && settings.useToggle) useLatch = !useLatch;
      if (touch.consumeEdge('f') && settings.guardToggle) guardLatch = !guardLatch;
    }
  }
  if (live && pad.connected) {
    look(pad.look.x * dt * 3.0, pad.look.y * dt * 2.2);
    if (pad.consume('a')) jumpEdge = true;
    if (pad.consume('b')) dodgeEdge = true;
    if (pad.consume('y')) crouch = !crouch;
    if (pad.consume('rt')) attackEdge = true;
    if ((pad.consume('lb') || pad.consume('l3')) && settings.sprintToggle) sprintLatch = !sprintLatch;
    if (pad.consume('x') && settings.useToggle) useLatch = !useLatch;
    if (pad.consume('lt') && settings.guardToggle) guardLatch = !guardLatch;
  }
  // Solo, a pause freezes the tomb. In co-op the host keeps simulating for the
  // partner, and the paused runner simply stands still.
  if(game.phase==='playing' && (!paused || coopLive())){
    // Fixed-step simulation. Everything with a gameplay consequence advances in
    // whole TICKs; `alpha` is how far we are into the next one, and the render
    // below interpolates by it.
    // hitstop: hold the simulation still, keep rendering
    if (hitStop > 0) { hitStop -= dt; acc = 0; }
    else acc += dt;
    let steps = 0;
    while (acc >= TICK && steps < MAX_CATCHUP_STEPS) {
      const cl=v=>Math.max(-1,Math.min(1,v));
      const on = live;
      const fwd   = on ? cl((keys.has('w')?1:0)-(keys.has('s')?1:0) + (touch?touch.axes.fwd:0) + pad.move.fwd) : 0;
      const strafe= on ? cl((keys.has('d')?1:0)-(keys.has('a')?1:0) + (touch?touch.axes.strafe:0) + pad.move.strafe) : 0;
      const ya = rigs[0].ya;
      const holdSprint = keys.has('shift') || (touch && Math.hypot(touch.axes.fwd,touch.axes.strafe)>0.92) || pad.held.has('lb') || pad.held.has('l3');
      const holdUse = keys.has('e') || !!(touch&&touch.held.has('e')) || pad.held.has('x');
      const holdGuard = keys.has('f') || !!(touch&&touch.held.has('f')) || pad.held.has('lt');
      // a toggled run ends when the stick or keys come to rest, like every
      // console game that offers it — otherwise the next step is a sprint
      if (sprintLatch && Math.hypot(fwd, strafe) < 0.1) sprintLatch = false;
      const human={ mx:fwd*Math.sin(ya)-strafe*Math.cos(ya), my:fwd*Math.cos(ya)+strafe*Math.sin(ya),
        fwd, strafe,                       // raw axes, for ledge shimmy and mantle
        sprint: on && (settings.sprintToggle ? (sprintLatch || (touch && Math.hypot(touch.axes.fwd,touch.axes.strafe)>0.92)) : holdSprint),
        crouch: on && crouch,
        interact: on && (settings.useToggle ? useLatch : holdUse),
        block: on && (settings.guardToggle ? guardLatch : holdGuard),
        attack:on&&attackEdge, dodge:on&&dodgeEdge, jump:on&&jumpEdge,
        jumpHeld: on && (keys.has(' ') || !!(touch && touch.held.has(' ')) || pad.held.has('a')) };
      // Edges are cleared by the tick that consumes them, never by the frame.
      // At 120 Hz a frame often runs no tick at all, and clearing per frame
      // silently drops the press — this is input buffering, and it is free here.
      attackEdge=false; dodgeEdge=false; jumpEdge=false;
      if (splitLive()) game.remoteInput = p2Input(on);
      if (net && net.connected && !net.isHost) {
        net.sendInput(human);     // our input is authoritative only on the host
        net.applySnapshot();      // reconcile BEFORE predicting this tick forward
      }
      if (net && net.isHost) game.remoteInput = net.remoteInput;
      game.update(TICK, human);
      acc -= TICK; steps++;
      if(game.phase==='results') break;
    }
    // Too far behind to catch up: drop the backlog rather than spiral.
    if (steps >= MAX_CATCHUP_STEPS) acc = 0;
    if (net && net.isHost) {               // broadcast at SNAPSHOT_HZ, not per tick
      snapAcc += dt;
      if (snapAcc >= 1 / SNAPSHOT_HZ) { snapAcc = 0; net.sendSnapshot(); }
    }
    alpha = Math.min(1, acc / TICK);
    if (game.impact && game.impact.at !== lastImpact) {
      lastImpact = game.impact.at;
      // 3 frames at 60 Hz. A second hit during the freeze does not restart it,
      // or game.t never advances again.
      if (hitStop <= 0) hitStop = 3 / 60;
      shake = Math.max(shake, (game.impact.kill ? 0.32 : 0.22) * settings.shake / 100);
      audio.hit(!!game.impact.kill);
      const vic = game.players.find(q => q.id === game.impact.victim);
      if (vic) vic.flash = 4 / 60;
      burstSparks(game.impact);
    }
    // LANDING. A drop that ends with no acknowledgement reads as the character
    // being teleported to the floor. Scaled by real impact speed, so a hop off
    // a kerb costs nothing and a two-storey drop is felt.
    for (let vi = 0; vi < views; vi++) {
      const me0 = vi === 0 ? meOf() : game.players[1];
      if (!me0 || !me0.landImpact) continue;
      const k = Math.min(1, Math.max(0, (me0.landImpact - MOVE.landSoft) / (MOVE.landHard - MOVE.landSoft)));
      if (k > 0.02) { const m = settings.shake / 100; rigs[vi].landDip = Math.max(rigs[vi].landDip, k * m); shake = Math.max(shake, k * 0.5 * m); audio.land(k); }
      me0.landImpact = 0;
    }
  } else if(game.phase!=='playing'){ orbit+=dt*0.08; alpha=1; }
  // The board appears once per finished run, however the run finished: in a
  // host tick, or in a snapshot that told a guest the tomb was cleared.
  // THE ENDING. A won run does not cut straight to a scoreboard: the camera
  // pulls out of the doorway as the tomb floods behind you, the title holds,
  // and the board fades in after. Any key or click skips it.
  if(game.phase==='results' && !resultsShown){
    if(game.won && endingT < 0){ endingT = 0; startEnding(); }
    if(!game.won || endingT >= ENDING || endingSkip){ resultsShown=true; finishEnding(); showResults(); }
  }
  if(endingT >= 0 && !resultsShown) endingT += dt;
  if(game.phase==='playing') resultsShown=false;

  // sync meshes
  for(const p of game.players){
    const ix=lerp(p.px,p.x,alpha), iy=lerp(p.py,p.y,alpha);
    const ia=lerpAngle(p.pangle,p.angle,alpha);
    let iz=lerp(p.pz||0,p.z||0,alpha);
    // STEP SMOOTHING. Walking up a stair tread teleports the body 0.36 m in one
    // tick, which on a seven-step run is seven visible pops. The SIMULATION
    // still steps instantly — only the drawn height is eased, and only for
    // rises small enough to be a step rather than a fall.
    if(p.visZ===undefined) p.visZ=iz;
    const dz=iz-p.visZ;
    if(Math.abs(dz) > 0.9 || p.state==='air' || p.state==='hang' || p.state==='mantle' || p.state==='vault') p.visZ=iz;
    else p.visZ += dz * Math.min(1, dt*MOVE.stepSmooth);
    iz = p.visZ;
    const v=to3(ix,iy); p.mesh.visible = !p.deadUntil && (p.id===0 || p.vis>0.15);
    p.mesh.position.set(v.x,iz,v.z);
    // The drawn facing has the same guard as the drawn position: lowering off
    // an edge turns the body 180 degrees to face the wall in one tick, and drawn
    // as-is the runner flipped round in a frame. Large turns rotate at 14 rad/s.
    if (p._va === undefined || p._snapSeenA !== p.snapN) { p._va = ia; p._snapSeenA = p.snapN; }
    { let d = ia - p._va; d = Math.atan2(Math.sin(d), Math.cos(d));
      const mx = Math.max(0.6, 14 * dt);
      p._va += Math.abs(d) > mx ? Math.sign(d) * mx : d; }
    p.mesh.rotation.y=Math.atan2(Math.cos(p._va),Math.sin(p._va));
    // Weights and the locked traversal-clip time first, THEN the mixer, so this
    // frame shows the pose that was just requested instead of last frame's.
    if (p.mesh.anim) p.mesh.anim(lerp(p.pphase,p.phase,alpha), p.gait||0, p.crouch, p.mps||0, p, dt);
    if (p.mixer) p.mixer.update(dt);

    // ---- put the hands ON the ledge ----
    // The simulation parks a hanging body PHYS.hangBelow under the lip and one
    // collision radius out from the face, which is what the physics wants. The
    // Mixamo hang pose puts the hands somewhere else entirely — measured at
    // 1.55 m above the stone and 0.69 m clear of it, so the character appeared
    // to be gripping thin air beside the wall. Correcting the BODY would change
    // what the physics means, so the correction goes on the mesh: gameplay keeps
    // its numbers, the model lines up with the rock. Both values come from
    // calibrateRig, so a different character re-derives them.
    if(p.rig && p.wrap){
      const sstep = u => { const x = Math.min(1, Math.max(0, u)); return x*x*(3-2*x); };
      const cr = climbRootSampler(p);
      if(p.state!=='hang') p._hang0 = null;
      if(p.state==='hang' && p.ledge){
        // ---- THE BRACED HANG: pivot about the hands ----
        // The hands go on the lip (the rig's calibrated hand point, placed
        // just over the edge). The clip hangs the body straight under them,
        // which would bury the chest in the stone, so the whole body PIVOTS
        // about the hands, tilting out from the wall just far enough to clear
        // the chest and hips; the leg IK then braces the feet on the face.
        // Pushing the body out bodily, which is what this used to do, left the
        // arms reaching a metre horizontally to a lip they were not under.
        let hold = 1;
        if(p.catchT != null && p.catchT < PHYS.catchTime) hold = sstep(p.catchT / PHYS.catchTime);
        const gap = hangGap(p);
        const vf = visibleFace(p);
        const clear = hangClearance(p, vf);
        // Tilt a little, the way a braced body leans off its hands; past
        // HANG_TILT it stops being a hang and becomes a plank in mid-air, so
        // whatever clearance is still missing comes from easing the whole body
        // out a few centimetres instead. The legs are the foot IK's.
        if(clear != null){
          const need = (HANG_SKIN - clear) * Math.min(1, dt*14);
          if((p._tilt||0) < HANG_TILT || need < 0) p._tilt = Math.min(HANG_TILT, Math.max(0, (p._tilt||0) + need * 1.6));
          if((p._tilt||0) >= HANG_TILT - 1e-3 || (p._out||0) > 0) p._out = Math.min(0.45, Math.max(0, (p._out||0) + need));
        }
        const a = (p._tilt || 0) * hold;
        const hy = p.rig.lift, hz = p.rig.reach;
        const bob = (p.catchT != null && p.catchT < PHYS.catchTime) ? 0 : Math.sin(game.t / 1000 * 2.3) * 0.012;
        // hands on the VISIBLE lip: its height and how far it stands out
        const ty = PHYS.hangBelow + 0.03 + (vf ? vf.topDy : 0) + bob;
        const tz = gap + 0.06 - (vf ? vf.lip : 0);
        // Blend in FROM whatever offset the body carried into the hang, not
        // from zero. A climb ends with the drawn body up to 1.6 m off the sim
        // (the warp cancelling the clip's own root motion while both fade),
        // and a drop-hang straight after it zeroed that in one frame.
        if (!p._hang0 || p._hang0.ledge !== p.ledge) p._hang0 = { ledge: p.ledge, x: p.wrap.position.x, y: p.wrap.position.y, z: p.wrap.position.z, r: p.wrap.rotation.x };
        const h0 = p._hang0, k0 = 1 - hold;
        p.wrap.rotation.x = a + h0.r * k0;
        p.wrap.position.x = h0.x * k0;
        p.wrap.position.y = (ty - (hy*Math.cos(a) - hz*Math.sin(a))) * hold + h0.y * k0;
        p.wrap.position.z = (tz - (hy*Math.sin(a) + hz*Math.cos(a)) - (p._out || 0)) * hold + h0.z * k0;
        p._m0 = null;
      } else if(p.state==='mantle' && p.ledge && cr){
        // ---- THE CLIMB: the climb-top clip, motion-warped ----
        // V0 = where the hips were at the hang, V1 = where they stand when
        // the climb is done. The clip's own root motion, scaled per axis, is
        // what carries them from one to the other, so the pull-up, the knee
        // over the lip and the stand all happen where the stone is.
        const g = p.ledge;
        if(!p._m0){
          const z1 = g.top, gap1 = -mantleInset(g) * S;
          const W0 = p.wrap.position.clone(), R0 = cr.r0, R1 = cr.r1;
          // standing hips: the idle pose, or the clip's own stand less its 1.8 m rise
          const Ri = cr.idle || new THREE.Vector3(R1.x, R0.y - 0.05, R1.z);
          const dSimY = z1 - iz, dSimZ = hangGap(p) - gap1;
          const needY = dSimY + Ri.y - W0.y - R0.y, needZ = dSimZ + Ri.z - W0.z - R0.z;
          const span = (n, d) => Math.abs(d) > 0.05 ? n / d : 1;
          p._m0 = { W0, R0, z0: iz, gap0: hangGap(p), tilt: p.wrap.rotation.x,
                    ky: span(needY, R1.y - R0.y), kz: span(needZ, R1.z - R0.z) };
        }
        p._hang0 = null;
        const m = p._m0, u = Math.min(1, p.mantle || 0);
        const R = cr.at(CLIMB_SPAN[0] + u * (CLIMB_SPAN[1] - CLIMB_SPAN[0]));
        const dSimY = iz - m.z0, dSimZ = m.gap0 - hangGap(p);
        p.wrap.rotation.x = m.tilt * (1 - sstep(u / 0.3));
        p.wrap.position.x = m.W0.x * (1 - u) - (R.x - m.R0.x);
        p.wrap.position.y = m.W0.y + (m.ky - 1) * (R.y - m.R0.y) - dSimY;
        p.wrap.position.z = m.W0.z + (m.kz - 1) * (R.z - m.R0.z) - dSimZ;
        // FOOT PLANT. The warp is exact for the hips, not the feet: the clip's
        // last step put a sole 0.2 m under the floor it had just climbed onto.
        // Once a foot is over the top, it may not go below the top.
        if (u > 0.4) {
          if (!p._feet) { p._feet = []; p.model.traverse(o => { if (o.isBone && /(Left|Right)Foot$/.test(o.name)) p._feet.push(o); }); }
          p.model.updateMatrixWorld(true);
          const lip = to3(g.ex, g.ey); let sink = 0;
          for (const f of p._feet) {
            f.getWorldPosition(_footV);
            const inward = -((_footV.x - lip.x) * g.nx + (_footV.z - lip.z) * g.ny);
            // only a foot that is over the top AND up at it: one still on the
            // face below the lip is the clip's knee-up, and lifting the whole
            // body to clear it threw the runner 0.8 m up in a frame
            if (inward > 0.04 && _footV.y > g.top - 0.3) sink = Math.max(sink, g.top + 0.085 - _footV.y);
          }
          // eased both ways, never a step: at most 4 m/s up (7 cm a frame)
          const prevPlant = p._plant || 0;
          p._plant = sink > prevPlant ? Math.min(sink, prevPlant + 4 * dt) : prevPlant * Math.exp(-8 * dt);
          p.wrap.position.y += p._plant;
        } else p._plant = 0;
      } else if(p.wrap.position.lengthSq() > 0 || p.wrap.rotation.x !== 0){
        // Back to the plain body: ease the offset out rather than snap it.
        p._m0 = null; p._tilt = 0; p._out = 0; p._vf = null; p._hang0 = null;
        const k = 1 - Math.exp(-10 * dt);
        p.wrap.position.multiplyScalar(1 - k);
        p.wrap.rotation.x *= (1 - k);
        if (p.wrap.position.lengthSq() < 1.6e-5 && Math.abs(p.wrap.rotation.x) < 0.002) { p.wrap.position.set(0, 0, 0); p.wrap.rotation.x = 0; }
      }
    }
    // The grab parks the body on the face in one tick. Slide the MESH from
    // where the jump actually was, so the hands travel to the lip.
    if(p.state==='hang' && p.grabFromX != null && p.catchT != null && p.catchT < PHYS.catchTime){
      const u = p.catchT / PHYS.catchTime;
      const k = 1 - u*u*(3-2*u);
      const from = to3(p.grabFromX, p.grabFromY);
      p.mesh.position.x += (from.x - p.mesh.position.x) * k;
      p.mesh.position.z += (from.z - p.mesh.position.z) * k;
      p.mesh.position.y += ((p.grabFromZ||0) - p.mesh.position.y) * k;
    }
    // CONTINUITY. Whatever the simulation did this tick — a grab that parks the
    // body on the face, a low mantle, a step the collision resolved, a vault
    // starting — the drawn body never covers more ground in a frame than a body
    // can. A larger jump is absorbed into an offset that bleeds away over
    // ~70 ms: the error smoothing a netcode uses, applied to every discontinuity.
    // A respawn bumps snapN and cuts cleanly.
    {
      const P = p.mesh.position;
      if (!p._vo || p._snapSeen !== p.snapN) { p._vo = new THREE.Vector3(); p._vt = P.clone(); p._snapSeen = p.snapN; }
      const dx = P.x - p._vt.x, dy = P.y - p._vt.y, dz = P.z - p._vt.z;
      const lim = Math.max(0.22, 7 * dt), limY = Math.max(0.45, 12 * dt);
      if (Math.hypot(dx, dz) > lim || Math.abs(dy) > limY) { p._vo.x -= dx; p._vo.y -= dy; p._vo.z -= dz; }
      p._vt.copy(P);
      if (p._vo.lengthSq() > 25) p._vo.set(0, 0, 0);          // over 5 m is a teleport meant as one
      p._vo.multiplyScalar(Math.exp(-14 * dt));
      P.add(p._vo);
    }
    // Two-bone foot plant, shoulder lag on a turn, and the landing squash.
    // After the mixer, so it edits the posed skeleton rather than the bind pose.
    if (game.phase === 'playing') applyPosePolish(p, dt, groundAt);

    // Contact shadow. Hung on the floor under the body, faded out with height
    // so a jump does not drag a black disc through the air.
    if (!p.blob) p.blob = contactBlob();
    const gz = groundAt(ix, iy);
    const above = (p.z || 0) - gz;
    const showBlob = !p.deadUntil && p.state !== 'hang' && p.state !== 'mantle' && above < 3.2 && above > -0.05;
    p.blob.visible = showBlob && p.mesh.visible;
    if (p.blob.visible) {
      p.blob.position.set(v.x, gz + 0.03, v.z);
      p.blob.material.opacity = p.state === 'ground' ? 0.72 : Math.max(0, 0.72 * (1 - above / 2.4));
    }

    // FOOTSTEPS. The stride phase advances by ground actually covered, so a
    // footfall is a crossing of PI — which means steps stay in sync with the
    // legs at every speed, and stop dead when the body does.
    if((p.id===(game.localId||0) || (splitLive() && p.id===1)) && game.phase==='playing'){
      const ph=p.phase||0;
      if(p._lastStepPh===undefined) p._lastStepPh=ph;
      if(p.state==='ground' && (p.mps||0)>0.4 &&
         Math.floor(ph/Math.PI) !== Math.floor(p._lastStepPh/Math.PI)){
        audio.footstep(Math.min(1,(p.mps||0)/6.9), !!p.crouch);
      }
      p._lastStepPh=ph;
      if(p._wasState!=='hang' && p.state==='hang') audio.grab();
      if(p._wasState==='ground' && p.state==='air' && (p.vz||0)>1) audio.jump();
      p._wasState=p.state;
    }
    p.mesh.setCarrying(!!game.carrying(p));
    if (p.flash > 0) {
      p.flash -= dt;
      paintFlash(p.mesh, p.flash > 0);
    }
    if(p.ring) p.ring.visible = false;
  }
  for(const r of game.relics){ if(r.mesh){ const owned=!!r.owner, hidden=r.availableAt>game.t; r.mesh.visible=!owned&&!hidden;
    if(!owned){ const v=to3(lerp(r.px,r.x,alpha),lerp(r.py,r.y,alpha)); r.mesh.position.x=v.x; r.mesh.position.z=v.z; } } }

  // The cameras are aimed at render time, one per view (renderViews).
  const me=meOf();
  if(game.phase==='results' && endingT >= 0 && !resultsShown && me){
    // the ending crane: up and out of the doorway, looking back at the runner
    const k = Math.min(1, endingT / ENDING), e = k * k * (3 - 2 * k);
    const base = to3(me.x, me.y);
    camLook.set(base.x, (me.z||0) + 1.3 + e * 0.8, base.z);
    camera.position.set(base.x + 2.5 + e * 9, (me.z||0) + 1.8 + e * 7.5, base.z + 3.5 - e * 1.5);
    camera.lookAt(camLook);
  } else if(game.phase!=='playing'){ // menu orbit
    for (const rg of rigs) rg.ready = false;
    const r=24; camera.position.set(Math.sin(orbit)*r, 12+Math.sin(orbit*0.6)*3, Math.cos(orbit)*r);
    camera.lookAt(0,1.5,0);
  }

  if(!paused) tuneFrame(dt*1000);
  if(game.phase==='playing') updateHUD(dt);
  if(settings.fps){ fpsAcc+=dt; fpsN++; if(fpsAcc>=0.5){ document.getElementById('fps').textContent=`${Math.round(fpsN/fpsAcc)} FPS · ${qctx.current.name}`; fpsAcc=0; fpsN=0; } }
  if (hitStop <= 0) tickSparks(dt);
  renderViews(dt);
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

// One objective diamond per view. Player two's is #marker2.
const markers = ['marker','marker2'].map(id => { const d=document.createElement('div'); d.id=id; d.className='off';
  d.innerHTML='<i></i><span></span>'; document.getElementById('hud').appendChild(d); return d; });
const markerEl = markers[0];
const markV = new THREE.Vector3();
// Where the current beat wants you: the next chamber's checkpoint, and in the
// last beat the way out. The diamond is a nudge, not a route — it points at a
// place, and the chamber's own puzzle still has to be read to get there.
function objectiveTarget(){
  const st=game.story; if(!st) return null;
  if(st.beat >= BEATS.length-1){ const z=game.zones[0]; return z && game.mech && game.mech.front>=1 ? { x:z.x, y:z.y, z:0 } : null; }
  if(st.beat === 5 && game.interact){         // three fires: the next one to light, then the disc
    const inter=game.interact;
    if(inter.st.solved){ const r=inter.items.find(i=>i.kind==='relic'); return r ? { x:r.x, y:r.y, z:r.z||5.6 } : null; }
  }
  return CHECKPOINTS[Math.min(st.beat+1, CHECKPOINTS.length-1)];
}
function drawMarker(me, vi=0){
  const el = markers[vi];
  if(vi===0 && views===1) markers[1].className='off';
  const t = settings.marker && objectiveTarget();
  if(!t){ el.className='off'; return; }
  const c=to3(t.x,t.y); markV.set(c.x,(t.z||0)+1.4,c.z);
  const dist=Math.hypot((t.x-me.x)*S,(t.y-me.y)*S);
  if(dist<3.5){ el.className='off'; return; }
  markV.project(camera);
  const behind = markV.z > 1;
  let x=markV.x, y=markV.y;
  if(behind){ x=-x; y=-Math.abs(y)-0.2; }
  const edge = behind || Math.abs(x)>0.92 || Math.abs(y)>0.85;
  x=Math.max(-0.92,Math.min(0.92,x)); y=Math.max(-0.85,Math.min(0.85,y));
  const W=innerWidth/views;
  el.style.transform=`translate(${vi*W+(x+1)/2*W}px,${(1-y)/2*innerHeight}px)`;
  el.className = edge ? 'edge' : '';
  el.querySelector('span').textContent = Math.round(dist)+' m';
}

const showPrompt=(el,html)=>{ if(!el) return; if(html){ if(el._h!==html){ el.innerHTML=html; el._h=html; } el.classList.remove('off'); } else el.classList.add('off'); };
// What the button under this runner's hand does right now. An interactable
// outranks a ledge: being told to climb while standing on a lever is how a
// puzzle reads as broken. `vi` 1 is player two, whose keys are different.
function promptFor(me, vi){
  const inter=game.interact; if(!me||!inter) return null;
  const two = vi===1;
  const padOn = two ? !!(pad2 && pad2.connected && performance.now()-pad2.lastUsed<8000) : (pad.connected && performance.now()-pad.lastUsed<8000);
  const K = padOn ? { use:'X', jump:'A', up:'UP', side:'SIDE', down:'DOWN', crouch:'Y' }
    : touch && !two ? { use:'USE', jump:'JUMP', up:'UP', side:'SIDE', down:'DOWN', crouch:'CROUCH' }
    : two ? { use:'/', jump:'ENTER', up:'↑', side:'←/→', down:'↓', crouch:'.' }
    : { use:'E', jump:'SPACE', up:'W', side:'A/D', down:'S', crouch:'C' };
  const hanging=me.state==='hang';
  const it=inter.near(me);
  if(it && !(it.kind==='relic' && !inter.st.solved) && !(it.kind==='glyph' && it.used)
     && !(it.kind==='lever' && it.mode==='pull' && it.used)
     && !(it.kind==='brazier' && (it.lit||inter.st.solved))){
    return it.mode==='hold' ? `hold <b>${K.use}</b> · ${it.label.toLowerCase()}`
                            : `<b>${K.use}</b> ${it.label.toLowerCase()}`;
  }
  if(game.isCoop() && me.state==='ground' && game._booster(me)){
    // the boost is invisible unless it is offered at the moment it exists
    return `<b>${K.jump}</b> leg-up off ${game._booster(me).name}`;
  }
  const mate = game.players.find(q=>q!==me && !q.isBot && !q.deadUntil);
  if(game.isCoop() && me.state==='ground' && me.crouch && (me.mps||0)<0.6 && mate && Math.hypot(mate.x-me.x,mate.y-me.y)*S<2.5)
    return `braced · ${mate.name} can jump off you`;
  // a partner who can see a wall too high for one: offer the brace
  if(game.isCoop() && me.state==='ground' && !me.crouch && mate && Math.hypot(mate.x-me.x,mate.y-me.y)*S<3 && highWallNear(me)) return `<b>${K.crouch}</b> brace · give ${mate.name} a leg-up`;
  if(hanging) return `<b>${K.up}</b> climb · <b>${K.side}</b> shimmy · <b>${K.down}</b> drop`;
  // Only when the button will actually grab. The old prompt used the airborne
  // reach, so it said "climb" from a stride away and the press jumped.
  if(me.state==='ground' && me.regrab<=0 && findLedge(me, PHYS.grabStand)) return `<b>${K.jump}</b> grab · <b>${K.up}</b> pull up`;
  return null;
}
// A face within a couple of metres that one runner cannot reach but a boost
// can: over the jump-catch reach, under what a boost adds.
function highWallNear(me){
  const z=me.z||0;
  for(const w of MAP.walls){ if(w.off) continue;
    const rise=w.top-z; if(rise<3.2 || rise>4.3) continue;   // a boosted catch tops out near 4.3 m
    const ex=Math.max(w.x,Math.min(me.x,w.x+w.w)), ey=Math.max(w.y,Math.min(me.y,w.y+w.h));
    if(Math.hypot(me.x-ex,me.y-ey)*S<1.6) return true; }
  return false;
}
// The runner cards in split view: name, vitals, and a word on what they are doing.
function updateRunners(){
  if(views<2) return;
  for(let i=0;i<2;i++){ const q=game.players[i]; if(!q) continue;
    const card=document.querySelector('#runners .r'+(i+1));
    document.getElementById('rn'+(i+1)).textContent=q.name;
    document.getElementById('rhp'+(i+1)).style.width=Math.max(0,q.hp)+'%';
    const st = q.deadUntil ? 'DOWN' : q.state==='hang' ? 'ON A LEDGE' : q.state==='mantle' ? 'CLIMBING' : q.crouch ? 'BRACED' : '';
    const el=document.getElementById('rst'+(i+1)); if(el.textContent!==st) el.textContent=st;
    card.classList.toggle('down', !!q.deadUntil); }
}
function updateHUD(dt=0){ const me=meOf(); if(!me||!game.story) return;
  const story=game.story, mech=game.mech, inter=game.interact;

  // a new chamber gets its title card, once
  if(story.beat!==lastBeat){ if(lastBeat>=0 || story.beat===0) ui.chapter(BEATS[story.beat].title); lastBeat=story.beat; }
  // taking a hit bleeds the edges red; healing fades it
  if(me.hp < lastHp - 0.5){ const h=document.getElementById('hurt'); h.style.transition='none'; h.style.opacity=String(Math.min(1, 0.45 + (lastHp-me.hp)/40));
    requestAnimationFrame(()=>{ h.style.transition='opacity .7s ease'; h.style.opacity=me.hp<35?'0.35':'0'; }); }
  lastHp = me.hp;
  // the controls strip is for the first minute; the field notes take over
  if(settings.hints && performance.now()-hintShownAt > 60000) document.getElementById('hint').classList.add('fade');
  // One thing at a time in the opening: the chapter card first, then the notes.
  tutorial.update(dt, { enabled: settings.tutorial && !paused && game.elapsed() > 3800, me, beat: story.beat, S,
    dev: pad.connected && performance.now()-pad.lastUsed < 8000 ? 'pad' : (touch ? 'touch' : 'kb'),
    lookDelta: lookAccum, strike: !!(me.atkUntil && me.atkUntil > game.t && me._tutAtk !== me.atkUntil && (me._tutAtk = me.atkUntil)),
    holdingLever: !!(inter && inter.items.some(i=>i.kind==='lever' && i.mode==='hold' && i.held)),
    guardiansAwake: game.players.some(q=>q.isBot && !q.ally && !q.dormant && !q.gone),
    coop: !!(game.isCoop && game.isCoop()), crouch,
    glyphs: game.interact && game.interact.st ? game.interact.st.read.filter(Boolean).length : 0 });

  // Elapsed, not remaining: a challenge tomb is timed against your own run.
  document.getElementById('timer').textContent=fmtTime(game.elapsed());
  setBeat(story.beat, BEATS.length);
  setObjective(story.current().objective.toUpperCase());
  document.getElementById('hpfill').style.width=me.hp+'%';
  document.getElementById('hpfill').style.background = me.hp>40?'linear-gradient(90deg,#39d98a,#8bffca)':'linear-gradient(90deg,#ff5a4e,#ffa08e)';
  setCaption(settings.captions ? game.captions.current() : null);
  setFlood(game.floodLeft(me), !!mech.flooding);

  // The solo grace window. Without this readout you cannot tell a ten-second
  // mechanic from a broken one, which is the whole difference for a judge.
  if(game.rooms) setRooms(game.rooms.count(), game.rooms.total());
  const cwLive = (mech.cwLive||[]).length, cwBusy = cwLive>0 && mech.bridge<1;
  if(mech.winchLatch > 0){
    // the winch readout outranks the others: while it is wound the counted
    // floor is SAFE, and that is the single most useful thing to know
    setHold(mech.winchLatch/MECH.winchGrace, `FLOOR JAMMED · ${Math.ceil(mech.winchLatch)}s`);
  } else if(cwBusy){
    // the two-hand task: show how many levers are counting RIGHT NOW, and how
    // long the latched one has left, because solo that number is the whole beat
    const latch = Math.max(mech.cwLatch.lever_cw_a||0, mech.cwLatch.lever_cw_b||0);
    // Two runners: no window to beat, only the other pair of hands to wait for.
    if(mech.coop) setHold(cwLive/2, `${cwLive}/2 LEVERS · TOGETHER`);
    else setHold(latch/MECH.cwGrace, `${cwLive}/2 LEVERS · ${Math.ceil(latch)}s`);
  } else if(mech.craneGrace>0 || mech.heldLive){
    setHold(mech.heldLive?1:mech.craneGrace/(mech.coop?MECH.coopCrane:MECH.soloGrace),
            mech.heldLive?(mech.coop?'ARM OUT · CROSS':'HELD'):(mech.coop?'ARM SWINGING IN':`${Math.ceil(mech.craneGrace)}s`));
  } else setHold(null);

  // Contextual prompt, one per runner on screen.
  showPrompt(document.getElementById('prompt'), promptFor(me, 0));
  if(views>1) showPrompt(document.getElementById('prompt2'), promptFor(game.players[1], 1));
  updateRunners();

  // The feed is news, not a log: a line lives six seconds, at most four show,
  // and the chamber titles already have their own card.
  const fresh=game.events.filter(e=>game.t-e.at<6000 && !/^[IVX]+ · /.test(e.text)).slice(-4);
  const sig=fresh.map(e=>e.at+e.text).join('|');
  if(sig!==lastFeed){ lastFeed=sig;
    // textContent, not innerHTML: event lines carry player names off the wire
    feedEl.replaceChildren(...fresh.map(e=>{ const d=document.createElement('div'); d.textContent=e.text; return d; })); }
  drawMini();
}
// Minimap. Walls in a muted stone tone so the markers carry the colour; the
// local runner is an arrow facing where they face, so the map can be read
// without turning to check it.
function drawMini(){ const w=180,h=135; mini.clearRect(0,0,w,h); const sx=w/MAP.w, sy=h/MAP.h;
  mini.fillStyle='rgba(150,190,196,0.16)';
  for(const wl of MAP.walls) mini.fillRect(wl.x*sx,wl.y*sy,wl.w*sx,wl.h*sy);
  if(game.mech && game.mech.front>=1){ mini.fillStyle='#8bffca';
    for(const z of game.zones){ mini.globalAlpha=.35+.25*Math.sin(performance.now()/300); mini.beginPath(); mini.arc(z.x*sx,z.y*sy,7,0,7); mini.fill(); }
    mini.globalAlpha=1; }
  // Mark what the current beat wants, not every collectable: a minimap that
  // shows everything shows nothing.
  if(game.interact){ for(const it of game.interact.items){
    if(it.used||it.lit) continue;
    if(it.kind==='relic'&&!game.interact.st.solved) continue;
    mini.fillStyle = it.kind==='brazier'?'#ffb14e':(it.kind==='glyph'?'#9fd8e8':'#ffd98a');
    mini.beginPath(); mini.arc(it.x*sx,it.y*sy,2.6,0,7); mini.fill(); } }
  const meId=game.localId||0;
  for(const p of game.players){ if(p.deadUntil||p.gone)continue; if(p.id!==meId&&p.vis<0.2)continue;
    if(p.isBot&&!p.ally&&p.dormant) continue;
    const x=p.x*sx, y=p.y*sy;
    if(p.id===meId || (splitLive() && p.id===1)){
      const a=p.angle||0; mini.save(); mini.translate(x,y); mini.rotate(a);
      mini.fillStyle= views>1 ? (p.id===0 ? '#7fe3ff' : '#ff9d84') : '#fff'; mini.strokeStyle='rgba(0,0,0,.6)'; mini.lineWidth=1;
      mini.beginPath(); mini.moveTo(6,0); mini.lineTo(-4,4); mini.lineTo(-2,0); mini.lineTo(-4,-4); mini.closePath(); mini.fill(); mini.stroke();
      mini.restore();
    } else {
      mini.fillStyle = p.id===1 && !p.isBot ? '#ff9d84' : p.ally||!p.isBot ? '#7fe3ff' : '#ff8f80';
      mini.beginPath(); mini.arc(x,y,2.8,0,7); mini.fill();
    } } }

const _introFrom = new THREE.Vector3();
function startEnding(){
  document.exitPointerLock?.();
  document.body.classList.add('ending');
  setTouchLive(false);
  const c = document.getElementById('endcard');
  c.querySelector('b').textContent = 'THE TOMB IS RUN';
  c.querySelector('span').textContent = (coopLive() || splitLive()) ? 'Two runners out of the silt, and the Sun Disc with them.' : 'The Sun Disc of Ixchel is out of the silt.';
  c.classList.add('on');
  const skip = () => { endingSkip = true; removeEventListener('keydown', skip); removeEventListener('pointerdown', skip); };
  setTimeout(() => { addEventListener('keydown', skip); addEventListener('pointerdown', skip); }, 600);
}
function finishEnding(){
  document.body.classList.remove('ending');
  const c = document.getElementById('endcard');
  // gone at once: the board repeats the title, and a slow fade ghosts behind it
  if (c) { c.style.transition = 'none'; c.classList.remove('on'); void c.offsetWidth; c.style.transition = ''; }
}
function showResults(){ let r=document.getElementById('results'); if(!r){ r=document.createElement('div'); r.id='results'; app.appendChild(r);}
  document.exitPointerLock?.();
  markerEl.className='off'; document.getElementById('tut')?.classList.add('off');
  const st=game.story, inter=game.interact, won=!!game.won;
  const glyphs=inter.st.read.filter(Boolean).length;
  const run={ won, ms:game.elapsed(), deaths:st.deaths, resets:inter.st.failures, glyphs, coop:coopLive() || splitLive() };
  const grade=gradeRun(run);
  const prevBest=records.bestMs;
  const { newBest, fresh } = recordRun(run);
  refreshRecordLine();
  const stat=(v,l)=>`<div class="stat"><b>${v}</b><span>${l}</span></div>`;
  const beats=BEATS.slice(0, won?BEATS.length:st.beat+1)
    .map((b,i)=>`<div>${i<st.beat||won?'✓':'·'} ${b.title}</div>`).join('');
  const pb = !won ? `REACHED ${BEATS[st.beat].title}`
    : newBest ? (prevBest!=null ? `NEW BEST · ${fmtTime(prevBest-run.ms)} FASTER` : 'FIRST ESCAPE · RECORD SET')
    : `BEST ${fmtTime(records.bestMs)}`;
  r.innerHTML=`<div class="center"><h1 class="${won?'win':'lose'}">${won?'THE TOMB IS RUN':'THE TOMB KEEPS YOU'}</h1>
    <p class="sub" style="color:var(--muted);letter-spacing:.1em;margin-top:6px">${won?'The Sun Disc of Ixchel is out of the silt.':'The water closed over the sanctum.'}</p>
    ${won?`<div class="grade" aria-label="Grade ${grade}">${grade}</div>`:''}
    <div class="pb">${pb}</div>
    <div class="stats">${stat(fmtTime(run.ms),'TIME')}${stat(st.deaths,'DEATHS')}${stat(glyphs+'/3','GLYPHS')}${stat(inter.st.failures,'WRONG FIRES')}</div>
    <div class="beats">${beats}</div>
    ${fresh.length?`<div class="fresh"><div class="pb" style="margin-bottom:8px">HONOURS EARNED</div><div class="honours">${fresh.map(a=>honour(a,true)).join('')}</div></div>`:''}
    <div class="menurow"><button id="again" class="primary">RUN IT AGAIN</button><button id="tomenu" class="ghost">TITLE</button><button class="ghost" data-open="records">RECORDS</button></div></div>`;
  setTouchLive(false);
  r.classList.add('on'); document.body.classList.add('results');
  document.getElementById('again').onclick=()=>{ r.classList.remove('on'); start(); };
  document.getElementById('tomenu').onclick=()=>quitToTitle();
  setTimeout(()=>document.getElementById('again')?.focus({preventScroll:true}), 60);
  for (const a of fresh) ui.toast('HONOUR EARNED', a.name);
}
