#!/usr/bin/env python3
"""Synthesize sound effects from a cue list and mix them (plus music and an optional voice-over) under a video.

  python3 sfx.py mix --video v.mp4 --cues cues.json --out out.mp4 [--music track.mp3 --offset 0 --fade 3]
                     [--vo vo.wav [--sfx-duck 10]] [--mono] [--sfx-lufs -19]
  python3 sfx.py audition --out sounds.wav        # every sound once, 0.8s apart, to hear the palette

cues.json comes from cues.mjs: {"dur": 60, "cues": [{"t": 1.2, "type": "pop", "g": 0.5, "p": 1.0, "pan": 0, "d": 0}]}
  t    seconds in the video   type  one of SOUNDS below   g  gain 0..1 (default 0.5)
  p    pitch multiplier       pan   -1 left .. 1 right    d  length for riser/swell/roll (they START at t)

Every sound is generated here from noise and sine waves (nothing to download or license). Levels: music at -16 LUFS,
the effects stem at --sfx-lufs (default -19, i.e. a few dB under the music), the result limited and gain-matched to
-16 LUFS integrated. With --vo, the voice sits at -16 LUFS, the music ducks under it via a sidechain compressor (measured:
11-17 dB down under speech, about 3 dB down between lines once the final gain-match is applied), and effects drop to
-24 LUFS so they never fight the words.
"""
import argparse, json, os, re, shutil, subprocess, sys, tempfile
import numpy as np

SR = 48000
rng = np.random.default_rng(7)


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


# ---------------------------------------------------------------- sound palette
def tt(d): return np.arange(int(d * SR)) / SR
def norm(x): m = np.max(np.abs(x)); return x / m if m > 0 else x


def band_noise(d, f0, f1, width=0.7, curve=1.0):
    """White noise through a band-pass whose centre glides f0 -> f1 (log), done frame by frame in the STFT."""
    n = int(d * SR); N, H = 2048, 512
    x = rng.standard_normal(n + N); out = np.zeros(n + N); win = np.hanning(N)
    lf = np.log2(np.maximum(np.fft.rfftfreq(N, 1 / SR), 1))
    for s in range(0, n, H):
        k = (s / max(n - 1, 1)) ** curve
        fc = np.exp(np.log(f0) + (np.log(f1) - np.log(f0)) * k)
        out[s:s + N] += np.fft.irfft(np.fft.rfft(x[s:s + N] * win) * np.exp(-0.5 * ((lf - np.log2(fc)) / width) ** 2)) * win
    return out[:n]


def whoosh(p=1, d=0.55):
    t = tt(d); env = np.sin(np.pi * np.minimum(t / d, 1)) ** 2 * np.exp(-1.2 * t / d)
    return norm(band_noise(d, 450 * p, 2600 * p, 0.6) * env)


def swoosh(p=1): return whoosh(p * 0.8, 0.8)                                   # bigger scene change


def flick(p=1):                                                                  # something small leaving
    d = 0.16; t = tt(d)
    return norm(band_noise(d, 2500 * p, 6000 * p, 0.5) * np.sin(np.pi * t / d) ** 2) * 0.8


def tick(p=1):                                                                   # a list item / checkbox landing
    d = 0.04; t = tt(d)
    return norm(np.sin(2 * np.pi * 2400 * p * t) * np.exp(-t / 0.006) + 0.25 * rng.standard_normal(len(t)) * np.exp(-t / 0.0015))


def blip(p=1):                                                                   # a diagram node appearing
    d = 0.1; t = tt(d); f = 1350 * p
    return norm((np.sin(2 * np.pi * f * t) + 0.2 * np.sin(4 * np.pi * f * t)) * np.exp(-t / 0.028) * (1 - np.exp(-t / 0.002)))


def pop(p=1):                                                                    # a chip / pill / badge popping in
    d = 0.14; t = tt(d); ph = np.cumsum(2 * np.pi * 480 * p * (1 + 1.3 * np.exp(-t / 0.014)) / SR)
    return norm((np.sin(ph) + 0.25 * np.sin(2 * ph)) * np.exp(-t / 0.04) * (1 - np.exp(-t / 0.0008)))


def click(p=1):                                                                  # a button press
    d = 0.05; t = tt(d); nz = np.diff(rng.standard_normal(len(t) + 1))
    return norm(nz * np.exp(-t / 0.003) * 0.6 + np.sin(2 * np.pi * 190 * p * t) * np.exp(-t / 0.012))


def impact(p=1, dec=0.45):                                                       # a slam: big reveal, the drop
    d = 1.4; t = tt(d); f = (38 + 30 * np.exp(-t / 0.08)) * p
    sub = np.sin(np.cumsum(2 * np.pi * f / SR)) * np.exp(-t / dec)
    body = band_noise(d, 180, 90, 0.9) * np.exp(-t / 0.09)
    return norm(sub + 0.6 * norm(body) + rng.standard_normal(len(t)) * np.exp(-t / 0.004) * 0.3)


def boom(p=1): return impact(p, 0.8) * 0.8                                        # softer, longer: a logo landing


def bell(freqs, stagger, dec, d=1.6):
    t = tt(d); out = np.zeros(len(t))
    for i, f in enumerate(freqs):
        s = int(i * stagger * SR); tl = t[: len(t) - s]
        out[s:] += (np.sin(2 * np.pi * f * tl) + 0.3 * np.sin(6 * np.pi * f * tl) * np.exp(-tl / 0.08)) * np.exp(-tl / dec) * (1 - np.exp(-tl / 0.003))
    return norm(out)


def shimmer(p=1): return bell([1568 * p, 2093 * p, 2637 * p, 3136 * p], 0.035, 0.45) * 0.8   # highlight / sparkle
def chime(p=1): return bell([523 * p, 659 * p, 784 * p, 1046 * p], 0.075, 0.5)              # success, "done"


def riser(p=1, d=2.0, f0=300, f1=7000):                                          # tension INTO a drop; ends at t+d
    t = tt(d); k = t / d
    x = norm(band_noise(d, f0 * p, f1 * p, 0.55, curve=1.6) * k ** 2.2) + np.sin(np.cumsum(2 * np.pi * (150 + 450 * k ** 2) * p / SR)) * k ** 3 * 0.25
    n = int(0.01 * SR); x[-n:] *= np.linspace(1, 0, n)
    return norm(x)


def swell(p=1, d=1.9): return riser(p, d, 200, 2200) * 0.8                        # gentler build


def roll(p=1, d=2.2):                                                            # a counter counting up
    out = np.zeros(int((d + 0.1) * SR)); n = max(1, int(d / 0.045))
    for i in range(n):
        k = i / max(n - 1, 1); s = tick(p * (1 + 0.5 * k)) * (0.5 + 0.5 * (1 - k) ** 0.5)
        a = int(i * 0.045 * SR); out[a:a + len(s)] += s[: len(out) - a]
    return norm(out)


SOUNDS = dict(whoosh=whoosh, swoosh=swoosh, flick=flick, tick=tick, blip=blip, pop=pop, click=click, impact=impact,
              boom=boom, shimmer=shimmer, chime=chime, riser=riser, swell=swell, roll=roll)
LONG = ("riser", "swell", "roll")


def make(c):
    fn = SOUNDS[c["type"]]
    return fn(c.get("p", 1), c["d"]) if c["type"] in LONG and c.get("d") else fn(c.get("p", 1))


def stem(cues, dur, mono):
    L = np.zeros(int((dur + 2) * SR)); R = np.zeros_like(L)
    for c in cues:
        if c["type"] not in SOUNDS:
            print(f"  skipping unknown sound '{c['type']}' at {c['t']}s (known: {', '.join(SOUNDS)})"); continue
        x = make(c) * c.get("g", 0.5)
        pan = 0 if mono else c.get("pan", 0)
        a = int(c["t"] * SR); b = min(a + len(x), len(L)); x = x[: b - a]
        L[a:b] += x * np.cos((pan + 1) * np.pi / 4) * np.sqrt(2)
        R[a:b] += x * np.sin((pan + 1) * np.pi / 4) * np.sqrt(2)
    st = np.stack([L, R], 1)[: int(dur * SR)]
    return st / max(1.0, np.max(np.abs(st)) / 0.95)


# ---------------------------------------------------------------- mixing
def write_wav(path, st):
    raw = (np.clip(st, -1, 1) * 32767).astype("<i2").tobytes()
    subprocess.run([FF, "-y", "-loglevel", "error", "-f", "s16le", "-ar", str(SR), "-ac", "2", "-i", "-", path], input=raw, check=True)


def lufs(path):
    err = subprocess.run([FF, "-i", path, "-af", "loudnorm=print_format=json", "-f", "null", "-"], capture_output=True, text=True).stderr
    m = re.findall(r'"input_i" : "([-\d.inf]+)"', err)
    return float(m[-1]) if m and "inf" not in m[-1] else -70.0


def voice_duck(vo_path, n, db, pre=0.12, hold=0.25, ramp=0.08):
    """Per-sample gain for the effects stem: 1.0 in the gaps, -db while the voice speaks (from the voice's own RMS)."""
    v = np.frombuffer(subprocess.run([FF, "-v", "quiet", "-i", vo_path, "-ac", "1", "-ar", str(SR), "-f", "s16le", "-"],
                                     capture_output=True).stdout, np.int16).astype(np.float32) / 32768
    win = int(0.02 * SR); k = len(v) // win
    rms = np.sqrt(np.mean(v[: k * win].reshape(k, win) ** 2, 1)) if k else np.zeros(0)
    on = rms > max(1e-4, 0.1 * (np.max(rms) if len(rms) else 0))          # speech = within 20 dB of the loudest window
    idx = np.flatnonzero(on); spoken = np.zeros(k, bool)
    for i in idx:                                                          # start the dip a little early, hold it through pauses
        spoken[max(0, i - int(pre / 0.02)): i + int(hold / 0.02) + 1] = True
    g = np.where(spoken, 10 ** (-db / 20), 1.0)
    r = max(1, int(ramp / 0.02)); g = np.convolve(np.pad(g, r, mode="edge"), np.ones(2 * r + 1) / (2 * r + 1), "valid")
    g = np.repeat(g, win); g = np.pad(g, (0, max(0, n - len(g))), constant_values=1.0)[:n]
    return g, float(spoken.sum() * 0.02)


def mix(a):
    spec = json.load(open(a.cues)); dur = float(spec["dur"]); cues = spec["cues"]
    work = tempfile.mkdtemp(prefix="sfx-"); base = os.path.join(work, "x")
    sfx_target = a.sfx_lufs if a.sfx_lufs is not None else (-24 if a.vo else -19)
    inputs = ["-i", a.video]; chains = []; mixins = []; n = 1  # ffmpeg input count (the video is input 0)
    if a.music:
        inputs += ["-ss", str(a.offset), "-i", a.music]; i = n; n += 1
        chains.append(f"[{i}:a]atrim=0:{dur},asetpts=PTS-STARTPTS,loudnorm=I=-16:TP=-1.5:LRA=11,aresample={SR}"
                      + (",volume=-6dB" if a.vo else "") + "[m0]")
    if cues:
        st = stem(cues, dur, a.mono)
        write_wav(base + "_sfx.wav", st)
        g = sfx_target - lufs(base + "_sfx.wav")       # level set from the undipped stem, so --sfx-lufs means the gaps
        if a.vo and a.sfx_duck > 0:
            env, secs = voice_duck(a.vo, len(st), a.sfx_duck)
            write_wav(base + "_sfx.wav", st * env[:, None])
            print(f"  effects dip {a.sfx_duck:g} dB under the voice ({secs:.1f}s of speech), full level in the gaps")
        inputs += ["-i", base + "_sfx.wav"]; i = n; n += 1
        chains.append(f"[{i}:a]volume={g:.2f}dB[s]"); mixins.append("[s]")
    if a.vo:
        inputs += ["-i", a.vo]; i = n; n += 1
        chains.append(f"[{i}:a]aresample={SR},loudnorm=I=-16:TP=-1.5:LRA=11,apad,atrim=0:{dur},asplit=2[v][vk]")
        mixins.append("[v]")
        if a.music:  # duck the music whenever the voice speaks
            chains.append("[m0][vk]sidechaincompress=threshold=0.02:ratio=8:attack=15:release=350:makeup=1[m]")
        else:
            chains.append("[vk]anullsink")
    if a.music:
        if not a.vo:
            chains.append("[m0]anull[m]")
        mixins.insert(0, "[m]")
    if not mixins:
        sys.exit("nothing to mix: give --music, --vo, or a cue list with cues")
    fade_st = max(0, dur - a.fade)
    graph = ";".join(chains) + ";" + "".join(mixins) + (f"amix=inputs={len(mixins)}:normalize=0:duration=first," if len(mixins) > 1 else "anull,") \
        + f"alimiter=limit=0.89:level=false,afade=t=in:d=0.03,afade=t=out:st={fade_st}:d={a.fade}[a]"
    subprocess.run([FF, "-y", "-loglevel", "error", *inputs, "-filter_complex", graph, "-map", "[a]", "-t", str(dur), base + "_mix.wav"], check=True)
    trim = -16 - lufs(base + "_mix.wav")
    subprocess.run([FF, "-y", "-loglevel", "error", "-i", a.video, "-i", base + "_mix.wav", "-filter_complex",
                    f"[1:a]volume={trim:.2f}dB,alimiter=limit=0.89:level=false[a]", "-map", "0:v", "-map", "[a]",
                    "-c:v", "copy", "-c:a", "aac", "-b:a", "192k", "-t", str(dur), "-movflags", "+faststart", a.out], check=True)
    parts = [p for p, on in (("music", a.music), (f"{len(cues)} sfx cues @ {sfx_target} LUFS", cues), ("voice-over (music ducked)", a.vo)) if on]
    print(f"wrote {a.out}: {dur:.1f}s, {' + '.join(parts)}, final {lufs(a.out):.1f} LUFS")
    check(a.out, base + "_sfx.wav" if cues else None, cues)
    if a.keep_stems and cues:
        shutil.copy(base + "_sfx.wav", os.path.splitext(a.out)[0] + "_sfx.wav")
    shutil.rmtree(work, ignore_errors=True)


def check(out, sfx_path, cues):
    """Numbers you can read without listening: does each transient start on its cue, and does it clear the mix?"""
    if not sfx_path:
        return
    def load(p):
        return np.frombuffer(subprocess.run([FF, "-v", "quiet", "-i", p, "-ac", "1", "-ar", str(SR), "-f", "s16le", "-"],
                                            capture_output=True).stdout, np.int16).astype(np.float32) / 32768
    s = load(sfx_path); errs = []
    for c in cues:
        if c["type"] in ("tick", "blip", "pop", "click", "impact", "boom", "chime", "shimmer"):
            a = int(c["t"] * SR); env = np.abs(s[a:a + int(0.25 * SR)])
            if len(env) and env.max() > 0:
                errs.append(np.argmax(env > 0.2 * env.max()) / SR * 1000)
    if errs:
        print(f"  sync: transients start {np.median(errs):.1f} ms (median), {max(errs):.1f} ms (max) after their cue")
    print(f"  peak {np.abs(load(out)).max():.2f} of full scale (limiter ceiling 0.89)")


def audition(a):
    items = [dict(type=k, t=0, p=1, d=1.2 if k in LONG else 0, g=0.8) for k in SOUNDS]
    gap = 0.4; t = 0.3; cues = []
    for c in items:
        c["t"] = t; cues.append(c); t += len(make(c)) / SR + gap
    write_wav(a.out, stem(cues, t + 0.5, True))
    print(f"wrote {a.out}: " + ", ".join(f"{c['type']}@{c['t']:.1f}s" for c in cues))


ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
sub = ap.add_subparsers(dest="cmd", required=True)
m = sub.add_parser("mix")
m.add_argument("--video", required=True); m.add_argument("--cues", required=True); m.add_argument("--out", required=True)
m.add_argument("--music"); m.add_argument("--offset", type=float, default=0); m.add_argument("--fade", type=float, default=3)
m.add_argument("--vo"); m.add_argument("--mono", action="store_true", help="no stereo panning (use for 9:16)")
m.add_argument("--keep-stems", action="store_true", help="also save the effects stem next to --out")
m.add_argument("--sfx-lufs", type=float, default=None, help="effects stem loudness (default -19, or -24 under a voice-over)")
m.add_argument("--sfx-duck", type=float, default=0, help="with --vo: dip the effects this many dB only while the voice speaks (e.g. 10)")
au = sub.add_parser("audition"); au.add_argument("--out", required=True)
args = ap.parse_args()
mix(args) if args.cmd == "mix" else audition(args)
