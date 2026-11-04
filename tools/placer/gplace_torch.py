"""Torch backend of the analytic global placement (gplace.py): the same WA wirelength, DCT Poisson density and
overflow as gplace.Model, on torch tensors. Select it with params backend='torch'.

Device: params['device'] ('cpu', 'mps'), else mps when available, else cpu. cpu runs in float64 (the numpy
values to 1e-9); mps has no float64 and runs in float32. The geometry, the turns, the projection and the
Nesterov loop stay in numpy: only the wa() and density() math runs on the device.
"""
import numpy as np
import torch

from . import gplace


class TorchModel(gplace.Model):
    def __init__(self, pr, params=None, pose=None):
        super().__init__(pr, params, pose)
        dev = self.p.get('device') or ('mps' if torch.backends.mps.is_available() else 'cpu')
        self.dev = torch.device(dev)
        self.dt = torch.float32 if self.dev.type == 'mps' else torch.float64
        t = self._t
        self.t_pu, self.t_pn = t(self.pu, torch.long), t(self.pn, torch.long)
        self.t_nw, self.t_mov = t(self.nw), t(self.mov, torch.long)
        self.t_ex, self.t_ey, self.t_F = t(self.ex), t(self.ey), t(self.F)
        self.t_Cx, self.t_Sx, self.t_Cy, self.t_Sy = t(self.Cx), t(self.Sx), t(self.Cy), t(self.Sy)
        self.t_inv, self.t_wu, self.t_wv = t(self.inv), t(self.wu), t(self.wv)

    def _t(self, a, dtype=None):
        return torch.as_tensor(np.asarray(a), dtype=dtype or self.dt, device=self.dev)

    def _np(self, a):
        return a.detach().cpu().double().numpy()

    def wa(self, x, y, gamma=None):
        """Weighted-average wirelength and its gradient (fixed units get 0)."""
        g = gamma or self.p['gamma'] or 1.0
        tot = 0.0
        grads = []
        pu, pn, nw, nn = self.t_pu, self.t_pn, self.t_nw, self.nnet
        for pos, d in ((x, self.pdx), (y, self.pdy)):
            q = self._t(pos)[pu] + self._t(d)
            dq = torch.zeros_like(q)
            for s in (1.0, -1.0):
                a = s * q / g
                m = torch.full((nn,), -float('inf'), dtype=self.dt, device=self.dev)
                m = m.scatter_reduce(0, pn, a, 'amax', include_self=True)
                e = torch.exp(a - m[pn])
                S = torch.zeros(nn, dtype=self.dt, device=self.dev).index_add_(0, pn, e)
                Sq = torch.zeros(nn, dtype=self.dt, device=self.dev).index_add_(0, pn, q * e)
                W = torch.where(S > 0, Sq / torch.where(S > 0, S, torch.ones_like(S)), torch.zeros_like(S))
                tot += s * float((nw * W).sum())
                dq += s * nw[pn] * e / S[pn] * (1 + s * (q - W[pn]) / g)
            gr = self._np(torch.zeros(self.n, dtype=self.dt, device=self.dev).index_add_(0, pu, dq))
            gr[self.fix] = 0.0
            grads.append(gr)
        return tot, grads[0], grads[1]

    def _overlaps_t(self, x, y):
        m = self.mov
        x0, x1 = self._t(x[m] + self.ox0[m]), self._t(x[m] + self.ox1[m])
        y0, y1 = self._t(y[m] + self.oy0[m]), self._t(y[m] + self.oy1[m])
        ex, ey = self.t_ex, self.t_ey
        ax = torch.clamp(torch.minimum(x1[:, None], ex[None, 1:]) - torch.maximum(x0[:, None], ex[None, :-1]), min=0)
        ay = torch.clamp(torch.minimum(y1[:, None], ey[None, 1:]) - torch.maximum(y0[:, None], ey[None, :-1]), min=0)
        return ax, ay

    def potential(self, rho):
        """(potential, field x, field y) on the bin centres, numpy in and out (see gplace.Model.potential)."""
        return tuple(self._np(v) for v in self._potential_t(self._t(rho)))

    def _potential_t(self, rho):
        a = self.t_Cx.T @ rho @ self.t_Cy * (4.0 / (self.nb * self.nb))
        a[0, :] *= 0.5
        a[:, 0] *= 0.5
        coef = a * self.t_inv
        psi = self.t_Cx @ coef @ self.t_Cy.T
        Ex = self.t_Sx @ (coef * self.t_wu[:, None]) @ self.t_Cy.T
        Ey = self.t_Cx @ (coef * self.t_wv[None, :]) @ self.t_Sy.T
        return psi, Ex, Ey

    def density(self, x, y):
        """(energy, grad x, grad y, overflow) of the movable units in the fixed charge."""
        ax, ay = self._overlaps_t(x, y)
        D = ax.T @ ay
        rho = (D + self.t_F) / self.barea
        psi, Ex, Ey = self._potential_t(rho)
        energy = 0.5 * float((rho * psi).sum()) * self.barea
        gx, gy = np.zeros(self.n), np.zeros(self.n)
        gx[self.mov] = -self._np(torch.einsum('ik,kl,il->i', ax, Ex, ay))
        gy[self.mov] = -self._np(torch.einsum('ik,kl,il->i', ax, Ey, ay))
        room = torch.clamp(self.p['target'] * self.barea - self.t_F, min=0)
        ovf = float(torch.clamp(D - room, min=0).sum()) / max(self.area[self.mov].sum(), 1e-9)
        return energy, gx, gy, ovf
