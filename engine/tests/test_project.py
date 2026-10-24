import asyncio
import json
import os
from pathlib import Path

import pytest
import yaml

from pcbstudio.api import registry
from pcbstudio.migrate import migrate
from pcbstudio.model import ProjectInfo, ProjectLayout
from pcbstudio.project import Project, ProjectError

CORPUS = Path(os.environ.get('PCBSTUDIO_CORPUS', '/Users/pacosw/code/iot-lab'))
needs_corpus = pytest.mark.skipif(not CORPUS.is_dir(), reason='corpus missing')
GATED = ['ESP32-CORE', 'H7-CORE', 'INPUT-4D2A', 'CORE-BREAKOUT', 'CHECKIN', 'CHECKIN-FRONT']


def rpc(method, **params):
    r = json.loads(asyncio.run(registry.handle(json.dumps({'jsonrpc': '2.0', 'id': 1, 'method': method, 'params': params}))))
    return r.get('result'), r.get('error')


def write(p: Path, text: str) -> None:
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(text)


def test_rejects_non_project(tmp_path):
    with pytest.raises(ProjectError):
        Project(tmp_path)


def test_small_project(tmp_path):
    write(tmp_path / 'hardware-design/boards/DEMO/cad/DEMO/DEMO.kicad_pcb', '(kicad_pcb (version 1))')
    boards = [b.model_dump() for b in Project(tmp_path).boards()]
    assert boards == [{'id': 'DEMO', 'directory': 'DEMO', 'lifecycle': 'unregistered', 'kind': None, 'variant_of': None,
                       'identity': 'legacy', 'revisions': [
        {'revision': None, 'state': 'unregistered', 'pcb': 'hardware-design/boards/DEMO/cad/DEMO/DEMO.kicad_pcb',
         'sch': None, 'spec': None, 'bom': None, 'gate': None, 'gates': [], 'pipeline': None}]}]
    with pytest.raises(ProjectError):
        Project(tmp_path).resolve('../outside.kicad_pcb')


@pytest.fixture
def multi(tmp_path):
    """MAIN rev A (gate MAIN + a variant) and rev B (gate in the gate-only folder MAIN-B; the registry names another
    gate), and NEW, a board the registry does not list but whose gate.json points at it."""
    b = tmp_path / 'hardware-design/boards'
    for rel in ('MAIN/cad/MAIN/MAIN.kicad_pcb', 'MAIN/cad/MAIN-B/MAIN-B.kicad_pcb', 'NEW/cad/NEW/NEW.kicad_pcb'):
        write(b / rel, '(kicad_pcb (version 1))')
    write(b / 'MAIN/cad/MAIN/MAIN.kicad_sch', '(kicad_sch)')
    write(b / 'MAIN/SPEC.md', '# spec')
    write(b / 'MAIN/BOM-B.csv', 'Designator,LCSC\n')
    write(b / 'MAIN/gate.json', json.dumps({'project': 'cad/MAIN/MAIN'}))
    write(b / 'MAIN/gate-6layer.json', json.dumps({'project': 'cad/MAIN/MAIN'}))
    write(b / 'MAIN/gate-metrics.json', '{}')
    write(b / 'MAIN-B/gate.json', json.dumps({'project': '../MAIN/cad/MAIN-B/MAIN-B'}))
    write(b / 'NEW/gate.json', json.dumps({'project': 'cad/NEW/NEW'}))
    write(tmp_path / 'tools/main_b_pipeline.sh', '#!/bin/sh\n')
    write(tmp_path / 'hardware-design/registry/boards.json', json.dumps({'boards': [
        {'id': 'MAIN', 'directory': 'MAIN', 'lifecycle': 'active', 'kind': 'board', 'revisions': [
            {'revision': 'A', 'state': 'old', 'project': 'cad/MAIN/MAIN', 'spec': 'SPEC.md', 'gate': None},
            {'revision': 'B', 'state': 'layout', 'project': 'cad/MAIN-B/MAIN-B', 'gate': 'WRONG', 'bom': 'BOM-B.csv'}]},
        {'id': 'MAIN-B', 'directory': 'MAIN-B', 'kind': 'gate-only', 'revision': 'B'}]}))
    return tmp_path


def test_gates_come_from_gate_json(multi):
    p = Project(multi)
    boards = {b.id: b for b in p.boards()}
    assert set(boards) == {'MAIN', 'NEW'}                       # MAIN-B is gate data, not a board
    a, b = boards['MAIN'].revisions
    assert a.gate == 'MAIN' and [(g.name, g.config, g.variant) for g in a.gates] == [
        ('MAIN', 'gate.json', None), ('MAIN', 'gate-6layer.json', '6layer')]
    assert a.sch.endswith('MAIN.kicad_sch') and a.spec == 'hardware-design/boards/MAIN/SPEC.md'
    assert b.gate == 'MAIN-B' and b.pipeline == 'tools/main_b_pipeline.sh' and b.bom.endswith('BOM-B.csv')
    assert boards['NEW'].revisions[0].gate == 'NEW'
    kinds = {(c.board, c.kind) for c in p.conflicts}
    assert ('MAIN', 'registry_gate_differs') in kinds and ('MAIN', 'registry_gate_missing') in kinds
    assert ('MAIN-B', 'gate_only_folder') in kinds and ('NEW', 'unregistered_board') in kinds


def test_layout_config(multi):
    (multi / 'hw').mkdir()
    (multi / 'hardware-design').rename(multi / 'hw/design')
    lay = ProjectLayout(boards_dir='hw/design/boards', registry='hw/design/registry/boards.json')
    with pytest.raises(ProjectError):
        Project(multi)
    assert {b.id for b in Project(multi, layout=lay).boards()} == {'MAIN', 'NEW'}


def test_board_yaml_wins_and_round_trips(multi, tmp_path_factory):
    out = tmp_path_factory.mktemp('mig')
    r = migrate(multi, out)
    assert r.round_trip and r.boards == 2 and r.gates == 4
    data = yaml.safe_load((out / 'MAIN/board.yaml').read_text())
    assert data['schema'] == 'pcbstudio.board.v1'
    assert data['revisions'][1] == {'rev': 'B', 'state': 'layout', 'pcb': 'cad/MAIN-B/MAIN-B.kicad_pcb', 'bom': 'BOM-B.csv',
                                    'gate': 'MAIN-B', 'gates': [{'name': 'MAIN-B'}], 'pipeline': 'tools/main_b_pipeline.sh'}
    # Copy the board.yaml files into the project and drop the registry: the project now reads board.yaml.
    for f in out.glob('*/board.yaml'):
        write(multi / 'hardware-design/boards' / f.parent.name / 'board.yaml', f.read_text())
    (multi / 'hardware-design/registry/boards.json').unlink()
    p = Project(multi)
    boards = {b.id: b for b in p.boards()}
    assert all(b.identity == 'board.yaml' for b in boards.values())
    assert boards['MAIN'].revisions[1].gate == 'MAIN-B' and boards['MAIN'].revisions[0].revision == 'A'
    assert not [c for c in p.conflicts if c.kind.startswith('board_yaml')]
    # A board.yaml gate that checks another PCB is a conflict.
    f = multi / 'hardware-design/boards/NEW/board.yaml'
    f.write_text(f.read_text().replace('name: NEW', 'name: MAIN'))
    p = Project(multi)
    p.boards()
    assert any(c.kind == 'board_yaml_gate_mismatch' and c.board == 'NEW' for c in p.conflicts)


def test_board_yaml_rejects_unknown_fields(multi):
    write(multi / 'hardware-design/boards/NEW/board.yaml', 'schema: pcbstudio.board.v1\nid: NEW\nlifecycle: x\nrevs: []\n')
    with pytest.raises(ProjectError, match='revs'):
        Project(multi).boards()


@needs_corpus
def test_open_iot_lab_and_geometry():
    res, err = rpc('project.open', root=str(CORPUS))
    assert err is None and len(res['boards']) > 10
    ProjectInfo.model_validate(res)
    poe = next(b for b in res['boards'] if b['id'] == 'POE-ETHERNET')
    pcb = next(r['pcb'] for r in poe['revisions'] if r['pcb'])
    geo, err = rpc('board.geometry', pcb=pcb)
    assert err is None and geo['footprints'] and geo['tracks'] and len(geo['bbox']) == 4
    _, err = rpc('board.geometry', pcb='../../etc/hosts')
    assert err and 'outside' in err['message']


@needs_corpus
def test_iot_lab_gates_and_revisions():
    p = Project(CORPUS)
    boards = {b.id: b for b in p.boards()}
    gated = {d.name for d in (CORPUS / 'hardware-design/boards').iterdir() if (d / 'gate.json').is_file()}
    listed = {r.gate for b in boards.values() for r in b.revisions if r.gate}
    assert listed == gated - set(p.registry().get('excluded_directories', []))
    for name in GATED:
        assert any(r.gate == name for r in boards[name].revisions), name
    # BASE-PWR-B / -C are revisions of BASE-PWR, not boards.
    assert 'BASE-PWR-B' not in boards and 'BASE-PWR-C' not in boards
    revs = {r.revision: r for r in boards['BASE-PWR'].revisions}
    assert (revs['B'].gate, revs['C'].gate) == ('BASE-PWR-B', 'BASE-PWR-C')
    mc = boards['MOTION-CTRL'].revisions[0]
    assert [g.config for g in mc.gates] == ['gate.json', 'gate-4layer.json', 'gate-6layer.json']
    for b in boards.values():
        for r in b.revisions:
            for f in (r.pcb, r.sch, r.spec, r.bom, r.pipeline):
                assert f is None or (CORPUS / f).is_file()


@needs_corpus
def test_iot_lab_migrate_round_trip(tmp_path):
    r = migrate(CORPUS, tmp_path)
    assert r.round_trip
    assert (tmp_path / 'BASE-PWR/board.yaml').is_file() and not (tmp_path / 'BASE-PWR-B').exists()
    assert json.loads((tmp_path / 'migrate-report.json').read_text())['boards'] == r.boards
    again = Project(CORPUS, identity_dir=tmp_path).info()
    legacy = Project(CORPUS).info()
    assert all(b.identity == 'board.yaml' for b in again.boards)
    assert [b.model_dump(exclude={'identity'}) for b in again.boards] == [b.model_dump(exclude={'identity'}) for b in legacy.boards]
