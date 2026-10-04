#!/usr/bin/env python3
"""Make a copy of a board with 2, 4 or 6 copper layers, for a routability test (tools/design_sweep.py).

  $PY tools/stackup_copy.py IN.kicad_pcb OUT.kicad_pcb --layers 2|4|6 [--grounds GND,ISO_GND] [--plane-net NET]
                            [--lock-tracks]

Result:
  2 layers: F.Cu signal | B.Cu signal + the ground pours (no planes: each rail is routed as tracks).
  4 layers: F.Cu signal | In1.Cu grounds | In2.Cu PLANE | B.Cu signal.
  6 layers: F.Cu signal | In1.Cu grounds | In2.Cu signal | In3.Cu PLANE | In4.Cu grounds | B.Cu signal.
Grounds (--grounds, default GND; tools/design_sweep.py reads them from reference-planes.json): a board can have
more than one ground domain (an isolated side). The ground zones of the board keep their outlines, so a domain
border or an isolation gap stays. A ground with no zone gets a pour of the board box (PQ-METER has no pour yet).
PLANE: --plane-net. A ground (default: the first ground): each ground zone is copied to the plane layer.
A rail (for example +3V3): one pour with the outline of the first ground zone; the other rails are tracks.
The power pours of the source board on inner layers go: they belong to one placement.
A rule area on an inner layer goes to all inner layers (a mains keepout is for all inner copper).
Kept tracks on an inner layer stay on 4 and 6 layers (block copper); on 2 layers they are removed.
Prints the signal layers and the plane nets for tools/fastroute_job.py.
The physical stackup (dielectric, impedance) is not set: the copy is for routability, not for fabrication.
"""
import argparse
import sys

import pcbnew

INNER = [pcbnew.In1_Cu, pcbnew.In2_Cu, pcbnew.In3_Cu, pcbnew.In4_Cu]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("src")
    ap.add_argument("out")
    ap.add_argument("--layers", type=int, choices=[2, 4, 6], required=True)
    ap.add_argument("--grounds", default="GND")
    ap.add_argument("--plane-net", default="")
    ap.add_argument("--lock-tracks", action="store_true", help="lock each track and via that is on the board")
    a = ap.parse_args()
    b = pcbnew.LoadBoard(a.src)
    grounds = [g for g in a.grounds.split(",") if g and b.FindNet(g) is not None]
    if not grounds:
        sys.exit(f"stackup_copy: no ground net of {a.grounds} is on the board (give --grounds)")
    plane_name = a.plane_net or grounds[0]
    if b.FindNet(plane_name) is None:
        sys.exit(f"stackup_copy: net not found: {plane_name}")
    zones = [z for z in b.Zones() if not z.GetIsRuleArea()]

    # One model zone per ground: its inner zone, else another zone of the net, else a new pour of the board box.
    models = {}
    for g in grounds:
        own = [z for z in zones if z.GetNetname() == g]
        m = next((z for z in own if z.GetLayer() in INNER), None) or (own[0] if own else None)
        if m is None:
            box = b.GetBoardEdgesBoundingBox()
            m = pcbnew.ZONE(b)
            m.SetNet(b.FindNet(g))
            m.SetLayer(pcbnew.In1_Cu)
            m.SetZoneName(g + "_NEW")
            d = pcbnew.FromMM(0.5)
            o = m.Outline()
            o.NewOutline()
            for x, y in ((box.GetLeft() + d, box.GetTop() + d), (box.GetRight() - d, box.GetTop() + d),
                         (box.GetRight() - d, box.GetBottom() - d), (box.GetLeft() + d, box.GetBottom() - d)):
                o.Append(x, y)
            m.SetIsFilled(False)
            models[g] = (m, True)   # not on the board yet
        else:
            # A copy made now: the zone itself can be an inner zone that is removed below.
            models[g] = (m.Duplicate(False).Cast(), False)

    def pour(layer, model, net_name, name):
        z = model.Duplicate(False).Cast()
        z.SetLayer(layer)
        z.SetNet(b.FindNet(net_name))
        z.SetZoneName(name)
        z.SetAssignedPriority(0)
        b.Add(z)

    # Inner zones of the source go; they come back from the models on the new layers.
    for z in zones:
        if z.GetLayer() in INNER:
            b.Delete(z)
    removed_tracks = 0
    if a.layers == 2:
        # The pours first: after a track is removed, Duplicate() of a zone gives an object with no type (KiCad 10.0.6).
        on_b = {z.GetNetname() for z in zones if z.GetLayer() == pcbnew.B_Cu}
        for g in grounds:
            if g not in on_b:
                pour(pcbnew.B_Cu, models[g][0], g, g + "_B")
        for t in list(b.GetTracks()):
            if t.GetClass() != "PCB_VIA" and t.GetLayer() in INNER:
                b.Delete(t)
                removed_tracks += 1
        b.SetCopperLayerCount(2)
        signal, planes = "F.Cu,B.Cu", list(grounds)
    else:
        b.SetCopperLayerCount(a.layers)
        plane_layer = pcbnew.In2_Cu if a.layers == 4 else pcbnew.In3_Cu
        for g in grounds:
            pour(pcbnew.In1_Cu, models[g][0], g, g + "_IN1")
            if a.layers == 6:
                pour(pcbnew.In4_Cu, models[g][0], g, g + "_IN4")
            if plane_name in grounds:
                pour(plane_layer, models[g][0], g, g + "_PLANE")
        if plane_name not in grounds:
            pour(plane_layer, models[grounds[0]][0], plane_name, "PLANE_" + plane_name)
        signal = "F.Cu,B.Cu" if a.layers == 4 else "F.Cu,In2.Cu,B.Cu"
        planes = list(grounds) + ([plane_name] if plane_name not in grounds else [])

    extended = 0
    if a.layers == 6:
        for z in b.Zones():
            ls = z.GetLayerSet()
            if z.GetIsRuleArea() and any(ls.Contains(l) for l in (pcbnew.In1_Cu, pcbnew.In2_Cu)):
                for l in INNER:
                    ls.AddLayer(l)
                z.SetLayerSet(ls)
                extended += 1
    for z in b.Zones():
        if not z.GetIsRuleArea():
            z.SetIslandRemovalMode(pcbnew.ISLAND_REMOVAL_MODE_ALWAYS)
    if a.lock_tracks:
        for t in b.GetTracks():
            t.SetLocked(True)
    pcbnew.ZONE_FILLER(b).Fill(b.Zones())
    pcbnew.SaveBoard(a.out, b)
    print(f"stackup_copy: {a.layers} layers SIGNAL {signal} PLANES {','.join(planes)} "
          f"(rule areas extended: {extended}, inner tracks removed: {removed_tracks})", flush=True)


if __name__ == "__main__":
    main()
