"""Search: simulated annealing on the incremental cost, one run per core, best exchange per epoch.

optimize(problem, params, workers, epochs, steps, seed, top) -> result dict
  0. With params['global'] = 1: analytic global placement (gplace.place) first; the annealer starts from
     its places (pass a low t0 to use the annealer as detailed placement).
     With params['normalize'] = 1: the weights are divided by the start values of their terms (normalized()).
  1. T0 = mean uphill delta of 200 random moves at the full window (or params['t0']).
     T falls geometrically from T0 to T0 * t_ratio over all epochs; the move window falls from
     w0 (half the board) to w1 in the same way. schedule 'lam': T follows the modified Lam feedback
     (Lam, lam_target; base_lam, lam_rate, lam_window) and carries over the epochs of each worker; the window
     is w0 * T / T0 (at least w1), and a unit smaller than area_ref mm2 moves up to area_max times farther.
  2. The spacing and forbidden-area weights grow from w to w * ramp over the epochs (epoch_params).
     Each epoch, each worker runs `steps` moves from its own state with its own seed
     (seed, worker, epoch). After the epoch, the worse half of the workers (by current cost)
     restart from the global best pose. The exchange is synchronous, so a seed gives one result.
  3. The best pose of each worker is legalized (legalize()) and ranked: illegal unit count, then cost.
Moves: translate (dx, dy multiples of params['grid'], unit origin inside problem['move_box'] (region mode)
or else the outline box), rotate 90/180/270 deg,
swap the places of two units whose courtyard areas differ by at most swap_ratio.
"""
import copy
import math
import multiprocessing as mp
import random
import time

from . import cost, mainspath

SEARCH = {'grid': 0.05, 'p_swap': 0.1, 'p_rot': 0.1, 'swap_ratio': 1.5, 't_ratio': 1e-4, 'w1': 0.25,
          'legal_step': 0.25, 'legal_radius': 5.0, 'legal_passes': 3, 'legal_time': 60.0,
          'ramp': 20.0, 'schedule': 'geometric', 'base_lam': 0.44, 'lam_rate': 0.885, 'lam_window': 500,
          'area_ref': 10.0, 'area_max': 5.0, 'normalize': 0, 'distinct': 0.0,
          'mains': 0}  # mains 1: mains path check of the final candidates (mainspath.faults), a rank key after illegal


def params_all(params):
    p = cost.params_with_defaults(SEARCH)
    p.update(params or {})
    return p


EPS_N = 1e-9
SOFT = (('w_wl', 'hpwl'), ('w_cong', 'cong'), ('w_via', 'via'), ('w_x', 'crossing'), ('w_row', 'row'))


def normalized(p, comp):
    """Soft weights divided by the start value of their term (the start HPWL for a term that is 0 at the start).
    Hard weights divided by the smallest of these divisors, so no soft term gains on overlap, oob or spacing."""
    h = max(comp['hpwl'], EPS_N)
    q = dict(p)
    ds = [comp[k] if comp.get(k, 0) > EPS_N else h for _, k in SOFT]
    for (w, _), d in zip(SOFT, ds):
        q[w] = p[w] / d
    for w in ('w_ov', 'w_oob', 'w_sp'):
        q[w] = p[w] / min(ds)
    return q


def distinct(cands, d, fixed):
    """Candidates (best first) whose movable units are on average d mm or more from each kept one; with d = 0,
    only exact copies are dropped."""
    mov = [i for i, f in enumerate(fixed) if not f]

    def gap(a, b):
        return sum(math.hypot(a[i][0] - b[i][0], a[i][1] - b[i][1]) for i in mov) / max(len(mov), 1)
    kept, seen = [], set()
    for c in cands:
        key = tuple((round(x, 3), round(y, 3), r) for x, y, r in c['pose'])
        if key in seen or (d > 0 and any(gap(c['pose'], k['pose']) < d for k in kept)):
            continue
        seen.add(key)
        kept.append(c)
    return kept


def epoch_params(p, e, epochs):
    """Spacing and forbidden-area weights grow geometrically from w to w * ramp over the epochs
    (the last epoch, the legalizer and the final ranking use w * ramp)."""
    f = e / (epochs - 1) if epochs > 1 else 1.0
    q = dict(p)
    q['w_ov'] = p['w_ov'] * p['ramp'] ** f
    q['w_oob'] = p['w_oob'] * p['ramp'] ** f
    return q


def seed_for(seed, worker, epoch):
    return (seed * 1000003 + worker * 10007 + epoch * 101) & 0xffffffff


class Mover:
    def __init__(self, pr, ev, params):
        p = params_all(params)
        self.ev = ev
        self.g = p['grid']
        self.p_swap, self.p_rot = p['p_swap'], p['p_rot']
        self.box = tuple(pr['move_box']) if pr.get('move_box') else cost.outline_box(pr['board'])
        self.mov = [i for i in range(ev.n) if not ev.fixed[i]]
        self.rot = [i for i in self.mov if pr['units'][i].get('rotate', True)]
        q = p['swap_ratio']
        a = ev.area
        self.partners = {i: [j for j in self.mov if j != i and max(a[i], a[j]) <= q * max(min(a[i], a[j]), 1e-9)]
                         for i in self.mov}
        self.swappable = [i for i in self.mov if self.partners[i]]
        # Lam schedule: a small unit moves farther (SA_PCB sigma ~ 1 / area), up to area_max times the window
        self.sc = ([min(max(p['area_ref'] / max(a[i], 1e-9), 1.0), p['area_max']) for i in range(ev.n)]
                   if p['schedule'] == 'lam' else [1.0] * ev.n)

    def _off(self, d, lo, hi):
        g = self.g
        d = round(d / g) * g
        return min(max(d, math.ceil(lo / g - 1e-9) * g), math.floor(hi / g + 1e-9) * g)

    def propose(self, rng, window):
        ev = self.ev
        u = rng.random()
        if u < self.p_swap and self.swappable:
            a = rng.choice(self.swappable)
            b = rng.choice(self.partners[a])
            dx = round((ev.X[b] - ev.X[a]) / self.g) * self.g
            dy = round((ev.Y[b] - ev.Y[a]) / self.g) * self.g
            return [(a, ev.X[a] + dx, ev.Y[a] + dy, ev.R[a]), (b, ev.X[b] - dx, ev.Y[b] - dy, ev.R[b])], 'swap'
        if u < self.p_swap + self.p_rot and self.rot:
            i = rng.choice(self.rot)
            return [(i, ev.X[i], ev.Y[i], (ev.R[i] + rng.randint(1, 3)) % 4)], 'rotate'
        i = rng.choice(self.mov)
        x, y = ev.X[i], ev.Y[i]
        bx0, by0, bx1, by1 = self.box
        w = window * self.sc[i]
        dx = self._off(rng.uniform(-w, w), bx0 - x, bx1 - x)
        dy = self._off(rng.uniform(-w, w), by0 - y, by1 - y)
        return [(i, x + dx, y + dy, ev.R[i])], 'translate'


def lam_target(f, base):
    """Target acceptance at the fraction f of all moves (modified Lam, SA_PCB): 1 -> base over the first 15 %,
    base to 65 %, then down by a factor 440 at the end."""
    if f < 0.15:
        return base + (1.0 - base) * 560.0 ** (-f / 0.15)
    if f <= 0.65:
        return base
    return base * 440.0 ** (-(f - 0.65) / 0.35)


class Lam:
    """Feedback temperature: acceptance EMA over `window` moves; every `window` moves T *= rate when the EMA is
    above lam_target, else T /= rate."""

    def __init__(self, t, base, rate, window, ema=1.0):
        self.t, self.base, self.rate, self.window, self.ema, self.n = t, base, rate, window, ema, 0

    def step(self, accepted, f):
        self.ema += (float(accepted) - self.ema) / self.window
        self.n += 1
        if self.n % self.window == 0:
            self.t = self.t * self.rate if self.ema > lam_target(f, self.base) else self.t / self.rate


def anneal_lam(ev, mover, rng, steps, lam, f0, f1, t_ref, w0, w1):
    """steps moves under the Lam controller (f0 -> f1 of the whole run); the window follows T / t_ref between
    w1 and w0. Returns (best_cost, best_pose, accepted moves)."""
    best, best_pose = ev.cost, ev.pose()
    exp, rand = math.exp, rng.random
    improved, acc = False, 0
    for s in range(steps):
        T = lam.t
        moves, _ = mover.propose(rng, min(max(w0 * T / t_ref, w1), w0))
        d = ev.propose(moves)
        ok = d <= 0 or rand() < exp(-d / T)
        if ok:
            acc += 1
            ev.commit()
            if ev.cost < best - 1e-12:
                best, improved = ev.cost, True
            elif improved and d > 0:
                best_pose, improved = _before(ev, moves), False
        else:
            ev.revert()
        lam.step(ok, f0 + (f1 - f0) * s / steps)
    if improved:
        best_pose = ev.pose()
    return best, best_pose, acc


def estimate_t0(ev, mover, rng, window, samples=200):
    ups = []
    for _ in range(samples):
        d = ev.propose(mover.propose(rng, window)[0])
        ev.revert()
        if d > 0:
            ups.append(d)
    return sum(ups) / len(ups) if ups else 1.0


def anneal(ev, mover, rng, steps, t0, t1, w0, w1):
    """steps moves with T from t0 to t1 and window from w0 to w1 (geometric). Returns (best_cost, best_pose)."""
    best, best_pose = ev.cost, ev.pose()
    if steps <= 0:
        return best, best_pose
    lt0, dlt = math.log(t0), math.log(t1 / t0) / steps
    lw0, dlw = math.log(w0), math.log(w1 / w0) / steps
    exp, rand = math.exp, rng.random
    improved = False
    for s in range(steps):
        T = exp(lt0 + dlt * s)
        moves, _ = mover.propose(rng, exp(lw0 + dlw * s))
        d = ev.propose(moves)
        if d <= 0 or rand() < exp(-d / T):
            ev.commit()
            if ev.cost < best - 1e-12:
                best, improved = ev.cost, True
            elif improved and d > 0:
                best_pose, improved = _before(ev, moves), False
        else:
            ev.revert()
    if improved:
        best_pose = ev.pose()
    return best, best_pose


def _before(ev, moves):
    """Pose before the accepted uphill move `moves` (that pose was the best so far)."""
    pose = ev.pose()
    ev_old = ev.last_old
    for i, x, y, r in ev_old:
        pose[i] = (x, y, r)
    return pose


def ring(k):
    """Integer offsets on the square ring at distance k (k >= 1)."""
    for a in range(-k, k + 1):
        yield (a, -k)
        yield (a, k)
    for b in range(-k + 1, k):
        yield (-k, b)
        yield (k, b)


class LegalizeTimeout(RuntimeError):
    """The legalizer used its time (legal_time s). The placement is not legal: `illegal` = units with a penalty."""

    def __init__(self, illegal, limit):
        self.illegal = illegal
        super().__init__('legalizer time limit %.1f s reached: %d units stay illegal' % (limit, len(illegal)))


def legalize(ev, params, clock=time.monotonic):
    """Move each unit with spacing overlap or edge/keepout area to the lowest-cost legal spot nearby
    (kept copper is a cost, not a legality rule: Evaluator.legal_penalty).
    Biggest units first; ring search on legal_step up to legal_radius, own rotation first.
    Up to legal_passes passes; each pass doubles the radius. Returns the units that stay illegal.
    Raises LegalizeTimeout after legal_time seconds (clock is injected for tests)."""
    p = params_all(params)
    end = clock() + p['legal_time']
    bad = []
    for k in range(int(p['legal_passes'])):
        bad = _legal_pass(ev, p['legal_step'], p['legal_radius'] * 2 ** k, end, clock, p['legal_time'])
        if not bad:
            break
    return bad


def _legal_pass(ev, step, radius, end, clock, limit):
    def check():
        if clock() > end:
            raise LegalizeTimeout([j for j in range(ev.n) if not ev.fixed[j] and ev.legal_penalty(j) > 1e-9], limit)
    rings = int(radius / step + 1e-9)
    order = sorted((i for i in range(ev.n) if not ev.fixed[i]), key=lambda i: (-ev.area[i], i))
    bad = []
    for i in order:
        if ev.legal_penalty(i) <= 1e-9:
            continue
        check()
        x0, y0, r0 = ev.X[i], ev.Y[i], ev.R[i]
        best = None
        for rots in ([r0], [r for r in range(4) if r != r0]):
            first = None
            for k in range(1, rings + 1):
                check()
                for a, b in ring(k):
                    for r in rots:
                        x, y = x0 + a * step, y0 + b * step
                        if ev.legal_penalty_at(i, x, y, r) > 1e-9:
                            continue
                        d = ev.propose([(i, x, y, r)])
                        ev.revert()
                        if best is None or d < best[0] - 1e-12:
                            best = (d, x, y, r)
                        first = k if first is None else first
                if first is not None and k >= first + 2:
                    break
            if best:
                break
        if best:
            ev.propose([(i, best[1], best[2], best[3])])
            ev.commit()
        else:
            bad.append(i)
    return bad


# worker side (module globals, set once per process)
_W = {}


def _init(pr, params):
    p = params_all(params)
    if p['mains'] and 'route_rules' not in pr:
        raise ValueError('mains = 1 needs route_rules and cu_nets in the problem: read it again with kicad_io')
    _W['pr'], _W['p'] = pr, p
    _W['mask'] = cost.Mask(pr['board'], p['mask_cell'], p['gap'])


def _evaluator(pose, p=None):
    return cost.Evaluator(_W['pr'], p or _W['p'], pose=pose, mask=_W['mask'])


def _epoch(task):
    w, pose, sd, t0, t1, w0, w1, steps, p, ls = task
    ev = _evaluator(pose, p)
    mover = Mover(_W['pr'], ev, p)
    rng = random.Random(sd)
    t = time.time()
    out = {}
    if ls:  # Lam schedule: ls = {'t', 'ema', 'f0', 'f1', 't_ref'}; T carries over the epochs of the worker
        lam = Lam(ls['t'], p['base_lam'], p['lam_rate'], p['lam_window'], ls['ema'])
        best, best_pose, acc = anneal_lam(ev, mover, rng, steps, lam, ls['f0'], ls['f1'], ls['t_ref'], w0, w1)
        out = {'lam': {'t': lam.t, 'ema': lam.ema}, 'accept': acc / max(steps, 1)}
    else:
        best, best_pose = anneal(ev, mover, rng, steps, t0, t1, w0, w1)
    return dict(out, worker=w, cur_pose=ev.pose(), cur_cost=ev.cost, best_pose=best_pose, best_cost=best,
                seconds=time.time() - t)


def _finish(task):
    w, pose, p = task
    ev = _evaluator(pose, p)
    timeout = False
    try:
        bad = legalize(ev, p)
    except LegalizeTimeout as e:
        bad, timeout = e.illegal, True
    pr = _W['pr']
    mains = mainspath.faults(pr, ev.pose(), mainspath.domain_nets(pr)) if p['mains'] else []
    return {'worker': w, 'pose': ev.pose(), 'cost': ev.cost, 'components': ev.components(),
            'illegal': [pr['units'][i]['name'] for i in bad], 'timeout': timeout, 'mains': mains}


def final_key(c):
    """Final candidate order: legal first, then no mains path faults, then the lower cost."""
    return (len(c['illegal']), len(c['mains']), c['cost'], c['worker'])


def optimize(pr, params, workers=1, epochs=10, steps=10000, seed=1, top=3, log=None):
    p = params_all(params)
    glob = start = None
    if p.get('global'):  # analytic global placement first (gplace.py); the annealer starts from it
        from . import gplace
        g = gplace.place(pr, p, log=log)
        pr = copy.deepcopy(pr)
        for u, (x, y, _) in zip(pr['units'], g['pose']):
            u['x'], u['y'] = x, y
        start = [tuple(q) for q in g['pose']]  # with gplace rotate=1 the turns carry over
        glob = {'iters': len(g['history']), 'overflow': g['history'][-1]['overflow'] if g['history'] else None}
    if p['normalize']:  # SA_PCB: each term relative to its value on the start pose
        p = normalized(p, cost.components(pr, cost.initial_pose(pr), p))
    _init(pr, p)
    pf = epoch_params(p, epochs - 1, epochs)
    ev0 = _evaluator(start, epoch_params(p, 0, epochs))
    evf = _evaluator(start, pf)
    initial = {'pose': evf.pose(), 'cost': evf.cost, 'components': evf.components()}
    bx0, by0, bx1, by1 = cost.outline_box(pr['board'])
    w0 = p.get('w0') or max(bx1 - bx0, by1 - by0) / 2
    w1 = min(p['w1'], w0)
    t0 = p.get('t0') or estimate_t0(ev0, Mover(pr, ev0, p), random.Random(seed), w0)
    t1 = t0 * p['t_ratio']
    frac = lambda a, b, f: a * (b / a) ** f  # noqa: E731
    cur = [initial['pose']] * workers
    cur_cost = [initial['cost']] * workers
    best = [(ev0.cost, initial['pose'])] * workers
    pool = mp.get_context('spawn').Pool(workers, _init, (pr, p)) if workers > 1 else None
    run = pool.map if pool else lambda f, xs: [f(x) for x in xs]
    t_start, busy = time.time(), 0.0
    history = []  # best pose of each epoch, for snapshots
    lam = lam_log = None
    if p['schedule'] == 'lam':
        lam, lam_log = [{'t': t0, 'ema': 1.0}] * workers, []
    try:
        for e in range(epochs):
            f0, f1 = e / epochs, (e + 1) / epochs
            pe = epoch_params(p, e, epochs)
            if lam:  # the window follows T; w0 and w1 are its bounds
                tasks = [(w, cur[w], seed_for(seed, w, e), t0, t1, w0, w1, steps, pe,
                          dict(lam[w], f0=f0, f1=f1, t_ref=t0)) for w in range(workers)]
            else:
                tasks = [(w, cur[w], seed_for(seed, w, e), frac(t0, t1, f0), frac(t0, t1, f1),
                          frac(w0, w1, f0), frac(w0, w1, f1), steps, pe, None) for w in range(workers)]
            out = run(_epoch, tasks)
            if lam:
                lam = [o['lam'] for o in sorted(out, key=lambda o: o['worker'])]
                lam_log.append({'epoch': e + 1, 'accept': sum(o['accept'] for o in out) / len(out),
                                'T': sum(q['t'] for q in lam) / len(lam)})
            for o in out:
                w = o['worker']
                cur[w], cur_cost[w] = o['cur_pose'], o['cur_cost']
                best[w] = (o['best_cost'], o['best_pose'])  # this epoch's weights: compare within the epoch only
                busy += o['seconds']
            g = min(range(workers), key=lambda w: (best[w][0], w))
            history.append({'epoch': e + 1, 'cost': best[g][0], 'pose': [list(q) for q in best[g][1]],
                            'components': cost.components(pr, best[g][1], pf)})
            if log:
                log('epoch %d/%d T %.3g best %.2f (worker %d) cur %s' % (
                    e + 1, epochs, frac(t0, t1, f1), best[g][0], g, ' '.join('%.1f' % c for c in cur_cost)))
            if e < epochs - 1:
                for w in sorted(range(workers), key=lambda w: (-cur_cost[w], w))[:workers // 2]:
                    if w != g:
                        cur[w], cur_cost[w] = best[g][1], best[g][0]
        fin = run(_finish, [(w, best[w][1], pf) for w in range(workers)])
    finally:
        if pool:
            pool.close()
            pool.join()
    fin.sort(key=final_key)
    cands = distinct(fin, p['distinct'], [u['fixed'] for u in pr['units']])
    return {'global': glob, 'lam': lam_log, 'initial': initial, 'candidates': cands[:top], 'history': history, 't0': t0, 'seed': seed, 'workers': workers,
            'epochs': epochs, 'steps': steps, 'params': p, 'wall_s': time.time() - t_start,
            'moves_per_s_per_worker': epochs * steps * workers / busy if busy else 0.0}
