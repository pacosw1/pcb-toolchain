#!/usr/bin/env python3
"""pcbtool: batch PCB edits from a JSON spec, then one compact DRC summary.

It replaces one-by-one edits. The agent writes the spec (every position, track point, width,
layer and via is still chosen by the agent: hand routing, no auto-router), runs one command,
reads the summary, tweaks the spec and runs again.

Run with the KiCad bundled Python (it has pcbnew):
  PY=/Applications/KiCad/KiCad.app/Contents/Frameworks/Python.framework/Versions/Current/bin/python3
  $PY tools/pcbtool.py pads   BOARD [REF ...] [--net NET]     pad positions and nets
  $PY tools/pcbtool.py place  BOARD SPEC.json                 set positions, then DRC summary
  $PY tools/pcbtool.py route  BOARD SPEC.json                 add tracks and vias, refill, DRC summary
  $PY tools/pcbtool.py unroute BOARD NET [NET ...]            remove the tracks and vias of nets
  $PY tools/pcbtool.py drc    BOARD                           DRC --schematic-parity summary
  $PY tools/pcbtool.py render BOARD OUTDIR                    top + iso PNG
  $PY tools/pcbtool.py art    BOARD SPEC.json                 silkscreen art group (waves, circles, lines, texts)
  $PY tools/pcbtool.py colors BOARD OUTDIR [VARIANT ...]      JLC colour variant renders (board unchanged)
  $PY tools/pcbtool.py setcolors BOARD MASK SILK FINISH       write the stackup colours
  $PY tools/pcbtool.py snapshot BOARD OUT.json [--checker CMD]  before/after state
  $PY tools/pcbtool.py compare BEFORE.json AFTER.json         exit 1 on a regression

Place spec:  {"place": {"R1": [x, y, rot]}, "grids": [{"refs": [...], "origin": [x, y],
              "pitch": [dx, dy], "cols": n, "rot": 0}]}
Route spec:  {"clear": ["NET"], "routes": [{"net": "VBAT", "width": 1.5, "layer": "F.Cu",
              "path": [[x, y], [x, y], {"via": [x, y]}, [x, y]]}]}
  A {"via": [x, y]} point adds a via and changes the layer (F.Cu <-> B.Cu).
  Segments must be 0/45/90 degrees unless the route has "any_angle": true.
Coordinates: KiCad mm, Y down.
"""
import argparse
import collections
import json
import math
import os
import re
import subprocess
import sys

KICAD_CLI = '/Applications/KiCad/KiCad.app/Contents/MacOS/kicad-cli'
OTHER = {'F.Cu': 'B.Cu', 'B.Cu': 'F.Cu'}


# ---------------------------------------------------------------- pure core (tested)
def grid_positions(g):
    cols = g.get('cols') or len(g['refs'])
    dx, dy = g['pitch']
    x0, y0 = g['origin']
    rot = g.get('rot', 0)
    out = {}
    for i, ref in enumerate(g['refs']):
        c, r = i % cols, i // cols
        out[ref] = (round(x0 + c * dx, 4), round(y0 + r * dy, 4), rot)
    return out


def placements(spec):
    out = {ref: tuple(v) for ref, v in spec.get('place', {}).items()}
    for g in spec.get('grids', []):
        for ref, v in grid_positions(g).items():
            if ref in out:
                raise ValueError(f'{ref} is placed twice')
            out[ref] = v
    return out


def expand_route(r):
    path = r['path']
    if len(path) < 2:
        raise ValueError(f"{r['net']}: a path needs 2 or more points")
    layer = r['layer']
    segs, vias = [], []
    prev = None
    for p in path:
        if isinstance(p, dict):
            pt = tuple(p['via'])
            if prev is not None and pt != prev:
                segs.append((prev, pt, layer, r['width']))
            vias.append(pt)
            layer = OTHER[layer]
        else:
            pt = tuple(p)
            if prev is not None:
                segs.append((prev, pt, layer, r['width']))
        prev = pt
    for a, b, _, _ in segs:
        dx, dy = b[0] - a[0], b[1] - a[1]
        if abs(dx) < 1e-9 and abs(dy) < 1e-9:
            raise ValueError(f"{r['net']}: zero-length segment at {a}")
        if not r.get('any_angle') and not (abs(dx) < 1e-6 or abs(dy) < 1e-6 or abs(abs(dx) - abs(dy)) < 1e-6):
            raise ValueError(f"{r['net']}: segment {a}->{b} is not 0/45/90 degrees")
    return segs, vias


NET_RE = re.compile(r'\[([^\]]+)\]')


def summarize_drc(d):
    v = d.get('violations', [])
    errs = [x for x in v if x.get('severity') == 'error']
    unrouted = collections.Counter()
    for u in d.get('unconnected_items', []):
        m = NET_RE.search(u['items'][0]['description'])
        unrouted[m.group(1) if m else '?'] += 1
    return {
        'errors': len(errs),
        'warnings': len(v) - len(errs),
        'warning_types': dict(collections.Counter(x['type'] for x in v if x.get('severity') != 'error')),
        'unconnected': len(d.get('unconnected_items', [])),
        'parity': len(d.get('schematic_parity', [])),
        'error_lines': [f"{x['type']}: " + ' | '.join(i['description'] for i in x['items']) for x in errs],
        'unrouted': dict(unrouted),
    }


JLC_MASK = ('Green', 'Red', 'Yellow', 'Blue', 'White', 'Black', 'Purple')
JLC_SILK = ('White', 'Black')
JLC_FINISH = ('HAL lead-free', 'ENIG')
LAYER_RE = re.compile(r'^\s*\(layer "([^"]+)"')


# KiCad draws the named 'Black' mask semi-transparent (brown over FR4). For renders only, a near-opaque hex.
RENDER_COLOR = {'Black': '#0E0E10F5'}


def apply_colors(text, mask, silk, finish, render=False):
    """Set the stackup colours (KiCad render and fab notes). Only colours JLC makes."""
    if mask not in JLC_MASK or silk not in JLC_SILK or finish not in JLC_FINISH:
        raise ValueError(f'not a JLC option: mask {mask}, silk {silk}, finish {finish}')
    shown = RENDER_COLOR.get(mask, mask) if render else mask
    want = {'F.Mask': shown, 'B.Mask': shown, 'F.SilkS': silk, 'B.SilkS': silk}
    out, cur, inside = [], None, False
    for line in text.split('\n'):
        if line.strip().startswith('(stackup'):
            inside = True
        elif inside and line.strip().startswith('(copper_finish'):
            inside = False
        m = LAYER_RE.match(line)
        if m:
            cur = m.group(1)
        if not inside:
            cur = None
        if cur in want and line.strip().startswith('(color '):
            continue
        out.append(line)
        if cur in want and line.strip().startswith('(type '):
            indent = line[:len(line) - len(line.lstrip())]
            out.append(f'{indent}(color "{want[cur]}")')
    return re.sub(r'\(copper_finish "[^"]*"\)', f'(copper_finish "{finish}")', '\n'.join(out))


def compare(a, b):
    """Before/after harness: regressions (worse), progress (better), part changes."""
    reg, prog = [], []
    for key, label in (('errors', 'DRC errors'), ('parity', 'parity'), ('unconnected', 'unconnected')):
        x, y = a['drc'][key], b['drc'][key]
        if y > x:
            reg.append(f'{label} {x} -> {y}')
        elif y < x:
            prog.append(f'{label} {x} -> {y}')
    if a.get('checker') and b.get('checker'):
        (p0, n0), (p1, n1) = a['checker'], b['checker']
        if p1 < p0:
            reg.append(f'checker {p0}/{n0} -> {p1}/{n1}')
        elif p1 > p0:
            prog.append(f'checker {p0}/{n0} -> {p1}/{n1}')
    fmt = lambda v: '(' + ', '.join(str(i) for i in v) + ')'
    pa, pb = a['parts'], b['parts']
    moved = [f'{r} {fmt(pa[r])} -> {fmt(pb[r])}' for r in sorted(pa) if r in pb and list(pa[r]) != list(pb[r])]
    return {'regressions': reg, 'progress': prog, 'moved': moved,
            'added': sorted(set(pb) - set(pa)), 'removed': sorted(set(pa) - set(pb)),
            'tracks': (a.get('tracks'), b.get('tracks')), 'vias': (a.get('vias'), b.get('vias'))}


def seigaiha(box, r, rings=3, step_deg=4):
    """Japanese wave pattern (seigaiha) as visible arc spans ((cx, cy), radius, a0, a1), degrees.

    Scales of radius r, 2r apart, rows r/2 apart, odd rows shifted by r. A lower row is in
    front. Only upper halves are drawn (Y down: angles 180-360). Every scale fits in the box.
    """
    x0, y0, x1, y1 = box
    centres = []
    j = 0
    while y0 + r + j * r / 2 <= y1:
        cy = y0 + r + j * r / 2
        cx = x0 + r + (r if j % 2 else 0)
        while cx + r <= x1 + 1e-9:
            centres.append((cx, cy))
            cx += 2 * r
        j += 1
    arcs = []
    for c in centres:
        front = [f for f in centres if f[1] > c[1] + 1e-9 and abs(f[0] - c[0]) < 2 * r and f[1] - c[1] < 2 * r]
        for k in range(1, rings + 1):
            rad = r * k / rings
            span = None
            a = 180
            while a < 360:
                m = math.radians(a + step_deg / 2)
                px, py = c[0] + rad * math.cos(m), c[1] + rad * math.sin(m)
                hidden = any(math.hypot(px - f[0], py - f[1]) < r - 1e-6 for f in front)
                if not hidden:
                    span = (span[0], a + step_deg) if span else (a, a + step_deg)
                elif span:
                    arcs.append((c, rad, span[0], span[1]))
                    span = None
                a += step_deg
            if span:
                arcs.append((c, rad, span[0], span[1]))
    return arcs


# ---------------------------------------------------------------- side effects (pcbnew, kicad-cli)
NOISE = ('Fontconfig warning:', 'create wxApp before calling this')


def drop_noise(text):
    return ''.join(l for l in text.splitlines(keepends=True) if not any(n in l for n in NOISE))


def pcb():
    # pcbnew writes a wx assert and many Fontconfig lines to fd 2 (C code). Catch fd 2 in a file and at exit
    # pass on only the other lines, so a real error still shows.
    if 'pcbnew' not in sys.modules:
        import atexit
        import tempfile
        cap = tempfile.TemporaryFile(mode='w+b')
        real = os.dup(2)
        os.dup2(cap.fileno(), 2)

        def restore():
            sys.stderr.flush()
            os.dup2(real, 2)
            cap.seek(0)
            sys.stderr.write(drop_noise(cap.read().decode(errors='replace')))
        atexit.register(restore)
    import pcbnew
    return pcbnew


def v2(x, y):
    p = pcb()
    return p.VECTOR2I(p.FromMM(x), p.FromMM(y))


def run_drc(board, out=None):
    out = out or os.path.join(os.path.dirname(os.path.abspath(board)), '.pcbtool-drc.json')
    subprocess.run([KICAD_CLI, 'pcb', 'drc', '--schematic-parity', '--format', 'json', '-o', out, board],
                   stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, check=False)
    with open(out) as f:
        d = json.load(f)
    os.remove(out)
    return summarize_drc(d)


def print_drc(s, limit=25):
    print(f"DRC: {s['errors']} errors, {s['warnings']} warnings {s['warning_types']}, "
          f"{s['unconnected']} unconnected, {s['parity']} parity")
    for line in s['error_lines'][:limit]:
        print('  E ' + line[:200])
    if s['unrouted']:
        print('  unrouted: ' + ', '.join(f'{n} {c}' for n, c in sorted(s['unrouted'].items(), key=lambda t: -t[1])))


def cmd_pads(a):
    p = pcb()
    b = p.LoadBoard(a.board)
    refs = set(a.refs)
    for fp in b.GetFootprints():
        for pad in fp.Pads():
            if not pad.GetNumber():
                continue
            if (refs and fp.GetReference() not in refs) or (a.net and pad.GetNetname() != a.net):
                continue
            q = pad.GetPosition()
            sz = pad.GetSize(p.F_Cu) if pad.IsOnLayer(p.F_Cu) else pad.GetSize(p.B_Cu)
            side = 'THT' if pad.GetAttribute() == p.PAD_ATTRIB_PTH else ('F' if pad.IsOnLayer(p.F_Cu) else 'B')
            print(f'{fp.GetReference()}.{pad.GetNumber()} {pad.GetNetname()} ({p.ToMM(q.x):.3f}, {p.ToMM(q.y):.3f}) '
                  f'{p.ToMM(sz.x):.2f}x{p.ToMM(sz.y):.2f} {side} rot {fp.GetOrientationDegrees():g}')


def cmd_place(a):
    p = pcb()
    spec = json.load(open(a.spec))
    pl = placements(spec)
    b = p.LoadBoard(a.board)
    missing = [r for r in pl if b.FindFootprintByReference(r) is None]
    if missing:
        sys.exit(f'not on the board: {missing}')
    for ref, (x, y, rot) in pl.items():
        fp = b.FindFootprintByReference(ref)
        fp.SetOrientationDegrees(rot)
        fp.SetPosition(v2(x, y))
    p.ZONE_FILLER(b).Fill(b.Zones())
    b.Save(a.board)
    print(f'placed {len(pl)} parts')
    print_drc(run_drc(a.board))


def delete_nets(b, nets):
    n = 0
    for t in list(b.GetTracks()):
        if t.GetNetname() in nets:
            b.Delete(t)
            n += 1
    return n


def cmd_unroute(a):
    p = pcb()
    b = p.LoadBoard(a.board)
    n = delete_nets(b, set(a.nets))
    p.ZONE_FILLER(b).Fill(b.Zones())
    b.Save(a.board)
    print(f'removed {n} track items')
    print_drc(run_drc(a.board))


def cmd_route(a):
    p = pcb()
    spec = json.load(open(a.spec))
    plan = [(r, *expand_route(r)) for r in spec['routes']]  # validate all before any change
    b = p.LoadBoard(a.board)
    removed = delete_nets(b, set(spec.get('clear', [])))
    via_d = spec.get('via', {'size': 0.6, 'drill': 0.3})
    nseg = nvia = 0
    for r, segs, vias in plan:
        net = b.FindNet(r['net'])
        if net is None:
            sys.exit(f"no net {r['net']} on the board")
        for (x0, y0), (x1, y1), layer, w in segs:
            t = p.PCB_TRACK(b)
            t.SetStart(v2(x0, y0))
            t.SetEnd(v2(x1, y1))
            t.SetLayer(b.GetLayerID(layer))
            t.SetWidth(p.FromMM(w))
            t.SetNet(net)
            b.Add(t)
            nseg += 1
        for x, y in vias:
            v = p.PCB_VIA(b)
            v.SetPosition(v2(x, y))
            v.SetWidth(p.FromMM(r.get('via_size', via_d['size'])))
            v.SetDrill(p.FromMM(r.get('via_drill', via_d['drill'])))
            v.SetNet(net)
            b.Add(v)
            nvia += 1
    # endpoint check: each route end must land on a pad of the same net (or on its own via)
    pads = [pd for fp in b.GetFootprints() for pd in fp.Pads() if pd.GetNumber()]
    for r, segs, vias in plan:
        for end in (r['path'][0], r['path'][-1]):
            if isinstance(end, dict):
                continue
            q = v2(*end)
            if not any(pd.GetNetname() == r['net'] and pd.HitTest(q) for pd in pads):
                others = [t for t in b.GetTracks() if t.GetNetname() == r['net'] and t.HitTest(q)]
                if len(others) < 2:
                    print(f"  W {r['net']}: end {end} is not on a pad of the net")
    p.ZONE_FILLER(b).Fill(b.Zones())
    b.Save(a.board)
    print(f'removed {removed}, added {nseg} segments and {nvia} vias')
    print_drc(run_drc(a.board))


def cmd_drc(a):
    print_drc(run_drc(a.board), limit=60)


def cmd_render(a):
    os.makedirs(a.outdir, exist_ok=True)
    base = os.path.join(a.outdir, os.path.splitext(os.path.basename(a.board))[0])
    jobs = [['--side', 'top', '--width', '1600', '--height', '2000', '-o', base + '-top.png'],
            ['--width', '1800', '--height', '1400', '--rotate', '-40,0,30', '--zoom', '0.9', '-o', base + '-iso.png']]
    for j in jobs:
        subprocess.run([KICAD_CLI, 'pcb', 'render', '--quality', 'high', *j, a.board],
                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, check=True)
        print(j[-1])


def cmd_art(a):
    """Silkscreen art from a spec, in one PCB_GROUP. A rerun replaces the group."""
    p = pcb()
    spec = json.load(open(a.spec))
    b = p.LoadBoard(a.board)
    name = spec.get('group', 'art')
    for g in list(b.Groups()):
        if g.GetName() == name or g.GetName() in spec.get('remove_groups', []):
            for it in list(g.GetItems()):
                b.Delete(it)
            b.Delete(g)
    layer = b.GetLayerID(spec.get('layer', 'B.SilkS'))
    mirror = spec.get('layer', 'B.SilkS').startswith('B.')
    grp = p.PCB_GROUP(b)
    grp.SetName(name)
    b.Add(grp)
    items = []
    faces = {}  # text uuid -> TrueType face; pcbnew does not save SetUnresolvedFontName, so it is written after Save

    def arc(c, rad, a0, a1, w):
        sh = p.PCB_SHAPE(b, p.SHAPE_T_ARC)
        pts = [v2(c[0] + rad * math.cos(math.radians(t)), c[1] + rad * math.sin(math.radians(t))) for t in (a0, (a0 + a1) / 2, a1)]
        sh.SetArcGeometry(*pts)
        sh.SetWidth(p.FromMM(w))
        sh.SetLayer(layer)
        items.append(sh)

    for wv in spec.get('waves', []):
        for c, rad, a0, a1 in seigaiha(wv['box'], wv['r'], wv.get('rings', 3)):
            arc(c, rad, a0, a1, wv.get('width', 0.18))
    for c in spec.get('circles', []):
        sh = p.PCB_SHAPE(b, p.SHAPE_T_CIRCLE)
        sh.SetCenter(v2(*c['c']))
        sh.SetEnd(v2(c['c'][0] + c['r'], c['c'][1]))
        sh.SetWidth(p.FromMM(c.get('width', 0.2)))
        sh.SetFilled(bool(c.get('fill')))
        sh.SetLayer(layer)
        items.append(sh)
    for ln in spec.get('lines', []):
        sh = p.PCB_SHAPE(b, p.SHAPE_T_SEGMENT)
        sh.SetStart(v2(*ln['a']))
        sh.SetEnd(v2(*ln['b']))
        sh.SetWidth(p.FromMM(ln.get('width', 0.2)))
        sh.SetLayer(layer)
        items.append(sh)
    for t in spec.get('texts', []):
        chars = list(t['text']) if t.get('vertical') else [t['text']]
        for i, ch in enumerate(chars):
            tx = p.PCB_TEXT(b)
            tx.SetText(ch)
            x, y = t['at']
            tx.SetPosition(v2(x, y + i * t['size'] * t.get('line', 1.1)))
            tx.SetLayer(layer)
            tx.SetTextSize(v2(t['size'], t['size']))
            tx.SetTextThickness(p.FromMM(t.get('thickness', t['size'] * 0.15)))
            tx.SetBold(bool(t.get('bold')))
            tx.SetTextAngleDegrees(t.get('angle', 0))
            tx.SetMirrored(mirror)
            if t.get('font'):
                faces[tx.m_Uuid.AsString()] = t['font']
            items.append(tx)
    for it in items:
        b.Add(it)
        grp.AddItem(it)
    b.Save(a.board)
    if faces:
        with open(a.board) as f:
            txt = f.read()
        for uid, face in faces.items():
            txt, n = re.subn(r'(\(uuid "%s"\)\s*\(effects\s*\(font\n)(\s*)' % re.escape(uid),
                             lambda m: f'{m.group(1)}{m.group(2)}(face "{face}")\n{m.group(2)}', txt, count=1)
            if n != 1:
                sys.exit(f'font face not written for text {uid}')
        with open(a.board, 'w') as f:
            f.write(txt)
    print(f'{name}: {len(items)} items on {spec.get("layer", "B.SilkS")}')
    print_drc(run_drc(a.board))


VARIANTS = {
    'black-enig': ('Black', 'White', 'ENIG'), 'white-enig': ('White', 'Black', 'ENIG'),
    'blue-enig': ('Blue', 'White', 'ENIG'), 'purple-enig': ('Purple', 'White', 'ENIG'),
    'red-enig': ('Red', 'White', 'ENIG'), 'green-hasl': ('Green', 'White', 'HAL lead-free'),
}


def cmd_colors(a):
    """Render colour variants from a temporary copy next to the board (KIPRJMOD stays valid)."""
    os.makedirs(a.outdir, exist_ok=True)
    src = open(a.board).read()
    d = os.path.dirname(os.path.abspath(a.board))
    for name in (a.variants or VARIANTS):
        tmp = os.path.join(d, f'.pcbtool-{name}.kicad_pcb')
        with open(tmp, 'w') as f:
            f.write(apply_colors(src, *VARIANTS[name], render=True))
        try:
            for side, extra in (('iso', ['--rotate', '-40,0,30', '--zoom', '0.9']), ('bottom', ['--side', 'bottom'])):
                out = os.path.join(a.outdir, f'{name}-{side}.png')
                subprocess.run([KICAD_CLI, 'pcb', 'render', '--quality', 'high', '--width', '1600', '--height', '1300',
                                '--background', 'opaque', *extra, '-o', out, tmp],
                               stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, check=True)
                print(out)
        finally:
            for f in (tmp, tmp[:-len('.kicad_pcb')] + '.kicad_prl'):  # kicad-cli writes a .kicad_prl
                if os.path.exists(f):
                    os.remove(f)


def cmd_setcolors(a):
    with open(a.board) as f:
        s = f.read()
    with open(a.board, 'w') as f:
        f.write(apply_colors(s, a.mask, a.silk, a.finish))
    print(f'stackup: mask {a.mask}, silk {a.silk}, finish {a.finish}')


def cmd_snapshot(a):
    p = pcb()
    b = p.LoadBoard(a.board)
    snap = {'drc': run_drc(a.board),
            'parts': {fp.GetReference(): [round(p.ToMM(fp.GetPosition().x), 3), round(p.ToMM(fp.GetPosition().y), 3),
                                          round(fp.GetOrientationDegrees(), 1), 'B' if fp.IsFlipped() else 'F']
                      for fp in b.GetFootprints()},
            'tracks': sum(1 for t in b.GetTracks() if not isinstance(t, p.PCB_VIA)),
            'vias': sum(1 for t in b.GetTracks() if isinstance(t, p.PCB_VIA))}
    if a.checker:
        out = subprocess.run(a.checker, shell=True, capture_output=True, text=True).stdout
        m = re.search(r'(\d+)/(\d+) checks pass', out)
        snap['checker'] = [int(m.group(1)), int(m.group(2))] if m else None
    with open(a.out, 'w') as f:
        json.dump(snap, f, indent=1)
    c = snap.get('checker')
    print(f"snapshot {a.out}: {snap['drc']['errors']} errors, {snap['drc']['unconnected']} unconnected, "
          f"{snap['drc']['parity']} parity, {snap['tracks']} tracks, {snap['vias']} vias" + (f', checker {c[0]}/{c[1]}' if c else ''))


def cmd_compare(a):
    r = compare(json.load(open(a.before)), json.load(open(a.after)))
    for k in ('regressions', 'progress'):
        print(f"{k}: {', '.join(r[k]) or '-'}")
    print(f"tracks {r['tracks'][0]} -> {r['tracks'][1]}, vias {r['vias'][0]} -> {r['vias'][1]}")
    for k in ('added', 'removed'):
        if r[k]:
            print(f"{k}: {', '.join(r[k])}")
    for m in r['moved'][:40]:
        print('  moved ' + m)
    sys.exit(1 if r['regressions'] else 0)


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sp = ap.add_subparsers(dest='cmd', required=True)
    s = sp.add_parser('pads'); s.add_argument('board'); s.add_argument('refs', nargs='*'); s.add_argument('--net')
    s.set_defaults(f=cmd_pads)
    for name, f in (('place', cmd_place), ('route', cmd_route)):
        s = sp.add_parser(name); s.add_argument('board'); s.add_argument('spec'); s.set_defaults(f=f)
    s = sp.add_parser('unroute'); s.add_argument('board'); s.add_argument('nets', nargs='+'); s.set_defaults(f=cmd_unroute)
    s = sp.add_parser('drc'); s.add_argument('board'); s.set_defaults(f=cmd_drc)
    s = sp.add_parser('render'); s.add_argument('board'); s.add_argument('outdir'); s.set_defaults(f=cmd_render)
    s = sp.add_parser('art'); s.add_argument('board'); s.add_argument('spec'); s.set_defaults(f=cmd_art)
    s = sp.add_parser('colors'); s.add_argument('board'); s.add_argument('outdir'); s.add_argument('variants', nargs='*')
    s.set_defaults(f=cmd_colors)
    s = sp.add_parser('setcolors'); s.add_argument('board'); s.add_argument('mask'); s.add_argument('silk'); s.add_argument('finish')
    s.set_defaults(f=cmd_setcolors)
    s = sp.add_parser('snapshot'); s.add_argument('board'); s.add_argument('out'); s.add_argument('--checker')
    s.set_defaults(f=cmd_snapshot)
    s = sp.add_parser('compare'); s.add_argument('before'); s.add_argument('after'); s.set_defaults(f=cmd_compare)
    a = ap.parse_args()
    a.f(a)


if __name__ == '__main__':
    main()
