"""Guard native copper preservation and scoped proposal extraction."""
import copy
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

from pcb_search.contracts import fingerprint
from pcb_search.native_srj import geometry_digest, netclass_rules, selected_route_proposal, source_set


class NativeContracts(unittest.TestCase):
    def test_netclass_values_are_explicit_and_composite_classes_abstain(self):
        p = {'net_settings': {'classes': [dict(name='PWR', track_width=.25,
               clearance=.15, via_diameter=.6, via_drill=.3)]}}
        self.assertEqual(netclass_rules(p, {'PWR'})['PWR']['track_width'], .25)
        with self.assertRaises(ValueError):
            netclass_rules(p, {'PWR,Default'})
        del p['net_settings']['classes'][0]['via_drill']
        with self.assertRaises(KeyError):
            netclass_rules(p, {'PWR'})

    def test_only_new_requested_net_copper_is_projected_and_originals_restored(self):
        old = dict(pcb_trace_id='old', connection_name='GND', route=[])
        new = dict(pcb_trace_id='new', connection_name='A', route=[])
        s = dict(traces=[old]); r = dict(status='model_mismatch', qualified=False,
            input_sha256=fingerprint(s), changed_fields=['preserved trace:old'],
            output=dict(traces=[dict(old, route=[{'x': 5}]), new]))
        saved = copy.deepcopy(r)
        p = selected_route_proposal(s, r, ['A'])
        self.assertEqual(p['output']['traces'], [old, new])
        self.assertEqual(r, saved)
        self.assertFalse(p['qualified'])
        self.assertTrue(p['native_validation_required'])
        r['changed_fields'] = ['obstacles']
        with self.assertRaises(ValueError):
            selected_route_proposal(s, r, ['A'])
        r['changed_fields'] = []; r['output']['traces'][-1]['connection_name'] = 'B'
        with self.assertRaises(ValueError):
            selected_route_proposal(s, r, ['A'])

    def test_geometry_hash_detects_changes_to_placement_rules_and_retained_copper(self):
        root = '(kicad_pcb (version 1) (footprint "R" (at 1 2) (uuid "f")) (segment (width .25) (uuid "t")))'
        with tempfile.TemporaryDirectory() as d:
            a, b = Path(d)/'a', Path(d)/'b'; a.write_text(root)
            b.write_text(root[:-1] + '(segment (width .15) (uuid "new")))')
            self.assertEqual(geometry_digest(a), geometry_digest(b, ['new']))
            for change in (root.replace('(at 1 2)', '(at 2 2)'), root.replace('.25', '.15'),
                           root[:-1] + '(setup (clearance .1)))'):
                b.write_text(change)
                self.assertNotEqual(geometry_digest(a), geometry_digest(b))
            with self.assertRaises(ValueError):
                geometry_digest(a, ['f'])

    @unittest.skipUnless(os.environ.get('PCB_NATIVE_FIXTURE'), 'explicit isolated native ENV fixture required')
    def test_hole_clearance_does_not_falsely_seal_sensor_escape(self):
        from pcb_search.capacity import terminal_conflicts
        board = Path(os.environ['PCB_NATIVE_FIXTURE']).resolve()
        project = json.loads(board.with_suffix('.kicad_pro').read_text())
        with tempfile.TemporaryDirectory() as directory:
            folder = Path(directory)/'input'
            p = subprocess.run([sys.executable, '-m', 'pcb_search.native_srj', 'export', str(board),
                                str(folder), '--net', '/SCL'], capture_output=True, text=True, timeout=15)
            self.assertEqual(p.returncode, 0, p.stdout+p.stderr)
            srj = json.loads((folder/'srj.json').read_text())
            self.assertFalse(terminal_conflicts(srj))
            self.assertEqual(srj['minTraceToHoleEdgeClearance'],
                             project['board']['design_settings']['rules']['min_hole_clearance'])
            self.assertEqual(srj['defaultObstacleMargin'],
                             max(c['clearance'] for c in project['net_settings']['classes']))

    @unittest.skipUnless(os.environ.get('PCB_NATIVE_FIXTURE'), 'explicit isolated native ENV fixture required')
    def test_native_selected_net_round_trip_keeps_every_other_item(self):
        import pcbnew as pcb
        board = Path(os.environ['PCB_NATIVE_FIXTURE']).resolve()
        before = source_set(board)
        with tempfile.TemporaryDirectory() as directory:
            folder, dest = Path(directory)/'input', Path(directory)/'output'
            def native_command(*args):
                p = subprocess.run([sys.executable, '-m', 'pcb_search.native_srj', *map(str,args)],
                                   capture_output=True, text=True, timeout=15)
                self.assertEqual(p.returncode, 0, p.stdout + p.stderr)
            native_command('export', board, folder, '--net', '/V_GAS')
            self.assertTrue(json.loads((folder/'record.json').read_text())['removed_items'])
            srj = json.loads((folder/'srj.json').read_text())
            native = pcb.LoadBoard(str(board)); source_tracks = list(native.GetTracks())
            restored = []
            for t in source_tracks:
                if t.GetNetname() != '/V_GAS' or t.IsLocked():
                    continue
                self.assertIs(type(t), pcb.PCB_TRACK)
                restored.append(dict(type='pcb_trace', pcb_trace_id=t.m_Uuid.AsString(),
                    connection_name='/V_GAS', route=[dict(route_type='wire', x=pcb.ToMM(q.x),
                    y=pcb.ToMM(q.y), layer={pcb.F_Cu:'top',pcb.B_Cu:'bottom'}[t.GetLayer()],
                    width=pcb.ToMM(t.GetWidth())) for q in (t.GetStart(),t.GetEnd())]))
            response = dict(status='candidate', qualified=False, input_sha256=fingerprint(srj),
                            output=dict(srj, traces=srj['traces']+restored))
            path = Path(directory)/'proposal.json'; path.write_text(json.dumps(response))
            native_command('import', folder, path, dest)
            imported = json.loads((dest/'record.json').read_text())
            self.assertEqual(imported['added'], len(restored))
            self.assertEqual(imported['protected_geometry_sha256'], geometry_digest(folder/'input.kicad_pcb'))
            self.assertEqual(before, source_set(board))
            after = pcb.LoadBoard(str(dest/'candidate.kicad_pcb'))
            def copper(b):
                return sorted((t.GetNetname(),t.GetLayer(),t.GetWidth(),tuple(t.GetStart()),tuple(t.GetEnd()))
                              for t in b.GetTracks() if type(t) is pcb.PCB_TRACK)
            self.assertEqual(copper(native), copper(after))


if __name__ == '__main__':
    unittest.main()
