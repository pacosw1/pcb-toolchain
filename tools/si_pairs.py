#!/usr/bin/env python3
"""si_pairs: gate for differential pairs and controlled-impedance nets.

It reads the routed copper of each pair in SPEC.json and checks:
  - differential impedance from the trace width, gap and the stackup,
  - length skew between the two legs,
  - uncoupled length (the part of a leg that is not next to the other leg at the pair pitch),
  - width and gap consistency, via count per leg, and the reference plane under the pair.
It also reports the length and the reference plane of single-ended fast nets (for example SPI clocks).

Run with the KiCad bundled Python (it has pcbnew):
  PY=/Applications/KiCad/KiCad.app/Contents/Frameworks/Python.framework/Versions/Current/bin/python3
  $PY tools/si_pairs.py BOARD.kicad_pcb SPEC.json [--verbose]
Exit 0: all PASS. Exit 1: one or more FAIL. Exit 2: tool error (bad spec, net not found, stackup mismatch).
The tool only reads the board. It never writes a .kicad_* file.

Spec: see hardware-design/boards/BASE-PWR/diff-pairs.json.
"""
import argparse
import json
import math
import os
import re
import sys


class SpecError(Exception):
    """A spec or board problem. The CLI stops with exit 2 (fail closed)."""


# ---------------------------------------------------------------- impedance (pure)
# Microstrip (outer layers): Hammerstad and Jensen 1980, "Accurate models for microstrip computer-aided design",
# with their thickness correction. Wadell, "Transmission Line Design Handbook" (1991), section 3.5.
# Edge-coupled microstrip: Kirschning and Jansen 1984, "Accurate wide-range design equations for the
# frequency-dependent characteristic of parallel coupled microstrip lines" (static even/odd mode part),
# Wadell section 3.6. Zdiff = 2 * Z0odd.
# Stripline (inner layers): IPC-2141A symmetric stripline, Z0 = 60/sqrt(Er) ln(4b / (0.67 pi (0.8w + t))),
# Zdiff = 2 Z0 (1 - 0.374 exp(-2.9 s/b)). IPC-2141A is a coarse model (about +-10 %).
# All lengths in mm. The equations do not model solder mask; mask lowers Z by a few ohm (see the tests).
ETA0 = 376.73


def _z01(u):
    # Hammerstad-Jensen impedance of a zero-thickness microstrip in air, u = w/h.
    f = 6 + (2 * math.pi - 6) * math.exp(-(30.666 / u) ** 0.7528)
    return ETA0 / (2 * math.pi) * math.log(f / u + math.sqrt(1 + (2 / u) ** 2))


def _eeff0(u, er):
    a = 1 + math.log((u ** 4 + (u / 52) ** 2) / (u ** 4 + 0.432)) / 49 + math.log(1 + (u / 18.1) ** 3) / 18.7
    b = 0.564 * ((er - 0.9) / (er + 3)) ** 0.053
    return (er + 1) / 2 + (er - 1) / 2 * (1 + 10 / u) ** (-a * b)


def _microstrip(w, h, t, er):
    """Return (Z0, Eeff, u_r): single microstrip with the Hammerstad-Jensen thickness correction."""
    u = w / h
    if t > 0:
        tn = t / h
        du1 = tn / math.pi * math.log(1 + 4 * math.e / (tn / math.tanh(math.sqrt(6.517 * u)) ** 2))
        dur = 0.5 * (1 + 1 / math.cosh(math.sqrt(er - 1))) * du1
    else:
        du1 = dur = 0.0
    u1, ur = u + du1, u + dur
    z = _z01(ur) / math.sqrt(_eeff0(ur, er))
    eeff = _eeff0(ur, er) * (_z01(u1) / _z01(ur)) ** 2
    return z, eeff, ur


def microstrip_z0(w, h, t, er):
    return _microstrip(w, h, t, er)[0]


def microstrip_zdiff(w, s, h, t, er):
    """Differential impedance 2 * Z0odd of an edge-coupled microstrip pair (Kirschning-Jansen, static)."""
    zl, eeff, u = _microstrip(w, h, t, er)
    g = s / h
    # Odd mode effective permittivity.
    ao = 0.7287 * (eeff - (er + 1) / 2) * (1 - math.exp(-0.179 * u))
    bo = 0.747 * er / (0.15 + er)
    co = bo - (bo - 0.207) * math.exp(-0.414 * u)
    do = 0.593 + 0.694 * math.exp(-0.562 * u)
    eo = ((er + 1) / 2 + ao - eeff) * math.exp(-co * g ** do) + eeff
    # Odd mode impedance.
    q1 = 0.8695 * u ** 0.194
    q2 = 1 + 0.7519 * g + 0.189 * g ** 2.31
    q3 = 0.1975 + (16.6 + (8.4 / g) ** 6) ** -0.387 + math.log(g ** 10 / (1 + (g / 3.4) ** 10)) / 241
    q4 = 2 * q1 / q2 / (math.exp(-g) * u ** q3 + (2 - math.exp(-g)) * u ** -q3)
    q5 = 1.794 + 1.14 * math.log(1 + 0.638 / (g + 0.517 * g ** 2.43))
    q6 = 0.2305 + math.log(g ** 10 / (1 + (g / 5.8) ** 10)) / 281.3 + math.log(1 + 0.598 * g ** 1.154) / 5.1
    q7 = (10 + 190 * g ** 2) / (1 + 82.3 * g ** 3)
    q8 = math.exp(-6.5 - 0.95 * math.log(g) - (g / 0.15) ** 5)
    q9 = math.log(q7) * (q8 + 1 / 16.5)
    q10 = (q2 * q4 - q5 * math.exp(math.log(u) * q6 * u ** -q9)) / q2
    zo = zl * math.sqrt(eeff / eo) / (1 - zl / ETA0 * math.sqrt(eeff) * q10)
    return 2 * zo


def stripline_z0(w, b, t, er):
    return 60 / math.sqrt(er) * math.log(4 * b / (0.67 * math.pi * (0.8 * w + t)))


def stripline_zdiff(w, s, b, t, er):
    return 2 * stripline_z0(w, b, t, er) * (1 - 0.374 * math.exp(-2.9 * s / b))


# ---------------------------------------------------------------- stackup (pure)
def parse_stackup(text):
    """Parse the (stackup ...) of a .kicad_pcb text. Return {copper layer: {t_mm, h_mm, er}}.
    h_mm and er are of the dielectric directly below the layer (for B.Cu: above), so for F.Cu and B.Cu they
    are the dielectric to the adjacent plane layer."""
    m = re.search(r'\(stackup(.*?)\(copper_finish|\(stackup(.*)', text, re.S)
    if not m:
        raise SpecError('board has no (stackup) section')
    body = m.group(1) or m.group(2)
    items = []
    for lm in re.finditer(r'\(layer "([^"]+)"(.*?)(?=\(layer "|\Z)', body, re.S):
        name, rest = lm.group(1), lm.group(2)
        typ = re.search(r'\(type "([^"]+)"\)', rest)
        th = re.search(r'\(thickness ([\d.]+)', rest)
        er = re.search(r'\(epsilon_r ([\d.]+)\)', rest)
        items.append((name, typ.group(1) if typ else '', float(th.group(1)) if th else None,
                      float(er.group(1)) if er else None))
    out = {}
    for i, (name, typ, th, _) in enumerate(items):
        if typ != 'copper':
            continue
        # The dielectric toward the board centre: below for the top half, above for B.Cu.
        step = -1 if name == 'B.Cu' else 1
        j = i + step
        while 0 <= j < len(items) and items[j][1] in ('', 'Top Solder Mask', 'Bottom Solder Mask'):
            j += step
        d = items[j] if 0 <= j < len(items) and items[j][1] in ('prepreg', 'core') else None
        out[name] = {'t_mm': th, 'h_mm': d[2] if d else None, 'er': d[3] if d else None}
    return out


def check_stackup(layers, board_stackup, rel=0.01):
    """Raise SpecError when a spec layer value differs from the board stackup by more than rel."""
    bad = []
    for name, spec in layers.items():
        got = board_stackup.get(name)
        if got is None:
            bad.append(f'{name}: not in the board stackup')
            continue
        for k in ('t_mm', 'h_mm', 'er'):
            if k in spec and (got[k] is None or abs(got[k] - spec[k]) > rel * spec[k]):
                bad.append(f'{name} {k}: spec {spec[k]} board {got[k]}')
    if bad:
        raise SpecError('stackup mismatch (spec vs .kicad_pcb): ' + '; '.join(bad))


# ---------------------------------------------------------------- geometry (pure)
# A net is {'segs': [(layer, x1, y1, x2, y2, width)], 'vias': [(x, y)], 'pads': {name: [(x, y) track ends in pad]}}.
# All in mm. Arcs come in as short chords.
def arc_points(start, mid, end, max_chord=0.05):
    """Points along the circle arc through start, mid and end, with chords of at most max_chord mm."""
    (ax, ay), (bx, by), (cx, cy) = start, mid, end
    d = 2 * (ax * (by - cy) + bx * (cy - ay) + cx * (ay - by))
    if abs(d) < 1e-12:
        return [start, end]
    ux = ((ax * ax + ay * ay) * (by - cy) + (bx * bx + by * by) * (cy - ay) + (cx * cx + cy * cy) * (ay - by)) / d
    uy = ((ax * ax + ay * ay) * (cx - bx) + (bx * bx + by * by) * (ax - cx) + (cx * cx + cy * cy) * (bx - ax)) / d
    r = math.hypot(ax - ux, ay - uy)
    a0, am, a1 = (math.atan2(y - uy, x - ux) for x, y in (start, mid, end))

    def ccw(a, b):
        return (b - a) % (2 * math.pi)
    sweep = ccw(a0, a1) if ccw(a0, am) < ccw(a0, a1) else -ccw(a1, a0)
    k = max(1, math.ceil(abs(sweep) * r / max_chord))
    return [start] + [(ux + r * math.cos(a0 + sweep * i / k), uy + r * math.sin(a0 + sweep * i / k))
                      for i in range(1, k)] + [end]


def _key(x, y):
    return (round(x, 4), round(y, 4))


def _seg_dist(px, py, x1, y1, x2, y2):
    dx, dy = x2 - x1, y2 - y1
    L2 = dx * dx + dy * dy
    t = 0.0 if L2 == 0 else max(0.0, min(1.0, ((px - x1) * dx + (py - y1) * dy) / L2))
    return math.hypot(px - x1 - t * dx, py - y1 - t * dy)


def path_length(net, a, b):
    """Shortest copper path length from pad a to pad b. Stubs off the path do not count."""
    import heapq
    for p in (a, b):
        if p not in net['pads'] or not net['pads'][p]:
            raise SpecError(f'pad {p} has no track end in it')
    ends = [(s[1], s[2]) for s in net['segs']] + [(s[3], s[4]) for s in net['segs']]
    graph = {}

    def edge(u, v, w):
        graph.setdefault(u, []).append((v, w))
        graph.setdefault(v, []).append((u, w))
    for _, x1, y1, x2, y2, _ in net['segs']:
        # Split the segment where another track ends on it (a T junction).
        L = math.hypot(x2 - x1, y2 - y1)
        ts = sorted({0.0, 1.0} | {((ex - x1) * (x2 - x1) + (ey - y1) * (y2 - y1)) / (L * L)
                                  for ex, ey in ends if L > 0 and _seg_dist(ex, ey, x1, y1, x2, y2) < 1e-3})
        pts = [(x1 + t * (x2 - x1), y1 + t * (y2 - y1)) for t in ts if 0 <= t <= 1]
        for (ux, uy), (vx, vy) in zip(pts, pts[1:]):
            edge(_key(ux, uy), _key(vx, vy), math.hypot(vx - ux, vy - uy))
    for name, pts in net['pads'].items():
        for x, y in pts:
            edge(('pad', name), _key(x, y), 0.0)
    dist, todo = {('pad', a): 0.0}, [(0.0, 0, ('pad', a))]
    n = 0
    while todo:
        d, _, u = heapq.heappop(todo)
        if u == ('pad', b):
            return d
        if d > dist.get(u, math.inf):
            continue
        for v, w in graph.get(u, []):
            if d + w < dist.get(v, math.inf):
                dist[v] = d + w
                n += 1
                heapq.heappush(todo, (d + w, n, v))
    raise SpecError(f'no copper path from pad {a} to pad {b}')


def _samples(net, step):
    """Points along every segment: (layer, x, y, width, length it stands for)."""
    for layer, x1, y1, x2, y2, w in net['segs']:
        L = math.hypot(x2 - x1, y2 - y1)
        k = max(1, math.ceil(L / step))
        for i in range(k):
            t = (i + 0.5) / k
            yield layer, x1 + t * (x2 - x1), y1 + t * (y2 - y1), w, L / k


def _gaps(a, b, step):
    """For each sample of leg a: (sample, edge gap to the nearest segment of leg b on the same layer)."""
    out = []
    for s in _samples(a, step):
        best = math.inf
        for layer, x1, y1, x2, y2, w in b['segs']:
            if layer == s[0]:
                best = min(best, _seg_dist(s[1], s[2], x1, y1, x2, y2) - (w + s[3]) / 2)
        out.append((s, best))
    return out


def analyze_pair(p, n, step=0.05, gap_tol=0.02, max_gap=0.5):
    """Coupling of two legs. The nominal gap per layer is the most common edge gap below max_gap.
    A sample is coupled when its gap is within gap_tol of the nominal gap."""
    gp, gn = _gaps(p, n, step), _gaps(n, p, step)
    layers = {}
    for layer in sorted({s[0] for s, _ in gp + gn}):
        near = [round(g, 3) for s, g in gp + gn if s[0] == layer and g <= max_gap]
        if not near:
            continue
        nominal = max(set(near), key=lambda g: (near.count(g), -g))
        cs = [s for s, g in gp + gn if s[0] == layer and abs(g - nominal) <= gap_tol]
        layers[layer] = {'gap': nominal, 'coupled_mm': sum(s[4] for s in cs) / 2,
                         'widths': sorted({round(s[3], 4) for s in cs}),
                         'w': sum(s[3] * s[4] for s in cs) / sum(s[4] for s in cs)}

    def uncoupled(gs):
        return sum(s[4] for s, g in gs if s[0] not in layers or abs(g - layers[s[0]]['gap']) > gap_tol)
    return {'layers': layers, 'uncoupled_p': uncoupled(gp), 'uncoupled_n': uncoupled(gn)}


def ref_coverage(nets, layers, ref_nets, ref_at, step=0.05):
    """Percent of the track length that has copper of one of ref_nets on the reference layer under it."""
    ref_nets = {ref_nets} if isinstance(ref_nets, str) else set(ref_nets)
    tot = hit = 0.0
    for net in nets:
        for layer, x, y, _, L in _samples(net, step):
            tot += L
            if ref_nets & ref_at(layers[layer]['ref_layer'], x, y):
                hit += L
    return 100.0 * hit / tot if tot else 0.0


# ---------------------------------------------------------------- evaluation (pure)
def zdiff(layer, w, s):
    m = layer['model']
    if m == 'microstrip':
        return layer.get('mask_factor_diff', 1.0) * microstrip_zdiff(w, s, layer['h_mm'], layer['t_mm'], layer['er'])
    if m == 'stripline':
        return stripline_zdiff(w, s, layer['b_mm'], layer['t_mm'], layer['er'])
    raise SpecError(f'unknown model {m}')


def _net(board, name):
    if name not in board['nets'] or not board['nets'][name]['segs']:
        raise SpecError(f'net {name} has no tracks on the board')
    net = board['nets'][name]
    return net


def _check_layers(nets, layers):
    for net in nets:
        for s in net['segs']:
            if s[0] not in layers:
                raise SpecError(f'track on {s[0]} but the spec has no model for {s[0]}')


def _leg_len(net, pads):
    return path_length(net, *pads) if pads else sum(math.hypot(s[3] - s[1], s[4] - s[2]) for s in net['segs'])


def _row(item, check, ok, detail):
    return {'item': item, 'check': check, 'status': 'PASS' if ok else 'FAIL', 'detail': detail}


def evaluate(spec, board):
    """Return result rows {item, check, status, detail}. Raise SpecError on a spec or board problem."""
    layers = spec['stackup']['layers']
    check_stackup(layers, board['stackup'])
    rows = []
    for pr in spec.get('pairs', []):
        name = pr['name']
        p, n = _net(board, pr['p']), _net(board, pr['n'])
        _check_layers((p, n), layers)
        a = analyze_pair(p, n, gap_tol=pr.get('gap_tol_mm', 0.02), max_gap=pr.get('max_gap_mm', 0.5))
        rows.append(_row(name, 'coupling', bool(a['layers']),
                         f'coupled on {sorted(a["layers"])}' if a['layers'] else
                         f'the legs are never within {pr.get("max_gap_mm", 0.5)} mm of each other'))
        tol = pr['tol_pct'] / 100 * pr['z_diff']
        for lname, lay in a['layers'].items():
            z = zdiff(layers[lname], lay['w'], lay['gap'])
            rows.append(_row(name, f'zdiff {lname}', abs(z - pr['z_diff']) <= tol,
                             f'{z:.1f} ohm (target {pr["z_diff"]} +-{pr["tol_pct"]}%) w {lay["w"]:.3f} '
                             f'gap {lay["gap"]:.3f} coupled {lay["coupled_mm"]:.2f} mm'))
            rows.append(_row(name, f'width {lname}', len(lay['widths']) == 1, f'coupled widths {lay["widths"]}'))
        lp, ln = _leg_len(p, pr.get('p_pads')), _leg_len(n, pr.get('n_pads'))
        rows.append(_row(name, 'skew', abs(lp - ln) <= pr['max_skew_mm'],
                         f'{abs(lp - ln):.3f} mm (p {lp:.3f}, n {ln:.3f}, max {pr["max_skew_mm"]})'))
        unc = max(a['uncoupled_p'], a['uncoupled_n'])
        rows.append(_row(name, 'uncoupled', unc <= pr['max_uncoupled_mm'],
                         f'{unc:.2f} mm (p {a["uncoupled_p"]:.2f}, n {a["uncoupled_n"]:.2f}, '
                         f'max {pr["max_uncoupled_mm"]})'))
        rows.append(_row(name, 'vias', len(p['vias']) == len(n['vias']),
                         f'p {len(p["vias"])}, n {len(n["vias"])}'))
        cov = ref_coverage((p, n), layers, pr['reference'], board['ref_at'])
        rows.append(_row(name, 'reference', cov >= pr.get('min_ref_pct', 100),
                         f'{math.floor(cov * 10) / 10:.1f} % of the length over {pr["reference"]} (min {pr.get("min_ref_pct", 100)} %)'))
    for ne in spec.get('nets', []):
        net = _net(board, ne['net'])
        _check_layers((net,), layers)
        L = _leg_len(net, ne.get('pads'))
        lim = ne.get('max_len_mm', math.inf)
        rows.append(_row(ne['name'], 'length', L <= lim,
                         f'{L:.2f} mm, {len(net["vias"])} vias, layers {sorted({s[0] for s in net["segs"]})}'
                         + (f' (max {lim})' if lim < math.inf else '')))
        cov = ref_coverage((net,), layers, ne['reference'], board['ref_at'])
        rows.append(_row(ne['name'], 'reference', cov >= ne.get('min_ref_pct', 100),
                         f'{math.floor(cov * 10) / 10:.1f} % of the length over {ne["reference"]} (min {ne.get("min_ref_pct", 100)} %)'))
    return rows



# ---------------------------------------------------------------- side effects (pcbnew, files)
NOISE = ('Fontconfig warning:', 'create wxApp before calling this', 'Adding duplicate image handler')


def drop_noise(text):
    return ''.join(line for line in text.splitlines(keepends=True) if not any(n in line for n in NOISE))


def pcb():
    # pcbnew writes a wx assert and many Fontconfig lines to fd 2 (C code). Catch fd 2 in a file and at exit
    # pass on only the other lines, so a real error still shows. Same as tools/pcbtool.py.
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


def load_board(path, net_names):
    """Read the board (no write). Fill the zones in memory only, so the reference check sees the current fill."""
    with open(path) as f:
        text = f.read()
    p = pcb()
    bd = p.LoadBoard(path)
    p.ZONE_FILLER(bd).Fill(bd.Zones())
    mm = p.ToMM
    nets = {n: {'segs': [], 'vias': [], 'pads': {}} for n in net_names}
    for t in bd.GetTracks():
        net = nets.get(t.GetNetname())
        if net is None:
            continue
        if t.GetClass() == 'PCB_VIA':
            net['vias'].append((mm(t.GetPosition().x), mm(t.GetPosition().y)))
            continue
        a, b = (mm(t.GetStart().x), mm(t.GetStart().y)), (mm(t.GetEnd().x), mm(t.GetEnd().y))
        pts = [a, b]
        if t.GetClass() == 'PCB_ARC':
            pts = arc_points(a, (mm(t.GetMid().x), mm(t.GetMid().y)), b)
        for (x1, y1), (x2, y2) in zip(pts, pts[1:]):
            net['segs'].append((t.GetLayerName(), x1, y1, x2, y2, mm(t.GetWidth())))
    for pad in bd.GetPads():
        net = nets.get(pad.GetNetname())
        if net is None:
            continue
        name = f'{pad.GetParentFootprint().GetReference()}.{pad.GetNumber()}'
        inside = net['pads'].setdefault(name, [])
        for layer, x1, y1, x2, y2, _ in net['segs']:
            lid = bd.GetLayerID(layer)
            for x, y in ((x1, y1), (x2, y2)):
                if pad.IsOnLayer(lid) and pad.HitTest(p.VECTOR2I(p.FromMM(x), p.FromMM(y))):
                    inside.append((x, y))
    zones = list(bd.Zones())

    def ref_at(layer, x, y):
        lid = bd.GetLayerID(layer)
        pos = p.VECTOR2I(p.FromMM(x), p.FromMM(y))
        return {z.GetNetname() for z in zones if z.IsOnLayer(lid) and z.HitTestFilledArea(lid, pos)}
    return {'stackup': parse_stackup(text), 'nets': nets, 'ref_at': ref_at}


def main(argv=None):
    ap = argparse.ArgumentParser(description='Differential pair and controlled-impedance gate (read only).')
    ap.add_argument('board')
    ap.add_argument('spec')
    ap.add_argument('--verbose', action='store_true', help='also print the PASS rows')
    args = ap.parse_args(argv)
    try:
        with open(args.spec) as f:
            spec = json.load(f)
        names = [x for pr in spec.get('pairs', []) for x in (pr['p'], pr['n'])]
        names += [ne['net'] for ne in spec.get('nets', [])]
        rows = evaluate(spec, load_board(args.board, names))
    except (SpecError, OSError, KeyError, ValueError) as e:
        print(f'si_pairs: ERROR {type(e).__name__}: {e}', file=sys.stderr)
        return 2
    fails = [r for r in rows if r['status'] == 'FAIL']
    for r in rows:
        if args.verbose or r['status'] == 'FAIL':
            print(f"{r['status']:4} {r['item']:12} {r['check']:14} {r['detail']}")
    print(f'si_pairs: {len(rows) - len(fails)} PASS, {len(fails)} FAIL')
    return 1 if fails else 0


if __name__ == '__main__':
    sys.exit(main())
