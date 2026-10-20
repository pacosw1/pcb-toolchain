"""Small serializable contracts shared by engine adapters and observers."""
from __future__ import annotations
from dataclasses import asdict, dataclass, field
import hashlib
import json
from pathlib import Path
from typing import Any


def fingerprint(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(',', ':'),
                                     allow_nan=False).encode()).hexdigest()


def file_digest(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


@dataclass(frozen=True)
class RuleContext:
    files: dict[str, str]
    routing_policy: dict[str, Any]
    root: str = ''

    @property
    def revision(self):
        files = {str(Path(name).relative_to(self.root)) if self.root else name: digest
                 for name, digest in self.files.items()}
        return fingerprint(dict(files=files, routing_policy=self.routing_policy))

    def assert_current(self):
        for name, expected in self.files.items():
            if not Path(name).is_file() or file_digest(name) != expected:
                raise ValueError('engine rule/source dependency changed: ' + name)


@dataclass(frozen=True)
class BoardState:
    board: str
    path: str
    sha256: str
    rules_revision: str
    parent: str | None = None

    @classmethod
    def capture(cls, board, path, rules, parent=None):
        return cls(board, str(Path(path).resolve()), file_digest(path), rules.revision, parent)


@dataclass(frozen=True)
class Finding:
    classification: str
    reason: str
    refs: tuple[str, ...] = ()
    nets: tuple[str, ...] = ()
    details: dict[str, Any] = field(default_factory=dict)

    @classmethod
    def from_dict(cls, row):
        return cls(row.get('classification', 'unknown'), row.get('reason', ''),
                   tuple(row.get('refs', ())), tuple(row.get('nets', ())),
                   {k: v for k, v in row.items() if k not in {'classification', 'reason', 'refs', 'nets'}})


@dataclass(frozen=True)
class Candidate:
    candidate_id: str
    board: BoardState
    path: str
    gate_passed: bool
    metrics: dict[str, Any]
    findings: tuple[Finding, ...]
    evidence: dict[str, str]
    strategy: dict[str, Any]

    @property
    def rank(self):
        # Missing metrics must never become a perfect score.
        def numeric(key):
            value = self.metrics.get(key)
            return value if type(value) in (int, float) and value >= 0 else float('inf')
        return (not self.gate_passed, numeric('drc_errors'), numeric('drc_parity'),
                numeric('drc_unconnected'), numeric('via_count'), numeric('track_length_mm'))


@dataclass(frozen=True)
class Outcome:
    status: str
    cause: str
    attempts: int
    candidate: str | None = None
    candidate_sha256: str | None = None
    best_gate_candidate: str | None = None
    findings: tuple[Finding, ...] = ()
    candidate_verified: bool = False

    def to_dict(self):
        return dict(schema='iot-lab.engine-outcome.v1', **asdict(self),
                    exit_code=0 if self.status == 'candidate' else 1,
                    native_and_board_specific_gates_required=True)
