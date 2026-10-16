"""Transactional candidate operations. Canonical CAD changes only in adopt()."""
import argparse
import datetime as dt
import fcntl
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import time

import lean_workflow as lean
from pcb_workflow import board_config, operation_command, python_native, sha


IGNORED = {'.git', '.gate', '.claude', '.bench', '__pycache__', 'node_modules', 'fab', 'render', 'renders', 'reports'}


def source_files(root, board=None):
    root = Path(root).resolve()
    found = []
    names = ['tools', 'hardware-design']
    if board:
        _, _, project = board_config(root, board)
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
    found.extend(root / name for name in ('FOCUS.md', 'AGENTS.md', 'CLAUDE.md') if (root / name).is_file())
    return sorted(set(found))


def source_state(root, board=None):
    root = Path(root).resolve()
    files = {str(p.relative_to(root)): sha(p) for p in source_files(root, board)}
    return dict(board=board, files=files, sha256=hashlib.sha256(json.dumps(files, sort_keys=True).encode()).hexdigest())


def snapshot(root, workspace, board=None):
    root, workspace = Path(root).resolve(), Path(workspace).resolve()
    if workspace.exists():
        raise ValueError('candidate workspace must be new')
    before = source_state(root, board)
    workspace.mkdir()
    for name in before['files']:
        source, dest = root / name, workspace / name
        dest.parent.mkdir(parents=True, exist_ok=True)
        # Materialize file symlinks so a legacy writer cannot follow them back
        # into canonical CAD. Never hardlink mutable source files.
        shutil.copyfile(source, dest)
        shutil.copymode(source, dest)
    if source_state(root, board) != before or any(sha(workspace / name) != digest for name, digest in before['files'].items()):
        raise ValueError('source changed while creating candidate workspace')
    return before


def pcb_identity(path):
    """Protect part/pad/net/outline/rule identity, allowing placement and copper.

    KiCad's parser handles quoted strings and nesting. Filled zone caches and
    generator metadata do not define the source electrical/mechanical contract.
    Unknown native forms stay protected, rather than being silently discarded.
    """
    from placer.dru import _tree, _tokens
    from decimal import Decimal
    forms = _tree(_tokens(Path(path).read_text()))
    if len(forms) != 1 or forms[0][0] != 'kicad_pcb':
        raise ValueError('invalid native PCB root')
    geometry = {'at', 'start', 'end', 'mid', 'xy', 'xyz', 'size', 'offset', 'width', 'thickness', 'clearance', 'drill', 'diameter'}

    def clean(value):
        if not isinstance(value, list):
            return value
        if value and value[0] in geometry:
            result = [value[0]]
            for v in value[1:]:
                if isinstance(v, str):
                    try:
                        v = str(Decimal(v).normalize())
                    except Exception:
                        pass
                result.append(clean(v))
            return result
        return [clean(v) for v in value]

    protected = []
    footprints = {}
    from pcb_search.block_bindings import footprints as native_footprints
    from pcb_search.native_placement import footprint_signature
    native = {fp['props'].get('Reference'): fp for fp in native_footprints(path)}
    for form in forms[0][1:]:
        if not isinstance(form, list) or not form:
            raise ValueError('malformed native PCB form')
        tag = form[0]
        if tag in ('version', 'generator', 'generator_version', 'segment', 'arc', 'via'):
            continue
        if tag == 'footprint':
            ref = next((v[2] for v in form if isinstance(v, list) and len(v) > 2 and v[:2] == ['property', 'Reference']), None)
            if not ref or ref in footprints:
                raise ValueError('footprints need unique references')
            footprints[ref] = footprint_signature(native[ref])
        elif tag == 'zone':
            protected.append(clean([v for v in form if not (isinstance(v, list) and v and v[0] in ('filled_polygon', 'fill_segments'))]))
        else:
            protected.append(clean(form))
    return dict(footprints=footprints, protected=protected)


def event(folder, kind, **data):
    directory = folder / 'operation'
    directory.mkdir(exist_ok=True)
    with (directory / 'events.jsonl').open('a') as stream:
        stream.write(json.dumps(dict(schema_version=1, time=dt.datetime.now(dt.timezone.utc).isoformat(timespec='milliseconds').replace('+00:00','Z'),
                                     type=kind, **data)) + '\n')


def execute(folder, stage, command, workspace, env):
    log_path = folder / 'operation' / (stage + '.log')
    event(folder, 'tool.start', stage=stage, log=str(log_path), command=command)
    with log_path.open('wb') as log:
        proc = subprocess.Popen(command, cwd=workspace, env=env, stdin=subprocess.DEVNULL,
                                stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
        while True:
            chunk = os.read(proc.stdout.fileno(), 65536)
            if not chunk:
                break
            log.write(chunk)
            log.flush()
            text = chunk.decode(errors='replace')
            event(folder, 'tool.output', stage=stage, bytes=len(chunk), stream='stdout', text=text[:1600], truncated=len(text) > 1600)
        code = proc.wait()
    event(folder, 'tool.exit', stage=stage, code=code, log=str(log_path))
    return code


def run(folder):
    folder = Path(folder).resolve()
    manifest = json.loads((folder / 'run.json').read_text())
    root = Path(manifest['root']).resolve()
    operation = manifest['operation']
    if operation in ('doctor', 'release', 'blocks', 'readiness'):
        env = dict(os.environ)
        if operation == 'doctor':
            command = [manifest['node'], str(root / 'tools/doctor.mjs'), '--gate-only']
            scope = 'environment'
        elif operation == 'release':
            env.update(FAB_WORK_DIR=str(folder / 'release-work'), FAB_RELEASE_OUT=str(folder / 'candidate'))
            command = ['sh', str(root / 'tools/fab-workflow.sh'), manifest['board'], 'release']
            scope = 'fabrication_candidate'
        elif operation == 'blocks':
            command = [os.environ.get('PYTHON_MODERN', 'python3'), str(root / 'tools/blocks.py')] + manifest['arguments']
            scope = 'block_evidence'
        else:
            command = [manifest['node'], str(root / 'tools/check-release-readiness.mjs')] + manifest['arguments']
            scope = 'assembly_readiness'
        code = execute(folder, operation, command, root, env)
        result = dict(status='passed' if code == 0 else 'error' if code == 2 else 'failed', exit_code=0 if code == 0 else 2 if code == 2 else 1,
                      cause=operation + (' completed' if code == 0 else ' failed; inspect original tool evidence'),
                      scope=scope, operation=operation, tool_exit=code,
                      artifact_directory=str(folder / 'candidate') if operation == 'release' else None)
        lean.atomic_json(folder / 'operation/result.json', result)
        return result['exit_code']
    workspace = folder / 'workspace'
    sources = snapshot(root, workspace, manifest['board'])
    lean.atomic_json(folder / 'operation/source.json', sources)
    board = manifest['board']
    _, cfg, source_project = board_config(root, board)
    _, _, candidate = board_config(workspace, board)
    native = candidate.with_suffix('.kicad_pcb')
    source_native = source_project.with_suffix('.kicad_pcb')
    if manifest.get('spec'):
        spec = folder / 'operation/spec.json'
        spec.write_text(json.dumps(manifest['spec']))
    else:
        spec = None
    command = operation_command(workspace, board, operation, spec, manifest.get('kind'))
    env = dict(os.environ, IOT_LAB=str(workspace))
    env.update(KICAD_PY=python_native(), KICAD_PYTHON=python_native())
    work = folder / 'operation/work'
    for key in ('ENV_WORK', 'BASEB_WORK', 'BASEC_WORK', 'AC24_WORK', 'AC24C_WORK', 'CELL_WORK', 'FIELD24B_WORK', 'AIO_WORK'):
        env[key] = str(work / key.lower())
    code = execute(folder, operation, command, workspace, env)
    if code:
        result = dict(status='failed', exit_code=1, cause=operation + ' tool failed', tool_exit=code)
    else:
        changed = [name for name, digest in sources['files'].items()
                   if name != str(source_native.relative_to(root)) and
                   (not (workspace / name).is_file() or sha(workspace / name) != digest)]
        identity_ok = pcb_identity(source_native) == pcb_identity(native)
        if not identity_ok or changed:
            result = dict(status='failed', exit_code=1, cause='candidate changed protected design inputs; explicit design revision required',
                          identity_preserved=identity_ok, protected_source_changes=changed, candidate_verified=False)
            result.update(scope='candidate_board_gate', operation=operation, source_sha256=sources['sha256'])
            lean.atomic_json(folder / 'operation/result.json', result)
            return 1
        gate = [manifest['node'], str(workspace / 'tools/gate.mjs'), board, '--fresh', '--evidence-dir', str(folder / 'gate')]
        code = execute(folder, 'validate', gate, workspace, env)
        report = json.loads((folder / 'gate/result.json').read_text()) if (folder / 'gate/result.json').exists() else None
        verified = bool(code == 0 and report and report.get('exit') == 0 and not report.get('changedDuringRun'))
        if verified and board == 'ENV-SENSE':
            semantic_commands = [
                ['python3', 'tools/check-env-schematic.py'],
                [python_native(),
                 'tools/check-env-pcb.py', str(native), '--json', str(folder / 'operation/board-check.json')],
            ]
            for i, semantic in enumerate(semantic_commands):
                if execute(folder, 'board-semantic-' + str(i), semantic, workspace, env):
                    verified = False
                    break
        if verified and board == 'BASE-PWR':
            # The complete legacy board audit includes manufacturing identity;
            # produce it only inside the candidate snapshot before acceptance.
            fab = folder / 'operation/fab'
            render = folder / 'operation/render'
            stage_env = dict(env, FAB_OUT=str(fab), RENDER_OUT=str(render))
            if execute(folder, 'candidate-fab', ['sh', 'tools/make-base-pwr-fab.sh'], workspace, stage_env):
                verified = False
            elif execute(folder, 'board-semantic', [manifest['node'], 'tools/check-base-pwr-pcb.mjs',
                         '--fab-dir', str(fab), '--render-dir', str(folder / 'operation/audit'),
                         '--gate-dir', str(folder / 'gate')], workspace, stage_env):
                verified = False
        result = dict(status='passed' if verified else 'failed', exit_code=0 if verified else 1,
                      cause='candidate meets configured gate targets' if verified else 'candidate does not meet configured gate targets',
                      candidate_verified=verified, identity_preserved=identity_ok, protected_source_changes=changed,
                      candidate=str(native), candidate_sha256=sha(native), metrics=report.get('metrics') if report else None,
                      input_sha256=report.get('provenance', {}).get('input_sha256') if report else None)
    result.update(scope='candidate_board_gate', operation=operation, board=board, source_sha256=sources['sha256'],
                  source_unchanged=source_state(root, board) == sources, workspace=str(workspace))
    if not result['source_unchanged']:
        result.update(status='error', exit_code=2, cause='canonical source changed during candidate operation')
    result['artifacts'] = {str(p.relative_to(folder)): sha(p) for p in (folder / 'gate').glob('*') if p.is_file()}
    result['artifacts'].update({str(p.relative_to(folder)): sha(p) for p in (folder / 'operation').glob('*') if p.is_file()})
    if native.exists():
        result['artifacts'][str(native.relative_to(folder))] = sha(native)
    lean.atomic_json(folder / 'operation/result.json', result)
    return result['exit_code']


def adopt(root, folder, defect=None, baseline=None):
    root, folder = Path(root).resolve(), Path(folder).resolve()
    from pcb_workflow import context
    from pcb_evidence import verify
    result = verify(folder)
    operation = json.loads((folder / 'operation/result.json').read_text())
    manifest = json.loads((folder / 'run.json').read_text())
    if Path(manifest['root']).resolve() != root or result['status'] != 'passed' or not result.get('cleanup', {}).get('complete'):
        raise ValueError('only a successful, settled candidate from this checkout can be adopted')
    if not operation.get('candidate_verified') or not operation.get('identity_preserved') or operation.get('protected_source_changes'):
        raise ValueError('candidate changes protected design identity or lacks full gate verification')
    _, _, candidate_project = board_config(folder / 'workspace', manifest['board'])
    candidate = Path(operation['candidate']).resolve()
    if candidate != candidate_project.with_suffix('.kicad_pcb') or operation['candidate_sha256'] != sha(candidate):
        raise ValueError('candidate does not match the verified native board')
    if operation.get('candidate_sha256') != result.get('candidate_sha256'):
        raise ValueError('candidate receipt and controller disagree')
    for name, digest in operation['artifacts'].items():
        path = (folder / name).resolve()
        if folder not in path.parents or sha(path) != digest:
            raise ValueError('candidate evidence changed after verification')
    board = manifest['board']
    state = context(root, board)
    if state['frozen']:
        if not baseline or not defect:
            raise ValueError('FOCUS.md freezes this board: provide --baseline RUN_ID and --defect FINDING_ID from a current failed check')
        baseline = Path(baseline)
        previous = json.loads((baseline / 'run.json').read_text())
        prior_result = verify(baseline)
        receipt = json.loads((baseline / 'gate/result.json').read_text())
        findings = json.loads((baseline / 'gate/findings.json').read_text())
        if previous['board'] != board or Path(previous['root']).resolve() != root or receipt['exit'] != 1 or prior_result['status'] != 'failed':
            raise ValueError('defect baseline is not a failed check of this board/checkout')
        finding = next((f for f in findings['findings'] if f['id'] == defect), None)
        if not finding or finding.get('severity') != 'error' or not findings.get('inputs_valid') or finding['stage'] not in findings.get('completed_checks', []):
            raise ValueError('defect ID is absent from the failed-check findings')
        updated = json.loads((folder / 'gate/findings.json').read_text())
        if not updated.get('complete') or not updated.get('inputs_valid') or any(f['id'] == defect for f in updated['findings']):
            raise ValueError('candidate did not resolve the named defect with complete evidence')
        source = json.loads((folder / 'operation/source.json').read_text())
        for p in receipt['provenance']['inputs']:
            if p['path'] in source['files'] and source['files'][p['path']] != p['sha256']:
                raise ValueError('defect baseline does not match candidate source')
        check = subprocess.run([manifest['node'], str(root / 'tools/pcb_snapshot_inputs.mjs'), str(root), board,
                                '--verify-failed', str(baseline / 'gate'), finding['stage']], capture_output=True, text=True, timeout=90)
        if check.returncode:
            raise ValueError('defect baseline is stale: ' + check.stderr.strip())
    sources = json.loads((folder / 'operation/source.json').read_text())
    _, _, project = board_config(root, board)
    target = project.with_suffix('.kicad_pcb')
    locks = root / '.gate/board-locks'
    locks.mkdir(parents=True, exist_ok=True)
    with (locks / (board + '.lock')).open('a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        if source_state(root, board) != sources:
            raise ValueError('canonical inputs changed since candidate creation; generate and verify a new candidate')
        check = subprocess.run([manifest['node'], str(root / 'tools/pcb_snapshot_inputs.mjs'), str(folder / 'workspace'), board,
                                '--verify', str(folder / 'gate')], capture_output=True, text=True, timeout=90,
                               env=dict(os.environ, IOT_LAB=str(folder / 'workspace')))
        if check.returncode:
            raise ValueError('candidate native evidence is stale: ' + check.stderr.strip())
        # Native/library probes can take time. The original read before those
        # probes cannot authorize replacing a board edited in the meantime.
        verify(folder)
        if source_state(root, board) != sources:
            raise ValueError('canonical inputs changed during adoption verification')
        if pcb_identity(target) != pcb_identity(candidate):
            raise ValueError('candidate changes protected design identity')
        candidate_bytes = candidate.read_bytes()
        if hashlib.sha256(candidate_bytes).hexdigest() != operation['candidate_sha256']:
            raise ValueError('candidate changed during adoption verification')
        original_bytes = target.read_bytes()
        if hashlib.sha256(original_bytes).hexdigest() != sources['files'][str(target.relative_to(root))]:
            raise ValueError('canonical PCB changed during adoption verification')
        backup = folder / 'backup'
        backup.mkdir()
        (backup / target.name).write_bytes(original_bytes)
        fd, name = tempfile.mkstemp(prefix='.pcb-adopt-', dir=target.parent)
        try:
            with os.fdopen(fd, 'wb') as stream:
                stream.write(candidate_bytes)
                stream.flush()
                os.fsync(stream.fileno())
            if source_state(root, board) != sources:
                raise ValueError('canonical inputs changed before atomic adoption')
            os.replace(name, target)
        finally:
            Path(name).unlink(missing_ok=True)
        receipt = dict(schema_version=1, board=board, target=str(target), before_sha256=sha(backup / target.name),
                       after_sha256=sha(target), candidate_run=folder.name, defect=defect, adopted_at=time.time())
        lean.atomic_json(folder / 'adoption.json', receipt)
        return receipt


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('run', type=Path)
    args = parser.parse_args()
    try:
        return run(args.run)
    except Exception as error:
        args.run.joinpath('operation').mkdir(exist_ok=True)
        lean.atomic_json(args.run / 'operation/result.json', dict(status='error', exit_code=2, cause=type(error).__name__ + ': ' + str(error)))
        return 2


if __name__ == '__main__':
    raise SystemExit(main())
