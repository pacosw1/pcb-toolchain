"""Small, local workflow controls: deadlines, attribution and bounded WIP.

No cached result is qualified here. Native board and release gates remain authoritative.
"""
import argparse
import contextlib
import fcntl
import hashlib
import json
import math
import os
from pathlib import Path
import resource
import signal
import subprocess
import sys
import tempfile
import time


def atomic_json(path, data):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile(mode='w', dir=path.parent, delete=False) as f:
        json.dump(data, f, indent=2, allow_nan=False)
        f.write('\n')
        tmp = f.name
    os.replace(tmp, path)


def digest(path):
    h = hashlib.sha256()
    with open(path, 'rb') as f:
        for chunk in iter(lambda: f.read(1024 * 1024), b''):
            h.update(chunk)
    return h.hexdigest()


def router_timeout(outdir, error=None):
    """Describe retained evidence without importing or qualifying a checkpoint."""
    outdir = Path(outdir)
    artifacts = {name: digest(outdir / name) for name in
                 ('board.dsn', 'board.ses', 'screen.ses', 'report.json',
                  'run.log', 'stages.jsonl', 'effective-configuration.json')
                 if (outdir / name).is_file()}
    atomic_json(outdir / 'outcome.json', dict(status='timeout', returncode=124,
                qualified=False, artifacts=artifacts,
                cause=type(error).__name__ if error else 'TimeoutExpired',
                cleanup=getattr(error, 'cleanup', None),
                note='deadline reached; checkpoints are incomplete evidence, not a verified candidate'))


DEADLINE_PROTOCOL = 'clock-monotonic-v1:'


def now():
    """Same-host kernel epoch, including macOS Python 3.9 subprocesses.

    Python 3.9 time.monotonic on macOS has a process-relative origin. Never
    serialize that origin or transfer this same-host protocol to another host.
    """
    return time.clock_gettime(time.CLOCK_MONOTONIC)


def decode_deadline(value):
    if not isinstance(value, str) or not value.startswith(DEADLINE_PROTOCOL):
        raise ValueError('unsupported inherited deadline protocol')
    value = float(value[len(DEADLINE_PROTOCOL):])
    if not math.isfinite(value):
        raise ValueError('deadline must be finite')
    return value


def encode_deadline(value):
    if not math.isfinite(value):
        raise ValueError('deadline must be finite')
    return DEADLINE_PROTOCOL + repr(value)


def inherited_deadline(env=None):
    value = (os.environ if env is None else env).get('IOT_LEAN_DEADLINE')
    return decode_deadline(value) if value is not None else None


def deadline_after(seconds, env=None):
    if not math.isfinite(seconds) or seconds < 0:
        raise ValueError('budget must be finite and nonnegative')
    value = now() + seconds
    inherited = inherited_deadline(env)
    return min(value, inherited) if inherited is not None else value


def remaining(deadline=None):
    deadline = inherited_deadline() if deadline is None else deadline
    if isinstance(deadline, str):
        deadline = decode_deadline(deadline)
    if deadline is not None and not math.isfinite(deadline):
        raise ValueError('deadline must be finite')
    return max(0., deadline - now()) if deadline is not None else None


class StageCancelled(KeyboardInterrupt):
    def __init__(self, signum=None):
        self.signum = signum
        super().__init__('stage cancelled by signal' if signum else 'stage cancelled')


def cleanup_group(proc):
    """Signal only our new-session child group; never mask the original cause.

    On a denied group signal, stop the directly owned child if permitted, but
    retain unconfirmed group cleanup as an error rather than claim no orphan.
    """
    errors = []
    for sig, grace in ((signal.SIGTERM, 5), (signal.SIGKILL, 2)):
        try:
            os.killpg(proc.pid, sig)
        except ProcessLookupError:
            pass
        except OSError as error:
            errors.append(dict(operation='killpg', signal=sig, error=str(error)))
            try:
                proc.send_signal(sig)
            except OSError as fallback:
                errors.append(dict(operation='owned-child-signal', signal=sig, error=str(fallback)))
        try:
            proc.communicate(timeout=grace)
            try:
                os.killpg(proc.pid, 0)
            except ProcessLookupError:
                return dict(complete=not errors, errors=errors, child_reaped=True)
            except OSError as error:
                errors.append(dict(operation='verify-group', signal=0, error=str(error)))
            # A reaped direct child does not prove its descendants have exited.
            # Continue to SIGKILL the same owned group; never report it green.
        except subprocess.TimeoutExpired:
            pass
    return dict(complete=False, errors=errors, child_reaped=proc.poll() is not None)


def run_stage(cmd, *, stage, event_file=None, deadline=None, **kwargs):
    """Bound the entire child process group; timeout output is never a pass.

    SIGTERM allows router checkpoints for five seconds, followed by at most two
    seconds for SIGKILL cleanup. Logs/checkpoints are retained, but no timeout
    result is accepted.
    """
    child_env = dict(kwargs.get('env', os.environ))
    child_deadline = inherited_deadline(child_env)
    parent_deadline = inherited_deadline()
    if parent_deadline is not None:
        child_deadline = min(parent_deadline, child_deadline) if child_deadline is not None else parent_deadline
    if deadline is not None:
        value = decode_deadline(deadline) if isinstance(deadline, str) else deadline
        child_deadline = min(value, child_deadline) if child_deadline is not None else value
    if child_deadline is not None:
        kwargs['env'] = dict(child_env, IOT_LEAN_DEADLINE=encode_deadline(child_deadline))
    left = remaining(child_deadline)
    started = now()
    before = resource.getrusage(resource.RUSAGE_CHILDREN)
    status, rc, proc = 'failed', None, None
    handlers = {}
    cleanup = None
    cause = None
    def interrupted(signum, frame):
        raise StageCancelled(signum)
    try:
        if left is not None and left <= 0:
            status = 'timeout'
            cause = dict(type='TimeoutExpired', signal=None)
            raise subprocess.TimeoutExpired(cmd, 0)
        proc = subprocess.Popen(cmd, start_new_session=True, **kwargs)
        # A surrounding pipeline watchdog must not leave a nested router group
        # orphaned when it terminates this Python process.
        for sig in (signal.SIGTERM, signal.SIGINT):
            handlers[sig] = signal.signal(sig, interrupted)
        try:
            stdout, stderr = proc.communicate(timeout=left)
        except (subprocess.TimeoutExpired, KeyboardInterrupt) as error:
            status = 'cancelled' if isinstance(error, KeyboardInterrupt) else 'timeout'
            cause = dict(type=type(error).__name__, signal=getattr(error, 'signum', None))
            # Repeated cancellation must not interrupt bounded cleanup.
            for sig in handlers:
                signal.signal(sig, signal.SIG_IGN)
            cleanup = cleanup_group(proc)
            error.cleanup = cleanup
            raise
        rc = proc.returncode
        status = 'complete' if rc == 0 else 'failed'
        return subprocess.CompletedProcess(cmd, rc, stdout, stderr)
    finally:
        for sig, handler in handlers.items():
            signal.signal(sig, handler)
        after = resource.getrusage(resource.RUSAGE_CHILDREN)
        if event_file:
            event = dict(stage=stage, command=list(map(str, cmd)), status=status, returncode=rc,
                         wall_s=now() - started, cause=cause, cleanup=cleanup,
                         child_cpu_s=(after.ru_utime + after.ru_stime - before.ru_utime - before.ru_stime))
            with open(event_file, 'a') as f:
                f.write(json.dumps(event) + '\n')


def optimizer_options(policy, threads=0):
    opts = ['--router.optimizer.enabled=' + ('true' if policy == 'always' else 'false')]
    if threads:
        opts += [f'--router.autorouter.max_threads={threads}', f'--router.optimizer.max_threads={threads}']
    return opts


def preflight_errors(drc):
    # Only independently checked existing copper faults stop routing. Opens,
    # placement warnings and router-internal skipped-net artifacts do not.
    return [v for v in drc.get('violations', []) if v.get('severity') == 'error'
            and v.get('type') in ('shorting_items', 'clearance', 'copper_edge_clearance')
            and not v.get('excluded', False)]


def validate_drc(drc):
    if not isinstance(drc, dict) or any(not isinstance(drc.get(k), list)
                                         for k in ('violations', 'unconnected_items')):
        raise ValueError('missing or malformed native DRC evidence')
    return drc


def select_real(run, directory):
    """Select only attributed, non-timeout candidates on the accepted outline."""
    candidates = []
    root = Path(directory).resolve()
    for index, step in enumerate(run.get('steps', [])):
        k = step.get('k')
        if not isinstance(k, (float, int)) or not math.isfinite(k) or abs(k - 1.) > 1e-9:
            continue
        if step.get('status', 'complete') != 'complete' or not step.get('board') or not step.get('runs'):
            continue
        scores = step['runs']
        if any(not isinstance(x, (float, int)) or not math.isfinite(x) or x < 0 or x >= 10**6 for x in scores):
            continue
        # Stored absolute paths are never followed after an archive/move. Use
        # the producing step under the explicitly supplied run directory.
        board = root / f'step-{index}' / 'route-0' / 'routed.kicad_pcb'
        if not board.is_file():
            continue
        outcome = board.parent / 'outcome.json'
        if outcome.exists():
            evidence = json.loads(outcome.read_text())
            if evidence.get('status') != 'complete' or evidence.get('board_sha256') != digest(board):
                continue
        candidates.append((not step.get('passed', False), min(scores), index, board))
    if not candidates:
        raise ValueError('no verified candidate on the accepted outline; diagnostic evidence retained')
    return str(min(candidates)[-1])


@contextlib.contextmanager
def job_slot(path):
    """One heavy cooperating BASE-B pipeline; do not interrupt other processes."""
    Path(path).parent.mkdir(parents=True, exist_ok=True)
    with open(path, 'a') as f:
        try:
            fcntl.flock(f, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise RuntimeError('another cooperating BASE-B pipeline is active; retry after it finishes')
        try:
            yield
        finally:
            fcntl.flock(f, fcntl.LOCK_UN)


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    sub = ap.add_subparsers(dest='action', required=True)
    sel = sub.add_parser('select')
    sel.add_argument('directory')
    ex = sub.add_parser('exec')
    ex.add_argument('--budget', type=float, required=True)
    ex.add_argument('--work', required=True)
    ex.add_argument('--lock', required=True)
    ex.add_argument('command', nargs=argparse.REMAINDER)
    a = ap.parse_args()
    if a.action == 'select':
        directory = Path(a.directory)
        print(select_real(json.loads((directory / 'run.json').read_text()), directory))
        return 0
    if not math.isfinite(a.budget) or a.budget <= 0:
        ap.error('budget must be finite and positive')
    command = a.command[1:] if a.command[:1] == ['--'] else a.command
    if not command:
        ap.error('command required')
    work = Path(a.work)
    work.mkdir(parents=True, exist_ok=True)
    events = str(work / 'stages.jsonl')
    try:
        with job_slot(a.lock):
            deadline = deadline_after(a.budget)
            env = dict(os.environ, IOT_LEAN_ADMITTED='1', IOT_LEAN_DEADLINE=encode_deadline(deadline))
            result = run_stage(command, stage='pipeline', event_file=events, env=env,
                               deadline=deadline)
            if remaining(env['IOT_LEAN_DEADLINE']) <= 0:
                atomic_json(work / 'pipeline-outcome.json', dict(status='timeout', qualified=False))
                print('INCOMPLETE: work finished after the deadline', file=sys.stderr)
                return 124
            atomic_json(work / 'pipeline-outcome.json',
                        dict(status='complete' if result.returncode == 0 else 'failed',
                             returncode=result.returncode, qualified=False))
            return result.returncode
    except subprocess.TimeoutExpired as error:
        atomic_json(work / 'pipeline-outcome.json', dict(status='timeout', qualified=False,
                    cause=type(error).__name__, cleanup=getattr(error, 'cleanup', None)))
        print('INCOMPLETE: deadline reached; logs/checkpoints retained', file=sys.stderr)
        return 124
    except KeyboardInterrupt as error:
        code = 128 + (getattr(error, 'signum', None) or signal.SIGINT)
        atomic_json(work / 'pipeline-outcome.json', dict(status='cancelled', returncode=code,
                    signal=getattr(error, 'signum', None), cleanup=getattr(error, 'cleanup', None), qualified=False))
        return code
    except RuntimeError as e:
        print(e, file=sys.stderr)
        return 75


if __name__ == '__main__':
    sys.exit(main())
