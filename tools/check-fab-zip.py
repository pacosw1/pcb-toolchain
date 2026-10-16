#!/usr/bin/env python3
"""Verify the exact files netchecked in a ZIP equal the staged fabrication set."""
import hashlib
import json
from pathlib import Path
import sys
import zipfile


def verify(archive, directory):
    directory = Path(directory)
    expected = {}
    for path in directory.rglob('*'):
        if path.is_symlink():
            raise ValueError('staged fabrication symlink')
        if path.is_file():
            expected[path.relative_to(directory).as_posix()] = hashlib.sha256(path.read_bytes()).hexdigest()
    with zipfile.ZipFile(archive) as source:
        if source.testzip() is not None:
            raise ValueError('fabrication ZIP CRC failure')
        actual = {}
        for entry in source.infolist():
            if entry.is_dir():
                continue
            name = entry.filename
            if name in actual or name.startswith('/') or any(part in ('', '.', '..') for part in name.split('/')):
                raise ValueError('duplicate/unsafe fabrication ZIP entry')
            actual[name] = hashlib.sha256(source.read(entry)).hexdigest()
    if not expected or actual != expected:
        raise ValueError('fabrication ZIP differs from staged Gerbers/drill files')
    return dict(status='passed',files=len(actual),sha256=hashlib.sha256(Path(archive).read_bytes()).hexdigest())


if __name__ == '__main__':
    try:
        print(json.dumps(verify(*sys.argv[1:3])))
    except Exception as error:
        print('FAIL: fabrication ZIP: ' + str(error), file=sys.stderr)
        raise SystemExit(1)
