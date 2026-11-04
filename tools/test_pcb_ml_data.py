"""Advisory table integrity and split tests; no native/runtime/ML dependencies."""
import copy
import hashlib
import json
from pathlib import Path
import tempfile
import unittest
from unittest import mock

import pcb_ml_data as data


def digest(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


class DatasetTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name).resolve()
        self.source = self.root / "owned-evidence.json"
        self.source.write_text('{"observed":true}\n')
        self.inputs = {"owned-evidence.json": digest(self.source)}
        self.path = self.root / "dataset.json"

    def row(self, name="r1", *, family="F1", case="case1", source="source1", run=None,
            pose="pose1", split="train", **changes):
        result = dict(id=name, family=family,
                      case_fingerprint=data.artifact_identity(case),
                      source_fingerprint=data.artifact_identity(source),
                      run_fingerprint=data.artifact_identity(run or name), split=split,
                      features={"density": 0.25, "opens": 1},
                      targets={"routed": 1, "duration": 2.5}, evidence_valid=True)
        if pose is not None:
            result["pose_fingerprint"] = data.artifact_identity(pose)
        result.update(changes)
        return result

    def finalize(self, rows=None, **changes):
        arguments = dict(dataset_id="routing-dev", task="routing_outcome",
                         feature_names=["opens", "density"],
                         target_specs={"routed": {"type": "binary", "direction": "max"},
                                       "duration": {"type": "regression", "direction": "min", "unit": "s"}},
                         rows=[self.row()] if rows is None else rows, inputs=self.inputs,
                         metadata={"feature_contract": {"extractor_sha256": data.artifact_identity("extractor")}})
        arguments.update(changes)
        return data.finalize_dataset(self.root, **arguments)

    def save(self, value):
        self.path.write_text(json.dumps(value) + "\n")
        return self.path

    def test_roundtrip_preserves_feature_order_extra_metadata_and_source_identity(self):
        row = self.row(status="timeout", failure_class="timeout", duration_s=None,
                       censoring={"right_censored": True, "budget_s": 30}, proxy_score=1.25)
        original = copy.deepcopy(row)
        result = self.finalize([row])
        self.assertEqual(row, original)
        self.assertEqual(list(result["rows"][0]["features"]), ["opens", "density"])
        self.assertEqual(result["inputs"], {str(self.source): digest(self.source)})
        self.assertEqual(result["rows"][0]["censoring"], row["censoring"])
        self.assertEqual(result, data.load_dataset(self.root, self.save(result)))
        self.assertEqual([row["id"] for row in data.split_rows(result, "train", "routed")], ["r1"])
        self.assertEqual(data.split_rows(result, "test"), [])

    def test_unknown_observations_and_failed_attempts_stay_visible_without_zero_fill(self):
        missing = self.row("missing", features={"opens": 2}, targets={"routed": None},
                           status="timeout", failure_class="timeout")
        invalid = self.row("invalid", evidence_valid=False, targets={"routed": 0, "duration": None})
        controls = self.row("controls", ineligible_reasons=["routing controls unknown"])
        result = self.finalize([missing, invalid, controls])
        rows = {row["id"]: row for row in result["rows"]}
        self.assertIsNone(rows["missing"]["features"]["density"])
        self.assertIsNone(rows["missing"]["targets"]["duration"])
        self.assertEqual(rows["missing"]["status"], "timeout")
        self.assertEqual(rows["invalid"]["targets"]["routed"], 0)
        self.assertEqual(len(result["rows"]), 3)
        for row in rows.values():
            self.assertFalse(row["eligibility"]["features"])
            self.assertTrue(row["eligibility"]["reasons"])
        self.assertFalse(rows["invalid"]["eligibility"]["targets"]["routed"])
        self.assertEqual(data.split_rows(result, "train", "routed"), [])

    def test_missing_label_does_not_hide_feature_eligible_candidate_from_prediction(self):
        result = self.finalize([self.row(targets={})])
        self.assertEqual(len(data.split_rows(result, "train")), 1)
        self.assertEqual(data.split_rows(result, "train", "routed"), [])
        self.assertFalse(result["rows"][0]["eligibility"]["targets"]["duration"])

    def test_repetitions_stay_eligible_but_run_aliases_count_once_deterministically(self):
        first = self.row("a", run="sealed-run")
        alias = self.row("z", run="sealed-run", historical_alias="other/result.json", ineligible_reasons=[])
        independent = self.row("rep2", run="independent-run")
        result = self.finalize([alias, independent, first])
        self.assertEqual([row["id"] for row in data.split_rows(result, "train", "routed")], ["a", "rep2"])
        duplicate = next(row for row in result["rows"] if row["id"] == "z")
        self.assertEqual(duplicate["eligibility"]["reasons"], [{"code": "duplicate_run", "duplicate_of": "a"}])
        self.assertFalse(duplicate["eligibility"]["targets"]["routed"])
        self.assertEqual(result, self.finalize([first, independent, alias]))

    def test_one_run_cannot_acquire_a_conflicting_label_or_attribution(self):
        for changes in ({"targets": {"routed": 0}}, {"features": {"opens": 999}},
                        {"source_fingerprint": data.artifact_identity("other-source")}):
            with self.subTest(changes=changes), self.assertRaisesRegex(ValueError, "one sealed run"):
                self.finalize([self.row("a", run="same"), self.row("b", run="same", **changes)])

    def test_cross_split_family_case_source_and_run_leakage_are_rejected(self):
        first = self.row("a")
        independent = self.row("b", family="F2", case="case2", source="source2", split="test")
        for field in ("family", "case_fingerprint", "source_fingerprint", "run_fingerprint"):
            second = copy.deepcopy(independent)
            second[field] = first[field]
            second["evidence_valid"] = False
            with self.subTest(field=field), self.assertRaisesRegex(ValueError, "cross-split"):
                self.finalize([first, second])

    def test_pose_tokens_can_repeat_across_unrelated_cases_and_pose_is_optional(self):
        first = self.row("train", pose="identical-XY")
        second = self.row("test", family="F2", case="case2", source="source2",
                          split="test", pose="identical-XY")
        no_pose = self.row("generic", family="F3", case="case3", source="source3", pose=None,
                           split="validation")
        no_pose["pose"] = {"description": "task metadata, not a native pose fingerprint"}
        result = self.finalize([first, second, no_pose])
        self.assertEqual(len(data.split_rows(result, "test", "routed")), 1)
        self.assertNotIn("pose_fingerprint", next(row for row in result["rows"] if row["id"] == "generic"))

    def test_booleans_nonfinite_and_wrong_binary_types_never_become_numeric_labels(self):
        for value in (True, False, float("nan"), float("inf"), -float("inf"), "1"):
            for column in ("features", "targets"):
                changes = {column: {"opens" if column == "features" else "duration": value}}
                with self.subTest(value=value, column=column), self.assertRaises(ValueError):
                    self.finalize([self.row(**changes)])
        for value in (0.0, 1.0, -1, 2):
            with self.subTest(binary=value), self.assertRaisesRegex(ValueError, "binary target"):
                self.finalize([self.row(targets={"routed": value})])

    def test_schema_drift_duplicate_ids_and_missing_provenance_are_rejected(self):
        for row in (self.row(features={"outcome_leak": 1}), self.row(targets={"unknown": 0}),
                    self.row(evidence_valid=None), self.row(source_fingerprint="filename"),
                    self.row(ineligible_reasons=[{}])):
            with self.subTest(row=row), self.assertRaises(ValueError):
                self.finalize([row])
        with self.assertRaisesRegex(ValueError, "duplicate row"):
            self.finalize([self.row(), self.row()])
        with self.assertRaisesRegex(ValueError, "also names a target"):
            self.finalize(feature_names=["routed"])
        with self.assertRaises(ValueError):
            self.finalize(target_specs={"x": {"kind": "regression", "direction": "min"}})

    def test_source_change_missing_artifact_and_empty_input_fail_cleanly(self):
        result = self.finalize()
        self.save(result)
        self.source.write_text("changed after dataset creation")
        with self.assertRaisesRegex(ValueError, "source artifact changed"):
            data.load_dataset(self.root, self.path)
        self.source.unlink()
        with self.assertRaisesRegex(ValueError, "source artifact is missing"):
            data.load_dataset(self.root, self.path)
        for inputs in ({}, None, {"missing.json": "a" * 64}):
            with self.subTest(inputs=inputs), self.assertRaises(ValueError):
                self.finalize(inputs=inputs)

    def test_external_sources_and_aliases_have_one_verified_canonical_entry(self):
        with tempfile.TemporaryDirectory() as external:
            source = Path(external).resolve() / "native-input.json"
            source.write_text("external original")
            alias = self.root / "alias.json"
            alias.symlink_to(source)
            inputs = {str(source): digest(source), str(alias): digest(source)}
            result = self.finalize(inputs=inputs)
            self.assertEqual(result["inputs"], {str(source): digest(source)})
            self.assertEqual(data.load_dataset(self.root, self.save(result)), result)
            inputs[str(alias)] = "0" * 64
            with self.assertRaisesRegex(ValueError, "conflicting hashes"):
                self.finalize(inputs=inputs)

    def test_content_and_recomputed_eligibility_detect_tampering(self):
        original = self.finalize([self.row(evidence_valid=False)])
        edited = copy.deepcopy(original)
        edited["rows"][0]["targets"]["routed"] = 0
        with self.assertRaisesRegex(ValueError, "content identity"):
            data.load_dataset(self.root, self.save(edited))
        edited = copy.deepcopy(original)
        edited["rows"][0]["eligibility"]["features"] = True
        edited["content_sha256"] = data.artifact_identity({key: value for key, value in edited.items() if key != "content_sha256"})
        with self.assertRaisesRegex(ValueError, "eligibility"):
            data.load_dataset(self.root, self.save(edited))
        with self.assertRaisesRegex(ValueError, "eligibility"):
            data.split_rows(edited, "train")

    def test_source_mutation_during_finalize_or_load_is_rejected(self):
        original_payload = data._payload

        def mutate(*args, **kwargs):
            value = original_payload(*args, **kwargs)
            self.source.write_text("changed during processing")
            return value

        with mock.patch.object(data, "_payload", side_effect=mutate):
            with self.assertRaisesRegex(ValueError, "source artifact changed"):
                self.finalize()
        self.source.write_text('{"observed":true}\n')
        result = self.finalize()
        self.save(result)
        with mock.patch.object(data, "_payload", side_effect=mutate):
            with self.assertRaisesRegex(ValueError, "source artifact changed"):
                data.load_dataset(self.root, self.path)

    def test_deterministic_content_identity_and_empty_corpus(self):
        first = self.finalize([self.row("b"), self.row("a")])
        second = self.finalize([self.row("a"), self.row("b")], inputs={str(self.source): digest(self.source)})
        self.assertEqual(first, second)
        reordered = self.finalize([self.row("b"), self.row("a")], feature_names=["density", "opens"])
        self.assertNotEqual(first["content_sha256"], reordered["content_sha256"])
        empty = self.finalize([])
        self.assertEqual(data.split_rows(empty, "train", "duration"), [])
        self.assertEqual(data.load_dataset(self.root, self.save(empty)), empty)
        self.assertEqual(data.artifact_identity({"b": 2, "a": 1}), data.artifact_identity({"a": 1, "b": 2}))

    def test_strict_json_and_unknown_selectors_fail(self):
        self.path.write_text('{"inputs":{},"inputs":{}}')
        with self.assertRaisesRegex(ValueError, "duplicate JSON key"):
            data.load_dataset(self.root, self.path)
        self.path.write_text('{"x":NaN}')
        with self.assertRaisesRegex(ValueError, "nonfinite JSON"):
            data.load_dataset(self.root, self.path)
        result = self.finalize()
        with self.assertRaisesRegex(ValueError, "invalid dataset split"):
            data.split_rows(result, "holdout")
        with self.assertRaisesRegex(ValueError, "unknown target"):
            data.split_rows(result, "train", "missing")


if __name__ == "__main__":
    unittest.main()
