#!/usr/bin/env python3
"""Import a Specctra session (.ses) onto a board, the same way as tools/freeroute.py.

  $PY tools/import_ses.py BASE.kicad_pcb RESULT.ses OUT.kicad_pcb [--expect-vias N]

All existing tracks and vias are locked for the import (KiCad removes unlocked copper on a SES import;
2026-10-03: an import without the lock removed 140 vias). The lock state is restored. Zones are refilled.
Check: via count before + SES vias = via count after; --expect-vias N compares with the router report.
Exit code 4 when a check fails.
"""
import argparse
import sys

import pcbnew


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("base")
    ap.add_argument("ses")
    ap.add_argument("out")
    ap.add_argument("--expect-vias", type=int)
    a = ap.parse_args()
    b = pcbnew.LoadBoard(a.base)
    was = {}
    for t in b.GetTracks():
        was[t.m_Uuid.AsString()] = t.IsLocked()
        t.SetLocked(True)
    vias = lambda: sum(1 for t in b.GetTracks() if t.GetClass() == "PCB_VIA")
    before = vias()
    if not pcbnew.ImportSpecctraSES(b, a.ses):
        sys.exit("import_ses: SES import failed")
    for t in b.GetTracks():
        t.SetLocked(was.get(t.m_Uuid.AsString(), False))
    after = vias()
    pcbnew.ZONE_FILLER(b).Fill(b.Zones())
    pcbnew.SaveBoard(a.out, b)
    with open(a.ses, errors="replace") as f:
        routes = f.read()
    ses_vias = routes[routes.find("(routes"):].count("(via ")
    print(f"import_ses: vias {before} + {ses_vias} (SES) -> {after}")
    if before + ses_vias != after or (a.expect_vias is not None and a.expect_vias != after):
        sys.exit(4)


if __name__ == "__main__":
    main()
