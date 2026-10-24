"""Engine API methods. The desktop app and (phase 4) the agent's MCP server call the same registry."""
from __future__ import annotations

import asyncio
import hashlib
import platform
from pathlib import Path
import time

from . import __version__, parts
from .kicad import board as kboard
from .kicad import cli as kcli
from .project import Project
from .rpc import Registry
from .runs import routing_policy as route_policy, runs

registry = Registry()
_started = time.time()
_project: Project | None = None


@registry.method('engine.ping')
def ping() -> dict:
    return {'ok': True, 'uptime_s': round(time.time() - _started, 3)}


@registry.method('engine.info')
def info() -> dict:
    return {'version': __version__, 'python': platform.python_version(), 'methods': registry.names(),
            'kicad_cli': kcli.version()}


@registry.method('project.open')
def project_open(root: str) -> dict:
    global _project
    _project = Project(root)
    return {'root': str(_project.root), 'boards': _project.boards()}


@registry.method('board.geometry')
def board_geometry(pcb: str) -> dict:
    """`pcb` is project-relative (as listed by project.open)."""
    if _project is None:
        raise RuntimeError('no project open')
    path = _project.resolve(pcb)
    geo = kboard.load(path)
    geo['bbox'] = kboard.bbox(geo)
    geo['pcb'] = pcb
    return geo


@registry.method('board.bom')
def board_bom(pcb: str) -> dict:
    if _project is None:
        raise RuntimeError('no project open')
    return parts.bom(_project, pcb)


@registry.method('board.glb')
async def board_glb(pcb: str, out_dir: str) -> dict:
    """3D model (binary glTF) of a board with its part models (kicad.cli.export_glb); cached by the board file hash."""
    if _project is None:
        raise RuntimeError('no project open')
    path = _project.resolve(pcb)
    digest = hashlib.sha256(path.read_bytes()).hexdigest()[:20]
    out = Path(out_dir).expanduser() / f'{path.stem}-{digest}.glb'
    if out.is_file() and out.stat().st_size > 0:
        return {'path': str(out), 'cached': True, 'size': out.stat().st_size}
    res = await asyncio.to_thread(kcli.export_glb, path, out,
                                  defines={'IOT_LAB': str(_project.root), 'KIPRJMOD': str(path.parent)})
    return {**res, 'cached': False}


@registry.method('file.resolve')
def file_resolve(path: str) -> dict:
    """Absolute path of a project file (for the app's PDF viewer), refusing anything outside the project."""
    if _project is None:
        raise RuntimeError('no project open')
    p = _project.resolve(path)
    if not p.is_file():
        raise FileNotFoundError(path)
    return {'path': str(p), 'size': p.stat().st_size}


@registry.method('gate.check')
def gate_check(board: str, fresh: bool = True) -> dict:
    """Start `tools/pcb check BOARD` in the project; progress arrives as run.event / run.state notifications."""
    if _project is None:
        raise RuntimeError('no project open')
    return runs.start_check(_project.root, board, fresh).summary()


@registry.method('op.build')
def op_build(board: str, timeout_s: int | None = None) -> dict:
    """`tools/pcb build BOARD`: the board's own pipeline makes an isolated candidate and gates it. Canonical CAD
    changes only in run.adopt."""
    if _project is None:
        raise RuntimeError('no project open')
    return runs.start(_project.root, 'build', board, timeout_s=timeout_s).summary()


@registry.method('op.route')
def op_route(board: str, policy: dict, timeout_s: int | None = None) -> dict:
    """`tools/pcb route BOARD --router fastroute --spec POLICY.json`: Fastroute on an isolated candidate, then the
    complete fresh gate on it. `policy` is a full iot-lab.routing-policy.v1 object, or the short form
    {layers, nets?, passes, timeout_s, threads?, optimizer?}; no nets = every named net with pads on the board.
    `timeout_s` is the total CLI deadline (solver + verification), default router timeout + 600 s."""
    if _project is None:
        raise RuntimeError('no project open')
    if 'schema' not in policy:
        nets = list(policy.get('nets') or []) or _board_nets(board)
        policy = route_policy(layers=policy.get('layers') or ['F.Cu', 'B.Cu'], nets=nets,
                              passes=int(policy.get('passes', 40)), timeout_s=int(policy.get('timeout_s', 300)),
                              threads=int(policy.get('threads', 1)), optimizer=policy.get('optimizer', 'if-routed'))
    return runs.start(_project.root, 'route', board, policy=policy, timeout_s=timeout_s).summary()


def _board_nets(gate: str) -> list[str]:
    assert _project is not None
    pcbs = [r['pcb'] for b in _project.boards() for r in b['revisions'] if r.get('gate') == gate and r.get('pcb')]
    if not pcbs:
        raise ValueError(f'no board revision with gate {gate!r}; pass policy.nets')
    geo = kboard.load(_project.resolve(pcbs[0]))
    return sorted({p['net'] for f in geo['footprints'] for p in f['pads'] if p.get('net')})


@registry.method('run.candidate')
def run_candidate(id: str) -> dict:
    """The candidate board of a build/route run: project-relative `pcb` (load it with board.geometry), the canonical
    `target` file adopt would replace, its gate `metrics`, `verified`, and whether run.adopt would be accepted."""
    r = runs.runs[id]
    c = r.candidate()
    if c is None:
        raise ValueError(f'run {id} has no candidate board ({r.op}, {r.state})')
    return {**c, 'id': id, 'run_id': r.run_id, 'state': r.state, 'adoptable': r.adoptable() is None,
            'not_adoptable_because': r.adoptable(), 'adoption': r.adoption}


@registry.method('run.adopt')
async def run_adopt(id: str) -> dict:
    """`tools/pcb adopt RUN_ID --json` (desktop only, on a user click; never in the web viewer or the agent)."""
    return await runs.adopt(id)


@registry.method('run.list')
def run_list() -> list[dict]:
    return [r.summary() for r in runs.runs.values()]


@registry.method('run.get')
def run_get(id: str, after: int = 0) -> dict:
    r = runs.runs[id]
    return {'summary': r.summary(), 'events': r.events[after:], 'stderr': r.stderr[-50:], 'end': r.end}


@registry.method('run.findings')
def run_findings(id: str) -> dict:
    if _project is None:
        raise RuntimeError('no project open')
    return runs.findings(id, _project.root)


@registry.method('run.cancel')
def run_cancel(id: str) -> dict:
    return runs.cancel(id)
