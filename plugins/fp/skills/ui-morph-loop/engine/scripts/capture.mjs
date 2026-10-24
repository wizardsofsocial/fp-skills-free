// Record an interactive HTML piece (a game, a 3D explorer, a toy) to MP4 deterministically, with no screen recorder.
//
//   node capture.mjs --url http://127.0.0.1:8765/game.html --out run.mp4 --dur 20
//        [--w 1080 --h 1920 --fps 30 --subframes 1] [--actions actions.json] [--seed 7] [--webgl] [--cues cues.json]
//        [--audio run.wav]
//
// The page runs on a virtual clock that this script advances exactly 1/fps per frame: performance.now, Date.now,
// requestAnimationFrame, setTimeout and setInterval are replaced before any page script runs, and Math.random is
// seeded. So a page that was written for real time (rAF loops, physics with dt) records identically every run,
// at full frame rate, however slow the machine or the WebGL software renderer is.
//
// actions.json scripts the "player" (attract mode). Times are in seconds of the recording:
//   [{"t": 0.5, "type": "click", "x": 540, "y": 1500},
//    {"t": 1.0, "type": "move", "x": 300, "y": 900, "to": [800, 900], "d": 0.6},   // cursor glide (drag if "down": true)
//    {"t": 2.0, "type": "key", "key": "ArrowLeft", "hold": 0.4},
//    {"t": 3.0, "type": "eval", "js": "window.game.boost()"}]                       // call into the page
// A page can also drive itself: if it defines window.attract(t), that is called every frame before rendering.
//
// Events: game logic can push to window.EVENTS ({type:'score', value: 10}, {type:'death'}...); --events writes them
// with their recording time, for finding highlights. Anything pushed during boot (before recording) is kept at t=0.
// --cursor draws a visible pointer that follows the scripted mouse (headless Chromium draws none).
//
// Sound, two ways:
//  --audio run.wav  records the page's own Web Audio, in sync and deterministically. Every AudioContext the page makes
//                   is really an OfflineAudioContext on the virtual clock: ctx.currentTime is the virtual time, so
//                   whatever the page schedules (oscillators, buffers, a music scheduler looking ahead of currentTime)
//                   lands on the same frame as the picture, and after the last frame the graph is rendered offline
//                   and cut to the recording. resume()/suspend() are no-ops and state reads 'running'. Not covered:
//                   <audio>/<video> elements and createMediaElementSource / MediaStream nodes (record those as cues).
//                   The page still has to create its AudioContext: if it waits for a tap, script one in --actions.
//                   Then: python3 music.py mux run.mp4 run.wav out.mp4 --fade 0 --no-normalize, and master.py.
//  --cues cues.json the page pushes cues as things happen, window.SFX_LOG.push({type:'pop', g:0.5}) (t is filled in
//                   with the virtual time), and sfx.py mix synthesizes the engine's own sounds on them.
// Errors in the page (exceptions and console.error) are printed as they happen and counted at the end.
import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { findFfmpeg, args, loadPlaywright, launchOptions } from './_common.mjs';

const a = args();
if (!a.url || !a.out || !a.dur) { console.error('usage: node capture.mjs --url <page> --out run.mp4 --dur <s> [--w --h --fps --actions a.json --seed n --webgl --cues c.json --events e.json --audio a.wav --cursor]'); process.exit(1); }
const W = +(a.w || 1280), H = +(a.h || 720), FPS = +(a.fps || 30), SUB = Math.max(1, +(a.subframes || 1));
const DUR = +a.dur, SEED = +(a.seed || 7);
const actions = a.actions ? JSON.parse(readFileSync(a.actions, 'utf8')).sort((x, y) => x.t - y.t) : [];
const BOOT = 5;                                   // frames the page runs before recording starts
const AUDIO_SECONDS = BOOT / FPS + DUR + 2;       // length of each offline audio timeline (boot + recording + tail)

const VIRTUAL_CLOCK = `(() => {
  let now = 0; const start = 1700000000000;
  let seed = ${SEED} >>> 0;
  Math.random = () => { seed = (seed + 0x6D2B79F5) >>> 0; let t = seed; t = Math.imul(t ^ t >>> 15, t | 1); t ^= t + Math.imul(t ^ t >>> 7, t | 61); return ((t ^ t >>> 14) >>> 0) / 4294967296; };
  const raf = new Map(); let rid = 0;
  const timers = new Map(); let tid = 0;
  performance.now = () => now;
  const RealDate = Date;
  Date = class extends RealDate { constructor(...x) { super(...(x.length ? x : [start + now])); } static now() { return start + now; } };
  window.requestAnimationFrame = cb => { raf.set(++rid, cb); return rid; };
  window.cancelAnimationFrame = id => raf.delete(id);
  window.setTimeout = (cb, ms = 0, ...x) => { timers.set(++tid, { at: now + ms, cb, x }); return tid; };
  window.setInterval = (cb, ms = 0, ...x) => { const id = ++tid; timers.set(id, { at: now + ms, cb, x, every: Math.max(1, ms) }); return id; };
  window.clearTimeout = window.clearInterval = id => timers.delete(id);
  window.__rec0 = 0;
  const stamped = () => { const arr = []; const push = arr.push.bind(arr);
    arr.push = (...c) => push(...c.map(x => ({ t: Math.max(0, (now - window.__rec0) / 1000), ...x }))); return arr; };
  window.SFX_LOG = stamped(); window.EVENTS = stamped();
  window.__advance = ms => {
    const target = now + ms;
    for (;;) {                                   // fire timers in order up to the target time
      let next = null;
      for (const [id, t] of timers) if (t.at <= target && (!next || t.at < next[1].at)) next = [id, t];
      if (!next) break;
      const [id, t] = next; now = Math.max(now, t.at);
      if (t.every) t.at += t.every; else timers.delete(id);
      try { t.cb(...t.x); } catch (e) { console.error(e); }
    }
    now = target;
    if (window.attract) try { window.attract((now - window.__rec0) / 1000); } catch (e) { console.error(e); }
    const cbs = [...raf.values()]; raf.clear();
    for (const cb of cbs) try { cb(now); } catch (e) { console.error(e); }
  };
  if (${a.audio ? 'true' : 'false'} && window.OfflineAudioContext) {
    // Web Audio on the virtual clock: each AudioContext is an OfflineAudioContext whose currentTime is the virtual
    // time, rendered after the last frame (see --audio in capture.mjs).
    const Off = window.OfflineAudioContext; window.__audioCtxs = [];
    class RecordedAudioContext extends Off {
      constructor(o = {}) {
        const sr = (o && o.sampleRate) || 48000;
        super({ numberOfChannels: 2, length: Math.ceil(${AUDIO_SECONDS} * sr), sampleRate: sr });
        this.__closed = false; window.__audioCtxs.push(this);
      }
      get currentTime() { return now / 1000; }
      get state() { return this.__closed ? 'closed' : 'running'; }
      get baseLatency() { return 0; }
      get outputLatency() { return 0; }
      getOutputTimestamp() { return { contextTime: now / 1000, performanceTime: now }; }
      resume() { return Promise.resolve(); }
      suspend() { return Promise.resolve(); }
      close() { this.__closed = true; return Promise.resolve(); }
      createMediaElementSource() { throw new Error('capture.mjs --audio: media elements are not recorded; log them as cues'); }
      createMediaStreamSource() { throw new Error('capture.mjs --audio: media streams are not recorded'); }
      createMediaStreamDestination() { throw new Error('capture.mjs --audio: media streams are not recorded'); }
    }
    window.AudioContext = window.webkitAudioContext = RecordedAudioContext;
    // render every context, keep [from, from + dur) seconds, mix to stereo 16-bit at 48 kHz, return base64 PCM
    window.__renderAudio = async (from, dur) => {
      const SR = 48000, n = Math.round(dur * SR), L = new Float32Array(n), R = new Float32Array(n);
      for (const ctx of window.__audioCtxs) {
        const buf = await Off.prototype.startRendering.call(ctx), k = buf.sampleRate / SR;
        const l = buf.getChannelData(0), r = buf.numberOfChannels > 1 ? buf.getChannelData(1) : l;
        for (let i = 0; i < n; i++) {                      // linear resample when the page chose another rate
          const x = (from * SR + i) * k, j = Math.floor(x), f = x - j;
          if (j + 1 >= l.length) break;
          L[i] += l[j] + (l[j + 1] - l[j]) * f; R[i] += r[j] + (r[j + 1] - r[j]) * f;
        }
      }
      const pcm = new Int16Array(n * 2);
      for (let i = 0; i < n; i++) { pcm[2 * i] = Math.max(-1, Math.min(1, L[i])) * 32767; pcm[2 * i + 1] = Math.max(-1, Math.min(1, R[i])) * 32767; }
      const bytes = new Uint8Array(pcm.buffer); let bin = '';
      for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
      return { contexts: window.__audioCtxs.length, b64: btoa(bin) };
    };
  }
})();`;

const { chromium } = await loadPlaywright();
const b = await chromium.launch(launchOptions(a));
const ctx = await b.newContext({ viewport: { width: W, height: H } });
await ctx.addInitScript(VIRTUAL_CLOCK);
const p = await ctx.newPage();
let pageErrors = 0;
p.on('pageerror', e => { pageErrors++; console.error('PAGE ERROR', e.message); });
p.on('console', m => { if (m.type() === 'error' && !/favicon|404/.test(m.text())) { pageErrors++; console.error('CONSOLE', m.text()); } });
await p.goto(a.url, { waitUntil: 'load' });
await p.evaluate(() => document.fonts && document.fonts.ready);
// let the page boot on the virtual clock (a few frames of setup, not recorded)
for (let i = 0; i < BOOT; i++) await p.evaluate(ms => window.__advance(ms), 1000 / FPS);
await p.evaluate(() => {
  window.__rec0 = performance.now();
  for (const log of [window.SFX_LOG, window.EVENTS]) for (const c of log) c.t = 0;   // boot-time marks land at t=0
});
if (a.cursor) await p.evaluate(() => {
  const c = document.createElement('div');
  c.style.cssText = 'position:fixed;left:0;top:0;width:28px;height:40px;pointer-events:none;z-index:2147483647;transform-origin:0 0;' +
    'background:url("data:image/svg+xml;utf8,<svg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 28 40%22><path d=%22M2 2 L2 32 L10 25 L16 38 L22 35 L16 22 L26 22 Z%22 fill=%22black%22 stroke=%22white%22 stroke-width=%222.5%22 stroke-linejoin=%22round%22/></svg>") no-repeat';
  document.body.appendChild(c);
  addEventListener('mousemove', e => { c.style.transform = `translate(${e.clientX}px,${e.clientY}px)`; }, true);
  addEventListener('mousedown', () => { c.style.scale = '0.85'; }, true); addEventListener('mouseup', () => { c.style.scale = '1'; }, true);
});

const vf = SUB > 1 ? ['-vf', `tmix=frames=${SUB},select='eq(mod(n\\,${SUB})\\,${SUB - 1})',setpts=N/${FPS}/TB`, '-r', String(FPS)] : [];
const ff = spawn(findFfmpeg(), ['-y', '-loglevel', 'error', '-f', 'image2pipe', '-framerate', String(FPS * SUB), '-c:v', 'mjpeg', '-i', '-',
  ...vf, '-c:v', 'libx264', '-preset', 'slow', '-crf', '17', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', a.out], { stdio: ['pipe', 'ignore', 'inherit'] });

const held = new Map(); // key -> release time
let ai = 0; const glides = [];
const N = Math.round(DUR * FPS), step = 1000 / FPS / SUB; const t0 = Date.now();
for (let i = 0; i < N * SUB; i++) {
  const t = i * step / 1000;
  while (ai < actions.length && actions[ai].t <= t) {
    const x = actions[ai++];
    if (x.type === 'click') await p.mouse.click(x.x, x.y);
    else if (x.type === 'down') { await p.mouse.move(x.x, x.y); await p.mouse.down(); }
    else if (x.type === 'up') await p.mouse.up();
    else if (x.type === 'move') { await p.mouse.move(x.x, x.y); if (x.down) await p.mouse.down(); if (x.to) glides.push({ ...x, t0: x.t }); }
    else if (x.type === 'key') { await p.keyboard.down(x.key); held.set(x.key, t + (x.hold || 0.08)); }
    else if (x.type === 'type') await p.keyboard.type(x.text);
    else if (x.type === 'eval') await p.evaluate(x.js);
  }
  for (const g of glides.splice(0)) {
    const k = Math.min(1, (t - g.t0) / (g.d || 0.5)), e = k * k * (3 - 2 * k);
    await p.mouse.move(g.x + (g.to[0] - g.x) * e, g.y + (g.to[1] - g.y) * e);
    if (k < 1) glides.push(g); else if (g.down) await p.mouse.up();
  }
  for (const [k, until] of held) if (t >= until) { await p.keyboard.up(k); held.delete(k); }
  await p.evaluate(ms => window.__advance(ms), step);
  const buf = await p.screenshot({ type: 'jpeg', quality: 92 });
  if (!ff.stdin.write(buf)) await new Promise(r => ff.stdin.once('drain', r));
  if (i % (300 * SUB) === 0) console.error(`frame ${Math.floor(i / SUB)}/${N}  ${((Date.now() - t0) / 1000).toFixed(0)}s`);
}
ff.stdin.end();
const code = await new Promise(r => ff.on('close', r));
if (a.cues) {
  const cues = await p.evaluate(() => window.SFX_LOG.map(c => ({ g: 0.5, p: 1, pan: 0, d: 0, ...c })));
  writeFileSync(a.cues, JSON.stringify({ dur: DUR, cues }, null, 1));
  console.error(`${cues.length} sound cues -> ${a.cues}`);
}
if (a.events) {
  const ev = await p.evaluate(() => window.EVENTS.slice());
  writeFileSync(a.events, JSON.stringify({ dur: DUR, events: ev }, null, 1));
  console.error(`${ev.length} events -> ${a.events}`);
}
if (a.audio) {
  const rec0 = await p.evaluate(() => window.__rec0 / 1000);
  const r = await p.evaluate(([f, d]) => window.__renderAudio ? window.__renderAudio(f, d) : null, [rec0, DUR]);
  if (!r) console.error('--audio: this browser has no OfflineAudioContext; nothing recorded');
  else {
    const pcm = Buffer.from(r.b64, 'base64'), hdr = Buffer.alloc(44);
    hdr.write('RIFF', 0); hdr.writeUInt32LE(36 + pcm.length, 4); hdr.write('WAVEfmt ', 8); hdr.writeUInt32LE(16, 16);
    hdr.writeUInt16LE(1, 20); hdr.writeUInt16LE(2, 22); hdr.writeUInt32LE(48000, 24); hdr.writeUInt32LE(48000 * 4, 28);
    hdr.writeUInt16LE(4, 32); hdr.writeUInt16LE(16, 34); hdr.write('data', 36); hdr.writeUInt32LE(pcm.length, 40);
    writeFileSync(a.audio, Buffer.concat([hdr, pcm]));
    let peak = 0; for (let i = 0; i < pcm.length; i += 2) peak = Math.max(peak, Math.abs(pcm.readInt16LE(i)));
    console.error(`Web Audio -> ${a.audio}  ${DUR}s from ${r.contexts} AudioContext${r.contexts === 1 ? '' : 's'}, peak ${(peak / 32767).toFixed(2)}` +
      (r.contexts === 0 ? '  (the page made none: does it wait for a tap? add a click to --actions)' : peak === 0 ? '  (silent)' : ''));
  }
}
await b.close();
if (pageErrors) console.error(`${pageErrors} page error${pageErrors === 1 ? '' : 's'} during the capture (listed above)`);
if (code !== 0) { console.error('ffmpeg exited with', code); process.exit(code); }
console.error(`done ${a.out}  ${N} frames, ${DUR}s @ ${W}x${H} ${FPS}fps (virtual clock, seed ${SEED})`);
