"""A hardware project (an iot-lab style repo): boards, revisions, their KiCad files and gates. Read only.

Board identity has one source per board:
- `<boards_dir>/<DIR>/board.yaml` (schema pcbstudio.board.v1) when the board has one;
- else the legacy derivation, which `pcbstudio migrate` turns into board.yaml files:
  registry `boards.json` (id, lifecycle, revisions, spec, bom) + board folders (`cad/**/*.kicad_pcb`) + gate configs.

Gate names come only from gate configs: `<boards_dir>/<NAME>/gate.json` (and `gate-<variant>.json`) checks the
revision whose PCB is the config's `project` + `.kicad_pcb`. The registry `gate` field is only cross-checked, and a
disagreement is an IdentityConflict. A folder that holds only gate data for a PCB in another folder (registry
kind `gate-only`, for example BASE-PWR-B) is not a board: its gate shows on the revision it checks.
"""
from __future__ import annotations

import ast
import json
from pathlib import Path

import yaml

from .model import (Board, BoardFile, BoardFileGate, BoardFileRevision, GateRef, IdentityConflict, ProjectInfo,
                    ProjectLayout, Revision)

DEFAULT_LAYOUT = ProjectLayout()


class ProjectError(ValueError):
    pass


class Project:
    def __init__(self, root: str | Path, layout: ProjectLayout | None = None,
                 identity_dir: str | Path | None = None) -> None:
        """`identity_dir`: read board.yaml files from `<identity_dir>/<DIR>/board.yaml` in place of the board
        folders (a migrate output checked before it is copied into the project)."""
        self.root = Path(root).expanduser().resolve()
        self.layout = layout or DEFAULT_LAYOUT
        if not (self.root / self.layout.boards_dir).is_dir():
            raise ProjectError(f'not a hardware project (no {self.layout.boards_dir}/): {self.root}')
        self.identity_dir = Path(identity_dir).expanduser().resolve() if identity_dir else None
        self.conflicts: list[IdentityConflict] = []

    # --- paths

    @property
    def boards_path(self) -> Path:
        return self.root / self.layout.boards_dir

    def path(self, rel: str) -> Path:
        """A layout path (project-relative) as an absolute path, unchecked."""
        return self.root / rel

    def resolve(self, rel: str) -> Path:
        """A project-relative path; refuses anything outside the project root."""
        p = (self.root / rel).resolve()
        if p != self.root and self.root not in p.parents:
            raise ProjectError(f'path outside the project: {rel}')
        return p

    def rel(self, p: Path) -> str:
        return str(p.resolve().relative_to(self.root))

    def existing(self, base: Path, rel: str | None) -> str | None:
        """Project-relative path of `base/rel` when it is a file inside the project, else None."""
        if not rel:
            return None
        p = (base / rel).resolve()
        if self.root not in p.parents or not p.is_file():
            return None
        return self.rel(p)

    def board_file(self, directory: str) -> Path:
        base = self.identity_dir if self.identity_dir else self.boards_path
        return base / directory / self.layout.board_file

    # --- public

    def info(self) -> ProjectInfo:
        boards = self.boards()
        return ProjectInfo(root=str(self.root), boards=boards, conflicts=list(self.conflicts))

    def boards(self) -> list[Board]:
        self.conflicts = []
        out = []
        for b in self.legacy_boards():
            f = self.board_file(b.directory)
            out.append(self._from_board_file(b.directory, f) if f.is_file() else b)
        # A board.yaml in a folder the legacy rules do not list as a board (gate-only folder, new folder).
        known = {b.directory for b in out}
        for d in self._folders():
            if d.name not in known and self.board_file(d.name).is_file():
                out.append(self._from_board_file(d.name, self.board_file(d.name)))
        out.sort(key=lambda b: b.directory)
        return out

    def revision_for_pcb(self, pcb_rel: str) -> tuple[Board, Revision] | None:
        for b in self.boards():
            for r in b.revisions:
                if r.pcb == pcb_rel:
                    return b, r
        return None

    # --- legacy derivation

    def registry(self) -> dict:
        f = self.path(self.layout.registry)
        return json.loads(f.read_text()) if f.is_file() else {}

    def _folders(self) -> list[Path]:
        excluded = set(self.registry().get('excluded_directories', []))
        return [d for d in sorted(self.boards_path.iterdir())
                if d.is_dir() and not d.name.startswith(('_', '.')) and d.name not in excluded]

    def _gate_configs(self, d: Path) -> list[Path]:
        main = d / self.layout.gate_file
        variants = [p for p in sorted(d.glob(self.layout.gate_variant_glob)) if p.name not in self.layout.gate_reserved]
        return ([main] if main.is_file() else []) + variants

    def _gate_pcb(self, d: Path, cfg: Path) -> str | None:
        try:
            data = json.loads(cfg.read_text())
        except (OSError, ValueError):
            self._conflict(d.name, 'gate_unreadable', f'{self.rel(cfg)} is not valid JSON')
            return None
        proj = data.get('project') if isinstance(data, dict) else None
        if not isinstance(proj, str) or not proj:
            self._conflict(d.name, 'gate_no_project', f'{self.rel(cfg)} names no project')
            return None
        return self.existing(d, proj + '.kicad_pcb')

    def _conflict(self, board: str | None, kind: str, message: str) -> None:
        self.conflicts.append(IdentityConflict(board=board, kind=kind, message=message))

    def _pipeline(self, gate: str | None) -> str | None:
        if not gate:
            return None
        alias = self._aliases().get(gate, gate.lower().replace('-', '_'))
        return self.existing(self.root, self.layout.pipeline.format(alias=alias))

    def _aliases(self) -> dict[str, str]:
        """The legacy `ALIASES` dict of the project's workflow module (parsed, never imported)."""
        f = self.path(self.layout.pipeline_aliases)
        if not f.is_file():
            return {}
        try:
            for node in ast.parse(f.read_text()).body:
                if isinstance(node, ast.Assign) and any(isinstance(t, ast.Name) and t.id == 'ALIASES' for t in node.targets):
                    v = ast.literal_eval(node.value)
                    return {str(k): str(x) for k, x in v.items()} if isinstance(v, dict) else {}
        except (SyntaxError, ValueError):
            pass
        return {}

    def legacy_boards(self) -> list[Board]:
        reg = self.registry()
        entries = {b['directory']: b for b in reg.get('boards', []) if b.get('directory')}
        folders = self._folders()
        gates_by_dir = {d.name: [(GateRef(name=d.name, config=c.name, variant=_variant(c.name)), self._gate_pcb(d, c))
                                 for c in self._gate_configs(d)] for d in folders}

        def gate_only(d: Path) -> bool:
            e = entries.get(d.name, {})
            if e.get('kind') == 'gate-only':
                return True
            gs = gates_by_dir[d.name]
            return bool(gs) and not e.get('revisions') and not any(d.glob('cad/**/*.kicad_pcb')) and all(
                pcb and not pcb.startswith(self.rel(d) + '/') for _, pcb in gs)

        boards: list[Board] = []
        registry_gate: dict[int, str | None] = {}   # id(Revision) -> the registry's gate field
        names = {d.name for d in folders}
        for b in reg.get('boards', []):
            if not b.get('directory') or (b['directory'] not in names and b['directory'] not in reg.get('excluded_directories', [])):
                self._conflict(b.get('id'), 'registry_no_folder', f'registry board {b.get("id")} has no board folder; not listed')
        for d in folders:
            if gate_only(d):
                self._conflict(d.name, 'gate_only_folder', f'{d.name} holds only gate data; its gate shows on the revision it checks')
                continue
            e = entries.get(d.name, {})
            if not e and any(d.glob('cad/**/*.kicad_pcb')):
                self._conflict(d.name, 'unregistered_board', f'{d.name} has CAD but no registry entry (lifecycle unregistered)')
            revs: list[Revision] = []
            named = False
            for r in e.get('revisions', []) or []:
                proj = r.get('project')
                pcb = self.existing(d, proj + '.kicad_pcb') if proj else None
                named = named or bool(pcb)
                if proj and not pcb:
                    self._conflict(d.name, 'registry_pcb_missing', f'rev {r.get("revision")}: {proj}.kicad_pcb does not exist')
                bom = self.existing(d, r.get('bom'))
                if r.get('bom') and not bom:
                    self._conflict(d.name, 'registry_bom_missing', f'rev {r.get("revision")}: {r["bom"]} does not exist')
                rev = Revision(revision=r.get('revision'), state=r.get('state'), pcb=pcb,
                               sch=self.existing(d, proj + '.kicad_sch') if proj else None,
                               spec=self.existing(d, r.get('spec')), bom=bom)
                registry_gate[id(rev)] = r.get('gate')
                revs.append(rev)
            # Files the registry does not name show only for a board without a registered PCB (candidate and
            # placement copies beside a registered revision are not revisions).
            if not named:
                for pcb in sorted(d.glob('cad/**/*.kicad_pcb')):
                    if not any(part.startswith('.') for part in pcb.relative_to(d).parts):
                        revs.append(Revision(revision=None, state='unregistered', pcb=self.rel(pcb),
                                             sch=self.existing(pcb.parent, pcb.stem + '.kicad_sch')))
            boards.append(Board(id=e.get('id', d.name), directory=d.name, lifecycle=e.get('lifecycle') or 'unregistered',
                                kind=e.get('kind'), variant_of=e.get('variant_of'), revisions=revs))

        # Attach gates by PCB path.
        by_pcb = {r.pcb: (b, r) for b in boards for r in b.revisions if r.pcb}
        by_dir = {b.directory: b for b in boards}
        prefix = self.layout.boards_dir.rstrip('/') + '/'
        for d in folders:
            for g, pcb in gates_by_dir[d.name]:
                if pcb is None:
                    self._conflict(d.name, 'gate_pcb_missing', f'{g.name}/{g.config}: its project has no .kicad_pcb')
                    continue
                if pcb not in by_pcb:
                    owner = by_dir.get(pcb[len(prefix):].split('/', 1)[0]) if pcb.startswith(prefix) else None
                    if owner is None:
                        self._conflict(d.name, 'gate_no_board', f'{g.name}/{g.config} checks {pcb}, which is in no board folder')
                        continue
                    rev = Revision(revision=entries.get(d.name, {}).get('revision'), state='unregistered', pcb=pcb,
                                   sch=self.existing(self.root, pcb[:-len('.kicad_pcb')] + '.kicad_sch'))
                    owner.revisions.append(rev)
                    by_pcb[pcb] = (owner, rev)
                    self._conflict(owner.directory, 'gate_unregistered_revision',
                                   f'{g.name}/{g.config} checks {pcb}, which the registry does not list')
                by_pcb[pcb][1].gates.append(g)

        for b in boards:
            for r in b.revisions:
                r.gates.sort(key=lambda g: (g.config != self.layout.gate_file, g.name != b.directory, g.name, g.config))
                main = [g for g in r.gates if g.config == self.layout.gate_file]
                r.gate = main[0].name if main else None
                r.pipeline = self._pipeline(r.gate)
                rg = registry_gate.get(id(r))
                if rg and rg != r.gate:
                    self._conflict(b.directory, 'registry_gate_differs',
                                   f'rev {r.revision}: registry gate {rg!r}, gate.json gives {r.gate!r} (gate.json wins)')
                elif not rg and r.gate and id(r) in registry_gate:
                    self._conflict(b.directory, 'registry_gate_missing',
                                   f'rev {r.revision}: registry has no gate, gate.json gives {r.gate!r}')
        return boards

    # --- board.yaml

    def _from_board_file(self, directory: str, f: Path) -> Board:
        try:
            bf = BoardFile.model_validate(yaml.safe_load(f.read_text()) or {})
        except Exception as e:   # noqa: BLE001 - name the file
            raise ProjectError(f'{f}: {e}') from e
        d = self.boards_path / directory
        revs = []
        for r in bf.revisions:
            gates = [GateRef(name=g.name, config=g.config, variant=_variant(g.config)) for g in r.gates]
            pcb = self.existing(d, r.pcb)
            for name, raw in (('pcb', r.pcb), ('sch', r.sch), ('spec', r.spec), ('bom', r.bom)):
                if raw and not self.existing(d, raw):
                    self._conflict(directory, f'board_yaml_{name}_missing', f'rev {r.rev}: {raw} does not exist')
            for g in gates:
                cfg = self.boards_path / g.name / g.config
                got = self._gate_pcb(cfg.parent, cfg) if cfg.is_file() else None
                if got != pcb:
                    self._conflict(directory, 'board_yaml_gate_mismatch', f'rev {r.rev}: gate {g.name}/{g.config} checks {got}, not {pcb}')
            if r.gate and r.gate not in [g.name for g in gates if g.config == self.layout.gate_file]:
                self._conflict(directory, 'board_yaml_gate_unlisted', f'rev {r.rev}: gate {r.gate} is not in gates')
            revs.append(Revision(revision=r.rev, state=r.state, pcb=pcb, sch=self.existing(d, r.sch),
                                 spec=self.existing(d, r.spec), bom=self.existing(d, r.bom), gate=r.gate, gates=gates,
                                 pipeline=self.existing(self.root, r.pipeline)))
        return Board(id=bf.id, directory=directory, lifecycle=bf.lifecycle, kind=bf.kind, variant_of=bf.variant_of,
                     identity='board.yaml', revisions=revs)

    def board_file_for(self, b: Board) -> BoardFile:
        """The board.yaml content that reproduces `b` (paths relative to the board folder)."""
        d = (self.boards_path / b.directory).resolve()
        bp = self.boards_path.resolve()

        def rel(p: str | None) -> str | None:
            if not p:
                return None
            ap = (self.root / p).resolve()
            return str(ap.relative_to(d)) if d in ap.parents else str(Path('..') / ap.relative_to(bp))

        return BoardFile(id=b.id, lifecycle=b.lifecycle, kind=b.kind, variant_of=b.variant_of, revisions=[
            BoardFileRevision(rev=r.revision, state=r.state, pcb=rel(r.pcb), sch=rel(r.sch), spec=rel(r.spec),
                              bom=rel(r.bom), gate=r.gate, pipeline=r.pipeline,
                              gates=[BoardFileGate(name=g.name, config=g.config) for g in r.gates])
            for r in b.revisions])


def _variant(config: str) -> str | None:
    stem = config[:-len('.json')] if config.endswith('.json') else config
    return stem[len('gate-'):] if stem.startswith('gate-') else None


def dump_board_file(bf: BoardFile) -> str:
    """board.yaml text: empty fields left out, default gate config left out."""
    data = bf.model_dump(by_alias=True)
    for r in data['revisions']:
        for k in [k for k, v in r.items() if v in (None, []) and k != 'rev']:
            del r[k]
        for g in r.get('gates', []):
            if g.get('config') == 'gate.json':
                del g['config']
    for k in ('kind', 'variant_of'):
        if data.get(k) is None:
            del data[k]
    return yaml.safe_dump(data, sort_keys=False, allow_unicode=True)
