"""Next decisions never manufacture current evidence or assembly readiness."""
import json
import os
from pathlib import Path
import signal
import sys
import tempfile
import time
import unittest
from unittest import mock

import pcb_evidence
import pcb_next
import pcb_workflow


def write(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, indent=2) + '\n')


def complete_context(root):
    for source in pcb_workflow.context(root, 'X')['source_files']:
        path = root / source['path']
        if not path.exists():
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text('Fixture context source\n')


class NextTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix='pcb-next-')
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name).resolve()
        self.board = self.root / 'hardware-design/boards/X'
        self.runs = self.root / '.gate/cli'
        self.project = self.board / 'cad/X'
        self.config = dict(project='cad/X', stage='G3', checks=dict(erc=True, drc=True))
        write(self.board / 'gate.json', self.config)
        for extension in ('.kicad_pcb', '.kicad_sch', '.kicad_pro', '.kicad_dru'):
            path = self.project.with_suffix(extension)
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text('fixture ' + extension)
        complete_context(self.root)
        self.fingerprint = 'a' * 64
        self.probe = mock.patch.object(pcb_next, 'verify_current_inputs', return_value=dict(
            verified=True, input_sha256=self.fingerprint, release_supported=True))
        self.verified = self.probe.start()
        self.addCleanup(self.probe.stop)

    def make_run(self, name='run-latest', *, status='passed', created='2026-10-15T12:00:00Z', operation='check', board='X', cached=False):
        folder = self.runs / name
        folder.mkdir(parents=True)
        manifest = dict(schema_version=1, run_id=name, root=str(self.root), board=board, project='cad/X',
                        created_at=created, operation=operation, gate_config_sha256=pcb_workflow.sha(self.board / 'gate.json'))
        if operation == 'readiness':
            manifest.update(board='ASSEMBLY', project=None, arguments=['X', '/fixture/candidate'])
        write(folder / 'run.json', manifest)
        write(folder / 'state.json', dict(status=status, updated_unix=time.time(), run_id=name))
        (folder / 'worker.lock').touch()
        metric_groups = dict(erc=dict(erc_errors=0, erc_warnings=0),
                             drc=dict(drc_errors=0 if status == 'passed' else 1, drc_warnings=0, drc_parity=0, drc_unconnected=0))
        metrics = {key: value for values in metric_groups.values() for key, value in values.items()}
        checks = {stage: dict(status='failed' if status == 'failed' and stage == 'drc' else 'passed', metrics=values, cached=cached)
                  for stage, values in metric_groups.items()}
        provenance = dict(input_sha256=self.fingerprint, inputs=[dict(path=str(self.project.with_suffix('.kicad_pcb').relative_to(self.root)),
                          sha256=pcb_workflow.sha(self.project.with_suffix('.kicad_pcb')))], tools=dict(kicad='fixture'))
        raw = dict(exit=0 if status == 'passed' else 1, changedDuringRun=False, metrics=metrics, checks=checks,
                   provenance=provenance, cache=dict(enabled=cached, hits=2 if cached else 0))
        write(folder / 'gate/result.json', raw)
        finding = dict(id='fixture-clearance', stage='drc', rule='clearance', severity='error',
                       message='U3.4 violates sourced clearance', refs=['U3'], pads=[dict(ref='U3', pad='4')],
                       location=dict(x=12.5, y=8, unit='mm'), evidence=dict(path='drc.json', pointer='/violations/0'))
        write(folder / 'gate/findings.json', dict(schema_version=1, board=board, project='cad/X',
              inputs_valid=True, input_sha256=self.fingerprint, complete=True, completed_checks=['erc', 'drc'],
              findings=[finding] if status == 'failed' else []))
        write(folder / 'gate/erc.json', dict(sheets=[dict(violations=[])]))
        write(folder / 'gate/drc.json', dict(violations=[], schematic_parity=[], unconnected_items=[]))
        (folder / 'gate/events.jsonl').write_text('{}\n')
        for stage in ('erc', 'drc'):
            (folder / 'gate' / (stage + '.log')).write_text('fixture checker log\n')
        result = dict(status=status, cleanup=dict(complete=True), input_sha256=self.fingerprint, metrics=metrics)
        if operation in {'build', 'edit', 'route'}:
            candidate = folder / 'workspace/hardware-design/boards/X/cad/X.kicad_pcb'
            candidate.parent.mkdir(parents=True)
            candidate.write_text('candidate fixture')
            write(folder / 'operation/source.json', dict(board='X', files={'fixture': 'hash'}, sha256='fixture-source'))
            write(folder / 'operation/result.json', dict(candidate=str(candidate)))
            result.update(candidate_verified=True, identity_preserved=True, source_unchanged=True)
        if operation == 'readiness':
            path = folder / 'operation/readiness.log'
            path.parent.mkdir(parents=True)
            path.write_text('{"status":"ready_for_user_review"}\n')
        self.seal(folder, result)
        return folder

    def seal(self, folder, result=None):
        result = result or json.loads((folder / 'result.json').read_text())
        result['evidence_sha256'] = pcb_evidence.evidence_files(folder)
        write(folder / 'result.json', result)

    def next(self):
        return pcb_next.next_action(self.root, 'X', self.runs)

    def test_dated_stock_expires_even_when_original_receipts_are_unchanged(self):
        folder = self.make_run(operation='parts')
        native = self.project.with_suffix('.kicad_pcb')
        report = dict(schema='iot-lab.part-evidence.v1', board='X', scope='assembly_stock_observation',
                      status='passed', qualified=False, stock_current=True, order_day_utc='2000-01-01',
                      candidate=str(self.root / 'candidate'), boards=2,
                      population_source=dict(path=str(self.board/'variants.json'),exists=False,sha256=None))
        write(folder / 'operation/report.json', report)
        terminal = json.loads((folder / 'result.json').read_text())
        terminal.update(engineering_inputs={str(native): pcb_workflow.sha(native)})
        self.seal(folder, terminal)
        result = self.next()
        self.assertEqual(result['state'], 'needs_stock_refresh')
        self.assertFalse(result['blocker']['stock_current'])
        argv = result['next_action']['argv']
        self.assertIn('stock', argv)
        self.assertEqual(argv[argv.index('--boards') + 1], '2')
        self.assertNotEqual(argv[-1], str(self.root / 'candidate'))
        self.verified.assert_not_called()

    def test_new_variant_population_invalidates_unchanged_stock_observation(self):
        folder=self.make_run(operation='parts')
        native=self.project.with_suffix('.kicad_pcb')
        population=self.board/'variants.json'
        report=dict(schema='iot-lab.part-evidence.v1',board='X',scope='assembly_stock_observation',
            status='observed',qualified=False,stock_current=True,
            order_day_utc=pcb_next.dt.datetime.now(pcb_next.dt.timezone.utc).date().isoformat(),
            population_source=dict(path=str(population),exists=False,sha256=None))
        write(folder/'operation/report.json',report)
        terminal=json.loads((folder/'result.json').read_text())
        terminal['engineering_inputs']={str(native):pcb_workflow.sha(native)}
        self.seal(folder,terminal)
        self.assertEqual(self.next()['evidence']['freshness'],'current')
        write(population,dict(variants=['FULL'],fit={'U1':['FULL']}))
        result=self.next()
        self.assertEqual(result['evidence']['freshness'],'stale')
        self.assertIn('population source',result['evidence']['cause'])
        self.assertNotEqual(result['state'],'review')
        self.verified.assert_not_called()

    def test_changed_engineering_input_cannot_recommend_a_repair(self):
        folder = self.make_run(operation='routing')
        native = self.project.with_suffix('.kicad_pcb')
        write(folder / 'operation/report.json', dict(schema='iot-lab.route-decision.v1',
              status='repairable', qualified=False))
        terminal = json.loads((folder / 'result.json').read_text())
        terminal.update(engineering_inputs={str(native): pcb_workflow.sha(native)})
        self.seal(folder, terminal)
        self.assertEqual(self.next()['next_action']['kind'], 'repair')
        native.write_text('changed CAD')
        result = self.next()
        self.assertNotEqual(result['next_action']['kind'], 'repair')
        self.assertEqual(result['evidence']['freshness'], 'stale')

    def test_parent_diagnosis_cannot_recommend_repair_after_canonical_sources_change(self):
        import pcb_operations
        native=self.project.with_suffix('.kicad_pcb')
        native.write_text('(kicad_pcb (version 20260101))')
        def source_state(root,board,extra_inputs=None):
            # Small exact input closure avoids the native dependency resolver;
            # parent_candidate's receipt/identity/source checks remain real.
            files={str(self.project.with_suffix(ext).relative_to(self.root)):pcb_workflow.sha(self.project.with_suffix(ext))
                   for ext in ('.kicad_pcb','.kicad_pro','.kicad_dru','.kicad_sch')}
            return dict(board=board,files=files,sha256=pcb_workflow.sha(native))
        parent=self.make_run('run-parent',status='failed',operation='edit',created='2026-10-15T11:00:00Z')
        candidate=parent/'workspace'/native.relative_to(self.root)
        candidate.write_bytes(native.read_bytes())
        write(parent/'workspace'/self.board.relative_to(self.root)/'gate.json',self.config)
        write(parent/'operation/source.json',source_state(self.root,'X'))
        write(parent/'operation/result.json',dict(candidate=str(candidate),candidate_sha256=pcb_workflow.sha(candidate),
            identity_preserved=True,source_unchanged=True,protected_source_changes=[]))
        self.seal(parent)
        reference=dict(folder=str(parent),result_sha256=pcb_workflow.sha(parent/'result.json'))
        diagnosis=self.make_run(operation='routing')
        manifest=json.loads((diagnosis/'run.json').read_text());manifest['from_run']=reference
        write(diagnosis/'run.json',manifest)
        write(diagnosis/'operation/report.json',dict(schema='iot-lab.route-decision.v1',status='repairable',qualified=False))
        observed={str(parent/name):digest for name,digest in pcb_evidence.evidence_files(parent).items()}
        observed[str(parent/'result.json')]=reference['result_sha256']
        terminal=json.loads((diagnosis/'result.json').read_text());terminal['engineering_inputs']=observed
        self.seal(diagnosis,terminal)
        with mock.patch.object(pcb_operations,'source_state',side_effect=source_state):
            self.assertEqual(self.next()['next_action']['kind'],'repair')
            self.project.with_suffix('.kicad_dru').write_text('changed canonical rule after diagnosis')
            result=self.next()
        self.assertNotEqual(result['next_action']['kind'],'repair')
        self.assertEqual(result['evidence']['freshness'],'stale')
        self.assertIn('canonical inputs changed',result['evidence']['cause'])
        self.verified.assert_not_called()

    def test_missing_native_input_names_the_exact_path_without_a_tool_probe(self):
        self.project.with_suffix('.kicad_sch').unlink()
        report = self.next()
        self.assertEqual(report['blocker']['code'], 'missing_native_input')
        self.assertEqual(report['blocker']['evidence']['path'], str(self.project.with_suffix('.kicad_sch')))
        self.assertFalse(report['readiness_verified'])
        self.verified.assert_not_called()

    def test_current_cli_receipt_supersedes_failed_legacy_pointer(self):
        legacy = self.board / '.gate/old'
        write(legacy / 'result.json', dict(exit=1, metrics=dict(drc_errors=99)))
        write(legacy.parent / 'latest.json', dict(run='old'))
        folder = self.make_run()
        report = self.next()
        self.assertEqual(report['observed_run']['run_id'], folder.name)
        self.assertEqual(report['evidence']['freshness'], 'current')
        self.assertEqual(report['blocker']['code'], 'release_evidence_missing')
        self.assertEqual(report['next_action']['argv'], ['tools/pcb', 'release', 'X', '--follow', '--json'])
        self.assertFalse(any(b['rule'] == 'previous_gate_failed' for b in report['context_blockers']))

    def test_legacy_evidence_alone_never_becomes_current(self):
        legacy = self.board / '.gate/old'
        write(legacy / 'result.json', dict(exit=0, metrics=dict(drc_errors=0)))
        write(legacy.parent / 'latest.json', dict(run='old'))
        report = self.next()
        self.assertEqual(report['evidence']['freshness'], 'unverified_legacy')
        self.assertEqual(report['next_action']['kind'], 'check')
        self.verified.assert_not_called()

    def test_other_board_or_revision_does_not_shadow_latest_matching_run(self):
        self.make_run('run-ours')
        other = self.make_run('run-other', board='Y', created='2026-10-15T13:00:00Z')
        revision = self.make_run('run-revision', created='2026-10-15T14:00:00Z')
        manifest = json.loads((revision / 'run.json').read_text())
        manifest['project'] = 'cad/X-B'
        write(revision / 'run.json', manifest)
        self.assertEqual(self.next()['observed_run']['run_id'], 'run-ours')

    def test_completed_failed_stage_reports_exact_finding_and_native_location(self):
        self.make_run(status='failed')
        report = self.next()
        self.assertEqual(report['blocker']['finding_id'], 'fixture-clearance')
        self.assertEqual(report['blocker']['pads'], [dict(ref='U3', pad='4')])
        self.assertEqual(report['blocker']['location']['x'], 12.5)
        self.assertEqual(report['next_action']['kind'], 'inspect_finding')
        self.assertEqual(report['blocker']['evidence']['pointer'], '/violations/0')

    def test_failed_native_stage_remains_actionable_when_dependents_are_blocked(self):
        self.config.update(stage='G4', checks=dict(erc=True, drc=True, paths='current-paths.json'))
        write(self.board / 'gate.json', self.config)
        folder = self.make_run(status='failed')
        raw = json.loads((folder / 'gate/result.json').read_text())
        raw['checks']['paths'] = dict(status='blocked', metrics=dict(paths_low=None))
        raw['metrics']['paths_low'] = None
        write(folder / 'gate/result.json', raw)
        findings = json.loads((folder / 'gate/findings.json').read_text())
        findings['complete'] = False
        write(folder / 'gate/findings.json', findings)
        self.seal(folder)
        self.assertEqual(self.next()['blocker']['finding_id'], 'fixture-clearance')

    def test_changed_config_is_stale_and_does_not_probe_tools(self):
        self.make_run()
        self.config['stage'] = 'G4'
        write(self.board / 'gate.json', self.config)
        report = self.next()
        self.assertEqual(report['evidence']['freshness'], 'stale')
        self.assertIn('gate changed', report['blocker']['message'])
        self.verified.assert_not_called()

    def test_corrupted_native_artifact_is_invalid_and_cannot_recommend_release(self):
        folder = self.make_run()
        (folder / 'gate/drc.json').write_text('{}')
        report = self.next()
        self.assertEqual(report['evidence']['freshness'], 'invalid')
        self.assertEqual(report['next_action']['kind'], 'check')
        self.verified.assert_not_called()

    def test_missing_native_evidence_cannot_be_treated_as_a_pass(self):
        folder = self.make_run()
        (folder / 'gate/erc.json').unlink()
        report = self.next()
        self.assertEqual(report['next_action']['kind'], 'check')
        self.assertIn('evidence changed: gate/erc.json', report['blocker']['message'])
        self.verified.assert_not_called()

    def test_g5_next_check_requires_the_fresh_mode_accepted_by_the_gate(self):
        self.config['stage'] = 'G5'
        write(self.board / 'gate.json', self.config)
        self.assertEqual(self.next()['next_action']['argv'], ['tools/pcb', 'check', 'X', '--fresh', '--follow', '--json'])

    def test_unknown_status_and_unknown_checker_state_cannot_promote(self):
        folder = self.make_run(status='unknown')
        self.assertEqual(self.next()['blocker']['code'], 'invalid_run_state')
        state = json.loads((folder / 'state.json').read_text())
        state['status'] = 'passed'
        write(folder / 'state.json', state)
        raw = json.loads((folder / 'gate/result.json').read_text())
        raw['checks']['drc']['status'] = 'maybe'
        write(folder / 'gate/result.json', raw)
        result = json.loads((folder / 'result.json').read_text())
        result['status'] = 'passed'
        self.seal(folder, result)
        self.assertEqual(self.next()['evidence']['freshness'], 'invalid')

    def test_running_run_is_observed_instead_of_launching_duplicate_work(self):
        folder = self.make_run()
        with mock.patch('pcb_cli.status', return_value=dict(status='running', controller_alive=True, active_stages=['drc'])):
            report = self.next()
        self.assertEqual(report['state'], 'observe')
        self.assertEqual(report['next_action']['argv'], ['tools/pcb', 'events', folder.name, '--json', '--wait', '20'])
        self.verified.assert_not_called()

    def test_older_live_run_takes_precedence_over_newer_completed_run(self):
        older = self.make_run('run-running', created='2026-10-15T11:00:00Z')
        self.make_run('run-completed')
        from pcb_cli import status
        def observed(folder):
            if folder == older:
                return dict(status='running', controller_alive=True, active_stages=['drc'])
            return status(folder)
        with mock.patch('pcb_cli.status', side_effect=observed):
            report = self.next()
        self.assertEqual(report['state'], 'observe')
        self.assertEqual(report['observed_run']['run_id'], older.name)
        self.verified.assert_not_called()

    def test_cached_current_checks_do_not_grant_order_readiness(self):
        self.make_run(cached=True)
        report = self.next()
        self.assertEqual(report['evidence']['freshness'], 'current')
        self.assertEqual(report['next_action']['kind'], 'generate_release_candidate')
        self.assertFalse(report['readiness_verified'])

    def test_verified_candidate_recommends_only_explicit_adoption(self):
        folder = self.make_run(operation='edit')
        sources = json.loads((folder / 'operation/source.json').read_text())
        with mock.patch('pcb_operations.source_state', return_value=sources):
            report = self.next()
        self.assertEqual(report['next_action']['argv'], ['tools/pcb', 'adopt', folder.name, '--json'])
        self.assertTrue(report['blocker']['mutates_cad'])
        self.assertEqual(self.project.with_suffix('.kicad_pcb').read_text(), 'fixture .kicad_pcb')

    def test_frozen_candidate_names_required_defect_without_inventing_command_args(self):
        (self.root / 'FOCUS.md').write_text('# FOCUS\n## Frozen\n- X\n## Done when\nfixed\n')
        folder = self.make_run(operation='edit')
        sources = json.loads((folder / 'operation/source.json').read_text())
        with mock.patch('pcb_operations.source_state', return_value=sources):
            report = self.next()
        self.assertEqual(report['blocker']['code'], 'frozen_candidate_needs_named_defect')
        self.assertEqual(report['blocker']['required_inputs'], ['baseline_run_id', 'finding_id'])
        self.assertEqual(report['next_action']['kind'], 'inspect_candidate')

    def test_readiness_receipt_never_claims_current_order_approval(self):
        self.make_run(operation='readiness')
        report = self.next()
        self.assertEqual(report['blocker']['code'], 'readiness_requires_current_review')
        self.assertFalse(report['readiness_verified'])
        self.verified.assert_not_called()

    def test_custom_runs_directory_is_in_runnable_argv_before_forwarded_arguments(self):
        self.runs = self.root / 'runs with spaces'
        folder = self.make_run()
        report = self.next()
        self.assertEqual(report['next_action']['argv'][2:4], ['--runs-dir', str(self.runs)])
        self.assertIn("'" + str(self.runs) + "'", report['next_action']['command'])


class NextCliIntegration(unittest.TestCase):
    def test_real_gate_cached_observation_verifies_inputs_without_release_promotion(self):
        import test_pcb_workflow
        fixture = test_pcb_workflow.WorkflowTests()
        fixture.setUp()
        try:
            complete_context(fixture.root)
            for _ in range(2):
                response = fixture.fixture.cli('check', 'X', '--changed', '--json', env=fixture.env)
                self.assertEqual(response.returncode, 0, response.stdout + response.stderr)
            shown = fixture.fixture.cli('next', 'X', '--json', env=fixture.env)
            self.assertEqual(shown.returncode, 0, shown.stdout + shown.stderr)
            report = json.loads(shown.stdout)
            self.assertEqual(report['evidence']['freshness'], 'current', report)
            self.assertEqual(report['blocker']['code'], 'next_stage_unverified')
            self.assertFalse(report['readiness_verified'])
            (fixture.board / 'cad/X.kicad_pcb').write_text('changed native input')
            stale = fixture.fixture.cli('next', 'X', '--json', env=fixture.env)
            report = json.loads(stale.stdout)
            self.assertEqual(report['evidence']['freshness'], 'stale')
            self.assertIn('input changed', report['blocker']['message'])
        finally:
            fixture.tearDown()


class NextInputProcessTests(unittest.TestCase):
    def test_version_probe_timeout_stops_its_owned_descendant(self):
        with tempfile.TemporaryDirectory(prefix='pcb-next-timeout-') as directory:
            root = Path(directory)
            gate = root / 'gate'
            write(gate / 'result.json', dict(provenance=dict(inputs=[])))
            pidfile = root / 'child.pid'
            helper = root / 'fake-node'
            helper.write_text('#!' + sys.executable + '\nimport os, pathlib, time\n'
                'child = os.fork()\nif child == 0:\n '
                'pathlib.Path(' + repr(str(pidfile)) + ').write_text(str(os.getpid()))\n '
                'time.sleep(30)\nelse:\n os.waitpid(child, 0)\n')
            helper.chmod(0o755)
            deadline = pcb_next.lean.deadline_after(0.4)
            try:
                with mock.patch.object(pcb_next.shutil, 'which', return_value=str(helper)), \
                     mock.patch.object(pcb_next.lean, 'deadline_after', return_value=deadline):
                    with self.assertRaisesRegex(RuntimeError, 'owned probes stopped'):
                        pcb_next.verify_current_inputs(root, 'X', gate)
                self.assertTrue(pidfile.is_file(), 'fixture probe did not start its descendant')
                with self.assertRaises(ProcessLookupError):
                    os.kill(int(pidfile.read_text()), 0)
            finally:
                if pidfile.is_file():
                    try:
                        os.kill(int(pidfile.read_text()), signal.SIGKILL)
                    except ProcessLookupError:
                        pass


if __name__ == '__main__':
    unittest.main()
