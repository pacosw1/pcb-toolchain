#!/usr/bin/env python3
"""Put a ground via next to each ground SMD pad (CLAUDE.md section 4, standard stackup).

Run with KiCad's bundled Python (pcbnew):
  $PY tools/gnd_pad_vias.py BOARD.kicad_pcb OUT.kicad_pcb [--net GND] [--skip U1,U10] [--r 1.0]

For each SMD pad of NET on F.Cu with no connected NET via within --r mm of its centre:
1. Try via places around the pad (4 sides, then 4 corners; 2 distances).
2. Keep the first place with class clearance to every other-net pad, track and via,
   0.25 mm hole to hole, 0.5 mm copper to the board edge (D-040), and not in a rule
   area that forbids vias.
3. Add the via (net class size) and a short F.Cu track from the pad centre.
A pad with no free place is listed; the router or a hand fix must connect it.
Nearby-via skips are proved before repairs. If copper changes, one final fill
rechecks those skips and the repairs; disconnected results are listed as unresolved.
At most two zone fills are performed, without an iterative repair/refill loop.
The result is a proposal: DRC with --schematic-parity decides.
"""
import argparse
import math

class NearbyViaConnectivity:
    """A proximity candidate needs fresh native connectivity before it can suppress a repair.

    The refresh callback must rebuild connectivity, refilling zones unless query
    flags exclude zone traversal. Every copper mutation invalidates that proof;
    saved filled polygons alone are not evidence.
    Exceptions propagate rather than silently treating an unproved pad as connected.
    """

    def __init__(self, refresh, flags=0):
        self.refresh = refresh
        self.flags = flags
        self.connectivity = None

    def invalidate(self):
        self.connectivity = None

    def connected(self, pad, via_positions, radius):
        center = pad.GetPosition()
        def nearby(position):
            return math.hypot(position.x - center.x, position.y - center.y) <= radius
        if not any(nearby(position) for position in via_positions):
            return False
        if self.connectivity is None:
            self.connectivity = self.refresh()
        items = (self.connectivity.GetConnectedItems(pad, self.flags) if self.flags
                 else self.connectivity.GetConnectedItems(pad))
        return any(item.GetClass() == 'PCB_VIA'
                   and item.GetNetCode() == pad.GetNetCode()
                   and nearby(item.GetPosition())
                   for item in items)


def main():
    import pcbnew
    MM = pcbnew.FromMM
    COPPER = (pcbnew.F_Cu, pcbnew.B_Cu, pcbnew.In1_Cu, pcbnew.In2_Cu, pcbnew.In3_Cu, pcbnew.In4_Cu)
    ap = argparse.ArgumentParser()
    ap.add_argument('board')
    ap.add_argument('out')
    ap.add_argument('--net', default='GND')
    ap.add_argument('--skip', default='', help='refs or REF.PAD to skip (pads with their own thermal vias)')
    ap.add_argument('--r', type=float, default=1.0)
    ap.add_argument('--width', type=float, default=0.4)
    ap.add_argument('--via', type=float, nargs=2, default=(0.6, 0.3), metavar=('DIA', 'DRILL'))
    ap.add_argument('--clearance', type=float, default=0.2)
    ap.add_argument('--only', default='', help='comma list of REF.PAD: only these pads, also when a via of the net is '
                    'within --r (repair after routing: the pour between the pad and that via can be cut)')
    ap.add_argument('--in-pad', action='store_true', help='last choice: a via in the pad centre, when the pad is at '
                    'least as large as the via (JLCPCB fills and caps vias on 6 layers and more at no extra cost)')
    a = ap.parse_args()
    skip = set(filter(None, a.skip.split(',')))
    only = set(filter(None, a.only.split(',')))
    b = pcbnew.LoadBoard(a.board)
    def refresh_connectivity():
        # Native connectivity includes zone islands. Refresh the fill on the
        # current geometry, including changes made by this invocation.
        b.BuildConnectivity()
        if any(not zone.GetIsRuleArea() for zone in b.Zones()):
            if not pcbnew.ZONE_FILLER(b).Fill(b.Zones()):
                raise RuntimeError('zone refill failed; nearby-via connectivity is unproved')
        b.BuildConnectivity()
        return b.GetConnectivity()
    via_connectivity = NearbyViaConnectivity(refresh_connectivity)
    def refresh_direct_connectivity():
        b.BuildConnectivity()
        return b.GetConnectivity()
    # EXCLUDE_ZONES excludes zone traversal in native SearchClusters, so this
    # inexpensive proof cannot mistake stale filled polygons for a connection.
    direct_connectivity = NearbyViaConnectivity(refresh_direct_connectivity, pcbnew.EXCLUDE_ZONES)
    ds = b.GetDesignSettings()
    net = b.GetNetsByName()[a.net]
    # Default net class of the boards: via 0.6/0.3 mm, clearance 0.2 mm.
    via_d, drill = MM(a.via[0]), MM(a.via[1])
    clr = max(MM(a.clearance), ds.m_MinClearance)
    # The new vias and stubs are on `net`: its own class clearance applies too (+3V3 in POWER: 0.2 mm).
    for fp in b.GetFootprints():
        own = next((p for p in fp.Pads() if p.GetNetCode() == net.GetNetCode()), None)
        if own is not None:
            try:
                clr = max(clr, own.GetOwnClearance(pcbnew.F_Cu))
            except Exception:
                pass
            break
    edge_gap = MM(0.5)
    w = MM(a.width)

    def item_clr(item):
        # The clearance to an item is at least the clearance of its own net class (MC-MAIN HV class: 0.6 mm).
        try:
            return max(clr, item.GetOwnClearance(item.GetLayer() if item.GetClass() == 'PCB_TRACK' else pcbnew.F_Cu))
        except Exception:
            return clr

    others = []  # (item, clearance to it) of other-net copper
    own_smd = []
    holes = []
    for fp in b.GetFootprints():
        for p in fp.Pads():
            if p.GetDrillSize().x:
                holes.append((p.GetPosition(), p.GetDrillSize().x // 2))
            if p.GetNetCode() != net.GetNetCode():
                others.append((p, item_clr(p)))
            elif p.GetAttribute() in (pcbnew.PAD_ATTRIB_SMD, pcbnew.PAD_ATTRIB_CONN):
                own_smd.append(p)  # no via in an SMD pad (pcbtool.py viapads gate)
    vias = []
    for t in b.GetTracks():
        if t.GetClass() == 'PCB_VIA':
            holes.append((t.GetPosition(), t.GetDrill() // 2))
            if t.GetNetCode() == net.GetNetCode():
                vias.append(t.GetPosition())
        if t.GetNetCode() != net.GetNetCode():
            others.append((t, item_clr(t)))
    edges = [d for d in b.GetDrawings() if d.GetLayer() == pcbnew.Edge_Cuts]
    rules = [z for z in b.Zones() if z.GetIsRuleArea() and z.GetDoNotAllowVias()]
    for fp in b.GetFootprints():
        rules += [z for z in fp.Zones() if z.GetIsRuleArea() and z.GetDoNotAllowVias()]
    outline = pcbnew.SHAPE_POLY_SET()
    b.GetBoardPolygonOutlines(outline, False)

    def free(pt, rad, seg=None, w=w, in_pad=None):
        if not outline.Contains(pt):
            return False
        for d in edges:
            if d.GetEffectiveShape().Collide(pt, rad + edge_gap):
                return False
        for z in rules:
            if z.Outline().Contains(pt) or z.Outline().Collide(pt, rad):
                return False
        for item, c in others:
            for layer in COPPER:
                if not item.IsOnLayer(layer):
                    continue
                if item.GetEffectiveShape(layer).Collide(pt, rad + c):
                    return False
                if seg is not None and layer == pcbnew.F_Cu and item.GetEffectiveShape(layer).Collide(seg, w // 2 + c):
                    return False
        for p in own_smd:
            if (in_pad is None or p.m_Uuid.AsString() != in_pad.m_Uuid.AsString()) and p.GetEffectiveShape(pcbnew.F_Cu).Collide(pt, rad):
                return False
        for hp, hr in holes:
            if math.hypot(hp.x - pt.x, hp.y - pt.y) < hr + drill // 2 + MM(0.25):
                return False
        return True

    # Snapshot decisions before the first mutation. Plane-only connections must
    # not cause repeated fills or duplicate vias after an earlier pad repair.
    initial_connected = set()
    if not only:
        for fp in b.GetFootprints():
            if fp.GetReference() in skip:
                continue
            for p in fp.Pads():
                name = f'{fp.GetReference()}.{p.GetNumber()}'
                if (name not in skip and p.GetNetCode() == net.GetNetCode()
                        and p.GetAttribute() in (pcbnew.PAD_ATTRIB_SMD, pcbnew.PAD_ATTRIB_CONN)
                        and p.IsOnLayer(pcbnew.F_Cu)
                        and via_connectivity.connected(p, vias, MM(a.r))):
                    initial_connected.add(p.m_Uuid.AsString())
    added, failed, in_pad, links = 0, [], [], []
    verify = []
    for fp in b.GetFootprints():
        if fp.GetReference() in skip:
            continue
        for p in fp.Pads():
            if f'{fp.GetReference()}.{p.GetNumber()}' in skip:
                continue
            if p.GetNetCode() != net.GetNetCode() or p.GetAttribute() not in (pcbnew.PAD_ATTRIB_SMD, pcbnew.PAD_ATTRIB_CONN):
                continue
            if only and f'{fp.GetReference()}.{p.GetNumber()}' not in only:
                continue
            if not p.IsOnLayer(pcbnew.F_Cu):
                continue
            c = p.GetPosition()
            if not only and p.m_Uuid.AsString() in initial_connected:
                verify.append((p, MM(a.r)))
                continue
            if not only and direct_connectivity.connected(p, vias, MM(a.r)):
                # An earlier new via/stub may also have connected this pad.
                verify.append((p, MM(a.r)))
                continue
            bb = p.GetBoundingBox()
            hx, hy = bb.GetWidth() // 2, bb.GetHeight() // 2
            done = False
            # The stub is not wider than the pad (a 0.4 mm stub from a 0.28 mm pad at 0.5 mm pitch meets the next pads).
            sw = min(w, 2 * min(hx, hy))
            for extra in (MM(0.2), MM(0.5), MM(0.9), MM(1.4)):
                cands = []
                for dx, dy in ((1, 0), (-1, 0), (0, 1), (0, -1), (1, 1), (-1, 1), (1, -1), (-1, -1)):
                    ox = dx * (hx + via_d // 2 + extra) if dx else 0
                    oy = dy * (hy + via_d // 2 + extra) if dy else 0
                    cands.append(pcbnew.VECTOR2I(c.x + ox, c.y + oy))
                for pt in cands:
                    seg = pcbnew.SEG(c, pt)
                    if free(pt, via_d // 2, seg, sw):
                        v = pcbnew.PCB_VIA(b)
                        v.SetPosition(pt)
                        v.SetWidth(via_d)
                        v.SetDrill(drill)
                        v.SetLayerPair(pcbnew.F_Cu, pcbnew.B_Cu)
                        v.SetNet(net)
                        b.Add(v)
                        t = pcbnew.PCB_TRACK(b)
                        t.SetStart(c)
                        t.SetEnd(pt)
                        t.SetWidth(sw)
                        t.SetLayer(pcbnew.F_Cu)
                        t.SetNet(net)
                        b.Add(t)
                        via_connectivity.invalidate()
                        direct_connectivity.invalidate()
                        holes.append((pt, drill // 2))
                        vias.append(pt)
                        added += 1
                        done = True
                        break
                if done:
                    break
            if not done and only:
                # Repair: a short F.Cu link to a via or pad of the same net at most 2 mm away.
                # Targets: the vias of the net first (a via 0.8 mm away with the pour between cut), then its pads.
                targets = list(vias) + [q.GetPosition() for q in own_smd if q.m_Uuid.AsString() != p.m_Uuid.AsString()]
                for qc in sorted(targets, key=lambda qc: math.hypot(qc.x - c.x, qc.y - c.y)):
                    dist = math.hypot(qc.x - c.x, qc.y - c.y)
                    if dist < 1:
                        continue
                    if dist > MM(2.0):
                        break
                    def clear(u, v):
                        seg = pcbnew.SEG(u, v)
                        return all(not (it.IsOnLayer(pcbnew.F_Cu) and it.GetEffectiveShape(pcbnew.F_Cu).Collide(seg, sw // 2 + cl))
                                   for it, cl in others)
                    # A straight link, or an L with the corner on the pad axis (out of a fine-pitch pin row first).
                    paths = [[c, qc], [c, pcbnew.VECTOR2I(c.x, qc.y), qc], [c, pcbnew.VECTOR2I(qc.x, c.y), qc]]
                    path = next((pp for pp in paths if all(clear(u, v) for u, v in zip(pp, pp[1:]))), None)
                    if path:
                        for u, v in zip(path, path[1:]):
                            t = pcbnew.PCB_TRACK(b)
                            t.SetStart(u)
                            t.SetEnd(v)
                            t.SetWidth(sw)
                            t.SetLayer(pcbnew.F_Cu)
                            t.SetNet(net)
                            b.Add(t)
                        links.append(f'{fp.GetReference()}.{p.GetNumber()}')
                        via_connectivity.invalidate()
                        direct_connectivity.invalidate()
                        done = True
                        break
            spot = None
            if not done and a.in_pad and 2 * min(hx, hy) >= via_d:
                # Places in the pad: the centre first, then a 5 x 5 grid (a track on another layer can be below the centre).
                rx, ry = hx - via_d // 2, hy - via_d // 2
                grid = [pcbnew.VECTOR2I(c.x + ix * rx // 2, c.y + iy * ry // 2)
                        for ix, iy in sorted(((i, j) for i in range(-2, 3) for j in range(-2, 3)), key=lambda q: q[0] ** 2 + q[1] ** 2)]
                spot = next((g for g in grid if free(g, via_d // 2, None, sw, in_pad=p)), None)
            if spot is not None:
                c = spot
                v = pcbnew.PCB_VIA(b)
                v.SetPosition(c)
                v.SetWidth(via_d)
                v.SetDrill(drill)
                v.SetLayerPair(pcbnew.F_Cu, pcbnew.B_Cu)
                v.SetNet(net)
                b.Add(v)
                via_connectivity.invalidate()
                direct_connectivity.invalidate()
                holes.append((c, drill // 2))
                vias.append(c)
                in_pad.append(f'{fp.GetReference()}.{p.GetNumber()}')
                done = True
            if not done:
                failed.append(f'{fp.GetReference()}.{p.GetNumber()}')
            else:
                verify.append((p, float('inf')))
    verification_failed = []
    if added or links or in_pad:
        # All mutations are complete. One fresh fill proves final connectivity;
        # a severed provisional plane connection is unresolved, never a skip
        # falsely reported as connected. Do not restart the repair/fill loop.
        via_connectivity.invalidate()
        for p, radius in verify:
            if not via_connectivity.connected(p, vias, radius):
                name = f'{p.GetParentFootprint().GetReference()}.{p.GetNumber()}'
                verification_failed.append(name)
                if name not in failed:
                    failed.append(name)
    pcbnew.SaveBoard(a.out, b)
    print(f'{a.net} vias added: {added}; pad links: {len(links)} {" ".join(links)}; in pad: {len(in_pad)} {" ".join(in_pad)}; no free place: {len(failed)} {" ".join(failed)}')
    print(f'final connectivity unresolved: {len(verification_failed)} {" ".join(verification_failed)}')


if __name__ == '__main__':
    main()
