// Readiness gate for the app-demo recorder: a scene is only recorded once the
// live page is truly ready, and never while it shows a broken state.
//
// waitUntilReady(page, scene, opts) polls the page until all of these hold, or
// the time runs out:
// - the document has loaded, on the app origin, past any login page (a login
//   path, or a visible password field, asks the caller to stop the run);
// - every entry of `show` (default scene.mustShow) is visible on screen and not
//   cut at the viewport edge. Plain entries are text; "css=..." is a selector;
// - no visible spinner, skeleton or busy marker; no visible error text;
// - fonts loaded, images on screen loaded (a broken image is a problem);
// - no failed same-origin request since the tracker was last reset;
// - no content clipped inside an overflow-hidden box, and the page is not
//   wider than the viewport;
// - no DOM change and no same-origin request in flight for settleMs (400 ms);
// - no uncaught page error (pageerror) since the tracker was last reset;
// - when opts.theme is set, the page background matches it. The recorder sets
//   it at the start gate only: a dialog opened by an action may dim the page.
//   The background is sampled at nine points on a 3x3 grid (under each point,
//   the first layer whose background alpha times its opacity is at least 0.5,
//   skipping translucent full-viewport fixed overlays (alpha times opacity
//   under 0.9, such as modal backdrops); then the root or body background;
//   then white) and the median relative luminance (0 black, 1 white)
//   must be at most 0.35 for "dark" and at least 0.55 for "light". Between the
//   two the page is neither clearly light nor clearly dark, and fails both.
//
// console.error messages never fail readiness; they come back as warnings.
//
// Returns { ok, problems, warnings, stop? }. `stop` is set when the page is a login page
// or off the app origin: the caller stops the whole run, it does not retake.

import { checkNavigation, isLoginRedirect } from './guard.mjs';

export const SPINNER_SELECTORS = [
  '[aria-busy="true"]', '[role="progressbar"]', '.spinner', '.loading', '.loader', '.skeleton',
  '[class*="skeleton" i]', '[class*="spinner" i]', '[class*="shimmer" i]',
  '[data-testid*="spinner" i]', '[data-testid*="skeleton" i]', '[data-testid*="loading" i]', '[data-loading="true"]',
];

export const ERROR_TEXT = /something went wrong|went wrong|unexpected error|internal server error|\berror\s*(?:code\s*)?[45]\d\d\b|\b(?:404|500|502|503)\b[^.\n]{0,20}\b(?:error|not found)\b|page not found|failed to load|could not load|couldn'?t load|unable to load|try again later|an error occurred|application error/i;

const READ_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Watches the page's network so readiness can see failed and in-flight
// same-origin requests. Call reset() before each navigation or action.
// `sends` lists every same-origin request since the reset whose method is not
// GET, HEAD or OPTIONS (a fetch, a beacon or a form post), as { method, path }
// with the path only, never the query: the recorder stops a read-only click
// that caused one.
export function trackRequests(page, origin) {
  let base;
  try { base = new URL(origin).origin; } catch { base = null; }
  const sameOrigin = (u) => { try { return new URL(u).origin === base; } catch { return false; } };
  const ignore = (u) => /\/favicon\.ico(?:$|\?)/.test(u);
  const inflight = new Map();
  const t = {
    failures: [],
    pageErrors: [],
    consoleErrors: [],
    lastActivity: Date.now(),
    sends: [],
    reset() { t.failures = []; t.pageErrors = []; t.consoleErrors = []; t.sends = []; },
    pending() {
      const now = Date.now();
      // A request open for over 5 s is a long poll or stream, not page loading.
      return [...inflight.values()].filter((start) => now - start < 5000).length;
    },
  };
  page.on('request', (req) => {
    if (!sameOrigin(req.url())) return;
    const method = req.method().toUpperCase();
    if (!READ_METHODS.has(method)) t.sends.push({ method, path: new URL(req.url()).pathname });
    if (['websocket', 'eventsource'].includes(req.resourceType())) return;
    inflight.set(req, Date.now()); t.lastActivity = Date.now();
  });
  const done = (req) => { if (inflight.delete(req)) t.lastActivity = Date.now(); };
  page.on('requestfinished', done);
  page.on('requestfailed', (req) => {
    done(req);
    const err = req.failure()?.errorText || 'failed';
    // A request cut short by a navigation is not a broken page.
    if (!sameOrigin(req.url()) || ignore(req.url()) || /ERR_ABORTED/.test(err)) return;
    t.failures.push(`${new URL(req.url()).pathname} (${err})`);
  });
  page.on('pageerror', (err) => { t.pageErrors.push(String(err?.message || err).split('\n')[0].slice(0, 160)); });
  page.on('console', (msg) => { if (msg.type() === 'error') t.consoleErrors.push(msg.text().split('\n')[0].slice(0, 160)); });
  page.on('response', (res) => {
    const u = res.url();
    if (!sameOrigin(u) || ignore(u) || res.status() < 400) return;
    t.failures.push(`${new URL(u).pathname} returned ${res.status()}`);
  });
  return t;
}

// Runs in the page. Everything it reports is about what a viewer would see.
function inspect({ show, spinners, errorSource, allowPassword, theme }) {
  const W = innerWidth; const H = innerHeight;
  const visible = (el) => {
    if (!el || !el.isConnected) return false;
    if (el.checkVisibility && !el.checkVisibility({ opacityProperty: true, visibilityProperty: true })) return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0 && r.right > 0 && r.bottom > 0 && r.left < W && r.top < H;
  };
  const label = (el) => {
    const id = el.id ? `#${el.id}` : '';
    const cls = typeof el.className === 'string' && el.className.trim() ? `.${el.className.trim().split(/\s+/).slice(0, 2).join('.')}` : '';
    return `<${el.tagName.toLowerCase()}${id}${cls}>`;
  };
  const out = {
    url: location.href, readyState: document.readyState, fonts: document.fonts ? document.fonts.status : 'loaded',
    problems: [], waiting: [], password: false, lastMutation: window.__fpReadyLastMutation || 0, now: performance.now(),
  };
  if (!window.__fpReadyObserver && document.documentElement) {
    window.__fpReadyLastMutation = performance.now();
    window.__fpReadyObserver = new MutationObserver((list) => {
      // The recorder's own cursor moves are not the page changing.
      if (list.every((m) => m.target.closest?.('#__fp_cursor') || m.target.id === '__fp_cursor')) return;
      window.__fpReadyLastMutation = performance.now();
    });
    window.__fpReadyObserver.observe(document.documentElement, { subtree: true, childList: true, attributes: true, characterData: true });
    out.lastMutation = window.__fpReadyLastMutation;
  }
  if (!document.body) { out.waiting.push('the page has no body yet'); return out; }

  out.password = !allowPassword && [...document.querySelectorAll('input[type="password"]')].some(visible);

  const text = document.body.innerText || '';
  const lower = text.toLowerCase();
  for (const want of show) {
    if (want.startsWith('css=')) {
      const sel = want.slice(4);
      let els = [];
      try { els = [...document.querySelectorAll(sel)]; } catch { out.problems.push(`mustShow selector "${sel}" is not valid CSS`); continue; }
      const el = els.find(visible);
      if (!el) { out.waiting.push(`"${sel}" is not visible`); continue; }
      const r = el.getBoundingClientRect();
      if (r.left < -1 || r.top < -1 || r.right > W + 1 || r.bottom > H + 1) out.waiting.push(`"${sel}" is cut off at the viewport edge`);
      continue;
    }
    if (!lower.includes(want.toLowerCase())) { out.waiting.push(`"${want}" is not visible`); continue; }
    // Find the text on screen to check it is inside the viewport.
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    let rect = null; let node;
    while ((node = walker.nextNode())) {
      const i = node.data.toLowerCase().indexOf(want.toLowerCase());
      if (i < 0 || !visible(node.parentElement)) continue;
      const range = document.createRange();
      range.setStart(node, i); range.setEnd(node, i + want.length);
      rect = range.getBoundingClientRect();
      break;
    }
    if (rect && (rect.left < -1 || rect.top < -1 || rect.right > W + 1 || rect.bottom > H + 1)) {
      out.waiting.push(rect.top >= H || rect.bottom <= 0 || rect.left >= W || rect.right <= 0
        ? `"${want}" is off screen` : `"${want}" is cut off at the viewport edge`);
    }
  }

  const spin = [];
  for (const sel of spinners) {
    let els = [];
    try { els = [...document.querySelectorAll(sel)]; } catch { continue; }
    for (const el of els) if (visible(el) && el.id !== '__fp_cursor') spin.push(label(el));
  }
  if (spin.length) out.waiting.push(`a loading indicator is visible: ${[...new Set(spin)].slice(0, 3).join(', ')}`);

  const errorRe = new RegExp(errorSource, 'i');
  const err = text.match(errorRe);
  if (err) {
    const line = text.split('\n').find((l) => errorRe.test(l)) || err[0];
    out.waiting.push(`error text is visible: "${line.trim().slice(0, 100)}"`);
  }

  for (const img of document.images) {
    if (!visible(img)) continue;
    if (!img.complete) out.waiting.push(`an image is still loading: ${img.currentSrc || img.src}`.slice(0, 140));
    else if (img.naturalWidth === 0) out.waiting.push(`an image failed to load${img.alt ? ` ("${img.alt}")` : ''}`);
  }

  if (theme) {
    const lum = [];
    const parse = (c) => { const m = c.match(/rgba?\(([^)]+)\)/); if (!m) return null; const v = m[1].split(/[\s,/]+/).filter(Boolean).map(Number); return { r: v[0], g: v[1], b: v[2], a: v.length > 3 ? v[3] : 1 }; };
    const lin = (c) => { const x = c / 255; return x <= 0.04045 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4; };
    for (const fx of [1 / 6, 1 / 2, 5 / 6]) {
      for (const fy of [1 / 6, 1 / 2, 5 / 6]) {
        // Every layer under the point, top first. Full-viewport fixed overlays
        // (modal backdrops, cookie banners' scrims) are skipped, and an
        // element's opacity (with its ancestors') scales its background alpha,
        // so a half-transparent black scrim never reads as a black page.
        let c = null;
        for (const el of document.elementsFromPoint(W * fx, H * fy)) {
          if (el.id === '__fp_cursor' || el.closest('#__fp_cursor')) continue;
          const cs = getComputedStyle(el);
          const r = el.getBoundingClientRect();
          const p = parse(cs.backgroundColor);
          if (!p) continue;
          let op = 1;
          for (let e = el; e; e = e.parentElement) op *= Number(getComputedStyle(e).opacity);
          // A translucent full-viewport fixed layer is a backdrop over the page;
          // an opaque one (an app shell, a background layer) is the page.
          if (cs.position === 'fixed' && r.width >= W * 0.9 && r.height >= H * 0.9 && p.a * op < 0.9) continue;
          if (p.a * op >= 0.5) { c = p; break; }
        }
        // Nothing opaque under the point: the canvas shows the root background,
        // or the body's when the root has none (CSS background propagation).
        if (!c) {
          const opaque = (e) => { const p = e && parse(getComputedStyle(e).backgroundColor); return p && p.a >= 0.5 ? p : null; };
          c = opaque(document.documentElement) || opaque(document.body) || { r: 255, g: 255, b: 255 };
        }
        lum.push(0.2126 * lin(c.r) + 0.7152 * lin(c.g) + 0.0722 * lin(c.b));
      }
    }
    lum.sort((a, b) => a - b);
    const med = lum[4];
    if (theme === 'dark' && med > 0.35) out.problems.push(`the page looks light (background luminance ${med.toFixed(2)}) but the plan asks for the dark theme`);
    if (theme === 'light' && med < 0.55) out.problems.push(`the page looks dark (background luminance ${med.toFixed(2)}) but the plan asks for the light theme`);
  }

  if (document.documentElement.scrollWidth > W + 1) {
    out.waiting.push(`the page is ${document.documentElement.scrollWidth - W}px wider than the viewport, so content is cut off at the right edge`);
  }
  // Boxes that hide part of a child: the "cut-off panel".
  const all = document.body.getElementsByTagName('*');
  for (let i = 0; i < all.length && i < 6000; i++) {
    const el = all[i];
    const cs = getComputedStyle(el);
    const clipX = /hidden|clip/.test(cs.overflowX); const clipY = /hidden|clip/.test(cs.overflowY);
    if (!clipX && !clipY) continue;
    if (cs.textOverflow === 'ellipsis' || !visible(el)) continue;
    const overX = clipX && el.clientWidth >= 120 && el.scrollWidth > el.clientWidth + 8;
    const overY = clipY && el.clientHeight >= 120 && el.scrollHeight > el.clientHeight + 8;
    if (!overX && !overY) continue;
    const box = el.getBoundingClientRect();
    const cut = [...el.children].some((c) => {
      const r = c.getBoundingClientRect();
      return (c.innerText || '').trim() && ((overX && r.right > box.right + 8) || (overY && r.bottom > box.bottom + 8));
    });
    if (cut) out.waiting.push(`content is cut off inside ${label(el)} (${overX ? `${el.scrollWidth - el.clientWidth}px hidden on the right` : `${el.scrollHeight - el.clientHeight}px hidden at the bottom`})`);
  }
  return out;
}

export async function waitUntilReady(page, scene, opts = {}) {
  const {
    origin, loginPaths, tracker, timeoutMs = 15000, settleMs = 400, pollMs = 200, loginGraceMs = 1000,
    spinnerSelectors = [], errorText, theme,
  } = opts;
  const warnings = () => (tracker?.consoleErrors.length ? [...new Set(tracker.consoleErrors)].slice(0, 5).map((m) => `console error: ${m}`) : []);
  const show = (opts.show ?? scene?.mustShow ?? []).filter((s) => typeof s === 'string' && s.trim());
  const spinners = [...SPINNER_SELECTORS, ...spinnerSelectors];
  const errorSource = errorText ? `(?:${ERROR_TEXT.source})|(?:${errorText})` : ERROR_TEXT.source;
  const allowPassword = scene?.allowPasswordField === true;
  const deadline = Date.now() + timeoutMs;
  let loginSince = null;
  let problems = ['the page never reported its state'];

  for (;;) {
    let s;
    const url = page.url();
    const nav = origin ? checkNavigation(url, origin) : { ok: true };
    if (!nav.ok) return { ok: false, problems: [nav.reason], warnings: warnings(), stop: nav.reason };
    try {
      s = await page.evaluate(inspect, { show, spinners, errorSource, allowPassword, theme });
    } catch (e) {
      // The page navigated mid-check: look again.
      s = null;
      problems = [`the page could not be inspected (${String(e.message).split('\n')[0]})`];
    }
    if (s) {
      const login = isLoginRedirect(s.url, loginPaths) || s.password;
      if (login) {
        loginSince ??= Date.now();
        const why = isLoginRedirect(s.url, loginPaths)
          ? `The page went to the login page (${new URL(s.url).pathname}): the saved session has expired. Log in again with the login command.`
          : 'A login form (a password field) is showing instead of the app: the saved session has expired. Log in again with the login command.';
        if (Date.now() - loginSince >= loginGraceMs || Date.now() >= deadline) return { ok: false, problems: [why], warnings: warnings(), stop: why };
      } else {
        loginSince = null;
      }
      problems = [...s.problems, ...s.waiting];
      if (s.readyState !== 'complete') problems.push('the page is still loading');
      if (s.fonts !== 'loaded') problems.push('fonts are still loading');
      if (tracker?.failures.length) problems.push(...[...new Set(tracker.failures)].map((f) => `a request failed: ${f}`));
      if (tracker?.pageErrors.length) problems.push(...[...new Set(tracker.pageErrors)].map((m) => `the page threw an error: ${m}`));
      if (login) problems.push('waiting to see if the login page is only a passing redirect');
      if (!problems.length) {
        const quietFor = Math.min(s.now - s.lastMutation, tracker ? Date.now() - tracker.lastActivity : Infinity);
        if (quietFor >= settleMs && !(tracker?.pending() > 0)) return { ok: true, problems: [], warnings: warnings() };
        problems = [`the page did not settle (it kept changing or loading for the last ${Math.round(timeoutMs / 1000)} s)`];
      }
    }
    if (Date.now() >= deadline) return { ok: false, problems, warnings: warnings() };
    await sleep(pollMs);
  }
}
