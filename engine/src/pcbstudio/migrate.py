"""`pcbstudio migrate --project ROOT --out DIR`: one board.yaml per board from the legacy derivation (registry +
gate configs + folders), a conflict report, and a round-trip check (re-read DIR -> the same boards).

DIR gets `<BOARD-DIR>/board.yaml` and `migrate-report.json`. With `--out <ROOT>/<boards_dir>` the files land in the
project itself; the default flow writes elsewhere first and checks the round trip.
"""
from __future__ import annotations

import json
from pathlib import Path

from .model import Board, MigrateReport
from .project import Project, dump_board_file


def _identity_free(boards: list[Board]) -> list[dict]:
    return [b.model_dump(exclude={'identity'}) for b in boards]


def migrate(root: str | Path, out: str | Path) -> MigrateReport:
    src = Project(root)
    boards = src.boards()
    conflicts = list(src.conflicts)
    out = Path(out).expanduser().resolve()
    written = []
    for b in boards:
        f = out / b.directory / src.layout.board_file
        f.parent.mkdir(parents=True, exist_ok=True)
        f.write_text(dump_board_file(src.board_file_for(b)))
        written.append(str(f.relative_to(out)))
    reread = Project(root, identity_dir=out)
    again = reread.boards()
    ok = _identity_free(again) == _identity_free(boards) and all(b.identity == 'board.yaml' for b in again)
    report = MigrateReport(root=str(src.root), out=str(out), boards=len(boards),
                           revisions=sum(len(b.revisions) for b in boards),
                           gates=sum(len(r.gates) for b in boards for r in b.revisions),
                           written=written, conflicts=conflicts, round_trip=ok)
    (out / 'migrate-report.json').write_text(json.dumps(report.model_dump(), indent=2) + '\n')
    return report
