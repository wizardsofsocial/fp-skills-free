# Video engine

The shared toolkit behind every skill in the Video Skills library by Fer Patel ([ferpatel.ai](https://ferpatel.ai)). It's MIT licensed. Every packaged skill carries its own copy as `<skill>/engine/`, so each skill zip is self-contained.

## Setup (once)

```bash
bash <engine>/setup.sh           # playwright + chromium, ffmpeg check, numpy
bash <engine>/setup.sh --music   # + faster-whisper, demucs, edge-tts (lyrics, stems, free voice-over)
```

## The composition contract

A composition is one HTML page that defines:

- `window.seek(t)` draws the frame at `t` seconds as a **pure function of t**. It may return a promise.
- `window.DURATION` is the length in seconds.
- `window.__ready = true` is set once fonts and assets are loaded.

Load `lib/seek.js` (springs, seeded noise, beat grid, captions, frame sequences, film grain) and call `SK.boot({ duration, draw, ready })` to get all three. Long video clips go in as frame sequences with `SK.frames(pattern, count, fps, 1, { window: 48 })`, which decodes only the frames being drawn (and a few ahead) instead of the whole clip. Open the page with `?play` to watch it live, or `?t=4.5` to freeze a frame.

Why the pure-function rule: any frame renders on its own and in any order, the output is identical on every machine, and sub-frames can be sampled for real motion blur. In practice that means no CSS transitions, no timers, no `Math.random` (use `SK.hash` / `SK.rng`), and no state carried between frames (use `SK.track` springs for values that change target).

## Scripts

| Script | What it does |
|---|---|
| `render.mjs` | Composition to MP4, frame by frame. `--subframes N` adds motion blur (set `window.CUTS` so blur never crosses a hard cut). `--loop-check` fails on a visible loop seam. `--webgl` is for three.js. |
| `preview.mjs` | Stills at chosen times. `--grid --every 0.5` gives a labelled contact grid, one tile per beat. |
| `capture.mjs` | Records an interactive page (game, 3D explorer, toy) on a virtual clock with scripted input, so the recording is deterministic and at full frame rate. `--audio run.wav` records the page's own Web Audio in sync (every AudioContext runs offline on the virtual clock). `--events` dumps `window.EVENTS` for highlight finding, `--cursor` draws a pointer. Page exceptions and `console.error` are printed and counted. |
| `beats.py` | BPM, beat grid, downbeats, sections and drop to `beats.json`. `--synth 120 --bars 7` writes a pure grid. |
| `align.py` | Word timings to `words.json`: from a voice-over, from sung lyrics (whisper, lyrics file is the truth), from an `.lrc`, or `transcribe` for speech with no script (whisper writes the words too, in caption lines). |
| `tts.py` | Free voice-over (edge-tts, or macOS `say`) from a timed script, with per-word timestamps. The script's `vo.json` can carry its `voice` and `rate`; `--voice` / `--rate` override them. |
| `voiceover.py` | ElevenLabs voice-over (reads `ELEVENLABS_API_KEY` from the environment only). |
| `sfx.py` | Synthesized sound effects from cues, mixed with music and voice, ducking and loudness handled. `--loop` for pieces on repeat: sounds past the end wrap to the start, no fades, no click at the seam. |
| `cues.mjs` | Collects a composition's sound cues (`data-sfx`, `window.SFX`, `window.cues()`). Pass `--webgl` for three.js pages. |
| `music.py` | Track energy map, and mux music under a video (`--fade 0 --no-normalize` for a whole song). |
| `bed.py` | Original gentle music bed for narrated pieces: one chord per bar, a layer added at each scene start. `--swell 8.4,17.4` rises into those moments (a turn, the end card). |
| `track.py` | Original groove track with a drop, arranged from a beat sheet (hook, build, drop, break, end). |
| `cutdown.py` | Short reels cut from a longer composition, on the beat. |
| `master.py` | Loudness master to -14 or -16 LUFS with an oversampled peak limiter, measured and corrected on the encoded file. |
| `checks.py` | Automatic QA on an MP4: single-frame pops, dead time, cut pacing, loop seam, cuts on the beat. A cut is a full-frame change (caught between dark or low-contrast shots too); wipes and partial changes are listed apart and are not counted as cuts. |

## The QA loop every skill uses

1. Run `preview.mjs --grid` at the key moment of every scene (or every beat) and look at every tile.
2. Fix, then re-preview.
3. `render.mjs`
4. `checks.py` (gate on its exit code).
5. Pull frames from the MP4 at transitions.
6. `master.py master`.

Hand over only what passed.
