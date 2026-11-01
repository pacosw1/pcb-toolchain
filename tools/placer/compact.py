"""Compaction mode (easy to hard): place with large routing halos, route, shrink the halos while it routes.

Pure core (no pcbnew, no network): the halo formula, halos as hard spacing, the virtual board scale,
the shrink/bisect schedule and the verdict. The driver (cli.py compact) runs search and routing on Hetzner.

halo(unit) = s * pitch * sqrt(fan-out), fan-out = nets that connect the unit to other units
(power/ground nets are not in the problem: they go to planes). Same form as KiCadRoutingTools
placement/quench.py (base + coef * sqrt(pins)), with the track + clearance pitch as coefficient.
"""
import copy
import math
from mandatory_preflight import ImmutableInputFailure

HALO = {
    'pitch': 0.4,  # mm per escaping track: 0.2 mm track + 0.2 mm clearance (JLC 4-layer standard class)
    'fill': 0.5,   # usable fraction of the board area for the grown units (the rest is channels and edge)
}


def halo(fanout, s, pitch=None):
    return s * (HALO['pitch'] if pitch is None else pitch) * math.sqrt(max(fanout, 0))


def fanout(pr):
    n = [0] * len(pr['units'])
    for net in pr['nets']:
        if net.get('cohesion'):  # a virtual group net is not an escaping track
            continue
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
                'not established; inspect congestion, pin escape and effective rules' % (t['s'], t['unrouted']))
    real = [t for t in ok if t['k'] <= 1.0 + 1e-9]
    if real:
        t = min(real, key=lambda t: t['s'])
        return 'fits in %.1f x %.1f mm at halo scale s = %.2f (unrouted %d)' % (size[0], size[1], t['s'], t['unrouted'])
    t = min(ok, key=lambda t: t['k'])
    return ('needs %.1f x %.1f mm (board scale %.3f) at halo scale s = %.2f; it does not route on the real outline'
            % (size[0] * t['k'], size[1] * t['k'], t['k'], t['s']))


REAL_S = (1.0, 0.5, 0.25, 0.0)  # real phase: halo scales tried on the real outline, the largest first
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


class RouteOutcome(list):
    """Counts plus a diagnostic handoff; list compatibility keeps old benches usable.

    A clean routing-step count may advance the schedule. A failed route may advance
    only when its driver has attributed a concrete bounded geometry update.
    This is routing-search evidence, never a configured gate or qualification.
    """
    def __init__(self, counts, decision, *, candidate=None, geometry_feedback=False, scoped_skipped_opens=False):
        super().__init__(counts)
        self.decision = copy.deepcopy(decision)
        self.candidate = copy.deepcopy(candidate)
        hard = {'schematic_parity', 'constraints_unknown', 'native_geometry', 'native_router_disagreement'}
        kinds = {row.get('classification') for row in decision.get('findings', [])}
        known = (decision.get('status') == 'diagnosed' and bool(kinds) and not kinds & hard
                 and kinds <= {'native_open', 'escape_failure', 'model_enclosed', 'router_miss', 'no_routing_defect'})
        complete = kinds == {'no_routing_defect'} and decision.get('action') == 'continue_native_validation'
        scoped = (scoped_skipped_opens and kinds == {'native_open'}
                  and decision.get('action') == 'diagnose_selected_connections')
        self.routing_step_clean = bool(self) and min(self) == 0 and known and (complete or scoped)
        feedback = (geometry_feedback and known and decision.get('action') in
                    ('inspect_escape', 'diagnose_selected_connections'))
        self.stop = not (self.routing_step_clean or feedback)


def run_loop(pr, size, search, write, route, s0=4.0, budget=2700.0, clock=None, target=0, shrink=0.85, tol=0.05,
             log=None, s_min=0.05, real_first=False, diagnostic_budget=None, k_cap=None):
    """Easy-to-hard loop. Injected effects: search(problem, step) -> optimize() result;
    write(problem, pose, k, step) -> board path; route(path, step) -> counts or RouteOutcome.
    Halo phase: s from s0, board scale k from the grown area (larger on an illegal result). A step passes when
    the best router run leaves <= target unrouted. Outline phase (when the best pass has k > 1): the real board
    (k = 1) first, then bisect k between the last fail and the best pass; s = outline_s. When the bare parts
    do not fit the real board (bare_scale > 1), the bisection starts between bare_scale and the best pass.
    Stops when both phases are done or when `budget` seconds have passed before a step starts.
    k_cap (2026-11-01): the halo phase uses at most this board scale and does not grow it (k_cap 1: every step on
    the real outline). Reason: a rigid block counts its whole border box in the area model, so NET-CORE with its
    spread blocks got k 1.02-1.05 at every halo, and a virtual-board step is not a candidate for the real board.
    real_first (2026-10-03): a real phase goes first. It places on the real outline (k = 1) with the largest
    halo that gives a legal placement (s_fit, then REAL_S) and routes it. The first step that routes ends the
    loop (no virtual board). If no step routes, the halo and outline phases follow and tell how much larger
    the board must be.
    Reason: DOOR-RELAY routed on its real outline, but the virtual phases said that it needs 112 x 80 mm;
    on a virtual board the fixed connectors stay at their places, so the added area is an empty band."""
    import time
    import subprocess
    clock = clock or time.monotonic
    t0 = clock()
    steps = []

    def over():
        return clock() - t0 >= budget

    def step(s, k, grow, phase):
        n = len(steps)
        q = with_halos(pr, s)
        for tries in range(1, TRIES + 1):
            try:
                res = search(virtual(q, k), n)
            except subprocess.TimeoutExpired:
                t = dict(s=s, k=k, tries=tries, cost=None, illegal=['placement deadline'], phase=phase,
                         history=[], pose=None, halo=[], runs=[], unrouted=None, passed=False, board=None,
                         status='timeout')
                steps.append(t)
                return t
            if res is None:  # no search result (remote timeout): a failed step, not an exception
                res = {'candidates': [{'pose': None, 'cost': float('nan'), 'illegal': ['no search result']}]}
                c = res['candidates'][0]
                break
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
            try:
                if over():
                    raise subprocess.TimeoutExpired('routing', 0)
                outcome = route(t['board'], n)
                t['runs'] = list(outcome)
                t['unrouted'] = min(t['runs'])
                t['passed'] = t['unrouted'] <= target
                if isinstance(outcome, RouteOutcome):
                    t['route_decision'] = outcome.decision
                    t['routed_candidate'] = outcome.candidate
                    t['passed'] = t['passed'] and outcome.routing_step_clean
                    if outcome.stop:
                        t.update(status='routing-decision', passed=False,
                                 next_action=outcome.decision)
            except subprocess.TimeoutExpired:
                t.update(runs=[], unrouted=None, passed=False, status='timeout')
            except ImmutableInputFailure as exc:
                t.update(runs=[], unrouted=None, passed=False, status='immutable-input',
                         failure_receipt=exc.path, immutable_faults=exc.receipt['faults'])
        steps.append(t)
        if log:
            log('step %d %s s %.3f k %.3f cost %.1f illegal %d runs %s -> %s' % (
                n, phase, s, k, c['cost'], len(c['illegal']), t['runs'], 'PASS' if t['passed'] else 'FAIL'))
        return t

    def terminal_stop(result):
        if result.get('status') == 'immutable-input':
            return 'immutable input mandatory rules'
        if result.get('status') == 'routing-decision':
            return 'routing diagnosis: ' + result['route_decision'].get('action', 'inspect_evidence')
        return None

    def finish(stop):
        ok = [t for t in steps if t['passed']]
        summary = [{kk: t[kk] for kk in ('s', 'k', 'unrouted', 'passed')} for t in steps]
        for row in summary:
            row['unrouted'] = -1 if row['unrouted'] is None else row['unrouted']
        handoff = next((t for t in reversed(steps) if t.get('status') == 'routing-decision'), None)
        return dict(steps=steps,
            best=min(ok, key=lambda t: (t['k'], t['s'])) if ok and stop != 'immutable input mandatory rules' else None,
            verdict=stop if handoff or stop == 'immutable input mandatory rules' else verdict(summary, size), stop=stop,
            next_action=handoff.get('next_action') if handoff else None,
            retained_candidate=handoff.get('routed_candidate') if handoff else None,
            qualified=False)

    stop = 'schedule done'
    if real_first:
        # The area model (fill 0.5) is conservative: DOOR-RELAY and MC-MAIN give s_fit(k = 1) = 0, but a search
        # on the real outline is legal. So the real phase tries a short list of halo scales, the largest first,
        # and keeps the first legal placement that routes. An illegal or failed step goes to the next smaller s.
        first = s_fit(pr, 1.0, s0)
        for s1 in ([first] if first >= s_min else []) + [x for x in REAL_S if x < max(first, s_min) or first < s_min]:
            if over():
                stop = 'time budget %.0f s' % budget
                break
            result = step(s1, 1.0, False, 'real')
            if terminal_stop(result):
                stop = terminal_stop(result)
                break
            if result['passed']:
                break
        ok = [t for t in steps if t['passed']]
        if ok or stop != 'schedule done':
            return finish(stop)
    # Retain low-density/virtual diagnostics, with their own explicit budget.
    # The injected driver also bounds each child, so a step cannot overrun it.
    if diagnostic_budget is not None:
        budget = min(budget, clock() - t0 + diagnostic_budget)
    sch = Schedule(s0, shrink, tol, s_min)
    while not sch.done:
        if over():
            stop = 'time budget %.0f s' % budget
            break
        k = board_scale(with_halos(pr, sch.s))
        result = step(sch.s, k if k_cap is None else min(k, k_cap), k_cap is None, 'halo')
        if terminal_stop(result):
            stop = terminal_stop(result)
            break
        sch.report(result['passed'])
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
            if terminal_stop(t):
                stop = terminal_stop(t)
                break
            if t['passed']:
                hi = k
            else:
                lo = k
            k = (lo + hi) / 2
    return finish(stop)
