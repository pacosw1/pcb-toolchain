"""Correctness tests against actual Metal when present; no board acceptance claims."""
import math
import platform
import random
import unittest

from pcb_engine.compute import ComputeWorker, INF, cpu_reference, build_worker


class CPUReferenceTests(unittest.TestCase):
    def test_bounds_and_nonfinite(self):
        invalid = [
            ("placement_hpwl", dict(candidates=[[[math.nan, 0]]], nets=[[0]])),
            ("placement_hpwl", dict(candidates=[[[0, 0]]], nets=[[1]])),
            ("cost_field", dict(width=1048576, height=2, blocked=[], targets=[])),
            ("cost_field", dict(width=2, height=2, blocked=[4], targets=[])),
            ("cost_field", dict(width=2, height=2, blocked=[], targets=[], max_sweeps=0)),
            ("congestion", dict(width=2, height=2, segments=[[0, 0, 2, 0]])),
            ("placement_hpwl", dict(candidates=[[[0, 0]]] * 10001,
                                    nets=[[0]] * 5000)),
        ]
        for op, data in invalid:
            with self.subTest(op=op, data=data), self.assertRaises(ValueError):
                cpu_reference(op, data)

    def test_cpu_fallback_and_rule_metadata(self):
        with ComputeWorker(native=False) as worker:
            reply = worker.request("placement_hpwl", backend="metal", revision="abc",
                                   candidates=[[[0, 0], [2, 5]]], nets=[[0, 1]],
                                   custom_rules={"hole_clearance": 0.3})
            self.assertEqual(reply["revision"], "abc")
            self.assertEqual(reply["result"]["scores"], [7])
            self.assertEqual(reply["metrics"]["dispatches"], 0)
            self.assertEqual(reply["metrics"]["backend"], "cpu")
            self.assertTrue(reply["metrics"]["fallback_reason"])

    def test_unconverged_is_explicit(self):
        result = cpu_reference("cost_field", dict(width=8, height=1, blocked=[], targets=[0], max_sweeps=1))
        self.assertFalse(result["converged"])
        self.assertEqual(result["distances"], [0, 1] + [INF] * 6)
        self.assertTrue(result["guidance_only"])

    def test_sparse_snapshot_cpu_fallback_and_closed_worker(self):
        with ComputeWorker(native=False) as worker:
            snapshot = worker.prepare("placement_hpwl", revision="source",
                                      candidates=[[[0, 0], [3, 4]]], nets=[[0, 1]])
            reply = worker.request("placement_hpwl", revision="source", snapshot_id=snapshot,
                                   candidate_deltas=[[], [[1, 2, -1]]])
            self.assertEqual(reply["result"]["scores"], [7, 8])
            with self.assertRaisesRegex(ValueError, "revision mismatch"):
                worker.request("placement_hpwl", revision="changed", snapshot_id=snapshot)
        with self.assertRaisesRegex(RuntimeError, "closed"):
            worker.request("capabilities")

    def test_calibration_cannot_promote_cpu_fallback(self):
        with ComputeWorker(native=False) as worker:
            profile = worker.calibrate("placement_hpwl", revision="cpu-only", save=False,
                                       repetitions=5, candidates=[[[0, 0], [1, 1]]], nets=[[0, 1]])
            self.assertFalse(profile["actual_metal"])
            self.assertFalse(profile["promoted"])


@unittest.skipUnless(platform.system() == "Darwin", "actual Metal requires macOS")
class MetalParityTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.worker = ComputeWorker()
        caps = cls.worker.request("capabilities")
        if not caps["result"]["metal_available"]:
            cls.worker.close()
            raise unittest.SkipTest(f"Metal unavailable: {caps}")

    @classmethod
    def tearDownClass(cls):
        cls.worker.close()

    def metal(self, op, **data):
        reply = self.worker.request(op, backend="metal", revision="parity-v1",
                                    custom_rules={"minimum_hole_clearance": 0.3}, **data)
        self.assertTrue(reply["ok"], reply)
        self.assertEqual(reply["revision"], "parity-v1")
        self.assertEqual(reply["metrics"]["backend"], "metal")
        self.assertGreater(reply["metrics"]["dispatches"], 0)
        return reply["result"]

    def test_hpwl_random_batches_and_empty_nets(self):
        rng = random.Random(741)
        data = dict(candidates=[[[rng.uniform(-100, 100), rng.uniform(-100, 100)]
                                 for _ in range(40)] for _ in range(48)],
                    nets=[[rng.randrange(40) for _ in range(5)] for _ in range(60)] + [[], [0]])
        expected = cpu_reference("placement_hpwl", data)["scores"]
        actual = self.metal("placement_hpwl", **data)["scores"]
        for a, b in zip(expected, actual):
            self.assertAlmostEqual(a, b, delta=max(0.01, abs(a) * 2e-6))

    def test_congestion_exact_integer_parity(self):
        data = dict(width=37, height=19, segments=[[0, 0, 36, 18], [5, 4, 1, 2],
                                                 [0, 0, 0, 0], [36, 0, 36, 18]])
        self.assertEqual(cpu_reference("congestion", data)["counts"],
                         self.metal("congestion", **data)["counts"])

    def test_thin_blocked_and_multilayer_fields(self):
        cases = [
            dict(width=1, height=17, blocked=[8], targets=[0]),
            dict(width=17, height=1, blocked=[8], targets=[16]),
            dict(width=8, height=8, blocked=list(range(24, 32)), targets=[0]),
            dict(width=4, height=4, layers=3, blocked=[1, 2, 17, 18], targets=[0, 47]),
            dict(width=4, height=4, blocked=list(range(16)), targets=[0]),
            dict(width=8, height=8, blocked=[], targets=[0], max_sweeps=2),
        ]
        for data in cases:
            with self.subTest(data=data):
                expected = cpu_reference("cost_field", data)
                actual = self.metal("cost_field", **data)
                self.assertEqual(expected["distances"], actual["distances"])
                self.assertEqual(expected["converged"], actual["converged"])

    def test_native_bounds_independent_of_python(self):
        # Deliberately bypass adapter validation: native service must reject too.
        import json
        request = dict(id="direct", revision="bounds", op="cost_field", backend="metal",
                       width=1048576, height=1048576, blocked=[], targets=[])
        self.worker.process.stdin.write(json.dumps(request) + "\n")
        self.worker.process.stdin.flush()
        reply = json.loads(self.worker.process.stdout.readline())
        self.assertFalse(reply["ok"])
        self.assertIn("budget", reply["error"])

    def test_sparse_snapshot_metal_and_immutable_revision(self):
        data = dict(candidates=[[[0, 0], [3, 4], [10, 10]]], nets=[[0, 1], [1, 2]])
        snapshot = self.worker.prepare("placement_hpwl", revision="sparse-v1", **data)
        deltas = [[], [[1, 2, 1]], [[0, -1, 2], [2, 4, 3]]]
        reply = self.worker.request("placement_hpwl", backend="metal", revision="sparse-v1",
                                    snapshot_id=snapshot, candidate_deltas=deltas)
        expected = cpu_reference("placement_hpwl", dict(data, candidate_deltas=deltas))
        self.assertEqual(reply["result"]["scores"], expected["scores"])
        self.assertTrue(reply["metrics"]["snapshot_reused"])
        self.assertGreater(reply["metrics"]["dispatches"], 0)
        data["candidates"][0][0][0] = 100
        repeated = self.worker.request("placement_hpwl", backend="metal", revision="sparse-v1",
                                       snapshot_id=snapshot, candidate_deltas=deltas)
        self.assertEqual(repeated["result"]["scores"], expected["scores"])
        with self.assertRaisesRegex(ValueError, "revision mismatch"):
            self.worker.request("placement_hpwl", revision="sparse-v2", snapshot_id=snapshot)

    def test_calibration_matches_hardware_source_revision_and_workload(self):
        data = dict(candidates=[[[0, 0], [3, 4]]] * 8, nets=[[0, 1]])
        profile = self.worker.calibrate("placement_hpwl", revision="cal-v1", repetitions=5,
                                        save=False, **data)
        self.assertTrue(profile["parity"])
        self.assertTrue(profile["actual_metal"])
        reply = self.worker.request("placement_hpwl", backend="auto", revision="cal-v1", **data)
        self.assertEqual(reply["metrics"]["backend"], "metal" if profile["promoted"] else "cpu")
        self.assertEqual(reply["metrics"]["calibration_id"], profile["id"])
        changed = self.worker.request("placement_hpwl", backend="auto", revision="cal-v2", **data)
        self.assertEqual(changed["metrics"]["backend"], "cpu")
        self.assertNotEqual(changed["metrics"]["calibration_id"], profile["id"])

    def test_cached_binary_requires_matching_build_receipt(self):
        import hashlib
        import json
        import os
        from pathlib import Path
        import tempfile
        from unittest.mock import patch
        with tempfile.TemporaryDirectory() as directory, patch.dict(os.environ, {"PCB_ENGINE_BUILD_DIR": directory}):
            binary = build_worker()
            original = hashlib.sha256(binary.read_bytes()).hexdigest()
            receipt = json.loads(binary.with_name("build.json").read_text())
            self.assertEqual(receipt["binary_sha256"], original)
            self.assertIn("compute.py", receipt["build_identity"]["source_sha256"])
            binary.write_bytes(binary.read_bytes() + b"corrupt cache")
            corrupted = hashlib.sha256(binary.read_bytes()).hexdigest()
            rebuilt = build_worker()
            rebuilt_sha = hashlib.sha256(rebuilt.read_bytes()).hexdigest()
            self.assertNotEqual(rebuilt_sha, corrupted)
            self.assertFalse(rebuilt.read_bytes().endswith(b"corrupt cache"))
            refreshed = json.loads(rebuilt.with_name("build.json").read_text())
            self.assertEqual(refreshed["binary_sha256"], rebuilt_sha)


if __name__ == "__main__":
    unittest.main()
