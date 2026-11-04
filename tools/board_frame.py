#!/usr/bin/env python3
"""Fast 2D board frame from the DSN/SES text (W12): PIL only, no pcbnew, no kicad-cli; about 0.3 s per frame.

  python3 tools/board_frame.py OUTDIR [--ses FILE] [--out PNG] [--stamp TEXT] [--width 1200]
      one frame: board outline and pads from OUTDIR/board.dsn, tracks by layer colour and vias from the SES
      (default OUTDIR/board.ses), the open connections as red lines (OUTDIR/report.json unrouted[] when the router
      has written it, else OUTDIR/open-triage.json), the stamp text top left. Default output: OUTDIR/frame.png.
  python3 tools/board_frame.py --mp4 OUTDIR [--seconds 60] [--keep]
      the frames OUTDIR/snapshots/NNNN.png (tools/route_snapshots.py) into OUTDIR/timelapse.mp4 with ffmpeg, the
      whole run in --seconds (frame rate = frames / seconds, at least 1 fps); the PNG frames are deleted after a
      good MP4 unless --keep. Without ffmpeg the frames stay and the tool says so (exit 2).

Units: the DSN is in um (KiCad export, "(unit um)"); the SES carries its "(resolution um N)" factor (N = 10:
divide by 10000 for mm). Checked against /tmp/w12/run-1: SES 982828 = triage 98.2828 mm. The y axis is negated in
both (DSN y = -mm). Layer colours: F.Cu red, B.Cu blue, In1.Cu olive, In2.Cu teal (the KiCad defaults, roughly);
pads grey, vias light grey, open connections red (#ff3030), outline white.
"""
import argparse
import glob
import json
import math
import os
import re
import shutil
import subprocess
import sys
import time

COLOURS = {'F.Cu': (200, 52, 52), 'B.Cu': (77, 127, 196), 'In1.Cu': (194, 194, 0), 'In2.Cu': (0, 170, 170)}
PAD = (150, 150, 150)
VIA = (220, 220, 220)
OPEN = (255, 48, 48)
BG = (0, 0, 0)
OUTLINE = (255, 255, 255)
TOKEN = re.compile(r'\(|\)|"[^"]*"|[^\s()"]+')


# ------------------------------------------------------------------ s-expression text

def parse(text):
    """Nested lists of strings for the whole s-expression text (quotes removed)."""
    stack = [[]]
    text = text.replace('(string_quote ")', '(string_quote)')   # the one unpaired quote of a KiCad DSN/SES
    for m in TOKEN.finditer(text):
        t = m.group(0)
        if t == '(':
            stack.append([])
        elif t == ')':
            node = stack.pop()
            stack[-1].append(node)
        else:
            stack[-1].append(t[1:-1] if t[0] == '"' else t)
    return stack[0]


def _find(node, head):
    return [n for n in node if isinstance(n, list) and n and n[0] == head]


def _walk(node, head):
    for n in node:
        if isinstance(n, list):
            if n and n[0] == head:
                yield n
            else:
                yield from _walk(n, head)


def _nums(node):
    out = []
    for n in node:
        if isinstance(n, str):
            try:
                out.append(float(n))
            except ValueError:
                pass
    return out


def _shape_box(shape):
    """(w, h, cx, cy) of a padstack shape in its own units."""
    s = shape[1] if len(shape) > 1 and isinstance(shape[1], list) else shape
    kind = s[0]
    v = _nums(s[2:])
    if kind == 'circle':
        d = v[0]
        cx, cy = (v[1], v[2]) if len(v) >= 3 else (0.0, 0.0)
        return d, d, cx, cy
    if kind == 'rect':
        x0, y0, x1, y1 = v[:4]
        return abs(x1 - x0), abs(y1 - y0), (x0 + x1) / 2, (y0 + y1) / 2
    if kind in ('polygon', 'path'):
        ap, pts = v[0], v[1:]
        xs, ys = pts[0::2], pts[1::2]
        if not xs:
            return ap, ap, 0.0, 0.0
        return max(xs) - min(xs) + ap, max(ys) - min(ys) + ap, (max(xs) + min(xs)) / 2, (max(ys) + min(ys)) / 2
    return 0.0, 0.0, 0.0, 0.0


def load_dsn(path):
    """{'outline': [(x, y) mm], 'pads': [(x, y, w, h, side) mm], 'bbox': (x0, y0, x1, y1)}."""
    tree = parse(open(path, errors='replace').read())
    pcb = tree[0]
    k = 1 / 1000.0   # um -> mm
    outline = []
    for b in _walk(_find(pcb, 'structure')[0], 'boundary'):
        for p in _find(b, 'path'):
            v = _nums(p[2:])[1:]   # after the aperture width
            outline = [(x * k, -y * k) for x, y in zip(v[0::2], v[1::2])]
            break
        if outline:
            break
    lib = _find(pcb, 'library')[0]
    stacks = {}
    for ps in _find(lib, 'padstack'):
        shapes = _find(ps, 'shape')
        stacks[ps[1]] = _shape_box(shapes[0]) if shapes else (0, 0, 0, 0)
    images = {}
    for im in _find(lib, 'image'):
        pins = []
        for p in _find(im, 'pin'):
            rot = 0.0
            rest = p[1:]
            name = rest[0]
            rest = rest[1:]
            if rest and isinstance(rest[0], list) and rest[0][0] == 'rotate':
                rot = float(rest[0][1])
                rest = rest[1:]
            v = _nums(rest[1:])
            if len(v) >= 2:
                pins.append((name, v[0], v[1], rot))
        images[im[1]] = pins
    pads = []
    for comp in _find(_find(pcb, 'placement')[0], 'component'):
        pins = images.get(comp[1], [])
        for pl in _find(comp, 'place'):
            v = _nums(pl[2:4])   # (place REF x y side rot ...)
            if len(v) < 2:
                continue
            px, py = v
            side = pl[4] if len(pl) > 4 and isinstance(pl[4], str) else 'front'
            rot = float(pl[5]) if len(pl) > 5 and isinstance(pl[5], str) else 0.0
            c, s = math.cos(math.radians(rot)), math.sin(math.radians(rot))
            for name, dx, dy, prot in pins:
                w, h, ox, oy = stacks.get(name, (0, 0, 0, 0))
                if side == 'back':
                    dx = -dx
                if round((rot + prot) / 90) % 2 == 1:
                    w, h = h, w
                x = px + (dx + ox) * c - (dy + oy) * s
                y = py + (dx + ox) * s + (dy + oy) * c
                pads.append((x * k, -y * k, w * k, h * k, side))
    xs = [p[0] for p in outline] or [p[0] for p in pads] or [0]
    ys = [p[1] for p in outline] or [p[1] for p in pads] or [0]
    return dict(outline=outline, pads=pads, bbox=(min(xs), min(ys), max(xs), max(ys)))


def load_ses(path):
    """{'wires': [(layer, width mm, [(x, y) mm])], 'vias': [(x, y) mm]}."""
    tree = parse(open(path, errors='replace').read())
    ses = tree[0]
    res = 1.0
    for r in _walk(ses, 'resolution'):
        if len(r) >= 3 and r[1] == 'um':
            res = float(r[2])
            break
    k = 1 / (1000.0 * res)
    wires, vias = [], []
    routes = _find(ses, 'routes')
    if not routes:
        return dict(wires=wires, vias=vias)
    for net in _walk(routes[0], 'net'):
        for w in _find(net, 'wire'):
            for p in _find(w, 'path'):
                v = _nums(p[2:])
                wires.append((p[1], float(p[2]) * k, [(x * k, -y * k) for x, y in zip(v[1::2], v[2::2])]))
        for via in _find(net, 'via'):
            v = _nums(via[2:])
            if len(v) >= 2:
                vias.append((v[0] * k, -v[1] * k))
    return dict(wires=wires, vias=vias)


def open_lines(outdir):
    """[(x0, y0, x1, y1) mm] of the open connections: report.json unrouted[] else open-triage.json connections[]."""
    try:
        rep = json.load(open(os.path.join(outdir, 'report.json')))
        return [(*u['from_xy'], *u['to_xy']) for u in rep.get('unrouted') or [] if u.get('from_xy') and u.get('to_xy')]
    except (OSError, ValueError, KeyError, TypeError):
        pass
    try:
        tri = json.load(open(os.path.join(outdir, 'open-triage.json')))
        return [(c['a_pos']['x'], c['a_pos']['y'], c['b_pos']['x'], c['b_pos']['y']) for c in tri.get('connections') or []
                if c.get('a_pos') and c.get('b_pos')]
    except (OSError, ValueError, KeyError, TypeError):
        return []


# ------------------------------------------------------------------ drawing

def render(dsn, ses, opens=(), stamp='', width=1200):
    from PIL import Image, ImageDraw, ImageFont
    x0, y0, x1, y1 = dsn['bbox']
    margin = 3.0
    bw, bh = (x1 - x0) + 2 * margin, (y1 - y0) + 2 * margin
    scale = (width - 2) / bw
    height = int(bh * scale) + 48
    img = Image.new('RGB', (width, height), BG)
    d = ImageDraw.Draw(img)
    top = 44
    P = lambda x, y: ((x - x0 + margin) * scale + 1, (y - y0 + margin) * scale + top)
    if dsn['outline']:
        d.polygon([P(x, y) for x, y in dsn['outline']], outline=OUTLINE)
    for x, y, w, h, side in dsn['pads']:
        ax, ay = P(x - w / 2, y - h / 2)
        bx, by = P(x + w / 2, y + h / 2)
        d.rectangle([ax, ay, max(bx, ax + 1), max(by, ay + 1)], fill=PAD if side == 'front' else (100, 100, 130))
    order = ['In2.Cu', 'In1.Cu', 'B.Cu', 'F.Cu']
    for layer in order + sorted({w[0] for w in ses['wires']} - set(order)):
        col = COLOURS.get(layer, (160, 160, 160))
        for lay, wid, pts in ses['wires']:
            if lay != layer or len(pts) < 2:
                continue
            d.line([P(x, y) for x, y in pts], fill=col, width=max(1, int(wid * scale)))
    r = max(1.5, 0.35 * scale)
    for x, y in ses['vias']:
        cx, cy = P(x, y)
        d.ellipse([cx - r, cy - r, cx + r, cy + r], fill=VIA)
    for ax, ay, bx, by in opens:
        d.line([P(ax, ay), P(bx, by)], fill=OPEN, width=3)
    try:
        font = ImageFont.load_default(size=26)
    except TypeError:
        font = ImageFont.load_default()
    d.text((10, 8), stamp, fill=(255, 255, 255), font=font)
    return img


def frame(outdir, ses_path=None, out=None, stamp=None, width=1200, dsn_path=None):
    """Render one frame; returns the PNG path."""
    dsn = load_dsn(dsn_path or os.path.join(outdir, 'board.dsn'))
    ses_path = ses_path or os.path.join(outdir, 'board.ses')
    ses = load_ses(ses_path) if os.path.isfile(ses_path) else dict(wires=[], vias=[])
    opens = open_lines(outdir)
    if stamp is None:
        stamp = f'{os.path.basename(outdir)}  open {len(opens)}  tracks {len(ses["wires"])}  vias {len(ses["vias"])}'
    img = render(dsn, ses, opens, stamp, width)
    out = out or os.path.join(outdir, 'frame.png')
    os.makedirs(os.path.dirname(os.path.abspath(out)), exist_ok=True)
    tmp = out + '.tmp.png'
    img.save(tmp, 'PNG', compress_level=1)
    os.replace(tmp, out)
    return out


def mp4(outdir, seconds=60, keep=False):
    """OUTDIR/snapshots/NNNN.png -> OUTDIR/timelapse.mp4 (frames / seconds fps, >= 1). Returns the MP4 path or None."""
    frames = sorted(glob.glob(os.path.join(outdir, 'snapshots', '[0-9]*.png')))
    if not frames:
        print('board_frame: no frames under snapshots/', flush=True)
        return None
    ffmpeg = shutil.which('ffmpeg')
    if not ffmpeg:
        print(f'board_frame: ffmpeg not found; {len(frames)} frames kept under {outdir}/snapshots', flush=True)
        return None
    fps = max(1.0, len(frames) / float(seconds))
    out = os.path.join(outdir, 'timelapse.mp4')
    lst = os.path.join(outdir, 'snapshots', 'frames.txt')
    with open(lst, 'w') as f:
        for p in frames:
            f.write(f"file '{os.path.abspath(p)}'\nduration {1 / fps:.4f}\n")
        f.write(f"file '{os.path.abspath(frames[-1])}'\n")
    cmd = [ffmpeg, '-y', '-loglevel', 'error', '-f', 'concat', '-safe', '0', '-i', lst,
           '-vf', 'pad=ceil(iw/2)*2:ceil(ih/2)*2', '-r', '30', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', out]
    p = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    if p.returncode or not os.path.isfile(out):
        print(f'board_frame: ffmpeg failed (rc {p.returncode}): {p.stderr.strip()[-300:]}', flush=True)
        return None
    print(f'board_frame: {out} ({len(frames)} frames, {fps:.2f} fps, {seconds} s)', flush=True)
    if not keep:
        for f_ in frames:
            os.remove(f_)
        os.remove(lst)
    return out


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument('outdir')
    ap.add_argument('--ses')
    ap.add_argument('--dsn')
    ap.add_argument('--out')
    ap.add_argument('--stamp')
    ap.add_argument('--width', type=int, default=1200)
    ap.add_argument('--mp4', action='store_true', help='assemble snapshots/*.png into timelapse.mp4')
    ap.add_argument('--seconds', type=int, default=60)
    ap.add_argument('--keep', action='store_true', help='keep the PNG frames after the MP4')
    a = ap.parse_args(argv)
    if a.mp4:
        return 0 if mp4(a.outdir, a.seconds, a.keep) else 2
    t = time.time()
    out = frame(a.outdir, a.ses, a.out, a.stamp, a.width, a.dsn)
    print(f'board_frame: {out} in {time.time() - t:.2f} s', flush=True)
    return 0


if __name__ == '__main__':
    sys.exit(main())
