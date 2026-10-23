---
name: ui-morph-loop
description: "By Fer Patel (ferpatel.ai). Makes a 10-20 second seamless looping UI motion video where ONE shape never cuts: it morphs through 8-12 real interface states of a product (button, loader, check, toggle, slider, tabs, chart, command palette, toast) on a beat grid, driven by a cursor with real clicks, drags and typing, then loops back to frame one. Dribbble-level UI motion for social posts, landing-page heroes and launch teasers, rendered as MP4 in 1:1, 9:16 and 16:9. Use this whenever the user asks for a UI animation loop, an interface motion piece, a morphing-button video, 'one shape' or 'never cut' motion, a Dribbble-style shot of their app, a looping product teaser, or motion design built from their UI components, even if they don't name this skill. Not for a full narrated product tour with features and captions (fp-product-video, at ferpatel.ai)."
---

# UI morph loop

> **Skills by Fer Patel** · [ferpatel.ai](https://ferpatel.ai)
> Part of the Video Skills library. Free to use for yourself; what you make with it is yours. See LICENSE.md. More skills at ferpatel.ai.

One element on screen the whole time. It becomes a button, then a loader, a check, a toggle, a slider, tabs, a chart, a command bar and a toast, and it ends exactly where it began, so the video loops forever. A cursor drives every change and something happens on every beat. The craft is that there are no cuts and no fades between scenes: the viewer's eye never has to find a new thing, so a 14-second clip reads as one continuous, satisfying gesture.

**The engine.** `<engine>` below means this plugin's copy of the video engine at `<this skill's folder>/../../engine`. Run `bash <engine>/setup.sh` once. `<engine>/README.md` lists every script.

## What you need

| Input | Default if the user skips it |
|---|---|
| The product (name, URL or screenshots) | The template's generic SaaS states |
| 8-12 interface moments, in story order | button, loader, check, toggle, slider, tabs, chart, command palette, toast, button |
| The real data inside each state (labels, numbers, names) | Ask. Real copy is what makes it look like *their* product. Never invent metrics for a real product. |
| Colours and font | Warm grey `#EDEBE8` canvas, black UI, white text, one accent, Inter |
| Aspect ratios | 1:1 (1440). 9:16 and 16:9 come from the same file. |
| Sound | Synthesized UI sounds (click, pop, tick, chime). Music only if the user supplies a track around 120 BPM. |

Dependencies: Node 18+, ffmpeg, Python 3 with numpy (all checked by `setup.sh`).

## Workflow

1. **Gather.** Get the inputs above. If they gave a URL, open it and screenshot the real components, then copy their radius, weight and colour. Look for the states that carry the product's story (sign in, the core action, the result, the "aha" number).

2. **Plan the state list on the beat grid, and get a yes.** Show a table before writing any code:

   | Beat | State | Shape (w x h, radius) | Content | Cursor action |
   |---|---|---|---|---|
   | 0 | button | 380 x 112, r56 | "Get started" | glides in |
   | 2 | loader | 132 x 132, r66 | spinner | click on 2 |

   At 120 BPM a beat is 0.5 s and 7 bars are 14 s. Give each state 2-3 beats. The last state must equal the first, and leave at least 2 beats after it for everything to settle.

3. **Build.** Make a working folder, copy `assets/template.html` to `<work>/index.html` and `<engine>/lib/seek.js` to `<work>/seek.js`, then serve it with `cd <work> && python3 -m http.server 8765 &`. Edit the three `EDIT` blocks:
   - `BRAND` sets the colours and font.
   - `BPM` / `BARS` set the grid.
   - `STATES`, `CURSOR`, `CLICKS` and `DRAG` are the story.

   Each state draws its own content in `draw(g, s)` around the shape's centre. Copy an existing state as the starting point for a new one. Open `index.html?play` in a browser to watch it live, or `?t=5.2` to freeze a frame.

4. **Preview one frame per beat** and look at every tile:
   ```bash
   node <engine>/scripts/preview.mjs --url http://127.0.0.1:8765/index.html --dir <work>/prev --w 1440 --h 1440 --grid --every 0.5
   ```
   Tiles that land exactly on a beat may show a shape with no content: that's the morph in progress, and it's correct. Also sample a quarter-beat later (`--grid 0.25 0.75 1.25 ...`) to see the content. Fix anything cramped, overlapping, off-grid or hard to read, then re-preview.

5. **Render with motion blur and the loop check:**
   ```bash
   node <engine>/scripts/render.mjs --url http://127.0.0.1:8765/index.html --out <work>/silent.mp4 --w 1440 --h 1440 --fps 30 --subframes 4 --loop-check
   ```
   Use `--fps 60` for the final if the platform supports it. For 9:16 use `--w 1080 --h 1920`, and for 16:9 use `--w 1920 --h 1080`. Same file every time.

6. **Check:** `python3 <engine>/scripts/checks.py <work>/silent.mp4 --loop`. Expect zero pops, no freezes and an ok loop seam.

7. **Sound and master.** The template's `cues()` already places a click on every press, a pop on every morph, ticks while typing and a chime on success.
   ```bash
   node <engine>/scripts/cues.mjs --url http://127.0.0.1:8765/index.html --out <work>/cues.json
   python3 <engine>/scripts/sfx.py mix --video <work>/silent.mp4 --cues <work>/cues.json --out <work>/mixed.mp4 [--music track.mp3]
   python3 <engine>/scripts/master.py master <work>/mixed.mp4 <work>/final.mp4 --lufs -16
   ```
   With a music track, run `python3 <engine>/scripts/beats.py track.mp3 --out beats.json` first. Set `BPM` to the result and start the loop on a downbeat (`--offset` in sfx.py).

8. **Deliver** the MP4s. Say what you checked: the loop seam, pops, and loudness. Say plainly that you can't hear the audio. Offer the other aspect ratios, a 60 fps master, or a version with the user's music.

## Rules that make it look good

- **One shape, never cut.** A single rounded rectangle plays every part by reshaping: its width, height, corner radius and fill are all that change. If a state needs a second element (a tooltip, a toggle knob), it lives inside the shape or grows out of it.
- **Content timing.** Content enters just after its container starts morphing and leaves just before the next morph, with a short blur. Text must never be visible while its container changes shape, or it squashes and overlaps.
- **Springs, with a tiny overshoot at most.** `SK.track` sums one closed-form spring per target change, so values glide from wherever they are. Keep damping around 0.8: bouncy easing looks like a template.
- **Liquid indicators.** For tab pills and toggle knobs, drive the leading edge on a faster spring than the trailing edge, so the indicator stretches as it travels.
- **Direct manipulation.** During a drag the pointer and the handle are one thing. Pull beyond the top of the range and the whole control rubber-bands; let go and it eases home from the exact point of release.
- **The camera frames each state.** Per-state `zoom` keeps small states (loader, check) as big on screen as wide ones (chart).
- **One accent colour, moved, not flooded.** It appears as an element (the check, a dot, the toggle track). Never fade the whole frame from black into the accent.
- **Leave out:** sparkle and particle effects, glow, gradient-filled controls, icons drawn at different stroke weights, beats where nothing happens, and `will-change` or CSS transforms on text the camera scales (it goes soft).
- **The loop is exact.** The last state equals the first and the cursor returns to its starting point. `--loop-check` proves it.

## Shipping checklist

- [ ] State list approved before building; every label and number is the product's real copy
- [ ] Every tile in the per-beat grid reviewed; no overlapping or clipped text
- [ ] `render.mjs --loop-check` passed and `checks.py --loop` shows 0 pops
- [ ] Rendered with `--subframes 4` or more
- [ ] Sound cues on every click and morph; mastered and `master.py` check ok
- [ ] Told the user what was verified and that you couldn't listen to the mix
