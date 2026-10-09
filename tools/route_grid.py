#!/usr/bin/env python3
"""Legality grid of a board and two read-only checks on it (2026-10-09, route features triage_opens, pin_escape_check).

  $PY tools/route_grid.py triage BOARD.kicad_pcb [--drc drc.json] [--layers F.Cu,B.Cu] [--skip GND,...] [--out FILE]
  $PY tools/route_grid.py escape BOARD.kicad_pcb [--layers F.Cu,B.Cu] [--skip GND,...] [--out FILE]

Grid: cells of grid_mm over the board outline. For a net N on a layer, a cell is free when the centre of a track of the
board minimum width there clears every copper item of another net (pads, tracks, vias, holes) by max(clearance of N,
clearance of the item), clears the board edge, and is outside a no-track rule area. A via fits at a cell when a via of
N's class diameter is free on every job layer and outside a no-via rule area. Filled zones are not obstacles (they
refill round new copper). The obstacles are shrunk by half a cell so a gap the grid cannot resolve counts as open: an
ENCLOSED result means no legal path even at the minimum width (class-to-class .kicad_dru clearances are not used).

triage: every open connection of the DRC report (kicad-cli pcb drc --format json; run it when --drc is not given) is
  ENCLOSED (flood fill from one end over free cells and via sites does not reach the other end) or ROUTER_MISS (a legal
  path exists; the router did not find it). For ENCLOSED the obstacles on the edge of the smaller region are named
  (blocking nets and parts). Prints one line "TRIAGE open N enclosed E router_miss M [top blockers]".
escape: every SMD pad of a routed net with more than one pad: can a track leave the footprint (reach the pad box of the
  footprint + 0.3 mm) or reach a via site, within reach_mm? Pads that cannot are "boxed in". Prints
  "ESCAPE pads P boxed_in B [refs]". The JSON has halo_hint {ref: mm} for tools/placer/compact_cli.py.
Idea from TraceMaker (doc 05 s13 exact reachability, s16 pin access); the code is our own.
"""
import argparse
import collections
import fnmatch
import json
import os
import re
import subprocess
import sys

import numpy as np
import pcbnew

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import route_features  # noqa: E402

NM = 1e6
KICAD_CLI = os.environ.get('KICAD_CLI', '/Applications/KiCad/KiCad.app/Contents/MacOS/kicad-cli')


def poly_pts(ps):
    out = []
    for k in range(ps.OutlineCount()):
        ol = ps.Outline(k)
        out.append(np.array([(ol.CPoint(i).x / NM, ol.CPoint(i).y / NM) for i in range(ol.PointCount())]))
    return out


class Item:
    __slots__ = ('net', 'owner', 'layers', 'seg', 'hw', 'polys', 'clr', 'bb', 'kind')

    def __init__(self, net, owner, layers, clr, kind='cu', seg=None, hw=0.0, polys=None):
        self.net, self.owner, self.layers, self.clr, self.kind = net, owner, layers, clr, kind
        self.seg, self.hw, self.polys = seg, hw, polys
        if seg is not None:
            x1, y1, x2, y2 = seg
            self.bb = (min(x1, x2) - hw, min(y1, y2) - hw, max(x1, x2) + hw, max(y1, y2) + hw)
        else:
            allp = np.vstack(polys)
            self.bb = (allp[:, 0].min(), allp[:, 1].min(), allp[:, 0].max(), allp[:, 1].max())


def seg_dist(px, py, x1, y1, x2, y2):
    dx, dy = x2 - x1, y2 - y1
    L = dx * dx + dy * dy
    if L == 0:
        return np.hypot(px - x1, py - y1)
    t = np.clip(((px - x1) * dx + (py - y1) * dy) / L, 0, 1)
    return np.hypot(px - (x1 + t * dx), py - (y1 + t * dy))


def in_poly(px, py, pts):
    ins = np.zeros(px.shape, bool)
    x, y = pts[:, 0], pts[:, 1]
    xj, yj = np.roll(x, 1), np.roll(y, 1)
    for a, b, c, d in zip(x, y, xj, yj):
        if b == d:
            continue
        cond = (b > py) != (d > py)
        xc = (c - a) * (py - b) / (d - b) + a
        ins ^= cond & (px < xc)
    return ins


def poly_dist(px, py, pts):
    d = np.full(px.shape, np.inf)
    for p, q in zip(pts, np.roll(pts, 1, axis=0)):
        d = np.minimum(d, seg_dist(px, py, p[0], p[1], q[0], q[1]))
    return d


class Board:
    def __init__(self, path, layers, g):
        self.b = pcbnew.LoadBoard(path)
        self.path = path
        self.layers = layers
        self.lid = {l: self.b.GetLayerID(l) for l in layers}
        self.g = g
        ds = self.b.GetDesignSettings()
        self.wmin = ds.m_TrackMinWidth / NM
        self.edge_clr = ds.m_CopperEdgeClearance / NM
        self.hole_clr = max(ds.m_HoleClearance, ds.m_MinClearance) / NM
        bb = self.b.GetBoardEdgesBoundingBox()
        self.x0, self.y0 = bb.GetX() / NM, bb.GetY() / NM
        self.nx = int(bb.GetWidth() / NM / g) + 1
        self.ny = int(bb.GetHeight() / NM / g) + 1
        self.items = []
        self.net_clr, self.net_via, self.net_pads = {}, {}, collections.defaultdict(list)
        self._collect()
        self._idx = {id(it): k for k, it in enumerate(self.items)}
        self.bbs = np.array([it.bb for it in self.items]) if self.items else np.zeros((0, 4))
        self._outline()
        self._cache = {}

    # ------------------------------------------------------------ items
    def _collect(self):
        b, L = self.b, self.layers
        for fp in b.GetFootprints():
            ref = fp.GetReference()
            for p in fp.Pads():
                net = p.GetNetname()
                pls = [l for l in L if p.IsOnLayer(self.lid[l])]
                owner = f'{ref}.{p.GetNumber()}'
                if p.GetAttribute() == pcbnew.PAD_ATTRIB_NPTH:
                    d = max(p.GetDrillSize().x, p.GetDrillSize().y) / NM
                    x, y = p.GetPosition().x / NM, p.GetPosition().y / NM
                    self.items.append(Item('', owner + '(hole)', set(L), self.hole_clr, seg=(x, y, x, y), hw=d / 2))
                    if not pls:
                        continue
                if not pls:
                    continue
                clr = p.GetOwnClearance(self.lid[pls[0]]) / NM
                ps = pcbnew.SHAPE_POLY_SET()
                p.TransformShapeToPolygon(ps, self.lid[pls[0]], 0, 5000, pcbnew.ERROR_INSIDE)
                it = Item(net, owner, set(pls), clr, polys=poly_pts(ps))
                it.kind = 'pad'
                self.items.append(it)
                if net:
                    self.net_pads[net].append((it, p, fp))
                    self.net_clr[net] = max(self.net_clr.get(net, 0), clr)
        for t in b.GetTracks():
            net = t.GetNetname()
            if t.GetClass() == 'PCB_VIA':
                x, y = t.GetPosition().x / NM, t.GetPosition().y / NM
                self.items.append(Item(net, 'via', set(L), t.GetOwnClearance(self.lid[L[0]]) / NM, seg=(x, y, x, y),
                                       hw=t.GetWidth(self.lid[L[0]]) / NM / 2))
                continue
            ln = t.GetLayerName()
            if ln not in L:
                continue
            clr = t.GetOwnClearance(t.GetLayer()) / NM
            if t.GetClass() == 'PCB_ARC':
                ps = pcbnew.SHAPE_POLY_SET()
                t.TransformShapeToPolygon(ps, t.GetLayer(), 0, 5000, pcbnew.ERROR_INSIDE)
                self.items.append(Item(net, 'track', {ln}, clr, polys=poly_pts(ps)))
            else:
                s, e = t.GetStart(), t.GetEnd()
                self.items.append(Item(net, 'track', {ln}, clr, seg=(s.x / NM, s.y / NM, e.x / NM, e.y / NM),
                                       hw=t.GetWidth() / NM / 2))
        for z in b.Zones():
            if not z.GetIsRuleArea():
                continue
            zl = {l for l in L if z.IsOnLayer(self.lid[l])}
            if not zl:
                continue
            polys = poly_pts(z.Outline())
            if z.GetDoNotAllowTracks():
                self.items.append(Item('', 'keepout:' + (z.GetZoneName() or '?'), zl, 0.0, kind='keep_track', polys=polys))
            if z.GetDoNotAllowVias():
                self.items.append(Item('', 'keepout:' + (z.GetZoneName() or '?'), zl, 0.0, kind='keep_via', polys=polys))
        for n in self.b.GetNetsByName().keys():
            n = str(n)
            try:
                self.net_via[n] = self.b.GetNetsByName()[n].GetNetClass().GetViaDiameter() / NM
            except Exception:  # noqa: BLE001
                self.net_via[n] = self.b.GetDesignSettings().m_ViasMinSize / NM

    def _outline(self):
        ps = pcbnew.SHAPE_POLY_SET()
        self.b.GetBoardPolygonOutlines(ps, True)
        self.outline = poly_pts(ps)

    # ------------------------------------------------------------ rasters
    def centres(self, i0, i1, j0, j1):
        xs = self.x0 + (np.arange(i0, i1) + 0.5) * self.g
        ys = self.y0 + (np.arange(j0, j1) + 0.5) * self.g
        return np.meshgrid(xs, ys)

    def win(self, x1, y1, x2, y2):
        i0 = max(0, int((x1 - self.x0) / self.g)); i1 = min(self.nx, int((x2 - self.x0) / self.g) + 2)
        j0 = max(0, int((y1 - self.y0) / self.g)); j1 = min(self.ny, int((y2 - self.y0) / self.g) + 2)
        return i0, i1, j0, j1

    def item_mask(self, k, r):
        """(window, bool mask) of cells within r of item k (r rounded to 1 um), cached."""
        key = (k, round(r, 3))
        m = self._cache.get(key)
        if m is not None:
            return m
        it = self.items[k]
        x1, y1, x2, y2 = it.bb
        w = self.win(x1 - r, y1 - r, x2 + r, y2 + r)
        if w[1] <= w[0] or w[3] <= w[2]:
            m = (w, None)
        else:
            px, py = self.centres(*w)
            if it.seg is not None:
                mask = seg_dist(px, py, *it.seg) <= it.hw + r
            else:
                mask = np.zeros(px.shape, bool)
                for pts in it.polys:
                    mask |= in_poly(px, py, pts)
                    if r > 0:
                        mask |= poly_dist(px, py, pts) <= r
            m = (w, mask)
        self._cache[key] = m
        return m

    def board_mask(self, w, margin):
        """Cells inside the outline and at least margin from it (cached per window and margin)."""
        key = ('board', tuple(w), round(margin, 3))
        if key in self._cache:
            return self._cache[key]
        self._cache[key] = self._board_mask(w, margin)
        return self._cache[key]

    def _board_mask(self, w, margin):
        px, py = self.centres(*w)
        ins = np.zeros(px.shape, bool)
        for pts in self.outline:
            ins ^= in_poly(px, py, pts)
        if margin > 0:
            d = np.full(px.shape, np.inf)
            for pts in self.outline:
                d = np.minimum(d, poly_dist(px, py, pts))
            ins &= d >= margin
        return ins

    def blocked(self, net, layer, w, via=False, owners=False):
        """bool array over window w: cells where net cannot put a track centre (via=False) or a via centre on layer."""
        tol = self.g / 2
        cn = self.net_clr.get(net, self.b.GetDesignSettings().m_MinClearance / NM)
        half = (self.net_via.get(net, 0.45) / 2) if via else self.wmin / 2
        i0, i1, j0, j1 = w
        out = ~self.board_mask(w, self.edge_clr + half - tol).copy()
        own = np.full(out.shape, -1, int) if owners else None
        if not len(self.bbs):
            return out, own
        sel = np.nonzero((self.bbs[:, 2] >= self.x0 + i0 * self.g - 10) & (self.bbs[:, 0] <= self.x0 + i1 * self.g + 10) &
                         (self.bbs[:, 3] >= self.y0 + j0 * self.g - 10) & (self.bbs[:, 1] <= self.y0 + j1 * self.g + 10))[0]
        for k in sel:
            it = self.items[k]
            if layer not in it.layers or (it.net and it.net == net):
                continue
            if it.kind == 'keep_track' or it.kind == 'keep_via':
                if it.kind == 'keep_via' and not via:
                    continue
                r = max(0.0, half - tol)
            else:
                r = max(cn, it.clr) + half - tol
            (a0, a1, b0, b1), m = self.item_mask(k, r)
            if m is None:
                continue
            c0, c1, d0, d1 = max(a0, i0), min(a1, i1), max(b0, j0), min(b1, j1)
            if c1 <= c0 or d1 <= d0:
                continue
            sub = m[d0 - b0:d1 - b0, c0 - a0:c1 - a0]
            out[d0 - j0:d1 - j0, c0 - i0:c1 - i0] |= sub
            if owners:
                o = own[d0 - j0:d1 - j0, c0 - i0:c1 - i0]
                o[sub] = k
        return out, own

    def own_cells(self, it, w):
        """Cells of the item's own copper inside window w."""
        k = self._idx[id(it)]
        (a0, a1, b0, b1), m = self.item_mask(k, 0.0)
        i0, i1, j0, j1 = w
        out = np.zeros((j1 - j0, i1 - i0), bool)
        if m is None:
            return out
        c0, c1, d0, d1 = max(a0, i0), min(a1, i1), max(b0, j0), min(b1, j1)
        if c1 > c0 and d1 > d0:
            out[d0 - j0:d1 - j0, c0 - i0:c1 - i0] = m[d0 - b0:d1 - b0, c0 - a0:c1 - a0]
        return out

    # ------------------------------------------------------------ flood
    def flood(self, free, viaok, seeds, target=None):
        """BFS over (layer, row, col). free: [L] arrays, viaok: array, seeds/target: [L] bool arrays.
        Returns (reached target?, reached arrays)."""
        nl = len(free)
        ny, nx = free[0].shape
        seen = [np.zeros((ny, nx), bool) for _ in range(nl)]
        q = collections.deque()
        for l in range(nl):
            s = seeds[l] & free[l]
            seen[l] |= s
            for j, i in zip(*np.nonzero(s)):
                q.append((l, j, i))
        fr = [f.tolist() for f in free]
        vo = viaok.tolist()
        tg = [t.tolist() for t in target] if target is not None else None
        sn = [s.tolist() for s in seen]
        hit = False
        while q:
            l, j, i = q.popleft()
            if tg is not None and tg[l][j][i]:
                hit = True
                break
            row = fr[l]
            for jj, ii in ((j - 1, i), (j + 1, i), (j, i - 1), (j, i + 1)):
                if 0 <= jj < ny and 0 <= ii < nx and row[jj][ii] and not sn[l][jj][ii]:
                    sn[l][jj][ii] = True
                    q.append((l, jj, ii))
            if vo[j][i]:
                for m in range(nl):
                    if m != l and fr[m][j][i] and not sn[m][j][i]:
                        sn[m][j][i] = True
                        q.append((m, j, i))
        return hit, [np.array(s, bool) for s in sn]

    def net_grids(self, net, w, owners=False):
        free, own = [], []
        for l in self.layers:
            bl, ow = self.blocked(net, l, w, owners=owners)
            free.append(~bl)
            own.append(ow)
        viaok = np.ones(free[0].shape, bool)
        if len(self.layers) > 1:
            for l in self.layers:
                viaok &= ~self.blocked(net, l, w, via=True)[0]
        else:
            viaok[:] = False
        return free, viaok, own

    def item_seed(self, it, w):
        cells = self.own_cells(it, w)
        return [cells if l in it.layers else np.zeros_like(cells) for l in self.layers]

    def blockers(self, reached, own, top=8):
        cnt = collections.Counter()
        for l in range(len(self.layers)):
            r = reached[l]
            edge = np.zeros_like(r)
            edge[1:, :] |= r[:-1, :]; edge[:-1, :] |= r[1:, :]; edge[:, 1:] |= r[:, :-1]; edge[:, :-1] |= r[:, 1:]
            edge &= ~r
            if not edge.any():
                edge = r   # empty region: the obstacles over the end itself
            ks = own[l][edge]
            for k in ks[ks >= 0]:
                it = self.items[k]
                name = it.net or '(no net)'
                cnt[f"{name} {it.owner}" if it.kind == 'pad' or 'hole' in it.owner or it.owner.startswith('keepout')
                    else f"{name} {it.kind if it.kind != 'cu' else it.owner}"] += 1
        nets = collections.Counter()
        parts = collections.Counter()
        for k, v in cnt.items():
            net, owner = k.split(' ', 1) if ' ' in k else (k, '')
            nets[net] += v
            if '.' in owner:
                parts[owner.split('.')[0]] += v
        return [n for n, _ in nets.most_common(top)], [p for p, _ in parts.most_common(top)]


def item_for(bd, desc, pos, uuid, by_uuid):
    it = by_uuid.get(uuid)
    if it is not None:
        return it
    m = re.match(r'(?:Pad|PTH pad|SMD pad) (\S+) \[([^\]]*)\] of (\S+)', desc)
    if m:
        for (x, p, fp) in bd.net_pads.get(m.group(2), []):
            if fp.GetReference() == m.group(3) and p.GetNumber() == m.group(1):
                return x
    m = re.search(r'\[([^\]]*)\]', desc)
    net = m.group(1) if m else ''
    best = None
    for x in bd.items:
        if x.net != net:
            continue
        cx, cy = (x.bb[0] + x.bb[2]) / 2, (x.bb[1] + x.bb[3]) / 2
        d = (cx - pos['x']) ** 2 + (cy - pos['y']) ** 2
        if x.bb[0] - 0.01 <= pos['x'] <= x.bb[2] + 0.01 and x.bb[1] - 0.01 <= pos['y'] <= x.bb[3] + 0.01:
            d = -1
        if best is None or d < best[0]:
            best = (d, x)
    return best[1] if best else None


def triage(a, cfg):
    bd = Board(a.board, a.layers, float(cfg.get('grid_mm', 0.1)))
    drc = a.drc
    if not drc:
        drc = os.path.splitext(a.out or a.board)[0] + '-drc.json'
        subprocess.run([KICAD_CLI, 'pcb', 'drc', '--format', 'json', '--units', 'mm', '-o', drc, a.board],
                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    d = json.load(open(drc))
    # map board items by uuid (pads and tracks) so DRC items find their geometry
    by_uuid = {}
    for it_list in (bd.net_pads.values(),):
        for lst in it_list:
            for (x, p, fp) in lst:
                by_uuid[p.m_Uuid.AsString()] = x
    skip = [s for s in a.skip.split(',') if s]
    opens = []
    for u in d.get('unconnected_items', []):
        its = u.get('items', [])
        if len(its) < 2:
            continue
        m = re.search(r'\[([^\]]*)\]', its[0]['description'])
        net = m.group(1) if m else ''
        if any(fnmatch.fnmatchcase(net, s) for s in skip) or 'Zone' in its[0]['description']:
            continue
        if a.nets_set is not None and net not in a.nets_set:
            continue   # a net this job did not route (a staged job)
        opens.append((net, its[0], its[1]))
    res = []
    full = (0, bd.nx, 0, bd.ny)
    grids = {}
    for net, ia, ib in opens[:int(cfg.get('max_opens', 60))]:
        A = item_for(bd, ia['description'], ia['pos'], ia.get('uuid', ''), by_uuid)
        B = item_for(bd, ib['description'], ib['pos'], ib.get('uuid', ''), by_uuid)
        row = {'net': net, 'a': ia['description'], 'b': ib['description'], 'a_pos': ia['pos'], 'b_pos': ib['pos']}
        if A is None or B is None:
            row['class'] = 'UNKNOWN'
            res.append(row)
            continue
        if net not in grids:
            grids = {net: bd.net_grids(net, full, owners=True)}   # one net at a time: memory
        free, viaok, own = grids[net]
        sa, sb = bd.item_seed(A, full), bd.item_seed(B, full)
        hit, ra = bd.flood(free, viaok, sa, sb)
        if hit:
            row['class'] = 'ROUTER_MISS'
        else:
            _, rb = bd.flood(free, viaok, sb)
            area_a = sum(int(x.sum()) for x in ra) * bd.g ** 2
            area_b = sum(int(x.sum()) for x in rb) * bd.g ** 2
            side, reach = ('a', ra) if area_a <= area_b else ('b', rb)
            if not any(x.any() for x in reach):   # the end itself has no legal cell: name what covers it
                reach = sa if side == 'a' else sb
            nets, parts = bd.blockers(reach, own)
            row.update({'class': 'ENCLOSED', 'enclosed_side': side, 'region_mm2': round(min(area_a, area_b), 2),
                        'blocking_nets': nets, 'blocking_parts': parts})
        res.append(row)
    enc = [r for r in res if r['class'] == 'ENCLOSED']
    miss = [r for r in res if r['class'] == 'ROUTER_MISS']
    top = collections.Counter(n for r in enc for n in r['blocking_nets'][:3])
    out = {'board': os.path.abspath(a.board), 'layers': a.layers, 'grid_mm': bd.g, 'open': len(opens),
           'enclosed': len(enc), 'router_miss': len(miss), 'unknown': len(res) - len(enc) - len(miss),
           'not_checked': max(0, len(opens) - len(res)), 'top_blockers': [n for n, _ in top.most_common(5)],
           'connections': res}
    if a.out:
        json.dump(out, open(a.out, 'w'), indent=1)
    print(f"TRIAGE open {len(opens)} enclosed {len(enc)} router_miss {len(miss)} unknown {out['unknown']}"
          + (f" blockers {','.join(out['top_blockers'])}" if enc else ''), flush=True)
    return out


def escape(a, cfg):
    g = float(cfg.get('grid_mm', 0.05))
    reach = float(cfg.get('reach_mm', 2.0))
    bd = Board(a.board, a.layers, g)
    skip = [s for s in a.skip.split(',') if s]
    boxed, checked = [], 0
    by_fp = collections.defaultdict(list)
    for net, lst in bd.net_pads.items():
        if len(lst) < 2 or any(fnmatch.fnmatchcase(net, s) for s in skip):
            continue
        if a.nets_set is not None and net not in a.nets_set:
            continue
        for (it, p, fp) in lst:
            if p.GetDrillSize().x or p.GetAttribute() == pcbnew.PAD_ATTRIB_NPTH:
                continue   # a through-hole pad is on every layer
            if all(f2.GetReference() == fp.GetReference() for (_, _, f2) in lst):
                continue   # a net inside one part only
            by_fp[fp.GetReference()].append((net, it, p, fp))
    for ref, pads in sorted(by_fp.items()):
        fx = [x.bb for x in bd.items if x.kind == 'pad' and x.owner.split('.')[0] == ref]
        bx = (min(b[0] for b in fx), min(b[1] for b in fx), max(b[2] for b in fx), max(b[3] for b in fx))
        w = bd.win(bx[0] - reach, bx[1] - reach, bx[2] + reach, bx[3] + reach)
        px, py = bd.centres(*w)
        outside = ~((px >= bx[0] - 0.3) & (px <= bx[2] + 0.3) & (py >= bx[1] - 0.3) & (py <= bx[3] + 0.3))
        for net, it, p, fp in pads:
            checked += 1
            free, viaok, _ = bd.net_grids(net, w)
            seeds = bd.item_seed(it, w)
            target = [outside | viaok for _ in bd.layers]
            hit, _ = bd.flood(free, viaok, seeds, target)
            if not hit:
                boxed.append({'pad': it.owner, 'net': net, 'ref': ref,
                              'free_cells_at_pad': int(sum((s & f).sum() for s, f in zip(seeds, free)))})
    refs = sorted({b['ref'] for b in boxed})
    out = {'board': os.path.abspath(a.board), 'layers': a.layers, 'grid_mm': g, 'pads_checked': checked,
           'boxed_in': boxed, 'halo_hint': {r: float(cfg.get('halo_hint_mm', 0.5)) for r in refs}}
    if a.out:
        json.dump(out, open(a.out, 'w'), indent=1)
    print(f"ESCAPE pads {checked} boxed_in {len(boxed)}" + (f" parts {','.join(refs[:12])}" if refs else ''), flush=True)
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('mode', choices=['triage', 'escape'])
    ap.add_argument('board')
    ap.add_argument('--drc', default='')
    ap.add_argument('--layers', default='F.Cu,B.Cu')
    ap.add_argument('--skip', default='GND')
    ap.add_argument('--out', default='')
    ap.add_argument('--grid', type=float, default=0.0)
    ap.add_argument('--nets', default='', help='file with the routed net names, one per line: only these nets')
    a = ap.parse_args()
    a.nets_set = set(open(a.nets).read().split('\n')) - {''} if a.nets else None
    a.layers = [l for l in a.layers.split(',') if l]
    cfg = route_features.load(a.board)['triage_opens' if a.mode == 'triage' else 'pin_escape_check']
    if a.grid:
        cfg = dict(cfg, grid_mm=a.grid)
    (triage if a.mode == 'triage' else escape)(a, cfg)


if __name__ == '__main__':
    main()
