"""Candidate runs (op.build, op.route, run.candidate, run.adopt) with a stand-in tools/pcb that writes iot-lab style
run records: run.end carries `candidate` (absolute, under evidence_dir/workspace/), `candidate_verified`,
`identity_preserved` and the candidate's gate `metrics` (tools/pcb_operations.py run(), tools/pcb_cli.py worker())."""
import asyncio
import json
import stat
from pathlib import Path

import pytest

from pcbstudio import api
from pcbstudio.runs import Runs, routing_policy

REL = 'hardware-design/boards/DEMO/cad/DEMO/DEMO.kicad_pcb'
BOARD = '''(kicad_pcb (version 20240108) (generator "test")
 (gr_rect (start 0 0) (end 20 10) (layer "Edge.Cuts") (width 0.1))
 (footprint "R" (layer "F.Cu") (at 5 5) (property "Reference" "R1")
  (pad "1" smd rect (at -1 0) (size 1 1) (layers "F.Cu") (net "/A"))
  (pad "2" smd rect (at 1 0) (size 1 1) (layers "F.Cu") (net "GND")))
 %s)
'''
# $1 = op. route copies its --spec into the run folder so the test can read what the engine wrote. The candidate is
# the canonical board plus one segment; `bad` boards fail their candidate gate; adopt replaces the canonical file.
FAKE_PCB = r'''#!/bin/sh
op=$1; board=$2
root=$(pwd); rid=run-$op-$board; ev=$root/.gate/cli/$rid; cand=$ev/workspace/''' + REL + r'''
if [ "$op" = adopt ]; then
  rid=$2; ev=$root/.gate/cli/$rid; cand=$ev/workspace/''' + REL + r'''
  [ -f "$cand" ] || { echo '{"status": "error", "exit_code": 2, "cause": "no such run"}'; exit 2; }
  tgt=$root/''' + REL + r'''; cp "$tgt" "$ev/backup.kicad_pcb"; cp "$cand" "$tgt"
  echo '{"schema_version": 1, "board": "DEMO", "target": "'$tgt'", "before_sha256": "b", "after_sha256": "a", "candidate_run": "'$rid'", "adopted_at": 1}'
  exit 0
fi
if [ "$board" = NOPE ]; then echo '{"status": "error", "exit_code": 2, "cause": "unknown board NOPE"}'; exit 2; fi
mkdir -p $(dirname $cand)
if [ "$op" = route ]; then
  while [ $# -gt 0 ]; do [ "$1" = --spec ] && cp "$2" $ev/spec.json; [ "$1" = --timeout ] && echo $2 > $ev/timeout; shift; done
fi
sed 's|^ )$| (segment (start 4 5) (end 6 5) (width 0.2) (layer "F.Cu") (net "/A")))|' "$root/''' + REL + r'''" > $cand
echo '{"schema_version": 1, "run_id": "'$rid'", "seq": 1, "type": "run.start", "board": "'$board'"}'
echo '{"schema_version": 1, "run_id": "'$rid'", "seq": 2, "type": "tool.exit", "stage": "'$op'", "status": "passed"}'
if [ "$board" = bad ]; then st=failed; code=1; ver=false; else st=passed; code=0; ver=true; fi
echo '{"schema_version": 1, "run_id": "'$rid'", "seq": 3, "type": "run.end", "status": "'$st'", "exit_code": '$code', "cause": "candidate meets configured gate targets", "candidate_verified": '$ver', "identity_preserved": true, "candidate": "'$cand'", "candidate_sha256": "c0ffee", "metrics": {"drc_errors": 0, "unconnected": 3}, "scope": "candidate_board_gate", "operation": "'$op'", "gate_result": "'$ev'/gate/result.json", "evidence_dir": "'$ev'", "elapsed_s": 0.1}'
exit $code
'''


@pytest.fixture
def project(tmp_path):
    pcb = tmp_path / REL
    pcb.parent.mkdir(parents=True)
    pcb.write_text(BOARD % '')
    (tmp_path / 'hardware-design/registry').mkdir(parents=True)
    (tmp_path / 'hardware-design/registry/boards.json').write_text(json.dumps({'boards': [
        {'id': 'DEMO', 'directory': 'DEMO', 'revisions': [{'revision': 'A', 'project': 'cad/DEMO/DEMO', 'gate': 'DEMO'}]}]}))
    (tmp_path / 'hardware-design/boards/DEMO/gate.json').write_text(json.dumps({'project': 'cad/DEMO/DEMO'}))
    (tmp_path / 'tools').mkdir()
    tool = tmp_path / 'tools/pcb'
    tool.write_text(FAKE_PCB)
    tool.chmod(tool.stat().st_mode | stat.S_IEXEC)
    return tmp_path


async def call(method, **params):
    return await api.registry.call(method, params)


async def finish(summary):
    for _ in range(200):
        r = api.runs.runs[summary['id']]
        if r.state != 'running':
            return r.summary()
        await asyncio.sleep(0.02)
    raise AssertionError('run did not end')


def test_route_candidate_review_and_adopt(project):
    async def go():
        await call('project.open', root=str(project))
        # Short policy, no nets: every named net with pads on the gate's board.
        s = await call('op.route', board='DEMO', policy={'layers': ['F.Cu'], 'passes': 5, 'timeout_s': 30})
        assert s['op'] == 'route' and s['mode'] == 'fastroute' and s['state'] == 'running'
        end = await finish(s)
        ev = project / '.gate/cli/run-route-DEMO'
        spec = json.loads((ev / 'spec.json').read_text())
        assert spec == {'schema': 'iot-lab.routing-policy.v1', 'layers': ['F.Cu'], 'only_nets': ['/A', 'GND'],
                        'passes': 5, 'threads': 1, 'timeout_s': 30, 'optimizer': 'if-routed', 'max_repairs': 0}
        assert (ev / 'timeout').read_text().strip() == '630'           # router + verification deadline
        assert end['state'] == 'passed' and end['run_id'] == 'run-route-DEMO' and end['adoptable']
        cand = await call('run.candidate', id=s['id'])
        assert cand['pcb'] == f'.gate/cli/run-route-DEMO/workspace/{REL}' and cand['target'] == REL
        assert cand['metrics'] == {'drc_errors': 0, 'unconnected': 3} and cand['verified'] and cand['adoptable']
        geo = await call('board.geometry', pcb=cand['pcb'])                 # the candidate loads inside the project
        assert len(geo['tracks']) == 1 and len((await call('board.geometry', pcb=REL))['tracks']) == 0
        receipt = await call('run.adopt', id=s['id'])
        assert receipt['candidate_run'] == 'run-route-DEMO'
        assert len((await call('board.geometry', pcb=REL))['tracks']) == 1  # canonical board replaced
        assert api.runs.runs[s['id']].summary()['adoption'] == receipt
        with pytest.raises(ValueError, match='already adopted'):
            await call('run.adopt', id=s['id'])
    asyncio.run(go())


def test_build_failed_candidate_is_not_adoptable(project):
    async def go():
        await call('project.open', root=str(project))
        s = await finish(await call('op.build', board='bad'))
        assert s['op'] == 'build' and s['state'] == 'failed' and not s['adoptable']
        assert s['candidate']['pcb'].endswith(REL) and s['candidate']['verified'] is False
        with pytest.raises(ValueError, match='run is failed'):
            await call('run.adopt', id=s['id'])
        # A gate check never has a candidate.
        chk = Runs()
        r = chk.start(project, 'check', 'DEMO')
        with pytest.raises(ValueError, match='no candidate'):
            await chk.adopt(r.id)
        await asyncio.sleep(0.3)
    asyncio.run(go())


def test_admission_error_is_the_terminal_event(project):
    async def go():
        await call('project.open', root=str(project))
        s = await finish(await call('op.build', board='NOPE'))
        assert s['state'] == 'error' and s['cause'] == 'unknown board NOPE' and s['candidate'] is None
    asyncio.run(go())


def test_adopt_refusal_from_the_cli_is_reported(project):
    async def go():
        await call('project.open', root=str(project))
        s = await finish(await call('op.build', board='DEMO'))
        api.runs.runs[s['id']].run_id = 'run-missing'        # the CLI refuses an unknown run
        with pytest.raises(RuntimeError, match='no such run'):
            await call('run.adopt', id=s['id'])
    asyncio.run(go())


def test_policy_validation():
    p = routing_policy(['F.Cu', 'B.Cu'], ['/A'], 40, 30)
    assert set(p) == {'schema', 'layers', 'only_nets', 'passes', 'threads', 'timeout_s', 'optimizer', 'max_repairs'}
    for bad in ({'nets': []}, {'nets': ['/A,/B']}, {'passes': 0}, {'layers': ['F.Cu', 'F.Cu']}):
        args = dict(layers=['F.Cu'], nets=['/A'], passes=40, timeout_s=30)
        args.update(bad)
        with pytest.raises(ValueError):
            routing_policy(**args)


def test_web_viewer_has_no_write_methods():
    from pcbstudio.web import READ_ONLY
    assert 'run.candidate' in READ_ONLY
    assert not READ_ONLY & {'op.build', 'op.route', 'run.adopt', 'gate.check', 'run.cancel'}
