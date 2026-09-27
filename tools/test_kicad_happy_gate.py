#!/usr/bin/env python3
"""Tests for tools/kicad_happy_gate.py.

These tests cover only the pure parse/filter functions. They use small
JSON fixtures cut from a real kicad-happy evaluation run, so they need no
kicad-happy clone and no PCB file. Run with: python3 tools/test_kicad_happy_gate.py
"""
import json
import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import kicad_happy_gate as gate

FIXTURES = os.path.join(os.path.dirname(os.path.abspath(__file__)), "fixtures")


def load_fixture(name):
    with open(os.path.join(FIXTURES, name)) as fh:
        return json.load(fh)


class LoadFindingsTests(unittest.TestCase):
    def test_pulls_flat_findings_list(self):
        doc = load_fixture("kicad_happy_pcb_sample.json")
        findings = gate.load_findings(doc)
        self.assertEqual(len(findings), 3)
        self.assertTrue(all("rule_id" in f for f in findings))

    def test_missing_findings_key_returns_empty(self):
        self.assertEqual(gate.load_findings({"analyzer_type": "x"}), [])

    def test_non_dict_input_returns_empty(self):
        self.assertEqual(gate.load_findings(None), [])


class FilterFindingsTests(unittest.TestCase):
    def setUp(self):
        self.sch = gate.load_findings(load_fixture("kicad_happy_sch_sample.json"))
        self.pcb = gate.load_findings(load_fixture("kicad_happy_pcb_sample.json"))
        self.emc = gate.load_findings(load_fixture("kicad_happy_emc_sample.json"))

    def test_keeps_only_allowed_rule_ids(self):
        allowed = ["GP-001", "RP-001", "VP-001", "DC-002", "UC-001"]
        kept = gate.filter_findings(self.sch + self.pcb + self.emc, allowed)
        kept_ids = {f["rule_id"] for f in kept}
        # UC-001 (sch), VP-001 (pcb), GP-001 and RP-001 (emc) are in-fixture and allowed
        self.assertEqual(kept_ids, {"UC-001", "VP-001", "GP-001", "RP-001"})

    def test_drops_ignored_rule_ids(self):
        allowed = ["GP-001", "RP-001", "VP-001", "DC-002", "UC-001"]
        kept = gate.filter_findings(self.sch + self.pcb + self.emc, allowed)
        kept_ids = {f["rule_id"] for f in kept}
        # VM-001 (sch), KO-001 / CC-002 (pcb), SU-001 / XT-001 (emc) must be dropped
        for ignored in ("VM-001", "KO-001", "CC-002", "SU-001", "XT-001"):
            self.assertNotIn(ignored, kept_ids)

    def test_empty_findings_yields_empty(self):
        self.assertEqual(gate.filter_findings([], ["GP-001"]), [])

    def test_min_severity_floor_drops_lower_severity(self):
        findings = [
            {"rule_id": "GP-001", "severity": "info", "summary": "low"},
            {"rule_id": "GP-001", "severity": "warning", "summary": "mid"},
            {"rule_id": "GP-001", "severity": "critical", "summary": "high"},
        ]
        kept = gate.filter_findings(findings, ["GP-001"], min_severity="warning")
        self.assertEqual([f["summary"] for f in kept], ["mid", "high"])

    def test_no_min_severity_keeps_all_severities(self):
        findings = [
            {"rule_id": "GP-001", "severity": "info", "summary": "low"},
            {"rule_id": "GP-001", "severity": "critical", "summary": "high"},
        ]
        kept = gate.filter_findings(findings, ["GP-001"])
        self.assertEqual(len(kept), 2)


class FormatFindingTests(unittest.TestCase):
    def test_formats_rule_and_summary(self):
        f = {"rule_id": "VP-001", "summary": "Via in pad on U3 pin 4"}
        self.assertEqual(gate.format_finding(f), "FAIL VP-001 Via in pad on U3 pin 4")

    def test_falls_back_to_description_when_no_summary(self):
        f = {"rule_id": "GP-001", "description": "Ground plane coverage too low"}
        self.assertEqual(
            gate.format_finding(f), "FAIL GP-001 Ground plane coverage too low"
        )


class ResolveBoardTests(unittest.TestCase):
    def test_resolves_pcb_file_argument(self):
        import tempfile

        with tempfile.TemporaryDirectory() as d:
            pcb_path = os.path.join(d, "BOARD.kicad_pcb")
            sch_path = os.path.join(d, "BOARD.kicad_sch")
            open(pcb_path, "w").close()
            open(sch_path, "w").close()
            pcb, sch = gate.resolve_board(pcb_path)
            self.assertEqual(pcb, pcb_path)
            self.assertEqual(sch, sch_path)

    def test_resolves_directory_argument(self):
        import tempfile

        with tempfile.TemporaryDirectory() as d:
            pcb_path = os.path.join(d, "BOARD.kicad_pcb")
            open(pcb_path, "w").close()
            pcb, sch = gate.resolve_board(d)
            self.assertEqual(pcb, pcb_path)
            self.assertIsNone(sch)

    def test_rejects_directory_with_no_pcb(self):
        import tempfile

        with tempfile.TemporaryDirectory() as d:
            with self.assertRaises(ValueError):
                gate.resolve_board(d)

    def test_rejects_directory_with_multiple_pcbs(self):
        import tempfile

        with tempfile.TemporaryDirectory() as d:
            open(os.path.join(d, "A.kicad_pcb"), "w").close()
            open(os.path.join(d, "B.kicad_pcb"), "w").close()
            with self.assertRaises(ValueError):
                gate.resolve_board(d)


class CheckPinnedTests(unittest.TestCase):
    def test_missing_dir_reports_error(self):
        err = gate.check_pinned("/nonexistent/kicad-happy-clone")
        self.assertIsNotNone(err)
        self.assertIn("not found", err)

    def test_wrong_commit_reports_error(self):
        import subprocess
        import tempfile

        with tempfile.TemporaryDirectory() as d:
            subprocess.run(["git", "init", "--quiet", d], check=True)
            subprocess.run(
                ["git", "-C", d, "commit", "--allow-empty", "--quiet", "-m", "x"],
                check=True,
                env={**os.environ, "GIT_AUTHOR_NAME": "t", "GIT_AUTHOR_EMAIL": "t@t",
                     "GIT_COMMITTER_NAME": "t", "GIT_COMMITTER_EMAIL": "t@t"},
            )
            err = gate.check_pinned(d)
            self.assertIsNotNone(err)
            self.assertIn("not the pinned commit", err)


class ExemptTests(unittest.TestCase):
    RULES = ["GP-001", "RP-001", "VP-001", "DC-002", "UC-001"]

    def setUp(self):
        self.findings = gate.filter_findings(
            gate.load_findings(load_fixture("kicad_happy_sch_sample.json"))
            + gate.load_findings(load_fixture("kicad_happy_pcb_sample.json"))
            + gate.load_findings(load_fixture("kicad_happy_emc_sample.json")),
            self.RULES,
        )

    def test_cli_exempt_parses_rule_and_net(self):
        self.assertEqual(
            gate.parse_exempt_args(["GP-001:/PS1_24V"]),
            [{"rule": "GP-001", "net": "/PS1_24V", "reason": "--exempt on the command line"}],
        )

    def test_cli_exempt_without_net_is_an_error(self):
        with self.assertRaises(ValueError):
            gate.parse_exempt_args(["GP-001"])

    def test_file_entry_without_reason_is_an_error(self):
        with self.assertRaises(ValueError):
            gate.load_exempt_file([{"rule": "GP-001", "net": "/PS1_24V"}])
        with self.assertRaises(ValueError):
            gate.load_exempt_file([{"rule": "GP-001", "net": "/PS1_24V", "reason": " "}])

    def test_matching_rule_and_net_drops_the_finding(self):
        ex = [{"rule": "GP-001", "net": "/PS1_24V", "reason": "24 V power, not a signal"}]
        kept, stale = gate.apply_exemptions(self.findings, ex)
        self.assertEqual(stale, [])
        self.assertNotIn("GP-001", {f["rule_id"] for f in kept})
        self.assertEqual(len(kept), len(self.findings) - 1)

    def test_ref_entry_drops_findings_of_that_rule_that_name_the_component(self):
        ex = gate.load_exempt_file([{"rule": "VP-001", "ref": "C4", "reason": "tented via, datasheet land pattern"}])
        kept, stale = gate.apply_exemptions(self.findings, ex)
        self.assertEqual(stale, [])
        self.assertNotIn("VP-001", {f["rule_id"] for f in kept})
        self.assertEqual(len(kept), len(self.findings) - 1)
        kept, stale = gate.apply_exemptions(self.findings, [{"rule": "VP-001", "ref": "U4", "reason": "x"}])
        self.assertEqual(len(kept), len(self.findings))
        self.assertEqual(len(stale), 1)

    def test_file_entry_needs_exactly_one_of_net_and_ref(self):
        with self.assertRaises(ValueError):
            gate.load_exempt_file([{"rule": "VP-001", "reason": "x"}])
        with self.assertRaises(ValueError):
            gate.load_exempt_file([{"rule": "VP-001", "net": "/A", "ref": "C4", "reason": "x"}])

    def test_stale_ref_entry_names_the_ref(self):
        lines, code = gate.evaluate(self.findings, self.RULES, None, [{"rule": "VP-001", "ref": "U4", "reason": "x"}])
        self.assertEqual(code, 2)
        self.assertTrue(any(l.startswith("STALE exempt VP-001 U4") for l in lines))

    def test_other_rule_on_that_net_is_not_dropped(self):
        ex = [{"rule": "RP-001", "net": "/PS1_24V", "reason": "x"}]
        kept, stale = gate.apply_exemptions(self.findings, ex)
        self.assertEqual(len(kept), len(self.findings))
        self.assertEqual(stale, ex)

    def test_stale_exempt_gives_exit_2(self):
        ex = [{"rule": "GP-001", "net": "/NO_SUCH_NET", "reason": "x"}]
        lines, code = gate.evaluate(self.findings, self.RULES, None, ex)
        self.assertEqual(code, 2)
        self.assertTrue(any(l.startswith("STALE exempt GP-001 /NO_SUCH_NET") for l in lines))

    def test_no_exempt_keeps_the_old_result(self):
        lines, code = gate.evaluate(self.findings, self.RULES, None, [])
        self.assertEqual(code, 1)
        self.assertEqual(lines[:-1], [gate.format_finding(f) for f in self.findings])

    def test_exempt_file_without_reason_exits_2_before_any_analysis(self):
        import tempfile

        with tempfile.NamedTemporaryFile("w", suffix=".json", delete=False) as fh:
            json.dump([{"rule": "GP-001", "net": "/PS1_24V"}], fh)
        import contextlib
        import io

        err = io.StringIO()
        try:
            with contextlib.redirect_stderr(err):
                self.assertEqual(gate.main(["/nonexistent/board", "--exempt-file", fh.name]), 2)
            self.assertIn("reason", err.getvalue())
        finally:
            os.unlink(fh.name)



class DefaultRulesTest(unittest.TestCase):
    def test_vp001_is_not_a_default_rule(self):
        # kicad-happy a6bba1a reads KiCad 10 "(tenting (front no) (back yes))" as untented, so VP-001
        # is always true. pcbtool.py viapads (with --allow) is the via-in-pad gate.
        self.assertNotIn("VP-001", gate.DEFAULT_RULES)
        self.assertEqual(gate.DEFAULT_RULES, ["GP-001", "RP-001", "DC-002", "UC-001"])


class GroundViaTests(unittest.TestCase):
    # kicad-happy a6bba1a finds ground vias by name only (GND, *GND, 0V); FIELD_0V is not one.
    def doc(self):
        return {"nets": {"1": "FIELD_0V", "2": "/SIG", "3": "GND"},
                "vias": {"vias": [{"x": 0, "y": 0, "net": 1}, {"x": 1, "y": 0, "net": 2},
                                  {"x": 2, "y": 0, "net": 3}]}}

    def test_named_ground_vias_are_marked_gnd(self):
        d = self.doc()
        self.assertEqual(gate.mark_ground_vias(d, ["FIELD_0V"]), 1)
        self.assertEqual([v.get("net_name") for v in d["vias"]["vias"]], ["GND", None, None])

    def test_no_grounds_changes_nothing(self):
        d = self.doc()
        self.assertEqual(gate.mark_ground_vias(d, []), 0)
        self.assertEqual(d, self.doc())

    def test_unknown_ground_net_is_an_error(self):
        with self.assertRaises(ValueError):
            gate.mark_ground_vias(self.doc(), ["FIELD_GND"])


if __name__ == "__main__":
    unittest.main()
