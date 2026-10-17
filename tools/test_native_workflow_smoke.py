"""Fast contract tests. The mandatory native corpus runs separately without skips."""
import argparse
import json
from pathlib import Path
import tempfile
import unittest

import native_workflow_smoke as smoke
from placer.dru import _tree, _tokens


class NativeSmokeTests(unittest.TestCase):
    def test_clean_baseline_requires_actual_errors_parity_and_connectivity_zero(self):
        clean = dict(errors=0, parity=0, unconnected=0, error_types=[])
        for case in smoke.CASES[:3]:
            smoke.require_case(case, clean)
            for metric in ('errors', 'parity', 'unconnected'):
                with self.assertRaises(ValueError):
                    smoke.require_case(case, dict(clean, **{metric: 1}))

    def test_each_defect_requires_its_actual_native_finding(self):
        for case, counts in [
                ('reject_short', dict(errors=1, parity=0, unconnected=0, error_types=['shorting_items'])),
                ('reject_short', dict(errors=1, parity=0, unconnected=0, error_types=['tracks_crossing'])),
                ('reject_clearance', dict(errors=1, parity=0, unconnected=0, error_types=['clearance'])),
                ('reject_pad_net_parity', dict(errors=0, parity=1, unconnected=0, error_types=[]))]:
            smoke.require_case(case, counts)
            with self.assertRaises(ValueError):
                smoke.require_case(case, dict(errors=0, parity=0, unconnected=0, error_types=[]))
        with self.assertRaises(ValueError):
            smoke.require_case('reject_short', dict(errors=1, parity=0, unconnected=0, error_types=['clearance']))

    def test_missing_native_runtime_is_recorded_failure_with_no_skips(self):
        with tempfile.TemporaryDirectory() as temporary:
            output = Path(temporary) / 'evidence'
            args = argparse.Namespace(output=output, timeout=5, cli=str(output / 'missing-cli'),
                                      python='python3', expected_version=smoke.PINNED_KICAD)
            result = smoke.run(args)
            self.assertEqual(result['status'], 'failed')
            self.assertEqual(result['skipped'], 0)
            self.assertEqual(result['cases'], [])
            self.assertIn('required native runtime missing', result['cause'])
            self.assertEqual(json.loads((output / 'summary.json').read_text())['expected_cases'], list(smoke.CASES))

    def test_malformed_native_report_cannot_satisfy_case(self):
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / 'drc.json'
            path.write_text(json.dumps(dict(violations=[], unconnected_items=[])))
            with self.assertRaisesRegex(ValueError, 'schematic_parity'):
                smoke.drc_counts(path)

    def test_embedded_schematic_contains_four_distinct_native_instances(self):
        forms = _tree(_tokens(smoke.schematic()))
        self.assertEqual(forms[0][0], 'kicad_sch')
        symbols = [form for form in forms[0][1:] if isinstance(form, list) and form[0] == 'symbol']
        labels = [form for form in forms[0][1:] if isinstance(form, list) and form[0] == 'label']
        self.assertEqual(len(symbols), 4)
        self.assertEqual([label[1] for label in labels], ['A', 'A', 'B', 'B'])
        self.assertEqual(len({smoke.uid('J' + str(i)) for i in range(1, 5)}), 4)

    def test_existing_evidence_directory_cannot_be_overwritten(self):
        with tempfile.TemporaryDirectory() as temporary:
            args = argparse.Namespace(output=Path(temporary), timeout=5)
            with self.assertRaises(FileExistsError):
                smoke.run(args)


if __name__ == '__main__':
    unittest.main()
