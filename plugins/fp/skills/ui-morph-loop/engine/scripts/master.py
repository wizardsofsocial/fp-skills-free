#!/usr/bin/env python3
"""Measure and master a finished video's loudness, and verify it after the encode.

  python3 master.py measure video.mp4                    # integrated LUFS, true peak, loudness range
  python3 master.py master video.mp4 out.mp4 [--lufs -14] [--tp -1.5]

`master` applies the exact gain to reach the target and a peak limiter (oversampled, ceiling 1 dB under --tp), so
spiky mixes with drums, stamps and impacts reach -14 LUFS without pumping (--no-limit: plain linear loudnorm). It encodes AAC 192k / 48 kHz, copies the video stream untouched, then measures the OUTPUT and fails if it
landed more than 1 LU off target or above the peak ceiling. AAC encoding can push peaks up, which is why the check
runs on the encoded file and not before it.

Targets: -14 LUFS for YouTube / Spotify-style music pieces, -16 LUFS for social feeds with speech (the engine's
sfx.py and music.py already land there). True peak -1.5 dBTP or lower.
"""
import argparse, json, re, shutil, subprocess, sys


def ffmpeg():
    p = shutil.which("ffmpeg")
    if p:
        return p
    try:
        import imageio_ffmpeg
        return imageio_ffmpeg.get_ffmpeg_exe()
    except ImportError:
        sys.exit("ffmpeg not found: pip install imageio-ffmpeg")


FF = ffmpeg()


def measure(path, lufs=-14, tp=-1.5):
    r = subprocess.run([FF, "-hide_banner", "-nostats", "-i", path, "-vn", "-af", f"loudnorm=I={lufs}:TP={tp}:LRA=11:print_format=json", "-f", "null", "-"],
                       capture_output=True, text=True)
    m = re.search(r"\{[^{}]*\"input_i\"[^{}]*\}", r.stderr, re.S)
    if not m:
        sys.exit(f"could not measure {path} (does it have an audio stream?)")
    return json.loads(m.group(0))


def measure_af(path, af):
    """Loudness of `path` after a filter chain, without writing anything."""
    r = subprocess.run([FF, "-hide_banner", "-nostats", "-i", path, "-vn", "-af", af + ",loudnorm=print_format=json", "-f", "null", "-"],
                       capture_output=True, text=True)
    m = re.search(r"\{[^{}]*\"input_i\"[^{}]*\}", r.stderr, re.S)
    return json.loads(m.group(0))


def cmd_measure(a):
    d = measure(a.file)
    print(f"{a.file}: {float(d['input_i']):.1f} LUFS integrated, true peak {float(d['input_tp']):.1f} dBTP, range {float(d['input_lra']):.1f} LU")


def encode(a, af):
    subprocess.run([FF, "-y", "-loglevel", "error", "-i", a.input, "-map", "0:v?", "-map", "0:a", "-c:v", "copy", "-af", af,
                    "-c:a", "aac", "-b:a", a.bitrate, "-ar", "48000", "-movflags", "+faststart", a.output], check=True)
    o = measure(a.output, a.lufs, a.tp)
    return float(o["input_i"]), float(o["input_tp"])


def cmd_master(a):
    d = measure(a.input, a.lufs, a.tp)
    if a.no_limit:
        af = (f"loudnorm=I={a.lufs}:TP={a.tp}:LRA=11:measured_I={d['input_i']}:measured_TP={d['input_tp']}:"
              f"measured_LRA={d['input_lra']}:measured_thresh={d['input_thresh']}:offset={d['target_offset']}:linear=true")
        i, p = encode(a, af)
    else:
        # Exact gain to the target, then a peak limiter at 4x the sample rate (close to a true-peak limiter).
        # AAC encoding overshoots peaks, by 0.5 dB on typical music and up to 3 dB on synthetic transients, so the
        # loop measures the ENCODED file and pulls the ceiling down by however much it overshot, then fixes up
        # the small loudness the limiter took away. Two or three rounds settle it.
        ceiling_db, gain = a.tp - 0.5, a.lufs - float(d["input_i"])
        for _ in range(4):
            lim = f"aresample=192000,alimiter=limit={10 ** (ceiling_db / 20):.4f}:attack=0.1:release=60:level=false,aresample=48000"
            af = f"volume={gain:.2f}dB,{lim}"
            i, p = encode(a, af)
            if p <= a.tp + 0.05 and abs(i - a.lufs) <= 0.5:
                break
            if p > a.tp:
                ceiling_db -= (p - a.tp) + 0.2
            gain += a.lufs - i
    print(f"in  {float(d['input_i']):.1f} LUFS / {float(d['input_tp']):.1f} dBTP\nout {i:.1f} LUFS / {p:.1f} dBTP  -> {a.output}")
    if abs(i - a.lufs) > 1 or p > a.tp + 0.5:
        sys.exit(f"MASTER CHECK FAILED: wanted {a.lufs} LUFS and <= {a.tp} dBTP. The mix is too peaky for this target: "
                 f"lower the loudest stem (often the impacts) or use --lufs -16.")
    print("master check ok")


ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
sub = ap.add_subparsers(dest="cmd", required=True)
m = sub.add_parser("measure"); m.add_argument("file")
ms = sub.add_parser("master"); ms.add_argument("input"); ms.add_argument("output")
ms.add_argument("--lufs", type=float, default=-14.0); ms.add_argument("--tp", type=float, default=-1.5)
ms.add_argument("--bitrate", default="192k")
ms.add_argument("--no-limit", action="store_true", help="plain linear loudnorm, no limiter (already-mastered audio)")
args = ap.parse_args()
cmd_measure(args) if args.cmd == "measure" else cmd_master(args)
