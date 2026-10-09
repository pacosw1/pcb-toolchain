import copy
import os
from pathlib import Path
import tempfile
import unittest

import import_pose_guard as guard


class PoseGuardTests(unittest.TestCase):
    def setUp(self):
        self.before = {'u': dict(ref='LOCKED', position=(89999999, -10), angle=45.,
                                layer=0, locked=True, pads={
            'p': dict(number='1', net='P', netcode=2, layers='01', angle=45.,
                      position=(90001234, 25))})}

    def translated(self, dx=1, dy=0):
        value = copy.deepcopy(self.before)
        value['u']['position'] = tuple(a+b for a,b in zip(value['u']['position'], (dx,dy)))
        value['u']['pads']['p']['position'] = tuple(a+b for a,b in zip(value['u']['pads']['p']['position'], (dx,dy)))
        return value

    def test_locked_rounding_and_unchanged_are_accepted(self):
        self.assertEqual(guard.restoration_plan(self.before, self.translated(), 100),
                         {'u': self.before['u']['position']})
        self.assertEqual(guard.restoration_plan(self.before, self.before, 100), {})

    def test_larger_and_non_rounding_translations_reject(self):
        for dx in (2, 101, 1000000):
            with self.assertRaises(ValueError):
                guard.restoration_plan(self.before, self.translated(dx), 100)
        with self.assertRaises(ValueError):
            guard.restoration_plan(self.before, self.translated(1, 11), 100)
        old = copy.deepcopy(self.before)
        old['u']['position'] = (50, 0)
        new = copy.deepcopy(old)
        new['u']['position'] = (100, 0)
        new['u']['pads']['p']['position'] = (old['u']['pads']['p']['position'][0]+50, 25)
        with self.assertRaises(ValueError):
            guard.restoration_plan(old, new, 100)

    def test_rotation_layer_lock_reference_and_ids_reject(self):
        for field, value in [('angle', 90.), ('layer', 31), ('locked', False), ('ref', 'other')]:
            new = self.translated()
            new['u'][field] = value
            with self.assertRaises(ValueError):
                guard.restoration_plan(self.before, new, 100)
        for new in ({}, dict(self.before, unexpected=self.before['u'])):
            with self.assertRaises(ValueError):
                guard.restoration_plan(self.before, new, 100)

    def test_pad_identity_and_independent_movement_reject(self):
        for field, value in [('number','2'), ('net','Q'), ('netcode',3),
                             ('layers','10'), ('angle',90.), ('position',(1,2))]:
            new = self.translated()
            new['u']['pads']['p'][field] = value
            with self.assertRaises(ValueError):
                guard.restoration_plan(self.before, new, 100)
        new = self.translated()
        new['u']['pads'] = {}
        with self.assertRaises(ValueError):
            guard.restoration_plan(self.before, new, 100)

    def test_declared_grid_is_matched_and_fail_closed(self):
        with tempfile.TemporaryDirectory() as td:
            a,b = Path(td)/'a',Path(td)/'b'
            a.write_text('(resolution um 10)')
            b.write_text('(resolution um 10)')
            self.assertEqual(guard.grid_nm(a,b),100)
            for text in ('(resolution um 1)', '(resolution mm 10)', '',
                         '(resolution um 10)(resolution um 1)', '(resolution um 3)'):
                b.write_text(text)
                with self.assertRaises(ValueError):
                    guard.grid_nm(a,b)

class NativePoseGuardTests(unittest.TestCase):
    @unittest.skipUnless(os.environ.get('IMPORT_POSE_FIXTURE'), 'retained native checkpoint required')
    def test_native_retained_ses_restores_exact_locked_poses(self):
        import pcbnew
        job = Path(os.environ['IMPORT_POSE_FIXTURE'])
        board = pcbnew.LoadBoard(str(job/'base.kicad_pcb'))
        before = guard.snapshot(board)
        for track in board.GetTracks():
            track.SetLocked(True)
        self.assertTrue(pcbnew.ImportSpecctraSES(board, str(job/'board.ses')))
        changes = guard.restore(board, before, guard.grid_nm(job/'board.dsn',job/'board.ses'))
        self.assertEqual({row['ref'] for row in changes}, {'TP14','D22','R56','C36','C4','R50'})
        self.assertEqual(guard.snapshot(board), before)
        with tempfile.TemporaryDirectory() as td:
            path = str(Path(td)/'roundtrip.kicad_pcb')
            pcbnew.SaveBoard(path,board)
            self.assertEqual(guard.snapshot(pcbnew.LoadBoard(path)), before)


if __name__ == '__main__':
    unittest.main()
