// Render a seek(t) composition to MP4, frame by frame.
//
//   node render.mjs --url http://127.0.0.1:8765/index.html --out video.mp4
//        [--w 1920 --h 1080 --fps 30 --from 0 --to <DURATION>] [--subframes 4] [--webgl] [--loop-check] [--crf 17]
//
// The page must define window.seek(t) (it may return a promise), window.DURATION, and set window.__ready = true once
// assets are loaded. Every frame is a pure function of t, so the output is identical on any machine.
//
// --subframes N   real motion blur: renders N sub-steps inside each frame and averages them (ffmpeg tmix). 4 is a good
//                 default for UI motion, 6-8 for fast whips and camera moves. Render time grows N times.
// --webgl         software GL so three.js / WebGL scenes render headless (see launchOptions in _common.mjs).
// --loop-check    for loops: also renders t = DURATION and fails if it doesn't match frame 0 (a visible seam).
//
// Hard cuts and motion blur: if the page sets window.CUTS = [t, ...] (times of hard cuts), sub-frames never reach
// back across a cut, so the first frame after a cut is sharp instead of a ghost of the previous shot.
import { spawn } from 'node:child_process';
import { findFfmpeg, args, loadPlaywright, launchOptions, openComposition } from './_common.mjs';

const a = args();
if (!a.url || !a.out) { console.error('usage: node render.mjs --url <page url> --out <file.mp4> [--w 1920 --h 1080 --fps 30 --from s --to s --subframes N --webgl --loop-check]'); process.exit(1); }
const W = +(a.w || 1920), H = +(a.h || 1080), FPS = +(a.fps || 30), SUB = Math.max(1, +(a.subframes || 1));
const { chromium } = await loadPlaywright();
const b = await chromium.launch(launchOptions(a));
const p = await openComposition(b, a, W, H);
const D = await p.evaluate(() => window.DURATION);
const CUTS = (await p.evaluate(() => window.CUTS || [])).map(Number).sort((x, y) => x - y);
const lastCut = t => { let c = -Infinity; for (const x of CUTS) if (x <= t + 1e-9) c = x; return c; };
const from = +(a.from || 0), to = +(a.to || D);

// With subframes, ffmpeg receives FPS*SUB frames per second, averages each group of SUB and keeps one per group.
const vf = SUB > 1 ? ['-vf', `tmix=frames=${SUB},select='eq(mod(n\\,${SUB})\\,${SUB - 1})',setpts=N/${FPS}/TB`, '-r', String(FPS)] : [];
const ff = spawn(findFfmpeg(), ['-y', '-loglevel', 'error', '-f', 'image2pipe', '-framerate', String(FPS * SUB), '-c:v', 'mjpeg', '-i', '-',
  ...vf, '-c:v', 'libx264', '-preset', 'slow', '-crf', String(a.crf || 17), '-pix_fmt', 'yuv420p', '-movflags', '+faststart', a.out],
  { stdio: ['pipe', 'ignore', 'inherit'] });

const shot = async t => { await p.evaluate(t => window.seek(t), t); return p.screenshot({ type: 'jpeg', quality: 95 }); };
const N = Math.round((to - from) * FPS); const t0 = Date.now();
for (let i = 0; i < N; i++) {
  for (let s = 0; s < SUB; s++) {
    // Sub-steps sit just before the frame time, so frame i still lands exactly on t = i/FPS (counters stay honest).
    const tf = from + i / FPS, t = from + (i - (SUB - 1 - s) / SUB) / FPS;
    const buf = await shot(Math.max(from, lastCut(tf), t));
    if (!ff.stdin.write(buf)) await new Promise(r => ff.stdin.once('drain', r));
  }
  if (i % 300 === 0) console.error(`frame ${i}/${N}  ${((Date.now() - t0) / 1000).toFixed(0)}s`);
}
ff.stdin.end();
const code = await new Promise(r => ff.on('close', r));

let seam = 0;
if (a['loop-check']) {
  // Compare the first frame with the frame one step past the end, pixel by pixel, in the browser.
  const [f0, f1] = [await shot(0), await shot(D)];
  seam = await p.evaluate(async ([x, y]) => {
    const load = s => new Promise(r => { const im = new Image(); im.onload = () => r(im); im.src = 'data:image/jpeg;base64,' + s; });
    const [i0, i1] = await Promise.all([load(x), load(y)]);
    const c = new OffscreenCanvas(i0.width, i0.height), g = c.getContext('2d');
    g.drawImage(i0, 0, 0); const d0 = g.getImageData(0, 0, c.width, c.height).data;
    g.drawImage(i1, 0, 0); const d1 = g.getImageData(0, 0, c.width, c.height).data;
    let bad = 0; for (let k = 0; k < d0.length; k += 4) if (Math.abs(d0[k] - d1[k]) + Math.abs(d0[k + 1] - d1[k + 1]) + Math.abs(d0[k + 2] - d1[k + 2]) > 24) bad++;
    return bad / (d0.length / 4);
  }, [f0.toString('base64'), f1.toString('base64')]);
}
await b.close();
if (code !== 0) { console.error('ffmpeg exited with', code); process.exit(code); }
console.error(`done ${a.out}  ${N} frames${SUB > 1 ? ` x${SUB} subframes` : ''}, ${(to - from).toFixed(1)}s @ ${W}x${H} ${FPS}fps`);
if (a['loop-check']) {
  const pct = (seam * 100).toFixed(2);
  if (seam > 0.001) { console.error(`LOOP SEAM: ${pct}% of pixels differ between t=0 and t=DURATION. Make the last state equal the first.`); process.exit(3); }
  console.error(`loop ok: t=0 and t=DURATION match (${pct}% differ)`);
}
