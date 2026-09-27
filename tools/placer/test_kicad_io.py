#!/usr/bin/env python3
"""Reader/writer round trip on a temporary copy of PWR-24V-5V (needs pcbnew: run with the KiCad Python).

  $PY -m unittest discover -s tools/placer -p 'test_*.py'
The repo board is only read (copied); all writes go to a temporary folder.
"""
import os
import shutil
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from placer import cost  # noqa: E402

try:
    import pcbnew
    from placer import kicad_io
except ImportError:  # plain python3 without KiCad
    pcbnew = None

REPO = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
SRC = os.path.join(REPO, 'hardware-design/boards/PWR-24V-5V/cad/PWR-24V-5V')


def near(a, b, tol=1e-3):
    return all(abs(x - y) <= tol for x, y in zip(a, b))


@unittest.skipUnless(pcbnew, 'needs pcbnew (KiCad bundled Python)')
class RoundTripTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix='placer-test-')
        shutil.copytree(SRC, os.path.join(self.tmp, 'b'))
        self.board = os.path.join(self.tmp, 'b', 'PWR-24V-5V.kicad_pcb')

    def tearDown(self):
        shutil.rmtree(self.tmp)

    def unit(self, pr, ref):
        return next(i for i, u in enumerate(pr['units']) if ref in u['refs'])

    def test_reader_units_fixed_parts_and_nets(self):
        pr = kicad_io.read_problem(self.board)
        refs = sorted(r for u in pr['units'] for r in u['refs'])
        self.assertEqual(len(refs), 29)
        fixed = {r for u in pr['units'] if u['fixed'] for r in u['refs']}
        self.assertTrue({'H3', 'H4', 'H5'} <= fixed)          # mounting holes
        self.assertIn('J1', fixed)                             # connector at the edge
        self.assertNotIn('U1', fixed)
        names = {n['name'] for n in pr['nets']}
        self.assertNotIn('GND', names)                         # skipped by default
        for n in pr['nets']:
            self.assertGreaterEqual(len({p[0] for p in n['pins']}), 2)
        u = pr['units'][self.unit(pr, 'U1')]
        self.assertEqual(u['rects'][0][4], 1.0)                # IC spacing class
        self.assertEqual(pr['units'][self.unit(pr, 'R2')]['rects'][0][4], 0.5)

    def test_write_moves_and_rotates_like_the_model(self):
        pr = kicad_io.read_problem(self.board)
        i = self.unit(pr, 'U1')
        pose = cost.initial_pose(pr)
        x, y, _ = pose[i]
        pose[i] = (x + 3.0, y - 2.0, 1)
        out = os.path.join(self.tmp, 'b', 'out.kicad_pcb')
        rep = kicad_io.write_board(self.board, pr, pose, out)
        self.assertEqual(rep['moved_units'], 1)
        pr2 = kicad_io.read_problem(out)
        j = self.unit(pr2, 'U1')
        u1, u2 = pr['units'][i], pr2['units'][j]
        self.assertTrue(near((u2['x'], u2['y']), (x + 3.0, y - 2.0)))
        self.assertTrue(near(u2['rects'][0][:4], cost.rot_rect(u1['rects'][0], 1)))
        # every pin of U1 lands where the model puts it
        p1 = sorted((n['name'], tuple(round(v, 3) for v in cost.rot_rect(q[1:5], 1)))
                    for n in pr['nets'] for q in n['pins'] if q[0] == i)
        p2 = sorted((n['name'], tuple(round(v, 3) for v in q[1:5]))
                    for n in pr2['nets'] for q in n['pins'] if q[0] == j)
        self.assertEqual(p1, p2)
        # other units do not move
        for k, u in enumerate(pr['units']):
            if k != i:
                v = pr2['units'][self.unit(pr2, u['refs'][0])]
                self.assertTrue(near((u['x'], u['y']), (v['x'], v['y'])))

    def test_write_removes_only_copper_at_moved_pads(self):
        pr = kicad_io.read_problem(self.board)
        i = self.unit(pr, 'U1')
        pose = cost.initial_pose(pr)
        pose[i] = (pose[i][0] + 3.0, pose[i][1], 0)
        out = os.path.join(self.tmp, 'b', 'out.kicad_pcb')
        b0 = pcbnew.LoadBoard(self.board)
        u1_nets = {p.GetNetname() for p in b0.FindFootprintByReference('U1').Pads()}
        rep = kicad_io.write_board(self.board, pr, pose, out)
        self.assertGreater(rep['removed_tracks'], 0)
        b1 = pcbnew.LoadBoard(out)
        keep0 = sorted(t.m_Uuid.AsString() for t in b0.GetTracks() if t.GetNetname() not in u1_nets)
        keep1 = sorted(t.m_Uuid.AsString() for t in b1.GetTracks() if t.GetNetname() not in u1_nets)
        self.assertEqual(keep0, keep1)
        pads = list(b1.FindFootprintByReference('U1').Pads())
        for t in b1.GetTracks():
            for pt in (t.GetStart(), t.GetEnd()):
                for pad in pads:
                    if pad.GetNetname() == t.GetNetname():
                        self.assertFalse(pad.HitTest(pt), 'track left at a moved pad')

    def test_block_border_moves_with_its_parts(self):
        b = pcbnew.LoadBoard(self.board)
        u1 = b.FindFootprintByReference('U1')
        bb = u1.GetCourtyard(pcbnew.F_CrtYd).BBox()
        rect = pcbnew.PCB_SHAPE(b)
        rect.SetShape(pcbnew.SHAPE_T_RECT)
        rect.SetLayer(b.GetLayerID('User.1'))
        rect.SetStart(pcbnew.VECTOR2I(bb.GetX() - 1000000, bb.GetY() - 1000000))
        rect.SetEnd(pcbnew.VECTOR2I(bb.GetRight() + 1000000, bb.GetBottom() + 1000000))
        b.Add(rect)
        pcbnew.SaveBoard(self.board, b)
        pr = kicad_io.read_problem(self.board)
        i = self.unit(pr, 'U1')
        self.assertGreater(len(pr['units'][i]['borders']), 0)
        pose = cost.initial_pose(pr)
        pose[i] = (pose[i][0] - 4.0, pose[i][1] + 1.0, 2)
        out = os.path.join(self.tmp, 'b', 'out.kicad_pcb')
        kicad_io.write_board(self.board, pr, pose, out)
        b1 = pcbnew.LoadBoard(out)
        r1 = next(d for d in b1.GetDrawings() if d.m_Uuid.AsString() == rect.m_Uuid.AsString())
        c0 = ((bb.GetX() + bb.GetRight()) / 2e6, (bb.GetY() + bb.GetBottom()) / 2e6)
        c1 = ((r1.GetStart().x + r1.GetEnd().x) / 2e6, (r1.GetStart().y + r1.GetEnd().y) / 2e6)
        self.assertTrue(near(c1, (c0[0] - 4.0, c0[1] + 1.0), 0.01))


if __name__ == '__main__':
    unittest.main()
