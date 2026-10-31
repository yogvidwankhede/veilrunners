// ---------------------------------------------------------------------------
// Device quality tiers.
//
// Every performance figure this project has ever quoted came from one M4 Max.
// "Runs on phone and tablet" is a frame-budget claim, and it cannot be met by a
// single fixed set of render settings. Each tier names its millisecond budget,
// and the auto-tuner steps DOWN when measured P95 misses it on real hardware.
// ---------------------------------------------------------------------------

export const TIERS = {
  low: {
    name: 'low',  budgetMs: 33.3,          // 30 Hz
    pixelRatio: 1.0, shadows: false, shadowMap: 512,
    bloom: false, grass: 0.18, charShadows: false, antialias: false, trees: 0.3,
  },
  medium: {
    name: 'medium', budgetMs: 16.7,
    pixelRatio: 1.25, shadows: true, shadowMap: 1024,
    bloom: true, grass: 0.5, charShadows: false, antialias: true, trees: 0.6,
  },
  high: {
    name: 'high', budgetMs: 16.7,
    pixelRatio: 1.5, shadows: true, shadowMap: 2048,
    bloom: true, grass: 1.0, charShadows: true, antialias: true, trees: 1.0,
  },
};
const ORDER = ['low', 'medium', 'high'];

// A first guess only. It is never trusted — the tuner measures and corrects.
export function guessTier() {
  const ua = navigator.userAgent || '';
  const touch = (navigator.maxTouchPoints || 0) > 1;
  const phone = /Android|iPhone|iPod/i.test(ua) || (touch && Math.min(screen.width, screen.height) < 500);
  const tablet = /iPad|Tablet/i.test(ua) || (touch && !phone);
  const cores = navigator.hardwareConcurrency || 4;
  const mem = navigator.deviceMemory || 4;
  if (phone) return cores >= 8 && mem >= 6 ? 'medium' : 'low';
  if (tablet) return cores >= 8 ? 'medium' : 'low';
  if (cores <= 4 || mem <= 4) return 'medium';
  return 'high';
}

export function applyTier(key, ctx) {
  const t = TIERS[key] || TIERS.medium;
  const { renderer, bloomPass, world, game } = ctx;

  renderer.setPixelRatio(Math.min(t.pixelRatio, window.devicePixelRatio || 1));
  renderer.shadowMap.enabled = t.shadows;
  if (world && world.sun) {
    world.sun.castShadow = t.shadows;
    if (t.shadows && world.sun.shadow.mapSize.width !== t.shadowMap) {
      world.sun.shadow.mapSize.set(t.shadowMap, t.shadowMap);
      if (world.sun.shadow.map) { world.sun.shadow.map.dispose(); world.sun.shadow.map = null; }
    }
  }
  if (bloomPass) bloomPass.enabled = t.bloom;

  // grass is one InstancedMesh: trimming `count` costs nothing and draws fewer blades
  if (world && world.grass) {
    if (world.grass.userData.fullCount === undefined) world.grass.userData.fullCount = world.grass.count;
    world.grass.count = Math.floor(world.grass.userData.fullCount * t.grass);
  }
  // Trees are the triangle budget: ~190k each. Resolution is irrelevant next to
  // this on a phone, so the tier has to thin them, not just shrink the framebuffer.
  if (ctx.placed && ctx.placed.tree) {
    const keep = Math.max(1, Math.round(ctx.placed.tree.length * (t.trees ?? 1)));
    ctx.placed.tree.forEach((m, i) => { m.visible = i < keep; });
  }
  if (game && game.players) {
    for (const p of game.players) if (p.model) p.model.traverse(o => { if (o.isMesh) o.castShadow = t.charShadows; });
  }
  ctx.current = t;
  return t;
}

// Watch real frame times and drop a tier when the budget is genuinely missed.
// Only ever steps down: oscillating between tiers mid-play is worse than being
// one notch conservative.
export function makeAutoTuner(ctx, onChange) {
  let samples = [], settleUntil = performance.now() + 2500, idx = ORDER.indexOf(ctx.current.name);
  // A hidden tab has rAF throttled to a crawl, which looks exactly like a slow
  // GPU. Without this guard, alt-tabbing away permanently downgrades quality.
  if (typeof document !== 'undefined') {
    document.addEventListener('visibilitychange', () => {
      samples = [];
      if (!document.hidden) settleUntil = performance.now() + 1500;
    });
  }
  return dtMs => {
    if (typeof document !== 'undefined' && document.hidden) { samples = []; return; }
    if (dtMs > 200) { samples = []; return; }  // a stall is not a frame-rate signal
    const now = performance.now();
    if (now < settleUntil) return;            // ignore load and shader-compile spikes
    samples.push(dtMs);
    if (samples.length < 180) return;         // ~3 s of frames
    samples.sort((a, b) => a - b);
    const p95 = samples[Math.floor(samples.length * 0.95)];
    samples = [];
    if (p95 > ctx.current.budgetMs * 1.25 && idx > 0) {
      idx--;
      const t = applyTier(ORDER[idx], ctx);
      settleUntil = performance.now() + 2500;
      onChange && onChange(t, p95);
    } else {
      settleUntil = performance.now() + 4000;  // re-check periodically, not constantly
    }
  };
}
