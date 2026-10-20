"""Owned ML command boundaries. The fixture backend makes no modeling/CAD claims."""
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import textwrap
import time
import unittest

import pcb_cli
import pcb_evidence


BACKEND = r'''
import argparse, hashlib, json, os
from pathlib import Path
import subprocess, sys, time

def sha(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()

def parse(arguments):
    parser = argparse.ArgumentParser()
    parser.add_argument('action', choices=['dataset', 'features', 'train', 'evaluate', 'predict'])
    parser.add_argument('id')
    for name in ['manifest', 'dataset', 'model', 'features', 'target', 'algorithm', 'regularization']:
        parser.add_argument('--' + name)
    parser.add_argument('--root', type=Path, default=Path.cwd())
    parser.add_argument('--output', type=Path)
    parser.add_argument('--json', action='store_true')
    return parser.parse_args(arguments)

def dependencies(root, arguments):
    args = parse(arguments)
    result = {}
    for name in ['manifest', 'dataset', 'model', 'features']:
        if not getattr(args, name):
            continue
        path = (Path(root) / getattr(args, name)).absolute()
        result[str(path)] = sha(path) if path.is_file() else None
        if path.is_file():
            nested = json.loads(path.read_text()).get('nested')
            if nested:
                nested = (Path(root) / nested).absolute()
                result[str(nested)] = sha(nested) if nested.is_file() else None
    return result

def main():
    args = parse(sys.argv[1:])
    mode = os.environ.get('ML_FIXTURE_MODE', '')
    inputs = dependencies(args.root, sys.argv[1:])
    missing = [path for path, digest in inputs.items() if digest is None]
    print('fixture ' + args.action + ' progress', flush=True)
    if mode == 'delay':
        child = subprocess.Popen([sys.executable, '-c',
            'import signal,time;signal.signal(signal.SIGTERM,signal.SIG_IGN);time.sleep(60)'])
        (args.root / 'child.pid').write_text(str(child.pid))
        time.sleep(60)
    if mode == 'mutate_nested':
        Path(args.root / 'nested.json').write_text('{"changed":true}')
    if mode == 'appear' and missing:
        Path(missing[0]).write_text('{}')
    artifact = args.output.parent / (args.action + '-artifact.json')
    if mode == 'outside':
        artifact = args.root / 'outside.json'
    artifact.write_text(json.dumps({'action':args.action, 'fixture':True}))
    report = dict(schema='iot-lab.pcb-ml-result.v1', action=args.action, id=args.id,
        status='blocked' if missing else 'failed' if mode == 'failure' else 'passed',
        qualified=False, adopt_model=False,
        # Intentionally omit nested inputs: the supervisor must retain the declared closure.
        inputs={path:digest for path,digest in inputs.items() if digest and Path(path).name != 'nested.json'},
        absent_inputs=missing, tool_inputs={}, artifacts={str(artifact):sha(artifact)})
    if mode == 'wrong_action': report['action'] = 'predict'
    if mode == 'wrong_id': report['id'] = 'ANOTHER'
    if mode == 'qualified': report['qualified'] = True
    if mode == 'adopt': report['adopt_model'] = True
    if mode == 'wrong_schema': report['schema'] = 'iot-lab.design-assessment.v1'
    if mode == 'bad_artifact': artifact.write_text('changed')
    if mode == 'no_artifact': report['artifacts'] = {}
    args.output.write_text(json.dumps(report))
    print(json.dumps({'status':report['status'], 'report':str(args.output)}), flush=True)
    return 0 if mode == 'exit_lie' else 1 if report['status'] != 'passed' else 0

if __name__ == '__main__':
    raise SystemExit(main())
'''


class MlCliTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='pcb-ml-cli-')
        self.root = Path(self.temp.name).resolve()
        self.runs = self.root / '.gate/cli'
        source = Path(__file__).resolve().parent
        for name in ('pcb', 'pcb_cli.py', 'pcb_operations.py', 'lean_owned.py', 'lean_owned_exec.py',
                     'lean_workflow.py', 'pcb_workflow.py', 'pcb_timing.py', 'pcb_cycle.py',
                     'pcb_evidence.py', 'pcb_benchmark.py', 'pcb_observation_inputs.py'):
            target = self.root / 'tools' / name
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(source / name, target)
        (self.root / 'tools/pcb_ml.py').write_text(textwrap.dedent(BACKEND))
        self.input = self.root / 'input.json'
        self.input.write_text('{}')
        self.env = dict(os.environ, PYTHON_MODERN=sys.executable, PYTHONDONTWRITEBYTECODE='1',
                        PCB_RUNS_DIR=str(self.runs), NODE=str(self.root / 'absent-node'))
        self.env.pop('PYTHONPATH', None)

    def tearDown(self):
        try:
            for folder in self.runs.glob('run-*'):
                if pcb_cli.controller_alive(folder) is True or pcb_cli.status(folder)['status'] == 'starting':
                    (folder / 'cancel.request').write_text('{}')
                    self.until(lambda: pcb_cli.controller_alive(folder) is False, 15)
        finally:
            self.temp.cleanup()

    def cli(self, *args, mode=''):
        return subprocess.run([sys.executable, str(self.root / 'tools/pcb'), *args], cwd=self.root,
            env=dict(self.env, ML_FIXTURE_MODE=mode), text=True, stdout=subprocess.PIPE,
            stderr=subprocess.PIPE, timeout=20)

    def until(self, predicate, seconds=10):
        deadline = time.monotonic() + seconds
        while time.monotonic() < deadline:
            value = predicate()
            if value:
                return value
            time.sleep(.03)
        self.fail('owned ML fixture did not settle before its test deadline')

    def observe(self, action='dataset', flags=None, mode='', supervisor=None):
        flags = flags or ['--manifest', str(self.input)]
        response = self.cli('ml', '--json', *(supervisor or []), action, 'TRIAL', *flags, mode=mode)
        self.assertTrue(response.stdout.strip(), response.stderr)
        final = json.loads(response.stdout.splitlines()[-1])
        folder = self.runs / final['run_id']
        return response, folder, json.loads((folder / 'result.json').read_text())

    def test_all_actions_run_without_board_context_or_node_and_seal_owned_artifacts(self):
        actions = {
            'dataset':['--manifest', str(self.input)],
            'features':['--manifest', str(self.input)],
            'train':['--dataset', str(self.input), '--target','route_s', '--algorithm','ridge', '--regularization','.5'],
            'evaluate':['--dataset',str(self.input),'--model',str(self.input)],
            'predict':['--model',str(self.input),'--features',str(self.input)],
        }
        for action, flags in actions.items():
            with self.subTest(action=action):
                response, folder, result = self.observe(action, flags)
                self.assertEqual(response.returncode, 0, response.stdout + response.stderr)
                self.assertEqual(pcb_evidence.verify(folder)['status'], 'passed')
                self.assertEqual(result['scope'], 'ml_observation')
                self.assertEqual(result['ml_action'], action)
                self.assertEqual(result['ml_id'], 'TRIAL')
                self.assertFalse(result['qualified'])
                self.assertFalse(result['adopt_model'])
                self.assertFalse(result['release_approved'])
                self.assertTrue(result['cleanup']['complete'])
                self.assertIsNone(json.loads((folder / 'run.json').read_text())['project'])
                self.assertIn(str(self.input), result['engineering_inputs'])
                self.assertTrue(any(row['type'] == 'tool.output' and 'progress' in row.get('text','')
                                    for row in pcb_cli.events(folder)))
                artifact = Path(next(iter(result['artifacts'])))
                self.assertTrue(artifact.is_relative_to(folder / 'operation'))
                self.assertEqual(result['evidence_sha256'][str(artifact.relative_to(folder))],
                                 result['artifacts'][str(artifact)])
                artifact.write_text('{}')
                with self.assertRaisesRegex(ValueError, 'changed'):
                    pcb_evidence.verify(folder)
        self.assertFalse((self.root / 'hardware-design').exists())

    def test_missing_input_is_a_sealed_blocked_observation_without_a_fake_hash(self):
        missing = self.root / 'missing.json'
        response, folder, result = self.observe(flags=['--manifest',str(missing)])
        self.assertEqual(response.returncode, 1, response.stdout + response.stderr)
        self.assertEqual(pcb_evidence.verify(folder)['status'], 'failed')
        self.assertEqual(result['engineering_status'], 'blocked')
        self.assertIn(str(missing), result['engineering_absent_inputs'])
        self.assertNotIn(str(missing), result['engineering_inputs'])

    def test_predeclared_nested_input_cannot_change_when_backend_omits_its_hash(self):
        nested = self.root / 'nested.json'
        nested.write_text('{}')
        self.input.write_text(json.dumps(dict(nested=str(nested))))
        response, _, result = self.observe(mode='mutate_nested')
        self.assertEqual(response.returncode, 2, response.stdout + response.stderr)
        self.assertIn('inputs changed', result['cause'])

    def test_absent_input_appearing_during_observation_cannot_be_sealed_current(self):
        response, _, result = self.observe(flags=['--manifest',str(self.root/'missing.json')], mode='appear')
        self.assertEqual(response.returncode, 2, response.stdout + response.stderr)
        self.assertIn('absent input appeared', result['cause'])

    def test_wrong_identity_type_qualification_or_model_adoption_is_rejected(self):
        for mode in ('wrong_action','wrong_id','wrong_schema','qualified','adopt'):
            with self.subTest(mode=mode):
                response, _, result = self.observe(mode=mode)
                self.assertEqual(response.returncode, 2, response.stdout + response.stderr)
                self.assertEqual(result['status'], 'error')
                self.assertTrue(result['cleanup']['complete'])

    def test_output_escape_tampering_and_empty_artifact_inventories_are_rejected(self):
        for mode in ('outside','bad_artifact','no_artifact'):
            with self.subTest(mode=mode):
                response, _, result = self.observe(mode=mode)
                self.assertEqual(response.returncode, 2, response.stdout + response.stderr)
                self.assertIn('artifact', result['cause'])

    def test_backend_nonpassing_verdict_cannot_exit_success(self):
        response, _, result = self.observe(flags=['--manifest',str(self.root/'missing.json')], mode='exit_lie')
        self.assertEqual(response.returncode, 2, response.stdout + response.stderr)
        self.assertIn('exit disagrees', result['cause'])

    def test_supervisor_paths_and_unknown_actions_are_rejected_before_admission(self):
        for arguments in (['dataset','TRIAL','--output',str(self.root/'report.json')],
                          ['dataset','TRIAL','--root='+str(self.root)], ['execute','TRIAL']):
            with self.subTest(arguments=arguments):
                response = self.cli('ml','--json',*arguments)
                self.assertEqual(response.returncode, 2, response.stdout + response.stderr)
                self.assertEqual(list(self.runs.glob('run-*')), [])

    def test_ml_can_attach_to_a_cycle_with_a_different_dataset_id_and_cannot_adopt_cad(self):
        board = self.root / 'hardware-design/boards/X'
        board.mkdir(parents=True)
        (board/'gate.json').write_text(json.dumps(dict(project='cad/X')))
        created = self.cli('cycle','start','X','--owner','fixture-integrator','--json')
        self.assertEqual(created.returncode, 0, created.stdout + created.stderr)
        cycle = json.loads(created.stdout)['cycle_id']
        shutil.rmtree(self.root/'hardware-design')
        response, folder, result = self.observe(supervisor=['--cycle',cycle])
        self.assertEqual(response.returncode, 0, response.stdout + response.stderr)
        self.assertEqual(result['board'], 'X')
        self.assertEqual(result['ml_id'], 'TRIAL')
        finished = self.cli('cycle','finish',cycle,'--json')
        self.assertEqual(finished.returncode, 0, finished.stdout + finished.stderr)
        recorded = json.loads(finished.stdout)
        self.assertEqual(recorded['runs'][0]['stage'], 'verification')
        self.assertTrue(recorded['runs'][0]['evidence_verified'])
        adopted = self.cli('adopt',folder.name,'--json')
        self.assertEqual(adopted.returncode, 2, adopted.stdout + adopted.stderr)
        self.assertIn('cannot adopt native CAD', adopted.stdout)

    def test_detached_progress_and_owned_descendant_cleanup_on_deadline(self):
        response = self.cli('ml','--json','--detach','--heartbeat','.1','--timeout','1.5',
                            'dataset','TRIAL','--manifest',str(self.input),mode='delay')
        self.assertEqual(response.returncode, 0, response.stdout + response.stderr)
        folder = self.runs / json.loads(response.stdout)['run_id']
        self.until(lambda:(self.root/'child.pid').is_file())
        pid = int((self.root/'child.pid').read_text())
        def stopped():
            if sys.platform.startswith('linux'):
                try:
                    status = Path(f'/proc/{pid}/status').read_text()
                except FileNotFoundError:
                    return True
                state = next(line.split()[1] for line in status.splitlines()
                             if line.startswith('State:'))
                return state in ('Z', 'X', 'x')
            process = subprocess.run(['/bin/ps','-o','stat=','-p',str(pid)],
                                     capture_output=True,text=True,timeout=1)
            if process.returncode == 1 and not process.stdout.strip() and not process.stderr.strip():
                return True
            self.assertEqual(process.returncode, 0, process.stderr)
            self.assertTrue(process.stdout.strip(), 'ps returned no process state')
            return process.stdout.strip().startswith('Z')
        self.assertFalse(stopped(), 'cleanup observer must detect the live descendant')
        self.until(lambda:any(row['type']=='tool.output' and 'progress' in row.get('text','')
                              for row in pcb_cli.events(folder)))
        self.assertNotIn(pcb_cli.status(folder)['status'], pcb_cli.TERMINAL)
        result = self.until(lambda:pcb_cli.status(folder) if pcb_cli.status(folder)['status'] in pcb_cli.TERMINAL else None)
        self.assertEqual(result['status'], 'timeout', result)
        self.assertTrue(result['cleanup']['complete'])
        self.until(stopped)


if __name__ == '__main__':
    unittest.main()
