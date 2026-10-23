/* seek.js: the small runtime every composition in this library is built on. Plain script, no build step.
 *
 *   <script src="seek.js"></script>
 *   <script>
 *     const { boot, spring, track, ease, seg, rng } = SK;
 *     boot({ duration: 14, draw: t => { ...draw frame t... }, ready: loadAssets() });
 *   </script>
 *
 * The one rule: draw(t) is a pure function of t. No CSS transitions, no timers, no Math.random, no state carried from
 * the previous frame. Then any frame renders on its own, in any order, identically on any machine, and the renderer
 * can sample sub-frames for motion blur. Everything below exists to make that rule easy to keep.
 *
 * Preview in a normal browser: open the page with ?play to watch it loop in real time, ?t=3.5 to freeze a frame.
 */
(function () {
  'use strict';
  const SK = {};

  // ---------------------------------------------------------------- numbers
  SK.clamp = (x, a = 0, b = 1) => Math.min(b, Math.max(a, x));
  SK.lerp = (a, b, k) => a + (b - a) * k;
  SK.remap = (x, a, b, c = 0, d = 1) => c + (d - c) * SK.clamp((x - a) / (b - a));
  /** progress 0..1 of t through [a, a+dur] */
  SK.seg = (t, a, dur) => SK.clamp((t - a) / dur);
  SK.mix = (c1, c2, k) => { // mix two hex colors
    const p = c => [1, 3, 5].map(i => parseInt(c.slice(i, i + 2), 16));
    const [x, y] = [p(c1), p(c2)];
    return '#' + x.map((v, i) => Math.round(SK.lerp(v, y[i], k)).toString(16).padStart(2, '0')).join('');
  };

  // ---------------------------------------------------------------- deterministic randomness
  /** a seeded generator: const r = SK.rng(42); r() -> [0,1) */
  SK.rng = seed => { let s = seed >>> 0; return () => { s = (s + 0x6D2B79F5) >>> 0; let t = s; t = Math.imul(t ^ t >>> 15, t | 1); t ^= t + Math.imul(t ^ t >>> 7, t | 61); return ((t ^ t >>> 14) >>> 0) / 4294967296; }; };
  /** stateless hash of numbers -> [0,1). Use it instead of Math.random inside draw(t): SK.hash(i, 7) */
  SK.hash = (...n) => { let h = 2166136261; for (const v of n) { h ^= Math.floor(v * 1000) | 0; h = Math.imul(h, 16777619); h ^= h >>> 13; } return ((h >>> 0) % 1e6) / 1e6; };
  /** smooth 1D value noise, seeded: SK.noise(t * 2, 3) */
  SK.noise = (x, seed = 0) => { const i = Math.floor(x), f = x - i, u = f * f * (3 - 2 * f); return SK.lerp(SK.hash(i, seed), SK.hash(i + 1, seed), u) * 2 - 1; };

  // ---------------------------------------------------------------- easing
  SK.ease = {
    linear: k => k,
    inOutSine: k => 0.5 - 0.5 * Math.cos(Math.PI * SK.clamp(k)),
    inOutCubic: k => (k = SK.clamp(k)) < 0.5 ? 4 * k * k * k : 1 - Math.pow(-2 * k + 2, 3) / 2,
    outCubic: k => 1 - Math.pow(1 - SK.clamp(k), 3),
    outExpo: k => (k = SK.clamp(k)) === 1 ? 1 : 1 - Math.pow(2, -10 * k),
    inOutExpo: k => { k = SK.clamp(k); return k === 0 || k === 1 ? k : k < 0.5 ? Math.pow(2, 20 * k - 10) / 2 : (2 - Math.pow(2, -20 * k + 10)) / 2; },
    outBack: (k, s = 1.2) => { k = SK.clamp(k) - 1; return 1 + (s + 1) * k * k * k + s * k * k; },
  };

  // ---------------------------------------------------------------- springs (closed form, so they stay pure functions of t)
  /** Step response of a damped spring released at t=0, going 0 -> 1. freq in Hz, damping ratio < 1 overshoots a little
   *  (0.75-0.85 reads as "a tiny overshoot"), 1 is critically damped (no overshoot). Returns 0 for t <= 0. */
  SK.spring = (t, freq = 2.2, damping = 0.8) => {
    if (t <= 0) return 0;
    const w = 2 * Math.PI * freq;
    if (damping >= 1) return 1 - (1 + w * t) * Math.exp(-w * t);
    const wd = w * Math.sqrt(1 - damping * damping), e = Math.exp(-damping * w * t);
    return 1 - e * (Math.cos(wd * t) + (damping * w / wd) * Math.sin(wd * t));
  };
  /** A value that changes target several times, as a pure function of t: the sum of one spring per change.
   *  keys: [[t0, v0], [t1, v1], ...] (v can be a number or an array of numbers). Each change starts from wherever the
   *  value is when it happens, exactly like a real spring being retargeted, but with no state. */
  SK.track = (t, keys, freq = 2.2, damping = 0.8) => {
    const arr = Array.isArray(keys[0][1]);
    const add = (acc, d, k) => arr ? acc.map((v, i) => v + d[i] * k) : acc + d * k;
    const sub = (x, y) => arr ? x.map((v, i) => v - y[i]) : x - y;
    let acc = keys[0][1];
    for (let i = 1; i < keys.length; i++) {
      if (t <= keys[i][0]) break;
      acc = add(acc, sub(keys[i][1], keys[i - 1][1]), SK.spring(t - keys[i][0], freq, damping));
    }
    return acc;
  };

  // ---------------------------------------------------------------- beat grid
  /** Wrap beats.json (from beats.py) so scenes are written in beats, not seconds. */
  SK.grid = (B) => ({
    ...B,
    at: n => B.offset + n * B.beat,                    // time of beat n (fractional ok)
    bar: n => B.offset + n * B.beat * (B.beats_per_bar || 4),
    beatOf: t => (t - B.offset) / B.beat,              // fractional beat number at time t
    pulse: (t, width = 0.12) => { const b = (t - B.offset) / B.beat; const f = b - Math.floor(b); return b < 0 ? 0 : Math.exp(-f / width); }, // 1 on each beat, decays
  });
  SK.loadJSON = url => fetch(url).then(r => { if (!r.ok) throw new Error('missing ' + url); return r.json(); });

  // ---------------------------------------------------------------- captions
  /** Word-by-word captions from words.json (tts.py / align.py). Returns the line on screen at t as
   *  [{w, on (0..1 lit), active}] or null, holding each line until its last word ends + hold. */
  SK.captions = (data, { hold = 0.35, lead = 0.12 } = {}) => {
    const words = data.words || data; const lines = new Map();
    for (const w of words) { if (!lines.has(w.line)) lines.set(w.line, []); lines.get(w.line).push(w); }
    const L = [...lines.values()];
    return t => {
      const line = L.find(ws => t >= ws[0].t0 - lead && t <= ws[ws.length - 1].t1 + hold);
      if (!line) return null;
      return line.map(w => ({ w: w.w, on: SK.clamp((t - w.t0) / 0.2), active: t >= w.t0 && t < w.t1 }));
    };
  };

  // ---------------------------------------------------------------- canvas helpers
  SK.canvas = (w, h) => {
    const c = document.createElement('canvas'); c.width = w; c.height = h;
    c.style.cssText = 'position:fixed;inset:0;width:100vw;height:100vh;display:block';
    document.body.appendChild(c); return c;
  };
  /** wrap text to lines that fit maxW with the context's current font */
  SK.wrap = (ctx, text, maxW) => {
    const out = []; let line = '';
    for (const word of String(text).split(/\s+/)) {
      const test = line ? line + ' ' + word : word;
      if (ctx.measureText(test).width > maxW && line) { out.push(line); line = word; } else line = test;
    }
    if (line) out.push(line); return out;
  };
  /** largest font size (px) at which text fits in maxW on one line; font is a template like 'bold {}px Inter' */
  SK.fit = (ctx, text, maxW, font, max = 400, min = 8) => {
    let lo = min, hi = max;
    while (hi - lo > 0.5) { const m = (lo + hi) / 2; ctx.font = font.replace('{}', m); if (ctx.measureText(text).width > maxW) hi = m; else lo = m; }
    ctx.font = font.replace('{}', lo); return lo;
  };
  /** film finish on a 2D canvas: fresh seeded grain every frame + vignette. Cheap enough for 60 fps renders. */
  SK.film = (ctx, t, { grain = 0.06, vignette = 0.35, fps = 30 } = {}) => {
    const { width: W, height: H } = ctx.canvas;
    if (!SK._grain) {
      const g = document.createElement('canvas'); g.width = g.height = 256; const gx = g.getContext('2d');
      const img = gx.createImageData(256, 256); const r = SK.rng(3);
      for (let i = 0; i < img.data.length; i += 4) { const v = r() * 255; img.data[i] = img.data[i + 1] = img.data[i + 2] = v; img.data[i + 3] = 255; }
      gx.putImageData(img, 0, 0); SK._grain = g;
    }
    if (grain > 0) {
      const f = Math.floor(t * fps); ctx.save(); ctx.globalAlpha = grain; ctx.globalCompositeOperation = 'overlay';
      ctx.translate(-SK.hash(f, 1) * 256, -SK.hash(f, 2) * 256);
      ctx.fillStyle = ctx.createPattern(SK._grain, 'repeat'); ctx.fillRect(0, 0, W + 256, H + 256); ctx.restore();
    }
    if (vignette > 0) {
      const v = ctx.createRadialGradient(W / 2, H / 2, Math.min(W, H) * 0.35, W / 2, H / 2, Math.hypot(W, H) / 2);
      v.addColorStop(0, 'rgba(0,0,0,0)'); v.addColorStop(1, `rgba(0,0,0,${vignette})`);
      ctx.fillStyle = v; ctx.fillRect(0, 0, W, H);
    }
  };

  // ---------------------------------------------------------------- video clips as frame sequences
  /** Headless Chromium can't seek a <video> reliably frame by frame, so clips go in as JPEG sequences:
   *    ffmpeg -i clip.mp4 -vf fps=30,scale=1080:-2 -q:v 3 frames/clip_%05d.jpg
   *  const clip = await SK.frames('frames/clip_%05d.jpg', 240, 30);  // count, fps
   *  clip.at(t) -> the decoded image for time t (holds the last frame past the end); clip.ready is a promise.
   *  Every frame is decoded up front, so keep clips short or scaled down (300 frames of 1080p is about 2.4 GB). */
  SK.frames = (pattern, count, fps = 30, start = 1) => {
    const imgs = []; const name = i => pattern.replace(/%0?(\d*)d/, (_, w) => String(i).padStart(+w || 0, '0'));
    for (let i = 0; i < count; i++) { const im = new Image(); im.src = name(start + i); imgs.push(im); }
    const ready = Promise.all(imgs.map(im => im.decode().catch(() => { throw new Error('missing frame ' + im.src); })));
    return ready.then(() => ({ imgs, fps, count, duration: count / fps, at: t => imgs[Math.max(0, Math.min(count - 1, Math.floor(t * fps + 1e-6)))] }));
  };

  // ---------------------------------------------------------------- boot
  /** Wire a composition up to the renderer: defines window.seek, window.DURATION, window.__ready.
   *  opts: { duration, draw(t), ready?: Promise, cues?: () => [{t,type,g,p,pan,d}] } */
  SK.boot = ({ duration, draw, ready, cues }) => {
    window.DURATION = duration;
    window.seek = t => draw(Math.max(0, Math.min(duration, t)));
    if (cues) window.cues = cues;
    const q = new URLSearchParams(location.search);
    Promise.resolve(ready).then(() => document.fonts ? document.fonts.ready : null).then(() => {
      window.seek(+(q.get('t') || 0));
      window.__ready = true;
      if (q.has('play')) { const t0 = performance.now(); const loop = () => { window.seek(((performance.now() - t0) / 1000) % duration); requestAnimationFrame(loop); }; loop(); }
    }).catch(e => { document.body.innerHTML = '<pre style="color:red;font:20px monospace;padding:40px">' + e + '</pre>'; console.error(e); });
  };

  window.SK = SK;
})();
