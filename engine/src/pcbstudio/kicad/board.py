"""Board geometry from a .kicad_pcb file, for the viewer (and later the checks). Read only; plain dicts.

Coordinates are KiCad board mm (y down). A footprint pad's `(at x y a)` is relative to the footprint origin, rotated
by the footprint angle; the pad angle in the file is already absolute.
"""
from __future__ import annotations

import math
from pathlib import Path

from .sexpr import child, children, parse, value


def _f(x) -> float:
    return float(x)


def _xy(node) -> tuple[float, float]:
    return _f(node[1]), _f(node[2])


def _rot(x: float, y: float, deg: float) -> tuple[float, float]:
    """KiCad rotation (positive = counter-clockwise on screen, y down)."""
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
    return [(ux + r * math.cos(a1 + total * k / segs), uy + r * math.sin(a1 + total * k / segs)) for k in range(segs + 1)]


def _outline(root) -> list[list[tuple[float, float]]]:
    """Edge.Cuts as polylines (lines, arcs, rects, circles, polys); not joined into loops (the viewer just draws)."""
    out = []
    for g in root:
        if not isinstance(g, list) or not g or str(g[0]) not in ('gr_line', 'gr_arc', 'gr_rect', 'gr_circle', 'gr_poly'):
            continue
        if value(g, 'layer') != 'Edge.Cuts':
            continue
        kind = str(g[0])
        if kind == 'gr_line':
            out.append([_xy(child(g, 'start')), _xy(child(g, 'end'))])
        elif kind == 'gr_arc':
            out.append(_arc_points(_xy(child(g, 'start')), _xy(child(g, 'mid')), _xy(child(g, 'end'))))
        elif kind == 'gr_rect':
            (x0, y0), (x1, y1) = _xy(child(g, 'start')), _xy(child(g, 'end'))
            out.append([(x0, y0), (x1, y0), (x1, y1), (x0, y1), (x0, y0)])
        elif kind == 'gr_circle':
            (cx, cy), (ex, ey) = _xy(child(g, 'center')), _xy(child(g, 'end'))
            r = math.hypot(ex - cx, ey - cy)
            out.append([(cx + r * math.cos(2 * math.pi * k / 48), cy + r * math.sin(2 * math.pi * k / 48)) for k in range(49)])
        else:
            pts = [_xy(p) for p in children(child(g, 'pts') or [], 'xy')]
            out.append(pts + pts[:1])
    return out


def _footprints(root) -> list[dict]:
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
        pads = []
        for pad in children(fp, 'pad'):
            pat = child(pad, 'at')
            px, py = _xy(pat)
            pa = _f(pat[3]) if len(pat) > 3 else fa
            dx, dy = _rot(px, py, fa)
            size = child(pad, 'size')
            drill = child(pad, 'drill')
            dval = None
            if drill is not None:
                nums = [v for v in drill[1:] if not isinstance(v, list) and str(v) != 'oval']
                dval = _f(nums[0]) if nums else None
            pads.append({
                'num': str(pad[1]), 'type': str(pad[2]), 'shape': str(pad[3]),
                'x': round(fx + dx, 4), 'y': round(fy + dy, 4), 'rot': pa,
                'w': _f(size[1]) if size else 0.0, 'h': _f(size[2]) if size and len(size) > 2 else 0.0,
                'layers': _layers(pad), 'net': str(value(pad, 'net', '') or ''), 'drill': dval,
                'rratio': _f(value(pad, 'roundrect_rratio', 0) or 0),
            })
        fps.append({'ref': ref, 'lib': str(fp[1]) if len(fp) > 1 else '', 'x': fx, 'y': fy, 'rot': fa,
                    'layer': str(value(fp, 'layer', '')), 'locked': any(c == 'locked' for c in fp[1:3]) or value(fp, 'locked') == 'yes',
                    'props': props, 'attrs': attrs, 'pads': pads})
    return fps


def load(path: str | Path) -> dict:
    root = parse(Path(path).read_text(encoding='utf-8'))
    tracks, vias, zones = [], [], []
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
    for z in children(root, 'zone'):
        net = str(value(z, 'net_name', '') or value(z, 'net', '') or '')
        rule_area = child(z, 'keepout') is not None or value(z, 'name') in ('PAIR_BREAKOUT',)
        name = str(value(z, 'name', '') or '')
        outline = [_xy(p) for p in children(child(child(z, 'polygon') or [], 'pts') or [], 'xy')]
        filled = []
        for fpoly in children(z, 'filled_polygon'):
            filled.append({'layer': str(value(fpoly, 'layer')),
                           'pts': [_xy(p) for p in children(child(fpoly, 'pts') or [], 'xy')]})
        zones.append({'net': net, 'name': name, 'layers': _layers(z), 'rule_area': rule_area,
                      'outline': outline, 'filled': filled})
    layers = [str(l[1]) for l in (child(root, 'layers') or [])[1:] if isinstance(l, list) and len(l) > 1]
    return {
        'layers': layers,
        'outline': _outline(root),
        'footprints': _footprints(root),
        'tracks': tracks,
        'vias': vias,
        'zones': zones,
    }


def bbox(geo: dict) -> tuple[float, float, float, float]:
    pts = [p for line in geo['outline'] for p in line] or [(p['x'], p['y']) for f in geo['footprints'] for p in f['pads']]
    xs, ys = [p[0] for p in pts], [p[1] for p in pts]
    return min(xs), min(ys), max(xs), max(ys)
