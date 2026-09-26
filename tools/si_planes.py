#!/usr/bin/env python3
"""si_planes: reference-plane gate for a 4-layer board.

It fails when a signal track on an outer layer has no filled ground plane of its own domain on the
adjacent layer, when a track crosses over the ground of another domain, and when a track cuts an
inner plane layer. It reads the board only. It fills the zones in memory and never saves.

Run with the KiCad bundled Python (it has pcbnew):
  PY=/Applications/KiCad/KiCad.app/Contents/Frameworks/Python.framework/Versions/Current/bin/python3
  $PY tools/si_planes.py BOARD.kicad_pcb SPEC.json [--verbose]
Exit 0 = pass, 1 = one or more FAIL, 2 = tool error (missing board, bad spec).

Spec (one per board, hardware-design/boards/<board>/reference-planes.json):
  {"about": "text",
   "adjacent": {"F.Cu": "In1.Cu", "B.Cu": "In2.Cu"},      outer layer -> its reference layer
   "plane_layers": ["In1.Cu", "In2.Cu"],                   a track on these layers is a FAIL
   "mixed_layers": {"In2.Cu": {"allow": "slow", "fast_file": "rp001-fast-nets.json",
                               "power": ["GND", "VBUS"], "reason": "..."}},
                                                           optional: a plane layer that may also carry tracks of
                                                           slow nets (not fast, not power, not a ground). fast_file is
                                                           relative to the spec ({"fast": [patterns]}; no file = error).
                                                           A fast net over it (on the outer layer that it references)
                                                           fails on any gap; each fill piece of a ground on it must
                                                           hold a via or a through-hole pad of that ground (no island).
   "grounds": ["GND", "ISO_0V"],                           one ground net per domain
   "alt_refs": {"VDD_3V3": {"domain": "GND", "reason": "..."}},   other plane nets that are a reference
   "domains": {"ISO_0V": ["/AI*"]},                        optional: net patterns -> domain (else the
                                                           ground zone outline that holds most pads)
   "exempt": {"nets": {"VIN": "reason"},
              "areas": [{"box": [x0, y0, x1, y1], "nets": ["/A"], "reason": "..."}]},
   "max_unreferenced_mm": 1.0,   longest continuous unreferenced run that passes
   "slow_max_gap_mm": 5.0,       optional: this limit for a slow net (not fast in mixed_layers), and
   "slow_min_coverage_pct": 95,  optional: min referenced % of its length (samples near own vias/pads count)
   "via_allow_mm": 0.6,          a run this near (plus the pad/via radius) the net's own via/pad is OK
   "step_mm": 0.25}              sample step along each track
Coordinates: KiCad mm, Y down.
"""
import argparse
import collections
import fnmatch
import json
import math
import os
import sys

DEFAULTS = {'max_unreferenced_mm': 1.0, 'via_allow_mm': 0.6, 'step_mm': 0.25}
REQUIRED = ('about', 'adjacent', 'plane_layers', 'grounds')
SLOW_LIMITS = ('slow_max_gap_mm', 'slow_min_coverage_pct')
KEYS = set(REQUIRED) | set(DEFAULTS) | {'alt_refs', 'domains', 'exempt', 'mixed_layers'} | set(SLOW_LIMITS)


class SpecError(ValueError):
    pass


# ---------------------------------------------------------------- pure core (tested)
def sample_segment(a, b, step):
    """Sample points (x, y, weight mm) at the centres of equal parts no longer than step."""
    length = math.dist(a, b)
    if length == 0:
        return []
    n = max(1, math.ceil(length / step - 1e-9))
    w = length / n
    return [(a[0] + (b[0] - a[0]) * (i + 0.5) / n, a[1] + (b[1] - a[1]) * (i + 0.5) / n, w) for i in range(n)]


def sample_arc(a, m, e, step):
    """Sample an arc from a through m to e, like sample_segment."""
    (ax, ay), (bx, by), (cx, cy) = a, m, e
    d = 2 * (ax * (by - cy) + bx * (cy - ay) + cx * (ay - by))
    if abs(d) < 1e-12:
        return sample_segment(a, e, step)
    ux = ((ax * ax + ay * ay) * (by - cy) + (bx * bx + by * by) * (cy - ay) + (cx * cx + cy * cy) * (ay - by)) / d
    uy = ((ax * ax + ay * ay) * (cx - bx) + (bx * bx + by * by) * (ax - cx) + (cx * cx + cy * cy) * (bx - ax)) / d
    r = math.dist((ux, uy), a)
    t0, tm, t1 = (math.atan2(p[1] - uy, p[0] - ux) for p in (a, m, e))
    sweep = (t1 - t0) % (2 * math.pi)
    if (tm - t0) % (2 * math.pi) > sweep:   # the arc goes the other way round
        sweep -= 2 * math.pi
    length = abs(sweep) * r
    n = max(1, math.ceil(length / step - 1e-9))
    return [(ux + r * math.cos(t0 + sweep * (i + 0.5) / n), uy + r * math.sin(t0 + sweep * (i + 0.5) / n), length / n)
            for i in range(n)]


def _reason(v, where):
    if not isinstance(v, str) or not v.strip():
        raise SpecError(f'{where}: a written reason is required')


def load_spec(raw):
    """Check a spec dict and add the defaults. Raise SpecError on any problem (fail closed)."""
    if not isinstance(raw, dict):
        raise SpecError('spec must be a JSON object')
    unknown = set(raw) - KEYS
    if unknown:
        raise SpecError(f'unknown spec keys: {sorted(unknown)}')
    # plane_layers may be empty: a 2-layer board has no plane layer
    missing = [k for k in REQUIRED if k not in raw or (k != 'plane_layers' and not raw[k])]
    if missing:
        raise SpecError(f'missing spec keys: {missing}')
    s = dict(DEFAULTS)
    s.update(raw)
    for k in list(DEFAULTS) + [k for k in SLOW_LIMITS if k in s]:
        if not isinstance(s[k], (int, float)) or s[k] <= 0:
            raise SpecError(f'{k} must be a number > 0')
    if not isinstance(s['adjacent'], dict) or not isinstance(s['plane_layers'], list) or not isinstance(s['grounds'], list):
        raise SpecError('adjacent must be an object; plane_layers and grounds must be lists')
    grounds = set(s['grounds'])
    s['alt_refs'] = s.get('alt_refs') or {}
    for net, a in s['alt_refs'].items():
        if not isinstance(a, dict) or a.get('domain') not in grounds:
            raise SpecError(f'alt_refs {net}: domain must be one of the grounds')
        _reason(a.get('reason'), f'alt_refs {net}')
    s['domains'] = s.get('domains') or {}
    for g, pats in s['domains'].items():
        if g not in grounds or not isinstance(pats, list):
            raise SpecError(f'domains {g}: key must be a ground, value a list of net patterns')
    ex = s.get('exempt') or {}
    if set(ex) - {'nets', 'areas'}:
        raise SpecError(f'unknown exempt keys: {sorted(set(ex) - {"nets", "areas"})}')
    ex.setdefault('nets', {})
    ex.setdefault('areas', [])
    for net, why in ex['nets'].items():
        _reason(why, f'exempt net {net}')
    for i, ar in enumerate(ex['areas']):
        if not isinstance(ar, dict) or len(ar.get('box') or []) != 4 or not ar.get('nets'):
            raise SpecError(f'exempt area {i}: needs box [x0, y0, x1, y1] and nets')
        _reason(ar.get('reason'), f'exempt area {i}')
    s['exempt'] = ex
    s['mixed_layers'] = s.get('mixed_layers') or {}
    for L, m in s['mixed_layers'].items():
        if L not in s['plane_layers'] or not isinstance(m, dict):
            raise SpecError(f'mixed_layers {L}: must be a plane layer with an object value')
        if m.get('allow') != 'slow' or not isinstance(m.get('fast_file'), str) or not m['fast_file']:
            raise SpecError(f'mixed_layers {L}: needs "allow": "slow" and "fast_file"')
        if not isinstance(m.get('power'), list) or not all(isinstance(q, str) for q in m['power']):
            raise SpecError(f'mixed_layers {L}: "power" must be a list of net patterns')
        _reason(m.get('reason'), f'mixed_layers {L}')
    return s


def parse_fast(raw, path):
    """The "fast" net patterns of an rp001-fast-nets.json dict. Raise SpecError when they are not a list of strings."""
    pats = raw.get('fast') if isinstance(raw, dict) else None
    if not isinstance(pats, list) or not pats or not all(isinstance(q, str) for q in pats):
        raise SpecError(f'{path}: "fast" must be a list of net patterns')
    return pats


def set_fast(s, fast):
    """Put the fast patterns {mixed layer: [patterns]} in the spec."""
    for L, pats in fast.items():
        s['mixed_layers'][L]['fast'] = list(pats)


def load_fast(s, spec_dir):
    """Read the fast_file of each mixed layer (relative to spec_dir). A missing or bad file is a SpecError (fail closed)."""
    fast = {}
    for L, m in s['mixed_layers'].items():
        path = os.path.join(spec_dir, m['fast_file'])
        if not os.path.isfile(path):
            raise SpecError(f'mixed_layers {L}: no fast net file {path}')
        with open(path) as f:
            fast[L] = parse_fast(json.load(f), path)
    set_fast(s, fast)


def net_kind(net, m, s):
    """'fast', 'power' or 'slow' for a net on a mixed layer m. Every ground is power."""
    if any(fnmatch.fnmatchcase(net, q) for q in m['fast']):
        return 'fast'
    if net in s['grounds'] or any(fnmatch.fnmatchcase(net, q) for q in m['power']):
        return 'power'
    return 'slow'


def check_against_board(s, nets, layers):
    """Every layer and net the spec names must exist on the board (no stale exemption)."""
    want_layers = set(s['adjacent']) | set(s['adjacent'].values()) | set(s['plane_layers'])
    if want_layers - set(layers):
        raise SpecError(f'layers not on the board: {sorted(want_layers - set(layers))}')
    want_nets = set(s['grounds']) | set(s['alt_refs']) | set(s['exempt']['nets'])
    for ar in s['exempt']['areas']:
        want_nets |= set(ar['nets'])
    if want_nets - set(nets):
        raise SpecError(f'nets not on the board: {sorted(want_nets - set(nets))}')


def ref_domain(ref, s):
    """The domain of a reference net (a ground or an alt_ref), else None."""
    if ref in s['grounds']:
        return ref
    a = s['alt_refs'].get(ref)
    return a['domain'] if a else None


def net_domain(net, pad_refs, s):
    """Domain of a net: a spec pattern first, else the domain that holds most of its pads. A tie gives None."""
    for g, pats in s['domains'].items():
        if any(fnmatch.fnmatchcase(net, p) for p in pats):
            return g
    votes = collections.Counter(d for d in (ref_domain(r, s) for r in pad_refs) if d)
    top = votes.most_common(2)
    if not top or (len(top) == 2 and top[0][1] == top[1][1]):
        return None
    return top[0][0]


def _runs(bad, link):
    """Group bad samples (x, y, w) that touch (distance <= link). Return [(length, (cx, cy))]."""
    parent = list(range(len(bad)))

    def find(i):
        while parent[i] != i:
            parent[i] = parent[parent[i]]
            i = parent[i]
        return i
    grid = collections.defaultdict(list)
    for i, (x, y, _) in enumerate(bad):
        grid[(math.floor(x / link), math.floor(y / link))].append(i)
    for (gx, gy), ids in grid.items():
        for dx in (-1, 0, 1):
            for dy in (-1, 0, 1):
                for j in grid.get((gx + dx, gy + dy), ()):
                    for i in ids:
                        if i < j and math.dist(bad[i][:2], bad[j][:2]) <= link:
                            parent[find(i)] = find(j)
    groups = collections.defaultdict(list)
    for i in range(len(bad)):
        groups[find(i)].append(bad[i])
    out = []
    for g in groups.values():
        w = sum(p[2] for p in g)
        out.append((w, (sum(p[0] * p[2] for p in g) / w, sum(p[1] * p[2] for p in g) / w)))
    return out


def evaluate_net(samples, ref_at, domain, anchors, s, net=None):
    """Check the samples of one net on one outer layer.

    ref_at(x, y) gives the net of the filled zone under the point on the adjacent layer, or None.
    anchors are the net's own vias and pads (x, y, radius). A bad sample near an anchor, or in an
    exempt area of this net, does not count in the worst run or in the crossing length.
    """
    allow = s['via_allow_mm']
    areas = [a['box'] for a in s['exempt']['areas'] if net in a['nets']]
    length = unref = cross = 0.0
    bad, cross_nets = [], collections.Counter()
    for x, y, w in samples:
        length += w
        ref = ref_at(x, y)
        rd = ref_domain(ref, s)
        if domain is not None and rd == domain:
            continue
        unref += w
        if any(math.dist((x, y), a[:2]) <= a[2] + allow for a in anchors):
            continue
        if any(min(b[0], b[2]) <= x <= max(b[0], b[2]) and min(b[1], b[3]) <= y <= max(b[1], b[3]) for b in areas):
            continue
        bad.append((x, y, w))
        if domain is not None and rd is not None:
            cross += w
            cross_nets[ref] += w
    runs = _runs(bad, 1.2 * s['step_mm'])
    worst, at = max(runs, default=(0, None))
    return {'length': length, 'unref': unref, 'bad': sum(w for _, _, w in bad), 'worst': worst, 'worst_at': at, 'cross': cross,
            'cross_net': cross_nets.most_common(1)[0][0] if cross_nets else None}


def _checked(net, s):
    return net not in s['grounds'] and net not in s['exempt']['nets']


def _fast_over_mixed(layer, net, s):
    m = s['mixed_layers'].get(s['adjacent'].get(layer))
    return m is not None and net_kind(net, m, s) == 'fast'


def reference_failures(results, domains, s):
    """FAIL lines from evaluate_net results keyed (layer, net). domains: net -> domain or None.
    A fast net on the outer layer over a mixed layer may have no gap at all."""
    nodom, cross, gaps, seen = [], [], [], set()
    for (layer, net), r in results.items():
        if not _checked(net, s):
            continue
        if domains.get(net) is None:
            if net not in seen:
                seen.add(net)
                nodom.append(f'FAIL no-domain {net}: no pad in a ground zone outline; set "domains" or "exempt"')
            continue
        if r['cross'] > 0:
            cross.append((r['cross'], f"FAIL domain-cross {layer} {net}: {r['cross']:.1f} mm over "
                                      f"{r['cross_net']} (domain {domains[net]})"))
        slow = s['mixed_layers'] and not any(net_kind(net, m, s) == 'fast' for m in s['mixed_layers'].values())
        limit = s.get('slow_max_gap_mm', s['max_unreferenced_mm']) if slow else s['max_unreferenced_mm']
        if _fast_over_mixed(layer, net, s) and r['worst'] > 0:
            x, y = r['worst_at']
            gaps.append((r['worst'], f"FAIL fast-unreferenced {layer} {net}: gap {r['worst']:.2f} mm at ({x:.1f}, {y:.1f}) "
                                     f"over the mixed layer {s['adjacent'][layer]} (a fast net needs ground under every mm)"))
        elif slow and 'slow_min_coverage_pct' in s and r['length'] and \
                100 * (1 - r.get('bad', 0) / r['length']) < s['slow_min_coverage_pct']:
            gaps.append((r.get('bad', 0), f"FAIL unreferenced {layer} {net}: coverage "
                                          f"{100 * (1 - r.get('bad', 0) / r['length']):.0f}% < {s['slow_min_coverage_pct']}% "
                                          f"(slow net); worst gap {r['worst']:.1f} mm"))
        elif r['worst'] > limit:
            x, y = r['worst_at']
            pct = 100 * r['unref'] / r['length'] if r['length'] else 0
            gaps.append((r['worst'], f"FAIL unreferenced {layer} {net}: gap {r['worst']:.1f} mm at "
                                     f"({x:.1f}, {y:.1f}); total {r['unref']:.1f} mm, {pct:.0f}%"))
    return sorted(nodom) + [t for _, t in sorted(cross, reverse=True)] + [t for _, t in sorted(gaps, reverse=True)]


def plane_cut_failures(cuts, s):
    """FAIL lines for tracks on a plane layer. cuts: (layer, net) -> mm. No exemption applies.
    On a mixed layer only a fast or power net fails."""
    out = []
    for mm, layer, net in sorted(((mm, layer, net) for (layer, net), mm in cuts.items() if layer in s['plane_layers']),
                                 reverse=True):
        m = s['mixed_layers'].get(layer)
        if m is None:
            out.append(f'FAIL plane-cut {layer} {net}: {mm:.1f} mm of track')
        elif net_kind(net, m, s) != 'slow':
            out.append(f'FAIL plane-cut {layer} {net}: {mm:.1f} mm of track; a {net_kind(net, m, s)} net on the mixed layer')
    return out


def island_failures(pieces):
    """FAIL lines for ground fill pieces on a mixed layer with no via or through-hole pad of the ground.
    pieces: [(layer, ground, number of ground vias and pads in the piece, (x, y) of a point in the piece)]."""
    return [f'FAIL island {layer} {g}: fill piece at ({x:.1f}, {y:.1f}) has no {g} via or pad'
            for layer, g, n, (x, y) in pieces if n == 0]


def max_min_distance(points, vias):
    """The largest distance from a point to its nearest via. None when there is no via."""
    if not vias:
        return None
    return max((min(math.dist(p, v) for v in vias) for p in points), default=0.0)


# ---------------------------------------------------------------- side effects (pcbnew)
NOISE = ('Fontconfig warning:', 'create wxApp before calling this', 'Adding duplicate image handler')


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


def mm(v):
    return v / 1e6


def analyse(board_path, s, verbose):
    p = pcb()
    b = p.LoadBoard(board_path)
    if b is None:
        raise SpecError(f'cannot load {board_path}')
    layers = {b.GetLayerName(l): l for l in b.GetEnabledLayers().CuStack()}
    nets = {str(n) for n in b.GetNetsByName().keys() if str(n)}
    check_against_board(s, nets, layers)
    p.ZONE_FILLER(b).Fill(b.Zones())   # in memory only; the board is never saved
    zones = [z for z in b.Zones() if not z.GetIsRuleArea()]
    refs = set(s['grounds']) | set(s['alt_refs'])

    fills = collections.defaultdict(list)   # layer id -> [(net, SHAPE_POLY_SET)]
    for z in zones:
        for l in z.GetLayerSet().Seq():
            poly = z.GetFilledPolysList(l)
            poly.BuildBBoxCaches()
            fills[l].append((z.GetNetname(), poly))

    def ref_fn(lid):
        def ref_at(x, y):
            v = p.VECTOR2I(p.FromMM(x), p.FromMM(y))
            for net, poly in fills[lid]:
                if poly.Contains(v, -1, 0, True):
                    return net
            return None
        return ref_at

    outlines = [(z.GetNetname(), z.Outline()) for z in zones if z.GetNetname() in refs]
    pad_refs, anchors = collections.defaultdict(list), collections.defaultdict(list)
    gpads = collections.defaultdict(list)
    for pad in b.GetPads():
        net, c = pad.GetNetname(), pad.GetPosition()
        sz_ = pad.GetSize(p.F_Cu) if hasattr(pad, 'GetSize') else pad.GetSize()
        gpads[net].append((mm(c.x), mm(c.y), mm(max(sz_.x, sz_.y)) / 2, pad.GetAttribute() == p.PAD_ATTRIB_PTH))
        v = p.VECTOR2I(c.x, c.y)
        pad_refs[net].append(next((n for n, o in outlines if o.Contains(v)), None))
        sz = pad.GetSize(p.F_Cu) if hasattr(pad, 'GetSize') else pad.GetSize()
        anchors[net].append((mm(c.x), mm(c.y), mm(max(sz.x, sz.y)) / 2))

    samples, cuts = collections.defaultdict(list), collections.defaultdict(float)
    vias, via_r = collections.defaultdict(list), collections.defaultdict(list)
    for t in b.GetTracks():
        net, cls = t.GetNetname(), t.GetClass()
        if cls == 'PCB_VIA':
            pos = t.GetPosition()
            anchors[net].append((mm(pos.x), mm(pos.y), mm(t.GetWidth(p.F_Cu)) / 2))
            vias[net].append((mm(pos.x), mm(pos.y)))
            via_r[net].append((mm(pos.x), mm(pos.y), mm(t.GetWidth(p.F_Cu)) / 2))
            continue
        lname = b.GetLayerName(t.GetLayer())
        a, e = t.GetStart(), t.GetEnd()
        if cls == 'PCB_ARC':
            m = t.GetMid()
            pts = sample_arc((mm(a.x), mm(a.y)), (mm(m.x), mm(m.y)), (mm(e.x), mm(e.y)), s['step_mm'])
        else:
            pts = sample_segment((mm(a.x), mm(a.y)), (mm(e.x), mm(e.y)), s['step_mm'])
        if lname in s['adjacent']:
            samples[(lname, net)].extend(pts)
        else:
            cuts[(lname, net)] += sum(w for _, _, w in pts)

    domains = {net: net_domain(net, pad_refs[net], s) for _, net in samples}
    results = {}
    for (lname, net), pts in samples.items():
        if not _checked(net, s):
            continue
        results[(lname, net)] = evaluate_net(pts, ref_fn(layers[s['adjacent'][lname]]), domains[net],
                                             anchors[net], s, net=net)

    info = []
    outline = p.SHAPE_POLY_SET()
    b.GetBoardPolygonOutlines(outline, True)
    area = outline.Area() / 1e12
    for lname in s['plane_layers']:
        filled = sum(poly.Area() for _, poly in fills[layers[lname]]) / 1e12
        per = ', '.join(f'{n} {poly.Area() / 1e12 / area * 100:.0f}%' for n, poly in fills[layers[lname]])
        info.append(f'INFO plane {lname}: fill {100 * filled / area:.0f}% of board ({per})')
    bb = b.GetBoardEdgesBoundingBox()
    for g in s['grounds']:
        polys = [poly for l in fills for n, poly in fills[l] if n == g]
        pts = []
        for i in range(int(mm(bb.GetWidth())) + 1):
            for j in range(int(mm(bb.GetHeight())) + 1):
                x, y = mm(bb.GetX()) + i, mm(bb.GetY()) + j
                v = p.VECTOR2I(p.FromMM(x), p.FromMM(y))
                if any(poly.Contains(v, -1, 0, True) for poly in polys):
                    pts.append((x, y))
        far = max_min_distance(pts, vias[g])
        info.append(f"INFO stitch {g}: {len(vias[g])} vias, farthest pour point "
                    f"{'n/a (no via)' if far is None else f'{far:.1f} mm'} from a via")

    pieces = []
    for lname in s['mixed_layers']:
        for g in s['grounds']:
            pts = [(x, y, r) for x, y, r in via_r[g]] + [(x, y, r) for x, y, r, tht in gpads[g] if tht]
            for net, poly in fills[layers[lname]]:
                if net != g:
                    continue
                for k in range(poly.OutlineCount()):
                    one = p.SHAPE_POLY_SET(poly.Outline(k))
                    c = poly.Outline(k).CPoint(0)
                    # a via or pad touches the piece (a thermal pad centre sits outside the fill)
                    n = sum(1 for x, y, r in pts if one.Collide(p.VECTOR2I(p.FromMM(x), p.FromMM(y)), p.FromMM(r) + 1000))
                    pieces.append((lname, g, n, (mm(c.x), mm(c.y))))
        info.append(f'INFO mixed {lname}: {sum(1 for q in pieces if q[0] == lname)} ground fill pieces; '
                    f'tracks: ' + (', '.join(f'{n} {v:.1f} mm' for (L, n), v in sorted(cuts.items()) if L == lname) or 'none'))

    fails = plane_cut_failures(cuts, s) + island_failures(pieces) + reference_failures(results, domains, s)
    detail = []
    if verbose:
        for (lname, net), r in sorted(results.items(), key=lambda kv: -kv[1]['worst']):
            pct = 100 * r['unref'] / r['length'] if r['length'] else 0
            detail.append(f"  {lname} {net} [{domains[net]}]: {r['length']:.1f} mm, unref {r['unref']:.1f} mm "
                          f"({pct:.0f}%), worst {r['worst']:.1f} mm, cross {r['cross']:.1f} mm")
        for net, why in s['exempt']['nets'].items():
            detail.append(f'  exempt {net}: {why}')
    return fails, info, detail


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument('board')
    ap.add_argument('spec')
    ap.add_argument('--verbose', action='store_true')
    a = ap.parse_args(argv)
    try:
        if not os.path.isfile(a.board):
            raise SpecError(f'no board file: {a.board}')
        with open(a.spec) as f:
            s = load_spec(json.load(f))
        load_fast(s, os.path.dirname(os.path.abspath(a.spec)))
        fails, info, detail = analyse(a.board, s, a.verbose)
    except (SpecError, OSError, json.JSONDecodeError) as e:
        print(f'ERROR {e}')
        return 2
    except Exception as e:   # fail closed: an unexpected error is never a pass
        print(f'ERROR {type(e).__name__}: {e}')
        return 2
    for line in fails + info + detail:
        print(line)
    print(f'{len(fails)} reference-plane failures')
    return 1 if fails else 0


if __name__ == '__main__':
    from hard_exit import hard_exit
    hard_exit(main)
