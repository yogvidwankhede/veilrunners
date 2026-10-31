import { BRIEF } from './story.js';

export function makeHUD(root){
  root.innerHTML = `
  <div id="vignette"></div>
  <div id="hud" class="hidden">
    <div id="top">
      <div class="pill" id="beat">I · VII</div>
      <div class="pill objective" id="objective">FIND A WAY DEEPER INTO THE TOMB</div>
      <div class="pill" id="timer">0:00</div>
    </div>
    <div id="crosshair"></div>
    <div id="flood" class="off"><div id="floodfill"></div><span id="floodlabel">THE WATER</span></div>
    <div id="hold" class="off"><svg viewBox="0 0 120 120"><circle class="bg" cx="60" cy="60" r="52"/><circle id="holdarc" cx="60" cy="60" r="52"/></svg><span id="holdlabel">HOLDING</span></div>
    <div id="bottom">
      <div id="health"><div id="hpfill"></div><span>VITALS</span></div>
      <canvas id="minimap" width="180" height="135"></canvas>
    </div>
    <div id="feed"></div>
    <div id="coop" class="off">CO-OP</div>
    <div id="prompt" class="off"><b>SPACE</b> climb</div>
    <div id="prompt2" class="off"></div>
    <div id="runners">
      <div class="runner r1"><i>P1</i><b id="rn1">ARIA</b><div class="hp"><div id="rhp1"></div></div><em id="rst1"></em></div>
      <div class="runner r2"><i>P2</i><b id="rn2">KESTREL</b><div class="hp"><div id="rhp2"></div></div><em id="rst2"></em></div>
    </div>
    <div id="tags"><div class="tag t0 off"><b></b><span></span></div><div class="tag t1 off"><b></b><span></span></div></div>
    <div id="seam"></div>
    <!-- Captions name the speaker. A track that does not is unusable for anyone
         relying on it, and with two runners talking it is unusable for everyone. -->
    <div id="caption" class="off"><b id="capwho">ARIA</b><span id="capline"></span></div>
    <div id="rooms">0 / 8 CHAMBERS</div>
    <div id="hint"><span class="h1">WASD move · SHIFT run · SPACE jump / climb · E use · C crouch · Q roll · F guard · CLICK strike · ESC pause</span><span class="h2">ARROWS move · R-SHIFT run · ENTER jump / climb · / use · . crouch · , roll · ' strike · ; guard</span></div>
  </div>
  <div id="hurt"></div>
  <div id="chapter" class="off"><span id="chnum">I</span><b id="chtitle">THE DOOR THAT WAS SHUT</b></div>
  <div id="toast" class="off"></div>
  <div id="letterbox"><i></i><i></i></div>
  <div id="endcard"><b></b><span></span></div>
  <div id="fps" class="off"></div>
  <div id="screen">
    <div class="center title">
      <div class="logo">VEIL<span>RUNNERS</span></div>
      <div class="tag">${BRIEF.title}</div>
      <p class="goal">${BRIEF.goal}</p>
      <p class="blurb">${BRIEF.lines.join(' ')}</p>
      <div class="modes" role="radiogroup" aria-label="Players">
        <button class="mode on" data-mode="solo" role="radio" aria-checked="true"><b>1</b><span>SOLO</span><small>Kestrel waits at the door</small></button>
        <button class="mode" data-mode="split" role="radio" aria-checked="false"><b>2</b><span>SAME SCREEN</span><small>Split view · one keyboard or two pads</small></button>
        <button class="mode" data-mode="online" role="radio" aria-checked="false"><b>2</b><span>ONLINE</span><small>Two browsers · one room code</small></button>
      </div>
      <div class="fields">
        <label class="p1"><span>Runner one</span><input id="pname" maxlength="16" placeholder="Runner name" value="ARIA" autocomplete="off" spellcheck="false"/></label>
        <label class="p2 forsplit"><span>Runner two</span><input id="pname2" maxlength="16" placeholder="Runner name" value="KESTREL" autocomplete="off" spellcheck="false"/></label>
        <label class="foronline"><span>Room code</span><input id="room" maxlength="24" placeholder="the same word on both screens" aria-label="Room code, the same on both screens" value="" autocomplete="off" spellcheck="false"/></label>
      </div>
      <button id="play" class="primary">ENTER THE TOMB</button>
      <div class="menurow">
        <button class="ghost" data-open="settings">SETTINGS</button>
        <button class="ghost" data-open="controls">CONTROLS</button>
        <button class="ghost" data-open="together">PLAYING TOGETHER</button>
        <button class="ghost" data-open="records">RECORDS</button>
      </div>
      <div id="load"><div id="loadbar"></div></div>
      <div class="assetnote" id="assetnote">Preparing the tomb…</div>
      <div class="recordline" id="recordline"></div>
      <div class="portrait-tip">⟲ Best played in landscape</div>
      <p class="blurb small">Seven chambers, built for two runners and playable by one. Together, the counterweight takes two levers at once, the crane a steady hand, and a wall too high to climb takes a partner's shoulders.</p>
    </div>
  </div>
  <div id="pause" class="panel off" role="dialog" aria-label="Paused">
    <div class="card">
      <h2>PAUSED</h2>
      <p class="sub" id="pausenote"></p>
      <button class="primary" data-act="resume">RESUME</button>
      <button class="ghost wide" data-open="settings">SETTINGS</button>
      <button class="ghost wide" data-open="controls">CONTROLS</button>
      <button class="ghost wide" data-open="together">PLAYING TOGETHER</button>
      <button class="ghost wide" data-act="restart">RESTART RUN</button>
      <button class="ghost wide danger" data-act="quit">ABANDON TO TITLE</button>
    </div>
  </div>
  <div id="settings" class="panel off" role="dialog" aria-label="Settings">
    <div class="card wide"><h2>SETTINGS</h2><div id="setlist"></div>
      <div class="row2"><button class="ghost" data-act="defaults">RESTORE DEFAULTS</button><button class="primary" data-close>DONE</button></div></div>
  </div>
  <div id="controls" class="panel off" role="dialog" aria-label="Controls">
    <div class="card wide"><h2>CONTROLS</h2>
      <table class="keys">
        <tr><th></th><th>Keyboard &amp; mouse</th><th>Gamepad</th></tr>
        <tr><td>Move</td><td><kbd>W</kbd><kbd>A</kbd><kbd>S</kbd><kbd>D</kbd></td><td>Left stick</td></tr>
        <tr><td>Look</td><td>Mouse (click to capture)</td><td>Right stick</td></tr>
        <tr><td>Run</td><td><kbd>Shift</kbd></td><td>LB / L3</td></tr>
        <tr><td>Jump · grab · climb</td><td><kbd>Space</kbd> hold for the full arc</td><td>A / Cross</td></tr>
        <tr><td>Crouch · lower to a hang</td><td><kbd>C</kbd></td><td>Y / Triangle</td></tr>
        <tr><td>Use · hold a lever</td><td><kbd>E</kbd></td><td>X / Square</td></tr>
        <tr><td>Roll</td><td><kbd>Q</kbd></td><td>B / Circle</td></tr>
        <tr><td>Guard</td><td><kbd>F</kbd></td><td>LT</td></tr>
        <tr><td>Strike</td><td>Click / <kbd>J</kbd></td><td>RT</td></tr>
        <tr><td>On a ledge</td><td><kbd>W</kbd> climb · <kbd>A</kbd>/<kbd>D</kbd> shimmy · <kbd>S</kbd> drop</td><td>Left stick</td></tr>
        <tr><td>Pause · mute</td><td><kbd>Esc</kbd> · <kbd>M</kbd></td><td>Start</td></tr>
      </table>
      <p class="sub">On a touch screen: left thumb moves, drag the right side to look, buttons on the right.</p>
      <div class="row2"><button class="primary" data-close>DONE</button></div></div>
  </div>
  <div id="together" class="panel off" role="dialog" aria-label="Playing together">
    <div class="card wide guide"><h2>PLAYING TOGETHER</h2>
      <p class="sub">The Cradle of Silt was cut for two. Alone, every two-handed task runs on a timer; with a partner the timer goes and the tomb opens the way it was built to.</p>
      <div class="ways">
        <div><b>SAME SCREEN</b><span>Pick <em>Same screen</em> on the title. The screen splits: runner one on the left, runner two on the right. Each half has its own camera, its own prompts and its own objective marker.</span></div>
        <div><b>ONLINE</b><span>Pick <em>Online</em>, and both of you type the same room code. The first in hosts the tomb; the second takes Kestrel's place beside them.</span></div>
      </div>
      <table class="keys">
        <tr><th></th><th>Runner one</th><th>Runner two</th></tr>
        <tr><td>Device</td><td>Keyboard &amp; mouse, or pad 1</td><td>Right-hand keys, or a pad (with one pad plugged in, it is runner two's)</td></tr>
        <tr><td>Move</td><td><kbd>W</kbd><kbd>A</kbd><kbd>S</kbd><kbd>D</kbd></td><td><kbd>↑</kbd><kbd>←</kbd><kbd>↓</kbd><kbd>→</kbd> · left stick</td></tr>
        <tr><td>Look</td><td>Mouse</td><td>Follows you on keys · right stick</td></tr>
        <tr><td>Jump · grab · climb</td><td><kbd>Space</kbd></td><td><kbd>Enter</kbd> · A / Cross</td></tr>
        <tr><td>Run</td><td><kbd>Shift</kbd></td><td><kbd>R-Shift</kbd> · LB</td></tr>
        <tr><td>Use · hold a lever</td><td><kbd>E</kbd></td><td><kbd>/</kbd> · X / Square</td></tr>
        <tr><td>Crouch · brace</td><td><kbd>C</kbd></td><td><kbd>.</kbd> · Y / Triangle</td></tr>
        <tr><td>Roll · strike · guard</td><td><kbd>Q</kbd> · click · <kbd>F</kbd></td><td><kbd>,</kbd> · <kbd>'</kbd> · <kbd>;</kbd></td></tr>
      </table>
      <h3>WHAT TWO CAN DO</h3>
      <ol class="moves">
        <li><b>A leg-up.</b> One crouches against a high wall (<kbd>C</kbd> / <kbd>.</kbd>) and braces. The other runs in and jumps off their shoulders to a ledge neither could reach alone.</li>
        <li><b>The counterweight.</b> Two levers either side of the wheel, held at the same moment. Alone you race a latch; together you just hold.</li>
        <li><b>The crane.</b> One holds the arm out over the gap while the other crosses on it, then the far lever swings it back for the first.</li>
        <li><b>The counted floor.</b> One winds the winch and the slabs stay up while the other walks it.</li>
        <li><b>The fires.</b> Read the three glyphs between you and call the order across the sanctum.</li>
        <li><b>The way out.</b> The door waits for both runners. Nobody gets left in the silt.</li>
      </ol>
      <p class="sub">If a runner falls, they come back at the last chamber you reached. Pausing on the same screen stops the tomb for both of you.</p>
      <div class="row2"><button class="primary" data-close>DONE</button></div></div>
  </div>
  <div id="records" class="panel off" role="dialog" aria-label="Records">
    <div class="card wide"><h2>RECORDS</h2><div id="reclist"></div>
      <div class="row2"><button class="primary" data-close>DONE</button></div></div>
  </div>
</div>`;
}

export function setObjective(t){const e=document.getElementById('objective');if(e)e.textContent=t;}
export function fmtTime(ms){const s=Math.max(0,Math.ceil(ms/1000));return `${Math.floor(s/60)}:${String(s%60).padStart(2,'0')}`;}

const ROMAN = ['I','II','III','IV','V','VI','VII'];
export function setBeat(i,total){
  const e=document.getElementById('beat');
  if(e) e.textContent = `${ROMAN[Math.min(i,ROMAN.length-1)]} · ${ROMAN[total-1]||total}`;
}

export function setCaption(line){
  const box=document.getElementById('caption');
  if(!box) return;
  if(!line){ box.classList.add('off'); return; }
  document.getElementById('capwho').textContent=line.speaker;
  document.getElementById('capline').textContent=line.text;
  box.classList.remove('off');
}

// The flood bar is the only clock the tomb has, and it only exists in beat 7.
export function setFlood(secondsLeft, shown){
  const box=document.getElementById('flood');
  if(!box) return;
  box.classList.toggle('off', !shown);
  if(!shown) return;
  const frac=Math.max(0,Math.min(1,secondsLeft/45));
  const fill=document.getElementById('floodfill');
  fill.style.width=(frac*100)+'%';
  fill.style.background = frac>0.4 ? 'linear-gradient(90deg,#2f9ad6,#86d9ff)'
                                   : 'linear-gradient(90deg,#ff5a4e,#ffa08e)';
  document.getElementById('floodlabel').textContent =
    secondsLeft<=0 ? 'UNDER' : `THE WATER · ${Math.ceil(secondsLeft)}s`;
}

// The solo grace window on a hold lever. Showing it is what makes the mechanic
// legible: without the ring you cannot tell a 10-second window from a bug.
export function setHold(frac, label){
  const box=document.getElementById('hold');
  if(!box) return;
  if(frac==null){ box.classList.remove('on'); return; }
  box.classList.add('on');
  document.getElementById('holdarc').style.strokeDashoffset = 327*(1-Math.max(0,Math.min(1,frac)));
  document.getElementById('holdlabel').textContent = label||'HOLDING';
}

// How much of the tomb has been opened. A tomb you can see all of at once is
// not a tomb, so showing the count makes the discovery legible rather than
// leaving the player wondering why the far side is black.
export function setRooms(n, total){
  const e=document.getElementById('rooms');
  if(e) e.textContent = `${n} / ${total} CHAMBERS`;
}
