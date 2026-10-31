import { ROOMS, roomAt } from './level.js';

// ---------------------------------------------------------------------------
// DISCOVERY — what the player is allowed to have seen.
//
// A room opens the first time a runner stands in it and never closes again.
// Everything that belongs to an undiscovered room is switched off: its lamps do
// not burn, its props are not drawn. With a dark ambient that leaves a black
// void where the chamber is, which is what a tomb looks like from the room
// before it.
//
// Discovery is per-TEAM, not per-player: in co-op your partner lighting the
// mechanism chamber means you can see it from the gallery, which is the whole
// point of sending someone ahead.
// ---------------------------------------------------------------------------

export function createRooms(game) {
  const seen = new Set();
  const R = {
    seen,
    justEntered: null,          // set for one tick when a room opens

    reset() { seen.clear(); R.justEntered = null; },

    // called once per tick with the live bodies
    step(players) {
      R.justEntered = null;
      for (const p of players) {
        if (p.deadUntil || (p.isBot && !p.ally)) continue;    // guardians discover nothing
        const r = roomAt(p.x, p.y, p.z || 0);
        if (r && !seen.has(r.id)) { seen.add(r.id); R.justEntered = r; }
      }
    },

    has: id => seen.has(id),
    // anything NOT in a room (the shell, the vault, the floor) is always drawn:
    // the architecture has to stay coherent or the tomb reads as floating boxes
    visible: id => !id || seen.has(id),
    count: () => seen.size,
    total: () => ROOMS.length,

    // netcode: a guest must not be able to see a chamber the host has not opened
    pack: () => [...seen].join(','),
    apply(csv) { if (typeof csv === 'string') for (const id of csv.split(',')) if (id) seen.add(id); },
  };
  return R;
}
