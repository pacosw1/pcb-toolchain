#!/usr/bin/env python3
"""The three routing rules of the user (2026-10-10, D-125) as prevention in tools/fastroute_job.py.

  1. Route critical signals first: staged order, each stage's copper locked before the next stage.
  2. Minimise vias (parasitics): a high router via cost, and a per-class via report.
  3. Keep a solid reference plane; never cross splits: keepouts over every missing piece of reference plane, on the
     signal layer adjacent to it, for the signal nets (reference-planes.json terms; power and ground nets exempt).

Route feature "routing_rules" (tools/route-features.json). No pcbnew import here: tools/fastroute_job.py gives the
board data (ring point lists in mm, KiCad coordinates, Y down), so the geometry is testable without KiCad.

Stages (stage_plan): pairs_clocks -> fast -> wide -> rest, then the job's last pass, with no keepout, routes the plane
nets (--route-planes) and the nets that an earlier stage left open (their stage copper is ripped up first).
A stage that holds both keepout nets and exempt nets is split (keepout nets first): Fastroute 0.1.7 reads DSN
keepouts for all nets (no net or class scope for a keepout in its DSN reader), so a stage with only signal nets is
the least invasive way to scope the keepouts.
"""
import bisect
import fnmatch
import json
import math
import os

STAGES = ('pairs_clocks', 'fast', 'wide', 'rest')
DEFAULT_CLOCKS = ['*CLK*', '*SCK*', '*XTAL*', '*OSC*']


def _match(net, pats):
    return any(fnmatch.fnmatchcase(net, p) for p in pats)


def _load(path):
    if path and os.path.isfile(path):
        with open(path) as f:
            return json.load(f)
    return {}


def board_info(board_dir, cfg=None):
    """Per-board inputs: fast patterns, pair nets, current-path nets and the reference-planes spec (raw dict)."""
    cfg = cfg or {}
    bd = board_dir or ''
    spec = _load(os.path.join(bd, 'reference-planes.json')) if bd else {}
    fast = list(_load(os.path.join(bd, 'rp001-fast-nets.json')).get('fast', [])) if bd else []
    for ff in [spec.get('fast_file')] + [m.get('fast_file') for m in (spec.get('mixed_layers') or {}).values()]:
        if ff and bd:
            fast += [p for p in _load(os.path.join(bd, ff)).get('fast', []) if p not in fast]
    pairs = []
    for p in (_load(os.path.join(bd, 'diff-pairs.json')).get('pairs', []) if bd else []):
        pairs += [p['p'], p['n']]
    current = sorted(_load(os.path.join(bd, 'current-paths.json')).get('nets', {})) if bd else []
    return dict(spec=spec, fast=fast, pairs=pairs, current=current,
                clocks=list(cfg.get('clock_patterns', DEFAULT_CLOCKS)))


def exempt(net, info, planes=()):
    """True for power and ground nets in reference-planes.json terms (no reference rule, so no keepout): a ground,
    a "power" or mixed-layer "power" pattern, an "exempt" net, a plane net of the job."""
    s = info.get('spec') or {}
    pats = list(s.get('power') or []) + [q for m in (s.get('mixed_layers') or {}).values() for q in m.get('power', [])]
    return (net in planes or net in (s.get('grounds') or []) or _match(net, pats)
            or net in ((s.get('exempt') or {}).get('nets') or {}))


def stage_of(net, info, net_class=None, wide_classes=()):
    """The stage of one net. Precedence: pair, clock, wide (current-paths.json, a wide net class, a power pattern),
    fast, rest. A switch node in the fast list is a wide net (it needs the full width first)."""
    if net in info['pairs']:
        return 'pairs_clocks'
    if _match(net, info['clocks']):
        return 'pairs_clocks'
    s = info.get('spec') or {}
    pats = list(s.get('power') or []) + [q for m in (s.get('mixed_layers') or {}).values() for q in m.get('power', [])]
    if net in info['current'] or (net_class or {}).get(net) in wide_classes or _match(net, pats):
        return 'wide'
    if _match(net, info['fast']):
        return 'fast'
    return 'rest'


def stage_plan(nets, info, net_class=None, wide_classes=(), planes=()):
    """[(name, sorted nets, keepout)] in routing order. Plane nets are left to the last pass. A stage with keepout
    nets and exempt nets is split: the keepout part first (name), then the exempt part (name + "_exempt")."""
    groups = {k: [] for k in STAGES}
    for n in sorted(nets):
        if n in planes:
            continue
        groups[stage_of(n, info, net_class, wide_classes)].append(n)
    plan = []
    for k in STAGES:
        sig = [n for n in groups[k] if not exempt(n, info, planes)]
        pwr = [n for n in groups[k] if exempt(n, info, planes)]
        plan += [p for p in ((k, sig, True), (k + '_exempt', pwr, False)) if p[1]]
    return plan


# ------------------------------------------------------------------ keepout geometry (rule 3)

def _row_crossings(edges_by_row, row, y):
    """x of every ring edge that crosses the scan line y (half-open in y, so a vertex counts once)."""
    xs = []
    for (x0, y0, x1, y1) in edges_by_row.get(row, ()):
        if (y0 <= y < y1) or (y1 <= y < y0):
            xs.append(x0 + (y - y0) * (x1 - x0) / (y1 - y0))
    xs.sort()
    return xs


def _bucket(rings, y_min, h, n_rows):
    """Edges of rings (lists of (x, y)) indexed by the scan rows they span."""
    out = {}
    for ring in rings:
        for i in range(len(ring)):
            (x0, y0), (x1, y1) = ring[i], ring[(i + 1) % len(ring)]
            if y0 == y1:
                continue
            lo, hi = min(y0, y1), max(y0, y1)
            r0 = max(0, int(math.floor((lo - y_min) / h - 0.5)))
            r1 = min(n_rows - 1, int(math.ceil((hi - y_min) / h - 0.5)))
            for r in range(r0, r1 + 1):
                out.setdefault(r, []).append((x0, y0, x1, y1))
    return out


def _union(iv):
    iv = sorted(iv)
    out = []
    for a, b in iv:
        if out and a <= out[-1][1]:
            out[-1][1] = max(out[-1][1], b)
        else:
            out.append([a, b])
    return [tuple(x) for x in out]


def _subtract(base, cut):
    """Intervals of base minus the union of cut (both lists of (a, b))."""
    cut = _union(cut)
    out = []
    for a, b in base:
        cur = a
        for c, d in cut:
            if d <= cur or c >= b:
                continue
            if c > cur:
                out.append((cur, c))
            cur = max(cur, d)
            if cur >= b:
                break
        if cur < b:
            out.append((cur, b))
    return out


def _pairs(xs):
    return [(xs[i], xs[i + 1]) for i in range(0, len(xs) - 1, 2)]


def void_rects(outline, ref_polys, discs, grid=0.1, min_mm=0.05, tol=None):
    """Rectangles (x0, y0, x1, y1) in mm that cover the board area with no reference copper.

    outline: rings of the board outline (even-odd: board holes and slots are not board area).
    ref_polys: polygons of reference copper, each a list of rings (even-odd per polygon, union over polygons).
    discs: (x, y, r) areas that are never a keepout (pads and vias with their allowance: pin access, antipads).
    Scan lines every grid mm; a row interval narrower than min_mm is dropped; rows whose intervals agree within tol
    (default grid / 2) merge into one rectangle that covers both (conservative: the keepout is never smaller)."""
    tol = grid / 2 if tol is None else tol
    pts = [p for ring in outline for p in ring]
    if not pts:
        return []
    y_min, y_max = min(p[1] for p in pts), max(p[1] for p in pts)
    n_rows = max(1, int(math.ceil((y_max - y_min) / grid)))
    board_edges = _bucket(outline, y_min, grid, n_rows)
    ref_edges = [_bucket(poly, y_min, grid, n_rows) for poly in ref_polys]
    disc_rows = {}
    for (cx, cy, r) in discs:
        r0 = max(0, int(math.floor((cy - r - y_min) / grid - 0.5)))
        r1 = min(n_rows - 1, int(math.ceil((cy + r - y_min) / grid - 0.5)))
        for row in range(r0, r1 + 1):
            disc_rows.setdefault(row, []).append((cx, cy, r))
    rects, open_ = [], {}
    for row in range(n_rows):
        y = y_min + (row + 0.5) * grid
        board = _pairs(_row_crossings(board_edges, row, y))
        ref = []
        for e in ref_edges:
            ref += _pairs(_row_crossings(e, row, y))
        cut = list(ref)
        for (cx, cy, r) in disc_rows.get(row, ()):
            # the disc's widest chord inside this row band (conservative for the never-keepout area)
            dy = max(0.0, abs(y - cy) - grid / 2)
            if dy < r:
                w = math.sqrt(r * r - dy * dy)
                cut.append((cx - w, cx + w))
        iv = [(a, b) for a, b in _subtract(board, cut) if b - a >= min_mm]
        y0 = y_min + row * grid
        nxt = {}
        for a, b in iv:
            hit = next((k for k in open_ if abs(k[0] - a) <= tol and abs(k[1] - b) <= tol), None)
            if hit is not None:
                ra, rb, ry0 = open_.pop(hit)
                nxt[(a, b)] = (min(ra, a), max(rb, b), ry0)
            else:
                nxt[(a, b)] = (a, b, y0)
        for (ra, rb, ry0) in open_.values():
            rects.append((ra, ry0, rb, y0))
        open_ = nxt
    y_end = y_min + n_rows * grid
    rects += [(ra, ry0, rb, y_end) for (ra, rb, ry0) in open_.values()]
    return rects


def ref_nets(spec, fast=False):
    """Reference nets: the grounds and the alt_refs (no slow_only one when the stage has a fast net; an alt_ref with
    cap_mm is a reference only near its caps, so it is not counted as a plane here)."""
    out = set(spec.get('grounds') or [])
    for n, a in (spec.get('alt_refs') or {}).items():
        if 'cap_mm' in a or (fast and a.get('slow_only')):
            continue
        out.add(n)
    return out


def layer_keepouts(spec, layers, outline, fills, discs, grid=0.1, fast=False):
    """{signal layer: rects} for each job layer that has a reference layer in spec["adjacent"]. fills: {layer name:
    [(net, rings)]} of the refilled zones. Only the adjacent layer of a plane gets its keepouts."""
    refs = ref_nets(spec, fast)
    out = {}
    for L in layers:
        P = (spec.get('adjacent') or {}).get(L)
        if not P:
            continue
        polys = [rings for net, rings in fills.get(P, []) if net in refs]
        out[L] = void_rects(outline, polys, discs.get(L, []), grid)
    return out


def add_wire_keepouts(text, rects_by_layer):
    """(wire_keepout "" (polygon LAYER 0 x y ...)) per rectangle in the DSN structure section (um, Y negated)."""
    out = []
    for layer, rects in sorted(rects_by_layer.items()):
        for (x0, y0, x1, y1) in rects:
            pts = [(x0, y0), (x1, y0), (x1, y1), (x0, y1), (x0, y0)]
            coords = '  '.join(f"{x * 1000:.0f} {-y * 1000:.0f}" for x, y in pts)
            out.append(f'    (wire_keepout "iot_ref_void" (polygon {layer} 0  {coords}))')
    if not out:
        return text
    i = text.find('(structure')
    j = text.find('\n    (via', i)
    if j < 0:
        j = text.find('\n    (rule', i)
    return text[:j] + '\n' + '\n'.join(out) + text[j:]


# ------------------------------------------------------------------ via report (rule 2)

def via_report(vias, net_stage, net_class, fast, grounds, gnd_anchors, via_allow):
    """vias: [(net, x, y, r)]; gnd_anchors: [(x, y, r)] (ground vias and through-hole ground pads).
    Returns {by_stage: {stage: {nets, vias, max, per_net}}, by_class: {...}, fast_no_gnd: [...]}. A fast-net via (a
    layer change) with no ground via or through-hole pad within via_allow (edge to edge) is listed in fast_no_gnd."""
    per_net = {}
    for net, *_ in vias:
        per_net[net] = per_net.get(net, 0) + 1
    by_stage, by_class = {}, {}
    for net, n in sorted(per_net.items()):
        if net in grounds:
            continue
        for key, table in ((net_stage.get(net, 'other'), by_stage), (net_class.get(net, '?'), by_class)):
            e = table.setdefault(key, dict(nets=0, vias=0, max=0, per_net={}))
            e['nets'] += 1
            e['vias'] += n
            e['max'] = max(e['max'], n)
            e['per_net'][net] = n
    xs = sorted(gnd_anchors)
    keys = [a[0] for a in xs]
    reach = max((a[2] for a in xs), default=0)
    missing = []
    for net, x, y, r in vias:
        if net in grounds or not _match(net, fast):
            continue
        lo = bisect.bisect_left(keys, x - r - reach - via_allow)
        hi = bisect.bisect_right(keys, x + r + reach + via_allow)
        best = min((math.dist((x, y), a[:2]) - r - a[2] for a in xs[lo:hi]), default=math.inf)
        if best > via_allow:
            missing.append(dict(net=net, x=round(x, 3), y=round(y, 3),
                                nearest_gnd_mm=None if best == math.inf else round(best, 3)))
    return dict(by_stage=by_stage, by_class=by_class, fast_no_gnd=missing, via_allow_mm=via_allow)


def summary_line(rep):
    s = ' '.join(f"{k}={v['vias']}/{v['nets']}" for k, v in sorted(rep['by_stage'].items()))
    return f"VIAS_BY_STAGE {s or '-'} (vias/nets) FAST_VIA_NO_GND {len(rep['fast_no_gnd'])}"
