#!/usr/bin/env python3
"""The three routing rules of the user (2026-10-10, D-125) as prevention in tools/fastroute_job.py.

  1. Route critical signals first: staged order, each stage's copper locked before the next stage.
  2. Minimise vias (parasitics): a high router via cost, and a per-class via report.
  3. Keep a solid reference plane; never cross splits: keepouts over every missing piece of reference plane, on the
     signal layer adjacent to it, for the signal nets (reference-planes.json terms; power and ground nets exempt).

Route feature "routing_rules" (tools/route-features.json). No pcbnew import here: tools/fastroute_job.py gives the
board data (ring point lists in mm, KiCad coordinates, Y down), so the geometry is testable without KiCad.

Stages (stage_plan): pairs_clocks -> fast -> escape -> wide_hot -> wide -> rest, then the job's last pass, with no
keepout, routes the plane nets (--route-planes) and the nets that an earlier stage left open (their stage copper is
ripped up first). W10 (2026-10-10): "escape" fans out the SMD pads of the fine-pitch footprints (IPC-7351B fine pitch:
pad pitch <= 0.65 mm) before any wide copper (the BGA fan-out practice; TI switch-node guidance): Fastroute's own
SMD fanout stage, bounded by a keepout outside a belt round each fine-pitch courtyard (one clearance, a via, a track).
"wide_hot" routes the switch nodes (current-paths.json "switch_node": true, or the config switch_nodes) as a
minimum-area loop: a corridor keepout round the net's pads, one layer (use_layer mask), a raised via cost, and a
maximum length = hot_loop_factor x the straight pad distance, checked after routing (via-report.json hot_loops).
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
    raw = _load(os.path.join(bd, 'current-paths.json')).get('nets', {}) if bd else {}
    return dict(spec=spec, fast=fast, pairs=pairs, current=sorted(raw),
                clocks=list(cfg.get('clock_patterns', DEFAULT_CLOCKS)),
                switch=switch_nodes(raw, cfg.get('switch_nodes', [])))


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


def stage_plan(nets, info, net_class=None, wide_classes=(), planes=(), escape=(), hot=()):
    """[(name, sorted nets, keepout)] in routing order. Plane nets are left to the last pass. A stage with keepout
    nets and exempt nets is split: the keepout part first (name), then the exempt part (name + "_exempt").
    escape: nets of fine-pitch SMD pads; those of the wide and rest groups form the "escape" stage before "wide"
    (no reference keepout: the belt keepout of the job bounds it) and are routed again in their own stage, from the
    locked escapes. hot: switch nodes; those of the wide group form "wide_hot" (split like any stage) before "wide"."""
    groups = {k: [] for k in STAGES}
    for n in sorted(nets):
        if n in planes:
            continue
        groups[stage_of(n, info, net_class, wide_classes)].append(n)
    esc = sorted(n for n in escape if n in groups['wide'] or n in groups['rest'])
    hot_nets = [n for n in groups['wide'] if n in hot]
    groups['wide'] = [n for n in groups['wide'] if n not in hot]
    plan = []
    for k in STAGES:
        if k == 'wide':
            if esc:
                plan.append(('escape', esc, False))
            sig = [n for n in hot_nets if not exempt(n, info, planes)]
            pwr = [n for n in hot_nets if exempt(n, info, planes)]
            plan += [p for p in (('wide_hot', sig, True), ('wide_hot_exempt', pwr, False)) if p[1]]
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
    """(wire_keepout "iot_ref_void" (polygon LAYER 0 x y ...)) per rectangle in the DSN structure (um, Y negated)."""
    return add_keepouts(text, rects_by_layer, ('wire_keepout',), 'iot_ref_void')


def add_keepouts(text, rects_by_layer, kinds=('wire_keepout',), name='iot_ref_void'):
    """One DSN keepout of each kind (wire_keepout, via_keepout) per rectangle, in the structure section."""
    out = []
    for layer, rects in sorted(rects_by_layer.items()):
        for (x0, y0, x1, y1) in rects:
            pts = [(x0, y0), (x1, y0), (x1, y1), (x0, y1), (x0, y0)]
            coords = '  '.join(f"{x * 1000:.0f} {-y * 1000:.0f}" for x, y in pts)
            for kind in kinds:
                out.append(f'    ({kind} "{name}" (polygon {layer} 0  {coords}))')
    if not out:
        return text
    i = text.find('(structure')
    j = text.find('\n    (via', i)
    if j < 0:
        j = text.find('\n    (rule', i)
    return text[:j] + '\n' + '\n'.join(out) + text[j:]


# ------------------------------------------------------------------ via report (rule 2)

def via_report(vias, net_stage, net_class, fast, grounds, gnd_anchors, via_allow, hot=None):
    """vias: [(net, x, y, r)]; gnd_anchors: [(x, y, r)] (ground vias and through-hole ground pads).
    Returns {by_stage: {stage: {nets, vias, max, per_net}}, by_class: {...}, fast_no_gnd: [...], hot_loops: {...}}.
    A fast-net via (a layer change) with no ground via or through-hole pad within via_allow (edge to edge) is listed
    in fast_no_gnd. hot: {net: {max_mm, straight_mm, length_mm}} of the switch nodes; each gets its via count and
    within = length_mm <= max_mm."""
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
    loops = {}
    for net, h in sorted((hot or {}).items()):
        loops[net] = dict(h, vias=per_net.get(net, 0), within=bool(h['length_mm'] <= h['max_mm']))
    return dict(by_stage=by_stage, by_class=by_class, fast_no_gnd=missing, via_allow_mm=via_allow, hot_loops=loops)


def summary_line(rep):
    s = ' '.join(f"{k}={v['vias']}/{v['nets']}" for k, v in sorted(rep['by_stage'].items()))
    line = f"VIAS_BY_STAGE {s or '-'} (vias/nets) FAST_VIA_NO_GND {len(rep['fast_no_gnd'])}"
    loops = rep.get('hot_loops') or {}
    if loops:
        ok = sum(1 for h in loops.values() if h['within'])
        line += f" HOT_LOOPS {ok}/{len(loops)} within " + ' '.join(
            f"{n}={h['length_mm']:g}/{h['max_mm']:g}mm,{h['vias']}via" for n, h in sorted(loops.items()))
    return line

# ------------------------------------------------------------------ fan-out stage (W10, 2026-10-10)

FINE_PITCH_MM = 0.65   # IPC-7351B land pattern standard: "fine pitch" components have a pitch of 0.65 mm or less


def footprint_pitch(points):
    """Pad pitch of one footprint: the smallest centre distance between two of its pads (mm); None with one pad."""
    pts = sorted(points)
    best = math.inf
    for i, p in enumerate(pts):
        for q in pts[i + 1:]:
            if q[0] - p[0] >= best:
                break
            best = min(best, math.dist(p, q))
    return None if best == math.inf else best


def fine_pitch_refs(pads_by_ref, limit=FINE_PITCH_MM):
    """{ref: pitch} of the footprints whose pad pitch is at most limit (config fine_pitch_mm, IPC-7351B 0.65 mm)."""
    out = {}
    for ref, pts in pads_by_ref.items():
        p = footprint_pitch(pts)
        if p is not None and p <= limit + 1e-6:
            out[ref] = round(p, 4)
    return out


def escape_nets(pads, fine, nets, exclude=()):
    """pads: [(ref, net, smd)]. The nets of the SMD pads of the fine-pitch footprints that the job routes, minus
    exclude (pair, clock and fast nets are routed before the escape stage; plane nets by the last pass)."""
    return sorted({net for ref, net, smd in pads if smd and net and ref in fine and net in nets and net not in exclude})


def belt_margin(width, clearance, via):
    """Belt outside a fine-pitch courtyard, from the board's Default class: one clearance to the courtyard, two
    staggered rows of fan-out vias (at a 0.5 mm pitch two 0.6 mm vias with their clearance do not fit in one row),
    one track beside them with its clearance."""
    return clearance + 2 * (via + clearance) + width + clearance


def grow(box, m):
    return (box[0] - m, box[1] - m, box[2] + m, box[3] + m)


def outside_rects(board_box, boxes):
    """Rectangles (x0, y0, x1, y1) that cover board_box minus the union of boxes: the keepout outside the belts
    (or outside a hot-loop corridor). Scan bands between the box edges; equal bands merge."""
    x0, y0, x1, y1 = board_box
    ys = sorted({y0, y1} | {b[1] for b in boxes} | {b[3] for b in boxes})
    ys = [y for y in ys if y0 <= y <= y1]
    out = []
    for ya, yb in zip(ys, ys[1:]):
        active = [(b[0], b[2]) for b in boxes if b[1] < yb and b[3] > ya]
        for a, c in _subtract([(x0, x1)], active):
            if out and out[-1][0] == a and out[-1][2] == c and abs(out[-1][3] - ya) < 1e-9:
                out[-1] = (a, out[-1][1], c, yb)
            else:
                out.append((a, ya, c, yb))
    return out


# ------------------------------------------------------------------ hot loop (W10, 2026-10-10)

def switch_nodes(current, names=()):
    """{net: loop pads} of the switch nodes: current-paths.json entries with "switch_node": true, plus the nets
    named in the config (switch_nodes). The loop pads are the entry's pads (first chain of a chained entry)."""
    out = {}
    for net, e in (current or {}).items():
        if e.get('switch_node') or net in names:
            out[net] = list(e.get('pads') or (e.get('chains') or [{}])[0].get('pads') or [])
    for n in names:
        out.setdefault(n, [])
    return out


def hot_loop(pad_xy, loop_pads, factor, margin_min):
    """The minimum-area loop bound of a switch node. pad_xy: {"REF.PIN": (x, y)} of every pad of the net;
    loop_pads: the loop ends of current-paths.json (its first and last pad). straight_mm: the straight distance
    between the ends (the longest pad distance of the net when the ends are unknown); max_mm = factor x straight
    (TI SLVAES4 / the hot-loop guidance: the switch node as short and direct as possible; factor hot_loop_factor);
    box: the bounding box of the net's pads grown by (max - straight) / 2, at least margin_min (one track and its
    clearance): the corridor outside which the stage keeps out. None without pads."""
    pts = list(pad_xy.values())
    if not pts:
        return None
    ends = [loop_pads[0], loop_pads[-1]] if len(loop_pads) >= 2 else []
    if ends and all(p in pad_xy for p in ends):
        d = math.dist(pad_xy[ends[0]], pad_xy[ends[1]])
    else:
        d = max(math.dist(p, q) for p in pts for q in pts)
    L = factor * d
    m = max((L - d) / 2, margin_min)
    xs, ys = [p[0] for p in pts], [p[1] for p in pts]
    return dict(straight_mm=round(d, 3), max_mm=round(L, 3), margin_mm=round(m, 3), ends=ends,
                box=(min(xs) - m, min(ys) - m, max(xs) + m, max(ys) + m))


# ------------------------------------------------------------------ repair pass (W9, 2026-10-10)

def segment_distance(a0, a1, b0, b1):
    """Shortest distance between segments a0-a1 and b0-b1 (mm, 2D); a point is a segment of zero length."""
    def orient(p, q, r):
        return (q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0])

    def point_seg(p, s0, s1):
        dx, dy = s1[0] - s0[0], s1[1] - s0[1]
        L2 = dx * dx + dy * dy
        if L2 == 0:
            return math.dist(p, s0)
        u = max(0.0, min(1.0, ((p[0] - s0[0]) * dx + (p[1] - s0[1]) * dy) / L2))
        return math.dist(p, (s0[0] + u * dx, s0[1] + u * dy))
    d1, d2 = orient(a0, a1, b0), orient(a0, a1, b1)
    d3, d4 = orient(b0, b1, a0), orient(b0, b1, a1)
    if ((d1 > 0) != (d2 > 0)) and ((d3 > 0) != (d4 > 0)) and d1 and d2 and d3 and d4:
        return 0.0
    return min(point_seg(b0, a0, a1), point_seg(b1, a0, a1), point_seg(a0, b0, b1), point_seg(a1, b0, b1))


def repair_selection(unrouted, copper, corridor_mm=1.0, exclude=(), max_blockers=4):
    """Nets to unlock for a repair pass: every net left open and its immediate blockers, nothing else.

    unrouted: Fastroute report rows (net, from_xy, to_xy in board mm, from/to layers). copper: [(net, layer, p0, p1)]
    of the routed board in mm (a via: layer None, p0 == p1). A blocker of an open connection is a net other than the
    open one with copper within corridor_mm of the straight line between the connection's ends, on a layer of the
    ends (a via counts on every layer); the max_blockers nearest nets per connection. exclude: nets never unlocked
    (the plane nets, the grounds). Pair, clock and fast copper is unlocked only when it is such a blocker."""
    open_nets = sorted({u['net'] for u in unrouted if u.get('net')})
    blockers, n = {}, 0
    for u in unrouted:
        net, a0, a1 = u.get('net'), u.get('from_xy'), u.get('to_xy')
        if not net or not a0 or not a1:
            continue
        n += 1
        layers = set((u.get('from') or {}).get('layers') or []) | set((u.get('to') or {}).get('layers') or [])
        best = {}
        for (cn, layer, p0, p1) in copper:
            if cn == net or cn in exclude or (layer is not None and layers and layer not in layers):
                continue
            d = segment_distance(tuple(a0), tuple(a1), tuple(p0), tuple(p1))
            if d <= corridor_mm and d < best.get(cn, math.inf):
                best[cn] = d
        near = sorted(best, key=lambda k: (best[k], k))[:max_blockers]
        blockers.setdefault(net, set()).update(near)
    blockers = {k: sorted(v) for k, v in blockers.items()}
    nets = set(open_nets) | {b for v in blockers.values() for b in v}
    return dict(nets=sorted(nets - set(exclude)), blockers=blockers, connections=n, corridor_mm=corridor_mm)
