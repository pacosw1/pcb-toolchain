"""Exit a pcbnew script without the interpreter shutdown.

KiCad's bundled Python 3.9 can crash in Py_FinalizeEx (EXC_BAD_ACCESS in
PyGC_Collect) when it frees pcbnew SWIG objects. A gate that passed then ends
with a crash code and a "Python quit unexpectedly" dialog. hard_exit runs the
command, runs the atexit handlers (the fd-2 noise filter), flushes, and calls
os._exit with the real code. Use it only in the `__main__` path.
"""
import atexit
import os
import sys
import traceback


def exit_code(fn):
    """Run fn and return its exit code, as the interpreter would give it. Does not exit."""
    try:
        r = fn()
    except SystemExit as e:
        if e.code is None or isinstance(e.code, int):
            return e.code or 0
        print(e.code, file=sys.stderr)
        return 1
    except BaseException:
        traceback.print_exc()
        return 1
    return r if isinstance(r, int) else 0


def hard_exit(fn):
    code = exit_code(fn)
    atexit._run_exitfuncs()  # os._exit skips atexit: pass on the filtered fd-2 output first
    sys.stdout.flush()
    sys.stderr.flush()
    os._exit(code)
