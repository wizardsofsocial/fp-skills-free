#!/usr/bin/env python3
"""Automatic checks and contact sheets for a recorded app-demo clip (the second safety net after the
recorder's readiness gate).

  python3 frames.py check clip.webm [--json report.json] [--signatures sigs.json] [--events events.json]
                                    [--scene ID] [--viewport 1920x1080] [--width 480] [--edge] [--edge-share 0.30]
  python3 frames.py sheet clip.webm --every 2 --out sheet.jpg [--cols 4] [--tile-width 480] [--report report.json]

check lists every failure as {kind, tMs, detail} and exits 1 when there is any (0 on a pass, 2 when the
clip or an option cannot be read). Kinds:
  blank     the whole frame is one flat colour (near-blank) for 200 ms or more.
  flicker   one frame that differs a lot from both neighbours while they match each other (a flash).
  cursor    (--events) the recorder's pointer is not drawn where its events say it is, for over 1.5 s. It
            looks for the pointer's own shape (dark arrow inside a white outline, hotspot on the event
            point), so a missing pointer fails on any page colours. Skipped without --events.
  cutoff    (--edge, off by default) content runs into the right or bottom edge of the frame. Plenty of
            ordinary layouts do that (docked panels and drawers, sticky bars, full-bleed footers, a scrolled
            page), so it is opt-in; --edge-share (0.30) is how much of the edge must be covered. A panel
            clipped inside the page is not at the edge: use a signature (kind cutoff), which stays on
            whenever signatures are given.
  <kind>    (--signatures) whatever kind a signature names, for example loading, login, error, cutoff.
Pixels alone cannot know every app's spinner or login page, so those are driven by a signatures file:

  {"signatures": [{"name": "jobs loading", "kind": "loading", "scenes": ["jobs"], "minMs": 300,
                   "regions": [{"box": [x0, y0, x1, y1], "color": "#f4f6f8", "tolerance": 8, "minShare": 0.97}]}]}

box is fractions of the frame (0 to 1). A region holds when the share of its pixels within tolerance
(largest per-channel difference, 0 to 255) of color is at least minShare (default 0.9) and at most
maxShare (default 1). A signature fires when every region holds for minMs (default 300) in a row; gapMs
(default 0) bridges short misses, for an animated spinner that is only in the region at some angles.
scenes (optional) limits it to those scene ids; the scene comes from --scene, else the clip name
(01-jobs.webm is jobs), else the one scene in the events file. When it is unknown every signature runs.
Without --signatures only blank, flicker and cursor (and cutoff with --edge) run.

Speed: the clip is decoded once, scaled to --width (480) wide, at its own frame rate up to 30 fps. A
flash is a single frame, so thinning the rate would hide exactly what flicker looks for; the decode of
a 4K clip dominates the cost either way, and frames are streamed, not held. What the downscale cannot
see: anything under about 4 source pixels per tile pixel, so thin text, hairline borders, small
spinners (match them with a loose tolerance and a small minShare, or a region sized to the spinner),
a mid-word text clip, and subtle colour shifts. The cursor check is the exception: it re-reads a
small crop of the full-resolution frame around each event.
"""
import argparse, json, math, re, shutil, subprocess, sys
import numpy as np

FPS_CAP = 30.0
FLICKER_STEP = 8.0        # mean luma change (0..255) that counts as a jump
FLICKER_QUIET = 0.25      # the neighbours must differ by under this share of the jump
BLANK_STD = 3.0           # luma standard deviation under which a frame is blank
BLANK_MS = 200
EDGE_MS = 300
CURSOR_MS = 1500
CURSOR_LOOKS = (100, 250, 400)   # ms after an event at which the cursor is looked for


class Fail(Exception):
    pass


def ffmpeg():
    p = shutil.which("ffmpeg")
    if p:
        return p
    try:
        import imageio_ffmpeg
        return imageio_ffmpeg.get_ffmpeg_exe()
    except ImportError:
        raise Fail("ffmpeg not found: pip install imageio-ffmpeg")


def probe(path):
    """width, height, fps, duration (None when the container does not say) from ffmpeg's banner."""
    err = subprocess.run([ffmpeg(), "-hide_banner", "-i", path], capture_output=True, text=True).stderr
    m = re.search(r"Video:.*?,\s*(\d{2,5})x(\d{2,5})", err)
    if not m:
        raise Fail(f"cannot read a video stream from {path}")
    w, h = int(m.group(1)), int(m.group(2))
    fm = re.search(r"([\d.]+)\s*fps", err)
    fps = float(fm.group(1)) if fm else 30.0
    dm = re.search(r"Duration:\s*(\d+):(\d+):([\d.]+)", err)
    dur = int(dm.group(1)) * 3600 + int(dm.group(2)) * 60 + float(dm.group(3)) if dm else None
    return w, h, fps, dur


def stream(path, width, height, vf):
    """Yield RGB frames (height x width x 3 uint8) from ffmpeg without holding the clip in memory."""
    cmd = [ffmpeg(), "-loglevel", "error", "-i", path, "-vf", f"{vf},scale={width}:{height}:flags=area,format=rgb24",
           "-f", "rawvideo", "-"]
    p = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    size = width * height * 3
    n = 0
    while True:
        buf = p.stdout.read(size)
        if len(buf) < size:
            break
        n += 1
        yield np.frombuffer(buf, dtype=np.uint8).reshape(height, width, 3)
    p.stdout.close()
    err = p.stderr.read().decode(errors="replace").strip()
    if p.wait() != 0 or (n == 0 and err):
        raise Fail(f"ffmpeg could not decode {path}: {err.splitlines()[-1] if err else 'no output'}")


def hex_color(s):
    if not (isinstance(s, str) and re.fullmatch(r"#[0-9a-fA-F]{6}", s)):
        raise Fail(f'a signature colour must look like "#rrggbb", got {s!r}')
    return np.array([int(s[i:i + 2], 16) for i in (1, 3, 5)], dtype=np.int16)


def load_signatures(path):
    try:
        with open(path) as f:
            raw = json.load(f)
    except (OSError, ValueError) as e:
        raise Fail(f"cannot read signatures {path}: {e}")
    sigs = []
    for i, s in enumerate(raw.get("signatures") if isinstance(raw, dict) else []):
        name = s.get("name") or f"signature {i + 1}"
        if not s.get("kind") or not isinstance(s.get("kind"), str):
            raise Fail(f'signature "{name}" needs a kind (for example loading, login, error)')
        regions = []
        for r in s.get("regions") or []:
            box = r.get("box")
            if not (isinstance(box, list) and len(box) == 4 and all(isinstance(v, (int, float)) for v in box)
                    and 0 <= box[0] < box[2] <= 1 and 0 <= box[1] < box[3] <= 1):
                raise Fail(f'signature "{name}": box must be [x0, y0, x1, y1] as fractions with x0 < x1 and y0 < y1')
            regions.append({"box": box, "color": hex_color(r.get("color")), "tol": int(r.get("tolerance", 8)),
                            "min": float(r.get("minShare", 0.9)), "max": float(r.get("maxShare", 1.0))})
        if not regions:
            raise Fail(f'signature "{name}" needs at least one region')
        sigs.append({"name": name, "kind": s["kind"], "scenes": s.get("scenes"), "minMs": float(s.get("minMs", 300)), "gapMs": float(s.get("gapMs", 0)),
                     "regions": regions})
    if not sigs:
        raise Fail(f"{path} holds no signatures")
    return sigs


def region_share(frame, box, color, tol):
    h, w = frame.shape[:2]
    x0, x1 = int(box[0] * w), max(int(box[0] * w) + 1, int(math.ceil(box[2] * w)))
    y0, y1 = int(box[1] * h), max(int(box[1] * h) + 1, int(math.ceil(box[3] * h)))
    patch = frame[y0:y1, x0:x1].astype(np.int16)
    return float((np.abs(patch - color).max(axis=2) <= tol).mean())


def runs(flags, min_frames):
    """(first, last) frame index of each stretch of True at least min_frames long."""
    out, start = [], None
    for i, f in enumerate(list(flags) + [False]):
        if f and start is None:
            start = i
        elif not f and start is not None:
            if i - start >= max(1, min_frames):
                out.append((start, i - 1))
            start = None
    return out


def bridge(flags, gap):
    """Fill runs of False no longer than gap frames that sit between two True stretches."""
    out, last = list(flags), None
    for i, f in enumerate(flags):
        if f:
            if last is not None and 0 < i - last - 1 <= gap:
                for k in range(last + 1, i):
                    out[k] = True
            last = i
    return out


def dominant_color(frame):
    sub = (frame[::4, ::4] >> 4).astype(np.int32)
    code = sub[..., 0] * 256 + sub[..., 1] * 16 + sub[..., 2]
    top = int(np.bincount(code.ravel()).argmax())
    return np.array([(top >> 8) * 16 + 8, ((top >> 4) & 15) * 16 + 8, (top & 15) * 16 + 8], dtype=np.int16)


def edge_ink(frame):
    bg = dominant_color(frame)
    ink = np.abs(frame.astype(np.int16) - bg).max(axis=2) > 48
    return float(ink[:, -2:].any(axis=1).mean()), float(ink[-2:, :].any(axis=0).mean())


def scene_of(args, clip, events):
    if args.scene:
        return args.scene
    m = re.match(r"^\d+-(.+)\.\w+$", clip.rsplit("/", 1)[-1])
    if m:
        return m.group(1)
    ids = {e.get("scene") for e in events or []}
    return next(iter(ids)) if len(ids) == 1 else None


def analyse(path, width, sigs, scene, edge_share):
    w, h, fps_in, dur = probe(path)
    fps = min(fps_in, FPS_CAP)
    height = max(2, 2 * round(width * h / w / 2))
    active = [s for s in sigs if not (s["scenes"] and scene and scene not in s["scenes"])]
    blank, edge_r, edge_b, hits = [], [], [], {s["name"]: [] for s in active}
    flicker, window, nframes = [], [], 0
    for frame in stream(path, width, height, f"fps={fps:g}"):
        g = frame.astype(np.float32) @ np.array([0.299, 0.587, 0.114], dtype=np.float32)
        blank.append(bool(g.std() < BLANK_STD))
        er, eb = edge_ink(frame)
        edge_r.append(er >= edge_share)
        edge_b.append(eb >= edge_share)
        for s in active:
            hits[s["name"]].append(all(
                r["min"] <= region_share(frame, r["box"], r["color"], r["tol"]) <= r["max"] for r in s["regions"]))
        window.append(g)
        if len(window) == 3:
            a, b, c = window
            d1, d2 = float(np.abs(b - a).mean()), float(np.abs(c - b).mean())
            if d1 > FLICKER_STEP and d2 > FLICKER_STEP and float(np.abs(c - a).mean()) < FLICKER_QUIET * min(d1, d2):
                flicker.append(nframes - 1)
            window.pop(0)
        nframes += 1
    if nframes == 0:
        raise Fail(f"{path} has no frames")
    return {"w": w, "h": h, "fps": fps, "frames": nframes, "duration": nframes / fps, "blank": blank,
            "edge_r": edge_r, "edge_b": edge_b, "hits": hits, "sigs": active, "flicker": flicker}


def ms(i, fps):
    return int(round(1000.0 * i / fps))


# The recorder's pointer (cursorInit in record.mjs): an SVG arrow, fill #111, 2 px white stroke, drawn so that
# the path point (2, 2) sits on the event position. Coordinates below are CSS px relative to that hotspot.
ARROW = [(0, 0), (0, 25), (6.5, 19), (11, 29.5), (15.5, 27.5), (11, 17.5), (20, 17.5)]
_TEMPLATES = {}


def cursor_template(s):
    """(core, ring) pixel offsets from the hotspot for a clip drawn at s clip pixels per CSS px."""
    key = round(s, 4)
    if key in _TEMPLATES:
        return _TEMPLATES[key]
    xs = (np.arange(int(-3 * s), int(24 * s) + 1) + 0.5) / s
    ys = (np.arange(int(-3 * s), int(33 * s) + 1) + 0.5) / s
    X, Y = np.meshgrid(xs, ys)
    inside = np.zeros(X.shape, dtype=bool)
    dist = np.full(X.shape, 1e9)
    for (x0, y0), (x1, y1) in zip(ARROW, ARROW[1:] + ARROW[:1]):
        if y0 != y1:
            inside ^= ((y0 > Y) != (y1 > Y)) & (X < (x1 - x0) * (Y - y0) / (y1 - y0) + x0)
        t = np.clip(((X - x0) * (x1 - x0) + (Y - y0) * (y1 - y0)) / ((x1 - x0) ** 2 + (y1 - y0) ** 2), 0, 1)
        dist = np.minimum(dist, np.hypot(X - (x0 + t * (x1 - x0)), Y - (y0 + t * (y1 - y0))))
    oy, ox = int(-3 * s), int(-3 * s)
    def idx(mask):
        yy, xx = np.nonzero(mask)
        return yy + oy, xx + ox
    out = (idx(inside & (dist > 1.6)), idx(dist <= 0.7))
    _TEMPLATES[key] = out
    return out


def cursor_in(px, hx, hy, s):
    """True when the recorder's arrow is in the crop with its hotspot near (hx, hy): a dark fill the shape of the
    arrow inside a white outline the shape of the arrow. Text or a block of colour cannot satisfy both."""
    (cy, cx), (ry, rx) = cursor_template(s)
    luma = px.astype(np.float32) @ np.array([0.299, 0.587, 0.114], dtype=np.float32)
    h, w = luma.shape
    r = int(math.ceil(3 * s)) + 1
    for dy in range(-r, r + 1):
        for dx in range(-r, r + 1):
            yc, xc, yr, xr = cy + hy + dy, cx + hx + dx, ry + hy + dy, rx + hx + dx
            if yc.min() < 0 or xc.min() < 0 or yc.max() >= h or xc.max() >= w or yr.min() < 0 or xr.min() < 0 or yr.max() >= h or xr.max() >= w:
                continue
            core, ring = luma[yc, xc], luma[yr, xr]
            if np.percentile(core, 90) < 110 and np.percentile(ring, 25) > 150:
                return True
    return False


def cursor_failures(path, events, scene, w, h, fps, duration, viewport):
    """Look for the recorder's pointer at each event's position (see cursor_in)."""
    ev = sorted((e for e in events if (scene is None or e.get("scene") == scene)
                 and isinstance(e.get("tMs"), (int, float)) and isinstance(e.get("x"), (int, float))
                 and isinstance(e.get("y"), (int, float))), key=lambda e: e["tMs"])
    if not ev:
        return [], f"no events for scene {scene!r}"
    vw, vh = viewport
    sx, sy = w / vw, h / vh
    missing = []
    for e in ev:
        x0 = int(max(0, (e["x"] - 6) * sx)); y0 = int(max(0, (e["y"] - 6) * sy))
        cw = int(min(w - x0, 34 * sx)); ch = int(min(h - y0, 42 * sy))
        hx, hy = int(round(e["x"] * sx)) - x0, int(round(e["y"] * sy)) - y0
        seen = False
        for look in CURSOR_LOOKS:
            t = min(max(0.0, (e["tMs"] + look) / 1000.0), max(0.0, duration - 1.5 / fps))
            raw = subprocess.run([ffmpeg(), "-loglevel", "error", "-ss", f"{t:.3f}", "-i", path, "-frames:v", "1",
                                  "-vf", f"crop={cw}:{ch}:{x0}:{y0},format=rgb24", "-f", "rawvideo", "-"],
                                 capture_output=True).stdout
            if len(raw) < cw * ch * 3:
                continue
            px = np.frombuffer(raw[:cw * ch * 3], dtype=np.uint8).reshape(ch, cw, 3)
            if cursor_in(px, hx, hy, sx):
                seen = True
                break
        missing.append(not seen)
    found = []
    i = 0
    while i < len(ev):
        if not missing[i]:
            i += 1
            continue
        j = i
        while j + 1 < len(ev) and missing[j + 1]:
            j += 1
        end = ev[j + 1]["tMs"] if j + 1 < len(ev) else duration * 1000
        span = end - ev[i]["tMs"]
        if span > CURSOR_MS:
            found.append({"kind": "cursor", "tMs": int(ev[i]["tMs"]),
                          "detail": f"the cursor is not visible at ({ev[i]['x']:g}, {ev[i]['y']:g}) after the {ev[i]['type']} "
                                    f"event, and stays missing for {span / 1000:.1f} s"})
        i = j + 1
    return found, None


def run_check(args):
    sigs = load_signatures(args.signatures) if args.signatures else []
    events = None
    if args.events:
        try:
            with open(args.events) as f:
                events = json.load(f)
        except (OSError, ValueError) as e:
            raise Fail(f"cannot read events {args.events}: {e}")
        if not isinstance(events, list):
            raise Fail("events must be a JSON list of {scene, tMs, type, x, y, rect}")
    try:
        vw, vh = (int(v) for v in args.viewport.lower().split("x"))
    except ValueError:
        raise Fail("--viewport must look like 1920x1080")
    scene = scene_of(args, args.clip, events)
    a = analyse(args.clip, args.width, sigs, scene, args.edge_share)
    fps = a["fps"]
    fails, skipped = [], []
    for i0, i1 in runs(a["blank"], math.ceil(BLANK_MS / 1000 * fps)):
        fails.append({"kind": "blank", "tMs": ms(i0, fps),
                      "detail": f"the frame is a single flat colour (nothing on screen) for {(i1 - i0 + 1) / fps:.1f} s"})
    for i in a["flicker"]:
        fails.append({"kind": "flicker", "tMs": ms(i, fps), "detail": "one frame differs sharply from the frames either side of it (a flash)"})
    for side, key in (("right", "edge_r"), ("bottom", "edge_b")) if args.edge else ():
        for i0, i1 in runs(a[key], math.ceil(EDGE_MS / 1000 * fps)):
            fails.append({"kind": "cutoff", "tMs": ms(i0, fps),
                          "detail": f"content runs into the {side} edge of the frame for {(i1 - i0 + 1) / fps:.1f} s (cut off)"})
    for s in a["sigs"]:
        hits = bridge(a["hits"][s["name"]], int(s["gapMs"] / 1000 * fps))
        for i0, i1 in runs(hits, math.ceil(s["minMs"] / 1000 * fps)):
            fails.append({"kind": s["kind"], "tMs": ms(i0, fps),
                          "detail": f'matches the signature "{s["name"]}" for {(i1 - i0 + 1) / fps:.1f} s'})
    if not args.edge:
        skipped.append("generic edge check (content running into the right or bottom edge): off, pass --edge to turn it on")
    if not args.signatures:
        skipped.append("signatures (loading, login, error): no --signatures file given")
    if events is None:
        skipped.append("cursor: no --events file given")
    else:
        found, why = cursor_failures(args.clip, events, scene, a["w"], a["h"], fps, a["duration"], (vw, vh))
        fails += found
        if why:
            skipped.append(f"cursor: {why}")
    fails.sort(key=lambda f: (f["tMs"], f["kind"]))
    rep = {"clip": args.clip, "ok": not fails, "frames": a["frames"], "fps": fps, "duration": round(a["duration"], 2),
           "scene": scene, "failures": fails, "skipped": skipped}
    print(f"{args.clip}: {a['frames']} frames @ {fps:g} fps ({rep['duration']}s)" + (f", scene {scene}" if scene else ""))
    if scene is None and any(s["scenes"] for s in sigs):
        print("  scene unknown: scene-limited signatures were applied to every frame (pass --scene to narrow them)")
    for f in fails:
        print(f"  FAIL {f['kind']} at {f['tMs'] / 1000:.2f}s: {f['detail']}")
    for s in skipped:
        print(f"  skipped {s}")
    print("  PASS" if not fails else f"  {len(fails)} problem(s): retake or fix before using this clip")
    if args.json:
        with open(args.json, "w") as f:
            json.dump(rep, f, indent=1)
    return 1 if fails else 0


# ---------------------------------------------------------------- contact sheet

GLYPHS = {  # 5 x 7 bitmap font, enough for a time label
    "0": "01110 10001 10011 10101 11001 10001 01110", "1": "00100 01100 00100 00100 00100 00100 01110",
    "2": "01110 10001 00001 00010 00100 01000 11111", "3": "11110 00001 00001 01110 00001 00001 11110",
    "4": "00010 00110 01010 10010 11111 00010 00010", "5": "11111 10000 11110 00001 00001 10001 01110",
    "6": "00110 01000 10000 11110 10001 10001 01110", "7": "11111 00001 00010 00100 01000 01000 01000",
    "8": "01110 10001 10001 01110 10001 10001 01110", "9": "01110 10001 10001 01111 00001 00010 01100",
    ":": "00000 00100 00100 00000 00100 00100 00000", ".": "00000 00000 00000 00000 00000 01100 01100",
    " ": "00000 00000 00000 00000 00000 00000 00000",
}


def stamp(img, text, x, y, scale=2):
    """Draw text on white-on-black at (x, y) in an RGB array."""
    cw = 6 * scale
    img[y:y + 9 * scale + 2, x:x + cw * len(text) + scale] = 0
    for k, ch in enumerate(text):
        rows = GLYPHS.get(ch, GLYPHS[" "]).split()
        for r, row in enumerate(rows):
            for c, bit in enumerate(row):
                if bit == "1":
                    yy, xx = y + 1 + (r + 1) * scale, x + scale + k * cw + c * scale
                    img[yy:yy + scale, xx:xx + scale] = 255


def label(t):
    m, s = divmod(t, 60)
    return f"{int(m):02d}:{s:04.1f}"


def run_sheet(args):
    if args.every <= 0:
        raise Fail("--every must be above 0 seconds")
    w, h, fps, dur = probe(args.clip)
    tw = args.tile_width
    th = max(2, 2 * round(tw * h / w / 2))
    tiles = []
    # round=up: tile k is the frame AT k * every, so its label is exact (the default rounding shows the
    # frame half an interval later than its label).
    for k, frame in enumerate(stream(args.clip, tw, th, f"fps=1/{args.every:g}:round=up")):
        if dur is not None and k * args.every >= dur:
            break
        tiles.append(frame.copy())
    if not tiles:
        raise Fail(f"no frames could be read from {args.clip}")
    flagged = set()
    if args.report:
        try:
            with open(args.report) as fh:
                for f in json.load(fh).get("failures", []):
                    flagged.add(int(f["tMs"] / 1000.0 // args.every))
        except (OSError, ValueError, KeyError, TypeError) as e:
            raise Fail(f"cannot read report {args.report}: {e}")
    cols = max(1, min(args.cols, len(tiles)))
    rows = math.ceil(len(tiles) / cols)
    pad = 8
    sheet = np.full((rows * (th + pad) + pad, cols * (tw + pad) + pad, 3), 32, dtype=np.uint8)
    for k, tile in enumerate(tiles):
        r, c = divmod(k, cols)
        x, y = pad + c * (tw + pad), pad + r * (th + pad)
        stamp(tile, label(k * args.every), 4, 4)
        if k in flagged:
            tile[:4], tile[-4:], tile[:, :4], tile[:, -4:] = (220, 38, 38), (220, 38, 38), (220, 38, 38), (220, 38, 38)
        sheet[y:y + th, x:x + tw] = tile
    sh, sw = sheet.shape[:2]
    p = subprocess.run([ffmpeg(), "-loglevel", "error", "-y", "-f", "rawvideo", "-pix_fmt", "rgb24", "-s", f"{sw}x{sh}", "-i", "-",
                        "-frames:v", "1", "-q:v", "3", args.out], input=sheet.tobytes(), capture_output=True)
    if p.returncode != 0:
        raise Fail(f"could not write {args.out}: {p.stderr.decode(errors='replace').strip()}")
    print(json.dumps({"out": args.out, "tiles": len(tiles), "every": args.every, "cols": cols, "rows": rows,
                      "width": sw, "height": sh, "flagged": sorted(flagged & set(range(len(tiles))))}))
    return 0


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)
    c = sub.add_parser("check"); c.add_argument("clip"); c.add_argument("--json"); c.add_argument("--signatures")
    c.add_argument("--events"); c.add_argument("--scene"); c.add_argument("--viewport", default="1920x1080")
    c.add_argument("--width", type=int, default=480); c.add_argument("--edge", action="store_true"); c.add_argument("--edge-share", type=float, default=0.30)
    s = sub.add_parser("sheet"); s.add_argument("clip"); s.add_argument("--every", type=float, default=2.0)
    s.add_argument("--out", required=True); s.add_argument("--cols", type=int, default=4)
    s.add_argument("--tile-width", type=int, default=480); s.add_argument("--report")
    a = ap.parse_args()
    try:
        sys.exit(run_check(a) if a.cmd == "check" else run_sheet(a))
    except Fail as e:
        print(f"error: {e}", file=sys.stderr)
        sys.exit(2)


if __name__ == "__main__":
    main()
