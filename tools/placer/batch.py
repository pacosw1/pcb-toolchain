"""Batched cost and batched simulated annealing on torch: K independent chains, one tensor step per move.

BatchCost(pr, params, device).components(poses) -> the cost.components terms for N poses (hpwl, cong, overlap,
oob, spacing), equal to the scalar cost (float64 on cpu; float32 on mps, about 1e-4 relative).
Chains(pr, params, start, chains, seed, device): K chains from one start pose. step(T, window) proposes one move
per chain (the anneal.Mover move set: translate on the grid inside the move box, turn, swap), evaluates all K
deltas as one batch and applies the Metropolis rule per chain.
optimize(): the batched path of anneal.optimize (params batch=1, chains, batch_device). The same geometric
schedule, weight ramp (epoch_params) and exchange (the worse half restarts from the best) as the workers; the best
chains are legalized and ranked by the scalar code (anneal._finish), so the legality checks are the same.

Delta per move: pair penalties of the moved rects against all rects (static gap tables per rect pair, from
the same rules as cost._pen / _domain_gap), forbidden area of the moved units (summed-area lookups), and a full
recompute of HPWL, RUDY (difference array + 2-D cumsum) and the domain-area penalty (convex hull per chain).
Not supported (ValueError, fail closed): crossings (w_x), rows (w_row), pin_demand, via nets, the Lam schedule.
Positions are integer grid steps from the start pose, so float32 does not drift.
"""
import math
import random
import time

import numpy as np
import torch

from . import anneal, cost

EPS = cost.EPS
TERMS = ('hpwl', 'cong', 'overlap', 'oob', 'spacing')
CHUNK = 1 << 24  # rect pairs per block on a GPU (a quarter on cpu, float64): memory bound
OFF = 1e6  # gap of a rect pair that does not count (same unit, both fixed, keepout over keepout, border skip)


def check_supported(pr, p):
    for k in ('w_x', 'w_row', 'pin_demand'):
        if p.get(k):
            raise ValueError('batch: %s = %s is not supported (use the scalar path)' % (k, p[k]))
    if pr.get('via_nets'):
        raise ValueError('batch: via nets (via room term) are not supported (use the scalar path)')


def _pen(ox, oy, g):
    """cost._pen per rect pair from the overlap spans ox, oy (min right - max left, without the gap)."""
    dx, dy = ox + g, oy + g
    a = dx.clamp(min=0) * dy.clamp(min=0)
    sx, sy = g - dx, g - dy
    c = (sx > 0) & (sy > 0) & (a > 0)
    d = torch.hypot(sx, sy)
    f = ((g - d) / torch.clamp(g - torch.maximum(sx, sy), min=1e-9)).clamp(0, 1)
    return torch.where(c, a * f, a)


def _hull(P):
    """Convex hull per batch row (gift wrapping): P (K, m, 2) -> (K, m + 1, 2), padded with the start point."""
    K, m, _ = P.shape
    ar = torch.arange(K, device=P.device)
    xmin = P[..., 0].min(dim=1).values
    y = torch.where(P[..., 0] == xmin[:, None], P[..., 1], torch.full_like(P[..., 1], math.inf))
    cur = y.argmin(dim=1)
    s = P[ar, cur]
    out = [s]
    prev = torch.full((K,), -math.pi / 2, dtype=P.dtype, device=P.device)
    done = torch.zeros(K, dtype=torch.bool, device=P.device)
    for _ in range(m):
        pc = P[ar, cur]
        v = P - pc[:, None, :]
        d2 = (v * v).sum(dim=2)
        turn = torch.remainder(torch.atan2(v[..., 1], v[..., 0]) - prev[:, None], 2 * math.pi)
        turn = torch.where(d2 > 0, turn, torch.full_like(turn, math.inf))
        tie = turn == turn.min(dim=1).values[:, None]
        nxt = torch.where(tie, d2, torch.full_like(d2, -1.0)).argmax(dim=1)
        q = P[ar, nxt]
        closed = done | (q == s).all(dim=1)
        out.append(torch.where(closed[:, None], s, q))
        prev = torch.where(closed, prev, torch.atan2(q[:, 1] - pc[:, 1], q[:, 0] - pc[:, 0]))
        cur = torch.where(closed, cur, nxt)
        done = closed
        if bool(done.all()):
            break
    return torch.stack(out, dim=1)


def _area_pen(R, H, g):
    """cost.area_pen per rect: R (K, S, 4) against the hull H (K, h, 2) grown by g -> (K, S)."""
    C = torch.stack([R[..., [0, 1]], R[..., [2, 1]], R[..., [2, 3]], R[..., [0, 3]]], dim=2)  # K S 4 2
    E = torch.roll(H, -1, dims=1) - H
    L = torch.hypot(E[..., 0], E[..., 1])
    ok = L > EPS
    Ls = torch.where(ok, L, torch.ones_like(L))
    nrm = torch.stack([-E[..., 1], E[..., 0]], dim=2) / Ls[..., None]
    nrm = torch.where(ok[..., None], nrm, torch.tensor([1.0, 0.0], dtype=H.dtype, device=H.device))
    K = H.shape[0]
    eye = torch.eye(2, dtype=H.dtype, device=H.device).expand(K, 2, 2)
    axes = torch.cat([eye, nrm], dim=1)  # K a 2
    pc = torch.einsum('ksci,kai->ksca', C, axes)
    ph = torch.einsum('khi,kai->kha', H, axes)
    s = torch.maximum(pc.min(dim=2).values - ph.max(dim=1).values[:, None],
                      ph.min(dim=1).values[:, None] - pc.max(dim=2).values).max(dim=2).values
    hx, hy = H[:, None, :, 0], H[:, None, :, 1]
    dx = torch.clamp(torch.maximum(R[..., 0:1] - hx, hx - R[..., 2:3]), min=0)
    dy = torch.clamp(torch.maximum(R[..., 1:2] - hy, hy - R[..., 3:4]), min=0)
    d = torch.hypot(dx, dy).min(dim=2).values
    ee = torch.where(ok, (E * E).sum(dim=2), torch.ones_like(L))
    rel = C[:, :, :, None, :] - H[:, None, None, :, :]  # K S 4 h 2
    t = ((rel * E[:, None, None]).sum(dim=4) / ee[:, None, None]).clamp(0, 1)
    q = H[:, None, None] + t[..., None] * E[:, None, None] - C[:, :, :, None, :]
    de = torch.hypot(q[..., 0], q[..., 1])
    de = torch.where(ok[:, None, None, :], de, torch.full_like(de, math.inf))
    d = torch.minimum(d, de.flatten(2).min(dim=2).values)
    return torch.where(s < 0, g - s, torch.clamp(g - d, min=0))


class BatchCost:
    """Static tables of one problem on one device; cost terms of batches of poses."""

    def __init__(self, pr, params, device='cpu'):
        p = self.p = cost.params_with_defaults(params)
        check_supported(pr, p)
        self.pr = pr
        self.dev = torch.device(device)
        self.dt = torch.float64 if self.dev.type == 'cpu' else torch.float32
        us = pr['units']
        n = self.n = len(us)
        self.fixed = np.array([bool(u['fixed']) for u in us])
        if any(not u['rects'] for u in us):
            raise ValueError('batch: a unit with no rects')
        T = cost.class_table(pr)
        lrect = [np.array([[cost.rot_rect(rc, r) for rc in u['rects']] for r in range(4)], dtype=float) for u in us]
        nr = [len(u['rects']) for u in us]
        off = np.concatenate([[0], np.cumsum(nr)]).astype(int)
        R = self.R = int(off[-1])
        self.nr, self.off = nr, off
        self.unit_of = np.repeat(np.arange(n), nr)
        clr = [np.array([rc[4] for rc in u['rects']], dtype=float) for u in us]
        hclr = [cost.hard_clr(u) for u in us]
        ko = [cost.ko_flags(u, T) for u in us]
        bd = [cost.border_flags(u) for u in us]
        rho = [cost.radii(u) for u in us]
        # pair tables: gap (soft = D-040 halo, hard) incl. both corner radii; masks with keepout pairs, borders, same unit
        GS, GH = np.full((R, R), -OFF), np.full((R, R), -OFF)  # a pair that does not count: gap -OFF (no overlap)
        for i in range(n):
            for j in range(n):
                if i == j or (self.fixed[i] and self.fixed[j]):
                    continue
                gs = np.maximum(clr[i][:, None], clr[j][None, :])
                gh = np.maximum(hclr[i][:, None], hclr[j][None, :])
                if ko[i][1] is not None and ko[j][1] is not None:
                    gs = cost._domain_gap(gs, clr[i], clr[j], ko[i], ko[j])
                    gh = cost._domain_gap(gh, hclr[i], hclr[j], ko[i], ko[j])
                rs = rho[i][:, None] + rho[j][None, :]
                kk = ko[i][0][:, None] & ko[j][0][None, :]
                sk = bd[i][:, None] | bd[j][None, :]
                a, b = slice(off[i], off[i + 1]), slice(off[j], off[j + 1])
                GS[a, b] = np.where(kk, -OFF, gs + rs)
                GH[a, b] = np.where(kk | sk, -OFF, gh + rs)
        t = self._t
        self.LR = t(np.concatenate(lrect, axis=1))  # 4 R 4 local rects per turn
        self.SH = t(np.concatenate(rho)[:, None] * np.array([1.0, 1.0, -1.0, -1.0]))  # corner radius shrink
        self.PT = torch.stack([t(GS), t(GH)], dim=2)  # R R 2: soft (full) and hard gap per rect pair
        self.UO = torch.as_tensor(self.unit_of, device=self.dev)
        self.chunk = CHUNK if self.dev.type != 'cpu' else CHUNK // 4
        self._forb_setup(pr, p)
        self._net_setup(pr, p)
        self._area_setup(pr)

    def _t(self, a, dtype=None):
        return torch.as_tensor(np.asarray(a), dtype=dtype or self.dt, device=self.dev)

    # forbidden area: per unit a table of (local rect per turn, SAT table, outside flag, sign per turn)
    def _forb_setup(self, pr, p):
        m = self.mask = cost.Mask(pr['board'], p['mask_cell'], p['gap'])
        tabs = [m.s, m.s_edge, m.s_band, m.s_cu, m.s_outl]
        kog = {}
        for c, s in m.s_kog.items():
            kog[c] = len(tabs)
            tabs.append(s)
        self.SAT = torch.stack([self._t(s.astype(float)) for s in tabs])  # T ny+1 nx+1
        S, CU, BAND, EDGE, OUTL = 0, 3, 2, 1, 4
        ents = []
        for u in pr['units']:
            e = []  # (4 x 4 rects, table, outside, 4 signs)

            def add(rects, tab, outside, sign=1.0):
                for rc in rects:
                    rr = [cost.rot_rect(rc, r) for r in range(4)]
                    e.append((rr, tab, outside, [sign] * 4))
            rects = u['rects']
            kos = set(u.get('ko', []))
            add([rects[k] for k in sorted(kos)], CU, False)
            ep = u.get('pad_rects') or u.get('edge_pads') or []
            add(ep, BAND, True)
            if 'pad_rects' not in u:
                add([rc for k, rc in enumerate(rects) if k not in kos], S, True)
            else:
                add([rc for k, rc in enumerate(rects) if k not in kos], EDGE, True)
                add(u['pad_rects'], CU, False)
            for k, rc in enumerate(rects):  # overhang into an own keepout rect: taken off
                if k in kos:
                    continue
                for j in sorted(kos):
                    rr, sg = [], []
                    for r in range(4):
                        a, q = cost.rot_rect(rc, r), cost.rot_rect(rects[j], r)
                        x0, y0, x1, y1 = max(a[0], q[0]), max(a[1], q[1]), min(a[2], q[2]), min(a[3], q[3])
                        rr.append((x0, y0, x1, y1))
                        sg.append(-1.0 if x1 > x0 and y1 > y0 else 0.0)
                    e.append((rr, OUTL, True, sg))
            for k, c, *_ in u.get('dom', []):
                if c in kog:
                    add([rects[k]], kog[c], False)
            ents.append(e)
        emax = max(1, max(len(e) for e in ents))
        n = self.n
        ER = np.zeros((n, emax, 4, 4))
        ET = np.zeros((n, emax), dtype=np.int64)
        EO = np.zeros((n, emax), dtype=bool)
        ES = np.zeros((n, emax, 4))
        for i, e in enumerate(ents):
            for k, (rr, tab, outside, sg) in enumerate(e):
                ER[i, k] = rr
                ET[i, k], EO[i, k], ES[i, k] = tab, outside, sg
        self.ER, self.ES = self._t(ER), self._t(ES)
        self.ET = torch.as_tensor(ET, device=self.dev)
        self.EO = torch.as_tensor(EO, device=self.dev)
        # edge anchors (cost.edge_miss)
        bx = cost.outline_box(pr['board'])
        c = pr['board'].get('edge_clearance', 0.0)
        self.edge = []
        for i, u in enumerate(pr['units']):
            e = u.get('edge')
            if e:
                at = np.array([cost.rot_pt(e['at'][0], e['at'][1], r) for r in range(4)], dtype=float)
                self.edge.append((i, self._t(at), list(e['sides']), e.get('tol', 0.5)))
        self.edge_lines = {'L': bx[0] + c, 'R': bx[2] - c, 'T': bx[1] + c, 'B': bx[3] - c}

    def _rect_area(self, W, tab, outside):
        """cost.Mask.rect_area for rects W (..., 4) on SAT tables tab (...) with the outside flags (...)."""
        m = self.mask
        c = m.c
        a0 = torch.floor((W[..., 0] - m.x0) / c + EPS)
        a1 = torch.ceil((W[..., 2] - m.x0) / c - EPS)
        a1 = torch.where(a1 <= a0, a0 + 1, a1)
        b0 = torch.floor((W[..., 1] - m.y0) / c + EPS)
        b1 = torch.ceil((W[..., 3] - m.y0) / c - EPS)
        b1 = torch.where(b1 <= b0, b0 + 1, b1)
        i0, i1 = a0.clamp(min=0), a1.clamp(max=m.nx)
        j0, j1 = b0.clamp(min=0), b1.clamp(max=m.ny)
        empty = (i1 <= i0) | (j1 <= j0)
        total = torch.where(outside, (a1 - a0) * (b1 - b0), torch.zeros_like(a0))
        inside = torch.where(outside & ~empty, (i1 - i0) * (j1 - j0), torch.zeros_like(a0))
        ci0, ci1 = i0.clamp(0, m.nx).long(), i1.clamp(0, m.nx).long()
        cj0, cj1 = j0.clamp(0, m.ny).long(), j1.clamp(0, m.ny).long()
        S = self.SAT
        bad = S[tab, cj1, ci1] - S[tab, cj0, ci1] - S[tab, cj1, ci0] + S[tab, cj0, ci0]
        bad = torch.where(empty, torch.zeros_like(bad), bad)
        return (total - inside + bad) * (c * c)

    def forb_units(self, U, X, Y, Rt):
        """Forbidden area of units U (K,) at X, Y, Rt (K,) (cost.forbidden without the fixed test)."""
        rr = self.ER[U, :, :, :]  # K E 4 4
        rr = torch.gather(rr, 2, Rt[:, None, None, None].expand(-1, rr.shape[1], 1, 4)).squeeze(2)
        W = rr + torch.stack([X, Y, X, Y], dim=1)[:, None, :]
        sg = torch.gather(self.ES[U], 2, Rt[:, None, None].expand(-1, rr.shape[1], 1)).squeeze(2)
        f = (self._rect_area(W, self.ET[U], self.EO[U]) * sg).sum(dim=1)
        for i, at, sides, tol in self.edge:
            ax, ay = at[Rt, 0] + X, at[Rt, 1] + Y
            L = self.edge_lines
            d = {'L': (ax - L['L']).abs(), 'R': (L['R'] - ax).abs(), 'T': (ay - L['T']).abs(), 'B': (L['B'] - ay).abs()}
            miss = torch.clamp(torch.stack([d[s] for s in sides]).min(dim=0).values - tol, min=0)
            f = f + torch.where(U == i, miss, torch.zeros_like(miss))
        return f

    # nets: HPWL and RUDY
    def _net_setup(self, pr, p):
        nets = pr['nets']
        pins = [(k, q) for k, n in enumerate(nets) for q in n['pins']]
        self.PU = torch.as_tensor([q[0] for _, q in pins], device=self.dev)
        self.LP = self._t(np.array([[cost.rot_rect(q[1:5], r) for _, q in pins] for r in range(4)], dtype=float).reshape(4, -1, 4))
        mp = max(1, max(len(n['pins']) for n in nets)) if nets else 1
        NP = np.zeros((len(nets), mp), dtype=np.int64)
        k0 = 0
        for k, n in enumerate(nets):
            c = len(n['pins'])
            idx = list(range(k0, k0 + c)) or [0]
            NP[k] = (idx + [idx[0]] * mp)[:mp]
            k0 += c
        self.NP = torch.as_tensor(NP, device=self.dev)
        self.NW = self._t([float(n['weight']) for n in nets])
        self.NT = self._t([cost.track_factor(n, p) for n in nets])
        self.nonempty = self._t([1.0 if n['pins'] else 0.0 for n in nets])
        g = self.grid = cost.Grid(pr['board'], p['rudy_cell'])
        self.G0 = self._t(cost.fixed_grid(pr, p))
        cw = cost.cell_weights(pr, p)
        self.CW = None if cw is None else self._t(cw)
        self.thr = cost.threshold(p)
        self.gn = (g.ny, g.nx)

    def hpwl_cong(self, X, Y, Rt):
        """HPWL and RUDY overflow of K poses X, Y, Rt (K, n)."""
        K = X.shape[0]
        pu = self.PU
        rr = self.LP[Rt[:, pu], torch.arange(len(pu), device=self.dev)[None, :]]  # K P 4
        WP = rr + torch.stack([X[:, pu], Y[:, pu], X[:, pu], Y[:, pu]], dim=2)
        B = WP[:, self.NP]  # K N mp 4
        x0, y0 = B[..., 0].min(dim=2).values, B[..., 1].min(dim=2).values
        x1, y1 = B[..., 2].max(dim=2).values, B[..., 3].max(dim=2).values
        wl = (x1 - x0) + (y1 - y0)
        hp = (self.NW * wl * self.nonempty).sum(dim=1)
        g = self.grid
        ny, nx = self.gn
        a0 = torch.floor((x0 - g.x0) / g.c + EPS)
        a1 = torch.ceil((x1 - g.x0) / g.c - EPS)
        a1 = torch.where(a1 <= a0, a0 + 1, a1)
        b0 = torch.floor((y0 - g.y0) / g.c + EPS)
        b1 = torch.ceil((y1 - g.y0) / g.c - EPS)
        b1 = torch.where(b1 <= b0, b0 + 1, b1)
        i0, i1 = a0.clamp(min=0), a1.clamp(max=nx)
        j0, j1 = b0.clamp(min=0), b1.clamp(max=ny)
        ok = (i1 > i0) & (j1 > j0) & (wl > 0) & (self.nonempty > 0)
        v = torch.where(ok, self.NT * wl / torch.where(ok, (j1 - j0) * (i1 - i0), torch.ones_like(wl)),
                        torch.zeros_like(wl))
        ci0, ci1 = i0.clamp(0, nx).long(), i1.clamp(0, nx).long()
        cj0, cj1 = j0.clamp(0, ny).long(), j1.clamp(0, ny).long()
        D = torch.zeros((K, (ny + 1) * (nx + 1)), dtype=self.dt, device=self.dev)
        w1 = nx + 1
        idx = torch.cat([cj0 * w1 + ci0, cj0 * w1 + ci1, cj1 * w1 + ci0, cj1 * w1 + ci1], dim=1)
        D.scatter_add_(1, idx, torch.cat([v, -v, -v, v], dim=1))
        G = D.view(K, ny + 1, nx + 1).cumsum(dim=1).cumsum(dim=2)[:, :ny, :nx] + self.G0
        ex = torch.clamp(G - self.thr, min=0)
        if self.CW is not None:
            ex = ex * self.CW
        return hp, ex.sum(dim=(1, 2))

    # domain areas (mains): hull of the domain pad rects, penalty of the other units' rects
    def _area_setup(self, pr):
        areas, subj = cost.area_setup(pr)
        self.areas = []
        for src, g, fx in areas:
            s_idx = [int(self.off[i] + k) for i, ks in src for k in ks]
            j_idx = [int(self.off[i] + k) for i, idx in enumerate(subj) if idx is not None
                     and not (self.fixed[i] and fx) for k in idx]
            if j_idx:
                self.areas.append((torch.as_tensor(s_idx, device=self.dev), torch.as_tensor(j_idx, device=self.dev),
                                   float(g)))

    def area_pen(self, W):
        """Domain-area penalty of K poses (world rects W, K R 4)."""
        tot = torch.zeros(W.shape[0], dtype=self.dt, device=self.dev)
        for s_idx, j_idx, g in self.areas:
            Rs = W[:, s_idx]
            P = torch.stack([Rs[..., [0, 1]], Rs[..., [2, 1]], Rs[..., [2, 3]], Rs[..., [0, 3]]], dim=2).flatten(1, 2)
            tot = tot + _area_pen(W[:, j_idx], _hull(P), g).sum(dim=1)
        return tot

    # rects and pairs
    def world(self, X, Y, Rt):
        """World rects (K, R, 4) of K poses."""
        uo = self.UO
        rr = self.LR[Rt[:, uo], torch.arange(self.R, device=self.dev)[None, :]]
        return rr + torch.stack([X[:, uo], Y[:, uo], X[:, uo], Y[:, uo]], dim=2)

    def pair_rows(self, rows, rmask, W, cmask=None):
        """(hard, soft full) pair sums of the rects rows (K, M) against all rects of W (K, R, 4); cmask (K, R):
        rects whose pairs with the rows count half (the moved rects: pairs inside them once)."""
        K, M = rows.shape
        step = max(1, self.chunk // max(M * self.R, 1))
        if K > step:  # memory: blocks of chains
            out = [self.pair_rows(rows[a:a + step], rmask[a:a + step], W[a:a + step],
                                  None if cmask is None else cmask[a:a + step]) for a in range(0, K, step)]
            return torch.cat([o[0] for o in out]), torch.cat([o[1] for o in out])
        Ws = W + self.SH
        A = torch.gather(Ws, 1, rows[..., None].expand(-1, -1, 4))  # K M 4
        T = self.PT[rows.reshape(-1)].view(K, M, self.R, 2)
        ox = torch.minimum(A[:, :, None, 2], Ws[:, None, :, 2]) - torch.maximum(A[:, :, None, 0], Ws[:, None, :, 0])
        oy = torch.minimum(A[:, :, None, 3], Ws[:, None, :, 3]) - torch.maximum(A[:, :, None, 1], Ws[:, None, :, 1])
        wr = rmask[:, :, None].to(self.dt)
        if cmask is not None:
            wr = wr * (1.0 - 0.5 * cmask[:, None, :].to(self.dt))
        s = (_pen(ox, oy, T[..., 0]) * wr).sum(dim=(1, 2))
        h = (_pen(ox, oy, T[..., 1]) * wr).sum(dim=(1, 2))
        return h, s

    def pairs_full(self, W):
        """(hard, soft full) over all rect pairs of K poses (each pair once)."""
        K = W.shape[0]
        h = torch.zeros(K, dtype=self.dt, device=self.dev)
        s = torch.zeros_like(h)
        step = max(1, self.chunk // max(K * self.R, 1))
        allm = torch.ones((K, self.R), dtype=torch.bool, device=self.dev)
        for a in range(0, self.R, step):
            rows = torch.arange(a, min(a + step, self.R), device=self.dev)[None, :].expand(K, -1)
            hh, ss = self.pair_rows(rows, torch.ones_like(rows, dtype=torch.bool), W, allm)
            h, s = h + hh, s + ss
        return h, s

    def forb_all(self, X, Y, Rt):
        """Forbidden area per unit (K, n); 0 for a fixed unit."""
        K = X.shape[0]
        F = torch.zeros((K, self.n), dtype=self.dt, device=self.dev)
        for i in range(self.n):
            if not self.fixed[i]:
                U = torch.full((K,), i, dtype=torch.long, device=self.dev)
                F[:, i] = self.forb_units(U, X[:, i], Y[:, i], Rt[:, i])
        return F

    def tensors(self, poses):
        P = np.array([[list(q) for q in pose] for pose in poses], dtype=float)
        return self._t(P[..., 0]), self._t(P[..., 1]), torch.as_tensor(P[..., 2].astype(np.int64) % 4, device=self.dev)

    def components(self, poses):
        X, Y, Rt = self.tensors(poses)
        W = self.world(X, Y, Rt)
        hp, cg = self.hpwl_cong(X, Y, Rt)
        h, s = self.pairs_full(W)
        return {'hpwl': hp, 'cong': cg, 'overlap': h + self.area_pen(W), 'oob': self.forb_all(X, Y, Rt).sum(dim=1),
                'spacing': s - h}

    def weighted(self, c, p=None):
        p = p or self.p
        return (p['w_wl'] * c['hpwl'] + p['w_cong'] * c['cong'] + p['w_ov'] * c['overlap'] + p['w_oob'] * c['oob']
                + p['w_sp'] * c['spacing'])

    def total(self, poses):
        return self.weighted(self.components(poses))


class Chains:
    """K annealing chains from one start pose. Positions are integer steps of params['grid'] from the start."""

    def __init__(self, pr, params, start, chains=64, seed=1, device='cpu', bc=None):
        p = self.p = anneal.params_all(params)
        if p['schedule'] != 'geometric':
            raise ValueError('batch: only the geometric schedule is supported')
        self.bc = bc or BatchCost(pr, p, device)
        bc = self.bc
        self.dev, self.dt, self.K, self.n = bc.dev, bc.dt, chains, bc.n
        self.gen = torch.Generator().manual_seed(int(seed))
        self.g = p['grid']
        self.start = [(float(x), float(y), int(r) % 4) for x, y, r in start]
        self.X0 = bc._t([q[0] for q in self.start])
        self.Y0 = bc._t([q[1] for q in self.start])
        K, n = chains, self.n
        self.DX = torch.zeros((K, n), dtype=torch.long, device=self.dev)
        self.DY = torch.zeros_like(self.DX)
        self.Rt = torch.as_tensor([q[2] for q in self.start], device=self.dev).repeat(K, 1)
        # move set (anneal.Mover)
        self.box = tuple(pr['move_box']) if pr.get('move_box') else cost.outline_box(pr['board'])
        mov = [i for i in range(n) if not bc.fixed[i]]
        rot = [i for i in mov if pr['units'][i].get('rotate', True)]
        a = [float(sum((rc[2] - rc[0]) * (rc[3] - rc[1]) for rc in u['rects'])) for u in pr['units']]  # Evaluator.area
        q = p['swap_ratio']
        part = {i: [j for j in mov if j != i and max(a[i], a[j]) <= q * max(min(a[i], a[j]), 1e-9)] for i in mov}
        sw = [i for i in mov if part[i]]
        self.mov = torch.as_tensor(mov, device=self.dev)
        self.rot = torch.as_tensor(rot or [0], device=self.dev)
        self.has_rot = bool(rot)
        self.sw = torch.as_tensor(sw or [0], device=self.dev)
        self.has_sw = bool(sw)
        mp = max([len(part[i]) for i in sw] or [1])
        self.part = torch.as_tensor([(part[i] + [part[i][0]] * mp)[:mp] for i in sw] or [[0]], device=self.dev)
        self.npart = torch.as_tensor([len(part[i]) for i in sw] or [1], device=self.dev)
        maxr = max(bc.nr)
        self.UR = torch.as_tensor([list(range(bc.off[i], bc.off[i + 1])) + [int(bc.off[i])] * (maxr - bc.nr[i])
                                   for i in range(n)], device=self.dev)
        self.NR = torch.as_tensor(bc.nr, device=self.dev)
        self.evals = 0
        self._acc = torch.zeros((), dtype=torch.long, device=self.dev)
        self.set_params(p)

    def xy(self, DX=None, DY=None):
        DX = self.DX if DX is None else DX
        DY = self.DY if DY is None else DY
        return self.X0 + DX.to(self.dt) * self.g, self.Y0 + DY.to(self.dt) * self.g

    def resync(self):
        """Full recompute of the chain state terms (after a weight change or a state copy)."""
        bc = self.bc
        X, Y = self.xy()
        self.W = bc.world(X, Y, self.Rt)
        self.hp, self.cg = bc.hpwl_cong(X, Y, self.Rt)
        self.h, self.s = bc.pairs_full(self.W)
        self.ap = bc.area_pen(self.W)
        self.F = bc.forb_all(X, Y, self.Rt)
        self.cost = self._weighted(self.hp, self.cg, self.h, self.s, self.ap, self.F.sum(dim=1))

    def set_params(self, params):
        """New weights: recompute the state cost; the best so far restarts from the current state."""
        self.p = anneal.params_all(params)
        check_supported(self.bc.pr, self.p)
        self.resync()
        self.best = self.cost.clone()
        self.bDX, self.bDY, self.bR = self.DX.clone(), self.DY.clone(), self.Rt.clone()

    def _weighted(self, hp, cg, h, s, ap, fb):
        p = self.p
        return (p['w_wl'] * hp + p['w_cong'] * cg + p['w_ov'] * (h + ap) + p['w_oob'] * fb + p['w_sp'] * (s - h))

    @property
    def accepted(self):
        return int(self._acc)

    def _rand(self, *shape):
        return torch.rand(shape, generator=self.gen, dtype=torch.float64).to(self.dev, self.dt)

    def _pick(self, table, u):
        return table[(u * len(table)).long().clamp(max=len(table) - 1)]

    def propose(self, window):
        """One move per chain: (m1, m2, has2, DXn, DYn, Rn)."""
        K, g = self.K, self.g
        u, r1, r2, r3, r4 = (self._rand(K) for _ in range(5))
        p = self.p
        swap = (u < p['p_swap']) & self.has_sw
        rot = ~swap & (u < p['p_swap'] + p['p_rot']) & self.has_rot
        ar = torch.arange(K, device=self.dev)
        # translate
        i = self._pick(self.mov, r1)
        X, Y = self.xy()
        x, y = X[ar, i], Y[ar, i]
        bx0, by0, bx1, by1 = self.box
        dx = torch.round((2 * r3 - 1) * window / g)
        dy = torch.round((2 * r4 - 1) * window / g)
        dx = torch.minimum(torch.maximum(dx, torch.ceil((bx0 - x) / g - 1e-9)), torch.floor((bx1 - x) / g + 1e-9))
        dy = torch.minimum(torch.maximum(dy, torch.ceil((by0 - y) / g - 1e-9)), torch.floor((by1 - y) / g + 1e-9))
        # turn
        j = self._pick(self.rot, r1)
        # swap
        k = (r1 * len(self.sw)).long().clamp(max=len(self.sw) - 1)
        a = self.sw[k]
        b = self.part[k, (r2 * self.npart[k]).long().clamp(max=self.part.shape[1] - 1)]
        sdx = torch.round((X[ar, b] - X[ar, a]) / g).long()
        sdy = torch.round((Y[ar, b] - Y[ar, a]) / g).long()
        m1 = torch.where(swap, a, torch.where(rot, j, i))
        m2 = torch.where(swap, b, m1)
        DXn, DYn, Rn = self.DX.clone(), self.DY.clone(), self.Rt.clone()
        z = torch.zeros_like(sdx)
        d1x = torch.where(swap, sdx, torch.where(rot, z, dx.long()))
        d1y = torch.where(swap, sdy, torch.where(rot, z, dy.long()))
        r1n = torch.where(rot, (self.Rt[ar, j] + 1 + (r2 * 3).long().clamp(max=2)) % 4, self.Rt[ar, m1])
        n2x = torch.where(swap, self.DX[ar, b] - sdx, self.DX[ar, m1] + d1x)
        n2y = torch.where(swap, self.DY[ar, b] - sdy, self.DY[ar, m1] + d1y)
        n2r = torch.where(swap, self.Rt[ar, b], r1n)
        DXn[ar, m2], DYn[ar, m2], Rn[ar, m2] = n2x, n2y, n2r
        DXn[ar, m1] = self.DX[ar, m1] + d1x
        DYn[ar, m1] = self.DY[ar, m1] + d1y
        Rn[ar, m1] = r1n
        return m1, m2, swap, DXn, DYn, Rn

    def _rows(self, m1, m2, has2):
        nr1 = int(self.NR[m1].max())
        rows = [self.UR[m1][:, :nr1]]
        mask = [torch.arange(nr1, device=self.dev)[None, :] < self.NR[m1][:, None]]
        if bool(has2.any()):
            nr2 = int(self.NR[m2].max())
            rows.append(self.UR[m2][:, :nr2])
            mask.append((torch.arange(nr2, device=self.dev)[None, :] < self.NR[m2][:, None]) & has2[:, None])
        return torch.cat(rows, dim=1), torch.cat(mask, dim=1)

    def step(self, T, window):
        bc, K = self.bc, self.K
        ar = torch.arange(K, device=self.dev)
        m1, m2, has2, DXn, DYn, Rn = self.propose(window)
        Xn, Yn = self.xy(DXn, DYn)
        Wn = bc.world(Xn, Yn, Rn)
        rows, rmask = self._rows(m1, m2, has2)
        uo = bc.UO[None, :]
        cm = (uo == m1[:, None]) | ((uo == m2[:, None]) & has2[:, None])
        h0, s0 = bc.pair_rows(rows, rmask, self.W, cm)
        h1, s1 = bc.pair_rows(rows, rmask, Wn, cm)
        f1a = bc.forb_units(m1, Xn[ar, m1], Yn[ar, m1], Rn[ar, m1])
        f1b = bc.forb_units(m2, Xn[ar, m2], Yn[ar, m2], Rn[ar, m2])
        zero = torch.zeros_like(f1a)
        dfb = (f1a - self.F[ar, m1]) + torch.where(has2, f1b - self.F[ar, m2], zero)
        hp, cg = bc.hpwl_cong(Xn, Yn, Rn)
        ap = bc.area_pen(Wn) if bc.areas else self.ap
        hn, sn = self.h + (h1 - h0), self.s + (s1 - s0)
        fbn = self.F.sum(dim=1) + dfb
        cn = self._weighted(hp, cg, hn, sn, ap, fbn)
        d = cn - self.cost
        acc = (d <= 0) | (self._rand(K) < torch.exp(-d / T))
        self._acc += acc.sum()
        self.evals += K
        a1, a2, a3 = acc[:, None], acc[:, None, None], acc
        self.DX = torch.where(a1, DXn, self.DX)
        self.DY = torch.where(a1, DYn, self.DY)
        self.Rt = torch.where(a1, Rn, self.Rt)
        self.W = torch.where(a2, Wn, self.W)
        self.hp, self.cg = torch.where(a3, hp, self.hp), torch.where(a3, cg, self.cg)
        self.h, self.s = torch.where(a3, hn, self.h), torch.where(a3, sn, self.s)
        self.ap = torch.where(a3, ap, self.ap)
        Fn = self.F.clone()
        Fn[ar, m2] = torch.where(has2, f1b, Fn[ar, m2])
        Fn[ar, m1] = f1a
        self.F = torch.where(a1, Fn, self.F)
        self.cost = torch.where(a3, cn, self.cost)
        better = self.cost < self.best - 1e-12
        self.best = torch.where(better, self.cost, self.best)
        b1 = better[:, None]
        self.bDX = torch.where(b1, self.DX, self.bDX)
        self.bDY = torch.where(b1, self.DY, self.bDY)
        self.bR = torch.where(b1, self.Rt, self.bR)
        return acc

    def _poses(self, DX, DY, Rt):
        dx, dy, r = DX.cpu().numpy(), DY.cpu().numpy(), Rt.cpu().numpy()
        g = self.g
        return [[(x + float(dx[k, i]) * g, y + float(dy[k, i]) * g, int(r[k, i])) for i, (x, y, _) in enumerate(self.start)]
                for k in range(self.K)]

    def poses(self):
        return self._poses(self.DX, self.DY, self.Rt)

    def best_poses(self):
        return self._poses(self.bDX, self.bDY, self.bR)

    def restart_from(self, dst, src):
        """Chains dst restart from the best state of chain src."""
        idx = torch.as_tensor(dst, device=self.dev)
        for a, b in ((self.DX, self.bDX), (self.DY, self.bDY), (self.Rt, self.bR)):
            a[idx] = b[src]


def default_device():
    return 'mps' if torch.backends.mps.is_available() else 'cpu'


def optimize(pr, p, epochs, steps, seed, top, log=None, start=None):
    """Batched anneal.optimize: params chains (K), batch_device, finish (chains legalized, default 8)."""
    if p['schedule'] != 'geometric':
        raise ValueError('batch: only the geometric schedule is supported')
    K = int(p.get('chains') or 64)
    dev = p.get('batch_device') or 'cpu'
    anneal._init(pr, p)
    pf = anneal.epoch_params(p, epochs - 1, epochs)
    p0 = anneal.epoch_params(p, 0, epochs)
    ev0 = anneal._evaluator(start, p0)
    evf = anneal._evaluator(start, pf)
    initial = {'pose': evf.pose(), 'cost': evf.cost, 'components': evf.components()}
    bx0, by0, bx1, by1 = cost.outline_box(pr['board'])
    w0 = p.get('w0') or max(bx1 - bx0, by1 - by0) / 2
    w1 = min(p['w1'], w0)
    t0 = p.get('t0') or anneal.estimate_t0(ev0, anneal.Mover(pr, ev0, p), random.Random(seed), w0)
    t1 = t0 * p['t_ratio']
    ch = Chains(pr, p0, initial['pose'], chains=K, seed=seed, device=dev)
    t_start = time.time()
    history = []
    for e in range(epochs):
        if e:
            ch.set_params(anneal.epoch_params(p, e, epochs))
        for s in range(steps):
            f = (e + s / steps) / epochs
            ch.step(t0 * (t1 / t0) ** f, w0 * (w1 / w0) ** f)
        best = ch.best.cpu().numpy()
        g = int(np.argmin(best))
        history.append({'epoch': e + 1, 'cost': float(best[g]), 'pose': [list(q) for q in ch.best_poses()[g]]})
        if log:
            log('epoch %d/%d best %.2f (chain %d)' % (e + 1, epochs, best[g], g))
        if e < epochs - 1:
            cur = ch.cost.cpu().numpy()
            worse = [w for w in sorted(range(K), key=lambda w: (-cur[w], w))[:K // 2] if w != g]
            if worse:
                ch.restart_from(worse, g)
    wall = time.time() - t_start
    best = ch.best.cpu().numpy()
    order = sorted(range(K), key=lambda w: (best[w], w))[:int(p.get('finish') or 8)]
    bp = ch.best_poses()
    fin = [anneal._finish((w, bp[w], pf)) for w in order]
    fin.sort(key=anneal.final_key)
    cands = anneal.distinct(fin, p['distinct'], [u['fixed'] for u in pr['units']])
    return {'lam': None, 'initial': initial, 'candidates': cands[:top], 'history': history, 't0': t0, 'seed': seed,
            'workers': 1, 'epochs': epochs, 'steps': steps, 'params': p, 'wall_s': time.time() - t_start,
            'moves_per_s_per_worker': ch.evals / wall if wall else 0.0,
            'batch': {'chains': K, 'device': dev, 'evals': ch.evals, 'evals_per_s': ch.evals / wall if wall else 0.0}}


def anneal_budget(pr, p, start, seconds, seed, chains=256, device='cpu', clock=time.monotonic):
    """Benchmark driver (bench_batch.py): geometric schedule over a wall-clock budget, one weight set."""
    ev = cost.Evaluator(pr, p, pose=start)
    bx0, by0, bx1, by1 = cost.outline_box(pr['board'])
    w0, w1 = max(bx1 - bx0, by1 - by0) / 2, p['w1']
    t0 = anneal.estimate_t0(ev, anneal.Mover(pr, ev, p), random.Random(seed), w0)
    t1 = t0 * p['t_ratio']
    ch = Chains(pr, p, start, chains=chains, seed=seed, device=device)
    ch.step(t0, w0)  # warm-up (kernel compile on mps), not timed
    ch.set_params(p)
    ch.evals = 0
    ch._acc.zero_()
    t_start = clock()
    while True:
        f = (clock() - t_start) / seconds
        if f >= 1.0:
            break
        for _ in range(10):
            ch.step(t0 * (t1 / t0) ** f, w0 * (w1 / w0) ** f)
    dt = clock() - t_start
    best = ch.best.cpu().numpy()
    k = int(np.argmin(best))
    return {'evals': ch.evals, 'seconds': dt, 'evals_per_s': ch.evals / dt, 'best_pose': ch.best_poses()[k],
            'accept': ch.accepted / max(ch.evals, 1)}
