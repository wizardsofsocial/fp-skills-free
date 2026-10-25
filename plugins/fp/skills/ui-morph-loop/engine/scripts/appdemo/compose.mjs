// Composition timeline for app walkthroughs: where each recorded scene sits in
// the video, where the camera looks, and where the captions go. Pure functions,
// no files and no browser, so every rule is unit tested.
//
//   import { buildTimeline } from './compose.mjs';
//   const timeline = buildTimeline({ scenes, events, words, url: 'example.com' });
//   // write it as timeline.json next to the template (skills/fp-app-demo/assets/template.html)
//
// Inputs
//   scenes  [{ id, title, narration, clip, clipDurationMs }] in plan order.
//   events  record.mjs's events.json: [{ scene, tMs, type, x, y, rect, context? }],
//           tMs from the start of that scene's clip, rect (and context, the
//           row, list item or form around the control) in CSS pixels of the
//           1920x1080 viewport. rect may also carry block, lines and panes
//           (record.mjs frameLayout), used by the 9:16 camera only and never
//           copied into the timeline. Types: move (glide starts), hover (the cursor
//           arrives), click, type, and navigate (the page changed; x, y and
//           rect are null).
//   words   align.py vo's words.json ({ words: [...] } or the bare array):
//           [{ w, t0, t1, line }], seconds on the voice-over timeline. Lines
//           map, in order, to the scenes that HAVE narration (a scene without
//           narration has no voice-over line). Optional: without it the words
//           are timed from the narration text at wpm (default 140), which is
//           enough to preview before the voice-over exists.
//
// Timing rules
//   - Narration sets scene length: a scene lasts at least its clip and at
//     least NARRATION_LEAD_MS + the spoken line + NARRATION_TAIL_MS. When the
//     narration is longer, the extra is overrunMs and the template holds the
//     clip's last frame.
//   - A scene with no narration lasts at least DEFAULT_HOLD_MS (2.5 s), so a
//     silent scene is never a flash.
//   - The voice-over line of a narrated scene starts at narrationStartMs
//     (scene start + NARRATION_LEAD_MS). Use it as the line's t in vo.json and
//     the words that align.py returns land exactly on these caption times.
//   - Voice-over, two passes (scene lengths depend on spoken lengths, and the
//     line starts depend on scene lengths):
//       1. render the voice-over (voiceover.py or tts.py) from any first t
//          values, align.py vo for words.json;
//       2. buildTimeline({ ..., words, allowVoDrift: true });
//       3. write vo.json from the narrated scenes only, in order, with
//          t = narrationStartMs / 1000;
//       4. re-run voiceover.py (cache hit: same text, nothing billed) and
//          align.py vo;
//       5. buildTimeline({ ..., words }) again: the same lengths, so the same
//          starts. Without allowVoDrift it throws when a line starts more than
//          VO_DRIFT_MS (50 ms) from its narrationStartMs, naming the line.
//   - Caption times (t0, t1) are seconds on the whole video's timeline, the
//     same clock as the voice track. Every other time here is milliseconds.
//
// Camera rules
//   - Eases toward the target of each hover, click or type, starting PREROLL_MS
//     before the cursor arrives so the target is framed when it gets there.
//   - Never zooms past maxZoom (1.5): the clips are 3840x2160, so a 1.5x crop
//     is still 2560x1440 real pixels drawn down into 1920x1080, never upscaled.
//   - Keeps the target fully in frame; a target too big for a 1.5x window gets
//     less zoom, never a crop; the window never leaves the viewport.
//   - Targets that already fit in the current window do not move the camera.
//   - Goes back to the full, still view once nothing is happening (16:9; at
//     9:16 the wide view is too small to read on a phone, so the camera stays
//     on the last target and every scene, the first too, opens on its first).
//   - When the page changes (a navigate event) the zoom ends at the click that
//     caused it and the camera cuts (cut: true), never easing out over the new
//     page: straight onto the new page's first target when the cursor reaches
//     it within OPEN_LOOKAHEAD_MS, else to wide. Every scene after the first
//     opens the same way (the first scene opens wide, to set the scene), so a
//     new page is never held wide and empty while the cursor travels.
//   - Frames the control's context (events' context: the row, list item or
//     form it sits in) when the whole context still zooms in at least
//     minContextZoom (CONTEXT_MIN_ZOOM; VERTICAL_CONTEXT_MIN_ZOOM at 9:16), so a
//     zoom on a table cell shows its row and does not slice the next column or
//     the heading. A context too big for that keeps the control's zoom and
//     lines the window up with the context's left edge (where a row starts),
//     the control still fully in frame (frameTarget).
//   - Leaves a caption band free: a tall target gets less zoom and sits away
//     from one band (bandSafeCamera).
//
// Caption rules
//   - Words are grouped into pages of at most captionChars characters (two
//     short lines at 1920x1080), broken at sentence ends and pauses.
//   - Each page takes the top or bottom band, whichever does not overlap the
//     camera's target on screen while the page is up.
//
// Output shape (aspect: '16:9' default, or '9:16')
//   - 16:9: the app fills the frame and the caption bands are the top and
//     bottom BAND_FRAC strips over it. The timeline carries no layout field,
//     exactly as before the option existed.
//   - 9:16 (1080x1920): the app is drawn whole, full width (a 1080x607.5 band,
//     never stretched or cropped). Its camera follows the same rules on the
//     viewport (target fully in frame, window inside the viewport) but zooms up
//     to VERTICAL_MAX_ZOOM (2.5, R23; never past sourceZoomCap, so the 4K source
//     is only ever scaled down) and uses cameraFor, since no caption band lies
//     over the app. Its window then keeps the control's block (table, form,
//     card) whole when it fits and moves its edges off text lines and
//     sidebars where it can (frameVertical, R38). The caption
//     bands are the free areas above and below that band (layoutFor), so a
//     caption can never cover the app, let alone the target. Pages are shorter
//     (VERTICAL_CAPTION_CHARS) because the type is bigger on a phone. Timing is
//     identical, so one voice-over and one music bed serve both cuts.
//
// Teaser: teaserSegments(timeline, 15) picks [startMs, endMs] ranges of the
// composition for a 15 second cut (see its comment).

export const VIEWPORT = Object.freeze({ width: 1920, height: 1080 });
export const FPS = 30;
export const DEFAULT_WPM = 140;
export const DEFAULT_HOLD_MS = 2500;
export const NARRATION_LEAD_MS = 350;
export const NARRATION_TAIL_MS = 700;
export const END_CARD_MS = 3500;
export const PREROLL_MS = 800;
export const BAND_FRAC = 0.26;
export const CAPTION_CHARS = 64;
// How long the camera stays on a target after the last event on it. A click often opens another page, so the
// camera lets go almost at once: staying zoomed shows an empty corner of the new page.
export const DWELL_MS = Object.freeze({ click: 250, hover: 1400, type: 2600, move: 1200 });
// 9:16: the close-up is where the text can be read on a phone, so it is held longer (a click still lets go at once).
export const VERTICAL_DWELL_MS = Object.freeze({ ...DWELL_MS, hover: 2200, type: 3400, move: 1800 });
// After a page change or a scene start (not the first scene), the camera opens straight on the first target when the
// cursor reaches it within this long.
export const OPEN_LOOKAHEAD_MS = 4000;
// The camera frames a control's whole context (row, list item, form) only when that still zooms in at least this much.
export const CONTEXT_MIN_ZOOM = 1.1;
export const VERTICAL_CONTEXT_MIN_ZOOM = 1.8;
// How far (ms) a voice-over line may start from its scene's narrationStartMs.
export const VO_DRIFT_MS = 50;
// The page stays up this long after its last word (matches SK.captions).
const CAPTION_HOLD_MS = 350;
// The vertical cut: its output size, its page length, and where the app band's top edge sits (share of the height).
export const VERTICAL_OUT = Object.freeze({ width: 1080, height: 1920 });
export const VERTICAL_CAPTION_CHARS = 40;
export const APP_TOP_FRAC = 0.31;
// The vertical cut zooms closer (R23): its app band is only 1080 px wide, so UI text needs the extra zoom to be read
// on a phone. Capped again by sourceZoomCap so the source is never upscaled.
export const VERTICAL_MAX_ZOOM = 2.5;
// The recorded clips are this many times the viewport (3840x2160 for 1920x1080).
export const SOURCE_SCALE = 2;

/** The highest zoom at which the camera's window still holds at least as many source pixels as the app area is wide. */
export function sourceZoomCap(vp = VIEWPORT, app = vp, sourceScale = SOURCE_SCALE) {
  return Math.floor(((vp.width * sourceScale) / app.width) * 1000) / 1000;
}

const clamp = (x, a, b) => Math.min(b, Math.max(a, x));
const r2 = (n) => Math.round(n * 100) / 100;
const r3 = (n) => Math.round(n * 1000) / 1000;
const wide = (vp, tMs) => ({ tMs, cx: vp.width / 2, cy: vp.height / 2, zoom: 1 });

function overlapArea(a, b) {
  const w = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
  const h = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
  return w > 0 && h > 0 ? w * h : 0;
}

function clampRect(rect, vp) {
  const x0 = clamp(rect.x, 0, vp.width), y0 = clamp(rect.y, 0, vp.height);
  const x1 = clamp(rect.x + rect.width, 0, vp.width), y1 = clamp(rect.y + rect.height, 0, vp.height);
  return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
}

/** The visible window of a camera, in viewport pixels. */
export function windowOf({ cx, cy, zoom }, vp = VIEWPORT) {
  const width = vp.width / zoom, height = vp.height / zoom;
  return { x: cx - width / 2, y: cy - height / 2, width, height };
}

/** Where a viewport rect lands on the output frame (out = { width: W, height: H }) when the camera shows win. */
export function screenRect(rect, win, out = VIEWPORT) {
  const sx = out.width / win.width, sy = out.height / win.height;
  return { x: (rect.x - win.x) * sx, y: (rect.y - win.y) * sy, width: rect.width * sx, height: rect.height * sy };
}

/** The caption band on the output frame: the top or bottom BAND_FRAC of its height, full width. */
export function bandRect(band, out = VIEWPORT, { frac = BAND_FRAC } = {}) {
  const h = out.height * frac;
  return { x: 0, y: band === 'top' ? 0 : out.height - h, width: out.width, height: h };
}

/** The camera that frames rect: as close as maxZoom allows, the whole rect plus margin in view, inside the viewport. */
export function cameraFor(rect, vp = VIEWPORT, { maxZoom = 1.5, margin = 40 } = {}) {
  const r = clampRect(rect, vp);
  if (r.width <= 0 || r.height <= 0) return { cx: vp.width / 2, cy: vp.height / 2, zoom: 1 };
  const fit = Math.min(vp.width / (r.width + 2 * margin), vp.height / (r.height + 2 * margin));
  // Rounded down, so the window only ever grows: the rect stays in frame.
  const zoom = Math.floor(clamp(fit, 1, Math.max(1, maxZoom)) * 1000) / 1000;
  const w = vp.width / zoom, h = vp.height / zoom;
  const cx = clamp(r2(r.x + r.width / 2), w / 2, vp.width - w / 2);
  const cy = clamp(r2(r.y + r.height / 2), h / 2, vp.height - h / 2);
  return { cx, cy, zoom };
}

/**
 * Where things go on an output frame of size out, for a viewport of size vp:
 *   { app, bands: { top, bottom } }, all in output pixels. app is where the camera's window is drawn.
 * Same shape as the viewport: app is the whole frame, bands are bandRect's strips over it.
 * Taller (9:16): app is a full-width band of the viewport's shape, its top at APP_TOP_FRAC of the height, and the
 * bands are the free areas above and below it.
 */
export function layoutFor(out = VIEWPORT, vp = VIEWPORT) {
  const W = out.width, H = out.height;
  const appH = (W * vp.height) / vp.width;
  if (Math.abs(appH - H) < 1e-6) return { app: { x: 0, y: 0, width: W, height: H }, bands: { top: bandRect('top', out), bottom: bandRect('bottom', out) } };
  if (appH > H) throw new Error(`an output of ${W}x${H} is wider than the ${vp.width}x${vp.height} viewport: only 16:9 and 9:16 are laid out`);
  const y = clamp(Math.round(H * APP_TOP_FRAC), 0, Math.floor(H - appH));
  return {
    app: { x: 0, y, width: W, height: appH },
    bands: { top: { x: 0, y: 0, width: W, height: y }, bottom: { x: 0, y: y + appH, width: W, height: H - y - appH } },
  };
}

// Where a viewport rect lands on the output when the camera shows win: inside the app area of the layout. When the
// app does not fill the frame (9:16), the part of the rect outside the window is not drawn, so it is clipped to the
// app area: a control just off camera must not claim a caption band around the app.
function onOutput(rect, win, layout) {
  const { app } = layout;
  const s = screenRect(rect, win, app);
  if (!app.x && !app.y) return s;
  const x0 = clamp(s.x + app.x, app.x, app.x + app.width), x1 = clamp(s.x + app.x + s.width, app.x, app.x + app.width);
  const y0 = clamp(s.y + app.y, app.y, app.y + app.height), y1 = clamp(s.y + app.y + s.height, app.y, app.y + app.height);
  return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
}

// Band choice against several rects on the output frame. Hard rects (the
// camera's target) must not be covered; soft ones (a target the camera has
// just left, still on screen) are avoided when possible. Bottom is preferred.
function chooseBand(hard, soft, layout) {
  const cost = (band, rects) => rects.reduce((s, r) => s + overlapArea(r, layout.bands[band]), 0);
  const options = ['bottom', 'top'];
  for (const b of options) if (cost(b, hard) === 0 && cost(b, soft) === 0) return b;
  for (const b of options) if (cost(b, hard) === 0) return b;
  return cost('top', hard) < cost('bottom', hard) ? 'top' : 'bottom';
}

/** The caption band ('top' or 'bottom') that does not overlap targetRect (output-frame pixels). Bottom unless covered. */
export function pickBand(targetRect, out = VIEWPORT) {
  return chooseBand([targetRect], [], layoutFor(out, out));
}

// Clearance (viewport px) between a framed target and a caption band.
const BAND_CLEAR = 16;

// cameraFor, but leaving a caption band free: the zoom is capped so the
// target fits the frame minus one band, and the window shifts so the target
// sits away from that band (bottom band preferred). Same guarantees as
// cameraFor: never above its zoom, rect fully in frame, window inside the
// viewport. A target too tall for any free band at 1x keeps cameraFor's
// framing (captions then take the band with the least overlap).
export function bandSafeCamera(rect, vp = VIEWPORT, opts = {}) {
  const base = cameraFor(rect, vp, opts);
  const r = clampRect(rect, vp);
  if (r.width <= 0 || r.height <= 0) return base;
  for (let zoom = base.zoom; ; zoom = Math.max(1, Math.floor((zoom - 0.02) * 1000) / 1000)) {
    const w = vp.width / zoom, h = vp.height / zoom, band = h * BAND_FRAC;
    const centred = clamp(r.y + r.height / 2 - h / 2, 0, vp.height - h);
    const ranges = {
      bottom: [r.y + r.height - (h - band) + BAND_CLEAR, r.y - BAND_CLEAR],
      top: [r.y + r.height - h + BAND_CLEAR, r.y - band - BAND_CLEAR],
    };
    for (const which of ['bottom', 'top']) {
      const lo = Math.max(0, ranges[which][0]), hi = Math.min(vp.height - h, ranges[which][1]);
      if (lo <= hi) {
        const y0 = clamp(centred, lo, hi);
        return { cx: clamp(r2(r.x + r.width / 2), w / 2, vp.width - w / 2), cy: y0 + h / 2, zoom };
      }
    }
    if (zoom <= 1) return base;
  }
}

/**
 * frameTarget(rect, context, vp, { maxZoom, margin, bandSafe = true, minContextZoom }) -> { cx, cy, zoom }
 * The camera for a control (rect) inside its context (a row, list item or form; null for none). The whole context is
 * framed when that zooms at least minContextZoom (or as much as the control alone would); otherwise the control's own
 * framing, its window slid sideways to start at the context's left edge (or to centre a context that fits across).
 * Same guarantees as cameraFor: the control fully in frame, the window inside the viewport, never above maxZoom.
 */
export function frameTarget(rect, context, vp = VIEWPORT, opts = {}) {
  if (opts.vertical) return frameVertical(rect, context, vp, opts);
  return frameContext(rect, context, vp, opts);
}

function frameContext(rect, context, vp, opts) {
  const { bandSafe = true, minContextZoom = CONTEXT_MIN_ZOOM, margin = 40 } = opts;
  const frame = (r) => (bandSafe ? bandSafeCamera(r, vp, opts) : cameraFor(r, vp, opts));
  const base = frame(rect);
  const r = clampRect(rect, vp);
  const c = context ? clampRect(context, vp) : null;
  if (!c || c.width <= 0 || c.height <= 0 || r.width <= 0 || r.height <= 0) return base;
  const holds = c.x <= r.x + 1 && c.y <= r.y + 1 && c.x + c.width >= r.x + r.width - 1 && c.y + c.height >= r.y + r.height - 1;
  if (!holds) return base;
  const whole = frame(c);
  if (whole.zoom >= Math.min(minContextZoom, base.zoom)) return whole;
  const w = vp.width / base.zoom;
  let x0 = c.width + 2 * margin <= w ? c.x + c.width / 2 - w / 2 : c.x - margin;
  const lo = r.x + r.width + margin - w, hi = r.x - margin;
  if (lo > hi) return base;
  x0 = clamp(clamp(x0, lo, hi), 0, vp.width - w);
  return { ...base, cx: r2(x0 + w / 2) };
}

// ---------------------------------------------------------------- 9:16 framing (R38)

// A line kept in frame must sit at least EDGE_CLEAR viewport px inside the window: the template fades the band's
// edges (about 14 px of the page at the close zoom) and, while a scene holds its last frame, eases in 1.5% (about
// 6 px more per edge); LINE_GAP is the room a window edge leaves next to a line it takes in
// or leaves out; BLOCK_PAD the least room kept around a block framed whole.
export const EDGE_CLEAR = 20;
const LINE_GAP = EDGE_CLEAR + 2;
const BLOCK_PAD = 8;
// Costs: one text line sliced at the band edge outweighs moving or zooming out a little; a zoom given up costs
// ZOOM_COST per unit of (z0 / z - 1), sliding a whole window away from the preferred spot costs SLIDE_COST.
const CUT_COST = 1000;
const ZOOM_COST = 1500;
const SLIDE_COST = 200;
// A sidebar is app chrome, not the subject: showing all of it costs a little, per share of the window it takes.
const PANE_COST = 300;
const ZOOM_STEP = 0.05;

const holdsRect = (o, r) => o.x <= r.x + 1 && o.y <= r.y + 1 && o.x + o.width >= r.x + r.width - 1 && o.y + o.height >= r.y + r.height - 1;
const asBox = (v) => (Array.isArray(v) ? { x: v[0], y: v[1], width: v[2], height: v[3] } : v);
const validBox = (b) => b && [b.x, b.y, b.width, b.height].every(Number.isFinite) && b.width > 0 && b.height > 0;

/**
 * cutLines(win, lines, panes, clear = EDGE_CLEAR) -> how many text lines the window slices (partly in, partly out,
 * or in but closer than clear px to an edge, where the band's fade would eat it), plus how many side panes (a
 * sidebar or nav, full height) one of its side edges runs through, leaving a bare sliver of it.
 * lines and panes are { x, y, width, height } or [x, y, width, height] in viewport pixels.
 */
export function cutLines(win, lines = [], panes = [], clear = EDGE_CLEAR) {
  const x1 = win.x + win.width, y1 = win.y + win.height, e = 0.5;
  let n = 0;
  for (const raw of lines) {
    const l = asBox(raw);
    const ix = Math.min(l.x + l.width, x1) - Math.max(l.x, win.x), iy = Math.min(l.y + l.height, y1) - Math.max(l.y, win.y);
    if (ix <= e || iy <= e) continue;
    if (l.x >= win.x + clear - e && l.y >= win.y + clear - e && l.x + l.width <= x1 - clear + e && l.y + l.height <= y1 - clear + e) continue;
    n++;
  }
  for (const raw of panes) {
    const p = asBox(raw);
    if (Math.min(p.y + p.height, y1) - Math.max(p.y, win.y) <= e) continue;
    const inside = (x) => x > p.x + e && x < p.x + p.width - e;
    if (inside(win.x) || inside(x1)) n++;
  }
  return n;
}

/**
 * frameVertical(rect, context, vp, opts) -> { cx, cy, zoom }: the 9:16 camera (frameTarget with opts.vertical).
 * rect may carry what the recorder saw around the control: rect.block (the table, form, list, section or card it
 * sits in), rect.lines (the text lines and controls on screen) and rect.panes (sidebars). The zoom starts at the
 * close framing (the context's, or the control's own) and the window then:
 *   - holds the whole block, centred, when the block fits (along each axis on its own), zooming out as far as
 *     minContextZoom for that when it does not fit at the close framing; otherwise starts at the
 *     block's left edge and at the context row's top (less the margin), never running past the block's far edge;
 *   - slides, or zooms out a little (never below minContextZoom), when that leaves fewer text lines sliced at the
 *     band edge, and never leaves a sidebar as a bare sliver at a side when that can be avoided (it would rather
 *     leave the sidebar out than show all of it).
 * The control is always fully in frame, the window inside the viewport, the zoom never above maxZoom.
 */
export function frameVertical(rect, context, vp = VIEWPORT, opts = {}) {
  const { margin = 40, minContextZoom = VERTICAL_CONTEXT_MIN_ZOOM } = opts;
  const start = frameContext(rect, context, vp, { ...opts, bandSafe: false });
  const r = clampRect(rect, vp);
  if (r.width <= 0 || r.height <= 0) return start;
  const keep = (b) => { if (!validBox(b)) return null; const c = clampRect(b, vp); return c.width > 0 && c.height > 0 && holdsRect(c, r) ? c : null; };
  const ctx = keep(context);
  const block = keep(rect.block);
  const lines = (Array.isArray(rect.lines) ? rect.lines : []).map(asBox).filter(validBox);
  const panes = (Array.isArray(rect.panes) ? rect.panes : []).map(asBox).filter(validBox);
  const z0 = start.zoom;
  const floor = Math.min(z0, minContextZoom);
  const zooms = [];
  for (let z = z0; z >= floor - 1e-9; z = Math.floor((z - ZOOM_STEP) * 1000) / 1000) zooms.push(z);
  if (block) {
    const bz = cameraFor(block, vp, { maxZoom: z0, margin: BLOCK_PAD }).zoom;
    if (bz >= floor && bz < z0) {
      // The block fits whole at a zoom the cut allows: never frame it closer, or part of it (a card's figures
      // column, say) is left out of the window entirely, which cutLines cannot see.
      const fits = zooms.filter((z) => z <= bz + 1e-9);
      zooms.length = 0;
      zooms.push(...fits);
      if (!zooms.includes(bz)) zooms.unshift(bz);
    }
  }
  let best = null;
  for (const zoom of zooms) {
    const w = vp.width / zoom, h = vp.height / zoom;
    if (r.width > w || r.height > h) continue;
    // One axis: the range the window's start may take, and where it would rather be.
    const axis = (pos, len, size, vpLen, startPos) => {
      const room = Math.min(16, (size - r[len]) / 2);
      let lo = Math.max(0, r[pos] + r[len] + room - size), hi = Math.min(vpLen - size, r[pos] - room);
      let pref;
      if (block && block[len] + 2 * BLOCK_PAD <= size) {
        const blo = Math.max(lo, block[pos] + block[len] + BLOCK_PAD - size), bhi = Math.min(hi, block[pos] - BLOCK_PAD);
        if (blo <= bhi) { lo = blo; hi = bhi; }
        pref = block[pos] + block[len] / 2 - size / 2;
      } else if (block) {
        // Too big for the window: start at its left edge, or the context row's top; never past its far edge.
        const edge = pos === 'x' ? block.x : (ctx && ctx[len] < block[len] ? ctx.y : r.y);
        pref = clamp(edge - margin, block[pos] - margin, block[pos] + block[len] + margin - size);
      } else {
        pref = startPos - size / 2;
      }
      return { lo, hi, pref: clamp(pref, lo, hi) };
    };
    const ax = axis('x', 'width', w, vp.width, start.cx);
    const ay = axis('y', 'height', h, vp.height, start.cy);
    if (ax.lo > ax.hi + 1e-6 || ay.lo > ay.hi + 1e-6) continue;
    const near = lines.filter((l) => l.x + l.width > r.x - w && l.x < r.x + r.width + w && l.y + l.height > r.y - h && l.y < r.y + r.height + h);
    const cost = (x, y) => CUT_COST * cutLines({ x, y, width: w, height: h }, near, panes)
      + SLIDE_COST * (Math.abs(x - ax.pref) / w + Math.abs(y - ay.pref) / h) + ZOOM_COST * (z0 / zoom - 1)
      + PANE_COST * panes.reduce((t, p) => t + Math.max(0, Math.min(p.x + p.width, x + w) - Math.max(p.x, x)), 0) / w;
    // Where a window edge lands just clear of something: before or after each line (and each pane, across).
    const spots = (a, pos, len, size, extra) => {
      const out = [a.pref, a.lo, a.hi];
      for (const l of [...near, ...extra]) {
        const s0 = l[pos], s1 = l[pos] + l[len];
        out.push(s0 - LINE_GAP, s1 + LINE_GAP, s0 - LINE_GAP - size, s1 + LINE_GAP - size);
      }
      return [...new Set(out.map((v) => clamp(v, a.lo, a.hi)))];
    };
    const xs = spots(ax, 'x', 'width', w, panes), ys = spots(ay, 'y', 'height', h, []);
    let x = ax.pref, y = ay.pref;
    for (let pass = 0; pass < 2; pass++) {
      y = ys.reduce((b, v) => (cost(x, v) < cost(x, b) ? v : b), y);
      x = xs.reduce((b, v) => (cost(v, y) < cost(b, y) ? v : b), x);
    }
    const c = cost(x, y);
    if (!best || c < best.c - 1e-9) best = { c, cam: { cx: r2(x + w / 2), cy: r2(y + h / 2), zoom } };
  }
  if (!best) return start;
  // r2 may move an edge by up to 0.005 px: keep the window inside the viewport.
  const { cam } = best, w = vp.width / cam.zoom, h = vp.height / cam.zoom;
  return { cx: clamp(cam.cx, w / 2, vp.width - w / 2), cy: clamp(cam.cy, h / 2, vp.height - h / 2), zoom: cam.zoom };
}

// ---------------------------------------------------------------- camera track

// A target as the timeline keeps it: the recorder's framing data (rect.block, rect.lines, rect.panes) is left out.
const targetOf = ({ block: _b, lines: _l, panes: _p, ...r }) => r;
const sameRect = (a, b) => Math.abs(a.x - b.x) <= 2 && Math.abs(a.y - b.y) <= 2 && Math.abs(a.width - b.width) <= 2 && Math.abs(a.height - b.height) <= 2;
const ARRIVING = new Set(['hover', 'click', 'type']);

// Keys for one stretch of a scene with no page change in it, [from, to).
function shotKeys(evs, vp, from, to, camOpts) {
  const dwell = camOpts.dwell || DWELL_MS;
  // 1. Consecutive events on one control are one target.
  const groups = [];
  for (const e of evs) {
    const g = groups.at(-1);
    if (g && sameRect(g.rect, e.rect)) { g.last = e.tMs; g.lastType = e.type; g.context ??= e.context || null; if (g.arrive == null && ARRIVING.has(e.type)) g.arrive = e.tMs; continue; }
    groups.push({ rect: e.rect, context: e.context || null, first: e.tMs, arrive: ARRIVING.has(e.type) ? e.tMs : null, last: e.tMs, lastType: e.type });
  }
  for (const g of groups) g.arrive ??= g.first + 700;

  // 2. Targets that fit the window already on screen, without a break in between, are one shot.
  const shots = [];
  for (const g of groups) {
    const s = shots.at(-1);
    const gapOk = s && g.arrive - PREROLL_MS <= s.last + (dwell[s.lastType] ?? 1200) + 600;
    // Inside the window within a pixel: an exact area match fails on fractional rects (150.8 + 442.5 - 150.8).
    if (s && gapOk && g.rect.width * g.rect.height > 0 && holdsRect(s.win, g.rect)) {
      s.last = g.last; s.lastType = g.lastType; s.subs.push(g); continue;
    }
    // 9:16 has no caption band over the app, so it frames with plain cameraFor (no zoom given up to a band).
    const cam = frameTarget(g.rect, g.context, vp, camOpts);
    shots.push({ ...g, cam, win: windowOf(cam, vp), subs: [] });
  }

  // 3. Keyframes: ease in ahead of each shot, back to wide when idle.
  const keys = [wide(vp, from)];
  shots.forEach((s, i) => {
    const prev = shots[i - 1];
    const tMs = Math.round(Math.max(from, s.arrive - PREROLL_MS, prev ? prev.last + 250 : 0, keys.at(-1).tMs + 1));
    if (tMs < to) keys.push({ tMs, ...s.cam, target: targetOf(s.rect) });
    // A later target in the same window: the camera stays put, the key only records the new target (for captions).
    for (const sub of s.subs) {
      const at = Math.round(Math.max(sub.arrive - PREROLL_MS, keys.at(-1).tMs + 1));
      if (at < to) keys.push({ tMs: at, ...s.cam, target: targetOf(sub.rect) });
    }
    const release = s.last + (dwell[s.lastType] ?? 1200);
    const next = shots[i + 1];
    if (camOpts.release !== false && (!next || next.arrive - PREROLL_MS > release + 600) && release < to && release > keys.at(-1).tMs) keys.push(wide(vp, Math.round(release)));
  });
  // Open straight on the first target (no wide hold on a page the cursor has not reached yet).
  if (camOpts.openFramed && keys[1]?.target && shots[0].arrive - from <= OPEN_LOOKAHEAD_MS) keys.splice(0, 2, { ...keys[1], tMs: from });
  // The first key is already wide: drop a wide key that changes nothing.
  return keys.filter((k, i) => i === 0 || k.target || keys[i - 1].target);
}

// The whole scene: a page change (navigate event) splits it. The zoomed shot
// ends at the click or typing that caused the change (nothing in between, or
// the old zoom would show over the new page), and the camera cuts to wide at
// the navigate (cut: true, no easing) before framing the new page's targets.
function cameraTrack(evs, navs, vp, durationMs, camOpts) {
  const cuts = [...new Set(navs.filter((t) => t > 0 && t < durationMs).map(Math.round))].sort((a, b) => a - b);
  const bounds = [0, ...cuts, durationMs];
  const keys = [];
  for (let i = 0; i < bounds.length - 1; i++) {
    const from = bounds[i], to = bounds[i + 1];
    const seg = evs.filter((e) => e.tMs >= from && e.tMs < to);
    let k = shotKeys(seg, vp, from, to, { ...camOpts, openFramed: i > 0 || camOpts.openFramed });
    const cause = i < bounds.length - 2 ? seg.filter((e) => e.type === 'click' || e.type === 'type').at(-1) : null;
    if (cause) k = k.filter((x) => x.tMs <= cause.tMs);
    if (i > 0) k[0] = { ...k[0], cut: true };
    keys.push(...k);
  }
  return keys;
}

// ---------------------------------------------------------------- words and captions

const wordList = (words) => (Array.isArray(words) ? words : Array.isArray(words?.words) ? words.words : []);

// The same spread as align.py vo: each word gets time in proportion to its letters (+2).
function spreadText(text, secs) {
  const ws = text.split(/\s+/).filter(Boolean);
  const weight = ws.map((x) => x.replace(/[^\p{L}\p{N}']/gu, '').length + 2);
  const tot = weight.reduce((a, b) => a + b, 0) || 1;
  let t = 0;
  return ws.map((w, i) => { const d = (secs * weight[i]) / tot; const o = { w, t0: t, t1: t + d * 0.92 }; t += d; return o; });
}

// The band free of the camera's target from t0 to t1 (ms in the scene): the
// keyframe in force at t0 and any that starts before t1.
function bandFor(t0, t1, camera, vp, layout) {
  const hard = [], soft = [];
  camera.forEach((k, i) => {
    const inForce = k.tMs <= t0 && (camera[i + 1]?.tMs ?? Infinity) > t0;
    if (!inForce && !(k.tMs > t0 && k.tMs <= t1)) return;
    const win = windowOf(k, vp);
    const prevWin = i > 0 ? windowOf(camera[i - 1], vp) : win;
    if (k.target) {
      // where the target is once framed, and where it starts the move from
      hard.push(onOutput(k.target, win, layout));
      soft.push(onOutput(k.target, prevWin, layout));
    } else if (i > 0 && camera[i - 1].target) {
      // the camera has let go, but the control it showed is still on screen
      soft.push(onOutput(camera[i - 1].target, win, layout), onOutput(camera[i - 1].target, prevWin, layout));
    }
  });
  return chooseBand(hard, soft, layout);
}

// Pages break at the size limit, sentence ends, long clauses, pauses, and
// wherever the free band changes (so a page never has to jump mid-read).
// Exported for the opener's captions (opener.mjs), which follow the same rules.
export function paginate(ws, maxChars) {
  const pages = [];
  let cur = [];
  for (const w of ws) {
    const prev = cur.at(-1);
    const text = [...cur.map((x) => x.w), w.w].join(' ');
    const sentenceEnd = prev && /[.?!]["')\]]?$/.test(prev.w) && cur.length >= 3;
    const clauseEnd = prev && /[,;:]$/.test(prev.w) && cur.map((x) => x.w).join(' ').length >= maxChars * 0.55;
    const pause = prev && w.t0 - prev.t1 > 0.45;
    const moved = prev && w.band !== prev.band;
    if (cur.length && (text.length > maxChars || sentenceEnd || clauseEnd || pause || moved)) { pages.push(cur); cur = []; }
    cur.push(w);
  }
  if (cur.length) pages.push(cur);
  return pages;
}

function captionsFor(scene, relWords, camera, vp, maxChars, layout) {
  const endS = (scene.startMs + scene.durationMs) / 1000;
  const base = scene.narrationStartMs / 1000;
  const inScene = (sec) => sec * 1000 - scene.startMs;
  const abs = relWords.map((w) => {
    const t0 = r3(Math.min(base + w.t0, endS)), t1 = r3(Math.min(base + w.t1, endS));
    return { w: w.w, t0, t1, band: bandFor(inScene(t0), inScene(t1), camera, vp, layout) };
  });
  const out = [];
  paginate(abs, maxChars).forEach((page, p) => {
    // The page is on screen from its first word until its hold after the last.
    let band = bandFor(inScene(page[0].t0), inScene(page.at(-1).t1) + CAPTION_HOLD_MS, camera, vp, layout);
    if (band !== page[0].band && bandFor(inScene(page[0].t0), inScene(page.at(-1).t1), camera, vp, layout) === page[0].band) band = page[0].band;
    for (const w of page) out.push({ w: w.w, t0: w.t0, t1: w.t1, band, page: p });
  });
  return out;
}

// ---------------------------------------------------------------- timeline

/**
 * buildTimeline({ scenes, events, words, wpm, url, endTitle, viewport, captionChars, maxZoom, margin, allowVoDrift, aspect }) -> Timeline
 *   { version, viewport, fps, wpm, durationMs,
 *     scenes: [{ id, title, clip, clipDurationMs, startMs, durationMs, overrunMs, narrationStartMs,
 *                camera: [{ tMs, cx, cy, zoom, target?, cut? }], captions: [{ w, t0, t1, band, page }] }],
 *     endCard: { startMs, durationMs, url, title } | null }
 *   aspect '9:16' adds { aspect, out: { width, height }, layout: layoutFor(out) } and pages at VERTICAL_CAPTION_CHARS
 *   (unless captionChars is given), and zooms up to VERTICAL_MAX_ZOOM; timing is the 16:9 timing.
 */
export function buildTimeline({
  scenes = [], events = [], words, wpm = DEFAULT_WPM, url = null, endTitle = null,
  viewport = VIEWPORT, captionChars, maxZoom, margin = 40, allowVoDrift = false, aspect = '16:9',
} = {}) {
  const vp = { width: viewport.width, height: viewport.height };
  if (aspect !== '16:9' && aspect !== '9:16') throw new Error(`aspect must be 16:9 or 9:16, not ${aspect}`);
  const vertical = aspect === '9:16';
  const outSize = vertical ? { ...VERTICAL_OUT } : vp;
  const layout = layoutFor(outSize, vp);
  captionChars ??= vertical ? VERTICAL_CAPTION_CHARS : CAPTION_CHARS;
  maxZoom ??= vertical ? VERTICAL_MAX_ZOOM : 1.5;
  if (vertical) maxZoom = Math.min(maxZoom, sourceZoomCap(vp, layout.app));
  const narrated = scenes.filter((s) => String(s.narration || '').trim());
  const all = wordList(words);

  // One list of words per narrated scene, times relative to the line's first word (s).
  let lines;
  if (all.length) {
    const byLine = new Map();
    for (const w of all) { if (!byLine.has(w.line)) byLine.set(w.line, []); byLine.get(w.line).push(w); }
    const groups = [...byLine.entries()].sort((a, b) => Number(a[0]) - Number(b[0])).map(([, ws]) => ws.slice().sort((a, b) => a.t0 - b.t0));
    if (groups.length !== narrated.length) {
      throw new Error(`words.json has ${groups.length} voice-over lines but the plan has ${narrated.length} narrated scene${narrated.length === 1 ? '' : 's'}: re-run the voice-over and align.py for this plan.`);
    }
    lines = groups.map((ws) => {
      const z = ws[0].t0;
      const rel = ws.map((w) => ({ w: w.w, t0: w.t0 - z, t1: Math.max(w.t1, w.t0) - z }));
      rel.line = ws[0].line; rel.startS = z;
      return rel;
    });
  } else {
    const rate = Number(wpm) > 0 ? Number(wpm) : DEFAULT_WPM;
    lines = narrated.map((s) => { const text = String(s.narration).trim(); return spreadText(text, (text.split(/\s+/).length / rate) * 60); });
  }
  const lineOf = new Map(narrated.map((s, i) => [s, lines[i]]));

  let cursor = 0;
  const out = scenes.map((s, si) => {
    const clipMs = Math.max(0, Number(s.clipDurationMs) || 0);
    const rel = lineOf.get(s);
    let durationMs, narrationStartMs = null;
    if (rel && rel.length) {
      const spokenMs = (rel.at(-1).t1 - rel[0].t0) * 1000;
      durationMs = Math.max(clipMs, Math.ceil(NARRATION_LEAD_MS + spokenMs + NARRATION_TAIL_MS));
      narrationStartMs = cursor + NARRATION_LEAD_MS;
    } else {
      durationMs = Math.max(clipMs, DEFAULT_HOLD_MS);
    }
    if (rel && rel.startS != null && !allowVoDrift && Math.abs(rel.startS * 1000 - narrationStartMs) > VO_DRIFT_MS) {
      throw new Error(`voice-over line ${rel.line} starts at ${rel.startS.toFixed(3)} s but its scene "${s.id}" has narrationStartMs ${narrationStartMs} (${(narrationStartMs / 1000).toFixed(3)} s): `
        + 'write vo.json with t = narrationStartMs / 1000, re-run voiceover.py and align.py, then build again (pass allowVoDrift: true only for the first pass).');
    }
    const mine = (events || []).filter((e) => e && e.scene === s.id && Number.isFinite(e.tMs));
    const evs = mine.filter((e) => e.rect && e.type !== 'navigate').sort((a, b) => a.tMs - b.tMs);
    const navs = mine.filter((e) => e.type === 'navigate').map((e) => e.tMs);
    const camera = cameraTrack(evs, navs, vp, durationMs, {
      // 9:16: a wide view of the app is too small to read on a phone, so the camera opens on the first target in
      // every scene (the first too) and stays on the last target instead of going back to wide.
      maxZoom, margin, bandSafe: !vertical, dwell: vertical ? VERTICAL_DWELL_MS : DWELL_MS, openFramed: vertical || si > 0, release: !vertical,
      minContextZoom: vertical ? VERTICAL_CONTEXT_MIN_ZOOM : CONTEXT_MIN_ZOOM,
      ...(vertical ? { vertical: true } : {}),
    });
    const scene = {
      id: s.id, title: s.title || '', clip: s.clip, clipDurationMs: clipMs,
      startMs: cursor, durationMs, overrunMs: durationMs - clipMs, narrationStartMs, camera, captions: [],
    };
    if (rel && rel.length) scene.captions = captionsFor(scene, rel, camera, vp, captionChars, layout);
    cursor += durationMs;
    return scene;
  });

  const endCard = url ? { startMs: cursor, durationMs: END_CARD_MS, url: String(url), title: endTitle ? String(endTitle) : '' } : null;
  const tl = { version: 1, viewport: vp, fps: FPS, wpm: Number(wpm) > 0 ? Number(wpm) : DEFAULT_WPM, durationMs: cursor + (endCard ? END_CARD_MS : 0), scenes: out, endCard };
  return vertical ? { ...tl, aspect, out: outSize, layout } : tl;
}

// ---------------------------------------------------------------- teaser

// After the last word kept, this much of the scene stays in (the voice dies away, the result stays on screen).
export const TEASER_TAIL_MS = 450;
// No scene segment shorter than this (a flash is worse than leaving the scene out).
export const TEASER_MIN_MS = 1500;
// How much of the end card closes the teaser (its URL is fully in by then), and how long a silent hook holds.
export const TEASER_END_MS = 2500;
export const TEASER_SILENT_HOOK_MS = 3000;
// The end card's part starts this far in, once the card has faded in over the last scene's last frame: that frame
// may belong to a scene the teaser left out.
export const TEASER_END_SKIP_MS = 500;

// Cut points of one scene, from its start, as [endMs, rank]: after the whole line (rank 3), a sentence (2), a clause
// (1) or any word (0). Each is the last frame boundary after that word's end and before the next word starts (or,
// after the line, before the tail runs out or the scene ends), so no cut lands inside a spoken word. A word with no
// frame boundary in its gap gives no cut point.
function cutPoints(s, frame) {
  const end = s.startMs + s.durationMs;
  const words = s.captions || [];
  return words.flatMap((w, i) => {
    const t1 = w.t1 * 1000, next = words[i + 1];
    const limit = next ? Math.min(next.t0 * 1000, end) : Math.min(t1 + TEASER_TAIL_MS, end);
    const at = frame.floor(limit);
    if (at < t1 - 1e-6) return [];
    const rank = !next ? 3 : /[.?!]["')\]]?$/.test(w.w) ? 2 : /[,;:]$/.test(w.w) ? 1 : 0;
    return [[at, rank]];
  });
}

// The best segment of scene s from its start within budget ms: the highest rank (at least minRank) that fits, at
// least minMs long, and the latest cut of that rank. null when nothing fits.
function sceneSegment(s, budget, frame, { minMs = TEASER_MIN_MS, minRank = 0 } = {}) {
  const a = frame.ceil(s.startMs);
  const fits = cutPoints(s, frame).filter(([b, r]) => r >= minRank && b - a <= budget + 1e-6 && b - a >= minMs - 1e-6);
  if (!fits.length) return null;
  const top = Math.max(...fits.map(([, r]) => r));
  return [a, fits.filter(([, r]) => r === top).at(-1)[0]];
}

/**
 * teaserSegments(timeline, seconds = 15) -> [[startMs, endMs], ...] in playback order, on the composition's clock.
 *   - It ends on the answer (R46): the scene timeline.teaserAnswer names (R48; the plan's video.teaserAnswer), else
 *     the last scene. Scenes after it are left out. The answer, when it has a voice line, is always in, from its start to the end
 *     of its line (or, when the whole line cannot fit, to the end of its last sentence that does). Its place is
 *     taken before anything else; when even its first sentence cannot fit, it throws (say so; never cut a line
 *     inside a word).
 *   - The hook (the first scene) opens it when it fits in what is left, from its start to the end of its line (cut
 *     at a sentence or word boundary if the line alone is too long; a silent hook holds TEASER_SILENT_HOOK_MS).
 *   - Then the strongest middle scenes by narration weight (spoken length), each from its start to the end of its
 *     line, in their original order; with room left, a longer scene's opening sentence. When time is short the
 *     middle scenes go first, never the answer. A scene that does not fit is left out, never sped up or cut
 *     mid-sentence.
 *   - The end card closes it (TEASER_END_MS) when there is one and room for it.
 *   - Every cut is on a frame boundary and never inside a spoken word (captions' word times), every segment lies
 *     inside one scene (or the end card), segments never overlap, and the total is at most seconds.
 *   An empty timeline gives [].
 */
export function teaserSegments(timeline, seconds = 15) {
  const fps = timeline?.fps || FPS;
  const step = 1000 / fps;
  const frame = { floor: (ms) => (Math.floor(ms / step + 1e-6) * 1000) / fps, ceil: (ms) => (Math.ceil(ms / step - 1e-6) * 1000) / fps };
  const scenes = timeline?.scenes || [];
  let budget = Math.max(0, Number(seconds) * 1000);
  const card = timeline?.endCard;
  let tail = null;
  if (card && scenes.length && budget - TEASER_END_MS >= TEASER_MIN_MS) {
    const a = frame.ceil(card.startMs + Math.min(TEASER_END_SKIP_MS, card.durationMs / 2));
    tail = [a, frame.floor(Math.min(card.startMs + card.durationMs, a + TEASER_END_MS))];
    budget -= tail[1] - tail[0];
  }
  if (!scenes.length) {
    if (!card || budget <= 0) return [];
    const a = frame.ceil(card.startMs);
    return [[a, frame.floor(Math.min(card.startMs + card.durationMs, a + budget))]];
  }

  const weight = (s) => (s.captions?.length ? s.captions.at(-1).t1 - s.captions[0].t0 : 0);
  // The answer (R46, R48): the scene the plan names (timeline.teaserAnswer, a scene id), else the last scene; its line,
  // whole if it fits, else up to its last sentence that does, is reserved first, and the teaser ends on it (scenes
  // after it are left out).
  const named = timeline?.teaserAnswer ? scenes.findIndex((s) => s.id === timeline.teaserAnswer) : -1;
  const ai = named >= 0 ? named : scenes.length - 1;
  const [hook, ...rest] = scenes.slice(0, ai + 1);
  const last = ai > 0 && weight(scenes[ai]) > 0 ? scenes[ai] : null;
  let answer = null;
  if (last) {
    answer = sceneSegment(last, budget, frame, { minRank: 3 }) || sceneSegment(last, budget, frame, { minRank: 2 });
    if (!answer) {
      throw new Error(`the teaser cannot end on the answer: the last scene's first sentence needs more than the ${(budget / 1000).toFixed(2)} s left `
        + 'after the end card (and the opener). Shorten that scene\'s line, or the opener line.');
    }
    budget -= answer[1] - answer[0];
  }
  let first = sceneSegment(hook, budget, frame, { minMs: 0 });
  if (!first) {
    const a = frame.ceil(hook.startMs), end = hook.startMs + hook.durationMs;
    // Silent, or no word boundary fits: hold briefly, ending on the latest frame that is not inside a word.
    const cap = hook.captions?.length ? budget : Math.min(budget, TEASER_SILENT_HOOK_MS);
    let b = frame.floor(Math.min(end, a + cap));
    const inWord = (ms) => (hook.captions || []).some((c) => ms > c.t0 * 1000 + 1e-6 && ms < c.t1 * 1000 - 1e-6);
    while (b > a && inWord(b)) b = frame.floor(b - step / 2);
    first = [a, b];
    // With the answer in, a hook squeezed below a short flash is left out rather than shown as one.
    if (answer && b - a < TEASER_MIN_MS) first = [a, a];
  }
  budget -= first[1] - first[0];

  const middle = last ? rest.slice(0, -1) : rest;
  const ranked = middle.filter((x) => weight(x) > 0).sort((x, y) => weight(y) - weight(x) || x.startMs - y.startMs);
  const picked = answer ? [{ s: last, seg: answer }] : [];
  // Whole lines first, strongest first; then, in what is left, a scene's opening sentences. Never half a sentence
  // outside the hook: it reads as a mistake.
  for (const minRank of [3, 2]) {
    for (const s of ranked) {
      if (picked.some((p) => p.s === s)) continue;
      const seg = sceneSegment(s, budget, frame, { minRank });
      if (!seg) continue;
      picked.push({ s, seg });
      budget -= seg[1] - seg[0];
    }
  }
  const body = picked.map((p) => p.seg).sort((x, y) => x[0] - y[0]);
  return [first, ...body, ...(tail ? [tail] : [])].filter(([a, b]) => b > a);
}
