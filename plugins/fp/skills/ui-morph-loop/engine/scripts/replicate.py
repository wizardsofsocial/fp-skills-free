#!/usr/bin/env python3
"""A generated opening shot from Replicate, with the cost shown first and a retry that never pays twice.

  python3 replicate.py price <owner/model>
  python3 replicate.py generate --model <owner/model[:version]> --prompt-file p.txt --seconds 6 --request-key K
                                --out intro/intro.mp4 [--duration-key duration] [--input name=value ...]
                                [--max-wait 1200] [--no-schema-check] --quoted-cost "<figure and basis>" --yes
  python3 replicate.py review intro/intro.mp4 --out intro/review

Money first. Generating costs the user money, so nothing is sent without their yes to a figure they have seen:
  1. price: Replicate's API does not publish a price for a model, so this prints the model's page, where the
     current price is shown, and how the model is billed. Read the figure there, work out the cost of this shot
     (for example 6 s at the per-second price), and show the user the model, the length and that cost.
  2. Only after the user says yes to that figure, run generate with --yes AND --quoted-cost set to the figure
     and its basis exactly as the user saw it (for example "$0.80 for 6 s at $0.133/s per the model page").
     Without both it prints what it would send and stops before any request at all, reads included. The quoted
     cost is written into the ledger next to the request and printed again at the end, so every paid run carries
     the figure it was agreed at.

Retry safety. --request-key names one request (pick something like intro-1). Every key is recorded in
<out dir>/ledger.json: the key, the request's fingerprint, the quoted cost and the time, written before the
create call is sent, then the prediction id the moment the create call answers. Each write is atomic, so a kill
never leaves half a ledger, and an exclusive lock (<ledger>.lock) is held from reading the ledger until the
prediction id is saved, so two runs at once never both create, and never drop each other's entries. Re-running
the same command is always safe:
  - the prediction id is known: it is polled until it ends, then downloaded. It is never created again, and a
    status check is always a poll, never a new generation.
  - the create call went out but no answer came back (a timeout, a dropped connection, a killed process): the
    recent predictions on the account are searched for one with this model and these exact inputs, and that
    one is picked up. If none is found, nothing is sent: look at https://replicate.com/predictions, and only
    when it shows nothing for this shot, start over with a new --request-key (that one is billed).
  - the shot is already downloaded: nothing is sent.
  - the same key with a different model, prompt, length or input is refused: a key is one request.
A failed or canceled prediction is reported with Replicate's own error; re-running reads that result again. Try
again with a new --request-key (billed again) after changing the prompt. Replicate deletes the outputs of API
predictions after an hour, so generate downloads as soon as the prediction succeeds; an output that has already
expired is reported as such (the run was billed; a new key would generate and bill again).

Shot direction. The opening shot is 3 to 8 s of a person, calm, that ends on a still, clean frame the video can
cut from to the app. When writing the prompt:
  - never ask the model to draw text, letters, numbers, logos, brand names or an app screen: models garble them,
    and the app itself is shown by the real recording that follows;
  - one subject and one camera move (a slow push in, a gentle pan, or a locked-off shot), nothing more;
  - say how it ends: the person settles, the camera stops, the last second is calm;
  - no recognisable real person, and nobody who could read as recommending the app.
Then review the clip (review below) for warped hands and faces, flicker, and any fake text, before it is used.

The request. An official model is run by name (POST /v1/models/<owner>/<name>/predictions); any other model by
its latest version (POST /v1/predictions with "version"), or by the version in <owner/model:version>. The input
is {"prompt": <prompt file>, <--duration-key>: <--seconds>} plus every --input name=value (the value is read as
JSON when it parses, else as a string). Video models name their inputs differently, and a model may silently
drop an input it does not know and bill its own default length instead of the quoted one. So before the create
call, every input name is checked against the model's own input schema (the version's openapi_schema,
components.schemas.Input.properties); any name the model does not have is refused, with the model's real input
names listed, before anything is paid for. Use --duration-key (empty to leave the length out, so the model's
default length is used) and --input to match. If the schema cannot be read, generate refuses unless you pass
--no-schema-check, which sends the inputs unchecked at your own risk (the billed length may differ from the
quote). The create call is sent without "Prefer: wait", so it answers at once with the prediction id (a video
takes minutes, longer than the 60 s that header can hold a request open) and the window in which an answer can
be lost stays short.

review runs frames.py's blank and flicker checks on the clip, makes a labelled contact sheet every 0.5 s
(sheet.jpg), and saves the last frame (last.png, the one the cut leaves from). It sends nothing.

The token is read from the REPLICATE_API_TOKEN environment variable and nowhere else: never put it in a file, a
commit or a chat message. It is never printed and never written to the ledger. It is sent only to the API host,
and only over https (plain http is accepted only when REPLICATE_BASE itself is http, the local test mock). It is
never sent to Replicate's file host (replicate.delivery serves signed URLs), and a redirect to any other host, or
from https down to http, goes there without it. REPLICATE_BASE overrides
the API base URL (for a local mock in tests); REPLICATE_TIMEOUT (60 s) and REPLICATE_POLL_SECONDS (5 s) tune the
network waits. Exit codes: 0 done, 1 the API or the prediction failed or is still running (re-run the same
command), 2 refused (no --yes or --quoted-cost, no token, a reused key, an input the model does not have, a bad
argument).
"""
import argparse, contextlib, datetime, fcntl, hashlib, http.client, json, os, re, shutil, subprocess, sys, tempfile, time
import urllib.error, urllib.parse, urllib.request

BASE = os.environ.get("REPLICATE_BASE", "https://api.replicate.com").rstrip("/")
TIMEOUT = float(os.environ.get("REPLICATE_TIMEOUT") or 60)
POLL = float(os.environ.get("REPLICATE_POLL_SECONDS") or 5)
FRAMES = os.path.join(os.path.dirname(os.path.abspath(__file__)), "appdemo", "frames.py")
MODEL_RE = re.compile(r"^([A-Za-z0-9][\w.-]*)/([A-Za-z0-9][\w.-]*)(?::([0-9a-f]{64}))?$")
# Replicate sits behind Cloudflare, which answers 403 "error code: 1010" to urllib's default Python-urllib
# User-Agent. Every request here (API, polling, the lost-prediction search, the file download) says who it is.
USER_AGENT = "fp-app-demo replicate.py (+https://ferpatel.ai)"
_token = None


def die(msg, code=1):
    print(scrub(msg), file=sys.stderr)
    sys.exit(code)


def scrub(text):
    text = str(text)
    return text.replace(_token, "[token]") if _token else text


def token():
    global _token
    if _token is None:
        t = os.environ.get("REPLICATE_API_TOKEN", "").strip()
        if not t:
            die("REPLICATE_API_TOKEN is not set. Create a token at https://replicate.com/account/api-tokens and add it as an "
                "environment variable (locally: export it in ~/.zshrc, or run this command yourself after "
                "read -s REPLICATE_API_TOKEN). Don't paste the token into a chat or a file. Nothing was sent.", 2)
        _token = t
    return _token


class Rejected(Exception):
    """Replicate answered with a 4xx: the request was refused, so nothing was started or billed."""


class Uncertain(Exception):
    """No usable answer (timeout, dropped connection, 5xx): the request may or may not have been acted on."""


def page_url(owner, name):
    return f"https://replicate.com/{owner}/{name}"


def trusted(url):
    """The token goes to the API host over https (http only when REPLICATE_BASE itself is http, the test mock), and nowhere else."""
    u, base = urllib.parse.urlparse(url), urllib.parse.urlparse(BASE)
    return (u.hostname or "") == (base.hostname or "") and (u.scheme == "https" or base.scheme == "http")


class TokenRedirect(urllib.request.HTTPRedirectHandler):
    """The token rides as an unredirected header, which urllib never copies onto a redirect; this puts it back only
    when the new URL is a trusted host, so a redirect elsewhere arrives without it."""

    def redirect_request(self, req, fp, code, msg, headers, newurl):
        new = super().redirect_request(req, fp, code, msg, headers, newurl)
        auth = req.unredirected_hdrs.get("Authorization")
        if new is not None and auth and trusted(newurl):
            new.add_unredirected_header("Authorization", auth)
        return new


OPENER = urllib.request.build_opener(TokenRedirect)


def authed(url, method="GET", data=None, headers=None):
    req = urllib.request.Request(url, method=method, data=data, headers={"User-Agent": USER_AGENT, **(headers or {})})
    if trusted(url):
        req.add_unredirected_header("Authorization", f"Bearer {token()}")
    return req


def call(method, path, body=None):
    url = path if path.startswith("http") else BASE + path
    if not trusted(url):
        die(f"refusing to send the token to {urllib.parse.urlparse(url).hostname}")
    req = authed(url, method, json.dumps(body).encode() if body is not None else None,
                 {"Content-Type": "application/json", "Accept": "application/json"})
    try:
        with OPENER.open(req, timeout=TIMEOUT) as r:
            return json.loads(r.read())
    except urllib.error.HTTPError as e:
        detail = scrub(e.read().decode(errors="replace")[:400])
        hint = {401: "the token is wrong or revoked", 402: "the account needs a payment method or more credit",
                404: "no such model or prediction", 422: "the input was rejected (check the model's input names)",
                429: "rate limited: wait and re-run the same command"}.get(e.code, "")
        msg = f"Replicate {e.code} on {urllib.parse.urlparse(url).path}{': ' + hint if hint else ''}\n{detail}"
        raise (Rejected if 400 <= e.code < 500 else Uncertain)(msg)
    except urllib.error.URLError as e:
        if isinstance(e.reason, ConnectionRefusedError):
            raise Rejected(f"Can't reach {BASE} (connection refused): nothing was sent")
        raise Uncertain(f"No answer from {BASE} ({e.reason})")
    except (TimeoutError, OSError, http.client.HTTPException, ValueError) as e:
        raise Uncertain(f"No usable answer from {BASE} ({type(e).__name__}: {e})")


def get(path):
    """A read: free, so any failure just stops with the reason."""
    try:
        return call("GET", path)
    except (Rejected, Uncertain) as e:
        die(f"{e}\nRe-running the same command is safe.")


def parse_model(s):
    m = MODEL_RE.match(s or "")
    if not m:
        die(f"--model must be owner/name or owner/name:<64-character version id>, not {s!r}", 2)
    return m.group(1), m.group(2), m.group(3)


# ---------------------------------------------------------------- price
def price(a):
    owner, name, _ = parse_model(a.model)
    url = page_url(owner, name)
    show = ("Show the user that figure, the model and the length before asking for their yes; then run generate with "
            "--yes and --quoted-cost \"<the figure and its basis, as they saw it>\".")
    if not os.environ.get("REPLICATE_API_TOKEN", "").strip():
        print(f"{owner}/{name}: no price from the API (it does not publish one, and REPLICATE_API_TOKEN is not set).")
        print(f"Read the current price on {url} and work out the cost of this shot from it.")
        print(show)
        return
    m = get(f"/v1/models/{owner}/{name}")
    official = bool(m.get("is_official"))
    page = m.get("url") or url
    print(f"{owner}/{name}: {m.get('description') or ''}".rstrip(": "))
    print(f"  page      {page}")
    print(f"  kind      {'official model: billed by what it makes (for video, usually per second of output or per run)' if official else 'community model: billed by the hardware time each run takes'}")
    print(f"  price     no price in Replicate's API: the figure must be read on {page}")
    print("Work out this shot's cost from that figure (for example 6 s times the per-second price).")
    print(show)


# ---------------------------------------------------------------- ledger
def ledger_path(out):
    return os.path.join(os.path.dirname(os.path.abspath(out)), "ledger.json")


@contextlib.contextmanager
def locked(lpath):
    """An exclusive lock on <ledger>.lock: one process at a time reads, decides and writes the ledger."""
    os.makedirs(os.path.dirname(lpath), exist_ok=True)
    with open(lpath + ".lock", "a") as f:
        fcntl.flock(f, fcntl.LOCK_EX)
        try:
            yield
        finally:
            fcntl.flock(f, fcntl.LOCK_UN)


def load_ledger(path):
    if not os.path.exists(path):
        return {"requests": {}}
    try:
        with open(path) as f:
            data = json.load(f)
        data.setdefault("requests", {})
        return data
    except (OSError, ValueError) as e:
        die(f"{path} cannot be read ({e}). It is the record of what was paid for: fix or move it by hand, never delete it "
            "to retry.", 2)


def save_ledger(path, data):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    fd, tmp = tempfile.mkstemp(prefix=".ledger-", dir=os.path.dirname(path))
    with os.fdopen(fd, "w") as f:
        json.dump(data, f, indent=1)
        f.flush()
        os.fsync(f.fileno())
    os.replace(tmp, path)


def now_iso():
    return datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def update_entry(lpath, key, **fields):
    """Re-read the ledger under the lock and change only this key's entry, so another run's entries survive."""
    with locked(lpath):
        ledger = load_ledger(lpath)
        entry = ledger["requests"].setdefault(key, {})
        entry.update(fields, updated_at=now_iso())
        save_ledger(lpath, ledger)
        return dict(entry)


# ---------------------------------------------------------------- generate
def build_input(a, prompt):
    inp = {"prompt": prompt}
    if a.duration_key:
        inp[a.duration_key] = int(a.seconds) if float(a.seconds).is_integer() else a.seconds
    for kv in a.input or []:
        if "=" not in kv:
            die(f"--input takes name=value, not {kv!r}", 2)
        k, v = kv.split("=", 1)
        try:
            inp[k] = json.loads(v)
        except ValueError:
            inp[k] = v
    return inp


def input_schema(version_obj):
    """The model's input names, from a version's openapi_schema, or None when it is not there."""
    try:
        props = version_obj["openapi_schema"]["components"]["schemas"]["Input"]["properties"]
    except (KeyError, TypeError):
        return None
    return props if isinstance(props, dict) and props else None


def check_inputs(a, inp, owner, name, props):
    if props is None:
        if a.no_schema_check:
            print(f"warning: {owner}/{name} published no input schema; sending {', '.join(inp)} unchecked (--no-schema-check). "
                  "If the model ignores one of them, it bills its own default, not the quoted length.")
            return
        die(f"Refused: the input schema of {owner}/{name} could not be read, so there is no way to know that it takes "
            f"{', '.join(inp)}. A model that drops an unknown length input bills its own default length, not the quoted "
            "one. Nothing was paid for. Check the model's API page; to send anyway at your own risk, add --no-schema-check.", 2)
    unknown = [k for k in inp if k not in props]
    if unknown:
        die(f"Refused: {owner}/{name} has no input named {', '.join(unknown)}. Its inputs are: {', '.join(sorted(props))}. "
            "Set --duration-key to the model's length input (and --input names to match); nothing was paid for.", 2)
    if not a.duration_key:
        print(f"note: no length input is sent (--duration-key is empty): {owner}/{name} runs its own default length.")


def find_lost(entry):
    """The prediction a lost create call started, if Replicate has one with this model and exactly these inputs."""
    since = datetime.datetime.strptime(entry["sent_at"], "%Y-%m-%dT%H:%M:%SZ") - datetime.timedelta(minutes=2)
    path = "/v1/predictions?" + urllib.parse.urlencode({"created_after": since.strftime("%Y-%m-%dT%H:%M:%SZ")})
    found = []
    for _ in range(10):  # 100 per page; a few pages is plenty for a two-minute window
        page = get(path)
        for p in page.get("results") or []:
            inp = p.get("input") or {}
            if p.get("model") == entry["model"] and all(inp.get(k) == v for k, v in entry["input"].items()):
                found.append(p)
        path = page.get("next")
        if not path:
            break
    found.sort(key=lambda p: p.get("created_at") or "")
    return found[0] if found else None


def output_url(out):
    if isinstance(out, str):
        return out
    if isinstance(out, list):
        return next((u for u in out if isinstance(u, str) and u.startswith("http")), None)
    if isinstance(out, dict):
        return next((u for u in out.values() if isinstance(u, str) and u.startswith("http")), None)
    return None


def download(url, dest):
    # No token: the file host serves signed URLs, so nothing secret goes with the request.
    # A temp file of its own, so two runs that pick up the same prediction never write into one file.
    fd, part = tempfile.mkstemp(prefix=".download-", suffix=".part", dir=os.path.dirname(dest))
    try:
        with OPENER.open(urllib.request.Request(url, headers={"User-Agent": USER_AGENT}), timeout=max(TIMEOUT, 300)) as r, os.fdopen(fd, "wb") as f:
            shutil.copyfileobj(r, f)
    except (urllib.error.URLError, OSError, http.client.HTTPException) as e:
        if os.path.exists(part):
            os.remove(part)
        die(f"The download failed ({getattr(e, 'reason', e)}). Re-run the same command soon: it downloads again "
            "without paying again, while Replicate still holds the file (about an hour after it was made).")
    if os.path.getsize(part) == 0:
        os.remove(part)
        die("The download was empty. Re-run the same command: it downloads again without paying again.")
    os.replace(part, dest)


def generate(a):
    owner, name, version = parse_model(a.model)
    if not 3 <= a.seconds <= 8:
        die("--seconds must be 3 to 8: the opening shot is short, calm and ends on a clean frame", 2)
    try:
        with open(a.prompt_file) as f:
            prompt = f.read().strip()
    except OSError as e:
        die(f"cannot read the prompt file: {e}", 2)
    if not prompt:
        die("the prompt file is empty", 2)
    if not re.match(r"^[\w.-]{1,80}$", a.request_key):
        die("--request-key must be 1 to 80 letters, digits, dots, dashes or underscores", 2)
    inp = build_input(a, prompt)
    out = os.path.abspath(a.out)
    quoted = (a.quoted_cost or "").strip()
    if not a.yes or not quoted:
        print(f"Would run {owner}/{name} for a {a.seconds:g} s shot (request key {a.request_key}) with input:")
        print("  " + json.dumps(inp))
        missing = " and ".join(x for x, ok in (("--yes", a.yes), ("--quoted-cost", quoted)) if not ok)
        die(f"Refused: generate needs --yes and --quoted-cost (missing {missing}). Nothing was sent. Read the price on "
            f"{page_url(owner, name)} (replicate.py price {owner}/{name}), show the user the model, the length and the "
            "cost, and only after their yes re-run with --yes --quoted-cost \"<that figure and its basis>\".", 2)
    token()
    fp = hashlib.sha256(json.dumps({"model": f"{owner}/{name}", "version": version, "input": inp}, sort_keys=True).encode()).hexdigest()
    lpath = ledger_path(out)
    key = a.request_key

    # From reading the ledger until the prediction id is on disk, no other run can read or write it.
    with locked(lpath):
        ledger = load_ledger(lpath)
        entry = ledger["requests"].get(key)
        if entry and entry.get("fingerprint") != fp:
            die(f"Refused: request key {key} was already used for a different request (another model, prompt, length "
                "or input). A key names one request, so nothing was sent. For a new shot use a new --request-key (it is "
                "billed); to pick up the old one, run it with its original prompt and settings.", 2)
        if entry and entry.get("status") == "downloaded" and os.path.exists(out):
            print(f"{a.out} is already downloaded for request key {key} (prediction {entry['prediction_id']}, quoted "
                  f"{entry.get('quoted_cost') or 'not recorded'}). Nothing was sent.")
            return

        def save(**fields):
            entry.update(fields, updated_at=now_iso())
            save_ledger(lpath, ledger)

        if entry and not entry.get("prediction_id"):
            print(f"Request key {key}: the create call went out at {entry['sent_at']} with no answer. Looking for the prediction it started...")
            p = find_lost(entry)
            if not p:
                die(f"No prediction on Replicate matches request key {key}, and nothing was sent now. Look at "
                    "https://replicate.com/predictions: if this shot is there, wait a minute and re-run the same command; "
                    "if it is not, the request never arrived, so start over with a new --request-key (that run is billed).")
            save(prediction_id=p["id"], status=p.get("status"), web=(p.get("urls") or {}).get("web"))
            print(f"Found it: prediction {p['id']} ({p.get('status')}). Picking it up, nothing new was created.")
        elif not entry:
            if version:
                v = get(f"/v1/models/{owner}/{name}/versions/{version}")
                create_path, body = "/v1/predictions", {"version": version, "input": inp}
            else:
                m = get(f"/v1/models/{owner}/{name}")
                v = m.get("latest_version") or {}
                if m.get("is_official"):
                    create_path, body = f"/v1/models/{owner}/{name}/predictions", {"input": inp}
                else:
                    if not v.get("id"):
                        die(f"{owner}/{name} has no published version to run. Nothing was sent.")
                    create_path, body = "/v1/predictions", {"version": v["id"], "input": inp}
            check_inputs(a, inp, owner, name, input_schema(v))
            entry = {"model": f"{owner}/{name}", "version": body.get("version"), "input": inp, "fingerprint": fp,
                     "quoted_cost": quoted, "out": a.out, "sent_at": now_iso(), "prediction_id": None, "status": "sending"}
            ledger["requests"][key] = entry
            save()  # on disk before the request leaves, so a lost answer is never mistaken for "never sent"
            print(f"Creating one prediction on {owner}/{name} ({a.seconds:g} s, quoted {quoted}), request key {key}...")
            try:
                p = call("POST", create_path, body)
            except Rejected as e:
                del ledger["requests"][key]
                save_ledger(lpath, ledger)
                die(f"{e}\nReplicate refused the request, so nothing was started or billed.")
            except Uncertain as e:
                die(f"{e}\nThe create call may have started a prediction. Re-run the same command: it looks for that "
                    "prediction and picks it up instead of creating another.")
            if not p.get("id"):
                die("Replicate's answer to the create call had no prediction id. Re-run the same command: it looks for the "
                    "prediction instead of creating another.")
            save(prediction_id=p["id"], status=p.get("status"), web=(p.get("urls") or {}).get("web"))
            print(f"prediction {p['id']} ({p.get('status')}), {entry.get('web') or ''}".rstrip(", "))
        else:
            print(f"Request key {key} is prediction {entry['prediction_id']}: checking on it, nothing new is created.")
        pid = entry["prediction_id"]
        quoted = entry.get("quoted_cost") or quoted

    start = time.time()
    last = None
    while True:
        p = get(f"/v1/predictions/{urllib.parse.quote(pid)}")
        status = p.get("status")
        if status != last:
            print(f"  {status}")
            last = status
            update_entry(lpath, key, status=status)
        if status in ("succeeded", "failed", "canceled"):
            break
        if time.time() - start > a.max_wait:
            die(f"Prediction {pid} is still {status} after {a.max_wait:g} s. Re-run the same command to keep waiting: it "
                "polls the same prediction and never pays again.")
        time.sleep(POLL)
    if status != "succeeded":
        update_entry(lpath, key, error=p.get("error"))
        die(f"Prediction {pid} {status}: {p.get('error') or 'Replicate gave no reason'}\nRe-running this command only reads "
            "that result again. To try again, change the prompt and use a new --request-key (that run is billed).")
    url = output_url(p.get("output"))
    if not url:
        update_entry(lpath, key, status="expired" if p.get("data_removed") else "no-output")
        die(f"Prediction {pid} succeeded but its output has expired or is missing (Replicate deletes API outputs after "
            "about an hour). It was billed; there is nothing left to download. A new --request-key would generate and "
            "bill it again.")
    os.makedirs(os.path.dirname(out), exist_ok=True)
    download(url, out)
    secs = (p.get("metrics") or {}).get("predict_time")
    update_entry(lpath, key, status="downloaded", predict_time=secs)
    print(f"wrote {a.out} (prediction {pid}{f', {secs:g} s of compute' if isinstance(secs, (int, float)) else ''}).")
    print(f"quoted cost: {quoted}. Check the actual charge on your Replicate account billing page.")
    print(f"Review it before it is used: python3 {os.path.basename(__file__)} review {a.out} --out "
          f"{os.path.join(os.path.dirname(a.out), 'review')}")


# ---------------------------------------------------------------- review
def review(a):
    if not os.path.exists(a.clip):
        die(f"no clip at {a.clip}", 2)
    os.makedirs(a.out, exist_ok=True)
    report = os.path.join(a.out, "check.json")
    c = subprocess.run([sys.executable, FRAMES, "check", a.clip, "--json", report])
    if c.returncode not in (0, 1) or not os.path.exists(report):
        die("frames.py could not check the clip (above)")
    sheet = os.path.join(a.out, "sheet.jpg")
    s = subprocess.run([sys.executable, FRAMES, "sheet", a.clip, "--every", "0.5", "--out", sheet, "--report", report],
                       stdout=subprocess.DEVNULL)
    if s.returncode != 0:
        die("frames.py could not make the contact sheet (above)")
    last = os.path.join(a.out, "last.png")
    ff = shutil.which("ffmpeg") or "ffmpeg"
    subprocess.run([ff, "-nostdin", "-v", "error", "-y", "-sseof", "-0.1", "-i", a.clip, "-frames:v", "1", "-update", "1", last])
    print(f"wrote {sheet} (a frame every 0.5 s, labelled with its time){' and ' + last if os.path.exists(last) else ''}")
    print("Look at every tile before the shot is used, and reject it for any of these:")
    print("  - warped hands or faces, extra or merging fingers, eyes or teeth that shift between frames")
    print("  - flicker, objects that appear or melt away, a jump in the light")
    print("  - any text, letters, logo or screen content (models invent them)")
    print("  - an ending that is not calm: the last frame (last.png) is what the video cuts from to the app")
    if c.returncode == 1:
        die(f"frames.py found blank or flickering frames (listed above and in {report}): do not use this clip")


if __name__ == "__main__":
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)
    pr = sub.add_parser("price"); pr.add_argument("model")
    g = sub.add_parser("generate")
    g.add_argument("--model", required=True); g.add_argument("--prompt-file", required=True)
    g.add_argument("--seconds", type=float, required=True); g.add_argument("--request-key", required=True)
    g.add_argument("--out", required=True); g.add_argument("--yes", action="store_true", help="the user said yes to the cost")
    g.add_argument("--quoted-cost", help="the figure and its basis the user saw and said yes to, e.g. \"$0.80 for 6 s per the model page\"")
    g.add_argument("--duration-key", default="duration", help="the model's input name for the length (empty: leave it out)")
    g.add_argument("--input", action="append", help="another model input, name=value (repeatable)")
    g.add_argument("--no-schema-check", action="store_true", help="send the inputs even when the model's input schema cannot be read (at your own risk)")
    g.add_argument("--max-wait", type=float, default=1200, help="seconds to poll before stopping (re-run to keep waiting)")
    rv = sub.add_parser("review"); rv.add_argument("clip"); rv.add_argument("--out", required=True)
    args = ap.parse_args()
    {"price": price, "generate": generate, "review": review}[args.cmd](args)
