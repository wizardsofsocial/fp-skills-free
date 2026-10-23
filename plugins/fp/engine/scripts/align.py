#!/usr/bin/env python3
"""Word timings for captions and lyrics: words.json with {w, t0, t1, line} for every word.

  python3 align.py vo --timing vo_timing.json --out words.json
        Word times inside each voice-over line (from voiceover.py or tts.py), refined by the pauses in the audio
        when --audio vo.wav is given. Good enough for word-by-word captions.

  python3 align.py lyrics --audio song.mp3 --lyrics lyrics.txt --out words.json [--model small] [--stems]
        Sung lyrics. The lyrics file is the truth (never invent or "correct" lyrics): speech recognition only
        supplies WHEN each word happens. Needs `pip install faster-whisper` (or openai-whisper). With --stems,
        vocals are isolated first with demucs (pip install demucs), which makes alignment far more accurate on
        dense mixes. Words the recognizer missed are interpolated between their matched neighbours and marked
        "est": true, so you know which ones to eyeball.

  python3 align.py lrc --lrc song.lrc --out words.json
        Use a hand-timed .lrc file (one timestamp per line); words are spread inside each line.

lyrics.txt: one lyric line per line; blank lines separate sections. Lines in [brackets] are ignored (e.g. [Chorus]).
"""
import argparse, difflib, json, os, re, shutil, subprocess, sys, tempfile


def clean(w):
    return re.sub(r"[^\w']", "", w.lower())


def spread(text, t0, t1, line):
    words = text.split(); w = [len(clean(x)) + 2 for x in words]; tot = sum(w) or 1; t = t0; out = []
    for x, k in zip(words, w):
        d = (t1 - t0) * k / tot
        out.append({"w": x, "t0": round(t, 3), "t1": round(t + d * 0.92, 3), "line": line}); t += d
    return out


def cmd_vo(a):
    rows = json.load(open(a.timing))
    out = []
    for r in rows:
        out += spread(r["text"], r["t"], r["t"] + r["spoken"], r["line"])
    json.dump({"words": out}, open(a.out, "w"), indent=1)
    print(f"{len(out)} words from {len(rows)} lines -> {a.out}")


def transcribe(audio, model):
    try:
        from faster_whisper import WhisperModel
        m = WhisperModel(model, compute_type="int8")
        segs, _ = m.transcribe(audio, word_timestamps=True, vad_filter=False)
        return [(w.word.strip(), w.start, w.end) for s in segs for w in (s.words or [])]
    except ImportError:
        pass
    try:
        import whisper
        m = whisper.load_model(model)
        r = m.transcribe(audio, word_timestamps=True)
        return [(w["word"].strip(), w["start"], w["end"]) for s in r["segments"] for w in s.get("words", [])]
    except ImportError:
        sys.exit("needs speech recognition: pip install faster-whisper   (or: pip install openai-whisper)")


def vocals(audio):
    out = tempfile.mkdtemp(prefix="stems_")
    subprocess.run([sys.executable, "-m", "demucs", "--two-stems", "vocals", "-o", out, audio], check=True)
    for root, _, files in os.walk(out):
        for f in files:
            if f.startswith("vocals"):
                return os.path.join(root, f)
    sys.exit("demucs ran but produced no vocals stem")


def cmd_lyrics(a):
    lines = [l.strip() for l in open(a.lyrics, encoding="utf8")]
    truth = []  # (word, line_no)
    ln = 0
    for l in lines:
        if not l or (l.startswith("[") and l.endswith("]")):
            continue
        ln += 1
        truth += [(w, ln) for w in l.split()]
    src = vocals(a.audio) if a.stems else a.audio
    heard = transcribe(src, a.model)
    A = [clean(w) for w, _ in truth]; B = [clean(w) for w, _, _ in heard]
    times = [None] * len(truth)
    for blk in difflib.SequenceMatcher(None, A, B, autojunk=False).get_matching_blocks():
        for k in range(blk.size):
            _, s, e = heard[blk.b + k]; times[blk.a + k] = (s, e)
    known = [i for i, t in enumerate(times) if t]
    if not known:
        sys.exit("no lyric words were recognized; try --stems, a bigger --model, or the lrc mode")
    out = []
    for i, (w, l) in enumerate(truth):
        if times[i]:
            out.append({"w": w, "t0": round(times[i][0], 3), "t1": round(times[i][1], 3), "line": l}); continue
        prv = max([k for k in known if k < i], default=None); nxt = min([k for k in known if k > i], default=None)
        t0 = times[prv][1] if prv is not None else max(0, times[nxt][0] - 0.4 * (nxt - i))
        t1 = times[nxt][0] if nxt is not None else times[prv][1] + 0.4 * (i - prv)
        span = (prv if prv is not None else i - 1, nxt if nxt is not None else i + 1)
        f = (i - span[0]) / max(1, span[1] - span[0])
        s = t0 + (t1 - t0) * (f - 1 / max(1, span[1] - span[0])); e = t0 + (t1 - t0) * f
        out.append({"w": w, "t0": round(max(0, s), 3), "t1": round(max(s + 0.08, e), 3), "line": l, "est": True})
    json.dump({"words": out}, open(a.out, "w"), indent=1)
    est = sum(1 for w in out if w.get("est"))
    print(f"{len(out)} lyric words, {len(out) - est} matched to the audio, {est} interpolated (marked est) -> {a.out}")


def cmd_lrc(a):
    rows = []
    for l in open(a.lrc, encoding="utf8"):
        m = re.match(r"\[(\d+):(\d+(?:\.\d+)?)\](.*)", l.strip())
        if m:
            rows.append((int(m.group(1)) * 60 + float(m.group(2)), m.group(3).strip()))
    out = []
    for i, (t, text) in enumerate(rows):
        if not text:
            continue
        end = rows[i + 1][0] if i + 1 < len(rows) else t + 4
        out += spread(text, t, end - 0.15, i + 1)
    json.dump({"words": out}, open(a.out, "w"), indent=1)
    print(f"{len(out)} words from {len(rows)} lrc lines -> {a.out}")


ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
sub = ap.add_subparsers(dest="cmd", required=True)
v = sub.add_parser("vo"); v.add_argument("--timing", required=True); v.add_argument("--out", required=True)
ly = sub.add_parser("lyrics"); ly.add_argument("--audio", required=True); ly.add_argument("--lyrics", required=True)
ly.add_argument("--out", required=True); ly.add_argument("--model", default="small"); ly.add_argument("--stems", action="store_true")
lr = sub.add_parser("lrc"); lr.add_argument("--lrc", required=True); lr.add_argument("--out", required=True)
args = ap.parse_args()
{"vo": cmd_vo, "lyrics": cmd_lyrics, "lrc": cmd_lrc}[args.cmd](args)
