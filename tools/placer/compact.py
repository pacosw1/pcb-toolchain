"""Compaction mode (easy to hard): place with large routing halos, route, shrink the halos while it routes.

Pure core (no pcbnew, no network): the halo formula, halos as hard spacing, the virtual board scale,
the shrink/bisect schedule and the verdict. The driver (cli.py compact) runs search and routing on Hetzner.

halo(unit) = s * pitch * sqrt(fan-out), fan-out = nets that connect the unit to other units
(power/ground nets are not in the problem: they go to planes). Same form as KiCadRoutingTools
placement/quench.py (base + coef * sqrt(pins)), with the track + clearance pitch as coefficient.
"""
import copy
import math

HALO = {
    'pitch': 0.4,  # mm per escaping track: 0.2 mm track + 0.2 mm clearance (JLC 4-layer standard class)
    'fill': 0.5,   # usable fraction of the board area for the grown units (the rest is channels and edge)
}


def halo(fanout, s, pitch=None):
    return s * (HALO['pitch'] if pitch is None else pitch) * math.sqrt(max(fanout, 0))


def fanout(pr):
    n = [0] * len(pr['units'])
    for net in pr['nets']:
        us = {q[0] for q in net['pins']}
        if len(us) > 1:
            for u in us:
                n[u] += 1
    return n


def with_halos(pr, s, pitch=None):
    """Copy of the problem with each rect spacing = max(D-040 spacing, halo of its unit)."""
    q = copy.deepcopy(pr)
    for u, f in zip(q['units'], fanout(pr)):
        h = halo(f, s, pitch)
        for r in u['rects']:
            r[4] = max(r[4], h)
    return q


def _area(poly):
    return abs(sum(a[0] * b[1] - b[0] * a[1] for a, b in zip(poly, poly[1:] + poly[:1]))) / 2


def board_scale(pr):
    """Linear scale of the virtual board: 1 when the grown units fit in `fill` of the board area."""
    need = sum((r[2] - r[0] + r[4]) * (r[3] - r[1] + r[4]) for u in pr['units'] for r in u['rects'])
    return max(1.0, math.sqrt(need / HALO['fill'] / _area(pr['board']['outline'])))


def virtual(pr, k):
    """Copy of the problem with the outline and move box scaled by k about the outline centre."""
    if k == 1.0:
        return pr
    q = copy.deepcopy(pr)
    xs = [p[0] for p in pr['board']['outline']]
    ys = [p[1] for p in pr['board']['outline']]
    cx, cy = (min(xs) + max(xs)) / 2, (min(ys) + max(ys)) / 2

    def sc(x, y):
        return [cx + (x - cx) * k, cy + (y - cy) * k]
    q['board']['outline'] = [sc(*p) for p in pr['board']['outline']]
    if pr.get('move_box'):
        b = pr['move_box']
        q['move_box'] = sc(b[0], b[1]) + sc(b[2], b[3])
    return q


class Schedule:
    """s0 first; on a pass shrink by `shrink` until the first fail, then bisect between the last pass and
    the last fail. Done when the gap is below tol of the pass value, at s_min, or at a fail with no pass."""

    def __init__(self, s0, shrink=0.85, tol=0.05, s_min=0.05):
        self.s, self.shrink, self.tol, self.s_min = s0, shrink, tol, s_min
        self.best = None   # smallest passing s
        self.fail = None   # largest failing s below best
        self.done = False

    def report(self, passed):
        if passed:
            self.best = self.s
        else:
            self.fail = self.s
            if self.best is None:
                self.done = True
                return
        if self.fail is None:
            nxt = self.s * self.shrink
        else:
            if (self.best - self.fail) / self.best < self.tol:
                self.done = True
                return
            nxt = (self.best + self.fail) / 2
        if nxt < self.s_min:
            self.done = True
            return
        self.s = nxt


def verdict(steps, size):
    """steps: [{s, k, unrouted, passed}]; size: (w, h) of the real board in mm."""
    if not steps:
        return 'no step ran (time budget?)'
    ok = [t for t in steps if t['passed']]
    if not ok:
        t = steps[0]
        return ('does not route fully even at the largest halo scale s = %.2f (unrouted %d): the cause is '
                'pin order or layer rules, not placement' % (t['s'], t['unrouted']))
    real = [t for t in ok if t['k'] <= 1.0 + 1e-9]
    if real:
        t = min(real, key=lambda t: t['s'])
        return 'fits in %.1f x %.1f mm at halo scale s = %.2f (unrouted %d)' % (size[0], size[1], t['s'], t['unrouted'])
    t = min(ok, key=lambda t: t['k'])
    return ('needs %.1f x %.1f mm (board scale %.3f) at halo scale s = %.2f; it does not route on the real outline'
            % (size[0] * t['k'], size[1] * t['k'], t['k'], t['s']))
