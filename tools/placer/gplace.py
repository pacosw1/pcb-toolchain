"""Analytic global placement (ePlace / RePlAce style) before the annealer. Pure numpy, no pcbnew.

Objective: WA wirelength (weighted-average smooth HPWL, pin centres) + lambda * electrostatic density energy.
  - Density: each unit is its courtyard box (all rects at the current rotation) grown by half its clearance,
    spread over a bins x bins grid on the outline box. Fixed units, the area outside the outline and the
    keepouts are fixed charge. The potential solves the Poisson equation with a cosine (DCT) basis; the
    density gradient of a unit is minus its charge times the field.
  - Nesterov descent with a Lipschitz step estimate (a unit moves at most max_move bin widths per step), a
    diagonal preconditioner (pins + lambda * area) and a growing lambda (x mu per iteration) until the
    overflow is below `stop_overflow`.
  - Routability (RePlAce): each time the overflow falls below route_overflow (route_rounds times), the units
    in bins with RUDY above the routing capacity grow in area (inflate(), at most max_infl in total).
  - Start: all movable units at the outline box centre with a small jitter (init 'centre'), or at their
    places (init 'pose', a warm start), or at the spectral seed (init 'spectral', spectral_pose, NS-Place).
  - Rotation stays as it is (the annealer makes the 90 degree turns). Fixed units do not move. Each unit
    stays inside the outline box; an edge-anchored unit (u['edge']) is put back on its nearest allowed side.
place(pr, params, pose=None) -> {'pose': [(x, y, r)], 'history': [{'iter', 'wa', 'overflow', 'lambda'}]}
The result is not legal: legalize it (anneal.legalize) and run the annealer at a low temperature.
"""
import math

import numpy as np

from . import cost

GLOBAL = {'bins': 64, 'target': 0.9, 'iters': 1000, 'stop_overflow': 0.1, 'mu': 1.05, 'gamma': None,
          'max_move': 0.5, 'infl': 1.0, 'seed': 1,
          'init': 'centre', 'route_rounds': 2, 'route_overflow': 0.2, 'max_infl': 2.0}


def _box(u, r):
    rs = [cost.rot_rect(rc, r) + (rc[4],) for rc in u['rects']]
    return (min(q[0] - q[4] / 2 for q in rs), min(q[1] - q[4] / 2 for q in rs),
            max(q[2] + q[4] / 2 for q in rs), max(q[3] + q[4] / 2 for q in rs))


class Model:
    def __init__(self, pr, params, pose=None):
        p = self.p = dict(GLOBAL, **(params or {}))
        us = pr['units']
        pose = pose or cost.initial_pose(pr)
        self.n = len(us)
        self.x0 = np.array([q[0] for q in pose], dtype=float)
        self.y0 = np.array([q[1] for q in pose], dtype=float)
        self.R = [int(q[2]) % 4 for q in pose]
        self.fixed = np.array([bool(u['fixed']) for u in us])
        self.mov = np.nonzero(~self.fixed)[0]
        self.fix = np.nonzero(self.fixed)[0]
        # unit boxes (offsets from the origin): grown by half the clearance x infl, and bare (for the board)
        grown = [_box(u, r) for u, r in zip(us, self.R)]
        c = [(b[0] + b[2]) / 2 for b in grown], [(b[1] + b[3]) / 2 for b in grown]
        f = p['infl']
        self.ox0 = np.array([cx - (cx - b[0]) * f for cx, b in zip(c[0], grown)])
        self.ox1 = np.array([cx + (b[2] - cx) * f for cx, b in zip(c[0], grown)])
        self.oy0 = np.array([cy - (cy - b[1]) * f for cy, b in zip(c[1], grown)])
        self.oy1 = np.array([cy + (b[3] - cy) * f for cy, b in zip(c[1], grown)])
        bare = [(min(q[0] for q in rs), min(q[1] for q in rs), max(q[2] for q in rs), max(q[3] for q in rs))
                for u, r in zip(us, self.R) for rs in [[cost.rot_rect(rc, r) for rc in u['rects']]]]
        self.bare = np.array(bare, dtype=float).reshape(-1, 4)
        self.area = (self.ox1 - self.ox0) * (self.oy1 - self.oy0)
        self.infl_total = np.ones(self.n)
        self.edges = [u.get('edge') for u in us]
        # pins (centres, rotated)
        pu, px, py, pn, w = [], [], [], [], []
        for k, net in enumerate(pr['nets']):
            for q in net['pins']:
                a, b, cc, d = cost.rot_rect(q[1:5], self.R[q[0]])
                pu.append(q[0])
                px.append((a + cc) / 2)
                py.append((b + d) / 2)
                pn.append(k)
            w.append(float(net['weight']))
        self.pu = np.array(pu, dtype=int)
        self.pdx, self.pdy = np.array(px, dtype=float), np.array(py, dtype=float)
        self.pn = np.array(pn, dtype=int)
        self.nw = np.array(w, dtype=float)
        cp = cost.params_with_defaults(self.p)
        self.ntf = np.array([cost.track_factor(n, cp) for n in pr['nets']], dtype=float)
        self.nnet = len(w)
        self.npin = np.bincount(self.pu, minlength=self.n).astype(float)
        # bins
        self.board = pr['board']
        bx0, by0, bx1, by1 = cost.outline_box(pr['board'])
        self.bb = (bx0, by0, bx1, by1)
        nb = p['bins']
        self.nb = nb
        self.ex = np.linspace(bx0, bx1, nb + 1)
        self.ey = np.linspace(by0, by1, nb + 1)
        self.bw, self.bh = (bx1 - bx0) / nb, (by1 - by0) / nb
        self.barea = self.bw * self.bh
        xc, yc = (self.ex[:-1] + self.ex[1:]) / 2, (self.ey[:-1] + self.ey[1:]) / 2
        wu = math.pi * np.arange(nb) / (bx1 - bx0)
        wv = math.pi * np.arange(nb) / (by1 - by0)
        self.Cx, self.Sx = np.cos(np.outer(xc - bx0, wu)), np.sin(np.outer(xc - bx0, wu))
        self.Cy, self.Sy = np.cos(np.outer(yc - by0, wv)), np.sin(np.outer(yc - by0, wv))
        den = wu[:, None] ** 2 + wv[None, :] ** 2
        den[0, 0] = 1.0
        self.inv = 1.0 / den
        self.inv[0, 0] = 0.0
        self.wu, self.wv = wu, wv
        self.F = self._fixed_map(pr)

    def _fixed_map(self, pr):
        """Fixed charge per bin (area): fixed units, outside the outline, keepouts (4 x 4 samples per bin)."""
        F = np.zeros((self.nb, self.nb))
        if len(self.fix):
            ax, ay = self._overlaps(self.x0, self.y0, self.fix)
            F += ax.T @ ay
        s = 4
        xs = self.bb[0] + (np.arange(self.nb * s) + 0.5) * self.bw / s
        ys = self.bb[1] + (np.arange(self.nb * s) + 0.5) * self.bh / s
        gx, gy = np.meshgrid(xs, ys, indexing='ij')
        out = ~cost.point_in_poly(gx, gy, pr['board']['outline'])
        for poly in pr['board'].get('keepouts', []):
            out |= cost.point_in_poly(gx, gy, poly)
        F += out.reshape(self.nb, s, self.nb, s).sum(axis=(1, 3)) * self.barea / (s * s)
        return F

    def _overlaps(self, x, y, idx):
        x0, x1 = x[idx] + self.ox0[idx], x[idx] + self.ox1[idx]
        y0, y1 = y[idx] + self.oy0[idx], y[idx] + self.oy1[idx]
        ax = np.clip(np.minimum(x1[:, None], self.ex[None, 1:]) - np.maximum(x0[:, None], self.ex[None, :-1]), 0, None)
        ay = np.clip(np.minimum(y1[:, None], self.ey[None, 1:]) - np.maximum(y0[:, None], self.ey[None, :-1]), 0, None)
        return ax, ay

    def rudy(self, x, y):
        """RUDY per bin (mm of track per mm2): each net spreads (w + h) * weight * track factor uniformly over its
        pin box."""
        px, py = x[self.pu] + self.pdx, y[self.pu] + self.pdy
        x0, x1 = np.full(self.nnet, np.inf), np.full(self.nnet, -np.inf)
        y0, y1 = np.full(self.nnet, np.inf), np.full(self.nnet, -np.inf)
        np.minimum.at(x0, self.pn, px)
        np.maximum.at(x1, self.pn, px)
        np.minimum.at(y0, self.pn, py)
        np.maximum.at(y1, self.pn, py)
        ok = np.isfinite(x0) & (np.bincount(self.pn, minlength=self.nnet) > 1)
        x0, x1, y0, y1, w = x0[ok], x1[ok], y0[ok], y1[ok], self.nw[ok] * self.ntf[ok]
        x1, y1 = np.maximum(x1, x0 + self.bw), np.maximum(y1, y0 + self.bh)  # a line net covers one bin row
        dens = w * ((x1 - x0) + (y1 - y0)) / ((x1 - x0) * (y1 - y0))
        ax = np.clip(np.minimum(x1[:, None], self.ex[None, 1:]) - np.maximum(x0[:, None], self.ex[None, :-1]), 0, None)
        ay = np.clip(np.minimum(y1[:, None], self.ey[None, 1:]) - np.maximum(y0[:, None], self.ey[None, :-1]), 0, None)
        return (ax * dens[:, None]).T @ ay / self.barea

    def inflate(self, x, y):
        """RePlAce cell inflation: each movable unit grows in area by its overlap-weighted RUDY over the routing
        capacity (cost limit * layers / pitch), clipped to [1, max_infl] in total. Returns the area factors."""
        cp = cost.params_with_defaults(self.p)
        cap = cp['limit'] * cp['layers'] / cp['pitch']
        R = self.rudy(x, y)
        ax, ay = self._overlaps(x, y, self.mov)
        a = ax.sum(1) * ay.sum(1)
        r = np.einsum('ik,kl,il->i', ax, R, ay) / np.maximum(a, 1e-12)
        f = np.ones(self.n)
        f[self.mov] = np.clip(r / cap, 1.0, None)
        f = np.minimum(self.infl_total * f, self.p['max_infl']) / self.infl_total
        self.infl_total = self.infl_total * f
        s = np.sqrt(f)
        cx, cy = (self.ox0 + self.ox1) / 2, (self.oy0 + self.oy1) / 2
        self.ox0, self.ox1 = cx - (cx - self.ox0) * s, cx + (self.ox1 - cx) * s
        self.oy0, self.oy1 = cy - (cy - self.oy0) * s, cy + (self.oy1 - cy) * s
        self.area = (self.ox1 - self.ox0) * (self.oy1 - self.oy0)
        return self.infl_total

    def wa(self, x, y, gamma=None):
        """Weighted-average wirelength and its gradient (fixed units get 0)."""
        g = gamma or self.p['gamma'] or 1.0
        tot = 0.0
        grads = []
        for pos, d in ((x, self.pdx), (y, self.pdy)):
            q = pos[self.pu] + d
            dq = np.zeros_like(q)
            for s in (1.0, -1.0):
                a = s * q / g
                m = np.full(self.nnet, -np.inf)
                np.maximum.at(m, self.pn, a)
                e = np.exp(a - m[self.pn])
                S = np.bincount(self.pn, e, self.nnet)
                Sq = np.bincount(self.pn, q * e, self.nnet)
                W = np.divide(Sq, S, out=np.zeros(self.nnet), where=S > 0)
                tot += s * float((self.nw * W).sum())
                dq += s * self.nw[self.pn] * e / S[self.pn] * (1 + s * (q - W[self.pn]) / g)
            gr = np.bincount(self.pu, dq, self.n)
            gr[self.fix] = 0.0
            grads.append(gr)
        return tot, grads[0], grads[1]

    def density(self, x, y):
        """(energy, grad x, grad y, overflow) of the movable units in the fixed charge."""
        ax, ay = self._overlaps(x, y, self.mov)
        D = ax.T @ ay
        rho = (D + self.F) / self.barea
        a = self.Cx.T @ rho @ self.Cy * (4.0 / (self.nb * self.nb))
        coef = a * self.inv
        psi = self.Cx @ coef @ self.Cy.T
        Ex = self.Sx @ (coef * self.wu[:, None]) @ self.Cy.T
        Ey = self.Cx @ (coef * self.wv[None, :]) @ self.Sy.T
        energy = 0.5 * float((rho * psi).sum()) * self.barea
        gx, gy = np.zeros(self.n), np.zeros(self.n)
        gx[self.mov] = -np.einsum('ik,kl,il->i', ax, Ex, ay)
        gy[self.mov] = -np.einsum('ik,kl,il->i', ax, Ey, ay)
        room = np.clip(self.p['target'] * self.barea - self.F, 0, None)
        ovf = float(np.clip(D - room, 0, None).sum() / max(self.area[self.mov].sum(), 1e-9))
        return energy, gx, gy, ovf

    def gamma_for(self, ovf):
        """ePlace smoothing: 8 bin widths x 10^(20/9 overflow - 11/9); a fixed params['gamma'] wins."""
        return self.p['gamma'] or 8.0 * max(self.bw, self.bh) * 10 ** (20.0 / 9 * min(ovf, 1.0) - 11.0 / 9)

    def project(self, x, y):
        """Fixed units back at their place, each unit box inside the outline box, edge anchors on a side."""
        x[self.fix], y[self.fix] = self.x0[self.fix], self.y0[self.fix]
        b = self.bare
        bx0, by0, bx1, by1 = self.bb
        m = self.mov
        x[m] = np.clip(x[m], bx0 - b[m, 0], np.maximum(bx1 - b[m, 2], bx0 - b[m, 0]))
        y[m] = np.clip(y[m], by0 - b[m, 1], np.maximum(by1 - b[m, 3], by0 - b[m, 1]))
        c = self.board.get('edge_clearance', 0.0)
        for i in m:
            e = self.edges[i]
            if not e:
                continue
            ax, ay = cost.rot_pt(e['at'][0], e['at'][1], self.R[i])
            px, py = x[i] + ax, y[i] + ay
            opts = {'L': (bx0 + c - px, 0.0), 'R': (bx1 - c - px, 0.0), 'T': (0.0, by0 + c - py),
                    'B': (0.0, by1 - c - py)}
            dx, dy = min((opts[s] for s in e['sides']), key=lambda d: abs(d[0]) + abs(d[1]))
            x[i] += dx
            y[i] += dy
        return x, y


def spectral_pose(pr, pose=None, all_orientations=False, span=0.5):
    """NS-Place seed: the 2nd and 3rd eigenvectors of the clique-model Laplacian (weight w / (k - 1) per pin
    pair; a weak all-to-all term joins separate parts), scaled to `span` of the outline box about its centre.
    Of the 8 flips and turns, the pose with the lowest HPWL; fixed units keep their places."""
    us = pr['units']
    n = len(us)
    pose = pose or cost.initial_pose(pr)
    L = np.zeros((n, n))
    for net in pr['nets']:
        u = [q[0] for q in net['pins']]
        if len(u) < 2:
            continue
        w = float(net['weight']) / (len(u) - 1)
        for a in range(len(u)):
            for b in range(a + 1, len(u)):
                if u[a] != u[b]:
                    L[u[a], u[b]] -= w
                    L[u[b], u[a]] -= w
    wmean = -L[L < 0].mean() if (L < 0).any() else 1.0
    L -= 1e-3 * wmean / n  # weak all-to-all: one connected graph
    np.fill_diagonal(L, 0.0)
    np.fill_diagonal(L, -L.sum(axis=1))
    _, vec = np.linalg.eigh(L)
    e2, e3 = vec[:, 1], vec[:, 2]
    bx0, by0, bx1, by1 = cost.outline_box(pr['board'])
    cx, cy = (bx0 + bx1) / 2, (by0 + by1) / 2

    def scale(v, c, half):
        r = np.abs(v).max()
        return c + (v / r if r > 0 else v) * half

    cands = []
    for a, b in ((e2, e3), (e3, e2)):
        for sx in (1, -1):
            for sy in (1, -1):
                x = scale(sx * a, cx, span * (bx1 - bx0) / 2)
                y = scale(sy * b, cy, span * (by1 - by0) / 2)
                cands.append([pose[i] if us[i]['fixed'] else (float(x[i]), float(y[i]), pose[i][2]) for i in range(n)])
    best = min(cands, key=lambda q: cost.hpwl(pr, q))
    return (best, cands) if all_orientations else best


def place(pr, params=None, pose=None, log=None):
    m = Model(pr, params, pose)
    p = m.p
    mv = m.mov
    n = m.n
    rng = np.random.default_rng(p['seed'])  # a small jitter breaks the symmetry of stacked units (ePlace)
    jx, jy = m.x0.copy(), m.y0.copy()
    if p['init'] == 'centre':  # all movable units start at the board centre and spread (ePlace); 'pose' keeps them
        jx[mv], jy[mv] = (m.bb[0] + m.bb[2]) / 2, (m.bb[1] + m.bb[3]) / 2
    elif p['init'] == 'spectral':  # NS-Place seed
        sp = spectral_pose(pr, pose)
        jx[mv], jy[mv] = [sp[i][0] for i in mv], [sp[i][1] for i in mv]
    jx[mv] += rng.uniform(-0.5, 0.5, len(mv)) * m.bw
    jy[mv] += rng.uniform(-0.5, 0.5, len(mv)) * m.bh
    u = np.concatenate(m.project(jx, jy))

    def grad(z, lam, gam):
        x, y = z[:n].copy(), z[n:].copy()
        w, wx, wy = m.wa(x, y, gam)
        e, dx, dy, ovf = m.density(x, y)
        return w, ovf, np.concatenate([wx, wy]), np.concatenate([dx, dy])

    _, ovf, gw, gd = grad(u, 0.0, m.gamma_for(1.0))
    nd = np.abs(gd).sum()
    lam = float(max(np.abs(gw).sum(), 1e-3 * m.npin.sum()) / nd) if nd > 0 else 1.0
    hist = []
    v, v_prev, g_prev = u.copy(), None, None
    ak = 1.0
    rounds = 0
    step = 0.1 * max(m.bw, m.bh)
    for k in range(p['iters']):
        gam = m.gamma_for(ovf)
        w, ovf, gw, gd = grad(v, lam, gam)
        hist.append({'iter': k, 'wa': w, 'overflow': ovf, 'lambda': lam})
        if log and k % 50 == 0:
            log('gplace %d wa %.1f overflow %.3f lambda %.3g' % (k, w, ovf, lam))
        if ovf < p['route_overflow'] and rounds < p['route_rounds']:
            m.inflate(v[:n], v[n:])  # routability: grow the units under congestion, then spread again
            rounds += 1
            hist[-1]['inflated'] = True
            _, ovf, gw, gd = grad(v, lam, gam)
        elif ovf < p['stop_overflow'] and k > 0:
            u = v  # the measured point
            break
        pre = np.concatenate([m.npin + lam * m.area, m.npin + lam * m.area])
        g = (gw + lam * gd) / np.maximum(pre, 1e-9)
        g[np.concatenate([m.fixed, m.fixed])] = 0.0
        if g_prev is not None:
            dg = np.linalg.norm(g - g_prev)
            if dg > 0:
                step = np.linalg.norm(v - v_prev) / dg
        mv_ = step * g
        mm = np.maximum(np.abs(mv_) / (p['max_move'] * max(m.bw, m.bh)), 1.0)  # max_move in bin widths
        u_new = v - mv_ / mm
        x, y = m.project(u_new[:n].copy(), u_new[n:].copy())
        u_new = np.concatenate([x, y])
        a_new = (1 + math.sqrt(4 * ak * ak + 1)) / 2
        v_prev, g_prev = v, g
        v = u_new + (ak - 1) / a_new * (u_new - u)
        x, y = m.project(v[:n].copy(), v[n:].copy())
        v = np.concatenate([x, y])
        u, ak = u_new, a_new
        lam *= p['mu']
    x, y = u[:n], u[n:]
    return {'pose': [(float(x[i]), float(y[i]), m.R[i]) for i in range(n)], 'history': hist,
            'movable': [int(i) for i in mv]}
