// Shared helpers: find a Chromium binary and an ffmpeg binary without downloading anything.
import { existsSync, readdirSync } from 'node:fs';
import { execSync } from 'node:child_process';
import path from 'node:path';

export function findChrome() {
  if (process.env.CHROME && existsSync(process.env.CHROME)) return process.env.CHROME;
  const home = process.env.HOME || '';
  const roots = [process.env.PLAYWRIGHT_BROWSERS_PATH, '/opt/pw-browsers', path.join(home, '.cache/ms-playwright'),
    path.join(home, 'Library/Caches/ms-playwright'), process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'ms-playwright')].filter(Boolean);
  for (const root of roots) {
    if (!existsSync(root)) continue;
    // Prefer the full chromium build; headless_shell also works.
    const dirs = readdirSync(root).filter(d => /^chromium/.test(d)).sort().reverse();
    for (const d of dirs) {
      for (const rel of ['chrome-linux/chrome', 'chrome-linux64/chrome', 'chrome-headless-shell-linux64/chrome-headless-shell',
        'chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
        'chrome-mac/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
        'chrome-mac/Chromium.app/Contents/MacOS/Chromium',
        'chrome-headless-shell-mac-arm64/chrome-headless-shell', 'chrome-headless-shell-mac-x64/chrome-headless-shell',
        'chrome-win/chrome.exe', 'chrome-win64/chrome.exe', 'chrome']) {
        const p = path.join(root, d, rel);
        if (existsSync(p)) return p;
      }
    }
  }
  return undefined; // let Playwright use its own default
}

export function findFfmpeg() {
  if (process.env.FFMPEG && existsSync(process.env.FFMPEG)) return process.env.FFMPEG;
  try { const p = execSync('command -v ffmpeg', { encoding: 'utf8' }).trim(); if (p) return p; } catch {}
  try {
    return execSync(`python3 -c "import imageio_ffmpeg;print(imageio_ffmpeg.get_ffmpeg_exe())"`, { encoding: 'utf8' }).trim();
  } catch {}
  throw new Error('ffmpeg not found. Run: pip install imageio-ffmpeg   (or set FFMPEG=/path/to/ffmpeg)');
}

const BOOL = new Set(['sheet', 'grid', 'webgl', 'loop-check', 'no-scene-whoosh', 'headed']);
export function args() {
  const out = {}; const a = process.argv.slice(2);
  for (let i = 0; i < a.length; i++) {
    if (a[i].startsWith('--')) { const k = a[i].slice(2); const v = !BOOL.has(k) && a[i + 1] && !a[i + 1].startsWith('--') ? a[++i] : true; out[k] = v; }
    else (out._ ||= []).push(a[i]);
  }
  return out;
}

export async function loadPlaywright() {
  // Node resolves bare imports relative to THIS file, so also try the caller's working directory
  // (e.g. the product repo, which usually has playwright in its node_modules).
  // Playwright is CommonJS: imported by file path, its exports can land under `default` only, so normalize.
  const norm = m => (m.chromium ? m : m.default);
  try { return norm(await import('playwright')); } catch {}
  // The engine's own node_modules (after `npm install` in the engine folder, see setup.sh).
  try {
    const { createRequire } = await import('node:module');
    const { pathToFileURL, fileURLToPath } = await import('node:url');
    const req = createRequire(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'noop.js'));
    return norm(await import(pathToFileURL(req.resolve('playwright')).href));
  } catch {}
  try {
    const { createRequire } = await import('node:module');
    const { pathToFileURL } = await import('node:url');
    const req = createRequire(path.join(process.cwd(), 'noop.js'));
    return norm(await import(pathToFileURL(req.resolve('playwright')).href));
  } catch {}
  throw new Error("Can't find 'playwright'. Run `bash setup.sh` in the engine folder once (it installs playwright next to these scripts).");
}

// Chromium flags. --webgl turns on a software GL path so three.js / WebGL pages render headless on any machine
// (slower than a GPU, but identical everywhere, which is what a frame-by-frame render needs).
export function launchOptions(a = {}) {
  const flags = ['--hide-scrollbars', '--mute-audio', '--font-render-hinting=none', '--force-color-profile=srgb'];
  if (a.webgl) flags.push('--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist');
  return { executablePath: findChrome(), args: flags, headless: !a.headed };
}

// Open a composition at t=0 and wait until it says it is ready (window.__ready === true).
export async function openComposition(b, a, W, H) {
  const p = await b.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: +(a.scale || 1) });
  p.on('pageerror', e => console.error('PAGE ERROR', e.message));
  p.on('console', m => { if (m.type() === 'error' && !/favicon|404/.test(m.text())) console.error('CONSOLE', m.text()); });
  await p.goto(a.url + (a.url.includes('?') ? '&' : '?') + 't=0');
  await p.waitForFunction(() => window.__ready === true, null, { timeout: 120000 });
  await p.evaluate(() => document.fonts && document.fonts.ready);
  await p.waitForTimeout(300);
  return p;
}
