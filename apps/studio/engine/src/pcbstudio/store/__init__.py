"""Engine caches outside the project tree (never committed)."""
from __future__ import annotations

import os
import sys
from pathlib import Path


def cache_dir() -> Path:
    """`$PCBSTUDIO_CACHE`, else the OS user cache folder + /pcbstudio."""
    env = os.environ.get('PCBSTUDIO_CACHE')
    if env:
        return Path(env).expanduser()
    if sys.platform == 'darwin':
        return Path.home() / 'Library/Caches/pcbstudio'
    return Path(os.environ.get('XDG_CACHE_HOME', Path.home() / '.cache')) / 'pcbstudio'
