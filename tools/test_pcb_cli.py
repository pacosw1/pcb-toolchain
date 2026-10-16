"""End-to-end CLI/real-gate fixtures. No native KiCad or board qualification claim."""
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import time
import unittest
from unittest import mock

import pcb_cli


class PcbCliTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='pcb-cli-test-')
        self.root = Path(self.temp.name)
        self.runs = self.root / '.gate/cli'
        source = Path(__file__).resolve().parent.parent
        files = ['tools/pcb', 'tools/pcb_cli.py', 'tools/lean_owned.py', 'tools/lean_owned_exec.py', 'tools/lean_workflow.py',
                 'tools/pcb_workflow.py', 'tools/pcb_operations.py', 'tools/pcb_evidence.py', 'tools/pcb_benchmark.py', 'tools/pcb_timing.py',
                 'tools/gate.mjs', 'tools/lib/env.mjs', 'tools/lib/gate-core.mjs', 'tools/lib/gate-runtime.mjs', 'tools/lib/gate-inputs.mjs',
                 'tools/lib/check-cache.mjs', 'tools/lib/gate-findings.mjs', 'tools/lib/env-paths.mjs']
        for name in files:
            target = self.root / name
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(source / name, target)
        board = self.root / 'hardware-design/boards/X'
        (board / 'cad').mkdir(parents=True)
        (board / 'gate.json').write_text(json.dumps(dict(project='cad/X', checks=dict(
            erc=True, drc=True, paths='current-paths.json', viapads={}, kicad_happy={}, port_labels=True))))
        (board / 'cad/X.kicad_pcb').write_text('original PCB')
        (board / 'cad/X.kicad_sch').write_text('original schematic')
        (board / 'current-paths.json').write_text('{}')
        (board / '.gate').mkdir()
        (board / '.gate/latest.json').write_text('prior latest pointer')
        (board / 'gate-metrics.json').write_text('prior tracked metrics')
        self.board = board
        fake = self.root / 'fake-tool'
        fake.write_text('#!' + sys.executable + '\n' + r'''
import json, os, pathlib, subprocess, sys, time
a = sys.argv[1:]
if '--version' in a or (a and a[0] == '-c'):
    print('10.0.6'); sys.exit(0)
if a[0] in ('sch', 'pcb'):
    out = pathlib.Path(a[a.index('-o') + 1])
    if a[0] == 'sch':
        out.write_text(json.dumps({'sheets': [{'violations': []}]})); sys.exit(0)
    if os.environ.get('PCB_FIXTURE_CHILD'):
        child = subprocess.Popen([sys.executable, '-c', 'import signal,time;signal.signal(signal.SIGTERM,signal.SIG_IGN);print("child-ready",flush=True);time.sleep(60)'])
        pathlib.Path(os.environ['PCB_FIXTURE_CHILD']).write_text(str(child.pid))
    print('fixture DRC started', flush=True)
    time.sleep(float(os.environ.get('PCB_FIXTURE_DELAY', '0')))
    errors = []
    if os.environ.get('PCB_FIXTURE_FINDING'):
        errors = [dict(type='clearance', severity='error', description='fixture clearance violation',
                       items=[dict(description='Pad 4 [SIG] of U3', pos=dict(x=12.5, y=8))])]
    parity = [dict(type='pad_net_mismatch', severity='error', description='fixture pad net mismatch', items=[])] if os.environ.get('PCB_FIXTURE_PARITY') else []
    out.write_text(json.dumps(dict(violations=errors, schematic_parity=parity, unconnected_items=[])))
    if os.environ.get('PCB_FIXTURE_MUTATE'):
        pathlib.Path(a[-1]).write_text('changed source')
    if os.environ.get('PCB_FIXTURE_CRASH'):
        sys.exit(2)
    sys.exit(0)
script = pathlib.Path(a[0]).name
if script == 'pcbtool.py' and a[1] == 'place':
    sys.exit(subprocess.run([sys.executable] + a).returncode)
elif script == 'kicad_happy_gate.py':
    pathlib.Path(a[a.index('--result') + 1]).write_text(json.dumps(dict(schema_version=1, completed=True, findings=0, stale_exemptions=0, exit=0)))
elif script == 'port_labels.py':
    print('port_labels: 0 checked, 0 failures')
elif a[1] == 'viapads':
    print('0 vias in SMD pads')
elif a[1] == 'paths':
    print('0 power-path pairs below the design current\n0 supply nets not covered')
else:
    sys.exit(2)
''')
        fake.chmod(0o755)
        happy = self.root / 'happy'
        happy.mkdir()
        subprocess.run(['git', 'init', '-q', str(happy)], check=True)
        subprocess.run(['git', '-C', str(happy), '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid',
                        'commit', '--allow-empty', '-qm', 'fixture'], check=True)
        pin = subprocess.check_output(['git', '-C', str(happy), 'rev-parse', 'HEAD'], text=True).strip()
        environment = self.root / 'tools/lib/env.mjs'
        environment.write_text(environment.read_text().replace("commit: 'a6bba1a'", 'commit: ' + repr(pin)))
        self.env = dict(os.environ, KICAD_CLI=str(fake), KICAD_PYTHON=str(fake), PYTHON_MODERN=str(fake),
                        KICAD_HAPPY_DIR=str(happy), KRT_DIR=str(self.root / 'absent'), KRPT_DIR=str(self.root / 'absent'),
                        KICAD_CONFIG_HOME=str(self.root / 'config'), PCB_RUNS_DIR=str(self.runs))

    def tearDown(self):
        try:
            for folder in self.runs.glob('run-*'):
                if pcb_cli.controller_alive(folder) is True or pcb_cli.status(folder)['status'] == 'starting':
                    (folder / 'cancel.request').write_text('{}')
                    self.until(lambda: pcb_cli.controller_alive(folder) is False, seconds=15)
        finally:
            self.temp.cleanup()

    def cli(self, *args, env=None):
        return subprocess.run([sys.executable, str(self.root / 'tools/pcb'), *args], env=env or self.env,
                              cwd=self.root, text=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=20)

    def until(self, predicate, seconds=12):
        deadline = time.monotonic() + seconds
        while time.monotonic() < deadline:
            value = predicate()
            if value:
                return value
            time.sleep(0.03)
        self.fail('fixture did not reach expected state before deadline')

    def start(self, **changes):
        response = self.cli('check', 'X', '--detach', '--json', '--heartbeat', '0.1', env=dict(self.env, **changes))
        self.assertEqual(response.returncode, 0, response.stderr + response.stdout)
        info = json.loads(response.stdout)
        return info['run_id'], self.runs / info['run_id']

    def finished(self, folder):
        state = pcb_cli.status(folder)
        return state if state['status'] in pcb_cli.TERMINAL else None

    def test_real_gate_streams_before_exit_and_preserves_board_evidence(self):
        run_id, folder = self.start(PCB_FIXTURE_DELAY='1.5')
        rows = self.until(lambda: [r for r in pcb_cli.events(folder) if r['type'] == 'tool.output' and r['stage'] == 'drc'])
        self.assertIn('fixture DRC started', rows[0]['text'])
        self.assertIsNone(self.finished(folder), 'output must be observable before gate completion')
        self.assertIn('fixture DRC started', (folder / 'gate/drc.log').read_text())
        heartbeat = self.until(lambda: [r for r in pcb_cli.events(folder) if r['type'] == 'run.heartbeat'])
        self.assertEqual(heartbeat[-1]['progress'], 'unknown')
        live = pcb_cli.status(folder)
        active_drc = next(row for row in live['active_stage_timing'] if row['stage'] == 'drc')
        self.assertGreaterEqual(active_drc['elapsed_s'], 0)
        self.assertGreaterEqual(active_drc['last_activity_age_s'], 0)
        final = self.until(lambda: self.finished(folder))
        self.assertEqual(final['status'], 'passed', final)
        self.assertTrue(final['cleanup']['complete'])
        timing = final['timing']
        self.assertEqual(timing['coverage'], 'recorded_boundaries')
        self.assertEqual(timing['incomplete_stages'], [])
        self.assertIsNone(timing['queue_wait_s'])
        self.assertIsNotNone(timing['supervisor_startup_s'])
        native = [row for row in timing['spans'] if row['category'] == 'kicad']
        self.assertEqual({row['stage'] for row in native}, {'erc', 'drc'})
        self.assertTrue(all(row['duration_source'] == 'producer_monotonic' for row in native))
        self.assertLessEqual(timing['busy_wall_s'], final['elapsed_s'] + .01)
        self.assertEqual((self.board / '.gate/latest.json').read_text(), 'prior latest pointer')
        self.assertEqual((self.board / 'gate-metrics.json').read_text(), 'prior tracked metrics')
        self.assertEqual((self.board / 'cad/X.kicad_pcb').read_text(), 'original PCB')
        shown = self.cli('status', run_id, '--json')
        self.assertEqual(json.loads(shown.stdout)['input_sha256'], final['input_sha256'])

    def test_cursor_reconnect_has_no_duplicates_and_rejects_invalid_boundary(self):
        run_id, folder = self.start()
        self.until(lambda: self.finished(folder))
        first = self.cli('events', run_id, '--json', '--limit', '2')
        rows = [json.loads(line) for line in first.stdout.splitlines()]
        self.assertEqual(len(rows), 2)
        rest = self.cli('events', run_id, '--after', str(rows[-1]['cursor']), '--json')
        later = [json.loads(line) for line in rest.stdout.splitlines()]
        self.assertEqual(later[0]['seq'], rows[-1]['seq'] + 1)
        self.assertEqual(later[-1]['type'], 'run.end')
        bad = self.cli('events', run_id, '--after', '1', '--json')
        self.assertEqual(bad.returncode, 2)
        self.assertIn('line boundary', json.loads(bad.stdout)['cause'])

    def test_findings_fail_and_explain_retains_native_location(self):
        run_id, folder = self.start(PCB_FIXTURE_FINDING='1')
        final = self.until(lambda: self.finished(folder))
        self.assertEqual(final['status'], 'failed', final)
        self.assertEqual(final['exit_code'], 1)
        explanation = json.loads(self.cli('explain', run_id, '--json').stdout)
        self.assertEqual(explanation['details'][0]['finding']['items'][0]['pos'], dict(x=12.5, y=8))
        self.assertTrue(any(f['cause'] == 'drc_errors: 1' for f in final['findings']))

    def test_clean_report_after_crash_cannot_pass(self):
        _, folder = self.start(PCB_FIXTURE_CRASH='1')
        final = self.until(lambda: self.finished(folder))
        self.assertEqual(final['status'], 'error', final)
        self.assertEqual(final['exit_code'], 2)
        self.assertIsNone(final['metrics']['drc_errors'])

    def test_input_mutation_invalidates_gate(self):
        _, folder = self.start(PCB_FIXTURE_MUTATE='1')
        final = self.until(lambda: self.finished(folder))
        self.assertEqual(final['status'], 'error', final)
        self.assertIn('inputs changed', final['cause'])

    def test_cancel_cleans_spawned_family_and_retains_evidence(self):
        pid_file = self.root / 'child.pid'
        run_id, folder = self.start(PCB_FIXTURE_CHILD=str(pid_file), PCB_FIXTURE_DELAY='60')
        self.until(pid_file.exists)
        self.until(lambda: (folder / 'gate/drc.log').exists() and 'child-ready' in (folder / 'gate/drc.log').read_text())
        response = self.cli('cancel', run_id, '--json')
        self.assertTrue(json.loads(response.stdout)['cancellation_requested'])
        final = self.until(lambda: self.finished(folder))
        self.assertEqual(final['status'], 'cancelled', final)
        self.assertTrue(final['cleanup']['complete'])
        self.assertEqual(final['timing']['coverage'], 'partial')
        self.assertTrue(any(row['stage'] == 'drc' for row in final['timing']['incomplete_stages']))
        pid = int(pid_file.read_text())
        with self.assertRaises(ProcessLookupError):
            os.kill(pid, 0)
        self.assertTrue((folder / 'gate/drc.log').is_file())
        again = json.loads(self.cli('cancel', run_id, '--json').stdout)
        self.assertEqual(again['status'], 'cancelled')

    def test_timeout_is_terminal_and_never_qualified(self):
        response = self.cli('check', 'X', '--json', '--timeout', '0.8', '--heartbeat', '0.1',
                            env=dict(self.env, PCB_FIXTURE_DELAY='60'))
        self.assertEqual(response.returncode, 124, response.stdout + response.stderr)
        rows = [json.loads(line) for line in response.stdout.splitlines()]
        self.assertEqual(rows[-1]['status'], 'timeout')
        self.assertTrue(rows[-1]['cleanup']['complete'])

    def test_missing_tool_never_produces_pass(self):
        _, folder = self.start(KICAD_CLI=str(self.root / 'missing-tool'))
        final = self.until(lambda: self.finished(folder))
        self.assertEqual(final['status'], 'error', final)

    def test_lost_controller_is_reported_without_signalling_a_pid(self):
        folder = self.runs / 'run-lost'
        folder.mkdir(parents=True)
        (folder / 'run.json').write_text('{}')
        (folder / 'worker.lock').touch()
        (folder / 'state.json').write_text(json.dumps(dict(status='running', updated_unix=time.time(), run_id=folder.name)))
        response = self.cli('status', folder.name, '--json')
        state = json.loads(response.stdout)
        self.assertEqual(state['status'], 'error')
        self.assertIn('cleanup unconfirmed', state['cause'])
        self.assertIsNone(state['cleanup'])

    def test_new_unlocked_controller_is_allowed_to_start(self):
        folder = self.root / 'starting'
        folder.mkdir()
        (folder / 'worker.lock').touch()
        state = dict(status='starting', updated_unix=time.time(), run_id=folder.name)
        (folder / 'state.json').write_text(json.dumps(state))
        self.assertEqual(pcb_cli.status(folder)['status'], 'starting')
        state['updated_unix'] -= 11
        (folder / 'state.json').write_text(json.dumps(state))
        failed = pcb_cli.status(folder)
        self.assertEqual(failed['status'], 'error')
        self.assertIn('did not start', failed['cause'])

    def test_status_reloads_terminal_result_after_controller_releases_lock(self):
        folder = self.root / 'completed'
        folder.mkdir()
        path = folder / 'state.json'
        state = dict(status='running', updated_unix=time.time(), run_id=folder.name)
        path.write_text(json.dumps(state))

        def finished_during_probe(_):
            path.write_text(json.dumps(dict(state, status='passed', exit_code=0)))
            return False

        with mock.patch.object(pcb_cli, 'controller_alive', side_effect=finished_during_probe):
            self.assertEqual(pcb_cli.status(folder)['status'], 'passed')

    def test_completed_supervisor_cannot_be_replayed(self):
        run_id, folder = self.start()
        self.until(lambda: self.finished(folder))
        self.until(lambda: pcb_cli.controller_alive(folder) is False)
        original = {name: (folder / name).read_bytes() for name in ('events.jsonl', 'state.json', 'result.json')}
        replay = self.cli('_worker', run_id, '--json')
        self.assertEqual(replay.returncode, 2, replay.stderr + replay.stdout)
        self.assertIn('already admitted', json.loads(replay.stdout)['cause'])
        self.assertEqual({name: (folder / name).read_bytes() for name in original}, original)

    def test_follow_returns_terminal_event_from_final_drain(self):
        terminal = dict(type='run.end', exit_code=0, cursor=100)
        with mock.patch.object(pcb_cli, 'events', side_effect=[[], [terminal]]) as read, \
                mock.patch.object(pcb_cli, 'status', return_value=dict(status='passed', controller_alive=False)), \
                mock.patch.object(pcb_cli, 'print_event') as show:
            self.assertEqual(pcb_cli.follow(self.root, True), 0)
        self.assertEqual(read.call_count, 2)
        show.assert_called_once_with(terminal, True)

    def test_partial_event_write_is_not_consumed(self):
        folder = self.root / 'partial'
        folder.mkdir()
        path = folder / 'events.jsonl'
        path.write_bytes(b'{"seq":1}\n{"seq":')
        rows = pcb_cli.events(folder)
        self.assertEqual([r['seq'] for r in rows], [1])
        with path.open('ab') as stream:
            stream.write(b'2}\n')
        self.assertEqual([r['seq'] for r in pcb_cli.events(folder, rows[0]['cursor'])], [2])

    def test_release_promotion_does_not_replay_gate_or_export_spans(self):
        folder = self.root / 'promote'
        for suffix in ('gate/events.jsonl', 'stages.jsonl'):
            path = folder / 'release-work' / suffix
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(json.dumps(dict(schema_version=1, type='stage.start', stage=suffix)) + '\n')
        rows, cursor = pcb_cli.incoming(folder, {})
        self.assertEqual(len(rows), 2)
        (folder / 'release-work').rename(folder / 'candidate')
        self.assertEqual(pcb_cli.incoming(folder, cursor)[0], [])
        with (folder / 'candidate/stages.jsonl').open('a') as stream:
            stream.write(json.dumps(dict(schema_version=1, type='stage.end', stage='export')) + '\n')
        self.assertEqual([row['type'] for row in pcb_cli.incoming(folder, cursor)[0]], ['stage.end'])

    def test_live_status_refreshes_elapsed_for_operations_without_output(self):
        folder = self.root / 'silent-operation'
        folder.mkdir()
        (folder / 'state.json').write_text(json.dumps(dict(status='running', updated_unix=18, elapsed_s=3,
            operation='release', active_stage_timing=[dict(stage='export', started_unix_s=15, last_activity_unix_s=17)])))
        with mock.patch.object(pcb_cli, 'controller_alive', return_value=True), mock.patch('time.time', return_value=20):
            state = pcb_cli.status(folder)
        self.assertEqual(state['elapsed_s'], 5)
        self.assertEqual(state['active_stage_timing'][0]['elapsed_s'], 5)
        self.assertEqual(state['active_stage_timing'][0]['last_activity_age_s'], 3)

    def test_changed_runs_reuse_evidence_and_benchmark_measures_complete_targets(self):
        folders = []
        for _ in range(2):
            response = self.cli('check', 'X', '--changed', '--json')
            self.assertEqual(response.returncode, 0, response.stdout + response.stderr)
            result = json.loads(response.stdout.splitlines()[-1])
            folders.append(self.runs / result['run_id'])
        from pcb_benchmark import summarize
        summary = summarize(folders)
        self.assertTrue(summary['comparable'])
        self.assertTrue(all(row['time_to_configured_targets_s'] is not None for row in summary['runs']))
        self.assertGreater(summary['runs'][1]['cache_hits'], 0)
        self.assertIsNotNone(summary['runs'][1]['child_cpu_s'])
        self.assertEqual(summary['runs'][1]['timing'], json.loads((folders[1] / 'result.json').read_text())['timing'])
        (folders[1] / 'gate/drc.json').write_text('{}')
        invalid = summarize(folders)["runs"][1]
        self.assertFalse(invalid['evidence_verified'])
        self.assertIsNone(invalid['time_to_configured_targets_s'])

    def test_baseline_flag_retains_explicit_findings_delta(self):
        prior, folder = self.start(PCB_FIXTURE_FINDING='1')
        self.until(lambda: self.finished(folder))
        response = self.cli('check', 'X', '--fresh', '--baseline', prior, '--json')
        self.assertEqual(response.returncode, 0, response.stdout + response.stderr)
        final = json.loads(response.stdout.splitlines()[-1])
        findings = json.loads((self.runs / final['run_id'] / 'gate/findings.json').read_text())
        self.assertEqual(len(findings['delta']['resolved']), 1)

    def test_blocks_uses_owned_streaming_lifecycle(self):
        (self.root / 'tools/blocks.py').write_text('import time\nprint("block-native-start",flush=True)\ntime.sleep(0.3)\nprint("{}",flush=True)\n')
        response = self.cli('blocks', '--json', '--heartbeat', '0.1', 'inventory', 'X', env=dict(self.env, PYTHON_MODERN=sys.executable))
        self.assertEqual(response.returncode, 0, response.stdout + response.stderr)
        rows = [json.loads(line) for line in response.stdout.splitlines()]
        self.assertTrue(any(row['type'] == 'tool.output' and 'block-native-start' in row['text'] for row in rows))
        self.assertEqual(rows[-1]['operation'], 'blocks')
        self.assertEqual(rows[-1]['scope'], 'block_evidence')
        self.assertTrue(rows[-1]['cleanup']['complete'])
        block_span = next(row for row in rows[-1]['timing']['spans'] if row['stage'] == 'blocks')
        self.assertGreaterEqual(block_span['duration_s'], .3)

    def test_valid_native_defect_blocks_dependents_without_losing_actionable_failure(self):
        _, folder = self.start(PCB_FIXTURE_PARITY='1')
        final = self.until(lambda: self.finished(folder))
        self.assertEqual(final['status'], 'failed', final)
        self.assertEqual(final['metrics']['drc_parity'], 1)
        self.assertIsNone(final['metrics']['paths_low'])
        from pcb_benchmark import summarize
        row = summarize([folder])['runs'][0]
        self.assertEqual(row['completed_checks'], 2)
        self.assertEqual(row['blocked_checks'], 4)
        self.assertIsNone(row['time_to_configured_targets_s'])


if __name__ == '__main__':
    unittest.main()
