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
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
DEFAULTS = {'via_allow_mm': 0.6, 'step_mm': 0.25}
REQUIRED = ('about', 'adjacent', 'plane_layers', 'grounds')
# D-124 removed max_unreferenced_mm (1.0 mm), slow_max_gap_mm and slow_min_coverage_pct: no source (report A1).
KEYS = set(REQUIRED) | set(DEFAULTS) | {'alt_refs', 'domains', 'exempt', 'mixed_layers', 'fast_file', 'power', 'edge_classes',
                                         'receivers', 'offboard', 'schematic'}
EDGE_RATES_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'edge-rates.json')


def _positive_finite(v):
    return isinstance(v, (int, float)) and not isinstance(v, bool) and math.isfinite(v) and v > 0


def load_edge_rates(path=EDGE_RATES_FILE):
    """The classes of tools/edge-rates.json: {class: {tr_ns, source, assumption}}. A class needs tr_ns > 0 and a source."""
    with open(path) as f:
        raw = json.load(f)
    import net_drivers
    net_drivers.verify_evidence(raw)
    out = {}
    for k, v in raw['classes'].items():
        if not _positive_finite(v.get('tr_ns')) or not str(v.get('source', '')).strip():
            raise SpecError(f'{path}: class {k} needs tr_ns > 0 and a source')
        a = v.get('applicability')
        if not isinstance(a, dict) or a.get('kind') not in ('part', 'protocol') or not str(a.get('reason', '')).strip():
            raise SpecError(f'{path}: class {k} needs explicit part/protocol applicability and reason')
        if a['kind'] == 'part':
            if not isinstance(a.get('mpn'), list) or not a['mpn'] or not all(isinstance(q, str) and q for q in a['mpn']) or not isinstance(a.get('pins'), str) or not a['pins']:
                raise SpecError(f'{path}: part class {k} needs MPN patterns and pin regex')
            re.compile(a['pins'])
        out[k] = {'tr_ns': v['tr_ns'], 'source': v['source'], 'assumption': bool(v.get('assumption', False)), 'applicability': a,
                  'stat':v.get('stat','unspecified'),'load':v.get('load','not recorded')}
    return out


def _edge_budget():
    with open(EDGE_RATES_FILE) as f:
        raw = json.load(f)
    if 'default_class' in raw:
        raise SpecError(f'{EDGE_RATES_FILE}: no default class (D-124 addendum: the edge comes from the net driver)')
    budget = raw.get('budget', {})
    if not all(_positive_finite(budget.get(k)) for k in ('nh_per_ns', 'nh_per_mm')):
        raise SpecError(f'{EDGE_RATES_FILE}: budget coefficients must be finite numbers > 0')
    ratio = budget['nh_per_ns'] / budget['nh_per_mm']
    if not _positive_finite(ratio):
        raise SpecError(f'{EDGE_RATES_FILE}: invalid budget ratio')
    return ratio


def detour_budget_mm(tr_ns):
    """Allowed return detour for a rise time: tr x 10 nH/ns / 1.5 nH/mm (tools/edge-rates.json, report C3)."""
    if not _positive_finite(tr_ns):
        raise SpecError('edge time must be a finite number > 0')
    budget = tr_ns * _edge_budget()
    if not _positive_finite(budget):
        raise SpecError('non-finite detour budget')
    return budget


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


def partition_signal_path(path, boundaries, circles, step):
    """Exact boundary partition of a native straight segment or circular arc.

    Classification is constant on each open interval: polygon, anchor,
    exemption and cap boundaries are all supplied. Step only subdivides those
    already bounded intervals for diagnostics; it never establishes coverage.
    Returns (start, midpoint, end, length) records in native path order.
    """
    a, e = path[0], path[-1]
    arc = None
    if len(path) == 3:
        (ax, ay), (bx, by), (cx, cy) = path
        den = 2 * (ax * (by - cy) + bx * (cy - ay) + cx * (ay - by))
        if abs(den) > 1e-12:
            ux = ((ax*ax+ay*ay)*(by-cy)+(bx*bx+by*by)*(cy-ay)+(cx*cx+cy*cy)*(ay-by))/den
            uy = ((ax*ax+ay*ay)*(cx-bx)+(bx*bx+by*by)*(ax-cx)+(cx*cx+cy*cy)*(bx-ax))/den
            radius = math.dist((ux, uy), a)
            angles = [math.atan2(q[1]-uy, q[0]-ux) for q in path]
            sweep = (angles[2]-angles[0]) % (2*math.pi)
            if (angles[1]-angles[0]) % (2*math.pi) > sweep:
                sweep -= 2*math.pi
            arc = (ux, uy, radius, angles[0], sweep)
    if arc is None:
        length = math.dist(a, e)
        cuts = reference_breaks(boundaries, a, e, circles)
        point = lambda t: (a[0]+t*(e[0]-a[0]), a[1]+t*(e[1]-a[1]))
    else:
        ux, uy, radius, angle, sweep = arc
        length = radius * abs(sweep)
        point = lambda t: (ux+radius*math.cos(angle+t*sweep), uy+radius*math.sin(angle+t*sweep))
        cuts = {0.0, 1.0}

        def add(q):
            theta = math.atan2(q[1]-uy, q[0]-ux)
            delta = (theta-angle) % (2*math.pi) if sweep > 0 else -((angle-theta) % (2*math.pi))
            t = delta / sweep
            if -1e-12 <= t <= 1+1e-12:
                cuts.add(min(1.0, max(0.0, t)))

        for c, d in boundaries:
            dx, dy = d[0]-c[0], d[1]-c[1]
            qx, qy = c[0]-ux, c[1]-uy
            norm = dx*dx+dy*dy
            if not norm:
                continue
            linear = 2*(qx*dx+qy*dy)
            disc = linear*linear-4*norm*(qx*qx+qy*qy-radius*radius)
            if disc >= 0:
                for u in ((-linear-math.sqrt(disc))/(2*norm), (-linear+math.sqrt(disc))/(2*norm)):
                    if 0 <= u <= 1:
                        add((c[0]+u*dx, c[1]+u*dy))
        for (cx, cy), r in circles:
            dist = math.dist((ux, uy), (cx, cy))
            if not dist or dist > radius+r or dist < abs(radius-r):
                continue
            along = (radius*radius-r*r+dist*dist)/(2*dist)
            height = math.sqrt(max(0.0, radius*radius-along*along))
            vx, vy = (cx-ux)/dist, (cy-uy)/dist
            for sign in (-1, 1):
                add((ux+along*vx-sign*height*vy, uy+along*vy+sign*height*vx))
        cuts = sorted(cuts)
    if not length:
        return []
    records = []
    for lo, hi in zip(cuts, cuts[1:]):
        n = max(1, math.ceil(length*(hi-lo)/step))
        for i in range(n):
            u, v = lo+(hi-lo)*i/n, lo+(hi-lo)*(i+1)/n
            if v > u:
                records.append((point(u), point((u+v)/2), point(v), length*(v-u)))
    return records


def evaluate_paths(paths, boundaries, ref_at, domain, anchors, s, net, caps=None):
    """Project whole native paths, preserving distinct sides of narrow voids.

    Bad intervals join only at actual path endpoints. Close opposite sides of
    a gap do not collapse into one terminal merely because the step is large.
    """
    circles = [(a[:2], a[2]+s['via_allow_mm']) for a in anchors]
    for ref, cfg in s['alt_refs'].items():
        if 'cap_mm' in cfg:
            circles.extend((c, cfg['cap_mm']) for c in (caps or {}).get(ref, []))
    edges = list(boundaries)
    areas = [a['box'] for a in s['exempt']['areas'] if net in a['nets']]
    for x0, y0, x1, y1 in areas:
        ring = [(x0,y0),(x1,y0),(x1,y1),(x0,y1)]
        edges.extend(zip(ring, ring[1:]+ring[:1]))
    # Partition at same-net/layer native centreline junctions, independently
    # of diagnostic step. A branch endpoint may lie inside an unsplit track.
    # Full supporting circles may add harmless cuts outside an arc's sweep;
    # joining still requires an actual interval endpoint on BOTH native paths.
    # Zero-radius endpoint circles also split overlapping/coincident arcs.
    for path in paths:
        if len(path) == 2:
            edges.append((path[0],path[-1]))
        else:
            (ax,ay),(bx,by),(cx,cy) = path
            den = 2*(ax*(by-cy)+bx*(cy-ay)+cx*(ay-by))
            if abs(den) <= 1e-12:
                edges.append((path[0],path[-1]))
            else:
                ux = ((ax*ax+ay*ay)*(by-cy)+(bx*bx+by*by)*(cy-ay)+(cx*cx+cy*cy)*(ay-by))/den
                uy = ((ax*ax+ay*ay)*(cx-bx)+(bx*bx+by*by)*(ax-cx)+(cx*cx+cy*cy)*(bx-ax))/den
                circles.append(((ux,uy),math.dist((ux,uy),path[0])))
        circles.extend((endpoint,0.0) for endpoint in (path[0],path[-1]))
    length = unref = cross = 0.0
    cross_nets = collections.Counter()
    bad, terminals = [], collections.defaultdict(list)
    # KiCad's native coordinate unit is one nanometre. This key is only for
    # native endpoint identity, not an enlargement of reference copper.
    key = lambda q: (round(q[0]*1e6), round(q[1]*1e6))
    for path in paths:
        states = []
        for start, q, end, weight in partition_signal_path(path, edges, circles, s['step_mm']):
            length += weight
            ref = ref_at(*q)
            rd = ref_domain(ref, s, is_fast(net, s), q, caps)
            good = domain is not None and rd == domain
            if not good:
                unref += weight
            near = [a for a in anchors if math.dist(q,a[:2]) <= a[2]+s['via_allow_mm']]
            exempt = any(min(b[0],b[2]) <= q[0] <= max(b[0],b[2]) and min(b[1],b[3]) <= q[1] <= max(b[1],b[3]) for b in areas)
            state = 'good' if good or near else 'exempt' if exempt else 'bad'
            radius = s['step_mm'] if good else max((a[2]+s['via_allow_mm']+s['step_mm'] for a in near),default=0)
            states.append((start,q,end,weight,state,radius))
            if state == 'bad' and domain is not None and rd is not None:
                cross += weight
                cross_nets[ref] += weight
        for i, row in enumerate(states):
            start, q, end, weight, state, radius = row
            if state == 'bad':
                bad.append((start,q,end,weight))
            elif state == 'good':
                if i and states[i-1][4] == 'bad':
                    terminals[key(start)].append((*q,radius))
                if i+1 < len(states) and states[i+1][4] == 'bad':
                    terminals[key(end)].append((*q,radius))
                # Reference at a track junction also attaches a bad interval
                # on another segment; only native shared endpoints are joined.
                if i == 0:
                    terminals[key(start)].append((*q,radius))
                if i == len(states)-1:
                    terminals[key(end)].append((*q,radius))
    parent = list(range(len(bad)))
    def find(i):
        while parent[i] != i:
            parent[i] = parent[parent[i]]
            i = parent[i]
        return i
    touching = {}
    for i, (start,q,end,w) in enumerate(bad):
        for endpt in (start,end):
            k = key(endpt)
            if k in touching:
                parent[find(i)] = find(touching[k])
            else:
                touching[k] = i
    groups = collections.defaultdict(list)
    for i in range(len(bad)):
        groups[find(i)].append(i)
    runs = []
    for ids in groups.values():
        weight = sum(bad[i][3] for i in ids)
        at = tuple(sum(bad[i][1][j]*bad[i][3] for i in ids)/weight for j in (0,1))
        terms = {t for i in ids for q in (bad[i][0],bad[i][2]) for t in terminals[key(q)]}
        runs.append(dict(length=weight,at=at,terminals=sorted(terms),bad_points=[bad[i][1] for i in ids],net=net))
    worst = max(runs,key=lambda r:r['length'],default=None)
    return dict(length=length,unref=unref,bad=sum(r['length'] for r in runs),worst=worst['length'] if worst else 0,
                worst_at=worst['at'] if worst else None,cross=cross,runs=runs,
                cross_net=cross_nets.most_common(1)[0][0] if cross_nets else None)


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
        if not _positive_finite(s[k]):
            raise SpecError(f'{k} must be a number > 0')
    if not isinstance(s['adjacent'], dict) or not isinstance(s['plane_layers'], list) or not isinstance(s['grounds'], list):
        raise SpecError('adjacent must be an object; plane_layers and grounds must be lists')
    grounds = set(s['grounds'])
    s['alt_refs'] = s.get('alt_refs') or {}
    for net, a in s['alt_refs'].items():
        if not isinstance(a, dict) or a.get('domain') not in grounds:
            raise SpecError(f'alt_refs {net}: domain must be one of the grounds')
        if 'cap_mm' in a and not _positive_finite(a['cap_mm']):
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
    no interface class). nl: a parsed schematic netlist (tools/net_drivers.py)."""
    import net_drivers
    table = net_drivers.load_table() if table is None else table
    out = {}
    for net in nets:
        if not _checked(net, s) or is_power(net, s) or is_fast(net, s):
            continue
        out[net] = net_drivers.net_edge(net, nl, table, s['receivers'], s['offboard'], s['_edge_rates'], power_patterns(s), interface=edge_class(net, s), geom=geom)
    return out


def routed_trace_summary(records):
    """Physical line-union lengths for capacitance SCREENING, not a bound.

    Native coordinates are integral nm. Union collinear segments within each
    net/layer so duplicated, reversed or split-overlap CAD tracks cannot inflate
    the modeled load. Exact reversed arcs are deduplicated; partial arc overlap,
    copper width intersections, pads/vias/pours and distributed loads remain
    unmodeled. Those limits prohibit fastest-edge qualification.
    records: (net, layer, path in mm, width in mm).
    """
    lines, arcs, widths = collections.defaultdict(list), {}, {}
    for net, layer, path, width in records:
        if not math.isfinite(width) or width <= 0:
            raise SpecError('trace geometry: invalid native width')
        if not all(math.isfinite(v) for point in path for v in point):
            raise SpecError('trace geometry: invalid native coordinate')
        pts = tuple(tuple(round(v * 1e6) for v in point) for point in path)
        if len(pts) not in (2, 3):
            raise SpecError('trace geometry: invalid native path')
        widths[net] = min(widths.get(net, math.inf), width)
        a, e = pts[0], pts[-1]
        if len(pts) == 3 and (pts[1][0]-a[0])*(e[1]-a[1]) != (pts[1][1]-a[1])*(e[0]-a[0]):
            key = (net, layer, min(pts, pts[::-1]))
            arcs[key] = sum(w for _, _, w in sample_arc(*path, 1e9))
            continue
        dx, dy = e[0]-a[0], e[1]-a[1]
        divisor = math.gcd(dx, dy)
        if not divisor:
            continue
        ux, uy = dx//divisor, dy//divisor
        if ux < 0 or (ux == 0 and uy < 0):ux, uy = -ux, -uy
        offset = a[0]*uy-a[1]*ux
        start, end = sorted((a[0]*ux+a[1]*uy, e[0]*ux+e[1]*uy))
        lines[(net, layer, ux, uy, offset)].append((start, end))
    length = collections.defaultdict(float)
    for (net, _, ux, uy, _), intervals in lines.items():
        total, start, end = 0, None, None
        for left, right in sorted(intervals):
            if start is None:start, end = left, right
            elif left <= end:end = max(end, right)
            else:total += end-start;start, end = left, right
        total += end-start
        length[net] += total / math.hypot(ux, uy) / 1e6
    for (net, _, _), arc_length in arcs.items():length[net] += arc_length
    return dict(length), widths


def trace_geometry(board_path, s, records):
    """D-124b routed-load inputs, explicitly an unqualified screening model.

    C'=sqrt(Eeff)/(c0*Z0) is the existing Hammerstad-Jensen outer-microstrip
    model. Use minimum width and the lower available outer-layer value; no
    claim that this proves actual inner/voided/distributed-load capacitance.
    Missing stackup leaves C*dV/I unresolved without discarding known IBIS
    or independently sourced driver values.
    """
    import net_drivers
    import si_pairs
    length, width = routed_trace_summary(records)
    result = {'length_mm': length, 'pf_per_mm': {},
              'model_applicability': {'qualified_fastest_bound': False,
                'reasons': ['outer microstrip approximation; actual return gaps/inner geometry unproved',
                            'distributed full-net load is not a proved load at the driver edge',
                            'partial arc overlap, pad/via/pour capacitance and physical intersection areas unmodeled']}}
    try:
        with open(board_path) as stream:stackup = si_pairs.parse_stackup(stream.read())
        outer = [(layer, stackup[layer]) for layer in ('F.Cu', 'B.Cu') if layer in s['adjacent'] and layer in stackup]
        outer = [(layer, d) for layer, d in outer if all(isinstance(d[k], (int, float)) and math.isfinite(d[k]) and d[k] > 0 for k in ('h_mm', 'er')) and (d['t_mm'] is None or math.isfinite(d['t_mm']) and d['t_mm'] >= 0)]
        if not outer:raise si_pairs.SpecError('no usable outer-layer dielectric height/Er')
        for net, w in width.items():
            value, layer, d = min((net_drivers.microstrip_pf_per_mm(w, d['h_mm'], d['t_mm'] or 0, d['er']), layer, d) for layer, d in outer)
            if not math.isfinite(value) or value <= 0:raise SpecError('trace geometry: invalid modeled capacitance')
            result['pf_per_mm'][net] = (value, f"screening microstrip w {w:g} h {d['h_mm']:g} t {d['t_mm'] or 0:g} mm Er {d['er']:g} ({layer}); Hammerstad-Jensen tools/si_pairs.py; applicability unproved")
    except (OSError, si_pairs.SpecError) as error:
        result['model_applicability']['reasons'].append('missing stackup/model input: '+str(error))
    return result


def net_edge_of(net, s):
    """(tr_ns, label) of a checked net, or (None, reason) for an unknown driver."""
    k = edge_class(net, s)
    if k and net not in s['_edges'] and s['_edge_rates'][k]['applicability']['kind'] == 'protocol':
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
        runs.append({'length': w, 'at': at, 'terminals': ends,
                     'bad_points': [bad[i][:2] for i in g], 'net': net})
    worst = max(runs, key=lambda r: r['length'], default=None)
    return {'length': length, 'unref': unref, 'bad': sum(w for _, _, w in bad), 'worst': worst['length'] if worst else 0,
            'worst_at': worst['at'] if worst else None, 'cross': cross, 'runs': runs,
            'cross_net': cross_nets.most_common(1)[0][0] if cross_nets else None}


class SpatialCandidates:
    """Immutable AABB tree; query results retain the original predicate order.

    Bounds are inclusive. Native polygon membership queries use the rounded
    integer PCB coordinate, not the unrounded millimetre coordinate.
    """
    def __init__(self, values, boxes):
        self.values = tuple(values)
        boxes = tuple(boxes)
        def build(ids):
            if not ids:
                return None
            box = (min(boxes[i][0] for i in ids), min(boxes[i][1] for i in ids),
                   max(boxes[i][2] for i in ids), max(boxes[i][3] for i in ids))
            if len(ids) <= 16:
                return box, tuple(ids), None, None
            axis = 0 if box[2] - box[0] >= box[3] - box[1] else 1
            ids = sorted(ids, key=lambda i: boxes[i][axis] + boxes[i][axis + 2])
            mid = len(ids) // 2
            return box, (), build(ids[:mid]), build(ids[mid:])
        self.boxes = boxes
        self.tree = build(list(range(len(boxes))))

    def __iter__(self):
        return iter(self.values)

    def candidates(self, query):
        def overlaps(box):
            return box[0] <= query[2] and query[0] <= box[2] and box[1] <= query[3] and query[1] <= box[3]
        ids = []
        def visit(node):
            if node is None or not overlaps(node[0]):
                return
            if node[1]:
                ids.extend(i for i in node[1] if overlaps(self.boxes[i]))
            else:
                visit(node[2]); visit(node[3])
        visit(self.tree)
        return (self.values[i] for i in sorted(ids))


def segment_candidates(boundaries):
    return SpatialCandidates(boundaries, [(min(a[0], b[0]), min(a[1], b[1]),
                                          max(a[0], b[0]), max(a[1], b[1])) for a, b in boundaries])


def circle_candidates(circles):
    return SpatialCandidates(circles, [(c[0] - r, c[1] - r, c[0] + r, c[1] + r) for c, r in circles])


def _edge_candidates(values, a, b):
    if not isinstance(values, SpatialCandidates):
        return values
    # Sub-nanometre/degenerate edges retain the complete historical scan. The
    # broad margin includes native 1 nm rounding and near-collinear tolerance.
    if math.dist(a, b) < 1e-6:
        return values
    margin = max(1e-6, max(math.ulp(v) for v in tuple(a) + tuple(b)) * 64)
    return values.candidates((min(a[0], b[0]) - margin, min(a[1], b[1]) - margin,
                              max(a[0], b[0]) + margin, max(a[1], b[1]) + margin))


def reference_breaks(boundaries, a, b, circles=()):
    """Check the entire segment using every polygon/cap boundary intersection.

    Point-only grid membership is insufficient: two free nodes can straddle a
    hole narrower than the cell. Boundaries include outer rings AND holes.
    """
    ax, ay = a
    dx, dy = b[0] - ax, b[1] - ay
    ts = {0.0, 1.0}
    for c, d in _edge_candidates(boundaries, a, b):
        ex, ey = d[0] - c[0], d[1] - c[1]
        den = dx * ey - dy * ex
        cx, cy = c[0] - ax, c[1] - ay
        if abs(den) > 1e-15:
            t = (cx * ey - cy * ex) / den
            u = (cx * dy - cy * dx) / den
            if 0 <= t <= 1 and 0 <= u <= 1:
                ts.add(t)
        elif abs(cx * dy - cy * dx) <= 1e-15:
            norm = dx * dx + dy * dy
            if norm:
                for q in (c, d):
                    t = ((q[0] - ax) * dx + (q[1] - ay) * dy) / norm
                    if 0 <= t <= 1:
                        ts.add(t)
    norm = dx * dx + dy * dy
    for (cx, cy), r in _edge_candidates(circles, a, b):
        if not norm:
            continue
        qx, qy = ax - cx, ay - cy
        linear = 2 * (qx * dx + qy * dy)
        disc = linear * linear - 4 * norm * (qx * qx + qy * qy - r * r)
        if disc >= 0:
            for t in ((-linear - math.sqrt(disc)) / (2 * norm), (-linear + math.sqrt(disc)) / (2 * norm)):
                if 0 <= t <= 1:
                    ts.add(t)
    return sorted(ts)


def continuous_reference(ok, boundaries, a, b, circles=()):
    cuts = reference_breaks(boundaries, a, b, circles)
    ax, ay = a
    dx, dy = b[0] - ax, b[1] - ay
    return all(ok(ax + t * dx, ay + t * dy)
               for t in [0.0, 1.0] + [(u + v) / 2 for u, v in zip(cuts, cuts[1:])])


def detour_mm(ok, terminals, budget, cell, portals=(), edge_ok=None,
              alternate_ok=None, alternate_edge_ok=None):
    """Return detour of one run: the shortest path in the reference copper from the first terminal to the farthest
    other terminal, on a grid of this cell size (8 neighbours, a diagonal step only between two free sides).
    portals: exact positions of ground vias/through-hole pads spanning both
    layers. Transfer requires actual alternate-plane copper and continuous
    edges; plane-cut checks alone cannot prove the absence of holes or slots.
    ok(x, y) -> True on reference copper. terminals: [(x, y, snap)]; a terminal is reached at any copper cell within
    snap of it, with continuous access and its distance counted. Returns mm or
    None when unreachable/over budget. Missing terminals are not proof of a
    stub; only an independently proven stub may return zero."""
    import heapq
    if len(terminals) < 2:
        return None
    # A point predicate cannot establish continuous reference copper.
    if edge_ok is None:
        return None
    cache = {}
    predicates = (ok, alternate_ok)
    edge_predicates = (edge_ok, alternate_edge_ok)

    def free(c):
        if c not in cache:
            cache[c] = bool(predicates[c[0]](c[1] * cell, c[2] * cell))
        return cache[c]

    def cells(t):
        r = max(t[2], cell)
        n = math.ceil(r / cell)
        cx, cy = round(t[0] / cell), round(t[1] / cell)
        return {(0, cx + i, cy + j): math.dist(((cx + i) * cell, (cy + j) * cell), t[:2]) / cell
                for i in range(-n, n + 1) for j in range(-n, n + 1)
                if math.dist(((cx + i) * cell, (cy + j) * cell), t[:2]) <= r + 1e-9
                and free((0, cx + i, cy + j)) and edge_ok(t[:2], ((cx + i) * cell, (cy + j) * cell))}
    src = cells(terminals[0])
    if not src:
        return None
    # Portal access must reach the exact physical position through copper.
    # Missing alternate-plane geometry disables transfers, never invents copper.
    ports = [(x, y) for x, y in portals if alternate_ok is not None and alternate_edge_ok is not None
             and ok(x, y) and alternate_ok(x, y)]
    at_port = collections.defaultdict(list)
    for k, q in enumerate(ports):
        q = (round(q[0] / cell), round(q[1] / cell))
        for i in (-1, 0, 1):
            for j in (-1, 0, 1):
                at_port[(q[0] + i, q[1] + j)].append(k)
    worst = 0.0
    for t in terminals[1:]:
        dst = cells(t)
        if not dst:
            return None
        tx, ty = t[0] / cell, t[1] / cell
        h = lambda c: math.hypot(c[1] - tx, c[2] - ty)
        dist = dict(src)
        heap = [(d + h(c), d, c) for c, d in src.items()]
        heapq.heapify(heap)
        found = None
        while heap:
            f, d, c = heapq.heappop(heap)
            if d > dist.get(c, math.inf) + 1e-12:
                continue
            if found is not None and f >= found - 1e-12:
                break
            if f * cell > budget + 1e-9:
                break
            if c in dst:
                found = min(found if found is not None else math.inf, d + dst[c])
            for dx in (-1, 0, 1):
                for dy in (-1, 0, 1):
                    if not (dx or dy):
                        continue
                    n = (c[0], c[1] + dx, c[2] + dy)
                    if not free(n) or not edge_predicates[c[0]]((c[1] * cell, c[2] * cell), (n[1] * cell, n[2] * cell)):
                        continue
                    nd = d + (1.4142135623730951 if dx and dy else 1.0)
                    if nd < dist.get(n, math.inf) - 1e-12:
                        dist[n] = nd
                        heapq.heappush(heap, (nd + h(n), nd, n))
            # One layered graph, not O(portals**2) independent A* searches.
            for k in at_port.get(c[1:], ()):
                start = (c[1] * cell, c[2] * cell)
                if not edge_predicates[c[0]](start, ports[k]):
                    continue
                q = ports[k]
                qi = (round(q[0] / cell), round(q[1] / cell))
                other = 1 - c[0]
                for n in ((other, qi[0] + i, qi[1] + j) for i in (-1, 0, 1) for j in (-1, 0, 1)):
                    end = (n[1] * cell, n[2] * cell)
                    if free(n) and edge_predicates[other](q, end):
                        nd = d + (math.dist(start, q) + math.dist(q, end)) / cell
                        if nd < dist.get(n, math.inf) - 1e-12 and nd * cell <= budget + 1e-9:
                            dist[n] = nd
                            heapq.heappush(heap, (nd + h(n), nd, n))
        if found is None or found * cell > budget + 1e-9:
            return None
        worst = max(worst, found * cell)
    return worst


def _checked(net, s):
    return net not in s['grounds'] and net not in s['exempt']['nets']


def _native_stub_matches(run, source_sha, net, layer, domain):
    proof = run.get('_stub_proof')
    try:
        return (source_sha is not None and isinstance(proof, _NativeStubProof) and
                proof.record.get('contract') == 'native-unloaded-single-straight-leaf-v1' and
                proof.matches(source_sha, net, layer, domain, run))
    except (KeyError, TypeError, ValueError):
        return False


def reference_failures(results, domains, s, detour=None, board_mm=None, source_sha=None):
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
            # Positive detours cannot qualify a missing edge bound. Request
            # only bounded native stub inspection; a numeric zero is no proof.
            for run in runs:
                if detour and not _native_stub_matches(run, source_sha, net, layer, domains[net]):
                    detour(layer, domains[net], run, 0.0)
            bad = [run for run in runs if not _native_stub_matches(run, source_sha, net, layer, domains[net])]
            if bad:
                w = max(bad, key=lambda q: q['length'])
                x, y = w['at']
                gaps.append((w['length'], f"FAIL unknown-driver {layer} {net}: {len(bad)} of {len(runs)} crossings need an edge time "
                                          f"(longest run {w['length']:.1f} mm at ({x:.1f}, {y:.1f}), detour not measured: missing edge bound); unknown driver: {label}"))
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


def reference_assessment(results,domains,s,detour=None,board_mm=None,source_sha=None):
    """Keep accepted geometric screening separate from timing-evidence closure.
    Timing-dependent crossings cannot qualify on TYP/MAX/assumed edge budgets,
    including the screen's board-perimeter exemption. No timing requirement is
    invented for continuous reference or strict-fast/power checks.
    """
    import net_drivers
    screen=reference_failures(results,domains,s,detour,board_mm,source_sha);evidence=[]
    for (layer,net),r in results.items():
        if not _checked(net,s) or is_power(net,s) or is_fast(net,s) or domains.get(net) is None or not r.get('runs'):
            continue
        # The geometric screen's large-budget exemption may not call detour.
        # Ask the existing bounded native producer to inspect a single-terminal
        # leaf independently of that exemption. Its numeric return proves nothing.
        if source_sha is not None and detour and net_edge_of(net,s)[0] is not None:
            for run in r['runs']:
                if len(run.get('terminals',[]))==1 and not _native_stub_matches(run,source_sha,net,layer,domains[net]):
                    detour(layer,domains[net],run,0.0)
        nonstub=[run for run in r['runs'] if not _native_stub_matches(run,source_sha,net,layer,domains[net])]
        if not nonstub:
            continue
        edge=s['_edges'].get(net)
        if edge is None:
            cls=edge_class(net,s)
            rate=s['_edge_rates'].get(cls,{})
            if rate.get('applicability',{}).get('kind')=='protocol':
                edge={'edge_ns':rate['tr_ns'],'timing_evidence':net_drivers.timing_evidence(rate)}
        if edge is None or 'unknown' in edge:
            evidence.append(f"FAIL unproved-fastest-edge {layer} {net}: driver edge unknown for an unreferenced run; no qualified timing bound or topology-proven stub")
            continue
        quality=edge.get('timing_evidence',{})
        if not quality.get('qualified_fastest_bound',False):
            evidence.append(f"FAIL unproved-fastest-edge {layer} {net}: accepted screening edge {edge['edge_ns']:g} ns has no proven fastest-edge bound; timing-dependent crossing/perimeter exemption cannot qualify")
    return dict(screening_failures=screen,timing_evidence_failures=evidence,
                timing_evidence_complete=not evidence,scope='timing evidence only; geometry/model/physical board qualification remain separate')


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


def native_reference_geometry(p, fills, layer, domain, s, caps, copper_items=()):
    """Fresh filled copper plus the physical ground portal lands on this layer.

    ERROR_INSIDE polygons conservatively approximate rounded lands. Ground
    barrels are abstract attachment nodes; their copper lands connect them to
    the fill only through real spokes/solid copper, not a radius allowance.
    """
    lands = []
    for item in copper_items:
        if item.GetNetname() != domain or not item.IsOnLayer(layer):
            continue
        poly = p.SHAPE_POLY_SET()
        item.TransformShapeToPolygon(poly, layer, 0, p.FromMM(.001), p.ERROR_INSIDE)
        poly.BuildBBoxCaches()
        lands.append(poly)
    polygons = [poly for _, poly in fills[layer]] + lands
    boundaries = []
    boxes = []
    for poly in polygons:
        points = []
        for k in range(poly.OutlineCount()):
            rings = [poly.Outline(k)] + [poly.Hole(k, j) for j in range(poly.HoleCount(k))]
            for ring in rings:
                pts = [(mm(ring.CPoint(j).x), mm(ring.CPoint(j).y)) for j in range(ring.PointCount())]
                points.extend((ring.CPoint(j).x, ring.CPoint(j).y) for j in range(ring.PointCount()))
                boundaries.extend(zip(pts, pts[1:] + pts[:1]))
        boxes.append((min(x for x, y in points), min(y for x, y in points),
                      max(x for x, y in points), max(y for x, y in points)) if points else (0, 0, -1, -1))
    lands_index = SpatialCandidates(lands, boxes[len(fills[layer]):])
    fills_index = SpatialCandidates(fills[layer], boxes[:len(fills[layer])])
    boundaries = segment_candidates(boundaries)
    point_cache = {}

    def ok(x, y):
        key = (x, y)
        if key in point_cache:
            return point_cache[key]
        point = p.VECTOR2I(p.FromMM(x), p.FromMM(y))
        query = (point.x, point.y, point.x, point.y)
        if any(poly.Contains(point, -1, 0, True) for poly in lands_index.candidates(query)):
            result = True
        else:
            ref = next((net for net, poly in fills_index.candidates(query) if poly.Contains(point, -1, 0, True)), None)
            result = ref_domain(ref, s, False, (x, y), caps) == domain
        if len(point_cache) >= 100000:
            point_cache.clear()
        point_cache[key] = result
        return result
    circles = circle_candidates([(c, a['cap_mm']) for n, a in s['alt_refs'].items() if 'cap_mm' in a for c in caps[n]])
    edge_cache = {}
    def edge(a, b):
        # Retain directional answers inside an undirected key: floating-point
        # intersections can differ at a tangency when evaluated in reverse.
        a, b = tuple(a), tuple(b)
        key = tuple(sorted((a, b)))
        direction = (a, b)
        answers = edge_cache.get(key)
        if answers is not None and direction in answers:
            return answers[direction]
        result = continuous_reference(ok, boundaries, a, b, circles)
        if len(edge_cache) >= 100000:
            edge_cache.clear()
        edge_cache.setdefault(key, {})[direction] = result
        return result
    edge.breaks = lambda a, b: reference_breaks(boundaries, a, b, circles)
    return ok, edge


def native_ground_portals(vertical_items, layer, alternate, domain):
    """Only the actual domain's conductive barrels spanning both planes."""
    return [(mm(item.GetPosition().x), mm(item.GetPosition().y)) for item in vertical_items
            if item.GetNetname() == domain and item.IsOnLayer(layer) and item.IsOnLayer(alternate)]


def single_leaf_candidate(start, end, run, ref_ok, breaks):
    """Conservative straight-leaf contract; this alone is NOT a stub proof.

    One genuine reference attachment, a contiguous referenced prefix followed
    by an unreferenced tip, and every measured bad point on this same segment.
    Native conductor/land collisions must still prove the tip is unloaded.
    """
    if len(run.get('terminals', ())) != 1 or not run.get('bad_points'):
        return None
    if not ref_ok(*start) and ref_ok(*end):
        start, end = end, start
    if not ref_ok(*start) or ref_ok(*end):
        return None
    dx, dy = end[0] - start[0], end[1] - start[1]
    norm = dx * dx + dy * dy
    if not norm:
        return None
    cuts = breaks(start, end)
    states = [bool(ref_ok(start[0] + (a + b) / 2 * dx, start[1] + (a + b) / 2 * dy))
              for a, b in zip(cuts, cuts[1:])]
    if not states or states[0] is not True or states[-1] is not False:
        return None
    first = states.index(False)
    if any(states[first:]):
        return None
    exit_t = cuts[first]

    def on_segment(q, low, high):
        t = ((q[0] - start[0]) * dx + (q[1] - start[1]) * dy) / norm
        projection = (start[0] + t * dx, start[1] + t * dy)
        return low - 1e-9 <= t <= high + 1e-9 and math.dist(q[:2], projection) <= 1e-6
    terminal = run['terminals'][0]
    if not ref_ok(*terminal[:2]) or not on_segment(terminal, 0, exit_t):
        return None
    if not all(on_segment(q, exit_t, 1) and not ref_ok(*q) for q in run['bad_points']):
        return None
    return start, (start[0] + exit_t * dx, start[1] + exit_t * dy), end


def _run_fingerprint(run):
    import hashlib
    return hashlib.sha256(json.dumps({'bad': run.get('bad_points'), 'terminals': run.get('terminals')},
                                    sort_keys=True, separators=(',', ':')).encode()).hexdigest()


class _NativeStubProof:
    """Internal producer result; never a user/spec boolean or terminal count."""
    def __init__(self, source_sha, track, net, layer, domain, run):
        self.record = dict(source_sha256=source_sha, track_uuid=str(track.m_Uuid.AsString()),
                           net=net, layer=layer, domain=domain, run_sha256=_run_fingerprint(run),
                           contract='native-unloaded-single-straight-leaf-v1')

    def matches(self, source_sha, net, layer, domain, run):
        return all(self.record[k] == v for k, v in dict(source_sha256=source_sha, net=net, layer=layer,
                                                       domain=domain, run_sha256=_run_fingerprint(run)).items())


def prove_native_stub(p, board, lname, net, domain, run, ref_ok, edge, source_sha):
    """Prove an unloaded straight native copper leaf, not a pad/via escape.

    Multi-segment/arc/branch stubs remain unproven. No component pad, via or
    other conductor may touch the unreferenced tip; the referenced prefix must
    physically attach to another same-net native conductor. Uses actual copper
    width and land shapes, not radius-only endpoint or sample-count inference.
    """
    layer = board.GetLayerID(lname)
    items = list(board.GetTracks()) + list(board.GetPads())
    candidates = []
    for track in items:
        if track.GetClass() != 'PCB_TRACK' or track.GetNetname() != net or not track.IsOnLayer(layer):
            continue
        a, b = track.GetStart(), track.GetEnd()
        candidate = single_leaf_candidate((mm(a.x), mm(a.y)), (mm(b.x), mm(b.y)), run, ref_ok, edge.breaks)
        if candidate is not None:
            candidates.append((track, candidate))
    if len(candidates) != 1:
        return None
    track, (start, exit_, end) = candidates[0]
    tip = p.PCB_TRACK(board)
    tip.SetLayer(layer)
    tip.SetWidth(track.GetWidth())
    tip.SetStart(p.VECTOR2I(p.FromMM(exit_[0]), p.FromMM(exit_[1])))
    tip.SetEnd(p.VECTOR2I(p.FromMM(end[0]), p.FromMM(end[1])))
    tip_shape = tip.GetEffectiveShape(layer)
    whole_shape = track.GetEffectiveShape(layer)
    attached = False
    for item in items:
        if item == track or not item.IsOnLayer(layer):
            continue
        shape = item.GetEffectiveShape(layer)
        if shape.Collide(tip_shape, 0):
            return None
        if item.GetNetname() == net and shape.Collide(whole_shape, 0):
            attached = True
    if not attached:
        return None
    return _NativeStubProof(source_sha, track, net, lname, domain, run)


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

    paths, cuts = collections.defaultdict(list), collections.defaultdict(float)
    routed_records = []
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
            path = ((mm(a.x), mm(a.y)), (mm(m.x), mm(m.y)), (mm(e.x), mm(e.y)))
        else:
            path = ((mm(a.x), mm(a.y)), (mm(e.x), mm(e.y)))
        routed_records.append((net, lname, path, mm(t.GetWidth())))
        if lname in s['adjacent']:
            paths[(lname, net)].append(path)
        else:
            pts = sample_arc(*path, s['step_mm']) if cls == 'PCB_ARC' else sample_segment(*path, s['step_mm'])
            cuts[(lname, net)] += sum(w for _, _, w in pts)

    caps = collections.defaultdict(list)   # alt_ref net -> centres of its decoupling caps (a C part from it to a ground)
    for fp in b.GetFootprints():
        fn = {pd.GetNetname() for pd in fp.Pads()}
        if fp.GetReference().startswith('C') and fn & set(s['grounds']):
            for n in fn & set(s['alt_refs']):
                caps[n].append((mm(fp.GetPosition().x), mm(fp.GetPosition().y)))
    domains = {net: net_domain(net, pad_refs[net], s) for _, net in paths}
    projection_boundaries = {}
    for lname in s['adjacent'].values():
        edges = []
        for _, poly in fills[layers[lname]]:
            for index in range(poly.OutlineCount()):
                for ring in [poly.COutline(index)] + [poly.CHole(index, h) for h in range(poly.HoleCount(index))]:
                    vertices = [(mm(ring.CPoint(i).x), mm(ring.CPoint(i).y)) for i in range(ring.PointCount())]
                    edges.extend(zip(vertices, vertices[1:]+vertices[:1]))
        projection_boundaries[lname] = edges
    results = {}
    for lname, net in paths:
        if not _checked(net, s):
            continue
        adjacent = s['adjacent'][lname]
        results[(lname, net)] = evaluate_paths(paths[(lname, net)], projection_boundaries[adjacent],
                                              ref_fn(layers[adjacent]), domains[net], anchors[net], s, net, caps)

    import net_drivers
    nl = net_drivers.export_netlist(sch_path or os.path.splitext(board_path)[0] + '.kicad_sch')
    s['_edges'] = driver_edges(sorted({net for _, net in results}), nl, s,
                               geom=trace_geometry(board_path, s, routed_records))

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
    copper_items = list(b.GetTracks()) + list(b.GetPads())
    vertical_items = [item for item in copper_items
                      if item.GetClass() == 'PCB_VIA' or (item.GetClass() == 'PAD' and item.GetAttribute() == p.PAD_ATTRIB_PTH)]
    reference_geometry = {}
    import hashlib
    with open(board_path, 'rb') as source_file:
        source_sha = hashlib.sha256(source_file.read()).hexdigest()

    def detour(lname, domain, run, budget):
        if _native_stub_matches(run, source_sha, run['net'], lname, domain):
            return 0.0
        if budget == 0 and len(run['terminals']) != 1:
            return None
        lid = layers[s['adjacent'][lname]]

        def geometry(layer):
            key = (layer, domain)
            if key not in reference_geometry:
                reference_geometry[key] = native_reference_geometry(p, fills, layer, domain, s, caps, copper_items)
            return reference_geometry[key]

        ok, edge_ok = geometry(lid)
        if len(run['terminals']) < 2:
            proof = prove_native_stub(p, b, lname, run['net'], domain, run, ok, edge_ok, source_sha)
            if proof is not None:
                run['_stub_proof'] = proof
                return 0.0
        if budget == 0:
            return None
        alt = layers.get('In1.Cu')
        alternate_ok = alternate_edge_ok = None
        ports = []
        if alt is not None and alt != lid:
            alternate_ok, alternate_edge_ok = geometry(alt)
            # A blind/buried via that does not span both planes is not a portal.
            ports = native_ground_portals(vertical_items, lid, alt, domain)
        # Continuous edge checks make coarsening conservative for topology;
        # narrow channels may still produce false failures, never jump holes.
        return detour_mm(ok, run['terminals'], budget, min(0.5, max(0.1, budget / 200)), ports,
                         edge_ok, alternate_ok, alternate_edge_ok)

    assessment=reference_assessment(results,domains,s,detour,board_mm,source_sha)
    geometry=plane_cut_failures(cuts,s)+island_failures(pieces)+assessment['screening_failures']
    fails=geometry+assessment['timing_evidence_failures']
    info.append(f"SI_SCREEN geometric_failures={len(geometry)}; accepted screening values retained")
    info.append(f"SI_TIMING_EVIDENCE unresolved={len(assessment['timing_evidence_failures'])} timing_evidence_complete={str(assessment['timing_evidence_complete']).lower()}; geometry/model/physical_board_qualification separate")
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
