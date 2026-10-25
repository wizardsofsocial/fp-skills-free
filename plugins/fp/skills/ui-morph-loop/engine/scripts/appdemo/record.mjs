#!/usr/bin/env node
// Real-time recorder for app walkthroughs. Drives a live, logged-in web app
// scene by scene with a visible cursor and records each scene as its own clip.
//
//   node record.mjs --plan plan.json --config capture.json --out run/ [--retake] [--scenes id1,id2]
//   node record.mjs login --config capture.json
//
// Writes run/scenes/NN-id.webm (VP9, 3840x2160, 30 fps: see the sharpness
// spike), run/events.json ([{ scene, tMs, type, x, y, rect, context? }] in CSS
// pixels of the 1920x1080 viewport; context is the row, list item or form
// around the control, when there is one; tMs from the start of that scene's
// clip; a navigate event, with x, y and rect null, marks each page change while a
// scene records),
// run/ledger.json, run/privacy.json (masked values only), run/report.json and
// run/failures/NN-id.png for every scene that failed.
//
// Order of safety: the plan is validated and approved and the ledger checked
// before any browser opens. Each scene must pass the readiness gate before it
// records. Every click, keystroke and landed URL goes through guard.mjs. A
// deny-listed control, a credential field, a login page or a page off the app
// origin stops the whole run. The tool never types or sees a password: the
// session comes from the buyer's own login (the login command).
//
// Every click is checked twice: before the cursor moves and again at the real
// point right before the click. A failed read-only scene is retaken in the run
// (at most twice); a scene that changes data is not. --scenes limits a rerun.
// The plan's theme (light or dark) is emulated and checked on screen.
//
// Exit codes: 0 every scene recorded; 1 a scene failed or the run stopped;
// 2 refused before recording (plan, approval, ledger, config or session).

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadPlaywright, launchOptions, args as parseArgs } from '../_common.mjs';
import { buildDeny, checkClick, checkType, checkNavigation, isLoginRedirect } from './guard.mjs';
import {
  PlanError, validatePlan, requireApproval, planTake, loadLedger, saveLedger, recordAttempt, isWriteAction, allowedPost, planChanges, recordPlan,
} from './plan.mjs';
import { waitUntilReady, trackRequests } from './ready.mjs';

export const VIEWPORT = Object.freeze({ width: 1920, height: 1080 });

export class RecordError extends Error {
  constructor(message) { super(message); this.name = 'RecordError'; }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, Math.max(0, ms)));
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const round = (n) => Math.round(n * 10) / 10;

// ---------------------------------------------------------------- browser

// Headless Chromium only captures at 2x when the scale is forced at launch;
// a context deviceScaleFactor alone gives a 1x picture (see the spike doc).
export async function launchBrowser({ scale = 2, headed = false } = {}) {
  const { chromium } = await loadPlaywright();
  const base = launchOptions({ headed });
  try {
    if (headed) {
      // The headless shell cannot open a window; use Playwright's own Chromium
      // (the exact build this Playwright version expects, which setup.sh installs).
      return await chromium.launch({ ...base, executablePath: undefined });
    }
    return await chromium.launch({ ...base, args: [...base.args, `--force-device-scale-factor=${scale}`] });
  } catch (e) {
    throw missingBrowser(e, headed) || e;
  }
}

const ENGINE_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

// Playwright's own error for a missing browser is a long boxed notice. Turn it
// into one plain step; any other launch error is returned as null (rethrown as is).
export function missingBrowser(e, headed = false) {
  const msg = String(e?.message || e || '');
  // Missing system libraries (the install-deps notice) is a different problem: pass it through.
  if (/install-deps|missing dependencies/i.test(msg)) return null;
  if (!/Executable doesn't exist|npx playwright install(?![-\w])/i.test(msg)) return null;
  const which = headed ? 'the Chromium build this Playwright version needs to open the login window' : 'a Chromium to record with';
  return new RecordError(`Chromium is missing: ${which} is not installed. Run once: bash "${path.join(ENGINE_DIR, 'setup.sh')}" (it downloads the right build), then run this command again.`);
}

// ---------------------------------------------------------------- framing data (R38)

export const FRAME_LINES_MAX = 400;

// Runs in the page, on the control. Returns, in CSS pixels of the viewport:
//   block: the table, grid, form, list or section the control sits in, or the card around it (a bordered or shadowed
//          box) when that holds it closely, as { x, y, width, height }; null when there is none smaller than the page;
//   lines: [x, y, width, height] of each visible text line (one per line of a text node) and each control, image or
//          icon on screen, nearest the control first, at most max of them;
//   panes: [x, y, width, height] of each sidebar or navigation column (aside, nav) at least 40% of the page tall.
// The 9:16 camera keeps a whole block in frame when it fits, and moves its band edges off text lines.
export function frameLayout(el, { max = 400 } = {}) {
  const W = window.innerWidth, H = window.innerHeight;
  const R = (r) => [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)];
  const onScreen = (r) => r.width >= 2 && r.height >= 2 && r.right > 0 && r.bottom > 0 && r.x < W && r.y < H;
  const shown = (e) => { const cs = getComputedStyle(e); return cs.visibility !== 'hidden' && cs.display !== 'none' && Number(cs.opacity) > 0.05; };
  const tb = el.getBoundingClientRect();
  const page = W * H;
  const area = (r) => r.width * r.height;
  const fitsPage = (r) => area(r) < page * 0.85 && r.width > 0 && r.height > 0;
  const isCard = (e) => {
    const cs = getComputedStyle(e);
    const border = ['Top', 'Right', 'Bottom', 'Left'].every((s) => parseFloat(cs[`border${s}Width`]) > 0 && cs[`border${s}Style`] !== 'none');
    return cs.boxShadow !== 'none' || (border && parseFloat(cs.borderTopLeftRadius) > 0);
  };
  let block = el.closest('table,[role=table],[role=grid],form,ul,ol,section');
  if (block && !fitsPage(block.getBoundingClientRect())) block = null;
  let card = null;
  for (let e = el.parentElement; e && e !== document.body; e = e.parentElement) {
    if (!fitsPage(e.getBoundingClientRect())) break;
    if (isCard(e)) { card = e; break; }
  }
  if (card && (!block || (card.contains(block) && area(card.getBoundingClientRect()) <= area(block.getBoundingClientRect()) * 1.6))) block = card;
  let b = block ? block.getBoundingClientRect() : null;
  if (b && (b.width <= tb.width + 1 && b.height <= tb.height + 1)) b = null;
  const lines = [];
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  const range = document.createRange();
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    if (!n.nodeValue.trim() || !n.parentElement || !shown(n.parentElement)) continue;
    if (n.parentElement.closest('script,style,noscript,option,template,[hidden],[aria-hidden=true]')) continue;
    range.selectNodeContents(n);
    for (const r of range.getClientRects()) if (onScreen(r)) lines.push(r);
  }
  for (const e of document.querySelectorAll('input:not([type=hidden]),select,textarea,button,img,svg,video,canvas,[role=img]')) {
    if (e.closest('svg') && e.tagName.toLowerCase() !== 'svg') continue;
    const r = e.getBoundingClientRect();
    if (onScreen(r) && shown(e)) lines.push(r);
  }
  const cx = tb.x + tb.width / 2, cy = tb.y + tb.height / 2;
  const dist = (r) => Math.hypot(Math.max(r.x - cx, 0, cx - r.right), Math.max(r.y - cy, 0, cy - r.bottom));
  lines.sort((a, c) => dist(a) - dist(c));
  const panes = [];
  for (const e of document.querySelectorAll('aside,nav,[role=navigation],[role=complementary]')) {
    const r = e.getBoundingClientRect();
    if (onScreen(r) && shown(e) && r.height >= H * 0.4 && r.width < W * 0.5) panes.push(R(r));
  }
  return { block: b ? { x: Math.round(b.x), y: Math.round(b.y), width: Math.round(b.width), height: Math.round(b.height) } : null, lines: lines.slice(0, max).map(R), panes };
}

// ---------------------------------------------------------------- guard helpers

// Where the page actually landed (after redirects). Returns a stop reason or null.
export function landedProblem(url, origin, loginPaths) {
  const nav = checkNavigation(url, origin);
  if (!nav.ok) return nav.reason;
  if (isLoginRedirect(url, loginPaths)) {
    return `The page went to the login page (${new URL(url).pathname}): the saved session has expired. Log in again with the login command.`;
  }
  return null;
}

// Runs in the page. Describes the element (and, given a point, whatever would
// really receive a click there) in the shape guard.mjs reads: every piece of
// text a person or screen reader could read on the control.
function describeTargets(el, point) {
  const clean = (s) => String(s || '').replace(/\s+/g, ' ').trim();
  const childText = (node) => {
    const out = [];
    for (const c of node.childNodes) {
      if (c.nodeType === 3) { out.push(c.data); continue; }
      if (c.nodeType !== 1) continue;
      const tag = c.tagName.toLowerCase();
      if (tag === 'script' || tag === 'style' || c.id === '__fp_cursor') continue;
      if (tag === 'img' || (tag === 'input' && c.type === 'image')) out.push(c.getAttribute('alt') || '');
      if (tag === 'svg') {
        for (const t of c.querySelectorAll('title, desc')) out.push(t.textContent);
      } else {
        out.push(childText(c));
      }
      for (const a of ['aria-label', 'title']) if (c.getAttribute(a)) out.push(c.getAttribute(a));
    }
    return out.join(' ');
  };
  const describe = (e) => {
    const tag = e.tagName.toLowerCase();
    const labels = e.labels ? [...e.labels].map((l) => childText(l)).join(' ') : '';
    const own = tag === 'img' ? e.getAttribute('alt') : '';
    const ids = (e.getAttribute('aria-labelledby') || '').split(/\s+/).filter(Boolean);
    const isField = tag === 'input' || tag === 'textarea' || tag === 'select';
    return {
      tag,
      text: clean([labels, own, isField ? '' : childText(e)].join(' ')),
      ariaLabel: clean(e.getAttribute('aria-label')),
      ariaLabelledByText: clean(ids.map((id) => document.getElementById(id)?.textContent || '').join(' ')),
      placeholder: clean(e.getAttribute('placeholder')),
      title: clean(e.getAttribute('title')),
      // A field's own value is what is about to be replaced; a button's value is its label.
      value: tag === 'input' && /^(submit|button|reset|image)$/i.test(e.type) ? clean(e.value) : (tag === 'button' ? clean(e.value) : ''),
      autocomplete: clean(e.getAttribute('autocomplete')),
      type: clean(e.getAttribute('type') || (tag === 'button' ? 'submit' : '')),
    };
  };
  const INTERACTIVE = 'a,button,input,select,textarea,label,summary,option,[role=button],[role=link],[role=menuitem],[role=tab],[role=checkbox],[role=switch],[role=option],[onclick]';
  const found = [el];
  const up = el.closest?.(INTERACTIVE);
  if (up) found.push(up);
  if (point) {
    const hit = document.elementFromPoint(point.x, point.y);
    if (hit && hit.id !== '__fp_cursor') {
      found.push(hit);
      const hitUp = hit.closest(INTERACTIVE);
      if (hitUp) found.push(hitUp);
    }
  }
  return [...new Set(found)].map(describe);
}

export async function describeElement(locator) {
  return (await locator.evaluate(describeTargets, null))[0];
}

// Runs in the page: the control that would submit this field's form.
function submitControlOf(el) {
  const form = el.form || el.closest('form');
  if (!form) return { form: false };
  const btn = form.querySelector('button[type=submit], input[type=submit], input[type=image], button:not([type])');
  return { form: true, found: Boolean(btn) };
}

// ---------------------------------------------------------------- privacy

export function maskEmail(email) {
  const [local, domain = ''] = String(email).split('@');
  const parts = domain.split('.');
  const tld = parts.length > 1 ? parts.pop() : '';
  return `${local.slice(0, 1)}***@${domain.slice(0, 1)}***${tld ? `.${tld}` : ''}`;
}

const EMAIL_RE = /[A-Z0-9._%+-]+@[A-Z0-9-]+(?:\.[A-Z0-9-]+)*\.[A-Z]{2,}/gi;
const PHONE_RE = /(?<![\w+])(?:\+\d{1,3}[\s.-]?)?(?:\(\d{1,4}\)[\s.-]?)?\d{2,4}(?:[\s.-]\d{2,4}){1,3}(?![\w])/g;

// Text seen on screen, scanned for emails, phone numbers and the buyer's own
// patterns. Only masked values come back; raw values are never kept.
export function scanPrivacy(text, patterns = []) {
  const s = String(text ?? '');
  const emails = new Set(); const phones = new Set(); const matches = new Set();
  for (const m of s.match(EMAIL_RE) || []) emails.add(maskEmail(m));
  const noEmails = s.replace(EMAIL_RE, ' ');
  for (const m of noEmails.match(PHONE_RE) || []) {
    const digits = m.replace(/\D/g, '');
    if (digits.length < 9 || digits.length > 15) continue;
    if (/^\d{4}[-./]\d{1,2}[-./]\d{1,2}$/.test(m.trim())) continue;
    let left = digits.length - 2;
    phones.add(m.trim().replace(/\d/g, (d) => (left-- > 0 ? '*' : d)));
  }
  for (const p of patterns) {
    let re;
    try { re = new RegExp(p, 'gi'); } catch { continue; }
    for (const m of noEmails.match(re) || []) if (m) matches.add(`${m.slice(0, 1)}***`);
  }
  return { emails: [...emails].sort(), phones: [...phones].sort(), matches: [...matches].sort() };
}

// ---------------------------------------------------------------- cursor

// Init script: a drawn pointer that survives navigation (its position is kept in
// sessionStorage) and glides along a gently curved, eased path.
export function cursorInit() {
  if (window.top !== window || window.__fpCursor) return;
  const KEY = '__fpCursor';
  let pos = null;
  try { pos = JSON.parse(sessionStorage.getItem(KEY)); } catch { pos = null; }
  if (!pos || !Number.isFinite(pos.x) || !Number.isFinite(pos.y)) pos = { x: Math.round(innerWidth * 0.5), y: Math.round(innerHeight * 0.6) };
  const save = () => { try { sessionStorage.setItem(KEY, JSON.stringify(pos)); } catch { /* opaque origin */ } };
  const SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="26" height="34" viewBox="0 0 26 34"><path d="M2 2 L2 27 L8.5 21 L13 31.5 L17.5 29.5 L13 19.5 L22 19.5 Z" fill="#111" stroke="#fff" stroke-width="2" stroke-linejoin="round"/></svg>';
  let el = null;
  const place = () => { if (el) el.style.transform = `translate(${pos.x - 2}px, ${pos.y - 2}px)`; };
  const mount = () => {
    if (!document.documentElement || (el && el.isConnected)) return;
    el = document.createElement('div');
    el.id = '__fp_cursor';
    el.setAttribute('aria-hidden', 'true');
    el.style.cssText = 'position:fixed;left:0;top:0;width:26px;height:34px;z-index:2147483647;pointer-events:none;will-change:transform;filter:drop-shadow(0 1px 2px rgba(0,0,0,.35));';
    el.innerHTML = SVG;
    place();
    document.documentElement.appendChild(el);
  };
  const keep = () => {
    mount();
    new MutationObserver(() => { if (!el || !el.isConnected) mount(); }).observe(document.documentElement, { childList: true });
  };
  if (document.documentElement) keep();
  document.addEventListener('DOMContentLoaded', keep, { once: true });
  const ease = (t) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2);
  let flip = 1;
  window.__fpCursor = {
    move(x, y, ms) {
      mount();
      const sx = pos.x; const sy = pos.y; const dx = x - sx; const dy = y - sy;
      const dist = Math.hypot(dx, dy) || 1;
      flip = -flip;
      const bend = Math.min(70, dist * 0.1) * flip;
      const cx = sx + dx / 2 - (dy / dist) * bend; const cy = sy + dy / 2 + (dx / dist) * bend;
      return new Promise((resolve) => {
        const t0 = performance.now();
        const step = (now) => {
          const t = Math.min(1, (now - t0) / Math.max(1, ms));
          const e = ease(t); const u = 1 - e;
          pos = { x: u * u * sx + 2 * u * e * cx + e * e * x, y: u * u * sy + 2 * u * e * cy + e * e * y };
          place();
          if (t < 1) requestAnimationFrame(step);
          else { pos = { x, y }; place(); save(); resolve(); }
        };
        requestAnimationFrame(step);
      });
    },
    click() {
      mount();
      if (!el) return;
      const ring = document.createElement('div');
      ring.style.cssText = 'position:absolute;left:2px;top:2px;width:44px;height:44px;margin:-22px 0 0 -22px;border-radius:50%;border:3px solid rgba(37,99,235,.85);box-sizing:border-box;pointer-events:none;';
      el.appendChild(ring);
      ring.animate([{ transform: 'scale(.3)', opacity: 1 }, { transform: 'scale(1.25)', opacity: 0 }], { duration: 450, easing: 'ease-out' }).onfinish = () => ring.remove();
      el.firstElementChild?.animate([{ transform: 'scale(1)' }, { transform: 'scale(.85)' }, { transform: 'scale(1)' }], { duration: 180 });
    },
  };
}

// ---------------------------------------------------------------- config

export function normalizeConfig(config, plan, configDir = process.cwd()) {
  if (!isObj(config)) throw new RecordError('The capture config must be a JSON object.');
  const planOrigin = new URL(plan.origin).origin;
  if (config.origin !== undefined) {
    let o;
    try { o = new URL(config.origin).origin; } catch { throw new RecordError(`capture config origin "${config.origin}" is not a valid URL.`); }
    if (o !== planOrigin) throw new RecordError(`capture config origin ${o} does not match the plan origin ${planOrigin}.`);
  }
  const num = (v, def, lo, hi, name) => {
    if (v === undefined) return def;
    if (typeof v !== 'number' || !Number.isFinite(v) || v < lo || v > hi) throw new RecordError(`capture config ${name} must be a number from ${lo} to ${hi}.`);
    return v;
  };
  const ready = isObj(config.ready) ? config.ready : {};
  const privacy = isObj(config.privacy) ? config.privacy : {};
  return {
    origin: planOrigin,
    storageState: path.resolve(configDir, config.storageState || '.fp-app-demo/session.json'),
    loginPaths: Array.isArray(config.loginPaths) ? config.loginPaths : undefined,
    scale: num(config.scale, 2, 1, 3, 'scale'),
    fps: num(config.fps, 30, 10, 60, 'fps'),
    pace: num(config.pace, 1, 0.05, 4, 'pace'),
    // A failed start gate is retried by reloading the page, at most twice.
    retries: Math.floor(num(config.retries, 2, 0, 2, 'retries')),
    ready: {
      timeoutMs: num(ready.timeoutMs, 15000, 500, 120000, 'ready.timeoutMs'),
      settleMs: num(ready.settleMs, 400, 100, 5000, 'ready.settleMs'),
      spinnerSelectors: Array.isArray(ready.spinnerSelectors) ? ready.spinnerSelectors.filter((s) => typeof s === 'string') : [],
      errorText: typeof ready.errorText === 'string' && ready.errorText.trim() ? ready.errorText : undefined,
    },
    privacyPatterns: Array.isArray(privacy.patterns) ? privacy.patterns.filter((p) => typeof p === 'string' && p) : [],
  };
}

// ---------------------------------------------------------------- files

function writeJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`);
  fs.renameSync(tmp, file);
}

function clearDir(dir, re) {
  if (!fs.existsSync(dir)) return;
  for (const f of fs.readdirSync(dir)) if (re.test(f)) fs.rmSync(path.join(dir, f), { force: true });
}

// ---------------------------------------------------------------- recording

const ACTIONS_THAT_TOUCH = new Set(['click', 'type', 'select', 'check', 'uncheck']);

// What must be visible before recording starts. A scene that only looks gets
// its mustShow checked up front; a scene that clicks or types reaches its
// mustShow at the end, so it can name readyShow for the start.
function startShow(scene) {
  if (Array.isArray(scene.readyShow)) return scene.readyShow;
  return scene.actions.some((a) => ACTIONS_THAT_TOUCH.has(a.type)) ? [] : scene.mustShow;
}

function verifyShow(scene) {
  const out = []; const bad = [];
  for (const v of scene.verify || []) {
    if (typeof v.text === 'string' && v.text.trim()) out.push(v.text);
    else if (typeof v.selector === 'string' && v.selector.trim()) out.push(`css=${v.selector}`);
    else bad.push(`a verify entry has neither text nor selector: ${JSON.stringify(v)}`);
  }
  return { out, bad };
}

class SceneStop extends Error {}
class SceneFail extends Error {}

// Finds the control an action names. A selector is used as given. A name is
// matched exactly first (buttons, links, labels, placeholders, then text, in
// that order). Only when nothing matches exactly may a partial match be used,
// and only when it picks out exactly one control: "Save" never quietly clicks
// "Save and send invoice" next to "Save draft".
async function resolveTarget(page, action, timeoutMs) {
  const t = typeof action.target === 'string' ? action.target : '';
  if (!action.selector && !t.trim()) throw new SceneFail(`a ${action.type} action needs a target (visible text or label) or a selector.`);
  const kinds = (exact) => [page.getByRole('button', { name: t, exact }), page.getByRole('link', { name: t, exact }), page.getByLabel(t, { exact }),
    page.getByPlaceholder(t, { exact }), page.getByRole('checkbox', { name: t, exact }), page.getByRole('tab', { name: t, exact }),
    page.getByRole('menuitem', { name: t, exact }), page.getByText(t, { exact })];
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (action.selector) {
      const v = page.locator(action.selector).filter({ visible: true }).first();
      if (await v.count().catch(() => 0)) return v;
    } else {
      for (const c of kinds(true)) {
        const v = c.filter({ visible: true });
        if (await v.count().catch(() => 0)) return v.first();
      }
      const any = kinds(false).reduce((a, b) => a.or(b)).filter({ visible: true });
      // A control and the text inside it count once.
      const found = await any.evaluateAll((els) => els.filter((e) => !els.some((o) => o !== e && o.contains(e)))
        .map((e) => (e.innerText || e.value || e.getAttribute('aria-label') || e.getAttribute('placeholder') || '').replace(/\s+/g, ' ').trim().slice(0, 60))).catch(() => []);
      if (found.length === 1) {
        // One control: take it through the most specific kind (the field, not its label).
        for (const c of kinds(false)) {
          const v = c.filter({ visible: true });
          if (await v.count().catch(() => 0)) return v.first();
        }
      }
      if (found.length > 1) {
        throw new SceneFail(`"${t}" matches nothing exactly and ${found.length} controls partly: ${found.slice(0, 5).map((f) => `"${f}"`).join(', ')}. Use the exact text or a selector.`);
      }
    }
    if (Date.now() >= deadline) throw new SceneFail(`could not find "${action.selector || t}" on the page.`);
    await sleep(150);
  }
}

function makeScene(ctx, scene) {
  const { page, cfg, deny, t0Ref, events, state } = ctx;
  const P = (ms) => ms * cfg.pace;
  const ev = (type, x, y, rect, context) => {
    events.push({ scene: scene.id, tMs: Math.max(0, Math.round(Date.now() - t0Ref.t0)), type, x: round(x), y: round(y), rect, ...(context ? { context } : {}) });
  };
  const ready = async (show, extra = {}) => {
    const r = await waitUntilReady(page, scene, { ...ctx.readyOpts, ...extra, show });
    for (const w of r.warnings || []) ctx.warnings.add(w);
    return r;
  };

  async function onScreen(loc) {
    let box = await loc.boundingBox();
    if (!box) throw new SceneFail('the target has no size on screen.');
    const inView = box.y >= 0 && box.x >= 0 && box.y + box.height <= VIEWPORT.height && box.x + box.width <= VIEWPORT.width;
    if (!inView) {
      await loc.evaluate((el) => el.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'smooth' }));
      await sleep(Math.max(300, P(800)));
      box = await loc.boundingBox();
      if (!box) throw new SceneFail('the target has no size on screen.');
    }
    const rect = { x: round(box.x), y: round(box.y), width: round(box.width), height: round(box.height) };
    // The row, list item, form or header the control sits in: the camera frames that, so a zoom does not slice a table.
    const c = await loc.evaluate((el) => {
      const r = el.closest('tr,[role=row],li,[role=listitem],form,fieldset,header')?.getBoundingClientRect();
      return r ? { x: r.x, y: r.y, width: r.width, height: r.height } : null;
    }).catch(() => null);
    const context = c && c.width > 0 && c.height > 0 && (c.width > box.width + 1 || c.height > box.height + 1)
      ? { x: round(c.x), y: round(c.y), width: round(c.width), height: round(c.height) } : null;
    // What the 9:16 camera needs to frame without slicing text (R38), kept on the rect so an event's keys stay
    // [scene, tMs, type, x, y, rect] (+ context): rect.block, rect.lines and rect.panes (see frameLayout).
    const layout = await loc.evaluate(frameLayout, { max: FRAME_LINES_MAX }).catch(() => null);
    if (layout?.block) rect.block = layout.block;
    if (layout?.lines?.length) rect.lines = layout.lines;
    if (layout?.panes?.length) rect.panes = layout.panes;
    return { rect, context, x: box.x + box.width / 2, y: box.y + box.height / 2 };
  }

  async function glide(to) {
    const dist = Math.hypot(to.x - state.cursor.x, to.y - state.cursor.y);
    const ms = Math.max(120, P(Math.min(1300, Math.max(500, 420 + dist * 0.45))));
    ev('move', to.x, to.y, to.rect, to.context);
    if (ctx.cursor) await page.evaluate(([x, y, d]) => window.__fpCursor?.move(x, y, d), [to.x, to.y, ms]).catch(() => sleep(ms));
    else await sleep(ms);
    await page.mouse.move(to.x, to.y);
    state.cursor = { x: to.x, y: to.y };
    ev('hover', to.x, to.y, to.rect, to.context);
  }

  async function clickAt(to) {
    ev('click', to.x, to.y, to.rect, to.context);
    if (ctx.cursor) await page.evaluate(() => window.__fpCursor?.click()).catch(() => {});
    await page.mouse.click(to.x, to.y);
  }

  // Checks the control and whatever would really receive a click at the point.
  // Returns a signature of what was checked, to compare just before the click.
  async function guardClick(loc, to) {
    const descs = await loc.evaluate(describeTargets, { x: to.x, y: to.y });
    for (const d of descs) {
      const r = checkClick(d, deny);
      if (!r.ok) throw new SceneStop(r.reason);
    }
    return JSON.stringify(descs);
  }

  // Right before the click: the glide and the hover beat may have opened a menu
  // or overlay, or moved the control. Check again at the real point.
  async function recheck(loc, to, before) {
    // A redirect may have landed during the glide and the hover beat; the same
    // control at the same spot on another host must never be clicked.
    await checkpoint();
    const box = await loc.boundingBox().catch(() => null);
    if (!box) throw new SceneFail('the target disappeared before the click.');
    const now = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
    if (Math.abs(now.x - to.x) > 4 || Math.abs(now.y - to.y) > 4) throw new SceneFail('the target moved between the cursor arriving and the click.');
    const sig = await guardClick(loc, to);
    if (sig !== before) throw new SceneStop('The control under the cursor changed between the check and the click (a hover may have opened a menu or overlay), so the click is refused.');
  }

  // Before every action: the page must still be on the app and logged in.
  async function checkpoint() {
    if (state.navStop) throw new SceneStop(state.navStop);
    const why = landedProblem(page.url(), cfg.origin, cfg.loginPaths);
    if (why) throw new SceneStop(why);
  }

  async function landed() {
    if (state.navStop) throw new SceneStop(state.navStop);
    const why = landedProblem(page.url(), cfg.origin, cfg.loginPaths);
    if (why && !isLoginRedirect(page.url(), cfg.loginPaths)) throw new SceneStop(why);
  }

  // After a click or submit: let any navigation land, check where it landed,
  // wait for the result to be ready, then pause on it so the viewer can read it.
  async function afterAction(navBefore) {
    const until = Date.now() + 600;
    while (state.navCount === navBefore && Date.now() < until) await sleep(50);
    await page.waitForLoadState('load').catch(() => {});
    await landed();
    const r = await ready([]);
    if (r.stop) throw new SceneStop(r.stop);
    if (!r.ok) throw new SceneFail(`after the action: ${r.problems.join('; ')}`);
    await scan();
    await sleep(P(900));
  }

  async function scan() {
    const text = await page.evaluate(() => document.body?.innerText || '').catch(() => '');
    const r = scanPrivacy(text, cfg.privacyPatterns);
    for (const k of ['emails', 'phones', 'matches']) for (const v of r[k]) ctx.privacy[k].add(v);
  }

  // Enter submits. It is allowed only when the field's form has a submit
  // control that passes the click guard, or the action names the control Enter
  // triggers (submitTarget) and it passes. Anything else is refused.
  async function guardEnter(loc, action, { beforePress = false } = {}) {
    if (beforePress) {
      // Typing may have moved focus or opened a suggestion list; Enter then acts
      // on that, not on the form. Check what Enter would really pick.
      const f = await loc.evaluate((el) => {
        const a = document.activeElement;
        const clean = (t) => String(t || '').replace(/\s+/g, ' ').trim();
        const id = a?.getAttribute?.('aria-activedescendant');
        const active = id ? document.getElementById(id) : null;
        const listOpen = a?.getAttribute?.('aria-expanded') === 'true';
        const picked = active || (listOpen ? [...document.querySelectorAll('[role="option"][aria-selected="true"]')].find((o) => o.checkVisibility?.() ?? true) : null);
        return { same: a === el, picked: picked ? clean(picked.innerText || picked.textContent || picked.getAttribute('aria-label')) : null };
      });
      if (!f.same) throw new SceneStop('Enter refused: focus moved away from the field while typing, so Enter would act on something that was not checked.');
      if (f.picked !== null) {
        const r = checkClick({ text: f.picked }, deny);
        if (!r.ok) throw new SceneStop(`Enter refused: it would pick the highlighted suggestion "${f.picked}". ${r.reason}`);
      }
    }
    const s = await loc.evaluate(submitControlOf);
    if (s.form) {
      if (!s.found) throw new SceneStop('Enter refused: the form has no submit control whose text can be checked.');
      const btn = loc.locator('xpath=ancestor::form[1]').locator('button[type=submit], input[type=submit], input[type=image], button:not([type])').first();
      const r = checkClick(await describeElement(btn), deny);
      if (!r.ok) throw new SceneStop(`Enter refused: it would submit the form. ${r.reason}`);
    }
    if (typeof action.submitTarget === 'string') {
      const st = action.submitTarget.trim();
      const target = await resolveTarget(page, st.startsWith('css=') ? { type: 'submit', selector: st.slice(4) } : { type: 'submit', target: st }, 5000);
      for (const d of await target.evaluate(describeTargets, null)) {
        const r = checkClick(d, deny);
        if (!r.ok) throw new SceneStop(`Enter refused: it would trigger "${st}". ${r.reason}`);
      }
    } else if (!s.form) {
      throw new SceneStop('Enter refused: the field is not in a form, so there is no submit control to check. Name the control Enter triggers with submitTarget.');
    }
  }

  // After a click marked readOnly: true, until the next action starts: any
  // same-origin request that is not a plain read (a fetch POST, a form post, a
  // beacon) means the click may have changed data. That stops the scene; it is
  // never retaken.
  let watching = false;
  function readOnlyCheck() {
    if (!watching) return;
    const allow = ctx.plan.safety?.allowPostPaths || [];
    const sent = ctx.tracker.sends.find((x) => !allowedPost(x.path, allow));
    if (sent) {
      watching = false;
      throw new SceneStop(`After a click marked readOnly: true, the app sent ${sent.method} ${sent.path} to its own origin, so the click may have changed data. `
        + 'Declare that click as a write: remove readOnly: true, add write: "<id>" and a writes entry the user approves. '
        + 'If that request is harmless (analytics, say), the user can list its path in safety.allowPostPaths instead.');
    }
  }

  async function run(action) {
    // The previous action's read-only window ends where this one begins.
    readOnlyCheck();
    watching = false;
    switch (action.type) {
      case 'wait': return sleep(P(Number.isFinite(action.ms) ? action.ms : 1000));
      case 'waitFor': await resolveTarget(page, action, action.timeoutMs ?? 10000); return undefined;
      case 'scroll': {
        if (action.target || action.selector) {
          const loc = await resolveTarget(page, action, 5000);
          await loc.evaluate((el) => el.scrollIntoView({ block: 'center', behavior: 'smooth' }));
        } else {
          await page.evaluate((y) => window.scrollBy({ top: y, behavior: 'smooth' }), Number.isFinite(action.y) ? action.y : 600);
        }
        await sleep(Math.max(300, P(900)));
        return scan();
      }
      case 'hover': {
        const loc = await resolveTarget(page, action, 5000);
        await glide(await onScreen(loc));
        return sleep(P(900));
      }
      case 'click': case 'check': case 'uncheck': {
        const loc = await resolveTarget(page, action, 5000);
        const to = await onScreen(loc);
        const sig = await guardClick(loc, to);
        if (action.type !== 'click') {
          const checked = await loc.isChecked().catch(() => null);
          if (checked === (action.type === 'check')) { await glide(to); return sleep(P(600)); }
        }
        await glide(to);
        await sleep(P(350));
        await recheck(loc, to, sig);
        const navBefore = state.navCount;
        ctx.tracker.reset();
        watching = action.type === 'click' && action.readOnly === true;
        await clickAt(to);
        try {
          await afterAction(navBefore);
        } finally {
          // A data-changing request wins over whatever else went wrong after the click.
          readOnlyCheck();
        }
        return undefined;
      }
      case 'select': {
        const loc = await resolveTarget(page, action, 5000);
        const to = await onScreen(loc);
        const value = String(action.value ?? '');
        // The option that will really be chosen, and its visible label.
        const opt = await loc.evaluate((el, v) => {
          const opts = [...(el.options || [])];
          let i = opts.findIndex((o) => o.label.trim() === v.trim());
          if (i < 0) i = opts.findIndex((o) => o.value === v);
          return i < 0 ? null : { index: i, label: opts[i].label };
        }, value);
        if (!opt) throw new SceneFail(`the list has no option "${value}".`);
        const t = checkType(await describeElement(loc), opt.label, deny);
        if (!t.ok) throw new SceneStop(t.reason);
        const c = checkClick({ text: opt.label }, deny);
        if (!c.ok) throw new SceneStop(c.reason);
        const sig = await guardClick(loc, to);
        await glide(to);
        await sleep(P(300));
        await recheck(loc, to, sig);
        ev('click', to.x, to.y, to.rect, to.context);
        if (ctx.cursor) await page.evaluate(() => window.__fpCursor?.click()).catch(() => {});
        const navBefore = state.navCount;
        ctx.tracker.reset();
        await loc.selectOption({ index: opt.index }, { timeout: 2000 });
        const chosen = await loc.evaluate((el) => el.selectedOptions?.[0]?.label ?? null);
        if (chosen !== opt.label) throw new SceneFail(`the list shows "${chosen}" instead of the checked option "${opt.label}".`);
        return afterAction(navBefore);
      }
      case 'type': {
        const loc = await resolveTarget(page, action, 5000);
        const to = await onScreen(loc);
        const value = String(action.value ?? '');
        const t = checkType(await describeElement(loc), value, deny);
        if (!t.ok) throw new SceneStop(t.reason);
        const submit = action.submit === true || action.pressEnter === true;
        if (submit) await guardEnter(loc, action);
        const sig = await guardClick(loc, to);
        await glide(to);
        await sleep(P(250));
        await recheck(loc, to, sig);
        await clickAt(to);
        await loc.fill('');
        ev('type', to.x, to.y, to.rect, to.context);
        for (const ch of value) {
          await page.keyboard.type(ch);
          await sleep(P(55 + Math.random() * 75 + (ch === ' ' ? 40 : 0)));
        }
        await sleep(P(400));
        if (submit) {
          await checkpoint();
          await guardEnter(loc, action, { beforePress: true });
          const navBefore = state.navCount;
          ctx.tracker.reset();
          await page.keyboard.press('Enter');
          return afterAction(navBefore);
        }
        return undefined;
      }
      default:
        throw new SceneFail(`unknown action type "${action.type}".`);
    }
  }

  // plan.rehearse: the scene's read-only clicks (and waitFor steps) once, off camera, before recording: no cursor,
  // no events, the guard and the read-only watch as on camera. Then back to the scene's start page through the
  // browser history, which in a single-page app keeps its data cache, so the recorded click lands on a page that
  // shows at once instead of a loading skeleton.
  async function rehearse() {
    const startUrl = page.url();
    for (const action of scene.actions) {
      if (action.type === 'waitFor') { await resolveTarget(page, action, action.timeoutMs ?? 10000); continue; }
      if (action.type !== 'click') continue;
      if (action.readOnly !== true) throw new SceneStop('A rehearsal runs read-only clicks only.');
      await checkpoint();
      const loc = await resolveTarget(page, action, 5000);
      const to = await onScreen(loc);
      const sig = await guardClick(loc, to);
      await recheck(loc, to, sig);
      const navBefore = state.navCount;
      ctx.tracker.reset();
      watching = true;
      await page.mouse.click(to.x, to.y);
      try {
        await afterAction(navBefore);
      } finally {
        readOnlyCheck();
        watching = false;
      }
    }
    for (let i = 0; i < 10 && page.url() !== startUrl; i++) {
      await page.goBack({ waitUntil: 'commit' }).catch(() => null);
      await page.waitForLoadState('load').catch(() => {});
      await landed();
    }
    if (page.url() !== startUrl) throw new SceneFail(`after the rehearsal the page could not go back to ${scene.route}.`);
    await page.mouse.move(state.cursor.x, state.cursor.y);
  }

  return { run, scan, checkpoint, ready, readOnlyCheck, rehearse };
}

// One try at a scene. phase says where it failed: 'gate' (before recording,
// nothing done) or 'record' (actions may have run).
async function attemptScene(ctx, scene, n) {
  const { page, cfg, out } = ctx;
  const name = `${n}-${scene.id}`;
  const clip = path.join(out, 'scenes', `${name}.webm`);
  const shot = path.join(out, 'failures', `${name}.png`);
  const rel = (f) => path.relative(out, f).split(path.sep).join('/');
  const result = { id: scene.id, n, status: 'failed', clip: null, failure: null, problems: [], warnings: [], durationMs: 0 };
  const failShot = async () => {
    fs.mkdirSync(path.dirname(shot), { recursive: true });
    await page.screenshot({ path: shot }).then(() => { result.failure = rel(shot); }).catch(() => {});
  };
  ctx.privacy = { emails: new Set(), phones: new Set(), matches: new Set() };
  ctx.warnings = new Set();
  const events = [];
  const t0Ref = { t0: Date.now() };
  const scn = makeScene({ ...ctx, events, t0Ref }, scene);
  const done = (phase) => { result.warnings = [...ctx.warnings]; return { result, events: result.status === 'ok' ? events : [], privacy: null, phase }; };

  // 1. Open the route and pass the start gate.
  const url = new URL(scene.route, cfg.origin).href;
  ctx.tracker.reset();
  ctx.state.navStop = null;
  let gate;
  try {
    await page.goto(url, { waitUntil: 'load', timeout: cfg.ready.timeoutMs + 15000 });
  } catch (e) {
    gate = { ok: false, problems: [`could not open ${scene.route}: ${String(e.message).split('\n')[0]}`] };
  }
  if (ctx.state.navStop) gate = { ok: false, problems: [ctx.state.navStop], stop: ctx.state.navStop };
  // The theme is judged here only: an action may open a dimming dialog later.
  if (!gate) gate = await scn.ready(startShow(scene), { theme: ctx.plan.theme });
  if (!gate.ok) {
    result.problems = gate.problems;
    result.stop = gate.stop;
    await failShot();
    return done('gate');
  }
  await scn.scan();

  // 1b. plan.rehearse: the scene's read-only clicks once off camera, then the start gate again.
  if (ctx.plan.rehearse === true && scene.actions.some((a) => a.type === 'click')) {
    try {
      await scn.rehearse();
      gate = await scn.ready(startShow(scene), { theme: ctx.plan.theme });
    } catch (e) {
      gate = { ok: false, problems: [`rehearsal: ${e.message}`], ...(e instanceof SceneStop ? { stop: e.message } : {}) };
    }
    if (!gate.ok) {
      result.problems = gate.problems;
      result.stop = gate.stop;
      await failShot();
      return done('gate');
    }
  }

  // 2. The ledger records each data change of this scene BEFORE it can happen.
  for (const w of (ctx.plan.writes || []).filter((x) => x.scene === scene.id)) {
    ctx.ledger = recordAttempt(ctx.ledger, w, ctx.take);
    saveLedger(ctx.ledgerFile, ctx.ledger);
  }

  // 3. Record in real time.
  fs.mkdirSync(path.dirname(clip), { recursive: true });
  fs.rmSync(clip, { force: true });
  const sc = ctx.screencast(page);
  let failure = null;
  try {
    await sc.start({ path: clip, size: { width: VIEWPORT.width * cfg.scale, height: VIEWPORT.height * cfg.scale }, fps: cfg.fps });
    t0Ref.t0 = Date.now();
    ctx.state.onNav = () => events.push({ scene: scene.id, tMs: Math.max(0, Math.round(Date.now() - t0Ref.t0)), type: 'navigate', x: null, y: null, rect: null });
    await sleep(cfg.pace * 700);
    for (const action of scene.actions) {
      await scn.checkpoint();
      await scn.run(action);
    }
    scn.readOnlyCheck();
    await scn.checkpoint();
    const v = verifyShow(scene);
    if (v.bad.length) throw new SceneFail(v.bad.join('; '));
    const end = await scn.ready([...scene.mustShow, ...v.out]);
    if (end.stop) throw new SceneStop(end.stop);
    if (!end.ok) throw new SceneFail(end.problems.join('; '));
    await scn.scan();
    // The pause after the last action: the clip ends after it.
    await sleep(cfg.pace * (Number.isFinite(scene.holdMs) ? scene.holdMs : 1500));
    scn.readOnlyCheck();
  } catch (e) {
    failure = e;
  }
  ctx.state.onNav = null;
  // Whatever broke after the page left the app (a missing control, a moved
  // box) is that stop, never a retakeable failure.
  if (failure && !(failure instanceof SceneStop) && ctx.state.navStop) failure = new SceneStop(ctx.state.navStop);
  result.durationMs = Date.now() - t0Ref.t0;
  try {
    await sc.stop();
  } catch (e) {
    failure ??= new SceneFail(`the recording could not be finished: ${String(e.message).split('\n')[0]}`);
  }
  if (!failure) {
    const size = fs.existsSync(clip) ? fs.statSync(clip).size : 0;
    if (!size) failure = new SceneFail('the recording produced no clip (the file is missing or empty).');
  }

  if (failure) {
    await failShot();
    if (fs.existsSync(clip)) fs.renameSync(clip, path.join(path.dirname(shot), `${name}.webm`));
    result.problems = [failure instanceof SceneStop || failure instanceof SceneFail ? failure.message : `the scene crashed: ${failure.message}`];
    if (failure instanceof SceneStop) result.stop = failure.message;
    return done('record');
  }
  result.status = 'ok';
  result.clip = rel(clip);
  const out2 = done('record');
  out2.privacy = { scene: scene.id, emails: [...ctx.privacy.emails].sort(), phones: [...ctx.privacy.phones].sort(), matches: [...ctx.privacy.matches].sort() };
  return out2;
}

// A failed scene is retaken in this run, at most cfg.retries (2) times, after
// a fresh page load. A scene that can change data is only retaken when it failed
// before recording started (nothing was done); after that it is reported, never
// silently repeated. A stop is never retaken.
async function recordScene(ctx, scene, n, log) {
  const writes = (ctx.plan.writes || []).some((w) => w.scene === scene.id) || scene.actions.some(isWriteAction);
  const earlier = [];
  for (let attempt = 0; ; attempt++) {
    const r = await attemptScene(ctx, scene, n);
    if (r.result.status === 'ok' || r.result.stop || attempt >= ctx.cfg.retries || (writes && r.phase !== 'gate')) {
      r.result.retakes = earlier;
      if (r.result.status === 'ok') {
        // Earlier tries of a scene that then recorded fine are not failures.
        for (const ext of ['png', 'webm']) fs.rmSync(path.join(ctx.out, 'failures', `${n}-${scene.id}.${ext}`), { force: true });
      }
      return r;
    }
    earlier.push(r.result.problems.join('; '));
    log(`scene ${n} ${scene.id}: retake ${attempt + 1} after: ${r.result.problems.join('; ')}`);
  }
}

// `scenes` limits the run to those scene ids (the others are reported as not
// selected), so a rerun of one scene does not repeat every data change.
// `screencast` is a seam for tests: (page) => ({ start(opts), stop() }).
export async function record({
  plan, config = {}, out, retake = false, scenes: only, launch = launchBrowser, configDir = process.cwd(), log = () => {},
  screencast = (page) => page.screencast,
}) {
  // Everything that can refuse does so before a browser opens.
  validatePlan(plan);
  requireApproval(plan);
  if (typeof out !== 'string' || !out) throw new RecordError('An output folder is needed (--out).');
  if (only !== undefined) {
    if (!Array.isArray(only) || !only.length) throw new RecordError('The scene filter needs at least one scene id.');
    const unknown = only.filter((id) => !plan.scenes.some((sc) => sc.id === id));
    if (unknown.length) throw new RecordError(`The scene filter names scenes that are not in the plan: ${unknown.join(', ')}.`);
  }
  const selected = (sc) => !only || only.includes(sc.id);
  const cfg = normalizeConfig(config, plan, configDir);
  const ledgerFile = path.join(out, 'ledger.json');
  let ledger = loadLedger(ledgerFile);
  // A route, action or write edited since the last take is printed, loudly,
  // before anything else: it needs a fresh yes from the buyer.
  const changed = planChanges(ledger, plan);
  if (changed) log(changed.message);
  const take = planTake(ledger, plan, { retake, scenes: only });
  if (take.refuse) throw new PlanError(take.message);
  if (!fs.existsSync(cfg.storageState)) {
    throw new RecordError(`No saved session at ${cfg.storageState}. Log in first: node record.mjs login --config <capture.json>`);
  }
  fs.mkdirSync(out, { recursive: true });
  ledger = recordPlan({ ...ledger, takes: Math.max(Number.isInteger(ledger.takes) ? ledger.takes : 0, take.take) }, plan, take.take);
  saveLedger(ledgerFile, ledger);
  // Clips and failures from an earlier run must never be mistaken for this one.
  const names = plan.scenes.map((sc, i) => (selected(sc) ? `${String(i + 1).padStart(2, '0')}-${sc.id}` : null)).filter(Boolean);
  const mine = (f) => names.some((nm) => f === `${nm}.webm` || f === `${nm}.png`);
  clearDir(path.join(out, 'scenes'), { test: mine });
  clearDir(path.join(out, 'failures'), { test: mine });

  const browser = await launch({ scale: cfg.scale });
  const report = {
    ok: false, take: take.take, planChanged: changed ? changed.message : null, selected: only ? [...only] : null, theme: plan.theme ?? null, stopped: null, viewport: { ...VIEWPORT }, scale: cfg.scale, fps: cfg.fps,
    clipSize: { width: VIEWPORT.width * cfg.scale, height: VIEWPORT.height * cfg.scale }, scenes: [],
  };
  const allEvents = []; const privacy = { note: 'Masked text seen on screen in each recorded scene. Raw values are never written.', scenes: [] };
  const flush = () => {
    writeJson(path.join(out, 'events.json'), allEvents);
    writeJson(path.join(out, 'privacy.json'), privacy);
    writeJson(path.join(out, 'report.json'), report);
  };
  try {
    const context = await browser.newContext({
      viewport: { ...VIEWPORT }, deviceScaleFactor: cfg.scale, storageState: cfg.storageState, ...(plan.theme ? { colorScheme: plan.theme } : {}),
    });
    const cursor = plan.video?.cursor !== false;
    if (cursor) await context.addInitScript(cursorInit);
    const page = await context.newPage();
    if (typeof page.screencast?.start !== 'function') {
      throw new RecordError('This recorder needs Playwright 1.64 or newer (page.screencast). Update it in the engine folder: npm install playwright@latest');
    }
    const state = { cursor: { x: VIEWPORT.width * 0.5, y: VIEWPORT.height * 0.6 }, navCount: 0, navStop: null, onNav: null };
    page.on('framenavigated', (f) => {
      if (f !== page.mainFrame() || f.url() === 'about:blank') return;
      state.navCount++;
      // While a scene records: a navigate event, so the composition cuts to wide when the page changes.
      state.onNav?.();
      // Checked on every URL the page commits to, redirects included.
      const nav = checkNavigation(f.url(), cfg.origin);
      if (!nav.ok && !state.navStop) state.navStop = nav.reason;
    });
    const tracker = trackRequests(page, cfg.origin);
    const ctx = {
      page, cfg, plan, out, ledgerFile, ledger, take: take.take, tracker, state, cursor, screencast,
      deny: buildDeny(plan.safety?.denyPattern),
      readyOpts: { origin: cfg.origin, loginPaths: cfg.loginPaths, tracker, ...cfg.ready },
    };
    for (let i = 0; i < plan.scenes.length; i++) {
      const scene = plan.scenes[i];
      const n = String(i + 1).padStart(2, '0');
      if (!selected(scene)) {
        report.scenes.push({ id: scene.id, n, status: 'skipped', clip: null, failure: null, problems: ['not selected for this run'], durationMs: 0 });
        continue;
      }
      if (report.stopped) {
        report.scenes.push({ id: scene.id, n, status: 'skipped', clip: null, failure: null, problems: ['not recorded: the run stopped earlier'], durationMs: 0 });
        continue;
      }
      log(`scene ${n} ${scene.id}: recording`);
      const { result, events, privacy: p } = await recordScene(ctx, scene, n, log);
      if (result.stop) report.stopped = `Scene "${scene.id}": ${result.stop}`;
      delete result.stop;
      report.scenes.push(result);
      allEvents.push(...events);
      if (p) privacy.scenes.push(p);
      log(`scene ${n} ${scene.id}: ${result.status}${result.problems.length ? ` (${result.problems.join('; ')})` : ''}`);
      flush();
    }
    report.ok = !report.stopped && report.scenes.every((s) => s.status === 'ok' || (s.status === 'skipped' && !selected(plan.scenes.find((sc) => sc.id === s.id))));
    flush();
    await context.close();
  } finally {
    await browser.close();
  }
  return report;
}

// ---------------------------------------------------------------- login

// Waits until the buyer has logged in by hand: the page is back on the app
// origin, off any login path, shows no password field, and stays that way for
// stableMs (so an MFA step in between does not count as done).
export async function waitForLogin(page, { origin, loginPaths, timeoutMs = 10 * 60 * 1000, stableMs = 1500, pollMs = 500 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let since = null;
  for (;;) {
    if (page.isClosed()) throw new RecordError('The login window was closed before the login finished.');
    const url = page.url();
    let ok = checkNavigation(url, origin).ok && !isLoginRedirect(url, loginPaths);
    if (ok) {
      ok = await page.evaluate(() => document.readyState === 'complete'
        && ![...document.querySelectorAll('input[type="password"]')].some((i) => i.checkVisibility?.() ?? true)).catch(() => false);
    }
    if (ok) {
      since ??= Date.now();
      if (Date.now() - since >= stableMs) return { url };
    } else {
      since = null;
    }
    if (Date.now() >= deadline) throw new RecordError('Timed out waiting for the login to finish.');
    await sleep(pollMs);
  }
}

// The part of a browser storage state that belongs to the app: cookies the
// browser would send to the app's host, and the localStorage of exactly the
// app's origin. A cookie whose domain starts with a dot (.example.com) is sent
// to that domain and its subdomains; one without the dot is host-only and is
// sent to that exact host alone, so an identity provider's session on the
// apex (example.com) is not the app's (app.example.com). An IP or localhost
// host matches exactly, and a one-label domain (.com) never covers a host. An
// SSO login also leaves the identity provider's cookies and storage behind;
// those are dropped, so the saved file is never a key to anything but the app.
export function appSessionState(state, origin) {
  const app = new URL(origin);
  const host = app.hostname.toLowerCase();
  const exactOnly = /^\d+(\.\d+){3}$/.test(host) || host.includes(':') || host === 'localhost';
  const applies = (domain) => {
    const raw = String(domain || '').toLowerCase();
    if (!raw.startsWith('.')) return Boolean(raw) && host === raw;
    const d = raw.slice(1);
    if (!d) return false;
    if (host === d) return true;
    return !exactOnly && d.includes('.') && host.endsWith(`.${d}`);
  };
  const cookies = Array.isArray(state?.cookies) ? state.cookies : [];
  const origins = Array.isArray(state?.origins) ? state.origins : [];
  const kept = { cookies: cookies.filter((c) => applies(c?.domain)), origins: origins.filter((o) => o?.origin === app.origin) };
  return { state: kept, dropped: { cookies: cookies.length - kept.cookies.length, origins: origins.length - kept.origins.length } };
}

// Saves only the app's own logged-in session state, readable by the user
// alone, in a folder git ignores.
export async function saveSession(context, file, { origin, log = () => {} } = {}) {
  let base;
  try { base = new URL(origin).origin; } catch { throw new RecordError('saveSession needs the app origin, to keep only the app\'s own session state.'); }
  const dir = path.dirname(file);
  const fresh = !fs.existsSync(dir);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const ignore = path.join(dir, '.gitignore');
  if (fresh) {
    fs.writeFileSync(ignore, '*\n');
  } else {
    const have = fs.existsSync(ignore) ? fs.readFileSync(ignore, 'utf8') : '';
    const line = path.basename(file);
    if (!have.split(/\r?\n/).some((l) => l.trim() === '*' || l.trim() === line)) fs.appendFileSync(ignore, `${have && !have.endsWith('\n') ? '\n' : ''}${line}\n`);
  }
  const { state, dropped } = appSessionState(await context.storageState(), base);
  fs.writeFileSync(file, JSON.stringify(state, null, 2), { mode: 0o600 });
  fs.chmodSync(file, 0o600);
  if (dropped.cookies || dropped.origins) {
    log(`Kept only the app's own session state: dropped ${dropped.cookies} cookies and the storage of ${dropped.origins} other origins (a sign-in provider, say).`);
  }
  if (!state.cookies.length && !state.origins.length) {
    log(`Warning: the saved session has no cookies or storage for ${base}, so the recording will most likely land on the login page. `
      + 'Check that the login finished on the app itself, then run the login again.');
  }
  return file;
}

export async function login({ config, configDir = process.cwd(), launch = launchBrowser, log = console.log }) {
  if (!isObj(config) || typeof config.origin !== 'string') throw new RecordError('The capture config needs the app origin (for example "https://staging.example.com").');
  let origin;
  try { origin = new URL(config.origin).origin; } catch { throw new RecordError(`capture config origin "${config.origin}" is not a valid URL.`); }
  const file = path.resolve(configDir, config.storageState || '.fp-app-demo/session.json');
  const browser = await launch({ headed: true });
  try {
    const context = await browser.newContext({ viewport: null });
    const page = await context.newPage();
    await page.goto(new URL(config.startPath || '/', origin).href);
    log('A browser window is open. Log in there yourself: this tool never types or sees your password.');
    log('Waiting until the app shows a logged-in page...');
    const { url } = await waitForLogin(page, { origin, loginPaths: config.loginPaths, timeoutMs: config.loginTimeoutMs });
    await saveSession(context, file, { origin, log });
    log(`Logged in at ${new URL(url).pathname}. Session saved to ${path.relative(process.cwd(), file)} (git-ignored). Delete it when you are done.`);
  } finally {
    await browser.close();
  }
  return file;
}

// ---------------------------------------------------------------- CLI

function readJsonFile(file, what) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { throw new RecordError(`Cannot read the ${what} ${file}: ${e.message}`); }
}

async function main() {
  const a = parseArgs();
  const usage = 'Usage: node record.mjs --plan plan.json --config capture.json --out run/ [--retake] [--scenes id1,id2]\n       node record.mjs login --config capture.json';
  if (typeof a.config !== 'string') { console.error(usage); return 2; }
  const configFile = path.resolve(a.config);
  try {
    const config = readJsonFile(configFile, 'capture config');
    if (a._?.[0] === 'login') {
      await login({ config, configDir: path.dirname(configFile) });
      return 0;
    }
    if (typeof a.plan !== 'string' || typeof a.out !== 'string') { console.error(usage); return 2; }
    const plan = readJsonFile(path.resolve(a.plan), 'plan');
    const report = await record({
      plan, config, out: path.resolve(a.out), retake: a.retake === true, configDir: path.dirname(configFile), log: (m) => console.log(m),
      scenes: typeof a.scenes === 'string' ? a.scenes.split(',').map((x) => x.trim()).filter(Boolean) : undefined,
    });
    if (report.stopped) console.error(`Run stopped. ${report.stopped}`);
    const failed = report.scenes.filter((s) => s.status === 'failed');
    for (const s of failed) console.error(`Scene ${s.n} ${s.id} failed: ${s.problems.join('; ')}`);
    console.log(report.ok ? `All ${report.scenes.length} scenes recorded.` : 'Not every scene was recorded. See report.json and failures/.');
    return report.ok ? 0 : 1;
  } catch (e) {
    if (e instanceof PlanError || e instanceof RecordError) { console.error(e.message); return 2; }
    throw e;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then((code) => { process.exitCode = code; }, (e) => { console.error(e?.stack || String(e)); process.exitCode = 1; });
}
