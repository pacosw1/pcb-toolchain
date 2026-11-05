"""tools/pcb route --router iotroute: admission, dispatch of iotroute run in the candidate, fail closed."""
import argparse
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

import pcb_cli


class Admission(unittest.TestCase):
    def args(self, spec):
        return argparse.Namespace(command='route', spec=spec, router='iotroute', timeout=60, board='NET-CORE',
                                  from_run=None, engineering_manifest=None, design_contract=None)

    def test_spec_is_optional(self):
        args = self.args(None)
        with tempfile.TemporaryDirectory() as d, patch('pcb_cli.shutil.which', return_value=None):
            with self.assertRaisesRegex(ValueError, 'Node.js'):   # admission passed; stops at the next check
                pcb_cli.start_run(args, Path(d) / 'runs')
        self.assertIsNone(args.spec)

    def test_wrong_policy_rejected_before_creating_run(self):
        with tempfile.TemporaryDirectory() as d:
            spec = Path(d) / 'p.json'
            spec.write_text('{"schema":"iot-lab.iotroute-policy.v1","iters":5,"cmd":"x"}')
            refused = ValueError('unknown iotroute policy fields: cmd')
            with patch('pcb_workflow.route_policy_args', side_effect=refused), self.assertRaisesRegex(ValueError, 'unknown iotroute policy fields'):
                pcb_cli.start_run(self.args(spec), Path(d) / 'runs')
            self.assertFalse((Path(d) / 'runs').exists())


class Dispatch(unittest.TestCase):
    def dispatch(self, d, status='PASS', code=0, record=True):
        import pcb_operations
        folder = Path(d) / 'run'
        (folder / 'operation').mkdir(parents=True)
        (folder / 'run.json').write_text(json.dumps(dict(root=d, board='X', operation='route', router='iotroute',
                                                         timeout_s=60, node='node')))
        calls = []

        def execute(folder_, stage, command, workspace, env):
            calls.append((stage, command))
            out = Path(command[command.index('iotroute') + 3])
            work = Path(str(out) + '.iotroute')
            work.mkdir(parents=True)
            out.write_text('routed')
            if record:
                (work / 'result.json').write_text(json.dumps(dict(status=status, board_file=str(out), drc_errors=1,
                                                                  unconnected=0, parity=0)))
            return code
        with patch.object(pcb_operations, 'snapshot', return_value={}), \
                patch.object(pcb_operations, 'board_config', return_value=(None, {}, Path(d) / 'X.kicad_sch')), \
                patch.object(pcb_operations, 'route_policy_args', return_value=['--iters', '80', '--lock-from', str(Path(d) / 'X.kicad_pcb')]), \
                patch.object(pcb_operations, 'execute', side_effect=execute):
            try:
                pcb_operations.run(folder)
            except KeyError:
                pass  # the stubbed snapshot has no files; the route stage is done by then
        return folder, calls

    def test_runs_iotroute_on_the_candidate_and_adopts_its_board(self):
        with tempfile.TemporaryDirectory() as d:
            folder, calls = self.dispatch(d)
            native = Path(d) / 'X.kicad_pcb'
            stage, command = calls[0]
            self.assertEqual(stage, 'route')
            self.assertEqual(command[:5], ['node', 'tools/router/route-dispatch.mjs', '--timeout', '60', '--'])
            self.assertEqual(command[5:9], ['iotroute', 'run', 'X', str(folder.resolve() / 'operation/router/X.kicad_pcb')])
            self.assertEqual(command[command.index('--pcb') + 1], str(native))
            self.assertEqual(command[command.index('--lock-from') + 1], str(native))
            self.assertEqual(command[command.index('--iters') + 1], '80')
            self.assertEqual(native.read_text(), 'routed')
            self.assertEqual(json.loads((folder / 'operation/router-summary.json').read_text())['status'], 'PASS')

    def test_drc_fail_is_a_failed_route_with_a_cause_and_no_copy(self):
        with tempfile.TemporaryDirectory() as d:
            folder, _ = self.dispatch(d, status='FAIL', code=1)
            self.assertFalse((Path(d) / 'X.kicad_pcb').exists())
            summary = json.loads((folder / 'operation/router-summary.json').read_text())
            self.assertIn('iotroute DRC not clean: errors 1', summary['cause'])   # the failed result's cause

    def test_success_without_pass_record_fails_closed(self):
        with tempfile.TemporaryDirectory() as d, self.assertRaisesRegex(ValueError, 'PASS record'):
            self.dispatch(d, record=False)


if __name__ == '__main__':
    unittest.main()
