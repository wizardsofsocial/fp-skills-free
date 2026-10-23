// Collect the sound-effect cues of a seek(t) composition into cues.json for sfx.py.
//
//   node cues.mjs --url http://127.0.0.1:8765/index.html --out cues.json [--seg 3.2-6.2 --seg 15.4-20.9 ...] [--no-scene-whoosh]
//
// Where cues come from, in order of precedence:
//   1. window.cues()  - a composition that computes its own list (e.g. one with several cuts remapped in time) returns
//                       [{t, type, g, p, pan, d}] in output seconds, and nothing else below is read.
//   2. [data-sfx]     - any element with data-sfx="pop|tick|boom|..." sounds at its data-in time (or data-cin for a
//                       counter, or data-sfx-at if given). Optional data-sfx-g (gain 0..1), data-sfx-p (pitch),
//                       data-sfx-pan (-1..1), data-sfx-d (length, for riser/swell/roll).
//   3. window.SFX     - an array of extra cues for things with no element of their own (a riser into the drop,
//                       diagram nodes as they draw): [{t, type, g, p, pan, d}].
//   4. scene changes  - a soft whoosh at every window.SCENES start after 0, unless --no-scene-whoosh.
//
// --seg (repeatable, same values you give cutdown.py) keeps only cues inside those composition ranges and shifts them
// into the reel's time, so a 15s reel gets exactly the sounds of the moments it shows.
import { writeFileSync } from 'node:fs';
import { args, loadPlaywright, launchOptions } from './_common.mjs';

const a = args();
if (!a.url || !a.out) { console.error('usage: node cues.mjs --url <page> --out cues.json [--seg a-b ...] [--no-scene-whoosh]'); process.exit(1); }
// args() keeps only the last --seg, so read every one straight from argv
const allSegs = process.argv.flatMap((v, i, arr) => v === '--seg' ? [arr[i + 1].split('-').map(Number)] : []);

const { chromium } = await loadPlaywright();
const b = await chromium.launch(launchOptions(a));
const p = await b.newPage({ viewport: { width: +(a.w || 1920), height: +(a.h || 1080) } });  // --w/--h: match the render size
await p.goto(a.url);
await p.waitForFunction(() => window.__ready === true || window.ready === true, null, { timeout: 60000 });
const res = await p.evaluate((noScene) => {
  const num = (v, d) => (v === undefined || v === '' ? d : +v);
  if (typeof window.cues === 'function') return { dur: window.DURATION, cues: window.cues(), source: 'window.cues()' };
  const out = [];
  document.querySelectorAll('[data-sfx]').forEach(el => {
    const d = el.dataset;
    const t = num(d.sfxAt, num(d.cin, num(d.in, NaN)));
    if (Number.isNaN(t)) return;
    out.push({ t, type: d.sfx, g: num(d.sfxG, 0.5), p: num(d.sfxP, 1), pan: num(d.sfxPan, 0), d: num(d.sfxD, d.sfx === 'roll' ? 1.4 : 0) });
  });
  (window.SFX || []).forEach(c => out.push({ g: 0.5, p: 1, pan: 0, d: 0, ...c }));
  if (!noScene && window.SCENES) Object.values(window.SCENES).filter(s => s > 0).forEach(s => out.push({ t: s, type: 'whoosh', g: 0.45, p: 1, pan: 0, d: 0 }));
  return { dur: window.DURATION, cues: out, source: 'data-sfx + window.SFX' + (noScene ? '' : ' + scene whooshes') };
}, !!a['no-scene-whoosh']);
await b.close();

let { dur, cues } = res;
if (allSegs.length) {
  let at = 0; const kept = [];
  for (const [lo, hi] of allSegs) {
    cues.filter(c => c.t >= lo - 0.02 && c.t < hi).forEach(c => kept.push({ ...c, t: Math.max(0, c.t - lo) + at, d: c.d ? Math.min(c.d, hi - c.t) : 0 }));
    at += hi - lo;
  }
  cues = kept; dur = at;
}
cues.sort((x, y) => x.t - y.t);
writeFileSync(a.out, JSON.stringify({ dur, cues }, null, 1));
const byType = cues.reduce((m, c) => (m[c.type] = (m[c.type] || 0) + 1, m), {});
console.log(`${a.out}: ${cues.length} cues over ${(+dur).toFixed(1)}s from ${res.source}${allSegs.length ? `, ${allSegs.length} segments` : ''}: ` +
  Object.entries(byType).map(([k, v]) => `${k}×${v}`).join(' '));
