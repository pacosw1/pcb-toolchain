import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import time
import types
import unittest
from unittest.mock import patch

import thermal_repair as tr


def fault(pad='p', ref='U16', net='GND', zone='z'):
    return dict(type='starved_thermal', severity='error', items=[
        dict(uuid=zone, description="Zone 'ground' [GND] on F.Cu"),
        dict(uuid=pad, description=f'Pad 2 [{net}] of {ref} on F.Cu')])


class ThermalDetectionTests(unittest.TestCase):
    def test_uuid_and_identity_required_not_only_text(self):
        d=dict(violations=[fault()])
        self.assertEqual(tr.thermal_targets(d, {'p':('U16','2','GND')}, {'z':'GND'}, {'GND'}), {'GND':['U16.2']})
        for pads,zones in [({}, {'z':'GND'}), ({'p':('U4','2','GND')},{'z':'GND'}),
                           ({'p':('U16','2','GND')},{'z':'VDD'})]:
            with self.assertRaises(ValueError): tr.thermal_targets(d,pads,zones,{'GND'})
        self.assertEqual(tr.thermal_targets(d,{'p':('U16','2','GND')},{'z':'GND'},{'/CAN_GND'}),{})

    def test_transaction_rejects_new_errors_regression_and_policy_change(self):
        before=dict(violations=[fault()],unconnected_items=[{}],schematic_parity=[])
        after=dict(violations=[],unconnected_items=[],schematic_parity=[])
        original={('setup','setup'):['setup',['min_spokes','2']]}
        self.assertTrue(tr.acceptable(before,after,original,dict(original))[0])
        cases=[dict(after,violations=[dict(type='clearance',severity='error',items=[])]),
               dict(after,schematic_parity=[{}]),dict(after,unconnected_items=[{},{}]),before]
        for candidate in cases:self.assertFalse(tr.acceptable(before,candidate,original,dict(original))[0])
        self.assertFalse(tr.acceptable(before,after,original,{('setup','setup'):['setup',['min_spokes','1']]} )[0])
        old_parity=dict(before,schematic_parity=[dict(type='net_mismatch',items=[dict(uuid='old',description='old net')])])
        new_parity=dict(after,schematic_parity=[dict(type='net_mismatch',items=[dict(uuid='new',description='new net')])])
        self.assertFalse(tr.acceptable(old_parity,new_parity,original,dict(original))[0])
        new_parity['schematic_parity'][0]['items'][0]['uuid']='old'
        self.assertFalse(tr.acceptable(old_parity,new_parity,original,dict(original))[0])

    def test_complete_immutable_native_nodes_and_fill_exclusion(self):
        with tempfile.TemporaryDirectory() as td:
            path=Path(td)/'board.kicad_pcb'
            path.write_text('(kicad_pcb (setup (min_spokes 2)) (footprint "U" (uuid f) (pad "2" (net 1 "GND"))) (zone (uuid z) (fill (thermal_gap .3) (thermal_bridge_width .4)) (filled_polygon (pts (xy 1 2)))) (segment (uuid s) (width .2)))')
            before=tr.immutable_board(path)
            path.write_text(path.read_text().replace('(xy 1 2)','(xy 3 4)'))
            self.assertEqual(before,tr.immutable_board(path))
            path.write_text(path.read_text().replace('thermal_gap .3','thermal_gap .2'))
            self.assertNotEqual(before,tr.immutable_board(path))

    def test_malformed_native_thermal_rejects(self):
        for items in ([],[{}],None,[dict(uuid='p',description='Pad 2 [GND] of U16 on F.Cu')]*2):
            with self.assertRaises(ValueError):
                tr.thermal_targets(dict(violations=[dict(fault(),items=items)]),{'p':('U16','2','GND')},{'z':'GND'},{'GND'})

    def test_parser_and_hierarchy_deadline_and_missing_sheet_fail_closed(self):
        with tempfile.TemporaryDirectory() as td:
            folder=Path(td);board=folder/'board.kicad_pcb';board.write_text('(kicad_pcb (setup))')
            with self.assertRaises(subprocess.TimeoutExpired): tr.immutable_board(board,tr.lean.now()-1)
            root=folder/'board.kicad_sch';root.write_text('(kicad_sch (property "Sheetfile" "blocks/child.kicad_sch"))')
            destination=folder/'copy';destination.mkdir()
            with self.assertRaises(ValueError):tr.copy_hierarchy(board,destination,tr.lean.now()+1)
            (folder/'blocks').mkdir();(folder/'blocks/child.kicad_sch').write_text('(kicad_sch)')
            self.assertEqual(tr.copy_hierarchy(board,destination,tr.lean.now()+1),['blocks/child.kicad_sch','board.kicad_sch'])
            with self.assertRaises(subprocess.TimeoutExpired):tr.copy_hierarchy(board,destination,tr.lean.now()-1)

    def test_timeout_is_persisted_and_propagated_without_accepting_original(self):
        with tempfile.TemporaryDirectory() as td:
            folder=Path(td);board=folder/'board.kicad_pcb';board.write_text('(kicad_pcb)')
            board.with_suffix('.kicad_sch').write_text('(kicad_sch)')
            d=dict(violations=[fault()],unconnected_items=[],schematic_parity=[])
            events=folder/'stages.jsonl'
            pcbnew=types.SimpleNamespace(LoadBoard=lambda path:object())
            with patch.dict('sys.modules',{'pcbnew':pcbnew}), patch.object(tr,'inventory',return_value=({'p':('U16','2','GND')},{'z':'GND'})), \
                 patch.object(tr.lean,'run_stage',side_effect=subprocess.TimeoutExpired(['native'],1)):
                with self.assertRaises(subprocess.TimeoutExpired):
                    tr.repair(board,board,d,['GND'],[],'native',str(events),'test-timeout')
            decision=json.loads(next(folder.glob('test-timeout-*/decision.json')).read_text())
            checkpoint=json.loads(next(folder.glob('test-timeout-*/checkpoint.json')).read_text())
            self.assertEqual(decision['status'],'timeout');self.assertFalse(decision['accepted'])
            self.assertFalse(checkpoint['qualified']);self.assertEqual(checkpoint['native_evidence'],d)
            self.assertEqual(json.loads(events.read_text())['status'],'timeout')
            self.assertEqual(board.read_text(),'(kicad_pcb)')

    def test_parser_tree_and_copy_phase_budget_checked(self):
        with tempfile.TemporaryDirectory() as td:
            board=Path(td)/'board.kicad_pcb';board.write_text('(kicad_pcb (setup))')
            def expire_tree(deadline,command):
                if command[0]=='native-policy-tree':raise subprocess.TimeoutExpired(command,0)
            with patch.object(tr,'check_budget',side_effect=expire_tree):
                with self.assertRaises(subprocess.TimeoutExpired):tr.immutable_board(board,tr.lean.now()+1)


@unittest.skipUnless(os.environ.get('THERMAL_REPAIR_FIXTURE'), 'set THERMAL_REPAIR_FIXTURE for frozen native two-pad evidence')
class NativeThermalFixtureTests(unittest.TestCase):
    def test_two_actual_starved_pads_repaired_without_policy_changes(self):
        import pcbnew
        fixture=Path(os.environ['THERMAL_REPAIR_FIXTURE'])
        with tempfile.TemporaryDirectory() as td:
            folder=Path(td)/'fixture';shutil.copytree(fixture,folder)
            source=folder/'BASE-PWR-B.kicad_pcb'
            drc=json.loads((folder/'checkpoint-drc.json').read_text())
            wanted={'U16.2','U4.2'}
            selected=[]
            for v in drc['violations']:
                if any(i.get('description') in ('Pad 2 [GND] of U16 on F.Cu','Pad 2 [GND] of U4 on F.Cu') for i in v['items']):selected.append(v)
            # Detection receives only these native violations; independent baseline
            # validation still checks the complete real board before acceptance.
            partial=dict(drc,violations=selected)
            native=tr.thermal_targets(partial,*tr.inventory(pcbnew.LoadBoard(str(source))),{'GND'})
            self.assertEqual(set(native['GND']),wanted)
            # Restrict the native evidence after refill so the representative probe
            # cannot silently become an unbounded all-pad repair.
            from unittest.mock import patch
            detect=tr.thermal_targets
            def two(d,p,z,n):
                return {net:[name for name in names if name in wanted]
                        for net,names in detect(d,p,z,n).items()}
            candidate=folder/'candidate.kicad_pcb';shutil.copy(source,candidate)
            before=tr.immutable_board(candidate)
            with patch.object(tr,'thermal_targets',side_effect=two):
                after,decision=tr.repair(candidate,source,partial,['GND'],[],shutil.which('kicad-cli'),None,'test-thermal')
            self.assertTrue(decision['accepted'],decision)
            self.assertEqual(decision['errors_before']-decision['errors_after'],2)
            self.assertEqual(after['schematic_parity'],[])
            self.assertLessEqual(len(after['unconnected_items']),len(drc['unconnected_items']))
            result_state=tr.immutable_board(candidate)
            self.assertTrue(all(result_state.get(k)==v for k,v in before.items()))


if __name__=='__main__':unittest.main()
