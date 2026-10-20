"""Receipt validation only; these fixtures do not claim actual native checks."""
import copy
import hashlib
import importlib.util
import json
from pathlib import Path
import shutil
import sys
import tempfile
import types
import unittest
from unittest import mock

import route_native_thermals as thermal


class NativeThermalTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name).resolve()
        self.source = self.root/'source.kicad_pcb'
        self.base = self.root/'base.kicad_pcb'
        self.final = self.root/'final.kicad_pcb'
        # Only UUID/net parsing is under test. No native tool is executed.
        self.board = '''(kicad_pcb (version 20260206)
 (footprint "test" (pad "1" smd rect (net "/FB") (uuid "fb-a")))
 (footprint "test" (pad "1" smd rect (net "/FB") (uuid "fb-b")))
 (footprint "test" (pad "1" smd rect (net "GND") (uuid "gnd-a"))))'''
        self.project = {'board': {'design_settings': {'rules': {'min_resolved_spokes': 2},
            'rule_severities': {'starved_thermal': 'error'}, 'drc_exclusions': []}}}
        for path in (self.source, self.base, self.final):
            path.write_text(self.board)
            self.write(path.with_suffix('.kicad_pro'), self.project)
            path.with_suffix('.kicad_dru').write_text('(version 1)\n')
        self.python = self.root/'recorded-python'
        self.cli = self.root/'recorded-kicad-cli'
        self.python.write_text('synthetic recorded Python binary identity')
        self.cli.write_text('synthetic recorded KiCad binary identity')
        self.initial_fill, self.initial_drc, self.initial_report = self.evidence(self.base, 'initial', opens=True)
        self.final_fill, self.final_drc, self.final_report = self.evidence(self.final, 'final', opens=False)

    def write(self, path, value):
        path.write_text(json.dumps(value))

    def sha(self, path):
        return hashlib.sha256(path.read_bytes()).hexdigest()

    def descriptor(self, path):
        return {'path': str(path), 'sha256': self.sha(path)}

    def evidence(self, candidate, label, *, opens):
        fill = self.root/(label+'-fill.json')
        drc = self.root/(label+'-drc.json')
        report = self.root/(label+'-report.json')
        inputs = {str(p): self.sha(p) for p in (candidate,
            candidate.with_suffix('.kicad_pro'), candidate.with_suffix('.kicad_dru'))}
        self.write(fill, {'schema': 'iot-lab.native-thermal-fill.v1',
            'candidate': self.descriptor(candidate), 'inputs': inputs, 'fill_result': True,
            'tool': self.descriptor(self.python), 'pcbnew_version': '10.0.6',
            'invocation': {'operation': 'ZONE_FILLER.Fill', 'saved': True}})
        self.write(report, {'kicad_version': '10.0.6', 'coordinate_units': 'mm',
            'source': candidate.name, 'included_severities': ['error', 'warning', 'exclusion'],
            'ignored_checks': [], 'violations': [], 'schematic_parity': [],
            'unconnected_items': [self.open_row()] if opens else []})
        self.write(drc, {'schema': 'iot-lab.native-thermal-drc.v1',
            'candidate': self.descriptor(candidate), 'inputs': inputs,
            'tool': self.descriptor(self.cli), 'returncode': 0,
            'command': [str(self.cli), 'pcb', 'drc', '--severity-all', '--format', 'json',
                        '--units', 'mm', '-o', str(report), str(candidate)],
            'report': self.descriptor(report)})
        return fill, drc, report

    def open_row(self, a='fb-a', b='fb-b'):
        return {'type': 'unconnected_items', 'severity': 'error',
                'items': [{'uuid': a}, {'uuid': b}]}

    def mutate(self, path, callback):
        data = json.loads(path.read_text())
        callback(data)
        self.write(path, data)

    def report_mutation(self, report, receipt, callback):
        self.mutate(report, callback)
        self.mutate(receipt, lambda d: d.update(report=self.descriptor(report)))

    def admit(self, **kwargs):
        args = dict(enabled=True, selected_nets=['/FB'],
            initial_fill_receipt=self.initial_fill, initial_drc_receipt=self.initial_drc)
        args.update(kwargs)
        return thermal.admit(self.source, self.base, **args)

    def discharge(self, capability):
        return thermal.discharge(capability, self.final,
            fill_receipt=self.final_fill, drc_receipt=self.final_drc)

    def module_copy(self, label):
        """Identical code in another checkout; no recorded code is executed."""
        tools = self.root/label/'tools'
        (tools/'placer').mkdir(parents=True)
        helper, parser = tools/'route_native_thermals.py', tools/'placer/dru.py'
        shutil.copyfile(thermal.__file__, helper)
        shutil.copyfile(thermal.native_parser.__file__, parser)
        def load(name, path):
            spec = importlib.util.spec_from_file_location(name, path)
            value = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(value)
            return value
        native_parser = load(label+'_parser', parser)
        package = types.ModuleType('placer')
        package.__path__ = [str(parser.parent)]
        package.dru = native_parser
        with mock.patch.dict(sys.modules, {'placer': package, 'placer.dru': native_parser}):
            return load(label+'_thermal', helper)

    def origin_capability(self, producer):
        return producer.admit(self.source, self.base, enabled=True, selected_nets=['/FB'],
            initial_fill_receipt=self.initial_fill, initial_drc_receipt=self.initial_drc)

    def test_identical_separated_origins_preserve_capability_and_final_provenance(self):
        producer, consumer = self.module_copy('producer'), self.module_copy('consumer')
        capability = self.origin_capability(producer)
        original = copy.deepcopy(capability)
        actual = consumer.validate_capability(capability, self.source, self.base, selected_nets=['/FB'])
        self.assertEqual(actual, original)
        self.assertEqual(capability, original)
        self.assertEqual(actual['implementation']['schema'], thermal.IMPLEMENTATION_SCHEMA)
        self.assertEqual(actual['implementation']['roles']['helper'], self.descriptor(Path(producer.__file__)))
        self.assertEqual(actual['implementation']['roles']['parser'], self.descriptor(Path(producer.native_parser.__file__)))
        kwargs = dict(fill_receipt=self.final_fill, drc_receipt=self.final_drc)
        final = producer.discharge(capability, self.final, **kwargs)
        self.assertEqual(consumer.discharge(capability, self.final, **kwargs), final)
        for module in (consumer, consumer.native_parser):
            self.assertNotIn(str(Path(module.__file__).resolve()), actual['inputs'])
            self.assertNotIn(str(Path(module.__file__).resolve()), final['inputs'])
        for descriptor in actual['implementation']['roles'].values():
            self.assertEqual(final['inputs'][descriptor['path']], descriptor['sha256'])

    def test_recorded_producer_implementation_path_and_bytes_remain_required(self):
        for role in ('helper', 'parser'):
            with self.subTest(role=role):
                producer, consumer = self.module_copy('producer_'+role), self.module_copy('consumer_'+role)
                capability = self.origin_capability(producer)
                path = Path(capability['implementation']['roles'][role]['path'])
                original = path.read_bytes()
                path.write_bytes(original+b'\n# changed original producer bytes\n')
                with self.assertRaisesRegex(ValueError, 'stale|changed'):
                    consumer.validate_capability(capability, self.source, self.base, selected_nets=['/FB'])
                path.write_bytes(original)
                path.rename(path.with_suffix('.missing'))
                with self.assertRaisesRegex(ValueError, 'missing evidence file'):
                    consumer.validate_capability(capability, self.source, self.base, selected_nets=['/FB'])

    def test_changed_consuming_helper_or_parser_cannot_use_original_capability(self):
        producer, consumer = self.module_copy('producer'), self.module_copy('consumer')
        capability = self.origin_capability(producer)
        for role, module in (('helper', consumer), ('parser', consumer.native_parser)):
            with self.subTest(role=role):
                path = Path(module.__file__)
                original = path.read_bytes()
                path.write_bytes(original+b'\n# changed consuming implementation\n')
                try:
                    with self.assertRaisesRegex(ValueError, 'consumer native thermal '+role+' implementation differs'):
                        consumer.validate_capability(capability, self.source, self.base, selected_nets=['/FB'])
                finally:
                    path.write_bytes(original)

    def test_versioned_role_records_cannot_drop_or_rebind_original_implementation_inputs(self):
        capability = self.admit()
        def reseal(value):
            value.pop('content_sha256')
            value['content_sha256'] = thermal._identity(value)
            return value
        legacy = copy.deepcopy(capability)
        legacy.pop('implementation')
        with self.assertRaisesRegex(ValueError, 'legacy.*historical only'):
            thermal.validate_capability(reseal(legacy), self.source, self.base, selected_nets=['/FB'])
        aliases = self.root/'identical-helper.py'
        aliases.write_bytes(Path(thermal.__file__).read_bytes())
        mutations = [
            lambda c: c['implementation'].update(schema='iot-lab.native-thermal-implementation.v2'),
            lambda c: c['implementation'].update(unreviewed=True),
            lambda c: c['implementation']['roles'].update(extra=c['implementation']['roles']['helper']),
            lambda c: c['implementation']['roles']['helper'].update(extra=True),
            lambda c: c['implementation']['roles'].update(parser=c['implementation']['roles']['helper']),
            lambda c: c['implementation']['roles']['helper'].update(path=str(aliases)),
            lambda c: c['implementation']['roles']['helper'].update(
                path=str(Path(thermal.__file__).parent/'..'/Path(thermal.__file__).parent.name/Path(thermal.__file__).name)),
            lambda c: c['inputs'].pop(c['implementation']['roles']['helper']['path']),
        ]
        for mutate in mutations:
            with self.subTest(mutation=mutate):
                changed = copy.deepcopy(capability)
                mutate(changed)
                with self.assertRaises(ValueError):
                    thermal.validate_capability(reseal(changed), self.source, self.base, selected_nets=['/FB'])

    def test_every_recorded_input_is_checked_before_cross_origin_replay(self):
        extra = self.root/'original-reviewed-input.txt'
        extra.write_text('original retained input')
        self.mutate(self.initial_fill, lambda d: d['inputs'].update({str(extra): self.sha(extra)}))
        producer, consumer = self.module_copy('producer'), self.module_copy('consumer')
        capability = self.origin_capability(producer)
        self.assertEqual(capability['inputs'][str(extra)], self.sha(extra))
        extra.write_text('changed original retained input')
        with self.assertRaisesRegex(ValueError, 'evidence input changed'):
            consumer.validate_capability(capability, self.source, self.base, selected_nets=['/FB'])

    def test_initial_capability_and_final_discharge_are_distinct_and_deterministic(self):
        capability = self.admit()
        self.assertEqual(capability['status'], 'pending_native')
        self.assertEqual(capability['required_count'], 2)
        self.assertFalse(capability['dsn_covered'])
        self.assertEqual(capability['initial']['metrics']['opens'], 1)
        self.assertFalse(capability['initial']['metrics']['parity_checked'])
        self.assertIn(str(Path(thermal.native_parser.__file__).resolve()), capability['inputs'])
        actual = thermal.validate_capability(capability, self.source, self.base, selected_nets=['/FB'], required_count=2)
        self.assertEqual(actual, capability)
        final = self.discharge(capability)
        self.assertEqual(final['status'], 'passed')
        self.assertFalse(final['qualified'])
        self.assertTrue(final['configured_gate_required'])
        self.assertEqual(final, self.discharge(capability))
        with self.assertRaisesRegex(ValueError, 'opt-in'):
            self.admit(enabled=False)

    def test_policy_requires_authored_integer_error_severity_and_no_exclusions(self):
        mutations = [lambda d: d['rules'].update(min_resolved_spokes=True),
                     lambda d: d['rules'].update(min_resolved_spokes=2.0),
                     lambda d: d['rules'].update(min_resolved_spokes=0),
                     lambda d: d['rules'].pop('min_resolved_spokes'),
                     lambda d: d['rule_severities'].update(starved_thermal='warning'),
                     lambda d: d.update(drc_exclusions=['excluded-item']),
                     lambda d: d.pop('drc_exclusions')]
        for mutate in mutations:
            with self.subTest(mutation=mutate):
                value = copy.deepcopy(self.project)
                mutate(value['board']['design_settings'])
                for p in (self.source, self.base):
                    self.write(p.with_suffix('.kicad_pro'), value)
                with self.assertRaises(ValueError):
                    self.admit()

    def test_custom_thermal_or_severity_rules_and_malformed_rules_are_rejected(self):
        rules = [
            '(rule "x" (constraint min_resolved_spokes (min 1)))',
            '(rule "x" (constraint zone_connection solid))',
            '(rule "x" (constraint thermal_spoke_width (min 0.1mm)))',
            '(rule "x" (condition "A.Type == \'Pad\'") (severity ignore) (constraint clearance (min 0.2mm)))',
            '(rule "unclosed" (constraint clearance (min 0.2mm))',
        ]
        for rule in rules:
            with self.subTest(rule=rule):
                for p in (self.source, self.base):
                    p.with_suffix('.kicad_dru').write_text('(version 1)\n'+rule)
                with self.assertRaises(ValueError):
                    self.admit()

    def test_checked_fill_must_be_true_saved_and_candidate_bound(self):
        original = json.loads(self.initial_fill.read_text())
        for patch in [dict(fill_result=False), dict(fill_result=1), dict(pcbnew_version='10.0.5'),
                      dict(invocation={'operation': 'ZONE_FILLER.Fill', 'saved': False}),
                      dict(candidate=self.descriptor(self.final))]:
            with self.subTest(patch=patch):
                self.write(self.initial_fill, dict(original, **patch))
                with self.assertRaises(ValueError):
                    self.admit()

    def test_hidden_refill_wrong_command_or_unsuccessful_drc_is_rejected(self):
        original = json.loads(self.initial_drc.read_text())
        invalid = [dict(returncode=1), dict(returncode=True),
            dict(command=original['command']+['--refill-zones']),
            dict(command=[v for v in original['command'] if v != '--severity-all']),
            dict(command=original['command'][:-1]+[str(self.final)])]
        for patch in invalid:
            with self.subTest(patch=patch):
                self.write(self.initial_drc, dict(original, **patch))
                with self.assertRaises(ValueError):
                    self.admit()

    def test_any_thermal_severity_or_exclusion_is_fatal(self):
        original = json.loads(self.initial_report.read_text())
        for severity in ['error', 'warning', 'exclusion']:
            with self.subTest(severity=severity):
                self.write(self.initial_report, original)
                self.report_mutation(self.initial_report, self.initial_drc,
                    lambda d: d.update(violations=[{'type': 'starved_thermal', 'severity': severity}]))
                with self.assertRaisesRegex(ValueError, 'thermal/excluded'):
                    self.admit()
        self.write(self.initial_report, original)
        self.report_mutation(self.initial_report, self.initial_drc,
            lambda d: d.update(ignored_checks=[{'key': 'starved_thermal'}]))
        with self.assertRaisesRegex(ValueError, 'ignored'):
            self.admit()

    def test_initial_opens_use_native_uuid_net_mapping_not_report_descriptions(self):
        row = self.open_row('fb-a', 'gnd-a')
        for item in row['items']:
            item['description'] = 'Pad [/FB] (misleading diagnostic text)'
        self.report_mutation(self.initial_report, self.initial_drc,
            lambda d: d.update(unconnected_items=[row]))
        with self.assertRaisesRegex(ValueError, 'selected native nets'):
            self.admit()
        self.report_mutation(self.initial_report, self.initial_drc,
            lambda d: d.update(unconnected_items=[self.open_row('fb-a', 'missing-uuid')]))
        with self.assertRaises(ValueError):
            self.admit()

    def test_final_requires_zero_opens_all_errors_and_same_runtime_tools(self):
        capability = self.admit()
        original = json.loads(self.final_report.read_text())
        for key, value in [('unconnected_items', [self.open_row()]),
                           ('violations', [{'type': 'clearance', 'severity': 'error'}]),
                           ('schematic_parity', [{'type': 'extra_footprint', 'severity': 'warning'}])]:
            with self.subTest(key=key):
                self.write(self.final_report, original)
                self.report_mutation(self.final_report, self.final_drc, lambda d: d.update({key: value}))
                with self.assertRaises(ValueError):
                    self.discharge(capability)
        self.write(self.final_report, original)
        self.mutate(self.final_drc, lambda d: d.update(report=self.descriptor(self.final_report)))
        replacement = self.root/'different-cli'
        replacement.write_text('a different native runtime')
        def replace(d):
            d['tool'] = self.descriptor(replacement)
            d['command'][0] = str(replacement)
        self.mutate(self.final_drc, replace)
        with self.assertRaisesRegex(ValueError, 'runtime tools'):
            self.discharge(capability)

    def test_capability_reopens_raw_files_and_rejects_scope_or_seal_tamper(self):
        capability = self.admit()
        with self.assertRaises(ValueError):
            thermal.validate_capability(capability, self.source, self.base, selected_nets=['GND'])
        with self.assertRaises(ValueError):
            thermal.validate_capability(capability, self.source, self.base, selected_nets=['/FB'], required_count=3)
        forged = dict(capability, status='passed')
        forged.pop('content_sha256')
        forged['content_sha256'] = thermal._identity(forged)
        with self.assertRaises(ValueError):
            thermal.validate_capability(forged, self.source, self.base, selected_nets=['/FB'])
        self.initial_report.write_text(self.initial_report.read_text()+' ')
        with self.assertRaises(ValueError):
            self.discharge(capability)

    def test_source_alias_is_content_checked_but_not_a_live_discharge_dependency(self):
        capability = self.admit()
        alias = self.root/'promoted-workspace.kicad_pcb'
        alias.write_bytes(self.source.read_bytes())
        for suffix in ('.kicad_pro', '.kicad_dru'):
            alias.with_suffix(suffix).write_bytes(self.source.with_suffix(suffix).read_bytes())
        actual = thermal.validate_capability(capability, alias, self.base, selected_nets=['/FB'])
        self.assertEqual(actual, capability)
        self.assertNotIn(str(alias), actual['inputs'])
        alias.write_text(self.board+'\n')
        with self.assertRaisesRegex(ValueError, 'immutable thermal source'):
            thermal.validate_capability(capability, alias, self.base, selected_nets=['/FB'])
        self.assertEqual(self.discharge(capability)['status'], 'passed')

    def test_missing_stale_candidate_changed_policy_and_source_tools_are_rejected(self):
        capability = self.admit()
        self.final.write_text(self.board+'\n')
        with self.assertRaises(ValueError):
            self.discharge(capability)
        self.final.write_text(self.board)
        value = copy.deepcopy(self.project)
        value['board']['design_settings']['rules']['min_resolved_spokes'] = 3
        self.write(self.final.with_suffix('.kicad_pro'), value)
        with self.assertRaisesRegex(ValueError, 'project or DRU'):
            self.discharge(capability)
        self.write(self.final.with_suffix('.kicad_pro'), self.project)
        self.cli.write_text('changed in place')
        with self.assertRaises(ValueError):
            self.discharge(capability)
        self.initial_fill.unlink()
        with self.assertRaises(ValueError):
            self.admit()

    def test_zero_initial_opens_is_permitted_but_missing_native_scope_is_not(self):
        self.report_mutation(self.initial_report, self.initial_drc,
            lambda d: d.update(unconnected_items=[]))
        self.assertEqual(self.admit()['initial']['metrics']['opens'], 0)
        with self.assertRaisesRegex(ValueError, 'absent'):
            self.admit(selected_nets=['/NOT_PRESENT'])

    def test_report_completeness_and_unsupported_runtime_fail_closed(self):
        original = json.loads(self.initial_report.read_text())
        for change in [dict(included_severities=['error']), dict(kicad_version='10.0.7'),
                       dict(source='different.kicad_pcb'), dict(violations=None),
                       dict(ignored_checks=[{'bad': 'unknown'}])]:
            with self.subTest(change=change):
                self.write(self.initial_report, dict(original, **change))
                self.mutate(self.initial_drc, lambda d: d.update(report=self.descriptor(self.initial_report)))
                with self.assertRaises(ValueError):
                    self.admit()


if __name__ == '__main__':
    unittest.main()
