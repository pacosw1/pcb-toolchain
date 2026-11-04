#!/usr/bin/env python3
"""Pack original fabrication bytes deterministically; never replace an archive."""
from pathlib import Path
import sys
import zipfile


def pack(directory, destination):
    directory = Path(directory)
    files = sorted(path for path in directory.rglob('*') if path.is_file())
    if not files or any(path.is_symlink() for path in directory.rglob('*')):
        raise ValueError('fabrication input is empty or contains symbolic links')
    with zipfile.ZipFile(destination, 'x', compression=zipfile.ZIP_DEFLATED) as archive:
        for path in files:
            # ZIP's format starts at 1980; stable metadata makes unchanged inputs
            # produce the same archive hash. File contents remain unmodified.
            entry = zipfile.ZipInfo(path.relative_to(directory).as_posix(), (1980, 1, 1, 0, 0, 0))
            entry.compress_type = zipfile.ZIP_DEFLATED
            entry.create_system = 3
            entry.external_attr = 0o100644 << 16
            archive.writestr(entry, path.read_bytes())


if __name__ == '__main__':
    try:
        pack(*sys.argv[1:3])
        print('PASS: deterministic fabrication ZIP; original bytes preserved')
    except Exception as error:
        print('FAIL: fabrication packaging: ' + str(error), file=sys.stderr)
        raise SystemExit(1)
