"""Pure process-control regressions: no native board/router jobs are launched."""
import ast
import contextlib
import importlib.util
import io
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


class RouterStopEvidenceTests(unittest.TestCase):
    def test_summary_preserves_unknown_diagnosis_and_real_measured_zero(self):
        job = load_job()
        tree = ast.parse(Path(__file__).with_name('fastroute_job.py').read_text())
        main = next(node for node in tree.body if isinstance(node, ast.FunctionDef) and node.name == '_main')
        summary = next(node for node in ast.walk(main) if isinstance(node, ast.Expr)
            and isinstance(node.value, ast.Call) and isinstance(node.value.func, ast.Name)
            and node.value.func.id == 'print' and node.value.args
            and isinstance(node.value.args[0], ast.JoinedStr)
            and isinstance(node.value.args[0].values[0], ast.Constant)
            and node.value.args[0].values[0].value == 'UNROUTED ')
        for extra, expected in (({}, 'CONGESTION unknown BLOCKED unknown'),
                ({'diagnosis':None}, 'CONGESTION unknown BLOCKED unknown'),
                ({'diagnosis':{'congestion':0,'blocked':1}}, 'CONGESTION 0 BLOCKED 1'),
                ({'diagnosis':{'congestion':None,'blocked':True}}, 'CONGESTION unknown BLOCKED unknown')):
            with self.subTest(report=extra):
                report = dict(stats=dict(unrouted=1,trace_length_mm=13.5), **extra)
                stream = io.StringIO()
                with contextlib.redirect_stdout(stream):
                    exec(compile(ast.Module(body=[summary], type_ignores=[]), '<production summary>', 'exec'),
                        dict(report=report,signal_open=1,gnd_open=0,errors=0,after=5,secs=2,
                             _diagnosis_count=job._diagnosis_count))
                self.assertIn(expected, stream.getvalue())
                self.assertTrue(stream.getvalue().startswith('UNROUTED 1 GND_OPEN 0 ERRORS 0 ROUTER_UNROUTED 1 '))
                self.assertIn('VIAS 5 SECONDS 2', stream.getvalue())

    def test_normal_producer_argv_keeps_report_without_automatic_diagnosis(self):
        # Execute the actual production argv expression without any native work.
        tree = ast.parse(Path(__file__).with_name('fastroute_job.py').read_text())
        main = next(node for node in tree.body if isinstance(node, ast.FunctionDef) and node.name == '_main')
        command = next(node for node in ast.walk(main) if isinstance(node, ast.Assign)
                       and any(isinstance(t, ast.Name) and t.id == 'cmd' for t in node.targets)
                       and isinstance(node.value, ast.BinOp)
                       and any(isinstance(v, ast.Constant) and v.value == '-de' for v in ast.walk(node.value)))
        values = dict(BIN='/reviewed/fastroute', model_dsn='/owned/router-model.dsn', ses='/owned/board.ses',
                      rep='/owned/report.json', min_um=150, edge_um=500,
                      a=types.SimpleNamespace(passes=40, set=['router.autorouter.max_threads=1']))
        exec(compile(ast.Module(body=[command], type_ignores=[]), '<production router argv>', 'exec'), values)
        self.assertNotIn('--diagnose', values['cmd'])
        self.assertIn('--report=/owned/report.json', values['cmd'])
        self.assertEqual(values['cmd'][:7], ['/reviewed/fastroute', '-de', '/owned/router-model.dsn',
                                         '-do', '/owned/board.ses', '-mp', '40'])
        self.assertIn('--router.min_trace_width_um=150', values['cmd'])
        self.assertIn('--router.copper_to_edge_clearance_um=500', values['cmd'])
        # Both actual solver calls remain inside the observer lifetime.
        guarded = [node for node in ast.walk(main) if isinstance(node, ast.With)
                   and any(isinstance(item.context_expr, ast.Call)
                           and isinstance(item.context_expr.func, ast.Name)
                           and item.context_expr.func.id == '_router_observers' for item in node.items)]
        self.assertEqual(len(guarded), 1)
        phases = [kw.value for call in ast.walk(guarded[0]) if isinstance(call, ast.Call)
                  and isinstance(call.func, ast.Attribute) and call.func.attr == 'run_stage'
                  for kw in call.keywords if kw.arg == 'stage']
        self.assertEqual(len(phases), 2)

    def test_actual_timeout_retains_single_owned_stall_and_settles_observers(self):
        job = load_job()
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder); log = root/'run.log'; marker = root/'stop-count'; result = {}; owner = {}
            stop = threading.Event(); progress = job.route_progress.Progress(root/'progress.jsonl')
            watcher = threading.Thread(target=job._router_watch,
                args=(str(log), 2, owner, stop, result, progress, 'route'), daemon=True)
            snapshot = types.SimpleNamespace(thread=None, start=mock.Mock(), stop=mock.Mock())
            snapshot.start.return_value = snapshot
            code = ('import pathlib,signal,sys,time\n'
                    'path=pathlib.Path(sys.argv[1]); count=0\n'
                    'def stopped(*args):\n'
                    ' global count\n'
                    ' count+=1; path.write_text(str(count))\n'
                    ' if count>1: sys.exit(0)\n'
                    'signal.signal(signal.SIGTERM,stopped)\n'
                    'print("Auto-routing stage started with baseline score 1 for 1 unrouted item.",flush=True)\n'
                    'for i in range(1,4):\n'
                    ' print(f"Auto-routing pass #{i} was completed in 0.01 seconds with score 1 '
                    '(1 unrouted and 0 violations) (routed 0, failed 1, ripped 0).",flush=True)\n'
                    'time.sleep(30)\n')
            def started(proc):
                owner['proc'] = mock.Mock(wraps=proc)
            with self.assertRaises(subprocess.TimeoutExpired) as caught:
                with job._router_observers(watcher, stop, result, snapshot, root/'stall.json', 2, 'all'):
                    with log.open('w') as stream:
                        lean.run_stage([sys.executable, '-c', code, str(marker)], stage='router-screen',
                            event_file=root/'stages.jsonl', deadline=lean.deadline_after(2), on_start=started,
                            stdout=stream, stderr=subprocess.STDOUT)
            owner['proc'].interrupt.assert_called_once()
            self.assertTrue(stop.is_set()); self.assertFalse(watcher.is_alive())
            snapshot.start.assert_called_once(); snapshot.stop.assert_called_once()
            self.assertTrue(caught.exception.cleanup['complete'])
            stage = json.loads((root/'stages.jsonl').read_text())
            self.assertEqual(stage['status'], 'timeout'); self.assertTrue(stage['cleanup']['child_reaped'])
            receipt = json.loads((root/'stall.json').read_text())
            self.assertTrue(receipt['interrupt_attempted'])
            self.assertIs(receipt['interrupt_acknowledged'], True)
            self.assertNotIn('stopped', receipt)
            self.assertEqual(receipt['pass_no'], 3); self.assertEqual(receipt['stage'], 'all')
            self.assertTrue(receipt['observer_cleanup']['complete'])
            self.assertTrue(marker.is_file(), 'the owned child must observe its stop signal')

    def test_secondary_snapshot_error_does_not_replace_original_exception_or_stall(self):
        job = load_job()
        for original in (subprocess.TimeoutExpired(['controlled-solver'], 1), KeyboardInterrupt('controlled cancel')):
            with self.subTest(error=type(original).__name__), tempfile.TemporaryDirectory() as folder:
                stop = threading.Event()
                watcher = threading.Thread(target=stop.wait)
                snapshot = types.SimpleNamespace(thread=None, start=mock.Mock(),
                    stop=mock.Mock(side_effect=RuntimeError('controlled snapshot failure')))
                result = dict(interrupt_attempted=True, interrupt_acknowledged=True,
                              how='owned-stage interrupt requested', pass_no=6, best=1, unrouted=1)
                with self.assertRaises(type(original)) as caught:
                    with job._router_observers(watcher, stop, result, snapshot, Path(folder)/'stall.json', 5, 'all'):
                        raise original
                self.assertIs(caught.exception, original)
                self.assertFalse(watcher.is_alive()); snapshot.stop.assert_called_once()
                receipt = json.loads((Path(folder)/'stall.json').read_text())
                self.assertTrue(receipt['interrupt_attempted']); self.assertFalse(receipt['observer_cleanup']['complete'])
                self.assertEqual(receipt['observer_cleanup']['errors'][0]['operation'], 'snapshot stop')

    def test_normal_completion_stops_observers_without_fabricating_stall(self):
        job = load_job()
        with tempfile.TemporaryDirectory() as folder:
            stop = threading.Event(); watcher = threading.Thread(target=stop.wait)
            snapshot = types.SimpleNamespace(thread=None, start=mock.Mock(), stop=mock.Mock())
            path = Path(folder)/'stall.json'
            with job._router_observers(watcher, stop, {}, snapshot, path, 5, 'all'):
                pass
            self.assertTrue(stop.is_set()); self.assertFalse(watcher.is_alive())
            snapshot.stop.assert_called_once(); self.assertFalse(path.exists())

    def test_unknown_or_false_interrupt_ack_is_not_retried_and_remains_durable(self):
        job = load_job()
        for answer in (False, TimeoutError('broker reply timed out after possible delivery')):
            with self.subTest(answer=str(answer)), tempfile.TemporaryDirectory() as folder:
                root = Path(folder); log = root/'run.log'; result = {}; proc = mock.Mock()
                if isinstance(answer, BaseException):proc.interrupt.side_effect = answer
                else:proc.interrupt.return_value = answer
                log.write_text('\n'.join(f'Auto-routing pass #{i} was completed in 0.1 seconds '
                    'with score 1 (1 unrouted and 0 violations).' for i in range(1,10))+'\n')
                stop = mock.Mock(); stop.wait.return_value = False
                with mock.patch.object(job.subprocess, 'run') as run, mock.patch('os.kill') as kill:
                    job._router_watch(str(log), 2, {'proc':proc}, stop, result, mock.Mock(), 'route')
                proc.interrupt.assert_called_once(); run.assert_not_called(); kill.assert_not_called()
                self.assertTrue(result['interrupt_attempted']); self.assertNotIn('stopped', result)
                self.assertIs(result['interrupt_acknowledged'], None if isinstance(answer, BaseException) else False)
                settled = threading.Event(); watcher = threading.Thread(target=settled.wait)
                snapshot = types.SimpleNamespace(thread=None, start=mock.Mock(), stop=mock.Mock())
                with job._router_observers(watcher, settled, result, snapshot, root/'stall.json', 2, 'all'):
                    pass
                receipt = json.loads((root/'stall.json').read_text())
                self.assertEqual(receipt['interrupt_acknowledged'], result['interrupt_acknowledged'])
                self.assertTrue(receipt['observer_cleanup']['complete'])


class NativePhaseAccountingTests(unittest.TestCase):
    def test_thermal_source_capture_remains_exact_after_workspace_promotion(self):
        job=load_job()
        with tempfile.TemporaryDirectory() as folder:
            root=Path(folder).resolve();source=root/'input.kicad_pcb';output=root/'router';output.mkdir()
            for suffix in ('.kicad_pcb','.kicad_pro','.kicad_dru','.kicad_sch'):
                source.with_suffix(suffix).write_text('original '+suffix)
            captured=Path(job._capture_thermal_source(source,output))
            receipt=json.loads((output/'native-thermal-source.json').read_text())
            self.assertEqual(receipt['captured']['sha256'],lean.digest(source))
            for suffix in ('.kicad_pcb','.kicad_pro','.kicad_dru','.kicad_sch'):
                self.assertEqual(captured.with_suffix(suffix).read_bytes(),source.with_suffix(suffix).read_bytes())
            source.write_text('promoted routed candidate')
            self.assertEqual(captured.read_text(),'original .kicad_pcb')
            self.assertNotIn(str(source),receipt['inputs'])
            with self.assertRaises(FileExistsError):job._capture_thermal_source(source,output)

    def test_checked_thermal_fill_requires_true_and_durably_retains_failure(self):
        job=load_job()
        with tempfile.TemporaryDirectory() as folder:
            root=Path(folder).resolve();board=root/'base.kicad_pcb';board.write_text('original native fixture bytes')
            board.with_suffix('.kicad_pro').write_text('{}');board.with_suffix('.kicad_dru').write_text('(version 1)')
            native=mock.Mock();native.Zones.return_value=[]
            for returned in (False,None,1):
                receipt=root/f'fill-{returned}.json';events=root/f'events-{returned}.jsonl'
                with mock.patch.object(job.pcbnew,'Version',return_value='10.0.6',create=True), \
                     mock.patch.object(job.pcbnew,'ZONE_FILLER',return_value=mock.Mock(Fill=mock.Mock(return_value=returned)),create=True), \
                     mock.patch.object(job.pcbnew,'SaveBoard',create=True) as save, \
                     self.assertRaisesRegex(ValueError,'did not return True'):
                    job._checked_thermal_fill(native,board,receipt,events,'controlled-fill')
                save.assert_not_called()
                value=json.loads(receipt.read_text());self.assertFalse(value['invocation']['saved'])
                self.assertIsNot(value['fill_result'],True)
                self.assertEqual(board.read_text(),'original native fixture bytes')
                self.assertEqual(json.loads(events.read_text())['status'],'failed')

    def test_checked_fill_saved_hash_and_no_hidden_refill_drc_bind_actual_outputs(self):
        job=load_job()
        with tempfile.TemporaryDirectory() as folder:
            root=Path(folder).resolve();board=root/'base.kicad_pcb';board.write_text('before fill')
            board.with_suffix('.kicad_pro').write_text('{}');board.with_suffix('.kicad_dru').write_text('(version 1)')
            native=mock.Mock();native.Zones.return_value=[];events=root/'events.jsonl';fill=root/'fill.json'
            def save(path,board,skip_settings):
                self.assertIs(skip_settings,True)
                Path(path).write_text('saved filled native')
                return True
            with mock.patch.object(job.pcbnew,'Version',return_value='10.0.6',create=True), \
                 mock.patch.object(job.pcbnew,'ZONE_FILLER',return_value=mock.Mock(Fill=mock.Mock(return_value=True)),create=True), \
                 mock.patch.object(job.pcbnew,'SaveBoard',side_effect=save,create=True) as saved:
                value=job._checked_thermal_fill(native,board,fill,events,'controlled-fill')
            saved.assert_called_once_with(str(board),native,True)
            self.assertIs(value['fill_result'],True);self.assertTrue(value['invocation']['saved'])
            self.assertEqual(value['candidate']['sha256'],lean.digest(board))
            self.assertEqual(value['inputs'][str(board)],lean.digest(board))
            def run(command,**kwargs):
                self.assertNotIn('--refill-zones',command)
                Path(command[command.index('-o')+1]).write_text(json.dumps(dict(violations=[],unconnected_items=[])))
                return types.SimpleNamespace(returncode=0,stdout='native completed',stderr='')
            with mock.patch.object(job,'KICAD_CLI',sys.executable),mock.patch.object(job.lean,'run_stage',side_effect=run):
                raw,receipt=job._thermal_drc(board,root,events,'controlled-native')
            proof=json.loads(Path(receipt).read_text());self.assertEqual(proof['returncode'],0)
            self.assertEqual(proof['report']['sha256'],lean.digest(proof['report']['path']))
            self.assertEqual(proof['candidate']['sha256'],lean.digest(board))
            self.assertEqual(proof['tool']['sha256'],lean.digest(Path(sys.executable).resolve()))
            self.assertEqual(raw,dict(violations=[],unconnected_items=[]))

    def test_checked_thermal_save_requires_true_and_preserves_failure_receipt(self):
        job=load_job()
        with tempfile.TemporaryDirectory() as folder:
            root=Path(folder).resolve();board=root/'base.kicad_pcb';board.write_text('original native fixture bytes')
            board.with_suffix('.kicad_pro').write_text('exact authored project')
            board.with_suffix('.kicad_dru').write_text('(version 1)')
            native=mock.Mock();native.Zones.return_value=[]
            for returned in (False,None,1):
                receipt=root/f'save-{returned}.json';events=root/f'events-save-{returned}.jsonl'
                with mock.patch.object(job.pcbnew,'Version',return_value='10.0.6',create=True), \
                     mock.patch.object(job.pcbnew,'ZONE_FILLER',return_value=mock.Mock(Fill=mock.Mock(return_value=True)),create=True), \
                     mock.patch.object(job.pcbnew,'SaveBoard',return_value=returned,create=True) as save, \
                     self.assertRaisesRegex(ValueError,'board save did not return True'):
                    job._checked_thermal_fill(native,board,receipt,events,'controlled-save')
                save.assert_called_once_with(str(board),native,True)
                value=json.loads(receipt.read_text());self.assertTrue(value['fill_result'])
                self.assertFalse(value['invocation']['saved'])
                self.assertEqual(board.with_suffix('.kicad_pro').read_text(),'exact authored project')
                self.assertEqual(json.loads(events.read_text())['status'],'failed')

    def test_native_thermal_drc_nonzero_retains_raw_receipt_and_stops(self):
        job=load_job()
        with tempfile.TemporaryDirectory() as folder:
            root=Path(folder);board=root/'base.kicad_pcb';board.write_text('saved filled native')
            with mock.patch.object(job,'KICAD_CLI',sys.executable), \
                 mock.patch.object(job.lean,'run_stage',return_value=types.SimpleNamespace(returncode=2,stdout='',stderr='native failed')), \
                 self.assertRaisesRegex(ValueError,'did not produce successful'):
                job._thermal_drc(board,root,root/'events.jsonl','failed-native')
            receipt=json.loads((root/'failed-native-drc.json').read_text())
            self.assertEqual(receipt['returncode'],2);self.assertIsNone(receipt['report']['sha256'])
            self.assertIn('cause',receipt)

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
