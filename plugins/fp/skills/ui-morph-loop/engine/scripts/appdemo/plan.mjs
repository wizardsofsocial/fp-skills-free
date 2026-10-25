// Plan validation and the write ledger for the app-demo recorder.
//
// The plan is what the buyer approves: the script, the scenes and every step
// that could change data. This module refuses a malformed plan, an unapproved
// plan, a data-changing scene with no declared write or no read-only check, and
// a retake that would silently repeat a data change.
//
// The ledger is a small JSON file per run. An attempt is recorded BEFORE the
// scene runs, so a crash mid-scene still counts as an attempt. A corrupt ledger
// is refused, never reset: resetting would hide earlier data changes.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { buildDeny, checkNavigation } from './guard.mjs';

export class PlanError extends Error {
  constructor(message) {
    super(message);
    this.name = 'PlanError';
  }
}

// The 16:9 cut's zoom cap (compose.mjs cameraFor's default); plan.video.maxZoom may lower it, never raise it.
export const WIDE_MAX_ZOOM = 1.5;

// The camera options a plan sets for one cut: video.maxZoom applies to the 16:9 cut only (the 9:16 cut keeps its own
// closer zoom, which a phone needs). Unset, nothing changes.
export function cameraOptions(plan, aspect = '16:9') {
  const mz = plan?.video?.maxZoom;
  return aspect === '16:9' && typeof mz === 'number' ? { maxZoom: mz } : {};
}

export const ACTION_TYPES =['wait', 'hover', 'click', 'type', 'select', 'check', 'uncheck', 'scroll', 'waitFor'];
const ALWAYS_WRITES = new Set(['type', 'select', 'check', 'uncheck']);

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isText = (v) => typeof v === 'string' && v.trim().length > 0;

function need(cond, message) {
  if (!cond) throw new PlanError(message);
}

function validateAction(a, where) {
  need(isObj(a), `${where}: each action must be an object.`);
  need(ACTION_TYPES.includes(a.type), `${where}: unknown action type "${String(a.type)}". Use one of ${ACTION_TYPES.join(', ')}.`);
  if (a.value !== undefined) {
    need(!/[\n\r\t]/.test(String(a.value)), `${where}: the value contains a newline or tab, which would submit the form or move to another field. Use submit: true to press Enter.`);
  }
  if (a.submitTarget !== undefined) {
    need(a.type === 'type', `${where}: submitTarget only applies to a type action.`);
    need(isText(a.submitTarget), `${where}: submitTarget must be the submit control's accessible name, or "css=" and a selector.`);
  }
}

function validateScene(s, i, origin, seen) {
  const where = `Scene ${i + 1}`;
  need(isObj(s), `${where} must be an object.`);
  need(isText(s.id), `${where} needs an id.`);
  need(!seen.has(s.id), `Duplicate scene id "${s.id}". Every scene needs its own id.`);
  seen.add(s.id);
  const w = `Scene "${s.id}"`;
  need(isText(s.title), `${w} needs a title.`);
  need(isText(s.route), `${w} needs a route.`);
  const nav = checkNavigation(s.route, origin);
  need(nav.ok, `${w} route "${s.route}" is off the app: ${nav.reason}`);
  need(typeof s.narration === 'string', `${w} needs narration (a string, empty if silent).`);
  need(Array.isArray(s.actions), `${w} needs an actions list.`);
  s.actions.forEach((a, j) => validateAction(a, `${w}, action ${j + 1}`));
  if (s.verify !== undefined) {
    need(Array.isArray(s.verify) && s.verify.every(isObj), `${w}: verify must be a list of checks.`);
  }
  need(Array.isArray(s.mustShow) && s.mustShow.every(isText), `${w} needs mustShow, a list of text that must be visible.`);
}

function validateWrite(wr, i, sceneIds) {
  const where = `Write ${i + 1}`;
  need(isObj(wr), `${where} must be an object.`);
  need(isText(wr.id), `${where} needs an id.`);
  const w = `Write "${wr.id}"`;
  need(isText(wr.scene), `${w} needs the scene it belongs to.`);
  need(sceneIds.has(wr.scene), `${w} names scene "${wr.scene}", which is not in the plan.`);
  need(isText(wr.description), `${w} needs a description.`);
  need(isText(wr.effect), `${w} needs the expected effect.`);
  need(typeof wr.approved === 'boolean', `${w} needs approved set to true or false.`);
}

const actionLabel = (a) => {
  const t = typeof a.target === 'string' && a.target ? ` "${a.target}"` : (typeof a.selector === 'string' && a.selector ? ` ${a.selector}` : '');
  return `${a.type}${t}`;
};

// Words that make a page change data, or end the session, just by being
// opened. A scene route is split into words on / - _ . and camelCase, and a
// word, or two neighbours joined (sign + out), must not be one of these.
export const ROUTE_DENY = ['logout', 'logoff', 'signout', 'delete', 'remove', 'cancel', 'unsubscribe', 'deactivate', 'destroy', 'revoke', 'reset', 'purge', 'terminate', 'signoff', 'wipe', 'erase'];

export function routeDenyWord(pathname) {
  let p = String(pathname);
  try { p = decodeURIComponent(p); } catch { /* keep it as it is */ }
  const words = p.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .toLowerCase().split(/[\s/._-]+/).filter(Boolean);
  for (let i = 0; i < words.length; i++) {
    if (ROUTE_DENY.includes(words[i])) return words[i];
    if (i + 1 < words.length && ROUTE_DENY.includes(words[i] + words[i + 1])) return words[i] + words[i + 1];
  }
  return null;
}

const pathList = (v, name, example) => {
  need(Array.isArray(v), `safety.${name} must be a list of paths, such as ["${example}"].`);
  for (const p of v) {
    need(isText(p) && p.startsWith('/'), `safety.${name} entry "${String(p)}" must be a path that starts with /.`);
    need(!/[?#]/.test(p), `safety.${name} entry "${p}" must be a path only, with no query or #.`);
  }
};

// Every click is a possible data change unless the plan marks it readOnly: true.
// type, select, check and uncheck always count. hover, scroll, wait and waitFor never do.
export function isWriteAction(a) {
  if (!isObj(a)) return false;
  if (ALWAYS_WRITES.has(a.type)) return true;
  return a.type === 'click' && a.readOnly !== true;
}

// Scenes whose actions can change data. Each such action names its writes[]
// entry (write: "<id>"), and the scene carries a verify.
export function scenesNeedingWrites(plan) {
  const scenes = Array.isArray(plan?.scenes) ? plan.scenes : [];
  return scenes.filter((s) => Array.isArray(s?.actions) && s.actions.some(isWriteAction)).map((s) => s.id);
}

// The optional spoken line over the opening shot (R40): { narration: "<one line>" }. It is narration, so it never
// enters the plan digest. A line that long would never fit a 3 to 8 s clip; the build checks the real fit.
export const OPENER_MAX_CHARS = 200;
export function validateOpener(opener) {
  need(isObj(opener), 'opener must be an object: { "narration": "<one short line>" }.');
  const extra = Object.keys(opener).filter((k) => k !== 'narration');
  need(!extra.length, `opener takes only narration, not ${extra.map((k) => `"${k}"`).join(', ')}.`);
  need(isText(opener.narration), 'opener needs narration: the one line spoken over the opening shot.');
  need(!/[\n\r\t]/.test(opener.narration), 'opener narration contains a newline or tab: write it as one line.');
  const n = opener.narration.trim().length;
  need(n <= OPENER_MAX_CHARS, `opener narration is ${n} characters; keep it to one short line (at most ${OPENER_MAX_CHARS}, and about 2 words a second of the clip).`);
  return opener;
}

export function validatePlan(plan) {
  need(isObj(plan), 'The plan must be an object.');
  need(isText(plan.title), 'The plan needs a title.');
  need(isText(plan.question), 'The plan needs the question the video answers.');
  need(isText(plan.origin), 'The plan needs the app origin.');
  let base;
  try { base = new URL(plan.origin); } catch { throw new PlanError(`The origin "${plan.origin}" is not a valid URL.`); }
  need(/^https?:$/.test(base.protocol), 'The origin must be http or https.');
  need(typeof plan.approved === 'boolean', 'The plan needs approved set to true or false.');
  need(Array.isArray(plan.scenes) && plan.scenes.length > 0, 'The plan needs at least one scene.');
  const seen = new Set();
  plan.scenes.forEach((s, i) => validateScene(s, i, plan.origin, seen));
  const writes = plan.writes === undefined ? [] : plan.writes;
  need(Array.isArray(writes), 'writes must be a list.');
  const ids = new Set();
  writes.forEach((wr, i) => {
    validateWrite(wr, i, seen);
    need(!ids.has(wr.id), `Duplicate write id "${wr.id}".`);
    ids.add(wr.id);
  });
  // Every write action names the writes entry it belongs to, and every entry
  // is named by an action in its scene: a second data change in a scene can
  // never hide behind the first one's approval.
  for (const s of plan.scenes) {
    const own = new Set(writes.filter((wr) => wr.scene === s.id).map((wr) => wr.id));
    s.actions.forEach((a, j) => {
      const where = `Scene "${s.id}", action ${j + 1} (${actionLabel(a)})`;
      if (!isWriteAction(a)) {
        need(a.write === undefined, `${where} cannot name a write: ${a.type === 'click' ? 'a click marked readOnly: true' : `a ${a.type}`} does not change data. Remove write, or remove readOnly if the click does change data.`);
        return;
      }
      need(isText(a.write),
        `${where} may change data: name its writes entry with write: "<id>" (one entry per data change, with its expected effect so the buyer can approve it), or mark a click readOnly: true if it only navigates.`);
      need(own.has(a.write), `${where} names write "${a.write}", which is not a writes entry for this scene. Add it to writes with scene "${s.id}", or name the right one.`);
    });
    for (const id of own) {
      need(s.actions.some((a) => isWriteAction(a) && a.write === id),
        `Write "${id}" is not named by any action in scene "${s.id}". Add write: "${id}" to the action that makes this change, or remove the entry.`);
    }
  }
  if (plan.opener !== undefined) validateOpener(plan.opener);
  // rehearse: true runs each scene's read-only clicks once off camera before it records, so a single-page app's
  // data is cached when the recorded click lands (no loading skeleton on film). Only a plan that cannot change
  // data may do that: no writes, and every click marked readOnly: true.
  if (plan.rehearse !== undefined) {
    need(typeof plan.rehearse === 'boolean', 'rehearse must be true or false.');
    if (plan.rehearse) {
      need(writes.length === 0, 'rehearse: true is only for a plan with no data changes: it clicks every scene\'s controls once more, off camera. Remove the writes or rehearse.');
      for (const s of plan.scenes) {
        const bad = s.actions.find((a) => isWriteAction(a));
        need(!bad, `rehearse: true needs every click marked readOnly: true and no typing; scene "${s.id}" has ${actionLabel(bad || {})}.`);
      }
    }
  }
  need(plan.theme === undefined || plan.theme === 'light' || plan.theme === 'dark', 'theme must be "light" or "dark" (or left out).');
  if (plan.video !== undefined) {
    need(isObj(plan.video), 'video must be an object.');
    need(plan.video.cursor === undefined || typeof plan.video.cursor === 'boolean', 'video.cursor must be true or false.');
    const mz = plan.video.maxZoom;
    need(mz === undefined || (typeof mz === 'number' && mz >= 1 && mz <= WIDE_MAX_ZOOM),
      `video.maxZoom must be a number from 1 to ${WIDE_MAX_ZOOM}: the 16:9 cut's closest zoom (1 keeps every shot wide, for a dense screen whose zoomed shots would slice its columns).`);
    const ta = plan.video.teaserAnswer;
    need(ta === undefined || (isText(ta) && seen.has(ta)),
      `video.teaserAnswer must be the id of a scene in this plan (the scene the teaser ends on; default the last), not "${String(ta)}".`);
  }
  if (plan.safety !== undefined) {
    need(isObj(plan.safety), 'safety must be an object.');
    const dp = plan.safety.denyPattern;
    if (dp !== undefined) {
      need(isText(dp), 'safety.denyPattern must be a non-empty text pattern.');
      try { new RegExp(dp, 'i'); } catch { throw new PlanError(`safety.denyPattern "${dp}" is not a valid pattern.`); }
      try { buildDeny(dp); } catch (e) { throw new PlanError(`safety.denyPattern is unusable: ${e.message}`); }
    }
    const ap = plan.safety.allowPostPaths;
    if (ap !== undefined) {
      pathList(ap, 'allowPostPaths', '/api/telemetry');
      for (const p of ap) need(p.replace(/\/+$/, '') !== '', `safety.allowPostPaths entry "${p}" would allow every path: name the harmless one.`);
    }
    if (plan.safety.allowRoutes !== undefined) pathList(plan.safety.allowRoutes, 'allowRoutes', '/orders/12/cancel');
  }
  // A GET can change data too (/logout, /orders/12/cancel): such a route is
  // refused unless the buyer lists that exact path in safety.allowRoutes.
  const allowRoutes = plan.safety?.allowRoutes || [];
  for (const s of plan.scenes) {
    const p = new URL(s.route, base).pathname;
    if (allowRoutes.includes(p)) continue;
    const word = routeDenyWord(p);
    need(!word, `Scene "${s.id}" route "${s.route}" contains "${word}": opening a page like that can change data or end the session by itself. `
      + 'Pick another route to the same screen, or, only if the user agrees the page is safe to open, list the exact path in safety.allowRoutes.');
  }
  // A scene with a write action has a writes entry by now (checked above).
  for (const id of scenesNeedingWrites(plan)) {
    const scene = plan.scenes.find((s) => s.id === id);
    need(Array.isArray(scene.verify) && scene.verify.length > 0,
      `Scene "${id}" can change data but has no verify. Add a read-only check that shows the change worked.`);
  }
  return plan;
}

// Whether a same-origin request path is one the plan's safety.allowPostPaths
// lets through after a read-only click: the path itself or anything under it.
export function allowedPost(pathname, allow = []) {
  return allow.some((p) => {
    const base = p.replace(/\/+$/, '');
    return pathname === base || pathname.startsWith(`${base}/`);
  });
}

export function requireApproval(plan) {
  need(isObj(plan) && plan.approved === true, 'The plan is not approved. Nothing records until the buyer approves the script, scenes and data changes.');
  const writes = Array.isArray(plan.writes) ? plan.writes : [];
  const open = writes.filter((wr) => wr?.approved !== true).map((wr) => wr?.id);
  need(open.length === 0, `Data changes not approved yet: ${open.join(', ')}.`);
}

// Seconds of narration to words, at a spoken pace (default 140 words a minute).
export function wordBudget(seconds, wpm = 140) {
  if (!Number.isFinite(seconds) || seconds <= 0 || !Number.isFinite(wpm) || wpm <= 0) return 0;
  return Math.round((seconds * wpm) / 60);
}

// ---- ledger ----
// { version: 1, takes: number, attempts: [{ write, scene, take, at }],
//   plans: [{ take, at, scenes: { <scene id>: <digest> } }] }
// `plans` is optional: ledgers written before it existed have none.

export function emptyLedger() {
  return { version: 1, takes: 0, attempts: [] };
}

function checkLedger(ledger) {
  need(isObj(ledger) && Array.isArray(ledger.attempts), 'The write ledger is damaged. Fix or restore it by hand; it is never reset automatically, because that would hide earlier data changes.');
  for (const a of ledger.attempts) {
    need(isObj(a) && isText(a.write) && Number.isInteger(a.take) && a.take > 0,
      'The write ledger is damaged. Fix or restore it by hand; it is never reset automatically, because that would hide earlier data changes.');
  }
  if (ledger.plans !== undefined) {
    need(Array.isArray(ledger.plans) && ledger.plans.every((p) => isObj(p) && Number.isInteger(p.take) && p.take > 0 && isObj(p.scenes)),
      'The write ledger is damaged (its plan record). Fix or restore it by hand; it is never reset automatically.');
  }
  return ledger;
}

const lastTake = (ledger) => Math.max(Number.isInteger(ledger.takes) ? ledger.takes : 0, 0, ...ledger.attempts.map((a) => a.take));

// Decides the next take. A take that would repeat an earlier attempted write is
// refused unless the caller passes retake: true (the buyer reset the data or
// said yes; record.mjs --retake, build.sh RETAKE=1). `scenes` limits the check
// to those scene ids. Every take of a run shares one folder and one ledger.
export function planTake(ledger, plan, { retake = false, scenes } = {}) {
  checkLedger(ledger);
  const take = lastTake(ledger) + 1;
  const writes = (Array.isArray(plan?.writes) ? plan.writes : []).filter((wr) => !scenes || scenes.includes(wr.scene));
  const repeated = writes.filter((wr) => ledger.attempts.some((a) => a.write === wr.id || a.scene === wr.scene));
  if (repeated.length && !retake) {
    const names = repeated.map((wr) => `"${wr.id}" (${wr.description})`).join(', ');
    return {
      take, refuse: true,
      message: `Take ${take} would repeat data changes already attempted: ${names}. Nothing was recorded. `
        + 'Ask the user: they can reset that data, or say yes to repeating it. Only then run again with RETAKE=1 '
        + '(build.sh) or --retake (record.mjs), in this same run folder.',
    };
  }
  return { take, message: repeated.length ? `Retake approved: repeating ${repeated.length} data change(s).` : `Take ${take} has no repeated data changes.` };
}

// Returns a new ledger with the attempt added. Call and save BEFORE the scene runs.
export function recordAttempt(ledger, write, take, at = new Date().toISOString()) {
  checkLedger(ledger);
  need(isObj(write) && isText(write.id), 'recordAttempt needs the write entry.');
  need(Number.isInteger(take) && take > 0, 'recordAttempt needs a take number.');
  return {
    ...ledger,
    takes: Math.max(lastTake(ledger), take),
    attempts: [...ledger.attempts, { write: write.id, scene: write.scene, take, at }],
  };
}

// ---- plan changes between takes ----
// What the buyer approved, per scene, as a digest: the route, the actions,
// the scene's writes and its verify checks. Timing (holdMs, ms, timeoutMs),
// screenshot names, narration, titles and mustShow are left out: editing those
// changes nothing in the app. A write's approved flag is left out too. The
// plan's origin and safety settings (allowPostPaths, allowRoutes, denyPattern)
// get a digest of their own under the pseudo-scene "(safety)": loosening one
// weakens a guard the buyer said yes to.
const TIMING = new Set(['holdMs', 'ms', 'timeoutMs', 'screenshot']);
const stable = (v) => {
  if (Array.isArray(v)) return `[${v.map(stable).join(',')}]`;
  if (isObj(v)) return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${stable(v[k])}`).join(',')}}`;
  return JSON.stringify(v ?? null);
};

export function sceneDigests(plan) {
  const writes = Array.isArray(plan?.writes) ? plan.writes : [];
  const out = {};
  for (const s of Array.isArray(plan?.scenes) ? plan.scenes : []) {
    const actions = (Array.isArray(s.actions) ? s.actions : []).map((a) => (isObj(a) ? Object.fromEntries(Object.entries(a).filter(([k]) => !TIMING.has(k))) : a));
    const own = writes.filter((wr) => isObj(wr) && wr.scene === s.id).map(({ approved: _, ...wr }) => wr);
    const verify = (Array.isArray(s.verify) ? s.verify : []).map((v) => (isObj(v) ? Object.fromEntries(Object.entries(v).filter(([k]) => !TIMING.has(k))) : v));
    out[s.id] = digest({ route: s.route, actions, writes: own, verify });
  }
  out[SAFETY] = digest(safetyOf(plan));
  return out;
}

export const SAFETY = '(safety)';
const digest = (v) => crypto.createHash('sha256').update(stable(v)).digest('hex').slice(0, 16);
function safetyOf(plan) {
  let origin = plan?.origin ?? null;
  try { origin = new URL(origin).origin; } catch { /* keep it as written */ }
  const sf = isObj(plan?.safety) ? plan.safety : {};
  const list = (v) => (Array.isArray(v) ? [...v].map(String).sort() : v ?? []);
  // rehearse adds off-camera clicks, so turning it on is a change the buyer sees; left out when off, so the digest
  // of every plan without it is unchanged.
  return { origin, allowPostPaths: list(sf.allowPostPaths), allowRoutes: list(sf.allowRoutes), denyPattern: sf.denyPattern ?? null,
    ...(plan?.rehearse === true ? { rehearse: true } : {}) };
}

// Returns a new ledger with this take's plan digests added.
export function recordPlan(ledger, plan, take, at = new Date().toISOString()) {
  checkLedger(ledger);
  need(Number.isInteger(take) && take > 0, 'recordPlan needs a take number.');
  return { ...ledger, plans: [...(ledger.plans || []), { take, at, scenes: sceneDigests(plan) }] };
}

// Compares the plan with the latest take's: { since, scenes, message } naming
// every scene whose route, actions, writes or verify changed (or that is new),
// and "(safety)" when the origin or a safety setting changed, or null.
// The change is not refused: it is printed loudly, because it needs a fresh
// yes from the buyer before the build goes on.
export function planChanges(ledger, plan) {
  checkLedger(ledger);
  const plans = ledger.plans || [];
  if (!plans.length) return null;
  const last = plans.reduce((a, b) => (b.take >= a.take ? b : a));
  const now = sceneDigests(plan);
  const scenes = Object.keys(now).filter((id) => last.scenes[id] !== now[id]);
  if (!scenes.length) return null;
  return {
    since: last.take, scenes,
    message: `PLAN CHANGED since take ${last.take}: scenes ${scenes.join(', ')} (route, action, write, check or safety edits). `
      + 'The user approved the plan as it was: show them what changed and get a fresh yes before building on this take.',
  };
}

export function hasAttempt(ledger, writeId, take) {
  checkLedger(ledger);
  return ledger.attempts.some((a) => a.write === writeId && (take === undefined || a.take === take));
}

// A missing file is an empty ledger. A file that cannot be read as a ledger is
// an error, never a silent reset.
export function loadLedger(file) {
  let raw;
  try { raw = fs.readFileSync(file, 'utf8'); } catch (e) {
    if (e.code === 'ENOENT') return emptyLedger();
    throw new PlanError(`The write ledger ${path.basename(file)} cannot be read: ${e.message}`);
  }
  let data;
  try { data = JSON.parse(raw); } catch {
    throw new PlanError(`The write ledger ${path.basename(file)} is corrupt (not valid JSON). It is not reset automatically; fix or restore it by hand.`);
  }
  return checkLedger(data);
}

export function saveLedger(file, ledger) {
  checkLedger(ledger);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(ledger, null, 2)}\n`);
  fs.renameSync(tmp, file);
}
