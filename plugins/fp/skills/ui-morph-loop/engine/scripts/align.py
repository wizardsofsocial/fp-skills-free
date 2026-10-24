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

  python3 align.py transcribe --audio talk.wav --out words.json [--model small] [--lang en] [--prompt "Names, jargon"]
                              [--max-words 7] [--gap 0.6]
        No script at all (a recorded talk, an interview, footage): speech recognition writes the words AND their times
        (faster-whisper, installed by `setup.sh --music`; video files work too). Caption lines break at the end of a
        sentence, at a pause longer than --gap seconds, or after --max-words words (never leaving one or two words
        of a sentence alone on the next line). Also writes words.txt, one caption line per line, to read through.
        This is what was heard, not what was meant: check names and numbers before they go on screen, and pass
        --prompt with the right spellings. Never use it for lyrics (use `lyrics`).

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


def transcribe(audio, model, lang=None, prompt=None, vad=False):
    try:
        from faster_whisper import WhisperModel
        m = WhisperModel(model, compute_type="int8")
        segs, _ = m.transcribe(audio, word_timestamps=True, vad_filter=vad, language=lang, initial_prompt=prompt or None)
        return [(w.word.strip(), w.start, w.end) for s in segs for w in (s.words or [])]
    except ImportError:
        pass
    try:
        import whisper
        m = whisper.load_model(model)
        r = m.transcribe(audio, word_timestamps=True, language=lang, initial_prompt=prompt or None)
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


def cmd_transcribe(a):
    heard = [(w, s, e) for w, s, e in transcribe(a.audio, a.model, a.lang, a.prompt, vad=True) if clean(w) or w.strip()]
    if not heard:
        sys.exit("no speech was recognized in " + a.audio)
    ends = [w[-1:] in ".?!" or (i + 1 < len(heard) and heard[i + 1][1] - e > a.gap) for i, (w, _, e) in enumerate(heard)]
    def left(i):                       # words from i to the end of its sentence or phrase
        j = i
        while j < len(heard) - 1 and not ends[j]: j += 1
        return j - i + 1
    out, line, n = [], 1, 0
    for i, (w, s, e) in enumerate(heard):
        # a new line after a sentence end or a pause; after max-words too, unless only 1-2 words of the sentence remain
        if n and (ends[i - 1] or (n >= a.max_words and left(i) > 2)):
            line += 1; n = 0
        out.append({"w": w, "t0": round(s, 3), "t1": round(max(e, s + 0.05), 3), "line": line}); n += 1
    json.dump({"words": out, "source": "transcribed"}, open(a.out, "w"), indent=1)
    lines = {}
    for w in out:
        lines.setdefault(w["line"], []).append(w)
    txt = os.path.splitext(a.out)[0] + ".txt"
    with open(txt, "w", encoding="utf8") as f:
        for ws in lines.values():
            f.write(f"{ws[0]['t0']:7.2f}  {' '.join(x['w'] for x in ws)}\n")
    print(f"{len(out)} words in {len(lines)} caption lines, transcribed with whisper '{a.model}' -> {a.out}, {txt}")
    print("  this is what the recognizer heard: check names and numbers before they go on screen")


ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
sub = ap.add_subparsers(dest="cmd", required=True)
v = sub.add_parser("vo"); v.add_argument("--timing", required=True); v.add_argument("--out", required=True)
ly = sub.add_parser("lyrics"); ly.add_argument("--audio", required=True); ly.add_argument("--lyrics", required=True)
ly.add_argument("--out", required=True); ly.add_argument("--model", default="small"); ly.add_argument("--stems", action="store_true")
lr = sub.add_parser("lrc"); lr.add_argument("--lrc", required=True); lr.add_argument("--out", required=True)
tr = sub.add_parser("transcribe"); tr.add_argument("--audio", required=True); tr.add_argument("--out", required=True)
tr.add_argument("--model", default="small"); tr.add_argument("--lang"); tr.add_argument("--prompt")
tr.add_argument("--max-words", type=int, default=7); tr.add_argument("--gap", type=float, default=0.6)
args = ap.parse_args()
{"vo": cmd_vo, "lyrics": cmd_lyrics, "lrc": cmd_lrc, "transcribe": cmd_transcribe}[args.cmd](args)
