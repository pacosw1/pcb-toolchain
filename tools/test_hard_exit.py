#!/usr/bin/env python3
"""Unit tests for tools/hard_exit.py (the exit-code mapping; no os._exit).

  python3 tools/test_hard_exit.py
"""
import contextlib
import io
import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import hard_exit as he


def raises(exc):
    def fn():
        raise exc
    return fn


class ExitCodeTest(unittest.TestCase):
    def test_normal_return(self):
        self.assertEqual(he.exit_code(lambda: None), 0)
        self.assertEqual(he.exit_code(lambda: 3), 3)

    def test_system_exit_int_and_none(self):
        self.assertEqual(he.exit_code(raises(SystemExit(1))), 1)
        self.assertEqual(he.exit_code(raises(SystemExit(0))), 0)
        self.assertEqual(he.exit_code(raises(SystemExit(None))), 0)

    def test_system_exit_str_prints_to_stderr_and_gives_1(self):
        err = io.StringIO()
        with contextlib.redirect_stderr(err):
            self.assertEqual(he.exit_code(raises(SystemExit('cannot load x'))), 1)
        self.assertEqual(err.getvalue(), 'cannot load x\n')

    def test_uncaught_error_prints_traceback_and_gives_1(self):
        err = io.StringIO()
        with contextlib.redirect_stderr(err):
            self.assertEqual(he.exit_code(raises(ValueError('boom'))), 1)
        self.assertIn('ValueError: boom', err.getvalue())


if __name__ == '__main__':
    unittest.main()
