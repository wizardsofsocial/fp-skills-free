#!/usr/bin/env python3
"""Synthesize an original groove track with a drop (numpy only, nothing downloaded or licensed) whose sections line
up with a beat sheet, so the drop hits where the best moment is. For trailers, beat edits, reels and tests.

  python3 track.py --out track.wav [--bpm 124] [--sheet beatsheet.json] [--key A] [--seed 3]

The section names in beatsheet.json decide the arrangement, bar by bar:
  hook   tight drums + bass, a filtered chord stab on each bar          (it has to grab in the first second)
  title  one big hit on its downbeat, then the groove with chords
  build  full groove, 16th arp, a noise riser over its last bar
  drop   everything: kick, clap, hats, bass, wide chords, lead stabs   (the loudest section)
  fail   breakdown: no kick, pad and a falling tone                    (gives the death moment room)
  end    groove back for a bar, then a final hit that rings out under the end card
Any other name gets the 'build' arrangement. Without --sheet: hook 2 bars, title 1, build 2, drop 2, fail 1, end 2.
Write beats.json afterwards with the engine: python3 <engine>/scripts/beats.py track.wav --bpm 124 --out beats.json
"""
import argparse, json, shutil, subprocess, sys
import numpy as np

SR = 44100
NOTES = {"C": 0, "C#": 1, "D": 2, "D#": 3, "E": 4, "F": 5, "F#": 6, "G": 7, "G#": 8, "A": 9, "A#": 10, "B": 11}


def hz(semi_from_a4): return 440.0 * 2 ** (semi_from_a4 / 12)


def lowpass(x, fc, res=0.0):
    """Gentle low-pass in the frequency domain (fine for short note buffers)."""
    n = len(x); X = np.fft.rfft(x, 2 * n); f = np.fft.rfftfreq(2 * n, 1 / SR)
    H = 1 / np.sqrt(1 + (f / fc) ** 4) * (1 + res * np.exp(-0.5 * ((f - fc) / (fc * 0.15)) ** 2))
    return np.fft.irfft(X * H)[:n]


def env(n, a=0.003, d=0.2, s=0.0, r=None):
    t = np.arange(n) / SR; e = np.minimum(1, t / max(a, 1e-4)) * (s + (1 - s) * np.exp(-t / d))
    if r: k = int(r * SR); e[-k:] *= np.linspace(1, 0, k) if k < n else 1
    return e


def saw(f, n, detune=0.0, voices=1, rng=None):
    t = np.arange(n) / SR; out = np.zeros(n)
    for v in range(voices):
        ff = f * (1 + detune * (v - (voices - 1) / 2) / max(1, voices - 1)); ph = rng.random() if rng is not None else 0
        out += 2 * ((t * ff + ph) % 1) - 1
    return out / voices


def kick(n):
    t = np.arange(n) / SR; f = 45 + 110 * np.exp(-t / 0.035)
    return np.sin(2 * np.pi * np.cumsum(f) / SR) * np.exp(-t / 0.28) + 0.3 * np.exp(-t / 0.004) * np.random.default_rng(1).standard_normal(n)


def clap(n, rng):
    x = rng.standard_normal(n); t = np.arange(n) / SR
    e = sum(np.exp(-np.maximum(0, t - o) / 0.012) * (t >= o) for o in (0, 0.009, 0.018)) + 0.6 * np.exp(-t / 0.12)
    return lowpass(x * e, 3500) * 0.9


def hat(n, rng, open_=False):
    x = rng.standard_normal(n); x = x - lowpass(x, 7000); return x * np.exp(-np.arange(n) / SR / (0.11 if open_ else 0.025))


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--out", required=True); ap.add_argument("--bpm", type=float, default=124); ap.add_argument("--sheet")
    ap.add_argument("--key", default="A"); ap.add_argument("--seed", type=int, default=3)
    a = ap.parse_args()
    rng = np.random.default_rng(a.seed)
    secs = [("hook", 8), ("title", 4), ("build", 8), ("drop", 8), ("fail", 4), ("end", 8)]
    if a.sheet:
        secs = [(s["name"], s["beats"]) for s in json.load(open(a.sheet))["sections"]]
    beat = 60 / a.bpm; bar = 4 * beat; nb = sum(b for _, b in secs); total = nb * beat + 2.5
    L = np.zeros(int(total * SR)); Rr = np.zeros_like(L)
    def put(x, t, g=1.0, pan=0.0):
        i = int(t * SR); x = x[: max(0, len(L) - i)] * g
        L[i:i + len(x)] += x * np.cos((pan + 1) * np.pi / 4) * 1.414; Rr[i:i + len(x)] += x * np.sin((pan + 1) * np.pi / 4) * 1.414
    root = NOTES[a.key.upper()] - 9                        # semitones from A
    prog = [[0, 3, 7], [-4, 0, 3], [-9, -5, -2], [-2, 2, 5]]  # i - VI - III - VII in minor, relative to the root
    K, ksz = kick(int(0.5 * SR)), int(0.5 * SR)
    beat_i = 0
    for name, nbeats in secs:
        kind = name if name in ("hook", "title", "build", "drop", "fail", "end") else "build"
        t0 = beat_i * beat
        for b in range(nbeats):
            t = t0 + b * beat; gb = beat_i + b; chord = prog[(gb // 4) % 4]; bass_f = hz(root + chord[0] - 24)
            last_bar = b >= nbeats - 4
            if kind != "fail" and not (kind == "end" and b >= 4):
                put(K, t, {"drop": 0.95, "hook": 0.6}.get(kind, 0.8))
                if b % 2 == 1 and kind != "hook": put(clap(int(0.3 * SR), rng), t, 0.45 if kind in ("drop", "build") else 0.3)
                for h in range(2): put(hat(int(0.15 * SR), rng, open_=(h == 1 and kind == "drop")), t + h * beat / 2, 0.16 if h else 0.1, 0.3)
                # bass: off-beat pumping 8ths
                n = int(beat / 2 * SR); x = lowpass(saw(bass_f, n, 0.01, 2, rng), 600 if kind == "drop" else 380) * env(n, 0.004, 0.12, 0.5, 0.02)
                put(x, t + beat / 2, 0.55)
            if kind in ("build", "drop", "end") and kind != "fail":
                for s16 in range(4):                     # 16th arp
                    if kind == "end" and b >= 4: break
                    note = chord[(gb * 4 + s16) % 3] + 12 * ((s16 // 2) % 2)
                    n = int(beat / 4 * SR); x = np.sign(np.sin(2 * np.pi * hz(root + note) * np.arange(n) / SR)) * env(n, 0.002, 0.05)
                    put(lowpass(x, 2600 if kind == "drop" else 1800), t + s16 * beat / 4, 0.09, -0.4 + 0.8 * (s16 % 2))
            if b % 4 == 0:                               # chords on each bar
                dur = bar if kind != "fail" else nbeats * beat
                n = int(dur * SR); fc = {"hook": 900, "title": 1600, "build": 1400, "drop": 3200, "fail": 700, "end": 2200}[kind]
                for v, semi in enumerate(chord + [chord[0] + 12]):
                    x = lowpass(saw(hz(root + semi - 12), n, 0.012, 3, rng), fc) * env(n, 0.01 if kind != "fail" else 0.4, 0.5 if kind in ("hook", "title") else 2.5, 0.35, 0.05)
                    put(x, t, 0.08 if kind != "drop" else 0.1, -0.5 + v * 0.33)
            if kind == "build" and last_bar and b == nbeats - 4:          # riser into whatever comes next
                n = int(4 * beat * SR); tt = np.arange(n) / n
                x = (rng.standard_normal(n) - lowpass(rng.standard_normal(n), 300)) * tt ** 2.2
                put(lowpass(x, 6000), t, 0.25)
            if kind == "fail" and b == 0:
                n = int(nbeats * beat * SR); tt = np.arange(n) / SR; f = hz(root + 7) * np.exp(-tt / 1.5)
                put(np.sin(2 * np.pi * np.cumsum(f) / SR) * np.exp(-tt / 1.2) * 0.6, t, 0.3)
            if (kind in ("title",) and b == 0) or (kind == "drop" and b == 0) or (kind == "end" and b == 4):   # big hits
                n = int(2.2 * SR); tt = np.arange(n) / SR
                boom = np.sin(2 * np.pi * np.cumsum(38 + 60 * np.exp(-tt / 0.06)) / SR) * np.exp(-tt / (0.9 if kind == "end" else 0.5))
                crash = (rng.standard_normal(n) - lowpass(rng.standard_normal(n), 4000)) * np.exp(-tt / 0.9) * 0.35
                put(boom + crash, t, 0.75)
                if kind == "end":
                    for v, semi in enumerate(chord + [chord[0] + 12, chord[1] + 12]):
                        x = lowpass(saw(hz(root + semi - 12), n, 0.015, 3, rng), 2600) * env(n, 0.005, 1.4)
                        put(x, t, 0.09, -0.6 + v * 0.3)
        beat_i += nbeats
    st = np.stack([L, Rr], 1); st = np.tanh(st * 1.2) / np.tanh(1.2); st /= max(1e-9, np.max(np.abs(st)) / 0.9)
    raw = (st * 32767).astype("<i2").tobytes()
    ff = shutil.which("ffmpeg") or sys.exit("ffmpeg not found")
    subprocess.run([ff, "-y", "-loglevel", "error", "-f", "s16le", "-ar", str(SR), "-ac", "2", "-i", "-", a.out], input=raw, check=True)
    print(f"{a.bpm:g} BPM, {nb} beats ({nb * beat:.2f}s + tail) in {a.key} minor: " + ", ".join(f"{n} {b}" for n, b in secs) + f" -> {a.out}")


if __name__ == "__main__":
    main()
