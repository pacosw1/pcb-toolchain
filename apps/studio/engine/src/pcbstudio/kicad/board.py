"""Board geometry from a .kicad_pcb file, for the viewer (and later the checks). Read only; plain dicts.

Coordinates are KiCad board mm (y down). A footprint item's `(at x y)` / `(start x y)` is in the footprint frame:
rotate it by the footprint angle, then add the footprint position. A pad's angle in the file is its absolute
orientation; a pad with no angle has orientation 0 (not the footprint angle). Custom pad primitives are in the pad
frame (rotate by the pad orientation, add the pad position).

Checked against KiCad's own pcbnew for every board of the iot-lab corpus: engine/tests/test_board.py.
"""
from __future__ import annotations

import math
from pathlib import Path

from .sexpr import child, children, parse, value

SILK_COURTYARD = ('F.SilkS', 'B.SilkS', 'F.CrtYd', 'B.CrtYd')
OUTLINE_EPS = 0.01          # mm: two Edge.Cuts ends closer than this are joined
KEEPOUT_ITEMS = ('tracks', 'vias', 'pads', 'copperpour', 'footprints')


def _f(x) -> float:
    return float(x)


def _xy(node) -> tuple[float, float]:
    return _f(node[1]), _f(node[2])


def _rot(x: float, y: float, deg: float) -> tuple[float, float]:
    """KiCad rotation (positive = counter-clockwise on screen, y down)."""
    if not deg:
        return x, y
    a = math.radians(deg)
    c, s = math.cos(a), math.sin(a)
    return x * c + y * s, -x * s + y * c


def _layers(node) -> list[str]:
    ls = child(node, 'layers')
    return [str(v) for v in ls[1:]] if ls else ([str(value(node, 'layer'))] if value(node, 'layer') else [])


def _arc_points(start, mid, end, segs: int = 16) -> list[tuple[float, float]]:
    (x1, y1), (x2, y2), (x3, y3) = start, mid, end
    d = 2 * (x1 * (y2 - y3) + x2 * (y3 - y1) + x3 * (y1 - y2))
    if abs(d) < 1e-12:
        return [start, end]
    ux = ((x1 * x1 + y1 * y1) * (y2 - y3) + (x2 * x2 + y2 * y2) * (y3 - y1) + (x3 * x3 + y3 * y3) * (y1 - y2)) / d
    uy = ((x1 * x1 + y1 * y1) * (x3 - x2) + (x2 * x2 + y2 * y2) * (x1 - x3) + (x3 * x3 + y3 * y3) * (x2 - x1)) / d
    r = math.hypot(x1 - ux, y1 - uy)
    a1, a2, a3 = (math.atan2(p[1] - uy, p[0] - ux) for p in (start, mid, end))

    def sweep(a, b):
        return (b - a) % (2 * math.pi)
    total = sweep(a1, a3)
    if sweep(a1, a2) > total:          # mid not on the ccw path: go the other way
        total -= 2 * math.pi
    pts = [(ux + r * math.cos(a1 + total * k / segs), uy + r * math.sin(a1 + total * k / segs)) for k in range(segs + 1)]
    pts[0], pts[-1] = start, end       # exact ends, so chains join
    return pts


def _circle(cx: float, cy: float, r: float, n: int = 48) -> list[tuple[float, float]]:
    return [(cx + r * math.cos(2 * math.pi * k / n), cy + r * math.sin(2 * math.pi * k / n)) for k in range(n + 1)]


def _shape(g, tf) -> tuple[list[tuple[float, float]], bool] | None:
    """A gr_*/fp_* graphic as (points, closed) in board coordinates; `tf` maps a local point to the board."""
    kind = str(g[0])[3:]
    if kind == 'line':
        return [tf(_xy(child(g, 'start'))), tf(_xy(child(g, 'end')))], False
    if kind == 'arc':
        return [tf(p) for p in _arc_points(_xy(child(g, 'start')), _xy(child(g, 'mid')), _xy(child(g, 'end')))], False
    if kind == 'rect':
        (x0, y0), (x1, y1) = _xy(child(g, 'start')), _xy(child(g, 'end'))
        pts = [tf(p) for p in ((x0, y0), (x1, y0), (x1, y1), (x0, y1))]
        return pts + pts[:1], True
    if kind == 'circle':
        (cx, cy), (ex, ey) = _xy(child(g, 'center')), _xy(child(g, 'end'))
        r = math.hypot(ex - cx, ey - cy)
        return [tf(p) for p in _circle(cx, cy, r)], True
    if kind == 'poly':
        pts = [tf(_xy(p)) for p in children(child(g, 'pts') or [], 'xy')]
        return (pts + pts[:1], True) if pts else None
    return None                        # text, curves, dimensions: not drawn


def _stroke_width(g) -> float:
    st = child(g, 'stroke')
    w = value(st, 'width') if st else value(g, 'width')
    return _f(w) if w is not None else 0.0


def _filled(g) -> bool:
    return str(value(g, 'fill', 'no')) in ('yes', 'solid')


def _graphic_items(node):
    for g in node:
        if isinstance(g, list) and g and str(g[0])[:3] in ('gr_', 'fp_') and str(g[0])[3:] in (
                'line', 'arc', 'rect', 'circle', 'poly'):
            yield g


def _join(pieces: list[list[tuple[float, float]]], eps: float = OUTLINE_EPS) -> list[list[tuple[float, float]]]:
    """Chain open polylines whose ends meet into longer chains; a chain whose ends meet is closed (last == first)."""
    def near(a, b):
        return abs(a[0] - b[0]) <= eps and abs(a[1] - b[1]) <= eps
    rest = [list(p) for p in pieces if len(p) >= 2]
    out = []
    while rest:
        chain = rest.pop(0)
        grown = True
        while grown and not near(chain[0], chain[-1]):
            grown = False
            for i, p in enumerate(rest):
                if near(chain[-1], p[0]):
                    chain += p[1:]
                elif near(chain[-1], p[-1]):
                    chain += p[-2::-1]
                elif near(chain[0], p[-1]):
                    chain[:0] = p[:-1]
                elif near(chain[0], p[0]):
                    chain[:0] = p[:0:-1]
                else:
                    continue
                rest.pop(i)
                grown = True
                break
        if len(chain) > 2 and near(chain[0], chain[-1]):
            chain[-1] = chain[0]
        out.append(chain)
    return out


def _is_closed(chain) -> bool:
    return len(chain) > 2 and chain[0] == chain[-1]


def _fp_transform(fx: float, fy: float, fa: float):
    def tf(p):
        dx, dy = _rot(p[0], p[1], fa)
        return fx + dx, fy + dy
    return tf


def _pad(pad, fx: float, fy: float, fa: float) -> dict:
    pat = child(pad, 'at')
    px, py = _xy(pat)
    pa = _f(pat[3]) if len(pat) > 3 else 0.0      # absolute orientation; none = 0
    dx, dy = _rot(px, py, fa)
    x, y = fx + dx, fy + dy
    size = child(pad, 'size')
    w = _f(size[1]) if size else 0.0
    h = _f(size[2]) if size and len(size) > 2 else w
    drill = child(pad, 'drill')
    d_w = d_h = None
    d_shape = None
    if drill is not None:
        nums = [_f(v) for v in drill[1:] if not isinstance(v, list) and str(v) != 'oval']
        d_shape = 'oval' if any(str(v) == 'oval' for v in drill[1:] if not isinstance(v, list)) else 'circle'
        if nums:
            d_w = nums[0]
            d_h = nums[1] if len(nums) > 1 and d_shape == 'oval' else d_w
    out = {
        'num': str(pad[1]), 'type': str(pad[2]), 'shape': str(pad[3]),
        'x': round(x, 6), 'y': round(y, 6), 'rot': pa,
        'w': w, 'h': h,
        'layers': _layers(pad), 'net': str(value(pad, 'net', '') or ''),
        'drill': d_w, 'drill_h': d_h, 'drill_shape': d_shape,
        'rratio': _f(value(pad, 'roundrect_rratio', 0) or 0),
    }
    if out['shape'] == 'custom':
        opts = child(pad, 'options')
        out['anchor'] = str(value(opts, 'anchor', 'rect')) if opts else 'rect'

        def tf(p):
            ex, ey = _rot(p[0], p[1], pa)
            return x + ex, y + ey
        prims = []
        for g in _graphic_items(child(pad, 'primitives') or []):
            got = _shape(g, tf)
            if got:
                pts, closed = got
                prims.append({'pts': [(round(a, 6), round(b, 6)) for a, b in pts], 'w': _stroke_width(g),
                              'fill': closed and (_filled(g) or str(g[0]) == 'gr_poly'), 'closed': closed})
        out['prims'] = prims
    return out


def _footprints(root, graphics: list, edges: list) -> list[dict]:
    fps = []
    for fp in children(root, 'footprint'):
        at = child(fp, 'at')
        fx, fy = _xy(at)
        fa = _f(at[3]) if len(at) > 3 else 0.0
        ref = ''
        props: dict[str, str] = {}
        for prop in children(fp, 'property'):
            if len(prop) > 2 and isinstance(prop[1], str):
                props[str(prop[1])] = str(prop[2])
            if len(prop) > 2 and prop[1] == 'Reference':
                ref = str(prop[2])
        attr = child(fp, 'attr')
        attrs = [str(a) for a in attr[1:]] if attr else []
        if not ref:                                 # older files: (fp_text reference "R1")
            for t in children(fp, 'fp_text'):
                if len(t) > 2 and t[1] == 'reference':
                    ref = str(t[2])
        tf = _fp_transform(fx, fy, fa)
        for g in _graphic_items(fp):
            layer = str(value(g, 'layer', ''))
            if layer in SILK_COURTYARD:
                got = _shape(g, tf)
                if got:
                    graphics.append({'layer': layer, 'ref': ref, 'pts': got[0], 'closed': got[1],
                                     'w': _stroke_width(g), 'fill': got[1] and _filled(g)})
            elif layer == 'Edge.Cuts':
                got = _shape(g, tf)
                if got:
                    edges.append(got)
        pads = [_pad(pad, fx, fy, fa) for pad in children(fp, 'pad')]
        fps.append({'ref': ref, 'lib': str(fp[1]) if len(fp) > 1 else '', 'x': fx, 'y': fy, 'rot': fa,
                    'layer': str(value(fp, 'layer', '')), 'locked': any(c == 'locked' for c in fp[1:3]) or value(fp, 'locked') == 'yes',
                    'props': props, 'attrs': attrs, 'pads': pads})
    return fps


def _zone(z) -> dict:
    net = str(value(z, 'net_name', '') or value(z, 'net', '') or '')
    name = str(value(z, 'name', '') or '')
    ko = child(z, 'keepout')
    rule_area = ko is not None                      # KiCad: a (keepout ...) block makes the zone a rule area
    allow = None
    if rule_area:
        allow = {k: str(value(ko, k, 'allowed')) != 'not_allowed' for k in KEEPOUT_ITEMS}
    polygons = [[_xy(p) for p in children(child(poly, 'pts') or [], 'xy')] for poly in children(z, 'polygon')]
    filled = [{'layer': str(value(fp, 'layer')), 'pts': [_xy(p) for p in children(child(fp, 'pts') or [], 'xy')]}
              for fp in children(z, 'filled_polygon')]
    return {'net': net, 'name': name, 'layers': _layers(z), 'rule_area': rule_area,
            'keepout': bool(allow) and not all(allow.values()), 'allow': allow,
            'outline': polygons[0] if polygons else [], 'polygons': polygons, 'filled': filled}


def load(path: str | Path) -> dict:
    return from_tree(parse(Path(path).read_text(encoding='utf-8')))


def from_tree(root) -> dict:
    tracks, vias = [], []
    for seg in children(root, 'segment'):
        (x1, y1), (x2, y2) = _xy(child(seg, 'start')), _xy(child(seg, 'end'))
        tracks.append({'x1': x1, 'y1': y1, 'x2': x2, 'y2': y2, 'w': _f(value(seg, 'width')),
                       'layer': str(value(seg, 'layer')), 'net': str(value(seg, 'net', '') or '')})
    for arc in children(root, 'arc'):
        pts = _arc_points(_xy(child(arc, 'start')), _xy(child(arc, 'mid')), _xy(child(arc, 'end')), 8)
        for (x1, y1), (x2, y2) in zip(pts, pts[1:]):
            tracks.append({'x1': x1, 'y1': y1, 'x2': x2, 'y2': y2, 'w': _f(value(arc, 'width')),
                           'layer': str(value(arc, 'layer')), 'net': str(value(arc, 'net', '') or '')})
    for v in children(root, 'via'):
        x, y = _xy(child(v, 'at'))
        vias.append({'x': x, 'y': y, 'd': _f(value(v, 'size')), 'drill': _f(value(v, 'drill')),
                     'layers': _layers(v), 'net': str(value(v, 'net', '') or '')})
    zones = [_zone(z) for z in children(root, 'zone')]
    graphics: list[dict] = []
    edges: list[tuple[list, bool]] = []
    ident = _fp_transform(0.0, 0.0, 0.0)
    for g in _graphic_items(root):
        layer = str(value(g, 'layer', ''))
        if layer == 'Edge.Cuts' or layer in SILK_COURTYARD:
            got = _shape(g, ident)
            if not got:
                continue
            if layer == 'Edge.Cuts':
                edges.append(got)
            else:
                graphics.append({'layer': layer, 'ref': '', 'pts': got[0], 'closed': got[1],
                                 'w': _stroke_width(g), 'fill': got[1] and _filled(g)})
    footprints = _footprints(root, graphics, edges)
    outline = [pts for pts, closed in edges if closed] + _join([pts for pts, closed in edges if not closed])
    layers = [str(l[1]) for l in (child(root, 'layers') or [])[1:] if isinstance(l, list) and len(l) > 1]
    return {
        'layers': layers,
        'outline': outline,
        'outline_open': sum(1 for c in outline if not _is_closed(c)),
        'footprints': footprints,
        'tracks': tracks,
        'vias': vias,
        'zones': zones,
        'graphics': graphics,
    }


def bbox(geo: dict) -> tuple[float, float, float, float]:
    """Board extent: the outline, else every pad, track, via and zone; (0, 0, 0, 0) for an empty board."""
    pts = [p for line in geo['outline'] for p in line]
    if not pts:
        pts = [(p['x'], p['y']) for f in geo['footprints'] for p in f['pads']]
        pts += [(t[k], t[k.replace('x', 'y')]) for t in geo['tracks'] for k in ('x1', 'x2')]
        pts += [(v['x'], v['y']) for v in geo['vias']]
        pts += [p for z in geo['zones'] for poly in z.get('polygons', [z['outline']]) for p in poly]
    if not pts:
        return 0.0, 0.0, 0.0, 0.0
    xs, ys = [p[0] for p in pts], [p[1] for p in pts]
    return min(xs), min(ys), max(xs), max(ys)
