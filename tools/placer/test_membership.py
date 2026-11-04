"""Block membership from the schematic (membership.py), explicit blocks and cohesion nets in the reader
(kicad_io.read_problem blocks=), cohesion nets in the cost and the halo.

  $PY -m unittest tools/placer/test_membership.py      (the NET-CORE round trip needs the KiCad Python)
"""
import json
import os
import shutil
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from placer import compact, cost, membership  # noqa: E402

try:
    import pcbnew
    from placer import kicad_io
except ImportError:  # plain Python: the pure tests still run
    pcbnew = None

REPO = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
NET_CORE = os.path.join(REPO, 'hardware-design/boards/NET-CORE/cad/NET-CORE')

SCH = '''(kicad_sch (version 20260306)
\t(lib_symbols (symbol "x:U" (property "Reference" "U" (at 0 0 0))))
\t(text "POWER: buck" (exclude_from_sim no) (at 10 10 0) (effects (font (size 1.778 1.778) (bold yes))))
\t(symbol (lib_id "x:BUCK") (at 20 20 0) (property "Reference" "U4" (at 0 0 0)) (property "Description" "Buck" (at 0 0 0)))
\t(symbol (lib_id "x:C") (at 30 20 0) (property "Reference" "C34" (at 0 0 0)) (property "Description" "U4 VIN 4.7 uF next to pin 4." (at 0 0 0)))
\t(symbol (lib_id "power:GND") (at 30 30 0) (property "Reference" "#PWR001" (at 0 0 0)))
\t(text "ETHERNET" (exclude_from_sim no) (at 10 100 0) (effects (font (size 1.778 1.778) (bold yes))))
\t(symbol (lib_id "x:PHY") (at 20 120 0) (property "Reference" "U7" (at 0 0 0)) (property "Group" "eth1" (at 0 0 0)))
)
'''


class SchematicTest(unittest.TestCase):
    def test_groups_from_field_or_title(self):
        parts, titles = membership.parse_schematic(SCH)
        self.assertEqual(sorted(parts), ['C34', 'U4', 'U7'])  # power symbols and lib_symbols are not parts
        self.assertEqual(parts['U7']['group'], 'eth1')       # the Group field
        self.assertEqual(parts['U4']['group'], 'POWER: buck')  # else the bold title above
        self.assertIn('U4 VIN', parts['C34']['desc'])
        self.assertEqual([t for _, t in titles], ['POWER: buck', 'ETHERNET'])


def sch(group, **desc):
    return {r: {'group': group, 'desc': d} for r, d in desc.items()}


class DeriveTest(unittest.TestCase):
    def test_description_and_affinity(self):
        s = sch('pwr', U4='', U5='', C34='U4 VIN 4.7 uF', C37='U5 VIN 4.7 uF', L1='', R8='', C36='VDD_3V3 10 uF',
                D3='VBUS TVS at J1', J1='', R4='', D1='Status LED green')
        pads = {'U4': ['VBUS', 'GND', 'SW1', 'VBUS', 'FB1'], 'U5': ['VBUS', 'GND', 'SW2', 'VBUS', 'FB2'],
                'C34': ['VBUS', 'GND'], 'C37': ['VBUS', 'GND'], 'L1': ['SW1', 'V33'], 'R8': ['V33', 'FB1'],
                'C36': ['V33', 'GND'], 'D3': ['VBUS', 'GND'], 'J1': ['VBUS', 'GND', 'CC', 'X'],
                'R4': ['V33', 'LEDA'], 'D1': ['LEDA', 'LEDK']}
        for k in range(4):  # V33 on more than RAIL_DEG parts: a rail
            s['C9%d' % k] = {'group': 'other', 'desc': ''}
            pads['C9%d' % k] = ['V33', 'GND']
        m = membership.derive(s, pads)
        self.assertEqual(m['blocks']['U4'], ['C34', 'C36', 'L1', 'R8', 'U4'])  # C36 via L1 / R8 on V33
        self.assertEqual(m['blocks']['U5'], ['C37', 'U5'])
        self.assertIn('names U4', m['why']['C34'])
        self.assertIn('connector support', m['why']['D3'])    # names J1, no IC: placed with the connector
        self.assertIn('indicator', m['why']['D1'])
        self.assertNotIn('R4', m['blocks']['U4'])              # LED resistor: signal net LEDA, no tie via V33
        self.assertEqual(sorted(m['components']['pwr']), sorted(['U4', 'U5', 'D1', 'D3', 'J1', 'R4']))

    def test_group_boundary_and_chain(self):
        s = {**sch('soc', U1='', C1='', Y1='', C28=''), **sch('eth', U7='', C45='')}
        pads = {'U1': ['V33', 'OSCI', 'OSCO', 'GND'], 'U7': ['V33', 'X1', 'X2', 'GND'], 'C1': ['V33', 'GND'],
                'C45': ['V33', 'GND'], 'Y1': ['OSCI', 'GND', 'OSCO', 'GND'], 'C28': ['OSCI', 'GND']}
        m = membership.derive(s, pads)
        self.assertEqual(m['blocks']['U1'], ['C1', 'C28', 'U1', 'Y1'])  # C1 and C45 stay in their own group
        self.assertEqual(m['blocks']['U7'], ['C45', 'U7'])

    def test_match(self):
        r = membership.match({'U4': ['U4', 'C1', 'C2']}, {'BUCK': ['U4', 'C1', 'L1']})
        self.assertEqual(r['blocks'][0]['derived'], 'U4')
        self.assertEqual(r['blocks'][0]['jaccard'], 0.5)
        self.assertEqual(r['blocks'][0]['missing'], ['L1'])
        self.assertEqual(r['share'], round(2 / 3, 3))

    def test_reference_from_builder(self):
        with tempfile.TemporaryDirectory() as d:
            p = os.path.join(d, 'b.py')
            open(p, 'w').write("import os\nBLOCKS = {'U1 X': ['U1'] + [f'C{i}' for i in range(1, 3)]}\n")
            self.assertEqual(membership.reference_from_builder(p), {'U1 X': ['U1', 'C1', 'C2']})


class TightenTest(unittest.TestCase):
    def test_moves_toward_anchor_keeps_side_and_gap(self):
        anchor = (0.0, 0.0, 4.0, 4.0)
        parts = {'C1': (10.0, 1.5, 11.0, 2.5), 'C2': (1.5, -10.0, 2.5, -9.0)}
        d = membership.tighten_block(anchor, parts, lambda q: True, gap=0.25, steps=100)
        c1 = membership.shift(parts['C1'], *d['C1'])
        self.assertGreater(c1[0], anchor[2])               # still east of the IC
        self.assertGreaterEqual(c1[0] - anchor[2], 0.25 - 1e-9)
        self.assertLess(c1[0] - anchor[2], 0.4)            # but close
        self.assertAlmostEqual(d['C1'][1], 0.0)             # on its own centre line (centre y 2 = anchor y)
        c2 = membership.shift(parts['C2'], *d['C2'])
        self.assertLess(c2[3], anchor[1])                  # still north

    def test_blocked_part_stays(self):
        d = membership.tighten_block((0, 0, 4, 4), {'C1': (5, 1, 6, 2)}, lambda q: q[0] >= 4.9)
        self.assertEqual(d['C1'], (0.0, 0.0))


def unit(name, x, y, fixed=False):
    return {'name': name, 'refs': [name], 'fixed': fixed, 'x': x, 'y': y, 'rects': [[-1, -1, 1, 1, 0.5]]}


class CohesionTest(unittest.TestCase):
    def test_cohesion_net_cost_no_rudy_no_halo(self):
        pr = {'units': [unit('A', 2, 2), unit('B', 8, 8), unit('C', 5, 5)],
              'nets': [{'name': 'S', 'weight': 1.0, 'pins': [[0, 0, 0, 0, 0], [2, 0, 0, 0, 0]]},
                       {'name': '~comp:X', 'weight': 2.0, 'pins': [[0, -1, -1, 1, 1], [1, -1, -1, 1, 1]],
                        'track': 0.0, 'cohesion': True}],
              'board': {'outline': [[0, 0], [10, 0], [10, 10], [0, 10]], 'keepouts': [], 'edge_clearance': 0.0}}
        pose = cost.initial_pose(pr)
        self.assertAlmostEqual(cost.hpwl(pr, pose), 6.0 + 2.0 * 16.0)  # group box 1..9 x 1..9: half perimeter 16
        self.assertEqual(cost.track_factor(pr['nets'][1], cost.params_with_defaults({'tracks': 1})), 0.0)
        g = cost.rudy_grid(pr, pose, {})
        pr1 = dict(pr, nets=pr['nets'][:1])
        self.assertEqual(float(abs(g - cost.rudy_grid(pr1, pose, {})).max()), 0.0)
        self.assertEqual(compact.fanout(pr), [1, 0, 1])  # the virtual net is no escaping track
        ev = cost.Evaluator(pr, {})
        d = ev.propose([(1, 2.0, 6.0, 0)])                 # B toward A (legal place): the group box shrinks
        self.assertAlmostEqual(d, -2.0 * 8.0)


@unittest.skipUnless(pcbnew, 'needs pcbnew (KiCad bundled Python)')
class NetCoreRoundTripTest(unittest.TestCase):
    """Derive from the committed NET-CORE schematic, draw the borders on a copy, read it with blocks=: each block
    with no fixed part is one rigid unit with exactly its parts; the others give cohesion nets."""

    def test_round_trip(self):
        tmp = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, tmp, True)
        d = os.path.join(tmp, 'b')
        shutil.copytree(NET_CORE, d)
        pcb = os.path.join(d, 'NET-CORE.kicad_pcb')
        parts, _ = membership.parse_schematic(open(os.path.join(d, 'NET-CORE.kicad_sch')).read())
        b = pcbnew.LoadBoard(pcb)
        m = membership.derive(parts, membership.board_pads(b))
        self.assertEqual(m['blocks']['U4'], ['C34', 'C35', 'C36', 'L1', 'R8', 'R9', 'U4'])
        self.assertEqual(sorted(m['components']), ['eth1', 'eth2', 'nand', 'pwr', 'soc'])
        for t in [t for t in b.GetTracks()]:  # no locked copper and no locked part: every block is rigid
            b.Delete(t)
        for fp in b.GetFootprints():
            fp.SetLocked(False)
        membership.draw(b, m)
        pcbnew.SaveBoard(pcb, b)
        pr = kicad_io.read_problem(pcb, blocks=m, w_block=4.0, w_comp=1.0)
        units = {u['name']: u for u in pr['units'] if u['box']}
        self.assertEqual(sorted(units), sorted(m['blocks']))
        for name, refs in m['blocks'].items():
            self.assertEqual(sorted(units[name]['refs']), sorted(refs))
        coh = [n for n in pr['nets'] if n.get('cohesion')]
        self.assertTrue(coh and all(n['name'].startswith('~comp:') for n in coh))
        self.assertEqual(len(kicad_io.block_borders(pcbnew.LoadBoard(pcb))), len(m['blocks']))


    def test_private_locked_copper_moves_with_block(self):
        """Task 3: the locked Y3 crystal route (CH_XI / CH_XO: pads on U8 and Y3 only) belongs to block U8. The block
        stays rigid and movable, the route is not fixed copper, and the writer moves it with the block. A locked
        route to another unit (the ETH2 pair to J3) makes the block soft."""
        tmp = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, tmp, True)
        d = os.path.join(tmp, 'b')
        shutil.copytree(NET_CORE, d)
        pcb = os.path.join(d, 'NET-CORE.kicad_pcb')
        parts, _ = membership.parse_schematic(open(os.path.join(d, 'NET-CORE.kicad_sch')).read())
        b = pcbnew.LoadBoard(pcb)
        m = membership.derive(parts, membership.board_pads(b))
        for t in [t for t in b.GetTracks()]:
            if t.GetNetname() not in ('/CH_XI', '/CH_XO', '/ETH2_TXP'):
                b.Delete(t)
            else:
                t.SetLocked(True)
        for fp in b.GetFootprints():
            fp.SetLocked(False)
        membership.draw(b, m)
        pcbnew.SaveBoard(pcb, b)
        pr = kicad_io.read_problem(pcb, blocks=m)
        u8 = [u for u in pr['units'] if 'U8' in u['refs']]
        self.assertEqual(len(u8), 1)
        self.assertIsNone(u8[0]['box'])  # ETH2_TXP goes to J3: U8 is fixed, its block soft (single units)
        self.assertTrue(u8[0]['fixed'])
        for t in [t for t in b.GetTracks() if t.GetNetname() == '/ETH2_TXP']:
            b.Delete(t)
        pcbnew.SaveBoard(pcb, b)
        pr = kicad_io.read_problem(pcb, blocks=m)
        i = next(k for k, u in enumerate(pr['units']) if u['name'] == 'U8')
        u = pr['units'][i]
        self.assertFalse(u['fixed'])
        xtal = [t for t in pcbnew.LoadBoard(pcb).GetTracks() if t.GetNetname() in ('/CH_XI', '/CH_XO')]
        self.assertEqual(sorted(u['locked_cu']), sorted(t.m_Uuid.AsString() for t in xtal))
        self.assertEqual(pr['board']['fixed_copper'], [])
        pose = cost.initial_pose(pr)
        pose[i] = (u['x'] + 0.5, u['y'], 0)
        out = os.path.join(d, 'moved.kicad_pcb')
        rep = kicad_io.write_board(pcb, pr, pose, out)
        self.assertEqual(rep['moved_block_tracks'], len(xtal))
        old = {t.m_Uuid.AsString(): t.GetStart().x for t in xtal}
        new = {t.m_Uuid.AsString(): t.GetStart().x for t in pcbnew.LoadBoard(out).GetTracks()}
        for k, x in old.items():
            self.assertEqual(new[k] - x, 500000)


if __name__ == '__main__':
    unittest.main()
