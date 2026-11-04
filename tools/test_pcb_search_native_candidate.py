"""A native backend may add requested copper, never change protected content."""
import json
from pathlib import Path
import tempfile
import unittest

from pcb_search.native_candidate import copper_items, scope_native
from pcb_search.native_srj import geometry_digest, source_set


def segment(uid, net, width='0.25'):
    return f'(segment (start 0 0) (end 1 1) (width {width}) (layer "F.Cu") (net {net}) (uuid "{uid}"))'


class NativeCandidateTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.source = self.root/'input.kicad_pcb'
        self.candidate = self.root/'backend.kicad_pcb'
        self.out = self.root/'scoped'
        self.original = segment('original', '"GND"')
        self.source.write_text('(kicad_pcb (version 20260101) '+self.original+')')
        for ext in ('.kicad_pro','.kicad_dru','.kicad_sch'):
            self.source.with_suffix(ext).write_text('unchanged '+ext)

    def write_candidate(self, *additions):
        self.candidate.write_text(self.source.read_text()[:-1]+' '.join(additions)+')')

    def test_filters_other_nets_and_preserves_sidecars(self):
        self.write_candidate(segment('wanted','"/V_GAS"'),segment('extra','"GND"'))
        before = source_set(self.source)
        result = scope_native(self.source,self.candidate,self.out,['/V_GAS'])
        self.assertEqual(result['added_items'],['wanted'])
        self.assertEqual(result['discarded_items'],['extra'])
        self.assertFalse(result['qualified'])
        target = self.out/'candidate.kicad_pcb'
        self.assertEqual(set(copper_items(target)[1]),{'original','wanted'})
        self.assertEqual(geometry_digest(self.source),geometry_digest(target,['wanted']))
        self.assertEqual(source_set(self.source),before)
        for ext in ('.kicad_pro','.kicad_dru','.kicad_sch'):
            self.assertEqual(target.with_suffix(ext).read_bytes(),self.source.with_suffix(ext).read_bytes())
        self.assertEqual(json.loads((self.out/'record.json').read_text()),result)

    def test_changed_or_missing_protected_copper_rejected_before_output(self):
        self.write_candidate(segment('wanted','"/V_GAS"'))
        original = self.candidate.read_text()
        for changed in (original.replace('(width 0.25)','(width 0.15)',1),
                        original.replace(self.original,'')):
            self.candidate.write_text(changed)
            with self.assertRaisesRegex(ValueError,'protected'):
                scope_native(self.source,self.candidate,self.out,['/V_GAS'])
            self.assertFalse(self.out.exists())

    def test_board_rule_or_placement_change_rejected(self):
        for form in ('(setup (pad_to_mask_clearance 0.1))',
                     '(footprint "X" (at 1 2) (uuid "fp"))'):
            self.write_candidate(segment('wanted','"/V_GAS"'),form)
            with self.assertRaisesRegex(ValueError,'protected'):
                scope_native(self.source,self.candidate,self.out,['/V_GAS'])

    def test_legacy_numeric_net_is_resolved(self):
        self.source.write_text('(kicad_pcb (net 1 "GND") (net 2 "/V_GAS") '+segment('original','1')+')')
        self.write_candidate(segment('wanted','2'),segment('extra','1'))
        result = scope_native(self.source,self.candidate,self.out,['/V_GAS'])
        self.assertEqual(result['added_items'],['wanted'])
        self.assertEqual(result['discarded_items'],['extra'])

    def test_unknown_net_code_and_duplicate_identity_rejected(self):
        for added in (segment('wanted','27'),segment('original','"/V_GAS"')):
            self.write_candidate(added)
            with self.assertRaises(ValueError):
                scope_native(self.source,self.candidate,self.out,['/V_GAS'])

    def test_empty_selection_and_existing_output_rejected(self):
        self.write_candidate(segment('wanted','"/V_GAS"'))
        for names in ([],['/V_GAS','/V_GAS'],['/NOT_PRESENT']):
            with self.assertRaises(ValueError):
                scope_native(self.source,self.candidate,self.out,names)
        self.out.mkdir()
        with self.assertRaises(FileExistsError):
            scope_native(self.source,self.candidate,self.out,['/V_GAS'])


if __name__ == '__main__':
    unittest.main()
