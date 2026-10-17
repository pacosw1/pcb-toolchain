"""One engineering observation record across reviews and owned CLI runs.

Recorded review intervals are elapsed wall time, not inferred human attention.
Closing a cycle never qualifies a part, board, release or bench measurement.
"""
import datetime as dt
import fcntl
import hashlib
import json
from pathlib import Path
import re
import tempfile
import time
import uuid

import lean_workflow as lean
from pcb_timing import union_seconds
from pcb_workflow import board_config


STAGES = ('requirements', 'architecture', 'parts', 'datasheets', 'schematic', 'placement',
          'routing', 'verification', 'release', 'prototype', 'production')
OPERATION_STAGE = {'parts': 'parts', 'placement': 'placement', 'routing': 'routing',
                   'repair': 'routing', 'edit': 'placement', 'route': 'routing',
                   'check': 'verification', 'release': 'release', 'readiness': 'release',
                   'blocks': 'schematic', 'build': 'placement', 'doctor': 'verification',
                   'schematic': 'schematic', 'design': 'requirements', 'outcomes': 'placement'}
CYCLE_ID = re.compile(r'cycle-[A-Za-z0-9_-]+\Z')


def sha(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def read(path):
    value = json.loads(Path(path).read_text())
    if not isinstance(value, dict):
        raise ValueError('expected cycle object')
    return value


def folder_for(base, cycle):
    if not CYCLE_ID.fullmatch(cycle):
        raise ValueError('invalid cycle ID')
    folder = Path(base).resolve() / cycle
    if folder.is_symlink() or not (folder / 'cycle.json').is_file():
        raise ValueError('unknown engineering cycle')
    return folder


def create(root, base, board, owner, contract=None):
    root, base = Path(root).resolve(), Path(base).resolve()
    design = None
    if contract:
        from design_contract import load_contract
        contract = Path(contract).resolve()
        raw = load_contract(root, contract)
        if (raw['identity']['board'] or raw['identity']['design_id']) != board:
            raise ValueError('cycle subject differs from its exact design contract identity')
        design = dict(path=str(contract), sha256=sha(contract), design_id=raw['identity']['design_id'])
    if (root / 'hardware-design/boards' / board / 'gate.json').is_file():
        _, _, project = board_config(root, board)
    elif design:
        project = None
    else:
        raise ValueError('a cycle before native CAD requires an explicit design contract')
    if not owner.strip():
        raise ValueError('one integration owner is required')
    base.mkdir(parents=True, exist_ok=True)
    folder = Path(tempfile.mkdtemp(prefix='cycle-', dir=base))
    data = dict(schema='iot-lab.engineering-cycle.v1', cycle_id=folder.name,
                root=str(root), board=board, project=str(project.relative_to(root)) if project else None,
                owner=owner, scope='engineering_observation', status='open',
                started_unix_s=time.time(), activities=[], runs=[], qualified=False,
                release_approved=False)
    if design:
        data['design_contract'] = design
    lean.atomic_json(folder / 'cycle.json', data)
    return summarize(folder)


def mutate(folder, callback):
    folder = Path(folder)
    with (folder / 'cycle.lock').open('a') as stream:
        fcntl.flock(stream, fcntl.LOCK_EX)
        data = read(folder / 'cycle.json')
        if data['status'] != 'open':
            raise ValueError('engineering observation cycle is closed')
        callback(data)
        lean.atomic_json(folder / 'cycle.json', data)


def begin(folder, stage, owner, description):
    if stage not in STAGES or not owner.strip() or not description.strip():
        raise ValueError('review activity needs an explicit stage, owner and description')
    activity_id = 'activity-' + uuid.uuid4().hex
    def update(data):
        data['activities'].append(dict(activity_id=activity_id, stage=stage, owner=owner,
                                       description=description, started_unix_s=time.time(),
                                       status='running', measurement='recorded_review_interval'))
    mutate(folder, update)
    return dict(activity_id=activity_id, cycle_id=Path(folder).name, status='running')


def end(folder, activity_id, outcome, evidence, decision):
    if outcome not in ('passed', 'blocked', 'rework') or not evidence or not decision.strip():
        raise ValueError('ending review requires outcome, evidence and decision')
    files = {str(Path(path).resolve()): sha(path) for path in evidence}
    def update(data):
        row = next((r for r in data['activities'] if r['activity_id'] == activity_id), None)
        if row is None or row['status'] != 'running':
            raise ValueError('review activity is absent or already ended')
        now = time.time()
        if now < row['started_unix_s']:
            raise ValueError('wall clock moved backwards; review interval is unmeasured')
        row.update(status=outcome, ended_unix_s=now, evidence=files, decision=decision,
                   elapsed_s=now - row['started_unix_s'])
    mutate(folder, update)
    return summarize(folder)


def attach(folder, run_folder, stage=None):
    run_folder = Path(run_folder).resolve()
    manifest = read(run_folder / 'run.json')
    stage = stage or (manifest.get('design_stage') if manifest['operation'] == 'design' else None) or OPERATION_STAGE.get(manifest['operation'])
    if stage not in STAGES:
        raise ValueError('operation requires an explicit engineering stage')
    def update(data):
        if Path(manifest['root']).resolve() != Path(data['root']) or manifest['board'] != data['board']:
            raise ValueError('run belongs to another board or checkout')
        if any(r['run_id'] == manifest['run_id'] for r in data['runs']):
            raise ValueError('run already belongs to this cycle')
        data['runs'].append(dict(run_id=manifest['run_id'], folder=str(run_folder), stage=stage,
                                 manifest_sha256=sha(run_folder / 'run.json')))
    mutate(folder, update)


def summarize(folder):
    folder = Path(folder).resolve()
    data = read(folder / 'cycle.json')
    result = dict(data)
    if data.get('design_contract'):
        binding = data['design_contract']
        contract = Path(binding['path'])
        result['design_context_current'] = contract.is_file() and sha(contract) == binding['sha256']
    rows, issues, intervals = [], [], []
    for activity in data['activities']:
        row = dict(activity)
        if row['status'] != 'running':
            for path, expected in row.get('evidence', {}).items():
                if not Path(path).is_file() or sha(path) != expected:
                    issues.append(dict(activity_id=row['activity_id'], cause='review evidence changed', path=path))
            intervals.append((row['started_unix_s'], row['ended_unix_s']))
        rows.append(row)
    runs = []
    for link in data['runs']:
        run_folder = Path(link['folder'])
        row = dict(link, status='unobserved', elapsed_s=None, evidence_verified=False)
        try:
            if sha(run_folder / 'run.json') != link['manifest_sha256']:
                raise ValueError('linked run manifest changed')
            manifest = read(run_folder / 'run.json')
            if manifest['board'] != data['board'] or Path(manifest['root']).resolve() != Path(data['root']):
                raise ValueError('linked run changed board or checkout')
            if (run_folder / 'result.json').is_file():
                from pcb_evidence import evidence_files
                terminal = read(run_folder / 'result.json')
                if terminal.get('status') not in ('passed', 'failed', 'error', 'timeout', 'cancelled'):
                    raise ValueError('linked run is not terminal')
                if terminal.get('cleanup', {}).get('complete') is not True:
                    raise ValueError('linked run cleanup is unconfirmed')
                if terminal.get('evidence_sha256') != evidence_files(run_folder):
                    raise ValueError('linked run evidence changed')
                if link.get('result_sha256') and sha(run_folder / 'result.json') != link['result_sha256']:
                    raise ValueError('closed cycle run result changed')
                row.update(status=terminal['status'], elapsed_s=terminal.get('elapsed_s'),
                           evidence_verified=True, result_sha256=sha(run_folder / 'result.json'),
                           timing=terminal.get('timing'), cause=terminal.get('cause'))
                report_path = run_folder / 'operation/report.json'
                if report_path.is_file():
                    observation = read(report_path)
                    if observation.get('schema') == 'iot-lab.design-assessment.v1':
                        from design_contract import current_assessment
                        row.update(assessment_current=current_assessment(observation),
                                   assessment_status=observation.get('status'),
                                   assessment_through=observation.get('through'),
                                   blockers=observation.get('blockers', []))
                    if observation.get('scope') == 'assembly_stock_observation':
                        from part_evidence import stock_population_current
                        row['order_day_utc'] = observation.get('order_day_utc')
                        row['availability_current_day'] = observation.get('order_day_utc') == dt.datetime.now(dt.timezone.utc).date().isoformat()
                        current_inputs = all(Path(name if Path(name).is_absolute() else Path(data['root']) / name).is_file()
                            and sha(Path(name if Path(name).is_absolute() else Path(data['root']) / name)) == digest
                            for name, digest in observation.get('inputs', {}).items())
                        row['availability_inputs_current'] = (bool(observation.get('inputs')) and current_inputs
                                                              and stock_population_current(observation))
                        row['stock_current'] = bool(row['availability_current_day'] and row['availability_inputs_current']
                                                    and observation.get('stock_current'))
                start = dt.datetime.fromisoformat(manifest['created_at'].replace('Z', '+00:00')).timestamp()
                ended = terminal.get('ended_unix_s')
                startup = (terminal.get('timing') or {}).get('supervisor_startup_s')
                if isinstance(ended, (int, float)) and ended >= start:
                    intervals.append((start, ended))
                    row['observed_interval_unix_s'] = [start, ended]
                    row['interval_source'] = 'recorded_submission_and_terminal_boundaries'
                elif isinstance(row['elapsed_s'], (int, float)) and isinstance(startup, (int, float)) and startup >= 0:
                    intervals.append((start, start + startup + row['elapsed_s']))
                    row['observed_interval_unix_s'] = [start, start + startup + row['elapsed_s']]
                    row['interval_source'] = 'recorded_submission_startup_and_supervisor_duration'
                else:
                    row['interval_source'] = 'unknown; no admission/start boundary'
            else:
                from pcb_cli import status
                observed = status(run_folder)
                row.update(status=observed['status'], elapsed_s=observed.get('elapsed_s'),
                           active_stages=observed.get('active_stages', []))
        except (OSError, ValueError, KeyError, TypeError) as error:
            row.update(status='stale', cause=str(error))
            issues.append(dict(run_id=link['run_id'], cause=str(error)))
        runs.append(row)
    observed_stages = {row['stage'] for row in rows + runs}
    stage_summary = {}
    for stage in STAGES:
        reviews = [r for r in rows if r['stage'] == stage]
        jobs = [r for r in runs if r['stage'] == stage]
        stage_summary[stage] = dict(observed=stage in observed_stages,
            review_elapsed_s=union_seconds([(r['started_unix_s'], r['ended_unix_s']) for r in reviews if 'ended_unix_s' in r]),
            run_elapsed_s=union_seconds([r['observed_interval_unix_s'] for r in jobs if 'observed_interval_unix_s' in r]),
            sum_run_duration_s=sum(r['elapsed_s'] for r in jobs if isinstance(r['elapsed_s'], (int, float))) if jobs else None,
            run_interval_coverage=('complete' if jobs and all('observed_interval_unix_s' in r for r in jobs) else
                                   'partial' if any('observed_interval_unix_s' in r for r in jobs) else 'unavailable'),
            runs=len(jobs), rework=sum(r['status'] == 'rework' for r in reviews),
            blocked=sum(r['status'] in ('blocked', 'failed', 'error', 'timeout') for r in reviews + jobs))
    recorded_causes = []
    for row in rows + runs:
        if row['status'] not in ('blocked', 'failed', 'error', 'timeout', 'rework'):
            continue
        causes = row.get('blockers') or [dict(detail=row.get('decision') or row.get('cause') or 'Cause unrecorded')]
        for cause in causes:
            recorded_causes.append(dict(stage=row['stage'], outcome=row['status'],
                run_id=row.get('run_id'), activity_id=row.get('activity_id'),
                code=cause.get('code'), cause=cause.get('detail'), requirement=cause.get('requirement'),
                check=cause.get('check')))
    result.update(activities=rows, runs=runs, stages=stage_summary, evidence_issues=issues,
                  recorded_failure_rework_causes=recorded_causes,
                  covered_elapsed_s=union_seconds(intervals),
                  unobserved_stages=[stage for stage in STAGES if stage not in observed_stages],
                  elapsed_s=max(0, data.get('ended_unix_s', time.time()) - data['started_unix_s']),
                  effort_scope='recorded intervals and owned runs; human attention and unrecorded work are unknown',
                  evidence=str(folder / 'cycle.json'))
    return result


def finish(folder):
    def update(data):
        # mutate holds the same lock used by begin/end/attach. Validate the
        # current record under that lock, never a previously observed snapshot.
        state = summarize(folder)
        if state['evidence_issues'] or any(r['status'] == 'running' for r in state['activities']):
            raise ValueError('resolve changed evidence and end recorded review activities before closing')
        if any(not r['evidence_verified'] for r in state['runs']):
            raise ValueError('linked runs must have verified terminal evidence before closing')
        for link in data['runs']:
            link['result_sha256'] = sha(Path(link['folder']) / 'result.json')
        data.update(status='recorded', ended_unix_s=time.time())
    mutate(folder, update)
    return summarize(folder)
