"""Public engine admission and local viewer boundaries; native proof is separate."""
import argparse
import http.client
import json
from pathlib import Path
import tempfile
import threading
import unittest
from unittest.mock import patch

import pcb_cli
import pcb_routing_trial
from pcb_engine import viewer


class PublicAdmissionTests(unittest.TestCase):
    def test_engine_policy_rejected_before_creating_run(self):
        with tempfile.TemporaryDirectory() as d:
            root = Path(d)
            spec = root / 'spec.json'
            spec.write_text('{"schema":"iot-lab.engine-policy.v1","routing":{},"shell":"echo bypass"}')
            args = argparse.Namespace(command='route', spec=spec, router='engine', timeout=60,
                                      board='ENV-SENSE', from_run=None, engineering_manifest=None,
                                      design_contract=None)
            with self.assertRaises(ValueError):
                pcb_cli.start_run(args, root / 'runs')
            self.assertFalse((root / 'runs').exists())

    def test_native_context_does_not_claim_container_isolation(self):
        with patch('lean_resources.limits', return_value=(2, 4)), patch('os.cpu_count', return_value=8):
            value = pcb_routing_trial.native_execution_context()
            receipt = json.loads(value['raw'])
            self.assertIsNone(value['image_id'])
            self.assertIsNone(value['container_id'])
            self.assertFalse(receipt['memory_is_hard_limit'])
            self.assertFalse(receipt['network_isolated'])
            self.assertEqual(receipt['memory_bytes'], 4 * 1073741824)
            self.assertEqual(value['raw'], pcb_routing_trial.native_execution_context()['raw'])

    def test_native_context_rejects_oversubscribed_processor_budget(self):
        with patch('lean_resources.limits', return_value=(16, 4)), patch('os.cpu_count', return_value=8):
            with self.assertRaises(ValueError):
                pcb_routing_trial.native_execution_context()

    def test_legacy_context_still_requires_inspect(self):
        with patch.dict('os.environ', {}, clear=True):
            with self.assertRaisesRegex(ValueError, 'Docker inspect'):
                pcb_routing_trial.execution_context()

    def test_plain_fastroute_route_uses_the_engine_host_runtime(self):
        import pcb_operations
        for platform, expected in (('darwin', 'native'), ('linux', 'container')):
            with self.subTest(platform=platform), tempfile.TemporaryDirectory() as d:
                folder = Path(d) / 'run'
                (folder / 'operation').mkdir(parents=True)
                (folder / 'run.json').write_text(json.dumps(dict(root=d, board='X', operation='route',
                    router='fastroute', spec={}, timeout_s=60)))
                with patch('sys.platform', platform), patch.object(pcb_operations, 'snapshot', return_value={}), \
                        patch.object(pcb_operations, 'board_config', return_value=(None, {}, Path(d) / 'X.kicad_sch')), \
                        patch.object(pcb_routing_trial, 'prepare', side_effect=LookupError('stop')) as prepare:
                    with self.assertRaises(LookupError):
                        pcb_operations.run(folder)
                self.assertEqual(prepare.call_args.kwargs.get('runtime'), expected)

    def route_args(self, spec, router='route-json'):
        return argparse.Namespace(command='route', spec=spec, router=router, timeout=60, board='FIELD-24V-BUS',
                                  from_run=None, engineering_manifest=None, design_contract=None)

    def test_route_json_spec_defaults_to_the_board_route_json(self):
        args = self.route_args(None)
        with tempfile.TemporaryDirectory() as d, patch('pcb_cli.shutil.which', return_value=None):
            with self.assertRaisesRegex(ValueError, 'Node.js'):
                pcb_cli.start_run(args, Path(d) / 'runs')
        self.assertEqual(args.spec, pcb_cli.ROOT / 'hardware-design/boards/FIELD-24V-BUS/route.json')

    def test_route_without_spec_rejected_for_other_routers(self):
        with tempfile.TemporaryDirectory() as d:
            with self.assertRaisesRegex(ValueError, 'spec'):
                pcb_cli.start_run(self.route_args(None, 'fastroute'), Path(d) / 'runs')
            self.assertFalse((Path(d) / 'runs').exists())

    def test_route_json_wrong_schema_rejected_before_creating_run(self):
        with tempfile.TemporaryDirectory() as d:
            spec = Path(d) / 'route.json'
            spec.write_text('{"schema":"iot-lab.routing-policy.v1"}')
            with self.assertRaisesRegex(ValueError, 'iot-lab.route.v1'):
                pcb_cli.start_run(self.route_args(spec), Path(d) / 'runs')
            self.assertFalse((Path(d) / 'runs').exists())

    def route_json_run(self, d, board_file=True):
        import pcb_operations
        folder = Path(d) / 'run'
        (folder / 'operation').mkdir(parents=True)
        (folder / 'run.json').write_text(json.dumps(dict(root=d, board='X', operation='route',
            router='route-json', spec={'schema': 'iot-lab.route.v1'}, timeout_s=60)))
        calls = []

        def execute(folder_, stage, command, workspace, env):
            calls.append(command)
            out = Path(command[command.index('tools/route.py') + 2])
            out.mkdir(parents=True)
            (out / 'X.kicad_pcb').write_text('routed')
            result = dict(board_file=str(out / 'X.kicad_pcb')) if board_file else {}
            (out / 'result.json').write_text(json.dumps(result))
            return 0
        with patch.object(pcb_operations, 'snapshot', return_value={}), \
                patch.object(pcb_operations, 'board_config', return_value=(None, {}, Path(d) / 'X.kicad_sch')), \
                patch.object(pcb_operations, 'execute', side_effect=execute):
            try:
                pcb_operations.run(folder)
            except KeyError:
                pass  # the stubbed snapshot has no files; the route stage is done by then
        return folder, calls

    def test_route_json_router_runs_route_py_on_the_candidate(self):
        with tempfile.TemporaryDirectory() as d:
            folder, calls = self.route_json_run(d)
            native = Path(d) / 'X.kicad_pcb'
            command = calls[0]
            self.assertEqual(command[1:4], ['tools/route.py', 'X', str(folder.resolve() / 'operation/router')])
            self.assertEqual(command[command.index('--input') + 1], str(native))
            config = Path(command[command.index('--config') + 1])
            self.assertEqual(json.loads(config.read_text())['schema'], 'iot-lab.route.v1')
            self.assertEqual(native.read_text(), 'routed')
            self.assertTrue((folder / 'operation/router-summary.json').is_file())

    def test_route_json_success_without_board_file_fails_closed(self):
        with tempfile.TemporaryDirectory() as d, self.assertRaisesRegex(ValueError, 'board_file'):
            self.route_json_run(d, board_file=False)

    def test_cancel_uses_one_shared_control(self):
        with tempfile.TemporaryDirectory() as d, patch('pcb_cli.status', return_value={'status': 'running'}):
            self.assertTrue(pcb_cli.request_cancel(Path(d))['cancellation_requested'])
            self.assertTrue((Path(d) / 'cancel.request').is_file())

    def test_terminal_cancel_does_not_write(self):
        with tempfile.TemporaryDirectory() as d, patch('pcb_cli.status', return_value={'status': 'passed'}):
            pcb_cli.request_cancel(Path(d))
            self.assertFalse((Path(d) / 'cancel.request').exists())


class ViewerTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.server, url = viewer.make_server(Path(self.temp.name))
        self.token = url.split('#', 1)[1]
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join()
        self.temp.cleanup()

    def request(self, method, path, token=None, origin=None, body=None):
        connection = http.client.HTTPConnection('127.0.0.1', self.server.server_port, timeout=5)
        headers = {}
        if token is not None:
            headers['X-PCB-Token'] = token
        if origin is not None:
            headers['Origin'] = origin
        connection.request(method, path, body=body, headers=headers)
        response = connection.getresponse()
        status, data = response.status, response.read()
        connection.close()
        return status, data

    def test_viewer_has_no_arbitrary_file_route(self):
        self.assertEqual(self.request('GET', '/../../etc/passwd', self.token)[0], 403)
        self.assertEqual(self.request('GET', '/state')[0], 403)
        self.assertEqual(self.server.server_address[0], '127.0.0.1')

    def test_mutations_require_origin_token_and_known_action(self):
        with patch('pcb_cli.request_cancel', return_value={'status': 'running'}) as cancel:
            self.assertEqual(self.request('POST', '/cancel', body='{}')[0], 403)
            self.assertEqual(self.request('POST', '/cancel', self.token, 'https://example.org', '{}')[0], 403)
            cancel.assert_not_called()
            self.assertEqual(self.request('POST', '/cancel', self.token, body='{"override":true}')[0], 409)
            cancel.assert_not_called()
            self.assertEqual(self.request('POST', '/cancel', self.token, body='{}')[0], 200)
            cancel.assert_called_once()

    def test_snapshot_is_observation_only(self):
        value = {'run': {'status': 'running'}, 'events': [], 'engine': {}, 'geometry': None}
        with patch.object(viewer.Observation, 'snapshot', return_value=value), patch('pcb_cli.request_cancel') as cancel:
            code, data = self.request('GET', '/state', self.token)
            self.assertEqual(code, 200)
            self.assertEqual(json.loads(data), value)
            cancel.assert_not_called()

    def test_board_projection_retains_rotated_pad_identity(self):
        path = Path(self.temp.name) / 'board.kicad_pcb'
        path.write_text('''(kicad_pcb
          (footprint "p" (at 10 20 90) (property "Reference" "U1")
           (pad "1" smd rect (at 1 0 90) (size 1 2) (layers "F.Cu")))
          (segment (start 0 0) (end 1 1) (width 0.25) (layer "B.Cu"))
          (via (at 1 1) (size 0.6)))''')
        image = viewer.geometry(path)
        self.assertEqual(image['pads'][0]['ref'], 'U1')
        self.assertAlmostEqual(image['pads'][0]['at'][0], 10)
        self.assertAlmostEqual(image['pads'][0]['at'][1], 19)
        self.assertEqual(image['segments'][0]['layer'], 'B.Cu')


if __name__ == '__main__':
    unittest.main()
