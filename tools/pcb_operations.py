"""Candidate snapshot for the Python modules not yet ported: placer/iotroute_step.py and route_decision.py repair.

The operations themselves are tools/lib/pcb-candidate-run.ts. This goes with those two callers.
"""
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess

from pcb_workflow import board_config, sha


IGNORED = {'.git', '.gate', '.claude', '.bench', '__pycache__', 'node_modules', 'fab', 'render', 'renders', 'reports',
           'target'}  # target: cargo build output (tools/router/core), not a source


def source_files(root, board=None, extra_inputs=None):
    root = Path(root).resolve()
    found = []
    names = ['tools', 'hardware-design']
    if board:
        _, cfg, project = board_config(root, board)
        owner = project.relative_to(root / 'hardware-design/boards').parts[0]
        names = ['tools', 'hardware-design/boards/' + owner, 'hardware-design/blocks', 'hardware-design/registry']
    for name in names:
        folder = root / name
        if not folder.exists():
            continue
        for base, dirs, files in os.walk(folder, followlinks=False):
            dirs[:] = sorted(d for d in dirs if d not in IGNORED and not d.endswith('.3dshapes')
                             and not (board and Path(base) == root / 'hardware-design/registry' and d in ('evidence', 'datasheets')))
            if any((Path(base) / d).is_symlink() for d in dirs):
                raise ValueError('directory symlinks need an explicit snapshot dependency: ' + str(base))
            for file in sorted(files):
                p = Path(base) / file
                if p.name.startswith('.pcb-adopt-') or p.suffix in ('.pyc', '.step', '.stp', '.wrl', '.mp4', '.gif') or not p.is_file():
                    continue
                found.append(p)
    if board:
        # The gate resolves cross-board sheets, original evidence and referenced
        # libraries. Copy those exact files instead of historical evidence runs.
        probe = subprocess.run([os.environ.get('NODE', 'node'), str(root / 'tools/pcb_snapshot_inputs.mjs'),
                                str(root), board], capture_output=True, text=True, timeout=20)
        if probe.returncode:
            raise ValueError('cannot resolve snapshot dependencies: ' + probe.stderr.strip())
        for name in json.loads(probe.stdout):
            p = Path(name)
            if p.is_relative_to(root) and p.is_file():
                found.append(p)
        found.extend(p for p in (root / 'hardware-design').glob('*') if p.is_file())
        if cfg.get('snapshot_schematic_datasheets'):
            # The configured candidate semantic checker also requires the exact
            # original datasheets named by each native schematic instance. Its
            # inputs must travel with the candidate and bind adoption freshness.
            from placer.dru import _tree, _tokens
            forms = _tree(_tokens(project.with_suffix('.kicad_sch').read_text()))
            for symbol in forms[0][1:]:
                if not isinstance(symbol, list) or not symbol or symbol[0] != 'symbol':
                    continue
                for prop in symbol:
                    if isinstance(prop, list) and len(prop) > 2 and prop[:2] == ['property', 'Datasheet'] and prop[2]:
                        pdf = root / 'hardware-design/registry/datasheets' / Path(prop[2]).name
                        if pdf.is_file():
                            found.append(pdf)
    found.extend(root / name for name in ('FOCUS.md', 'AGENTS.md', 'CLAUDE.md') if (root / name).is_file())
    for name in extra_inputs or []:
        path = (root / name).resolve()
        if not path.is_relative_to(root) or not path.is_file():
            raise ValueError('explicit engineering dependency is missing or outside checkout: ' + str(name))
        found.append(path)
    return sorted(set(found))


def source_state(root, board=None, extra_inputs=None):
    root = Path(root).resolve()
    files = {str(p.relative_to(root)): sha(p) for p in source_files(root, board, extra_inputs)}
    result = dict(board=board, files=files, sha256=hashlib.sha256(json.dumps(files, sort_keys=True).encode()).hexdigest())
    if extra_inputs:
        result['extra_inputs'] = sorted(set(extra_inputs))
    return result


def snapshot(root, workspace, board=None, extra_inputs=None):
    root, workspace = Path(root).resolve(), Path(workspace).resolve()
    if workspace.exists():
        raise ValueError('candidate workspace must be new')
    before = source_state(root, board, extra_inputs)
    workspace.mkdir()
    for name in before['files']:
        source, dest = root / name, workspace / name
        dest.parent.mkdir(parents=True, exist_ok=True)
        # Materialize file symlinks so a legacy writer cannot follow them back
        # into canonical CAD. Never hardlink mutable source files.
        shutil.copyfile(source, dest)
        shutil.copymode(source, dest)
    if source_state(root, board, extra_inputs) != before or any(sha(workspace / name) != digest for name, digest in before['files'].items()):
        raise ValueError('source changed while creating candidate workspace')
    return before
