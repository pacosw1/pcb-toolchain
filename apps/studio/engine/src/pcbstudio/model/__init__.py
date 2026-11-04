"""Typed engine shapes (pydantic v2). API methods return `model_dump()` of these; the app's TypeScript types are
generated from them (`python -m pcbstudio.model.tsgen`, app `npm run types:gen` / `types:check`)."""
from __future__ import annotations

from .geometry import Footprint, Geometry, GlbResult, Graphic, Pad, PadPrim, Track, Via, Zone, ZoneAllow, ZoneFill
from .parts import (Bom, BomLine, BomSource, BomSummary, BoardParts, DatasheetRef, PartPlacement, PartRecord,
                    PartsIndexStats)
from .project import (Board, BoardFile, BoardFileGate, BoardFileRevision, GateRef, IdentityConflict, MigrateReport,
                      ProjectInfo, ProjectLayout, Revision)
from .runs import Candidate, Finding, FindingItem, Findings, RunSummary

# The shapes the app sees, in output order of the generated TypeScript file.
EXPORTED = [
    PadPrim, Pad, Footprint, Track, Via, ZoneFill, ZoneAllow, Zone, Graphic, Geometry, GlbResult,
    GateRef, Revision, Board, IdentityConflict, ProjectInfo, ProjectLayout,
    DatasheetRef, PartRecord, PartsIndexStats, BomSource, BomLine, BomSummary, Bom, PartPlacement, BoardParts,
    Candidate, RunSummary, FindingItem, Finding, Findings,
]

__all__ = [m.__name__ for m in EXPORTED] + ['BoardFile', 'BoardFileGate', 'BoardFileRevision', 'MigrateReport',
                                            'EXPORTED']
