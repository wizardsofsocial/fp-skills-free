#!/usr/bin/env python3
"""Automatic checks on a rendered MP4 that catch what eyeballing stills misses.

  python3 checks.py video.mp4 [--loop] [--beats beats.json] [--json report.json]

Reports:
  pops      single-frame flashes: frame i differs a lot from both neighbours while they match each other
            (an element that appears for one frame, a missed seek, a flicker). Each is listed with its time.
  freezes   runs of > 1.5 s where nothing moves (dead time). Fine on a deliberate hold, a bug anywhere else.
  jumps     hard cuts per second and the share of still frames: a quick read of pacing.
            A hard cut is a frame where the picture changes almost everywhere at once. The frame is split into
            20 px tiles and each tile is compared on its own terms: textured tiles by correlation (so a cut between
            two dark or low-contrast shots still counts), flat tiles by their level. A wipe, a card sliding over, or
            text slamming onto a background changes only part of the frame per step, so it is listed under "wipes"
            instead (a big frame-to-frame change that is not a full-frame cut). A white flash is still a cut.
  loop      (--loop) how different the last frame is from the first; a seamless loop is near 0.
  beat sync (--beats) share of hard cuts that land within 1.5 frames of a beat in beats.json.
Exit code 1 when pops are found or the loop seam is visible, so a skill can gate on it.
"""
import argparse, json, shutil, subprocess, sys
import numpy as np


def ffmpeg():
    p = shutil.which("ffmpeg")
    if p:
        return p
    try:
        import imageio_ffmpeg
        return imageio_ffmpeg.get_ffmpeg_exe()
    except ImportError:
        sys.exit("ffmpeg not found: pip install imageio-ffmpeg")


def frames(path, w=160):
    probe = subprocess.run([ffmpeg(), "-i", path], capture_output=True, text=True).stderr
    fps = 30.0
    for tok in probe.split(","):
        if " fps" in tok:
            try: fps = float(tok.strip().split(" ")[0])
            except ValueError: pass
    raw = subprocess.run([ffmpeg(), "-loglevel", "error", "-i", path, "-vf", f"scale={w}:-2,format=gray", "-f", "rawvideo", "-"],
                         capture_output=True, check=True).stdout
    # find height from the scaled size: read one frame's worth by asking ffmpeg for the size
    size = subprocess.run([ffmpeg(), "-loglevel", "error", "-i", path, "-vf", f"scale={w}:-2", "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "gray", "-"],
                          capture_output=True, check=True).stdout
    h = len(size) // w
    f = np.frombuffer(raw, dtype=np.uint8).reshape(-1, h, w).astype(np.float32)
    return f, fps


def tiles(f, size=20):
    """per-tile zero-mean pixels, mean and standard deviation: arrays shaped (frames, tiles, px), (frames, tiles)"""
    n, h, w = f.shape; ty, tx = max(1, h // size), max(1, w // size)
    t = f[:, : ty * size, : tx * size].reshape(n, ty, size, tx, size).transpose(0, 1, 3, 2, 4).reshape(n, ty * tx, size * size)
    m = t.mean(2); sd = t.std(2)
    return t - m[..., None], m, sd


def cut_steps(f, tex=2.5, corr=0.5, same=0.9, level=10.0, shift=2):
    """For each step i -> i+1, the share of tiles that changed. A tile textured on both sides (sd >= tex) changed if the
    two correlate below corr even at the best shift of up to `shift` px (so camera moves, zooms and gate weave are not
    cuts), or its level moved by more than `level` without keeping the same picture (r below `same`). Correlation
    ignores brightness and contrast: a cut between two dim shots registers, a lamp flickering over the same scene
    does not. Any other tile changed if its level moved by more than `level` or it went from flat to textured or
    back (a flash to white, a cut from black)."""
    c = f[:, shift:-shift, shift:-shift]; h, w = c.shape[1:]
    z, m, sd = tiles(c)
    offs = [(dy, dx) for dy in range(-shift, shift + 1) for dx in range(-shift, shift + 1)]
    out = np.zeros(len(f) - 1)
    for i in range(len(f) - 1):
        a, sa = z[i], sd[i]; sb = sd[i + 1]; dm = np.abs(m[i + 1] - m[i])
        nxt = np.stack([f[i + 1, shift + dy: shift + dy + h, shift + dx: shift + dx + w] for dy, dx in offs])
        zs, _, ss = tiles(nxt)                                  # the next frame at every small offset
        r = ((a[None] * zs).mean(2) / np.maximum(sa[None] * ss, 1e-6)).max(0)
        both = (sa >= tex) & (sb >= tex)
        changed = np.where(both, (r < corr) | ((dm > level) & (r < same)),
                           (dm > level) | (((sa >= tex) != (sb >= tex)) & (np.abs(sa - sb) > tex)))
        out[i] = changed.mean()
    return out


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("video"); ap.add_argument("--loop", action="store_true"); ap.add_argument("--beats"); ap.add_argument("--json")
    a = ap.parse_args()
    f, fps = frames(a.video)
    d = np.abs(np.diff(f, axis=0)).mean(axis=(1, 2))           # mean change between consecutive frames (0..255)
    rep = {"frames": len(f), "fps": fps, "duration": round(len(f) / fps, 2)}

    pops = []
    for i in range(1, len(f) - 1):
        around = np.abs(f[i + 1] - f[i - 1]).mean()
        if d[i - 1] > 12 and d[i] > 12 and around < 0.35 * min(d[i - 1], d[i]):
            pops.append(round(i / fps, 3))
    rep["pops"] = pops

    still = d < 0.05          # mean change under 0.05/255: truly nothing moves (a slow push-in still counts as motion)
    freezes, run = [], 0
    for i, s in enumerate(still):
        run = run + 1 if s else 0
        if run == int(1.5 * fps):
            freezes.append(round((i - run + 1) / fps, 2))
    rep["freezes_start"] = freezes
    frac = cut_steps(f)
    full = (frac >= 0.6) & (d > 3)            # most of the frame changed in one step, and by more than noise
    # A cut happens in one step, though the frame after it often settles (a punch-in, a flash decaying). So each run
    # of consecutive full-frame changes holds one cut at most: always for a run of 1-2, and for a longer run only if
    # its biggest step stands out (1.5x the run's median). The cut's time is the run's first step unless a later one
    # is over twice as big. An even run of 3+ is a whip or fast transition, listed with the wipes.
    is_cut = np.zeros_like(full); i = 0
    while i < len(full):
        if not full[i]:
            i += 1; continue
        j = i
        while j + 1 < len(full) and full[j + 1]: j += 1
        k = i + int(np.argmax(d[i:j + 1]))
        if d[i] * 2 >= d[k]: k = i                      # the cut is where the change starts, unless a later step dwarfs it
        if j - i < 2 or d[k] >= 1.5 * np.median(d[i:j + 1]): is_cut[k] = True
        i = j + 1
    cuts = [round(float(i + 1) / fps, 3) for i in np.where(is_cut)[0]]
    wipes = [round(float(i + 1) / fps, 3) for i in np.where(((d > 25) | full) & ~is_cut)[0]]
    rep["hard_cuts"] = len(cuts); rep["cuts_per_sec"] = round(len(cuts) / max(rep["duration"], 0.01), 2)
    rep["cuts"] = cuts; rep["wipes"] = wipes
    rep["still_share"] = round(float(still.mean()), 3)

    if a.loop:
        rep["loop_seam"] = round(float(np.abs(f[-1] - f[0]).mean()), 2)
        rep["loop_step"] = round(float(np.median(d)), 2)
    if a.beats and cuts:
        B = json.load(open(a.beats)); beats = np.array(B["beats"])
        near = [c for c in cuts if np.min(np.abs(beats - c)) <= 1.5 / fps]
        rep["cuts_on_beat"] = round(len(near) / len(cuts), 2)
        rep["off_beat_cuts"] = [c for c in cuts if c not in near]

    print(f"{a.video}: {rep['frames']} frames @ {fps:g} fps ({rep['duration']}s)")
    print(f"  pops: {len(pops)}" + (f"  at {pops[:12]}" if pops else ""))
    print(f"  freezes > 1.5s: {len(freezes)}" + (f"  starting {freezes[:8]}" if freezes else ""))
    print(f"  hard cuts: {rep['hard_cuts']} ({rep['cuts_per_sec']}/s), still frames {rep['still_share'] * 100:.0f}%"
          + (f"  at {cuts[:12]}" if 0 < len(cuts) <= 12 else ""))
    if wipes:
        print(f"  wipes / partial changes (not counted as cuts): {len(wipes)}  at {wipes[:12]}")
    bad = bool(pops)
    if a.loop:
        seam_bad = rep["loop_seam"] > max(2.0, 2.5 * rep["loop_step"])
        print(f"  loop seam: {rep['loop_seam']} (typical frame step {rep['loop_step']})" + ("  <- VISIBLE SEAM" if seam_bad else "  ok"))
        bad |= seam_bad
    if "cuts_on_beat" in rep:
        print(f"  cuts on a beat: {rep['cuts_on_beat'] * 100:.0f}%" + (f"  off-beat at {rep['off_beat_cuts'][:12]}" if rep['off_beat_cuts'] else ""))
        print("  (a cut is a full-frame change: a white flash or a shot change counts, a wipe or a text slam on a still"
              " background does not; read the list, not just the %)")
    if a.json:
        json.dump(rep, open(a.json, "w"), indent=1)
    sys.exit(1 if bad else 0)


if __name__ == "__main__":
    main()
