"""Qualification fixtures: exact native bindings, stale proofs and measured data.

Recorded gate fixtures exercise proof contracts; fake-tool integration exercises
the real source-native runner. Neither constitutes PCB qualification evidence.
"""
import csv
import json
import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest import mock

import block_qualification as qualification
import block_reuse
from pcb_search.block_bindings import bind_instance
from pcb_search.contracts import fingerprint
from test_pcb_search_block_bindings import fp


class QualificationTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix='block-proof-')
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name).resolve()
        self.library = self.root / 'blocks'
        self.block = self.library / 'MODULE.kicad_block'
        self.block.mkdir(parents=True)
        self.source = self.block / 'MODULE.kicad_pcb'
        self.source.write_text('(kicad_pcb ' + fp('U1', '/one', 'VIN', '2 3', 0) + ')')
        self.facts = dict(level=0, ports=[dict(name='VIN', net='VIN', limits='2.5..5.5 V; datasheet p.1')],
                          layout_rules=[dict(rule='Input bypass on same layer beside VIN', source='datasheet p.2')])
        (self.block / 'facts.json').write_text(json.dumps(self.facts))
        self.board = self.root / 'hardware-design/boards/X'
        self.target = self.board / 'cad/X.kicad_pcb'
        self.target.parent.mkdir(parents=True)
        self.target.write_text('(kicad_pcb ' + fp('U8', '/instance/one', '+3V3', '12 13', 0) + ')')
        for pcb in (self.source, self.target):
            for extension in ('.kicad_sch', '.kicad_pro', '.kicad_dru'):
                pcb.with_suffix(extension).write_text('(kicad_sch)' if extension == '.kicad_sch' else '{}')
        self.config = dict(project='cad/X', checks=dict(erc=True, drc=True, paths='current-paths.json',
                                                     viapads={}, kicad_happy={}, port_labels=True))
        self.config_file = self.board / 'gate.json'
        self.write(self.config_file, self.config)
        self.binding = bind_instance(self.block, self.target, '/instance')
        self.binding_file = self.root / 'binding.json'
        self.write(self.binding_file, self.binding)
        self.binary = self.root / 'fake-kicad'
        self.binary.write_text('#!' + sys.executable + '\n' + '''import json, pathlib, sys
a=sys.argv[1:]
if a==['--version']: print('10.0.6'); sys.exit(0)
out=pathlib.Path(a[a.index('-o')+1])
out.write_text(json.dumps({'sheets':[{'violations':[]}]} if a[0]=='sch' else
 {'violations':[], 'schematic_parity':[], 'unconnected_items':[]}))
''')
        self.binary.chmod(0o755)
        self.native_dir = self.root / 'source-native'
        self.native_dir.mkdir()
        self.native_result = self.native_fixture(self.native_dir)
        self.run = self.root / 'target-run'
        self.gate_fixture()
        self.review = self.root / 'review.md'
        self.review.write_text('Fixture attributed engineering review: VIN 3.3 V; bypass and returns inspected.\n')
        self.datasheet = self.root / 'manufacturer.pdf'
        self.datasheet.write_bytes(b'%PDF-fixture original manufacturer evidence')
        self.write(str(self.datasheet) + '.source.json', dict(sha256=qualification.sha(self.datasheet),
                   source_url='https://manufacturer.example/datasheet.pdf', fetched_at_utc='2026-10-15T12:00:00Z'))
        self.stock = self.root / 'jlc.json'
        self.write(self.stock, dict(source_url='https://jlcpcb.com/api/catalog', fetched_at_utc='2026-10-15T12:00:00Z',
                   record=dict(componentCode='C123', componentModelEn='ABC', stockCount=12)))
        review = dict(verdict='pass', reviewer='Fixture engineer', reviewed_at='2026-10-15T12:00:00Z',
                      evidence=self.artifact(self.review, locator='VIN review'))
        self.proof = dict(schema='iot-lab.block-evidence.v1', binding_sha256=fingerprint(self.binding),
                          source_native=str(self.native_dir / 'result.json'), target_run=str(self.run),
                          reviews=dict(operating_limits=dict(VIN=dict(review, target_conditions='3.3 V, ambient 25 C')),
                                       layout_rules={'0': review}, stackup_and_rules=review,
                                       boundary_and_returns=review, ground_and_isolation=review),
                          parts=dict(U1=dict(mpn='ABC', lcsc='C123', datasheet=self.artifact(self.datasheet),
                                             jlc_assembly=self.artifact(self.stock), pinout_and_land_pattern=review)))
        self.proof_file = self.root / 'evidence.json'
        self.write(self.proof_file, self.proof)

    def write(self, path, value):
        Path(path).write_text(json.dumps(value, indent=2))

    def artifact(self, path, **extra):
        return dict(path=str(path), sha256=qualification.sha(path), **extra)

    def native_fixture(self, output):
        checks = {}
        for name in ('erc', 'drc'):
            self.write(output / (name + '.json'), dict(sheets=[dict(violations=[])]) if name == 'erc' else
                       dict(violations=[], schematic_parity=[], unconnected_items=[]))
            (output / (name + '.log')).write_text('fixture invocation completed\n')
            command = ([str(self.binary), 'sch', 'erc', '--format', 'json', '--severity-all', '--units', 'mm'] if name == 'erc' else
                       [str(self.binary), 'pcb', 'drc', '--schematic-parity', '--refill-zones', '--format', 'json', '--severity-all', '--units', 'mm'])
            command += ['-o', str(output / (name + '.json')), str(self.source.with_suffix('.kicad_sch') if name == 'erc' else self.source)]
            checks[name] = dict(command=command, exit_code=0, cleanup=dict(complete=True),
                                report_sha256=qualification.sha(output / (name + '.json')),
                                log_sha256=qualification.sha(output / (name + '.log')))
        result = dict(schema='iot-lab.block-native.v1', block_id='MODULE', status='passed',
                      source_directory=str(self.block), source_sha256=block_reuse.read_block(self.block)['source_sha256'],
                      executable=str(self.binary), executable_sha256=qualification.sha(self.binary), tool_version='10.0.6',
                      started_at='2026-10-15T12:00:00Z', finished_at='2026-10-15T12:01:00Z',
                      checks=checks, metrics=qualification.native_metrics(output))
        self.write(output / 'result.json', result)
        return result

    def gate_fixture(self):
        gate = self.run / 'gate'
        gate.mkdir(parents=True)
        inputs = [self.config_file] + [self.target.with_suffix(ext) for ext in
                  ('.kicad_pcb', '.kicad_sch', '.kicad_pro', '.kicad_dru')]
        provenance = dict(inputs=[dict(path=str(p.relative_to(self.root)), sha256=qualification.sha(p)) for p in inputs],
                          tools=dict(kicad='10.0.6', node='fixture'))
        import hashlib
        provenance['input_sha256'] = hashlib.sha256(json.dumps(provenance, separators=(',', ':')).encode()).hexdigest()
        stage_metrics = dict(erc=dict(erc_errors=0, erc_warnings=0),
                             drc=dict(drc_errors=0, drc_parity=0, drc_unconnected=0, drc_warnings=0),
                             paths=dict(paths_low=0), viapads=dict(viapads=0),
                             kicad_happy=dict(kicad_happy_findings=0), port_labels=dict(port_label_failures=0))
        metrics = {k: v for values in stage_metrics.values() for k, v in values.items()}
        self.write(self.run / 'run.json', dict(board='X', root=str(self.root),
                   command=['node', str(self.root / 'tools/gate.mjs'), 'X', '--evidence-dir', str(gate)]))
        self.write(self.run / 'result.json', dict(status='passed', exit_code=0, scope='configured_board_gate',
                   cleanup=dict(complete=True), input_sha256=provenance['input_sha256'], metrics=metrics))
        self.write(gate / 'result.json', dict(exit=0, changedDuringRun=False, metrics=metrics, provenance=provenance))
        self.write(gate / 'erc.json', dict(sheets=[dict(violations=[])]))
        self.write(gate / 'drc.json', dict(violations=[], schematic_parity=[], unconnected_items=[]))
        (gate / 'events.jsonl').write_text(''.join(json.dumps(dict(type='check.end', stage=stage, status='passed', metrics=values)) + '\n'
               for stage, values in stage_metrics.items()) + json.dumps(dict(type='gate.end', exit=0)) + '\n')

    def qualify(self, bench=None):
        return qualification.qualify(self.library, 'MODULE', self.binding_file, self.proof_file, self.root, bench)

    def test_complete_proof_derives_gate_level_without_changing_facts(self):
        receipt = self.qualify()
        self.assertEqual((receipt['level'], receipt['qualification']), (1, 'gate_verified'))
        self.assertEqual(json.loads((self.block / 'facts.json').read_text())['level'], 0)
        path = self.root / 'receipt.json'
        self.write(path, receipt)
        self.assertEqual(qualification.status(path)['status'], 'current')

    def test_source_change_invalidates_receipt_and_binding(self):
        path = self.root / 'receipt.json'
        self.write(path, self.qualify())
        (self.block / 'MODULE.kicad_dru').write_text('changed rule')
        self.assertEqual(qualification.status(path)['qualification'], 'draft')
        with self.assertRaisesRegex(ValueError, 'stale'):
            self.qualify()

    def test_retrieval_uses_receipt_only_for_exact_recorded_target(self):
        path = self.root / 'receipt.json'
        self.write(path, self.qualify())
        self.assertEqual(block_reuse.reuse(self.library, 'MODULE')['qualification'], 'unverified_for_target')
        row = block_reuse.reuse(self.library, 'MODULE', receipt=path)
        self.assertEqual(row['qualification'], 'gate_verified')
        self.assertEqual(row['qualification_target']['instance_path'], '/instance')
        self.review.write_text('changed review')
        with self.assertRaisesRegex(ValueError, 'stale'):
            block_reuse.reuse(self.library, 'MODULE', receipt=path)

    def test_changed_operating_review_or_native_artifact_invalidates_receipt(self):
        path = self.root / 'receipt.json'
        self.write(path, self.qualify())
        self.review.write_text('changed target conditions')
        self.assertEqual(qualification.status(path)['level'], 0)
        (self.native_dir / 'drc.json').write_text('{}')
        with self.assertRaisesRegex(ValueError, 'artifact changed'):
            self.qualify()

    def test_missing_operating_conditions_or_unsupported_requirements_cannot_promote(self):
        for change, reason in [(lambda p: p['reviews']['operating_limits']['VIN'].pop('target_conditions'), 'operating conditions'),
                               (lambda p: p['reviews'].pop('operating_limits'), 'every exact block port'),
                               (lambda p: p.update(unsupported=['unverified isolation']), 'unsupported')]:
            proof = json.loads(json.dumps(self.proof))
            change(proof)
            self.write(self.proof_file, proof)
            with self.assertRaisesRegex(ValueError, reason):
                self.qualify()

    def test_actual_native_mpn_pad_and_instance_changes_are_rejected(self):
        original = self.target.read_text()
        for old, new in [('"ABC"', '"OTHER"'), ('(size 1 2)', '(size 1 1)'), ('/instance/one', '/other/one')]:
            self.target.write_text(original.replace(old, new))
            with self.assertRaises(ValueError):
                self.qualify()
        self.target.write_text(original)

    def test_missing_source_native_or_incomplete_target_gate_cannot_promote(self):
        (self.native_dir / 'erc.log').unlink()
        with self.assertRaises(FileNotFoundError):
            self.qualify()
        (self.native_dir / 'erc.log').write_text('fixture invocation completed\n')
        event_path = self.run / 'gate/events.jsonl'
        event_path.write_text('\n'.join(line for line in event_path.read_text().splitlines() if 'paths' not in line) + '\n')
        with self.assertRaisesRegex(ValueError, 'complete successful configured check'):
            self.qualify()

    def test_gate_accepts_explicit_fresh_in_any_order_and_rejects_incremental(self):
        path = self.run / 'run.json'
        manifest = json.loads(path.read_text())
        manifest['command'] = ['node', str(self.root / 'tools/gate.mjs'), '--fresh', '--evidence-dir', str(self.run / 'gate'), 'X']
        self.write(path, manifest)
        self.assertEqual(self.qualify()['level'], 1)
        for flag in ('--changed', '--ratchet', '--write', '--config'):
            self.write(path, dict(manifest, command=manifest['command'] + [flag]))
            with self.assertRaisesRegex(ValueError, 'unsupported gate mode'):
                self.qualify()
        self.write(path, manifest)
        raw_path = self.run / 'gate/result.json'
        raw = json.loads(raw_path.read_text())
        raw['cache'] = dict(enabled=True, hits=1)
        self.write(raw_path, raw)
        with self.assertRaisesRegex(ValueError, 'cached checks cannot promote'):
            self.qualify()

    def test_previously_absent_gate_dependency_appearing_invalidates_receipt(self):
        path = self.run / 'gate/result.json'
        raw = json.loads(path.read_text())
        raw['provenance']['inputs'].append(dict(path='previously-missing.json', sha256=None))
        import hashlib
        raw['provenance']['input_sha256'] = hashlib.sha256(json.dumps(
            {key: raw['provenance'][key] for key in ('inputs', 'tools')}, separators=(',', ':')).encode()).hexdigest()
        self.write(path, raw)
        result_path = self.run / 'result.json'
        result = json.loads(result_path.read_text())
        result['input_sha256'] = raw['provenance']['input_sha256']
        self.write(result_path, result)
        receipt_path = self.root / 'receipt.json'
        self.write(receipt_path, self.qualify())
        (self.root / 'previously-missing.json').write_text('new dependency')
        self.assertEqual(qualification.status(receipt_path)['qualification'], 'draft')

    def test_different_target_and_disabled_electrical_gate_cannot_promote(self):
        manifest = json.loads((self.run / 'run.json').read_text())
        manifest['board'] = 'OTHER'
        self.write(self.run / 'run.json', manifest)
        with self.assertRaises(OSError):
            self.qualify()
        manifest['board'] = 'X'
        self.write(self.run / 'run.json', manifest)
        self.config['checks']['paths'] = False
        self.write(self.config_file, self.config)
        with self.assertRaisesRegex(ValueError, 'omits required'):
            self.qualify()

    def test_inventory_requires_symbol_identity_and_reports_flat_board(self):
        row = qualification.inventory(self.root, self.library, 'X')
        self.assertEqual(row['instances'][0]['block_id'], 'MODULE')
        self.assertEqual(row['instances'][0]['status'], 'bound_draft')
        self.target.write_text(self.target.read_text().replace('/instance/one', '/different/new'))
        self.assertEqual(qualification.inventory(self.root, self.library, 'X')['authoritative_instances'], 0)
        self.target.write_text(self.target.read_text().replace('/different/new', '/flat'))
        self.assertIn('paths are flat', qualification.inventory(self.root, self.library, 'X')['cause'])

    def test_source_native_runner_records_real_owned_invocations(self):
        output = self.root / 'executed-native'
        with mock.patch.dict(os.environ, KICAD_CLI=str(self.binary)):
            report = qualification.native(self.block, output, timeout=10)
        self.assertEqual(report['status'], 'passed', report)
        self.assertTrue(report['checks']['drc']['cleanup']['complete'])
        qualification.verify_native(output / 'result.json', block_reuse.read_block(self.block), qualification.Evidence())

    def test_source_native_runner_refuses_existing_or_in_source_evidence(self):
        with self.assertRaisesRegex(ValueError, 'outside'):
            qualification.native(self.block, self.block / 'results')
        with mock.patch.dict(os.environ, KICAD_CLI=str(self.binary)), self.assertRaises(FileExistsError):
            qualification.native(self.block, self.native_dir)

    def bench_fixture(self, value='3.3'):
        plan = self.root / 'bench-plan.json'
        review_artifact = self.artifact(self.review, locator='VIN acceptance criterion')
        self.write(plan, dict(schema='iot-lab.block-bench-plan.v1', binding_sha256=fingerprint(self.binding),
                   approved_by='Fixture engineer', approved_at='2026-10-15T12:00:00Z',
                   tests=[dict(id='vin', requirement='VIN operating voltage', unit='V', min=2.5, max=5.5, source=review_artifact)]))
        self.proof['bench_plan'] = self.artifact(plan)
        self.write(self.proof_file, self.proof)
        raw = self.root / 'raw.csv'
        with raw.open('w', newline='') as stream:
            writer = csv.DictWriter(stream, fieldnames=['test_id', 'value', 'unit', 'instrument_id'])
            writer.writeheader()
            writer.writerow(dict(test_id='vin', value=value, unit='V', instrument_id='meter-1'))
        measured = self.root / 'measured.json'
        self.write(measured, dict(schema='iot-lab.block-bench.v1', binding_sha256=fingerprint(self.binding),
                   operator='Fixture operator', measured_at='2026-10-15T12:00:00Z', board_serial='FIXTURE-ONLY',
                   instruments=[dict(id='meter-1', calibration_evidence=review_artifact)], raw_data=self.artifact(raw)))
        return measured

    def test_bench_level_requires_attributed_raw_measurements_against_sourced_plan(self):
        measured = self.bench_fixture()
        receipt = self.qualify(measured)
        self.assertEqual((receipt['level'], receipt['qualification']), (2, 'bench_validated'))
        self.assertEqual(receipt['bench']['board_serial'], 'FIXTURE-ONLY')
        self.bench_fixture(value='9')
        with self.assertRaisesRegex(ValueError, 'outside sourced limits'):
            self.qualify(measured)

    def test_unattributed_or_missing_bench_evidence_does_not_promote(self):
        measured = self.bench_fixture()
        report = json.loads(measured.read_text())
        report.pop('operator')
        self.write(measured, report)
        with self.assertRaisesRegex(ValueError, 'attributable measured'):
            self.qualify(measured)
        (self.root / 'raw.csv').unlink()
        with self.assertRaises((ValueError, FileNotFoundError)):
            self.qualify(measured)


if __name__ == '__main__':
    unittest.main()
