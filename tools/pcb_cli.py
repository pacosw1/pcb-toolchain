"""Observable board gates. One owned supervisor and durable journal per run.

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

ROOT = Path(__file__).resolve().parent.parent
TERMINAL = {'passed', 'failed', 'error', 'cancelled', 'timeout'}
RUN_ID = re.compile(r'run-[A-Za-z0-9_-]+\Z')


def utc():
    return dt.datetime.now(dt.timezone.utc).isoformat(timespec='milliseconds')


def read_json(path):
    return json.loads(Path(path).read_text())


def run_dir(base, run_id):
    if not RUN_ID.fullmatch(run_id):
        raise ValueError('invalid run ID; use the ID returned by check')
    path = base / run_id
    if not (path / 'run.json').is_file():
        raise ValueError('unknown run: ' + run_id)
    return path


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
    return state


class Journal:
    def __init__(self, folder):
        self.folder = folder
        self.started = time.monotonic()
        self.state = read_json(folder / 'state.json')
        self.seq = 0
        self.active = set()

    def emit(self, kind, **data):
        elapsed = round(time.monotonic() - self.started, 3)
        self.seq += 1
        event = dict(schema_version=1, run_id=self.folder.name, seq=self.seq,
                     time=utc(), elapsed_s=elapsed, type=kind, **data)
        with (self.folder / 'events.jsonl').open('a') as stream:
            stream.write(json.dumps(event, allow_nan=False) + '\n')
            stream.flush()
        if kind == 'tool.start':
            self.active.discard('preflight')
            self.active.add(data['stage'])
        if kind == 'gate.start':
            self.active.add('preflight')
        if kind == 'check.end':
            self.active.discard(data['stage'])
            self.state['last_progress_s'] = elapsed
        if kind in {'tool.start', 'tool.exit', 'tool.output', 'check.end'}:
            self.state['last_activity_s'] = elapsed
        self.state.update(seq=self.seq, elapsed_s=elapsed, updated_unix=time.time(),
                          active_stages=sorted(self.active))
        lean.atomic_json(self.folder / 'state.json', self.state)
        return event


def incoming(folder, offset):
    """Read complete native events once; an unfinished final write stays unread."""
    rows = []
    try:
        with (folder / 'gate/events.jsonl').open('rb') as stream:
            stream.seek(offset)
            while True:
                line = stream.readline()
                if not line or not line.endswith(b'\n'):
                    break
                event = json.loads(line)
                if event.get('schema_version') != 1 or not isinstance(event.get('type'), str):
                    raise ValueError('invalid gate event')
                rows.append(event)
                offset = stream.tell()
    except FileNotFoundError:
        pass
    return rows, offset


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
    if report['changedDuringRun'] or missing or missing_versions:
        cause = ('gate inputs changed during run; evidence is invalid' if report['changedDuringRun'] else
                 'required checker did not complete: ' + ', '.join(missing) if missing else
                 'required tool version unavailable: ' + ', '.join(missing_versions))
        return dict(status='error', exit_code=2, cause=cause, metrics=metrics,
                    input_sha256=provenance['input_sha256'], findings=findings)
    return dict(status='passed' if code == 0 else 'failed', exit_code=code,
                cause='all configured gate targets met' if code == 0 else 'configured gate targets not met',
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
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
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
                            result = gate_outcome(folder, proc.returncode, gate_ended, findings)
                            break
                        except subprocess.TimeoutExpired:
                            pass
                        if time.monotonic() - heartbeat >= manifest['heartbeat_s']:
                            journal.emit('run.heartbeat', active_stages=sorted(journal.active), progress='unknown',
                                         last_activity_s=journal.state.get('last_activity_s'),
                                         last_progress_s=journal.state.get('last_progress_s'))
                            heartbeat = time.monotonic()
        except BaseException as error:
            result = dict(status='error', exit_code=2, cause=type(error).__name__ + ': ' + str(error), findings=findings)
        finally:
            if proc:
                try:
                    if cleanup is None:
                        cleanup = proc.cleanup()
                    if not proc.close():
                        cleanup = dict(complete=False, errors=['owned broker did not settle'])
                except Exception as error:
                    cleanup = dict(complete=False, errors=[str(error)])
            if not cleanup or not cleanup.get('complete'):
                result.update(status='error', exit_code=2,
                              cause=result['cause'] + '; owned process cleanup unconfirmed')
            result.update(schema_version=1, run_id=folder.name, board=manifest['board'], cleanup=cleanup,
                          scope='configured_board_gate', gate_result=str(folder / 'gate/result.json'),
                          evidence_dir=str(folder), elapsed_s=round(time.monotonic() - journal.started, 3))
            lean.atomic_json(folder / 'result.json', result)
            journal.state.update(result)
            journal.active.clear()
            journal.emit('run.end', **{k: v for k, v in result.items() if k not in {'schema_version', 'run_id', 'elapsed_s'}})
            for sig, handler in prior.items():
                signal.signal(sig, handler)
        return result['exit_code']


def start_run(args, base):
    if not re.fullmatch(r'[A-Z0-9][A-Z0-9-]*', args.board):
        raise ValueError('board must be a configured board ID, such as ENV-SENSE')
    config = ROOT / 'hardware-design/boards' / args.board / 'gate.json'
    cfg = read_json(config)
    node = shutil.which(os.environ.get('NODE', 'node'))
    if not node:
        raise ValueError('Node.js is required to run the existing gate')
    base.mkdir(parents=True, exist_ok=True)
    folder = Path(tempfile.mkdtemp(prefix='run-', dir=base))
    command = [node, str(ROOT / 'tools/gate.mjs'), args.board, '--evidence-dir', str(folder / 'gate')]
    manifest = dict(schema_version=1, run_id=folder.name, board=args.board, project=cfg['project'],
                    created_at=utc(), root=str(ROOT), command=command, timeout_s=args.timeout,
                    heartbeat_s=args.heartbeat, gate_config_sha256=hashlib.sha256(config.read_bytes()).hexdigest())
    lean.atomic_json(folder / 'run.json', manifest)
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
        detail = 'alive; progress unknown; active=' + ','.join(event['active_stages'])
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
            print(json.dumps(state) if machine else f"STUCK: {state.get('cause', 'supervisor ended without events')}", flush=True)
            return state.get('exit_code', 2)
        time.sleep(0.1)


def explain(folder, limit):
    state = status(folder)
    details = []
    total = 0
    for name in ('erc', 'drc'):
        path = folder / 'gate' / (name + '.json')
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
    return dict(run=state, details=details, omitted=max(0, total - len(details)),
                logs=[str(p) for p in sorted((folder / 'gate').glob('*.log'))] + [str(folder / 'gate.log'), str(folder / 'worker.log')])


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
    for name in ('check', 'status', 'events', 'explain', 'cancel', '_worker'):
        child = sub.add_parser(name)
        child.add_argument('--runs-dir', type=Path, default=Path(os.environ.get('PCB_RUNS_DIR', ROOT / '.gate/cli')))
        child.add_argument('--json', action='store_true', help='JSON; following/events emit JSON Lines')
        if name == 'check':
            child.add_argument('board')
            mode = child.add_mutually_exclusive_group()
            mode.add_argument('--detach', action='store_true', help='return the durable run ID immediately')
            mode.add_argument('--follow', action='store_true', help='stream events until finished (default)')
            child.add_argument('--timeout', type=positive, default=600, help='total run deadline in seconds (default 600)')
            child.add_argument('--heartbeat', type=positive, default=5, help='liveness interval in seconds (default 5)')
        else:
            child.add_argument('run_id')
        if name == 'events':
            child.add_argument('--after', type=int, default=0, help='byte cursor returned by an earlier event')
            child.add_argument('--wait', type=wait_seconds, default=0, help='bounded wait for new events, at most 60 seconds')
        if name in ('events', 'explain'):
            child.add_argument('--limit', type=int, default=100 if name == 'events' else 20)
    args = parser.parse_args(argv)
    try:
        base = args.runs_dir.resolve()
        if args.command == 'check':
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
        if args.command == '_worker':
            return worker(folder)
        if args.command == 'status':
            state = status(folder)
            print(json.dumps(state) if args.json else f"{state['status'].upper()}: {folder.name} {state.get('cause', '')}; evidence={folder}")
        elif args.command == 'cancel':
            state = status(folder)
            if state['status'] not in TERMINAL:
                lean.atomic_json(folder / 'cancel.request', dict(requested_at=utc()))
                state = dict(state, cancellation_requested=True)
            print(json.dumps(state) if args.json else f"{state['status'].upper()}: {folder.name}; cancellation_requested={state.get('cancellation_requested', False)}")
        elif args.command == 'explain':
            if not 1 <= args.limit <= 1000:
                raise ValueError('--limit must be between 1 and 1000')
            report = explain(folder, args.limit)
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
