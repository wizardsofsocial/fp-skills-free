#!/usr/bin/env node
// The file side of an app-demo build: turns a recorded run into timeline.json and the voice-over script, and
// checks the spoken lines against their slots. compose.mjs does the timing itself; this reads and writes files
// around it so a build script (skills/fp-app-demo/assets/build.sh) stays plain shell.
//
//   node timeline.mjs clips --run run/
//        one "id<TAB>clip" line per plan scene, in order; fails if a scene was not recorded
//   node timeline.mjs build --run run/ --frames comp/frames --out comp/timeline.json [--vo audio/vo.json]
//                           [--words audio/words.json] [--allow-vo-drift] [--max-hold-ms 4000] [--aspect 9:16]
//        reads run/plan.json, run/report.json and run/events.json, counts the extracted frames in
//        <frames>/<scene id>/, writes the timeline (with each scene's real frameCount) and, with --vo, vo.json
//        from it. --aspect 9:16 lays it out for the vertical cut (same timing, so the same voice-over)
//   node timeline.mjs teaser --timeline comp/timeline.json --out comp/teaser.json [--seconds 15]
//        the teaser's cuts (compose.mjs teaserSegments), written as { fps, segments: [[startS, endS], ...] } and
//        printed as "startS<TAB>endS" lines, seconds on the composition's clock, on frame boundaries
//   node timeline.mjs check-vo --timing audio/vo_timing.json --vo audio/vo.json
//        exits 1, naming the scene, when a spoken line runs past its slot
//   node timeline.mjs dry-vo --plan run/plan.json --out audio/vo.json
//        vo.json straight from the plan's narration, for a voice-over dry run before anything records
//   node timeline.mjs marks --timeline comp/timeline.json
//        "name<TAB>seconds" lines: where to pull review frames from the encoded video
//
// The opener (opener.mjs: one spoken line over the opening shot, plan.opener.narration):
//   node timeline.mjs opener-vo --plan run/plan.json --clip-s 5 --out audio/opener.json
//        checks plan.opener (plan.mjs validateOpener); with a line, writes its vo.json (t = 0.4 s) and prints
//        "<words> <word budget>"; without one, removes a stale --out and prints "none"
//   node timeline.mjs opener-screen --plan run/plan.json --clip-s 5
//        exits 1 with a plain message when the line is clearly too long for the clip (more than 1.5 times the word
//        budget, or longer than the room at 140 words a minute), before anything is voiced or billed (R43)
//   node timeline.mjs opener-teaser --words audio/opener_words.json --clip-s 5
//        where the teaser leaves the opener (R42): the line plus 0.5 s, at most 6 s and the clip, never in a word
//   node timeline.mjs opener-fit --timing audio/opener_timing.json --clip-s 5
//        exits 1 with a plain message when the spoken line does not end 0.3 s before the clip ends; else prints
//        the second the line ends at
//   node timeline.mjs opener-timeline --words audio/opener_words.json --frames-dir comp/opener-frames/16x9
//                                     --pattern opener-frames/16x9/f_%06d.jpg --w 1920 --h 1080 --out comp/timeline-opener.json
//                                     [--picture 1440x1080]
//        the opener's one-scene composition at that size, its frame count from the frames written; --picture is the
//        shot's own shape, so a tall frame's captions go under a letterboxed shot
//   node timeline.mjs shift --sections 3.55,8.75 --by 5
//        the bed's scene starts moved later by the opening shot ("-" for none)
//
// The voice-over contract (compose.mjs header, two passes): vo.json holds the narrated scenes only, in order,
// with t = narrationStartMs / 1000 and until = the next line's t, or the scene end for the last line. A slot
// never reaches more than maxHoldMs past the end of its scene's recorded clip: past that, the video would sit
// on a held last frame while the voice goes on, so a line that long is an overrun to shorten, not a hold.
//
// Clip lengths come from the frames ffmpeg actually wrote (frameCount / fps), never from the container's
// reported duration, so the template never asks for a frame that is not there.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildTimeline, teaserSegments, FPS } from './compose.mjs';
import { openerVoScript, openerWordBudget, openerFit, openerFitMessage, openerTimeline, shiftSections, openerScreen, openerText, openerTeaserEnd } from './opener.mjs';
import { validateOpener, cameraOptions } from './plan.mjs';
import { args as parseArgs } from '../_common.mjs';

export const MAX_HOLD_MS = 4000;
const r3 = (n) => Math.round(n * 1000) / 1000;
const narrationOf = (s) => String(s?.narration || '').trim();

/** Plan scenes joined with the recorder's report and the extracted frame counts, in plan order. */
export function scenesFromRun({ plan, report, frameCounts, fps = FPS }) {
  const byId = new Map((report?.scenes || []).map((s) => [s.id, s]));
  return (plan?.scenes || []).map((s) => {
    const r = byId.get(s.id);
    if (!r || r.status !== 'ok' || !r.clip) {
      throw new Error(`scene "${s.id}" was not recorded (status ${r ? r.status : 'missing'}): fix it and record again before composing.`);
    }
    const frameCount = Number(frameCounts?.[s.id]) || 0;
    if (frameCount <= 0) throw new Error(`scene "${s.id}" has no frames extracted from ${r.clip}.`);
    return { id: s.id, title: s.title || '', narration: narrationOf(s), clip: r.clip, frameCount, clipDurationMs: Math.round((frameCount * 1000) / fps) };
  });
}

/** vo.json for the voice step (voiceover.py or tts.py), from a timeline and the scenes it was built from. */
export function voScript(timeline, scenes, { maxHoldMs = MAX_HOLD_MS } = {}) {
  const text = new Map(scenes.map((s) => [s.id, narrationOf(s)]));
  const narrated = timeline.scenes.filter((s) => s.narrationStartMs != null && text.get(s.id));
  const lines = narrated.map((s, i) => {
    const next = narrated[i + 1];
    const end = next ? next.narrationStartMs : s.startMs + s.durationMs;
    // The cap is what makes an overrun possible at all: narration sets scene length, so the next line's t
    // (or the scene end) always leaves room for the line. Without the cap no line could ever overrun, and a
    // long line would just hold the clip's last frame for as long as the voice goes on.
    const cap = s.startMs + s.clipDurationMs + maxHoldMs;
    return { t: r3(s.narrationStartMs / 1000), until: r3(Math.min(end, cap) / 1000), text: text.get(s.id), scene: s.id };
  });
  return { lines };
}

/** The lines of a voice step's timing rows (vo_timing.json) that are spoken past their slot. */
export function voOverruns(rows, vo) {
  const out = [];
  for (const r of rows || []) {
    if (r.slot == null || !(r.spoken > r.slot + 0.001)) continue;
    const line = vo?.lines?.[r.line - 1];
    out.push({ line: r.line, scene: line?.scene ?? null, text: r.text ?? line?.text ?? '', spoken: r.spoken, slot: r3(r.slot), over: r3(r.spoken - r.slot) });
  }
  return out;
}

/** vo.json from the plan alone (provisional times): the same text, so a dry run shows the same billing. */
export function planVoScript(plan) {
  const lines = (plan?.scenes || []).filter((s) => narrationOf(s)).map((s, i) => ({ t: i * 10, text: narrationOf(s), scene: s.id }));
  return { lines };
}

/** Where to pull review frames from the encoded video: both sides of every scene change, after every page change, the end card. */
export function reviewMarks(timeline, { fps = timeline.fps || FPS } = {}) {
  const f = 1 / fps;
  const marks = [];
  timeline.scenes.forEach((s, i) => {
    const n = String(i + 1).padStart(2, '0');
    const a = s.startMs / 1000, b = (s.startMs + s.durationMs) / 1000;
    marks.push({ name: `${n}-${s.id}-first`, t: r3(a + 3 * f) });
    (s.camera || []).filter((k) => k.cut).forEach((k, j) => marks.push({ name: `${n}-${s.id}-cut-${j + 1}`, t: r3(a + k.tMs / 1000 + 6 * f) }));
    marks.push({ name: `${n}-${s.id}-last`, t: r3(b - 3 * f) });
  });
  if (timeline.endCard) {
    const n = String(timeline.scenes.length + 1).padStart(2, '0');
    marks.push({ name: `${n}-end-card`, t: r3((timeline.endCard.startMs + Math.min(2000, timeline.endCard.durationMs - 100)) / 1000) });
  }
  return marks;
}

// ---------------------------------------------------------------- CLI

const readJson = (file, what) => {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { throw new Error(`cannot read ${what} ${file}: ${e.message}`); }
};
const writeJson = (file, data) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(data, null, 1)); };

function frameCounts(dir, ids) {
  const out = {};
  for (const id of ids) {
    const d = path.join(dir, id);
    out[id] = fs.existsSync(d) ? fs.readdirSync(d).filter((f) => /^f_\d+\.jpg$/.test(f)).length : 0;
  }
  return out;
}

function main() {
  const a = parseArgs();
  const cmd = a._?.[0];
  const need = (k) => { if (typeof a[k] !== 'string') throw new Error(`${cmd} needs --${k}`); return a[k]; };
  if (cmd === 'clips') {
    const run = need('run');
    const plan = readJson(path.join(run, 'plan.json'), 'plan');
    const report = readJson(path.join(run, 'report.json'), 'recorder report');
    const byId = new Map((report.scenes || []).map((s) => [s.id, s]));
    for (const s of plan.scenes || []) {
      const r = byId.get(s.id);
      if (!r || r.status !== 'ok' || !r.clip) throw new Error(`scene "${s.id}" was not recorded (status ${r ? r.status : 'missing'}).`);
      console.log(`${s.id}\t${r.clip}`);
    }
  } else if (cmd === 'build') {
    const run = need('run');
    const plan = readJson(path.join(run, 'plan.json'), 'plan');
    const report = readJson(path.join(run, 'report.json'), 'recorder report');
    const events = readJson(path.join(run, 'events.json'), 'events');
    const words = typeof a.words === 'string' ? readJson(a.words, 'word timings') : undefined;
    const scenes = scenesFromRun({ plan, report, frameCounts: frameCounts(need('frames'), (plan.scenes || []).map((s) => s.id)) });
    const end = plan.video?.endCard;
    const aspect = typeof a.aspect === 'string' ? a.aspect : '16:9';
    const timeline = buildTimeline({
      scenes, events, words, url: end?.url || null, endTitle: end?.title || null, allowVoDrift: a['allow-vo-drift'] === true,
      aspect, ...cameraOptions(plan, aspect),
    });
    // R48: the scene the teaser ends on, when the plan names one (absent otherwise, so other timelines are unchanged).
    if (typeof plan.video?.teaserAnswer === 'string') timeline.teaserAnswer = plan.video.teaserAnswer;
    const counts = new Map(scenes.map((s) => [s.id, s.frameCount]));
    for (const s of timeline.scenes) s.frameCount = counts.get(s.id);
    writeJson(need('out'), timeline);
    const maxHoldMs = a['max-hold-ms'] !== undefined ? Number(a['max-hold-ms']) : MAX_HOLD_MS;
    if (!(maxHoldMs >= 0)) throw new Error('--max-hold-ms must be a number of milliseconds');
    if (typeof a.vo === 'string') writeJson(a.vo, voScript(timeline, scenes, { maxHoldMs }));
    console.log(`timeline: ${timeline.scenes.length} scenes, ${(timeline.durationMs / 1000).toFixed(2)} s`);
  } else if (cmd === 'check-vo') {
    const over = voOverruns(readJson(need('timing'), 'voice timing'), readJson(need('vo'), 'voice script'));
    for (const o of over) {
      console.error(`voice-over line ${o.line} (scene "${o.scene}") is ${o.spoken.toFixed(2)} s long but its slot is ${o.slot.toFixed(2)} s, `
        + `${o.over.toFixed(2)} s over: shorten that scene's narration in plan.json (or give the scene a longer holdMs so the recording covers it), then build again.`);
    }
    process.exitCode = over.length ? 1 : 0;
  } else if (cmd === 'dry-vo') {
    writeJson(need('out'), planVoScript(readJson(need('plan'), 'plan')));
  } else if (cmd === 'teaser') {
    const timeline = readJson(need('timeline'), 'timeline');
    const seconds = a.seconds !== undefined ? Number(a.seconds) : 15;
    if (!(seconds > 0)) throw new Error('--seconds must be a positive number');
    const fps = timeline.fps || FPS;
    // Seconds to 6 places: frame boundaries at 30 fps are not whole milliseconds.
    const segments = teaserSegments(timeline, seconds).map(([x, y]) => [Math.round(x * 1000) / 1e6, Math.round(y * 1000) / 1e6]);
    if (!segments.length) throw new Error('the timeline has nothing to cut a teaser from');
    writeJson(need('out'), { fps, seconds, segments });
    for (const [x, y] of segments) console.log(`${x.toFixed(6)}\t${y.toFixed(6)}`);
  } else if (cmd === 'marks') {
    for (const m of reviewMarks(readJson(need('timeline'), 'timeline'))) console.log(`${m.name}\t${m.t}`);
  } else if (cmd === 'opener-vo') {
    const plan = readJson(need('plan'), 'plan');
    const clipS = Number(need('clip-s'));
    const out = need('out');
    if (plan.opener === undefined) { fs.rmSync(out, { force: true }); console.log('none'); return; }
    try { validateOpener(plan.opener); } catch (e) { throw new Error(`plan.json: ${e.message}`); }
    const vo = openerVoScript(plan, clipS);
    writeJson(out, vo);
    console.log(`${vo.lines[0].text.split(/\s+/).length} ${openerWordBudget(clipS)}`);
  } else if (cmd === 'opener-screen') {
    const sc = openerScreen(openerText(readJson(need('plan'), 'plan')), Number(need('clip-s')));
    if (!sc.ok) throw new Error(sc.message);
    console.log(`${sc.words} words, about ${sc.estS.toFixed(2)} s of ${sc.limitS.toFixed(2)} s`);
  } else if (cmd === 'opener-teaser') {
    console.log(openerTeaserEnd({ words: readJson(need('words'), 'opener word timings'), clipS: Number(need('clip-s')) }).toFixed(6));
  } else if (cmd === 'opener-fit') {
    const clipS = Number(need('clip-s'));
    const [row] = readJson(need('timing'), 'opener voice timing');
    if (!row || !Number.isFinite(row.spoken)) throw new Error('the opener voice timing has no spoken line');
    const fit = openerFit(row.spoken, clipS);
    if (!fit.fits) throw new Error(openerFitMessage(fit, clipS));
    console.log(fit.endS.toFixed(3));
  } else if (cmd === 'opener-timeline') {
    const dir = need('frames-dir');
    const frameCount = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => /^f_\d+\.jpg$/.test(f)).length : 0;
    const pic = typeof a.picture === 'string' ? a.picture.match(/^(\d+(?:\.\d+)?)x(\d+(?:\.\d+)?)$/) : null;
    const tl = openerTimeline({
      words: readJson(need('words'), 'opener word timings'), frameCount, out: { width: Number(need('w')), height: Number(need('h')) }, frames: need('pattern'),
      picture: pic ? { width: Number(pic[1]), height: Number(pic[2]) } : undefined,
    });
    writeJson(need('out'), tl);
    console.log(`opener: ${frameCount} frames, ${tl.scenes[0].captions.length} caption words`);
  } else if (cmd === 'shift') {
    const starts = String(a.sections ?? '-').split(',').map((x) => x.trim()).filter((x) => x && x !== '-').map(Number);
    if (starts.some((x) => !Number.isFinite(x))) throw new Error('--sections must be seconds separated by commas');
    const by = Number(need('by'));
    if (!Number.isFinite(by)) throw new Error('--by must be a number of seconds');
    const out = shiftSections(starts, by);
    console.log(out.length ? out.map((x) => x.toFixed(3)).join(',') : '-');
  } else {
    console.error('usage: node timeline.mjs clips|build|check-vo|dry-vo|teaser|marks|opener-vo|opener-screen|opener-teaser|opener-fit|opener-timeline|shift ... (see the header of this file)');
    process.exitCode = 2;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main(); } catch (e) { console.error(e.message); process.exitCode = 1; }
}
