#!/usr/bin/env python3
"""CIP 830 audit regression cases for tools/fastroute_job.py (run with the KiCad bundled Python: it imports pcbnew).

#815 (comment 2878): plane_via_clearance_repair must not delete a locked via/stub or one that is in the input board.
#803 (comment 2879): the stall stop interrupts only the owned router handle once; it never searches processes by name.
"""
import os
import sys
import tempfile
import threading
import unittest
from unittest import mock

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import fastroute_job as fj  # noqa: E402


class P:
    def __init__(self, x, y):
        self.x, self.y = x, y

    def __eq__(self, o):
        return (self.x, self.y) == (o.x, o.y)


class Item:
    def __init__(self, cls, net, a, b=None, locked=False):
        self.cls, self.net, self.a, self.b, self.locked = cls, net, a, b or a, locked

    def GetClass(self):
        return self.cls

    def GetNetname(self):
        return self.net

    def GetLayer(self):
        return 0

    def GetStart(self):
        return self.a

    def GetEnd(self):
        return self.b

    def GetPosition(self):
        return self.a

    def IsLocked(self):
        return self.locked


class Pad:
    def __init__(self, net, pos):
        self.net, self.pos = net, pos

    def GetNetname(self):
        return self.net

    def GetPosition(self):
        return self.pos

    def GetNumber(self):
        return '1'


class FP:
    def __init__(self, pads):
        self.pads = pads

    def GetReference(self):
        return 'U1'

    def Pads(self):
        return self.pads


class Board:
    def __init__(self, items, pads):
        self.items, self.fps, self.deleted = items, [FP(pads)], []

    def GetTracks(self):
        return [t for t in self.items if t not in self.deleted]

    def GetFootprints(self):
        return self.fps

    def Delete(self, t):
        self.deleted.append(t)


def fixture(locked):
    via = Item('PCB_VIA', 'GND', P(1_000_000, 1_000_000), locked=locked)
    stub = Item('PCB_TRACK', 'GND', P(0, 0), P(1_000_000, 1_000_000), locked=locked)
    board = Board([via, stub], [Pad('GND', P(0, 0))])
    drc = {'violations': [{'severity': 'error', 'type': 'clearance',
                           'items': [{'description': 'Via [GND] on F.Cu - B.Cu', 'pos': {'x': 1.0, 'y': 1.0}}]}]}
    return board, drc, via, stub


class Repair815(unittest.TestCase):
    def run_repair(self, board, drc, preserve=frozenset()):
        with mock.patch.object(fj.pcbnew, 'LoadBoard', return_value=board), \
                mock.patch.object(fj.pcbnew, 'SaveBoard') as save:
            todo = fj.plane_via_clearance_repair('x.kicad_pcb', drc, {'GND'}, preserve=preserve)
        return todo, save

    def test_locked_source_copper_is_refused(self):
        board, drc, _, _ = fixture(locked=True)
        todo, save = self.run_repair(board, drc)
        self.assertEqual(board.deleted, [])
        self.assertEqual(todo, {})
        save.assert_not_called()

    def test_unlocked_input_copper_is_refused(self):
        board, drc, via, stub = fixture(locked=False)
        todo, save = self.run_repair(board, drc, preserve={fj.copper_key(via), fj.copper_key(stub)})
        self.assertEqual(board.deleted, [])
        save.assert_not_called()

    def test_job_created_via_is_repaired(self):
        board, drc, via, stub = fixture(locked=False)
        todo, save = self.run_repair(board, drc)
        self.assertEqual(set(board.deleted), {via, stub})
        self.assertEqual(todo, {'GND': {'U1.1'}})
        save.assert_called_once()

    def test_missing_source_copper_is_reported(self):
        board, _, via, stub = fixture(locked=False)
        keys = {fj.copper_key(via), fj.copper_key(stub)}
        board.deleted.append(via)
        with mock.patch.object(fj.pcbnew, 'LoadBoard', return_value=board):
            self.assertEqual(fj.missing_source_copper('x', keys), [fj.copper_key(via)])


class Stall803(unittest.TestCase):
    def watch(self, owner, lines):
        with tempfile.TemporaryDirectory() as d:
            log = os.path.join(d, 'run.log')
            open(log, 'w').write('\n'.join(lines) + '\n')
            stop, result = threading.Event(), {}
            progress = mock.Mock()
            with mock.patch.object(fj.subprocess, 'run') as run, mock.patch('os.kill') as kill:
                t = threading.Thread(target=fj._router_watch, args=(log, 2, owner, stop, result, progress, 'route'))
                t.start()
                t.join(5)
                stop.set()
                t.join(5)
            return result, run, kill

    def lines(self):
        return ['    0.1 INFO  Auto-routing stage started with baseline score 1 for 3 unrouted items.'] + [
            f'    0.{i} INFO  Auto-routing pass #{i} was completed in 0.1 seconds with score 1 (3 unrouted and 0 '
            f'violations) (routed 0, failed 1, ripped 0).' for i in range(1, 6)]

    def test_stall_interrupts_only_the_owned_handle_once(self):
        proc = mock.Mock()
        proc.interrupt.return_value = True
        result, run, kill = self.watch({'proc': proc}, self.lines())
        self.assertTrue(result['interrupt_attempted'])
        self.assertIs(result['interrupt_acknowledged'], True)
        self.assertEqual(result.get('how'), 'owned-stage interrupt requested')
        proc.interrupt.assert_called_once()
        run.assert_not_called()      # no pgrep / process search
        kill.assert_not_called()     # no PID signalled directly

    def test_no_owned_handle_signals_nothing(self):
        result, run, kill = self.watch({}, self.lines())
        self.assertFalse(result['interrupt_attempted'])
        self.assertIsNone(result['interrupt_acknowledged'])
        run.assert_not_called()
        kill.assert_not_called()


if __name__ == '__main__':
    unittest.main()
