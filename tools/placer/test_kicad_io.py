#!/usr/bin/env python3
"""Reader/writer round trip on a temporary copy of PWR-24V-5V (needs pcbnew: run with the KiCad Python).

  $PY -m unittest discover -s tools/placer -p 'test_*.py'
The repo board is only read (copied); all writes go to a temporary folder.
"""
import json
import os
import shutil
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from placer import cost  # noqa: E402

try:
    import pcbnew
    from placer import dru, kicad_io
except ImportError:  # plain python3 without KiCad
    pcbnew = None

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(os.path.dirname(HERE))
SRC = os.path.join(REPO, 'hardware-design/boards/PWR-24V-5V/cad/PWR-24V-5V')


def near(a, b, tol=1e-3):
    return all(abs(x - y) <= tol for x, y in zip(a, b))


def is_fixed(pr, ref):
    return any(u['fixed'] for u in pr['units'] if ref in u['refs'])


@unittest.skipUnless(pcbnew, 'needs pcbnew (KiCad bundled Python)')
class KeepoutGapsTest(unittest.TestCase):
    def test_a_no_net_creepage_rule_gives_its_domain_classes_the_gap_plus_the_margin(self):
        g = kicad_io._keepout_gaps({'FIELD': 1, 'CELL': 2}, [('FIELD', 0.7)])
        self.assertEqual(list(g), ['1'])
        self.assertAlmostEqual(g['1'], 0.75)

    def test_no_rule_gives_no_gap(self):
        self.assertEqual(kicad_io._keepout_gaps({'FIELD': 1}, []), {})


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

    def test_via_nets_give_each_unit_its_copper_pads_with_the_net_code(self):
        b = pcbnew.LoadBoard(self.board)
        gnd = b.FindNet('GND').GetNetCode()
        self.assertEqual(kicad_io.read_problem(self.board)['via_nets'], [])
        pr = kicad_io.read_problem(self.board, via_nets=['GND'])
        self.assertEqual(pr['via_nets'], [gnd])
        for u in pr['units']:
            pads = [p for r in u['refs'] for p in b.FindFootprintByReference(r).Pads()]
            self.assertEqual(len(u['cu']), len(pads))
            self.assertEqual(sorted(q[4] for q in u['cu']), sorted(p.GetNetCode() for p in pads))
        self.assertTrue(any(q[4] == gnd for u in pr['units'] for q in u['cu']))
        self.assertEqual(cost.via_room(pr, cost.initial_pose(pr), {}), 0)  # the routed original has via room

    def test_cu_nets_name_the_net_and_class_of_each_copper_net_code(self):
        b = pcbnew.LoadBoard(self.board)
        pr = kicad_io.read_problem(self.board)
        codes = {q[4] for u in pr['units'] for q in u['cu'] if q[4] > 0}
        self.assertEqual({int(k) for k in pr['cu_nets']}, codes)
        for k, (name, cls) in pr['cu_nets'].items():
            n = b.FindNet(name)
            self.assertEqual((n.GetNetCode(), n.GetNetClassName()), (int(k), cls))

    def test_cu_pads_give_the_ref_pad_kind_and_pad_number_of_each_copper_box(self):
        b = pcbnew.LoadBoard(self.board)
        kind = {pcbnew.PAD_ATTRIB_SMD: 'smd', pcbnew.PAD_ATTRIB_PTH: 'pth', pcbnew.PAD_ATTRIB_NPTH: 'npth',
                pcbnew.PAD_ATTRIB_CONN: 'smd'}
        for u in kicad_io.read_problem(self.board)['units']:
            want = [[r, kind[p.GetAttribute()], p.GetNumber()] for r in u['refs']
                    for p in b.FindFootprintByReference(r).Pads()]
            self.assertEqual(u['cu_pads'], want)
            self.assertEqual(len(u['cu_pads']), len([q for q in u['cu'] if q[4] != -1]))   # no-via rows (-1) come after

    def test_centres_give_each_part_courtyard_centre_relative_to_the_unit_origin(self):
        # the board checkers measure part distances from the courtyard box centre, not the footprint origin
        b = pcbnew.LoadBoard(self.board)
        pr = kicad_io.read_problem(self.board)
        for u in pr['units']:
            self.assertEqual(sorted(u['centres']), sorted(u['refs']))
            for r, (lx, ly) in u['centres'].items():
                c = kicad_io.fp_rect(b.FindFootprintByReference(r))
                self.assertAlmostEqual(lx + u['x'], (c[0] + c[2]) / 2, places=5)
                self.assertAlmostEqual(ly + u['y'], (c[1] + c[3]) / 2, places=5)
            self.assertEqual(cost.rule_miss(pr, cost.initial_pose(pr), 0), 0.0)

    def test_route_rules_hold_the_dru_rules_and_the_net_class_clearance_and_width(self):
        pr = kicad_io.read_problem(self.board)
        stem = os.path.splitext(self.board)[0]
        cs = json.load(open(stem + '.kicad_pro'))['net_settings']['classes']
        self.assertEqual(pr['route_rules']['classes'], {c['name']: [c['clearance'], c['track_width']] for c in cs})
        want = dru.parse(open(stem + '.kicad_dru').read()) if os.path.exists(stem + '.kicad_dru') else None
        got = pr['route_rules']['dru']
        self.assertEqual(set(got), {'domains', 'holes', 'pairs', 'members'})
        if want:
            self.assertEqual(json.loads(json.dumps(got)), json.loads(json.dumps({k: want[k] for k in got})))

    def test_no_via_rule_areas_are_board_via_keepouts_or_move_with_their_unit(self):
        shutil.copytree(os.path.join(self.tmp, 'b'), os.path.join(self.tmp, 'v'))  # pcbnew keeps a loaded project
        path = os.path.join(self.tmp, 'v', 'PWR-24V-5V.kicad_pcb')
        b = pcbnew.LoadBoard(path)
        c = b.FindFootprintByReference('U1').GetPosition()
        x, y = c.x / 1e6, c.y / 1e6
        z = pcbnew.ZONE(b)
        z.SetIsRuleArea(True)
        z.SetDoNotAllowVias(True)
        z.SetDoNotAllowFootprints(False)
        z.SetLayerSet(pcbnew.LSET.AllCuMask())
        z.SetZoneName('NOVIA_T')
        o = z.Outline()
        o.NewOutline()
        for px, py in ((x - 2, y - 1), (x + 2, y - 1), (x + 2, y + 1), (x - 2, y + 1)):
            o.Append(int(round(px * 1e6)), int(round(py * 1e6)))
        b.Add(z)
        pcbnew.SaveBoard(path, b)
        pr = kicad_io.read_problem(path)
        n = len(pr['board']['via_keepouts'])
        self.assertIn([[round(x - 2, 3), round(y - 1, 3)], [round(x + 2, 3), round(y - 1, 3)],
                       [round(x + 2, 3), round(y + 1, 3)], [round(x - 2, 3), round(y + 1, 3)]],
                      [[[round(v, 3) for v in q] for q in k] for k in pr['board']['via_keepouts']])
        pr = kicad_io.read_problem(path, zone_refs={'NOVIA_T': 'U1'})
        self.assertEqual(len(pr['board']['via_keepouts']), n - 1)
        u = pr['units'][self.unit(pr, 'U1')]
        rows = [q for q in u['cu'] if q[4] == -1]
        self.assertEqual(len(rows), 1)
        self.assertEqual([round(v, 3) for v in (rows[0][0] + u['x'], rows[0][1] + u['y'], rows[0][2] + u['x'],
                                                rows[0][3] + u['y'])],
                         [round(x - 2, 3), round(y - 1, 3), round(x + 2, 3), round(y + 1, 3)])

    def test_cli_read_takes_the_via_nets(self):
        from placer import cli
        out = os.path.join(self.tmp, 'p.json')
        cli.main(['read', self.board, '-o', out, '--via-net', 'GND', 'NOPE*'])
        self.assertEqual(json.load(open(out))['via_nets'], [pcbnew.LoadBoard(self.board).FindNet('GND').GetNetCode()])

    def test_a_locked_track_is_fixed_copper_and_the_writer_keeps_it(self):
        b = pcbnew.LoadBoard(self.board)
        t = next(t for t in b.GetTracks() if t.GetClass() == 'PCB_TRACK')
        t.SetLocked(True)
        tid = t.m_Uuid.AsString()
        pcbnew.SaveBoard(self.board, b)
        pr = kicad_io.read_problem(self.board)
        self.assertEqual(len(pr['board']['fixed_copper']), 1)
        ends = [(pcbnew.ToMM(q.x), pcbnew.ToMM(q.y)) for q in (t.GetStart(), t.GetEnd())]
        on = [f.GetReference() for f in b.GetFootprints() for p in f.Pads() if any(p.HitTest(pcbnew.VECTOR2I(
            int(x * 1e6), int(y * 1e6))) for x, y in ends)]
        self.assertTrue(on and all(is_fixed(pr, r) for r in on))  # its parts stay: the route is fixed
        pose = cost.initial_pose(pr)
        for i, u in enumerate(pr['units']):  # every movable unit moves onto the track
            if not u['fixed']:
                pose[i] = (ends[0][0], ends[0][1], 0)
        out = os.path.join(self.tmp, 'b', 'out.kicad_pcb')
        kicad_io.write_board(self.board, pr, pose, out)
        self.assertIn(tid, [x.m_Uuid.AsString() for x in pcbnew.LoadBoard(out).GetTracks()])

    def test_locked_bottom_track_membership_and_pth_smd_control(self):
        b = pcbnew.LoadBoard(self.board)
        track = next(t for t in b.GetTracks() if t.GetClass() == 'PCB_TRACK')
        track.SetLayer(pcbnew.B_Cu)
        track.SetLocked(True)
        pcbnew.SaveBoard(self.board, b)
        pr = kicad_io.read_problem(self.board)
        self.assertIn(kicad_io._copper_row(b, track), pr['board']['fixed_copper_layers'])
        actual = {fp.GetReference(): fp for fp in b.GetFootprints()}
        for u in pr['units']:
            pads = [p for ref in u['refs'] for p in actual[ref].Pads()]
            self.assertEqual(len(pads), len(u['pad_copper_layers']))
            for pad, layers in zip(pads, u['pad_copper_layers']):
                self.assertEqual('B.Cu' in layers, pad.IsOnLayer(pcbnew.B_Cu))
                self.assertEqual('F.Cu' in layers, pad.IsOnLayer(pcbnew.F_Cu))
        pth = next((u, k) for u in pr['units'] for k, meta in enumerate(u['cu_pads'])
                   if meta[1] == 'pth')
        smd = next((u, k) for u in pr['units'] for k, layers in enumerate(u['pad_copper_layers'])
                   if layers == ['F.Cu'])
        board = {'outline': [[0, 0], [20, 0], [20, 20], [0, 20]], 'keepouts': [],
                 'fixed_copper_layers': [['B.Cu', 9., 10., 11., 10., .2]]}
        for (source, index), bad in ((pth, True), (smd, False)):
            u = {'name': 'fixture', 'refs': ['fixture'], 'fixed': False, 'x': 10., 'y': 10.,
                 'rects': [[-1., -1., 1., 1., 0.]], 'pad_rects': [[-.5, -.5, .5, .5]],
                 'pad_copper_layers': [source['pad_copper_layers'][index]]}
            ev = cost.Evaluator({'units': [u], 'nets': [], 'board': board}, {})
            self.assertEqual(ev.legal_penalty(0) > 0., bad)

    def test_locked_via_rows_record_actual_layer_span(self):
        b = pcbnew.LoadBoard(self.board)
        b.SetCopperLayerCount(4)
        via = pcbnew.PCB_VIA(b)
        via.SetPosition(pcbnew.VECTOR2I(int(10e6), int(10e6)))
        via.SetWidth(int(.6e6))
        via.SetDrill(int(.3e6))
        via.SetLayerPair(pcbnew.F_Cu, pcbnew.B_Cu)
        via.SetLocked(True)
        b.Add(via)
        pcbnew.SaveBoard(self.board, b)
        pr = kicad_io.read_problem(self.board)
        rows = [r for r in pr['board']['fixed_copper_layers'] if r[1:5] == [10., 10., 10., 10.]]
        self.assertTrue(rows)
        self.assertEqual({r[0] for r in rows}, {'F.Cu', 'In1.Cu', 'In2.Cu', 'B.Cu'})
        self.assertEqual(len(rows), 4)
        self.assertTrue(all(r[0] != 'via' for r in rows))
        via.SetViaType(pcbnew.VIATYPE_BLIND)
        via.SetLayerPair(pcbnew.F_Cu, pcbnew.In1_Cu)
        self.assertEqual({r[0] for r in kicad_io._layer_copper_rows(b, via)}, {'F.Cu', 'In1.Cu'})

    def test_a_connector_staged_wholly_outside_the_outline_is_movable(self):
        b = pcbnew.LoadBoard(self.board)
        j = b.FindFootprintByReference('J1')
        j.Move(pcbnew.VECTOR2I(0, int(100e6)))
        pcbnew.SaveBoard(self.board, b)
        pr = kicad_io.read_problem(self.board)
        self.assertFalse(pr['units'][self.unit(pr, 'J1')]['fixed'])

    def test_a_pad_of_a_net_class_with_a_larger_clearance_gets_its_own_spacing_rect(self):
        import json as js
        net = next(p.GetNetname() for p in pcbnew.LoadBoard(self.board).FindFootprintByReference('U1').Pads()
                   if p.GetNetname() and p.GetNetClassName() == 'Default')
        shutil.copytree(os.path.join(self.tmp, 'b'), os.path.join(self.tmp, 'c'))  # pcbnew keeps a loaded project
        pro = os.path.join(self.tmp, 'c', 'PWR-24V-5V.kicad_pro')
        d = js.load(open(pro))
        hv = dict(d['net_settings']['classes'][0], name='HV', clearance=2.5, priority=0)
        d['net_settings']['classes'].append(hv)
        d['net_settings']['netclass_patterns'] = (d['net_settings'].get('netclass_patterns') or []) + [
            {'netclass': 'HV', 'pattern': net}]
        js.dump(d, open(pro, 'w'))
        pr = kicad_io.read_problem(os.path.join(self.tmp, 'c', 'PWR-24V-5V.kicad_pcb'))
        u = pr['units'][self.unit(pr, 'U1')]
        self.assertEqual(u['rects'][0][4], 1.0)  # the courtyard keeps the D-040 class
        pads = [p for p in pcbnew.LoadBoard(self.board).FindFootprintByReference('U1').Pads() if p.GetNetname() == net]
        hv = [[round(v, 2) for v in r] for r in u['rects'] if r[4] == 2.5]
        self.assertEqual(len(hv), len(pads))  # the mains rule is pad to copper, not courtyard to courtyard
        self.assertEqual(sorted(u['hard']), [k for k, r in enumerate(u['rects']) if r[4] == 2.5])  # DRC enforces it
        bb = pads[0].GetBoundingBox()
        self.assertIn([round(v, 2) for v in (bb.GetX() / 1e6 - u['x'], bb.GetY() / 1e6 - u['y'],
                                             bb.GetRight() / 1e6 - u['x'], bb.GetBottom() / 1e6 - u['y'], 2.5)], hv)

    def test_each_net_gets_the_track_of_its_net_class(self):
        import json as js
        net = next(p.GetNetname() for p in pcbnew.LoadBoard(self.board).FindFootprintByReference('U1').Pads()
                   if p.GetNetname() and p.GetNetClassName() == 'Default')
        shutil.copytree(os.path.join(self.tmp, 'b'), os.path.join(self.tmp, 'e'))  # pcbnew keeps a loaded project
        pro = os.path.join(self.tmp, 'e', 'PWR-24V-5V.kicad_pro')
        d = js.load(open(pro))
        d['net_settings']['classes'].append(dict(d['net_settings']['classes'][0], name='P24', track_width=0.5,
                                                 clearance=0.3, priority=0))
        d['net_settings']['netclass_patterns'] = (d['net_settings'].get('netclass_patterns') or []) + [
            {'netclass': 'P24', 'pattern': net}]
        js.dump(d, open(pro, 'w'))
        default = next(c for c in d['net_settings']['classes'] if c['name'] == 'Default')
        pr = kicad_io.read_problem(os.path.join(self.tmp, 'e', 'PWR-24V-5V.kicad_pcb'))
        tracks = {n['name']: n['track'] for n in pr['nets']}
        self.assertAlmostEqual(tracks.pop(net), 0.8)
        self.assertTrue(tracks)
        b = pcbnew.LoadBoard(os.path.join(self.tmp, 'e', 'PWR-24V-5V.kicad_pcb'))
        cls = {p.GetNetname(): p.GetNetClassName() for p in b.GetPads()}
        for n, t in tracks.items():
            if cls[n] == 'Default':
                self.assertAlmostEqual(t, default['track_width'] + default['clearance'])

    def test_the_track_clearance_takes_the_larger_dru_class_gap(self):
        import json as js
        pro = os.path.join(self.tmp, 'tracks.kicad_pro')
        cls = [{'name': 'Default', 'track_width': 0.2, 'clearance': 0.2},
               {'name': 'MAINS_K1', 'track_width': 2.0, 'clearance': 1.0}]
        js.dump({'net_settings': {'classes': cls}}, open(pro, 'w'))
        t = kicad_io.class_tracks(pro, domains=[('MAINS_K*', 8.0, 3.0)])
        self.assertAlmostEqual(t['MAINS_K1'], 2.0 + 3.0)  # the gap between two classes of the domain
        self.assertAlmostEqual(t['Default'], 0.4)
        self.assertAlmostEqual(kicad_io.class_tracks(pro)['MAINS_K1'], 3.0)

    def test_domain_pads_get_domain_rects_and_the_part_courtyard_holds_no_pad(self):
        import json as js
        net = next(p.GetNetname() for p in pcbnew.LoadBoard(self.board).FindFootprintByReference('U1').Pads()
                   if p.GetNetname() and p.GetNetClassName() == 'Default')
        shutil.copytree(os.path.join(self.tmp, 'b'), os.path.join(self.tmp, 'd'))  # pcbnew keeps a loaded project
        pro = os.path.join(self.tmp, 'd', 'PWR-24V-5V.kicad_pro')
        d = js.load(open(pro))
        d['net_settings']['classes'].append(dict(d['net_settings']['classes'][0], name='MAINS_K1', priority=0))
        d['net_settings']['netclass_patterns'] = (d['net_settings'].get('netclass_patterns') or []) + [
            {'netclass': 'MAINS_K1', 'pattern': net}]
        js.dump(d, open(pro, 'w'))
        path = os.path.join(self.tmp, 'd', 'PWR-24V-5V.kicad_pcb')
        pr = kicad_io.read_problem(path, domains=[('MAINS_K*', 8.0, 3.0)])
        u = pr['units'][self.unit(pr, 'U1')]
        fp = pcbnew.LoadBoard(path).FindFootprintByReference('U1')
        mains = [p for p in fp.Pads() if p.GetNetname() == net]
        self.assertEqual(len(u['dom']), len(mains))
        self.assertEqual({(c, g) for _, c, g, _ in u['dom']}, {(1, 3.0)})
        self.assertEqual({u['rects'][i][4] for i, *_ in u['dom']}, {8.0})
        self.assertIn(0, u['mech'])  # the courtyard: its pads have their own rects
        pads = [p for p in fp.Pads() if p.GetNetname()]
        self.assertEqual(len(u['rects']), 1 + len(pads))
        self.assertEqual(sorted(u['hard'] + [i for i, *_ in u['dom']]), list(range(1, 1 + len(pads))))
        self.assertNotIn('dom', pr['units'][self.unit(pr, 'R2')])
        self.assertEqual(pr['units'][self.unit(pr, 'H3')]['mech'], [0])  # a mounting hole: no net pad

    def test_domain_and_hole_rules_come_from_the_board_dru(self):
        import json as js
        b = pcbnew.LoadBoard(self.board)
        net = next(p.GetNetname() for p in b.FindFootprintByReference('U1').Pads()
                   if p.GetNetname() and p.GetNetClassName() == 'Default')
        fb, hb = [p.GetNetname() for p in b.FindFootprintByReference('R2').Pads()]
        shutil.copytree(os.path.join(self.tmp, 'b'), os.path.join(self.tmp, 'e'))  # pcbnew keeps a loaded project
        pro = os.path.join(self.tmp, 'e', 'PWR-24V-5V.kicad_pro')
        d = js.load(open(pro))
        d['net_settings']['classes'].append(dict(d['net_settings']['classes'][0], name='MAINS_K1', priority=0))
        d['net_settings']['netclass_patterns'] = (d['net_settings'].get('netclass_patterns') or []) + [
            {'netclass': 'MAINS_K1', 'pattern': net}, {'netclass': 'FB', 'pattern': fb}, {'netclass': 'HB', 'pattern': hb}]
        d['net_settings']['classes'] += [dict(d['net_settings']['classes'][0], name=c, priority=0) for c in ('FB', 'HB')]
        js.dump(d, open(pro, 'w'))
        with open(os.path.join(self.tmp, 'e', 'PWR-24V-5V.kicad_dru'), 'a') as f:
            f.write('\n(rule "M" (condition "A.NetClass == \'MAINS_K*\' && B.NetClass != \'MAINS_K*\'")'
                    ' (constraint clearance (min 8mm)))\n'
                    '(rule "H" (condition "A.NetClass == \'MAINS_K*\' && B.Type == \'Pad\' && B.Reference == \'H3\'")'
                    ' (constraint hole_clearance (min 9.65mm)))\n'
                    '(rule "X" (condition "A.NetClass == \'FB\' && B.NetClass == \'HB\'")'
                    ' (constraint clearance (min 4mm)))\n'
                    '(rule "Odd" (condition "A.NetClass == \'FB\' || B.Layer == \'F.Cu\'")'
                    ' (constraint clearance (min 1mm)))\n')
        pr = kicad_io.read_problem(os.path.join(self.tmp, 'e', 'PWR-24V-5V.kicad_pcb'))
        cg = pr['class_gaps']
        i = {n.split(',')[0]: k for k, n in enumerate(cg['names'])}  # a net in 2 classes: 'HB,POWER'
        u = pr['units'][self.unit(pr, 'U1')]
        self.assertEqual({u['rects'][k][4] for k, c, *_ in u['dom'] if c == i['MAINS_K1']}, {8.0})
        h = pr['units'][self.unit(pr, 'H3')]
        self.assertEqual([(c, g) for _, c, g, _ in h['dom']], [(-1, 9.65)])
        self.assertEqual(pr['dru_ignored'], ['Odd'])
        self.assertEqual(set(i) - {''}, {'MAINS_K1', 'FB', 'HB'})
        self.assertEqual(cg['gaps'][i['FB']][i['HB']], 4.0)  # the pair rule (barrier)
        self.assertEqual(cg['gaps'][i['HB']][i['FB']], 4.0)
        self.assertEqual(cg['gaps'][i['MAINS_K1']][i['FB']], 8.0)  # mains to every other net
        r2 = pr['units'][self.unit(pr, 'R2')]
        self.assertEqual({c for _, c, *_ in r2['dom']}, {i['FB'], i['HB']})
        self.assertNotIn('dom', kicad_io.read_problem(os.path.join(self.tmp, 'e', 'PWR-24V-5V.kicad_pcb'),
                                                      domains=[])['units'][self.unit(pr, 'U1')])

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
        n_lone = len(self.lone_vias(b0))
        none = kicad_io.read_problem(self.board, free_box=[0, 0, 1, 1])  # nothing movable: all copper stays
        self.assertEqual(len(none['board']['copper']), n_tracks - n_lone)  # lone stitching vias are no obstacle
        self.assertTrue(any(c[0] == 'via' for c in none['board']['copper']))
        ic = kicad_io.fp_rect(b0.FindFootprintByReference('U1'))
        pr = kicad_io.read_problem(self.board, free_box=list(ic))  # only U1 moves
        self.assertEqual([u['refs'] for u in pr['units'] if not u['fixed']], [['U1']])
        i = self.unit(pr, 'U1')
        pose = cost.initial_pose(pr)
        pose[i] = (pose[i][0] + 3.0, pose[i][1], 0)
        out = os.path.join(self.tmp, 'b', 'out.kicad_pcb')
        rep = kicad_io.write_board(self.board, pr, pose, out)
        b1 = pcbnew.LoadBoard(out)
        lone = {self.key(t) for t in self.lone_vias(b1)}
        kept = {self.key(t) for t in b1.GetTracks()} - lone
        cost_copper = {tuple(round(v, 3) for v in c[1:5]) for c in pr['board']['copper']}
        self.assertEqual(kept - cost_copper, set())  # the writer keeps nothing the cost did not count
        self.assertLessEqual(len(cost_copper - kept), rep['removed_collisions'])

    @staticmethod
    def key(t):
        if t.GetClass() == 'PCB_VIA':
            q = t.GetPosition()
            return tuple(round(v / 1e6, 3) for v in (q.x, q.y, q.x, q.y))
        a, b = t.GetStart(), t.GetEnd()
        return tuple(round(v / 1e6, 3) for v in (a.x, a.y, b.x, b.y))

    @staticmethod
    def lone_vias(b):
        ends = {(t.GetNetCode(), p.x, p.y) for t in b.GetTracks() if t.GetClass() != 'PCB_VIA'
                for p in (t.GetStart(), t.GetEnd())}
        return [t for t in b.GetTracks() if t.GetClass() == 'PCB_VIA'
                and (t.GetNetCode(), t.GetPosition().x, t.GetPosition().y) not in ends]

    def test_units_carry_their_pad_boxes_for_the_copper_obstacle_check(self):
        pr = kicad_io.read_problem(self.board)
        b = pcbnew.LoadBoard(self.board)
        u = pr['units'][self.unit(pr, 'U1')]
        pads = [p for r in u['refs'] for p in b.FindFootprintByReference(r).Pads()]
        self.assertEqual(len(u['pad_rects']), len(pads))
        for p in pads:
            q = p.GetPosition()
            x, y = q.x / 1e6 - u['x'], q.y / 1e6 - u['y']
            self.assertTrue(any(r[0] <= x <= r[2] and r[1] <= y <= r[3] for r in u['pad_rects']))

    def test_lone_stitching_vias_are_not_kept_copper(self):
        # a via-only cluster (stitching via to a zone) is no obstacle: the writer removes it where a part lands
        b = pcbnew.LoadBoard(self.board)
        u1 = b.FindFootprintByReference('U1')
        q = u1.GetPosition()
        spot = None
        for d in range(20, 200):  # first free point left of U1, off all pads and tracks
            v = pcbnew.VECTOR2I(q.x - d * 100000, q.y)
            if (not any(p.HitTest(v, 500000) for p in b.GetPads())
                    and not any(t.HitTest(v, 500000) for t in b.GetTracks())
                    and not any(fp.GetCourtyard(pcbnew.F_CrtYd).Collide(v, 300000) for fp in b.GetFootprints())):
                spot = (v.x / 1e6, v.y / 1e6)
                break
        self.assertIsNotNone(spot)
        via = pcbnew.PCB_VIA(b)
        via.SetPosition(pcbnew.VECTOR2I(int(spot[0] * 1e6), int(spot[1] * 1e6)))
        via.SetWidth(600000)
        via.SetDrill(300000)
        via.SetNet(b.FindNet('GND'))
        b.Add(via)
        pcbnew.SaveBoard(self.board, b)
        pr = kicad_io.read_problem(self.board)
        self.assertFalse(any(c[0] == 'via' and near(c[1:3], spot) for c in pr['board']['copper']))

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
        pr = kicad_io.read_problem(self.board, free_box=list(kicad_io.fp_rect(u1)))
        self.assertFalse(any(at(c) for c in pr['board']['copper']))
        i = self.unit(pr, 'U1')
        pose = cost.initial_pose(pr)
        pose[i] = (pose[i][0] + 3.0, pose[i][1], 0)
        out = os.path.join(self.tmp, 'b', 'out.kicad_pcb')
        kicad_io.write_board(self.board, pr, pose, out)
        self.assertFalse(any(t.GetClass() == 'PCB_VIA' and near((t.GetPosition().x / 1e6, t.GetPosition().y / 1e6), spot)
                             for t in pcbnew.LoadBoard(out).GetTracks()))

    def test_write_on_a_virtual_board_replaces_the_outline_by_the_scaled_box(self):
        pr = kicad_io.read_problem(self.board)
        x0, y0, x1, y1 = cost.outline_box(pr['board'])
        out = os.path.join(self.tmp, 'b', 'out.kicad_pcb')
        kicad_io.write_board(self.board, pr, cost.initial_pose(pr), out, outline_scale=1.5)
        q = kicad_io.read_problem(out)
        cx, cy, w, h = (x0 + x1) / 2, (y0 + y1) / 2, (x1 - x0) * 1.5, (y1 - y0) * 1.5
        self.assertTrue(near(cost.outline_box(q['board']), (cx - w / 2, cy - h / 2, cx + w / 2, cy + h / 2), 0.01))

    def test_write_on_a_virtual_board_grows_the_full_board_zones_with_the_outline(self):
        pr = kicad_io.read_problem(self.board)
        x0, y0, x1, y1 = cost.outline_box(pr['board'])
        full = lambda z: z.GetBoundingBox()  # noqa: E731
        before = {z.GetZoneName(): full(z) for z in pcbnew.LoadBoard(self.board).Zones()}
        out = os.path.join(self.tmp, 'b', 'out.kicad_pcb')
        kicad_io.write_board(self.board, pr, cost.initial_pose(pr), out, outline_scale=1.5)
        after = {z.GetZoneName(): full(z) for z in pcbnew.LoadBoard(out).Zones()}
        self.assertIn('GND_F', after)
        w, h = (x1 - x0) * 1.5, (y1 - y0) * 1.5
        for name in ('GND_F', 'GND_B'):
            bb = after[name]
            self.assertGreater(bb.GetWidth() / 1e6, w - 1.0, name)
            self.assertGreater(bb.GetHeight() / 1e6, h - 1.0, name)
        # a local zone (not the whole board) keeps its outline
        for name, bb in before.items():
            if bb.GetWidth() / 1e6 < (x1 - x0) * 0.9:
                self.assertEqual((after[name].GetWidth(), after[name].GetHeight()), (bb.GetWidth(), bb.GetHeight()))

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

    def _block_u1(self, b):
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
        return ic, box

    def _rule_area(self, b, name, r):
        z = pcbnew.ZONE(b)
        z.SetIsRuleArea(True)
        z.SetDoNotAllowTracks(True)
        z.SetDoNotAllowFootprints(False)
        z.SetZoneName(name)
        z.SetLayer(pcbnew.F_Cu)
        o = z.Outline()
        o.NewOutline()
        for x, y in ((r[0], r[1]), (r[2], r[1]), (r[2], r[3]), (r[0], r[3])):
            o.Append(pcbnew.VECTOR2I(int(x * 1e6), int(y * 1e6)))
        b.Add(z)
        return z

    def test_edge_anchor_and_block_rule_area_clipped_at_the_anchor_line_move_with_the_block(self):
        b = pcbnew.LoadBoard(self.board)
        ic, box = self._block_u1(b)
        z = self._rule_area(b, 'ANT', (ic[0] - 3, ic[3] - 1, ic[2] + 3, ic[3] + 5))  # beyond the S side
        zid = z.m_Uuid.AsString()
        pcbnew.SaveBoard(self.board, b)
        # a rule area goes with a unit only when named: a board-wide area (a mains domain) that meets a block stays
        pr0 = kicad_io.read_problem(self.board)
        self.assertNotIn('zones', pr0['units'][self.unit(pr0, 'U1')])
        pr = kicad_io.read_problem(self.board, edges={'U1': ('LR', 'S')}, zone_refs={'ANT': 'U1'})
        i = self.unit(pr, 'U1')
        u = pr['units'][i]
        self.assertEqual(u['edge']['sides'], 'LR')
        # in a block the anchor is on the border (block copper ends there), in line with the part side
        self.assertTrue(near(u['edge']['at'], ((ic[0] + ic[2]) / 2 - u['x'], box[3] - u['y']), 0.01))
        self.assertEqual(u['zones'], [zid])
        self.assertEqual([u['rects'][k][4] for k in u['ko']], [0.0])  # the area rect is a keepout rect
        self.assertIn([round(v, 2) for v in (ic[0] - 3 - u['x'], ic[3] - 1 - u['y'], ic[2] + 3 - u['x'],
                                             box[3] - u['y'], 0.0)],
                      [[round(v, 2) for v in r] for r in u['rects']])
        pose = cost.initial_pose(pr)
        pose[i] = (pose[i][0] - 4.0, pose[i][1] + 1.0, 0)
        out = os.path.join(self.tmp, 'b', 'out.kicad_pcb')
        kicad_io.write_board(self.board, pr, pose, out)
        z1 = next(q for q in pcbnew.LoadBoard(out).Zones() if q.m_Uuid.AsString() == zid)
        bb = z1.GetBoundingBox()
        self.assertTrue(near((bb.GetX() / 1e6, bb.GetY() / 1e6), (ic[0] - 3 - 4.0, ic[3] - 1 + 1.0), 0.01))

    def test_a_board_slot_inside_a_block_border_moves_with_the_block_as_a_keepout_rect(self):
        # RELAY-4: each relay block has an Edge.Cuts slot under the relay (creepage); it is part of the block
        b = pcbnew.LoadBoard(self.board)
        ic, box = self._block_u1(b)
        sl = (ic[0] + 0.5, ic[1] + 0.5, ic[0] + 1.5, ic[1] + 2.5)
        cut = pcbnew.PCB_SHAPE(b)
        cut.SetShape(pcbnew.SHAPE_T_RECT)
        cut.SetLayer(pcbnew.Edge_Cuts)
        cut.SetStart(pcbnew.VECTOR2I(int(sl[0] * 1e6), int(sl[1] * 1e6)))
        cut.SetEnd(pcbnew.VECTOR2I(int(sl[2] * 1e6), int(sl[3] * 1e6)))
        b.Add(cut)
        cid = cut.m_Uuid.AsString()
        pcbnew.SaveBoard(self.board, b)
        pr = kicad_io.read_problem(self.board)
        self.assertFalse(any(abs(min(q[0] for q in k) - sl[0]) < 0.01 for k in pr['board']['keepouts']))
        i = self.unit(pr, 'U1')
        u = pr['units'][i]
        self.assertEqual(u['cuts'], [cid])
        self.assertIn([round(v, 2) for v in (sl[0] - u['x'], sl[1] - u['y'], sl[2] - u['x'], sl[3] - u['y'], 0.0)],
                      [[round(v, 2) for v in u['rects'][k]] for k in u['ko']])
        pose = cost.initial_pose(pr)
        q = json.loads(json.dumps(pr))
        q['units'][i]['rects'].pop()
        del q['units'][i]['ko']
        self.assertAlmostEqual(cost.Evaluator(pr, {}).legal_penalty(i),  # its own slot adds no penalty
                               cost.Evaluator(q, {}).legal_penalty(i))
        pose[i] = (pose[i][0] - 4.0, pose[i][1] + 1.0, 0)
        out = os.path.join(self.tmp, 'b', 'out.kicad_pcb')
        kicad_io.write_board(self.board, pr, pose, out)
        c1 = next(d for d in pcbnew.LoadBoard(out).GetDrawings() if d.m_Uuid.AsString() == cid)
        q0 = c1.GetStart()  # the rect corner (the bounding box adds half the line width)
        self.assertTrue(near((q0.x / 1e6, q0.y / 1e6), (sl[0] - 4.0, sl[1] + 1.0), 0.05))

    def test_named_rule_areas_are_board_keepouts(self):
        b = pcbnew.LoadBoard(self.board)
        self._rule_area(b, 'ZZ9_KEEPOUT', (0, 0, 2, 2))
        pcbnew.SaveBoard(self.board, b)
        self.assertEqual(len(kicad_io.read_problem(self.board, keepout_zones=['ZZ*'])['board']['keepouts'])
                         - len(kicad_io.read_problem(self.board)['board']['keepouts']), 1)

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


RELAY4 = os.path.join(REPO, 'hardware-design', 'boards', 'RELAY-4', 'cad', 'RELAY-4', 'RELAY-4.kicad_pcb')
IO6X6 = os.path.join(REPO, 'hardware-design', 'boards', 'IO-6X6', 'cad', 'IO-6X6', 'IO-6X6.kicad_pcb')
KNOWN_GOOD = ['RELAY-4', 'IO-6X6', 'INPUT-4D2A', 'POE-ETHERNET', 'PWR-24V-5V', 'FIELD-24V-BUS', 'BASE-PWR']
ZONE_REFS = {'BASE-PWR': {'U1_ANTENNA': 'U1'}}  # the WROOM antenna keepout moves with U1 (D-021)


def board_path(name):
    return os.path.join(REPO, 'hardware-design', 'boards', name, 'cad', name, name + '.kicad_pcb')


@unittest.skipUnless(pcbnew and os.path.exists(RELAY4), 'needs pcbnew and the RELAY-4 board')
class KnownGoodGateTest(unittest.TestCase):
    """The model must accept a known-good routed board and reject a placement that breaks its .kicad_dru rules."""

    @classmethod
    def setUpClass(cls):
        cls.pr = kicad_io.read_problem(RELAY4, keepout_zones=['H*_KEEPOUT'], skip=['GND', 'FIELD_GND'])

    def test_the_relay4_original_is_legal(self):
        ev = cost.Evaluator(self.pr, {})
        self.assertEqual([u['name'] for i, u in enumerate(self.pr['units'])
                          if not u['fixed'] and ev.legal_penalty(i) > 0], [])

    def test_the_mains_area_keeps_c24_out_as_in_the_port2_winner(self):
        (a,) = self.pr['domain_areas']  # one .kicad_dru domain: MAINS_K*, 8 mm to all other nets
        self.assertEqual((len(a['classes']), a['gap']), (4, 8.0))
        self.assertAlmostEqual(cost.overlap(self.pr, cost.initial_pose(self.pr)), 0.0)
        i = [u['name'] for u in self.pr['units']].index('C24')
        pose = cost.initial_pose(self.pr)
        pose[i] = (147.8, 179.8, 1)  # PORT2 s89: below the mains connectors, 8 mm from the J4 pads
        pr = dict(self.pr, domain_areas=[])
        self.assertAlmostEqual(cost.Evaluator(pr, {}, pose).legal_penalty(i), 0.0)  # the pad gaps pass
        self.assertGreater(cost.Evaluator(self.pr, {}, pose).legal_penalty(i), 0.0)

    def test_the_courtyard_rect_is_the_courtyard_polygon_box(self):  # BBox() adds about 0.05 mm per side
        fp = pcbnew.LoadBoard(board_path('BASE-PWR')).FindFootprintByReference('R36')
        c = fp.GetCourtyard(pcbnew.F_CrtYd).Outline(0)
        xs = [pcbnew.ToMM(c.CPoint(k).x) for k in range(c.PointCount())]
        ys = [pcbnew.ToMM(c.CPoint(k).y) for k in range(c.PointCount())]
        for got, want in zip(kicad_io.fp_rect(fp), (min(xs), min(ys), max(xs), max(ys))):
            self.assertAlmostEqual(got, want, places=4)

    def test_a_round_courtyard_is_a_circle(self):  # POE TP4/TP5: boxes overlap, circles 0.015 mm apart
        pr = kicad_io.read_problem(board_path('POE-ETHERNET'))
        u = pr['units'][[x['name'] for x in pr['units']].index('TP5')]
        (i, rho), = u['rho']
        r = u['rects'][i]
        self.assertAlmostEqual(r[2] - r[0], 2 * rho, places=3)

    def test_a_no_footprint_area_on_the_back_only_does_not_hold_top_parts(self):  # BASE-PWR INPUT_J2_KEEPOUT
        pr = kicad_io.read_problem(board_path('BASE-PWR'))
        self.assertFalse(any(min(p[0] for p in k) > 149 and max(p[0] for p in k) < 167 for k in pr['board']['keepouts']))

    def test_all_known_good_originals_are_legal(self):
        bad = {}
        for name in KNOWN_GOOD:
            pr = kicad_io.read_problem(board_path(name), zone_refs=ZONE_REFS.get(name))
            ev = cost.Evaluator(pr, {})
            bad[name] = [u['name'] for i, u in enumerate(pr['units']) if not u['fixed'] and ev.legal_penalty(i) > 0]
        self.assertEqual({k: v for k, v in bad.items() if v}, {})

    def test_the_edge_band_is_the_board_copper_to_edge_clearance(self):
        pr = kicad_io.read_problem(board_path('INPUT-4D2A'))
        self.assertEqual(pr['board']['edge_clearance'], 0.5)
        self.assertTrue(all('edge_pads' in u for u in pr['units'] if 'pad_rects' not in u and u['refs']))

    def test_the_io6x6_original_is_legal(self):  # its block borders BLOCK2 and DO1-2 overlap: legal, not DRC
        pr = kicad_io.read_problem(IO6X6)
        ev = cost.Evaluator(pr, {})
        self.assertEqual([u['name'] for i, u in enumerate(pr['units'])
                          if not u['fixed'] and ev.legal_penalty(i) > 0], [])
        self.assertEqual(len(pr['units'][[u['name'] for u in pr['units']].index('BLOCK2')]['border']), 1)

    def test_a_selv_part_6_7_mm_from_a_mains_pad_is_illegal(self):
        # the 8 mm gap comes from the RELAY-4 .kicad_dru "Mains to SELV and 24 V", read by the reader
        pr = kicad_io.read_problem(RELAY4)
        b = pcbnew.LoadBoard(RELAY4)
        pads = [p for f in b.GetFootprints() for p in f.Pads() if p.GetNetClassName().startswith('MAINS_K')]
        pad = max(pads, key=lambda p: p.GetBoundingBox().GetRight())  # the right-most mains pad
        ref = pad.GetParentFootprint().GetReference()
        i = next(k for k, u in enumerate(pr['units']) if ref in u['refs'])
        mu = pr['units'][i]
        box = [mu['x'] + r[2] for r in mu['rects']]
        bb = pad.GetBoundingBox()
        right, y = pcbnew.ToMM(bb.GetRight()), pcbnew.ToMM(bb.GetCenter().y)
        self.assertLessEqual(max(box), right + 6.7)  # nothing else of the unit reaches the test part

        def penalty(gap):
            selv = {'name': 'R', 'refs': ['R'], 'fixed': False, 'x': right + gap + 0.5, 'y': y,
                    'rects': [[-0.5, -0.5, 0.5, 0.5, 0.0]]}
            q = dict(pr, units=[dict(mu, fixed=True), selv], nets=[], decaps=[], region=None)
            return cost.Evaluator(q, {}).legal_penalty(1)
        self.assertGreater(penalty(6.7), 0.0)
        self.assertAlmostEqual(penalty(8.1), 0.0)

    def test_the_bench_b_v2_placement_that_broke_the_mains_rule_is_illegal(self):
        pose = [tuple(q) for q in json.load(open(os.path.join(HERE, 'testdata', 'relay4-bench-b-v2-P.json')))['pose']]
        ev = cost.Evaluator(self.pr, {}, pose)
        self.assertGreater(sum(1 for i in range(ev.n) if not ev.fixed[i] and ev.legal_penalty(i) > 0), 10)


if __name__ == '__main__':
    unittest.main()
