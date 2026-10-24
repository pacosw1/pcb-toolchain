"""gate.check end to end over the WebSocket server, with a stand-in tools/pcb that emits iot-lab style events."""
import asyncio
import json
import os
import stat
import subprocess
import sys

from websockets.asyncio.client import connect

FAKE_PCB = '''#!/bin/sh
echo '{"schema_version": 1, "run_id": "run-test", "seq": 1, "type": "run.start", "board": "'$2'"}'
echo '{"schema_version": 1, "run_id": "run-test", "seq": 2, "type": "stage.start", "stage": "drc"}'
echo 'not json output line'
echo '{"schema_version": 1, "run_id": "run-test", "seq": 3, "type": "run.end", "status": "passed", "exit_code": 0, "cause": "all configured gate targets met", "metrics": {"drc_errors": 0}, "findings": [], "elapsed_s": 0.1}'
'''


def make_project(tmp_path):
    (tmp_path / 'hardware-design/boards/DEMO').mkdir(parents=True)
    tools = tmp_path / 'tools'
    tools.mkdir()
    pcb = tools / 'pcb'
    pcb.write_text(FAKE_PCB)
    pcb.chmod(pcb.stat().st_mode | stat.S_IEXEC)
    return tmp_path


def test_gate_check_streams_events(tmp_path):
    root = make_project(tmp_path)
    p = subprocess.Popen([sys.executable, '-m', 'pcbstudio', 'serve'], stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                         text=True, env={**os.environ})
    try:
        port = json.loads(p.stdout.readline()[6:])['port']

        async def go():
            async with connect(f'ws://127.0.0.1:{port}') as ws:
                async def call(i, method, **params):
                    await ws.send(json.dumps({'jsonrpc': '2.0', 'id': i, 'method': method, 'params': params}))
                await call(1, 'project.open', root=str(root))
                await call(2, 'gate.check', board='DEMO', fresh=True)
                seen, final, replies = [], None, {}
                while final is None:
                    msg = json.loads(await asyncio.wait_for(ws.recv(), 10))
                    if 'id' in msg:
                        replies[msg['id']] = msg
                    elif msg['method'] == 'run.event':
                        seen.append(msg['params']['event']['type'])
                    elif msg['method'] == 'run.state' and msg['params']['state'] != 'running':
                        final = msg['params']
                await call(3, 'run.get', id=final['id'])
                while 3 not in replies:
                    msg = json.loads(await asyncio.wait_for(ws.recv(), 10))
                    if 'id' in msg:
                        replies[msg['id']] = msg
                return seen, final, replies
        seen, final, replies = asyncio.run(go())
        assert replies[2]['result']['state'] == 'running'
        assert seen == ['run.start', 'stage.start', 'output.text', 'run.end']
        assert final['state'] == 'passed' and final['metrics'] == {'drc_errors': 0} and final['run_id'] == 'run-test'
        assert len(replies[3]['result']['events']) == 4
    finally:
        p.stdin.close()
        p.wait(timeout=10)


def test_rejects_bad_board_names(tmp_path):
    from pcbstudio.runs import Runs

    async def go():
        for bad in ('../x', '-rf', ''):
            try:
                Runs().start_check(make_project(tmp_path / bad.replace('/', '_').replace('-', 'm') or 'e'), bad)
            except ValueError:
                continue
            raise AssertionError(f'accepted {bad!r}')
    asyncio.run(go())
