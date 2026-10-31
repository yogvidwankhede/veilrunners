// ---------------------------------------------------------------------------
// Player settings and records, persisted in localStorage.
//
// Every read and write is guarded: private windows, blocked site data and some
// embedded frames throw on the accessor itself, and a settings menu is not a
// reason for the game to fail to boot. Without storage everything still works
// for the session; it just is not remembered.
// ---------------------------------------------------------------------------

const KEY_SETTINGS = 'veil.settings.v1';
const KEY_RECORDS = 'veil.records.v1';

export const DEFAULTS = {
  volume: 70,          // 0..100, master gain
  sens: 1,             // mouse / stick look multiplier
  invertY: false,
  fov: 60,             // base vertical FOV; sprint widening rides on top
  shake: 100,          // 0..100 — camera shake, landing dip and hitstop flash
  quality: 'auto',     // auto | low | medium | high
  captions: true,
  tutorial: true,      // field notes that teach each move, in the opening chambers
  marker: true,        // the on-screen objective diamond
  hints: true,         // the controls strip along the bottom
  sprintToggle: false, // accessibility: hold-versus-toggle on every hold action
  useToggle: false,
  guardToggle: false,
  fps: false,
};

function load(key, fallback) {
  try { const v = JSON.parse(localStorage.getItem(key) || 'null'); return v && typeof v === 'object' ? v : fallback; }
  catch { return fallback; }
}
function save(key, v) { try { localStorage.setItem(key, JSON.stringify(v)); } catch {} }

export const settings = { ...DEFAULTS, ...load(KEY_SETTINGS, {}) };
export function saveSettings() { save(KEY_SETTINGS, settings); }
export function resetSettings() { Object.assign(settings, DEFAULTS); saveSettings(); }

export const records = { runs: 0, wins: 0, bestMs: null, bestDeaths: null, unlocked: [], ...load(KEY_RECORDS, {}) };
export function saveRecords() { save(KEY_RECORDS, records); }

// ---- achievements ----------------------------------------------------------
// Each one names a way to play the tomb better, not a grind. They are checked
// once, on the results board, against that run's numbers.
export const ACHIEVEMENTS = [
  { id: 'escape',    name: 'Out Alive',        desc: 'Recover the Sun Disc and escape the tomb.', test: r => r.won },
  { id: 'flawless',  name: 'Untouched by Silt', desc: 'Escape without dying once.',                test: r => r.won && r.deaths === 0 },
  { id: 'scholar',   name: 'Glyph Reader',     desc: 'Read all three glyphs.',                     test: r => r.glyphs >= 3 },
  { id: 'steady',    name: 'Steady Hands',     desc: 'Light the braziers without a wrong fire.',  test: r => r.won && r.resets === 0 },
  { id: 'swift',     name: 'Silt Runner',      desc: 'Escape in under 5 minutes.',                 test: r => r.won && r.ms < 300000 },
  { id: 'blitz',     name: 'Before the Water', desc: 'Escape in under 3 minutes 30.',             test: r => r.won && r.ms < 210000 },
  { id: 'together',  name: 'Two Hands',        desc: 'Escape with a partner.',                     test: r => r.won && r.coop },
];

// A grade the player can chase. Time is the spine, deaths cost 20 s each, and
// a wrong brazier costs 8 s: the same order a speedrunner would weigh them.
export function gradeRun(r) {
  if (!r.won) return 'D';
  const s = r.ms / 1000 + r.deaths * 20 + r.resets * 8;
  if (s < 200) return 'S';
  if (s < 300) return 'A';
  if (s < 450) return 'B';
  return 'C';
}

// Fold a finished run into the records; returns what changed for the board.
export function recordRun(r) {
  records.runs = (records.runs || 0) + 1;
  const fresh = [];
  let newBest = false;
  if (r.won) {
    records.wins = (records.wins || 0) + 1;
    if (records.bestMs == null || r.ms < records.bestMs) { records.bestMs = r.ms; newBest = true; }
    if (records.bestDeaths == null || r.deaths < records.bestDeaths) records.bestDeaths = r.deaths;
  }
  const have = new Set(records.unlocked || []);
  for (const a of ACHIEVEMENTS) if (!have.has(a.id) && a.test(r)) { have.add(a.id); fresh.push(a); }
  records.unlocked = [...have];
  saveRecords();
  return { newBest, fresh };
}
