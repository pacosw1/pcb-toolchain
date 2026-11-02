"""Router congestion at the pins of a unit, for the repair rank (repair.py --rank hot).

Why (README "Repair rank by router congestion", tools/router/reports/2026-11-01-congestion.md): the router writes a
congestion map with each route (tools/router/DESIGN.md 5d, OUT.iotroute/congestion.json). On 8 failed NET-CORE routes
the open sat at a signal pad in the top 9 % of the PathFinder history of its own route in 7 cases (1-2 mm cells); the
8th was walled in by fixed copper, where the router never negotiated. The history of the previous step did not predict
the routed length or the opens of the next step (no search cost term: see the report).

Map: from_route(path) = {'origin': [x0, y0], 'cell': mm, 'nx', 'ny', 'h': [ny * nx]} (world mm): per cell the history
summed over the routable layers. Pins: the pad centres (net['pts']) of the signal nets (not cohesion, not plane nets),
as wirelen.py. Model.value(unit, x, y, r) = sum of h at the cells of the unit's pins at that pose (0 outside the map).
"""
import json


def from_route(path):
    """The history map of a router congestion.json (schema iot-lab.route-congestion.v0)."""
    with open(path) as fh:
        m = json.load(fh)
    if m.get('schema') != 'iot-lab.route-congestion.v0':
        raise ValueError('%s: not a router congestion map' % path)
    h = [0.0] * (m['nx'] * m['ny'])
    for layer in m['layers']:
        for c, v in enumerate(layer['hist']):
            h[c] += v
    return {'origin': list(m['origin']), 'cell': m['cell'], 'nx': m['nx'], 'ny': m['ny'], 'h': [round(v, 4) for v in h]}


class Model:
    """Per-unit local pin points for the 4 turns; value(i, x, y, r) = sum of h at the pins of unit i at the pose."""

    def __init__(self, pr, cmap):
        from .cost import rot_pt
        self.map = cmap
        planes = set(pr.get('plane_nets') or ())
        pts = {}
        for n in pr['nets']:
            if n.get('cohesion') or n['name'] in planes:
                continue
            for i, q in enumerate(n['pins']):
                loc = [tuple(p) for p in n['pts'][i]] if n.get('pts') is not None else [((q[1] + q[3]) / 2, (q[2] + q[4]) / 2)]
                pts.setdefault(q[0], []).extend(loc)
        self.lpts = {u: [[rot_pt(a, b, r) for a, b in loc] for r in range(4)] for u, loc in pts.items()}

    def h_at(self, x, y):
        g = self.map
        i = int((x - g['origin'][0]) // g['cell'])
        j = int((y - g['origin'][1]) // g['cell'])
        if 0 <= i < g['nx'] and 0 <= j < g['ny']:
            return g['h'][j * g['nx'] + i]
        return 0.0

    def value(self, u, x, y, r):
        if u not in self.lpts:
            return 0.0
        return sum(self.h_at(a + x, b + y) for a, b in self.lpts[u][int(r) % 4])
