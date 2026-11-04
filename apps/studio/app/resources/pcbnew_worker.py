"""KiCad's own pcbnew, isolated in a subprocess of KiCad's bundled Python. The client is src/main/kicad/pcbnew.ts.

Headless pcbnew can crash or assert, so it never runs inside the engine: the client starts
`<kicad python> -I pcbnew_worker.py --serve` and talks one JSON object per line.

Request  {"id": n, "op": "...", ...params}
Reply    {"id": n, "ok": true, "result": ...} | {"id": n, "ok": false, "error": "..."}

Ops: ping, load {path} -> {board}, query {board, what}, move_footprint {board, ref, x, y, rot?},
save {board, path?}, close {board}, crash {how} (tests only).

It runs on KiCad's Python (3.9), so it uses no newer syntax at run time.
"""
import json
import os
import sys


def _serve() -> None:
    proto = os.fdopen(os.dup(1), 'w', encoding='utf-8', buffering=1)
    os.dup2(2, 1)                                  # stray prints from pcbnew/wx go to stderr, not the protocol
    sys.stdout = sys.stderr
    import wx                                     # noqa: F401  (pcbnew needs an app object headless)
    app = wx.App(False)                            # noqa: F841
    import pcbnew

    boards = {}
    opened = [0]                                   # handles are never reused, even after a close
    mm = pcbnew.ToMM

    def names(cls_prefix):
        return {getattr(pcbnew, k): k[len(cls_prefix):].lower() for k in dir(pcbnew) if k.startswith(cls_prefix)}
    pad_shapes = names('PAD_SHAPE_')
    pad_shapes[1] = 'rect'
    attrs = names('PAD_ATTRIB_')

    def board(p):
        b = boards.get(p.get('board'))
        if b is None:
            raise ValueError('unknown board %r' % p.get('board'))
        return b

    def poly_counts(ps):
        return [{'points': ps.Outline(i).PointCount(), 'holes': ps.HoleCount(i)} for i in range(ps.OutlineCount())]

    def q_pads(b):
        out = []
        for fp in b.GetFootprints():
            for pad in fp.Pads():
                pos, size = pad.GetPosition(), pad.GetSize(pcbnew.F_Cu)
                drill = pad.GetDrillSize()
                bb = pad.GetBoundingBox()
                out.append({'ref': fp.GetReference(), 'num': pad.GetNumber(),
                            'x': mm(pos.x), 'y': mm(pos.y), 'rot': pad.GetOrientationDegrees(),
                            'w': mm(size.x), 'h': mm(size.y),
                            'shape': pad_shapes.get(pad.GetShape(pcbnew.F_Cu), str(pad.GetShape(pcbnew.F_Cu))),
                            'type': attrs.get(pad.GetAttribute(), str(pad.GetAttribute())),
                            'drill': [mm(drill.x), mm(drill.y)] if pad.HasHole() else None,
                            'drill_shape': 'oval' if pad.GetDrillShape() == pcbnew.PAD_DRILL_SHAPE_OBLONG else 'circle',
                            'bbox': [mm(bb.GetX()), mm(bb.GetY()), mm(bb.GetRight()), mm(bb.GetBottom())]})
        return out

    def q_zones(b):
        out = []
        for z in b.Zones():
            filled = {}
            for layer in z.GetLayerSet().Seq():
                if z.HasFilledPolysForLayer(layer):
                    filled[b.GetLayerName(layer)] = z.GetFilledPolysList(layer).OutlineCount()
            item = {'name': z.GetZoneName(), 'net': z.GetNetname(), 'rule_area': bool(z.GetIsRuleArea()),
                    'layers': [b.GetLayerName(l) for l in z.GetLayerSet().Seq()],
                    'outline': poly_counts(z.Outline()), 'filled': filled}
            if z.GetIsRuleArea():
                item['keepout'] = {'tracks': not z.GetDoNotAllowTracks(), 'vias': not z.GetDoNotAllowVias(),
                                   'pads': not z.GetDoNotAllowPads(), 'copperpour': not z.GetDoNotAllowZoneFills(),
                                   'footprints': not z.GetDoNotAllowFootprints()}
            out.append(item)
        return out

    def q_outline(b):
        ps = pcbnew.SHAPE_POLY_SET()
        ok = b.GetBoardPolygonOutlines(ps, False)
        return {'ok': bool(ok), 'outlines': poly_counts(ps)}

    def q_counts(b):
        t = b.GetTracks()
        return {'footprints': len(b.GetFootprints()), 'zones': len(b.Zones()),
                'segments': sum(1 for x in t if x.GetClass() == 'PCB_TRACK'),
                'arcs': sum(1 for x in t if x.GetClass() == 'PCB_ARC'),
                'vias': sum(1 for x in t if x.GetClass() == 'PCB_VIA'),
                'pads': sum(len(fp.Pads()) for fp in b.GetFootprints())}

    queries = {'pads': q_pads, 'zones': q_zones, 'outline': q_outline, 'counts': q_counts}

    def handle(req):
        op = req.get('op')
        if op == 'ping':
            return {'pcbnew': pcbnew.Version(), 'python': sys.version.split()[0]}
        if op == 'load':
            b = pcbnew.LoadBoard(req['path'])
            if b is None:
                raise ValueError('LoadBoard returned nothing for %s' % req['path'])
            opened[0] += 1
            key = 'b%d' % opened[0]
            boards[key] = b
            return {'board': key}
        if op == 'query':
            what = req.get('what', 'counts')
            if what not in queries:
                raise ValueError('unknown query %r (%s)' % (what, ', '.join(sorted(queries))))
            return queries[what](board(req))
        if op == 'move_footprint':
            b = board(req)
            fp = next((f for f in b.GetFootprints() if f.GetReference() == req['ref']), None)
            if fp is None:
                raise ValueError('no footprint %r' % req['ref'])
            fp.SetPosition(pcbnew.VECTOR2I(pcbnew.FromMM(req['x']), pcbnew.FromMM(req['y'])))
            if req.get('rot') is not None:
                fp.SetOrientationDegrees(float(req['rot']))
            return {'ref': req['ref']}
        if op == 'save':
            b = board(req)
            path = req.get('path') or b.GetFileName()
            pcbnew.SaveBoard(path, b)
            return {'path': path}
        if op == 'close':
            boards.pop(req.get('board'), None)
            return {}
        if op == 'crash':
            if req.get('how') == 'exit':
                os._exit(3)
            os.abort()
        raise ValueError('unknown op %r' % op)

    for line in sys.stdin:
        if not line.strip():
            continue
        req = {}
        try:
            req = json.loads(line)
            reply = {'id': req.get('id'), 'ok': True, 'result': handle(req)}
        except Exception as e:                    # an op error is a reply, not a crash
            reply = {'id': req.get('id'), 'ok': False, 'error': '%s: %s' % (type(e).__name__, e)}
        proto.write(json.dumps(reply) + '\n')
        proto.flush()


if __name__ == '__main__' and '--serve' in sys.argv:
    _serve()
