import importlib.util
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('progress', Path(__file__).with_name('progress.py'))
p = importlib.util.module_from_spec(spec)
spec.loader.exec_module(p)


class ProgressTests(unittest.TestCase):
    def test_history_ignores_partial_and_failed_rows(self):
        with tempfile.TemporaryDirectory() as tmp:
            log = Path(tmp) / 'log.csv'
            log.write_text('time,board,unconnected,errors,parity\n2026-09-26 08:00:00,BASE-PWR,85,1,0\n2026-09-26 08:01:00,BASE-PWR,?,?,?\npartial\n')
            with patch.object(p, 'LOG', log):
                self.assertEqual(p.history()['BASE-PWR'][0]['counts'], (85, 1, 0))
                self.assertEqual(len(p.history()['BASE-PWR']), 1)
                p.append_result('BASE-PWR', (80, 0, 0))
                self.assertEqual(p.history()['BASE-PWR'][-1]['counts'], (80, 0, 0))

    def test_fingerprint_tracks_schematic_and_ignores_reports(self):
        with tempfile.TemporaryDirectory() as tmp:
            pcb = Path(tmp) / 'board.kicad_pcb'
            pcb.write_text('board')
            original = p.fingerprint(pcb)
            (pcb.parent / 'report.json').write_text('{}')
            self.assertEqual(p.fingerprint(pcb), original)
            (pcb.parent / 'board.kicad_sch').write_text('schematic')
            self.assertNotEqual(p.fingerprint(pcb), original)

    def test_process_attribution_requires_board_and_excludes_own_drc(self):
        lines = ['python tools/freeroute.py /BASE-PWR/BASE-PWR.kicad_pcb',
                 'kicad-cli pcb drc /tmp/board-progress-xyz/INPUT-4D2A/INPUT-4D2A.kicad_pcb',
                 'java -jar freerouting.jar /tmp/board.dsn']
        self.assertEqual(p.observed_activity(lines, 'BASE-PWR'), 'Routing process observed')
        self.assertEqual(p.observed_activity(lines, 'INPUT-4D2A'), '')
        self.assertEqual(p.observed_activity(lines, 'BACKUP-POWER'), '')

    def test_check_failure_does_not_become_zero_errors(self):
        with tempfile.TemporaryDirectory() as tmp:
            pcb = Path(tmp) / 'board.kicad_pcb'
            pcb.write_text('board')
            with patch.object(p.subprocess, 'run') as run:
                run.return_value.returncode = 1
                with self.assertRaisesRegex(ValueError, 'DRC failed'):
                    p.check_board(pcb)
            self.assertEqual(pcb.read_text(), 'board')

    def test_stale_report_and_changed_source_are_visible(self):
        with tempfile.TemporaryDirectory() as tmp:
            folder = Path(tmp)
            pcb = folder / 'board.kicad_pcb'
            pcb.write_text('before')
            fingerprint = p.fingerprint(pcb)
            pcb.write_text('after')
            (folder / 'BASE-PWR.json').write_text(p.json.dumps(dict(time=p.time.time() - 600, agent='router', task='Routing power')))
            with patch.object(p, 'state_dir', return_value=folder), patch.object(p, 'command', return_value=''), patch.object(p, 'history', return_value={b: [] for b in p.BOARDS}):
                dashboard = p.Dashboard(120)
                dashboard.pcbs = {b: pcb for b in p.BOARDS}
                dashboard.results['BASE-PWR'] = dict(time=p.time.time(), counts=(85, 1, 0), fingerprint=fingerprint)
                rows = dashboard.model()
                self.assertIn('STALE report', rows[1]['activity'])
                self.assertIn('FILE CHANGED', rows[1]['freshness'])
                detail = '\n'.join(x for x, _ in dashboard.lines(rows, 1, True))
                self.assertIn('BASE-PWR', detail)
                self.assertNotIn('BACKUP-POWER', detail)
                self.assertIn('Routing power', detail)


if __name__ == '__main__':
    unittest.main()
