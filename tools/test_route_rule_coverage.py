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

    def test_reference_stitching_requires_actual_single_layer_active_net_mask(self):
        self.assert_blocked(self.inspect('', dsn(), require_stitching=True))
        self.assert_blocked(self.inspect('', dsn(mask=['F.Cu', 'B.Cu']), require_stitching=True))
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


class FileCoverageTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(); self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.board = self.root/'source.kicad_pcb'; self.board.write_text(native())
        self.base = self.root/'base.kicad_pcb'; self.base.write_text(native())
        self.rules = self.board.with_suffix('.kicad_dru'); self.rules.write_text(rule())
        self.project = self.board.with_suffix('.kicad_pro'); self.project.write_text('{}')
        self.model = self.root/'board.dsn'; self.model.write_text(dsn('3000'))
        self.gate = self.root/'gate.json'; self.gate.write_text(json.dumps(dict(checks=dict(drc=True))))

    def check(self):
        return coverage.check_files(self.board, self.base, self.model, active_nets=[LED],
            net_classes=CLASSES, obstacles=OBSTACLES, layers=['F.Cu', 'B.Cu'], gate=self.gate)

    def test_receipt_binds_original_base_rules_project_gate_and_exact_dsn(self):
        result = self.check()
        self.assertEqual(result['status'], 'passed', result)
        for path in (self.board, self.base, self.rules, self.project, self.model, self.gate,
                     Path(coverage.__file__).resolve(), Path(coverage.route_features.__file__).resolve()):
            self.assertEqual(result['inputs'][str(path)], hashlib.sha256(path.read_bytes()).hexdigest())
        self.assertEqual(result['dsn'], dict(path=str(self.model), sha256=result['inputs'][str(self.model)]))
        self.assertFalse(result['qualified'])

    def test_pads_only_disposition_cannot_hide_moved_or_changed_base_footprints(self):
        self.rules.write_text('(version 1) (rule "pads fixed" (constraint disallow pad))')
        for label, text in (('pose', native().replace('(at 10 10 180)', '(at 11 10 180)')),
                            ('pad', native().replace('(size 1 1)', '(size 2 1)', 1)),
                            ('net', native().replace('(net "/LED_LINK_K")', '(net "/OTHER")', 1))):
            with self.subTest(change=label):
                self.base.write_text(text)
                with self.assertRaises(ValueError):self.check()

    def test_input_changed_during_admission_is_blocked_even_when_decision_was_passed(self):
        original = coverage.inspect
        for path in (self.board, self.base, self.rules, self.project, self.model, self.gate):
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
        self.gate.write_text(json.dumps(dict(checks=dict(drc=True, kicad_happy=True))))
        self.assertEqual(self.check()['status'], 'blocked')
        self.model.write_text(dsn('200', mask=['F.Cu']))
        self.assertEqual(self.check()['status'], 'passed')


if __name__ == '__main__':
    unittest.main()
