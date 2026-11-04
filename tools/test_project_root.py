"""Project root resolver and board route-rule plugin loader."""
import json
import os
from pathlib import Path
import tempfile
import unittest

import board_route_rules
import project_root


class ProjectRootTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(); self.addCleanup(self.tmp.cleanup)
        self.root = Path(os.path.realpath(self.tmp.name))
        (self.root / 'hardware-design/boards/X').mkdir(parents=True)
        (self.root / 'tools').mkdir()

    def test_order_explicit_env_cwd_fallback(self):
        deep = self.root / 'hardware-design/boards/X'
        self.assertEqual(project_root.root('/a', {'IOT_LAB': '/b'}, deep), Path('/a'))
        self.assertEqual(project_root.root(None, {'IOT_LAB': '/b'}, deep), Path('/b'))
        self.assertEqual(project_root.root(None, {}, deep), self.root)
        self.assertEqual(project_root.root(None, {}, '/'), project_root.FALLBACK)

    def test_plugin_from_gate_json_and_absent_key(self):
        (self.root / 'tools/fixture_rules_plugin.py').write_text('LABEL = "FX"\ndef preserved_input_faults(*a):\n    return []\n')
        (self.root / 'hardware-design/boards/X/gate.json').write_text(json.dumps({'route_rules': 'tools/fixture_rules_plugin.py'}))
        (self.root / 'hardware-design/boards/Y').mkdir()
        (self.root / 'hardware-design/boards/Y/gate.pending.json').write_text(json.dumps({'project': 'cad/Y'}))
        self.assertEqual(board_route_rules.load(self.root, 'X').LABEL, 'FX')
        self.assertIsNone(board_route_rules.load(self.root, 'Y'))
        self.assertIsNone(board_route_rules.load(self.root, 'not a board'))
        board, rules = board_route_rules.mandatory(self.root, ['', 'Y', 'X'])
        self.assertEqual((board, rules.LABEL), ('X', 'FX'))


if __name__ == '__main__':
    unittest.main()
