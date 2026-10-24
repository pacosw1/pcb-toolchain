"""Engine API methods. The desktop app and (phase 4) the agent's MCP server call the same registry."""
from __future__ import annotations

import platform
import shutil
import subprocess
import time

from . import __version__
from .kicad import board as kboard
from .project import Project
from .rpc import Registry

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


def _kicad_cli_version() -> str | None:
    exe = shutil.which('kicad-cli')
    if not exe:
        return None
    try:
        return subprocess.run([exe, 'version'], capture_output=True, text=True, timeout=10).stdout.strip() or None
    except (OSError, subprocess.TimeoutExpired):
        return None
