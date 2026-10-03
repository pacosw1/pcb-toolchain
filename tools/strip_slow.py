#!/usr/bin/env python3
"""Re-route experiment, step 1: remove the tracks and vias of the slow signal nets from a board copy.

  $PY tools/strip_slow.py BOARD.kicad_pcb OUT.kicad_pcb NETS.txt --board-dir hardware-design/boards/<BOARD>

Slow net = net class Default, not a power net of current-paths.json, not a fast net of rp001-fast-nets.json
or diff-pairs.json, not a ground net, and with 2 or more pads. Power copper, fast nets, pairs and ground
vias stay. NETS.txt gets the slow net names (one per line) for tools/freeroute.py --nets-file.
"""
import argparse
import fnmatch
import json
import os

import pcbnew


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("board")
    ap.add_argument("out")
    ap.add_argument("nets_out")
    ap.add_argument("--board-dir", required=True)
    a = ap.parse_args()

    def load(name):
        p = os.path.join(a.board_dir, name)
        return json.load(open(p)) if os.path.isfile(p) else {}

    power = set(load("current-paths.json").get("nets", {}))
    fast = list(load("rp001-fast-nets.json").get("fast", []))
    for pair in load("diff-pairs.json").get("pairs", []):
        fast += [pair["p"], pair["n"]]

    b = pcbnew.LoadBoard(a.board)
    pads = {}
    for fp in b.GetFootprints():
        for p in fp.Pads():
            pads[p.GetNetname()] = pads.get(p.GetNetname(), 0) + 1
    slow = set()
    for name, net in b.GetNetsByName().items():
        name = str(name)
        if not name or pads.get(name, 0) < 2 or "GND" in name or name in power:
            continue
        if net.GetNetClassName() != "Default" or any(fnmatch.fnmatchcase(name, g) for g in fast):
            continue
        slow.add(name)
    removed, mm = 0, 0.0
    for t in list(b.GetTracks()):
        if t.GetNetname() in slow:
            if t.GetClass() != "PCB_VIA":
                mm += t.GetLength() / 1e6
            b.Remove(t)
            removed += 1
    pcbnew.ZONE_FILLER(b).Fill(b.Zones())
    pcbnew.SaveBoard(a.out, b)
    with open(a.nets_out, "w") as f:
        f.write("\n".join(sorted(slow)) + "\n")
    kept = sum(1 for _ in b.GetTracks())
    print(f"strip_slow: {len(slow)} slow nets, removed {removed} items ({mm:.0f} mm of track), kept {kept} items")


if __name__ == "__main__":
    main()
