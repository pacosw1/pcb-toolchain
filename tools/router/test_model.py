"""Unit tests of tools/router/model.py helpers. Needs the KiCad Python (model.py imports pcbnew):
  /Applications/KiCad/KiCad.app/Contents/Frameworks/Python.framework/Versions/Current/bin/python3 -m unittest test_model
"""
import json
import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import model  # noqa: E402


class ViaCurrent(unittest.TestCase):
    def test_power_via_carries_the_net_current(self):
        # v8 (ESP32-CORE b4 paths_low: VIN_REG 2.1 A through one 0.3 mm via = 1.92 A at dT 20 K, plating 18 um)
        self.assertLess(model.pcbtool.via_amps(0.3, 0.018, 20), 2.1)
        dr, d = model.via_for_current(0.3, 0.6, 2.1, 0.018, 20)
        self.assertEqual((dr, d), (0.35, 0.65))
        self.assertGreaterEqual(model.pcbtool.via_amps(dr, 0.018, 20), 2.1)
        self.assertEqual(model.via_for_current(0.3, 0.6, 1.0, 0.018, 20), (0.3, 0.6))

    def test_plane_pad_of_a_high_current_chain_gets_a_larger_fanout_via(self):
        # v8b (ESP32-CORE c1 paths_low: GND J2.4 -> U3.6 2.1 A through the 0.3 mm fan-out via of U3.6)
        classes = {'Default': {'drill': 0.3, 'via': 0.6}}
        nets = {'GND': {'plane': True, 'class': 'Default', 'via': {'hole_size': 0.3, 'via_diameter': 0.6},
                        'power_chains': [{'pads': ['J2.4', 'U3.6'], 'amps': 2.1}, {'pads': ['C1.2', 'U1.1'], 'amps': 0.5}]},
                'VSYS': {'plane': False, 'class': 'Default', 'power_chains': [{'pads': ['J2.1', 'U2.3'], 'amps': 2.1}]}}
        self.assertEqual(model.plane_fanout_vias(nets, classes, 0.018, 20),
                         {'J2.4': (0.35, 0.65, 2.1), 'U3.6': (0.35, 0.65, 2.1)})

    def test_disallow_types(self):
        self.assertEqual(model.disallow_types(['constraint', 'disallow', 'track', 'via']), {'track', 'via'})
        self.assertEqual(model.disallow_types(['constraint', 'disallow', 'pad']), {'pad'})



class RuleValues(unittest.TestCase):
    """A rule value that the router cannot keep stops the model (state unknown), it is not reported as applied.
    KiCad DRC after the route would see the rule, but the search would not have tried to meet it."""

    def compile(self, constraint):
        import subprocess
        import tempfile
        import test_iso_board
        with tempfile.TemporaryDirectory() as d:
            test_iso_board.make_board(d)
            with open(os.path.join(d, 'iso.kicad_dru'), 'w') as fh:
                fh.write('(version 1)\n' + constraint + '\n')
            out = os.path.join(d, 'model.json')
            p = subprocess.run([sys.executable, os.path.join(os.path.dirname(os.path.abspath(__file__)), 'model.py'), d, '--out', out],
                               capture_output=True, text=True)
            with open(out) as fh:
                m = json.load(fh)
        return p.returncode, m

    def assert_stops(self, constraint, why):
        rc, m = self.compile(constraint)
        self.assertEqual(rc, 1)
        self.assertEqual([r['state'] for r in m['rules']], ['unknown'])
        self.assertIn(why, m['rules'][0]['why'])

    def test_width_needs_opt(self):
        self.assert_stops("""(rule "w" (condition "A.NetClass == 'ISO'") (constraint track_width (min 0.8mm)))""", 'no opt')

    def test_width_on_one_layer(self):
        self.assert_stops("""(rule "w" (layer "F.Cu") (condition "A.NetClass == 'ISO'") (constraint track_width (opt 0.4mm)))""", 'F.Cu')

    def test_length_min(self):
        self.assert_stops("""(rule "l" (condition "A.NetClass == 'ISO'") (constraint length (min 20mm) (max 30mm)))""", 'min')

    def test_via_count_min(self):
        self.assert_stops("""(rule "c" (condition "A.NetClass == 'ISO'") (constraint via_count (min 1) (max 3)))""", 'min')

    def test_via_diameter_max(self):
        self.assert_stops("""(rule "v" (condition "A.NetClass == 'ISO'") (constraint via_diameter (min 0.5mm) (max 0.7mm)))""", 'max')

    def test_values_the_router_keeps_are_applied(self):
        rc, m = self.compile("""(rule "w" (condition "A.NetClass == 'ISO'") (constraint track_width (min 0.2mm) (opt 0.3mm) (max 0.4mm)))
(rule "l" (condition "A.NetClass == 'ISO'") (constraint length (max 30mm)))
(rule "c" (condition "A.NetClass == 'ISO'") (constraint via_count (max 3)))
(rule "v" (condition "A.NetClass == 'ISO'") (constraint via_diameter (min 0.5mm)))""")
        self.assertEqual(rc, 0)
        self.assertEqual({r['state'] for r in m['rules']}, {'applied'})
        self.assertEqual(m['nets']['ISO1']['width'], 0.3)

    def test_a_rule_that_reaches_no_net_stops_nothing(self):
        rc, m = self.compile("""(rule "w" (condition "A.NetClass == 'NONE'") (constraint track_width (min 0.8mm)))""")
        self.assertEqual(rc, 0)


class IsolationBoards(unittest.TestCase):
    """model.py on committed isolation boards (isolation work, reports/2026-11-01-isolation.md). Each case failed before:
    the model stopped (MODEL FAIL, unknown creepage / pair selectors) or had no such key."""
    models = {}

    @classmethod
    def model_of(cls, board):
        if board not in cls.models:
            import subprocess
            import tempfile
            out = os.path.join(tempfile.mkdtemp(), 'model.json')
            p = subprocess.run([sys.executable, os.path.join(os.path.dirname(os.path.abspath(__file__)), 'model.py'),
                                os.path.join(model.ROOT, 'hardware-design', 'boards', board), '--out', out], capture_output=True, text=True)
            assert 'MODEL ok' in p.stdout, p.stdout + p.stderr
            with open(out) as fh:
                cls.models[board] = json.load(fh)
        return cls.models[board]

    def test_poe_pair_rules_and_plane_reach(self):
        m = self.model_of('POE-ETHERNET')
        states = {(r['rule'], r['constraint']): r['state'] for r in m['rules']}
        self.assertEqual(states[('PoE isolation', 'creepage')], 'applied')
        self.assertEqual(states[('PoE creepage J1 pin pitch', 'creepage')], 'applied')
        self.assertEqual(m['iso']['max'], 3.0)
        self.assertEqual([r['key'] for r in m['iso']['regions']], ['intersectsCourtyard:J1'])
        # ISO_GND has no plane on this board; the VDD_3V3 In2 zones do not reach J1.11 / J1.13; PHY_GND is a plane
        self.assertFalse(m['nets']['ISO_GND']['plane'])
        self.assertFalse(m['nets']['VDD_3V3']['plane'])
        self.assertTrue(m['nets']['PHY_GND']['plane'] and m['nets']['PHY_GND']['plane_polys'])
        self.assertEqual((m['return_net'], m['return_nets']), ('PHY_GND', ['PHY_GND', 'ISO_GND']))

    def test_return_scope_is_the_gate_rp001_scope(self):
        """RP-001 scope (2026-11-02): the nets the gate's kicad-happy RP-001 never checks (power / ground by name and
        schematic power rails, rpscope.py) need no return via; a signal net still does. Before: no return_scope key."""
        m = self.model_of('POE-ETHERNET')
        skip = m['return_scope']['skip']
        for n in ('VDD_3V3', 'VDD_3V3A', 'PHY_GND', 'ISO_GND', 'PRIMARY_5V'):
            self.assertIn(n, skip)
            self.assertIn(n, m['return_exempt'])
        for n in ('/ETH_CT', '/MOSI', '/SCSn', '/POE_V1N', '/LED_LINK_K'):
            self.assertNotIn(n, skip)
        # the gate's own functions decide (no copied list): kicad-happy sees /1V2O as a rail (nnVn after the sheet path)
        self.assertEqual(model.rp_scope(m['pcb'], ['/1V2O', '/XI', 'VDD_3V3A'])['skip'], ['/1V2O', 'VDD_3V3A'])

    def test_soft_reference_nets_follow_si_planes(self):
        """Gate scope of the reference rule (2026-11-02): a checked net that si_planes.is_fast calls fast stays hard
        (a fast net may cross no gap); every other checked net is soft (the D-124c screen may accept its run)."""
        m = self.model_of('NET-CORE')
        self.assertFalse(m['nets']['/ETH_REF_CLK']['ref_soft'])   # rp001-fast-nets.json
        self.assertTrue(m['nets']['/CH_LED0']['ref_soft'])
        p = self.model_of('POE-ETHERNET')
        self.assertTrue(p['nets']['/ETH_CT']['ref_soft'])

    def test_exempt_area_is_reference_for_its_nets(self):
        """si_planes exempt.areas (2026-11-02): the J1 box is no reference rule for /LED_*_K and /MAG_* (they were walled
        in at J1), and stays one for /ETH_CT (not listed). The box and the fill are one union: no seam at x = 122.5."""
        m = self.model_of('POE-ETHERNET')
        d = m['nets']['/LED_LINK_K']['ref_domain']
        self.assertTrue(d.startswith('PHY_GND+exempt:'))
        self.assertEqual(m['nets']['/MAG_TXP']['ref_domain'], d)
        self.assertEqual(m['nets']['/ETH_CT']['ref_domain'], 'PHY_GND')

        def inside(x, y, polys):
            def odd(ring):
                c = False
                for (ax, ay), (bx, by) in zip(ring, ring[-1:] + ring[:-1]):
                    if (ay > y) != (by > y) and x < (bx - ax) * (y - ay) / (by - ay) + ax:
                        c = not c
                return c
            return any(odd(p[0]) and not any(odd(h) for h in p[1:]) for p in polys)
        doms = m['ref_fill']['layers']['B.Cu']['domains']
        for x in (110.0, 121.0, 122.5, 125.0):
            self.assertTrue(inside(x, 113.0, doms[d]), x)
        self.assertFalse(inside(121.0, 113.0, doms['PHY_GND']))

    def test_relay_parallel_mains_copy(self):
        m = self.model_of('RELAY-4')
        n = m['nets']['/MAINS_COM1']
        self.assertEqual((n['layers'], n['twin']), (['F.Cu'], ['F.Cu', 'B.Cu']))
        # 10 A over two equal copies: each copy carries 5 A (IPC-2221 width of the paths gate, 2 oz, dT 10 K)
        self.assertEqual(n['min_width_layers']['F.Cu'], model.ipc_width(5.0, model.pcbtool.copper_thickness(m['pcb'])['F.Cu'], 10))
        self.assertEqual(max(m['iso']['table']), 9.65)  # 'Mains to screw hole'

    def test_input_barrier_band_keeps_its_hole(self):
        m = self.model_of('INPUT-4D2A')
        band = [k for k in m['keepouts'] if k['name'] == 'BARRIER_BAND'][0]
        self.assertFalse(band['rect'])
        self.assertEqual(len(band['holes']), 1)

    def test_input_reference_fill(self):
        """Plane fill edge (DESIGN 5b, reports/2026-11-02-plane-edge.md): the filled reference per outer layer and
        domain, from KiCad's own fill. The isolation run's /AI1 F.Cu run at (108.12, 104.0) (gate planes, unknown
        driver) lies in the void beside the H1 screw-hole area; (140, 130) lies on the ISO_0V In1 fill and (130, 110) on the
        host-side GND island, not on ISO_0V."""
        m = self.model_of('INPUT-4D2A')
        rf = m['ref_fill']
        self.assertEqual(rf['via_allow'], 0.6)
        self.assertEqual({k: v['plane'] for k, v in rf['layers'].items()}, {'F.Cu': 'In1.Cu', 'B.Cu': 'In2.Cu'})
        self.assertEqual((m['nets']['/AI1']['ref_domain'], m['nets']['ISO_5V']['ref_domain']), ('ISO_0V', 'ISO_0V'))
        self.assertNotIn('ref_domain', m['nets']['ISO_0V'])   # a ground: not a checked net

        def inside(x, y, polys):
            def odd(ring):
                c = False
                for (ax, ay), (bx, by) in zip(ring, ring[-1:] + ring[:-1]):
                    if (ay > y) != (by > y) and x < (bx - ax) * (y - ay) / (by - ay) + ax:
                        c = not c
                return c
            return any(odd(p[0]) and not any(odd(h) for h in p[1:]) for p in polys)
        iso = rf['layers']['F.Cu']['domains']['ISO_0V']
        self.assertFalse(inside(108.12, 104.0, iso))
        self.assertTrue(inside(140.0, 130.0, iso))
        self.assertFalse(inside(130.0, 110.0, iso))
        self.assertTrue(inside(130.0, 110.0, rf['layers']['F.Cu']['domains']['GND']))


class ThermalVias(unittest.TestCase):
    """thermal-vias.json -> pad thermal_vias (model.thermal_via_spec) on the committed FW-IO U4.9 (LM5164 EP, 3.2 x 2.5
    mm at 90 degrees: the long side runs along board y)."""
    @classmethod
    def setUpClass(cls):
        bdir = os.path.join(model.ROOT, 'hardware-design', 'boards', 'FW-IO')
        cfg = model.load_cfg(bdir)
        cls.b = model.pcbnew.LoadBoard(os.path.join(bdir, cfg['project']) + '.kicad_pcb')
        pro = json.load(open(os.path.join(bdir, cfg['project']) + '.kicad_pro'))
        cls.classes = {c['name']: {'via': c.get('via_diameter'), 'drill': c.get('via_drill')} for c in pro['net_settings']['classes']}
        cls.setup = pro['board']['design_settings']['rules']

    def run_spec(self, spec, allow=('U4.9',), hth=0.45):
        import tempfile
        fp = self.b.FindFootprintByReference('U4')
        pad = [p for p in fp.Pads() if p.GetNumber() == '9'][0]
        bb = pad.GetBoundingBox()
        T = model.T
        d = {'ref': 'U4', 'num': '9', 'net': 'GND', 'x': T(pad.GetPosition().x), 'y': T(pad.GetPosition().y), 'drill': 0.0,
             'bbox': [T(bb.GetLeft()), T(bb.GetTop()), T(bb.GetRight()), T(bb.GetBottom())]}
        tmp = tempfile.mkdtemp()
        if spec is not None:
            with open(os.path.join(tmp, 'thermal-vias.json'), 'w') as fh:
                json.dump({'pads': {'U4.9': spec}}, fh)
        n = model.thermal_via_spec(tmp, {('U4', '9'): (fp, pad, d)}, {'GND': {'plane': True, 'class': 'PWR'}}, self.classes,
                                   self.setup, {'hole_to_hole': [{'min': hth, 'scope': 'all'}]}, set(allow))
        return n, d

    SPEC = {'long': 2, 'short': 2, 'pitch_long': 1.27, 'pitch_short': 1.10, 'drill': 0.3, 'diameter': 0.6, 'source': 'LM5164 Fig. 28'}

    def test_array_centred_long_side_along_y(self):
        n, d = self.run_spec(dict(self.SPEC))
        self.assertEqual(n, 4)
        tv = d['thermal_vias']
        self.assertEqual((tv['d'], tv['drill'], tv['source']), (0.6, 0.3, 'LM5164 Fig. 28'))
        xs = sorted({v[0] for v in tv['vias']})
        ys = sorted({v[1] for v in tv['vias']})
        self.assertAlmostEqual(xs[1] - xs[0], 1.10, places=4)   # short side (2.5 mm) along x
        self.assertAlmostEqual(ys[1] - ys[0], 1.27, places=4)   # long side (3.2 mm) along y
        self.assertAlmostEqual(sum(xs) / 2, d['x'], places=4)
        self.assertAlmostEqual(sum(ys) / 2, d['y'], places=4)

    def test_no_file_no_key(self):
        n, d = self.run_spec(None)
        self.assertEqual(n, 0)
        self.assertNotIn('thermal_vias', d)

    def test_refusals(self):
        cases = [({'source': ' '}, 'empty source'), ({'drill': 0.25, 'diameter': 0.55}, 'net class PWR via drill'),
                 ({'pitch_short': 0.7}, 'hole-to-hole'), ({'pitch_long': 3.0}, 'not inside the pad copper'),
                 ({'short': 3}, 'not inside the pad copper')]
        for change, why in cases:
            with self.assertRaises(SystemExit) as e:
                self.run_spec(dict(self.SPEC, **change))
            self.assertIn(why, str(e.exception), change)
        spec = dict(self.SPEC)
        del spec['source']
        with self.assertRaises(SystemExit) as e:
            self.run_spec(spec)
        self.assertIn('missing source', str(e.exception))
        with self.assertRaises(SystemExit) as e:
            self.run_spec(dict(self.SPEC), allow=())
        self.assertIn('viapads.allow', str(e.exception))


if __name__ == '__main__':
    unittest.main()
