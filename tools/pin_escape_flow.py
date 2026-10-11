#!/usr/bin/env python3
"""Simultaneous pin escape as a vertex-disjoint max-flow (W18, 2026-10-11, CIP #831 item 2 "ready-to-route").

  $PY tools/pin_escape_flow.py BOARD.kicad_pcb [--layers F.Cu,B.Cu] [--in2-nets N,..] [--plane-nets GND,..]
        [--region x0,y0,x1,y1] [--only-nets N,..] [--escape-mm 3] [--json OUT]

Question: can all pins of a block leave it AT THE SAME TIME? tools/route_grid.py escape asks it per pad, so pins that
compete for the same exits all pass there (BASE-PWR-B U19: 0 boxed-in pads, 1-3 nets open after every router run).

Method: escape routing as network flow (Yan and Chen, "A network flow based approach for escape routing" / the BGA
escape routing literature, e.g. Yan, Wong, "Correctly modeling the diagonal capacity in escape routing"; Fang et al.,
"A network-flow-based RDL routing algorithm"). Each net that must leave the region is one unit of demand; the routing
space is a grid, cell capacity 1 by node splitting (a track occupies a cell); Dinic max-flow. All demand escapes at
once iff max-flow == demand. A min cut (cells reachable from the source in the residual graph whose out-node is not)
is where the competing nets run out of room.

Grid and rules (read from the .kicad_pro next to the board and its .kicad_dru when present):
- pitch = track width + clearance of the net class; the smallest pitch among the escaping nets (printed). Wider nets
  on that grid are optimistic (they occupy one cell; the class width is the router default, not a DRC minimum, and
  routers neck down at pads). Obstacles grow by the smallest clearance to any escaping net; so a net class whose
  clearances differ (for example POE or MAINS .kicad_dru rules) is also checked alone on its own pitch and clearances.
- a cell is blocked for track centres within clearance(item, net) + half track width of other nets' pads, tracks, vias
  and NPTH holes (hole clearance); within half track width of a no-track rule area (KiCad keepout semantics: no
  clearance); within edge clearance + half track width of the board edge (min_copper_edge_clearance, else 0.3 mm).
  Clearance = max(both net class clearances, last matching .kicad_dru clearance rule). Rule terms we cannot evaluate:
  a positive term skips the rule; a negated exemption "!(...)" is ignored (the rule applies; conservative). Zones are
  not obstacles (pours refill round tracks).
- escaping nets: a net's own copper (pads, tracks, vias) in the region is merged into its super-source (capacity 1);
  cells within its halo (clearance to the other escaping nets + half track width) are its own if no other net claims
  them, else blocked. Pad access: the source reaches the free 8-neighbours of its own cells (a straight or diagonal
  stub of <= 1.41 pitch; this absorbs the grid alignment of fine-pitch pins; stubs are not checked for crossing).
- 4-neighbour moves per layer, no 45-degree moves. A via (layer change) is allowed at a cell where a via of the class
  diameter plus clearance clears other nets' copper on every copper layer (through-hole) and the edge; vias are
  modelled as joining the same cell on two layers (the via's larger footprint on its neighbours is not charged).
- --in2-nets: In2.Cu is added for those nets only; flow enters In2.Cu only from their sources (no other net can reach
  it), and may leave it by via.
- sources: non-plane nets with a pad centre inside the region and another pad outside it or on another part
  (--only-nets restricts this); one unit each, all its pads in the region merged (region mode).
  Sinks: free cells on the region boundary ring (and a net whose own copper already reaches it).
- whole-board mode (no --region): every footprint with >= 8 pads (plus, with --only-nets, every footprint with a pad
  of those nets) is its own region = courtyard bbox grown by --escape-mm; sources are that footprint's pads only (the
  net's pads on other parts block the other escaping nets).
Output: one line per region "PIN_ESCAPE PASS|FAIL region ... demand D flow F unescaped [...] cut [...]", then
"PIN_ESCAPE_SUMMARY ...". The unescaped nets are one valid choice of the losers (max-flow is not unique); "contested"
lists every net whose source is on the source side of the min cut (they share the bottleneck). Exit 1 on any FAIL.
"""
import argparse
import collections
import fnmatch
import json
import os
import re
import sys
import time
from collections import deque

import numpy as np
import pcbnew

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from route_features import Obj, Unknown, cond_eval, dru_rules, mm  # noqa: E402
from route_grid import in_poly, poly_dist, poly_pts, seg_dist  # noqa: E402

NM = 1e6
INF = 1 << 30
IN2 = 'In2.Cu'


def read(path):
    with open(path) as fh:
        return fh.read()


# ---------------------------------------------------------------- rules
class Rules:
    def __init__(self, board, pcb_path):
        base = os.path.splitext(pcb_path)[0]
        pro = json.loads(read(base + '.kicad_pro')) if os.path.exists(base + '.kicad_pro') else {}
        ns = pro.get('net_settings', {})
        self.classes = {c['name']: c for c in ns.get('classes', [])}
        if 'Default' not in self.classes:
            self.classes['Default'] = {'name': 'Default', 'track_width': 0.2, 'clearance': 0.2, 'via_diameter': 0.6}
        self.patterns = ns.get('netclass_patterns') or []
        self.assign = ns.get('netclass_assignments') or {}
        r = pro.get('board', {}).get('design_settings', {}).get('rules', {})
        self.edge = r.get('min_copper_edge_clearance', 0.3) or 0.3
        self.hole = r.get('min_hole_clearance', 0.25) or 0.25
        self.rules, self.notes = [], []
        if os.path.exists(base + '.kicad_dru'):
            for ru in dru_rules(read(base + '.kicad_dru')):
                for c in ru['constraints']:
                    if c[0] in ('clearance', 'edge_clearance'):
                        mn = [x for x in c[1:] if isinstance(x, list) and x[0] == 'min']
                        if mn:
                            self.rules.append((c[0], ru['name'], ru['condition'], mm(mn[0][1])))
        self.board = board
        self._cls, self._clr = {}, {}

    def cls(self, net):
        if net in self._cls:
            return self._cls[net]
        name = None
        if net in self.assign:
            a = self.assign[net]
            name = a[0] if isinstance(a, list) else a
        if name is None:
            hits = [p['netclass'] for p in self.patterns if fnmatch.fnmatchcase(net, p['pattern'])]
            name = next((h for h in hits if h != 'Default'), None)
        if name is None and net:
            try:
                n = str(self.board.GetNetsByName()[net].GetNetClassName())
                name = next((x for x in n.split(',') if x in self.classes and x != 'Default'), None)
            except Exception:  # noqa: BLE001
                pass
        c = self.classes.get(name or 'Default', self.classes['Default'])
        self._cls[net] = c
        return c

    def _rule(self, cond, a, b):
        try:
            return cond_eval(cond, a, b)
        except Unknown:
            pass
        except Exception:  # noqa: BLE001
            return False
        c2 = re.sub(r'&&\s*!\((?:[^()]|\((?:[^()]|\([^()]*\))*\))*\)', '', cond)
        if c2 != cond:
            try:
                r = cond_eval(c2, a, b)
                if r:
                    self.notes.append(f'dru exemption ignored (conservative): {cond[:80]}')
                return r
            except Exception:  # noqa: BLE001
                return False
        return False

    def clearance(self, net_a, kind_a, net_b):
        """Clearance between an item of net_a (kind 'Pad'/'Track'/'Via') and a track of net_b."""
        key = (net_a, kind_a, net_b)
        if key in self._clr:
            return self._clr[key]
        v = max(self.cls(net_a)['clearance'], self.cls(net_b)['clearance'])
        dru = None
        for kind, _name, cond, val in self.rules:
            if kind != 'clearance':
                continue
            A = Obj(net_a, self.cls(net_a)['name'], kind_a)
            B = Obj(net_b, self.cls(net_b)['name'], 'Track')
            if self._rule(cond, A, B) or self._rule(cond, B, A):
                dru = val  # later rules win
        if dru is not None:
            v = max(v, dru)
        self._clr[key] = v
        return v


# ---------------------------------------------------------------- board items
class Item:
    __slots__ = ('net', 'name', 'layers', 'kind', 'seg', 'hw', 'polys', 'bb', 'lclr', 'ref')

    def __init__(self, net, name, layers, kind, seg=None, hw=0.0, polys=None, lclr=0.0, ref=None):
        self.net, self.name, self.layers, self.kind = net, name, layers, kind
        self.seg, self.hw, self.polys, self.lclr, self.ref = seg, hw, polys, lclr, ref
        if seg is not None:
            x1, y1, x2, y2 = seg
            self.bb = (min(x1, x2) - hw, min(y1, y2) - hw, max(x1, x2) + hw, max(y1, y2) + hw)
        else:
            a = np.vstack(polys)
            self.bb = (a[:, 0].min(), a[:, 1].min(), a[:, 0].max(), a[:, 1].max())

    def dist(self, px, py):
        if self.seg is not None:
            return np.maximum(seg_dist(px, py, *self.seg) - self.hw, 0.0)
        d = np.full(px.shape, np.inf)
        ins = np.zeros(px.shape, bool)
        for pts in self.polys:
            ins |= in_poly(px, py, pts)
            d = np.minimum(d, poly_dist(px, py, pts))
        d[ins] = 0.0
        return d


def collect(b):
    cu = [b.GetLayerName(l) for l in b.GetEnabledLayers().CuStack()]
    lid = {l: b.GetLayerID(l) for l in cu}
    items, pads = [], []
    for fp in b.GetFootprints():
        ref = fp.GetReference()
        for p in fp.Pads():
            net = p.GetNetname()
            nm = f'{ref}.{p.GetNumber()}'
            x, y = p.GetPosition().x / NM, p.GetPosition().y / NM
            if p.GetAttribute() == pcbnew.PAD_ATTRIB_NPTH:
                d = max(p.GetDrillSize().x, p.GetDrillSize().y) / NM
                items.append(Item('', nm + '(hole)', set(cu), 'Hole', seg=(x, y, x, y), hw=d / 2, ref=ref))
            pls = [l for l in cu if p.IsOnLayer(lid[l])]
            if not pls:
                continue
            ps = pcbnew.SHAPE_POLY_SET()
            p.TransformShapeToPolygon(ps, lid[pls[0]], 0, 5000, pcbnew.ERROR_INSIDE)
            try:
                lc = p.GetLocalClearance()
                lc = (lc or 0) / NM
            except Exception:  # noqa: BLE001
                lc = 0.0
            it = Item(net, nm, set(pls), 'Pad', polys=poly_pts(ps), lclr=lc, ref=ref)
            items.append(it)
            pads.append((it, fp, x, y))
    for t in b.GetTracks():
        net = t.GetNetname()
        if t.GetClass() == 'PCB_VIA':
            x, y = t.GetPosition().x / NM, t.GetPosition().y / NM
            items.append(Item(net, f'via {net}', set(cu), 'Via', seg=(x, y, x, y), hw=t.GetWidth(lid[cu[0]]) / NM / 2))
            continue
        ln = t.GetLayerName()
        if t.GetClass() == 'PCB_ARC':
            ps = pcbnew.SHAPE_POLY_SET()
            t.TransformShapeToPolygon(ps, t.GetLayer(), 0, 5000, pcbnew.ERROR_INSIDE)
            items.append(Item(net, f'track {net}', {ln}, 'Track', polys=poly_pts(ps)))
        else:
            s, e = t.GetStart(), t.GetEnd()
            items.append(Item(net, f'track {net}', {ln}, 'Track', seg=(s.x / NM, s.y / NM, e.x / NM, e.y / NM),
                              hw=t.GetWidth() / NM / 2))
    for z in b.Zones():
        if not z.GetIsRuleArea():
            continue
        zl = {l for l in cu if z.IsOnLayer(lid[l])}
        if not zl:
            continue
        polys = poly_pts(z.Outline())
        nm = 'keepout:' + (z.GetZoneName() or '?')
        if z.GetDoNotAllowTracks():
            items.append(Item('', nm, zl, 'KeepTrack', polys=polys))
        if z.GetDoNotAllowVias():
            items.append(Item('', nm, zl, 'KeepVia', polys=polys))
    ps = pcbnew.SHAPE_POLY_SET()
    b.GetBoardPolygonOutlines(ps, True)
    return cu, items, pads, poly_pts(ps)


# ---------------------------------------------------------------- max-flow (Dinic)
def dinic(n, U, V, C, s, t):
    """Edges U->V with capacity C (numpy). Returns (flow, cap array, to, adjacency) for residual queries."""
    m = len(U)
    frm = np.empty(2 * m, np.int64); to = np.empty(2 * m, np.int64); cap = np.zeros(2 * m, np.int64)
    frm[0::2], frm[1::2] = U, V
    to[0::2], to[1::2] = V, U
    cap[0::2] = C
    order = np.argsort(frm, kind='stable')
    start = np.searchsorted(frm[order], np.arange(n + 1))
    adj, st, to_l, cap_l = order.tolist(), start.tolist(), to.tolist(), cap.tolist()
    flow = 0
    while True:
        level = [-1] * n
        level[s] = 0
        q = deque([s])
        while q:
            u = q.popleft()
            for k in range(st[u], st[u + 1]):
                e = adj[k]
                v = to_l[e]
                if cap_l[e] > 0 and level[v] < 0:
                    level[v] = level[u] + 1
                    q.append(v)
        if level[t] < 0:
            break
        it = st[:]
        while True:
            stack, path = [s], []
            while stack and stack[-1] != t:
                u = stack[-1]
                moved = False
                while it[u] < st[u + 1]:
                    e = adj[it[u]]
                    v = to_l[e]
                    if cap_l[e] > 0 and level[v] == level[u] + 1:
                        stack.append(v); path.append(e); moved = True
                        break
                    it[u] += 1
                if not moved:
                    level[u] = -2
                    stack.pop()
                    if path:
                        path.pop()
            if not stack:
                break
            f = min(cap_l[e] for e in path)
            for e in path:
                cap_l[e] -= f
                cap_l[e ^ 1] += f
            flow += f
    return flow, cap_l, to_l, adj, st


def residual_reach(s, cap_l, to_l, adj, st, n):
    seen = [False] * n
    seen[s] = True
    q = deque([s])
    while q:
        u = q.popleft()
        for k in range(st[u], st[u + 1]):
            e = adj[k]
            if cap_l[e] > 0 and not seen[to_l[e]]:
                seen[to_l[e]] = True
                q.append(to_l[e])
    return seen


# ---------------------------------------------------------------- one region
class Checker:
    def __init__(self, pcb, layers, in2_nets, plane_nets, only_nets):
        self.b = pcbnew.LoadBoard(pcb)
        self.rules = Rules(self.b, pcb)
        self.cu, self.items, self.pads, self.outline = collect(self.b)
        self.in2 = set(in2_nets or [])
        self.layers = [l for l in layers if l in self.cu]
        if self.in2 and IN2 not in self.layers and IN2 in self.cu:
            self.layers.append(IN2)
        self.restricted = {IN2} if self.in2 else set()
        self.plane = set(plane_nets or [])
        self.only = set(only_nets) if only_nets else None
        self.net_pads = collections.defaultdict(list)
        for it, fp, x, y in self.pads:
            if it.net:
                self.net_pads[it.net].append((x, y, fp.GetReference()))
        self.bbs = np.array([it.bb for it in self.items])

    def demand(self, rect, fp_ref=None):
        x0, y0, x1, y1 = rect
        inside = lambda x, y: x0 <= x <= x1 and y0 <= y <= y1  # noqa: E731
        out = []
        for net, pl in sorted(self.net_pads.items()):
            if net in self.plane or (self.only is not None and net not in self.only):
                continue
            if fp_ref is not None and not any(r == fp_ref for _, _, r in pl):
                continue
            mine = [(x, y, r) for x, y, r in pl if inside(x, y) and (fp_ref is None or r == fp_ref)]
            # must leave: a pad outside the region, or a pad on another part (signal nets only reach here)
            if mine and any(not inside(x, y) or r != mine[0][2] for x, y, r in pl):
                out.append(net)
        return out

    def run(self, name, rect, fp_ref=None):
        """All demand nets on the smallest class pitch; with mixed net classes also each class alone on its own pitch
        and clearances (a necessary condition the mixed run is too optimistic for). FAIL if any run fails."""
        t0 = time.time()
        D = self.demand(rect, fp_ref)
        res = self._flow(name, rect, fp_ref, D)
        R = self.rules
        groups = collections.defaultdict(list)
        for k in D:
            groups[R.cls(k)['name']].append(k)
        if len(groups) > 1:
            # a class gets its own run only when its clearances differ from the pitch class (clearance is a DRC
            # constraint; the net class track width is only the router default, routers neck down at pads)
            kmin = min(D, key=lambda k: R.cls(k)['track_width'] + R.cls(k)['clearance'])
            x0, y0, x1, y1 = rect
            near = {it.net for it, _fp, x, y in self.pads if x0 <= x <= x1 and y0 <= y <= y1}
            own = [(c, ks) for c, ks in groups.items()
                   if any(R.clearance(n, 'Pad', ks[0]) != R.clearance(n, 'Pad', kmin) for n in near)]
            res['per_class'] = []
            for cname, ks in sorted(own):
                sub = self._flow(name, rect, fp_ref, ks)
                res['per_class'].append({k: sub[k] for k in ('demand_nets', 'demand', 'flow', 'verdict', 'unescaped',
                                                             'contested', 'cut', 'pitch_mm', 'pitch_class')})
                if sub['verdict'] == 'FAIL':
                    if res['verdict'] == 'PASS':
                        res['cut'] = sub['cut']
                    res['verdict'] = 'FAIL'
                    res['unescaped'] = res['unescaped'] + [k for k in sub['unescaped'] if k not in res['unescaped']]
                    res['contested'] = res['contested'] + [k for k in sub['contested'] if k not in res['contested']]
                    res['failed_classes'] = res.get('failed_classes', []) + [cname]
        res['time_s'] = round(time.time() - t0, 3)
        return res

    def _flow(self, name, rect, fp_ref, D):
        t0 = time.time()
        res = {'region': name, 'rect': [round(v, 3) for v in rect], 'demand_nets': D, 'demand': len(D)}
        if not D:
            res.update(flow=0, verdict='PASS', unescaped=[], contested=[], cut=None, time_s=round(time.time() - t0, 3))
            return res
        R = self.rules
        cls = {k: R.cls(k) for k in D}
        pitch_k = {k: cls[k]['track_width'] + cls[k]['clearance'] for k in D}
        kmin = min(D, key=lambda k: pitch_k[k])
        p = pitch_k[kmin]
        res['pitch_mm'] = round(p, 4)
        res['pitch_class'] = cls[kmin]['name']
        hw = {k: cls[k]['track_width'] / 2 for k in D}
        vr = min(cls[k]['via_diameter'] for k in D) / 2
        x0, y0, x1, y1 = rect
        nx, ny = max(2, int(np.ceil((x1 - x0) / p))), max(2, int(np.ceil((y1 - y0) / p)))
        xs, ys = x0 + (np.arange(nx) + 0.5) * p, y0 + (np.arange(ny) + 0.5) * p
        PX, PY = np.meshgrid(xs, ys)
        L = self.layers
        nl = len(L)
        kidx = {k: i for i, k in enumerate(D)}
        Dset = set(D)
        # board edge
        ins = np.zeros(PX.shape, bool)
        dedge = np.full(PX.shape, np.inf)
        for pts in self.outline:
            ins ^= in_poly(PX, PY, pts)
            dedge = np.minimum(dedge, poly_dist(PX, PY, pts))
        hwmin = min(hw.values())
        edge_blk = ~ins | (dedge < R.edge + hwmin)
        edge_via = ~ins | (dedge < R.edge + vr)
        blk = [edge_blk.copy() for _ in L]                       # blocked by non-escaping things
        owner = [np.full(PX.shape, -1, int) for _ in L]          # last item index blocking (for the cut report)
        own_d = [np.full(PX.shape, np.inf) for _ in L]           # distance to nearest escaping copper
        own_k = [np.full(PX.shape, -1, int) for _ in L]          # ... and its net
        halo_n = [np.zeros(PX.shape, np.int16) for _ in L]       # how many escaping nets' halos cover the cell
        halo_k = [np.full(PX.shape, -1, int) for _ in L]
        via_blk = edge_via.copy()
        via_n = np.zeros(PX.shape, np.int16)
        via_k = np.full(PX.shape, -1, int)
        # halo radius of an escaping net's copper = min clearance to the other escaping nets + their half width
        ro = {}
        for k in D:
            others = [R.clearance(k, 'Track', o) + hw[o] for o in D if o != k]
            ro[k] = min(others) if others else 0.0
        rmax = max([R.clearance('', 'Pad', k) for k in D] + [8.0]) + vr + p
        bb = self.bbs
        sel = np.nonzero((bb[:, 2] >= x0 - rmax) & (bb[:, 0] <= x1 + rmax) & (bb[:, 3] >= y0 - rmax) & (bb[:, 1] <= y1 + rmax))[0]
        for idx in sel:
            it = self.items[idx]
            if it.kind in ('KeepTrack', 'KeepVia'):
                rt = None if it.kind == 'KeepVia' else hwmin
                rv = vr
            elif it.kind == 'Hole':
                rt = R.hole + hwmin
                rv = R.hole + vr
            else:
                cl = {k: max(R.clearance(it.net, it.kind, k), it.lclr) for k in D if k != it.net}
                rt = min((cl[k] + hw[k] for k in cl), default=None)
                rv = min((cl[k] for k in cl), default=0.0) + vr
            # per-part mode: only the part's own pads (and the net's tracks/vias) are its source copper; the net's
            # pads on other parts block the other escaping nets only
            esc = it.net in Dset and (fp_ref is None or it.kind != 'Pad' or it.ref == fp_ref)
            k = kidx.get(it.net, -1)
            rbig = max(rt or 0.0, rv, (ro[it.net] + p) if esc else 0.0)  # p: own-copper cells reach d <= p/2
            a0 = max(0, int((it.bb[0] - rbig - x0) / p)); a1 = min(nx, int((it.bb[2] + rbig - x0) / p) + 2)
            b0 = max(0, int((it.bb[1] - rbig - y0) / p)); b1 = min(ny, int((it.bb[3] + rbig - y0) / p) + 2)
            if a1 <= a0 or b1 <= b0:
                continue
            d = it.dist(PX[b0:b1, a0:a1], PY[b0:b1, a0:a1])
            sl = (slice(b0, b1), slice(a0, a1))
            # vias are through-hole: every copper layer of the item counts
            if rv is not None and it.kind != 'KeepTrack':
                vm = d < rv
                if esc:
                    vn = via_n[sl]; vk = via_k[sl]
                    new = vm & (vk != k)
                    vn[new] += 1
                    vk[new] = k
                else:
                    via_blk[sl] |= vm
            for li, l in enumerate(L):
                if l not in it.layers or it.kind == 'KeepVia':
                    continue
                if esc:
                    cm = d <= 0.5 * p
                    od, ok = own_d[li][sl], own_k[li][sl]
                    better = cm & (d < od)
                    od[better] = d[better]; ok[better] = k
                    if rt is not None or ro[it.net] > 0:
                        hm = d < ro[it.net]
                        hn, hk = halo_n[li][sl], halo_k[li][sl]
                        new = hm & (hk != k)
                        hn[new] += 1; hk[new] = k
                elif rt is not None:
                    m = d < rt
                    blk[li][sl] |= m
                    owner[li][sl][m] = idx
            if esc:
                # make sure a pad smaller than a cell still owns its nearest cell
                if it.kind == 'Pad':
                    cx, cy = (it.bb[0] + it.bb[2]) / 2, (it.bb[1] + it.bb[3]) / 2
                    i, j = int((cx - x0) / p), int((cy - y0) / p)
                    if 0 <= i < nx and 0 <= j < ny:
                        for li, l in enumerate(L):
                            if l in it.layers and own_k[li][j, i] < 0:
                                own_k[li][j, i] = k; own_d[li][j, i] = 0.0
        # cell states: -1 free, k private to net k, -2 blocked
        state = []
        for li in range(nl):
            s = np.full(PX.shape, -1, int)
            hb = halo_n[li] > 1
            s[blk[li] | hb] = -2
            one = (halo_n[li] == 1) & ~blk[li]
            s[one] = halo_k[li][one]
            cop = own_k[li] >= 0
            # own copper overrides other nets' halos, not other nets' copper (blk core) - approximated by halo
            s[cop] = own_k[li][cop]
            state.append(s)
        via_all = ~via_blk & (via_n == 0)
        # pad access: the free 8-neighbours of a net's own cells (a straight or diagonal stub of <= 1.41 pitch; it
        # absorbs the grid alignment of fine-pitch pins)
        acc, rim = [], []
        for li in range(nl):
            a = np.zeros((len(D),) + PX.shape, bool)
            rm = np.zeros((len(D),) + PX.shape, bool)
            for k in range(len(D)):
                o = state[li] == k
                g = o.copy()
                g[1:, :] |= o[:-1, :]; g[:-1, :] |= o[1:, :]
                h = g.copy()
                h[:, 1:] |= g[:, :-1]; h[:, :-1] |= g[:, 1:]
                a[k] = h & (state[li] == -1)
                rm[k] = h & ~o
            acc.append(a)
            rim.append(rm)
        ncell = nx * ny
        N = 2 * nl * ncell
        S, T = N, N + 1
        SK = N + 2
        n = SK + len(D)
        ids = np.arange(ncell).reshape(ny, nx)
        U, V, C = [], [], []

        def add(u, v, c):
            u, v, c = np.broadcast_arrays(np.asarray(u, np.int64).ravel(), np.asarray(v, np.int64).ravel(),
                                          np.asarray(c, np.int64))
            U.append(u.copy()); V.append(v.copy()); C.append(c.copy())
        ring = np.zeros(PX.shape, bool)
        ring[0, :] = ring[-1, :] = ring[:, 0] = ring[:, -1] = True
        free = [state[li] == -1 for li in range(nl)]
        for li in range(nl):
            base = li * ncell
            f = free[li]
            cid = ids + base
            add(2 * cid[f], 2 * cid[f] + 1, 1)
            h = f[:, :-1] & f[:, 1:]
            a, bq = cid[:, :-1][h], cid[:, 1:][h]
            add(2 * a + 1, 2 * bq, INF); add(2 * bq + 1, 2 * a, INF)
            v = f[:-1, :] & f[1:, :]
            a, bq = cid[:-1, :][v], cid[1:, :][v]
            add(2 * a + 1, 2 * bq, INF); add(2 * bq + 1, 2 * a, INF)
            add(2 * cid[f & ring] + 1, T, INF)
        for li in range(nl):
            for mi in range(nl):
                if li == mi:
                    continue
                if L[mi] in self.restricted and L[li] not in self.restricted:
                    continue
                vm = free[li] & free[mi] & via_all
                add(2 * (ids[vm] + li * ncell) + 1, 2 * (ids[vm] + mi * ncell), INF)
        for k, net in enumerate(D):
            sk = SK + k
            add([S], [sk], 1)
            allow = [li for li in range(nl) if L[li] not in self.restricted or net in self.in2]
            touch = np.zeros(PX.shape, bool)
            reach_t = False
            for li in range(nl):
                priv = state[li] == k
                touch |= priv | acc[li][k]
                if li in allow:
                    tgt = free[li] & acc[li][k]
                    add(np.full(int(tgt.sum()), sk), 2 * (ids[tgt] + li * ncell), INF)
                    if (priv & ring).any():
                        reach_t = True
            viak = ~via_blk & ((via_n == 0) | ((via_n == 1) & (via_k == k)))
            for mi in allow:
                tgt = touch & viak & free[mi]
                add(np.full(int(tgt.sum()), sk), 2 * (ids[tgt] + mi * ncell), INF)
            if reach_t:
                add([sk], [T], INF)
        U, V, C = np.concatenate(U), np.concatenate(V), np.concatenate(C)
        flow, cap_l, to_l, adj, st = dinic(n, U, V, C, S, T)
        res['flow'] = flow
        res['verdict'] = 'PASS' if flow == len(D) else 'FAIL'
        res['grid'] = [nx, ny, nl]
        # which nets carry flow: residual capacity of S->S_k edge is 0 when used
        used = set()
        for kk in range(st[S], st[S + 1]):
            e = adj[kk]
            if e % 2 == 0 and cap_l[e] == 0:
                used.add(to_l[e] - SK)
        res['unescaped'] = [D[k] for k in range(len(D)) if k not in used]
        res['cut'] = None
        res['contested'] = []
        if res['verdict'] == 'FAIL':
            seen = residual_reach(S, cap_l, to_l, adj, st, n)
            res['contested'] = [D[k] for k in range(len(D)) if seen[SK + k]]
            cells = []
            for li in range(nl):
                cid = ids + li * ncell
                f = free[li]
                sin = np.array(seen[:N:2]).reshape(nl, ny, nx)[li]
                sout = np.array(seen[1:N:2]).reshape(nl, ny, nx)[li]
                cut = f & sin & ~sout
                for j, i in zip(*np.nonzero(cut)):
                    cells.append((li, j, i))
            near = collections.Counter()
            for li, j, i in cells:
                for jj in range(max(0, j - 2), min(ny, j + 3)):
                    for ii in range(max(0, i - 2), min(nx, i + 3)):
                        o = owner[li][jj, ii]
                        if o >= 0:
                            near[self.items[o].name] += 1
                        elif state[li][jj, ii] >= 0:
                            near['own:' + D[state[li][jj, ii]]] += 1
            if cells:
                cx = [xs[i] for _, _, i in cells]; cy = [ys[j] for _, j, _ in cells]
                res['cut'] = {'cells': len(cells), 'layers': sorted({L[li] for li, _, _ in cells}),
                              'bbox': [round(float(min(cx)), 2), round(float(min(cy)), 2), round(float(max(cx)), 2),
                                       round(float(max(cy)), 2)],
                              'near': [n_ for n_, _ in near.most_common(8)]}
            else:
                for k in range(len(D)):
                    if not seen[SK + k]:
                        continue
                    for li in range(nl):
                        for j, i in zip(*np.nonzero(rim[li][k])):
                            o = owner[li][j, i]
                            if o >= 0 and self.items[o].net != D[k]:
                                near[self.items[o].name] += 1
                            elif state[li][j, i] >= 0 and state[li][j, i] != k:
                                near['own:' + D[state[li][j, i]]] += 1
                res['cut'] = {'cells': 0, 'note': 'sources boxed in: no free cell reachable (cut at the source)',
                              'near': [n_ for n_, _ in near.most_common(8)]}
        res['time_s'] = round(time.time() - t0, 3)
        return res

    def footprint_regions(self, escape_mm):
        out = []
        for fp in self.b.GetFootprints():
            ref = fp.GetReference()
            pads = list(fp.Pads())
            want = len(pads) >= 8
            if self.only is not None:
                want = any(p.GetNetname() in self.only for p in pads)
            if not want:
                continue
            bb = None
            for lay in (pcbnew.F_CrtYd, pcbnew.B_CrtYd):
                cy = fp.GetCourtyard(lay)
                if cy.OutlineCount():
                    bx = cy.BBox()
                    bb = (bx.GetX() / NM, bx.GetY() / NM, (bx.GetX() + bx.GetWidth()) / NM,
                          (bx.GetY() + bx.GetHeight()) / NM)
                    break
            if bb is None:
                xs = [q.GetPosition().x / NM for q in pads]; ys = [q.GetPosition().y / NM for q in pads]
                bb = (min(xs), min(ys), max(xs), max(ys))
            e = escape_mm
            out.append((ref, (bb[0] - e, bb[1] - e, bb[2] + e, bb[3] + e)))
        return out


def fmt(r):
    cut = r.get('cut')
    cs = '[]'
    if cut:
        cs = f"[{cut['cells']} cells {'/'.join(cut.get('layers', []))} bbox {cut.get('bbox', '-')} near {', '.join(cut['near'][:5])}]"
    fc = f" failed_classes {r['failed_classes']}" if r.get('failed_classes') else ''
    return (f"PIN_ESCAPE {r['verdict']} region {r['region']} {r['rect']} demand {r['demand']} flow {r['flow']}{fc} "
            f"unescaped {r['unescaped']} contested {r['contested']} cut {cs} pitch {r.get('pitch_mm', '-')} mm "
            f"({r.get('pitch_class', '-')}) {r['time_s']} s")


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.split('\n')[0])
    ap.add_argument('board')
    ap.add_argument('--layers', default='F.Cu,B.Cu')
    ap.add_argument('--in2-nets', default='')
    ap.add_argument('--plane-nets', default='')
    ap.add_argument('--region', default='')
    ap.add_argument('--only-nets', default='')
    ap.add_argument('--escape-mm', type=float, default=3.0)
    ap.add_argument('--json', default='')
    a = ap.parse_args(argv)
    t0 = time.time()
    sp = lambda s: [x for x in s.split(',') if x]  # noqa: E731
    ck = Checker(a.board, sp(a.layers), sp(a.in2_nets), sp(a.plane_nets), sp(a.only_nets) or None)
    if a.region:
        rect = tuple(float(v) for v in a.region.split(','))
        regions = [('rect', rect, None)]
    else:
        regions = [(ref, r, ref) for ref, r in ck.footprint_regions(a.escape_mm)]
        print(f"PIN_ESCAPE whole-board: footprints checked {[r for r, _, _ in regions]}")
    out = []
    for name, rect, ref in regions:
        r = ck.run(name, rect, ref)
        out.append(r)
        if r['demand']:
            print(fmt(r))
    fails = [r for r in out if r['verdict'] == 'FAIL']
    wall = round(time.time() - t0, 2)
    pc = sorted({(r.get('pitch_mm'), r.get('pitch_class')) for r in out if r.get('pitch_mm')})
    notes = sorted(set(ck.rules.notes))
    for nt in notes:
        print('NOTE', nt)
    summ = (f"PIN_ESCAPE_SUMMARY {'FAIL' if fails else 'PASS'} regions {len([r for r in out if r['demand']])} "
            f"fail {len(fails)} unescaped {[n for r in fails for n in r['unescaped']]} layers {ck.layers} "
            f"pitch {pc} wall {wall} s")
    print(summ)
    if a.json:
        with open(a.json, 'w') as fh:
            json.dump({'board': a.board, 'layers': ck.layers, 'in2_nets': sorted(ck.in2), 'plane_nets': sorted(ck.plane),
                       'regions': out, 'notes': notes, 'verdict': 'FAIL' if fails else 'PASS', 'wall_s': wall,
                       'summary': summ}, fh, indent=1)
    return 1 if fails else 0


if __name__ == '__main__':
    sys.exit(main())
