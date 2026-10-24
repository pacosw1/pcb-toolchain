"""A hardware project (an iot-lab style repo): boards, revisions and their KiCad files. Read only for now.

Sources, in order: `hardware-design/registry/boards.json` (id, lifecycle, revisions with project path and state),
then every `hardware-design/boards/<DIR>/cad/**/*.kicad_pcb` the registry does not name (shown as `unregistered`).
Phase 5 replaces this with per-board `board.yaml`.
"""
from __future__ import annotations

import json
from pathlib import Path

BOARDS_DIR = 'hardware-design/boards'
REGISTRY = 'hardware-design/registry/boards.json'


class ProjectError(ValueError):
    pass


class Project:
    def __init__(self, root: str | Path) -> None:
        self.root = Path(root).expanduser().resolve()
        if not (self.root / BOARDS_DIR).is_dir():
            raise ProjectError(f'not a hardware project (no {BOARDS_DIR}/): {self.root}')

    def resolve(self, rel: str) -> Path:
        """A project-relative path; refuses anything outside the project root."""
        p = (self.root / rel).resolve()
        if p != self.root and self.root not in p.parents:
            raise ProjectError(f'path outside the project: {rel}')
        return p

    def boards(self) -> list[dict]:
        reg = {}
        reg_file = self.root / REGISTRY
        excluded: set[str] = set()
        if reg_file.is_file():
            data = json.loads(reg_file.read_text())
            excluded = set(data.get('excluded_directories', []))
            for b in data.get('boards', []):
                reg[b['directory']] = b
        out = []
        for d in sorted((self.root / BOARDS_DIR).iterdir()):
            if not d.is_dir() or d.name.startswith(('_', '.')) or d.name in excluded:
                continue
            entry = reg.get(d.name, {})
            revs = []
            named = set()
            for r in entry.get('revisions', []) or []:
                proj = r.get('project')
                pcb = d / (proj + '.kicad_pcb') if proj else None
                rel = str(pcb.relative_to(self.root)) if pcb is not None and pcb.is_file() else None
                if rel:
                    named.add(rel)
                revs.append({'revision': r.get('revision'), 'state': r.get('state'), 'pcb': rel,
                             'spec': r.get('spec'), 'gate': r.get('gate')})
            # Files the registry does not name show only for a board without a registered PCB (candidate and
            # placement copies beside a registered revision are not revisions).
            for pcb in ([] if named else sorted(d.glob('cad/**/*.kicad_pcb'))):
                rel = str(pcb.relative_to(self.root))
                if rel not in named and not any(part.startswith('.') for part in pcb.relative_to(d).parts):
                    revs.append({'revision': None, 'state': 'unregistered', 'pcb': rel, 'spec': None, 'gate': None})
            out.append({'id': entry.get('id', d.name), 'directory': d.name,
                        'lifecycle': entry.get('lifecycle', 'unregistered'), 'revisions': revs})
        return out
