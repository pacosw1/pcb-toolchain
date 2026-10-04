#!/usr/bin/env python3
"""Make a copy of a board with 2, 4 or 6 copper layers, for a routability test (tools/design_sweep.py).

  $PY tools/stackup_copy.py IN.kicad_pcb OUT.kicad_pcb --layers 2|4|6 [--plane-net NET]

Use it on a board without inner-layer tracks (strip them first). Result:
  2 layers: F.Cu signal | B.Cu signal + a full GND pour (no planes: each rail is routed as tracks).
  4 layers: F.Cu signal | In1.Cu GND | In2.Cu PLANE | B.Cu signal.
  6 layers: F.Cu signal | In1.Cu GND | In2.Cu signal | In3.Cu PLANE | In4.Cu GND | B.Cu signal.
PLANE = one full-board pour of --plane-net (default GND). Give the rail with the most pads (for example +3V3);
the other rails are routed as tracks with their net-class width. The split power pours of the source board go:
they belong to one placement. All full-board pours copy the outline of the first In1.Cu (or other) GND zone.
Prints the signal layers for tools/fastroute_job.py --layers and the plane nets for --plane-nets.
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
    ap.add_argument("--plane-net", default="GND")
    ap.add_argument("--lock-tracks", action="store_true", help="lock each track and via that is on the board")
    a = ap.parse_args()
    b = pcbnew.LoadBoard(a.src)
    plane = b.FindNet(a.plane_net)
    gnd = b.FindNet("GND")
    if plane is None or gnd is None:
        sys.exit(f"stackup_copy: net not found: {a.plane_net if plane is None else 'GND'}")
    zones = [z for z in b.Zones() if not z.GetIsRuleArea()]
    model = next((z for z in zones if z.GetNetname() == "GND" and z.GetLayer() in INNER), None) or \
        next((z for z in zones if z.GetNetname() == "GND"), None)
    if model is None:
        sys.exit("stackup_copy: no GND zone to copy the outline from")
    inner_tracks = [t for t in b.GetTracks() if t.GetClass() != "PCB_VIA" and t.GetLayer() in INNER]
    if inner_tracks:
        sys.exit(f"stackup_copy: {len(inner_tracks)} tracks on inner layers: strip them first")

    def pour(layer, net, name):
        z = model.Duplicate(False).Cast()
        z.SetLayer(layer)
        z.SetNet(net)
        z.SetZoneName(name)
        z.SetAssignedPriority(0)
        b.Add(z)

    for z in zones:
        if z.GetLayer() in INNER and z is not model:
            b.Remove(z)
    keep_model_on = model.GetLayer()
    if a.layers == 2:
        if not any(z.GetNetname() == "GND" and z.GetLayer() == pcbnew.B_Cu for z in zones):
            pour(pcbnew.B_Cu, gnd, "GND_B")
        if keep_model_on in INNER:
            b.Remove(model)
        b.SetCopperLayerCount(2)
        signal, planes = "F.Cu,B.Cu", ["GND"]
    else:
        b.SetCopperLayerCount(a.layers)
        if keep_model_on != pcbnew.In1_Cu:
            pour(pcbnew.In1_Cu, gnd, "GND_IN1")
        if a.layers == 4:
            pour(pcbnew.In2_Cu, plane, "PLANE_IN2")
            signal = "F.Cu,B.Cu"
        else:
            pour(pcbnew.In3_Cu, plane, "PLANE_IN3")
            pour(pcbnew.In4_Cu, gnd, "GND_IN4")
            signal = "F.Cu,In2.Cu,B.Cu"
        planes = ["GND"] + ([a.plane_net] if a.plane_net != "GND" else [])
    # A rule area (keepout) on an inner layer is for all inner copper (for example a mains keepout): extend it to the
    # new inner layers. DOOR-RELAY 6 layers, 2026-10-03: without this the new planes went below the mains area.
    extended = 0
    if a.layers == 6:
        for z in b.Zones():
            ls = z.GetLayerSet()
            if z.GetIsRuleArea() and any(ls.Contains(l) for l in (pcbnew.In1_Cu, pcbnew.In2_Cu)):
                for l in INNER:
                    ls.AddLayer(l)
                z.SetLayerSet(ls)
                extended += 1
    if a.lock_tracks:
        # Kept copper (a pair inside a fixed block) is locked: the placer then keeps the parts on it in place.
        for t in b.GetTracks():
            t.SetLocked(True)
    pcbnew.ZONE_FILLER(b).Fill(b.Zones())
    pcbnew.SaveBoard(a.out, b)
    print(f"stackup_copy: {a.layers} layers SIGNAL {signal} PLANES {','.join(planes)} (rule areas extended: {extended})", flush=True)


if __name__ == "__main__":
    main()
