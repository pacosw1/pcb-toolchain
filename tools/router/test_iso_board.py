"""Router and kicad-cli DRC agree on a pair clearance and a creepage case (tiny KiCad 10 test board).

Needs KiCad, the pinned KiCad API server (kicad-cli-nightly) and cargo (run.find_or_build). About 30 s.
  python3 -m unittest test_iso_board

Board 40 x 35 mm, F.Cu / B.Cu. ISO1 (class ISO) joins two pads past an OTH1 pad (class OTH) that sits 0.1 mm from the
straight line; ISO2 (class ISO) joins two pads past a DEF1 pad (class Default). DRU: 'G' ISO-OTH clearance 1.5 mm,
'C' ISO-Default creepage 2.0 mm (class clearance 0.2 mm). With the model's pair table the route is DRC-clean (no
clearance, creepage or unconnected item); with the table taken out of the model (the router before the isolation work)
KiCad reports rule G and rule C on the route. So the distances the router keeps are the ones KiCad checks.
"""
import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest
import uuid

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import run  # noqa: E402

DRU = """(version 1)
(rule "G" (condition "A.NetClass == 'ISO' && B.NetClass == 'OTH'") (constraint clearance (min 1.5mm)))
(rule "C" (condition "A.NetClass == 'ISO' && B.NetClass == 'Default'") (constraint creepage (min 2.0mm)))
"""
PADS = [('P1', 'ISO1', 5, 10), ('P2', 'ISO1', 25, 10), ('Q1', 'OTH1', 15, 10.6),
        ('P3', 'ISO2', 5, 25), ('P4', 'ISO2', 25, 25), ('R1', 'DEF1', 15, 25.6)]


def make_board(d, name='iso'):
    U = lambda: str(uuid.uuid4())
    L = ['(kicad_pcb', '(version 20260206)', '(generator "pcbnew")', '(generator_version "10.0")',
         '(general (thickness 1.6) (legacy_teardrops no))', '(paper "A4")',
         '(layers (0 "F.Cu" signal) (2 "B.Cu" signal) (13 "F.Paste" user) (15 "B.Paste" user) (5 "F.SilkS" user "f.silkscreen")'
         ' (7 "B.SilkS" user "b.silkscreen") (1 "F.Mask" user) (3 "B.Mask" user) (25 "Edge.Cuts" user) (27 "Margin" user)'
         ' (31 "F.CrtYd" user "F.Courtyard") (29 "B.CrtYd" user "B.Courtyard") (35 "F.Fab" user) (33 "B.Fab" user))',
         '(setup (pad_to_mask_clearance 0))']
    for ref, net, x, y in PADS:
        L += [f'(footprint "t:{ref}" (layer "F.Cu") (uuid "{U()}") (at {x} {y})',
              f'  (property "Reference" "{ref}" (at 0 0 0) (layer "F.Fab") (uuid "{U()}") (effects (font (size 1 1) (thickness 0.15))))',
              f'  (property "Value" "{ref}" (at 0 0 0) (layer "F.Fab") (hide yes) (uuid "{U()}") (effects (font (size 1 1) (thickness 0.15))))',
              '  (attr smd)',
              f'  (fp_rect (start -0.8 -0.8) (end 0.8 0.8) (stroke (width 0.05) (type solid)) (fill no) (layer "F.CrtYd") (uuid "{U()}"))',
              f'  (pad "1" smd rect (at 0 0) (size 1 1) (layers "F.Cu" "F.Mask") (net "{net}") (uuid "{U()}"))', ')']
    L += [f'(gr_rect (start 0 0) (end 40 35) (stroke (width 0.05) (type default)) (fill no) (layer "Edge.Cuts") (uuid "{U()}"))', ')']
    open(os.path.join(d, name + '.kicad_pcb'), 'w').write('\n'.join(L) + '\n')
    cls = lambda n: {'name': n, 'clearance': 0.2, 'track_width': 0.2, 'via_diameter': 0.6, 'via_drill': 0.3,
                     'priority': 2147483647 if n == 'Default' else 1, 'bus_width': 12, 'diff_pair_gap': 0.25,
                     'diff_pair_via_gap': 0.25, 'diff_pair_width': 0.2, 'line_style': 0, 'microvia_diameter': 0.3,
                     'microvia_drill': 0.1, 'pcb_color': 'rgba(0, 0, 0, 0.000)', 'schematic_color': 'rgba(0, 0, 0, 0.000)', 'wire_width': 6}
    pro = {'board': {'design_settings': {'rules': {'min_clearance': 0.0, 'min_copper_edge_clearance': 0.3, 'min_track_width': 0.15,
                                                    'min_hole_clearance': 0.25, 'min_hole_to_hole': 0.25, 'min_via_diameter': 0.5,
                                                    'min_through_hole_diameter': 0.3, 'min_via_annular_width': 0.1}}},
           'meta': {'filename': name + '.kicad_pro', 'version': 3},
           'net_settings': {'classes': [cls('Default'), cls('ISO'), cls('OTH')], 'meta': {'version': 4},
                            'netclass_patterns': [{'netclass': 'ISO', 'pattern': 'ISO*'}, {'netclass': 'OTH', 'pattern': 'OTH*'}]}}
    json.dump(pro, open(os.path.join(d, name + '.kicad_pro'), 'w'), indent=2)
    open(os.path.join(d, name + '.kicad_dru'), 'w').write(DRU)
    json.dump({'project': name}, open(os.path.join(d, 'gate.pending.json'), 'w'))
    return os.path.join(d, name + '.kicad_pcb')


def drc(pcb, out):
    subprocess.run([run.KICAD_CLI, 'pcb', 'drc', '--format', 'json', '--severity-all', '-o', out, pcb],
                   stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, check=True)
    with open(out) as fh:
        d = json.load(fh)
    v = [(x['type'], x['description']) for x in d.get('violations', []) if x['type'] in ('clearance', 'creepage')]
    return v, len(d.get('unconnected_items', []))


@unittest.skipUnless(os.path.exists(run.KICAD_CLI) and shutil.which('cargo') and shutil.which('kicad-cli-nightly'), 'needs KiCad, its API server and cargo')
class Agreement(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.TemporaryDirectory()
        cls.dir = cls.tmp.name
        cls.pcb = make_board(cls.dir)
        cls.exe = run.find_or_build()[0]
        model = os.path.join(cls.dir, 'model.json')
        p = subprocess.run(run.model_command(cls.exe, cls.dir, cls.pcb, model), capture_output=True, text=True)
        assert 'MODEL ok' in p.stdout, p.stdout + p.stderr
        with open(model) as fh:
            cls.model = json.load(fh)
        bare = dict(cls.model)
        bare.pop('iso')
        with open(os.path.join(cls.dir, 'bare.json'), 'w') as fh:
            json.dump(bare, fh)
        cls.res = {}
        for tag, m in (('iso', model), ('bare', os.path.join(cls.dir, 'bare.json'))):
            route = os.path.join(cls.dir, f'route-{tag}.json')
            subprocess.run([cls.exe, m, route, '--iters', '20'], capture_output=True, text=True, check=True)
            out = os.path.join(cls.dir, 'w-' + tag)
            subprocess.run([cls.exe, 'write', cls.pcb, route, out], capture_output=True, text=True)
            cls.res[tag] = drc(os.path.join(out, 'iso.kicad_pcb'), os.path.join(cls.dir, f'drc-{tag}.json'))

    @classmethod
    def tearDownClass(cls):
        cls.tmp.cleanup()

    def test_model_has_the_pair_rules(self):
        self.assertIn('iso', self.model)
        states = {(r['rule'], r['constraint']): r['state'] for r in self.model['rules']}
        self.assertEqual(states, {('G', 'clearance'): 'applied', ('C', 'creepage'): 'applied'})

    def test_route_with_the_pair_table_is_drc_clean(self):
        v, unc = self.res['iso']
        self.assertEqual((v, unc), ([], 0))

    def test_route_without_the_pair_table_breaks_both_rules(self):
        v, unc = self.res['bare']
        self.assertEqual(unc, 0)
        self.assertTrue(any(t == 'clearance' and "rule 'G'" in d for t, d in v), v)
        self.assertTrue(any(t == 'creepage' and "rule 'C'" in d for t, d in v), v)


if __name__ == '__main__':
    unittest.main()
