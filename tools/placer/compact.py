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


def _unit_need(u):
    """Area a unit takes with its spacing: a block counts its border box once (its parts are inside) plus the
    part of any rect beyond the border (a rule area); a single part counts each rect."""
    if not u.get('box'):
        return sum((r[2] - r[0] + r[4]) * (r[3] - r[1] + r[4]) for r in u['rects'])
    b = [u['box'][0] - u['x'], u['box'][1] - u['y'], u['box'][2] - u['x'], u['box'][3] - u['y']]
    c = max([r[4] for r in u['rects']] + [0.0])
    out = 0.0
    for r in u['rects']:
        inner = (max(0.0, min(r[2], b[2]) - max(r[0], b[0])) * max(0.0, min(r[3], b[3]) - max(r[1], b[1])))
        out += (r[2] - r[0]) * (r[3] - r[1]) - inner
    return (b[2] - b[0] + c) * (b[3] - b[1] + c) + out


def _raw_scale(pr):
    need = sum(_unit_need(u) for u in pr['units'])
    return math.sqrt(need / HALO['fill'] / _area(pr['board']['outline']))


def board_scale(pr):
    """Linear scale of the virtual board: 1 when the grown units fit in `fill` of the board area."""
    return max(1.0, _raw_scale(pr))


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
        if t['unrouted'] < 0:
            return ('no legal placement at the largest halo scale s = %.2f (board scale %.2f): lower --s0 or give '
                    'the search more steps' % (t['s'], t['k']))
        return ('does not route fully even at the largest halo scale s = %.2f (unrouted %d): the cause is '
                'pin order or layer rules, not placement' % (t['s'], t['unrouted']))
    real = [t for t in ok if t['k'] <= 1.0 + 1e-9]
    if real:
        t = min(real, key=lambda t: t['s'])
        return 'fits in %.1f x %.1f mm at halo scale s = %.2f (unrouted %d)' % (size[0], size[1], t['s'], t['unrouted'])
    t = min(ok, key=lambda t: t['k'])
    return ('needs %.1f x %.1f mm (board scale %.3f) at halo scale s = %.2f; it does not route on the real outline'
            % (size[0] * t['k'], size[1] * t['k'], t['k'], t['s']))


GROW, TRIES = 1.15, 3  # an illegal search result: same s again on a 15 % larger virtual board, up to 3 tries


def s_fit(pr, k, s_hi, iters=40):
    """Largest halo scale s <= s_hi whose grown units fit a board of scale k (board_scale <= k); 0 if none."""
    def fits(s):
        return _raw_scale(with_halos(pr, s)) <= k + 1e-9
    if fits(s_hi):
        return s_hi
    lo, hi = 0.0, s_hi
    for _ in range(iters):
        mid = (lo + hi) / 2
        lo, hi = (mid, hi) if fits(mid) else (lo, mid)
    return lo


def bare_scale(pr):
    """Board scale below which the parts with no halo cannot fit, even at 100 % fill."""
    return _raw_scale(with_halos(pr, 0.0)) * math.sqrt(HALO['fill'])


def outline_s(pr, k, best, k_floor):
    """Halo scale for an outline step at board scale k: the largest that fits k (s_fit); when no halo fits,
    s goes down linearly from the best pass (at best['k']) to 0 at the bare-parts floor k_floor."""
    s = s_fit(pr, k, best['s'])
    if s > 0.0 or k_floor < 1.0:
        return s
    return best['s'] * (k - k_floor) / (best['k'] - k_floor)


K_TOL = 0.02  # the outline phase stops when the board scale gap is below 2 %


def run_loop(pr, size, search, write, route, s0=4.0, budget=2700.0, clock=None, target=0, shrink=0.85, tol=0.05,
             log=None, s_min=0.05):
    """Easy-to-hard loop. Injected effects: search(problem, step) -> optimize() result;
    write(problem, pose, k, step) -> board path; route(path, step) -> [unrouted per router run].
    Halo phase: s from s0, board scale k from the grown area (larger on an illegal result). A step passes when
    the best router run leaves <= target unrouted. Outline phase (when the best pass has k > 1): the real board
    (k = 1) first, then bisect k between the last fail and the best pass; s = outline_s. When the bare parts
    do not fit the real board (bare_scale > 1), the bisection starts between bare_scale and the best pass.
    Stops when both phases are done or when `budget` seconds have passed before a step starts."""
    import time
    clock = clock or time.monotonic
    t0 = clock()
    steps = []

    def over():
        return clock() - t0 >= budget

    def step(s, k, grow, phase):
        n = len(steps)
        q = with_halos(pr, s)
        for tries in range(1, TRIES + 1):
            res = search(virtual(q, k), n)
            c = res['candidates'][0]
            if not c['illegal'] or not grow or tries == TRIES or over():
                break
            k *= GROW
        t = {'s': s, 'k': k, 'tries': tries, 'cost': c['cost'], 'illegal': c['illegal'], 'phase': phase,
             'history': res.get('history', []), 'pose': c['pose'],
             'halo': [u['rects'][0][4] if u['rects'] else 0.0 for u in q['units']]}
        if c['illegal']:
            t.update(runs=[], unrouted=None, passed=False, board=None)
        else:
            t['board'] = write(q, c['pose'], k, n)
            t['runs'] = route(t['board'], n)
            t['unrouted'] = min(t['runs'])
            t['passed'] = t['unrouted'] <= target
        steps.append(t)
        if log:
            log('step %d %s s %.3f k %.3f cost %.1f illegal %d runs %s -> %s' % (
                n, phase, s, k, c['cost'], len(c['illegal']), t['runs'], 'PASS' if t['passed'] else 'FAIL'))
        return t

    stop = 'schedule done'
    sch = Schedule(s0, shrink, tol, s_min)
    while not sch.done:
        if over():
            stop = 'time budget %.0f s' % budget
            break
        sch.report(step(sch.s, board_scale(with_halos(pr, sch.s)), True, 'halo')['passed'])
    passed = [t for t in steps if t['passed']]
    if passed and stop == 'schedule done':
        best = min(passed, key=lambda t: (t['k'], t['s']))
        k_floor = bare_scale(pr)
        hi, lo = best['k'], max(1.0, k_floor)
        k = 1.0 if k_floor < 1.0 else (lo + hi) / 2  # the real board first, when the bare parts fit it
        while hi > 1.0 + 1e-9 and (hi - lo) / hi >= K_TOL:
            if over():
                stop = 'time budget %.0f s' % budget
                break
            t = step(outline_s(pr, k, best, k_floor), k, False, 'outline')
            if t['passed']:
                hi = k
            else:
                lo = k
            k = (lo + hi) / 2
    ok = [t for t in steps if t['passed']]
    summary = [{kk: t[kk] for kk in ('s', 'k', 'unrouted', 'passed')} for t in steps]
    for t in summary:
        t['unrouted'] = -1 if t['unrouted'] is None else t['unrouted']
    return {'steps': steps, 'best': min(ok, key=lambda t: (t['k'], t['s'])) if ok else None,
            'verdict': verdict(summary, size), 'stop': stop}
