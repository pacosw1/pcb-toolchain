#!/usr/bin/env python3
"""Timelapse of a compaction run (run.json from compact_cli.py): PNG frames (matplotlib), then GIF + MP4 (ffmpeg).
  $PY tools/placer/movie.py RUN.json OUTDIR [--seconds 15] [--routed RUNDIR]
The frames are the viewer frames (viewer.build): one per anneal epoch and one per step result. Left: layout
(block colors, halos dashed, ratsnest by length, region box, outline). Right: RUDY heat (same scale on all
frames, over-capacity cells red). Below: cost parts over the frames with a marker, and s + unrouted per step.
--routed RUNDIR: also one PNG per step of the best routed board (kicad-cli pcb render, top view).
Output goes to OUTDIR only (scratch); do not commit it.
"""
import argparse
import base64
import colorsys
import json
import os
import re
import shutil
import subprocess
import sys

import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt  # noqa: E402
import numpy as np  # noqa: E402
from matplotlib.collections import LineCollection  # noqa: E402
from matplotlib.patches import Rectangle  # noqa: E402

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from placer import viewer  # noqa: E402

FFMPEG = shutil.which('ffmpeg') or '/opt/homebrew/bin/ffmpeg'
KEYS = (('hpwl', '#36c'), ('cong', '#c63'), ('overlap', '#393'), ('oob', '#939'))


def fps(n, seconds):
    return int(min(30, max(1, round(n / seconds))))


def _col(s):
    h = 0
    for c in s:
        h = (h * 31 + ord(c)) % 360
    return colorsys.hls_to_rgb(h / 360, 0.5, 0.6)


def _box(rs):
    return min(r[0] for r in rs), min(r[1] for r in rs), max(r[2] for r in rs), max(r[3] for r in rs)


def render_frames(run, outdir, dpi=90):
    _, d = viewer.build(run)
    fr, units, g = d['frames'], d['units'], d['grid']
    xs = [p[0] for f in fr for p in f['outline']]
    ys = [p[1] for f in fr for p in f['outline']]
    lim = (min(xs) - 1, max(xs) + 1, min(ys) - 1, max(ys) + 1)
    ext = (g['x0'], g['x0'] + g['nx'] * g['c'], g['y0'] + g['ny'] * g['c'], g['y0'])
    series = {k: np.array([f['comp'].get(k, 0.0) for f in fr]) for k, _ in KEYS}
    steps = '   '.join('step %d: s=%.2f unrouted=%s %s' % (k, t['s'], t['unrouted'], 'PASS' if t['passed'] else 'FAIL')
                       for k, t in enumerate(d['steps']))
    os.makedirs(outdir, exist_ok=True)
    paths = []
    for i, f in enumerate(fr):
        fig = plt.figure(figsize=(12, 7.2))
        gs = fig.add_gridspec(2, 2, height_ratios=[3, 1.2])
        lay, heat, ch = fig.add_subplot(gs[0, 0]), fig.add_subplot(gs[0, 1]), fig.add_subplot(gs[1, :])
        for ax in (lay, heat):
            ax.set_xlim(lim[0], lim[1])
            ax.set_ylim(lim[3], lim[2])
            ax.set_aspect('equal')
            ax.plot([p[0] for p in f['outline'] + f['outline'][:1]], [p[1] for p in f['outline'] + f['outline'][:1]],
                    color='#888', lw=1)
            if d['region']:
                r = d['region']
                ax.add_patch(Rectangle((r[0], r[1]), r[2] - r[0], r[3] - r[1], fill=False, ec='#c0c', ls=':'))
        segs = np.array(f['segs']).reshape(-1, 4)
        if len(segs):
            ln = np.hypot(segs[:, 2] - segs[:, 0], segs[:, 3] - segs[:, 1])
            t = ln / max(ln.max(), 1e-9)
            lay.add_collection(LineCollection(segs.reshape(-1, 2, 2), colors=plt.cm.RdYlGn_r(t), lw=0.6, alpha=0.6))
        for u, rs in enumerate(f['rects']):
            U = units[u]
            c = _col(U['block']) if U['block'] else ('#888' if U['fixed'] else '#5a8')
            for r in rs:
                lay.add_patch(Rectangle((r[0], r[1]), r[2] - r[0], r[3] - r[1], fc=c, alpha=0.55, lw=0))
            if not U['fixed'] and U['halo'] > 0 and rs:
                a, b, e, h = _box(rs)
                q = U['halo'] / 2
                lay.add_patch(Rectangle((a - q, b - q), e - a + 2 * q, h - b + 2 * q, fill=False, ec='#999', ls='--',
                                        lw=0.5))
        hv = np.frombuffer(base64.b64decode(f['heat']), np.uint8).reshape(g['ny'], g['nx']) / 254.0
        ov = np.frombuffer(base64.b64decode(f['over']), np.uint8).reshape(g['ny'], g['nx'])
        heat.imshow(np.ma.masked_where(ov > 0, hv), cmap='Blues', vmin=0, vmax=1, extent=ext, interpolation='nearest')
        heat.imshow(np.ma.masked_where(ov == 0, hv), cmap='Reds', vmin=0, vmax=1, extent=ext, interpolation='nearest')
        lay.set_title(f['label'] + '   s=%.2f   cost=%.0f' % (f['s'], f['cost'])
                      + ('' if f['unrouted'] is None else '   unrouted=%d' % f['unrouted']), fontsize=9)
        heat.set_title('RUDY congestion (red: over capacity)', fontsize=9)
        for k, c in KEYS:
            v = series[k]
            ch.plot(v / max(v.max(), 1e-9), color=c, lw=1, label=k)
        ch.axvline(i, color='k', lw=0.8)
        ch.set_yticks([])
        ch.legend(loc='upper right', fontsize=7)
        ch.set_xlabel(steps + '\n' + d['verdict'], fontsize=7)
        fig.tight_layout()
        p = os.path.join(outdir, 'f%04d.png' % i)
        fig.savefig(p, dpi=dpi)
        plt.close(fig)
        paths.append(p)
    return paths


def encode(outdir, n, seconds):
    r = str(fps(n, seconds))
    src = os.path.join(outdir, 'f%04d.png')
    subprocess.run([FFMPEG, '-y', '-loglevel', 'error', '-framerate', r, '-i', src, '-vf',
                    'scale=trunc(iw/2)*2:trunc(ih/2)*2', '-pix_fmt', 'yuv420p', os.path.join(outdir, 'run.mp4')],
                   check=True)
    subprocess.run([FFMPEG, '-y', '-loglevel', 'error', '-framerate', r, '-i', src, '-vf',
                    'scale=720:-1:flags=lanczos,split[a][b];[a]palettegen[p];[b][p]paletteuse',
                    os.path.join(outdir, 'run.gif')], check=True)


def routed(rundir, outdir):
    """One top render per step of the router run with the fewest unrouted (step-N/route-K/*-r.kicad_pcb)."""
    out = []
    for s in sorted(os.listdir(rundir)):
        m = re.fullmatch(r'step-(\d+)', s)
        if not m:
            continue
        best = None
        for k in sorted(os.listdir(os.path.join(rundir, s))):
            log = os.path.join(rundir, s, k + '.log')
            if re.fullmatch(r'route-\d+', k) and os.path.exists(log):
                u = re.findall(r'^UNROUTED (\d+)', open(log).read(), re.M)
                pcb = [x for x in os.listdir(os.path.join(rundir, s, k)) if x.endswith('-r.kicad_pcb')]
                if u and pcb and (best is None or int(u[-1]) < best[0]):
                    best = (int(u[-1]), os.path.join(rundir, s, k, pcb[0]))
        if best:
            p = os.path.join(outdir, 'routed-step%s-u%d.png' % (m.group(1), best[0]))
            subprocess.run(['kicad-cli', 'pcb', 'render', '--side', 'top', '--quality', 'basic', '-w', '1600',
                            '-h', '1000', '-o', p, best[1]], check=True, capture_output=True)
            out.append(p)
    return out


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('run')
    ap.add_argument('outdir')
    ap.add_argument('--seconds', type=float, default=15.0)
    ap.add_argument('--routed', metavar='RUNDIR')
    a = ap.parse_args(argv)
    paths = render_frames(json.load(open(a.run)), a.outdir)
    encode(a.outdir, len(paths), a.seconds)
    print('frames %d, %s, %s' % (len(paths), os.path.join(a.outdir, 'run.gif'), os.path.join(a.outdir, 'run.mp4')))
    for p in routed(a.routed, a.outdir) if a.routed else []:
        print('routed', p)


if __name__ == '__main__':
    main()
