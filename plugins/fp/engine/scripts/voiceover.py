#!/usr/bin/env python3
"""Voice-over with ElevenLabs: render a timed script into one track that lines up with the video's scenes.

  python3 voiceover.py voices                                     # list the voices on your account (id, name, labels)
  python3 voiceover.py render --script vo.json --voice <voice_id> --out vo.wav [--dur 60]
                              [--model eleven_multilingual_v2] [--stability 0.5 --similarity 0.75 --style 0 --speed 1.0]
                              [--dry-run]

vo.json - one entry per line, t = when it starts in the video (s), until = when it must be finished (usually the next
scene's start; optional, defaults to the next line's t):
  {"voice": "<optional default voice_id>",
   "lines": [{"t": 0.4, "until": 5.8, "text": "Moving your HighLevel sub-account?"}, ...]}

Each line is its own request, sent with the neighbouring lines as previous_text/next_text so the delivery flows as one
read. Leading/trailing silence is trimmed so a line starts exactly at t. Every clip is cached in <out dir>/vo_cache/
keyed by text + voice + settings, so re-mixing or re-timing never pays for the same line twice. After rendering, a table
shows each line's spoken length against its slot and flags any that run over (shorten the copy, or move `until`).

The API key is read from the ELEVENLABS_API_KEY environment variable and nowhere else: never put it in a file, a
composition, a commit or a chat message. In a cloud session the host api.elevenlabs.io must also be allowed by the
environment's network policy. --dry-run prints what would be sent (and the character count you'd be billed for)
without calling the API. ELEVENLABS_BASE overrides the API base URL (for a proxy, or a local mock in tests).
"""
import argparse, hashlib, json, os, shutil, subprocess, sys, urllib.error, urllib.request

BASE = os.environ.get("ELEVENLABS_BASE", "https://api.elevenlabs.io").rstrip("/")
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


def key():
    k = os.environ.get("ELEVENLABS_API_KEY", "").strip()
    if not k:
        sys.exit("ELEVENLABS_API_KEY is not set. Add it as an environment variable (in a cloud session: the environment's "
                 "settings, then start a new session; locally: export it in ~/.zshrc, or run this command yourself after "
                 "read -s ELEVENLABS_API_KEY). Don't paste the key into a chat or a file.")
    return k


def call(method, path, body=None, accept="application/json"):
    req = urllib.request.Request(BASE + path, method=method, data=json.dumps(body).encode() if body is not None else None,
                                 headers={"xi-api-key": key(), "Content-Type": "application/json", "Accept": accept})
    try:
        with urllib.request.urlopen(req, timeout=120) as r:
            return r.read()
    except urllib.error.HTTPError as e:
        detail = e.read().decode(errors="replace")[:400]
        hint = {401: "the key is wrong or revoked", 402: "the account is out of credits", 422: "the request was rejected (bad voice id or settings?)",
                429: "rate limited: wait and re-run (cached lines are not re-billed)"}.get(e.code, "")
        sys.exit(f"ElevenLabs {e.code} on {path}{': ' + hint if hint else ''}\n{detail}")
    except urllib.error.URLError as e:
        sys.exit(f"Can't reach {BASE} ({e.reason}). In a cloud session, allow api.elevenlabs.io in the environment's network settings.")


def voices(_):
    data = json.loads(call("GET", "/v1/voices"))
    for v in sorted(data.get("voices", []), key=lambda v: (v.get("category") != "cloned", v.get("name", ""))):
        lab = v.get("labels") or {}
        desc = ", ".join(x for x in (lab.get("gender"), lab.get("age"), lab.get("accent"), lab.get("description"), lab.get("use_case")) if x)
        print(f"{v['voice_id']}  {v.get('name', ''):<22} {v.get('category', ''):<10} {desc}")


def load_script(path):
    spec = json.load(open(path))
    lines = spec["lines"] if isinstance(spec, dict) else spec
    lines = sorted(lines, key=lambda l: l["t"])
    for i, l in enumerate(lines):
        l.setdefault("until", lines[i + 1]["t"] if i + 1 < len(lines) else None)
    return (spec.get("voice") if isinstance(spec, dict) else None), lines


def duration(path):
    out = subprocess.run([ffmpeg(), "-i", path], capture_output=True, text=True).stderr
    h, m, s = out.split("Duration:")[1].split(",")[0].strip().split(":")
    return int(h) * 3600 + int(m) * 60 + float(s)


def render(a):
    default_voice, lines = load_script(a.script)
    voice = a.voice or default_voice
    if not voice:
        sys.exit("no voice: pass --voice <voice_id> (run `voiceover.py voices` to list them) or set \"voice\" in the script")
    settings = {"stability": a.stability, "similarity_boost": a.similarity, "style": a.style, "use_speaker_boost": True}
    if a.speed is not None:
        settings["speed"] = a.speed
    out_dir = os.path.dirname(os.path.abspath(a.out)); cache = os.path.join(out_dir, "vo_cache"); os.makedirs(cache, exist_ok=True)
    chars = sum(len(l["text"]) for l in lines)
    todo = []
    for i, l in enumerate(lines):
        body = {"text": l["text"], "model_id": a.model, "voice_settings": settings,
                "previous_text": " ".join(x["text"] for x in lines[max(0, i - 2):i]) or None,
                "next_text": lines[i + 1]["text"] if i + 1 < len(lines) else None}
        body = {k: v for k, v in body.items() if v is not None}
        h = hashlib.sha256(json.dumps([voice, body], sort_keys=True).encode()).hexdigest()[:16]
        l["clip"] = os.path.join(cache, f"{h}.mp3")
        if not os.path.exists(l["clip"]):
            todo.append((l, body))
    billed = sum(len(l["text"]) for l, _ in todo)
    print(f"{len(lines)} lines, {chars} characters; {len(todo)} to generate ({billed} characters billed), {len(lines) - len(todo)} cached")
    if a.dry_run:
        for l, body in todo:
            print(f"  POST /v1/text-to-speech/{voice}?output_format=mp3_44100_128  {json.dumps(body)[:160]}")
        return
    for l, body in todo:
        audio = call("POST", f"/v1/text-to-speech/{voice}?output_format=mp3_44100_128", body, accept="audio/mpeg")
        open(l["clip"], "wb").write(audio)
    ff = ffmpeg(); trim = "silenceremove=start_periods=1:start_threshold=-45dB,areverse,silenceremove=start_periods=1:start_threshold=-45dB,areverse"
    rows = []; parts = []
    for i, l in enumerate(lines):
        clean = l["clip"][:-4] + "_trim.wav"
        subprocess.run([ff, "-y", "-loglevel", "error", "-i", l["clip"], "-af", trim, "-ar", str(SR), "-ac", "2", clean], check=True)
        n = duration(clean); end = l["t"] + n
        slot = (l["until"] - l["t"]) if l["until"] is not None else None
        rows.append((i + 1, l["t"], n, end, slot, l["text"]))
        parts.append((clean, l["t"]))
    dur = a.dur or max(r[3] for r in rows) + 0.5
    inputs = sum((["-i", p] for p, _ in parts), [])
    delays = ";".join(f"[{i}:a]adelay={int(t * 1000)}|{int(t * 1000)}[d{i}]" for i, (_, t) in enumerate(parts))
    graph = delays + ";" + "".join(f"[d{i}]" for i in range(len(parts))) + f"amix=inputs={len(parts)}:normalize=0:duration=longest,apad,atrim=0:{dur}[a]"
    subprocess.run([ff, "-y", "-loglevel", "error", *inputs, "-filter_complex", graph, "-map", "[a]", "-ar", str(SR), a.out], check=True)
    over = 0
    print(f"\n{'#':>2}  {'start':>6} {'spoken':>7} {'ends':>6} {'slot':>6}  line")
    for i, t, n, end, slot, text in rows:
        flag = "" if slot is None or n <= slot - 0.3 else ("  <- OVER: shorten or move 'until'" if n > slot else "  <- tight (<0.3s to spare)")
        over += n > (slot or 1e9)
        print(f"{i:>2}  {t:6.2f} {n:6.2f}s {end:6.2f} {'' if slot is None else f'{slot:5.2f}s':>6}  {text[:60]}{flag}")
    json.dump([dict(line=i, t=t, spoken=round(n, 3), ends=round(e, 3), slot=s, text=x) for i, t, n, e, s, x in rows],
              open(os.path.splitext(a.out)[0] + "_timing.json", "w"), indent=1)
    print(f"\nwrote {a.out} ({dur:.1f}s){'; ' + str(over) + ' line(s) run over their slot' if over else ''}")


ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
sub = ap.add_subparsers(dest="cmd", required=True)
sub.add_parser("voices")
r = sub.add_parser("render")
r.add_argument("--script", required=True); r.add_argument("--out", required=True); r.add_argument("--voice")
r.add_argument("--dur", type=float, help="length of the output track (use the video's length)")
r.add_argument("--model", default="eleven_multilingual_v2", help="eleven_multilingual_v2 (best), or a faster/cheaper flash/turbo model")
r.add_argument("--stability", type=float, default=0.5); r.add_argument("--similarity", type=float, default=0.75)
r.add_argument("--style", type=float, default=0.0); r.add_argument("--speed", type=float, help="optional delivery speed, e.g. 1.05")
r.add_argument("--dry-run", action="store_true")
args = ap.parse_args()
voices(args) if args.cmd == "voices" else render(args)
