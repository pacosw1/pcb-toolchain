"""Adapter tests; numerical geometry is synthetic, not a board design allowance."""
import copy
import json
import os
import unittest

from pcb_search.contracts import fingerprint
from pcb_search.packing import admit, prepare, propose
from test_pcb_search import PARAMS, placement_problem


def problem():
    p = placement_problem()
    p['cu_nets'] = {'1': ['N', 'Default']}
    for u in p['units']:
        u['cu'] = [[-.1, -.2, .1, .2, 1]]
    return p


def response(pr, prepared):
    return dict(schema='iot-lab.packing-response.v1',
                input_sha256=fingerprint(dict(problem=pr, prepared=prepared)),
                components=[dict(id=u['name'], x=u['x'], y=-u['y'], rotation=0)
                            for i, u in enumerate(pr['units']) if i not in prepared['stationary']],
                backend={'name': 'test-double'})


class PackingAdapterTests(unittest.TestCase):
    def test_round_trip_keeps_fixed_unit_and_rigid_blocks(self):
        p = problem()
        p['units'][1]['refs'] = ['U1', 'C1']
        prepared = prepare(p, rotations=[0, 1])
        self.assertEqual(len(prepared['input']['components']), 2)
        self.assertEqual(prepared['input']['components'][0]['availableRotationDegrees'], [0])
        raw = response(p, prepared)
        raw['components'][1].update(x=7., y=-6., rotation=90)
        result = admit(p, prepared, raw, PARAMS)
        self.assertEqual(result['pose'], [[2., 5., 0], [7., 6., 1]])
        self.assertEqual(result['status'], 'candidate')
        self.assertFalse(result['qualified'])

    def test_missing_duplicate_and_unknown_parts_are_rejected(self):
        p = problem()
        prepared = prepare(p)
        mutations = [lambda r: r['components'].pop(),
                     lambda r: r['components'].append(copy.deepcopy(r['components'][0])),
                     lambda r: r['components'][0].update(id='invented'),
                     lambda r: r.update(input_sha256='0' * 64)]
        for mutate in mutations:
            raw = response(p, prepared)
            mutate(raw)
            with self.assertRaises(ValueError):
                admit(p, prepared, raw, PARAMS)

    def test_backend_fixed_move_and_illegal_geometry_are_screened(self):
        p = problem()
        prepared = prepare(p)
        raw = response(p, prepared)
        raw['components'][0]['x'] = 3.
        self.assertEqual(admit(p, prepared, raw, PARAMS)['status'], 'reject')
        raw = response(p, prepared)
        raw['components'][1]['x'] = 2.
        self.assertIn('overlap', admit(p, prepared, raw, PARAMS)['final']['errors'])
        raw['components'][1]['x'] = float('nan')
        with self.assertRaises(ValueError):
            admit(p, prepared, raw, PARAMS)

    def test_mechanical_fixed_units_survive_without_fake_pad_geometry(self):
        p = problem()
        p['units'][0].pop('cu')
        prepared = prepare(p)
        self.assertEqual(prepared['stationary'], [0])
        self.assertEqual(len(prepared['input']['obstacles']), 1)
        raw = response(p, prepared)
        result = admit(p, prepared, raw, PARAMS)
        self.assertEqual(result['pose'][0], [2., 5., 0])
        p['units'][1].pop('cu')
        with self.assertRaisesRegex(ValueError, 'physical pad'):
            prepare(p)

    def test_round_trip_checks_original_rules_and_restricts_rotation(self):
        p = problem()
        p['units'][0]['rects'][0][4] = 1.2
        prepared = prepare(p)
        self.assertEqual(prepared['input']['minGap'], 1.2)
        raw = response(p, prepared)
        raw['components'][1]['rotation'] = 90
        with self.assertRaisesRegex(ValueError, 'rotation'):
            admit(p, prepared, raw, PARAMS)
        p['dru_ignored'] = ['unrepresented']
        with self.assertRaisesRegex(ValueError, 'unrepresented'):
            prepare(p)

    @unittest.skipUnless(os.environ.get('PCB_PACKING_INTEGRATION') == '1', 'optional pinned Node backend')
    def test_pinned_library_integration_preserves_original_input(self):
        p = problem()
        before = fingerprint(p)
        result = propose(p, budget_s=5, params=PARAMS)
        self.assertEqual(result['status'], 'candidate', json.dumps(result))
        self.assertEqual(result['backend']['version'], '0.0.90')
        self.assertEqual(result['pose'][0], [2., 5., 0])
        self.assertFalse(result['qualified'])
        self.assertEqual(before, fingerprint(p))


if __name__ == '__main__':
    unittest.main()
