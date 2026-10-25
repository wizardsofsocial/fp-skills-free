// Guard for the app-demo recorder: decides whether a click, a keystroke or a
// navigation is safe to perform on the buyer's real app.
//
// Pure functions, no Playwright import, so every rule is unit tested. The
// recorder reads an element description from the live DOM and calls these.
// Every check fails closed: a missing element, a bad URL or a junk argument is
// a refusal, never a pass.
//
// Deliberate design choices:
// - The control's real accessible text is what counts (visible text, aria-label,
//   aria-labelledby text, placeholder, title, value). Ids, names, classes and
//   selectors are never read, so a harmless selector cannot vouch for a control.
// - Matching is word-bounded after normalising case, punctuation, camelCase,
//   accents and zero-width characters. "Buyer list" is allowed (a nav label, not
//   a purchase); "Buy", "Buying" and "Log-out" are refused. A false refusal costs
//   a retake of a scene; a missed refusal costs the buyer real data.
// - Not handled: look-alike letters from other alphabets (a Cyrillic "e" inside
//   "delete"). The buyer's review of every take is the backstop for those.

const DENY_WORDS = [
  'delet(?:e|es|ed|ing|ion)',
  'remov(?:e|es|ed|ing|al)',
  'reset(?:s|ting)?',
  'revok(?:e|es|ed|ing)',
  'log\\s?(?:out|off)',
  'sign\\s?(?:out|off)',
  'pay(?:s|ing|ment|ments)?',
  'purchas(?:e|es|ed|ing)',
  'buy(?:s|ing)?',
  'transfer(?:s|red|ring)?',
  'publish(?:es|ed|ing)?',
  'unpublish(?:es|ed|ing)?',
  'cancel(?:s|led|ling|ing)?\\s+(?:my\\s+|your\\s+|the\\s+|this\\s+|a\\s+)?(?:subscription|plan|membership|account|order)',
  'unsubscribe',
  'deactivat(?:e|es|ed|ing)',
  'erase',
  'destroy',
  'wipe',
];

// The private copy is what the checks use. It is never exported, so nothing a
// caller does to the exported object (compile, lastIndex, freezing tricks)
// can loosen the real list. The export is a separate frozen copy for callers
// that want to read or combine it.
const DENY_SOURCE = `\\b(?:${DENY_WORDS.join('|')})\\b`;
const DENY_PRIVATE = new RegExp(DENY_SOURCE, 'i');
export const DENY_DEFAULT = Object.freeze(new RegExp(DENY_SOURCE, 'i'));

// Lowercase, strip accents and invisible characters, split camelCase, and turn
// every run of punctuation into one space ("Sign-out", "log_out", "logOut").
function normalize(s) {
  return String(s ?? '')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[­​-‏⁠﻿]/g, '')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Adds to the default, never removes. `extra` is a regex source or a plain
// phrase ("archive|send invoice"). An invalid regex is used as a literal.
// An extra that matches the empty string would block everything, so it throws.
export function buildDeny(extra) {
  const text = typeof extra === 'string' ? extra.trim() : '';
  if (!text) return new RegExp(DENY_SOURCE, 'i');
  let part;
  try {
    part = new RegExp(text, 'i');
  } catch {
    part = new RegExp(escapeRegex(text), 'i');
  }
  if (part.test('')) throw new Error(`Deny list addition "${text}" matches empty text and would block every click`);
  return new RegExp(`(?:${DENY_SOURCE})|(?:${part.source})`, 'i');
}

const TEXT_FIELDS = ['text', 'ariaLabel', 'ariaLabelledByText', 'placeholder', 'title', 'value'];

// Everything a person (or screen reader) could read on the control, joined.
export function controlText(el) {
  if (!el || typeof el !== 'object') return '';
  const parts = TEXT_FIELDS
    .map((k) => (typeof el[k] === 'string' ? el[k].replace(/\s+/g, ' ').trim() : ''))
    .filter(Boolean);
  return [...new Set(parts)].join(' ');
}

// The default list is always applied, whatever `deny` is, so a caller cannot
// loosen it by passing something weaker (or nothing).
function matchesDeny(text, deny) {
  const lists = [DENY_PRIVATE];
  if (deny instanceof RegExp) lists.push(new RegExp(deny.source, deny.flags.replace(/[gy]/g, '')));
  else if (typeof deny === 'string') lists.push(buildDeny(deny));
  const forms = [normalize(text), text.toLowerCase()];
  for (const re of lists) {
    for (const f of forms) {
      const m = f.match(re);
      if (m) return m[0];
    }
  }
  return null;
}

const clip = (s) => (s.length > 80 ? `${s.slice(0, 77)}...` : s);

export function checkClick(el, deny) {
  if (!el || typeof el !== 'object') return { ok: false, reason: 'No element description, so the click is refused.' };
  const text = controlText(el);
  const hit = matchesDeny(text, deny);
  if (hit) return { ok: false, reason: `Click refused: control "${clip(text)}" matches the deny list ("${hit}").` };
  return { ok: true };
}

const CREDENTIAL_LABEL = /\b(?:passwords?|passcodes?|passphrases?|pass|pwd|pin|one time (?:code|password|passcode)|otp|verification code|security code|cvv|cvc|card number|credit card|social security|ssn|api ?keys?|secret(?: ?keys?)?|access keys?|tokens?|account numbers?|routing numbers?|iban|sort code|expir(?:y|ation|es|ing))\b/;
const CREDENTIAL_AUTOCOMPLETE = /(?:^|\s)(?:one-time-code|current-password|new-password|cc-[a-z-]+)(?:\s|$)/;

function luhn(digits) {
  let sum = 0;
  for (let i = 0; i < digits.length; i++) {
    let d = Number(digits[digits.length - 1 - i]);
    if (i % 2 === 1) { d *= 2; if (d > 9) d -= 9; }
    sum += d;
  }
  return sum % 10 === 0;
}

function entropy(s) {
  const counts = new Map();
  for (const c of s) counts.set(c, (counts.get(c) || 0) + 1);
  let h = 0;
  for (const n of counts.values()) { const p = n / s.length; h -= p * Math.log2(p); }
  return h;
}

// Prefixes are searched anywhere in the value behind a non-alphanumeric left
// boundary, so quotes, "key:" labels and brackets cannot hide them.
const SECRET_PREFIX = /(?:^|[^a-z0-9])(?:sk[_-]|rk[_-](?:live|test)|r8_|xox[abprse]-|xapp-|gh[pousr]_|github_pat_|whsec_|glpat-|shpat_|npm_[a-z0-9]{6}|hf_[a-z0-9]{8}|sg\.[a-z0-9_-]{10}|aiza[a-z0-9_-]{20}|eyj[a-z0-9_-]+\.[a-z0-9_-]+\.)/i;
const AWS_KEY_ID = /(?:^|[^A-Za-z0-9])(?:AKIA|ASIA)[0-9A-Z]{16}/;

function looksSecret(value) {
  if (/-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(value)) return true;
  if (/\bbearer\s+\S{16,}/i.test(value)) return true;
  if (/\b\d{3}-\d{2}-\d{4}\b/.test(value)) return true;
  if (SECRET_PREFIX.test(value) || AWS_KEY_ID.test(value)) return true;
  for (const m of value.match(/\d(?:[ .\-/_]?\d){12,18}/g) || []) {
    if (luhn(m.replace(/\D/g, ''))) return true;
  }
  for (const raw of value.split(/[^A-Za-z0-9_\-+/=.]+/)) {
    const token = raw.replace(/^\.+|\.+$/g, '');
    // Long random-looking token: 24+ chars of one unbroken word with both
    // letters and digits and high character variety (API keys, hashes).
    if (token.length >= 24 && /^[A-Za-z0-9_\-+/=]+$/.test(token) && /[A-Za-z]/.test(token) && /\d/.test(token) && entropy(token) >= 3.5) return true;
  }
  return false;
}

export function checkType(el, value, deny) {
  if (!el || typeof el !== 'object') return { ok: false, reason: 'No element description, so typing is refused.' };
  if (String(el.type || '').toLowerCase() === 'password') {
    return { ok: false, reason: 'Typing refused: this is a password field. The skill never types credentials.' };
  }
  if (CREDENTIAL_AUTOCOMPLETE.test(String(el.autocomplete || '').toLowerCase())) {
    return { ok: false, reason: `Typing refused: the field is marked ${el.autocomplete} (credential or payment data).` };
  }
  const text = controlText(el);
  if (CREDENTIAL_LABEL.test(normalize(text))) {
    return { ok: false, reason: `Typing refused: the field "${clip(text)}" looks like a credential or payment field.` };
  }
  // Fail closed: a field whose label hits the deny list (for example
  // "Type DELETE to confirm") is part of a destructive flow.
  const hit = matchesDeny(text, deny);
  if (hit) return { ok: false, reason: `Typing refused: field "${clip(text)}" matches the deny list ("${hit}").` };
  // A newline presses Enter (submits) and a tab moves focus to another field,
  // so the rest of the value would land somewhere no check has looked at.
  if (/[\n\r\t]/.test(String(value ?? ''))) {
    return { ok: false, reason: 'Typing refused: the value contains a newline or tab, which would submit the form or move to another field. Use submit: true instead.' };
  }
  if (looksSecret(String(value ?? ''))) {
    return { ok: false, reason: 'Typing refused: the value looks like a secret (key, token or card number).' };
  }
  return { ok: true };
}

export function checkNavigation(url, origin) {
  let base;
  try { base = new URL(String(origin)); } catch { return { ok: false, reason: 'Navigation refused: the app origin is not a valid URL.' }; }
  if (!/^https?:$/.test(base.protocol)) return { ok: false, reason: 'Navigation refused: the app origin must be http or https.' };
  if (base.username || base.password) return { ok: false, reason: 'Navigation refused: the app origin contains credentials.' };
  if (typeof url !== 'string' || !url.trim()) return { ok: false, reason: 'Navigation refused: empty or invalid URL.' };
  let target;
  try { target = new URL(url.trim(), base); } catch { return { ok: false, reason: `Navigation refused: "${clip(url)}" is not a valid URL.` }; }
  if (!/^https?:$/.test(target.protocol)) return { ok: false, reason: `Navigation refused: ${target.protocol} URLs are not allowed.` };
  if (target.username || target.password) return { ok: false, reason: 'Navigation refused: the URL contains credentials.' };
  if (target.origin !== base.origin) return { ok: false, reason: `Navigation refused: ${target.origin} is not the app origin ${base.origin}.` };
  return { ok: true };
}

const DEFAULT_LOGIN_PATHS = ['/login', '/log-in', '/signin', '/sign-in'];

const cleanPath = (p) => p.toLowerCase().replace(/\/+$/, '') || '/';

// True when the page we landed on is a login page (the session expired).
// Compares the path only, so "?next=/login" on another page does not count.
// An unparseable URL returns false: checkNavigation is what refuses bad URLs.
export function isLoginRedirect(url, loginPaths = DEFAULT_LOGIN_PATHS) {
  let path;
  try { path = cleanPath(new URL(String(url), 'http://placeholder.invalid').pathname); } catch { return false; }
  if (!Array.isArray(loginPaths)) return false;
  return loginPaths.some((raw) => {
    if (typeof raw !== 'string' || !raw.trim()) return false;
    let p;
    try { p = cleanPath(new URL(raw.trim(), 'http://placeholder.invalid').pathname); } catch { return false; }
    return p !== '/' && (path === p || path.startsWith(`${p}/`));
  });
}
