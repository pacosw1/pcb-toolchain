"""Rule-preservation checks run even when the optional GPU runtime is absent."""
import builtins
import copy
import importlib.util
import sys
import types
from pathlib import Path
import unittest
from unittest.mock import Mock, patch

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from placer import anneal
from placer.batch_capabilities import check_cost, check_search


class BatchCapabilitiesTests(unittest.TestCase):
    def test_rejects_each_active_unsupported_objective_without_mutation(self):
        for key in ('w_x', 'w_row', 'pin_demand'):
            p = anneal.params_all({key: 1})
            before = copy.deepcopy(p)
            with self.assertRaisesRegex(ValueError, key):
                check_cost({}, p)
            self.assertEqual(p, before)
        with self.assertRaisesRegex(ValueError, 'via room'):
            check_cost({'via_nets': ['GND']}, anneal.params_all({}))

    def test_lam_cost_can_be_scored_but_search_is_rejected(self):
        p = anneal.params_all({'schedule': 'lam'})
        check_cost({}, p)
        with self.assertRaisesRegex(ValueError, 'geometric'):
            check_search({}, p)

    def test_batch_rules_rejected_before_optional_import_or_global_work(self):
        # An intentionally incomplete problem would fail during global placement
        # or scalar setup. Unsupported batch policy must be the first failure.
        for overrides in ({'w_x': 1}, {'w_row': 1}, {'pin_demand': 1}, {'schedule': 'lam'}, {'max_displacement': 3}):
            with self.assertRaisesRegex(ValueError, 'batch:'):
                anneal.optimize({}, dict({'batch': 1, 'global': 1}, **overrides), epochs=1, steps=1)
        with self.assertRaisesRegex(ValueError, 'via room'):
            anneal.optimize({'via_nets': ['GND']}, {'batch': 1}, epochs=1, steps=1)

    def test_current_base_policy_supported_and_cpu_default_unchanged(self):
        p = anneal.params_all({'p_swap': 0, 'p_rot': 0, 'w0': 3})
        check_search({'via_nets': []}, p)
        self.assertFalse(p.get('batch'))

    def test_existing_chain_cannot_switch_to_lam_or_drop_objective_terms(self):
        # Load actual methods with an empty optional Torch namespace. No tensors
        # or GPU calls occur: policy validation must precede any resync/state edit.
        path = Path(__file__).parent / 'batch.py'
        spec = importlib.util.spec_from_file_location('placer._batch_guard_probe', path)
        module = importlib.util.module_from_spec(spec)
        with patch.dict(sys.modules, {'torch': types.ModuleType('torch')}):
            spec.loader.exec_module(module)
        chain = module.Chains.__new__(module.Chains)
        chain.bc = types.SimpleNamespace(pr={})
        chain.p = anneal.params_all({})
        chain.resync = Mock()
        old = copy.deepcopy(chain.p)
        for overrides in ({'schedule': 'lam'}, {'w_x': 1}, {'w_row': 1}, {'pin_demand': 1}, {'max_displacement': 3}):
            with self.assertRaises(ValueError):
                chain.set_params(overrides)
            self.assertEqual(chain.p, old)
            chain.resync.assert_not_called()

    def test_missing_optional_runtime_has_explicit_safe_error(self):
        original = builtins.__import__
        def unavailable(name, globals=None, locals=None, fromlist=(), level=0):
            if level == 1 and 'batch' in fromlist:
                raise ImportError('isolated optional runtime absent')
            return original(name, globals, locals, fromlist, level)
        with patch('builtins.__import__', side_effect=unavailable):
            with self.assertRaisesRegex(RuntimeError, 'default scalar CPU'):
                anneal.optimize({}, {'batch': 1}, epochs=1, steps=1)


if __name__ == '__main__':
    unittest.main()
