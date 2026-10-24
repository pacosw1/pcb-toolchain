"""Run shapes, as runs.py emits them today (Run.summary, Run.candidate, Runs.findings). runs.py (agent A) adopts them."""
from __future__ import annotations

from typing import Any, Literal

from .base import Model

RunState = Literal['running', 'passed', 'failed', 'error', 'cancelled']
RunOp = Literal['check', 'build', 'route']


class Candidate(Model):
    """A candidate board of a build/route run."""
    pcb: str                       # project-relative, under .gate/cli/RUN_ID/workspace/
    target: str | None             # the canonical board file adopt replaces
    exists: bool
    sha256: str | None
    verified: bool
    identity_preserved: bool | None
    metrics: dict[str, float] | None


class RunSummary(Model):
    id: str
    op: RunOp
    board: str
    mode: str
    state: RunState
    started: float
    exit_code: int | None
    run_id: str | None
    cause: str | None
    metrics: dict[str, float] | None
    findings: int
    events: int
    elapsed_s: float | None
    candidate: Candidate | None
    policy: dict[str, Any] | None
    adoption: dict[str, Any] | None
    adoptable: bool


class FindingItem(Model):
    description: str
    x: float
    y: float


class Finding(Model):
    kind: Literal['violation', 'unconnected']
    type: str
    severity: str
    description: str
    x: float
    y: float
    items: list[FindingItem]


class Findings(Model):
    id: str
    items: list[Finding]
    source: str | None
