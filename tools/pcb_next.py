"""Read-only next decisions from exact board context and unified run receipts.

Commands are recommendations, never executed here. A recorded verdict is not
current evidence until its artifacts, native dependencies and tools are checked.
"""
import datetime as dt
import json
import os
from pathlib import Path
import re
import shlex
import shutil
import subprocess
import uuid

import lean_workflow as lean
import pcb_evidence
import pcb_workflow

TERMINAL = {'passed', 'failed', 'error', 'cancelled', 'timeout'}
OPERATIONS = {'check', 'edit', 'route', 'repair', 'build', 'release', 'readiness', 'parts', 'placement', 'routing', 'schematic'}


def read(path):
    value = json.loads(Path(path).read_text())
    if not isinstance(value, dict):
        raise ValueError('expected object: ' + str(path))
    return value


def timestamp(value):
    parsed = dt.datetime.fromisoformat(value.replace('Z', '+00:00'))
    if parsed.tzinfo is None:
        raise ValueError('run timestamp has no timezone')
    return parsed


def latest_run(root, board, project, base, operations=None):
    matches, rejected = [], []
    for folder in Path(base).glob('run-*'):
        if not folder.is_dir() or folder.is_symlink():
            continue
        try:
            manifest = read(folder / 'run.json')
            operation = manifest.get('operation', 'check')
            requested = manifest.get('arguments', [None])[0] if operation == 'readiness' else manifest.get('board')
            if requested != board or operation not in (OPERATIONS if operations is None else operations):
                continue
            if Path(manifest.get('root', '')).resolve() != root:
                rejected.append(dict(path=str(folder), cause='run belongs to a different checkout'))
                continue
            if operation != 'readiness' and manifest.get('project') != project:
                rejected.append(dict(path=str(folder), cause='run belongs to a different configured revision/project'))
                continue
            if manifest.get('run_id') != folder.name or not re.fullmatch(r'run-[A-Za-z0-9_-]+', folder.name):
                raise ValueError('run identity mismatch')
            matches.append((timestamp(manifest['created_at']), folder.name, folder, manifest))
        except (OSError, ValueError, KeyError, TypeError, IndexError) as error:
            rejected.append(dict(path=str(folder), cause=str(error)))
    if not matches:
        return None, rejected
    matches.sort(key=lambda row: (row[0], row[1]), reverse=True)
    # An older admitted run can still be using this board while a newer one
    # has finished. Observe that work before recommending another operation.
    from pcb_cli import status
    for _, _, folder, manifest in matches:
        try:
            state = status(folder)
            if state.get('controller_alive') is True or state['status'] in {'starting', 'running', 'stopping'}:
                return (folder, manifest), rejected
        except (OSError, ValueError, KeyError, TypeError):
            pass  # The newest observation is validated explicitly below.
    _, _, folder, manifest = matches[0]
    return (folder, manifest), rejected


def repo_inputs_unchanged(root, gate):
    """Fail cheaply on known changed inputs before probing native tool versions."""
    for entry in gate.get('provenance', {}).get('inputs', []):
        name = entry['path']
        if name.startswith('external/'):
            continue  # Resolved by the existing native dependency verifier.
        path = (root / name).resolve()
        if not path.is_relative_to(root):
            raise ValueError('recorded gate input escapes its checkout: ' + name)
        expected = entry.get('sha256')
        if (path.exists() if expected is None else not path.is_file() or pcb_workflow.sha(path) != expected):
            raise ValueError('recorded gate input changed: ' + name)


def verify_current_inputs(root, board, gate_dir):
    """Only existing source/tool verification; never run ERC, DRC or fabrication."""
    raw = read(gate_dir / 'result.json')
    repo_inputs_unchanged(root, raw)
    node = shutil.which(os.environ.get('NODE', 'node'))
    if not node:
        raise RuntimeError('Node.js unavailable; dependency freshness is unverified')
    command = [node, str(root / 'tools/pcb_snapshot_inputs.mjs'), str(root), board,
               '--verify-inputs', str(gate_dir)]
    try:
        result = lean.run_stage(command, stage='next-input-verification', deadline=lean.deadline_after(20),
                                text=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                env=dict(os.environ, IOT_LAB=str(root)))
    except subprocess.TimeoutExpired as error:
        cleanup = getattr(error, 'cleanup', {})
        suffix = '; owned probes stopped' if cleanup.get('complete') is True else '; probe cleanup unconfirmed'
        raise RuntimeError('dependency/tool verification exceeded its 20-second observation budget' + suffix) from None
    if result.returncode:
        raise RuntimeError(result.stderr.strip() or result.stdout.strip() or 'dependency verification failed')
    verified = json.loads(result.stdout)
    if verified.get('verified') is not True or verified.get('input_sha256') != raw.get('provenance', {}).get('input_sha256'):
        raise ValueError('dependency verifier returned mismatched evidence')
    return verified


def required_gate_evidence(folder, gate_dir, result):
    raw = read(gate_dir / 'result.json')
    hashes = result.get('evidence_sha256', {})
    required = ['result.json', 'events.jsonl', 'findings.json']
    required += [name + extension for name in ('erc', 'drc') if name in raw.get('checks', {})
                 and raw['checks'][name].get('status') in {'passed', 'failed'} for extension in ('.json', '.log')]
    for name in required:
        path = gate_dir / name
        if not path.is_relative_to(folder) or str(path.relative_to(folder)) not in hashes:
            raise ValueError('terminal receipt does not bind required gate evidence: ' + str(path))
    if result.get('input_sha256') is not None and raw.get('provenance', {}).get('input_sha256') != result['input_sha256']:
        raise ValueError('terminal and gate input fingerprints disagree')
    if raw.get('changedDuringRun') is not False:
        raise ValueError('gate inputs changed during the recorded invocation')
    return raw


def current_finding(folder, gate_dir, raw, board, project):
    findings = read(gate_dir / 'findings.json')
    if (findings.get('board') != board or findings.get('project') != project
            or findings.get('inputs_valid') is not True
            or findings.get('input_sha256') != raw['provenance']['input_sha256']):
        raise ValueError('findings do not match valid gate input evidence')
    checks = raw.get('checks', {})
    stages = list(dict.fromkeys(['preflight', 'erc', 'drc', *checks]))
    for stage in stages:
        check = checks.get(stage, {})
        if check.get('status') != 'failed' or not check.get('metrics') or any(value is None for value in check['metrics'].values()):
            continue
        for finding in findings.get('findings', []):
            pointer = finding.get('evidence', {}).get('pointer', '')
            hard_native = pointer.startswith(('/schematic_parity/', '/unconnected_items/'))
            if finding.get('stage') != stage or (finding.get('severity') != 'error' and not hard_native):
                continue
            source = dict(finding.get('evidence', {}))
            path = (gate_dir / source.get('path', '')).resolve()
            if not path.is_relative_to(gate_dir) or not path.is_file():
                raise ValueError('finding evidence escapes or is missing from its gate directory')
            source.update(path=str(path), sha256=pcb_workflow.sha(path))
            return dict(code='gate_finding', stage=stage, finding_id=finding.get('id'),
                        rule=finding.get('rule'), message=finding.get('message'), evidence=source,
                        **{key: finding[key] for key in ('refs', 'pads', 'nets', 'location', 'measured', 'required', 'source') if key in finding})
    raise ValueError('failed gate has no attributable completed-stage finding')


def design_next(root, identifier, contract, base, through=None):
    """Observe a sealed stage assessment, including ideas without native CAD.

    Checking freshness reads files only. Native verifiers belong to the owned
    design operation and are never repeated to render a next-action response.
    """
    contract = Path(contract).resolve()
    value = read(contract)
    identity = value.get('identity', {})
    if identity.get('design_id') != identifier:
        raise ValueError('next design subject differs from its contract identity')
    from design_contract import STAGES
    stage = through or value.get('current_stage')
    if stage not in STAGES:
        raise ValueError('next needs a declared lifecycle stage')
    board = identity.get('board') or identifier
    selected, rejected = latest_run(root, board, None, base, operations={'design'})
    output = dict(schema_version=1, design_id=identifier, board=board, through=stage,
        scope='next_design_decision_only', qualified=False, readiness_verified=False,
        observed_run=None, ignored_observations=rejected, evidence=dict(freshness='missing'))

    def finish(state, code, message, argv, **details):
        output.update(state=state, blocker=dict(code=code, message=message, **details),
            next_action=dict(argv=argv, command=shlex.join(argv), cwd=str(root)))
        return output

    prefix = ['tools/pcb', 'design', '--runs-dir', str(base), '--json']
    check = prefix + ['check', identifier, '--contract', str(contract), '--through', stage]
    if not selected:
        return finish('needs_check', 'design_assessment_missing', 'No owned assessment for this design stage', check)
    folder, manifest = selected
    from pcb_cli import status
    state = status(folder)
    output['observed_run'] = dict(run_id=folder.name, operation='design', status=state['status'])
    if state.get('controller_alive') or state['status'] in {'starting', 'running', 'stopping'}:
        output['evidence']['freshness'] = 'running'
        return finish('observe', 'run_in_progress', 'Current design assessment must settle',
            ['tools/pcb', 'events', '--runs-dir', str(base), folder.name, '--json', '--wait', '20'])
    try:
        result = pcb_evidence.verify(folder)
        binding = manifest.get('design_contract', {})
        if (Path(binding.get('path', '')).resolve() != contract or binding.get('sha256') != pcb_workflow.sha(contract)
                or manifest.get('design_stage') != stage):
            raise ValueError('design contract or requested stage changed')
        inputs = result.get('engineering_inputs')
        if not isinstance(inputs, dict) or not inputs:
            raise ValueError('design assessment lacks source bindings')
        if 'engineering_policy' in result:
            from pcb_observation_inputs import current
            if not current(result['engineering_policy']):
                raise ValueError('engineering code resolution changed since the assessment')
        if any(not Path(name).is_file() or pcb_workflow.sha(name) != digest for name, digest in inputs.items()):
            raise ValueError('design assessment source or tool changed')
        if any(Path(name).exists() or Path(name).is_symlink() for name in result.get('engineering_absent_inputs', [])):
            raise ValueError('a previously absent design input appeared')
        report_path = folder / 'operation/report.json'
        report = read(report_path)
        if report.get('design_id') != identifier or report.get('through') != stage:
            raise ValueError('assessment report belongs to another design or stage')
        from design_contract import current_assessment
        if not current_assessment(report):
            raise ValueError('design assessment inputs or dated release context expired')
        output['evidence'] = dict(freshness='current', report=str(report_path), report_sha256=pcb_workflow.sha(report_path),
            receipt=str(folder / 'result.json'))
        output['readiness_verified'] = result['status'] == 'passed' and report.get('status') == 'passed'
        output['assessment'] = dict(status=report.get('status'), stages=report.get('stages'),
            next_stage=report.get('next_stage'), requirement_results=report.get('requirement_results'))
        first = next(iter(report.get('blockers', [])), {})
        code = first.get('code', 'design_stage_review')
        message = first.get('detail', report.get('cause', 'Review current stage evidence and the next engineering decision'))
        repeated = 0
        if result['status'] == 'failed':
            for other in base.glob('run-*'):
                try:
                    prior = read(other / 'run.json')
                    if (prior.get('operation') != 'design' or prior.get('board') != board or prior.get('design_stage') != stage
                            or prior.get('design_contract') != binding or Path(prior.get('root', '')).resolve() != root):
                        continue
                    observation = pcb_evidence.verify(other)
                    old_report = read(other / 'operation/report.json')
                    if (observation.get('status') == 'failed' and observation.get('engineering_inputs') == inputs
                            and observation.get('engineering_absent_inputs', []) == result.get('engineering_absent_inputs', [])
                            and old_report.get('blockers') == report.get('blockers')):
                        repeated += 1
                except (OSError, ValueError, KeyError, TypeError):
                    continue
        if repeated >= 2:
            code, message = 'repeated_unchanged_failure', 'Same current failure recorded twice; resolve its cited cause before retrying'
        return finish('stuck' if repeated >= 2 else 'review' if output['readiness_verified'] else 'blocked', code, message,
            ['tools/pcb', 'explain', '--runs-dir', str(base), folder.name, '--json'],
            stage=stage, requirement_id=first.get('requirement_id', first.get('requirement')), evidence=first.get('evidence'), repeated_failures=repeated,
            engineering_next_action=report.get('next_action'))
    except (OSError, ValueError, KeyError, TypeError, RuntimeError) as error:
        output['evidence'] = dict(freshness='stale_or_invalid', cause=str(error))
        return finish('needs_check', 'design_assessment_stale', str(error), check)


def next_action(root, board, base=None, design_contract=None, through=None):
    root = Path(root).resolve()
    base = Path(base if base is not None else os.environ.get('PCB_RUNS_DIR', root / '.gate/cli')).resolve()
    default_design = root / 'hardware-design/registry/design-contracts' / (board + '.json')
    if design_contract or default_design.is_file():
        path = Path(design_contract) if design_contract else default_design
        identifier = read(path).get('identity', {}).get('design_id')
        if design_contract and identifier != board:
            raise ValueError('explicit design next subject must be its design_id')
        return design_next(root, identifier, path, base, through)
    context = pcb_workflow.context(root, board)
    _, config, _ = pcb_workflow.board_config(root, board)
    check_mode = '--fresh' if config.get('stage') == 'G5' else '--changed'
    selected, rejected = latest_run(root, board, config['project'], base)
    output = dict(schema_version=1, board=board, project=context['project'], revision=context['revision'],
                  frozen=context['frozen'], scope='next_decision_only',
                  context_blockers=[b for b in context['blockers'] if b['rule'] in {'missing_native_input', 'missing_context_source'}],
                  ignored_observations=rejected,
                  observed_run=None, evidence=dict(freshness='missing'),
                  readiness_verified=False, qualification='guidance only; no release, order or measured qualification granted')

    def command(*args):
        argv = ['tools/pcb', args[0]]
        if base != (root / '.gate/cli').resolve():
            argv += ['--runs-dir', str(base)]
        argv += list(args[1:])
        return dict(argv=argv, command=shlex.join(argv), cwd=str(root))

    def finish(state, code, message, action, *args, evidence=None, **details):
        output.update(state=state, blocker=dict(code=code, message=message, **details),
                      next_action=dict(kind=action, **command(*args)))
        if evidence is not None:
            output['blocker']['evidence'] = evidence
        return output

    selected_state = None
    if selected:
        folder, manifest = selected
        output['observed_run'] = dict(run_id=folder.name, operation=manifest.get('operation', 'check'),
            created_at=manifest['created_at'], manifest=str(folder / 'run.json'), evidence_dir=str(folder))
        try:
            from pcb_cli import status
            recorded_state = read(folder / 'state.json').get('status')
            if recorded_state not in TERMINAL | {'starting', 'running', 'stopping'}:
                raise ValueError('unknown run state: ' + str(recorded_state))
            selected_state = status(folder)
            output['observed_run']['status'] = selected_state['status']
            if selected_state['status'] not in TERMINAL and selected_state['status'] not in {'starting', 'running', 'stopping'}:
                raise ValueError('unknown run state: ' + str(selected_state['status']))
            if selected_state.get('controller_alive') is True or selected_state['status'] in {'starting', 'running', 'stopping'}:
                output['evidence']['freshness'] = 'running'
                return finish('observe', 'run_in_progress', 'Existing run must settle before another decision',
                              'observe', 'events', folder.name, '--json', '--wait', '20',
                              evidence=dict(path=str(folder / 'state.json'), active_stages=selected_state.get('active_stages', [])))
        except (OSError, ValueError, KeyError, TypeError) as error:
            output['evidence'] = dict(freshness='invalid', cause=str(error))
            return finish('blocked', 'invalid_run_state', str(error), 'inspect', 'status', folder.name, '--json',
                          evidence=dict(path=str(folder / 'state.json')))

    missing = next((b for b in context['blockers'] if b['rule'] in {'missing_native_input', 'missing_context_source'}), None)
    if missing:
        return finish('blocked', missing['rule'], 'Required board input is missing: ' + missing['path'],
                      'inspect_required_source', 'context', board, '--json', evidence=dict(path=str(root / missing['path']), exists=False))
    if not selected:
        legacy = context.get('previous_gate')
        output['evidence'] = dict(freshness='unverified_legacy' if legacy else 'missing',
                                  **({'legacy_observation': legacy} if legacy else {}))
        return finish('needs_check', 'current_check_missing', 'No current unified run evidence for this board revision',
                      'check', 'check', board, check_mode, '--follow', '--json')

    folder, manifest = selected
    operation = manifest.get('operation', 'check')
    if selected_state['status'] not in {'passed', 'failed'}:
        output['evidence'] = dict(freshness='incomplete', cause=selected_state.get('cause'))
        return finish('blocked', 'run_not_completed', selected_state.get('cause', 'Run has no completed gate verdict'),
                      'inspect', 'explain', folder.name, '--json', evidence=dict(path=str(folder / 'worker.log')))
    phase = 'artifacts'
    try:
        result = pcb_evidence.verify(folder)
        output['evidence'] = dict(freshness='artifacts_verified', receipt=str(folder / 'result.json'),
                                  receipt_sha256=pcb_workflow.sha(folder / 'result.json'))
        if operation == 'readiness':
            return finish('review', 'readiness_requires_current_review', 'Order-preparation evidence needs review of its recorded inputs and date',
                          'inspect', 'explain', folder.name, '--json', evidence=dict(path=str(folder / 'operation/readiness.log')))
        if operation in {'parts', 'placement', 'routing', 'schematic'}:
            phase = 'source'
            if manifest.get('from_run'):
                # Reports about an isolated candidate bind that candidate's
                # files. Reuse continuation admission to also check the
                # canonical source from which the parent was created.
                from pcb_operations import parent_candidate
                parent_candidate(root, board, manifest['from_run'])
            inputs = result.get('engineering_inputs')
            if not isinstance(inputs, dict) or not inputs:
                raise ValueError('engineering observation lacks current input bindings')
            if 'engineering_policy' in result:
                from pcb_observation_inputs import current
                if not current(result['engineering_policy']):
                    raise ValueError('engineering code resolution changed since the observation')
            for name, digest in inputs.items():
                if not Path(name).is_file() or pcb_workflow.sha(name) != digest:
                    raise ValueError('engineering observation input changed: ' + name)
            if any(Path(name).exists() or Path(name).is_symlink() for name in result.get('engineering_absent_inputs', [])):
                raise ValueError('a previously absent engineering input appeared')
            report_path = folder / 'operation/report.json'
            report = read(report_path)
            if report.get('scope') == 'assembly_stock_observation':
                from part_evidence import stock_population_current
                if not stock_population_current(report):
                    raise ValueError('assembly population source presence or contents changed since stock observation')
            output['evidence'].update(freshness='current', report=str(report_path), report_sha256=pcb_workflow.sha(report_path))
            if report.get('scope') == 'assembly_stock_observation':
                today = dt.datetime.now(dt.timezone.utc).date().isoformat()
                if report.get('order_day_utc') != today:
                    output['evidence']['freshness'] = 'expired_stock_day'
                    destination = root / '.gate/assembly-stock' / (board + '-' + today + '-' + uuid.uuid4().hex)
                    candidate = report.get('candidate')
                    boards = report.get('boards')
                    if candidate and isinstance(boards, int) and boards > 0:
                        return finish('needs_stock_refresh', 'stock_day_expired',
                            'Assembly availability observation is from another UTC day',
                            'refresh_stock', 'parts', '--json', 'stock', board, '--candidate', str(candidate),
                            '--boards', str(boards), '--receipts', str(destination), evidence=dict(path=str(report_path)),
                            stock_current=False)
                    return finish('needs_stock_refresh', 'stock_day_expired',
                        'Assembly availability observation is from another UTC day',
                        'inspect_stock_context', 'explain', folder.name, '--json',
                        evidence=dict(path=str(report_path)), stock_current=False)
            if operation == 'routing' and report.get('status') == 'repairable':
                continuation = ['--from-run', Path(manifest['from_run']['folder']).name] if manifest.get('from_run') else []
                return finish('needs_repair', 'bounded_route_repair',
                    'Current native evidence supports one bounded isolated repair',
                    'repair', 'repair', board, '--plan', str(report_path), *continuation, '--follow', '--json',
                    evidence=dict(path=str(report_path)), qualified=False)
            blockers = report.get('blockers', []) or report.get('findings', [])
            first = blockers[0] if blockers and isinstance(blockers[0], dict) else {}
            return finish('review' if result['status'] == 'passed' else 'blocked',
                first.get('code', operation + '_review'),
                first.get('detail', first.get('message', report.get('cause', operation + ' evidence needs an engineering decision'))),
                'inspect_engineering_evidence', 'explain', folder.name, '--json',
                evidence=dict(path=str(report_path)), engineering_status=report.get('status'), qualified=False)
        phase = 'source'
        if manifest.get('gate_config_sha256') != pcb_workflow.sha(root / 'hardware-design/boards' / board / 'gate.json'):
            raise ValueError('configured board gate changed since the run')
        gate_dir = folder / 'gate'
        if operation == 'release':
            gate_dir = folder / ('candidate/gate' if (folder / 'candidate/gate').is_dir() else 'release-work/gate')
        if not (gate_dir / 'result.json').exists():
            output['evidence']['freshness'] = 'recorded_only'
            return finish('blocked', 'operation_failed_before_gate', result.get('cause', 'Operation has no completed gate evidence'),
                          'inspect', 'explain', folder.name, '--json', evidence=dict(path=str(folder / 'operation' / (operation + '.log'))))
        phase = 'artifacts'
        raw = required_gate_evidence(folder, gate_dir, result)
        checks = raw.get('checks', {})
        enabled = {key for key, value in config.get('checks', {}).items() if value is not False and value is not None}
        if set(checks) != enabled or any(check.get('status') not in {'passed', 'failed', 'blocked', 'error'} for check in checks.values()):
            raise ValueError('gate has missing or unknown configured check states')
        if raw.get('exit') == 0 and (any(check.get('status') != 'passed' for check in checks.values())
                or not raw.get('metrics') or any(value is None for value in raw['metrics'].values())):
            raise ValueError('passed gate lacks complete configured check verdicts')
        verification_root = root
        if operation in {'build', 'edit', 'route', 'repair'}:
            phase = 'source'
            from pcb_operations import source_state
            sources = read(folder / 'operation/source.json')
            if source_state(root, board, sources.get('extra_inputs')) != sources:
                raise ValueError('canonical inputs changed since candidate creation')
            verification_root = folder / 'workspace'
        phase = 'freshness'
        verified = verify_current_inputs(verification_root, board, gate_dir)
        output['evidence'].update(freshness='current', input_sha256=verified['input_sha256'], gate=str(gate_dir))
        if raw.get('exit') == 1:
            if (operation in {'build', 'edit', 'route', 'repair'}
                    and result.get('identity_preserved') is True and result.get('source_unchanged') is True
                    and all(raw.get('metrics', {}).get(key) == 0 for key in ('erc_errors', 'drc_errors', 'drc_parity'))
                    and (raw.get('metrics', {}).get('drc_unconnected') or 0) > 0):
                return finish('needs_diagnosis', 'candidate_connectivity_open',
                    'Isolated candidate preserves design identity but needs routing diagnosis',
                    'diagnose_candidate', 'routing', '--from-run', folder.name, '--json', 'diagnose', board,
                    '--evidence', str(gate_dir / 'result.json'), evidence=dict(path=str(gate_dir / 'drc.json')))
            finding = current_finding(folder, gate_dir, raw, board, config['project'])
            return finish('blocked', finding.pop('code'), finding.pop('message'), 'inspect_finding',
                          'explain', folder.name, '--json', **finding)
        if raw.get('exit') != 0 or result.get('status') != 'passed':
            return finish('blocked', 'operation_failed', result.get('cause', 'Operation did not pass after its native gate'),
                          'inspect', 'explain', folder.name, '--json', evidence=dict(path=str(folder / 'operation' / (operation + '.log'))))
        if operation in {'build', 'edit', 'route', 'repair'}:
            if not result.get('candidate_verified') or not result.get('identity_preserved'):
                raise ValueError('candidate lacks verified design identity and gate evidence')
            if context['frozen']:
                return finish('review', 'frozen_candidate_needs_named_defect', 'Frozen-board adoption requires a current failed baseline and exact defect ID',
                              'inspect_candidate', 'explain', folder.name, '--json',
                              evidence=dict(path=str(folder / 'operation/result.json')), required_inputs=['baseline_run_id', 'finding_id'])
            return finish('review', 'candidate_not_adopted', 'Verified isolated candidate has not changed canonical CAD',
                          'explicit_adoption', 'adopt', folder.name, '--json', evidence=dict(path=str(folder / 'operation/result.json')),
                          mutates_cad=True)
        if operation == 'release':
            candidate = folder / 'candidate'
            return finish('needs_review', 'assembly_readiness_unverified', 'Fabrication candidate does not establish stock, assembly orientation or order readiness',
                          'readiness', 'readiness', '--json', board, str(candidate), evidence=dict(path=str(candidate / 'release-manifest.json')))
        if verified.get('release_supported'):
            return finish('needs_release', 'release_evidence_missing', 'Configured checks passed; fabrication and assembly evidence remain separate',
                          'generate_release_candidate', 'release', board, '--follow', '--json', evidence=dict(path=str(gate_dir / 'result.json')))
        return finish('review', 'next_stage_unverified', 'Configured gate passed; review the next stage and board workflow before changing scope',
                      'review_stage', 'context', board, '--json', evidence=dict(path=str(gate_dir / 'result.json')))
    except (OSError, ValueError, KeyError, TypeError, RuntimeError) as error:
        freshness = ('missing' if isinstance(error, FileNotFoundError) else
                     'invalid' if phase == 'artifacts' else 'stale' if isinstance(error, ValueError) else 'unverified')
        output['evidence'].update(freshness=freshness, cause=str(error))
        return finish('needs_check', 'evidence_not_current', str(error), 'check', 'check', board, check_mode, '--follow', '--json',
                      evidence=dict(path=str(folder / 'result.json')))
