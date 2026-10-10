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
                                                           ("slow_only": true: for slow nets only, not fast nets)
   "domains": {"ISO_0V": ["/AI*"]},                        optional: net patterns -> domain (else the
                                                           ground zone outline that holds most pads)
   "exempt": {"nets": {"VIN": "reason"},
              "areas": [{"box": [x0, y0, x1, y1], "nets": ["/A"], "reason": "..."}]},
   "fast_file": "rp001-fast-nets.json",   optional, for a stackup with no mixed layer: fast net patterns
   "power": ["VBUS", "/MAINS_*"],   optional: power and DC nets (no edge): no reference rule (D-124); the "power"
                                 lists of mixed_layers count too. A track on a plane layer still fails.
   "edge_classes": {"i2c": ["/SDA"], "rs485": ["/RS485_A"]},   optional: net patterns -> an interface class of
                                 tools/edge-rates.json (rise time with its source)
   "receivers": {"/ALMn": {"refs": ["U1"], "reason": "..."}},   optional: parts whose pin on that net is an input
                                 (firmware pin map or design), so not a driver (D-124 addendum)
   "offboard": {"/ENC_A*": {"class": "rs485", "reason": "..."}},   optional: a net driven only from off-board (a
                                 connector) gets the edge of this interface class of tools/edge-rates.json
   "schematic": "cad/X/X.kicad_sch",   optional, relative to the spec: the schematic for the driver lookup
                                 (default: the board file with .kicad_sch)
   "via_allow_mm": 0.6,          a run this near (plus the pad/via radius) the net's own via/pad is OK
   "step_mm": 0.25}              sample step along each track
Coordinates: KiCad mm, Y down.

Rules (D-124, hardware-design/reports/2026-10-09-design-rules-sources.md A1 and C3):
  fast net (fast_file / mixed_layers fast): no crossing of a gap, void, hole or slot in its reference, outside
      via_allow_mm at its own vias and pads ("Net crossing gap / hole or slot": HyperLynx DRC rule list,
      https://signalintegrityjournal.com/articles/577-design-rule-checks-for-high-speed-pcb-design [P]).
  power / DC net: no reference rule.
  other nets: each unreferenced run is a crossing; the return detour (the shortest path in the reference copper of
      the net's domain between the two crossing points, the whole path counted) must be <= tr[ns] x 10 nH/ns / 1.5 nH/mm
      = 6.7 mm per ns (tools/edge-rates.json). When that budget is larger than the board (outline bounding-box
      perimeter), the net has no reference rule. An unreachable reference fails.
      tr: an "edge_classes" interface class, else the net's actual driver (D-124 addendum 2026-10-09,
      tools/net_drivers.py: schematic netlist + tools/driver-edges.json, datasheet or IBIS tr/tf). There is no default:
      a net with a crossing whose driver or edge time is not known fails as "unknown driver" (a run with no detour,
      a stub, passes at any edge).
  every net except a ground: domain crossing (a track over the ground of another domain) fails.
"""
import argparse
import collections
import fnmatch
import json
import math
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
DEFAULTS = {'via_allow_mm': 0.6, 'step_mm': 0.25}
REQUIRED = ('about', 'adjacent', 'plane_layers', 'grounds')
# D-124 removed max_unreferenced_mm (1.0 mm), slow_max_gap_mm and slow_min_coverage_pct: no source (report A1).
KEYS = set(REQUIRED) | set(DEFAULTS) | {'alt_refs', 'domains', 'exempt', 'mixed_layers', 'fast_file', 'power', 'edge_classes',
                                         'receivers', 'offboard', 'schematic'}
EDGE_RATES_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'edge-rates.json')


def load_edge_rates(path=EDGE_RATES_FILE):
    """The classes of tools/edge-rates.json: {class: {tr_ns, source, assumption}}. A class needs tr_ns > 0 and a source."""
    with open(path) as f:
        raw = json.load(f)
    out = {}
    for k, v in raw['classes'].items():
        if not isinstance(v.get('tr_ns'), (int, float)) or v['tr_ns'] <= 0 or not str(v.get('source', '')).strip():
            raise SpecError(f'{path}: class {k} needs tr_ns > 0 and a source')
        out[k] = {'tr_ns': v['tr_ns'], 'source': v['source'], 'assumption': bool(v.get('assumption', False))}
    return out


def _edge_budget():
    with open(EDGE_RATES_FILE) as f:
        raw = json.load(f)
    if 'default_class' in raw:
        raise SpecError(f'{EDGE_RATES_FILE}: no default class (D-124 addendum: the edge comes from the net driver)')
    return raw['budget']['nh_per_ns'] / raw['budget']['nh_per_mm']


def detour_budget_mm(tr_ns):
    """Allowed return detour for a rise time: tr x 10 nH/ns / 1.5 nH/mm (tools/edge-rates.json, report C3)."""
    return tr_ns * _edge_budget()


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
    for k in DEFAULTS:
        if not isinstance(s[k], (int, float)) or s[k] <= 0:
            raise SpecError(f'{k} must be a number > 0')
    if not isinstance(s['adjacent'], dict) or not isinstance(s['plane_layers'], list) or not isinstance(s['grounds'], list):
        raise SpecError('adjacent must be an object; plane_layers and grounds must be lists')
    grounds = set(s['grounds'])
    s['alt_refs'] = s.get('alt_refs') or {}
    for net, a in s['alt_refs'].items():
        if not isinstance(a, dict) or a.get('domain') not in grounds:
            raise SpecError(f'alt_refs {net}: domain must be one of the grounds')
        if 'cap_mm' in a and (not isinstance(a['cap_mm'], (int, float)) or a['cap_mm'] <= 0):
            raise SpecError(f'alt_refs {net}: cap_mm must be a number > 0')
        if not isinstance(a.get('slow_only', False), bool):
            raise SpecError(f'alt_refs {net}: slow_only must be true or false')
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
    s['power'] = s.get('power') or []
    if not isinstance(s['power'], list) or not all(isinstance(q, str) for q in s['power']):
        raise SpecError('"power" must be a list of net patterns')
    s['edge_classes'] = s.get('edge_classes') or {}
    known = load_edge_rates()
    for k, pats in s['edge_classes'].items():
        if k not in known:
            raise SpecError(f'edge_classes {k}: not a class of {EDGE_RATES_FILE} ({sorted(known)})')
        if not isinstance(pats, list) or not all(isinstance(q, str) for q in pats):
            raise SpecError(f'edge_classes {k}: must be a list of net patterns')
    s['_edge_rates'] = known
    s['receivers'] = s.get('receivers') or {}
    for net, r in s['receivers'].items():
        if not isinstance(r, dict) or not isinstance(r.get('refs'), list) or not r['refs']:
            raise SpecError(f'receivers {net}: needs "refs" (a list of part references)')
        _reason(r.get('reason'), f'receivers {net}')
    s['offboard'] = s.get('offboard') or {}
    for net, o in s['offboard'].items():
        if not isinstance(o, dict) or o.get('class') not in known:
            raise SpecError(f'offboard {net}: "class" must be a class of {EDGE_RATES_FILE}')
        _reason(o.get('reason'), f'offboard {net}')
    s.setdefault('_edges', {})
    return s


def is_power(net, s):
    """A power or DC net (no reference rule): a ground, the top-level "power" or a mixed layer "power" pattern."""
    pats = list(s.get('power') or []) + [q for m in s['mixed_layers'].values() for q in m['power']]
    return net in s['grounds'] or any(fnmatch.fnmatchcase(net, q) for q in pats)


def is_fast(net, s):
    if any(fnmatch.fnmatchcase(net, q) for q in s.get('_fast_top') or []):
        return True
    return any(net_kind(net, m, s) == 'fast' for m in s['mixed_layers'].values() if 'fast' in m)


def edge_class(net, s):
    """The interface class of a net ("edge_classes"), else None: the edge then comes from the net's driver."""
    for k, pats in s['edge_classes'].items():
        if any(fnmatch.fnmatchcase(net, q) for q in pats):
            return k
    return None


def power_patterns(s):
    return list(s.get('power') or []) + [q for m in s['mixed_layers'].values() for q in m['power']]


def driver_edges(nets, nl, s, table=None, geom=None):
    """{net: {'edge_ns', 'driver'} or {'unknown': reason}} for the nets that need a driver edge (not power, not fast,
    no interface class). nl: a parsed schematic netlist (tools/net_drivers.py). geom: routed length and trace
    capacitance per net for the bound C*dV/I (D-124b, net_drivers.net_edge)."""
    import net_drivers
    table = net_drivers.load_table() if table is None else table
    out = {}
    for net in nets:
        if not _checked(net, s) or is_power(net, s) or is_fast(net, s) or edge_class(net, s):
            continue
        out[net] = net_drivers.net_edge(net, nl, table, s['receivers'], s['offboard'], s['_edge_rates'], power_patterns(s),
                                        geom)
    return out


def trace_geometry(board_path, s, routed, width):
    """D-124b: {'length_mm': {net: mm}, 'pf_per_mm': {net: (pF/mm, text)}}. The capacitance per mm is the microstrip
    C' = sqrt(Eeff) / (c0 x Z0) (Hammerstad-Jensen, tools/si_pairs.py) at the net's narrowest track over the outer
    layer dielectric of the stackup; the lower value of the outer layers is used (the inner stripline has more C),
    so the bound is the shorter one."""
    import net_drivers
    import si_pairs
    with open(board_path) as f:
        st = si_pairs.parse_stackup(f.read())
    outer = [(L, st[L]) for L in s['adjacent'] if L in st and st[L]['h_mm'] and st[L]['er']]
    if not outer:
        raise SpecError('board stackup: no dielectric height and Er for the outer layers (needed for the bound C*dV/I)')
    geom = {'length_mm': dict(routed), 'pf_per_mm': {}}
    for net, w in width.items():
        c, L, d = min((net_drivers.microstrip_pf_per_mm(w, d['h_mm'], d['t_mm'] or 0, d['er']), L, d) for L, d in outer)
        geom['pf_per_mm'][net] = (c, f"microstrip w {w:.3g} h {d['h_mm']:g} t {d['t_mm'] or 0:g} mm Er {d['er']:g} ({L} stackup), "
                                     f"C' = sqrt(Eeff)/(c0 Z0), Hammerstad-Jensen (tools/si_pairs.py)")
    return geom


def net_edge_of(net, s):
    """(tr_ns, label) of a checked net, or (None, reason) for an unknown driver."""
    k = edge_class(net, s)
    if k:
        r = s['_edge_rates'][k]
        return r['tr_ns'], f"class {k}, tr {r['tr_ns']:g} ns{', assumption' if r['assumption'] else ''}"
    e = s['_edges'].get(net)
    if e is None:
        return None, 'driver not looked up'
    if 'unknown' in e:
        return None, e['unknown']
    return e['edge_ns'], f"driver {e['driver']}"


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
    if isinstance(s.get('fast_file'), str) and s['fast_file']:
        path = os.path.join(spec_dir, s['fast_file'])
        if not os.path.isfile(path):
            raise SpecError(f'fast_file: no fast net file {path}')
        with open(path) as f:
            s['_fast_top'] = list(json.load(f).get('fast', []))


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


def ref_domain(ref, s, fast=False, xy=None, caps=None):
    """The domain of a reference net (a ground or an alt_ref), else None. A slow_only alt_ref is no reference for a fast net.
    An alt_ref with cap_mm is a reference only within cap_mm of a decoupling cap centre (caps: net -> [(x, y)])."""
    if ref in s['grounds']:
        return ref
    a = s['alt_refs'].get(ref)
    if not a or (fast and a.get('slow_only')):
        return None
    if 'cap_mm' in a and not any(math.dist(xy, c) <= a['cap_mm'] for c in (caps or {}).get(ref, [])):
        return None
    return a['domain']


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


def _groups(pts, link):
    """Group points (x, y, ...) that touch (distance <= link). Returns lists of indices."""
    parent = list(range(len(pts)))

    def find(i):
        while parent[i] != i:
            parent[i] = parent[parent[i]]
            i = parent[i]
        return i
    grid = collections.defaultdict(list)
    for i, q in enumerate(pts):
        grid[(math.floor(q[0] / link), math.floor(q[1] / link))].append(i)
    for (gx, gy), ids in grid.items():
        for dx in (-1, 0, 1):
            for dy in (-1, 0, 1):
                for j in grid.get((gx + dx, gy + dy), ()):
                    for i in ids:
                        if i < j and math.dist(pts[i][:2], pts[j][:2]) <= link:
                            parent[find(i)] = find(j)
    groups = collections.defaultdict(list)
    for i in range(len(pts)):
        groups[find(i)].append(i)
    return list(groups.values())


def evaluate_net(samples, ref_at, domain, anchors, s, net=None, caps=None):
    """Check the samples of one net on one outer layer.

    ref_at(x, y) gives the net of the filled zone under the point on the adjacent layer, or None.
    anchors are the net's own vias and pads (x, y, radius). A bad sample near an anchor, or in an
    exempt area of this net, does not count in the worst run or in the crossing length.
    Each run of bad samples gets its terminals: the good samples next to it (x, y, snap), where the return current
    leaves and joins the reference (snap: the search radius for reference copper; at an own via or pad it is the
    anchor radius + via_allow_mm).
    """
    allow = s['via_allow_mm']
    step = s['step_mm']
    areas = [a['box'] for a in s['exempt']['areas'] if net in a['nets']]
    length = unref = cross = 0.0
    bad, good, cross_nets = [], [], collections.Counter()
    fast = net is not None and is_fast(net, s)
    for x, y, w in samples:
        length += w
        ref = ref_at(x, y)
        rd = ref_domain(ref, s, fast, (x, y), caps)
        if domain is not None and rd == domain:
            good.append((x, y, step))
            continue
        unref += w
        near = [a for a in anchors if math.dist((x, y), a[:2]) <= a[2] + allow]
        if near:
            good.append((x, y, max(a[2] for a in near) + allow + step))
            continue
        if any(min(b[0], b[2]) <= x <= max(b[0], b[2]) and min(b[1], b[3]) <= y <= max(b[1], b[3]) for b in areas):
            continue
        bad.append((x, y, w))
        if domain is not None and rd is not None:
            cross += w
            cross_nets[ref] += w
    link = 1.2 * step
    runs = []
    gidx = collections.defaultdict(list)
    for i, q in enumerate(good):
        gidx[(math.floor(q[0] / link), math.floor(q[1] / link))].append(i)
    for g in _groups(bad, link):
        w = sum(bad[i][2] for i in g)
        at = (sum(bad[i][0] * bad[i][2] for i in g) / w, sum(bad[i][1] * bad[i][2] for i in g) / w)
        term = set()
        for i in g:
            bx, by = bad[i][:2]
            cx, cy = math.floor(bx / link), math.floor(by / link)
            for dx in (-1, 0, 1):
                for dy in (-1, 0, 1):
                    for j in gidx.get((cx + dx, cy + dy), ()):
                        if math.dist((bx, by), good[j][:2]) <= link:
                            term.add(j)
        # one terminal per side: join terminals that touch each other
        tl = [good[j] for j in sorted(term)]
        ends = [max((tl[k] for k in grp), key=lambda q: q[2]) for grp in _groups(tl, link)] if tl else []
        runs.append({'length': w, 'at': at, 'terminals': ends})
    worst = max(runs, key=lambda r: r['length'], default=None)
    return {'length': length, 'unref': unref, 'bad': sum(w for _, _, w in bad), 'worst': worst['length'] if worst else 0,
            'worst_at': worst['at'] if worst else None, 'cross': cross, 'runs': runs,
            'cross_net': cross_nets.most_common(1)[0][0] if cross_nets else None}


def detour_mm(ok, terminals, budget, cell, portals=()):
    """Return detour of one run: the shortest path in the reference copper from the first terminal to the farthest
    other terminal, on a grid of this cell size (8 neighbours, a diagonal step only between two free sides).
    portals: (x, y) of the ground vias and through-hole pads of the domain ground. The return current may go down one
    and up another; the path between them is counted as the straight line (the other ground plane, In1, is solid by
    the stackup rule; a track on it fails as plane-cut).
    ok(x, y) -> True on reference copper. terminals: [(x, y, snap)]; a terminal is reached at any copper cell within
    snap of it. Returns the length in mm, or None when it is longer than budget or there is no copper path.
    Fewer than two terminals: a stub, no crossing: 0."""
    import heapq
    if len(terminals) < 2:
        return 0.0
    cache = {}

    def free(c):
        if c not in cache:
            cache[c] = bool(ok(c[0] * cell, c[1] * cell))
        return cache[c]

    def cells(t):
        r = max(t[2], cell)
        n = math.ceil(r / cell)
        cx, cy = round(t[0] / cell), round(t[1] / cell)
        return {(cx + i, cy + j) for i in range(-n, n + 1) for j in range(-n, n + 1)
                if math.dist(((cx + i) * cell, (cy + j) * cell), t[:2]) <= r + 1e-9 and free((cx + i, cy + j))}
    src = cells(terminals[0])
    if not src:
        return None
    ports = [(round(x / cell), round(y / cell)) for x, y in portals]
    ports = [q for q in ports if free(q) or any(free((q[0] + i, q[1] + j)) for i in (-1, 0, 1) for j in (-1, 0, 1))]
    at_port = collections.defaultdict(list)
    for k, q in enumerate(ports):
        for i in (-1, 0, 1):
            for j in (-1, 0, 1):
                at_port[(q[0] + i, q[1] + j)].append(k)
    worst = 0.0
    for t in terminals[1:]:
        dst = cells(t)
        if not dst:
            return None
        if src & dst:
            continue
        tx, ty, tr = t[0] / cell, t[1] / cell, max(t[2], cell) / cell
        h = lambda c: max(0.0, math.hypot(c[0] - tx, c[1] - ty) - tr - 1)
        dist = {c: 0.0 for c in src}
        heap = [(h(c), 0.0, c) for c in src]
        heapq.heapify(heap)
        found = None
        while heap:
            f, d, c = heapq.heappop(heap)
            if d > dist.get(c, math.inf) + 1e-12:
                continue
            if c in dst:
                found = d
                break
            if f * cell > budget + 1e-9:
                break
            for dx in (-1, 0, 1):
                for dy in (-1, 0, 1):
                    if not (dx or dy):
                        continue
                    n = (c[0] + dx, c[1] + dy)
                    if not free(n) or (dx and dy and not (free((c[0] + dx, c[1])) and free((c[0], c[1] + dy)))):
                        continue
                    nd = d + (1.4142135623730951 if dx and dy else 1.0)
                    if nd < dist.get(n, math.inf) - 1e-12:
                        dist[n] = nd
                        heapq.heappush(heap, (nd + h(n), nd, n))
            for k in at_port.get(c, ()):   # down a ground via, along the solid plane, up another
                for q in ports:
                    for n in ((q[0] + i, q[1] + j) for i in (-1, 0, 1) for j in (-1, 0, 1)):
                        if free(n):
                            nd = d + math.dist(c, n)
                            if nd < dist.get(n, math.inf) - 1e-12 and nd * cell <= budget + 1e-9:
                                dist[n] = nd
                                heapq.heappush(heap, (nd + h(n), nd, n))
        if found is None or found * cell > budget + 1e-9:
            return None
        worst = max(worst, found * cell)
    return worst


def _checked(net, s):
    return net not in s['grounds'] and net not in s['exempt']['nets']


def reference_failures(results, domains, s, detour=None, board_mm=None):
    """FAIL lines from evaluate_net results keyed (layer, net). domains: net -> domain or None.
    detour(layer, domain, run, budget) -> mm or None (over budget / unreachable); board_mm: the size above which a
    budget gives no rule (the board outline bounding-box perimeter). Rules: see the module text (D-124)."""
    nodom, cross, gaps, seen = [], [], [], set()
    for (layer, net), r in results.items():
        if not _checked(net, s):
            continue
        power = is_power(net, s)
        if domains.get(net) is None:
            if net not in seen and not power:
                seen.add(net)
                nodom.append(f'FAIL no-domain {net}: no pad in a ground zone outline; set "domains" or "exempt"')
            continue
        if r['cross'] > 0:
            cross.append((r['cross'], f"FAIL domain-cross {layer} {net}: {r['cross']:.1f} mm over "
                                      f"{r['cross_net']} (domain {domains[net]})"))
        if power:
            continue
        if is_fast(net, s):
            if r['worst'] > 0:
                x, y = r['worst_at']
                gaps.append((r['worst'], f"FAIL fast-crossing {layer} {net}: {len(r.get('runs') or [1])} crossings, longest "
                                         f"{r['worst']:.2f} mm at ({x:.1f}, {y:.1f}) (a fast net may cross no gap, void or slot)"))
            continue
        tr, label = net_edge_of(net, s)
        runs = r.get('runs') or []

        def measure(run):
            """The detour length of a run (a fine grid first, then up to the board size), None when unreachable."""
            if not detour:
                return None
            for b in (20.0, board_mm if board_mm is not None else math.inf):
                d = detour(layer, domains[net], run, b)
                if d is not None:
                    return d
            return None
        if tr is None:
            # no edge time: only a run with no detour at all (a stub) passes
            lens = [measure(run) for run in runs]
            bad = [(run, d) for run, d in zip(runs, lens) if d is None or d > 0]
            if bad:
                w, d = max(bad, key=lambda q: q[0]['length'])
                x, y = w['at']
                gaps.append((w['length'], f"FAIL unknown-driver {layer} {net}: {len(bad)} of {len(runs)} crossings need an edge time "
                                          f"(longest run {w['length']:.1f} mm at ({x:.1f}, {y:.1f}), detour "
                                          f"{'none (no reference path)' if d is None else f'{d:.1f} mm'}); unknown driver: {label}"))
            continue
        budget = detour_budget_mm(tr)
        if board_mm is not None and budget > board_mm:
            continue
        over = [run for run in runs if (detour(layer, domains[net], run, budget) if detour else None) is None]
        if over:
            w = max(over, key=lambda q: q['length'])
            x, y = w['at']
            d = measure(w)
            gaps.append((w['length'], f"FAIL detour {layer} {net}: {len(over)} of {len(runs)} crossings with a return detour "
                                      f"> {budget:.1f} mm or no reference path, longest run {w['length']:.1f} mm at ({x:.1f}, {y:.1f}), "
                                      f"detour {'none (no reference path)' if d is None else f'{d:.1f} mm'} "
                                      f"(tr {tr:g} ns: {label})"))
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


def ground_pieces(p, polys):
    """The copper pieces of one ground on one layer. Fills of two zones of the same net that touch are one piece."""
    u = p.SHAPE_POLY_SET()
    for poly in polys:
        u.BooleanAdd(poly)
    return [p.SHAPE_LINE_CHAIN(u.Outline(k)) for k in range(u.OutlineCount())]


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


def analyse(board_path, s, verbose, sch_path=None):
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
    routed, width = collections.defaultdict(float), {}   # D-124b: routed length (all layers) and narrowest track
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
        routed[net] += sum(w for _, _, w in pts)
        width[net] = min(width.get(net, math.inf), mm(t.GetWidth()))
        if lname in s['adjacent']:
            samples[(lname, net)].extend(pts)
        else:
            cuts[(lname, net)] += sum(w for _, _, w in pts)

    caps = collections.defaultdict(list)   # alt_ref net -> centres of its decoupling caps (a C part from it to a ground)
    for fp in b.GetFootprints():
        fn = {pd.GetNetname() for pd in fp.Pads()}
        if fp.GetReference().startswith('C') and fn & set(s['grounds']):
            for n in fn & set(s['alt_refs']):
                caps[n].append((mm(fp.GetPosition().x), mm(fp.GetPosition().y)))
    domains = {net: net_domain(net, pad_refs[net], s) for _, net in samples}
    results = {}
    for (lname, net), pts in samples.items():
        if not _checked(net, s):
            continue
        results[(lname, net)] = evaluate_net(pts, ref_fn(layers[s['adjacent'][lname]]), domains[net],
                                             anchors[net], s, net=net, caps=caps)

    import net_drivers
    nl = net_drivers.export_netlist(sch_path or os.path.splitext(board_path)[0] + '.kicad_sch')
    s['_edges'] = driver_edges(sorted({net for _, net in results}), nl, s,
                               geom=trace_geometry(board_path, s, routed, width))

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
            for outline in ground_pieces(p, [poly for net, poly in fills[layers[lname]] if net == g]):
                one = p.SHAPE_POLY_SET(outline)
                c = outline.CPoint(0)
                # a via or pad touches the piece (a thermal pad centre sits outside the fill)
                n = sum(1 for x, y, r in pts if one.Collide(p.VECTOR2I(p.FromMM(x), p.FromMM(y)), p.FromMM(r) + 1000))
                pieces.append((lname, g, n, (mm(c.x), mm(c.y))))
        info.append(f'INFO mixed {lname}: {sum(1 for q in pieces if q[0] == lname)} ground fill pieces; '
                    f'tracks: ' + (', '.join(f'{n} {v:.1f} mm' for (L, n), v in sorted(cuts.items()) if L == lname) or 'none'))

    bb_w, bb_h = mm(bb.GetWidth()), mm(bb.GetHeight())
    board_mm = 2 * (bb_w + bb_h)

    def detour(lname, domain, run, budget):
        ref_at = ref_fn(layers[s['adjacent'][lname]])
        ok = lambda x, y: ref_domain(ref_at(x, y), s, False, (x, y), caps) == domain
        # grid cell: 0.1 mm, coarser for a long budget (at most 200 cells per budget; a coarser grid only makes
        # the path longer, so it never hides a failure)
        ports = [(x, y) for x, y, _ in via_r[domain]] + [(x, y) for x, y, _, tht in gpads[domain] if tht]
        return detour_mm(ok, run['terminals'], budget, min(0.5, max(0.1, budget / 200)), ports)

    fails = plane_cut_failures(cuts, s) + island_failures(pieces) + reference_failures(results, domains, s, detour, board_mm)
    info.append(f'INFO detour budget: no rule above {board_mm:.0f} mm (board bounding-box perimeter); '
                + ', '.join(f"{k} {v['tr_ns']:g} ns -> {detour_budget_mm(v['tr_ns']):.1f} mm" + (' (assumption)' if v['assumption'] else '')
                            for k, v in s['_edge_rates'].items()) + '; other nets: the edge of their driver (tools/driver-edges.json)')
    unknown = sorted(n for n, e in s['_edges'].items() if 'unknown' in e)
    info.append(f"INFO drivers: {len(s['_edges']) - len(unknown)} nets with a driver edge, {len(unknown)} unknown "
                f"(a failure only with a crossing)")
    detail = []
    if verbose:
        for (lname, net), r in sorted(results.items(), key=lambda kv: -kv[1]['worst']):
            pct = 100 * r['unref'] / r['length'] if r['length'] else 0
            kind = 'power' if is_power(net, s) else 'fast' if is_fast(net, s) else (
                edge_class(net, s) or ('unknown driver' if net_edge_of(net, s)[0] is None else f'{net_edge_of(net, s)[0]:g} ns'))
            detail.append(f"  {lname} {net} [{domains[net]}, {kind}]: {r['length']:.1f} mm, unref {r['unref']:.1f} mm "
                          f"({pct:.0f}%), worst {r['worst']:.1f} mm, {len(r['runs'])} runs, cross {r['cross']:.1f} mm")
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
        spec_dir = os.path.dirname(os.path.abspath(a.spec))
        load_fast(s, spec_dir)
        sch = os.path.join(spec_dir, s['schematic']) if s.get('schematic') else None
        fails, info, detail = analyse(a.board, s, a.verbose, sch)
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
