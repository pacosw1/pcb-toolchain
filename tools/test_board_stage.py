import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from board_stage import Stage
import route_preview


class StageTests(unittest.TestCase):
    def test_save_invalidates_render_and_records_activity(self):
        with tempfile.TemporaryDirectory() as tmp:
            pcb = Path(tmp) / 'TEST.kicad_pcb'
            pcb.write_text('(kicad_pcb)')
            stage = Stage()
            stage.boards = {'TEST': pcb}
            stage.directory = Path(tmp)
            stage.scan()
            first = stage.request('TEST', 'pcb')
            pcb.write_text('(kicad_pcb)\n')
            stage.scan()
            second = stage.request('TEST', 'pcb')
            self.assertNotEqual(first['key'], second['key'])
            self.assertEqual(stage.state['events'][0]['board'], 'TEST')
            self.assertEqual(stage.state['events'][0]['view'], 'pcb')
            self.assertEqual(pcb.read_text(), '(kicad_pcb)\n')
            with self.assertRaises(ValueError):
                stage.request('../other', 'pcb')

    def test_schematic_save_changes_auto_follow_view(self):
        with tempfile.TemporaryDirectory() as tmp:
            pcb = Path(tmp) / 'TEST.kicad_pcb'
            pcb.write_text('(kicad_pcb)')
            stage = Stage()
            stage.boards, stage.directory = {'TEST': pcb}, Path(tmp)
            stage.scan()
            pcb.with_suffix('.kicad_sch').write_text('(kicad_sch)')
            stage.scan()
            self.assertEqual(stage.state['boards'][0]['view'], 'sch')

    def test_final_candidate_snapshot_is_published_atomically(self):
        with tempfile.TemporaryDirectory() as tmp:
            work = Path(tmp)
            (work / 'board.ses').write_bytes(b'(session final)')
            data = dict(work=tmp, preview=str(work / 'live.ses'), status='routing')
            status = work / 'status.json'
            route_preview.finish(status, data, 'candidate saved')
            self.assertEqual((work / 'live.ses').read_bytes(), b'(session final)')
            self.assertEqual(json.loads(status.read_text())['status'], 'candidate saved')


if __name__ == '__main__':
    unittest.main()
