import hashlib
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from pcb_engine.acceleration import observe
from pcb_engine.compute import ComputeWorker


class ComputeObservationTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        folder = self.root / "hardware-design/boards/TEST"
        folder.mkdir(parents=True)
        (folder / "gate.json").write_text(json.dumps({"project": "cad/TEST", "checks": {}}))
        self.native = folder / "cad/TEST.kicad_pcb"
        self.native.parent.mkdir()
        self.native.write_text("(kicad_pcb)")
        self.revision = hashlib.sha256(self.native.read_bytes()).hexdigest()

    def tearDown(self):
        self.tmp.cleanup()

    def test_status_seals_artifacts_without_board_mutation(self):
        with patch("pcb_engine.acceleration.ComputeWorker",
                   side_effect=lambda **kw: ComputeWorker(native=False, **kw)):
            output = self.root / "observation/report.json"
            result = observe(self.root, "TEST", output)
        self.assertEqual(result["status"], "passed")
        self.assertFalse(result["qualified"])
        self.assertFalse(result["production_settings_changed"])
        self.assertEqual(result["revision"], self.revision)
        self.assertTrue(result["artifacts"])
        for name, digest in result["artifacts"].items():
            self.assertEqual(hashlib.sha256((output.parent / name).read_bytes()).hexdigest(), digest)
        self.assertEqual(hashlib.sha256(self.native.read_bytes()).hexdigest(), self.revision)

    def test_stale_revision_rejected_before_measurement(self):
        request = self.root / "request.json"
        request.write_text(json.dumps(dict(schema="iot-lab.compute-request.v1", revision="0"*64,
                                          op="cost_field", data=dict(width=2, height=2, blocked=[], targets=[0]))))
        with self.assertRaisesRegex(ValueError, "revision does not match"):
            observe(self.root, "TEST", self.root / "report.json", request_path=request)
        self.assertFalse((self.root / "report-artifacts").exists())

    def test_unsupported_fields_cannot_inject_native_operations(self):
        request = self.root / "request.json"
        request.write_text(json.dumps(dict(schema="iot-lab.compute-request.v1", revision=self.revision,
                                          op="cost_field", data=dict(width=2, height=2, blocked=[],
                                                                    targets=[0], model_path="/tmp/model"))))
        with self.assertRaisesRegex(ValueError, "unsupported fields"):
            observe(self.root, "TEST", self.root / "report.json", request_path=request)

    def test_cpu_only_calibration_stays_blocked_and_owned(self):
        request = self.root / "request.json"
        request.write_text(json.dumps(dict(schema="iot-lab.compute-request.v1", revision=self.revision,
                                          op="cost_field", data=dict(width=2, height=2, blocked=[], targets=[0]))))
        with patch("pcb_engine.acceleration.ComputeWorker",
                   side_effect=lambda **kw: ComputeWorker(native=False, **kw)):
            output = self.root / "operation/report.json"
            result = observe(self.root, "TEST", output, request_path=request)
        self.assertEqual(result["status"], "blocked")
        self.assertFalse((output.parent / "report-artifacts/calibration.json").exists())


if __name__ == "__main__":
    unittest.main()
