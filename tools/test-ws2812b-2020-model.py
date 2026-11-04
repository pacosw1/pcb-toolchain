#!/usr/bin/env python3
"""Check the WS2812B-2020 simplified STEP against the datasheet outline.

Run: uv run --python 3.12 --with cadquery-ocp python tools/test-ws2812b-2020-model.py STEP
Source: hardware-design/registry/datasheets/WS2812B-2020-V6.pdf, page 2: body 2.0 x 2.0 mm,
height 0.84 mm, base 0.28 mm, tolerance 0.15 mm. The body is centred on the footprint origin.
"""
import sys

from OCP.Bnd import Bnd_Box
from OCP.BRepBndLib import BRepBndLib
from OCP.IFSelect import IFSelect_RetDone
from OCP.STEPControl import STEPControl_Reader

r = STEPControl_Reader()
if r.ReadFile(sys.argv[1]) != IFSelect_RetDone:
    sys.exit(f'FAIL cannot read {sys.argv[1]}')
r.TransferRoots()
b = Bnd_Box()
BRepBndLib.Add_s(r.OneShape(), b)
(x0, y0, z0), (x1, y1, z1) = (b.CornerMin().Coord(), b.CornerMax().Coord())
want = {'x0': -1.0, 'x1': 1.0, 'y0': -1.0, 'y1': 1.0, 'z0': 0.0, 'z1': 0.84}
got = {'x0': x0, 'x1': x1, 'y0': y0, 'y1': y1, 'z0': z0, 'z1': z1}
bad = [k for k in want if abs(want[k] - got[k]) > 0.02]
print(' '.join(f'{k}={got[k]:.3f}' for k in got))
sys.exit(f'FAIL {bad}' if bad else 'PASS')
