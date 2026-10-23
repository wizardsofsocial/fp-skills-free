#!/usr/bin/env python3
"""A gentle, original music bed for a narrated explainer, synthesized from sine waves (nothing downloaded or licensed).

  python3 bed.py --dur 19.4 --out bed.wav [--bpm 84] [--key D] [--minor] [--sections 3.55,8.75,13.25] [--seed 3]

It plays one chord per bar (I V vi IV, or i VI III VII with --minor) as a soft pad, and adds a layer at each time in
--sections, so the music grows with the explanation instead of looping flat:
  section 0  pad only              (the hook: leave room for the first line)
  section 1  + bell arpeggio       (the mechanism)
  section 2  + sub bass on 1 and 3 (the reveal)
  section 3+ + soft offbeat shaker (the payoff)
Pass the scene start times as --sections so each new layer arrives with a scene. The last chord rings out over the
final 1.5 s. sfx.py then sets its loudness and ducks it under the voice-over, so the level here does not matter.
"""
import argparse, wave
import numpy as np

SR = 48000
NOTES = {'C': 0, 'C#': 1, 'Db': 1, 'D': 2, 'D#': 3, 'Eb': 3, 'E': 4, 'F': 5, 'F#': 6, 'Gb': 6, 'G': 7, 'G#': 8, 'Ab': 8, 'A': 9, 'A#': 10, 'Bb': 10, 'B': 11}


def hz(midi): return 440.0 * 2 ** ((midi - 69) / 12)


def tone(f, d, harmonics=6, tilt=1.6, detune=0.0015):
    """a warm, slightly chorused tone: a few harmonics falling off by 1/k^tilt, two copies detuned against each other"""
    t = np.arange(int(d * SR)) / SR; out = np.zeros_like(t)
    for k in range(1, harmonics + 1):
        for dt in (-detune, detune):
            out += np.sin(2 * np.pi * f * k * (1 + dt) * t + k * 0.7) / k ** tilt
    return out / harmonics


def env(n, a, r):
    e = np.ones(n); ai, ri = min(n, int(a * SR)), min(n, int(r * SR))
    e[:ai] = np.linspace(0, 1, ai) ** 2; e[n - ri:] *= np.linspace(1, 0, ri) ** 2
    return e


def place(buf, x, t, pan=0.0, g=1.0):
    i = int(t * SR); j = min(len(buf), i + len(x))
    if i >= len(buf) or j <= i: return
    l, r = np.cos((pan + 1) * np.pi / 4), np.sin((pan + 1) * np.pi / 4)
    buf[i:j, 0] += x[:j - i] * g * l * 1.414; buf[i:j, 1] += x[:j - i] * g * r * 1.414


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--dur', type=float, required=True); ap.add_argument('--out', required=True)
    ap.add_argument('--bpm', type=float, default=84); ap.add_argument('--key', default='D'); ap.add_argument('--minor', action='store_true')
    ap.add_argument('--sections', default=''); ap.add_argument('--seed', type=int, default=3)
    a = ap.parse_args()
    rng = np.random.default_rng(a.seed)
    beat = 60 / a.bpm; bar = 4 * beat; root = 48 + NOTES[a.key]            # C3-based root
    prog = [(0, 'm'), (8, 'M'), (3, 'M'), (10, 'M')] if a.minor else [(0, 'M'), (7, 'M'), (9, 'm'), (5, 'M')]
    secs = [0.0] + [float(x) for x in a.sections.split(',') if x.strip()]
    layer = lambda t: sum(1 for s in secs if t >= s - 1e-6) - 1
    n = int(a.dur * SR); mix = np.zeros((n, 2))

    bars = int(np.ceil(a.dur / bar))
    for b in range(bars):
        t0 = b * bar; off, q = prog[b % 4]; r = root + off
        chord = [r + 12, r + 12 + (3 if q == 'm' else 4), r + 19, r + 24]
        last = t0 + bar >= a.dur - 1e-6
        d = (a.dur - t0) if last else bar + 0.9                       # overlap into the next bar for a smooth change
        for i, m in enumerate(chord):                                  # pad
            x = tone(hz(m), d) * env(int(d * SR), 0.6, 1.4 if last else 0.9)
            place(mix, x, t0, pan=(-0.35, 0.35, -0.15, 0.15)[i], g=0.16)
        for beat_i in range(4):                                        # bass on 1 and 3
            tb = t0 + beat_i * beat
            if beat_i % 2 == 0 and layer(tb) >= 2 and tb < a.dur - 1.0:
                x = tone(hz(r), beat * 1.8, harmonics=2, tilt=3) * env(int(beat * 1.8 * SR), 0.02, 0.6)
                place(mix, x, tb, g=0.16)
        for s8 in range(8):                                            # bell arpeggio in eighths
            tb = t0 + s8 * beat / 2
            if layer(tb) >= 1 and tb < a.dur - 1.2:
                m = chord[[0, 1, 2, 3, 2, 1, 2, 3][s8]] + 12
                tt = np.arange(int(1.2 * SR)) / SR
                x = (np.sin(2 * np.pi * hz(m) * tt) + 0.25 * np.sin(2 * np.pi * hz(m) * 2.76 * tt) * np.exp(-tt * 9)) * np.exp(-tt * 3.2)
                x *= env(len(x), 0.004, 0.05)
                place(mix, x, tb, pan=0.4 if s8 % 2 else -0.4, g=0.13 * (1 if s8 % 2 == 0 else 0.7))
            if layer(tb) >= 3 and s8 % 2 == 1 and tb < a.dur - 1.0:     # offbeat shaker
                sh = rng.standard_normal(int(0.06 * SR)); sh = np.diff(sh, prepend=0) * np.exp(-np.arange(len(sh)) / SR * 60)
                place(mix, sh, tb, pan=0.2, g=0.05)

    fade = int(1.5 * SR); mix[-fade:] *= np.linspace(1, 0, fade)[:, None] ** 1.5
    mix /= max(1e-9, np.abs(mix).max()) / 0.89
    with wave.open(a.out, 'wb') as w:
        w.setnchannels(2); w.setsampwidth(2); w.setframerate(SR)
        w.writeframes((mix * 32767).astype('<i2').tobytes())
    print(f"wrote {a.out}: {a.dur:.1f}s, {a.bpm:g} BPM in {a.key} {'minor' if a.minor else 'major'}, layers at {secs}")


if __name__ == '__main__':
    main()
