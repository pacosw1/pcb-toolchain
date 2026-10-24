"""Engine API methods (phase 1: health only)."""
from __future__ import annotations

import platform
import shutil
import subprocess
import time

from . import __version__
from .rpc import Registry

registry = Registry()
_started = time.time()


@registry.method('engine.ping')
def ping() -> dict:
    return {'ok': True, 'uptime_s': round(time.time() - _started, 3)}


@registry.method('engine.info')
def info() -> dict:
    return {'version': __version__, 'python': platform.python_version(), 'methods': registry.names(),
            'kicad_cli': _kicad_cli_version()}


def _kicad_cli_version() -> str | None:
    exe = shutil.which('kicad-cli')
    if not exe:
        return None
    try:
        return subprocess.run([exe, 'version'], capture_output=True, text=True, timeout=10).stdout.strip() or None
    except (OSError, subprocess.TimeoutExpired):
        return None
