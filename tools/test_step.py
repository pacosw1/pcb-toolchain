#!/usr/bin/env python3
"""Tests for tools/step.py on a temporary git repository with a fake kicad-cli (no KiCad needed).

  python3 tools/test_step.py
"""
import json
import os
import pathlib
import subprocess
import sys
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
STEP = os.path.join(HERE, 'step.py')
FAKE_CLI = '''#!/usr/bin/env python3
import shutil, sys, os
shutil.copy(os.environ['FAKE_DRC'], sys.argv[sys.argv.index('-o') + 1])
'''
CLEAN = {'violations': [{'type': 'silk_overlap', 'severity': 'warning', 'items': [{'description': 'x'}]},
                        {'type': 'clearance', 'severity': 'error', 'items': [{'description': 'Track [A] on F.Cu'}]}],
         'unconnected_items': [{'items': [{'description': 'Pad 1 [A]'}]}, {'items': [{'description': 'Pad 2 [B]'}]}],
         'schematic_parity': []}


def git(repo, *args):
    return subprocess.run(['git', '-C', repo, *args], capture_output=True, text=True, check=True).stdout


class StepTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.repo = os.path.join(self.tmp.name, 'repo')
        self.proj = os.path.join(self.repo, 'boards', 'X')
        os.makedirs(self.proj)
        git(self.repo, 'init', '-q')
        git(self.repo, 'config', 'user.email', 't@t')
        git(self.repo, 'config', 'user.name', 't')
        for name, text in (('X.kicad_pcb', 'pcb v1\n'), ('X.kicad_sch', 'sch v1\n'), ('X.kicad_pro', '{}\n'),
                           ('../../other.txt', 'other v1\n'), ('../../staged.txt', 's v1\n')):
            pathlib.Path(self.proj, name).write_text(text)
        git(self.repo, 'add', '.')
        git(self.repo, 'commit', '-q', '-m', 'init')
        self.cli = os.path.join(self.tmp.name, 'kicad-cli')
        pathlib.Path(self.cli).write_text(FAKE_CLI)
        os.chmod(self.cli, 0o755)
        self.drc = os.path.join(self.tmp.name, 'drc.json')
        self.set_drc(CLEAN)

    def tearDown(self):
        self.tmp.cleanup()

    def set_drc(self, d):
        pathlib.Path(self.drc).write_text(json.dumps(d))

    def run_step(self, *args):
        env = dict(os.environ, STEP_KICAD_CLI=self.cli, FAKE_DRC=self.drc)
        return subprocess.run([sys.executable, STEP, *args], capture_output=True, text=True, cwd=self.repo, env=env)

    def board(self):
        return os.path.join(self.proj, 'X.kicad_pcb')

    def test_rollback_restores_only_the_board_files_and_keeps_the_index(self):
        r = self.run_step('begin', self.board())
        self.assertEqual(r.returncode, 0, r.stderr)
        pathlib.Path(self.proj, 'X.kicad_pcb').write_text('pcb broken\n')
        pathlib.Path(self.repo, 'other.txt').write_text('other v2\n')
        pathlib.Path(self.repo, 'staged.txt').write_text('s v2\n')
        git(self.repo, 'add', 'staged.txt')
        r = self.run_step('rollback', self.board())
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertEqual(pathlib.Path(self.proj, 'X.kicad_pcb').read_text(), 'pcb v1\n')
        self.assertEqual(pathlib.Path(self.repo, 'other.txt').read_text(), 'other v2\n')
        self.assertEqual(git(self.repo, 'diff', '--cached', '--name-only'), 'staged.txt\n')
        self.assertIn('restored 1 files', r.stdout)

    def test_rollback_restores_an_uncommitted_begin_state(self):
        pathlib.Path(self.proj, 'X.kicad_sch').write_text('sch dirty\n')
        self.run_step('begin', self.proj)
        pathlib.Path(self.proj, 'X.kicad_sch').write_text('sch worse\n')
        self.run_step('rollback', self.proj)
        self.assertEqual(pathlib.Path(self.proj, 'X.kicad_sch').read_text(), 'sch dirty\n')

    def test_rollback_without_begin_fails(self):
        r = self.run_step('rollback', self.board())
        self.assertNotEqual(r.returncode, 0)
        self.assertIn('no begin', r.stderr)

    def test_check_passes_on_the_same_drc(self):
        self.run_step('begin', self.board())
        r = self.run_step('check', self.board(), '--gate', 'true')
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
        self.assertIn('PASS', r.stdout)

    def test_check_fails_on_a_new_error(self):
        self.run_step('begin', self.board())
        worse = json.loads(json.dumps(CLEAN))
        worse['violations'].append({'type': 'clearance', 'severity': 'error', 'items': [{'description': 'Via [B]'}]})
        self.set_drc(worse)
        r = self.run_step('check', self.board())
        self.assertEqual(r.returncode, 1)
        self.assertIn('FAIL', r.stdout)
        self.assertIn('clearance: Via [B]', r.stdout)

    def test_check_fails_on_more_unconnected_or_parity(self):
        self.run_step('begin', self.board())
        worse = dict(CLEAN, unconnected_items=CLEAN['unconnected_items'] * 2, schematic_parity=[{'type': 'x'}])
        self.set_drc(worse)
        self.assertEqual(self.run_step('check', self.board()).returncode, 1)

    def test_check_fewer_unconnected_passes(self):
        self.run_step('begin', self.board())
        self.set_drc(dict(CLEAN, unconnected_items=CLEAN['unconnected_items'][:1]))
        self.assertEqual(self.run_step('check', self.board()).returncode, 0)

    def test_check_fails_on_the_gate(self):
        self.run_step('begin', self.board())
        r = self.run_step('check', self.board(), '--gate', 'false')
        self.assertEqual(r.returncode, 1)
        self.assertIn('gate exit 1', r.stdout)


if __name__ == '__main__':
    unittest.main()
