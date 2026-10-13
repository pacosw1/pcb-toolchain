"""Native evidence and automatic local-repair selection counterexamples."""
import copy
import json
from pathlib import Path
import tempfile
import unittest

from pcb_search.native_conflicts import propose, select_repair
from pcb_search.native_srj import digest, source_set
from test_pcb_search_native_eco import PCB


class NativeConflictTest(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory();self.addCleanup(self.tmp.cleanup)
        self.root=Path(self.tmp.name);self.board=self.root/'input.kicad_pcb'
        self.board.write_text(PCB[:-1]+'''(footprint "U" (at -1 -1) (uuid "u")
          (property "Reference" "U1") (pad "1" smd rect (at 0 0) (net "B") (uuid "p"))))''')
        for ext in ('.kicad_pro','.kicad_dru','.kicad_sch'):self.board.with_suffix(ext).write_text('fixture')
        self.folder=self.root/'native';self.folder.mkdir()
        self.drc=dict(source=self.board.name,coordinate_units='mm',included_severities=['error','warning','exclusion'],
            violations=[dict(type=kind,severity='error',items=[dict(uuid='via'),dict(uuid='p')])
                        for kind in ('clearance','hole_clearance')],unconnected_items=[],schematic_parity=[])
        self.record=dict(schema='iot-lab.native-export.v1',board=str(self.board),status='reject',
            source_mutated=False,drc_returncode=0,
            drc_command=['kicad-cli','pcb','drc','--schematic-parity','--refill-zones','--severity-all'])
        self.save()

    def save(self):
        (self.folder/'drc.json').write_text(json.dumps(self.drc))
        self.record.update(inputs=source_set(self.board),drc_sha256=digest(self.folder/'drc.json'))
        (self.folder/'record.json').write_text(json.dumps(self.record))

    def select(self):return select_repair(self.folder,fractions=[.5],budget_s=2)

    def test_native_ids_select_the_away_trace_without_manual_item_selection(self):
        plan=self.select();self.assertEqual(plan['status'],'candidate')
        self.assertEqual(plan['choice']['via_id'],'via');self.assertEqual(plan['choice']['along_trace_id'],'top')
        self.assertEqual(plan['choice']['conflict_error_indices'],[0,1]);self.assertFalse(plan['qualified'])
        result=propose(self.folder,self.root/'out',fractions=[.5],budget_s=2)
        self.assertEqual(result['destination_mm'],['1.000000','0.000000'])
        self.assertEqual(result['conflict_selection']['choice']['via_id'],'via')
        self.assertFalse(result['qualified']);self.assertTrue(result['native_and_board_specific_gates_required'])

    def test_report_and_source_tampering_rejected(self):
        for path in (self.board,self.board.with_suffix('.kicad_dru'),self.folder/'drc.json'):
            original=path.read_text();path.write_text(original+' ')
            with self.subTest(path=path),self.assertRaisesRegex(ValueError,'stale'):self.select()
            path.write_text(original)

    def test_missing_parity_check_or_existing_parity_fails_before_repair(self):
        self.drc['schematic_parity']=[dict(type='missing_footprint')];self.save()
        with self.assertRaisesRegex(ValueError,'schematic parity'):self.select()
        self.drc['schematic_parity']=[];self.record['drc_command'].remove('--schematic-parity');self.save()
        with self.assertRaisesRegex(ValueError,'incomplete'):self.select()

    def test_other_errors_and_opens_are_not_claimed_fixed(self):
        self.drc['violations'].append(dict(type='track_width',severity='error',items=[]))
        self.drc['unconnected_items']=[dict(items=[])];self.save()
        plan=self.select();self.assertEqual(plan['choice']['conflict_error_indices'],[0,1])
        self.assertEqual(plan['untargeted_error_indices'],[2]);self.assertEqual(plan['input_open_count'],1)
        self.assertEqual(plan['unsupported_error_indices'],[2]);self.assertFalse(plan['qualified'])

    def test_opposing_pad_conflicts_cannot_be_ranked_as_a_single_away_move(self):
        self.board.write_text(self.board.read_text()[:-1]+'''(footprint "U" (at 1 1) (uuid "u2")
          (property "Reference" "U2") (pad "1" smd rect (at 0 0) (net "C") (uuid "p2"))))''')
        row=copy.deepcopy(self.drc['violations'][0]);row['items'][1]['uuid']='p2'
        self.drc['violations'].append(row);self.save()
        plan=self.select();self.assertEqual(plan['status'],'unsupported');self.assertIsNone(plan['choice'])
        result=propose(self.folder,self.root/'out',fractions=[.5],budget_s=2)
        self.assertEqual(result['status'],'unsupported');self.assertFalse((self.root/'out/proposal.kicad_pcb').exists())
        self.assertTrue((self.root/'out/record.json').is_file())

    def test_locked_or_branched_via_abstains(self):
        source=self.board.read_text()
        for changed in (source.replace('(via (at','(via (locked yes) (at'),
                        source[:-1]+'(segment (start 0 0) (end 0 1) (width .15) (layer "F.Cu") (net "A") (uuid "branch")))'):
            self.board.write_text(changed);self.save()
            with self.subTest(changed=changed):
                plan=self.select();self.assertEqual(plan['status'],'unsupported');self.assertIsNone(plan['choice'])

    def test_timeout_discards_partial_choices(self):
        # Put the valid away direction first, so timeout must discard an
        # already-selected candidate rather than just an empty search.
        self.board.write_text(self.board.read_text().replace('(uuid "top")','(uuid "a-top")'));self.save()
        ticks=iter([0,0,3,3])
        plan=select_repair(self.folder,fractions=[.5],budget_s=1,clock=lambda:next(ticks))
        self.assertEqual(plan['status'],'timeout');self.assertIsNone(plan['choice'])
        self.assertEqual(plan['evaluated'],1)
        self.assertEqual(plan['untargeted_error_indices'],[0,1])


if __name__=='__main__':unittest.main()
