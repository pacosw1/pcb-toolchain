#!/usr/bin/env python3
"""Atomically rename one release stage without replacing any existing entry."""
import ctypes
import os
import sys


def publish(source, destination):
    library = ctypes.CDLL(None, use_errno=True)
    if sys.platform == 'linux':
        rename = library.renameat2
        rename.argtypes = (ctypes.c_int, ctypes.c_char_p, ctypes.c_int, ctypes.c_char_p, ctypes.c_uint)
        result = rename(-100, os.fsencode(source), -100, os.fsencode(destination), 1)  # AT_FDCWD, RENAME_NOREPLACE
    elif sys.platform == 'darwin':
        rename = library.renamex_np
        rename.argtypes = (ctypes.c_char_p, ctypes.c_char_p, ctypes.c_uint)
        result = rename(os.fsencode(source), os.fsencode(destination), 4)  # RENAME_EXCL
    else:
        raise RuntimeError('release publication requires macOS or Linux exclusive rename')
    if result:
        code = ctypes.get_errno()
        raise OSError(code, os.strerror(code), destination)


if __name__ == '__main__':
    try:
        publish(*sys.argv[1:3])
    except Exception as error:
        print('FAIL: release publication: ' + str(error), file=sys.stderr)
        raise SystemExit(1)
