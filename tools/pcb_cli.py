"""Observable board workflows. One owned supervisor and durable journal per run.

The gate owns validation/provenance. This module owns observation and lifecycle;
it never writes CAD, tracked metrics, or the board's latest-gate pointer.
"""
import argparse
import datetime as dt
import fcntl
import hashlib
import json
import math
import os
from pathlib import Path
import re
import shutil
import signal
import subprocess
import sys
import tempfile
import time

import lean_owned
import lean_workflow as lean
import pcb_workflow
from pcb_timing import MeasuredSpan, Timeline, live_stages, measured_stage

ROOT = Path(__file__).resolve().parent.parent
TERMINAL = {'passed', 'failed', 'error', 'cancelled', 'timeout'}
RUN_ID = re.compile(r'run-[A-Za-z0-9_-]+\Z')
OBSERVATIONS = ('parts', 'placement', 'routing', 'design', 'schematic', 'outcomes', 'ml')


def backend_option(arguments, name):
    values = []
    for index, arg in enumerate(arguments):
        if arg == name:
            if index + 1 >= len(arguments):
                raise ValueError(name + ' requires a value')
            values.append(arguments[index + 1])
        elif arg.startswith(name + '='):
            values.append(arg.split('=', 1)[1])
    if len(values) > 1:
        raise ValueError('duplicate backend option: ' + name)
    return values[0] if values else None


def utc():
    return dt.datetime.now(dt.timezone.utc).isoformat(timespec='milliseconds')


def compact_terminal(result, folder):
    """Keep inventories in the sealed receipt instead of every streamed event."""
    view = dict(result)
    counts = {}
    for name in ('engineering_inputs', 'engineering_absent_inputs', 'evidence_sha256', 'artifacts'):
        if name in view:
            counts[name] = len(view.pop(name))
    if counts:
        view['inventory_counts'] = counts
    receipt = Path(folder) / 'result.json'
    if receipt.is_file():
        view['receipt'] = dict(path=str(receipt), sha256=pcb_workflow.sha(receipt))
    return view


def read_json(path):
    return json.loads(Path(path).read_text())


def run_dir(base, run_id):
    if not RUN_ID.fullmatch(run_id):
        raise ValueError('invalid run ID; use the ID returned by check')
    path = base / run_id
    if not (path / 'run.json').is_file():
        raise ValueError('unknown run: ' + run_id)
    return path


def request_cancel(folder):
    """Shared CLI/viewer control; cancellation is owned by the supervisor."""
    state = status(folder)
    if state['status'] not in TERMINAL:
        lean.atomic_json(Path(folder) / 'cancel.request', dict(requested_at=utc()))
        state = dict(state, cancellation_requested=True)
    return state


def continue_engine(folder):
    """Idempotently continue a sealed engine candidate through normal admission."""
    folder = Path(folder).resolve()
    original = read_json(folder / 'run.json')
    if Path(original['root']).resolve() != ROOT or original.get('router') != 'engine':
        raise ValueError('continuation requires an engine run from this checkout')
    from pcb_evidence import verify
    verify(folder)
    requests = folder.parent / '.continuations'
    requests.mkdir(exist_ok=True)
    with (requests / (folder.name + '.lock')).open('a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        receipt = requests / (folder.name + '.json')
        if receipt.exists():
            previous = read_json(receipt)
            if previous.get('run_id'):
                child = run_dir(folder.parent, previous['run_id'])
                manifest = read_json(child / 'run.json')
                if manifest.get('from_run', {}).get('folder') != str(folder):
                    raise ValueError('continuation receipt does not match its parent')
                return status(child)
            token = previous['token']
        else:
            token = hashlib.sha256((str(folder) + pcb_workflow.sha(folder / 'result.json')).encode()).hexdigest()
            lean.atomic_json(receipt, dict(token=token, status='submitted'))
        # A supervisor may have started before the UI process crashed. Recover
        # its durable identity rather than launching the same continuation twice.
        for path in sorted(folder.parent.glob('run-*/run.json')):
            manifest = read_json(path)
            if manifest.get('continuation_key') == token:
                if manifest.get('from_run', {}).get('folder') != str(folder):
                    raise ValueError('continuation key belongs to another parent')
                lean.atomic_json(receipt, dict(token=token, run_id=path.parent.name))
                return status(path.parent)
        spec = requests / (folder.name + '-policy.json')
        lean.atomic_json(spec, original['spec'])
        args = argparse.Namespace(command='route', board=original['board'],
            router='engine', spec=spec, from_run=folder.name,
            timeout=original['timeout_s'], heartbeat=original['heartbeat_s'],
            engineering_manifest=None, design_contract=None, cycle=None, baseline=None,
            continuation_key=token)
        child = start_run(args, folder.parent)
        lean.atomic_json(receipt, dict(token=token, run_id=child.name))
        return status(child)


def controller_alive(folder):
    try:
        with (folder / 'worker.lock').open('rb') as lock:
            try:
                fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
                return False
            except BlockingIOError:
                return True
    except FileNotFoundError:
        return None


def status(folder):
    state = read_json(folder / 'state.json')
    alive = controller_alive(folder)
    if alive is False:
        # The supervisor may have published its terminal state and released the
        # lock between our first read and the liveness probe.
        state = read_json(folder / 'state.json')
    state['controller_alive'] = alive
    state['evidence_dir'] = str(folder)
    state['heartbeat_age_s'] = max(0, round(time.time() - state['updated_unix'], 3))
    if state['status'] == 'starting' and alive in (None, False):
        # Creating the lock and acquiring it are separate system calls. Allow
        # the existing startup budget for both absent and newly created locks.
        if time.time() - state['updated_unix'] > 10:
            state.update(status='error', exit_code=2, cause='supervisor did not start; inspect worker.log', cleanup=None)
    elif state['status'] not in TERMINAL and alive is False:
        state.update(status='error', exit_code=2, cause='supervisor stopped without a terminal result; cleanup unconfirmed', cleanup=None)
    if state['status'] not in TERMINAL:
        state['elapsed_s'] = round(state.get('elapsed_s', 0) + state['heartbeat_age_s'], 3)
        state['elapsed_clock'] = 'supervisor_monotonic_plus_wall_since_update'
        state['active_stage_timing'] = live_stages(state.get('active_stage_timing', []))
        timing = state.get('timing')
        if timing:
            timing['active_stages'] = state['active_stage_timing']
    return state


class Journal:
    def __init__(self, folder):
        self.folder = folder
        self.started = time.monotonic()
        self.state = read_json(folder / 'state.json')
        self.seq = 0
        self.active = set()
        self.timeline = Timeline(read_json(folder / 'run.json').get('created_at'))

    def emit(self, kind, **data):
        elapsed = round(time.monotonic() - self.started, 3)
        self.seq += 1
        event = dict(schema_version=1, run_id=self.folder.name, seq=self.seq,
                     time=utc(), elapsed_s=elapsed, type=kind, **data)
        self.timeline.observe(event)
        with (self.folder / 'events.jsonl').open('a') as stream:
            stream.write(json.dumps(event, allow_nan=False) + '\n')
            stream.flush()
        self.active = {span['stage'] for span in self.timeline.active.values()}
        if kind == 'check.end':
            self.active.discard(data['stage'])
            self.state['last_progress_s'] = elapsed
        if kind in {'tool.start', 'tool.exit', 'tool.output', 'stage.start', 'stage.end', 'stage.activity', 'check.end'}:
            self.state['last_activity_s'] = elapsed
        terminal = self.state['status'] in TERMINAL
        timing = self.timeline.summary(terminal=terminal)
        self.state.update(seq=self.seq, elapsed_s=elapsed, updated_unix=time.time(),
                          active_stages=[] if terminal else sorted(self.active),
                          active_stage_timing=timing['active_stages'], timing=timing)
        lean.atomic_json(self.folder / 'state.json', self.state)
        return event


def incoming(folder, offset):
    """Read complete native events once; an unfinished final write stays unread."""
    rows = []
    if not isinstance(offset, dict):
        offset = {'gate/events.jsonl': offset}
    producer_paths = ['operation/events.jsonl', 'gate/events.jsonl']
    # Successful release atomically moves the work directory. Keep the same
    # cursor key so promotion cannot replay already observed gate events.
    release_sources = {}
    for suffix in ('gate/events.jsonl', 'stages.jsonl'):
        name = next((prefix + '/' + suffix for prefix in ('release-work', 'candidate')
                     if (folder / prefix / suffix).exists()), 'release-work/' + suffix)
        release_sources[name] = 'release/' + suffix
    for name in producer_paths + list(release_sources):
        cursor_key = release_sources.get(name, name)
        try:
            with (folder / name).open('rb') as stream:
                stream.seek(offset.get(cursor_key, 0))
                while True:
                    line = stream.readline()
                    if not line or not line.endswith(b'\n'):
                        break
                    event = json.loads(line)
                    if event.get('schema_version') != 1 or not isinstance(event.get('type'), str):
                        raise ValueError('invalid producer event')
                    rows.append(event)
                    offset[cursor_key] = stream.tell()
        except FileNotFoundError:
            pass
    rows.sort(key=lambda row: row.get('time', ''))
    return rows, offset


def gate_directory(folder):
    return next((folder / name for name in ('gate', 'candidate/gate', 'release-work/gate')
                 if (folder / name).is_dir()), folder / 'gate')


def gate_outcome(folder, code, gate_ended, findings):
    report = read_json(folder / 'gate/result.json')
    metrics = report['metrics']
    provenance = report['provenance']
    if not isinstance(metrics, dict) or not metrics or not re.fullmatch(r'[0-9a-f]{64}', provenance['input_sha256']):
        raise ValueError('invalid gate result/provenance')
    if code not in (0, 1) or report['exit'] != code or not gate_ended:
        raise ValueError('gate exit and terminal evidence disagree')
    missing = [name for name, value in metrics.items() if value is None]
    missing_versions = [name for name, value in provenance['tools'].items() if value is None]
    checks = report.get('checks', {})
    known_failure = any(c.get('status') == 'failed' and c.get('metrics') and all(v is not None for v in c['metrics'].values())
                        for c in checks.values())
    deliberately_blocked = bool(missing and known_failure and not report.get('preflightErrors') and
        all(any(c.get('status') == 'blocked' and key in c.get('metrics', {}) for c in checks.values()) for key in missing))
    if report['changedDuringRun'] or (missing and not deliberately_blocked) or missing_versions:
        cause = ('gate inputs changed during run; evidence is invalid' if report['changedDuringRun'] else
                 'required checker did not complete: ' + ', '.join(missing) if missing else
                 'required tool version unavailable: ' + ', '.join(missing_versions))
        return dict(status='error', exit_code=2, cause=cause, metrics=metrics,
                    input_sha256=provenance['input_sha256'], findings=findings)
    return dict(status='passed' if code == 0 else 'failed', exit_code=code,
                cause='all configured gate targets met' if code == 0 else
                      'native findings block dependent checks' if deliberately_blocked else 'configured gate targets not met',
                metrics=metrics, input_sha256=provenance['input_sha256'], findings=findings)


def worker(folder):
    manifest = read_json(folder / 'run.json')
    # The lock file also records admission permanently. Replaying _worker must
    # never rerun a completed gate or append a second sequence to its journal.
    try:
        lock = (folder / 'worker.lock').open('xb')
    except FileExistsError:
        raise ValueError('run supervisor was already admitted; start a new check') from None
    with lock:
        # Exclusive creation already admitted this sole supervisor. A liveness
        # probe may briefly hold the new file before we acquire it; wait for
        # that observer rather than abandoning the run before its first event.
        fcntl.flock(lock, fcntl.LOCK_EX)
        journal = Journal(folder)
        interrupted = []
        prior = {}
        for sig in (signal.SIGINT, signal.SIGTERM):
            prior[sig] = signal.signal(sig, lambda signum, frame: interrupted.append(signum))
        journal.state.update(status='running', worker_pid=os.getpid())
        journal.emit('run.start', board=manifest['board'], command=manifest['command'])
        proc, cleanup, result = None, None, None
        offset, gate_ended, findings = 0, False, []
        heartbeat = time.monotonic()
        deadline = lean.deadline_after(manifest['timeout_s'], {})

        def drain():
            nonlocal offset, gate_ended
            rows, offset = incoming(folder, offset)
            for row in rows:
                kind = row.pop('type')
                row.pop('schema_version', None)
                row['source_time'] = row.pop('time', None)
                if kind == 'gate.end':
                    gate_ended = True
                if kind == 'check.end':
                    findings.extend(dict(stage=row['stage'], cause=text, log=str(folder / 'gate' / (row['stage'] + '.log')))
                                    for text in row.get('findings', []))
                journal.emit(kind, **row)

        try:
            if (folder / 'cancel.request').exists():
                result = dict(status='cancelled', exit_code=130, cause='cancelled before gate admission')
                cleanup = dict(complete=True, errors=[])
            else:
                env = dict(os.environ, IOT_LEAN_DEADLINE=lean.encode_deadline(deadline))
                with (folder / 'gate.log').open('wb') as log:
                    with measured_stage(journal.emit, 'process-startup', 'startup', 'supervisor'):
                        proc = lean_owned.prepare(manifest['command'], dict(cwd=ROOT, env=env,
                                                  stdin=subprocess.DEVNULL, stdout=log, stderr=subprocess.STDOUT))
                        proc.start()
                        proc.activate()
                    while True:
                        drain()
                        if interrupted or (folder / 'cancel.request').exists() or lean.remaining(deadline) <= 0:
                            cancelled = bool(interrupted or (folder / 'cancel.request').exists())
                            result = dict(status='cancelled' if cancelled else 'timeout', exit_code=130 if cancelled else 124,
                                          cause='cancellation requested' if cancelled else 'run deadline reached')
                            journal.state['status'] = 'stopping'
                            journal.emit('run.stopping', cause=result['cause'])
                            cleanup = proc.cleanup()
                            proc.communicate(timeout=8)
                            drain()
                            break
                        try:
                            proc.communicate(timeout=0.1)
                            cleanup = proc.last_cleanup
                            drain()
                            if manifest.get('operation', 'check') == 'check':
                                result = gate_outcome(folder, proc.returncode, gate_ended, findings)
                            else:
                                result = read_json(folder / 'operation/result.json')
                                if result.get('exit_code') != proc.returncode or result.get('status') not in TERMINAL:
                                    raise ValueError('operation exit and terminal evidence disagree')
                            break
                        except subprocess.TimeoutExpired:
                            pass
                        if time.monotonic() - heartbeat >= manifest['heartbeat_s']:
                            journal.emit('run.heartbeat', active_stages=sorted(journal.active), progress='unknown',
                                         active_stage_timing=journal.timeline.summary()['active_stages'],
                                         last_activity_s=journal.state.get('last_activity_s'),
                                         last_progress_s=journal.state.get('last_progress_s'))
                            heartbeat = time.monotonic()
        except BaseException as error:
            result = dict(status='error', exit_code=2, cause=type(error).__name__ + ': ' + str(error), findings=findings)
        finally:
            cleanup_span = MeasuredSpan('cleanup', 'cleanup')
            journal.emit('stage.start', **cleanup_span.fields)
            if proc:
                try:
                    if cleanup is None:
                        cleanup = proc.cleanup()
                    if not proc.close():
                        cleanup = dict(complete=False, errors=['owned broker did not settle'])
                except Exception as error:
                    cleanup = dict(complete=False, errors=[str(error)])
            journal.emit('stage.end', **cleanup_span.end('passed' if cleanup and cleanup.get('complete') else 'error'))
            if not cleanup or not cleanup.get('complete'):
                result.update(status='error', exit_code=2,
                              cause=result['cause'] + '; owned process cleanup unconfirmed')
            result.setdefault('scope', {'check':'configured_board_gate', 'build':'candidate_board_gate',
                'edit':'candidate_board_gate', 'route':'candidate_board_gate', 'release':'fabrication_candidate',
                'repair':'candidate_board_gate', 'parts':'part_evidence', 'placement':'placement_constraints',
                'routing':'routing_decision', 'design':'design_assessment', 'schematic':'schematic_function',
                'outcomes':'placement_outcomes', 'ml':'ml_observation', 'doctor':'environment', 'blocks':'block_evidence',
                'readiness':'assembly_readiness'}[manifest.get('operation','check')])
            result.update(schema_version=1, run_id=folder.name, board=manifest['board'], cleanup=cleanup,
                          operation=manifest.get('operation', 'check'), child_cpu_s=proc.child_cpu_s if proc else None,
                          cpu_scope=proc.cpu_scope if proc else None, gate_result=str(gate_directory(folder) / 'result.json'),
                          evidence_dir=str(folder))
            from pcb_evidence import evidence_files
            try:
                with measured_stage(journal.emit, 'evidence-sealing', 'sealing', 'supervisor'):
                    result['evidence_sha256'] = evidence_files(folder)
            except (OSError, ValueError) as error:
                result.update(status='error', exit_code=2, cause='cannot bind run evidence: ' + str(error))
            result.update(elapsed_s=round(time.monotonic() - journal.started, 3),
                          timing=journal.timeline.summary(terminal=True), ended_unix_s=time.time())
            lean.atomic_json(folder / 'result.json', result)
            journal.state.update(result)
            journal.active.clear()
            journal.emit('run.end', **{k: v for k, v in compact_terminal(result, folder).items()
                                       if k not in {'schema_version', 'run_id', 'elapsed_s'}})
            for sig, handler in prior.items():
                signal.signal(sig, handler)
        return result['exit_code']


def start_run(args, base):
    submitted_at = utc()
    operation = args.command
    from_run = None
    if getattr(args, 'from_run', None):
        parent = run_dir(base, args.from_run)
        from pcb_evidence import verify
        verify(parent)
        previous = read_json(parent / 'run.json')
        from_run = dict(folder=str(parent), result_sha256=pcb_workflow.sha(parent / 'result.json'))
        if operation in ('build', 'edit', 'route', 'repair') and not getattr(args, 'engineering_manifest', None):
            if previous.get('engineering_manifest'):
                args.engineering_manifest = Path(previous['engineering_manifest']['path'])
        if operation in ('build', 'edit', 'route', 'repair') and not getattr(args, 'design_contract', None):
            if previous.get('design_contract'):
                args.design_contract = Path(previous['design_contract']['path'])
    if operation in ('build', 'edit', 'route', 'repair', 'release') and not getattr(args, 'design_contract', None):
        default_contract = ROOT / 'hardware-design/registry/design-contracts' / (args.board + '.json')
        if default_contract.is_file():
            args.design_contract = default_contract
    if operation in ('build', 'edit', 'route', 'repair') and not getattr(args, 'engineering_manifest', None):
        default_review = ROOT / 'hardware-design/registry/part-reviews' / (args.board + '.json')
        if default_review.is_file():
            args.engineering_manifest = default_review
    spec = None
    router = getattr(args, 'router', 'explicit')
    if operation == 'route' and not getattr(args, 'spec', None) and router != 'iotroute':
        if router != 'route-json':
            raise ValueError('route --router ' + router + ' requires --spec')
        args.spec = pcb_workflow.board_config(ROOT, args.board)[0] / 'route.json'
    if getattr(args, 'spec', None):
        spec = read_json(args.spec)
        if not isinstance(spec, dict):
            raise ValueError('candidate spec must be a JSON object')
        if operation == 'route' and getattr(args, 'router', None) == 'engine':
            from pcb_engine.policy import validate_policy
            spec = validate_policy(spec, args.timeout)
        if operation == 'route' and router == 'route-json':
            from route_plan import SCHEMA
            if spec.get('schema') != SCHEMA:
                raise ValueError('route --router route-json requires a ' + SCHEMA + ' spec')
        if operation == 'route' and router == 'iotroute':
            from router.run import policy
            policy(spec)
    cycle_folder = None
    if getattr(args, 'cycle', None):
        import pcb_cycle
        cycle_folder = pcb_cycle.folder_for(base, args.cycle)
        cycle = pcb_cycle.read(cycle_folder / 'cycle.json')
        if cycle['status'] != 'open' or Path(cycle['root']).resolve() != ROOT:
            raise ValueError('cycle must be open and belong to this checkout')
    design = None
    if operation in OBSERVATIONS:
        if len(args.arguments) < 2:
            raise ValueError(operation + ' requires an action and board/PDF; put supervisor options first')
        action, subject = args.arguments[:2]
        if operation == 'ml':
            if action not in ('dataset', 'features', 'train', 'evaluate', 'predict',
                              'engine-dataset', 'engine-train', 'engine-evaluate', 'engine-export', 'engine-public-corpus'):
                raise ValueError('unknown ML action; use dataset/features/train/evaluate/predict or engine-dataset/train/evaluate/export')
            for reserved in ('--root', '--output'):
                if any(value == reserved or value.startswith(reserved + '=') for value in args.arguments):
                    raise ValueError('ml ' + reserved + ' is owned by the run supervisor')
        if operation == 'parts' and action == 'inspect':
            args.board = cycle['board'] if cycle_folder else 'PARTS'
        else:
            args.board = subject
        if operation == 'design':
            contract_path = backend_option(args.arguments, '--contract')
            if not contract_path:
                raise ValueError('design check requires --contract FILE')
            args.design_contract = Path(contract_path).resolve()
            design = read_json(args.design_contract)
            if not isinstance(design, dict) or not isinstance(design.get('identity'), dict):
                raise ValueError('design contract requires an identity object')
            if design['identity'].get('design_id') != subject:
                raise ValueError('design action subject differs from its exact contract identity')
            args.board = design['identity'].get('board') or subject
        elif operation in ('outcomes', 'ml') and cycle_folder:
            args.board = cycle['board']
    baseline = None
    if getattr(args, 'baseline', None):
        baseline = run_dir(base, args.baseline) / 'gate/findings.json'
        if not baseline.is_file():
            raise ValueError('baseline has no structured findings')
    if operation in ('design', 'outcomes', 'ml') or (operation=='parts' and action=='selection'):
        cfg, config = {'project': None}, None
    elif operation in ('doctor', 'blocks', 'readiness') or (operation == 'parts' and args.board == 'PARTS'):
        args.board = {'doctor': 'ENVIRONMENT', 'blocks': 'BLOCKS', 'readiness': 'ASSEMBLY', 'parts':'PARTS'}[operation]
        if cycle_folder and operation in ('doctor', 'blocks', 'readiness'):
            args.board = args.arguments[0] if operation == 'readiness' else cycle['board']
        cfg, config = {'project': None}, None
    else:
        _, cfg, _ = pcb_workflow.board_config(ROOT, args.board)
        config = ROOT / 'hardware-design/boards' / args.board / 'gate.json'
    if cycle_folder and args.board != cycle['board']:
        raise ValueError('run belongs to another board than its engineering cycle')
    node = shutil.which(os.environ.get('NODE', 'node'))
    if not node and operation not in ('design', 'outcomes', 'ml') and not (operation=='parts' and action=='selection'):
        raise ValueError('Node.js is required to run the existing gate')
    base.mkdir(parents=True, exist_ok=True)
    folder = Path(tempfile.mkdtemp(prefix='run-', dir=base))
    command = [node, str(ROOT / 'tools/gate.mjs'), args.board, '--evidence-dir', str(folder / 'gate')]
    if operation == 'check':
        if getattr(args, 'changed', False):
            command.append('--changed')
        if getattr(args, 'fresh', False):
            command.append('--fresh')
        if baseline:
            command.extend(['--findings-baseline', str(baseline)])
    else:
        operation_python = sys.executable
        if operation == 'route' and getattr(args, 'router', None) == 'engine' and spec.get('ranking'):
            operation_python = os.environ.get('PCB_ENGINE_ML_PYTHON', operation_python)
        command = [operation_python, str(ROOT / 'tools/pcb_operations.py'), str(folder)]
    manifest = dict(schema_version=1, run_id=folder.name, board=args.board, project=cfg['project'],
                    created_at=submitted_at, root=str(ROOT), command=command, timeout_s=args.timeout,
                    heartbeat_s=args.heartbeat, operation=operation, node=node,
                    gate_config_sha256=hashlib.sha256(config.read_bytes()).hexdigest() if config else None)
    if spec is not None:
        manifest['spec'] = spec
        manifest['spec_sha256'] = hashlib.sha256(Path(args.spec).read_bytes()).hexdigest()
    if operation == 'route':
        manifest['router'] = getattr(args, 'router', 'explicit')
    if getattr(args, 'continuation_key', None):
        if not re.fullmatch(r'[0-9a-f]{64}', args.continuation_key):
            raise ValueError('invalid continuation identity')
        manifest['continuation_key'] = args.continuation_key
    if getattr(args, 'kind', None):
        manifest['kind'] = args.kind
    for key in ('plan', 'engineering_manifest', 'design_contract'):
        if getattr(args, key, None):
            path = getattr(args, key).resolve()
            value = read_json(path)
            if not isinstance(value, dict):
                raise ValueError(key + ' requires a JSON object')
            manifest[key] = dict(path=str(path), sha256=pcb_workflow.sha(path), content=value)
    if operation in ('blocks', 'readiness') + OBSERVATIONS:
        manifest['arguments'] = args.arguments
    if design:
        manifest['design_id'] = design['identity']['design_id']
        manifest['design_stage'] = backend_option(args.arguments, '--through') or design.get('current_stage', 'requirements')
    if cycle_folder:
        manifest['cycle'] = cycle_folder.name
    if from_run:
        manifest['from_run'] = from_run
    lean.atomic_json(folder / 'run.json', manifest)
    if cycle_folder:
        import pcb_cycle
        pcb_cycle.attach(cycle_folder, folder,
            'datasheets' if operation == 'parts' and args.arguments[0] == 'inspect' else
            'verification' if operation == 'ml' else
            'routing' if operation == 'edit' and getattr(args, 'kind', None) == 'route' else None)
    lean.atomic_json(folder / 'state.json', dict(schema_version=1, run_id=folder.name, board=args.board,
                     status='starting', seq=0, updated_unix=time.time(), elapsed_s=0, active_stages=[]))
    # A detached run owns a fresh broker and deadline; no inherited broker capability.
    env = dict(os.environ)
    for key in (lean_owned.SOCKET_ENV, lean_owned.HANDLE_ENV, lean_owned.DEPTH_ENV, 'IOT_LEAN_DEADLINE'):
        env.pop(key, None)
    try:
        with (folder / 'worker.log').open('wb') as log:
            subprocess.Popen([sys.executable, str(Path(__file__).resolve()), '_worker', folder.name,
                              '--runs-dir', str(base)], stdin=subprocess.DEVNULL, stdout=log, stderr=subprocess.STDOUT,
                             cwd=ROOT, env=env, start_new_session=True, close_fds=True)
    except OSError as error:
        state = read_json(folder / 'state.json')
        state.update(status='error', exit_code=2, cause='cannot start supervisor: ' + str(error))
        lean.atomic_json(folder / 'state.json', state)
        raise
    return folder


def events(folder, cursor=0, limit=100):
    """Byte cursors permit reconnecting without rescanning old events/logs."""
    rows = []
    try:
        with (folder / 'events.jsonl').open('rb') as stream:
            size = os.fstat(stream.fileno()).st_size
            if cursor < 0 or cursor > size:
                raise ValueError('event cursor is outside this run')
            if cursor:
                stream.seek(cursor - 1)
                if stream.read(1) != b'\n':
                    raise ValueError('event cursor must be a returned line boundary')
            stream.seek(cursor)
            for _ in range(limit):
                line = stream.readline()
                if not line or not line.endswith(b'\n'):
                    break
                row = json.loads(line)
                row['cursor'] = stream.tell()
                rows.append(row)
    except FileNotFoundError:
        if cursor:
            raise ValueError('event cursor is outside this run') from None
    return rows


def stage_status(rows):
    return ', '.join(row['stage'] + ' elapsed=' +
        (str(row['elapsed_s']) + 's' if row['elapsed_s'] is not None else 'unavailable') +
        ' last-activity=' + (str(row['last_activity_age_s']) + 's ago'
                            if row['last_activity_age_s'] is not None else 'unavailable') for row in rows)


def print_event(event, machine):
    if machine:
        print(json.dumps(event, allow_nan=False), flush=True)
        return
    kind = event['type']
    detail = ''
    if kind == 'tool.output':
        detail = event['text'].strip().replace('\n', ' | ')
    elif kind == 'check.end':
        detail = event['status'] + ' ' + json.dumps(event['metrics'])
    elif kind == 'run.heartbeat':
        stages = event.get('active_stage_timing', [])
        detail = 'alive; progress unknown; active=' + stage_status(stages)
        if not stages:
            detail += ','.join(event['active_stages'])
    elif kind in {'run.end', 'run.stopping'}:
        detail = event.get('status', '') + ': ' + event['cause']
    elif kind == 'tool.exit':
        detail = 'exit=' + str(event['code'])
    print(f"{event['run_id']} {event['elapsed_s']:7.1f}s {kind} {event.get('stage', '')} {detail}".rstrip(), flush=True)


def follow(folder, machine):
    cursor = 0
    while True:
        rows = events(folder, cursor)
        for row in rows:
            print_event(row, machine)
            cursor = row['cursor']
            if row['type'] == 'run.end':
                return row['exit_code']
        if len(rows) == 100:
            continue
        state = status(folder)
        if state['status'] in TERMINAL and state['controller_alive'] is not True:
            # Drain once more after the lock was released (terminal append race).
            rows = events(folder, cursor)
            if rows:
                for row in rows:
                    print_event(row, machine)
                    cursor = row['cursor']
                    if row['type'] == 'run.end':
                        return row['exit_code']
                continue
            print(json.dumps(compact_terminal(state, folder)) if machine else f"STUCK: {state.get('cause', 'supervisor ended without events')}", flush=True)
            return state.get('exit_code', 2)
        time.sleep(0.1)


def explain(folder, limit):
    state = status(folder)
    gate = gate_directory(folder)
    details = []
    total = 0
    for name in ('erc', 'drc'):
        path = gate / (name + '.json')
        if not path.exists():
            continue
        try:
            report = read_json(path)
            groups = ([('erc', s.get('violations', [])) for s in report.get('sheets', [])] if name == 'erc' else
                      [(key, report.get(key, [])) for key in ('violations', 'schematic_parity', 'unconnected_items')])
            for category, findings in groups:
                for finding in findings:
                    total += 1
                    if len(details) < limit:
                        details.append(dict(stage=name, category=category, report=str(path), finding=finding))
        except (ValueError, TypeError, AttributeError):
            details.append(dict(stage=name, report=str(path), cause='malformed report; inspect original evidence'))
    structured = gate / 'findings.json'
    normalized = read_json(structured) if structured.exists() else None
    return dict(run=state, details=details, findings=normalized, omitted=max(0, total - len(details)),
                logs=[str(p) for directory in (gate, folder / 'operation') for p in sorted(directory.glob('*.log'))]
                     + [str(folder / 'gate.log'), str(folder / 'worker.log')])


def positive(value):
    value = float(value)
    if not math.isfinite(value) or value <= 0:
        raise argparse.ArgumentTypeError('must be a finite positive number')
    return value


def wait_seconds(value):
    value = float(value)
    if not math.isfinite(value) or not 0 <= value <= 60:
        raise argparse.ArgumentTypeError('must be between 0 and 60 seconds')
    return value


def main(argv=None):
    parser = argparse.ArgumentParser(description='Observable native board gates; see tools/PCB-CLI.md')
    sub = parser.add_subparsers(dest='command', required=True)
    operations = ('check', 'build', 'edit', 'route', 'repair', 'release', 'doctor', 'blocks', 'readiness',
                  'parts', 'placement', 'routing', 'design', 'schematic', 'outcomes', 'ml')
    for name in operations + ('list', 'context', 'next', 'status', 'events', 'explain', 'cancel', 'adopt', 'benchmark', 'cycle', 'note', 'view', '_worker'):
        child = sub.add_parser(name)
        child.add_argument('--runs-dir', type=Path, default=Path(os.environ.get('PCB_RUNS_DIR', ROOT / '.gate/cli')))
        child.add_argument('--json', action='store_true', help='JSON; following/events emit JSON Lines')
        if name in operations:
            if name in ('blocks', 'readiness') + OBSERVATIONS:
                child.add_argument('arguments', nargs=argparse.REMAINDER)
            elif name != 'doctor':
                child.add_argument('board')
            mode = child.add_mutually_exclusive_group()
            mode.add_argument('--detach', action='store_true', help='return the durable run ID immediately')
            mode.add_argument('--follow', action='store_true', help='stream events until finished (default)')
            child.add_argument('--timeout', type=positive, default=600, help='total run deadline in seconds (default 600)')
            child.add_argument('--heartbeat', type=positive, default=5, help='liveness interval in seconds (default 5)')
            child.add_argument('--cycle', help='link this run to one engineering cycle')
            if name in ('build', 'edit', 'route', 'repair', 'parts', 'placement', 'routing'):
                child.add_argument('--from-run', help='continue/inspect a sealed isolated candidate')
            if name == 'check':
                freshness = child.add_mutually_exclusive_group()
                freshness.add_argument('--changed', action='store_true', help='reuse matching completed per-check receipts')
                freshness.add_argument('--fresh', action='store_true', help='require fresh native checks (default)')
                child.add_argument('--baseline', help='prior run ID for a findings delta')
            if name in ('edit', 'route'):
                child.add_argument('--spec', type=Path, required=name == 'edit',
                                   help='route: required, except --router route-json (default: the board route.json) '
                                        'and --router iotroute (default policy: tools/router/run.py)')
                if name == 'edit':
                    child.add_argument('--kind', choices=['place', 'route'], required=True)
                else:
                    child.add_argument('--router', choices=['explicit', 'fastroute', 'engine', 'route-json', 'iotroute'],
                                       default='explicit',
                                       help='explicit tracks, controlled Fastroute, integrated engine search, '
                                            'tools/route.py driven by route.json, or the in-house router '
                                            '(tools/router/run.py)')
            if name == 'repair':
                child.add_argument('--plan', type=Path, required=True)
            if name in ('build', 'edit', 'route', 'repair'):
                child.add_argument('--engineering-manifest', type=Path,
                                   help='reviewed part uses and sourced placement constraints')
            if name in ('build', 'edit', 'route', 'repair', 'release'):
                child.add_argument('--design-contract', type=Path, help='sourced idea-to-production contract')
        elif name == 'list':
            pass
        elif name in ('context', 'next'):
            child.add_argument('board')
            if name == 'next':
                child.add_argument('--design-contract', type=Path, help='observe a design before native CAD exists')
                child.add_argument('--through', help='lifecycle stage to assess')
        elif name == 'benchmark':
            child.add_argument('run_ids', nargs='+')
        elif name == 'view':
            child.add_argument('run_id')
            child.add_argument('--port', type=int, default=0, help='localhost port; 0 selects a free port')
        elif name == 'cycle':
            child.add_argument('action', choices=['start', 'status', 'begin', 'end', 'finish', 'attach'])
            child.add_argument('subject', help='board for start; cycle ID otherwise')
            child.add_argument('--owner')
            import pcb_cycle
            child.add_argument('--stage', choices=pcb_cycle.STAGES)
            child.add_argument('--contract', type=Path, help='design contract for a cycle before native CAD exists')
            child.add_argument('--description')
            child.add_argument('--activity')
            child.add_argument('--outcome', choices=['passed', 'blocked', 'rework'])
            child.add_argument('--evidence', action='append', type=Path)
            child.add_argument('--decision')
            child.add_argument('--run')
        else:
            child.add_argument('run_id')
        if name == 'adopt':
            child.add_argument('--baseline')
            child.add_argument('--defect')
        if name == 'note':
            child.add_argument('message')
            child.add_argument('--kind', choices=['intervention', 'decision', 'rework'], required=True)
        if name == 'events':
            child.add_argument('--after', type=int, default=0, help='byte cursor returned by an earlier event')
            child.add_argument('--wait', type=wait_seconds, default=0, help='bounded wait for new events, at most 60 seconds')
        if name in ('events', 'explain'):
            child.add_argument('--limit', type=int, default=100 if name == 'events' else 20)
    args = parser.parse_args(argv)
    try:
        base = args.runs_dir.resolve()
        if args.command == 'cycle':
            import pcb_cycle
            if args.action == 'start':
                if not args.owner:
                    raise ValueError('cycle start requires --owner for integration ownership')
                data = pcb_cycle.create(ROOT, base, args.subject, args.owner, contract=args.contract)
            else:
                cycle_folder = pcb_cycle.folder_for(base, args.subject)
                if Path(pcb_cycle.read(cycle_folder / 'cycle.json')['root']).resolve() != ROOT:
                    raise ValueError('cycle belongs to another checkout')
                if args.action == 'begin':
                    data = pcb_cycle.begin(cycle_folder, args.stage, args.owner or '', args.description or '')
                elif args.action == 'end':
                    data = pcb_cycle.end(cycle_folder, args.activity, args.outcome, args.evidence, args.decision or '')
                elif args.action == 'finish':
                    data = pcb_cycle.finish(cycle_folder)
                elif args.action == 'attach':
                    if not args.run:
                        raise ValueError('cycle attach requires --run RUN_ID')
                    pcb_cycle.attach(cycle_folder, run_dir(base, args.run), args.stage)
                    data = pcb_cycle.summarize(cycle_folder)
                else:
                    data = pcb_cycle.summarize(cycle_folder)
            print(json.dumps(data) if args.json else json.dumps(data, indent=2))
            return 0
        if args.command == 'list':
            data = pcb_workflow.catalog(ROOT)
            print(json.dumps(data) if args.json else '\n'.join(row['board'] for row in data['boards']))
            return 0
        if args.command == 'next':
            from pcb_next import next_action
            data = next_action(ROOT, args.board, base, design_contract=args.design_contract, through=args.through)
            print(json.dumps(data) if args.json else
                  data['blocker']['message'] + '\nNext: ' + data['next_action']['command'])
            return 0
        if args.command == 'context' or (args.command == 'status' and not RUN_ID.fullmatch(args.run_id)):
            data = pcb_workflow.context(ROOT, args.board if args.command == 'context' else args.run_id)
            print(json.dumps(data) if args.json else json.dumps(data, indent=2))
            return 0
        if args.command == 'blocks':
            if not args.arguments or args.arguments[0] not in ('inventory', 'native', 'qualify', 'status', 'find', 'reuse', 'plan'):
                raise ValueError('choose blocks inventory/native/qualify/status/find/reuse/plan')
        if args.command == 'readiness':
            if len(args.arguments) < 2:
                raise ValueError('readiness requires BOARD CANDIDATE; put CLI --json/--detach before BOARD')
        if args.command in OBSERVATIONS:
            allowed = {'parts': ('status', 'inspect', 'selection', 'verify', 'stock'), 'placement': ('check',),
                       'routing': ('diagnose', 'compute-status', 'compute-calibrate'), 'design': ('check',), 'schematic': ('check',),
                       'outcomes': ('evaluate',), 'ml': ('dataset', 'features', 'train', 'evaluate', 'predict',
                           'engine-dataset', 'engine-train', 'engine-evaluate', 'engine-export', 'engine-public-corpus')}[args.command]
            if not args.arguments or args.arguments[0] not in allowed:
                raise ValueError('choose ' + args.command + ' ' + '/'.join(allowed))
        if args.command == 'benchmark':
            from pcb_benchmark import summarize
            data = summarize([run_dir(base, item) for item in args.run_ids])
            print(json.dumps(data) if args.json else json.dumps(data, indent=2))
            return 0
        if args.command in operations:
            folder = start_run(args, base)
            if args.detach:
                state = status(folder)
                print(json.dumps(state) if args.json else f"START: {folder.name}; tools/pcb events {folder.name} --wait 20")
                return 0
            try:
                return follow(folder, args.json)
            except KeyboardInterrupt:
                lean.atomic_json(folder / 'cancel.request', dict(requested_at=utc()))
                return follow(folder, args.json)
        folder = run_dir(base, args.run_id)
        if args.command == 'view':
            from pcb_engine.viewer import serve
            serve(folder, port=args.port)
            return 0
        if args.command == 'adopt':
            from pcb_operations import adopt
            data = adopt(ROOT, folder, args.defect, run_dir(base, args.baseline) if args.baseline else None)
            print(json.dumps(data) if args.json else 'PASS: adopted verified candidate; backup=' + str(folder / 'backup'))
            return 0
        if args.command == 'note':
            with (folder / 'notes.jsonl').open('a') as stream:
                fcntl.flock(stream, fcntl.LOCK_EX)
                stream.write(json.dumps(dict(time=utc(), kind=args.kind, message=args.message)) + '\n')
            print(json.dumps(dict(recorded=True)) if args.json else 'PASS: run note recorded')
            return 0
        if args.command == '_worker':
            return worker(folder)
        if args.command == 'status':
            state = status(folder)
            if state['status'] in TERMINAL:
                state = compact_terminal(state, folder)
            print(json.dumps(state) if args.json else f"{state['status'].upper()}: {folder.name} {state.get('cause', '')}; elapsed={state.get('elapsed_s', 'unavailable')}s; " +
                  ('active=' + stage_status(state['active_stage_timing']) + '; ' if state.get('active_stage_timing') else '') + f"evidence={folder}")
        elif args.command == 'cancel':
            state = request_cancel(folder)
            if state['status'] in TERMINAL:
                state = compact_terminal(state, folder)
            print(json.dumps(state) if args.json else f"{state['status'].upper()}: {folder.name}; cancellation_requested={state.get('cancellation_requested', False)}")
        elif args.command == 'explain':
            if not 1 <= args.limit <= 1000:
                raise ValueError('--limit must be between 1 and 1000')
            report = explain(folder, args.limit)
            if report['run']['status'] in TERMINAL:
                report['run'] = compact_terminal(report['run'], folder)
            if args.json:
                print(json.dumps(report))
            else:
                print(f"{report['run']['status'].upper()}: {report['run'].get('cause', 'run active')}")
                for finding in report['run'].get('findings', []):
                    print(f"  {finding['stage']}: {finding['cause']} ({finding['log']})")
                for detail in report['details']:
                    print('  ' + json.dumps(detail))
                print('Evidence: ' + str(folder))
        elif args.command == 'events':
            if not 1 <= args.limit <= 1000:
                raise ValueError('--limit must be between 1 and 1000')
            until = time.monotonic() + args.wait
            while True:
                rows = events(folder, args.after, args.limit)
                if rows or status(folder)['status'] in TERMINAL or time.monotonic() >= until:
                    break
                time.sleep(min(0.1, max(0, until - time.monotonic())))
            for row in rows:
                print_event(row, args.json)
        return 0
    except KeyboardInterrupt:
        return 130
    except (OSError, ValueError, KeyError) as error:
        if args.json:
            print(json.dumps(dict(status='error', exit_code=2, cause=str(error))))
        else:
            print('FAIL: ' + str(error), file=sys.stderr)
        return 2


if __name__ == '__main__':
    raise SystemExit(main())
