// ---------------------------------------------------------------------------
// Touch controls.
//
// Pointer Lock does not exist on phones, so mouse-look is unavailable and every
// bound key needs a surface. Left half of the screen is a virtual stick, right
// half is a look pad, and the actions sit as thumb-reachable buttons. Nothing is
// created at all on a device without touch.
// ---------------------------------------------------------------------------

export const isTouch = () =>
  (navigator.maxTouchPoints || 0) > 1 || ('ontouchstart' in window);

// Returns { axes:{fwd,strafe}, look:{dx,dy}, pressed:Set, consumeEdge(name) }
export function createTouchControls(root) {
  const state = {
    axes: { fwd: 0, strafe: 0 },
    look: { dx: 0, dy: 0 },
    held: new Set(),
    edges: new Set(),
    active: true,
  };

  const el = document.createElement('div');
  el.id = 'touch';
  el.innerHTML = `
    <div id="tstick"><div id="tnub"></div></div>
    <div id="tlook"></div>
    <div id="tbtns">
      <button data-k="f"     class="tb tb-sm">GUARD</button>
      <button data-k="q"     class="tb tb-sm">ROLL</button>
      <button data-k="c"     class="tb tb-sm">CROUCH</button>
      <button data-k="e"     class="tb tb-sm">USE</button>
      <button data-k=" "     class="tb tb-lg">JUMP</button>
      <button data-k="strike" class="tb tb-lg">STRIKE</button>
    </div>
    <button id="tpause" aria-label="Pause">II</button>`;
  root.appendChild(el);
  el.querySelector('#tpause').addEventListener('touchstart', e => { e.preventDefault(); state.edges.add('pause'); }, { passive: false });

  // ---- left stick ----
  const stick = el.querySelector('#tstick'), nub = el.querySelector('#tnub');
  let stickId = null, sx = 0, sy = 0;
  const R = 52;
  const stickStart = e => {
    const t = e.changedTouches[0]; stickId = t.identifier;
    const r = stick.getBoundingClientRect();
    sx = r.left + r.width / 2; sy = r.top + r.height / 2;
    stickMove(e);
  };
  const stickMove = e => {
    for (const t of e.changedTouches) {
      if (t.identifier !== stickId) continue;
      let dx = t.clientX - sx, dy = t.clientY - sy;
      const d = Math.hypot(dx, dy) || 1;
      if (d > R) { dx = dx / d * R; dy = dy / d * R; }
      nub.style.transform = `translate(${dx}px,${dy}px)`;
      state.axes.strafe = dx / R;
      state.axes.fwd = -dy / R;                     // up on the stick is forward
    }
  };
  const stickEnd = e => {
    for (const t of e.changedTouches) {
      if (t.identifier !== stickId) continue;
      stickId = null; nub.style.transform = 'translate(0,0)';
      state.axes.fwd = 0; state.axes.strafe = 0;
    }
  };
  stick.addEventListener('touchstart', e => { e.preventDefault(); stickStart(e); }, { passive: false });
  stick.addEventListener('touchmove',  e => { e.preventDefault(); stickMove(e); },  { passive: false });
  stick.addEventListener('touchend',   stickEnd);
  stick.addEventListener('touchcancel', stickEnd);

  // ---- right look pad: drag to turn, replaces pointer lock ----
  const look = el.querySelector('#tlook');
  let lookId = null, lx = 0, ly = 0;
  look.addEventListener('touchstart', e => {
    e.preventDefault(); const t = e.changedTouches[0];
    lookId = t.identifier; lx = t.clientX; ly = t.clientY;
  }, { passive: false });
  look.addEventListener('touchmove', e => {
    e.preventDefault();
    for (const t of e.changedTouches) {
      if (t.identifier !== lookId) continue;
      state.look.dx += t.clientX - lx; state.look.dy += t.clientY - ly;
      lx = t.clientX; ly = t.clientY;
    }
  }, { passive: false });
  const lookEnd = e => { for (const t of e.changedTouches) if (t.identifier === lookId) lookId = null; };
  look.addEventListener('touchend', lookEnd);
  look.addEventListener('touchcancel', lookEnd);

  // ---- buttons: holds for guard, edges for the rest ----
  el.querySelectorAll('.tb').forEach(b => {
    const k = b.dataset.k;
    const down = e => { e.preventDefault(); b.classList.add('on'); state.held.add(k); state.edges.add(k); };
    const up   = e => { e.preventDefault(); b.classList.remove('on'); state.held.delete(k); };
    b.addEventListener('touchstart', down, { passive: false });
    b.addEventListener('touchend', up);
    b.addEventListener('touchcancel', up);
  });

  state.consumeEdge = k => { if (state.edges.has(k)) { state.edges.delete(k); return true; } return false; };
  state.takeLook = () => { const d = { dx: state.look.dx, dy: state.look.dy }; state.look.dx = 0; state.look.dy = 0; return d; };
  state.setVisible = v => { el.style.display = v ? '' : 'none'; };
  return state;
}
