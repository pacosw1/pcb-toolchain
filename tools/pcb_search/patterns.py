"""Cheap deterministic same-layer L/Z routing, before costly topology search.

Proposals only: conservative rectangular obstacles, no vias/planes/pairs/curves.
Success here is geometric feasibility in this model, never a native DRC pass.
"""
from dataclasses import dataclass
import math
import time

from .contracts import Problem, number


@dataclass(frozen=True)
class Route:
    connection: str
    net: str
    layer: str
    width: float
    points: tuple

    @property
    def length(self):
        return sum(math.dist(a, b) for a, b in zip(self.points, self.points[1:]))


def _axis_distance(a0, a1, b0, b1):
    return max(b0 - a1, a0 - b1, 0.)


def _segment_box(a, b):
    if a[0] != b[0] and a[1] != b[1]:
        raise ValueError('pattern kernel only supports orthogonal segments')
    return min(a[0], b[0]), min(a[1], b[1]), max(a[0], b[0]), max(a[1], b[1])


def _distance(a, b):
    # Exact minimum distance between axis-aligned segments/rectangles.
    return math.hypot(_axis_distance(a[0], a[2], b[0], b[2]),
                      _axis_distance(a[1], a[3], b[1], b[3]))


def blockers(problem, route, retained=(), *, deadline=None, clock=time.monotonic):
    def check_time():
        if deadline is not None and clock() >= deadline:
            raise TimeoutError('pattern geometry budget exhausted')

    check_time()
    rules = {r.name: r for r in problem.nets}
    rule = rules[route.net]
    if route.layer not in rule.layers or route.width != rule.width:
        raise ValueError('route violates its width/layer contract')
    bad = set()
    margin = problem.edge_clearance + route.width / 2
    x0, y0, x1, y1 = problem.bounds
    if any(not (x0 + margin <= x <= x1 - margin and y0 + margin <= y <= y1 - margin)
           for x, y in route.points):
        bad.add('board_edge')
    for a, b in zip(route.points, route.points[1:]):
        seg = _segment_box(a, b)
        for ob in problem.obstacles:
            check_time()
            if route.layer not in ob.layers or (ob.net and ob.net == route.net):
                continue
            gap = problem.gap(route.net, ob.net, ob.clearance)
            if _distance(seg, ob.bounds) < route.width / 2 + gap:
                bad.add(ob.name)
        for old in retained:
            check_time()
            if old.layer != route.layer or old.net == route.net:
                continue
            gap = problem.gap(route.net, old.net) + (route.width + old.width) / 2
            if any(_distance(seg, _segment_box(c, d)) < gap for c, d in zip(old.points, old.points[1:])):
                bad.add('route:' + old.connection)
    check_time()
    return sorted(bad)


def patterns(connection):
    a, b = connection.start, connection.end
    mx, my = (a[0] + b[0]) / 2, (a[1] + b[1]) / 2
    candidates = [(a, (a[0], b[1]), b), (a, (b[0], a[1]), b),
                  (a, (mx, a[1]), (mx, b[1]), b), (a, (a[0], my), (b[0], my), b)]
    seen = set()
    for ps in candidates:
        path = tuple(p for i, p in enumerate(ps) if i == 0 or p != ps[i - 1])
        if len(path) == 1:
            path = (path[0], path[0])
        if path not in seen:
            seen.add(path)
            yield path


def route_patterns(problem, *, budget_s, clock=time.monotonic):
    if not isinstance(problem, Problem):
        raise TypeError('validated Problem required')
    budget_s = number(budget_s, 'budget_s', positive=True)
    start = clock()
    output = {'schema': 'iot-lab.pattern-route.v1', 'input_sha256': problem.identity,
              'qualified': False, 'routes': [], 'unresolved': [], 'attempts': 0,
              'native_validation_required': True}
    if problem.unsupported:
        output.update(status='unsupported', unsupported=list(problem.unsupported),
                      elapsed_s=clock() - start)
        output['unresolved'] = [{'connection': c.name, 'net': c.net, 'reason': 'unsupported_constraints'}
                                for c in problem.connections]
        return output
    rules = {n.name: n for n in problem.nets}
    retained = []
    # Constrained-layer and wider connections first; no hidden randomized restarts.
    order = sorted(problem.connections, key=lambda c: (len(c.layers), -rules[c.net].width, c.name))
    timed_out = False
    for c in order:
        tried_blockers = set()
        chosen = None
        for layer in c.layers:
            for path in patterns(c):
                if clock() - start >= budget_s:
                    timed_out = True
                    break
                proposed = Route(c.name, c.net, layer, rules[c.net].width, path)
                output['attempts'] += 1
                try:
                    found = blockers(problem, proposed, retained, deadline=start + budget_s, clock=clock)
                except TimeoutError:
                    timed_out = True
                    break
                if not found:
                    chosen = proposed
                    break
                tried_blockers.update(found)
            if chosen or timed_out:
                break
        if chosen:
            retained.append(chosen)
        else:
            output['unresolved'].append({'connection': c.name, 'net': c.net,
                'reason': 'budget' if timed_out else 'patterns_exhausted',
                'blockers': sorted(tried_blockers), 'unroutable_proven': False})
    output['routes'] = [dict(connection=r.connection, net=r.net, layer=r.layer,
                             width=r.width, points=r.points, length_mm=r.length) for r in retained]
    output.update(status='timeout' if timed_out else 'candidate', elapsed_s=clock() - start)
    return output
