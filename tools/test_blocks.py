#!/usr/bin/env python3
"""Unit tests for the pure core of tools/blocks.py (no pcbnew, no kicad-cli, no network).

  python3 tools/test_blocks.py
"""
import importlib.util
import json
import os
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
spec = importlib.util.spec_from_file_location('blocks', os.path.join(HERE, 'blocks.py'))
bk = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bk)

PCB = '''(kicad_pcb
	(footprint "Diode_SMD:D_SMA"
		(layer "F.Cu")
		(property "Reference" "D2"
			(at 0 0 0))
		(property "Value" "SS36")
		(property "Datasheet" "${KIPRJMOD}/../../../../registry/datasheets/SS36.pdf")
		(property "LCSC" "C22452")
		(property "MPN" "SS36")
		(property "Description" "reverse polarity diode")
	)
	(footprint "Diode_SMD:D_SMA"
		(layer "F.Cu")
		(property "Reference" "D1")
		(property "Value" "SS36")
		(property "Datasheet" "SS36.pdf")
		(property "LCSC" "C22452")
		(property "MPN" "SS36")
	)
	(footprint "TestPoint:TP"
		(layer "F.Cu")
		(property "Reference" "TP1")
		(property "Value" "TP")
	)
	(group "PWR-24V-IN"
		(members "a" "b"))
)
'''


class ParseTest(unittest.TestCase):
    def test_footprints_and_properties(self):
        fps = bk.parse_footprints(PCB)
        self.assertEqual([f['ref'] for f in fps], ['D2', 'D1', 'TP1'])
        self.assertEqual(fps[0], {'ref': 'D2', 'value': 'SS36', 'footprint': 'Diode_SMD:D_SMA', 'lcsc': 'C22452',
                                  'mpn': 'SS36', 'description': 'reverse polarity diode', 'datasheet': 'SS36.pdf', 'url': ''})
        self.assertEqual(fps[1]['datasheet'], 'SS36.pdf')
        self.assertEqual(fps[2]['lcsc'], '')

    def test_used_in_finds_block_group(self):
        self.assertEqual(bk.used_in({'RELAY-4': PCB, 'BASE-PWR': '(kicad_pcb)'}, 'PWR-24V-IN'), ['RELAY-4'])


class ResolveTest(unittest.TestCase):
    def test_url_datasheet_parsed_as_url(self):
        fp = bk.parse_footprints('(kicad_pcb\n\t(footprint "R:R"\n\t\t(property "Reference" "R1")\n'
                                 '\t\t(property "Datasheet" "https://www.lcsc.com/datasheet/x_C25804.pdf")\n'
                                 '\t\t(property "MPN" "0603WAF1002T5E")\n\t)\n)')[0]
        self.assertEqual((fp['datasheet'], fp['url']), ('', 'https://www.lcsc.com/datasheet/x_C25804.pdf'))

    def test_registry_file_by_mpn_wins(self):
        fp = {'datasheet': '', 'url': 'https://x/y.pdf', 'mpn': '0603WAF1002T5E'}
        self.assertEqual(bk.resolve_datasheet(fp, {'0603WAF1002T5E.pdf'}), '0603WAF1002T5E.pdf')

    def test_local_path_kept(self):
        self.assertEqual(bk.resolve_datasheet({'datasheet': 'SS36.pdf', 'url': '', 'mpn': 'X'}, set()), 'SS36.pdf')

    def test_url_only_is_an_error(self):
        fp = {'ref': 'R1', 'lcsc': 'C25804', 'datasheet': '', 'url': 'https://x/y.pdf', 'mpn': 'Z'}
        self.assertEqual(bk.check_parts([fp], {}), ['R1: datasheet is only a URL, not in registry/datasheets'])


class BomTest(unittest.TestCase):
    def test_groups_same_part_sorted_refs(self):
        rows = bk.bom(bk.parse_footprints(PCB))
        self.assertEqual(rows[0]['refs'], ['D1', 'D2'])
        self.assertEqual(rows[0]['qty'], 2)
        self.assertEqual(rows[0]['datasheet'], 'SS36.pdf')

    def test_row_description_is_first_non_empty_of_group(self):
        rows = bk.bom(bk.parse_footprints(PCB))
        self.assertEqual(rows[0]['description'], 'reverse polarity diode')
        self.assertEqual(rows[1]['description'], '')


class CheckPartsTest(unittest.TestCase):
    def test_missing_c_number_and_datasheet_are_errors(self):
        fps = bk.parse_footprints(PCB)
        errs = bk.check_parts(fps, {'SS36.pdf': ('aa', 'aa')})
        self.assertIn('TP1: no JLC C-number', errs)
        self.assertIn('TP1: no datasheet', errs)
        self.assertFalse(any(e.startswith('D') for e in errs))

    def test_datasheet_hash_mismatch_is_error(self):
        errs = bk.check_parts(bk.parse_footprints(PCB)[:1], {'SS36.pdf': ('aa', 'bb')})
        self.assertEqual(errs, ['D2: SS36.pdf sha256 does not match its .source.json'])

    def test_datasheet_not_in_registry_is_error(self):
        errs = bk.check_parts(bk.parse_footprints(PCB)[:1], {})
        self.assertEqual(errs, ['D2: SS36.pdf not in registry/datasheets'])


class MetaTest(unittest.TestCase):
    def test_good_facts(self):
        self.assertEqual(bk.validate_facts({'level': 0, 'layout_rules': [{'rule': 'r', 'source': 'SS36.pdf p.3'}]}), [])

    def test_bad_level_and_rule_without_source(self):
        errs = bk.validate_facts({'level': 3, 'layout_rules': [{'rule': 'r'}]})
        self.assertIn('level must be 0, 1 or 2', errs)
        self.assertIn('layout rule 1 has no source', errs)

    def test_kicad_meta_three_keys_no_indent_no_trailing_newline(self):
        s = bk.kicad_meta('24 V input', 'power tvs')
        self.assertEqual(list(json.loads(s)), ['description', 'keywords', 'fields'])
        self.assertFalse(s.endswith('\n'))
        self.assertTrue(s.startswith('{\n"description"'))


class CacheTest(unittest.TestCase):
    def test_key_changes_with_content(self):
        with tempfile.TemporaryDirectory() as d:
            p = os.path.join(d, 'a.kicad_pcb')
            open(p, 'w').write('1'); k1 = bk.cache_key([p], 'top')
            open(p, 'w').write('2'); k2 = bk.cache_key([p], 'top')
            self.assertNotEqual(k1, k2)
            self.assertNotEqual(k2, bk.cache_key([p], 'bottom'))


class RevisionTest(unittest.TestCase):
    def test_revision_changes_when_a_file_changes_or_appears(self):
        with tempfile.TemporaryDirectory() as d:
            a = os.path.join(d, 'a.kicad_pcb'); open(a, 'w').write('1')
            r1 = bk.revision([d])
            open(a, 'w').write('22'); r2 = bk.revision([d])
            open(os.path.join(d, 'b.kicad_sch'), 'w').write('x'); r3 = bk.revision([d])
            self.assertEqual(len({r1, r2, r3}), 3)
            self.assertEqual(r3, bk.revision([d]))


class CostTest(unittest.TestCase):
    def test_total_from_unit_price_and_qty_extended_count(self):
        rows = [{'refs': ['C1', 'C2'], 'qty': 2, 'lcsc': 'C13585', 'evidence': {'price': 0.2653, 'jlc_class': 'Basic Part'}},
                {'refs': ['F1'], 'qty': 1, 'lcsc': 'C87383', 'evidence': {'price': 0.3748, 'jlc_class': 'Extended Part'}},
                {'refs': ['TP1'], 'qty': 1, 'lcsc': '', 'evidence': None}]
        c = bk.cost(rows)
        self.assertAlmostEqual(c['parts_usd'], 0.9054, places=4)
        self.assertEqual(c['extended'], ['C87383'])
        self.assertEqual(c['missing'], ['TP1'])

    def test_order_fee_per_unique_extended_part(self):
        rows = [{'refs': ['F1'], 'qty': 1, 'lcsc': 'C87383', 'evidence': {'price': 0.3748, 'jlc_class': 'Extended Part'}},
                {'refs': ['D3'], 'qty': 1, 'lcsc': 'C224048', 'evidence': {'price': 0.2958, 'jlc_class': 'Extended Part'}},
                {'refs': ['C1'], 'qty': 1, 'lcsc': 'C13585', 'evidence': {'price': 0.2653, 'jlc_class': 'Basic Part'}}]
        c = bk.cost(rows)
        self.assertEqual(c['extended_fee_usd'], 2 * bk.JLC_EXTENDED_FEE_USD)
        self.assertAlmostEqual(c['first_board_usd'], 0.9359 + 2 * bk.JLC_EXTENDED_FEE_USD, places=4)


class ViewVariantTest(unittest.TestCase):
    def test_variant_changes_with_the_export_command(self):
        v1 = bk.view_variant('front')
        ext, cmd = bk.VIEWS['front']
        bk.VIEWS['front'] = (ext, lambda s, o: cmd(s, o) + ['--extra'])
        try:
            self.assertNotEqual(v1, bk.view_variant('front'))
        finally:
            bk.VIEWS['front'] = (ext, cmd)


class RecolorTest(unittest.TestCase):
    def test_all_fill_and_stroke_colors_become_one(self):
        svg = '<g style="fill:#C2C200; stroke:#C2C200"><path fill="#000000" stroke="#FF00ff"/></g><rect fill="none"/>'
        out = bk.recolor_svg(svg, '#00B8D4')
        self.assertEqual(out, '<g style="fill:#00B8D4; stroke:#00B8D4"><path fill="#00B8D4" stroke="#00B8D4"/></g><rect fill="none"/>')


class SafePathTest(unittest.TestCase):
    def test_inside_root_resolves(self):
        with tempfile.TemporaryDirectory() as d:
            open(os.path.join(d, 'a.txt'), 'w').close()
            self.assertEqual(bk.safe_path(d, 'a.txt'), os.path.realpath(os.path.join(d, 'a.txt')))

    def test_traversal_is_refused(self):
        with tempfile.TemporaryDirectory() as d:
            self.assertIsNone(bk.safe_path(d, '../etc/passwd'))
            self.assertIsNone(bk.safe_path(d, '/etc/passwd'))


if __name__ == '__main__':
    unittest.main()
