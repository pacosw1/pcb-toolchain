"""Durable runs (records under .gate/studio/runs survive an engine crash) and run.cancel semantics."""
import asyncio
import json
import os
import signal
import stat
import subprocess
import sys

import pytest
from websockets.asyncio.client import connect

from pcbstudio import runs as runs_mod
from pcbstudio.runs import Runs

# SLOW writes its pid and sleeps (a run that is still running when the engine dies); other boards pass at once.
FAKE_PCB = r'''#!/bin/sh
board=$2
echo '{"schema_version": 1, "run_id": "run-'$board'", "seq": 1, "type": "run.start", "board": "'$board'"}'
if [ "$board" = SLOW ]; then echo $$ > "$(pwd)/slow.pid"; exec sleep 30; fi
echo '{"schema_version": 1, "run_id": "run-'$board'", "seq": 2, "type": "run.end", "status": "passed", "exit_code": 0, "cause": "ok", "metrics": {"drc_errors": 0}, "findings": [], "elapsed_s": 0.1}'
'''


@pytest.fixture
def project(tmp_path):
    (tmp_path / 'hardware-design/boards/DEMO').mkdir(parents=True)
    (tmp_path / 'tools').mkdir()
    tool = tmp_path / 'tools/pcb'
    tool.write_text(FAKE_PCB)
    tool.chmod(tool.stat().st_mode | stat.S_IEXEC)
    return tmp_path


def _serve():
    p = subprocess.Popen([sys.executable, '-m', 'pcbstudio', 'serve'], stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                         text=True, env={**os.environ})
    ready = json.loads(p.stdout.readline()[6:])
    return p, f'ws://127.0.0.1:{ready["port"]}/?t={ready["token"]}'


async def _rpc(ws, i, method, **params):
    await ws.send(json.dumps({'jsonrpc': '2.0', 'id': i, 'method': method, 'params': params}))
    while True:
        msg = json.loads(await asyncio.wait_for(ws.recv(), 10))
        if msg.get('id') == i:
            assert 'error' not in msg, msg
            return msg['result']


def test_runs_survive_an_engine_crash(project):
    p, url = _serve()
    try:
        async def first():
            async with connect(url) as ws:
                await _rpc(ws, 1, 'project.open', root=str(project))
                fast = await _rpc(ws, 2, 'gate.check', board='DEMO')
                slow = await _rpc(ws, 3, 'gate.check', board='SLOW')
                for i in range(100):
                    rs = {r['id']: r for r in await _rpc(ws, 10 + i, 'run.list')}
                    if rs[fast['id']]['state'] == 'passed' and (project / 'slow.pid').is_file():
                        return fast['id'], slow['id']
                    await asyncio.sleep(0.1)
                raise AssertionError('runs did not start')
        fast_id, slow_id = asyncio.run(first())
    finally:
        p.kill()                                         # engine death: SIGKILL, no cleanup
        p.wait(timeout=10)
        pid = (project / 'slow.pid').read_text().strip() if (project / 'slow.pid').is_file() else None
        if pid:                                          # the orphaned CLI process (its own session)
            try:
                os.killpg(int(pid), signal.SIGTERM)
            except ProcessLookupError:
                pass
    assert fast_id.startswith('r-') and len(fast_id) == 18 and fast_id != slow_id
    record = json.loads((project / '.gate/studio/runs' / slow_id / 'run.json').read_text())
    assert record['state'] == 'running'

    p, url = _serve()
    try:
        async def second():
            async with connect(url) as ws:
                assert await _rpc(ws, 1, 'run.list') == []     # records load on project.open
                await _rpc(ws, 2, 'project.open', root=str(project))
                rs = {r['id']: r for r in await _rpc(ws, 3, 'run.list')}
                got = await _rpc(ws, 4, 'run.get', id=fast_id)
                return rs, got
        rs, got = asyncio.run(second())
    finally:
        p.stdin.close()
        p.wait(timeout=10)
    assert set(rs) == {fast_id, slow_id}
    assert rs[fast_id]['state'] == 'passed' and rs[fast_id]['metrics'] == {'drc_errors': 0}
    assert rs[slow_id]['state'] == 'interrupted'
    assert [e['type'] for e in got['events']] == ['run.start', 'run.end']
    record = json.loads((project / '.gate/studio/runs' / slow_id / 'run.json').read_text())
    assert record['state'] == 'interrupted'              # the record itself is updated


def test_cancel_waits_for_exit_and_tolerates_a_gone_process(project):
    async def go():
        r = Runs()
        run = r.start(project, 'check', 'SLOW')
        for _ in range(100):
            if (project / 'slow.pid').is_file() and run.proc:
                break
            await asyncio.sleep(0.05)
        s = r.cancel(run.id)
        assert s['state'] == 'running' and run.cancel_requested     # not cancelled before the process exits
        for _ in range(200):
            if run.state != 'running':
                break
            await asyncio.sleep(0.02)
        assert run.state == 'cancelled'
        assert r.cancel(run.id)['state'] == 'cancelled'             # cancel after the end: no error
        record = json.loads((project / '.gate/studio/runs' / run.id / 'run.json').read_text())
        assert record['state'] == 'cancelled'
    asyncio.run(go())


def test_killpg_of_an_exited_process_group_does_not_raise():
    p = subprocess.Popen(['true'], start_new_session=True)
    p.wait()
    runs_mod._killpg(p.pid)                      # ProcessLookupError is swallowed


LONG_LINE = r'''#!/bin/sh
printf '{"run_id": "run-long", "type": "run.end", "status": "passed", "exit_code": 0, "cause": "'
head -c 200000 /dev/zero | tr '\0' a
printf '"}\n'
'''


def test_an_event_longer_than_the_stream_buffer_is_read(project):
    (project / 'tools/pcb').write_text(LONG_LINE)

    async def go():
        r = Runs()
        run = r.start(project, 'check', 'DEMO')
        for _ in range(200):
            if run.state != 'running':
                break
            await asyncio.sleep(0.02)
        assert run.state == 'passed', run.stderr
        assert len(run.end['cause']) == 200000
    asyncio.run(go())
