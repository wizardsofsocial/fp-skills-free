#!/usr/bin/env python3
"""Cut a short reel (e.g. 15s, 9:16) out of an existing seek(t) composition: render only the chosen time ranges,
join them with hard cuts, and optionally lay music under it with the drop on the first cut.

  python3 cutdown.py --url http://127.0.0.1:8765/vertical.html --w 1080 --h 1920 \
      --seg 3.2-6.2 --seg 6.5-9.0 --seg 15.4-20.9 --seg 75.6-79.6 \
      --out reel1.mp4 [--music track.mp3 --drop 15.0 --fade 1.5] [--sfx]

--drop is the time (s) of the drop in the track (find it with `music.py analyze --zoom`). The track is offset so the
drop lands exactly on the first cut. Without --drop, music starts at --offset (default 0).

--sfx adds the composition's sound effects for exactly these segments (cues.mjs --seg, then sfx.py mix --mono).

Segments are rendered straight from the composition (no re-encode on join), so there's no quality loss.
Keep every segment length a multiple of the track's beat (0.5s at 120 BPM) so every cut lands on a beat.
"""
import argparse, os, subprocess, sys, tempfile, shutil

HERE = os.path.dirname(os.path.abspath(__file__))


def ffmpeg():
    p = shutil.which('ffmpeg')
    if p:
        return p
    try:
        import imageio_ffmpeg
        return imageio_ffmpeg.get_ffmpeg_exe()
    except ImportError:
        sys.exit('ffmpeg not found: pip install imageio-ffmpeg')


ap = argparse.ArgumentParser()
ap.add_argument('--url', required=True)
ap.add_argument('--w', default='1080'); ap.add_argument('--h', default='1920')
ap.add_argument('--seg', action='append', required=True, help='start-end in composition seconds, in playback order')
ap.add_argument('--out', required=True)
ap.add_argument('--music'); ap.add_argument('--drop', type=float); ap.add_argument('--offset', type=float, default=0.0)
ap.add_argument('--fade', type=float, default=1.5)
ap.add_argument('--sfx', action='store_true', help='mix in the sound-effect cues of these segments')
a = ap.parse_args()

segs = []
for s in a.seg:
    lo, hi = (float(x) for x in s.split('-'))
    if hi <= lo:
        sys.exit(f'bad segment {s}')
    segs.append((lo, hi))
total = sum(hi - lo for lo, hi in segs)
print(f'{len(segs)} segments, {total:.2f}s total; cuts at ' + ', '.join(f'{sum(h - l for l, h in segs[:i + 1]):.2f}s' for i in range(len(segs) - 1)))

work = tempfile.mkdtemp(prefix='cutdown-')
out_abs = os.path.abspath(a.out)
listfile = os.path.join(work, 'list.txt')
with open(listfile, 'w') as lf:
    for i, (lo, hi) in enumerate(segs):
        part = os.path.join(work, f'part{i}.mp4')
        subprocess.run(['node', os.path.join(HERE, 'render.mjs'), '--url', a.url, '--w', a.w, '--h', a.h,
                        '--from', str(lo), '--to', str(hi), '--out', part], check=True)
        lf.write(f"file '{part}'\n")

silent = out_abs if not (a.music or a.sfx) else os.path.join(work, 'silent.mp4')
subprocess.run([ffmpeg(), '-loglevel', 'error', '-y', '-f', 'concat', '-safe', '0', '-i', listfile, '-c', 'copy',
                '-movflags', '+faststart', silent], check=True)

offset = a.offset
if a.music and a.drop is not None:
    first_cut = segs[0][1] - segs[0][0]
    offset = max(0.0, a.drop - first_cut)
    print(f'music offset {offset:.2f}s so the drop ({a.drop}s) lands on the first cut ({first_cut:.2f}s)')
if a.sfx:
    cues = os.path.join(work, 'cues.json')
    subprocess.run(['node', os.path.join(HERE, 'cues.mjs'), '--url', a.url, '--out', cues] +
                   sum((['--seg', f'{lo}-{hi}'] for lo, hi in segs), []), check=True)
    cmd = [sys.executable, os.path.join(HERE, 'sfx.py'), 'mix', '--video', silent, '--cues', cues, '--out', out_abs,
           '--mono', '--fade', str(a.fade)]
    if a.music:
        cmd += ['--music', a.music, '--offset', str(offset)]
    subprocess.run(cmd, check=True)
elif a.music:
    subprocess.run([sys.executable, os.path.join(HERE, 'music.py'), 'mux', silent, a.music, out_abs,
                    '--offset', str(offset), '--fade', str(a.fade)], check=True)

shutil.rmtree(work, ignore_errors=True)
print(f'wrote {out_abs}')
