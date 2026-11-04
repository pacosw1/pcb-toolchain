#!/usr/bin/env python3
"""Repository-local entrypoint; no installation or third-party Python packages.

`tools/pcb --project DIR ...` sets the project root (exported as IOT_LAB to every child); see tools/project_root.py.
"""
import os
import sys

if len(sys.argv) > 2 and sys.argv[1] == '--project':
    os.environ['IOT_LAB'] = os.path.abspath(sys.argv[2])
    del sys.argv[1:3]
elif len(sys.argv) > 1 and sys.argv[1].startswith('--project='):
    os.environ['IOT_LAB'] = os.path.abspath(sys.argv[1].split('=', 1)[1])
    del sys.argv[1]

from pcb_cli import main  # noqa: E402

if __name__ == '__main__':
    raise SystemExit(main())
