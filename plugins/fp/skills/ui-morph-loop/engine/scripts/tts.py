#!/usr/bin/env python3
"""Voice-over from a timed script with a free or local TTS engine, plus exact word timings for captions.

  python3 tts.py render --script vo.json --out vo.wav [--engine edge|say] [--voice en-US-AndrewNeural] [--rate +0%] [--dur 60]
  python3 tts.py voices [--engine edge]

Same vo.json as voiceover.py (ElevenLabs): {"lines": [{"t": 0.4, "until": 5.8, "text": "..."}, ...]}.
vo.json may also carry "voice" and "rate" ({"voice": "en-US-EmmaNeural", "rate": "+6%", "lines": [...]}), so the
script remembers how it was read; --voice and --rate on the command line win when given.
Writes vo.wav, vo_timing.json (per line: start, spoken length, slot) and vo_words.json (per word: w, t0, t1, line),
which captions read to light up word by word.

Engines:
  edge   Microsoft Edge neural voices through the `edge-tts` package (pip install edge-tts). Free, needs internet,
         very good quality, and reports a timestamp for every word. Default when installed.
  say    macOS built-in `say` (offline, no install). Word times are estimated from character counts.
For the most natural read use voiceover.py (ElevenLabs), then `align.py vo` for word times.
"""
import argparse, asyncio, json, os, shutil, subprocess, sys, tempfile

SR = 48000


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


def duration(path):
    out = subprocess.run([FF, "-i", path], capture_output=True, text=True).stderr
    for line in out.splitlines():
        if "Duration:" in line:
            h, m, s = line.split("Duration:")[1].split(",")[0].strip().split(":")
            return int(h) * 3600 + int(m) * 60 + float(s)
    return 0.0


def estimate_words(text, t0, length, line):
    """Spread words over the spoken length by character weight (punctuation adds a small pause)."""
    words = text.split()
    w = [len(x.strip(".,!?;:")) + 1 + (3 if x[-1:] in ".,!?;:" else 0) for x in words]
    tot = sum(w) or 1; t = t0; out = []
    for x, k in zip(words, w):
        d = length * k / tot
        out.append({"w": x, "t0": round(t, 3), "t1": round(t + d * 0.92, 3), "line": line}); t += d
    return out


async def edge_line(text, voice, rate, mp3):
    import edge_tts
    com = edge_tts.Communicate(text, voice, rate=rate, boundary="WordBoundary")
    words = []
    with open(mp3, "wb") as f:
        async for ch in com.stream():
            if ch["type"] == "audio":
                f.write(ch["data"])
            elif ch["type"] == "WordBoundary":
                words.append((ch["offset"] / 1e7, (ch["offset"] + ch["duration"]) / 1e7, ch["text"]))
    return words


def have_edge():
    try:
        import edge_tts  # noqa: F401
        return True
    except ImportError:
        return False


def render(a):
    spec = json.load(open(a.script)); lines = spec["lines"]
    voice = a.voice or spec.get("voice"); rate = a.rate or spec.get("rate") or "+0%"
    for i, l in enumerate(lines):
        l.setdefault("until", lines[i + 1]["t"] if i + 1 < len(lines) else None)
    engine = a.engine or ("edge" if have_edge() else ("say" if shutil.which("say") else None))
    if not engine:
        sys.exit("no TTS engine: pip install edge-tts (or run on macOS for `say`, or use voiceover.py with ElevenLabs)")
    if engine == "say" and not a.voice and voice and "Neural" in voice:
        voice = None                        # an edge voice name saved in vo.json means nothing to `say`
    tmp = tempfile.mkdtemp(prefix="tts_")
    trim = "silenceremove=start_periods=1:start_threshold=-45dB"
    rows, words, parts = [], [], []
    for i, l in enumerate(lines):
        raw = os.path.join(tmp, f"{i}.raw"); wav = os.path.join(tmp, f"{i}.wav")
        lead = 0.0; ws = None
        if engine == "edge":
            for attempt in range(4):        # the edge service sometimes answers "No audio received"; a retry works
                try:
                    ws = asyncio.run(edge_line(l["text"], voice or "en-US-AndrewNeural", rate, raw)); break
                except Exception as e:
                    if attempt == 3: raise
                    print(f"  edge-tts: {e}; retrying line {i + 1}"); import time; time.sleep(1.5 * (attempt + 1))
            lead = ws[0][0] if ws else 0.0          # the silence we trim off the front
            subprocess.run([FF, "-y", "-loglevel", "error", "-i", raw, "-af", f"atrim=start={lead}", "-ar", str(SR), "-ac", "2", wav], check=True)
        else:
            cmd = ["say", "-o", raw + ".aiff"] + (["-v", voice] if voice else []) + [l["text"]]
            subprocess.run(cmd, check=True)
            subprocess.run([FF, "-y", "-loglevel", "error", "-i", raw + ".aiff", "-af", trim, "-ar", str(SR), "-ac", "2", wav], check=True)
        n = duration(wav)
        if ws:
            words += [{"w": w, "t0": round(l["t"] + s - lead, 3), "t1": round(l["t"] + e - lead, 3), "line": i + 1} for s, e, w in ws]
        else:
            words += estimate_words(l["text"], l["t"], n, i + 1)
        slot = (l["until"] - l["t"]) if l["until"] is not None else None
        rows.append(dict(line=i + 1, t=l["t"], spoken=round(n, 3), ends=round(l["t"] + n, 3), slot=slot, text=l["text"]))
        parts.append((wav, l["t"]))
    dur = a.dur or max(r["ends"] for r in rows) + 0.5
    inputs = sum((["-i", p] for p, _ in parts), [])
    delays = ";".join(f"[{i}:a]adelay={int(t * 1000)}|{int(t * 1000)}[d{i}]" for i, (_, t) in enumerate(parts))
    graph = delays + ";" + "".join(f"[d{i}]" for i in range(len(parts))) + f"amix=inputs={len(parts)}:normalize=0:duration=longest,apad,atrim=0:{dur}[a]"
    subprocess.run([FF, "-y", "-loglevel", "error", *inputs, "-filter_complex", graph, "-map", "[a]", "-ar", str(SR), a.out], check=True)
    base = os.path.splitext(a.out)[0]
    json.dump(rows, open(base + "_timing.json", "w"), indent=1)
    json.dump({"words": words}, open(base + "_words.json", "w"), indent=1)
    over = [r for r in rows if r["slot"] is not None and r["spoken"] > r["slot"]]
    for r in rows:
        flag = "  <- OVER: shorten the line or move 'until'" if r in over else ""
        print(f"{r['line']:>2} {r['t']:6.2f}s spoken {r['spoken']:5.2f}s slot {'' if r['slot'] is None else round(r['slot'], 2)}  {r['text'][:60]}{flag}")
    print(f"wrote {a.out} ({dur:.1f}s, engine {engine}{', voice ' + voice if voice else ''}{', rate ' + rate if engine == 'edge' else ''}), {base}_timing.json, {base}_words.json ({len(words)} words)")


def voices(a):
    if (a.engine or "edge") == "edge":
        import edge_tts
        for v in asyncio.run(edge_tts.list_voices()):
            print(v["ShortName"], v["Gender"], v.get("Locale"))
    else:
        print(subprocess.run(["say", "-v", "?"], capture_output=True, text=True).stdout)


ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
sub = ap.add_subparsers(dest="cmd", required=True)
r = sub.add_parser("render"); r.add_argument("--script", required=True); r.add_argument("--out", required=True)
r.add_argument("--engine", choices=["edge", "say"]); r.add_argument("--voice"); r.add_argument("--rate", help="edge speaking rate, e.g. +6%% (default: vo.json \"rate\", else +0%%)")
r.add_argument("--dur", type=float)
v = sub.add_parser("voices"); v.add_argument("--engine", choices=["edge", "say"])
args = ap.parse_args()
render(args) if args.cmd == "render" else voices(args)
