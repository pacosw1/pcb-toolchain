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
import lean_owned


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


def stage_depth(env):
    """Support root plus two nested owned supervisors; reject deeper nesting."""
    value = env.get('IOT_LEAN_STAGE_DEPTH', '0')
    if value not in ('0', '1', '2'):
        raise ValueError('invalid/excessive owned stage depth')
    return int(value)


def cleanup_group(proc, depth=0):
    """Signal only our new-session child group; never mask the original cause.

    On a denied group signal, stop the directly owned child if permitted, but
    retain unconfirmed group cleanup as an error rather than claim no orphan.
    """
    if isinstance(proc, lean_owned.Process):
        result = proc.cleanup()
        try:proc.communicate(timeout=0)
        except Exception:pass
        return result
    # Popen may already have reaped its leader. A numeric PID no longer proves
    # signal authority, so refuse unsupported handles without any signal.
    return dict(complete=False, errors=[dict(operation='ownership',
                error='cleanup requires an authenticated broker-owned stage')],
                child_reaped=False, family_cleanup='unconfirmed')


def run_stage(cmd, *, stage, event_file=None, deadline=None, on_start=None, **kwargs):
    """Bound the entire child process group; timeout output is never a pass.

    A root-owned broker retains registered group leaders across stopped nested
    controllers. TERM allows five seconds for checkpoints, then KILL cleanup
    gets two seconds; broker thread/descriptor draining is separately bounded.
    Root plus two nested owned levels are supported. Arbitrary unregistered
    setsid descendants are outside this ownership protocol. Logs/checkpoints
    are retained, but no timeout or uncertain cleanup result is accepted.
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
    status, rc, proc = 'failed', None, None
    handlers = {}
    cleanup = None
    cause = None
    admitting = True
    pending_signal = None
    def interrupted(signum, frame):
        nonlocal pending_signal
        if admitting:
            pending_signal = signum
            return
        raise StageCancelled(signum)
    try:
        depth = stage_depth(os.environ)
        if 'IOT_LEAN_STAGE_DEPTH' in child_env and stage_depth(child_env) != depth:
            raise ValueError('child environment cannot reset owned stage depth')
        if left is not None and left <= 0:
            status = 'timeout'
            cause = dict(type='TimeoutExpired', signal=None)
            raise subprocess.TimeoutExpired(cmd, 0)
        # Admission/cancellation is installed before the broker can spawn any
        # controller or helper. Only the root broker owns/reaps their leaders.
        for sig in (signal.SIGTERM, signal.SIGINT):
            handlers[sig] = signal.signal(sig, interrupted)
        try:
            proc = lean_owned.prepare(cmd, kwargs)
            if pending_signal:
                admitting=False
                raise StageCancelled(pending_signal)
            proc.start()
            admitting = False
            if pending_signal:raise StageCancelled(pending_signal)
            left = remaining(child_deadline)
            if left is not None and left<=0:raise subprocess.TimeoutExpired(cmd,0)
            proc.activate()
            if on_start:   # audit #803: the caller gets the owned process (graceful interrupt), not a PID search
                on_start(proc)
            left = remaining(child_deadline)
            stdout, stderr = proc.communicate(timeout=left)
        except (subprocess.TimeoutExpired, KeyboardInterrupt) as error:
            status = 'cancelled' if isinstance(error, KeyboardInterrupt) else 'timeout'
            cause = dict(type=type(error).__name__, signal=getattr(error, 'signum', None))
            # Repeated cancellation must not interrupt bounded cleanup.
            for sig in handlers:
                signal.signal(sig, signal.SIG_IGN)
            try:
                cleanup = cleanup_group(proc, depth) if proc else dict(complete=True, errors=[], child_reaped=True)
            except Exception as cleanup_error:
                # Cleanup diagnostics must never replace timeout/cancellation.
                cleanup = dict(complete=False, child_reaped=proc.returncode is not None,
                               family_cleanup='unconfirmed', errors=[dict(
                                   operation='cleanup', type=type(cleanup_error).__name__,
                                   error=str(cleanup_error))])
            error.cleanup = cleanup
            raise
        rc = proc.returncode
        cleanup = proc.last_cleanup
        if cleanup and not cleanup['complete']:
            raise RuntimeError('owned-stage cleanup could not be confirmed')
        status = 'complete' if rc == 0 else 'failed'
        return subprocess.CompletedProcess(cmd, rc, stdout, stderr)
    except BaseException as error:
        if cause is None:cause=dict(type=type(error).__name__,signal=getattr(error,'signum',None))
        if proc and cleanup is None:
            for sig in handlers:signal.signal(sig,signal.SIG_IGN)
            try:cleanup=cleanup_group(proc)
            except Exception as cleanup_error:
                cleanup=dict(complete=False,errors=[dict(operation='cleanup',error=str(cleanup_error))])
            error.cleanup=cleanup
        raise
    finally:
        try:close_failed = bool(proc and not proc.close())
        except Exception:close_failed = True
        if close_failed:
            cleanup = dict(complete=False, errors=[dict(operation='broker-close', error='owned broker has unsettled workers')])
            if status=='complete':status='failed'
        for sig, handler in handlers.items():
            signal.signal(sig, handler)
        if event_file:
            event = dict(stage=stage, command=list(map(str, cmd)), status=status, returncode=rc,
                         wall_s=now() - started, cause=cause, cleanup=cleanup,
                         child_cpu_s=proc.child_cpu_s if proc else None,
                         adopted_child_cpu_s=proc.adopted_child_cpu_s if proc else None,
                         cpu_scope=proc.cpu_scope if proc else 'unavailable; no owned leader reaped')
            with open(event_file, 'a') as f:
                f.write(json.dumps(event) + '\n')
            try:   # W5 run record: the same stage end as one action next to stages.jsonl (never blocks the stage)
                import run_record
                run_record.append(os.path.dirname(os.path.abspath(str(event_file))), stage, 'stage ' + status,
                                  inputs={'command': event['command']}, evidence=os.path.basename(str(event_file)),
                                  result=dict(returncode=rc, wall_s=round(event['wall_s'], 3), cause=cause),
                                  why='owned subprocess stage of the job' if status == 'complete' else f'stage {status}: {cause}')
            except Exception:
                pass
        if close_failed and cause is None:
            raise RuntimeError('owned-stage broker did not settle')


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
