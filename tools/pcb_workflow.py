"""Repository-derived board context and deterministic workflow plans.

Native CAD, gate.json and the existing board registry remain the sources of
truth. This module contains command adapters, not a second part/design database.
"""
import hashlib
import json
import os
from pathlib import Path
import re


def sha(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def board_config(root, board):
    if not re.fullmatch(r'[A-Z0-9][A-Z0-9-]*', board):
        raise ValueError('invalid board ID')
    folder = Path(root) / 'hardware-design/boards' / board
    path = folder / 'gate.json'
    cfg = json.loads(path.read_text())
    if not isinstance(cfg, dict) or not isinstance(cfg.get('project'), str) or not cfg['project']:
        raise ValueError('gate configuration requires a project')
    project = (folder / cfg['project']).resolve()
    if (Path(root) / 'hardware-design/boards').resolve() not in project.parents:
        raise ValueError('project escapes the board registry tree')
    return folder, cfg, project


def registry_revision(root, board):
    path = Path(root) / 'hardware-design/registry/boards.json'
    if not path.exists():
        return {}
    for entry in json.loads(path.read_text()).get('boards', []):
        for revision in entry.get('revisions', []):
            if revision.get('gate') == board:
                return dict(owner=entry['id'], directory=entry['directory'], lifecycle=entry.get('lifecycle'), **revision)
        if entry.get('id') == board and not entry.get('revisions'):
            return dict(owner=entry['id'], directory=entry['directory'], lifecycle=entry.get('lifecycle'))
    return {}


def pipeline(root, board):
    """The integrated build pipeline of BOARD: the "pipeline" key of its gate.json, when that file exists."""
    path = Path(root) / 'hardware-design/boards' / board / 'gate.json'
    if not re.fullmatch(r'[A-Z0-9][A-Z0-9-]*', board) or not path.is_file():
        return None
    name = json.loads(path.read_text()).get('pipeline')
    return name if isinstance(name, str) and name and (Path(root) / name).is_file() else None


def context(root, board):
    root = Path(root).resolve()
    folder, cfg, project = board_config(root, board)
    revision = registry_revision(root, board)
    focus = root / 'FOCUS.md'
    focus_text = focus.read_text() if focus.exists() else ''
    frozen = bool(re.search(r'^-\s+' + re.escape(board) + r'(?:\s|$)', focus_text.split('## Frozen', 1)[-1].split('\n## ', 1)[0], re.MULTILINE))
    checks = cfg.get('checks', {})
    missing = [str(project.with_suffix('.' + ext).relative_to(root)) for ext in ('kicad_pcb', 'kicad_sch', 'kicad_pro')
               if not project.with_suffix('.' + ext).is_file()]
    blockers = [dict(rule='missing_native_input', path=p) for p in missing]
    latest = folder / '.gate/latest.json'
    gate = None
    if latest.exists():
        try:
            pointer = json.loads(latest.read_text())
            evidence = (folder / '.gate' / pointer['run']).resolve()
            if not evidence.is_relative_to((folder / '.gate').resolve()):
                raise ValueError('latest gate escapes its evidence directory')
            report = json.loads((evidence / 'result.json').read_text())
            # Old receipts are observations until the gate checks the full
            # dependency closure again; never label them current from mtime.
            gate = dict(evidence=str(evidence), exit=report.get('exit'), metrics=report.get('metrics'),
                        freshness='requires_dependency_verification', input_sha256=report.get('provenance', {}).get('input_sha256'))
            if report.get('exit'):
                blockers.append(dict(rule='previous_gate_failed', evidence=str(evidence)))
        except (OSError, ValueError, KeyError, TypeError):
            blockers.append(dict(rule='invalid_latest_gate', evidence=str(latest)))
    spec = root / 'hardware-design/boards' / revision.get('directory', board) / revision.get('spec', 'SPEC.md')
    packet = spec.parent
    # FOCUS.md is optional (removed by the user 2026-10-20); when present it can still freeze a board.
    sources = [root / 'AGENTS.md'] + ([focus] if focus.exists() else []) + [spec, folder / 'gate.json', root / 'hardware-design/STATUS.md',
               root / 'hardware-design/REQUIREMENTS.md', root / 'hardware-design/INTERFACES.md',
               root / 'hardware-design/CONNECTORS.md', root / 'hardware-design/DECISIONS.md']
    sources.extend(packet / name for name in ('STATUS.md', 'DOC-RECONCILIATION.md', 'BOM-VERIFIED.csv', 'SCHEMATIC.md'))
    engineering_manifest = root / 'hardware-design/registry/part-reviews' / (board + '.json')
    engineering = dict(manifest=str(engineering_manifest.relative_to(root)),
                       state='requires_native_instance_verification' if engineering_manifest.is_file() else 'missing_review',
                       sha256=sha(engineering_manifest) if engineering_manifest.is_file() else None,
                       qualified=False, stock_current=False,
                       inspect_command=f'tools/pcb parts --json status {board}')
    if engineering_manifest.is_file():
        sources.append(engineering_manifest)
    blockers.extend(dict(rule='missing_context_source', path=str(p.relative_to(root))) for p in sources if not p.is_file())
    return dict(schema_version=1, board=board, revision=revision, project=str(project.relative_to(root)),
                stage=cfg.get('stage', 'G4'), frozen=frozen, source_of_truth='KiCad',
                configured_checks=checks, blockers=blockers, previous_gate=gate, engineering=engineering,
                commands=dict(check=f'tools/pcb check {board} --changed --follow',
                              fresh=f'tools/pcb check {board} --fresh --follow',
                              build=f'tools/pcb build {board} --follow' if pipeline(root, board) else None,
                              edit=f'tools/pcb edit {board} --kind place --spec SPEC.json --follow',
                              route=f'tools/pcb route {board} --spec ROUTES.json --follow',
                              parts=f'tools/pcb parts --json status {board}',
                              part_review=(f'tools/pcb parts --json verify {board} --manifest {engineering["manifest"]}'
                                           if engineering_manifest.is_file() else None),
                              release=f'tools/pcb release {board} --follow'),
                next_action=('restore missing native inputs' if missing else
                             'complete missing board packet evidence' if any(b['rule']=='missing_context_source' for b in blockers) else
                             'run current input checks'),
                source_files=[dict(path=str(p.relative_to(root)), sha256=sha(p) if p.is_file() else None) for p in sources],
                focus=focus_text)


def catalog(root):
    directory = Path(root) / 'hardware-design/boards'
    rows = []
    for path in sorted(directory.glob('*/gate.json')):
        board = path.parent.name
        row = registry_revision(root, board)
        rows.append(dict(board=board, revision=row, build_pipeline=pipeline(root, board)))
    return dict(schema_version=1, boards=rows)


def python_native():
    return os.environ.get('KICAD_PYTHON', os.environ.get('KICAD_PY',
        '/Applications/KiCad/KiCad.app/Contents/Frameworks/Python.framework/Versions/Current/bin/python3'
        if sys_platform() == 'darwin' else 'python3'))


def sys_platform():
    import sys
    return sys.platform


def operation_command(root, board, operation, spec=None, kind=None):
    root = Path(root)
    _, _, project = board_config(root, board)
    if operation == 'build':
        script = pipeline(root, board)
        if not script:
            raise ValueError('no integrated build pipeline for ' + board + '; use edit/route with an explicit spec')
        return ['sh', script]
    if operation in ('edit', 'route'):
        if not spec:
            raise ValueError('an explicit JSON spec is required')
        command = 'route' if operation == 'route' else kind
        if command not in ('place', 'route'):
            raise ValueError('edit kind must be place or route')
        return [python_native(), 'tools/pcbtool.py', command,
                str(project.with_suffix('.kicad_pcb').relative_to(root)), str(spec)]
    raise ValueError('unknown candidate operation: ' + operation)
