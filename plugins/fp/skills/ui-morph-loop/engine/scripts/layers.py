#!/usr/bin/env python3
"""Split one still image into animatable layers, and check that an animation still matches the original.

  python3 layers.py split photo.jpg --out layers/ [--subject auto] [--regions regions.json] [--pad 0.12]
  python3 layers.py compare photo.jpg frame.png [--max 1.5] [--diff diff.png]
  python3 layers.py grid photo.jpg --out grid.jpg [--step 100]       a labelled coordinate grid, to read positions off
  python3 layers.py propose poster.png --out regions.json [--gap 18]  draft regions for a flat-background graphic

split writes, into --out:
  plate.png      the background with every cut-out filled in (nearest colour for flat artwork, inpainted for photos;
                 --fill picks), extended by --pad on each side
                 (mirrored and softened) so camera moves and parallax never show an empty edge
  <name>.png     one RGBA cut-out per layer, cropped to its box, original pixels only
  layers.json    where everything sits, in source-image pixels (see below)
  sheet.jpg      original / plate / cut-outs / labelled boxes, to look at before building

Layers come from two places:
  --subject auto     the main subject, cut with rembg (a person, a product, an animal). --subject none skips it.
  --regions file     a JSON list you write after looking at the image, one entry per element:
      {"name": "headline", "box": [x, y, w, h], "cut": "ink", "kind": "text"}
      {"name": "bottle", "box": [x, y, w, h], "cut": "auto", "locked": true}
      {"name": "arrow", "poly": [[x, y], ...], "cut": "poly"}
    cut: "box"   the whole rectangle
         "poly"  the polygon
         "ink"   pixels that differ from the box's own background colour (text, icons, lines on a flat fill).
                 The background shows through around the letters, so reveals and moves stay clean.
         "auto"  rembg inside the box only (one object among several)
         "color" pixels inside the box (or poly) within "tol" (default 24) of any of "colors" (["#hex", ...]): one part
                 drawn in its own colours over another, like white windmill blades over a brown tower. The plate behind
                 is inpainted, so thin parts (spokes, blades) crossing something else are rebuilt from around them.
    kind: free text the template reads ("text", "icon", "chart", "subject", "logo-part"...).
    locked: true for anything that must never be warped (faces, products, logos, text). Default true.
    pivot: [x, y] the point this layer turns around when it spins or sways (a hub, a trunk's foot, a hull).
    fill: false keeps the original pixels in the plate under this layer (use it for layers that only glow or
          pulse in place, so nothing behind them needs inventing). Default true.

layers.json: {"source": {file, w, h, alpha}, "plate": {file, x, y, w, h}, "layers": [{name, file, x, y, w, h, kind,
locked, z}]}. x and y are the cut-out's top-left in source pixels; the plate's x and y are negative by the pad.

compare renders nothing: it checks a frame you rendered at the source size, at the composition's rest pose with
effects off (the template's ?pure mode), against the original. It fails (exit 1) when more than --max percent of the
pixels differ visibly. That is the proof the animation is the user's image, not a redraw of it.
"""
import argparse, json, os, sys

import numpy as np
from PIL import Image, ImageDraw, ImageFilter


def load_rgba(path):
    im = Image.open(path)
    has_alpha = im.mode in ("RGBA", "LA") or (im.mode == "P" and "transparency" in im.info)
    im = im.convert("RGBA")
    a = np.asarray(im)
    return a, bool(has_alpha and (a[..., 3] < 250).any())


SESSIONS = {}


def rembg_mask(rgb, model):
    try:
        from rembg import remove, new_session
    except ImportError:
        sys.exit("rembg is not installed. Run: bash <engine>/setup.sh --image   (or: pip install rembg onnxruntime)")
    # CPU only: on macOS onnxruntime also offers CoreML, which can hang for minutes compiling the model. CPU takes seconds.
    if model not in SESSIONS:
        SESSIONS[model] = new_session(model, providers=["CPUExecutionProvider"])
    m = remove(Image.fromarray(rgb), only_mask=True, session=SESSIONS[model])
    return np.asarray(m.convert("L")).astype(np.float32) / 255.0


def ink_mask(rgb, box):
    """Pixels inside the box that differ from the box's border colour: text and icons on a flat background."""
    x, y, w, h = box
    crop = rgb[y:y + h, x:x + w].astype(np.int16)
    border = np.concatenate([crop[0], crop[-1], crop[:, 0], crop[:, -1]])
    bg = np.median(border, axis=0)
    d = np.abs(crop - bg).max(axis=2)
    m = np.clip((d - 18) / 30.0, 0, 1).astype(np.float32)   # soft ramp keeps anti-aliased edges
    # anything the ink encloses belongs to it: a light glyph inside a dark badge, the counter of an "o"
    import cv2
    reach = np.pad((m < 0.5).astype(np.uint8), 1, constant_values=1)
    cv2.floodFill(reach, np.zeros((reach.shape[0] + 2, reach.shape[1] + 2), np.uint8), (0, 0), 2)
    m = np.maximum(m, (reach[1:-1, 1:-1] == 1).astype(np.float32))
    out = np.zeros(rgb.shape[:2], np.float32)
    out[y:y + h, x:x + w] = m
    return out, bg.astype(np.uint8)


def color_mask(rgb, box, reg):
    """Pixels in the box (and the region's poly, if it has one) close to any of the region's colours."""
    x, y, w, h = box
    cols = reg.get("colors")
    if not cols:
        sys.exit(f'region "{reg.get("name")}" has cut "color" but no "colors" list')
    tol = float(reg.get("tol", 24))
    crop = rgb[y:y + h, x:x + w].astype(np.int16)
    m = np.zeros((h, w), np.float32)
    for c in cols:
        c = c.lstrip("#"); ref = np.array([int(c[i:i + 2], 16) for i in (0, 2, 4)], np.int16)
        d = np.abs(crop - ref).max(axis=2)
        m = np.maximum(m, np.clip((tol + 12 - d) / 12.0, 0, 1))   # soft edge keeps anti-aliasing
    out = np.zeros(rgb.shape[:2], np.float32)
    out[y:y + h, x:x + w] = m
    if "poly" in reg:
        img = Image.new("L", (rgb.shape[1], rgb.shape[0]), 0)
        ImageDraw.Draw(img).polygon([tuple(q) for q in reg["poly"]], fill=255)
        out *= np.asarray(img).astype(np.float32) / 255.0
    return out


def region_mask(rgb, reg, model):
    """The layer's alpha mask, and for an "ink" cut the flat background colour that belongs behind it."""
    H, W = rgb.shape[:2]
    cut = reg.get("cut", "box")
    if "poly" in reg:
        img = Image.new("L", (W, H), 0)
        ImageDraw.Draw(img).polygon([tuple(p) for p in reg["poly"]], fill=255)
        m = np.asarray(img).astype(np.float32) / 255.0
        if cut == "poly" or cut == "box":
            return m, None
        xs, ys = zip(*reg["poly"])
        reg = dict(reg, box=[int(min(xs)), int(min(ys)), int(max(xs) - min(xs)), int(max(ys) - min(ys))])
    x, y, w, h = [int(round(v)) for v in reg["box"]]
    x, y = max(0, x), max(0, y)
    w, h = min(w, W - x), min(h, H - y)
    if w <= 0 or h <= 0:
        sys.exit(f'region "{reg.get("name")}" is outside the image')
    if cut == "ink":
        return ink_mask(rgb, (x, y, w, h))
    if cut == "color":
        return color_mask(rgb, (x, y, w, h), reg), None
    if cut == "auto":
        out = np.zeros((H, W), np.float32)
        out[y:y + h, x:x + w] = rembg_mask(np.ascontiguousarray(rgb[y:y + h, x:x + w]), model)
        return out, None
    out = np.zeros((H, W), np.float32)
    out[y:y + h, x:x + w] = 1.0
    return out, None


def is_flat_art(rgb):
    """Flat-colour artwork (illustrations, UI, logos): a handful of colours cover nearly every pixel."""
    q = (rgb[::4, ::4] // 8).reshape(-1, 3)
    _, counts = np.unique(q, axis=0, return_counts=True)
    return float(np.sort(counts)[::-1][:24].sum()) / len(q) > 0.85


def nearest_fill(rgb, hole):
    """Give every hidden pixel the colour of the nearest visible one: crisp, no blur, edges carry straight on."""
    import cv2
    keep = (hole <= 0.02).astype(np.uint8)
    # distances run from each hidden pixel (non-zero) to the nearest visible one (zero), which each get their own label
    _, labels = cv2.distanceTransformWithLabels(1 - keep, cv2.DIST_L2, 5, labelType=cv2.DIST_LABEL_PIXEL)
    ys, xs = np.nonzero(keep)
    lut = np.zeros((labels.max() + 1, 2), np.int32)
    lut[labels[ys, xs]] = np.stack([ys, xs], 1)
    out = rgb.copy()
    hy, hx = np.nonzero(keep == 0)
    src = lut[labels[hy, hx]]
    out[hy, hx] = rgb[src[:, 0], src[:, 1]]
    return out


def feather(m, px):
    if px <= 0:
        return m
    return np.asarray(Image.fromarray((m * 255).astype(np.uint8)).filter(ImageFilter.GaussianBlur(px))).astype(np.float32) / 255.0


def bbox(m, thr=0.02):
    ys, xs = np.where(m > thr)
    if not len(xs):
        return None
    return int(xs.min()), int(ys.min()), int(xs.max() - xs.min() + 1), int(ys.max() - ys.min() + 1)


def inpaint(rgb, hole):
    import cv2
    k = max(3, int(round(min(rgb.shape[:2]) * 0.006)) | 1)
    grow = cv2.dilate((hole > 0.02).astype(np.uint8) * 255, np.ones((k, k), np.uint8), iterations=2)
    bgr = cv2.cvtColor(rgb, cv2.COLOR_RGB2BGR)
    # small and thin holes (blades, spokes, cars, text) inpaint best at full size
    full = cv2.inpaint(bgr, grow, 7, cv2.INPAINT_TELEA)
    # one big hole (a whole subject) fills better from a smaller copy, then gets its edge detail back at full size
    n, lab, stats, _ = cv2.connectedComponentsWithStats(grow, 8)
    big = np.zeros(grow.shape, np.uint8)
    for i in range(1, n):
        if stats[i, cv2.CC_STAT_AREA] > 0.03 * grow.size:
            big[lab == i] = 255
    if big.any():
        s = 0.25
        small = cv2.resize(bgr, None, fx=s, fy=s, interpolation=cv2.INTER_AREA)
        sm = cv2.resize(big, (small.shape[1], small.shape[0]), interpolation=cv2.INTER_NEAREST)
        small = cv2.inpaint(small, sm, 9, cv2.INPAINT_TELEA)
        up = cv2.resize(small, (bgr.shape[1], bgr.shape[0]), interpolation=cv2.INTER_CUBIC)
        coarse = np.where(big[..., None] > 0, up, bgr)
        edge = cv2.erode(big, np.ones((3, 3), np.uint8)) - cv2.erode(big, np.ones((9, 9), np.uint8))
        coarse = cv2.inpaint(coarse, edge, 5, cv2.INPAINT_TELEA)
        full = np.where(big[..., None] > 0, coarse, full)
    bgr = full
    return cv2.cvtColor(bgr, cv2.COLOR_BGR2RGB)


def extend(rgba, pad):
    """Mirror the plate outwards by pad px and soften the mirrored part, so it reads as more of the scene."""
    import cv2
    if pad <= 0:
        return rgba
    big = cv2.copyMakeBorder(rgba, pad, pad, pad, pad, cv2.BORDER_REFLECT_101)
    blur = cv2.GaussianBlur(big, (0, 0), max(2, pad / 6))
    H, W = big.shape[:2]
    yy, xx = np.mgrid[0:H, 0:W]
    dist = np.maximum(np.maximum(pad - xx, xx - (W - 1 - pad)), np.maximum(pad - yy, yy - (H - 1 - pad)))
    k = np.clip(dist / max(1, pad * 0.5), 0, 1)[..., None]
    return (big * (1 - k) + blur * k).astype(np.uint8)


def checker(h, w, s=16):
    yy, xx = np.mgrid[0:h, 0:w]
    c = (((yy // s) + (xx // s)) % 2) * 40 + 190
    return np.dstack([c, c, c]).astype(np.uint8)


def over(dst_rgb, rgba, x, y):
    h, w = rgba.shape[:2]
    a = rgba[..., 3:4].astype(np.float32) / 255.0
    region = dst_rgb[y:y + h, x:x + w].astype(np.float32)
    dst_rgb[y:y + h, x:x + w] = (rgba[..., :3] * a + region * (1 - a)).astype(np.uint8)


def split(args):
    src, has_alpha = load_rgba(args.image)
    H, W = src.shape[:2]
    rgb = np.ascontiguousarray(src[..., :3])
    os.makedirs(args.out, exist_ok=True)
    regions = []
    if args.regions:
        with open(args.regions) as f:
            regions = json.load(f)
    if args.subject == "auto":
        regions = [{"name": "subject", "cut": "subject", "kind": "subject", "locked": True}] + regions

    layers, hole, flat = [], np.zeros((H, W), np.float32), []
    names = set()
    for z, reg in enumerate(regions, 1):
        name = reg.get("name") or f"layer{z}"
        if name in names or name == "plate":
            sys.exit(f'two layers are called "{name}" (or one is called "plate"); names must be unique')
        names.add(name)
        m, bg = (rembg_mask(rgb, args.model), None) if reg.get("cut") == "subject" else region_mask(rgb, reg, args.model)
        if has_alpha:
            m = m * (src[..., 3].astype(np.float32) / 255.0)
        m = feather(m, args.feather if reg.get("cut") in ("subject", "auto", "box", "poly") else 0)
        bb = bbox(m)
        if not bb:
            print(f'  !! "{name}" came out empty (nothing cut). Check its box and cut mode.')
            continue
        x, y, w, h = bb
        cut = src[y:y + h, x:x + w].copy()
        cut[..., 3] = (m[y:y + h, x:x + w] * (src[y:y + h, x:x + w, 3].astype(np.float32))).astype(np.uint8)
        Image.fromarray(cut).save(os.path.join(args.out, f"{name}.png"))
        if reg.get("fill", True) and bg is not None:
            flat.append((m, bg))           # ink on a flat background: the background colour is exactly what was behind it
        elif reg.get("fill", True):
            hole = np.maximum(hole, m)
        layers.append({"name": name, "file": f"{name}.png", "x": x, "y": y, "w": w, "h": h,
                       "kind": reg.get("kind", "object"), "locked": bool(reg.get("locked", True)), "z": z,
                       "cover": round(float((m > 0.5).mean()) * 100, 2)})
        if "pivot" in reg:
            layers[-1]["pivot"] = reg["pivot"]   # where spin and sway turn (the template reads it)

    if has_alpha:
        # transparent source (a logo): nothing behind the parts to invent, the plate is what is left over
        import cv2
        for m, _ in flat:
            hole = np.maximum(hole, m)
        gone = cv2.dilate((hole > 0.02).astype(np.uint8), np.ones((5, 5), np.uint8)) > 0   # no anti-aliased fringe left behind
        plate = src.copy()
        plate[gone, 3] = 0
    else:
        mode = args.fill if args.fill != "auto" else ("nearest" if is_flat_art(rgb) else "inpaint")
        if hole.max() <= 0:
            base = rgb.copy()
        elif mode == "nearest":
            import cv2
            base = nearest_fill(rgb, cv2.dilate((hole > 0.02).astype(np.uint8), np.ones((5, 5), np.uint8)).astype(np.float32))
        else:
            base = inpaint(rgb, hole)
        import cv2
        for m, bg in flat:
            grow = cv2.dilate((m > 0.02).astype(np.uint8), np.ones((3, 3), np.uint8)) > 0
            base[grow] = bg
            hole = np.maximum(hole, m)
        plate = np.dstack([base, np.full((H, W), 255, np.uint8)])
    pad = int(round(max(W, H) * args.pad))
    Image.fromarray(extend(plate, pad)).save(os.path.join(args.out, "plate.png"))

    meta = {"source": {"file": os.path.basename(args.image), "w": W, "h": H, "alpha": has_alpha},
            "plate": {"file": "plate.png", "x": -pad, "y": -pad, "w": W + 2 * pad, "h": H + 2 * pad},
            "layers": layers}
    with open(os.path.join(args.out, "layers.json"), "w") as f:
        json.dump(meta, f, indent=1)

    # put it back together: the cut-outs over the filled plate should be the original again
    base = checker(H, W) if has_alpha else plate[..., :3].copy()
    if has_alpha:
        over(base, plate, 0, 0)
    for L in layers:
        over(base, np.asarray(Image.open(os.path.join(args.out, L["file"]))), L["x"], L["y"])
    ref = checker(H, W)
    over(ref, src, 0, 0)
    pct, _ = diff_pct(ref, base)

    sheet(args.out, src, plate, layers, has_alpha)
    print(f"{len(layers)} layer(s) + plate -> {args.out}/layers.json (pad {pad}px)")
    for L in layers:
        print(f'  z{L["z"]} {L["name"]:<16} {L["kind"]:<9} box {L["x"]},{L["y"]} {L["w"]}x{L["h"]}  covers {L["cover"]}%'
              f'{"  locked" if L["locked"] else ""}')
    filled = float((hole > 0.5).mean()) * 100
    print(f"  plate: {filled:.1f}% of the image was filled in. Look at sheet.jpg: the fill only shows where a layer moves.")
    print(f"  reassembled vs original: {pct:.2f}% of pixels differ visibly {'ok' if pct <= 1.5 else '(check the feathered edges)'}")


def sheet(out, src, plate, layers, has_alpha):
    H, W = src.shape[:2]
    s = 640 / max(W, H)
    tw, th = max(1, int(W * s)), max(1, int(H * s))
    tiles = []
    o = checker(H, W); over(o, src, 0, 0); tiles.append(("original", o))
    pad = (plate.shape[0] - H) // 2 if plate.shape[0] > H else 0
    p = checker(H, W); over(p, plate if not pad else plate[pad:pad + H, pad:pad + W], 0, 0); tiles.append(("plate (filled)", p))
    c = checker(H, W)
    for L in layers:
        over(c, np.asarray(Image.open(os.path.join(out, L["file"]))), L["x"], L["y"])
    tiles.append(("cut-outs", c))
    b = Image.fromarray(o.copy()); d = ImageDraw.Draw(b)
    for i, L in enumerate(layers):
        col = [(255, 64, 96), (64, 200, 255), (255, 200, 40), (120, 255, 120), (220, 120, 255)][i % 5]
        d.rectangle([L["x"], L["y"], L["x"] + L["w"], L["y"] + L["h"]], outline=col, width=max(2, int(3 / s)))
        d.text((L["x"] + 6, L["y"] + 6), f'z{L["z"]} {L["name"]}', fill=col)
    tiles.append(("boxes", np.asarray(b)))
    canvas = Image.new("RGB", (tw * 2 + 30, th * 2 + 70), (20, 20, 24))
    d = ImageDraw.Draw(canvas)
    for i, (label, arr) in enumerate(tiles):
        x, y = 10 + (i % 2) * (tw + 10), 25 + (i // 2) * (th + 25)
        canvas.paste(Image.fromarray(arr).resize((tw, th), Image.LANCZOS), (x, y))
        d.text((x, y - 16), label, fill=(230, 230, 230))
    canvas.save(os.path.join(out, "sheet.jpg"), quality=88)


def diff_pct(a, b, thr=24):
    d = np.abs(a.astype(np.int16) - b.astype(np.int16)).max(axis=2)
    return float((d > thr).mean()) * 100, d


def compare(args):
    src, has_alpha = load_rgba(args.original)
    H, W = src.shape[:2]
    if has_alpha:  # a transparent original is compared over the colour the composition draws behind it
        ref = np.array(Image.new("RGB", (W, H), tuple(args.bg)))
        over(ref, src, 0, 0)
    else:
        ref = src[..., :3].copy()
    fr = Image.open(args.frame).convert("RGB")
    if fr.size != (W, H):
        print(f"  frame is {fr.size[0]}x{fr.size[1]}, original is {W}x{H}: resizing the frame to compare. "
              f"Render the rest frame at the source size for a strict check.")
        fr = fr.resize((W, H), Image.LANCZOS)
    pct, d = diff_pct(ref, np.asarray(fr))
    mean = float(d.mean())
    if args.diff:
        heat = np.clip(d * 4, 0, 255).astype(np.uint8)
        Image.fromarray(np.dstack([heat, heat // 3, heat // 3])).save(args.diff)
    ok = pct <= args.max
    print(f"rest frame vs original: {pct:.2f}% of pixels differ visibly (max {args.max}%), mean difference {mean:.1f}/255  "
          f"{'ok' if ok else 'FAIL: the rest pose is not the original. Look at the diff image.'}")
    sys.exit(0 if ok else 1)


def grid(args):
    src, _ = load_rgba(args.image)
    H, W = src.shape[:2]
    im = checker(H, W); over(im, src, 0, 0)
    im = Image.fromarray(im); d = ImageDraw.Draw(im)
    step = args.step or max(50, int(round(max(W, H) / 12 / 50.0)) * 50)
    for x in range(0, W, step):
        d.line([(x, 0), (x, H)], fill=(255, 0, 90), width=1)
        d.text((x + 3, 3), str(x), fill=(255, 0, 90))
    for y in range(0, H, step):
        d.line([(0, y), (W, y)], fill=(0, 140, 255), width=1)
        d.text((3, y + 3), str(y), fill=(0, 140, 255))
    if args.regions:
        with open(args.regions) as f:
            for r in json.load(f):
                if "box" in r:
                    x, y, w, h = r["box"]; d.rectangle([x, y, x + w, y + h], outline=(20, 200, 60), width=3)
                    d.text((x + 4, y + h - 14), r.get("name", ""), fill=(20, 160, 50))
    im.convert("RGB").save(args.out, quality=90)
    print(f"{args.out}: {W}x{H}, grid every {step}px (x in pink along the top, y in blue down the side)")


def propose(args):
    """Find the separate elements of a graphic on a flat background (text lines, icons, shapes, bars) as boxes."""
    import cv2
    src, has_alpha = load_rgba(args.image)
    H, W = src.shape[:2]
    if has_alpha:
        ink = src[..., 3] > 40
    else:
        rgb = src[..., :3].astype(np.int16)
        q = (rgb // 8).reshape(-1, 3)
        vals, counts = np.unique(q, axis=0, return_counts=True)
        bg = vals[counts.argmax()] * 8 + 4
        share = counts.max() / q.shape[0]
        if share < 0.25:
            print(f"  note: the most common colour covers only {share:.0%} of the image, so this is not a flat background."
                  " Boxes will be rough; for a photo use --subject auto and hand-written boxes instead.")
        ink = np.abs(rgb - bg).max(axis=2) > 28
    gap = args.gap
    kx, ky = max(1, gap), max(1, int(gap * 0.45))   # words join into lines more readily than lines into paragraphs
    blob = cv2.dilate(ink.astype(np.uint8), np.ones((ky, kx), np.uint8))
    n, lab, stats, _ = cv2.connectedComponentsWithStats(blob, 8)
    boxes = []
    for i in range(1, n):
        x, y, w, h, area = (int(v) for v in stats[i])
        x, y = x + kx // 2, y + ky // 2; w, h = w - kx + 1, h - ky + 1   # undo the dilation
        if w * h < args.min * args.min or ink[y:y + h, x:x + w].sum() < args.min:
            continue
        m = max(4, gap // 3)
        boxes.append([max(0, x - m), max(0, y - m), min(W, x + w + m) - max(0, x - m), min(H, y + h + m) - max(0, y - m)])
    rowh = max(1, int(np.median([b[3] for b in boxes]))) if boxes else 1
    boxes.sort(key=lambda b: (b[1] // rowh, b[0]))       # reading order: rows, then left to right
    regs = [{"name": f"r{i + 1:02d}", "box": b, "cut": "ink", "kind": "element"} for i, b in enumerate(boxes)]
    with open(args.out, "w") as f:
        f.write("[\n" + ",\n".join(" " + json.dumps(r) for r in regs) + "\n]\n")
    print(f"{len(regs)} region(s) -> {args.out}. Rename them (title, icon1, bar3...), merge or split boxes, then check them "
          f"with: layers.py grid {os.path.basename(args.image)} --regions {os.path.basename(args.out)} --out boxes.jpg")


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)
    s = sub.add_parser("split", help="cut an image into a filled plate and RGBA layers")
    s.add_argument("image"); s.add_argument("--out", required=True)
    s.add_argument("--subject", choices=["auto", "none"], default="none")
    s.add_argument("--regions", help="JSON list of regions to cut (see the top of this file)")
    s.add_argument("--pad", type=float, default=0.12, help="plate overscan on each side, as a fraction of the long side")
    s.add_argument("--feather", type=float, default=1.2, help="edge softening for subject/auto/box/poly cuts, in px")
    s.add_argument("--fill", choices=["auto", "nearest", "inpaint"], default="auto",
                   help="how the plate is filled behind cut-outs: nearest colour (flat art), inpaint (photos), or auto")
    s.add_argument("--model", default="isnet-general-use", help="rembg model (isnet-general-use, u2net, u2net_human_seg, birefnet-portrait)")
    c = sub.add_parser("compare", help="check a rendered rest frame against the original")
    c.add_argument("original"); c.add_argument("frame")
    c.add_argument("--max", type=float, default=1.5, help="percent of pixels allowed to differ visibly")
    c.add_argument("--diff", help="write a heat map of the differences here")
    c.add_argument("--bg", type=int, nargs=3, default=[0, 0, 0], help="background colour behind a transparent original")
    g = sub.add_parser("grid", help="draw a labelled coordinate grid (and any regions) over the image")
    g.add_argument("image"); g.add_argument("--out", required=True)
    g.add_argument("--step", type=int, default=0, help="grid spacing in px (default: about 12 lines on the long side)")
    g.add_argument("--regions", help="also draw these regions' boxes")
    r = sub.add_parser("propose", help="draft regions.json from the separate elements of a flat-background graphic")
    r.add_argument("image"); r.add_argument("--out", required=True)
    r.add_argument("--gap", type=int, default=18, help="px of background that still joins two marks into one element")
    r.add_argument("--min", type=int, default=6, help="ignore specks smaller than this, in px")
    a = ap.parse_args()
    {"split": split, "compare": compare, "grid": grid, "propose": propose}[a.cmd](a)


if __name__ == "__main__":
    main()
