"""Engine API methods. The desktop app and (phase 4) the agent's MCP server call the same registry."""
from __future__ import annotations

import platform
import shutil
import subprocess
import time

from . import __version__, parts
from .kicad import board as kboard
from .project import Project
from .rpc import Registry
from .runs import runs

registry = Registry()
_started = time.time()
_project: Project | None = None


@registry.method('engine.ping')
def ping() -> dict:
    return {'ok': True, 'uptime_s': round(time.time() - _started, 3)}


@registry.method('engine.info')
def info() -> dict:
    return {'version': __version__, 'python': platform.python_version(), 'methods': registry.names(),
            'kicad_cli': _kicad_cli_version()}


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


@registry.method('run.list')
def run_list() -> list[dict]:
    return [r.summary() for r in runs.runs.values()]


@registry.method('run.get')
def run_get(id: str, after: int = 0) -> dict:
    r = runs.runs[id]
    return {'summary': r.summary(), 'events': r.events[after:], 'stderr': r.stderr[-50:], 'end': r.end}


@registry.method('run.cancel')
def run_cancel(id: str) -> dict:
    return runs.cancel(id)


def _kicad_cli_version() -> str | None:
    exe = shutil.which('kicad-cli')
    if not exe:
        return None
    try:
        return subprocess.run([exe, 'version'], capture_output=True, text=True, timeout=10).stdout.strip() or None
    except (OSError, subprocess.TimeoutExpired):
        return None
