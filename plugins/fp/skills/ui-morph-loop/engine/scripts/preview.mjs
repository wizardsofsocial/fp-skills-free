// Render still frames at chosen timestamps (and an optional contact sheet) to check a composition before the full render.
//
//   node preview.mjs --url http://127.0.0.1:8765/index.html --dir prev [--w 1920 --h 1080] [--sheet | --grid] [--webgl] 5.5 9.5 22 31
//   node preview.mjs --url ... --dir prev --grid --every 0.5          # one still per beat at 120 BPM, as a grid
//
// --sheet  one horizontal strip.  --grid  rows of 4 (better for 12+ frames, e.g. one per beat), each tile labelled
// with its time.  --every s  samples the whole composition every s seconds instead of listing times.
//
// Look at every frame you render. It's the cheapest place to catch overlaps, bad wraps and mistimed reveals.
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { args, loadPlaywright, launchOptions, openComposition } from './_common.mjs';

const a = args();
const times = (a._ || []).map(Number);
if (!a.url || !a.dir || (!times.length && !a.every)) { console.error('usage: node preview.mjs --url <page> --dir <outdir> [--w --h] [--sheet|--grid] [--every s] t1 t2 ...'); process.exit(1); }
const W = +(a.w || 1920), H = +(a.h || 1080);
mkdirSync(a.dir, { recursive: true });
const { chromium } = await loadPlaywright();
const b = await chromium.launch(launchOptions(a));
const p = await openComposition(b, a, W, H);
if (a.every) { const D = await p.evaluate(() => window.DURATION); for (let t = 0; t < D - 1e-6; t += +a.every) times.push(+t.toFixed(3)); }
const files = [];
for (const t of times) {
  await p.evaluate(t => window.seek(t), t);
  const f = path.join(a.dir, `f_${t}.jpg`);
  await p.screenshot({ path: f, type: 'jpeg', quality: 80 });
  files.push(f);
}

// Contact sheets are composed in the browser, so they need nothing beyond what's already running.
async function compose(name, cols) {
  const tw = W >= H ? (cols === files.length ? 640 : 480) : (cols === files.length ? 360 : 270), th = Math.round(tw * H / W);
  const rows = Math.ceil(files.length / cols);
  const imgs = files.map(f => readFileSync(f).toString('base64'));
  const pg = await b.newPage();
  const data = await pg.evaluate(async ({ imgs, times, cols, rows, tw, th }) => {
    const c = document.createElement('canvas'); c.width = cols * tw; c.height = rows * th; const g = c.getContext('2d');
    g.fillStyle = '#000'; g.fillRect(0, 0, c.width, c.height);
    for (let i = 0; i < imgs.length; i++) {
      const im = new Image(); im.src = 'data:image/jpeg;base64,' + imgs[i]; await im.decode();
      const x = (i % cols) * tw, y = Math.floor(i / cols) * th;
      g.drawImage(im, x, y, tw, th);
      g.font = 'bold 18px system-ui, sans-serif'; const label = times[i] + 's'; const lw = g.measureText(label).width;
      g.fillStyle = 'rgba(0,0,0,.65)'; g.fillRect(x + 6, y + 6, lw + 12, 26); g.fillStyle = '#fff'; g.fillText(label, x + 12, y + 25);
      g.strokeStyle = 'rgba(255,255,255,.25)'; g.strokeRect(x + 0.5, y + 0.5, tw - 1, th - 1);
    }
    return c.toDataURL('image/jpeg', 0.85).split(',')[1];
  }, { imgs, times, cols, rows, tw, th });
  const out = path.join(a.dir, name); writeFileSync(out, Buffer.from(data, 'base64')); await pg.close();
  return out;
}
if (a.sheet && files.length > 1) console.log(await compose('sheet.jpg', files.length));
if (a.grid && files.length > 1) console.log(await compose('grid.jpg', Math.min(4, files.length)));
await b.close();
console.log(files.join('\n'));
