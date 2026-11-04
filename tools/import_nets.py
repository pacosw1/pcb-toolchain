#!/usr/bin/env python3
"""Copy the new copper of some nets from a routed candidate onto a base board.

  $PY tools/import_nets.py BASE.kicad_pcb CANDIDATE.kicad_pcb OUT.kicad_pcb --nets A,B,C

New copper = a track or via of CANDIDATE whose UUID is not in BASE (tools/freeroute.py keeps the UUIDs of
the old copper). Only the items of the listed nets are copied. Zones are refilled. OUT may be BASE.
Prints "import_nets: <n> items of <m> nets". Used by tools/route_batch.mjs (accept and bisect without a new router run).
"""
import argparse

import pcbnew


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("base")
    ap.add_argument("candidate")
    ap.add_argument("out")
    ap.add_argument("--nets", required=True)
    a = ap.parse_args()
    nets = set(n for n in a.nets.split(",") if n)

    base = pcbnew.LoadBoard(a.base)
    cand = pcbnew.LoadBoard(a.candidate)
    old = set(t.m_Uuid.AsString() for t in base.GetTracks())
    count, used = 0, set()
    for t in cand.GetTracks():
        name = t.GetNetname()
        if t.m_Uuid.AsString() in old or name not in nets:
            continue
        net = base.FindNet(name)
        if net is None:
            continue
        item = t.Duplicate()
        item.SetNet(net)
        item.SetLocked(False)
        base.Add(item)
        count += 1
        used.add(name)
    pcbnew.ZONE_FILLER(base).Fill(base.Zones())
    pcbnew.SaveBoard(a.out, base)
    print(f"import_nets: {count} items of {len(used)} nets")


if __name__ == "__main__":
    main()
