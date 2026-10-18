"""Real parsers and sealed-run protocol fixtures; no KiCad/router execution."""
import copy
import json
from pathlib import Path
import tempfile
import unittest

import pcb_ml_adapters as adapters
import pcb_ml_data as data
import pcb_ml_features as features
import test_placement_outcomes as history


NATIVE = '''(kicad_pcb (version 20260101)
 (layers (0 "F.Cu" signal) (31 "B.Cu" signal))
 (net 0 "") (net 1 "/A")
 (footprint "Test" (layer "F.Cu") (at 10 10 90)
   (property "Reference" "U1")
   (pad "1" smd rect (at 2 0) (size 1 1) (layers "F.Cu") (net 1 "/A")))
 (footprint "Test" (layer "B.Cu") (at 20 10)
   (property "Reference" "U2")
   (pad "1" smd rect (at 0 0) (size 1 1) (layers "B.Cu") (net 1 "/A")))
 (gr_rect (start 0 0) (end 30 20) (layer "Edge.Cuts"))
 (segment (start 0 1) (end 1 1) (width 0.2) (layer "F.Cu") (net 1))
 (via (at 1 1) (size 0.6) (drill 0.3) (layers "F.Cu" "B.Cu") (net 1))
 (zone (net 1) (net_name "/A") (layer "F.Cu")))'''


def write(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value) + "\n")


class FeatureTests(unittest.TestCase):
    def without_legacy_nets(self):
        return NATIVE.replace(' (net 0 "") (net 1 "/A")\n', '')

    def test_kicad10_pad_local_named_nets_are_counted_without_a_legacy_table(self):
        native = self.without_legacy_nets().replace('(net 1 "/A")', '(net "/A")')
        native = native.replace('(net "/A")', '(net "/B")', 1)
        values, causes = features.routing_features(native)
        self.assertEqual(values['declared_net_count'], 2)
        self.assertEqual(causes, [])
        self.assertEqual(features.feature_contract('routing')['version'], 2)
        self.assertEqual(features.feature_contract('workflow')['version'], 1)

    def test_legacy_numeric_references_and_later_explicit_pad_declarations_resolve(self):
        legacy = NATIVE.replace('(net 1 "/A")', '(net 1)').replace('(net 1)', '(net 1 "/A")', 1)
        named = self.without_legacy_nets().replace('(net 1 "/A")', '(net 7 "/A")')
        named = named.replace('(net 7 "/A")', '(net 7)', 1)
        for native in (legacy, named):
            with self.subTest(native=native):
                values, causes = features.routing_features(native)
                self.assertEqual(values['declared_net_count'], 1)
                self.assertEqual(values['all_net_pad_hpwl_mm'], 12)
                self.assertEqual(causes, [])

    def test_mixed_declarations_deduplicate_names_and_exclude_empty_names(self):
        native = NATIVE.replace('(net 0 "")', '(net 0 "") (net 2 "/A") (net 3 "/UNUSED")')
        native = native.replace('(net 1 "/A")))', '(net "/B")))', 1)
        native = native.replace('(net 1 "/A")))', '(net "")))', 1)
        values, causes = features.routing_features(native)
        self.assertEqual(values['declared_net_count'], 3)
        self.assertEqual(causes, [])

    def test_unresolved_numeric_pad_net_keeps_net_count_and_geometry_unknown(self):
        native = self.without_legacy_nets().replace('(net 1 "/A")', '(net 7)')
        values, causes = features.routing_features(native)
        self.assertIsNone(values['declared_net_count'])
        self.assertIsNone(values['all_net_pad_hpwl_mm'])
        self.assertIsNone(values['all_net_pairwise_distance_sum_mm'])
        self.assertIn('native_net_unknown', {row['code'] for row in causes})
        self.assertIn('declared_net_count', {row.get('feature') for row in causes})

    def test_named_pad_declarations_cannot_contradict_table_or_each_other(self):
        for native in (NATIVE, self.without_legacy_nets()):
            changed = native.replace('(net 1 "/A")))', '(net 1 "/CONFLICT")))', 1)
            with self.subTest(native=native), self.assertRaisesRegex(ValueError, 'pad net differs'):
                features.routing_features(changed)

    def test_native_pad_rotation_counts_and_all_net_measurements(self):
        values, causes = features.routing_features(NATIVE)
        self.assertEqual(causes, [])
        self.assertEqual(values["footprint_count"], 2)
        self.assertEqual(values["pad_count"], 2)
        self.assertEqual(values["copper_layer_count"], 2)
        self.assertEqual(values["declared_net_count"], 1)
        self.assertEqual(values["retained_track_count"], 1)
        self.assertEqual(values["retained_via_count"], 1)
        self.assertEqual(values["retained_zone_count"], 1)
        self.assertEqual(values["two_pad_net_count"], 1)
        self.assertAlmostEqual(values["all_net_pad_hpwl_mm"], 12)
        self.assertAlmostEqual(values["two_pad_distance_sum_mm"], 104 ** 0.5)
        self.assertAlmostEqual(values["all_net_pairwise_distance_sum_mm"], 104 ** 0.5)
        self.assertEqual(values["edge_bbox_area_mm2"], 600)
        moved, _ = features.routing_features(NATIVE.replace("(at 20 10)", "(at 25 10)"))
        self.assertAlmostEqual(moved["all_net_pad_hpwl_mm"], 17)
        self.assertEqual(moved["retained_track_count"], values["retained_track_count"])

    def test_interior_pad_motion_changes_pairwise_distance_without_changing_hpwl(self):
        native = '''(kicad_pcb (layers (0 "F.Cu" signal) (31 "B.Cu" signal))
          (footprint "A" (at 0 0) (pad "1" (at 0 0) (net "/A")))
          (footprint "B" (at 10 10) (pad "1" (at 0 0) (net "/A")))
          (footprint "C" (at 5 6 90) (pad "1" (at 1 0) (net "/A")))
          (footprint "D" (at 1000 1000) (pad "1" (at 0 0) (net "/OTHER")))
          (gr_rect (start 0 0) (end 1010 1010) (layer "Edge.Cuts")))'''
        before, causes = features.routing_features(native)
        after, moved_causes = features.routing_features(native.replace('(at 5 6 90)', '(at 5.5 6 90)'))
        self.assertEqual(causes, [])
        self.assertEqual(moved_causes, [])
        self.assertEqual(before['all_net_pad_hpwl_mm'], 20)
        self.assertEqual(after['all_net_pad_hpwl_mm'], before['all_net_pad_hpwl_mm'])
        self.assertAlmostEqual(before['all_net_pairwise_distance_sum_mm'], 2 * 200 ** .5)
        self.assertGreater(after['all_net_pairwise_distance_sum_mm'], before['all_net_pairwise_distance_sum_mm'])
        column = next(row for row in features.feature_contract('routing')['features']
                      if row['name'] == 'all_net_pairwise_distance_sum_mm')
        self.assertEqual(column['unit'], 'mm')

    def test_unsupported_geometry_is_unknown_not_an_approximation(self):
        native = NATIVE.replace('(gr_rect (start 0 0) (end 30 20) (layer "Edge.Cuts"))',
                                '(gr_arc (start 0 0) (mid 5 5) (end 10 0) (layer "Edge.Cuts"))')
        values, causes = features.routing_features(native)
        self.assertIsNone(values["edge_bbox_area_mm2"])
        self.assertEqual(values["pad_count"], 2)
        self.assertIn("edge_bbox_area_mm2", {row.get("feature") for row in causes})
        values, causes = features.routing_features(NATIVE.replace("(at 2 0)", ""))
        self.assertIsNone(values["all_net_pad_hpwl_mm"])
        self.assertIsNone(values["two_pad_distance_sum_mm"])
        self.assertIsNone(values["all_net_pairwise_distance_sum_mm"])
        self.assertTrue(causes)
        with self.assertRaisesRegex(ValueError, "unbalanced"):
            features.routing_features(NATIVE[:-1])

    def test_workflow_features_read_only_predecision_fields(self):
        original = dict(operation="parts", timeout_s=30, project="cad/X", arguments=["inspect"],
                        targets={"run_passed": 0}, result={"elapsed_s": 999})
        values, causes = features.workflow_features(original)
        self.assertEqual(causes, [])
        self.assertEqual(values["budget_s"], 30)
        self.assertEqual(values["operation_parts"], 1)
        self.assertEqual(sum(values["operation_" + name] for name in features.OPERATIONS), 1)
        changed = dict(original, result={"elapsed_s": 0}, targets={"run_passed": 1})
        self.assertEqual(features.workflow_features(changed), (values, causes))
        self.assertEqual(features.workflow_case(changed), features.workflow_case(original))
        values, causes = features.workflow_features(dict(operation="unknown", timeout_s=True))
        self.assertIsNone(values["budget_s"])
        self.assertIsNone(values["operation_parts"])
        self.assertTrue(causes)


class AdapterTests(unittest.TestCase):
    def setUp(self):
        self.fixture = history.OutcomeTests(methodName="test_absent_controls_stay_observational_and_timeout_is_in_denominator")
        self.fixture.setUp()
        self.addCleanup(self.fixture.doCleanups)
        self.root = self.fixture.root
        self.manifest = self.root / "corpus.json"
        self.request = self.root / "request.json"

    def trial(self, split="train", family="DEV", arm="baseline", replicate=1, status="passed", controlled=True):
        folder, trial = self.fixture.run_fixture(split, family, arm, replicate, status, controlled)
        run = json.loads((folder / "run.json").read_text())
        run["timeout_s"] = 30
        write(folder / "run.json", run)
        original = Path(trial["placement_input"]["path"])
        native = original.read_text().replace("(kicad_pcb", '(kicad_pcb (layers (0 "F.Cu" signal) (31 "B.Cu" signal)) (net 1 "N") (gr_rect (start 0 0) (end 30 20) (layer "Edge.Cuts"))', 1)
        self.update_native(folder, trial, native)
        return folder, trial

    def update_native(self, folder, trial, original_text=None, candidate_text=None):
        original = Path(trial["placement_input"]["path"])
        if original_text is not None:
            original.write_text(original_text)
        trial["placement_input"]["sha256"] = adapters._sha(original)
        operation_path = folder / "operation/result.json"
        operation = json.loads(operation_path.read_text())
        candidate = folder / "workspace" / Path(operation["candidate"]).relative_to(operation["workspace"])
        candidate.write_text(candidate_text if candidate_text is not None else original.read_text())
        operation["candidate_sha256"] = adapters._sha(candidate)
        write(operation_path, operation)
        source = json.loads((folder / "operation/source.json").read_text())
        key = str(candidate.relative_to(folder / "workspace"))
        source["files"][key] = adapters._sha(original)
        write(folder / "operation/source.json", source)
        gate = json.loads((folder / "gate/result.json").read_text())
        gate["provenance"]["inputs"][0]["sha256"] = adapters._sha(candidate)
        write(folder / "gate/result.json", gate)
        self.fixture.reseal(folder, json.loads((folder / "result.json").read_text())["status"])
        trial["sha256"] = adapters._sha(folder / "result.json")

    def corpus(self, trials, adapter="routing"):
        write(self.manifest, dict(schema=adapters.CORPUS, dataset_id="real-protocol", adapter=adapter, trials=trials))
        return adapters.build_dataset(self.root, self.manifest)

    def packet(self, source, adapter="routing"):
        write(self.request, dict(schema=adapters.REQUEST, id="candidate-features", adapter=adapter,
                                 samples=[dict(id="candidate", source=dict(path=str(source), sha256=adapters._sha(source)))]))
        return adapters.make_feature_packet(self.root, self.request)

    def test_routing_uses_original_input_not_routed_geometry_and_acceptance_is_sourced(self):
        folder, trial = self.trial()
        original = Path(trial["placement_input"]["path"])
        routed = original.read_text()[:-1] + '(segment (start 1 1) (end 2 1) (width 0.2) (layer "F.Cu") (net 1)))'
        self.update_native(folder, trial, candidate_text=routed)
        dataset = self.corpus([trial])
        row = dataset["rows"][0]
        self.assertTrue(row["evidence_valid"])
        self.assertTrue(row["eligibility"]["features"])
        self.assertEqual(row["features"]["retained_track_count"], 0)
        self.assertEqual(row["targets"]["accepted_within_budget"], 1)
        self.assertEqual(row["targets"]["owned_elapsed_s"], 2)
        self.assertEqual(row["targets"]["successful_completion_elapsed_s"], 2)
        self.assertEqual(row["targets"]["native_opens"], 0)
        packet = self.packet(original)
        self.assertEqual(packet["feature_contract"], dataset["metadata"]["feature_contract"])
        self.assertEqual(packet["rows"][0]["features"], row["features"])
        self.assertFalse(any(Path(name).is_absolute() for name in packet["feature_contract"]["implementation_sha256"]))

    def test_timeout_and_absent_controls_keep_attempt_and_unknown_completion(self):
        _, trial = self.trial(status="timeout", controlled=False)
        dataset = self.corpus([trial])
        row = dataset["rows"][0]
        self.assertTrue(row["evidence_valid"])
        self.assertFalse(row["controls_known"])
        self.assertFalse(row["eligibility"]["features"])
        self.assertIsNone(row["targets"]["accepted_within_budget"])
        self.assertIsNone(row["targets"]["successful_completion_elapsed_s"])
        self.assertEqual(row["targets"]["owned_elapsed_s"], 2)
        self.assertEqual(row["observation"]["failure_class"], "timeout")
        self.assertFalse(row["completion_censoring"]["observed"])
        self.assertEqual(len(dataset["rows"]), 1)

    def test_quality_labels_measure_exact_final_native_copper_without_feature_leakage(self):
        folder,trial=self.trial()
        original=Path(trial['placement_input']['path'])
        routed=original.read_text()[:-1]+'''
            (segment (start -1 -1) (end 2 3) (width 0.2) (layer "F.Cu") (net 1))
            (segment (start 2 3) (end 5 3) (width 0.2) (layer "B.Cu") (net 1))
            (via (at 2 3) (size 0.6) (drill 0.3) (layers "F.Cu" "B.Cu") (net 1)))'''
        self.update_native(folder,trial,candidate_text=routed)
        dataset=self.corpus([trial]);row=dataset['rows'][0]
        self.assertEqual(row['targets']['routed_track_length_mm'],8)
        self.assertEqual(row['targets']['routed_via_count'],1)
        self.assertTrue(row['eligibility']['targets']['routed_track_length_mm'])
        self.assertTrue(row['eligibility']['targets']['routed_via_count'])
        self.assertEqual(row['features']['retained_track_count'],0)
        self.assertEqual(row['features']['retained_via_count'],0)
        self.assertEqual(row['features'],self.packet(original)['rows'][0]['features'])
        self.assertNotIn('routed_track_length_mm',dataset['feature_names'])
        quality=row['observation']['routed_quality']
        candidate=Path(quality['candidate']['path'])
        self.assertEqual(quality['candidate']['sha256'],adapters._sha(candidate))
        self.assertEqual(dataset['inputs'][str(candidate)],quality['candidate']['sha256'])
        self.assertEqual(quality['unknowns'],{})
        self.assertIn('retained copper included',quality['scope'])

    def test_unsupported_or_nonfinite_track_geometry_never_becomes_zero_length(self):
        segment='(segment (start 0 0) (end 3 4) (width 0.2) (layer "F.Cu") (net 1))'
        via='(via (at 3 4) (size 0.6) (drill 0.3) (layers "F.Cu" "B.Cu") (net 1))'
        changes=[('arc','(arc (start 0 0) (mid 1 1) (end 2 0) (width 0.2) (layer "F.Cu") (net 1))'),
                 ('nan',segment.replace('3 4','nan 4')),('infinite',segment.replace('3 4','1e999 4')),
                 ('wrong_unit',segment.replace('3 4','3mm 4')),('missing_endpoint',segment.replace('(end 3 4)','')),
                 ('duplicate_endpoint',segment.replace('(end 3 4)','(end 3 4) (end 5 6)')),
                 ('noncopper',segment.replace('F.Cu','F.SilkS'))]
        for name,track in changes:
            with self.subTest(geometry=name):
                folder,trial=self.trial(arm=name)
                original=Path(trial['placement_input']['path'])
                self.update_native(folder,trial,candidate_text=original.read_text()[:-1]+track+via+')')
                row=self.corpus([trial])['rows'][0]
                self.assertEqual(row['targets']['accepted_within_budget'],1)
                self.assertIsNone(row['targets']['routed_track_length_mm'])
                self.assertFalse(row['eligibility']['targets']['routed_track_length_mm'])
                self.assertEqual(row['targets']['routed_via_count'],1)
                self.assertTrue(row['observation']['routed_quality']['unknowns']['routed_track_length_mm'])

    def test_malformed_via_does_not_hide_valid_segment_length(self):
        folder,trial=self.trial()
        original=Path(trial['placement_input']['path'])
        routed=original.read_text()[:-1]+'''
            (segment (start 0 0) (end 3 4) (width 0.2) (layer "F.Cu") (net 1))
            (via (at 3 nan) (size 0.6) (drill 0.3) (layers "F.Cu" "B.Cu") (net 1)))'''
        self.update_native(folder,trial,candidate_text=routed)
        row=self.corpus([trial])['rows'][0]
        self.assertEqual(row['targets']['routed_track_length_mm'],5)
        self.assertIsNone(row['targets']['routed_via_count'])
        self.assertTrue(row['observation']['routed_quality']['unknowns']['routed_via_count'])

    def test_failed_timeout_and_control_unknown_rows_have_no_successful_quality_labels(self):
        for name,status,controlled in (('failure','failed',True),('timeout','timeout',True),
                                       ('unknown','passed',False)):
            with self.subTest(outcome=name):
                folder,trial=self.trial(arm=name,status=status,controlled=controlled)
                original=Path(trial['placement_input']['path'])
                self.update_native(folder,trial,candidate_text=original.read_text()[:-1]+'''
                    (segment (start 0 0) (end 3 4) (width 0.2) (layer "F.Cu") (net 1)))''')
                row=self.corpus([trial])['rows'][0]
                self.assertIsNone(row['targets']['routed_track_length_mm'])
                self.assertIsNone(row['targets']['routed_via_count'])
                self.assertTrue(row['observation']['routed_quality']['unknowns'])

    def test_quality_requires_sealed_candidate_and_exact_fresh_native_binding(self):
        for change in ('candidate_bytes','binding','cached','units','over_budget'):
            with self.subTest(change=change):
                folder,trial=self.trial(arm=change)
                operation=json.loads((folder/'operation/result.json').read_text())
                candidate=folder/'workspace'/Path(operation['candidate']).relative_to(operation['workspace'])
                if change=='candidate_bytes':
                    candidate.write_text(candidate.read_text()[:-1]+'''
                        (segment (start 0 0) (end 3 4) (width 0.2) (layer "F.Cu") (net 1)))''')
                else:
                    gate_path=folder/'gate/result.json';gate=json.loads(gate_path.read_text())
                    if change=='binding':gate['provenance']['inputs'][0]['sha256']='0'*64
                    if change=='cached':gate['checks']['drc']['cached']=True
                    if change=='units':
                        path=folder/'gate/drc.json';raw=json.loads(path.read_text());raw['coordinate_units']='in';write(path,raw)
                    write(gate_path,gate)
                    if change=='over_budget':
                        manifest=json.loads((folder/'run.json').read_text());manifest['timeout_s']=1;write(folder/'run.json',manifest)
                    self.fixture.reseal(folder);trial['sha256']=adapters._sha(folder/'result.json')
                row=self.corpus([trial])['rows'][0]
                self.assertIsNone(row['targets']['routed_track_length_mm'])
                self.assertIsNone(row['targets']['routed_via_count'])
                if change!='over_budget':self.assertFalse(row['evidence_valid'])
                else:self.assertEqual(row['targets']['accepted_within_budget'],0)

    def test_controlled_failure_has_zero_acceptance_but_never_zero_completion_time(self):
        _, trial = self.trial(status="failed")
        row = self.corpus([trial])["rows"][0]
        self.assertEqual(row["targets"]["accepted_within_budget"], 0)
        self.assertEqual(row["targets"]["native_errors"], 1)
        self.assertIsNone(row["targets"]["successful_completion_elapsed_s"])
        self.assertTrue(row["eligibility"]["targets"]["owned_elapsed_s"])

    def test_acceptance_budget_is_the_whole_run_not_the_solver_phase(self):
        folder, trial = self.trial()
        manifest_path = folder / "run.json"
        manifest = json.loads(manifest_path.read_text())
        manifest["timeout_s"] = 120
        write(manifest_path, manifest)
        policy_path = folder / "operation/execution-policy.json"
        policy = json.loads(policy_path.read_text())
        policy["effort"]["timeout_s"] = 120
        policy["effort"]["router_timeout_s"] = 30
        write(policy_path, policy)
        self.fixture.reseal(folder)
        trial["sha256"] = adapters._sha(folder / "result.json")
        row = self.corpus([trial])["rows"][0]
        self.assertEqual(row["targets"]["owned_elapsed_s"], 2)
        self.assertEqual(row["owned_run_budget_s"], 120)
        self.assertEqual(row["solver_timeout_s"], 30)
        self.assertEqual(row["targets"]["accepted_within_budget"], 1)

    def test_corrupt_seal_and_substituted_original_remain_ineligible(self):
        folder, trial = self.trial()
        (folder / "operation/source.json").write_text('{}')
        row = self.corpus([trial])["rows"][0]
        self.assertFalse(row["evidence_valid"])
        self.assertIsNone(row["targets"]["accepted_within_budget"])
        self.assertTrue(row["ineligible_reasons"])
        self.assertFalse(row["eligibility"]["features"])
        # A current, correctly hashed different PCB cannot replace the original
        # source whose hash is sealed in operation/source.json.
        folder, trial = self.trial(arm="substitution")
        replacement = self.root / "substitute.kicad_pcb"
        replacement.write_text(NATIVE)
        trial["placement_input"] = dict(path=str(replacement), sha256=adapters._sha(replacement))
        row = self.corpus([trial])["rows"][0]
        self.assertFalse(row["evidence_valid"])
        self.assertIn("original route input", " ".join(row["ineligible_reasons"]))

    def test_source_bound_invalid_native_coordinates_retain_the_attempt(self):
        folder, trial = self.trial()
        original = Path(trial["placement_input"]["path"])
        self.update_native(folder, trial, original.read_text().replace("(at 10 10)", "(at invalid 10)"))
        dataset = self.corpus([trial])
        self.assertEqual(len(dataset["rows"]), 1)
        row = dataset["rows"][0]
        self.assertFalse(row["evidence_valid"])
        self.assertFalse(row["eligibility"]["features"])
        self.assertIsNone(row["targets"]["accepted_within_budget"])
        self.assertTrue(row["ineligible_reasons"])

    def test_missing_historical_artifacts_are_inventory_absences_not_fake_labels(self):
        _, trial = self.trial()
        original = Path(trial["placement_input"]["path"])
        original.unlink()
        write(self.manifest, dict(schema=adapters.CORPUS, dataset_id="missing", adapter="routing", trials=[trial]))
        dependencies = adapters.manifest_dependencies(self.root, self.manifest)
        self.assertIsNone(dependencies[str(original)])
        dataset = adapters.build_dataset(self.root, self.manifest)
        self.assertIn(str(original), dataset["metadata"]["absent_inputs"])
        row = dataset["rows"][0]
        self.assertFalse(row["evidence_valid"])
        self.assertTrue(all(value is None for value in row["features"].values()))
        self.assertIsNone(row["targets"]["native_opens"])

    def test_unbound_terminal_is_not_accepted_and_observer_implementations_are_bound(self):
        _, trial = self.trial()
        dataset = self.corpus([trial])
        tools = Path(adapters.__file__).resolve().parent
        for relative in ("pcb_search/native_placement.py", "pcb_search/native_eco.py", "pcb_search/native_candidate.py", "blocks.py"):
            path = tools / relative
            self.assertEqual(dataset["inputs"][str(path)], adapters._sha(path))
        trial.pop("sha256")
        with self.assertRaisesRegex(ValueError, "terminal SHA256"):
            self.corpus([trial])

    def test_duplicate_aliases_are_excluded_but_independent_repeats_remain(self):
        _, first = self.trial()
        _, repeat = self.trial(replicate=2)
        alias = copy.deepcopy(first)
        alias["id"] = "alias"
        dataset = self.corpus([first, alias, repeat])
        self.assertEqual(len(dataset["rows"]), 3)
        self.assertEqual(len(data.split_rows(dataset, "train", "accepted_within_budget")), 2)
        self.assertEqual(dataset["rows"][0]["run_fingerprint"], next(row for row in dataset["rows"] if row["id"] == first["id"])["run_fingerprint"])

    def test_same_native_case_cannot_be_relabelled_into_another_split(self):
        _, first = self.trial()
        _, second = self.trial(split="test", family="DEV")
        second["family"] = "invented-family"
        with self.assertRaisesRegex(ValueError, "cross-split"):
            self.corpus([first, second])

    def test_workflow_adapter_uses_pre_run_manifest_and_records_terminal_only_target(self):
        folder, trial = self.trial(status="timeout", controlled=False)
        run = json.loads((folder / "run.json").read_text())
        run["operation"] = "parts"
        run["arguments"] = ["inspect", "X", "--datasheet", "original.pdf"]
        write(folder / "run.json", run)
        self.fixture.reseal(folder, "timeout")
        trial["sha256"] = adapters._sha(folder / "result.json")
        dataset = self.corpus([trial], "workflow")
        row = dataset["rows"][0]
        self.assertTrue(row["evidence_valid"])
        self.assertEqual(row["features"]["operation_parts"], 1)
        self.assertEqual(row["features"]["budget_s"], 30)
        self.assertEqual(row["targets"], dict(run_passed=0, owned_elapsed_s=2))
        packet = self.packet(folder / "run.json", "workflow")
        self.assertEqual(packet["rows"][0]["features"], row["features"])
        self.assertEqual(packet["feature_contract"], dataset["metadata"]["feature_contract"])

    def test_workflow_case_binds_actual_predecision_cad_and_normalizes_host_paths(self):
        trials = []
        for split, family in (("train", "DEV"), ("test", "HOLD")):
            folder, trial = self.trial(split=split, family=family)
            run = json.loads((folder / "run.json").read_text())
            run.update(operation="check", board="SAME", project="cad/SAME")
            write(folder / "run.json", run)
            # Check runs have a native source receipt rather than a candidate
            # snapshot. Exact native inputs distinguish the electrical cases.
            (folder / "operation/source.json").unlink()
            gate = json.loads((folder / "gate/result.json").read_text())
            gate["provenance"]["inputs"][0]["path"] = "/old-host/checkout/hardware-design/boards/SAME/cad/SAME.kicad_pcb"
            write(folder / "gate/result.json", gate)
            self.fixture.reseal(folder)
            trial["sha256"] = adapters._sha(folder / "result.json")
            trials.append(trial)
        dataset = self.corpus(trials, "workflow")
        self.assertNotEqual(dataset["rows"][0]["case_fingerprint"], dataset["rows"][1]["case_fingerprint"])
        original_case = next(row for row in dataset["rows"] if row["split"] == "train")["case_fingerprint"]
        folder = Path(trials[0]["path"])
        gate = json.loads((folder / "gate/result.json").read_text())
        gate["provenance"]["inputs"][0]["path"] = gate["provenance"]["inputs"][0]["path"].replace("/old-host/checkout", "/new-host/copy")
        write(folder / "gate/result.json", gate)
        self.fixture.reseal(folder)
        trials[0]["sha256"] = adapters._sha(folder / "result.json")
        changed = self.corpus(trials, "workflow")
        self.assertEqual(next(row for row in changed["rows"] if row["split"] == "train")["case_fingerprint"], original_case)

    def test_packet_reextracts_original_values_and_rejects_outcomes_and_source_edits(self):
        source = self.root / "native.kicad_pcb"
        source.write_text(NATIVE)
        packet = self.packet(source)
        path = self.root / "features.json"
        path.write_text(json.dumps(packet, sort_keys=True))
        loaded = adapters.load_feature_packet(self.root, path)
        self.assertEqual(loaded, packet)
        self.assertEqual(list(loaded["rows"][0]["features"]), loaded["feature_names"])
        edited = copy.deepcopy(packet)
        edited["rows"][0]["features"]["pad_count"] = 999
        edited["content_sha256"] = data.artifact_identity({key: item for key, item in edited.items() if key != "content_sha256"})
        write(path, edited)
        with self.assertRaisesRegex(ValueError, "original source extraction"):
            adapters.load_feature_packet(self.root, path)
        edited = copy.deepcopy(packet)
        edited["rows"][0]["features"]["retained_track_count"] = True
        edited["content_sha256"] = data.artifact_identity({key: item for key, item in edited.items() if key != "content_sha256"})
        write(path, edited)
        with self.assertRaisesRegex(ValueError, "original source extraction"):
            adapters.load_feature_packet(self.root, path)
        edited = copy.deepcopy(packet)
        edited["rows"][0]["targets"] = {"accepted_within_budget": 1}
        edited["content_sha256"] = data.artifact_identity({key: item for key, item in edited.items() if key != "content_sha256"})
        write(path, edited)
        with self.assertRaisesRegex(ValueError, "outcomes"):
            adapters.load_feature_packet(self.root, path)
        write(path, packet)
        source.write_text(NATIVE.replace("(at 20 10)", "(at 21 10)"))
        with self.assertRaisesRegex(ValueError, "source artifact changed"):
            adapters.load_feature_packet(self.root, path)


if __name__ == "__main__":
    unittest.main()
