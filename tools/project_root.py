"""One resolver for the project (repository) root. The JS twin is tools/lib/env.mjs `projectRoot`.

Order: an explicit argument (for example `--project` or `--root`) > env IOT_LAB > the nearest parent of the
current directory that holds hardware-design/boards > the old file-relative root (the folder above tools/).
Use it for project data only. Imports of sibling tool modules stay file-relative.
"""
import os
from pathlib import Path

MARKER = Path('hardware-design') / 'boards'
FALLBACK = Path(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))


def find(start):
    """The nearest folder at or above START that holds hardware-design/boards, else None."""
    here = Path(os.path.abspath(start))
    for folder in (here, *here.parents):
        if (folder / MARKER).is_dir():
            return folder
    return None


def root(explicit=None, environ=None, cwd=None):
    if explicit:
        return Path(os.path.abspath(explicit))
    value = (os.environ if environ is None else environ).get('IOT_LAB')
    if value:
        return Path(os.path.abspath(value))
    try:
        found = find(cwd if cwd is not None else os.getcwd())
    except OSError:
        found = None
    return found or FALLBACK


def root_str(explicit=None):
    return str(root(explicit))
