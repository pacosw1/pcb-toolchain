"""Single-writer transactions with durable rollback and source-bound evidence."""
from contextlib import contextmanager
from dataclasses import asdict
import fcntl
import json
import os
from pathlib import Path
import shutil
import time

from .model import BoardState, Candidate, Finding, file_digest, fingerprint


def atomic_json(path, value):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(path.name + '.tmp')
    with temporary.open('w') as stream:
        json.dump(value, stream, indent=2, sort_keys=True, allow_nan=False)
        stream.write('\n')
        stream.flush()
        os.fsync(stream.fileno())
    os.replace(temporary, path)


def atomic_copy(source, destination):
    destination = Path(destination)
    temporary = destination.with_name(destination.name + '.engine-tmp')
    with Path(source).open('rb') as src, temporary.open('wb') as dst:
        shutil.copyfileobj(src, dst)
        dst.flush()
        os.fsync(dst.fileno())
    os.replace(temporary, destination)


class Session:
    def __init__(self, folder, native, rules, policy, emit=None):
        self.folder, self.native = Path(folder).resolve(), Path(native).resolve()
        self.rules, self.policy = rules, policy
        self.emit = emit or (lambda *args, **kwargs: None)
        self.phase = 'admitted'
        self.seen = set()
        self.attempts = []
        self.best = None
        self.best_verified = None
        self._lock = None
        self.initial_sha256 = None
        self.pending = None
        self.attempt_count = 0
        self.movement_origin = None

    def __enter__(self):
        self.folder.mkdir(parents=True, exist_ok=True)
        self._lock = (self.folder / 'writer.lock').open('a+')
        try:
            fcntl.flock(self._lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            self.rules.assert_current()
            receipt = self.folder / 'state.json'
            resumed = receipt.exists()
            binding = dict(native=str(self.native), rules=self.rules.revision,
                           policy=fingerprint(self.policy.to_dict()))
            self.initial_sha256 = file_digest(self.native)
            if receipt.exists():
                old = json.loads(receipt.read_text())
                if old.get('binding') != binding:
                    raise ValueError('stale engine session dependencies or policy')
                pending = old.get('pending')
                if pending:
                    backup = self.folder / pending['backup']
                    if not backup.is_file() or file_digest(backup) != pending['sha256']:
                        raise ValueError('interrupted transaction has no intact rollback image')
                    atomic_copy(backup, self.native)
                elif file_digest(self.native) not in ({old.get('initial_sha256')} |
                        {row['board']['sha256'] for row in old.get('attempts', [])}):
                    raise ValueError('native board differs from every recorded session revision')
                self.initial_sha256 = old['initial_sha256']
                self.seen = set(old.get('seen', []))
                self.attempt_count = old.get('attempt_count', len(self.seen))
                self.movement_origin = old.get('movement_origin')
                self.attempts = old.get('attempts', [])
                for row in self.attempts:
                    item = Candidate(row['candidate_id'], BoardState(**row['board']), row['path'],
                        row['gate_passed'], row['metrics'], tuple(Finding(**f) for f in row['findings']),
                        row['evidence'], row['strategy'])
                    if file_digest(item.path) != item.board.sha256 or any(file_digest(p) != d for p, d in item.evidence.items()):
                        raise ValueError('recorded candidate or verification evidence changed')
                    if self.best is None or item.rank < self.best.rank:
                        self.best = item
                    if item.gate_passed and (self.best_verified is None or item.rank < self.best_verified.rank):
                        self.best_verified = item
            self.binding = binding
            self.persist()
            self.event('engine.session', phase=self.phase, resumed=resumed)
            return self
        except BaseException:
            self._lock.close()
            self._lock = None
            raise

    def __exit__(self, *exc):
        if self._lock:
            fcntl.flock(self._lock, fcntl.LOCK_UN)
            self._lock.close()
            self._lock = None

    def event(self, kind, **data):
        row = dict(type=kind, time=time.time(), **data)
        with (self.folder / 'events.jsonl').open('a') as stream:
            stream.write(json.dumps(row, sort_keys=True, allow_nan=False) + '\n')
            stream.flush()
            os.fsync(stream.fileno())
        self.emit(kind, **data)

    def persist(self):
        atomic_json(self.folder / 'state.json', dict(schema='iot-lab.engine-session.v1',
            binding=self.binding, phase=self.phase, seen=sorted(self.seen), attempts=self.attempts,
            pending=self.pending, candidate=str(self.native), initial_sha256=self.initial_sha256,
            attempt_count=self.attempt_count,
            movement_origin=self.movement_origin,
            best_candidate=asdict(self.best) if self.best else None,
            best_gate_candidate=asdict(self.best_verified) if self.best_verified else None))

    def transition(self, phase):
        allowed = {'admitted': {'searching', 'blocked'}, 'searching': {'diagnosing', 'verifying', 'complete', 'blocked'},
                   'diagnosing': {'searching', 'complete', 'blocked'}, 'verifying': {'diagnosing', 'searching', 'complete', 'blocked'},
                   'complete': set(), 'blocked': set()}
        if phase not in allowed[self.phase]:
            raise ValueError('invalid engine transition: ' + self.phase + ' -> ' + phase)
        self.phase = phase
        self.persist()
        self.event('engine.phase', phase=phase)

    def admit_attempt(self, strategy):
        self.rules.assert_current()
        key = fingerprint(dict(board=file_digest(self.native), rules=self.rules.revision, strategy=strategy))
        if key in self.seen:
            self.event('engine.retry_stopped', fingerprint=key)
            return None
        self.seen.add(key)
        self.attempt_count += 1
        self.persist()
        return key

    @contextmanager
    def transaction(self, attempt_id):
        self.rules.assert_current()
        backup = self.folder / (attempt_id + '.rollback.kicad_pcb')
        atomic_copy(self.native, backup)
        pending = dict(backup=backup.name, sha256=file_digest(backup), attempt_id=attempt_id,
                       invalidates=['connectivity', 'geometry', 'placement', 'native_checks'])
        self.pending = pending
        self.persist()
        self.event('engine.transaction', action='begin', attempt_id=attempt_id, **{k: v for k, v in pending.items() if k != 'attempt_id'})
        try:
            yield
            self.rules.assert_current()
        finally:
            # Search never advances the source implicitly. Candidates are immutable
            # images, and selection is materialized only after all trials finish.
            atomic_copy(backup, self.native)
            self.pending = None
            self.persist()
            self.event('engine.transaction', action='rollback', attempt_id=attempt_id)

    def record(self, candidate):
        if file_digest(candidate.path) != candidate.board.sha256:
            raise ValueError('candidate bytes changed before recording')
        for name, digest in candidate.evidence.items():
            if file_digest(name) != digest:
                raise ValueError('candidate gate evidence changed before recording')
        row = asdict(candidate)
        self.attempts.append(row)
        if self.best is None or candidate.rank < self.best.rank:
            self.best = candidate
        if candidate.gate_passed and (self.best_verified is None or candidate.rank < self.best_verified.rank):
            self.best_verified = candidate
        self.persist()
        self.event('engine.candidate', **row)
