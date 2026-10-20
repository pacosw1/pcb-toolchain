"""Numeric contracts only; synthetic data never qualifies physical boards."""
import copy
import importlib.util
import json
import unittest
from pathlib import Path

import test_pcb_ml_models as fixtures
from pcb_engine import ml


@unittest.skipUnless(importlib.util.find_spec("torch"), "isolated torch environment required")
class EngineMLTests(unittest.TestCase):
    rows = fixtures.PcbMlModelsTests.rows
    dataset = fixtures.PcbMlModelsTests.dataset
    # Reuse the dataset fixture, not the base test suite.
    def setUp(self):
        fixtures.PcbMlModelsTests.setUp(self)
        self.dataset_path = self.dataset(metadata={"proxy_baseline": {"feature": "x", "direction": "max"}})
        self.model_path = self.root / "engine-model.json"
        self.fitted = ml.train(self.root, self.dataset_path, model_id="test", target="y",
                               output=self.model_path, epochs=12, device="cpu")

    def test_engine_frozen_ood_and_exploration(self):
        ranker = ml.FrozenRanker(self.model_path, self.root, allow_experimental=True)
        candidates = [{"id": str(i), "features": {"x": i - 3, "constant": 7}, "production_score": i}
                      for i in range(7)]
        result = ranker.rank(candidates, self.contract, budget=4)
        self.assertEqual(result["deterministic_exploration_ids"], ["0"])
        self.assertEqual(len(result["candidates"]), 4)
        self.assertEqual(ranker.score({"x": 900, "constant": 7}, self.contract)[1], "outside_training_range")
        self.assertEqual(ranker.score({"x": 1, "constant": 7}, {})[1], "feature_contract_mismatch")
        before = ranker.score(candidates[1]["features"], self.contract)
        self.model_path.write_text("{}")
        self.assertEqual(before, ranker.score(candidates[1]["features"], self.contract))

    def test_engine_default_not_promoted(self):
        ranker = ml.FrozenRanker(self.model_path, self.root)
        self.assertEqual(ranker.score({"x": 0, "constant": 7}, self.contract)[1], "model_not_promoted")
        self.assertFalse(self.fitted["promotion"])

    def test_engine_evaluation_and_unknowns(self):
        report = ml.evaluate(self.root, self.model_path, self.dataset_path)
        self.assertFalse(report["promotion"])
        self.assertIn("ridge", report["folds"]["test"])
        self.assertIn("production_proxy", report["folds"]["test"])
        rows = self.rows()
        rows[0]["targets"]["y"] = None
        path = self.dataset(rows, filename="unknown.json")
        model = ml.train(self.root, path, model_id="unknown", target="y", epochs=2, device="cpu")
        self.assertEqual(len(model["training"]["rows"]), 6)

    def test_engine_holdout_does_not_train(self):
        rows = self.rows()
        for row in rows:
            if row["split"] != "train":
                row["targets"]["y"] = 999999
        path = self.dataset(rows, filename="modified.json")
        changed = ml.train(self.root, path, model_id="test", target="y", epochs=12, device="cpu")
        self.assertEqual(self.fitted["state"], changed["state"])
        self.assertEqual(self.fitted["ranges"], changed["ranges"])

    def test_engine_checksum_and_public_license(self):
        altered = copy.deepcopy(self.fitted)
        altered["state"]["0.bias"][0] += 10
        self.model_path.write_text(json.dumps(altered))
        with self.assertRaisesRegex(ValueError, "checksum"):
            ml.FrozenRanker(self.model_path, self.root)
        with self.assertRaises(ValueError):
            ml.verify_public_corpus({"schema": "iot-lab.pcb-engine-public-corpus.v1",
                "sources": [{"license": "unknown"}]})

    def test_engine_supervised_training_and_evaluation(self):
        import pcb_ml
        report = pcb_ml.execute(self.root, ["engine-train", "supervised", "--dataset",
            str(self.dataset_path), "--target", "y", "--epochs", "2", "--device", "cpu"],
            self.root / "supervised/report.json")
        self.assertEqual(report["status"], "passed", report.get("cause"))
        model = self.root / "supervised/model.json"
        report = pcb_ml.execute(self.root, ["engine-evaluate", "evaluation", "--dataset",
            str(self.dataset_path), "--model", str(model)], self.root / "evaluated/report.json")
        self.assertEqual(report["status"], "passed", report.get("cause"))
        self.assertFalse(report["adopt_model"])


class EngineCorpusTests(unittest.TestCase):
    def test_guarded_repair_proof_rechecks_native_geometry(self):
        import tempfile
        from pcb_engine.learning import _guarded_controls
        from pcb_search.native_srj import geometry_digest, digest
        from placement_outcomes import Evidence
        with tempfile.TemporaryDirectory() as directory:
            attempt = Path(directory)
            (attempt / "repair").mkdir()
            source = attempt / "input.kicad_pcb"
            candidate = attempt / "candidate.kicad_pcb"
            source.write_text('(kicad_pcb (version 20240108) (generator pcbnew))')
            candidate.write_text('(kicad_pcb (version 20240108) (generator pcbnew)'
                ' (segment (start 0 0) (end 1 0) (width 0.25) (layer "F.Cu") (net "n") (uuid "added")))')
            guard = dict(schema="iot-lab.local-routing-guard.v1", status="proposed",
                source_inputs={"input.kicad_pcb": digest(source)}, candidate_sha256=digest(candidate),
                allowed_original_edits=[], added_items=["added"],
                protected_geometry_sha256=geometry_digest(source))
            (attempt / "repair/guard.json").write_text(json.dumps(guard))
            receipt = dict(strategy={"kind": "repair"}, policy={"schema": "iot-lab.engine-policy.v1"})
            result = _guarded_controls(Evidence(attempt), attempt, receipt, source, candidate)
            self.assertEqual(result["kind"], "engine_guarded_native")
            guard["protected_geometry_sha256"] = "0" * 64
            (attempt / "repair/guard.json").write_text(json.dumps(guard))
            with self.assertRaisesRegex(ValueError, "geometry"):
                _guarded_controls(Evidence(attempt), attempt, receipt, source, candidate)

    def test_public_corpus_import_preserves_bytes_without_labels(self):
        import hashlib
        import io
        import tempfile
        from unittest.mock import patch
        from pcb_engine.learning import ingest_public_corpus
        revision = "a" * 40
        source_bytes = b"(kicad_pcb)\n"
        license_bytes = b"Public source license evidence\n"
        payloads = {"board.kicad_pcb": source_bytes, "LICENSE": license_bytes}
        def asset(name):
            return dict(path=name, url=f"https://example.org/{revision}/{name}",
                        sha256=hashlib.sha256(payloads[name]).hexdigest())
        request = dict(schema="iot-lab.pcb-engine-public-corpus.v1", revision=revision,
            sources=[dict(asset("board.kicad_pcb"), license="CC-BY-SA-4.0", attribution="Fixture")],
            license_evidence=[asset("LICENSE")])
        def response(url, **kwargs):
            stream = io.BytesIO(payloads[url.rsplit("/", 1)[-1]])
            stream.url = url
            return stream
        with tempfile.TemporaryDirectory() as directory, patch("urllib.request.urlopen", side_effect=response):
            root = Path(directory)
            manifest = root / "request.json"
            manifest.write_text(json.dumps(request))
            result = ingest_public_corpus(manifest, root / "out")
            self.assertEqual((root / "out/board.kicad_pcb").read_bytes(), source_bytes)
            self.assertFalse(result["labels_eligible"])
            self.assertIsNone(result["labels"])
            request["sources"][0]["sha256"] = "0" * 64
            manifest.write_text(json.dumps(request))
            with self.assertRaisesRegex(ValueError, "SHA256"):
                ingest_public_corpus(manifest, root / "bad")

    def test_internal_gate_flag_never_supplies_full_acceptance(self):
        # Admission rejects a loose attempt directory lacking the supervisor's
        # terminal evidence seal before looking at any gate_passed flag.
        import tempfile
        from pcb_engine.learning import build_dataset
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "run").mkdir()
            (root / "run/result.json").write_text('{"status":"passed","gate_passed":true}')
            import hashlib
            manifest = {"schema": "iot-lab.pcb-engine-corpus.v1", "trials": [{
                "id": "bad", "family": "a", "split": "train", "path": str(root / "run"),
                "sha256": hashlib.sha256((root / "run/result.json").read_bytes()).hexdigest(),
                "attempt_id": "attempt-a"}]}
            (root / "manifest.json").write_text(json.dumps(manifest))
            with self.assertRaisesRegex(ValueError, "terminal"):
                build_dataset(root, "manifest.json", "invalid")

    def test_sealed_failed_attempt_retains_unknown_acceptance(self):
        import hashlib
        import tempfile
        from pcb_engine.learning import build_dataset
        digest = lambda p: hashlib.sha256(p.read_bytes()).hexdigest()
        with tempfile.TemporaryDirectory() as directory:
            run = Path(directory) / "run"
            attempt = run / "operation/engine/attempt-a"
            attempt.mkdir(parents=True)
            (run / "run.json").write_text(json.dumps({"operation": "route", "timeout_s": 30}))
            (run / "operation/result.json").write_text("{}")
            source = attempt / "input.kicad_pcb"
            source.write_text("(kicad_pcb (version 20240108) (generator pcbnew))")
            (attempt / "input.json").write_text(json.dumps({
                "schema": "iot-lab.engine-input.v1", "board_sha256": digest(source),
                "rules_revision": "0" * 64}))
            inventory = {str(p.relative_to(run)): digest(p) for p in run.rglob("*") if p.is_file()}
            terminal = run / "result.json"
            terminal.write_text(json.dumps({"status": "failed", "cleanup": {"complete": True},
                                           "evidence_sha256": inventory, "elapsed_s": 5}))
            manifest = Path(directory) / "corpus.json"
            manifest.write_text(json.dumps({"schema": "iot-lab.pcb-engine-corpus.v1", "trials": [{
                "id": "a", "family": "family", "split": "train", "path": str(run),
                "sha256": digest(terminal), "attempt_id": "attempt-a"}]}))
            result = build_dataset(Path(__file__).resolve().parent.parent, manifest, "failed-attempt")
            row = result["rows"][0]
            self.assertIsNone(row["targets"]["accepted_within_budget"])
            self.assertIsNone(row["targets"]["routed_track_length_mm"])
            self.assertTrue(row["unknowns"])


if __name__ == "__main__":
    unittest.main()
