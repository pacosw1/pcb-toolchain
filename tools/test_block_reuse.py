"""Regression checks for reuse evidence, freshness and candidate filtering."""
import json
from pathlib import Path
import tempfile
import unittest

import block_reuse as br


class ReuseTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.lib = Path(self.tmp.name)
        self.block = self.lib / 'USB.kicad_block'
        self.block.mkdir()
        (self.block / 'USB.json').write_text(json.dumps({'description': 'USB sink', 'keywords': 'ESD'}))
        (self.block / 'facts.json').write_text(json.dumps({'level': 2, 'gates': 'historical pass',
            'ports': [{'name': 'VBUS', 'limits': '5 V'}], 'open_items': ['recheck stock']}))
        (self.block / 'USB.kicad_pcb').write_text('(kicad_pcb\n\t(footprint "Package:X"\n'
            '\t\t(property "Reference" "U1")\n\t\t(property "MPN" "ABC")\n\t)\n)')
        (self.block / 'USB.kicad_sch').write_text('(kicad_sch)')
        (self.block / 'USB.kicad_pro').write_text('{}')

    def test_does_not_promote_historical_claim(self):
        row = br.reuse(self.lib, 'USB')
        self.assertEqual(row['declared_level'], 2)
        self.assertEqual(row['qualification'], 'unverified_for_target')
        self.assertEqual(row['open_items'], ['recheck stock'])

    def test_rule_change_invalidates_proposal(self):
        old = br.reuse(self.lib, 'USB')['source_sha256']
        (self.block / 'USB.kicad_dru').write_text('(version 1)')
        with self.assertRaisesRegex(ValueError, 'stale'):
            br.reuse(self.lib, 'USB', old)

    def test_gui_state_does_not_invalidate(self):
        old = br.reuse(self.lib, 'USB')['source_sha256']
        (self.block / 'USB.kicad_prl').write_text('new window')
        self.assertEqual(br.reuse(self.lib, 'USB', old)['source_sha256'], old)

    def test_filters_and_explanation(self):
        rows = br.find(self.lib, 'usb esd', mpn='abc', footprint='Package:X')
        self.assertEqual([r['id'] for r in rows], ['USB'])
        self.assertEqual(rows[0]['matches']['esd'], ['keywords'])
        self.assertEqual(br.find(self.lib, 'usb', mpn='other'), [])

    def test_missing_cad_and_level_stay_unknown(self):
        (self.block / 'USB.kicad_sch').unlink()
        (self.block / 'facts.json').unlink()
        row = br.reuse(self.lib, 'USB')
        self.assertIsNone(row['declared_level'])
        self.assertEqual(row['missing_files'], ['USB.kicad_sch'])
        self.assertTrue(row['facts_errors'])

    def test_path_escape_rejected(self):
        with self.assertRaises(ValueError):
            br.reuse(self.lib, '../USB')

    def test_external_dependency_not_silently_hashed(self):
        outside = self.lib / 'external.kicad_sym'
        outside.write_text('external')
        (self.block / 'external.kicad_sym').symlink_to(outside)
        with self.assertRaisesRegex(ValueError, 'external'):
            br.reuse(self.lib, 'USB')


if __name__ == '__main__':
    unittest.main()
