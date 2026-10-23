#!/usr/bin/env python3
"""Map a music track's energy over time, and mux it under a rendered video.

  python3 music.py analyze track.mp3                  # loudness per 2s + onsets, to find the intro, drops, breakdowns
  python3 music.py analyze track.mp3 --zoom 14 17     # 1/8s resolution in a window, to pin a drop to the beat
  python3 music.py mux video.mp4 track.mp3 out.mp4 [--offset 0] [--fade 3] [--no-normalize]
  (a whole-song music video: --fade 0 --no-normalize, then master.py)

`mux` trims the track to the video length (starting at --offset seconds into the track), fades out over the
last --fade seconds, normalizes to -16 LUFS (typical for social platforms) and copies the video stream untouched.
"""
import argparse, array, math, subprocess, sys, shutil


def ffmpeg():
    p = shutil.which('ffmpeg')
    if p:
        return p
    try:
        import imageio_ffmpeg
        return imageio_ffmpeg.get_ffmpeg_exe()
    except ImportError:
        sys.exit('ffmpeg not found: pip install imageio-ffmpeg')


def duration(path):
    out = subprocess.run([ffmpeg(), '-i', path], capture_output=True, text=True).stderr
    for line in out.splitlines():
        if 'Duration:' in line:
            h, m, s = line.split('Duration:')[1].split(',')[0].strip().split(':')
            return int(h) * 3600 + int(m) * 60 + float(s)
    sys.exit(f'could not read duration of {path}')


def pcm(path, sr=8000):
    raw = subprocess.run([ffmpeg(), '-loglevel', 'error', '-i', path, '-ac', '1', '-ar', str(sr), '-f', 's16le', '-'],
                         capture_output=True, check=True).stdout
    return array.array('h', raw), sr


def db(a, s, e, sr):
    w = a[int(s * sr):int(e * sr)]
    if not w:
        return -99.0
    r = math.sqrt(sum(x * x for x in w) / len(w))
    return 20 * math.log10(r / 32768 + 1e-9)


def analyze(args):
    a, sr = pcm(args.track)
    total = len(a) / sr
    if args.zoom:
        lo, hi = args.zoom
        t = lo
        cells = []
        while t < hi:
            cells.append(f'{t:.3f}:{db(a, t, t + 0.125, sr):.0f}')
            t += 0.125
        print(' '.join(cells))
        print('A jump of ~8 dB or more from one cell to the next is a hit; the first big one after a quiet run is the drop.')
        return
    print(f'duration {total:.1f}s  (bars: louder = longer)')
    prev = None
    for s in range(0, int(total), 2):
        v = db(a, s, s + 2, sr)
        mark = ''
        if prev is not None and v - prev >= 3:
            mark = '  <- energy up (drop/build?)'
        elif prev is not None and prev - v >= 6:
            mark = '  <- energy down (breakdown?)'
        print(f'{s:4d}s {v:6.1f} dB {"#" * int(max(0, v + 40))}{mark}')
        prev = v


def mux(args):
    vd = duration(args.video)
    fade_st = max(0, vd - args.fade)
    af = f'atrim={args.offset}:{args.offset + vd},asetpts=PTS-STARTPTS'
    if args.fade > 0:
        af += f',afade=t=out:st={fade_st}:d={args.fade}'
    if not args.no_normalize:
        af += ',loudnorm=I=-16:TP=-1.5:LRA=11'
    subprocess.run([ffmpeg(), '-loglevel', 'error', '-y', '-i', args.video, '-i', args.track, '-map', '0:v', '-map', '1:a',
                    '-c:v', 'copy', '-af', af, '-c:a', 'aac', '-b:a', '192k', '-ar', '48000', '-shortest',
                    '-movflags', '+faststart', args.out], check=True)
    print(f'wrote {args.out} ({vd:.1f}s, music from {args.offset}s, {args.fade}s fade-out, -16 LUFS)')


ap = argparse.ArgumentParser()
sub = ap.add_subparsers(dest='cmd', required=True)
p1 = sub.add_parser('analyze'); p1.add_argument('track'); p1.add_argument('--zoom', nargs=2, type=float)
p2 = sub.add_parser('mux'); p2.add_argument('video'); p2.add_argument('track'); p2.add_argument('out')
p2.add_argument('--offset', type=float, default=0.0); p2.add_argument('--fade', type=float, default=3.0)
p2.add_argument('--no-normalize', action='store_true', help='keep the track as mastered (then run master.py on the result)')
args = ap.parse_args()
analyze(args) if args.cmd == 'analyze' else mux(args)
