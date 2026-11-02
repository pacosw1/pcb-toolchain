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


if __name__ == '__main__':
    unittest.main()
