import asyncio
import json
import os
from pathlib import Path

import pytest

from pcbstudio.api import registry
from pcbstudio.project import Project, ProjectError

CORPUS = Path(os.environ.get('PCBSTUDIO_CORPUS', '/Users/pacosw/code/iot-lab'))


def rpc(method, **params):
    r = json.loads(asyncio.run(registry.handle(json.dumps({'jsonrpc': '2.0', 'id': 1, 'method': method, 'params': params}))))
    return r.get('result'), r.get('error')


def test_rejects_non_project(tmp_path):
    with pytest.raises(ProjectError):
        Project(tmp_path)


def test_small_project(tmp_path):
    (tmp_path / 'hardware-design/boards/DEMO/cad/DEMO').mkdir(parents=True)
    (tmp_path / 'hardware-design/boards/DEMO/cad/DEMO/DEMO.kicad_pcb').write_text('(kicad_pcb (version 1))')
    boards = Project(tmp_path).boards()
    assert boards == [{'id': 'DEMO', 'directory': 'DEMO', 'lifecycle': 'unregistered', 'revisions': [
        {'revision': None, 'state': 'unregistered', 'pcb': 'hardware-design/boards/DEMO/cad/DEMO/DEMO.kicad_pcb',
         'spec': None}]}]
    with pytest.raises(ProjectError):
        Project(tmp_path).resolve('../outside.kicad_pcb')


@pytest.mark.skipif(not CORPUS.is_dir(), reason='corpus missing')
def test_open_iot_lab_and_geometry():
    res, err = rpc('project.open', root=str(CORPUS))
    assert err is None and len(res['boards']) > 10
    poe = next(b for b in res['boards'] if b['id'] == 'POE-ETHERNET')
    pcb = next(r['pcb'] for r in poe['revisions'] if r['pcb'])
    geo, err = rpc('board.geometry', pcb=pcb)
    assert err is None and geo['footprints'] and geo['tracks'] and len(geo['bbox']) == 4
    _, err = rpc('board.geometry', pcb='../../etc/hosts')
    assert err and 'outside' in err['message']
