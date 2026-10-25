#!/usr/bin/env python3
"""Free stock footage from Pexels, for a short opening shot: search, then download the one the user picks.

  python3 stock.py search "<query>" [--n 3] [--orientation landscape]
  python3 stock.py get <id> --out intro/intro.mp4 [--start 0] [--seconds 6]

search lists the best matches with what the user needs to choose and to credit them: the clip's page on Pexels,
its creator, its length and size, and the license. Show the user two or three and let them pick.

get downloads the chosen clip (the 1080p file when there is one, else the closest above it, else the largest),
cuts it to --seconds from --start (6 s from 0 by default; an opening shot runs 3 to 8 s) and writes SOURCE.md
next to it: the page URL, the creator, the license name and URL, and the date of the download. Keep SOURCE.md
with the video; it is the record of where the shot came from.

The license: Pexels clips are free to use without paying or asking, but the Pexels License does not let a clip
suggest that the people in it, or Pexels, back a product, and it does not allow showing a recognisable person in
a bad or offensive light. So for an app demo pick shots with no logos or readable brand names and no recognisable
face that could read as that person recommending the app: hands on a keyboard, a person seen from behind or out
of focus, a desk, a street. Crediting the creator is not required but is good manners; SOURCE.md has the line.

The API key is read from the PEXELS_API_KEY environment variable and nowhere else: never put it in a file, a
commit or a chat message. It is sent to the Pexels API only: never to the host that serves the video files, and
never along a redirect.
PEXELS_BASE overrides the API base URL (for a local mock in tests). Exit codes: 0 done, 1 the API or the
download failed, 2 no key, no results, or a bad argument.
"""
import argparse, datetime, json, os, shutil, subprocess, sys, tempfile, urllib.error, urllib.parse, urllib.request

BASE = os.environ.get("PEXELS_BASE", "https://api.pexels.com").rstrip("/")
LICENSE = ("Pexels License", "https://www.pexels.com/license/")
REMINDER = ("Before you pick: the Pexels License does not let a clip suggest that the people in it (or Pexels) back the\n"
            "app, or show a recognisable person in a bad light. Choose a shot with no logos, no readable brand names and\n"
            "no recognisable face that could read as an endorsement (hands, a person from behind, a desk, a street).")


def die(msg, code=1):
    print(msg, file=sys.stderr)
    sys.exit(code)


def ffmpeg():
    p = shutil.which("ffmpeg")
    if p:
        return p
    try:
        import imageio_ffmpeg
        return imageio_ffmpeg.get_ffmpeg_exe()
    except ImportError:
        die("ffmpeg not found: pip install imageio-ffmpeg")


def key():
    k = os.environ.get("PEXELS_API_KEY", "").strip()
    if not k:
        die("PEXELS_API_KEY is not set. Get a free key at https://www.pexels.com/api/ and add it as an environment "
            "variable (locally: export it in ~/.zshrc, or run this command yourself after read -s PEXELS_API_KEY). "
            "Don't paste the key into a chat or a file. Or skip the search and supply your own clip as intro/intro.mp4.", 2)
    return k


def call(path):
    k = key()
    req = urllib.request.Request(BASE + path, headers={"Accept": "application/json"})
    # Unredirected: urllib never copies it onto a redirect, so a redirect to another host arrives without the key.
    req.add_unredirected_header("Authorization", k)
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            return json.loads(r.read())
    except urllib.error.HTTPError as e:
        detail = e.read().decode(errors="replace")[:400].replace(k, "[key]")
        hint = {401: "the key is wrong or revoked", 403: "the key is not allowed to do this", 404: "no such video",
                429: "rate limited (Pexels allows 200 requests an hour): wait and try again"}.get(e.code, "")
        die(f"Pexels {e.code} on {path.split('?')[0]}{': ' + hint if hint else ''}\n{detail}")
    except urllib.error.URLError as e:
        die(f"Can't reach {BASE} ({e.reason}). Check the network, or supply your own clip as intro/intro.mp4.")
    except json.JSONDecodeError:
        die(f"Pexels sent something that is not JSON on {path.split('?')[0]}")


def creator(v):
    u = v.get("user") or {}
    return u.get("name") or "unknown", u.get("url") or ""


def search(a):
    if not 1 <= a.n <= 80:
        die("--n must be 1 to 80", 2)
    q = urllib.parse.urlencode({"query": a.query, "per_page": a.n, "orientation": a.orientation})
    videos = (call(f"/v1/videos/search?{q}").get("videos") or [])[:a.n]
    if not videos:
        die(f'No Pexels videos for "{a.query}". Try other words (what is in the shot, not what it means), '
            "or supply your own clip as intro/intro.mp4.", 2)
    for i, v in enumerate(videos, 1):
        name, url = creator(v)
        print(f"{i}. id {v['id']}  {v.get('duration', '?')} s  {v.get('width', '?')}x{v.get('height', '?')}")
        print(f"   page     {v.get('url', '')}")
        print(f"   creator  {name}  {url}")
        print(f"   license  {LICENSE[0]}  {LICENSE[1]}")
        if v.get("image"):
            print(f"   preview  {v['image']}")
    print(f"\nDownload the one the user picks: python3 {os.path.basename(__file__)} get <id> --out intro/intro.mp4")
    print(REMINDER)


def pick_file(v):
    files = [f for f in v.get("video_files") or [] if f.get("file_type") == "video/mp4" and f.get("link") and f.get("width")]
    if not files:
        die(f"Pexels video {v.get('id')} has no MP4 file to download")
    big = sorted((f for f in files if f["width"] >= 1920), key=lambda f: f["width"])
    return big[0] if big else max(files, key=lambda f: f["width"])


def download(url, dest):
    # The video files live on a CDN: the API key is never sent there.
    req = urllib.request.Request(url, headers={"User-Agent": "fp-app-demo stock.py"})
    try:
        with urllib.request.urlopen(req, timeout=300) as r, open(dest, "wb") as f:
            shutil.copyfileobj(r, f)
    except (urllib.error.URLError, OSError) as e:
        die(f"The download failed ({getattr(e, 'reason', e)}): run the same command again")
    if os.path.getsize(dest) == 0:
        die("The download was empty: run the same command again")


def get(a):
    if a.seconds <= 0 or a.start < 0:
        die("--seconds must be above 0 and --start 0 or more", 2)
    v = call(f"/v1/videos/videos/{urllib.parse.quote(str(a.id))}")
    f = pick_file(v)
    out = os.path.abspath(a.out)
    os.makedirs(os.path.dirname(out), exist_ok=True)
    work = tempfile.mkdtemp(prefix="stock-", dir=os.path.dirname(out))
    try:
        raw = os.path.join(work, "raw.mp4")
        download(f["link"], raw)
        cut = os.path.join(work, "cut.mp4")
        # Re-encoded so the cut lands on the exact frame; the sound is dropped (the build uses its own voice and music).
        r = subprocess.run([ffmpeg(), "-nostdin", "-loglevel", "error", "-y", "-ss", str(a.start), "-i", raw, "-t", str(a.seconds),
                            "-an", "-c:v", "libx264", "-preset", "slow", "-crf", "17", "-pix_fmt", "yuv420p", "-movflags", "+faststart", cut],
                           capture_output=True, text=True)
        if r.returncode != 0 or not os.path.exists(cut) or os.path.getsize(cut) == 0:
            die(f"ffmpeg could not cut the clip: {r.stderr.strip()[:400]}")
        os.replace(cut, out)
    finally:
        shutil.rmtree(work, ignore_errors=True)
    name, url = creator(v)
    today = datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%d")
    src = os.path.join(os.path.dirname(out), "SOURCE.md")
    with open(src, "w") as fh:
        fh.write(f"# Opening shot source\n\n"
                 f"- Clip: {v.get('url', '')} (Pexels video {v.get('id')})\n"
                 f"- Creator: {name}{' (' + url + ')' if url else ''}\n"
                 f"- License: {LICENSE[0]}, {LICENSE[1]}\n"
                 f"- Downloaded: {today} (UTC), the {f['width']}x{f.get('height', '?')} file, cut to {a.seconds:g} s from {a.start:g} s\n"
                 f"- Credit line (optional, good manners): Video by {name} on Pexels\n\n"
                 "The Pexels License does not let this clip suggest that the people in it, or Pexels, back the app,\n"
                 "or show a recognisable person in a bad light.\n")
    print(f"wrote {out} and {src}")
    print(f"clip by {name}, {LICENSE[0]}. Look at it before the build: python3 replicate.py review {a.out} --out {os.path.join(os.path.dirname(a.out), 'review')}")


ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
sub = ap.add_subparsers(dest="cmd", required=True)
s = sub.add_parser("search"); s.add_argument("query"); s.add_argument("--n", type=int, default=3)
s.add_argument("--orientation", default="landscape", choices=["landscape", "portrait", "square"])
g = sub.add_parser("get"); g.add_argument("id"); g.add_argument("--out", required=True)
g.add_argument("--start", type=float, default=0.0); g.add_argument("--seconds", type=float, default=6.0)
args = ap.parse_args()
search(args) if args.cmd == "search" else get(args)
