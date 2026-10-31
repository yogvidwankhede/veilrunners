// ---------------------------------------------------------------------------
// CAPTIONS. A queue of spoken lines, each tagged with WHO is speaking.
//
// Speaker identification is not decoration: a caption track that does not name
// the speaker is unusable for anyone relying on it, and in a two-runner story
// where both characters talk it is unusable for everyone. It is also far
// cheaper to build in now than to retrofit into every line later.
//
// Lines advance on simulated time so a caption cannot outrun the beat that
// triggered it on a slow device.
// ---------------------------------------------------------------------------

export function createCaptions() {
  const q = [];
  let cur = null, left = 0;
  const c = {
    // `secs` defaults to a readable dwell: ~14 characters per second, floor 2 s.
    say(speaker, text, secs) {
      q.push({ speaker, text, secs: secs || Math.max(2, Math.min(7, text.length / 14)) });
    },
    step(dt) {
      if (!cur) { cur = q.shift() || null; left = cur ? cur.secs : 0; return; }
      left -= dt;
      if (left <= 0) { cur = q.shift() || null; left = cur ? cur.secs : 0; }
    },
    current() { return cur; },
    clear() { q.length = 0; cur = null; left = 0; },
    pending() { return q.length; },
  };
  return c;
}
