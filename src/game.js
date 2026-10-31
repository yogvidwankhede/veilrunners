import * as THREE from 'three';
import { MAP, RULES, TEAM, S, BOT, PHYS, MOVE, COMBAT } from './constants.js';
import { to3 } from './world.js';
import { buildRunner } from './characters.js';
import { attachWalkRig, makeWalkDriver, gaitStride, RUN_MPS, MAX_CADENCE } from './walkrig.js';
import { hitsProp } from './collision.js';
import { groundAt, blockedAt, findLedge, attachToLedge, stepVertical, vaultTarget, edgeBelow, catchLedge, lowMantle, STAND_REACH } from './traversal.js';
import { makeFbxLocomotion, cloneSkinned, isolateMaterials, calibrateRig } from './fbxrunner.js';
import { createMech, MECH } from './mech.js';
import { stepHorizontal, killMomentum, vaultIntent } from './move.js';
import { createInteract } from './interact.js';
import { createCaptions } from './captions.js';
import { createStory, BEATS } from './story.js';
import { createRooms } from './rooms.js';
import { CHECKPOINTS, WATER } from './level.js';

const dist = (a,b)=>Math.hypot(a.x-b.x,a.y-b.y);
// Knockback is a velocity, not a teleport. stepHorizontal resolves it next
// tick, so a wall stops the body and a body already inside stone is steered
// toward the exit instead of further in.
function shove(body, nx, ny, speed) {
  let x = nx, y = ny;
  if (blockedAt(body.x, body.y, body.z)) {
    let best = -1e9, ba = 0;
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * Math.PI * 2, dx = Math.cos(a), dy = Math.sin(a);
      const free = blockedAt(body.x + dx * 18, body.y + dy * 18, body.z) ? 0 : 2;
      const score = dx * nx + dy * ny + free;
      if (score > best) { best = score; ba = a; }
    }
    x = Math.cos(ba); y = Math.sin(ba);
  }
  body.vx = x * speed;
  body.vy = y * speed;
}
// Park the body on the lip immediately, and remember where it reached from so
// the mesh can slide into the hands-on-ledge pose instead of popping there.
// `pullUp` is a jump that was already committed at the face: hang for the
// catch, then mantle on its own. A standing grab leaves pullUp off so the
// player can shimmy.
function beginGrab(p, g, pullUp) {
  p.grabFromX = p.x; p.grabFromY = p.y; p.grabFromZ = p.z;
  p.catchT = 0;
  p.autoMantle = pullUp ? PHYS.catchTime : 0;
  attachToLedge(p, g);
}
// A guardian that follows you out of its chamber and onto a collapsing
// causeway is a different game, and a worse one. They hold their ground.
const LEASH = 330;
// The boost: jump speed multiplier off a crouched partner (apex ~1.1 m -> ~2.3 m),
// and how close (metres, centre to centre) the partner has to be.
const BOOST = 1.42, BOOST_R = 1.15;
// Would a step to (nx,ny) put this body over a drop it cannot survive? The AI's
// only avoidance was blocked(), which asks about WALLS — and the tomb kills with
// holes, not walls. Guardians walked off the mechanism floor into the abyss and
// deleted themselves, which handed the player beat 3 for free. A drop of more
// than this is never something a guardian should step into on purpose.
const AI_DROP = 1.3;
const wouldFall = (p, nx, ny) => groundAt(nx, ny) < (p.z || 0) - AI_DROP;
const ZERO_INPUT = { mx:0,my:0,fwd:0,strafe:0,sp:0,cr:0,it:0,at:0,dg:0,jp:0,bl:0 };
// The shape _botThink returns. Spread it rather than sharing it: a returned
// object gets mutated by the caller, and one shared literal would leak a
// guardian's last decision into every other guardian on the next tick.
const ZERO_AI = { mx:0,my:0,sprint:false,crouch:false,interact:false,attack:false,dodge:false,fwd:0,jump:false };
// Walls block from below and are walkable from above, so this needs a height.
const blocked=(x,y,z=0)=>blockedAt(x,y,z);
const inBush=(p)=>MAP.bushes.some(b=>p.x>b.x&&p.x<b.x+b.w&&p.y>b.y&&p.y<b.y+b.h);

export class Game {
  constructor(scene){ this.scene=scene; this.players=[]; this.relics=[]; this.zones=[]; this.t=0;
    this.phase='menu'; this.winner=null; this.events=[];
    // A challenge tomb is a puzzle with two guardians in it, not an arena with
    // four rivals. The fourth rival was what made the old level a deathmatch.
    this.guardianCount=2; this.botCount=2;
    // Solo and the host play slot 0 and own the simulation. A co-op guest
    // plays slot 1 and predicts locally; the host's snapshots are authority.
    this.localId = 0;
    this.authority = true; }

  addPlayer(name,isBot,slot){
    const sp=MAP.spawns[slot%MAP.spawns.length]; const color=TEAM[slot%TEAM.length];
    // The two runners start facing the stairs, north, so the opening shot is
    // the way deeper and not the back of a shut door.
    // The tomb is five storeys. A guardian posted on the 5 m mechanism floor
    // used to spawn at z=0, which put it inside the floor it was standing on.
    const sz=groundAt(sp.x,sp.y);
    const mesh=buildRunner(color); mesh.tint(color); this.scene.add(mesh);
    // Arena leftover: a coloured disc under the feet so you could pick your
    // runner out of a deathmatch. On the character you play it only ever
    // showed up as a circle stamped into whatever wall you were climbing,
    // because a transparent mesh still writes depth. Partners keep a faint
    // one, and only while they are standing on the floor.
    const ring=new THREE.Mesh(new THREE.RingGeometry(0.42,0.5,24),new THREE.MeshBasicMaterial({color,transparent:true,opacity:0,depthWrite:false,side:THREE.DoubleSide}));
    ring.rotation.x=-Math.PI/2; ring.position.y=0.03; ring.visible=false; mesh.add(ring);
    const face = slot < 2 ? -Math.PI / 2 : 0;
    const p={id:slot,name,isBot,color,x:sp.x,y:sp.y,angle:face,hp:100,score:0,crouch:false,sprint:false,
      px:sp.x,py:sp.y,pangle:face,pphase:0,gait:0,mps:0,
      dormant:isBot,under:0,gone:false,      // guardians are statues until beat 3
      z:sz,vz:0,pz:sz,state:'ground',ledge:null,regrab:0,mantle:0,vault:0,
      atkUntil:0,atkHitAt:0,atkSpent:false,blockFrom:0,blocking:false,
      rollUntil:0,hitUntil:0,stunUntil:0,
      input:{x:0,y:0,interact:false},cd:{},carry:null,extractSince:0,deadUntil:0,invuln:0,
      mesh,ring,phase:0,vis:1,bot:{goal:null,retarget:0,strafe:0}};
    p.game=this;                     // the animation layer needs the clock
    this.players.push(p); return p;
  }

  init(humanName){
    // RUN AGAIN used to leave the previous match's runners in the scene: five
    // frozen bodies standing around, and five more sets of materials, every time.
    for(const p of this.players){ this.scene.remove(p.mesh);
      // the contact shadow main.js hangs under each body is the body's too
      if(p.blob){ this.scene.remove(p.blob); p.blob.geometry.dispose(); p.blob.material.dispose(); p.blob=null; }
      p.mesh.traverse(o=>{
        // each cloned rig owns its skeleton, and a skeleton owns a bone texture
        // on the GPU: two of them were left behind by every RUN IT AGAIN
        if(o.isSkinnedMesh && o.skeleton && !o.userData.fromProto) o.skeleton.dispose();
        if(!o.isMesh||!o.material)return;
        for(const m of (Array.isArray(o.material)?o.material:[o.material])) if(m.userData.vrOwned) m.dispose(); });
      p.mixer=null; }
    this.players=[]; this.relics=[]; this.phase='playing'; this.t=0; this.winner=null; this.events=[];
    this.won=false;
    // Slot 1 is the partner: a co-op guest takes it over, and solo it stays an
    // ally that does nothing rather than a rival. Slots 2+ are the guardians.
    this.addPlayer(humanName||'ARIA',false,0);
    this.addPlayer('KESTREL',true,1); this.players[1].ally=true; this.players[1].dormant=true;
    const names=['GUARDIAN','SENTINEL'];
    for(let i=0;i<this.guardianCount;i++) this.addPlayer(names[i%names.length],true,i+2);
    // relics
    // Removed AND released: a group taken out of the scene still holds its
    // GPU buffers, and every RUN IT AGAIN used to leave another one behind.
    for(const m of this._relicMeshes||[]){ this.scene.remove(m);
      m.traverse(o=>{ if(o.userData && o.userData.sharedProto) return;
        if(o.isMesh && !o.userData.fromProto){ o.geometry && o.geometry.dispose(); (Array.isArray(o.material)?o.material:[o.material]).forEach(x=>x && x.dispose()); }
        if(o.isLight && o.dispose) o.dispose(); }); }
    this._relicMeshes=[];
    this.relics=MAP.relics.map((r,id)=>{ const mesh=this._makeRelic(r.color); this.scene.add(mesh); this._relicMeshes.push(mesh);
      return {id,x:r.x,y:r.y,z:r.z||0,px:r.x,py:r.y,home:{x:r.x,y:r.y,z:r.z||0},owner:null,availableAt:0,mesh}; });
    // zones
    if(!this.zones.length) this.zones=MAP.zones.map(z=>{ const g=this._makeZone(); const c=to3(z.x,z.y); g.position.set(c.x,0,c.z); this.scene.add(g); return {x:z.x,y:z.y,mesh:g}; });
    if(this._runnerProto) this.upgradeRunners(this._runnerProto, this._runnerAnims, this._runnerOpts);
    // the sun disc model arrives asynchronously; re-apply it to the new relics
    if(this._relicProto) this.upgradeRelics(this._relicProto);

    // ---- the tomb's own systems ----
    this.mech = this.mech || createMech(this);
    this.mech.reset();
    this.captions = this.captions || createCaptions();
    this.captions.clear();
    this.rooms = this.rooms || createRooms(this);
    this.rooms.reset();
    this.interact = this.interact || createInteract(this, this.mech, this.captions);
    this.interact.reset();
    this.ctx = {
      game: this, mech: this.mech, interact: this.interact,
      say: (who, line) => this.captions.say(who, line),
      any: fn => this.players.some(q => !q.isBot || q.ally ? (!q.deadUntil && fn(q)) : false),
      // every HUMAN runner, alive: the co-op exit waits for both
      all: fn => { const hs = this.players.filter(q => !q.isBot); return hs.length > 0 && hs.every(q => !q.deadUntil && fn(q)); },
      me: () => this.players[0],
      wakeGuardians: () => { for (const q of this.players) if (q.isBot && !q.ally) {
        q.dormant = false; this.event(`${q.name} wakes`); } },
      guardiansAlive: () => this.players.some(q => q.isBot && !q.ally && !q.dormant && !q.gone && !q.deadUntil),
    };
    this.story = this.story || createStory(this, this.ctx);
    this.story.reset();
  }

  _makeRelic(){ const g=new THREE.Group();
    const gem=new THREE.Mesh(new THREE.OctahedronGeometry(0.33,0),new THREE.MeshStandardMaterial({color:0xf3d98a,emissive:0xd9a74a,emissiveIntensity:1.6,metalness:0.6,roughness:0.25}));
    gem.castShadow=true; g.add(gem); g.userData.gem=gem;
    const light=new THREE.PointLight(0xffcf7a,3,6,2); light.position.y=0.4; g.add(light);
    const halo=new THREE.Mesh(new THREE.RingGeometry(0.5,0.62,24),new THREE.MeshBasicMaterial({color:0xffcf7a,transparent:true,opacity:0.5,side:THREE.DoubleSide}));
    halo.rotation.x=-Math.PI/2; halo.position.y=0.03; g.add(halo); return g; }

  // The way OUT, marked on the floor of the entrance hall. This used to be a
  // 3.9 m glowing torus with a 10 m light beam over it — correct for an
  // extraction circle you had to stand in for three seconds, and absurd for a
  // doorway you walk through once at the very end. A threshold, not a beacon.
  _makeZone(){ const g=new THREE.Group();
    const ring=new THREE.Mesh(new THREE.TorusGeometry(1.5,0.045,6,40),
      new THREE.MeshStandardMaterial({color:0xcdbb86,emissive:0xa98c42,emissiveIntensity:0.55,roughness:0.6,metalness:0.3}));
    ring.rotation.x=-Math.PI/2; ring.position.y=0.04; g.add(ring);
    const disc=new THREE.Mesh(new THREE.CircleGeometry(1.46,32),
      new THREE.MeshBasicMaterial({color:0xcdbb86,transparent:true,opacity:0.05}));
    disc.rotation.x=-Math.PI/2; disc.position.y=0.03; g.add(disc);
    const runes=new THREE.Group();
    for(let i=0;i<8;i++){ const a=i/8*Math.PI*2;
      const rn=new THREE.Mesh(new THREE.BoxGeometry(0.13,0.015,0.26),
        new THREE.MeshStandardMaterial({color:0xcdbb86,emissive:0xcdbb86,emissiveIntensity:0.8}));
      rn.position.set(Math.cos(a)*1.3,0.05,Math.sin(a)*1.3); rn.rotation.y=-a; runes.add(rn); }
    g.add(runes); g.userData.runes=runes;
    return g; }

  event(text){ this.events.push({text,at:this.t}); this.events=this.events.slice(-6); }

  carrying(p){ return this.relics.find(r=>r.owner===p.id); }

  hurt(p, amount, by, now = this.t) {
    if (p.deadUntil || p.invuln > now || p.dormant) return 'none';
    if (p.rollUntil > now) return 'dodged';                 // i-frames inside the roll
    if (p.blocking) {
      const since = (now - p.blockFrom) / 1000;
      if (since <= COMBAT.parryWindow) {                    // raised guard just in time
        if (by) by.stunUntil = now + COMBAT.parryStun * 1000;
        this.event(`${p.name} parried ${by ? by.name : 'a strike'}`);
        return 'parry';
      }
      amount *= COMBAT.blockSoak;                           // soaked, not negated
    }
    p.hp = Math.max(0, p.hp - amount);
    p.extractSince = 0;
    p.hitUntil = now + COMBAT.hitStun * 1000;
    if (!p.hp) {
      // The sun disc is a story item and it STAYS with you. Dropping it where
      // you fell, then respawning at a checkpoint, soft-locks the escape: the
      // disc would be lying in the flood behind a mechanism you cannot re-arm.
      p.deadUntil = now + 1200; p.carry = null;
      if (by) this.event(`${by.name} took down ${p.name}`); else this.event(`${p.name} fell`);
      return 'kill';
    }
    return 'hit';
  }

  // humanInput: {mx,my (strafe/fwd -1..1), sprint, crouch, interact, attack, dodge}
  update(dt, human){
    if(this.phase!=='playing')return;
    // Snapshot the pre-tick pose. The renderer draws between this and the new
    // one, so motion stays smooth at any refresh rate above the tick rate.
    for(const p of this.players){ p.px=p.x; p.py=p.y; p.pz=p.z; p.pangle=p.angle; p.pphase=p.phase; }
    for(const r of this.relics){ r.px=r.x; r.py=r.y; }
    this.t+=dt*1000;

    // The tomb moves BEFORE any body does, so everyone this tick sees the same
    // world: a tile that has just retracted is gone for the runner standing on
    // it too, not on the next tick. Reversing these two lines is the difference
    // between a timing puzzle and a coin flip.
    this.mech.step(dt);
    this.interact.beginTick();
    this.captions.step(dt);
    // Discovery, before the bodies move: a chamber opens the moment someone is
    // standing in it, and everything downstream reads that this same tick.
    this.rooms.step(this.players);
    if(this.rooms.justEntered){
      const r=this.rooms.justEntered;
      this.event(`${r.name} (${this.rooms.count()}/${this.rooms.total()})`);
    }

    for(const p of this.players){
      if(p.gone) continue;
      // A guest renders the host's body from snapshots. Simulating it here as
      // well walks it off the position the host just sent.
      if(p.remote && this.authority === false) continue;
      if(p.deadUntil){
        // A guardian stays down. Respawning them would be fine in an arena, but
        // beat 3 ends when the chamber is clear — on a respawn timer it never
        // ends, and the tomb deadlocks with the bridge already down.
        if(p.isBot && !p.ally){ p.gone=true; continue; }
        if(this.t>=p.deadUntil) this._respawn(p); else continue;
      }

      let mx,my,sprint,crouch,interact,attack,dodge,fwd=0,strafe=0,jump=false;
      // The keyboard belongs to localId. The wire belongs to a remote partner.
      // Anyone else non-bot (there isn't one, today) stands still.
      const local = p.id === this.localId;
      const src = p.isBot ? null : (p.remote ? (this.remoteInput || ZERO_INPUT) : (local ? human : ZERO_INPUT));
      if(p.isBot){ ({mx,my,sprint,crouch,interact,attack,dodge,fwd=0,jump=false}=this._botThink(p)); }
      else if(p.remote){
        if(src.nm) p.name = String(src.nm).slice(0, 16);
        mx=src.mx||0; my=src.my||0; fwd=src.fwd||0; strafe=src.strafe||0;
        sprint=!!src.sp; crouch=!!src.cr; interact=!!src.it;
        attack=!!src.at; dodge=!!src.dg; jump=!!src.jp;
      }
      else if(local){ mx=human.mx; my=human.my; sprint=human.sprint; crouch=human.crouch; interact=human.interact;
             attack=human.attack; dodge=human.dodge; fwd=human.fwd||0; strafe=human.strafe||0; jump=!!human.jump; }
      else { mx=0; my=0; sprint=false; crouch=false; interact=false; attack=false; dodge=false; }

      // committed actions remove control, which is what gives them weight
      const locked = p.stunUntil>this.t || p.hitUntil>this.t || (p.atkUntil>this.t && p.atkHitAt+COMBAT.active*1000>this.t);

      // Held, not just pressed. A tap cuts the jump; a hold keeps the full arc.
      // A remote packet with no `jh` (older client) keeps the full arc too.
      if(!p.isBot){
        p.jumpHeld = p.remote ? (src && src.jh != null ? !!src.jh : true)
          : (local && human ? (human.jumpHeld !== false) : true);
      }

      // ---- vertical: ledge grab, hang, mantle, gravity ----
      const want={ up:0, down:0, side:0 };
      if(p.state==='hang'){
        if(fwd<-0.3){ want.down=1; p.autoMantle=0; }
        else if((p.autoMantle||0)>0){
          p.autoMantle -= dt;
          if(p.autoMantle<=0) want.up=1;   // the catch finished; pull up
        }
        // bots set fwd too, so they can finish a climb. A human's climb waits
        // for the catch to land: pressing up mid-catch started the pull-up while
        // the body was still sliding into the hang, and it popped half a metre.
        if(fwd>0.3||jump){
          if(!p.isBot && p.catchT!=null && p.catchT<PHYS.catchTime) p.autoMantle=Math.max(p.autoMantle||0, PHYS.catchTime-p.catchT);
          else want.up=1;
        }
        want.side=strafe;
        dodge=false;                       // Space means "climb" while hanging
      } else if(jump && !p.isBot){
        // SPACE is contextual but never silent: grab a ledge if one is in reach,
        // otherwise jump. It used to do nothing at all away from a wall.
        // ...but only from AGAINST the face. grabStand, not grabRange: a
        // two-metre snap radius meant Space usually did not jump.
        // A lip within standing reach is climbed from where you stand: a low
        // one straight up and over, a high one into a hang. Above standing
        // reach the press JUMPS, and the catch takes the lip when the hands
        // actually arrive at it.
        let g = p.regrab<=0 ? findLedge(p, PHYS.grabStand) : null;
        if(g && g.top - (p.z||0) > STAND_REACH) g = null;
        if(g && g.top - (p.z||0) < PHYS.hangBelow - 0.05){ lowMantle(p, g); dodge=false; }
        else if(g){ beginGrab(p, g, false); dodge=false; }
        // VAULT before JUMP. Low cover you are running at is vaulted; the jump
        // is what happens when there is nothing to vault. Asked the same way
        // move.js asks it, so the two cannot disagree about what Space did.
        else if(vaultIntent(p, { mx, my, locked })){ dodge=false; /* move.js performs it */ }
        // THE BOOST. A partner crouched beside you is a step: jump off their
        // back and you go a metre higher than you can alone, which is what a
        // co-op climb is. Checked before the plain jump so the press means it.
        else if(p.state==='ground' && this._booster(p)){
          const q=this._booster(p);
          p.vz=PHYS.jumpSpeed*BOOST; p.state='air'; p.coyote=0; dodge=false; p.boostedAt=this.t;
          q.boostingAt=this.t;
          this.event(`${q.name} boosts ${p.name}`);
        }
        // COYOTE TIME: still jumpable for a moment after walking off an edge.
        // A player who commits at the lip issues the press while the character
        // is already a few frames past it, and without this the jump is eaten.
        else if(p.state==='ground' || (p.coyote||0) > 0){
          p.vz=PHYS.jumpSpeed; p.state='air'; p.coyote=0; dodge=false;
        }
        // Too early: remember it and fire the instant we touch down.
        else p.jumpBuf = MOVE.jumpBuffer;
      }

      if(p.isBot && jump && p.regrab<=0 && p.state==='ground'){
        const g=findLedge(p); if(g) attachToLedge(p,g);
      }

      // ---- drop-hang: crouch at the lip to lower yourself instead of falling ----
      if(p.state==='ground' && crouch && p.regrab<=0 && p.z>0.05){
        const e = edgeBelow(p);
        if(e){ beginGrab(p, e, false); }
      }
      let vstate=stepVertical(p, dt, want);
      // THE CATCH (traversal.catchLedge). A jump takes a ledge when the hands
      // reach the lip, on the way up or on the way down, if the body is at the
      // face and facing or moving into it. A running jump, or forward held,
      // pulls up on its own once the hands arrive; a hop in place hangs, so
      // the player can still shimmy.
      if(vstate==='air' && !p.isBot && p.regrab<=0){
        const g=catchLedge(p);
        if(g){
          const into = -((p.vx||0)*g.nx + (p.vy||0)*g.ny);
          beginGrab(p, g, fwd>0.2 || into>18);
          vstate=p.state;
        }
      }
      // JUMP BUFFERING: a press made just before landing fires on touchdown
      // rather than being dropped. Consumed here, after the vertical step, so
      // `p.state` is this tick's truth and not last tick's.
      if(!p.isBot && (p.jumpBuf||0) > 0){
        p.jumpBuf -= dt;
        if(p.state==='ground'){ p.vz=PHYS.jumpSpeed; p.state='air'; p.jumpBuf=0; }
      }
      if(vstate==='hang') p.catchT = Math.min(1, (p.catchT||0)+dt);
      if(vstate==='hang'||vstate==='mantle'||vstate==='vault'){
        // hands are on the wall: no ground movement, no fighting. Momentum is
        // zeroed too, or the body resumes a stride it was carrying before the
        // grab the moment it lets go.
        killMomentum(p);
        p.moving=0; p.gait=0; p.sprint=false; p.crouch=false;
        p.vis = (p.id === this.localId || p.ally) ? 1 : p.vis;
        continue;
      }

      if(locked){ mx=0; my=0; sprint=false; }
      p.sprint=sprint; p.crouch=crouch;
      // Velocity-based locomotion, shared with tools/runthrough.mjs so the test
      // cannot be easier than the game. See src/move.js: the stick sets a TARGET
      // velocity and facing, and the body accelerates and rotates toward them at
      // bounded rates rather than being assigned both outright.
      const moved = stepHorizontal(p, {
        mx, my, sprint, crouch, locked,
        vault: jump && !p.isBot,     // a vault is a button press, not a bump
        edgeGuard: !p.isBot,         // walking stops at a drop that would strand you
        carrying: !!this.carrying(p),
      }, dt);
      p.gait=Math.min(1,p.mps/RUN_MPS);                        // 0 = still, 1 = full run
      void moved;
      const stride=Math.max(0.55,gaitStride(p.gait,p.legLen||0.95));
      const cadence=Math.min(MAX_CADENCE,p.mps/stride);        // cycles per second
      p.phase+=cadence*dt*Math.PI*2;

      // ---- dodge roll: i-frames, not just a speed burst ----
      if(dodge && !(p.cd.dodge>this.t) && p.stunUntil<=this.t){
        p.cd.dodge=this.t+RULES.dodgeCooldown;
        p.dodgeUntil=this.t+200;
        p.rollUntil=this.t+COMBAT.rollIFrames*1000;
        p.rollEnd=this.t+COMBAT.rollTime*1000;
        p.atkUntil=0;                                   // rolling cancels a swing
      }

      // ---- guard ----
      const wantBlock = !p.isBot && p.stunUntil<=this.t && p.atkUntil<=this.t
        && !!(p.remote ? (this.remoteInput||{}).bl : (local ? human && human.block : false));
      if(wantBlock && !p.blocking) p.blockFrom=this.t;   // parry window starts now
      p.blocking = wantBlock;

      // ---- attack: windup -> active -> recover, damage only while active ----
      // `p.cd` starts empty, so cd.attack is undefined and `undefined <= t` is
      // ALWAYS false — the negated form is the one that works from a cold start.
      if(attack && !(p.cd.attack>this.t) && p.atkUntil<=this.t && p.stunUntil<=this.t && !p.blocking){
        p.cd.attack=this.t+RULES.attackCooldown;
        p.atkStart=this.t;
        p.atkHitAt=this.t+COMBAT.windup*1000;
        p.atkUntil=this.t+(COMBAT.windup+COMBAT.active+COMBAT.recover)*1000;
        p.atkSpent=false;
      }
      if(p.atkUntil>this.t && !p.atkSpent && this.t>=p.atkHitAt && this.t<=p.atkHitAt+COMBAT.active*1000){
        p.atkSpent=true;                                 // one hit per swing
        const targets=this.players.filter(q=>q.id!==p.id&&!q.deadUntil&&dist(p,q)<RULES.attackRange)
                                  .sort((a,b)=>dist(p,a)-dist(p,b));
        if(targets[0]){ const q=targets[0];
          const behind=Math.cos(Math.atan2(p.y-q.y,p.x-q.x)-q.angle)<-0.5;
          const res=this.hurt(q,(behind&&p.crouch)?100:RULES.attack,p);
          if(res==='hit'||res==='kill'){
            let dx=q.x-p.x, dy=q.y-p.y, L=Math.hypot(dx,dy);
            if(L<1){ dx=Math.cos(p.angle||0); dy=Math.sin(p.angle||0); L=1; }
            dx/=L; dy/=L;
            shove(q, dx, dy, 96);
            shove(p, -dx, -dy, 52);
            this.impact={at:this.t, x:(p.x+q.x)/2, y:(p.y+q.y)/2,
              z:Math.max(p.z||0, q.z||0), kill:res==='kill', victim:q.id, nx:dx, ny:dy};
          }
          if(res==='parry'){ p.atkUntil=this.t; }
        }
      }

      // ---- glyphs, levers, braziers, the disc ----
      if(!p.isBot || p.ally){
        const res=this.interact.step(dt,p,!!interact);
        if(res==='relic'){
          const r=this.relics[0]; if(r) r.owner=p.id;
          this.event(`${p.name} lifts the sun disc`);
        }
      }
      const carried=this.carrying(p);
      if(carried){ carried.x=p.x; carried.y=p.y; carried.z=p.z; }

      // the landing pose decays over ~0.35 s; fbxrunner blends it over locomotion
      if(p.landImpact && !p._landSeen){ p._landSeen=true; }
      p.landAnim = Math.max(0, (p.landAnim||0) - dt/0.35);

      // ---- what the tomb does to you ----
      this._hazards(p,dt);

      // concealment visibility. A dormant guardian is a statue: always drawn.
      const hid=crouch&&inBush(p);
      const eye = this.players[this.localId] || this.players[0];
      p.vis = (p.id===this.localId || p.ally || p.dormant) ? 1
        : (hid?0.0:(dist(p,eye)<70?1:(dist(p,eye)<360?1:0.25)));
    }

    // The story reads the world LAST, once every body and every mechanism has
    // moved, so a beat condition is never evaluated against a half-stepped tick.
    const adv=this.story.step();
    if(adv==='complete'){ this.won=true; this.winner=this.players[this.localId] || this.players[0]; this._finish(); return; }
    if(adv===true) this.event(this.story.current().title);
  }

  // -------------------------------------------------------------------------
  // HAZARDS. The tomb kills in two ways that have nothing to do with combat:
  // you fall into something, or the water closes over you.
  // -------------------------------------------------------------------------
  _hazards(p,dt){
    if(p.deadUntil||p.dormant) return;
    const pit=this.mech.pitAt(p);
    if(pit){ this._claim(p,pit); return; }
    // Submersion is graced: brushing the rising water must not be fatal, or the
    // escape becomes a precision platforming test instead of a chase.
    const sub=this.mech.submersion(p);
    if(sub>MECH.drownDepth){ p.under=(p.under||0)+dt;
      if(p.under>=MECH.drownGrace) this._claim(p,'the water'); }
    else p.under=Math.max(0,(p.under||0)-dt*2);
    // falling masonry during the collapse. It HURTS rather than kills: the
    // water is the deadline, and two hazards both able to end the run outright
    // would make the escape a lottery rather than a chase.
    const deb=this.mech.debrisHit(p);
    if(deb){
      p.hp=Math.max(0,p.hp-deb);
      p.hitUntil=this.t+COMBAT.hitStun*1000;
      this.impact={at:this.t,x:p.x,y:p.y,z:p.z||0,kill:false,victim:p.id,nx:0,ny:1};
      if(!p.hp) this._claim(p,'the ceiling');
      else if(!p.isBot||p.ally) this.event(`${p.name} is caught by falling stone`);
    }
  }

  _claim(p,cause){
    if(p.deadUntil) return;
    p.hp=0; p.under=0; p.deadUntil=this.t+1200; p.ledge=null; p.state='ground';
    if(!p.isBot||p.ally) this.story.deaths++;
    this.event(`${p.name} was lost to ${cause}`);
  }

  _respawn(p){
    // A guardian goes back to its post; a runner goes back to the beat it is in.
    // Respawn roulette at a random spawn is a deathmatch convention, and here it
    // would drop you on the far side of a puzzle you had not solved.
    const c=(p.isBot&&!p.ally)?MAP.spawns[p.id%MAP.spawns.length]:this.story.checkpoint();
    p.x=c.x; p.y=c.y; p.z=c.z!=null?c.z:groundAt(c.x,c.y);
    p.hp=100; p.deadUntil=0; p.invuln=this.t+1500; p.under=0;
    p.vz=0; p.state='ground'; p.ledge=null; p.regrab=0;
    p.jumpBuf=0; p.coyote=0; killMomentum(p);
    p.px=p.x; p.py=p.y; p.pz=p.z;                 // snap, never lerp across a respawn
    p.snapN=(p.snapN||0)+1;                       // ...and main.js must not ease across it either
    // Dying in the flood rolls the water back, or one mistake makes the escape
    // mathematically unwinnable and the only remaining option is restarting.
    if(this.story.current().key==='escape') this.mech.floodT=Math.max(0,this.mech.floodT-25);
  }

  _botThink(p){
    if(p.dormant) return ZERO_AI;            // still carved into the floor
    if(p.ally) return this._allyThink(p);    // the partner slot with nobody in it
    return this._guardThink(p);
  }

  // The co-op partner when no human has taken the slot. It follows and keeps
  // up; it does NOT solve anything. A partner competent enough to work the
  // levers would remove the only reason the second player exists.
  _allyThink(p){
    const out={...ZERO_AI};
    if(p.state==='hang'){ out.fwd=1; return out; }
    if(p.state==='mantle'||p.state==='vault') return out;
    const lead=this.players[0];
    if(!lead||lead.deadUntil) return out;
    const d=dist(p,lead);
    if(d<95) return out;                                  // close enough, hold
    let dx=lead.x-p.x, dy=lead.y-p.y; const L=Math.hypot(dx,dy)||1; dx/=L; dy/=L;
    if((lead.z||0) > (p.z||0)+0.5 && findLedge(p)) out.jump=true;
    const ax=p.x+dx*26, ay=p.y+dy*26;
    if(blocked(ax,ay,p.z) || wouldFall(p,ax,ay)){ const px=-dy; dy=dx; dx=px; }
    out.mx=dx; out.my=dy; out.sprint=d>260;
    return out;
  }

  _guardThink(p){
    const out={...ZERO_AI};
    const me=p, b=me.bot;
    // Mid-climb: finish it.
    if(me.state==='hang'){ out.fwd=1; return out; }
    if(me.state==='mantle'||me.state==='vault') return out;

    // ---- perception. A runner crouched in cover (vis 0) is truly invisible.
    const seen = q => !q.deadUntil && (!q.isBot||q.ally) && dist(me,q) < BOT.sight && q.vis > 0.2;
    const foe = this.players.filter(q=>q.id!==me.id && seen(q)).sort((a,c)=>dist(me,a)-dist(me,c))[0];

    // ---- the post it woke at. Guardians defend a room; they do not roam ----
    const post = MAP.spawns[me.id % MAP.spawns.length];
    const strayed = dist(me,post) > LEASH;

    if(this.t >= (b.retarget||0)){
      b.retarget = this.t + BOT.think + Math.random()*BOT.thinkJitter;
      b.kind = strayed ? 'return' : (foe ? 'hunt' : 'post');
      b.strafe = 0;
    }

    let goal=null;
    if(strayed || b.kind==='return'){ goal=post; out.sprint=true; }
    else if(b.kind==='hunt' && foe){ goal=foe; out.sprint=dist(me,foe)>140; }
    else {
      // hold the post, drifting a little so two guardians are not identical
      if(!b.search || this.t>(b.searchUntil||0) || dist(me,b.search)<50){
        const a=Math.random()*Math.PI*2, rr=Math.random()*120;
        const cx=post.x+Math.cos(a)*rr, cy=post.y+Math.sin(a)*rr;
        // only drift to somewhere that is actually floor at this height
        b.search = Math.abs(groundAt(cx,cy)-(me.z||0))<0.6 ? {x:cx,y:cy} : {x:post.x,y:post.y};
        b.searchUntil=this.t+BOT.wander;
      }
      goal=b.search;
    }

    const goalZ = goal && goal.z != null ? goal.z : (goal ? groundAt(goal.x,goal.y) : 0);
    if(goalZ > me.z + 0.5 && findLedge(me)) out.jump = true;

    if(foe && dist(me,foe)<RULES.attackRange) out.attack=true;
    if(foe && dist(me,foe)<40 && Math.random()<0.02) out.dodge=true;
    if(!goal) return out;

    let dx=goal.x-me.x, dy=goal.y-me.y; const L=Math.hypot(dx,dy)||1; dx/=L; dy/=L;
    // Avoid walls AND ledges. The old call also passed no height, so every wall
    // taller than a step read as blocking no matter what floor the guardian was
    // standing on — on a five-storey level that is most of the map.
    const ax=me.x+dx*26, ay=me.y+dy*26;
    if(blocked(ax, ay, me.z) || wouldFall(me, ax, ay)){
      if(this.t>(b.slideUntil||0)){ b.strafe=Math.random()<0.5?1:-1; b.slideUntil=this.t+500; }
      const px=-dy, py=dx; dx=px*b.strafe; dy=py*b.strafe;
      // if sliding ALSO walks off the edge, stand still rather than commit suicide
      if(wouldFall(me, me.x+dx*26, me.y+dy*26)){ out.mx=0; out.my=0; return out; }
    } else {
      // small steady heading error so they do not travel on rails
      const a=Math.atan2(dy,dx) + (b.noise||(b.noise=(Math.random()*2-1)*BOT.aimNoise));
      dx=Math.cos(a); dy=Math.sin(a);
    }
    out.mx=dx; out.my=dy; return out;
  }

  _finish(){ this.phase='results'; }
  // Two humans in the run (host + partner, from either end). Re-read every
  // tick, so a partner who leaves hands the strict co-op gates back to the
  // solo rules instead of stranding the runner who stayed.
  // A crouched, standing-still human partner within reach of this runner.
  _booster(p){
    for(const q of this.players){
      if(q===p || q.isBot || q.deadUntil || q.state!=='ground' || !q.crouch || (q.mps||0)>0.6) continue;
      if(Math.abs((q.z||0)-(p.z||0))>0.3) continue;
      if(dist(p,q)*S<=BOOST_R) return q;
    }
    return null;
  }
  isCoop(){ const a=this.players[0], b=this.players[1]; return !!(a && b && !a.isBot && !b.isBot); }

  // Elapsed, not remaining: the tomb has no match clock. The only deadline in
  // it is the flood, and that one gets its own readout.
  elapsed(){ return this.t - (this.story ? this.story.startedAt : 0); }

  // Seconds until the water here is deep enough to start drowning this body.
  // Zero outside beat 7, which is also how the HUD knows to hide the bar.
  floodLeft(p=this.players[0]){
    const m=this.mech;
    if(!m || !m.flooding || !p) return 0;
    const rate=(WATER.flood-WATER.start)/WATER.floodSeconds;     // metres per second
    return Math.max(0, ((p.z||0)+MECH.drownDepth-m.waterZ)/rate);
  }
}

// --- Meshy asset upgrade hooks (called by assets.js when a GLB pack is present) ---
// THE RIM. A dark-clothed runner against dark stone is a hole in the frame,
// and two of them are the same hole. A thin fresnel edge in the runner's own
// colour — teal for the first, coral for the second — is how a co-op game
// tells its players apart at a glance and keeps them readable in shadow. It
// is added after lighting, so it is a light catch on the silhouette, not paint.
function rimLight(root, hex){
  const col = new THREE.Color(hex);
  root.traverse(o => {
    if(!o.isMesh || !o.material) return;
    for(const m of (Array.isArray(o.material) ? o.material : [o.material])){
      if(!m.isMeshStandardMaterial) continue;
      const uni = { uRim: { value: col }, uRimK: { value: 0.22 } };
      m.userData.rim = uni;
      const prev = m.onBeforeCompile;           // the cloth weave, if the clone kept it
      m.onBeforeCompile = (sh, r) => {
        if (prev) prev.call(m, sh, r);
        Object.assign(sh.uniforms, uni);
        sh.fragmentShader = 'uniform vec3 uRim;\nuniform float uRimK;\n' + sh.fragmentShader.replace('#include <opaque_fragment>',
          `float rimF = 1.0 - max(dot(normalize(normal), normalize(vViewPosition)), 0.0);
          outgoingLight += uRim * smoothstep(0.55, 1.0, rimF) * uRimK;
          #include <opaque_fragment>`);
      };
      m.customProgramCacheKey = () => 'rim' + (prev ? prev.toString().length : 0);
      m.needsUpdate = true;
    }
  });
}

Game.prototype.upgradeRunners = function(proto, animations, opts){
  // normalise a model: feet on the ground, centred, facing +Z (movement dir)
  const norm = (src, targetH) => {
    const box=new THREE.Box3().setFromObject(src); const size=new THREE.Vector3(); box.getSize(size);
    const scale=targetH/(size.y||1.9);
    return { scale, feet:box.min.y*scale,
             cx:(box.min.x+box.max.x)/2*scale, cz:(box.min.z+box.max.z)/2*scale };
  };
  const clips = opts && opts.clips;           // named Mixamo clips, when rigged
  const riggedAll = !!(opts && opts.rigged);
  const legacy = animations&&animations.length?animations:null;
  for(const p of this.players){
    for(const c of [...p.mesh.children]) if(c!==p.ring) p.mesh.remove(c);
    // A guardian is a STATUE that wakes, so it gets its own model rather than
    // the runner mesh under a different tint. It carries no rig, so it falls to
    // the procedural walk driver — stiff, which for carved rock is the look.
    const isGuard = p.isBot && !p.ally && !!this._guardianProto;
    const src = isGuard ? this._guardianProto : proto;
    const rigged = isGuard ? false : riggedAll;
    const { scale, feet, cx, cz } = norm(src, isGuard ? 2.05 : 1.85);   // guardians stand taller
    // A SkinnedMesh must be cloned with SkeletonUtils, not Object3D.clone — a plain
    // clone shares the original's bones and every character animates as one.
    const model = rigged ? cloneSkinned(src) : src.clone(true);
    if(rigged) isolateMaterials(model);   // or all five share one material (see fbxrunner)
    else isolateMaterials(model);         // statues tint independently too
    if(!isGuard && p.id < 2) rimLight(model, p.id === 0 ? 0x7fe3ff : 0xff9d84);
    model.scale.setScalar(scale);
    model.position.set(-cx, -feet, -cz);
    // The model already faces +Z and main.js aims each runner's local +Z down its
    // movement vector, so no yaw offset. The old Math.PI made everyone moonwalk.
    const wrap=new THREE.Group(); wrap.add(model);
    p.mesh.add(wrap); p.model=model; p.wrap=wrap;
    p.mesh.tint=()=>{};
    // Carrying shows as the disc itself, slung on the back. It used to paint a
    // flat blue emissive over the whole body, which under the tonemapper turned
    // the runner a washed-out white for the entire escape.
    let slung=null, carryOn=false;
    p.mesh.setCarrying=(on)=>{
      if(on===carryOn) return; carryOn=on;
      if(on && !slung){
        let spine=null; model.traverse(o=>{ if(!spine && o.isBone && /Spine2$/.test(o.name)) spine=o; });
        slung=new THREE.Group();
        // built facing -Z, the runner's back: the face looks behind them
        const disc=new THREE.Mesh(new THREE.CylinderGeometry(0.2,0.2,0.035,28),
          new THREE.MeshStandardMaterial({color:0xe2bf6a,emissive:0xb07a24,emissiveIntensity:0.9,metalness:0.7,roughness:0.3}));
        disc.rotation.x=Math.PI/2; slung.add(disc);
        const boss=new THREE.Mesh(new THREE.OctahedronGeometry(0.075,0),
          new THREE.MeshStandardMaterial({color:0xf3d98a,emissive:0xd9a74a,emissiveIntensity:1.4,metalness:0.6,roughness:0.25}));
        boss.position.z=-0.03; slung.add(boss);
        if(spine){
          // Placed in WORLD terms and then expressed in the bone's frame: a
          // Mixamo spine's local axes are not the body's, and an offset along
          // the bone's -Z hung the disc edge-on off one shoulder.
          p.mesh.updateMatrixWorld(true);
          const P=new THREE.Vector3(), Qs=new THREE.Quaternion(), Qm=new THREE.Quaternion(), ws=new THREE.Vector3();
          spine.getWorldPosition(P); spine.getWorldQuaternion(Qs); model.getWorldQuaternion(Qm); spine.getWorldScale(ws);
          const at=P.clone().add(new THREE.Vector3(0,0.02,-0.2).applyQuaternion(Qm));
          spine.add(slung); slung.position.copy(spine.worldToLocal(at));
          slung.quaternion.copy(Qs.invert().multiply(Qm)); slung.scale.setScalar(1/(ws.x||1));
        } else { slung.position.set(0,1.25,-0.2); p.mesh.add(slung); }
      }
      if(slung) slung.visible=on;
    };

    if(rigged && clips){
      // real mocap: blend idle/walk/run by measured ground speed
      p.mixer=new THREE.AnimationMixer(model);
      p.mesh.anim=makeFbxLocomotion(p.mixer, clips);
      wrap.scale.setScalar(1); wrap.position.set(0,0,0);

      // ---- ground the rig against its POSED skeleton, not its bind box ----
      // `feet` above came from a Box3 of the untouched proto. For a skinned FBX
      // that box is the bind pose, and it put the idle character 1.03 m above
      // the floor — the "why is it flying" you can see from the first frame.
      // Measuring the actual foot bones once the idle pose has settled is the
      // only reading that survives a different rig later.
      // foot bones, kept for the IK pass in main.js
      p.feet = [];
      model.traverse(o=>{ if(o.isBone && /(left|right)foot$/.test(o.name.toLowerCase())) p.feet.push(o); });
      p.rig = calibrateRig(p.mixer, p.mesh.anim, model, p.mesh);
      // Rest shin length per foot, measured on the settled idle pose. The IK
      // clamps the foot onto a sphere of this radius about the knee, which is
      // what stops a leg being stretched into a spike when the ground under a
      // foot is further down than the leg can reach.
      p.shin = p.feet.map(f=>{
        if(!f.parent) return 0;
        const a=new THREE.Vector3(), b=new THREE.Vector3();
        f.getWorldPosition(a); f.parent.getWorldPosition(b);
        return a.distanceTo(b);
      });
      model.position.y -= p.rig.drop;
      p.rig.lift -= p.rig.drop;          // hand height is relative to the new origin
      if (p.id === 0 && typeof window !== 'undefined') window.__RIG = p.rig;   // for tools/rigcheck
    } else if(legacy){
      p.mixer=new THREE.AnimationMixer(model);
      const run=legacy.find(a=>/run|walk|jog/i.test(a.name))||legacy[0];
      const act=p.mixer.clipAction(run); act.play(); act.setEffectiveWeight(0);
      p.mesh.anim=(phase,gait)=>{ const g=Math.min(1,Math.max(0,gait||0));
        act.setEffectiveWeight(g>0.05?1:0); act.setEffectiveTimeScale(Math.max(0.5,g*1.5)); };
    } else {
      // static mesh fallback: bend it in the vertex shader so it strides at all
      p.mixer=null;
      const rig=attachWalkRig(model);
      p.legLen=rig.legLenRig*scale;
      p.mesh.anim=makeWalkDriver(rig, wrap, p.legLen);
    }
  }
};

Game.prototype.upgradeRelics = function(proto){
  for(const r of this.relics){ if(!r.mesh)continue; const gem=r.mesh.userData.gem; if(gem)r.mesh.remove(gem);
    const m=proto.clone(true); m.scale.setScalar(0.5); m.traverse(o=>{ o.userData.fromProto=true; });
    r.mesh.add(m); r.mesh.userData.gem=m; }
};
