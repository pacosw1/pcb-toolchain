"""Project, board and revision shapes, the project layout config and the board.yaml file schema."""
from __future__ import annotations

from typing import Literal

from pydantic import ConfigDict, Field

from .base import Model


class ProjectLayout(Model):
    """Where a hardware project keeps its files, project-relative. The default is the iot-lab layout."""
    boards_dir: str = 'hardware-design/boards'
    registry: str = 'hardware-design/registry/boards.json'
    datasheets_dir: str = 'hardware-design/registry/datasheets'
    cad_assets_dir: str = 'hardware-design/registry/cad-assets'
    components: str = 'hardware-design/registry/components.json'
    board_file: str = 'board.yaml'
    gate_file: str = 'gate.json'
    gate_variant_glob: str = 'gate-*.json'
    gate_reserved: list[str] = Field(default_factory=lambda: ['gate-metrics.json', 'gate-waivers.json'])


class GateRef(Model):
    """One gate config that checks a revision: `<boards_dir>/<name>/<config>`; run with `tools/pcb check NAME`
    (config gate.json) or `node tools/gate.mjs NAME --config CONFIG` (a variant)."""
    name: str
    config: str = 'gate.json'
    variant: str | None = None


class Revision(Model):
    """A board revision. Every path is project-relative and exists, or is None."""
    revision: str | None
    state: str | None
    pcb: str | None
    sch: str | None = None
    spec: str | None = None
    bom: str | None = None
    gate: str | None = None
    gates: list[GateRef] = Field(default_factory=list)
    pipeline: str | None = None


class Board(Model):
    id: str
    directory: str
    lifecycle: str
    kind: str | None = None
    variant_of: str | None = None
    identity: Literal['board.yaml', 'legacy'] = 'legacy'
    revisions: list[Revision]


class IdentityConflict(Model):
    """A disagreement between identity sources (registry, gate.json, folders, board.yaml) and how it was resolved."""
    board: str | None
    kind: str
    message: str


class ProjectInfo(Model):
    root: str
    boards: list[Board]
    conflicts: list[IdentityConflict] = Field(default_factory=list)


# --- board.yaml (schema pcbstudio.board.v1). Paths are relative to the board folder; `pipeline` is project-relative.

class BoardFileGate(Model):
    name: str
    config: str = 'gate.json'


class BoardFileRevision(Model):
    rev: str | None
    state: str | None = None
    pcb: str | None = None
    sch: str | None = None
    spec: str | None = None
    bom: str | None = None
    gate: str | None = None
    gates: list[BoardFileGate] = Field(default_factory=list)
    pipeline: str | None = None


class BoardFile(Model):
    model_config = ConfigDict(extra='forbid', populate_by_name=True)
    schema_: Literal['pcbstudio.board.v1'] = Field('pcbstudio.board.v1', alias='schema')
    id: str
    lifecycle: str
    kind: str | None = None
    variant_of: str | None = None
    revisions: list[BoardFileRevision] = Field(default_factory=list)


class MigrateReport(Model):
    root: str
    out: str
    boards: int
    revisions: int
    gates: int
    written: list[str]
    conflicts: list[IdentityConflict]
    round_trip: bool
