#!/usr/bin/env python3
"""Pin swap board adapter on a temporary copy of PWR-24V-5V (needs pcbnew: run with the KiCad Python).

U1 pads 3 (/EN) and 4 (/RT) act as plain GPIO inputs in a test pin map; pad 5 (/FB) acts as a fixed AF pin.
"""
import json
import os
import shutil
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

try:
    import pcbnew
    from placer import pinswap_io
except ImportError:  # plain python3 without KiCad
    pcbnew = None

REPO = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
SRC = os.path.join(REPO, 'hardware-design/boards/PWR-24V-5V/cad/PWR-24V-5V')


def pin(number, name, net, function, af=None, typ='FT_h', exti=None, note=''):
    return {'number': number, 'name': name, 'net': net, 'function': function, 'af': af,
            'pin_type': typ, 'exti': exti, 'note': note}


@unittest.skipUnless(pcbnew, 'needs pcbnew (KiCad bundled Python)')
class PinSwapIoTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix='pinswap-test-')
        shutil.copytree(SRC, os.path.join(self.tmp, 'b'))
        self.board = os.path.join(self.tmp, 'b', 'PWR-24V-5V.kicad_pcb')
        self.pins = [pin(3, 'PD3', 'EN', 'GPIO in'), pin(4, 'PD4', 'RT', 'GPIO in'),
                     pin(5, 'PA0', 'FB', 'ADC1_INP16 (additional function)', af='ADC')]
        self.map = os.path.join(self.tmp, 'map.json')
        json.dump({'ref': 'U1', 'pins': self.pins}, open(self.map, 'w'))

    def tearDown(self):
        shutil.rmtree(self.tmp)

    def pad(self, b, number):
        return next(p for p in b.FindFootprintByReference('U1').Pads() if p.GetNumber() == str(number))

    def test_read_pins_takes_slots_and_other_ends_from_the_board(self):
        nets, slots, fixed = pinswap_io.read_pins(self.board, self.map)
        self.assertEqual(sorted(nets), ['/EN', '/RT'])
        self.assertEqual(nets['/EN']['pin'], 3)
        self.assertEqual(nets['/EN']['kind'], 'in')
        self.assertTrue(nets['/EN']['ft'])
        b = pcbnew.LoadBoard(self.board)
        p3 = self.pad(b, 3).GetPosition()
        self.assertAlmostEqual(slots[3]['x'], p3.x / 1e6, 4)
        self.assertAlmostEqual(slots[3]['y'], p3.y / 1e6, 4)
        others = sorted((round(p.GetPosition().x / 1e6, 4), round(p.GetPosition().y / 1e6, 4))
                        for p in b.GetPads() if p.GetNetname() == '/EN' and p.GetParentFootprint().GetReference() != 'U1')
        self.assertEqual(sorted((round(x, 4), round(y, 4)) for x, y in nets['/EN']['ends']), others)
        p5 = self.pad(b, 5).GetPosition()
        self.assertTrue(any(abs(s[0] - p5.x / 1e6) < 1e-4 and abs(s[1] - p5.y / 1e6) < 1e-4 for s in fixed))

    def test_read_pins_fails_closed_when_the_pin_map_does_not_match_the_board(self):
        self.pins[0]['net'] = 'XX'
        json.dump({'ref': 'U1', 'pins': self.pins}, open(self.map, 'w'))
        with self.assertRaises(ValueError):
            pinswap_io.read_pins(self.board, self.map)

    def test_apply_swaps_pad_nets_on_a_copy_and_removes_their_old_copper_only(self):
        diff = [{'net': '/EN', 'from_pin': 3, 'to_pin': 4}, {'net': '/RT', 'from_pin': 4, 'to_pin': 3}]
        out = os.path.join(self.tmp, 'b', 'swapped.kicad_pcb')
        b0 = pcbnew.LoadBoard(self.board)
        gnd0 = sum(1 for t in b0.GetTracks() if t.GetNetname() == 'GND')
        pads0 = [self.pad(b0, 3), self.pad(b0, 4)]
        touch0 = sum(1 for t in b0.GetTracks() if any(pd.HitTest(t.GetStart()) or pd.HitTest(t.GetEnd())
                                                     for pd in pads0 if pd.GetNetname() == t.GetNetname()))
        self.assertGreater(touch0, 0)
        res = pinswap_io.apply(self.board, diff, out)
        b = pcbnew.LoadBoard(out)
        self.assertEqual(self.pad(b, 3).GetNetname(), '/RT')
        self.assertEqual(self.pad(b, 4).GetNetname(), '/EN')
        self.assertEqual(sum(1 for t in b.GetTracks() if t.GetNetname() == 'GND'), gnd0)
        self.assertGreater(res['removed_tracks'], 0)
        for pd in (self.pad(b, 3), self.pad(b, 4)):
            self.assertFalse(any(pd.HitTest(t.GetStart()) or pd.HitTest(t.GetEnd()) for t in b.GetTracks()
                                 if t.GetClass() != 'PCB_VIA' and t.GetNetname() in ('/EN', '/RT')))
        self.assertEqual(self.pad(pcbnew.LoadBoard(self.board), 3).GetNetname(), '/EN')  # source untouched

    def test_cli_apply_takes_the_ref_from_the_pin_map(self):
        from placer import cli
        out = os.path.join(self.tmp, 'b', 'swapped.kicad_pcb')
        cli.main(['pinswap', self.board, self.map, '-o', os.path.join(self.tmp, 'ps.json'), '--apply', out])
        self.assertTrue(os.path.exists(out))


if __name__ == '__main__':
    unittest.main()
