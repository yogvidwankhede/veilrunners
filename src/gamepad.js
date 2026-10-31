// ---------------------------------------------------------------------------
// Gamepad input, standard mapping (Xbox / PlayStation / Switch Pro in a browser).
//
// Polled once per rendered frame. Sticks get a radial deadzone with the live
// range rescaled to 0..1, so a worn stick that rests at 0.12 does not walk the
// runner off a ledge, and full tilt still reaches full speed. Buttons report
// edges (pressed this frame) separately from holds, the same split the keyboard
// path uses, so the simulation's input buffering sees a pad press exactly as it
// sees a key press.
//
//   left stick  move           right stick  look
//   A / Cross   jump / climb   B / Circle   roll
//   X / Square  use (hold)     Y / Triangle crouch
//   RT          strike         LT           guard
//   LB / L3     run            Start        pause
// ---------------------------------------------------------------------------

const DEAD = 0.16;
const BTN = { a: 0, b: 1, x: 2, y: 3, lb: 4, rb: 5, lt: 6, rt: 7, back: 8, start: 9, l3: 10, r3: 11,
  up: 12, down: 13, left: 14, right: 15 };

function radial(x, y) {
  const m = Math.hypot(x, y);
  if (m < DEAD) return [0, 0];
  const k = Math.min(1, (m - DEAD) / (1 - DEAD)) / m;
  return [x * k, y * k];
}

// `nth` picks the nth connected pad, so two runners on one screen each get
// their own: pad 0 and pad 1 in the order the browser reports them.
export function createGamepad(nth = 0) {
  const prev = new Set();
  const pad = {
    connected: false,
    move: { fwd: 0, strafe: 0 },
    look: { x: 0, y: 0 },
    held: new Set(),
    edges: new Set(),
    lastUsed: 0,
  };
  pad.consume = k => { if (pad.edges.has(k)) { pad.edges.delete(k); return true; } return false; };

  pad.poll = () => {
    const list = (navigator.getGamepads && navigator.getGamepads()) || [];
    let gp = null, seen = 0;
    for (const g of list) if (g && g.connected && seen++ === nth) { gp = g; break; }
    pad.connected = !!gp;
    pad.held.clear();
    // Edges live for one frame. main.js moves the ones it uses into its own
    // edge flags, which persist until a simulation tick consumes them.
    pad.edges.clear();
    if (!gp) { pad.move.fwd = pad.move.strafe = pad.look.x = pad.look.y = 0; prev.clear(); return; }
    const ax = gp.axes;
    const [lx, ly] = radial(ax[0] || 0, ax[1] || 0);
    const [rx, ry] = radial(ax[2] || 0, ax[3] || 0);
    pad.move.strafe = lx; pad.move.fwd = -ly;
    // A cubic response: precise near the centre for lining up a jump, fast at
    // full tilt for turning around.
    pad.look.x = rx * rx * rx * 0.6 + rx * 0.4;
    pad.look.y = ry * ry * ry * 0.6 + ry * 0.4;
    const down = i => { const b = gp.buttons[i]; return !!b && (b.pressed || b.value > 0.5); };
    for (const [name, i] of Object.entries(BTN)) {
      if (!down(i)) continue;
      pad.held.add(name);
      if (!prev.has(name)) pad.edges.add(name);
    }
    if (pad.held.size || lx || ly || rx || ry) pad.lastUsed = performance.now();
    prev.clear(); for (const k of pad.held) prev.add(k);
  };
  return pad;
}
