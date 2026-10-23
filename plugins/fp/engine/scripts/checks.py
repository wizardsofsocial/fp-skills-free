#!/usr/bin/env python3
"""Automatic checks on a rendered MP4 that catch what eyeballing stills misses.

  python3 checks.py video.mp4 [--loop] [--beats beats.json] [--json report.json]

Reports:
  pops      single-frame flashes: frame i differs a lot from both neighbours while they match each other
            (an element that appears for one frame, a missed seek, a flicker). Each is listed with its time.
  freezes   runs of > 1.5 s where nothing moves (dead time). Fine on a deliberate hold, a bug anywhere else.
  jumps     hard cuts per second and the share of still frames: a quick read of pacing.
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
    cuts = [round((i + 1) / fps, 3) for i in np.where(d > 25)[0]]
    rep["hard_cuts"] = len(cuts); rep["cuts_per_sec"] = round(len(cuts) / max(rep["duration"], 0.01), 2)
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
    print(f"  hard cuts: {rep['hard_cuts']} ({rep['cuts_per_sec']}/s), still frames {rep['still_share'] * 100:.0f}%")
    bad = bool(pops)
    if a.loop:
        seam_bad = rep["loop_seam"] > max(2.0, 2.5 * rep["loop_step"])
        print(f"  loop seam: {rep['loop_seam']} (typical frame step {rep['loop_step']})" + ("  <- VISIBLE SEAM" if seam_bad else "  ok"))
        bad |= seam_bad
    if "cuts_on_beat" in rep:
        print(f"  cuts on a beat: {rep['cuts_on_beat'] * 100:.0f}%" + (f"  off-beat at {rep['off_beat_cuts'][:12]}" if rep['off_beat_cuts'] else ""))
        print("  (any frame-to-frame jump counts as a cut: flashes and text slams too, so read the list, not just the %)")
    if a.json:
        json.dump(rep, open(a.json, "w"), indent=1)
    sys.exit(1 if bad else 0)


if __name__ == "__main__":
    main()
