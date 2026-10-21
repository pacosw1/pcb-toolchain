"""Transactional candidate operations. Canonical CAD changes only in adopt()."""
import argparse
import datetime as dt
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tempfile
import time

import lean_workflow as lean
from pcb_workflow import board_config, operation_command, python_native, sha
from pcb_timing import MeasuredSpan, measured_stage


IGNORED = {'.git', '.gate', '.claude', '.bench', '__pycache__', 'node_modules', 'fab', 'render', 'renders', 'reports'}
OBSERVATION_BACKENDS = {
    'parts': ('part_evidence.py', 'part_evidence'),
    'placement': ('engineering_constraints.py', 'placement_constraints'),
    'routing': ('route_decision.py', 'routing_decision'),
    'design': ('design_contract.py', 'design_assessment'),
    'schematic': ('schematic_contract.py', 'schematic_function'),
    'outcomes': ('placement_outcomes.py', 'placement_outcomes'),
    'ml': ('pcb_ml.py', 'ml_observation'),
}


def design_admission(root, folder, manifest):
    """Check the previous engineering stage before spending on a candidate.

    Native candidate guards preserve schematic and protected part identity;
    the subsequent fresh configured gate still judges the changed layout.
    """
    binding = manifest.get('design_contract')
    if not binding:
        return None
    path = Path(binding['path']).resolve()
    if not path.is_relative_to(root) or sha(path) != binding['sha256']:
        raise ValueError('design contract changed or escaped its checkout after admission')
    declared = json.loads(path.read_text()).get('identity', {})
    if declared.get('board') != manifest['board']:
        raise ValueError('candidate design contract must name this exact native board')
    operation = manifest['operation']
    through = ('routing' if operation == 'release' else 'architecture' if operation == 'build' else
               'placement' if operation in ('route', 'repair') or manifest.get('kind') == 'route' else 'schematic')
    from design_contract import evaluate_contract
    with measured_stage(lambda kind, **data: event(folder, kind, **data), 'design-prerequisites', 'operation'):
        report = evaluate_contract(root, path, through=through)
    lean.atomic_json(folder / 'operation/design-preflight.json', report)
    if report.get('status') != 'passed':
        first = next(iter(report.get('blockers', [])), {})
        result = dict(status='failed', exit_code=1, scope='design_preflight', operation=operation,
            cause=first.get('detail', 'design prerequisites are incomplete or stale'),
            candidate_verified=False, qualified=False, release_approved=False,
            report=str(folder / 'operation/design-preflight.json'), design_stage=through)
        lean.atomic_json(folder / 'operation/result.json', result)
    return report


def source_files(root, board=None, extra_inputs=None):
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
        if board == 'ENV-SENSE':
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
    keepout_positions = []
    footprints = {}
    from pcb_search.block_bindings import footprints as native_footprints
    from pcb_search.native_placement import footprint_signature
    from pcb_search.native_eco import locked
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
            if locked(native[ref]['form']):
                footprints[ref] = dict(signature=footprints[ref], locked_pose=[str(v.normalize()) for v in native[ref]['pose']])
        elif tag == 'zone':
            if any(isinstance(v, list) and v[:1] == ['keepout'] for v in form):
                keepout_positions.append(len(protected))
            protected.append(clean([v for v in form if not (isinstance(v, list) and v and v[0] in ('filled_polygon', 'fill_segments'))]))
        else:
            protected.append(clean(form))
    # KiCad can reorder independent rule areas, including areas whose source
    # UUIDs coincide. Preserve every full form and its multiplicity; only their
    # order among keepout slots is immaterial. Copper zones and unknown forms
    # retain their original order and every nested authored value.
    keepouts = sorted((protected[i] for i in keepout_positions), key=lambda v: json.dumps(v, sort_keys=True))
    for i, area in zip(keepout_positions, keepouts):
        protected[i] = area
    return dict(footprints=footprints, protected=protected)


def event(folder, kind, **data):
    directory = folder / 'operation'
    directory.mkdir(exist_ok=True)
    with (directory / 'events.jsonl').open('a') as stream:
        stream.write(json.dumps(dict(schema_version=1, time=dt.datetime.now(dt.timezone.utc).isoformat(timespec='milliseconds').replace('+00:00','Z'),
                                     type=kind, **data)) + '\n')


def execute(folder, stage, command, workspace, env):
    log_path = folder / 'operation' / (stage + '.log')
    span = MeasuredSpan(stage, producer='operations')
    event(folder, 'tool.start', **span.fields, log=str(log_path), command=command)
    try:
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
                event(folder, 'tool.output', stage=stage, span_id=span.fields['span_id'], producer='operations',
                      bytes=len(chunk), stream='stdout', text=text[:1600], truncated=len(text) > 1600)
            code = proc.wait()
    except BaseException:
        event(folder, 'tool.exit', **span.end('error', code=None), log=str(log_path))
        raise
    event(folder, 'tool.exit', **span.end('passed' if code == 0 else 'failed', code=code), log=str(log_path))
    return code


def parent_candidate(root, board, reference):
    """Continue a sealed candidate; never use failed/partial tool output as CAD."""
    from pcb_evidence import verify
    root, parent = Path(root).resolve(), Path(reference['folder']).resolve()
    if sha(parent / 'result.json') != reference['result_sha256']:
        raise ValueError('parent candidate terminal receipt changed')
    terminal = verify(parent)
    manifest = json.loads((parent / 'run.json').read_text())
    operation = json.loads((parent / 'operation/result.json').read_text())
    if (Path(manifest['root']).resolve() != root or manifest['board'] != board
            or operation.get('identity_preserved') is not True or operation.get('protected_source_changes')
            or operation.get('source_unchanged') is not True or operation.get('continuation_allowed') is False
            or terminal['status'] not in ('passed', 'failed')):
        raise ValueError('parent lacks settled, source-preserving candidate evidence')
    sources = json.loads((parent / 'operation/source.json').read_text())
    if source_state(root, board, sources.get('extra_inputs')) != sources:
        raise ValueError('canonical inputs changed since parent candidate creation')
    _, _, project = board_config(parent / 'workspace', board)
    candidate = Path(operation['candidate']).resolve()
    if candidate != project.with_suffix('.kicad_pcb') or sha(candidate) != operation['candidate_sha256']:
        raise ValueError('parent candidate differs from its sealed receipt')
    _, _, original = board_config(root, board)
    if pcb_identity(original.with_suffix('.kicad_pcb')) != pcb_identity(candidate):
        raise ValueError('parent candidate changes protected board identity')
    dependencies = {str(parent / name): digest for name, digest in terminal['evidence_sha256'].items()}
    dependencies[str(parent / 'result.json')] = reference['result_sha256']
    return candidate, dependencies


def placement_check(root, board, manifest, candidate, output, *, escape_screens=None):
    from engineering_constraints import check_manifest, reviewed_contract
    contract = reviewed_contract(root, board, manifest)
    evidence = None
    if any(rule['kind'] == 'escape' for rule in contract['rules']):
        from route_decision import generate_escape_evidence
        evidence = Path(output).with_name(Path(output).stem + '-escape.json')
        if escape_screens is None:generate_escape_evidence(contract, candidate, evidence)
        else:evidence=escape_screens.get(contract,candidate,evidence)
    report = check_manifest(root, board, manifest, candidate=candidate, escape_evidence=evidence)
    if evidence is not None:
        report['escape_evidence']=str(evidence)
        report['inputs'].update(json.loads(Path(evidence).read_text()).get('inputs',{}))
        report['inputs'][str(evidence)]=sha(evidence)
    if escape_screens is not None:
        report['escape_screens']=dict(generated=escape_screens.generated,reused=escape_screens.hits)
    lean.atomic_json(output, report)
    return report


def candidate_layout_check(root, workspace, folder, manifest, output, *, escape_screens=None):
    from design_contract import evaluate_candidate_layout
    # Reviewed fixed/rigid poses belong to the original source. Rebuilding
    # that baseline from the edited workspace would compare a pose to itself.
    path = Path(manifest['design_contract']['path'])
    _, _, candidate = board_config(workspace, manifest['board'])
    with measured_stage(lambda kind, **data: event(folder, kind, **data), output.stem, 'operation'):
        report = evaluate_candidate_layout(root, path, candidate=candidate.with_suffix('.kicad_pcb'),
                                           evidence_directory=output.parent / (output.stem + '-evidence'),
                                           escape_screens=escape_screens)
    lean.atomic_json(output, report)
    return report


def run(folder):
    folder = Path(folder).resolve()
    manifest = json.loads((folder / 'run.json').read_text())
    root = Path(manifest['root']).resolve()
    operation = manifest['operation']
    design = None
    if operation in ('build', 'edit', 'route', 'repair', 'release') and manifest.get('design_contract'):
        design = design_admission(root, folder, manifest)
        if design.get('status') != 'passed':
            return 1
    parent = None
    parent_dependencies = {}
    if manifest.get('from_run'):
        parent, parent_dependencies = parent_candidate(root, manifest['board'], manifest['from_run'])
    if operation in OBSERVATION_BACKENDS:
        backend_root = Path(manifest['from_run']['folder']) / 'workspace' if parent else root
        backend, scope = OBSERVATION_BACKENDS[operation]
        output = folder / 'operation/report.json'
        from pcb_observation_inputs import collect, current
        python_command = os.environ.get('PYTHON_MODERN', 'python3')
        if operation == 'ml' and manifest['arguments'][0].startswith('engine-'):
            python_command = os.environ.get('PCB_ENGINE_ML_PYTHON', python_command)
        policy_operation = operation + '-from-run' if manifest.get('from_run') else operation
        implementation = collect(root, policy_operation, manifest['arguments'], python_command=python_command)
        observed_inputs = dict(implementation['files'])
        absent = list(implementation['absent'])
        ml_absent = set()
        if operation == 'ml':
            from pcb_ml import dependencies
            declared = dependencies(backend_root, manifest['arguments'])
            if not isinstance(declared, dict):
                raise ValueError('ML dependency collector must return a file/hash mapping')
            for name, digest in declared.items():
                path = (backend_root / name).absolute()
                if digest is None:
                    if path.exists() or path.is_symlink():
                        raise ValueError('declared absent ML input appeared: ' + str(path))
                    ml_absent.add(str(path))
                    absent.append(str(path))
                else:
                    resolved = str(path.resolve())
                    if not isinstance(digest, str) or not re.fullmatch(r'[0-9a-f]{64}', digest):
                        raise ValueError('ML dependency collector returned an invalid input hash')
                    if not path.is_file() or sha(path) != digest:
                        raise ValueError('ML input changed before backend execution: ' + str(path))
                    if resolved in observed_inputs and observed_inputs[resolved] != digest:
                        raise ValueError('ML input differs from its implementation binding: ' + str(path))
                    observed_inputs[resolved] = digest
        for key in ('design_contract',):
            if manifest.get(key):
                binding = manifest[key]
                if sha(binding['path']) != binding['sha256']:
                    raise ValueError(key + ' changed after admission')
                observed_inputs[binding['path']] = binding['sha256']
        command = [python_command, str(root / 'tools' / backend)]
        command += manifest['arguments'] + ['--root', str(backend_root), '--json', '--output', str(output)]
        code = execute(folder, operation, command, root, dict(os.environ, IOT_LAB=str(backend_root)))
        report = json.loads(output.read_text()) if output.is_file() else None
        if not isinstance(report, dict) or not report.get('schema') or not report.get('status') or report.get('qualified') is not False:
            raise ValueError('engineering backend did not produce a scoped, unqualified report')
        typed = {'design': 'iot-lab.design-assessment.v1',
                 'schematic': 'iot-lab.schematic-contract-result.v1',
                 'outcomes': 'iot-lab.placement-outcome-comparison.v1',
                 'ml': 'iot-lab.pcb-ml-result.v1'}
        if operation in typed:
            statuses = ('passed', 'blocked', 'failed') if operation == 'ml' else ('passed', 'blocked', 'stale')
            if report['schema'] != typed[operation] or report['status'] not in statuses:
                raise ValueError('engineering backend returned an incompatible report type')
            if (code == 0) != (report['status'] == 'passed'):
                raise ValueError('engineering backend exit disagrees with its evidence verdict')
            if operation == 'design' and (report.get('design_id') != manifest.get('design_id')
                    or report.get('through') != manifest.get('design_stage')):
                raise ValueError('design assessment belongs to another design or requested stage')
            if operation == 'schematic' and report.get('board') != manifest['board']:
                raise ValueError('schematic assessment belongs to another board')
            if operation == 'outcomes' and report.get('study_id') != manifest['arguments'][1]:
                raise ValueError('outcome assessment belongs to another study')
            if operation == 'ml':
                if (report.get('action'), report.get('id')) != tuple(manifest['arguments'][:2]):
                    raise ValueError('ML assessment belongs to another action or ID')
                if report.get('adopt_model') is not False or code not in (0, 1, 2):
                    raise ValueError('ML assessment must remain non-adopting with a valid exit')
                if report['status'] == 'passed' and ml_absent:
                    raise ValueError('ML assessment passed with an absent requested input')
                for key in ('inputs', 'tool_inputs', 'artifacts'):
                    if not isinstance(report.get(key), dict) or any(
                            not isinstance(value, str) or not re.fullmatch(r'[0-9a-f]{64}', value)
                            for value in report[key].values()):
                        raise ValueError('ML assessment has an invalid ' + key + ' inventory')
                if report['status'] == 'passed' and not report['artifacts']:
                    raise ValueError('passed ML assessment has no owned output artifact')
                for name, digest in report['artifacts'].items():
                    path = (output.parent / name).absolute()
                    if (path.is_symlink() or not path.resolve().is_relative_to(output.parent.resolve())
                            or path.resolve() in (output.resolve(), (output.parent / 'result.json').resolve())
                            or not path.is_file() or sha(path) != digest):
                        raise ValueError('ML artifact is missing, changed or outside its owned operation: ' + name)
        for key in ('inputs', 'native_inputs', 'tool_inputs', 'source_inputs', 'implementation_sha256', 'evidence_sha256'):
            for name, digest in report.get(key, {}).items():
                if isinstance(digest, str) and len(digest) == 64:
                    namespace = backend_root / 'tools' if key == 'implementation_sha256' else backend_root
                    resolved = str((namespace / name).resolve())
                    if resolved in observed_inputs and observed_inputs[resolved] != digest:
                        raise ValueError('engineering backend reported a changed policy input: ' + name)
                    observed_inputs[resolved] = digest
        observed_inputs.update(parent_dependencies)
        for name in report.get('absent_inputs', []):
            path = (backend_root / name).absolute()
            allowed = str(path) in ml_absent if operation == 'ml' else path.resolve().is_relative_to(backend_root)
            if not allowed or path.exists() or path.is_symlink():
                raise ValueError('engineering absent input appeared or escaped its checkout: ' + name)
            absent.append(str(path))
        if not current(implementation['policy']):
            raise ValueError('engineering code resolution changed while producing the report')
        if any(Path(name).exists() or Path(name).is_symlink() for name in absent):
            raise ValueError('a previously absent engineering input appeared while producing the report')
        if any(not Path(name).is_file() or sha(name) != digest for name, digest in observed_inputs.items()):
            raise ValueError('engineering evidence inputs changed while producing the report')
        result = dict(status='passed' if code == 0 else 'error' if code == 2 else 'failed',
                      exit_code=0 if code == 0 else 2 if code == 2 else 1,
                      scope=scope,
                      cause=(report or {}).get('cause', operation + (' completed' if code == 0 else ' blocked; inspect report.json')),
                      operation=operation, tool_exit=code, report=str(output),
                      engineering_status=(report or {}).get('status'), engineering_inputs=observed_inputs,
                      engineering_absent_inputs=sorted(set(absent)), engineering_policy=implementation['policy'],
                      qualified=False, release_approved=False)
        if operation == 'ml':
            result.update(adopt_model=False, ml_action=report['action'], ml_id=report['id'],
                          artifacts=report['artifacts'])
        lean.atomic_json(folder / 'operation/result.json', result)
        return result['exit_code']
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
    extra_inputs = []
    if operation == 'route' and manifest.get('router') == 'engine':
        from pcb_engine.policy import dependencies
        extra_inputs.extend(dependencies(root, manifest['spec']))
    if design:
        from design_contract import dependency_files
        # The changed layout must obey its declared future constraints too.
        # Collect their sources without rerunning native/physical stage checks.
        extra_inputs.extend(dependency_files(root, Path(manifest['design_contract']['path']), through='placement'))
        for name, digest in {**design.get('inputs', {}), **design.get('tool_inputs', {})}.items():
            path = (root / name).resolve()
            if path.is_relative_to(root):
                if not path.is_file() or sha(path) != digest:
                    raise ValueError('design prerequisite dependency changed: ' + name)
                extra_inputs.append(str(path.relative_to(root)))
    for name, expected in parent_dependencies.items():
        path = Path(name).resolve()
        if not path.is_relative_to(root) or sha(path) != expected:
            raise ValueError('parent candidate dependency changed or escaped checkout')
        extra_inputs.append(str(path.relative_to(root)))
    if operation == 'repair':
        from route_decision import plan_dependencies
        plan = manifest['plan']
        plan_path = Path(plan['path']).resolve()
        dependencies = {str(plan_path): plan['sha256'], **plan_dependencies(plan['content'])}
        for name, expected in dependencies.items():
            path = Path(name).resolve()
            if not path.is_relative_to(root) or sha(path) != expected:
                raise ValueError('routing repair dependency is stale or outside checkout: ' + name)
            extra_inputs.append(str(path.relative_to(root)))
    engineering = manifest.get('engineering_manifest')
    if engineering:
        path = Path(engineering['path']).resolve()
        if not path.is_relative_to(root) or sha(path) != engineering['sha256']:
            raise ValueError('engineering manifest changed or is outside this checkout')
        from part_evidence import verify_manifest
        review = verify_manifest(root, manifest['board'], path)
        lean.atomic_json(folder / 'operation/part-review.json', review)
        if review['status'] != 'passed':
            result = dict(status='failed', exit_code=1, scope='engineering_preflight', operation=operation,
                          cause='reviewed part evidence is incomplete or stale', candidate_verified=False,
                          report=str(folder / 'operation/part-review.json'))
            lean.atomic_json(folder / 'operation/result.json', result)
            return 1
        extra_inputs.append(str(path.relative_to(root)))
        for name in review.get('inputs', {}):
            dependency = (root / name).resolve()
            if not dependency.is_relative_to(root):
                raise ValueError('review dependency escapes checkout: ' + name)
            extra_inputs.append(str(dependency.relative_to(root)))
    workspace = folder / 'workspace'
    with measured_stage(lambda kind, **data: event(folder, kind, **data), 'snapshot', 'snapshot'):
        sources = snapshot(root, workspace, manifest['board'], extra_inputs)
    lean.atomic_json(folder / 'operation/source.json', sources)
    board = manifest['board']
    _, cfg, source_project = board_config(root, board)
    _, _, candidate = board_config(workspace, board)
    native = candidate.with_suffix('.kicad_pcb')
    source_native = source_project.with_suffix('.kicad_pcb')
    if parent:
        # Materialize the prior isolated geometry into the new workspace; the
        # source receipt still binds unchanged canonical CAD and parent evidence.
        shutil.copyfile(parent, native)
        if sha(native) != sha(parent):
            raise ValueError('parent changed while continuing its candidate')
    if manifest.get('spec'):
        spec = folder / 'operation/spec.json'
        spec.write_text(json.dumps(manifest['spec']))
    else:
        spec = None
    solver = operation == 'route' and manifest.get('router', 'explicit') == 'fastroute'
    engine = operation == 'route' and manifest.get('router') == 'engine'
    command = None if operation == 'repair' or solver or engine else operation_command(workspace, board, operation, spec, manifest.get('kind'))
    env = dict(os.environ, IOT_LAB=str(workspace))
    env.update(KICAD_PY=python_native(), KICAD_PYTHON=python_native())
    if engineering:
        env.update(PCB_ENGINEERING_MANIFEST=str(workspace / Path(engineering['path']).relative_to(root)),
                   PCB_ENGINEERING_BOARD=board, PCB_ENGINEERING_ROOT=str(workspace))
    work = folder / 'operation/work'
    for key in ('ENV_WORK', 'BASEB_WORK', 'BASEC_WORK', 'AC24_WORK', 'AC24C_WORK', 'CELL_WORK', 'FIELD24B_WORK', 'AIO_WORK'):
        env[key] = str(work / key.lower())
    from route_decision import EscapeStageReceipts
    pre_screens=EscapeStageReceipts(lambda kind,**data:event(folder,kind,stage='placement-preflight',**data))
    if engineering and (operation in ('route', 'repair') or (operation == 'edit' and manifest.get('kind') == 'route')):
        constraints = placement_check(root, board, Path(engineering['path']), native,
                                      folder / 'operation/placement-preflight.json',escape_screens=pre_screens)
        if constraints['status'] != 'passed':
            result = dict(status='failed', exit_code=1, scope='engineering_preflight', operation=operation,
                          cause='placement requirements block routing', candidate_verified=False,
                          source_sha256=sources['sha256'], report=str(folder / 'operation/placement-preflight.json'))
            lean.atomic_json(folder / 'operation/result.json', result)
            return 1
    if design and (operation in ('route', 'repair') or (operation == 'edit' and manifest.get('kind') == 'route')):
        output = folder / 'operation/design-layout-preflight.json'
        checked = candidate_layout_check(root, workspace, folder, manifest, output,escape_screens=pre_screens)
        if checked['status'] != 'passed':
            lean.atomic_json(folder / 'operation/result.json', dict(status='failed', exit_code=1,
                scope='design_layout_screen', operation=operation, candidate_verified=False, qualified=False,
                cause='candidate placement or test access blocks routing', source_sha256=sources['sha256'], report=str(output)))
            return 1
    solver_report = None
    if engine:
        from pcb_engine import run_engine
        with measured_stage(lambda kind, **data: event(folder, kind, **data), 'engine', 'operation'):
            solver_report = run_engine(folder, workspace, board, manifest['spec'],
                timeout_s=manifest['timeout_s'], node=manifest['node'], env=env,
                emit=lambda kind, **data: event(folder, kind, **data), execute=execute)
        lean.atomic_json(folder / 'operation/engine-summary.json', solver_report)
        # Native acceptance is owned by the same outer guard/gate as legacy
        # operations. A partial candidate must get that check and a failed receipt.
        candidate_path = solver_report.get('candidate')
        if candidate_path and Path(candidate_path).resolve() != native.resolve():
            raise ValueError('engine candidate must be the configured isolated native board')
        code = 0 if candidate_path and native.is_file() else 1
    elif operation == 'repair':
        from route_decision import apply_plan
        plan = manifest['plan']
        if sha(plan['path']) != plan['sha256']:
            raise ValueError('routing repair plan changed after admission')
        with measured_stage(lambda kind, **data: event(folder, kind, **data), 'bounded-route-repair', 'operation'):
            repair = apply_plan(workspace, board, plan['content'], folder / 'operation/repair')
        lean.atomic_json(folder / 'operation/repair-guard.json', repair)
        code = 0 if repair.get('status') in ('passed', 'proposed') else 1
    elif solver:
        from pcb_routing_trial import prepare, finalize
        solver_output = folder / 'operation/router'
        # Same host default as the engine policy (pcb_engine/policy.py): native on the Mac.
        runtime = 'native' if sys.platform == 'darwin' else 'container'
        prepared = prepare(workspace, native, solver_output, manifest['spec'], manifest['timeout_s'], board=board,
                           runtime=runtime)
        code = execute(folder, 'route', prepared['command'], workspace, dict(env, **prepared['env']))
        solver_report = finalize(prepared, returncode=code)
        lean.atomic_json(folder / 'operation/router-summary.json', solver_report)
        if not code and solver_report.get('status') != 'passed':
            raise ValueError('solver completion lacks verified execution controls')
        if not code:
            routed = solver_output / 'routed.kicad_pcb'
            if not routed.is_file():
                raise ValueError('solver returned success without its routed native candidate')
            shutil.copyfile(routed, native)
    else:
        code = execute(folder, operation, command, workspace, env)
    if code:
        result = dict(status='failed', exit_code=1,
                      cause=(solver_report or {}).get('cause') or operation + ' tool failed', tool_exit=code)
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
        post_screens=EscapeStageReceipts(lambda kind,**data:event(folder,kind,stage='placement-postcheck',**data))
        if engineering:
            constraints = placement_check(root, board, Path(engineering['path']), native,
                                          folder / 'operation/placement-postcheck.json',escape_screens=post_screens)
            if constraints['status'] != 'passed':
                repairable = bool(constraints.get('blockers')) and all(
                    row.get('code') == 'constraint_violation' for row in constraints['blockers'])
                result = dict(status='failed', exit_code=1, scope='candidate_engineering_screen', operation=operation,
                              cause='candidate violates reviewed placement or block requirements', candidate_verified=False,
                              source_sha256=sources['sha256'], report=str(folder / 'operation/placement-postcheck.json'),
                              candidate=str(native), candidate_sha256=sha(native), identity_preserved=identity_ok,
                              protected_source_changes=changed, continuation_allowed=repairable,
                              source_unchanged=source_state(root, board, extra_inputs) == sources,
                              workspace=str(workspace), board=board)
                lean.atomic_json(folder / 'operation/result.json', result)
                return 1
        if design:
            output = folder / 'operation/design-layout-postcheck.json'
            checked = candidate_layout_check(root, workspace, folder, manifest, output,escape_screens=post_screens)
            if checked['status'] != 'passed':
                lean.atomic_json(folder / 'operation/result.json', dict(status='failed', exit_code=1,
                    scope='design_layout_screen', operation=operation, candidate_verified=False, qualified=False,
                    cause='candidate violates declared placement or test access requirements', report=str(output),
                    source_sha256=sources['sha256'], candidate=str(native), candidate_sha256=sha(native),
                    identity_preserved=identity_ok, protected_source_changes=changed,
                    source_unchanged=source_state(root, board, extra_inputs) == sources,
                    workspace=str(workspace), board=board, continuation_allowed=False))
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
                  source_unchanged=source_state(root, board, extra_inputs) == sources, workspace=str(workspace))
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
    if manifest.get('operation') == 'ml':
        raise ValueError('ML observations cannot adopt native CAD')
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
        if source_state(root, board, sources.get('extra_inputs')) != sources:
            raise ValueError('canonical inputs changed since candidate creation; generate and verify a new candidate')
        check = subprocess.run([manifest['node'], str(root / 'tools/pcb_snapshot_inputs.mjs'), str(folder / 'workspace'), board,
                                '--verify', str(folder / 'gate')], capture_output=True, text=True, timeout=90,
                               env=dict(os.environ, IOT_LAB=str(folder / 'workspace')))
        if check.returncode:
            raise ValueError('candidate native evidence is stale: ' + check.stderr.strip())
        # Native/library probes can take time. The original read before those
        # probes cannot authorize replacing a board edited in the meantime.
        verify(folder)
        if source_state(root, board, sources.get('extra_inputs')) != sources:
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
            if source_state(root, board, sources.get('extra_inputs')) != sources:
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
