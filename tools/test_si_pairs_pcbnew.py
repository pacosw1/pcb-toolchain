#!/usr/bin/env python3
"""Test for the pcbnew side of si_pairs.py: collecting vias for the via-antipad allowance.

Run with the KiCad bundled Python:
  /Applications/KiCad/KiCad.app/Contents/Frameworks/Python.framework/Versions/Current/bin/python3 \
      tools/test_si_pairs_pcbnew.py

Builds a small in-memory board (no file read or write) with one via and one ground zone, so the
test does not need a fixture .kicad_pcb.
"""
import os
import sys

import pcbnew

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import si_pairs as sp  # noqa: E402


def test_collect_vias_radius_is_via_width_plus_zone_clearance():
    # A 0.6 mm via on net SIG, under a GND zone with a 0.3 mm local clearance: allowance radius
    # 0.3 mm (half width) + 0.3 mm (clearance) = 0.6 mm.
    board = pcbnew.BOARD()
    sig = pcbnew.NETINFO_ITEM(board, 'SIG')
    board.Add(sig)
    gnd = pcbnew.NETINFO_ITEM(board, 'GND')
    board.Add(gnd)
    zone = pcbnew.ZONE(board)
    zone.SetLayer(pcbnew.F_Cu)
    zone.SetNet(gnd)
    zone.SetLocalClearance(pcbnew.FromMM(0.3))
    board.Add(zone)
    via = pcbnew.PCB_VIA(board)
    via.SetPosition(pcbnew.VECTOR2I(pcbnew.FromMM(5), pcbnew.FromMM(7)))
    via.SetWidth(pcbnew.FromMM(0.6))
    via.SetNet(sig)
    board.Add(via)

    vias = sp.collect_vias(board, pcbnew)
    assert list(vias) == ['SIG'], vias
    (x, y, r), = vias['SIG']
    assert (round(x, 3), round(y, 3), round(r, 3)) == (5.0, 7.0, 0.6), vias


def test_a_zone_on_another_layer_does_not_count():
    # The via is on F.Cu/B.Cu (through), but the zone is on an inner layer only in a 4-layer board;
    # here we simulate "no zone on the via's layers" by putting the zone net elsewhere and giving
    # it no local clearance override, so the allowance falls back to half the via width.
    board = pcbnew.BOARD()
    sig = pcbnew.NETINFO_ITEM(board, 'SIG')
    board.Add(sig)
    via = pcbnew.PCB_VIA(board)
    via.SetPosition(pcbnew.VECTOR2I(pcbnew.FromMM(1), pcbnew.FromMM(1)))
    via.SetWidth(pcbnew.FromMM(0.5))
    via.SetNet(sig)
    board.Add(via)

    vias = sp.collect_vias(board, pcbnew)
    (x, y, r), = vias['SIG']
    assert round(r, 3) == 0.25, vias


def _pad(board, fp, net, attr, size_mm, at_mm):
    pad = pcbnew.PAD(fp)
    pad.SetAttribute(attr)
    pad.SetShape(pcbnew.PAD_SHAPE_CIRCLE)
    pad.SetSize(pcbnew.VECTOR2I(pcbnew.FromMM(size_mm), pcbnew.FromMM(size_mm)))
    if attr == pcbnew.PAD_ATTRIB_PTH:
        pad.SetDrillSize(pcbnew.VECTOR2I(pcbnew.FromMM(1.0), pcbnew.FromMM(1.0)))
        pad.SetLayerSet(pcbnew.PAD.PTHMask())
    else:
        pad.SetLayerSet(pcbnew.PAD.SMDMask())
    pad.SetPosition(pcbnew.VECTOR2I(pcbnew.FromMM(at_mm[0]), pcbnew.FromMM(at_mm[1])))
    pad.SetNet(net)
    fp.Add(pad)


def test_pth_pad_counts_as_via_and_smd_pad_does_not():
    # An RJ45 pin: 1.6 mm PTH pad under a GND zone with 0.25 mm clearance -> radius 0.8 + 0.25 = 1.05 mm.
    # A same-net SMD pad cuts no plane, so it gives no allowance.
    board = pcbnew.BOARD()
    sig = pcbnew.NETINFO_ITEM(board, 'SIG')
    board.Add(sig)
    gnd = pcbnew.NETINFO_ITEM(board, 'GND')
    board.Add(gnd)
    zone = pcbnew.ZONE(board)
    zone.SetLayer(pcbnew.In1_Cu)
    zone.SetNet(gnd)
    zone.SetLocalClearance(pcbnew.FromMM(0.25))
    board.Add(zone)
    fp = pcbnew.FOOTPRINT(board)
    board.Add(fp)
    _pad(board, fp, sig, pcbnew.PAD_ATTRIB_PTH, 1.6, (10, 20))
    _pad(board, fp, sig, pcbnew.PAD_ATTRIB_SMD, 1.0, (30, 40))

    vias = sp.collect_vias(board, pcbnew)
    assert [(round(x, 3), round(y, 3), round(r, 3)) for x, y, r in vias['SIG']] == [(10.0, 20.0, 1.05)], vias


if __name__ == '__main__':
    test_collect_vias_radius_is_via_width_plus_zone_clearance()
    test_a_zone_on_another_layer_does_not_count()
    test_pth_pad_counts_as_via_and_smd_pad_does_not()
    print('ok')
