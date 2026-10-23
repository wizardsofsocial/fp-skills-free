#!/usr/bin/env python3
"""Find a track's beat grid, downbeats, sections and drop, and write them to JSON for a composition to read.

  python3 beats.py track.mp3 --out beats.json [--bpm 120] [--beats-per-bar 4]
  python3 beats.py --synth 120 --bars 8 --out beats.json     # no track: a pure grid at a BPM (synthesized music)

beats.json:
  {"bpm": 120.0, "offset": 0.48, "beat": 0.5, "beats": [0.48, 0.98, ...], "downbeats": [0.48, 2.48, ...],
  (offset is the FIRST DOWNBEAT; beats also includes any pickup beats before it)
   "sections": [{"t0": 0, "t1": 15.9, "energy": -21.3, "label": "intro"}, ...], "drop": 31.98, "duration": 182.4}

A composition loads it and puts every state change on a beat:  const B = await (await fetch('beats.json')).json();
then `beatTime(n) = B.offset + n * B.beat`. Keep scene lengths whole bars so cuts land on downbeats.

How it works (numpy only): spectral-flux onset envelope -> tempo by autocorrelation (60-200 BPM, folded to 80-160)
-> beat phase that best lines up with the onsets -> downbeat = the beat phase in each bar with the most low-end
low-band onsets (the kick) -> section boundaries where per-bar loudness jumps -> the drop is the start of the first
loudest section after a quieter one (else the biggest rise on a downbeat).
Pass --bpm if you know it; the detector is reliable on modern produced music and rougher on rubato or live takes,
so always sanity-check by rendering a still per beat (preview.mjs --grid --every <beat>).
If librosa is installed, --librosa uses its beat tracker instead.
"""
import argparse, json, shutil, subprocess, sys
import numpy as np

SR = 22050
HOP = 512


def ffmpeg():
    p = shutil.which("ffmpeg")
    if p:
        return p
    try:
        import imageio_ffmpeg
        return imageio_ffmpeg.get_ffmpeg_exe()
    except ImportError:
        sys.exit("ffmpeg not found: pip install imageio-ffmpeg")


def load(path):
    raw = subprocess.run([ffmpeg(), "-loglevel", "error", "-i", path, "-ac", "1", "-ar", str(SR), "-f", "f32le", "-"],
                         capture_output=True, check=True).stdout
    return np.frombuffer(raw, dtype=np.float32)


def stft_mag(y, n=2048):
    win = np.hanning(n)
    frames = 1 + max(0, (len(y) - n) // HOP)
    idx = np.arange(n)[None, :] + HOP * np.arange(frames)[:, None]
    return np.abs(np.fft.rfft(y[idx] * win, axis=1))


def onset_envelope(S):
    L = np.log1p(10 * S)
    flux = np.maximum(0, np.diff(L, axis=0)).sum(axis=1)
    flux = np.concatenate([[0], flux])
    flux -= np.convolve(flux, np.ones(16) / 16, mode="same")          # remove slow drift
    return np.maximum(flux, 0)


def tempo(env, fps, lo=60, hi=200):
    e = env - env.mean()
    ac = np.correlate(e, e, mode="full")[len(e) - 1:]
    lags = np.arange(len(ac))
    bpm = 60 * fps / np.maximum(lags, 1)
    ok = (bpm >= lo) & (bpm <= hi)
    # weight toward ~120 BPM so the detector prefers the felt beat over half/double time
    w = np.exp(-0.5 * (np.log2(bpm / 120) / 0.9) ** 2)
    lag = lags[ok][np.argmax((ac * w)[ok])]
    b = 60 * fps / lag
    while b < 80: b *= 2
    while b > 160: b /= 2
    return b


def refine_tempo(env, fps, bpm):
    """Fine search +-3% around the estimate for the period that lines onsets up best over the whole track."""
    best = (-1, bpm, 0)
    for cand in np.linspace(bpm * 0.97, bpm * 1.03, 61):
        period = 60 * fps / cand
        for ph in np.linspace(0, period, 24, endpoint=False):
            pos = np.arange(ph, len(env) - 1, period).astype(int)
            s = env[pos].sum()
            if s > best[0]:
                best = (s, cand, ph)
    return best[1], best[2] / fps


def sections(y, dur, beat, first_down, bpb):
    """Loudness per bar (bars aligned to the downbeats), split where it changes by >= 3 dB for 2+ bars.
    A trailing piece shorter than 2 bars is folded into the section before it."""
    bar = bpb * beat
    edges = list(np.arange(first_down % bar, dur, bar))
    if not edges or edges[0] > 0.01:
        edges = [0.0] + edges
    if len(edges) > 1 and edges[1] - edges[0] < 0.75 * bar:      # a pickup shorter than a bar joins the first bar
        del edges[1]
    edges.append(dur)
    db = np.array([20 * np.log10(np.sqrt(np.mean(y[int(a * SR):max(int(a * SR) + 1, int(b * SR))] ** 2)) + 1e-9)
                   for a, b in zip(edges[:-1], edges[1:])])
    n = len(db)
    out, start = [], 0
    for i in range(1, n):
        if abs(db[i] - db[start:i].mean()) >= 3 and i - start >= 2:
            out.append((start, i)); start = i
    if out and n - start < 2:
        out[-1] = (out[-1][0], n)
    else:
        out.append((start, n))
    secs = [{"t0": round(edges[a], 3), "t1": round(edges[b], 3), "energy": round(float(db[a:b].mean()), 1)} for a, b in out]
    peak = max(s["energy"] for s in secs)
    for i, s in enumerate(secs):
        s["label"] = "intro" if i == 0 and s["energy"] < peak - 4 else ("peak" if s["energy"] >= peak - 2 else ("break" if s["energy"] < peak - 8 else "verse"))
    return secs


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("track", nargs="?")
    ap.add_argument("--out", required=True)
    ap.add_argument("--bpm", type=float)
    ap.add_argument("--beats-per-bar", type=int, default=4)
    ap.add_argument("--synth", type=float, help="no track: write a pure grid at this BPM")
    ap.add_argument("--bars", type=int, default=8)
    ap.add_argument("--librosa", action="store_true")
    a = ap.parse_args()
    bpb = a.beats_per_bar

    if a.synth:
        beat = 60 / a.synth; n = a.bars * bpb
        beats = [round(i * beat, 4) for i in range(n)]
        res = {"bpm": a.synth, "offset": 0.0, "beat": round(beat, 6), "beats": beats, "downbeats": beats[::bpb],
               "sections": [], "drop": None, "duration": round(n * beat, 4), "beats_per_bar": bpb}
        json.dump(res, open(a.out, "w"), indent=1); print(f"grid {a.synth} BPM, {a.bars} bars = {res['duration']}s -> {a.out}"); return

    if not a.track:
        sys.exit("give a track, or --synth <bpm>")
    y = load(a.track); dur = len(y) / SR
    if a.librosa:
        import librosa
        bpm, frames = librosa.beat.beat_track(y=y.astype(np.float64), sr=SR, hop_length=HOP, start_bpm=a.bpm or 120)
        bpm = float(np.atleast_1d(bpm)[0]); offset = float(librosa.frames_to_time(frames[0], sr=SR, hop_length=HOP))
        S = stft_mag(y); env = onset_envelope(S)
    else:
        S = stft_mag(y); env = onset_envelope(S); fps = SR / HOP
        bpm = a.bpm or tempo(env, fps)
        bpm, offset = refine_tempo(env, fps, bpm)
        offset += 1024 / SR      # an STFT frame's index marks its start; the onset sits at the window's centre
    beat = 60 / bpm
    beats = list(np.arange(offset % beat, dur, beat))      # every beat from the start of the track

    # downbeat: the beat phase (0..bpb-1) whose beats carry the strongest LOW-band onsets (kicks land on the one;
    # an off-beat bass line has low energy but few sharp low onsets, so onsets beat raw energy here)
    lowb = int(150 / (SR / 2048)) + 1
    low = np.maximum(0, np.diff(np.log1p(10 * S[:, :lowb]), axis=0)).sum(axis=1)
    low = np.concatenate([[0], low])
    fi = lambda t: min(len(low) - 1, int(t * SR / HOP))
    near = lambda t: max(low[max(0, fi(t) - 2):fi(t) + 3])
    score = [sum(near(t) for t in beats[k::bpb]) for k in range(bpb)]
    k = int(np.argmax(score))
    downbeats = beats[k::bpb]
    offset = downbeats[0]          # beat 0 of the grid is the first downbeat, so SK.grid().bar(n) lands on bars

    secs = sections(y, dur, beat, offset, bpb)
    # drop: the start of the first loudest ("peak") section that follows a quieter one; if every section is equally
    # loud, the downbeat with the largest loudness rise
    drop = next((s["t0"] for i, s in enumerate(secs) if i and s["label"] == "peak" and secs[i - 1]["energy"] < s["energy"] - 3), None)
    if drop is None and downbeats:
        rms = lambda a, b: 20 * np.log10(np.sqrt(np.mean(y[int(a * SR):max(int(a * SR) + 1, int(b * SR))] ** 2)) + 1e-9)
        bar = bpb * beat
        drop = max(downbeats[2:] or downbeats, key=lambda t: rms(t, t + bar) - rms(t - 2 * bar, t))
    else:
        drop = min(downbeats, key=lambda t: abs(t - drop)) if downbeats else drop

    r = lambda v: round(float(v), 4)
    res = {"bpm": round(float(bpm), 2), "offset": r(offset), "beat": r(beat), "beats": [r(t) for t in beats],
           "downbeats": [r(t) for t in downbeats], "sections": secs, "drop": r(drop) if drop is not None else None,
           "duration": r(dur), "beats_per_bar": bpb}
    json.dump(res, open(a.out, "w"), indent=1)
    print(f"{res['bpm']} BPM, first downbeat {downbeats[0]:.2f}s, {len(beats)} beats, drop at {res['drop']}s, "
          f"{len(secs)} sections: " + ", ".join(f"{s['label']} {s['t0']:.0f}-{s['t1']:.0f}s" for s in secs))
    print(f"-> {a.out}")


if __name__ == "__main__":
    main()
