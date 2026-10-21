import copy
import unittest

import route_plan as plan

COPPER = ['F.Cu', 'In1.Cu', 'In2.Cu', 'B.Cu']


def config():
    return {
        'schema': 'iot-lab.route.v1',
        'about': 'test board',
        'backend': 'fastroute',
        'layers': ['F.Cu', 'In2.Cu', 'B.Cu'],
        'budget': {'passes': 60, 'time_s': 300, 'threads': 8},
        'stages': [
            {'name': 'mains', 'only_nets': ['/AC_N', '/AC_L'], 'layers': ['B.Cu'], 'passes': 100,
             'remove_zones': ['BARRIER_BAND'],
             'keepouts': [{'name': 'SELV', 'outside': [10, 10, 40, 30]}],
             'require': {'open': 0, 'vias': 0}},
            {'name': 'selv', 'skip_nets': ['GND'], 'plane_nets': ['GND'], 'neck_um': 250,
             'keepouts': [{'name': 'HV', 'inside': [8, 8, 42, 32], 'layers': ['F.Cu', 'B.Cu']}]},
        ],
        'pours': [
            {'name': 'GND_B', 'net': 'GND', 'layer': 'B.Cu', 'shape': 'board', 'priority': 0},
            {'name': 'HI', 'net': '/AC_L', 'layer': 'F.Cu', 'shape': 'around', 'grow_mm': 1.2, 'priority': 2},
        ],
    }


class LoadTests(unittest.TestCase):
    def test_valid_config_gives_normalized_stages(self):
        p = plan.load(config(), COPPER)
        self.assertEqual(p['backend'], 'fastroute')
        mains, selv = p['stages']
        self.assertEqual(mains['layers'], ['B.Cu'])
        self.assertEqual(mains['passes'], 100)
        self.assertEqual(mains['time_s'], 300)
        self.assertEqual(mains['max_vias'], 0)
        # A stage without its own layers or budget takes the board values; open connections default to 0.
        self.assertEqual(selv['layers'], ['F.Cu', 'In2.Cu', 'B.Cu'])
        self.assertEqual(selv['passes'], 60)
        self.assertEqual(selv['require_open'], 0)
        self.assertIsNone(selv['max_vias'])
        self.assertEqual(selv['keepouts'][0]['layers'], ['F.Cu', 'B.Cu'])
        # A keepout without layers blocks every copper layer of the board.
        self.assertEqual(mains['keepouts'][0]['layers'], COPPER)

    def assertRejects(self, cfg, text):
        with self.assertRaises(ValueError) as e:
            plan.load(cfg, COPPER)
        self.assertIn(text, str(e.exception))

    def test_unknown_key_is_rejected(self):
        cfg = config()
        cfg['stages'][0]['only_net'] = ['/AC_N']
        self.assertRejects(cfg, 'unknown key only_net')

    def test_wrong_schema_is_rejected(self):
        cfg = config()
        cfg['schema'] = 'iot-lab.route.v0'
        self.assertRejects(cfg, 'schema')

    def test_unknown_backend_is_rejected(self):
        cfg = config()
        cfg['backend'] = 'freerouting'
        self.assertRejects(cfg, 'backend')

    def test_only_and_skip_nets_together_are_rejected(self):
        cfg = config()
        cfg['stages'][0]['skip_nets'] = ['GND']
        self.assertRejects(cfg, 'only_nets and skip_nets')

    def test_layer_not_on_board_is_rejected(self):
        cfg = config()
        cfg['stages'][1]['layers'] = ['In3.Cu']
        self.assertRejects(cfg, 'In3.Cu')

    def test_duplicate_stage_name_is_rejected(self):
        cfg = config()
        cfg['stages'][1]['name'] = 'mains'
        self.assertRejects(cfg, 'duplicate stage')

    def test_no_stage_is_rejected(self):
        cfg = config()
        cfg['stages'] = []
        self.assertRejects(cfg, 'stages')

    def test_keepout_needs_exactly_one_box(self):
        cfg = config()
        cfg['stages'][0]['keepouts'][0]['inside'] = [1, 1, 2, 2]
        self.assertRejects(cfg, 'exactly one of inside or outside')

    def test_keepout_box_must_have_positive_size(self):
        cfg = config()
        cfg['stages'][0]['keepouts'][0]['outside'] = [40, 10, 10, 30]
        self.assertRejects(cfg, 'x0 < x1')

    def test_around_pour_needs_grow(self):
        cfg = config()
        del cfg['pours'][1]['grow_mm']
        self.assertRejects(cfg, 'grow_mm')

    def test_pour_shape_must_be_known(self):
        cfg = config()
        cfg['pours'][0]['shape'] = 'circle'
        self.assertRejects(cfg, 'shape')

    def test_negative_neck_is_rejected(self):
        cfg = config()
        cfg['stages'][1]['neck_um'] = -1
        self.assertRejects(cfg, 'neck_um')

    def test_boolean_is_not_a_count(self):
        cfg = config()
        cfg['stages'][0]['require']['vias'] = True
        self.assertRejects(cfg, 'vias')

    def test_features_become_the_fastroute_environment(self):
        cfg = config()
        cfg['features'] = {'via_off_small_pads': True, 'triage_opens': False}
        p = plan.load(cfg, COPPER)
        self.assertEqual(plan.feature_env(p), 'triage_opens=0,via_off_small_pads=1')
        self.assertEqual(plan.feature_env(plan.load(config(), COPPER)), '')

    def test_unknown_feature_is_rejected(self):
        cfg = config()
        cfg['features'] = {'via_off_small_pad': True}
        with self.assertRaises(ValueError) as e:
            plan.load(cfg, COPPER, known_features={'via_off_small_pads'})
        self.assertIn('unknown feature via_off_small_pad', str(e.exception))

    def test_feature_must_be_on_or_off(self):
        cfg = config()
        cfg['features'] = {'via_off_small_pads': 'yes'}
        self.assertRejects(cfg, 'features.via_off_small_pads')

    def test_input_is_not_changed(self):
        cfg = config()
        before = copy.deepcopy(cfg)
        plan.load(cfg, COPPER)
        self.assertEqual(cfg, before)


class FastrouteArgsTests(unittest.TestCase):
    def test_only_nets_stage(self):
        mains = plan.load(config(), COPPER)['stages'][0]
        self.assertEqual(plan.fastroute_args(mains), [
            '--layers', 'B.Cu', '--passes', '100', '--max-time', '300', '--threads', '8',
            '--skip-net', '', '--plane-nets', '', '--only-nets', '/AC_N,/AC_L'])

    def test_plane_and_neck_stage(self):
        selv = plan.load(config(), COPPER)['stages'][1]
        self.assertEqual(plan.fastroute_args(selv), [
            '--layers', 'F.Cu,In2.Cu,B.Cu', '--passes', '60', '--max-time', '300', '--threads', '8',
            '--skip-net', 'GND', '--plane-nets', 'GND', '--neck-um', '250'])

    def test_route_planes_unlock_and_via_skip(self):
        cfg = config()
        cfg['stages'][1].update(route_planes=True, unlock_nets=['/A'], via_skip=['U2', 'R7.1'])
        selv = plan.load(cfg, COPPER)['stages'][1]
        args = plan.fastroute_args(selv)
        self.assertIn('--route-planes', args)
        self.assertEqual(args[args.index('--unlock-nets') + 1], '/A')
        self.assertIn('--via-args=--skip U2 R7.1', args)


class TracemakerArgsTests(unittest.TestCase):
    def test_layers_become_no_tracks_on_and_only_nets_go_first(self):
        mains = plan.load(config(), COPPER)['stages'][0]
        args = plan.tracemaker_args(mains, COPPER, 'tm', 'in.kicad_pcb', 'out.kicad_pcb', 'sum.json')
        self.assertEqual(args[:5], ['tm', 'route', 'in.kicad_pcb', '-o', 'out.kicad_pcb'])
        self.assertEqual(args[args.index('--no-tracks-on') + 1], 'F.Cu,In1.Cu,In2.Cu')
        self.assertEqual(args[args.index('--first-nets') + 1], '/AC_N,/AC_L')
        self.assertEqual(args[args.index('--time') + 1], '300')
        self.assertEqual(args[args.index('--json') + 1], 'sum.json')
        self.assertNotIn('--soft-zones', args)

    def test_plane_nets_use_soft_zones_and_all_layers_give_no_layer_flag(self):
        cfg = config()
        cfg['stages'][1]['layers'] = COPPER
        selv = plan.load(cfg, COPPER)['stages'][1]
        args = plan.tracemaker_args(selv, COPPER, 'tm', 'a', 'b', 'c')
        self.assertIn('--soft-zones', args)
        self.assertNotIn('--no-tracks-on', args)
        self.assertNotIn('--first-nets', args)


class KeptNetsTests(unittest.TestCase):
    def test_only_nets_keep_only_those(self):
        mains = plan.load(config(), COPPER)['stages'][0]
        self.assertEqual(plan.kept_nets(mains, ['/AC_N', '/AC_L', 'GND', '/X']), {'/AC_N', '/AC_L'})

    def test_skip_nets_keep_the_rest(self):
        selv = plan.load(config(), COPPER)['stages'][1]
        self.assertEqual(plan.kept_nets(selv, ['/AC_N', 'GND', '/X']), {'/AC_N', '/X'})

    def test_tracemaker_keeps_plane_net_copper_in_place_of_pad_vias(self):
        # GND is skipped and a plane net: Fastroute gives its pads vias; TraceMaker's GND copper does that job.
        selv = plan.load(config(), COPPER)['stages'][1]
        self.assertEqual(plan.tracemaker_kept(selv, ['/AC_N', 'GND', '/X']), {'/AC_N', 'GND', '/X'})
        mains = plan.load(config(), COPPER)['stages'][0]
        self.assertEqual(plan.tracemaker_kept(mains, ['/AC_N', 'GND']), {'/AC_N'})


class StageCheckTests(unittest.TestCase):
    def test_open_connection_on_stage_net_fails(self):
        mains = plan.load(config(), COPPER)['stages'][0]
        self.assertEqual(plan.stage_failures(mains, ['/AC_N', '/OTHER'], 0),
                         ['stage mains: 1 open connections on its nets (limit 0)'])

    def test_vias_over_limit_fail(self):
        mains = plan.load(config(), COPPER)['stages'][0]
        self.assertEqual(plan.stage_failures(mains, [], 2), ['stage mains: 2 vias on its nets (limit 0)'])

    def test_clean_stage_passes(self):
        selv = plan.load(config(), COPPER)['stages'][1]
        self.assertEqual(plan.stage_failures(selv, ['GND'], 40), [])


class OpenNetsTests(unittest.TestCase):
    def item(self, net):
        return {'items': [{'description': f'Pad 1 [{net}] of J1 on F.Cu'}, {'description': f'Pad 2 [{net}] of J2'}]}

    def test_one_net_per_open_connection(self):
        d = {'unconnected_items': [self.item('/AC_N'), self.item('GND'), self.item('GND')]}
        self.assertEqual(sorted(plan.open_nets(d)), ['/AC_N', 'GND', 'GND'])

    def test_capped_list_cannot_be_trusted(self):
        d = {'unconnected_items': [self.item('GND')] * plan.DRC_UNCONNECTED_CAP}
        with self.assertRaises(ValueError):
            plan.open_nets(d)

    def test_item_without_net_is_an_error(self):
        with self.assertRaises(ValueError):
            plan.open_nets({'unconnected_items': [{'items': [{'description': 'Track on F.Cu'}]}]})


BOARD = '''(kicad_pcb
\t(version 20260101)
\t(setup
\t\t(stackup
\t\t\t(layer "F.Cu" (type "copper") (thickness 0.035))
\t\t)
\t)
\t(zone
\t\t(net "GND")
\t\t(name "BARRIER_BAND")
\t\t(polygon (pts (xy 0 0) (xy 1 0) (xy 1 1)))
\t)
\t(zone
\t\t(net "GND")
\t\t(name "GND_B")
\t\t(property "note" "a ) in text")
\t)
\t(zone
\t\t(name "BARRIER_BAND_2")
\t)
)
'''


class TextTests(unittest.TestCase):
    def test_split_removes_named_zones_only(self):
        text, blocks = plan.split_zones(BOARD, ['BARRIER_BAND'])
        self.assertEqual(len(blocks), 1)
        self.assertIn('(name "BARRIER_BAND")', blocks[0])
        self.assertNotIn('(name "BARRIER_BAND")', text)
        self.assertIn('(name "GND_B")', text)
        self.assertIn('(name "BARRIER_BAND_2")', text)

    def test_missing_zone_name_is_an_error(self):
        with self.assertRaises(ValueError):
            plan.split_zones(BOARD, ['NO_SUCH_ZONE'])

    def test_split_then_add_restores_the_zone(self):
        text, blocks = plan.split_zones(BOARD, ['BARRIER_BAND'])
        back = plan.add_blocks(text, blocks)
        self.assertEqual(back.count('(name "BARRIER_BAND")'), 1)
        self.assertTrue(back.rstrip().endswith(')'))
        self.assertEqual(plan.split_zones(back, ['BARRIER_BAND'])[1], blocks)

    def test_copy_block_puts_back_the_source_stackup(self):
        changed = BOARD.replace('(thickness 0.035)', '(thickness 0.07)')
        self.assertIn('(thickness 0.035)', plan.copy_block(BOARD, changed, '(stackup'))
        self.assertNotIn('(thickness 0.07)', plan.copy_block(BOARD, changed, '(stackup'))


if __name__ == '__main__':
    unittest.main()
