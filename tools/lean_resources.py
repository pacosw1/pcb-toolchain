"""Cooperating local board jobs: declared CPU/memory reservations, not OS quotas.

Crash-safe locks release capacity. FIFO admission is bounded and interruptible;
no unrelated process is stopped. Memory requests are estimates, not RSS limits.
"""
import argparse
import contextlib
import fcntl
import json
import math
import os
import re
from pathlib import Path
import subprocess
import sys
import signal
import threading
import time
import uuid
import lean_workflow as lean

NATIVE_KEYS = ('OMP_NUM_THREADS', 'OPENBLAS_NUM_THREADS', 'MKL_NUM_THREADS',
               'VECLIB_MAXIMUM_THREADS', 'NUMEXPR_NUM_THREADS', 'BLIS_NUM_THREADS')


def native_env(env=None):
    # One native worker per placement process prevents nested oversubscription.
    return dict(os.environ if env is None else env, **{k: '1' for k in NATIVE_KEYS})


def router_env(cpu):
    """Cap the backend's global Rayon variants within a live CPU reservation.

    Explicit autorouter/optimizer pools still need their CLI caps. Their worker
    and coordinator threads are separate from this global pool; this is not an
    OS quota or a bound on total process threads.
    """
    if type(cpu) is not int or cpu < 1:
        raise ValueError('router CPU request must be a positive integer')
    if not inherited(cpu, 0):
        raise ValueError('router environment requires a live resource reservation')
    return dict(native_env(), RAYON_NUM_THREADS=str(cpu))


def limits():
    cpu = int(os.environ.get('IOT_CPU_BUDGET', min(12, os.cpu_count() or 1)))
    memory = float(os.environ.get('IOT_MEMORY_BUDGET_GIB', '16'))
    if cpu < 1 or not math.isfinite(memory) or memory <= 0:
        raise ValueError('resource capacities must be finite and positive')
    return cpu, memory


def root_directory():
    return Path(os.environ.get('IOT_RESOURCE_DIRECTORY',
                               str(Path.home() / '.cache/iot-lab/resources')))


def job_memory():
    return float(os.environ.get('IOT_JOB_MEMORY_GIB', '8'))


def default_cpu():
    return int(os.environ.get('IOT_RESOURCE_CPU', limits()[0]))


def event(path, **values):
    if path:
        Path(path).parent.mkdir(parents=True, exist_ok=True)
        with open(path, 'a') as f:
            f.write(json.dumps(dict(time_monotonic=lean.now(), **values)) + '\n')


@contextlib.contextmanager
def guard(root, deadline=None):
    root.mkdir(parents=True, exist_ok=True)
    deadline = lean.now() + 5 if deadline is None else deadline
    with open(root / 'guard', 'a') as f:
        while True:
            try:
                fcntl.flock(f, fcntl.LOCK_EX | fcntl.LOCK_NB)
                break
            except BlockingIOError:
                if lean.now() >= deadline:
                    raise TimeoutError('resource ledger busy; admission deadline reached')
                time.sleep(min(.01, max(0., deadline-lean.now())))
        yield


def live_claims(root):
    """Must hold guard. Locked ticket inode is liveness, never PID guesses."""
    claims = []
    for path in root.glob('*.ticket'):
        with open(path, 'r+') as f:
            try:
                fcntl.flock(f, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError:
                claims.append(json.load(f))
            else:
                path.unlink()  # dead owner; checkpoints live elsewhere
    return claims


def inherited(cpu, memory):
    path = os.environ.get('IOT_RESOURCE_TICKET')
    if not path:
        return False
    with open(path, 'r+') as f:
        try:
            fcntl.flock(f, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            claim = json.load(f)
        else:
            raise ValueError('inherited resource reservation is no longer live')
    if claim['status'] != 'admitted' or cpu > claim['cpu'] or memory > claim['memory_gib']:
        raise ValueError('child request exceeds inherited reservation')
    return True


@contextlib.contextmanager
def reserve(cpu, memory_gib=None, *, wait_s=30., events=None, label='board'):
    memory_gib = job_memory() if memory_gib is None else memory_gib
    capacity, memory_capacity = limits()
    if cpu < 1 or cpu > capacity or not math.isfinite(memory_gib) or memory_gib <= 0 or memory_gib > memory_capacity:
        raise ValueError('request exceeds cooperating resource capacity')
    if not math.isfinite(wait_s) or wait_s < 0:
        raise ValueError('admission wait must be finite and nonnegative')
    if lean.remaining() == 0:
        raise TimeoutError('end-to-end deadline reached before admission')
    if inherited(cpu, memory_gib):
        yield native_env()
        return
    root = root_directory()
    started = lean.now()
    deadline = started + wait_s
    inherited_deadline = lean.inherited_deadline()
    if inherited_deadline is not None:
        deadline = min(deadline, inherited_deadline)
    ticket = root / (uuid.uuid4().hex + '.ticket')
    claim = dict(id=ticket.stem, pid=os.getpid(), queued_at=started, status='waiting',
                 clock_protocol=lean.DEADLINE_PROTOCOL,
                 label=label, cpu=cpu, memory_gib=memory_gib,
                 cpu_capacity=capacity, memory_capacity_gib=memory_capacity)
    def write(f):
        f.seek(0)
        json.dump(claim, f)
        f.truncate()
        f.flush()
    with guard(root, deadline):
        f = open(ticket, 'w+')
        fcntl.flock(f, fcntl.LOCK_EX | fcntl.LOCK_NB)
        write(f)
    handlers = {}
    if threading.current_thread() is threading.main_thread():
        def cancelled(signum, frame):
            raise lean.StageCancelled(signum)
        for sig in (signal.SIGTERM, signal.SIGINT):
            handlers[sig] = signal.signal(sig, cancelled)
    try:
        # Publishing readiness must not expose a waiter with default signal
        # handlers. Keep publication inside cleanup/cancellation accounting.
        event(events, action='queued', **claim)
        while True:
            if inherited_deadline is not None and lean.now() >= inherited_deadline:
                raise TimeoutError('end-to-end deadline reached during admission')
            with guard(root, deadline):
                active = live_claims(root)
                if any(c.get('clock_protocol') != lean.DEADLINE_PROTOCOL for c in active):
                    raise ValueError('cooperating jobs use incompatible queue clock protocols')
                # All clients must agree on the same capacities, otherwise an
                # optimistic client could break a pessimistic client's budget.
                if any(c['cpu_capacity'] != capacity or c['memory_capacity_gib'] != memory_capacity for c in active):
                    raise ValueError('cooperating jobs disagree on resource capacities')
                waiting = sorted((c for c in active if c['status'] == 'waiting'), key=lambda c: (c['queued_at'], c['id']))
                admitted = [c for c in active if c['status'] == 'admitted']
                used_cpu = sum(c['cpu'] for c in admitted)
                used_memory = sum(c['memory_gib'] for c in admitted)
                if waiting[0]['id'] == claim['id'] and used_cpu + cpu <= capacity and used_memory + memory_gib <= memory_capacity:
                    claim['status'] = 'admitted'
                    write(f)
                    break
            if lean.now() >= deadline:
                raise TimeoutError('cooperating resource admission deadline reached')
            time.sleep(min(.1, max(0., deadline - lean.now())))
        event(events, action='admitted', queue_s=lean.now() - started, **claim)
        yield dict(native_env(), IOT_RESOURCE_TICKET=str(ticket), IOT_RESOURCE_CPU=str(cpu),
                   IOT_JOB_MEMORY_GIB=str(memory_gib))
    except BaseException as e:
        event(events, action='cancelled' if isinstance(e, KeyboardInterrupt) else 'failed',
              reason=type(e).__name__, signal=getattr(e, 'signum', None),
              queue_s=lean.now() - started, **claim)
        raise
    finally:
        for sig, handler in handlers.items():
            signal.signal(sig, handler)
        try:
            with guard(root):
                ticket.unlink(missing_ok=True)
        finally:
            f.close()
        event(events, action='released', **claim)


@contextlib.contextmanager
def environment(env):
    saved = {k: os.environ.get(k) for k in env if k.startswith('IOT_RESOURCE_') or k in ('IOT_JOB_MEMORY_GIB', 'IOT_LEAN_DEADLINE') or k in NATIVE_KEYS}
    try:
        os.environ.update({k: env[k] for k in saved})
        yield
    finally:
        for k, value in saved.items():
            if value is None:
                os.environ.pop(k, None)
            else:
                os.environ[k] = value


def sample(pid):
    rows = []
    p = subprocess.run(['ps', '-axo', 'pid,ppid,%cpu,rss'], capture_output=True, text=True, timeout=3)
    for line in p.stdout.splitlines()[1:]:
        fields = line.split()
        if len(fields) == 4:
            rows.append(dict(pid=int(fields[0]), ppid=int(fields[1]), cpu_percent=float(fields[2]), rss_kib=int(fields[3])))
    family = {pid}
    while True:
        expanded = family | {r['pid'] for r in rows if r['ppid'] in family}
        if expanded == family:
            break
        family = expanded
    result = dict(monotonic=lean.now(), processes=[r for r in rows if r['pid'] in family],
                  gpu_memory_bytes=None, gpu_memory_note='no supported process GPU counter collected')
    for name, cmd in [('vm_stat', ['vm_stat']), ('swapusage', ['sysctl', 'vm.swapusage'])]:
        try:
            out = subprocess.run(cmd, capture_output=True, text=True, timeout=3)
            result[name] = dict(returncode=out.returncode, raw=out.stdout, error=out.stderr)
        except (OSError, subprocess.TimeoutExpired) as e:
            result[name] = dict(unavailable=str(e))
    return result


def summarize(path):
    samples = [json.loads(line) for line in Path(path).read_text().splitlines()]
    valid = [s for s in samples if 'processes' in s]
    def vm(s):
        raw = s.get('vm_stat', {}).get('raw', '')
        page = re.search(r'page size of (\d+) bytes', raw)
        counts = {k.strip(): int(v) for k, v in re.findall(r'^([^:\n]+):\s+(\d+)\.', raw, re.M)}
        return int(page.group(1)) if page else 0, counts
    vm_samples = [(s['monotonic'], *vm(s)) for s in valid if s.get('vm_stat', {}).get('returncode') == 0]
    rates = None
    compression = None
    if len(vm_samples) > 1:
        first, last = vm_samples[0], vm_samples[-1]
        dt = last[0] - first[0]
        if dt > 0 and first[1] == last[1]:
            rates = {k: (last[2].get(k, 0)-first[2].get(k, 0))*last[1]/dt
                     for k in ('Swapins', 'Swapouts', 'Pageins', 'Pageouts')}
        compression = dict(peak_physical_bytes=max(c.get('Pages occupied by compressor', 0)*p for _, p, c in vm_samples),
                           peak_logical_bytes=max(c.get('Pages stored in compressor', 0)*p for _, p, c in vm_samples))
    return dict(sample_count=len(valid),
                peak_observed_family_rss_bytes=max([sum(p['rss_kib']*1024 for p in s['processes']) for s in valid] or [0]),
                system_vm_rates_bytes_s=rates, system_compression=compression,
                gpu_memory_bytes=None,
                limitations='RSS sums include shared pages and profiler; sampling can miss peaks. ps CPU is lifetime average. VM rates/compression are system-wide, not attributed to this job. No supported GPU memory counter collected.')


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument('--cpu', type=int, required=True)
    ap.add_argument('--memory-gib', type=float, default=8.)
    ap.add_argument('--wait', type=float, default=30.)
    ap.add_argument('--seconds', type=float, required=True)
    ap.add_argument('--output', required=True)
    ap.add_argument('command', nargs=argparse.REMAINDER)
    a = ap.parse_args()
    if not math.isfinite(a.seconds) or a.seconds <= 0:
        ap.error('seconds must be finite and positive')
    cmd = a.command[1:] if a.command[:1] == ['--'] else a.command
    if not cmd:
        ap.error('command required')
    output = Path(a.output)
    output.mkdir(parents=True, exist_ok=False)
    import lean_workflow as lean
    stop = threading.Event()
    def monitor():
        with open(output / 'samples.jsonl', 'w') as f:
            while not stop.is_set():
                try:
                    f.write(json.dumps(sample(os.getpid())) + '\n')
                    f.flush()
                except (OSError, ValueError, subprocess.TimeoutExpired) as e:
                    f.write(json.dumps(dict(unavailable=str(e))) + '\n')
                stop.wait(.5)
    thread = threading.Thread(target=monitor, daemon=True)
    thread.start()
    started = lean.now()
    deadline = lean.deadline_after(a.seconds)
    budget_env = dict(os.environ, IOT_LEAN_DEADLINE=lean.encode_deadline(deadline))
    cause, cleanup = None, None
    try:
        with environment(budget_env), reserve(a.cpu, a.memory_gib, wait_s=a.wait, events=output / 'admission.jsonl') as env:
            env['IOT_LEAN_DEADLINE'] = lean.encode_deadline(deadline)
            with open(output / 'command.log', 'w') as log:
                rc = lean.run_stage(cmd, stage='profile', deadline=env['IOT_LEAN_DEADLINE'],
                                    event_file=output / 'stages.jsonl', env=env, stdout=log, stderr=subprocess.STDOUT).returncode
        status = 'complete' if rc == 0 else 'failed'
    except (TimeoutError, subprocess.TimeoutExpired) as error:
        rc, status = 124, 'timeout'
        cause, cleanup = dict(type=type(error).__name__, signal=None), getattr(error, 'cleanup', None)
    except KeyboardInterrupt as error:
        rc, status = 128 + (getattr(error, 'signum', None) or signal.SIGINT), 'cancelled'
        cause, cleanup = dict(type=type(error).__name__, signal=getattr(error, 'signum', None)), getattr(error, 'cleanup', None)
    except (ValueError, OSError) as e:
        rc, status = 2, 'failed'
        event(output / 'admission.jsonl', action='failed', reason=str(e))
    finally:
        stop.set()
        thread.join(timeout=8)
    lean.atomic_json(output / 'outcome.json', dict(status=status, returncode=rc, wall_s=lean.now()-started,
                                                 cpu=a.cpu, memory_gib=a.memory_gib, qualified=False,
                                                 cause=cause, cleanup=cleanup,
                                                 profile=summarize(output / 'samples.jsonl'),
                                                 note='resource profile only; native full board gate required'))
    return rc


if __name__ == '__main__':
    sys.exit(main())
