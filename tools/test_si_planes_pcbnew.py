#!/usr/bin/env python3
"""Test for the pcbnew side of si_planes.py: ground fill pieces for the island check.

Run with the KiCad bundled Python:
  /Applications/KiCad/KiCad.app/Contents/Frameworks/Python.framework/Versions/Current/bin/python3 \
      tools/test_si_planes_pcbnew.py

Builds the fills in memory (no file read or write), so the test does not need a fixture .kicad_pcb.
"""
import os
import sys

import pcbnew

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import si_planes as sp  # noqa: E402


def square(x0, y0, x1, y1):
    s = pcbnew.SHAPE_POLY_SET()
    s.NewOutline()
    for x, y in [(x0, y0), (x1, y0), (x1, y1), (x0, y1)]:
        s.Append(pcbnew.FromMM(x), pcbnew.FromMM(y))
    return s


def test_touching_fills_of_two_zones_are_one_piece():
    # A small fill of zone A that touches the fill of zone B (same net) is the same copper, not an island.
    big = square(0, 0, 10, 10)
    sliver = square(10, 4, 10.3, 4.3)
    pieces = sp.ground_pieces(pcbnew, [big, sliver])
    assert len(pieces) == 1
    assert pieces[0].BBox().GetRight() == pcbnew.FromMM(10.3)


def test_separate_fills_stay_separate_pieces():
    assert len(sp.ground_pieces(pcbnew, [square(0, 0, 1, 1), square(5, 5, 6, 6)])) == 2


if __name__ == '__main__':
    test_touching_fills_of_two_zones_are_one_piece()
    test_separate_fills_stay_separate_pieces()
    print('ok')
