"""Actual-model rule coverage and input races; no native or router execution."""
from decimal import Decimal
import hashlib
import json
from pathlib import Path
import tempfile
import unittest
from unittest import mock

import route_rule_coverage as coverage


LED = '/LED_LINK_K'
POE = '/POE_V2N'
MDI = '/ETH_TXP'
CLASSES = {LED: 'Default', POE: 'POE'}
OBSTACLES = [dict(NetName=POE, Type='Pad', Pad_Type='Through-hole'),
             dict(NetName=POE, Type='Track', Pad_Type='')]


def rule(kind='clearance', value='3mm', condition="A.NetClass == 'POE' && B.NetClass != 'POE'"):
    return '(version 1)\n(rule "PoE isolation" (condition "' + condition + '") (constraint ' + kind + ' (min ' + value + ')))'


def dsn(clearance='200', *, mask=None, extra='', pairs='', unit='um'):
    circuit = '(circuit (use_layer ' + ' '.join(mask) + '))' if mask else ''
    return '''(pcb "coverage-fixture"
      (parser (string_quote ")) (resolution um 10) (unit UNIT)
      (structure (layer "F.Cu" (type signal)) (layer "B.Cu" (type signal))
        (rule (width 200) (clearance CLEARANCE)) EXTRA)
      (network (net "LED" (pins R10-1)) (net "POE" (pins J1-10))
        (class "DEFAULT" "LED" CIRCUIT (rule (clearance CLEARANCE)))
        (class "POE" "POE" (rule (clearance CLEARANCE))) PAIRS))'''.replace(
            'UNIT', unit).replace('CLEARANCE', clearance).replace('EXTRA', extra).replace(
            'CIRCUIT', circuit).replace('PAIRS', pairs).replace('"LED"', '"'+LED+'"').replace('"POE"', '"'+POE+'"')


def native():
    return '''(kicad_pcb (version 20260101)
      (layers (0 "F.Cu" signal) (31 "B.Cu" signal))
      (footprint "Fixture:Resistor" (layer "F.Cu") (at 10 10 180) (uuid "R10")
        (property "Reference" "R10") (property "Value" "1k")
        (pad "1" smd rect (at -1 0 180) (size 1 1) (layers "F.Cu" "F.Mask") (net "/LED_LINK_K") (uuid "R10-1"))
        (pad "2" smd rect (at 1 0 180) (size 1 1) (layers "F.Cu" "F.Mask") (net "/POE_V2N") (uuid "R10-2"))))'''


def project(*, rules=None, realistic=False):
    # Explicit authored protocol fixture values, never defaults for real CAD.
    values = {name: 0 for name in coverage.route_project_coverage.REQUIRED}
    if realistic:
        values.update(min_clearance=0, min_track_width=0.15,
            min_copper_edge_clearance=0.5, min_hole_clearance=0.25,
            min_hole_to_hole=0.25, min_microvia_diameter=0.2,
            min_microvia_drill=0.1, min_through_hole_diameter=0.2,
            min_via_annular_width=0.1, min_via_diameter=0.45,
            min_connection=0, min_resolved_spokes=2, min_silk_clearance=0,
            min_text_height=0.8, min_text_thickness=0.08,
            solder_mask_to_copper_clearance=0, max_error=0.005,
            min_groove_width=0, use_height_for_length_calcs=True)
    values.update(rules or {})
    return dict(board=dict(design_settings=dict(rules=values)), net_settings=dict(classes=[
        dict(name='Default', clearance=0.2), dict(name='POE', clearance=0.2)]))


class CoverageTests(unittest.TestCase):
    def inspect(self, rules=None, model=None, **kwargs):
        return coverage.inspect(rule() if rules is None else rules, dsn() if model is None else model,
            active_nets=kwargs.pop('active_nets', [LED]),
            net_classes=kwargs.pop('net_classes', CLASSES),
            obstacles=kwargs.pop('obstacles', OBSTACLES),
            layers=kwargs.pop('layers', ['F.Cu', 'B.Cu']), **kwargs)

    def assert_blocked(self, result):
        self.assertEqual(result['status'], 'blocked', result)
        self.assertFalse(result['solver_launch_allowed'], result)
        self.assertFalse(result['qualified'])
        self.assertTrue(result.get('cause'))

    def assert_passed(self, result):
        self.assertEqual(result['status'], 'passed', result)
        self.assertTrue(result['solver_launch_allowed'], result)
        self.assertFalse(result['qualified'])

    def test_exported_point_two_mm_does_not_cover_three_mm_native_clearance(self):
        result = self.inspect()
        self.assert_blocked(result)
        rows = [row for row in result['requirements'] if row['constraint'] == 'clearance']
        self.assertTrue(rows)
        self.assertEqual(rows[0]['disposition'], 'weaker_than_native')
        self.assertEqual(Decimal(rows[0]['required_mm']), Decimal('3'))
        self.assertEqual(Decimal(rows[0]['model_floor_mm']), Decimal('0.2'))
        self.assertEqual(rows[0]['witness'], dict(active=LED, obstacle=POE))

    def test_every_actual_dsn_clearance_at_native_minimum_is_covered(self):
        for floor in ('3000', '4000'):
            with self.subTest(floor=floor):
                result = self.inspect(model=dsn(floor))
                self.assert_passed(result)
                self.assertEqual(result['requirements'][0]['disposition'], 'covered')

    def test_compiler_style_class_pair_does_not_prove_creepage(self):
        pairs = '(class_class (classes "DEFAULT" "'+POE+'") (rule (clearance 3000)))'
        result = self.inspect(rule('creepage'), dsn('3000', pairs=pairs))
        self.assert_blocked(result)
        self.assertEqual(result['requirements'][0]['disposition'], 'unsupported')
        self.assertIn('no proven enforcement', result['requirements'][0]['reason'])

    def test_spatial_clearance_selector_remains_unsupported_even_with_strong_dsn(self):
        condition = "A.NetClass == 'POE' && B.NetClass != 'POE' && A.intersectsCourtyard('J1') && B.intersectsCourtyard('J1')"
        result = self.inspect(rule(value='1.25mm', condition=condition), dsn('3000'))
        self.assert_blocked(result)
        self.assertEqual(result['requirements'][0]['disposition'], 'unsupported')

    def test_unrelated_mdi_unary_rules_do_not_block_new_led_tracks(self):
        rules = '''(version 1) (rule "MDI"
          (condition "A.inDiffPair('/ETH_TX')")
          (constraint track_width (min 0.2mm)) (constraint length (max 25mm))
          (constraint diff_pair_gap (min 0.18mm)) (constraint via_count (max 0)))'''
        model = dsn()
        model = model[:-2] + '(class "MDI" "'+MDI+'" (rule (clearance 200)))' + '))'
        classes = dict(CLASSES, **{MDI: 'MDI'})
        obstacles = OBSTACLES + [dict(NetName=MDI, Type='Track', Pad_Type=''),
                                  dict(NetName=MDI, Type='Pad', Pad_Type='SMD')]
        result = self.inspect(rules, model, net_classes=classes, obstacles=obstacles)
        self.assert_passed(result)
        self.assertTrue(all(row['disposition'] == 'not_applicable' for row in result['requirements']))

    def test_led_to_retained_poe_requirements_are_relevant_in_either_orientation(self):
        for condition in ("A.NetClass == 'POE' && B.NetClass != 'POE'",
                          "B.NetClass == 'POE' && A.NetClass != 'POE'",
                          "A.NetName == '/POE_*' && B.NetName == '/LED_*'"):
            with self.subTest(condition=condition):
                result = self.inspect(rule(condition=condition))
                self.assert_blocked(result)
                self.assertEqual(result['requirements'][0]['disposition'], 'weaker_than_native')

    def test_quoted_net_operator_characters_remain_literal_and_relevant(self):
        for active in ('/ALERT!', '/ALERT&&READY', '/ALERT||READY'):
            with self.subTest(net=active):
                condition = "A.NetName == '"+active+"' && B.NetClass == 'POE'"
                model = dsn().replace('"'+LED+'"', '"'+active+'"')
                result = self.inspect(rule(condition=condition), model,
                    active_nets=[active], net_classes={active: 'Default', POE: 'POE'})
                self.assert_blocked(result)
                row = result['requirements'][0]
                self.assertEqual(row['disposition'], 'weaker_than_native')
                self.assertEqual(row['witness'], dict(active=active, obstacle=POE))
                self.assertEqual(Decimal(row['required_mm']), Decimal('3'))
                self.assertEqual(Decimal(row['model_floor_mm']), Decimal('0.2'))

    def test_unknown_or_malformed_native_selectors_and_bounds_fail_closed(self):
        selectors = ["A.UnknownProperty == 'POE'", "A.unknownFunction('J1')", "A.NetClass ==",
                     "A.NetClass == 'POE' && unbound_name"]
        for condition in selectors:
            with self.subTest(condition=condition):self.assert_blocked(self.inspect(rule(condition=condition), dsn('3000')))
        for value in ('nan', 'inf', '-1mm', '3cm', '3e999mm', 'unknown'):
            with self.subTest(value=value):self.assert_blocked(self.inspect(rule(value=value), dsn('3000')))
        for bad in (rule()[:-1], '(version 2)', '(rule "unterminated)',
                    '(version 1) (rule "x" (constraint clearance (min 3mm)) (unrecognized 1))'):
            with self.subTest(document=bad):self.assert_blocked(self.inspect(bad, dsn('3000')))

    def test_unknown_or_ambiguous_dsn_units_numbers_and_membership_fail_closed(self):
        models = [dsn('nan'), dsn('-1'), dsn('3cm'), dsn('3000', unit='unknown'),
                  dsn('3000').replace('(unit um)', '(unit um) (unit mm)'),
                  dsn('3000').replace('(clearance 3000)', '(clearance)', 1),
                  dsn('3000').replace('(class "DEFAULT"', '(class "DEFAULT" "'+POE+'"'),
                  dsn('3000').replace('(class "'+POE+'"', '(class "DEFAULT"')]
        # Remove actual class membership without changing the net declaration.
        models.append(dsn('3000').replace('(class "DEFAULT" "'+LED+'"', '(class "DEFAULT"'))
        for index, model in enumerate(models):
            with self.subTest(model=index):self.assert_blocked(self.inspect(model=model))
        for classes, obstacles in (({POE: 'POE'}, OBSTACLES),
                                   (dict(CLASSES, **{'/unmodeled': 'Default'}), OBSTACLES),
                                   (CLASSES, [dict(NetName='/unknown', Type='Pad')])):
            with self.subTest(classes=classes, obstacles=obstacles):
                self.assert_blocked(self.inspect(net_classes=classes, obstacles=obstacles))

    def test_class_pair_does_not_hide_weaker_global_or_class_clearance(self):
        pair = '(class_class (classes "DEFAULT" "'+POE+'") (rule (clearance 3000)))'
        self.assert_blocked(self.inspect(model=dsn('200', pairs=pair)))
        mixed = dsn('3000', pairs=pair)
        mixed = mixed.replace('(rule (clearance 3000)))', '(rule (clearance 200)))', 1)
        self.assert_blocked(self.inspect(model=mixed))

    def test_backend_resolution_unit_cannot_disagree_with_the_coverage_unit(self):
        for declaration in ('', '(resolution mm 10)', '(resolution um 0)',
                '(resolution um nan)', '(resolution um -1)', '(resolution um 2147483648)',
                '(resolution um 10) (resolution um 100)'):
            with self.subTest(resolution=declaration):
                self.assert_blocked(self.inspect(model=dsn('3000').replace('(resolution um 10)', declaration)))
        self.assert_passed(self.inspect(model=dsn('3', unit='mm').replace('(resolution um 10)', '(resolution mm 10)')))

    def test_typed_or_nested_weak_track_via_rules_cannot_fool_coverage(self):
        for extra in ('(rule (clearance 200 (type wire_wire)))',
                      '(rule (clearance 200 (type via_pin)))',
                      '(region "local" (rule (clearance 200)))',
                      '(unrecognized (nested (rule (clearance 200))))',
                      '(rule (clearance nan (type via_pin)))'):
            with self.subTest(extra=extra):self.assert_blocked(self.inspect(model=dsn('3000', extra=extra)))

    def test_exported_pad_only_clearance_exceptions_do_not_weaken_new_tracks(self):
        for kind in ('smd_smd', 'pin_pin', 'pin_smd'):
            with self.subTest(kind=kind):
                self.assert_passed(self.inspect(model=dsn('3000', extra='(rule (clearance 50 (type '+kind+')))')))

    def test_pads_only_prohibition_is_immutable_under_source_guard(self):
        rules = '''(version 1) (rule "fixed pad keepout"
          (condition "A.Type == 'Pad' && A.intersectsArea('H3_KEEPOUT')")
          (constraint disallow pad))'''
        result = self.inspect(rules)
        self.assert_passed(result)
        self.assertEqual(result['requirements'][0]['disposition'], 'immutable_unchanged')

    def test_exact_inactive_layer_is_irrelevant_but_active_unknown_and_wildcard_layers_block(self):
        for layer, passed in (('B.Cu', True), ('F.Cu', False), ('In1.Cu', False), ('*.Cu', False)):
            rules = '(version 1) (rule "no tracks" (layer "'+layer+'") (condition "A.Type == \'Track\'") (constraint disallow track))'
            result = self.inspect(rules, dsn(mask=['F.Cu']), layers=['F.Cu'])
            with self.subTest(layer=layer):
                (self.assert_passed if passed else self.assert_blocked)(result)
        rule_text = '(version 1) (rule "inner" (layer "B.Cu") (constraint disallow track))'
        self.assert_blocked(self.inspect(rule_text, dsn(mask=['F.Cu', 'B.Cu'])))

    def test_silkscreen_rules_are_immutable_while_copper_clearance_still_blocks(self):
        silk = '(rule "silk" (condition "A.memberOfFootprint(\'J1\') && B.Layer == \'Edge.Cuts\'") (constraint silk_clearance (min -10mm)))'
        result = self.inspect('(version 1) '+silk, dsn(mask=['F.Cu']), layers=['F.Cu'])
        self.assert_passed(result)
        self.assertEqual(result['requirements'][0]['disposition'], 'immutable_unchanged')
        self.assert_blocked(self.inspect(rule()+' '+silk))
        # New vias can touch silk; the exact final native DRC decides that rule.
        pending = self.inspect('(version 1) (rule "silk to mask" (constraint silk_clearance (min 1mm)))')
        self.assert_pending(pending, dict(rule='silk to mask', constraint='silk_clearance',
            enforcement='native-drc', drc_types=['silk_overlap', 'silk_over_copper']))

    def assert_pending(self, result, obligation):
        self.assertEqual(result['status'], 'pending_native', result)
        self.assertTrue(result['solver_launch_allowed'], result)
        self.assertFalse(result['qualified'])
        rows = [r for r in result['requirements'] if r['disposition'] == 'native_postcondition']
        self.assertIn(obligation, [r['native_obligation'] for r in rows])

    def test_new_via_hole_rules_are_native_obligations_but_track_only_proof_is_kept(self):
        either = "A.Pad_Type == 'Through-hole' || B.Pad_Type == 'Through-hole'"
        self.assert_pending(self.inspect(rule('hole_clearance', '0.28mm', either)), dict(rule='PoE isolation',
            constraint='hole_clearance', required_mm='0.28', enforcement='native-drc', drc_types=['hole_clearance']))
        self.assert_pending(self.inspect(rule('hole_to_hole', '0.45mm', 'True')), dict(rule='PoE isolation',
            constraint='hole_to_hole', required_mm='0.45', enforcement='native-drc', drc_types=['hole_to_hole', 'holes_co_located']))
        # PTH-to-PTH only: the new via has no pad type, so the rule cannot apply.
        both = "A.Pad_Type == 'Through-hole' && B.Pad_Type == 'Through-hole'"
        self.assert_passed(self.inspect(rule('hole_to_hole', '0.45mm', both)))
        # One layer: no new via, so the old exact track proof is still the only route.
        self.assert_blocked(self.inspect(rule('hole_clearance', '0.28mm', either), dsn(mask=['F.Cu']), layers=['F.Cu']))
        self.assert_blocked(self.inspect(rule('hole_clearance', '0.28mm (max 1mm)', either)))

    def test_reference_stitching_requires_actual_single_layer_active_net_mask(self):
        # The configured gate runs RP-001 on the final board; admission records it as a typed gate obligation.
        gate = dict(rule='configured kicad_happy RP-001', constraint='reference_stitching',
                    enforcement='configured-gate', nets=[LED])
        self.assert_pending(self.inspect('', dsn(), require_stitching=True), gate)
        self.assert_pending(self.inspect('', dsn(mask=['F.Cu', 'B.Cu']), require_stitching=True), gate)
        passed = self.inspect('', dsn(mask=['F.Cu']), require_stitching=True)
        self.assert_passed(passed)
        self.assertEqual(passed['requirements'][0]['disposition'], 'covered')
        self.assert_blocked(self.inspect('', dsn(mask=['Unknown.Cu']), require_stitching=True))

    def test_requested_single_layer_does_not_replace_actual_dsn_active_net_mask(self):
        self.assert_blocked(self.inspect('', dsn(), layers=['F.Cu'], require_stitching=True))
        self.assert_passed(self.inspect('', dsn(mask=['F.Cu']), layers=['F.Cu'], require_stitching=True))

    def test_actual_dsn_layer_declarations_must_support_requested_active_mask(self):
        model = dsn(mask=['F.Cu'])
        front = '(layer "F.Cu" (type signal))'
        for label, changed in (
                ('missing', model.replace(front, '')),
                ('unknown_type', model.replace(front, '(layer "F.Cu" (type unknown))')),
                ('duplicate', model.replace(front, front+' '+front))):
            with self.subTest(change=label):
                self.assert_blocked(self.inspect('', changed, layers=['F.Cu'], require_stitching=True))

    def test_hole_proof_rejection_is_retained_and_cannot_admit_the_solver(self):
        rules = rule('hole_clearance', '0.28mm', "A.Pad_Type == 'Through-hole' || B.Pad_Type == 'Through-hole'")
        for pads in (None, [], [dict(net=POE)]):
            with self.subTest(pads=pads), mock.patch.object(coverage.route_hole_coverage, 'inspect',
                    return_value=dict(status='blocked', cause='fixture containment rejected')) as proof:
                result = self.inspect(rules, dsn(mask=['F.Cu']), layers=['F.Cu'], native_pads=pads)
                self.assert_blocked(result)
                row = result['requirements'][0]
                self.assertEqual(row['disposition'], 'unsupported')
                if pads:
                    self.assertEqual(row['reason'], 'fixture containment rejected')
                    proof.assert_called_once()
                else:
                    proof.assert_not_called()

    def test_custom_pth_selector_checks_every_active_net_before_using_the_pth_subset(self):
        later = '/ZZ_AFTER'
        model = dsn(mask=['F.Cu']).replace('(network ', '(network (net "'+later+'" (pins R9-1)) ', 1)
        model = model.replace('(class "DEFAULT" "'+LED+'"', '(class "DEFAULT" "'+LED+'" "'+later+'"', 1)
        classes = dict(CLASSES, **{later: 'Default', '': 'Default'})
        obstacles = OBSTACLES + [dict(NetName='', Type='Pad', Pad_Type='NPTH, mechanical')]
        first = "(A.NetName == '"+LED+"' && B.Pad_Type == 'Through-hole')"
        later_cases = {
            'unresolved': "(A.NetName == '"+later+"' && B.Pad_Type == 'Through-hole' && B.intersectsArea('critical'))",
            'broader': "(A.NetName == '"+later+"' && B.Pad_Type == 'NPTH, mechanical')",
        }
        for label, extra in later_cases.items():
            with self.subTest(later_selector=label), mock.patch.object(coverage.route_hole_coverage, 'inspect',
                    return_value=dict(status='covered')) as geometry:
                result = self.inspect(rule('hole_clearance', '0.28mm', first+' || '+extra), model,
                    active_nets=[LED, later], net_classes=classes, obstacles=obstacles,
                    layers=['F.Cu'], native_pads=[dict(net=POE)])
                self.assert_blocked(result)
                geometry.assert_not_called()
                row = result['requirements'][0]
                self.assertIn('selector applicability' if label=='unresolved' else 'PTH geometry and tracks only', row['reason'])


class FileCoverageTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(); self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.board = self.root/'source.kicad_pcb'; self.board.write_text(native())
        self.base = self.root/'base.kicad_pcb'; self.base.write_text(native())
        self.rules = self.board.with_suffix('.kicad_dru'); self.rules.write_text(rule())
        self.base_rules = self.base.with_suffix('.kicad_dru'); self.base_rules.write_bytes(self.rules.read_bytes())
        self.project = self.board.with_suffix('.kicad_pro'); self.project.write_text(json.dumps(project()))
        self.base_project = self.base.with_suffix('.kicad_pro'); self.base_project.write_bytes(self.project.read_bytes())
        self.model = self.root/'board.dsn'; self.model.write_text(dsn('3000'))
        self.gate = self.root/'gate.json'; self.gate.write_text(json.dumps(dict(checks=dict(drc=True))))

    def check(self):
        return coverage.check_files(self.board, self.base, self.model, active_nets=[LED],
            net_classes=CLASSES, obstacles=OBSTACLES, layers=['F.Cu', 'B.Cu'], gate=self.gate)

    def test_receipt_binds_original_base_rules_project_gate_and_exact_dsn(self):
        result = self.check()
        self.assertEqual(result['status'], 'passed', result)
        for path in (self.board, self.base, self.rules, self.base_rules, self.project, self.base_project, self.model, self.gate,
                     Path(coverage.__file__).resolve(), Path(coverage.route_features.__file__).resolve()):
            self.assertEqual(result['inputs'][str(path)], hashlib.sha256(path.read_bytes()).hexdigest())
        self.assertEqual(result['dsn'], dict(path=str(self.model), sha256=result['inputs'][str(self.model)]))
        self.assertFalse(result['qualified'])

    def test_pads_only_disposition_cannot_hide_moved_or_changed_base_footprints(self):
        self.rules.write_text('(version 1) (rule "pads fixed" (constraint disallow pad))')
        self.base_rules.write_bytes(self.rules.read_bytes())
        for label, text in (('pose', native().replace('(at 10 10 180)', '(at 11 10 180)')),
                            ('pad', native().replace('(size 1 1)', '(size 2 1)', 1)),
                            ('net', native().replace('(net "/LED_LINK_K")', '(net "/OTHER")', 1))):
            with self.subTest(change=label):
                self.base.write_text(text)
                with self.assertRaises(ValueError):self.check()

    def test_input_changed_during_admission_is_blocked_even_when_decision_was_passed(self):
        original = coverage.inspect
        for path in (self.board, self.base, self.rules, self.base_rules, self.project, self.base_project, self.model, self.gate):
            before = path.read_bytes()
            def mutate(*args, **kwargs):
                result = original(*args, **kwargs)
                path.write_bytes(before+b'\n')
                return result
            with self.subTest(path=path.name), mock.patch.object(coverage, 'inspect', side_effect=mutate):
                result = self.check()
                self.assertEqual(result['status'], 'blocked', result)
                self.assertFalse(result['solver_launch_allowed'])
                self.assertIn('changed', result['cause'])
            path.write_bytes(before)

    def test_changed_dsn_is_reinterpreted_and_gate_stitching_is_not_ignored(self):
        self.model.write_text(dsn('200'))
        self.assertEqual(self.check()['status'], 'blocked')
        self.rules.write_text('(version 1)')
        self.base_rules.write_bytes(self.rules.read_bytes())
        self.gate.write_text(json.dumps(dict(checks=dict(drc=True, kicad_happy=True))))
        pending = self.check()
        self.assertEqual(pending['status'], 'pending_native', pending)
        self.assertEqual([o['enforcement'] for o in pending['native_postconditions']], ['configured-gate'])
        self.model.write_text(dsn('200', mask=['F.Cu']))
        self.assertEqual(self.check()['status'], 'passed')

    def test_unknown_native_hole_geometry_cannot_be_silently_omitted(self):
        with mock.patch.object(coverage.route_hole_coverage, 'native_pth_pads',
                side_effect=ValueError('unsupported offset drill')):
            unrelated = self.check()
            self.assertEqual(unrelated['status'], 'passed', unrelated)
            self.assertEqual(unrelated['native_pth_geometry_unknown'], 'unsupported offset drill')
            self.rules.write_text(rule('hole_clearance', '0.28mm',
                "A.Pad_Type == 'Through-hole' || B.Pad_Type == 'Through-hole'"))
            self.base_rules.write_bytes(self.rules.read_bytes())
            # Tracks only: with new vias the exact final native DRC decides this rule instead.
            self.model.write_text(dsn('3000', mask=['F.Cu']))
            relevant = self.check()
            self.assertEqual(relevant['status'], 'blocked', relevant)
            self.assertFalse(relevant['solver_launch_allowed'])
            self.assertEqual(relevant['requirements'][0]['disposition'], 'unsupported')
            self.assertEqual(relevant['native_pth_geometry_unknown'], 'unsupported offset drill')

    def test_malformed_custom_rules_keep_the_blocked_receipts_source_bindings(self):
        self.rules.write_text('(rule "unterminated)')
        self.base_rules.write_bytes(self.rules.read_bytes())
        result=self.check()
        self.assertEqual(result['status'],'blocked',result)
        self.assertFalse(result['solver_launch_allowed'])
        self.assertEqual(result['inputs'][str(self.rules)],hashlib.sha256(self.rules.read_bytes()).hexdigest())


class ProjectCoverageTests(unittest.TestCase):
    def setUp(self):
        FileCoverageTests.setUp(self)
        self.rules.unlink()
        self.base_rules.unlink()
        self.authored = project(realistic=True)
        self.save_project()
        self.model.write_text(self.single_layer_model())
        self.router = self.root / 'router'
        self.router.write_bytes(b'attributed backend fixture; never executed')
        self.command = [str(self.router), '-de', str(self.model), '-do', str(self.root/'routed.ses'),
            '-mp', '40', '--router.min_trace_width_um=150', '--router.copper_to_edge_clearance_um=500',
            '--report='+str(self.root/'report.json'), '--diagnose', '--max-time=30',
            '--router.optimizer.enabled=false', '--router.autorouter.max_threads=1',
            '--router.optimizer.max_threads=1']

    def save_project(self):
        self.project.write_text(json.dumps(self.authored))
        self.base_project.write_bytes(self.project.read_bytes())

    def single_layer_model(self, clearance='200'):
        # Match actual restrict_dsn output: non-routing copper is power type,
        # in addition to the active net's explicit one-layer mask.
        text=dsn(clearance,mask=['F.Cu']).replace('(layer "B.Cu" (type signal))','(layer "B.Cu" (type power))')
        return text[:-1]+' (library) (placement))'

    def write_native(self, text):
        self.board.write_text(text)
        self.base.write_text(text)

    def check(self, command='default', backend_policy=None, native_thermal_capability=None):
        return coverage.check_files(self.board, self.base, self.model, active_nets=[LED],
            net_classes=CLASSES, obstacles=OBSTACLES, layers=['F.Cu'], gate=self.gate,
            backend_command=self.command if command == 'default' else command,backend_policy=backend_policy,
            native_thermal_capability=native_thermal_capability)

    def row(self, result, name):
        return next(r for r in result['requirements'] if r['rule']=='native project' and r['constraint']==name)

    def test_actual_project_minima_without_dru_are_bound_to_model_and_final_argv(self):
        result = self.check()
        self.assertEqual(result['status'], 'passed', result)
        self.assertIsNone(result['inputs'][str(self.rules)])
        self.assertEqual(result['backend_command'], self.command)
        self.assertEqual(result['backend_command_sha256'], hashlib.sha256(json.dumps(self.command,
            separators=(',', ':'), ensure_ascii=True).encode()).hexdigest())
        self.assertEqual(result['inputs'][str(self.router)], hashlib.sha256(self.router.read_bytes()).hexdigest())
        for key, expected in [('min_track_width','0.15'), ('min_copper_edge_clearance','0.5')]:
            item = self.row(result,key)
            self.assertEqual(item['disposition'],'covered')
            self.assertEqual(Decimal(item['required_mm']),Decimal(expected))
            self.assertEqual(Decimal(item['model_floor_mm']),Decimal(expected))
            self.assertEqual(item['source'],dict(path=str(self.project),pointer='/board/design_settings/rules/'+key,exists=True))
        self.assertEqual(self.row(result,'min_resolved_spokes')['disposition'],'not_applicable')

    def test_missing_malformed_unresolved_and_untyped_project_rules_fail_closed(self):
        original = self.project.read_bytes()
        documents = ['{}', '[]', '{', '{"board":{},"board":{}}',
            json.dumps(project(rules={'min_track_width':True},realistic=True)),
            json.dumps(project(rules={'min_track_width':'0.15'},realistic=True)),
            json.dumps(project(rules={'min_track_width':-0.15},realistic=True)),
            json.dumps(project(rules={'min_track_width':float('nan')},realistic=True)),
            json.dumps(project(rules={'min_track_width':float('inf')},realistic=True))]
        del self.authored['board']['design_settings']['rules']['min_hole_clearance']
        documents.append(json.dumps(self.authored))
        for text in documents:
            with self.subTest(project=text[:80]):
                self.project.write_text(text);self.base_project.write_text(text)
                result = self.check()
                self.assertEqual(result['status'],'blocked',result)
                self.assertFalse(result['solver_launch_allowed'])
        self.project.write_bytes(original);self.base_project.write_bytes(original)
        self.project.unlink();self.base_project.unlink()
        result=self.check()
        self.assertEqual(result['status'],'blocked',result)
        self.assertIsNone(result['inputs'][str(self.project)])
        self.assertIn('missing',self.row(result,'project_document')['reason'])

    def test_unknown_project_keys_and_positive_unproved_constraints_do_not_disappear(self):
        for name,value in [('future_constraint',0),('min_connection',0.1),
                ('solder_mask_to_copper_clearance',0.1),('min_resolved_spokes',2.5)]:
            with self.subTest(name=name):
                self.authored=project(realistic=True,rules={name:value});self.save_project()
                result=self.check()
                self.assertEqual(result['status'],'blocked',result)
                self.assertEqual(self.row(result,name)['disposition'],'unsupported')

    def test_project_clearance_and_only_relevant_netclasses_compare_actual_dsn(self):
        self.authored['net_settings']['classes'].append(dict(name='unused',clearance=100))
        self.save_project()
        self.assertEqual(self.check()['status'],'passed')
        for key in ('global','active','retained'):
            with self.subTest(scope=key):
                self.authored=project(realistic=True)
                if key=='global':self.authored['board']['design_settings']['rules']['min_clearance']=0.25
                else:self.authored['net_settings']['classes'][0 if key=='active' else 1]['clearance']=0.25
                self.save_project()
                result=self.check()
                self.assertEqual(result['status'],'blocked',result)
                self.assertTrue(any(r['disposition']=='weaker_than_native' and Decimal(r['required_mm'])==Decimal('.25')
                    for r in result['requirements']))
        self.model.write_text(self.single_layer_model('250'))
        self.assertEqual(self.check()['status'],'passed')
        self.authored['net_settings']['classes'].pop()
        self.save_project()
        self.assertEqual(self.check()['status'],'blocked')

    def test_width_edge_missing_weaker_duplicated_unknown_and_neck_overrides_block(self):
        changes=[None,[],[True],self.command[:-1]+['--config=unknown.json'],
            [v for v in self.command if not v.startswith('--router.min_trace_width_um=')],
            [v.replace('width_um=150','width_um=149') for v in self.command],
            [v.replace('clearance_um=500','clearance_um=499') for v in self.command],
            self.command+['--router.min_trace_width_um=151'],
            self.command+['--router.copper_to_edge_clearance_um=501'],
            self.command+['--router.neck_width_um=149'],
            self.command+['--router.neck_width_um=150','--router.neck_width_um=150'],
            [v.replace('width_um=150','width_um=nan') for v in self.command],
            [v.replace(str(self.model),str(self.root/'other.dsn')) for v in self.command]]
        for command in changes:
            with self.subTest(command=command):
                result=self.check(command)
                self.assertEqual(result['status'],'blocked',result)
                self.assertFalse(result['solver_launch_allowed'])
                json.dumps(result,allow_nan=False)
        self.assertEqual(self.check(self.command+['--router.neck_width_um=150'])['status'],'passed')

    def test_absent_dru_does_not_skip_native_slotted_pth_hole_requirement(self):
        slot='''(footprint "USB" (layer "F.Cu") (at 20 20 180)
          (property "Reference" "J2")
          (pad "7" thru_hole oval (at -4.32 -1.78 180) (size 1.1 1.9)
            (drill oval 0.599998 1.299997) (layers "*.Cu" "*.Mask") (net "/POE_V2N") (uuid "usb-slot")))'''
        self.write_native(native()[:-1]+slot+')')
        result=self.check()
        self.assertEqual(result['status'],'blocked',result)
        item=self.row(result,'min_hole_clearance')
        self.assertEqual(Decimal(item['required_mm']),Decimal('.25'))
        self.assertEqual(item['disposition'],'unsupported')
        self.assertTrue(item['hole_geometry'])
        self.assertEqual(item['hole_geometry'][0]['proof']['status'],'blocked')
        self.assertIn('DSN',item['reason'])

    def test_all_drilled_pads_npth_and_retained_vias_reach_the_project_proof(self):
        items='''(footprint "Holes" (layer "F.Cu") (at 20 20)
          (property "Reference" "J2")
          (pad "1" thru_hole circle (at 0 0) (size 1 1) (drill 0.3) (layers "*.Cu") (net "/POE_V2N") (uuid "pth"))
          (pad "" np_thru_hole circle (at 2 0) (size 1 1) (drill 1) (layers "*.Cu") (uuid "npth")))
          (via (at 25 25) (size 0.6) (drill 0.3) (layers "F.Cu" "B.Cu") (net "/POE_V2N") (uuid "via"))'''
        self.write_native(native()[:-1]+items+')')
        with mock.patch.object(coverage.route_hole_coverage,'inspect_drilled',return_value=dict(status='covered')) as proof:
            result=self.check()
            self.assertEqual(result['status'],'passed',result)
        proof.assert_called_once()
        holes=proof.call_args.kwargs['holes']
        self.assertEqual({h['kind'] for h in holes},{'pth','npth','via'})
        self.assertEqual(len(holes),3)
        self.assertEqual(proof.call_args.kwargs['active_nets'],[LED])
        self.assertEqual(Decimal(proof.call_args.kwargs['required_mm']),Decimal('.25'))

    def test_same_net_holes_are_excluded_only_from_the_same_net_clearance_scope(self):
        hole='''(via (at 25 25) (size 0.6) (drill 0.3) (layers "F.Cu" "B.Cu") (net "/LED_LINK_K") (uuid "own-via"))'''
        self.write_native(native()[:-1]+hole+')')
        with mock.patch.object(coverage.route_hole_coverage,'inspect_drilled',
                return_value=dict(status='covered',native_not_applicable=[dict(identity='own-via')])) as proof:
            result=self.check()
        self.assertEqual(result['status'],'passed',result)
        self.assertEqual(self.row(result,'min_hole_clearance')['disposition'],'covered')
        self.assertEqual(len(proof.call_args.kwargs['holes']),1)
        self.assertEqual(proof.call_args.kwargs['holes'][0]['identity'],'own-via')
        self.assertEqual(proof.call_args.kwargs['applicability'],'kicad10_project_track')

    def test_new_vias_or_changed_drills_do_not_get_immutable_dimension_credit(self):
        self.model.write_text(dsn('200'))
        result=coverage.check_files(self.board,self.base,self.model,active_nets=[LED],net_classes=CLASSES,
            obstacles=OBSTACLES,layers=['F.Cu','B.Cu'],gate=self.gate,backend_command=self.command)
        self.assertEqual(result['status'],'blocked',result)
        # No via padstack library in the actual DSN: the via dimensions are unknown.
        self.assertEqual(self.row(result,'min_via_diameter')['disposition'],'unsupported')
        self.assertIn('DSN library',self.row(result,'min_via_diameter')['reason'])
        self.assertEqual(self.row(result,'min_hole_to_hole')['disposition'],'native_postcondition')
        self.model.write_text(self.single_layer_model())
        via='''(via (at 25 25) (size 0.6) (drill 0.3) (layers "F.Cu" "B.Cu") (net "/LED_LINK_K") (uuid "via"))'''
        self.write_native(native()[:-1]+via+')')
        self.base.write_text(self.base.read_text().replace('(drill 0.3)','(drill 0.31)'))
        result=self.check()
        self.assertEqual(result['status'],'blocked',result)
        self.assertFalse(result['drilled_geometry_preserved'])

    def via_check(self, stack='600:300', drill=0.3):
        # KiCad 10 specctra export: "Via[top-bottom]_<DSN diameter>:<drill um>_um".
        name='Via[0-1]_'+stack+'_um'; size=stack.split(':')[0]
        text=dsn('200',extra='(via "'+name+'")')
        self.model.write_text(text[:-1]+' (library (padstack "'+name+'" (shape (circle F.Cu '+size+
            ')) (shape (circle B.Cu '+size+')) (attach off))) (placement))')
        for item in self.authored['net_settings']['classes']:
            item.update(via_diameter=0.6, via_drill=drill)
        self.save_project()
        return coverage.check_files(self.board,self.base,self.model,active_nets=[LED],net_classes=CLASSES,
            obstacles=OBSTACLES,layers=['F.Cu','B.Cu'],gate=self.gate,backend_command=self.command)

    def test_new_via_padstacks_meeting_minima_are_covered_and_hole_rules_stay_native(self):
        result=self.via_check()
        self.assertEqual(result['status'],'pending_native',result)
        self.assertTrue(result['solver_launch_allowed'])
        for name in ('min_via_diameter','min_through_hole_diameter','min_via_annular_width'):
            self.assertEqual(self.row(result,name)['disposition'],'covered',name)
        witness=self.row(result,'min_via_diameter')['via_padstacks']
        self.assertIn(dict(source='dsn padstack Via[0-1]_600:300_um',diameter_mm='0.6',drill_mm='0.3',
            annular_mm='0.15',through=True),witness)
        for name in ('min_microvia_diameter','min_microvia_drill'):
            self.assertEqual(self.row(result,name)['disposition'],'not_applicable',name)
        for name in ('min_text_height','min_text_thickness'):
            self.assertEqual(self.row(result,name)['disposition'],'immutable_unchanged',name)
        for name,types in (('min_hole_to_hole',['hole_to_hole','holes_co_located']),('min_hole_clearance',['hole_clearance'])):
            item=self.row(result,name)
            self.assertEqual(item['disposition'],'native_postcondition',name)
            self.assertEqual(item['native_obligation'],dict(constraint=name,required_mm=item['required_mm'],
                enforcement='native-drc',drc_types=types))
            self.assertIn(item['native_obligation'],result['native_postconditions'])

    def test_new_via_padstack_below_a_project_minimum_blocks_with_its_cause(self):
        for stack,drill,name in (('400:200',0.3,'min_via_diameter'),('500:150',0.3,'min_through_hole_diameter'),
                                 ('500:320',0.3,'min_via_annular_width'),('600:300',0.1,'min_through_hole_diameter')):
            with self.subTest(stack=stack,drill=drill):
                result=self.via_check(stack,drill)
                self.assertEqual(result['status'],'blocked',result)
                self.assertFalse(result['solver_launch_allowed'])
                item=self.row(result,name)
                self.assertEqual(item['disposition'],'weaker_than_native')
                self.assertIn('Via[0-1]_'+stack+'_um' if drill==0.3 else 'netclass Default',item['reason'])

    def test_job_added_base_vias_are_measured_but_a_changed_source_hole_still_blocks(self):
        # fastroute_job places plane vias on the base before routing; they are fixed router input.
        via='(via (at 25 25) (size SIZE) (drill 0.3) (layers "F.Cu" "B.Cu") (net "/POE_V2N") (uuid "plane-via"))'
        self.base.write_text(native()[:-1]+via.replace('SIZE','0.6')+')')
        result=self.via_check()
        self.assertEqual(result['status'],'pending_native',result)
        self.assertFalse(result['drilled_geometry_preserved'])
        self.assertIn('base via plane-via',[v['source'] for v in self.row(result,'min_via_diameter')['via_padstacks']])
        self.base.write_text(native()[:-1]+via.replace('SIZE','0.48')+')')
        result=self.via_check()
        self.assertEqual(result['status'],'blocked',result)
        self.assertIn('base via plane-via',self.row(result,'min_via_annular_width')['reason'])
        self.write_native(native()[:-1]+via.replace('SIZE','0.6')+')')
        self.base.write_text(native())
        result=self.via_check()
        self.assertEqual(result['status'],'blocked',result)
        self.assertEqual(self.row(result,'min_via_diameter')['disposition'],'unsupported')

    def test_unknown_or_absent_rule_still_blocks_when_new_vias_are_possible(self):
        self.authored['board']['design_settings']['rules']['min_new_feature']=1
        result=self.via_check()
        self.assertEqual(result['status'],'blocked',result)
        self.assertEqual(self.row(result,'min_new_feature')['disposition'],'unsupported')
        del self.authored['board']['design_settings']['rules']['min_new_feature']
        del self.authored['board']['design_settings']['rules']['min_via_diameter']
        result=self.via_check()
        self.assertEqual(result['status'],'blocked',result)
        self.assertEqual(self.row(result,'min_via_diameter')['disposition'],'unsupported')

    def test_positive_spoke_requirement_is_not_covered_by_identical_authored_zone(self):
        zone='(zone (net "/POE_V2N") (net_name "/POE_V2N") (layer "F.Cu") (connect_pads (clearance 0.2)))'
        self.write_native(native()[:-1]+zone+')')
        result=self.check()
        self.assertEqual(result['status'],'blocked',result)
        item=self.row(result,'min_resolved_spokes')
        self.assertEqual(item['required_count'],'2')
        self.assertEqual(item['disposition'],'unsupported')
        self.assertTrue(result['fixed_geometry_preserved'])

    def test_verified_native_capability_leaves_only_a_pending_thermal_obligation(self):
        import route_native_thermals
        zone='(zone (net "/POE_V2N") (net_name "/POE_V2N") (layer "F.Cu") (connect_pads (clearance 0.2)))'
        self.write_native(native()[:-1]+zone+')')
        capability=dict(schema=route_native_thermals.CAPABILITY_SCHEMA, status='pending_native',
            required_count=2, content_sha256='c'*64, inputs={str(self.rules):None})
        with mock.patch.object(route_native_thermals, 'validate_capability', return_value=capability) as validate:
            result=self.check(native_thermal_capability=capability)
        validate.assert_called_once_with(capability,self.board,self.base,selected_nets=[LED])
        self.assertEqual(result['status'],'pending_native',result)
        self.assertTrue(result['solver_launch_allowed'])
        self.assertEqual(result['model_status'],'partial')
        self.assertEqual(self.row(result,'min_resolved_spokes')['disposition'],'native_postcondition')
        self.assertEqual(result['native_postconditions'],[dict(constraint='min_resolved_spokes',
            required_count='2',capability_sha256='c'*64)])
        self.assertIsNone(result['inputs'][str(self.rules)])

    def test_native_capability_cannot_cover_a_different_count_or_unrelated_requirement(self):
        import route_native_thermals
        zone='(zone (net "/POE_V2N") (net_name "/POE_V2N") (layer "F.Cu") (connect_pads (clearance 0.2)))'
        self.write_native(native()[:-1]+zone+')')
        for count,connection in ((1,0),(2,0.1)):
            with self.subTest(count=count,connection=connection):
                self.authored['board']['design_settings']['rules']['min_connection']=connection
                self.save_project()
                capability=dict(schema=route_native_thermals.CAPABILITY_SCHEMA,status='pending_native',
                    required_count=count,content_sha256='c'*64,inputs={})
                with mock.patch.object(route_native_thermals,'validate_capability',return_value=capability):
                    result=self.check(native_thermal_capability=capability)
                self.assertEqual(result['status'],'blocked',result)
                self.assertFalse(result['solver_launch_allowed'])

    def test_invalid_native_capability_blocks_even_when_thermal_requirement_is_inactive(self):
        import route_native_thermals
        with mock.patch.object(route_native_thermals,'validate_capability',side_effect=ValueError('missing native input evidence')):
            result=self.check(native_thermal_capability={})
        self.assertEqual(result['status'],'blocked',result)
        self.assertFalse(result['solver_launch_allowed'])
        self.assertIn('missing native input evidence',result['cause'])

    def test_all_solid_thermal_inapplicability_includes_overrides_and_missing_threshold(self):
        zone='(zone (net "/POE_V2N") (net_name "/POE_V2N") (layer "F.Cu") (connect_pads yes (clearance 0.2)))'
        solid=native()[:-1]+zone+')'
        for override in ('', '(zone_connect 2)', '(zone_connect -1)', '(zone_connect 0)'):
            with self.subTest(nonthermal_override=override):
                text=solid.replace('(property "Reference" "R10")','(property "Reference" "R10") '+override)
                self.write_native(text)
                result=self.check()
                self.assertEqual(result['status'],'passed',result)
                item=self.row(result,'min_resolved_spokes')
                self.assertEqual(item['disposition'],'not_applicable')
                self.assertFalse(item['thermal_applicability']['thermal_connections_possible'])
        del self.authored['board']['design_settings']['rules']['min_resolved_spokes'];self.save_project()
        result=self.check()
        self.assertEqual(result['status'],'passed',result)
        item=self.row(result,'min_resolved_spokes')
        self.assertFalse(item['source']['exists'])
        self.assertNotIn('required_count',item)
        for override in ('(zone_connect 1)','(zone_connect 3)','(zone_connect 9)'):
            with self.subTest(thermal_override=override):
                self.write_native(solid.replace('(property "Reference" "R10")','(property "Reference" "R10") '+override))
                result=self.check()
                self.assertEqual(result['status'],'blocked',result)
                self.assertEqual(self.row(result,'min_resolved_spokes')['disposition'],'unsupported')
        self.write_native(solid)
        self.rules.write_text('(version 1) (rule "thermal pads" (condition "A.Type == \'Pad\'") (constraint zone_connection thermal_reliefs))')
        self.base_rules.write_bytes(self.rules.read_bytes())
        result=self.check()
        self.assertEqual(result['status'],'blocked',result)
        self.assertEqual(self.row(result,'min_resolved_spokes')['disposition'],'unsupported')

    def test_base_project_fixed_geometry_and_command_races_are_bound(self):
        self.base_project.write_text('{}')
        result=self.check();self.assertEqual(result['status'],'blocked',result)
        self.assertEqual(self.row(result,'project_source')['disposition'],'unsupported')
        self.save_project()
        self.base_rules.write_text('(version 1) (rule "unexpected base policy" (constraint clearance (min 1mm)))')
        result=self.check();self.assertEqual(result['status'],'blocked',result)
        self.assertTrue(any(r['constraint']=='rule_source' for r in result['requirements']))
        self.base_rules.unlink()
        self.base.write_text(native()[:-1]+'(gr_text "changed" (at 0 0) (layer "F.SilkS")))')
        result=self.check();self.assertEqual(result['status'],'blocked',result)
        self.assertFalse(result['fixed_geometry_preserved'])
        self.write_native(native())
        original=coverage.route_project_coverage.evaluate
        for target in ('source','base','backend','command','missing-dru'):
            with self.subTest(target=target):
                paths={'source':self.project,'base':self.base_project,'backend':self.router}
                previous={p:p.read_bytes() for p in paths.values()}
                command=list(self.command)
                def mutate(*args,**kwargs):
                    result=original(*args,**kwargs)
                    if target=='command':command.append('--router.min_trace_width_um=100')
                    elif target=='missing-dru':self.rules.write_text('(version 1)')
                    else:paths[target].write_bytes(previous[paths[target]]+b'\n')
                    return result
                with mock.patch.object(coverage.route_project_coverage,'evaluate',side_effect=mutate):
                    result=self.check(command)
                self.assertEqual(result['status'],'blocked',result)
                self.assertIn('changed during admission',result['cause'])
                for p,b in previous.items():p.write_bytes(b)
                if self.rules.exists():self.rules.unlink()

    def test_backend_profile_proof_is_passed_bound_and_rechecked_without_inventing_one(self):
        evidence=self.root/'native-backend-evidence.json';evidence.write_text('{"source":"fixture"}')
        expected=hashlib.sha256(evidence.read_bytes()).hexdigest()
        policy=dict(mode='quality-first',manifest='fixture-only-not-a-real-profile')
        def proof(*args,**kwargs):
            self.assertEqual(kwargs['backend_policy'],policy)
            self.assertIsNot(kwargs['backend_policy'],policy)
            self.assertEqual(kwargs['backend_command'],self.command)
            return dict(status='covered',inputs={str(evidence):expected})
        with mock.patch.object(coverage.route_hole_coverage,'inspect_drilled',side_effect=proof):
            result=self.check(backend_policy=policy)
        self.assertEqual(result['status'],'passed',result)
        self.assertEqual(result['backend_policy'],policy)
        self.assertEqual(result['inputs'][str(evidence)],expected)
        def changed(*args,**kwargs):
            result=proof(*args,**kwargs)
            evidence.write_text('{"source":"changed"}')
            return result
        with mock.patch.object(coverage.route_hole_coverage,'inspect_drilled',side_effect=changed):
            result=self.check(backend_policy=policy)
        self.assertEqual(result['status'],'blocked',result)
        self.assertIn('changed during admission',result['cause'])
        evidence.write_text('{"source":"fixture"}')
        def mutate_policy(*args,**kwargs):
            result=proof(*args,**kwargs)
            policy['mode']='changed'
            return result
        with mock.patch.object(coverage.route_hole_coverage,'inspect_drilled',side_effect=mutate_policy):
            result=self.check(backend_policy=policy)
        self.assertEqual(result['status'],'blocked',result)
        self.assertIn('backend policy changed',result['cause'])

    def test_custom_hole_limit_cannot_bypass_actual_backend_proof_with_zero_project_minimum(self):
        self.authored['board']['design_settings']['rules']['min_hole_clearance']=0
        self.save_project()
        hole='''(footprint "PTH" (layer "F.Cu") (at 20 20)
          (property "Reference" "J2")
          (pad "1" thru_hole circle (at 0 0) (size 1 1) (drill 0.3)
            (layers "*.Cu") (net "/POE_V2N") (uuid "pth")))'''
        self.write_native(native()[:-1]+hole+')')
        self.rules.write_text(rule('hole_clearance','0.4mm',
            "A.Pad_Type == 'Through-hole' || B.Pad_Type == 'Through-hole'"))
        self.base_rules.write_bytes(self.rules.read_bytes())
        evidence=self.root/'actual-backend-proof.json';evidence.write_text('{}')
        digest=hashlib.sha256(evidence.read_bytes()).hexdigest()
        policy=dict(mode='fixture-only-boundary')
        with mock.patch.object(coverage.route_hole_coverage,'inspect',
                return_value=dict(status='covered',cause='legacy analytic subset')):
            rejected=self.check(backend_policy=policy)
            self.assertEqual(rejected['status'],'blocked',rejected)
            custom=next(r for r in rejected['requirements'] if r['rule']=='PoE isolation')
            self.assertEqual(custom['disposition'],'unsupported')
            self.assertEqual(Decimal(custom['required_mm']),Decimal('.4'))
            self.assertEqual(custom['analytical_hole_geometry']['status'],'covered')
            with mock.patch.object(coverage.route_hole_coverage,'inspect_drilled',
                    return_value=dict(status='covered',inputs={str(evidence):digest})) as actual:
                admitted=self.check(backend_policy=policy)
            self.assertEqual(admitted['status'],'passed',admitted)
            self.assertEqual(admitted['inputs'][str(evidence)],digest)
            self.assertEqual(actual.call_count,1)
            kwargs=actual.call_args.kwargs
            self.assertEqual(kwargs['required_mm'],'0.4')
            self.assertEqual(kwargs['backend_policy'],policy)
            self.assertEqual(kwargs['backend_command'],self.command)
            self.assertEqual(len(kwargs['holes']),1)
            self.assertEqual(kwargs['applicability'],'custom_pth_track')
            self.assertNotEqual(kwargs['applicability'],'kicad10_project_track')

    def test_joint_custom_and_project_hole_proofs_keep_the_full_inventory_and_separate_minima(self):
        mixed='''(footprint "PTH" (layer "F.Cu") (at 20 20)
          (property "Reference" "J2")
          (pad "1" thru_hole circle (at 0 0) (size 1 1) (drill 0.3)
            (layers "*.Cu") (net "/POE_V2N") (uuid "pth"))
          (pad "" np_thru_hole circle (at 2 0) (size 1 1) (drill 1)
            (layers "*.Cu") (uuid "npth")))
          (via (at 25 25) (size 0.6) (drill 0.3) (layers "F.Cu" "B.Cu")
            (net "/LED_LINK_K") (uuid "kept-via"))'''
        self.write_native(native()[:-1]+mixed+')')
        self.rules.write_text(rule('hole_clearance','0.28mm',
            "A.Pad_Type == 'Through-hole' || B.Pad_Type == 'Through-hole'"))
        self.base_rules.write_bytes(self.rules.read_bytes())
        for project_fails in (False,True):
            calls=[]
            def actual(*args,**kwargs):
                calls.append(kwargs)
                self.assertEqual({h['identity'] for h in kwargs['holes']},{'pth','npth','kept-via'})
                self.assertEqual({h['kind'] for h in kwargs['holes']},{'pth','npth','via'})
                if kwargs['applicability']=='custom_pth_track':
                    self.assertEqual(Decimal(kwargs['required_mm']),Decimal('.28'))
                    return dict(status='covered',cause='fixture PTH scope with every physical instance bound')
                self.assertEqual(kwargs['applicability'],'kicad10_project_track')
                self.assertEqual(Decimal(kwargs['required_mm']),Decimal('.25'))
                return dict(status='blocked' if project_fails else 'covered',
                    cause='fixture NPTH project obstacle too small' if project_fails else 'fixture all-hole project proof')
            with self.subTest(project_failure=project_fails), mock.patch.object(coverage.route_hole_coverage,'inspect',
                    return_value=dict(status='covered',cause='legacy analytical PTH subset')), \
                    mock.patch.object(coverage.route_hole_coverage,'inspect_drilled',side_effect=actual):
                result=self.check()
            self.assertEqual(len(calls),2)
            self.assertEqual(result['status'],'blocked' if project_fails else 'passed',result)
            self.assertEqual(result['solver_launch_allowed'],not project_fails)
            custom=next(r for r in result['requirements'] if r['rule']=='PoE isolation')
            self.assertEqual(custom['disposition'],'covered')
            self.assertEqual(self.row(result,'min_hole_clearance')['disposition'],'unsupported' if project_fails else 'covered')

    def test_joint_hole_proofs_block_missing_or_changed_retained_vias_before_distance_proof(self):
        pth='''(footprint "PTH" (layer "F.Cu") (at 20 20)
          (property "Reference" "J2")
          (pad "1" thru_hole circle (at 0 0) (size 1 1) (drill 0.3)
            (layers "*.Cu") (net "/POE_V2N") (uuid "pth")))'''
        via='''(via (at 25 25) (size 0.6) (drill 0.3) (layers "F.Cu" "B.Cu")
          (net "/LED_LINK_K") (uuid "kept-via"))'''
        text=native()[:-1]+pth+via+')';self.write_native(text)
        self.rules.write_text(rule('hole_clearance','0.28mm',
            "A.Pad_Type == 'Through-hole' || B.Pad_Type == 'Through-hole'"))
        self.base_rules.write_bytes(self.rules.read_bytes())
        for label,changed in (('missing',text.replace(via,'')),
                ('moved',text.replace('(at 25 25)','(at 25.1 25)'))):
            self.base.write_text(changed)
            with self.subTest(via_change=label), mock.patch.object(coverage.route_hole_coverage,'inspect',
                    return_value=dict(status='covered',cause='legacy analytical PTH subset')), \
                    mock.patch.object(coverage.route_hole_coverage,'inspect_drilled',return_value=dict(status='covered')) as actual:
                result=self.check()
            self.assertEqual(result['status'],'blocked',result)
            self.assertFalse(result['solver_launch_allowed'])
            self.assertFalse(result['drilled_geometry_preserved'])
            actual.assert_not_called()
            custom=next(r for r in result['requirements'] if r['rule']=='PoE isolation')
            self.assertEqual(custom['disposition'],'unsupported')
            self.assertEqual(self.row(result,'min_hole_clearance')['disposition'],'unsupported')


class NativePostconditionTests(unittest.TestCase):
    HOLES = dict(constraint='min_hole_to_hole', required_mm='0.25', enforcement='native-drc',
                 drc_types=['hole_to_hole', 'holes_co_located'])
    GATE = dict(rule='configured kicad_happy RP-001', constraint='reference_stitching',
                enforcement='configured-gate', nets=[LED])
    THERMAL = dict(constraint='min_resolved_spokes', required_count='2', capability_sha256='c'*64)

    def report(self, violations=(), ignored=(), severities=('error', 'warning', 'exclusion')):
        return dict(violations=list(violations), unconnected_items=[], schematic_parity=[],
                    ignored_checks=[dict(key=k) for k in ignored], included_severities=list(severities))

    def test_clean_native_drc_discharges_and_gate_and_thermal_obligations_stay_typed(self):
        result = coverage.discharge_native([self.HOLES, self.GATE, self.THERMAL],
            self.report([dict(type='clearance', severity='error')]))
        self.assertEqual(result['status'], 'passed', result)
        self.assertEqual(result['native_drc'], [dict(self.HOLES, violations=0)])
        self.assertEqual(result['configured_gate'], [self.GATE])
        self.assertEqual(result['native_checkback'], [self.THERMAL])
        self.assertFalse(result['qualified'])

    def test_violation_ignored_check_or_incomplete_report_fails_the_obligation(self):
        cases = dict(warning=self.report([dict(type='hole_to_hole', severity='warning')]),
                     excluded=self.report([dict(type='holes_co_located', severity='exclusion', excluded=True)]),
                     ignored=self.report(ignored=['hole_to_hole']),
                     severities=self.report(severities=('error',)),
                     malformed=dict(violations=[]))
        for label, report in cases.items():
            with self.subTest(report=label):
                result = coverage.discharge_native([self.HOLES], report)
                self.assertEqual(result['status'], 'failed', result)
                self.assertTrue(result['cause'])
        unknown = coverage.discharge_native([dict(constraint='min_hole_to_hole')], self.report())
        self.assertEqual(unknown['status'], 'failed', unknown)

    SILK = dict(constraint='min_silk_clearance', required_mm='0.15', enforcement='native-drc',
                drc_types=['silk_overlap', 'silk_over_copper'])

    def finding(self, kind, *uuids):
        return dict(type=kind, severity='warning', items=[dict(description='item', uuid=u) for u in uuids])

    def test_finding_already_on_the_input_board_does_not_fail_the_obligation(self):
        old = self.finding('silk_over_copper', 'text-1', 'pad-1')
        result = coverage.discharge_native([self.SILK], self.report([old]), baseline=self.report([old]))
        self.assertEqual(result['status'], 'passed', result)
        self.assertEqual(result['native_drc'][0]['violations'], 0)
        self.assertEqual(result['native_drc'][0]['preexisting'], 1)

    def test_finding_that_touches_new_copper_fails_the_obligation(self):
        old = self.finding('silk_over_copper', 'text-1', 'pad-1')
        new = self.finding('silk_over_copper', 'text-1', 'new-via')
        result = coverage.discharge_native([self.SILK], self.report([old, new]), baseline=self.report([old]))
        self.assertEqual(result['status'], 'failed', result)
        self.assertEqual(result['native_drc'][0]['violations'], 1)

    def test_a_repeated_input_finding_counts_once_only(self):
        old = self.finding('silk_over_copper', 'text-1', 'pad-1')
        result = coverage.discharge_native([self.SILK], self.report([old, old]), baseline=self.report([old]))
        self.assertEqual(result['status'], 'failed', result)

    def test_incomplete_or_unidentified_baseline_fails(self):
        cases = dict(severities=self.report(severities=('error',)),
                     no_uuid=self.report([dict(type='silk_over_copper', severity='warning',
                                               items=[dict(description='item')])]))
        for label, baseline in cases.items():
            with self.subTest(baseline=label):
                result = coverage.discharge_native([self.SILK], self.report(), baseline=baseline)
                self.assertEqual(result['status'], 'failed', result)


class ClearanceStrengtheningTests(unittest.TestCase):
    def project_text(self, floor=.3, unused=99):
        value = project()
        value['net_settings']['classes'][1]['clearance'] = floor
        value['net_settings']['classes'].append(dict(name='UNUSED', clearance=unused))
        return json.dumps(value)

    def strengthen(self, model=None, project_text=None, **kwargs):
        return coverage.route_features.strengthen_project_clearance(
            dsn() if model is None else model,
            self.project_text() if project_text is None else project_text,
            source='actual-project.kicad_pro', active_nets=[LED], net_classes=CLASSES,
            obstacles=OBSTACLES, layers=['F.Cu', 'B.Cu'], **kwargs)

    def test_applicable_power_class_raises_every_weak_declaration_without_using_unused_class(self):
        extra = '''(rule (clearance 50 (type smd_smd)))
          (region "nested" (rule (clearance 100 (type wire_wire))))'''
        pairs = '(class_class (classes "DEFAULT" "POE") (rule (clearance 600)))'
        model = '# comment (clearance 200)\n' + dsn(extra=extra, pairs=pairs).replace(
            '"coverage-fixture"', '"literal (clearance 200)"')
        actual, receipt = self.strengthen(model)
        expected = '# comment (clearance 200)\n' + dsn('300',
            extra=extra.replace('clearance 100', 'clearance 300'), pairs=pairs).replace(
                '"coverage-fixture"', '"literal (clearance 200)"')
        self.assertEqual(actual, expected)
        self.assertEqual(len(receipt['changes']), 4)
        self.assertEqual(receipt['required_mm'], '0.3')
        self.assertEqual({r.get('netclass') for r in receipt['requirements'] if 'netclass' in r}, {'Default', 'POE'})
        self.assertNotIn('UNUSED', json.dumps(receipt['requirements']))
        self.assertEqual(receipt['before_sha256'], hashlib.sha256(model.encode()).hexdigest())
        self.assertEqual(receipt['after_sha256'], hashlib.sha256(actual.encode()).hexdigest())
        self.assertEqual(receipt['project']['sha256'], hashlib.sha256(self.project_text().encode()).hexdigest())
        self.assertFalse(receipt['qualified'])

    def test_pad_only_exceptions_and_all_nonclearance_bytes_stay_exact(self):
        extra = ''.join('(rule (clearance 50 (type '+kind+')))' for kind in ('smd_smd','pin_pin','pin_smd'))
        model = dsn('200', extra=extra)
        changed, receipt = self.strengthen(model)
        self.assertEqual(changed, dsn('300', extra=extra))
        cursor = 0
        pieces = []
        for edit in receipt['changes']:
            self.assertEqual(model[edit['start']:edit['end']], edit['before'])
            pieces += [model[cursor:edit['start']], edit['after']]
            cursor = edit['end']
        self.assertEqual(''.join(pieces) + model[cursor:], changed)
        self.assertEqual(coverage.Model(changed, ['F.Cu']).membership, coverage.Model(model, ['F.Cu']).membership)

    def test_stronger_model_is_unchanged_and_strengthening_is_idempotent(self):
        model = dsn('600')
        same, receipt = self.strengthen(model)
        self.assertEqual(same, model); self.assertEqual(receipt['changes'], [])
        once, _ = self.strengthen()
        twice, report = self.strengthen(once)
        self.assertEqual(twice, once); self.assertEqual(report['changes'], [])

    def test_exact_known_unit_conversions_and_nonrepresentable_values_abstain(self):
        for unit, initial, target, floor, resolution in (
                ('mm', '0.2', '0.3', .3, 10), ('mil', '5', '10', .254, 10),
                ('in', '0.05', '0.1', 2.54, 100)):
            with self.subTest(unit=unit):
                model = dsn(initial, unit=unit).replace('(resolution um 10)', '(resolution '+unit+' '+str(resolution)+')')
                changed, _ = self.strengthen(model, self.project_text(floor))
                self.assertEqual(changed, model.replace('(clearance '+initial+')', '(clearance '+target+')'))
        for model, floor in ((dsn('0.2', unit='mm').replace('(resolution um 10)', '(resolution mm 10)'), .25),
                             (dsn('5', unit='mil').replace('(resolution um 10)', '(resolution mil 127)'), .3)):
            with self.subTest(model=model), self.assertRaisesRegex(ValueError, 'exact|represent'):
                self.strengthen(model, self.project_text(floor))

    def test_unknown_malformed_units_qualifiers_numbers_and_tokens_fail_closed(self):
        variants = [dsn(unit='unknown'), dsn().replace('(unit um)', '(unit um) (unit mm)'),
            dsn().replace('(resolution um 10)', '(resolution mm 10)'), dsn('nan'), dsn('-1'),
            dsn(extra='(rule (clearance 50 (type unsupported)))'),
            dsn(extra='(rule (clearance 50 (type smd_smd) (type pin_pin)))'),
            dsn(extra='(rule (clearance 50 (type smd_smd smd_smd)))'),
            dsn(extra='(rule (clearance 50 (type smd_smd) unknown))'),
            dsn(extra='(region x (unit mm))'), dsn('200um'), dsn()[:-1],
            dsn().replace('(unit um)', '(unit (unknown))'),
            dsn().replace('"coverage-fixture"', '"unterminated')]
        for model in variants:
            with self.subTest(model=model), self.assertRaises(ValueError):
                self.strengthen(model)

    def test_used_class_or_native_membership_unknown_blocks_instead_of_dropping_obstacle(self):
        value = json.loads(self.project_text())
        value['net_settings']['classes'] = value['net_settings']['classes'][:1]
        with self.assertRaisesRegex(ValueError, 'netclass clearance is unresolved'):
            self.strengthen(project_text=json.dumps(value))
        membership = '(class "'+POE+'" "'+POE+'"'
        self.assertIn(membership, dsn())
        model = dsn().replace(membership, '(class "'+POE+'"', 1)
        with self.assertRaisesRegex(ValueError, 'absent from the DSN'):
            self.strengthen(model)

    def test_unused_native_mapping_without_dsn_membership_does_not_set_the_floor(self):
        classes = dict(CLASSES, UNUSED_DECLARATION='UNUSED')
        changed, receipt = coverage.route_features.strengthen_project_clearance(dsn(), self.project_text(),
            source='actual-project.kicad_pro', active_nets=[LED],net_classes=classes,
            obstacles=OBSTACLES,layers=['F.Cu','B.Cu'])
        self.assertEqual(changed,dsn('300'))
        self.assertEqual(receipt['required_mm'],'0.3')
        self.assertNotIn('UNUSED_DECLARATION',receipt['counterparts'])
        self.assertNotIn('UNUSED',json.dumps(receipt['requirements']))

    def test_existing_strict_file_guard_rejects_before_and_accepts_after_model_change(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder); source, base, model = [root/name for name in ('source.kicad_pcb','base.kicad_pcb','model.dsn')]
            project_text = self.project_text()
            for path in (source, base):
                path.write_text(native()); path.with_suffix('.kicad_dru').write_text('(version 1)')
                path.with_suffix('.kicad_pro').write_text(project_text)
            model.write_text(dsn())
            scope = dict(active_nets=[LED],net_classes=CLASSES,obstacles=OBSTACLES,layers=['F.Cu','B.Cu'])
            before = coverage.check_files(source,base,model,**scope)
            self.assertEqual(before['status'],'blocked')
            self.assertTrue(any(r.get('constraint')=='netclass_clearance' and r['disposition']=='weaker_than_native'
                                for r in before['requirements']))
            original = {p:hashlib.sha256(p.read_bytes()).hexdigest() for p in (source,base,source.with_suffix('.kicad_pro'),base.with_suffix('.kicad_pro'))}
            changed, _ = self.strengthen(model.read_text(), project_text)
            model.write_text(changed)
            after = coverage.check_files(source,base,model,**scope)
            self.assertEqual(after['status'],'passed',after['cause'])
            self.assertTrue(after['solver_launch_allowed'])
            self.assertTrue(all(hashlib.sha256(p.read_bytes()).hexdigest()==digest for p,digest in original.items()))


if __name__ == '__main__':
    unittest.main()
