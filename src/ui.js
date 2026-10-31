// ---------------------------------------------------------------------------
// Front-end panels: settings, controls, records, pause, chapter cards, toasts.
//
// Pure DOM. Nothing here reads or writes simulation state; main.js passes in
// what to show and is told, through `onSetting`, what the player changed.
// ---------------------------------------------------------------------------
import { settings, saveSettings, resetSettings, records, ACHIEVEMENTS } from './prefs.js';
import { fmtTime } from './hud.js';

const $ = id => document.getElementById(id);

// The settings schema. Order is the order on screen.
const ROWS = [
  { k: 'volume', label: 'Master volume', type: 'range', min: 0, max: 100, step: 1, fmt: v => v + '%' },
  { k: 'sens', label: 'Look sensitivity', type: 'range', min: 0.25, max: 3, step: 0.05, fmt: v => (+v).toFixed(2) + '×' },
  { k: 'invertY', label: 'Invert look Y', type: 'toggle' },
  { k: 'fov', label: 'Field of view', type: 'range', min: 50, max: 80, step: 1, fmt: v => v + '°' },
  { k: 'shake', label: 'Camera shake', hint: 'Lower for motion comfort', type: 'range', min: 0, max: 100, step: 5, fmt: v => v + '%' },
  { k: 'quality', label: 'Graphics quality', hint: 'Auto steps down if frames run long', type: 'seg', opts: ['auto', 'low', 'medium', 'high'] },
  { k: 'tutorial', label: 'Tutorial guidance', hint: 'Field notes that teach each move', type: 'toggle' },
  { k: 'marker', label: 'Objective marker', type: 'toggle' },
  { k: 'captions', label: 'Captions', hint: 'Speaker-named dialogue', type: 'toggle' },
  { k: 'hints', label: 'Controls strip', type: 'toggle' },
  { k: 'sprintToggle', label: 'Run', hint: 'Hold or toggle', type: 'seg', opts: [false, true], names: ['HOLD', 'TOGGLE'] },
  { k: 'useToggle', label: 'Use / levers', hint: 'Hold or toggle', type: 'seg', opts: [false, true], names: ['HOLD', 'TOGGLE'] },
  { k: 'guardToggle', label: 'Guard', hint: 'Hold or toggle', type: 'seg', opts: [false, true], names: ['HOLD', 'TOGGLE'] },
  { k: 'fps', label: 'Show frame rate', type: 'toggle' },
];

export function createUI({ onSetting, onAction }) {
  const stack = [];                       // open panels, top last
  const open = id => {
    const el = $(id); if (!el) return;
    if (id === 'settings') renderSettings();
    if (id === 'records') renderRecords();
    el.classList.remove('off');
    stack.push(id);
    const first = el.querySelector('button, input');
    if (first) setTimeout(() => first.focus({ preventScroll: true }), 30);
  };
  const close = () => {
    const id = stack.pop(); if (id) $(id).classList.add('off');
    const top = stack[stack.length - 1];
    if (top) { const b = $(top).querySelector('button'); if (b) b.focus({ preventScroll: true }); }
    return id;
  };
  const closeAll = () => { while (stack.length) close(); };

  document.addEventListener('click', e => {
    const t = e.target.closest('[data-open],[data-close],[data-act]');
    if (!t) return;
    if (t.dataset.open) open(t.dataset.open);
    else if (t.dataset.close !== undefined) close();
    else if (t.dataset.act === 'defaults') { resetSettings(); for (const r of ROWS) onSetting(r.k, settings[r.k]); renderSettings(); }
    else onAction(t.dataset.act);
  });

  function renderSettings() {
    const list = $('setlist');
    list.innerHTML = '';
    for (const r of ROWS) {
      const row = document.createElement('div'); row.className = 'set';
      row.innerHTML = `<span>${r.label}${r.hint ? `<small>${r.hint}</small>` : ''}</span><div class="ctl"></div>`;
      const ctl = row.querySelector('.ctl');
      const set = v => { settings[r.k] = v; saveSettings(); onSetting(r.k, v); };
      if (r.type === 'range') {
        const inp = document.createElement('input');
        Object.assign(inp, { type: 'range', min: r.min, max: r.max, step: r.step, value: settings[r.k] });
        inp.setAttribute('aria-label', r.label);
        const out = document.createElement('output'); out.textContent = r.fmt(settings[r.k]);
        inp.addEventListener('input', () => { const v = +inp.value; out.textContent = r.fmt(v); set(v); });
        ctl.append(inp, out);
      } else if (r.type === 'toggle') {
        const b = document.createElement('button'); b.className = 'tog'; b.setAttribute('role', 'switch');
        b.setAttribute('aria-label', r.label); b.setAttribute('aria-checked', String(!!settings[r.k]));
        b.addEventListener('click', () => { const v = !settings[r.k]; b.setAttribute('aria-checked', String(v)); set(v); });
        ctl.append(b);
      } else {
        const seg = document.createElement('div'); seg.className = 'seg'; seg.setAttribute('role', 'group');
        seg.setAttribute('aria-label', r.label);
        r.opts.forEach((o, i) => {
          const b = document.createElement('button');
          b.textContent = r.names ? r.names[i] : String(o).toUpperCase();
          b.className = settings[r.k] === o ? 'on' : '';
          b.addEventListener('click', () => { seg.querySelectorAll('button').forEach(x => x.className = ''); b.className = 'on'; set(o); });
          seg.append(b);
        });
        ctl.append(seg);
      }
      list.append(row);
    }
  }

  function renderRecords() {
    const got = new Set(records.unlocked || []);
    $('reclist').innerHTML = `
      <div class="recgrid">
        <div><b>${records.bestMs != null ? fmtTime(records.bestMs) : '—'}</b><span>BEST ESCAPE</span></div>
        <div><b>${records.wins || 0}<small style="font-size:14px;color:var(--muted)"> / ${records.runs || 0}</small></b><span>ESCAPES / RUNS</span></div>
        <div><b>${got.size} / ${ACHIEVEMENTS.length}</b><span>HONOURS</span></div>
      </div>
      <div class="honours">${ACHIEVEMENTS.map(a => honour(a, got.has(a.id))).join('')}</div>`;
  }

  // ---- chapter card: the beat title, held, then faded ----
  let chapterTimer = 0;
  function chapter(title) {
    const m = /^([IVX]+)\s*·\s*(.*)$/.exec(title || '');
    $('chnum').textContent = m ? m[1] : '';
    $('chtitle').textContent = m ? m[2] : title;
    const el = $('chapter');
    el.classList.remove('off');
    clearTimeout(chapterTimer);
    chapterTimer = setTimeout(() => el.classList.add('off'), 3200);
  }

  // ---- toast queue: honours unlocked, co-op status ----
  const queue = []; let showing = false;
  function toast(title, text, icon = '✦') {
    queue.push({ title, text, icon });
    if (!showing) next();
  }
  function next() {
    const t = queue.shift(); const el = $('toast');
    if (!t) { showing = false; el.classList.add('off'); return; }
    showing = true;
    el.innerHTML = `<i>${t.icon}</i><div><b>${t.title}</b><span>${t.text}</span></div>`;
    el.classList.remove('off');
    setTimeout(() => { el.classList.add('off'); setTimeout(next, 350); }, 3400);
  }

  return { open, close, closeAll, get depth() { return stack.length; }, top: () => stack[stack.length - 1],
    chapter, toast, renderRecords };
}

export const honour = (a, got) =>
  `<div class="hon${got ? ' got' : ''}"><i>${got ? '✦' : '·'}</i><div><b>${a.name}</b><small>${a.desc}</small></div></div>`;
