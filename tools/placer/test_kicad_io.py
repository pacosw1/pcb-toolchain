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


def is_fixed(pr, ref):
    return any(u['fixed'] for u in pr['units'] if ref in u['refs'])


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
        fp = pcbnew.LoadBoard(self.board).FindFootprintByReference('U1')
        self.assertEqual(len(u['pads']), len(fp.Pads()))       # pin RUDY points
        q = fp.Pads()[0].GetPosition()
        self.assertTrue(any(near((a + u['x'], b + u['y']), (q.x / 1e6, q.y / 1e6)) for a, b in u['pads']))
        self.assertEqual(pr['units'][self.unit(pr, 'R2')]['rects'][0][4], 0.5)

    def test_tie_joins_small_parts_next_to_an_ic(self):
        loose = kicad_io.read_problem(self.board, tie=0)
        self.assertEqual(loose['units'][self.unit(loose, 'U1')]['refs'], ['U1'])
        pr = kicad_io.read_problem(self.board, tie=1.5)
        refs = pr['units'][self.unit(pr, 'U1')]['refs']
        self.assertGreater(len(refs), 1)
        b = pcbnew.LoadBoard(self.board)
        u1 = b.FindFootprintByReference('U1')
        ic = kicad_io.fp_rect(u1)
        ic_nets = {p.GetNetname() for p in u1.Pads()} - {'GND', ''}
        for fp in b.GetFootprints():
            r = fp.GetReference()
            c = kicad_io.fp_rect(fp)
            gap = max(ic[0] - c[2], c[0] - ic[2], ic[1] - c[3], c[1] - ic[3])
            shared = {p.GetNetname() for p in fp.Pads()} & ic_nets
            if r != 'U1' and len(fp.Pads()) <= 3 and gap <= 1.5 and shared and not is_fixed(pr, r):
                self.assertIn(r, refs)
        for r in refs:
            self.assertFalse(is_fixed(loose, r))

    def test_rigid_switch_net_makes_one_hot_loop_unit(self):
        pr = kicad_io.read_problem(self.board, rigid_nets=['*SW*'])
        refs = pr['units'][self.unit(pr, 'U1')]['refs']
        for r in ('L1', 'D3', 'C4'):  # every part on /SW
            self.assertIn(r, refs)

    def test_rigid_net_without_an_inductor_is_not_a_switch_node(self):
        # /EN matches the pattern but has no inductor pad (as SWDIO/SWCLK match *SW* on MC-MAIN)
        pr = kicad_io.read_problem(self.board, rigid_nets=['/EN'])
        refs = pr['units'][self.unit(pr, 'U1')]['refs']
        b = pcbnew.LoadBoard(self.board)
        on_en = {p.GetParentFootprint().GetReference() for p in b.GetPads() if p.GetNetname() == '/EN'} - {'U1'}
        self.assertTrue(on_en)
        self.assertFalse(on_en & set(refs))

    def test_decap_tie_joins_caps_near_an_ic_power_pin_and_reports_distance(self):
        pr = kicad_io.read_problem(self.board, decap_tie=3.0)
        refs = pr['units'][self.unit(pr, 'U1')]['refs']
        b = pcbnew.LoadBoard(self.board)
        u1 = b.FindFootprintByReference('U1')
        seen = {d[0]: d for d in pr['decaps']}
        for fp in b.GetFootprints():
            nets = [p.GetNetname() for p in fp.Pads()]
            if not fp.GetReference().startswith('C') or len(nets) != 2 or 'GND' not in nets:
                continue
            other = [n for n in nets if n != 'GND'][0]
            pins = [p for p in u1.Pads() if p.GetNetname() == other]
            if not pins:
                continue
            gap = min(kicad_io.pad_gap(q, pin) for q in fp.Pads() if q.GetNetname() == other for pin in pins)
            if gap <= 3.0:
                self.assertIn(fp.GetReference(), refs)
                self.assertEqual(seen[fp.GetReference()][1], 'U1')
                self.assertAlmostEqual(seen[fp.GetReference()][2], gap, places=3)
        self.assertTrue(seen)

    def test_test_points_move_freely_and_are_left_out_of_the_cost(self):
        # a fixed test point blocked U1 on MC-MAIN; a test point keeps only its courtyard (spacing 0)
        b = pcbnew.LoadBoard(self.board)
        b.FindFootprintByReference('R7').SetReference('TP1')
        pcbnew.SaveBoard(self.board, b)
        pr = kicad_io.read_problem(self.board)
        i = self.unit(pr, 'TP1')
        u = pr['units'][i]
        self.assertFalse(u['fixed'])
        self.assertEqual([r[4] for r in u['rects']], [0.0])
        self.assertEqual(u['pads'], [])
        self.assertFalse(any(q[0] == i for n in pr['nets'] for q in n['pins']))

    def test_kept_copper_is_the_copper_the_writer_keeps(self):
        b0 = pcbnew.LoadBoard(self.board)
        n_tracks = len(list(b0.GetTracks()))
        none = kicad_io.read_problem(self.board, free_box=[0, 0, 1, 1])  # nothing movable: all copper stays
        self.assertEqual(len(none['board']['copper']), n_tracks)
        self.assertTrue(any(c[0] == 'via' for c in none['board']['copper']))
        ic = kicad_io.fp_rect(b0.FindFootprintByReference('U1'))
        pr = kicad_io.read_problem(self.board, free_box=list(ic))  # only U1 moves
        self.assertEqual([u['refs'] for u in pr['units'] if not u['fixed']], [['U1']])
        i = self.unit(pr, 'U1')
        pose = cost.initial_pose(pr)
        pose[i] = (pose[i][0] + 3.0, pose[i][1], 0)
        rep = kicad_io.write_board(self.board, pr, pose, os.path.join(self.tmp, 'b', 'out.kicad_pcb'))
        self.assertEqual(len(pr['board']['copper']), n_tracks - (rep['removed_tracks'] - rep['removed_collisions']))

    def test_lone_via_under_a_movable_part_moves_with_it_not_kept(self):
        # a stitching via under the U1 body (on no pad, no track) belongs to U1: not an obstacle, removed on a move
        b = pcbnew.LoadBoard(self.board)
        u1 = b.FindFootprintByReference('U1')
        x0, y0, x1, y1 = kicad_io.fp_rect(u1)
        spot = None
        for i in range(1, 20):
            for j in range(1, 20):
                x, y = x0 + (x1 - x0) * i / 20, y0 + (y1 - y0) * j / 20
                v = pcbnew.VECTOR2I(int(x * 1e6), int(y * 1e6))
                if not any(p.HitTest(v, 400000) for p in b.GetPads()):
                    spot = (x, y)
                    break
            if spot:
                break
        self.assertIsNotNone(spot)
        via = pcbnew.PCB_VIA(b)
        via.SetPosition(pcbnew.VECTOR2I(int(spot[0] * 1e6), int(spot[1] * 1e6)))
        via.SetWidth(600000)
        via.SetDrill(300000)
        via.SetNet(b.FindNet('GND'))
        b.Add(via)
        pcbnew.SaveBoard(self.board, b)
        at = lambda c: c[0] == 'via' and near(c[1:3], spot)  # noqa: E731
        self.assertTrue(any(at(c) for c in kicad_io.read_problem(self.board, free_box=[0, 0, 1, 1])['board']['copper']))
        pr = kicad_io.read_problem(self.board, free_box=list(kicad_io.fp_rect(u1)))
        self.assertFalse(any(at(c) for c in pr['board']['copper']))
        i = self.unit(pr, 'U1')
        pose = cost.initial_pose(pr)
        pose[i] = (pose[i][0] + 3.0, pose[i][1], 0)
        out = os.path.join(self.tmp, 'b', 'out.kicad_pcb')
        kicad_io.write_board(self.board, pr, pose, out)
        self.assertFalse(any(t.GetClass() == 'PCB_VIA' and near((t.GetPosition().x / 1e6, t.GetPosition().y / 1e6), spot)
                             for t in pcbnew.LoadBoard(out).GetTracks()))

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

    def test_write_removes_other_copper_under_moved_pads(self):
        pr = kicad_io.read_problem(self.board)
        i = self.unit(pr, 'U1')
        b0 = pcbnew.LoadBoard(self.board)
        u1_nets = {p.GetNetname() for p in b0.FindFootprintByReference('U1').Pads()}
        t = next(t for t in b0.GetTracks() if t.GetClass() == 'PCB_TRACK' and t.GetNetname() not in u1_nets
                 and t.GetLength() > 2e6)
        mid = ((t.GetStart().x + t.GetEnd().x) / 2e6, (t.GetStart().y + t.GetEnd().y) / 2e6)
        pose = cost.initial_pose(pr)
        u = pr['units'][i]
        dx = mid[0] - (u['x'] + u['pads'][0][0])  # put U1 pad 0 on the track
        dy = mid[1] - (u['y'] + u['pads'][0][1])
        pose[i] = (u['x'] + dx, u['y'] + dy, 0)
        out = os.path.join(self.tmp, 'b', 'out.kicad_pcb')
        rep = kicad_io.write_board(self.board, pr, pose, out)
        self.assertGreater(rep['removed_collisions'], 0)
        b1 = pcbnew.LoadBoard(out)
        pads = list(b1.FindFootprintByReference('U1').Pads())
        for tr in b1.GetTracks():
            for pad in pads:
                if pad.GetNetname() != tr.GetNetname() and pad.IsOnLayer(tr.GetLayer()):
                    self.assertFalse(kicad_io.collide(tr, pad, 0), 'copper of %s under U1' % tr.GetNetname())

    def test_block_border_moves_with_its_parts(self):
        # Border on User.1 around U1 and its nearest part: one rigid unit (with any other part inside).
        b = pcbnew.LoadBoard(self.board)
        ic = kicad_io.fp_rect(b.FindFootprintByReference('U1'))
        other = min((f for f in b.GetFootprints() if f.GetReference() not in ('U1', 'J1', 'J2')),
                    key=lambda f: max(ic[0] - kicad_io.fp_rect(f)[2], kicad_io.fp_rect(f)[0] - ic[2],
                                      ic[1] - kicad_io.fp_rect(f)[3], kicad_io.fp_rect(f)[1] - ic[3]))
        oc = kicad_io.fp_rect(other)
        box = (min(ic[0], oc[0]) - .5, min(ic[1], oc[1]) - .5, max(ic[2], oc[2]) + .5, max(ic[3], oc[3]) + .5)
        rect = pcbnew.PCB_SHAPE(b)
        rect.SetShape(pcbnew.SHAPE_T_RECT)
        rect.SetLayer(b.GetLayerID('User.1'))
        rect.SetStart(pcbnew.VECTOR2I(int(box[0] * 1e6), int(box[1] * 1e6)))
        rect.SetEnd(pcbnew.VECTOR2I(int(box[2] * 1e6), int(box[3] * 1e6)))
        b.Add(rect)
        pcbnew.SaveBoard(self.board, b)
        pr = kicad_io.read_problem(self.board)
        i = self.unit(pr, 'U1')
        self.assertIn(other.GetReference(), pr['units'][i]['refs'])
        self.assertEqual(pr['units'][i]['borders'], [rect.m_Uuid.AsString()])
        u = pr['units'][i]  # the border box is a rect of class 0: block copper inside it stays clear of other parts
        self.assertIn([round(v, 3) for v in (box[0] - u['x'], box[1] - u['y'], box[2] - u['x'], box[3] - u['y'], 0.0)],
                      [[round(v, 3) for v in r] for r in u['rects']])
        pose = cost.initial_pose(pr)
        pose[i] = (pose[i][0] - 4.0, pose[i][1] + 1.0, 2)
        out = os.path.join(self.tmp, 'b', 'out.kicad_pcb')
        kicad_io.write_board(self.board, pr, pose, out)
        b1 = pcbnew.LoadBoard(out)
        r1 = next(d for d in b1.GetDrawings() if d.m_Uuid.AsString() == rect.m_Uuid.AsString())
        c0 = ((box[0] + box[2]) / 2, (box[1] + box[3]) / 2)
        c1 = ((r1.GetStart().x + r1.GetEnd().x) / 2e6, (r1.GetStart().y + r1.GetEnd().y) / 2e6)
        self.assertTrue(near(c1, (c0[0] - 4.0, c0[1] + 1.0), 0.01))
        # the two parts keep their relative layout (turned 180 deg)
        f1, g1 = b1.FindFootprintByReference('U1'), b1.FindFootprintByReference(other.GetReference())
        f0, g0 = b.FindFootprintByReference('U1'), b.FindFootprintByReference(other.GetReference())
        d0 = (g0.GetPosition().x - f0.GetPosition().x, g0.GetPosition().y - f0.GetPosition().y)
        d1 = (g1.GetPosition().x - f1.GetPosition().x, g1.GetPosition().y - f1.GetPosition().y)
        self.assertTrue(near(d1, (-d0[0], -d0[1]), 2))


if __name__ == '__main__':
    unittest.main()
