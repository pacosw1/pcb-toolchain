"""Pure process-control regressions: no native board/router jobs are launched."""
import importlib.util
import json
import os
from pathlib import Path
import signal
import subprocess
import sys
import tempfile
import threading
import time
import types
import unittest
from unittest import mock

import lean_workflow as lean


def load_job():
    spec = importlib.util.spec_from_file_location('controlled_fastroute_job',
                                                  Path(__file__).with_name('fastroute_job.py'))
    job = importlib.util.module_from_spec(spec)
    # Native dependencies are isolated to this import; other tests keep theirs.
    with mock.patch.dict(sys.modules, {'pcbnew': types.ModuleType('pcbnew'),
                                      'freeroute': types.ModuleType('freeroute')}):
        spec.loader.exec_module(job)
    return job


class HelperDeadlineTests(unittest.TestCase):
    def setUp(self):
        self.job = load_job()
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.board = self.root/'input.kicad_pcb'
        self.board.write_text('controlled input; never opened by native KiCad')
        self.out = self.root/'job'
        self.ready = self.root/'helper-ready'
        self.checkpoint = self.root/'helper-checkpoint'
        self.real_stage = lean.run_stage

    def run_job(self, *, expired=False, seconds=1):
        helper = ('import os,pathlib,signal,sys,time; '
                  'signal.signal(signal.SIGTERM,lambda *a:'
                  '(pathlib.Path(sys.argv[2]).write_text("retained"),sys.exit(0))); '
                  'pathlib.Path(sys.argv[1]).write_text(str(os.getpid())); time.sleep(30)')
        def controlled_helper(cmd, **kwargs):
            # Exercise the real caller, supervisor, pipes and process cleanup;
            # substitute only the native helper executable with a stalled child.
            return self.real_stage([sys.executable, '-c', helper, str(self.ready), str(self.checkpoint)], **kwargs)
        argv = ['fastroute_job.py', str(self.board), str(self.out), '--plane-nets', 'GND',
                '--threads', '1', '--max-time', str(seconds)]
        env = dict(IOT_RESOURCE_DIRECTORY=str(self.root/'resources'), IOT_CPU_BUDGET='1',
                   IOT_MEMORY_BUDGET_GIB='8', IOT_JOB_MEMORY_GIB='8')
        if expired:
            env['IOT_LEAN_DEADLINE'] = lean.encode_deadline(lean.now()-1)
        with mock.patch.dict(os.environ, env), mock.patch.object(sys, 'argv', argv), \
             mock.patch.object(self.job, 'BIN', sys.executable), \
             mock.patch.object(self.job.backend_quality, 'bind', return_value={'mode':'legacy'}), \
             mock.patch.object(self.job.route_features, 'load', return_value={}), \
             mock.patch.object(self.job.route_features, 'summary', return_value='controlled'), \
             mock.patch.object(self.job.lean, 'run_stage', side_effect=controlled_helper):
            if expired:
                return self.job._main(self.job._parse_args())
            return self.job.main()

    def events(self):
        return [json.loads(line) for line in (self.out/'stages.jsonl').read_text().splitlines()]

    def assert_reaped(self):
        pid = int(self.ready.read_text())
        with self.assertRaises(ProcessLookupError):
            os.kill(pid, 0)
        self.assertTrue(self.events()[-1]['cleanup']['child_reaped'])
        self.assertTrue(self.events()[-1]['cleanup']['complete'])

    def test_stalled_initial_helper_obeys_standalone_job_deadline(self):
        self.assertEqual(self.run_job(), 124)
        outcome = json.loads((self.out/'outcome.json').read_text())
        self.assertEqual(outcome['status'], 'timeout')
        self.assertFalse(outcome['qualified'])
        self.assertEqual(self.events()[0]['stage'], 'initial-plane-vias:GND')
        self.assertEqual(self.events()[0]['status'], 'timeout')
        self.assertEqual(self.checkpoint.read_text(), 'retained')
        self.assertFalse((self.out/'routed.kicad_pcb').exists())
        self.assert_reaped()

    def test_expired_inherited_deadline_never_launches_helper(self):
        with self.assertRaises(subprocess.TimeoutExpired):
            self.run_job(expired=True)
        self.assertFalse(self.ready.exists())
        self.assertEqual(self.events()[0]['status'], 'timeout')
        self.assertIsNone(self.events()[0]['cleanup'])

    def test_cleanup_failure_preserves_original_timeout_and_retained_evidence(self):
        real_cleanup = lean.cleanup_group
        def failed_cleanup(proc, depth):
            real_cleanup(proc, depth)
            raise RuntimeError('controlled cleanup diagnostic failure')
        with mock.patch.object(lean, 'cleanup_group', side_effect=failed_cleanup):
            self.assertEqual(self.run_job(), 124)
        event = self.events()[0]
        self.assertEqual(event['cause']['type'], 'TimeoutExpired')
        self.assertFalse(event['cleanup']['complete'])
        self.assertEqual(event['cleanup']['errors'][0]['type'], 'RuntimeError')
        self.assertEqual(self.checkpoint.read_text(), 'retained')
        with self.assertRaises(ProcessLookupError):
            os.kill(int(self.ready.read_text()), 0)

    def test_cancel_during_helper_retains_evidence_and_reaps_child(self):
        sent = threading.Event()
        def cancel_when_ready():
            until = time.monotonic()+5
            while time.monotonic()<until:
                handler = signal.getsignal(signal.SIGTERM)
                if self.ready.exists() and getattr(handler, '__name__', '') == 'interrupted':
                    sent.set()
                    os.kill(os.getpid(), signal.SIGTERM)
                    return
                sent.wait(.005)
        sender = threading.Thread(target=cancel_when_ready)
        sender.start()
        try:
            self.assertEqual(self.run_job(seconds=10), 128+signal.SIGTERM)
        finally:
            sender.join(timeout=6)
        self.assertTrue(sent.is_set(), 'helper and cancellation handler must both become ready')
        self.assertFalse(sender.is_alive())
        outcome = json.loads((self.out/'outcome.json').read_text())
        self.assertEqual(outcome['status'], 'cancelled')
        self.assertFalse(outcome['qualified'])
        self.assertEqual(self.events()[0]['status'], 'cancelled')
        self.assertEqual(self.checkpoint.read_text(), 'retained')
        self.assert_reaped()


class NativePhaseAccountingTests(unittest.TestCase):
    def test_inline_work_reports_distinct_cpu_scopes_and_failure(self):
        job = load_job()
        with tempfile.TemporaryDirectory() as folder:
            events = Path(folder)/'stages.jsonl'
            with mock.patch.dict(os.environ, {}, clear=False):
                with job._native_phase('fill', events):
                    sum(i*i for i in range(10000))
                with self.assertRaises(ValueError):
                    with job._native_phase('import', events):
                        raise ValueError('controlled native failure')
            rows = [json.loads(line) for line in events.read_text().splitlines()]
            self.assertEqual([r['status'] for r in rows], ['complete', 'failed'])
            for row in rows:
                self.assertEqual(row['kind'], 'inprocess')
                self.assertGreaterEqual(row['self_cpu_s'], 0)
                self.assertGreaterEqual(row['child_cpu_s'], 0)
                self.assertIn('non-additive', row['accounting'])
                self.assertTrue(row['blocking_native'])

    def test_expired_inline_phase_never_runs_or_reports_success(self):
        job = load_job()
        with tempfile.TemporaryDirectory() as folder:
            events = Path(folder)/'stages.jsonl'
            with mock.patch.dict(os.environ, {'IOT_LEAN_DEADLINE':lean.encode_deadline(lean.now()-1)}):
                with self.assertRaises(subprocess.TimeoutExpired):
                    with job._native_phase('fill', events):
                        self.fail('expired native phase must not start')
            self.assertEqual(json.loads(events.read_text())['status'], 'timeout')


class NestedCleanupTests(unittest.TestCase):
    def exercise(self, levels, captured, paused=False):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            pidfile = root/'helper.pid'
            controller = root/'controller.pid'
            helper = ('import os,pathlib,signal,sys,time; '
                      'signal.signal(signal.SIGTERM,signal.SIG_IGN); '
                      'pathlib.Path(sys.argv[1]).write_text(str(os.getpid())); time.sleep(30)')
            inner = ('import lean_workflow as lean,sys,os,pathlib; '
                     'pathlib.Path('+repr(str(controller))+').write_text(str(os.getpid())); '
                     'lean.run_stage([sys.executable,"-c",'+repr(helper)+','+repr(str(pidfile))+'], '
                     'stage="inner",event_file='+repr(str(root/'inner.jsonl'))+')')
            for index in range(levels-2):
                inner = ('import lean_workflow as lean,sys; '
                         'lean.run_stage([sys.executable,"-c",'+repr(inner)+'], '
                         'stage="middle",event_file='+repr(str(root/f'middle-{index}.jsonl'))+')')
            sent = threading.Event()
            def cancel_when_ready():
                until = time.monotonic()+5
                while time.monotonic()<until:
                    if pidfile.exists() and getattr(signal.getsignal(signal.SIGTERM), '__name__', '') == 'interrupted':
                        if paused:os.kill(int(controller.read_text()),signal.SIGSTOP)
                        sent.set()
                        os.kill(os.getpid(), signal.SIGTERM)
                        return
                    sent.wait(.005)
            sender = threading.Thread(target=cancel_when_ready)
            sender.start()
            try:
                with open(root/'output.log', 'w') as log:
                    with self.assertRaises(lean.StageCancelled):
                        lean.run_stage([sys.executable, '-c', inner], stage='outer',
                                       event_file=root/'outer.jsonl', deadline=lean.deadline_after(15),
                                       stdout=subprocess.PIPE if captured else log,
                                       stderr=subprocess.PIPE if captured else log)
                self.assertTrue(sent.is_set())
                pid = int(pidfile.read_text())
                try:
                    os.kill(pid, 0)
                    alive = True
                except ProcessLookupError:
                    alive = False
                row = json.loads((root/'outer.jsonl').read_text())
                self.assertTrue(row['cleanup']['complete'],json.dumps(row['cleanup']))
                self.assertTrue(row['cleanup']['child_reaped'])
                print(json.dumps(dict(nested_cleanup=True, levels=levels, captured=captured,
                                      helper_alive=alive, wall_s=row['wall_s'], cleanup=row['cleanup'])))
                self.assertFalse(alive, 'outer cleanup must not kill the supervisor before its separate helper group')
                if paused:
                    with self.assertRaises(ProcessLookupError):os.kill(int(controller.read_text()),0)
            finally:
                sender.join(timeout=6)
                if pidfile.exists():
                    # This PID is created by this test, in its own session; never
                    # touch any unrelated user/agent process on a failure.
                    try:
                        os.killpg(int(pidfile.read_text()), signal.SIGKILL)
                    except ProcessLookupError:
                        pass
                if paused and controller.exists():
                    try:os.killpg(int(controller.read_text()),signal.SIGKILL)
                    except ProcessLookupError:pass

    def test_two_level_file_output_cleans_ignoring_helper(self):
        self.exercise(2, False)

    def test_three_level_file_output_cleans_ignoring_helper(self):
        self.exercise(3, False)

    def test_two_level_captured_pipes_close_after_cancel(self):
        self.exercise(2, True)

    def test_three_level_captured_pipes_close_after_cancel(self):
        self.exercise(3, True)

    def test_paused_controller_file_stream_cleans_separate_helper(self):
        self.exercise(2,False,paused=True)

    def test_paused_controller_captured_pipes_cleans_separate_helper(self):
        self.exercise(2,True,paused=True)

    def test_invalid_depth_and_child_reset_fail_before_launch(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            marker = root/'launched'
            cmd = [sys.executable, '-c', 'import pathlib,sys;pathlib.Path(sys.argv[1]).touch()', str(marker)]
            for depth in ('-1', '01', '3', '9', '1.0', '', 'invalid', '9'*5000):
                with self.subTest(depth=depth[:20]), mock.patch.dict(os.environ, {'IOT_LEAN_STAGE_DEPTH':depth}):
                    with self.assertRaises(ValueError):
                        lean.run_stage(cmd, stage='invalid', event_file=root/'events')
                    self.assertFalse(marker.exists())
            with mock.patch.dict(os.environ, {'IOT_LEAN_STAGE_DEPTH':'1'}):
                env = dict(os.environ, IOT_LEAN_STAGE_DEPTH='0')
                with self.assertRaises(ValueError):
                    lean.run_stage(cmd, stage='reset', env=env, event_file=root/'events')
                self.assertFalse(marker.exists())

    def test_fourth_owned_level_rejects_before_spawning_its_helper(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            marker = root/'helper-launched'
            cmd = [sys.executable, '-c', 'import pathlib,sys;pathlib.Path(sys.argv[1]).touch()', str(marker)]
            for level in range(3):
                script = ('import lean_workflow as lean,sys; '
                          'sys.exit(lean.run_stage('+repr(cmd)+',stage="depth-limit",event_file='
                          +repr(str(root/f'level-{level}.jsonl'))+').returncode)')
                cmd = [sys.executable, '-c', script]
            result = lean.run_stage(cmd, stage='root', deadline=lean.deadline_after(5),
                                    stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
            self.assertNotEqual(result.returncode, 0)
            self.assertIn('invalid/excessive owned stage depth', result.stderr)
            self.assertFalse(marker.exists())


class ClearanceModelPhaseTests(unittest.TestCase):
    def test_actual_file_phase_binds_project_before_and_after_models_without_native_writes(self):
        from test_route_rule_coverage import dsn, project, CLASSES, OBSTACLES, LED
        job = load_job()
        with tempfile.TemporaryDirectory() as folder:
            root=Path(folder); source=root/'source.kicad_pro'; before=root/'before.dsn'; model=root/'final.dsn'; receipt=root/'floor.json'
            value=project();value['net_settings']['classes'][1]['clearance']=.3
            source.write_text(json.dumps(value)); original=source.read_bytes()
            changed, report=job._strengthen_clearance_model(dsn(),source,before,model,receipt,
                active_nets=[LED],net_classes=CLASSES,obstacles=OBSTACLES,layers=['F.Cu','B.Cu'])
            self.assertEqual(source.read_bytes(),original)
            self.assertEqual(before.read_text(),dsn());self.assertEqual(changed,dsn('300'))
            self.assertFalse(model.exists()) # The phase precedes final model sealing.
            self.assertEqual(report,json.loads(receipt.read_text()))
            self.assertEqual(report['inputs'][str(source)],lean.digest(source))
            self.assertEqual(report['before']['sha256'],lean.digest(before))
            self.assertEqual(report['after']['path'],str(model))

    def test_malformed_project_retains_blocked_receipt_and_exact_pretransform_model(self):
        from test_route_rule_coverage import dsn, CLASSES, OBSTACLES, LED
        job=load_job()
        with tempfile.TemporaryDirectory() as folder:
            root=Path(folder); source=root/'source.kicad_pro';before=root/'before.dsn';model=root/'final.dsn';receipt=root/'floor.json'
            source.write_text('{"duplicated":1,"duplicated":2}')
            with self.assertRaisesRegex(ValueError,'duplicate project field'):
                job._strengthen_clearance_model(dsn(),source,before,model,receipt,
                    active_nets=[LED],net_classes=CLASSES,obstacles=OBSTACLES,layers=['F.Cu','B.Cu'])
            self.assertEqual(before.read_text(),dsn());self.assertFalse(model.exists())
            report=json.loads(receipt.read_text());self.assertEqual(report['status'],'blocked')
            self.assertEqual(report['inputs'][str(source)],lean.digest(source))

    def test_project_or_before_model_mutation_blocks_the_file_phase(self):
        from test_route_rule_coverage import dsn, project, CLASSES, OBSTACLES, LED
        job=load_job(); original=job.route_features.strengthen_project_clearance
        for target in ('project','before'):
            with self.subTest(target=target), tempfile.TemporaryDirectory() as folder:
                root=Path(folder);source=root/'source.kicad_pro';before=root/'before.dsn';model=root/'final.dsn';receipt=root/'floor.json'
                value=project();value['net_settings']['classes'][1]['clearance']=.3
                source.write_text(json.dumps(value))
                def changed(*args,**kwargs):
                    result=original(*args,**kwargs)
                    (source if target=='project' else before).write_text('changed after reading')
                    return result
                with mock.patch.object(job.route_features,'strengthen_project_clearance',side_effect=changed):
                    with self.assertRaisesRegex(ValueError,'changed during clearance strengthening'):
                        job._strengthen_clearance_model(dsn(),source,before,model,receipt,
                            active_nets=[LED],net_classes=CLASSES,obstacles=OBSTACLES,layers=['F.Cu','B.Cu'])
                self.assertFalse(model.exists())
                self.assertEqual(json.loads(receipt.read_text())['status'],'blocked')


if __name__ == '__main__':
    unittest.main()
