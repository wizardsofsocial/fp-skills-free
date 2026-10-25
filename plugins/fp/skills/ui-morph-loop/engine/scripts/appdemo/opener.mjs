// The opener: one spoken line over the opening shot (plan.opener.narration, R40), with burned-in captions, and the
// music bed shifted to start on the first frame (R39). Pure functions, no files; timeline.mjs is the CLI around them
// and skills/fp-app-demo/assets/build.sh runs it.
//
//   - The line starts OPENER_LEAD_S (0.4 s) into the shot and must end at least OPENER_TAIL_S (0.3 s) before the shot
//     ends (openerFit); otherwise the build stops: shorten the line or use a longer clip.
//   - Word budget (R41): about OPENER_WORDS_PER_S (2) words a second of clip after the lead and the tail, so a 5 s
//     clip takes about 8 to 10 words (openerWordBudget). The fit check on the spoken length is the hard rule.
//   - The captions are burned in by a small composition whose only scene is the opener (openerTimeline), rendered by
//     the same template at each format's size: the clip drawn whole and still (no zoom, no push-in), no scene title,
//     no end card, captions in the lower band in the walkthrough's style and paging rules.
//   - shiftSections moves the bed's scene starts by the shot's length when the bed runs over shot + walkthrough.

import { paginate, layoutFor, VIEWPORT, FPS, DEFAULT_WPM, CAPTION_CHARS, VERTICAL_CAPTION_CHARS } from './compose.mjs';

export const OPENER_LEAD_S = 0.4;
export const OPENER_TAIL_S = 0.3;
export const OPENER_WORDS_PER_S = 2;
// The opener's line and scene id in vo.json and the opener timeline: a plan scene id cannot hold parentheses in practice,
// and nothing else reads it.
export const OPENER_SCENE = '(opener)';

const r3 = (n) => Math.round(n * 1000) / 1000;
const wordList = (words) => (Array.isArray(words) ? words : Array.isArray(words?.words) ? words.words : []);

/** The opener's line, trimmed ('' when the plan has none). */
export function openerText(plan) {
  return typeof plan?.opener?.narration === 'string' ? plan.opener.narration.trim() : '';
}

/** vo.json for the opener alone: { lines: [{ t: 0.4, until: clip - 0.3, text, scene: '(opener)' }] }, or no lines. */
export function openerVoScript(plan, clipS) {
  const text = openerText(plan);
  if (!text) return { lines: [] };
  return { lines: [{ t: OPENER_LEAD_S, until: r3(Number(clipS) - OPENER_TAIL_S), text, scene: OPENER_SCENE }] };
}

/** About how many words fit a clip of clipS seconds (R41). */
export function openerWordBudget(clipS) {
  const s = Number(clipS) - OPENER_LEAD_S - OPENER_TAIL_S;
  return Number.isFinite(s) && s > 0 ? Math.round(OPENER_WORDS_PER_S * s) : 0;
}

/** Whether a line spoken for spokenS seconds from 0.4 s ends at least 0.3 s before a clip of clipS seconds ends. */
export function openerFit(spokenS, clipS) {
  const endS = r3(OPENER_LEAD_S + Number(spokenS));
  const limitS = r3(Number(clipS) - OPENER_TAIL_S);
  const overS = r3(Math.max(0, endS - limitS));
  return { fits: endS <= limitS + 1e-6, endS, limitS, overS };
}

export function openerFitMessage(fit, clipS) {
  const spoken = fit.endS - OPENER_LEAD_S;
  return `the opener line is spoken for ${spoken.toFixed(2)} s from ${OPENER_LEAD_S} s, so it ends at ${fit.endS.toFixed(2)} s, `
    + `but it must end by ${fit.limitS.toFixed(2)} s (${OPENER_TAIL_S} s before the ${Number(clipS).toFixed(2)} s clip ends), `
    + `${fit.overS.toFixed(2)} s over: shorten the line or use a longer clip (about ${openerWordBudget(clipS)} words fit this one).`;
}

/** The bed's scene starts (seconds) moved later by offsetS, rounded to the millisecond. */
export function shiftSections(starts, offsetS) {
  return (starts || []).map((t) => r3(Number(t) + Number(offsetS)));
}

// Room a two-line caption needs below a letterboxed picture on a tall frame (the template's 9:16 caption at two lines
// plus its margins), in output pixels at 1080 wide.
export const TALL_CAPTION_ROOM = 260;

/** Where a picture of shape picture ({ width, height }) lands when fitted inside out (black bars, never stretched). */
export function fittedPicture(picture, out) {
  const ar = picture && picture.width > 0 && picture.height > 0 ? picture.width / picture.height : out.width / out.height;
  const width = Math.min(out.width, out.height * ar), height = width / ar;
  return { x: (out.width - width) / 2, y: (out.height - height) / 2, width, height };
}

/**
 * openerTimeline({ words, frameCount, out, fps, frames, picture }) -> a timeline for template.html with one scene, the opener:
 *   out       the output size (1920x1080 or 1080x1920); it is also the viewport, so the shot's frames, already fitted to
 *             out, are drawn 1:1.
 *   frames    the frame pattern, relative to the composition folder (e.g. opener-frames/16x9/f_%06d.jpg).
 *   words     align.py vo's words.json for the opener line (times on the video's clock, from 0.4 s).
 *   picture   the shot's own shape ({ width, height }, display pixels), to know where its letterbox bars are.
 * The scene lasts exactly frameCount frames. Taller than wide: pages at VERTICAL_CAPTION_CHARS, and opener.captionBelow
 * is where the captions start: just below the fitted picture when the bar under it has room for two lines (a wide
 * shot letterboxed in 9:16), else the bottom edge of the vertical cut's app band (layoutFor), where the walkthrough's
 * captions sit, over the picture (a shot that fills the tall frame).
 */
export function openerTimeline({ words, frameCount, out = VIEWPORT, fps = FPS, frames = 'opener-frames/f_%06d.jpg', picture } = {}) {
  const n = Number(frameCount);
  if (!Number.isInteger(n) || n <= 0) throw new Error('the opening shot has no frames to compose the opener over');
  const size = { width: out.width, height: out.height };
  const tall = size.height > size.width;
  const durationMs = Math.round((n * 1000) / fps);
  const endS = durationMs / 1000;
  const ws = wordList(words).slice().sort((a, b) => a.t0 - b.t0)
    .map((w) => ({ w: w.w, t0: r3(Math.min(w.t0, endS)), t1: r3(Math.min(Math.max(w.t1, w.t0), endS)), band: 'bottom' }));
  const captions = [];
  paginate(ws, tall ? VERTICAL_CAPTION_CHARS : CAPTION_CHARS).forEach((page, p) => {
    for (const w of page) captions.push({ w: w.w, t0: w.t0, t1: w.t1, band: 'bottom', page: p });
  });
  const opener = {};
  if (tall) {
    const { app } = layoutFor(size, VIEWPORT);
    const pic = fittedPicture(picture, size);
    const below = pic.y + pic.height;
    opener.captionBelow = size.height - below >= TALL_CAPTION_ROOM * (size.width / 1080) ? Math.round(below * 100) / 100 : app.y + app.height;
  }
  return {
    version: 1, viewport: size, fps, wpm: DEFAULT_WPM, durationMs, showTitles: false, opener,
    scenes: [{
      id: OPENER_SCENE, title: '', clip: 'intro/intro.mp4', frames, frameCount: n, clipDurationMs: durationMs,
      startMs: 0, durationMs, overrunMs: 0, narrationStartMs: Math.round(OPENER_LEAD_S * 1000),
      camera: [{ tMs: 0, cx: size.width / 2, cy: size.height / 2, zoom: 1 }], captions,
    }],
    endCard: null,
  };
}

/**
 * openerScreen(text, clipS, wpm = DEFAULT_WPM) -> { ok, words, budget, estS, limitS, message }
 * The screen run before anything is voiced or billed (R43): a line is refused when it has more than 1.5 times the
 * word budget, or when its estimated speaking time at wpm is longer than the room between the 0.4 s lead and the
 * 0.3 s tail. A line that passes can still overrun once voiced; the fit check on the spoken length catches that.
 */
export function openerScreen(text, clipS, wpm = DEFAULT_WPM) {
  const words = String(text || '').trim().split(/\s+/).filter(Boolean).length;
  const budget = openerWordBudget(clipS);
  const estS = r3((words * 60) / wpm);
  const limitS = r3(Number(clipS) - OPENER_LEAD_S - OPENER_TAIL_S);
  const ok = words <= 1.5 * budget && estS <= limitS + 1e-6;
  const message = ok ? '' : `the opener line has ${words} words, about ${estS.toFixed(2)} s spoken at ${wpm} words a minute, but the `
    + `${Number(clipS).toFixed(2)} s clip leaves ${limitS.toFixed(2)} s for it (from ${OPENER_LEAD_S} s to ${OPENER_TAIL_S} s before its end; `
    + `about ${budget} words fit): shorten the line or use a longer clip.`;
  return { ok, words, budget, estS, limitS, message };
}

// The teaser's share of the opener (R42): at most this long, so at least 9 of its 15 s are the app.
export const OPENER_TEASER_MAX_S = 6;
export const OPENER_TEASER_TAIL_S = 0.5;

/**
 * openerTeaserEnd({ words, clipS, fps }) -> seconds: where the teaser leaves the opener. The line's last word plus
 * OPENER_TEASER_TAIL_S, never past the clip, never past OPENER_TEASER_MAX_S, on a frame boundary, and never inside a
 * spoken word (pulled back to the start of the word it would cut).
 */
export function openerTeaserEnd({ words, clipS, fps = FPS } = {}) {
  const ws = wordList(words).slice().sort((a, b) => a.t0 - b.t0);
  const clipFrames = Math.round(Number(clipS) * fps);
  const lineEnd = ws.length ? Math.max(...ws.map((w) => Math.max(w.t0, w.t1))) : 0;
  const target = Math.min(Number(clipS), lineEnd + OPENER_TEASER_TAIL_S, OPENER_TEASER_MAX_S);
  let f = Math.min(clipFrames, Math.ceil(target * fps - 1e-6));
  if (f / fps > OPENER_TEASER_MAX_S + 1e-9) f = Math.floor(OPENER_TEASER_MAX_S * fps + 1e-6);
  const inWord = (s) => ws.find((w) => s > w.t0 + 1e-6 && s < w.t1 - 1e-6);
  for (let hit = inWord(f / fps); hit && f > 0; hit = inWord(f / fps)) f = Math.floor(hit.t0 * fps + 1e-6);
  return Math.round((f / fps) * 1e6) / 1e6;
}
