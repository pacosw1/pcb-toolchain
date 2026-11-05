//! Synthetic receipt validation, never an actual KiCad check.
use route_coverage::{
    Result,
    board::{BoardReader, NativeBoard},
    evidence,
    thermal::{IMPLEMENTATION_SCHEMA, Validator},
};
use serde_json::{Value, json};
use std::{
    fs,
    path::{Path, PathBuf},
    sync::atomic::{AtomicUsize, Ordering},
};
static NEXT: AtomicUsize = AtomicUsize::new(0);
struct Reader;
impl BoardReader for Reader {
    fn read(&self, _: &Path) -> Result<NativeBoard> {
        Ok(serde_json::from_value(json!({"copper_layers":["F.Cu","B.Cu"],"footprints":[{"reference":"U1","layer":"F.Cu","position":{"x":0,"y":0},"orientation":0,"pads":[
    {"id":"fb-a","number":"1","kind":"Smd","shape":"Rect","net":"/FB","position":{"x":0,"y":0},"orientation":0,"size":{"x":1,"y":1},"drill":{"x":0,"y":0},"layers":["F.Cu"],"copper":[]},
    {"id":"fb-b","number":"2","kind":"Smd","shape":"Rect","net":"/FB","position":{"x":0,"y":0},"orientation":0,"size":{"x":1,"y":1},"drill":{"x":0,"y":0},"layers":["F.Cu"],"copper":[]},
    {"id":"gnd-a","number":"3","kind":"Smd","shape":"Rect","net":"GND","position":{"x":0,"y":0},"orientation":0,"size":{"x":1,"y":1},"drill":{"x":0,"y":0},"layers":["F.Cu"],"copper":[]}]}],"copper":[]})).unwrap())
    }
}
struct Fixture {
    root: PathBuf,
    source: PathBuf,
    base: PathBuf,
    final_board: PathBuf,
    validator: Validator<Reader>,
}
impl Drop for Fixture {
    fn drop(&mut self) {
        fs::remove_dir_all(&self.root).unwrap();
    }
}
impl Fixture {
    fn new() -> Self {
        let root = std::env::temp_dir().join(format!(
            "route-thermal-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir(&root).unwrap();
        let root = root.canonicalize().unwrap();
        let source = root.join("source.kicad_pcb");
        let base = root.join("base.kicad_pcb");
        let final_board = root.join("final.kicad_pcb");
        for p in [&source, &base, &final_board] {
            fs::write(p, "synthetic native board bytes").unwrap();
            write(
                &p.with_extension("kicad_pro"),
                &json!({"board":{"design_settings":{"rules":{"min_resolved_spokes":2},"rule_severities":{"starved_thermal":"error"},"drc_exclusions":[]}}}),
            );
            fs::write(p.with_extension("kicad_dru"), "(version 1)\n").unwrap();
        }
        for name in ["validator", "fill-tool", "drc-tool"] {
            fs::write(root.join(name), name).unwrap();
        }
        let f = Self {
            validator: Validator::new(Reader, root.join("validator")),
            root,
            source,
            base,
            final_board,
        };
        f.receipts(&f.base, "initial", true);
        f.receipts(&f.final_board, "final", false);
        f
    }
    fn path(&self, name: &str) -> PathBuf {
        self.root.join(name)
    }
    fn receipts(&self, candidate: &Path, label: &str, opens: bool) {
        let report = self.path(&format!("{label}-report.json"));
        let fill = self.path(&format!("{label}-fill.json"));
        let drc = self.path(&format!("{label}-drc.json"));
        let mut inputs = json!({});
        for p in [
            candidate.to_path_buf(),
            candidate.with_extension("kicad_pro"),
            candidate.with_extension("kicad_dru"),
        ] {
            inputs[p.to_str().unwrap()] = evidence::hash(&p).unwrap().into();
        }
        write(
            &fill,
            &json!({"schema":"iot-lab.native-thermal-fill.v1","candidate":evidence::descriptor(candidate).unwrap(),"inputs":inputs,"fill_result":true,"tool":evidence::descriptor(&self.path("fill-tool")).unwrap(),"pcbnew_version":"10.0.6","invocation":{"operation":"ZONE_FILLER.Fill","saved":true}}),
        );
        write(
            &report,
            &json!({"kicad_version":"10.0.6","coordinate_units":"mm","source":candidate.file_name().unwrap().to_str().unwrap(),"included_severities":["error","warning","exclusion"],"ignored_checks":[],"violations":[],"schematic_parity":[],"unconnected_items":if opens{json!([{"type":"unconnected_items","severity":"error","items":[{"uuid":"fb-a"},{"uuid":"fb-b"}]}])}else{json!([])}}),
        );
        write(
            &drc,
            &json!({"schema":"iot-lab.native-thermal-drc.v1","candidate":evidence::descriptor(candidate).unwrap(),"inputs":inputs,"tool":evidence::descriptor(&self.path("drc-tool")).unwrap(),"returncode":0,"command":[self.path("drc-tool"),"pcb","drc","--severity-all","--format","json","--units","mm","-o",report,candidate],"report":evidence::descriptor(&report).unwrap()}),
        );
    }
    fn admit(&self) -> Result<Value> {
        self.admit_with(true, &fb())
    }
    fn admit_with(&self, enabled: bool, nets: &[String]) -> Result<Value> {
        self.validator.admit(
            &self.source,
            &self.base,
            enabled,
            nets,
            &self.path("initial-fill.json"),
            &self.path("initial-drc.json"),
        )
    }
    fn validate(&self, c: &Value) -> Result<Value> {
        self.validator
            .validate_capability(c, &self.source, &self.base, &fb(), None)
    }
    fn discharge(&self, c: &Value) -> Result<Value> {
        self.validator.discharge(
            c,
            &self.final_board,
            &self.path("final-fill.json"),
            &self.path("final-drc.json"),
        )
    }
    /// A validator run from an identical copy of the producer's artifact.
    fn consumer(&self) -> Validator<Reader> {
        let exe = self.path("consumer-validator");
        fs::copy(self.path("validator"), &exe).unwrap();
        Validator::new(Reader, exe)
    }
    fn mutate(&self, file: &str, f: impl FnOnce(&mut Value)) {
        let p = self.path(file);
        let mut v = evidence::read(&p).unwrap().0;
        f(&mut v);
        write(&p, &v);
    }
    fn report(&self, f: impl FnOnce(&mut Value)) {
        self.report_of("initial", f);
    }
    fn report_of(&self, label: &str, f: impl FnOnce(&mut Value)) {
        let report = format!("{label}-report.json");
        self.mutate(&report, f);
        self.mutate(&format!("{label}-drc.json"), |v| {
            v["report"] = evidence::descriptor(&self.path(&report)).unwrap()
        });
    }
}
fn write(path: &Path, v: &Value) {
    fs::write(path, v.to_string()).unwrap();
}
fn fb() -> [String; 1] {
    ["/FB".into()]
}
fn refused(result: Result<Value>, text: &str) {
    let error = result.unwrap_err();
    assert!(error.contains(text), "{error}");
}
fn reseal(mut c: Value) -> Value {
    c.as_object_mut().unwrap().remove("content_sha256");
    evidence::seal(c)
}
fn settings(board: &Path, change: impl FnOnce(&mut Value)) {
    let path = board.with_extension("kicad_pro");
    let mut project = evidence::read(&path).unwrap().0;
    change(&mut project["board"]["design_settings"]);
    write(&path, &project);
}
#[test]
fn initial_selected_opens_and_final_zero_opens_discharge_one_obligation() {
    let f = Fixture::new();
    let c = f.admit().unwrap();
    assert_eq!(c["status"], "pending_native");
    assert_eq!(c["initial"]["metrics"]["opens"], 1);
    let final_check = f
        .validator
        .discharge(
            &c,
            &f.final_board,
            &f.path("final-fill.json"),
            &f.path("final-drc.json"),
        )
        .unwrap();
    assert_eq!(final_check["status"], "passed");
    assert_eq!(final_check["qualified"], false);
    assert_eq!(final_check["dsn_covered"], false);
    assert_eq!(final_check["configured_gate_required"], true);
}
#[test]
fn capability_reopens_receipts_and_rejects_changed_source() {
    let f = Fixture::new();
    let c = f.admit().unwrap();
    f.mutate("initial-fill.json", |v| v["fill_result"] = false.into());
    assert!(
        f.validator
            .validate_capability(&c, &f.source, &f.base, &["/FB".into()], None)
            .is_err()
    );
}
#[test]
fn edited_seals_or_claims_cannot_admit() {
    let f = Fixture::new();
    let mut c = f.admit().unwrap();
    c["required_count"] = json!(3);
    assert!(
        f.validator
            .validate_capability(&c, &f.source, &f.base, &["/FB".into()], None)
            .unwrap_err()
            .contains("content changed")
    );
    c.as_object_mut().unwrap().remove("content_sha256");
    let c = evidence::seal(c);
    assert!(
        f.validator
            .validate_capability(&c, &f.source, &f.base, &["/FB".into()], None)
            .is_err()
    );
}
#[test]
fn authored_policy_must_be_complete_and_unchanged() {
    for change in [0, 1, 2, 3] {
        let f = Fixture::new();
        for board in [&f.source, &f.base] {
            let path = board.with_extension("kicad_pro");
            let mut p = evidence::read(&path).unwrap().0;
            match change {
                0 => p["board"]["design_settings"]["rules"]["min_resolved_spokes"] = json!(2.0),
                1 => p["board"]["design_settings"]["rules"]["min_resolved_spokes"] = json!(0),
                2 => {
                    p["board"]["design_settings"]["rule_severities"]["starved_thermal"] =
                        "warning".into()
                }
                _ => p["board"]["design_settings"]["drc_exclusions"] = json!(["excluded"]),
            }
            write(&path, &p);
        }
        assert!(f.admit().is_err(), "policy mutation {change}");
    }
}
#[test]
fn custom_thermal_rules_and_severity_overrides_block() {
    for rule in [
        "(constraint thermal_spoke_width (min .2))",
        "(constraint zone_connection solid)",
        "(severity warning)",
        "(unknown x)",
    ] {
        let f = Fixture::new();
        for board in [&f.source, &f.base] {
            fs::write(
                board.with_extension("kicad_dru"),
                format!("(version 1) (rule X {rule})"),
            )
            .unwrap();
        }
        f.receipts(&f.base, "initial", true);
        assert!(f.admit().is_err(), "{rule}");
    }
}
#[test]
fn native_thermal_or_excluded_or_parity_findings_are_fatal() {
    for finding in [
        json!({"type":"starved_thermal","severity":"warning"}),
        json!({"type":"clearance","severity":"exclusion"}),
        json!({"type":"clearance","severity":"error"}),
    ] {
        let f = Fixture::new();
        f.report(|r| r["violations"] = json!([finding]));
        assert!(f.admit().is_err());
    }
    let f = Fixture::new();
    f.report(|r| r["schematic_parity"] = json!([{}]));
    assert!(f.admit().is_err());
}
#[test]
fn opens_require_two_distinct_uuids_on_selected_native_net() {
    for id in ["gnd-a", "fb-a", "missing"] {
        let f = Fixture::new();
        f.report(|r| r["unconnected_items"][0]["items"][1]["uuid"] = id.into());
        assert!(f.admit().is_err());
    }
}
#[test]
fn drc_command_cannot_hide_a_refill_or_override_output() {
    for flag in ["--refill-zones", "--severity-all", "--save-board"] {
        let f = Fixture::new();
        f.mutate("initial-drc.json", |r| {
            r["command"].as_array_mut().unwrap().push(flag.into())
        });
        assert!(f.admit().is_err(), "{flag}");
    }
}
#[test]
fn failed_fill_missing_checks_or_wrong_version_block() {
    for change in [0, 1, 2, 3] {
        let f = Fixture::new();
        match change {
            0 => f.mutate("initial-fill.json", |r| r["fill_result"] = false.into()),
            1 => f.report(|r| {
                r.as_object_mut().unwrap().remove("ignored_checks");
            }),
            2 => f.report(|r| r["kicad_version"] = "11.0".into()),
            _ => f.report(|r| r["ignored_checks"] = json!([{"key":"starved_thermal"}])),
        }
        assert!(f.admit().is_err());
    }
}
#[test]
fn final_opens_and_changed_runtime_tools_cannot_discharge() {
    for change in [0, 1] {
        let f = Fixture::new();
        let c = f.admit().unwrap();
        if change == 0 {
            f.receipts(&f.final_board, "final", true);
        } else {
            fs::write(f.path("other-tool"), "other").unwrap();
            f.mutate("final-fill.json", |v| {
                v["tool"] = evidence::descriptor(&f.path("other-tool")).unwrap()
            });
        }
        assert!(
            f.validator
                .discharge(
                    &c,
                    &f.final_board,
                    &f.path("final-fill.json"),
                    &f.path("final-drc.json")
                )
                .is_err()
        );
    }
}
#[test]
fn relocated_identical_validator_retains_producer_origin() {
    let f = Fixture::new();
    let c = f.admit().unwrap();
    let exe = f.path("other-validator");
    fs::copy(f.path("validator"), &exe).unwrap();
    let consumer = Validator::new(Reader, exe.clone());
    assert_eq!(
        consumer
            .validate_capability(&c, &f.source, &f.base, &["/FB".into()], None)
            .unwrap(),
        c
    );
    fs::write(exe, "different bytes").unwrap();
    assert!(
        consumer
            .validate_capability(&c, &f.source, &f.base, &["/FB".into()], None)
            .unwrap_err()
            .contains("differs from producer")
    );
}
#[test]
fn symlinks_and_absent_inputs_that_appear_are_rejected() {
    let f = Fixture::new();
    let c = f.admit().unwrap();
    fs::write(f.source.with_extension("kicad_sch"), "new").unwrap();
    assert!(
        f.validator
            .validate_capability(&c, &f.source, &f.base, &["/FB".into()], None)
            .is_err()
    );
    let link = f.path("link");
    std::os::unix::fs::symlink(&f.source, &link).unwrap();
    assert!(evidence::hash(&link).is_err());
}
#[test]
fn duplicate_evidence_keys_are_not_last_value_wins() {
    let f = Fixture::new();
    fs::write(
        f.path("initial-fill.json"),
        "{\"fill_result\":false,\"fill_result\":true}",
    )
    .unwrap();
    assert!(f.admit().is_err());
}
#[test]
fn capability_is_pending_and_its_discharge_is_deterministic_and_opt_in() {
    let f = Fixture::new();
    let c = f.admit().unwrap();
    assert_eq!(c["required_count"], 2);
    assert_eq!(c["dsn_covered"], false);
    assert_eq!(c["initial"]["metrics"]["parity_checked"], false);
    let role = &c["implementation"]["roles"]["validator"];
    assert_eq!(c["inputs"][role["path"].as_str().unwrap()], role["sha256"]);
    let actual = f
        .validator
        .validate_capability(&c, &f.source, &f.base, &fb(), Some(&json!(2)))
        .unwrap();
    assert_eq!(actual, c);
    assert_eq!(f.discharge(&c).unwrap(), f.discharge(&c).unwrap());
    refused(f.admit_with(false, &fb()), "opt-in");
}
#[test]
fn identical_copies_agree_and_bind_only_the_producer() {
    let f = Fixture::new();
    let c = f.admit().unwrap();
    let consumer = f.consumer();
    let actual = consumer
        .validate_capability(&c, &f.source, &f.base, &fb(), None)
        .unwrap();
    assert_eq!(actual, c);
    let role = evidence::descriptor(&f.path("validator")).unwrap();
    assert_eq!(actual["implementation"]["schema"], IMPLEMENTATION_SCHEMA);
    assert_eq!(actual["implementation"]["roles"]["validator"], role);
    let final_check = f.discharge(&c).unwrap();
    assert_eq!(
        consumer
            .discharge(
                &c,
                &f.final_board,
                &f.path("final-fill.json"),
                &f.path("final-drc.json")
            )
            .unwrap(),
        final_check
    );
    let copy = f.path("consumer-validator");
    let copy = copy.to_str().unwrap();
    assert!(actual["inputs"].get(copy).is_none());
    assert!(final_check["inputs"].get(copy).is_none());
    assert_eq!(
        final_check["inputs"][role["path"].as_str().unwrap()],
        role["sha256"]
    );
}
#[test]
fn recorded_producer_path_and_bytes_remain_required() {
    let f = Fixture::new();
    let c = f.admit().unwrap();
    let consumer = f.consumer();
    let validate = || consumer.validate_capability(&c, &f.source, &f.base, &fb(), None);
    let producer = f.path("validator");
    let bytes = fs::read(&producer).unwrap();
    fs::write(&producer, "changed producer bytes").unwrap();
    refused(validate(), "stale");
    fs::write(&producer, bytes).unwrap();
    fs::rename(&producer, f.path("validator.missing")).unwrap();
    refused(validate(), "missing evidence file");
}
#[test]
fn versioned_role_records_cannot_drop_or_rebind_the_producer() {
    let f = Fixture::new();
    let c = f.admit().unwrap();
    let role = c["implementation"]["roles"]["validator"].clone();
    let recorded = role["path"].as_str().unwrap().to_string();
    let alias = f.path("identical-validator");
    fs::copy(&recorded, &alias).unwrap();
    let dotted = f
        .root
        .join("..")
        .join(f.root.file_name().unwrap())
        .join("validator");
    let unsupported = "unsupported native thermal implementation roles/version";
    let edits: [(&dyn Fn(&mut Value), &str); 9] = [
        (
            &|c: &mut Value| {
                c.as_object_mut().unwrap().remove("implementation");
            },
            "historical",
        ),
        (
            &|c: &mut Value| {
                c["implementation"]["schema"] = "iot-lab.native-thermal-implementation.v1".into()
            },
            unsupported,
        ),
        (
            &|c: &mut Value| c["implementation"]["unreviewed"] = true.into(),
            unsupported,
        ),
        (
            &|c: &mut Value| c["implementation"]["roles"]["parser"] = role.clone(),
            unsupported,
        ),
        (
            &|c: &mut Value| {
                c["implementation"]["roles"] = json!({"helper":role,"parser":role});
            },
            unsupported,
        ),
        (
            &|c: &mut Value| c["implementation"]["roles"]["validator"]["extra"] = true.into(),
            "missing exact file descriptor",
        ),
        (
            &|c: &mut Value| {
                c["implementation"]["roles"]["validator"]["path"] = json!(alias);
            },
            "absent from original inputs",
        ),
        (
            &|c: &mut Value| {
                c["implementation"]["roles"]["validator"]["path"] = json!(dotted);
            },
            "must be canonical",
        ),
        (
            &|c: &mut Value| {
                c["inputs"].as_object_mut().unwrap().remove(&recorded);
            },
            "absent from original inputs",
        ),
    ];
    for (edit, text) in edits {
        let mut changed = c.clone();
        edit(&mut changed);
        refused(f.validate(&reseal(changed)), text);
    }
}
#[test]
fn every_recorded_input_is_rechecked_by_a_relocated_consumer() {
    let f = Fixture::new();
    let extra = f.path("original-reviewed-input.txt");
    fs::write(&extra, "original retained input").unwrap();
    let digest = evidence::hash(&extra).unwrap();
    f.mutate("initial-fill.json", |v| {
        v["inputs"][extra.to_str().unwrap()] = digest.clone().into()
    });
    let c = f.admit().unwrap();
    assert_eq!(c["inputs"][extra.to_str().unwrap()], digest.as_str());
    fs::write(&extra, "changed original retained input").unwrap();
    refused(
        f.consumer()
            .validate_capability(&c, &f.source, &f.base, &fb(), None),
        "evidence input changed",
    );
}
#[test]
fn policy_needs_a_real_integer_count_and_explicit_exclusions() {
    let edits: [(fn(&mut Value), &str); 3] = [
        (
            |d| d["rules"]["min_resolved_spokes"] = true.into(),
            "min_resolved_spokes",
        ),
        (
            |d| {
                d["rules"]
                    .as_object_mut()
                    .unwrap()
                    .remove("min_resolved_spokes");
            },
            "min_resolved_spokes",
        ),
        (
            |d| {
                d.as_object_mut().unwrap().remove("drc_exclusions");
            },
            "explicit empty DRC exclusions",
        ),
    ];
    for (edit, text) in edits {
        let f = Fixture::new();
        settings(&f.source, edit);
        settings(&f.base, edit);
        refused(f.admit(), text);
    }
}
#[test]
fn spoke_rules_severity_overrides_and_malformed_rules_block() {
    for (rule, text) in [
        (
            r#"(rule "x" (constraint min_resolved_spokes (min 1)))"#,
            "custom thermal/zone constraint",
        ),
        (
            r#"(rule "x" (condition "A.Type == 'Pad'") (severity ignore) (constraint clearance (min 0.2mm)))"#,
            "custom rule severity",
        ),
        (
            r#"(rule "unclosed" (constraint clearance (min 0.2mm))"#,
            "unbalanced parentheses",
        ),
    ] {
        let f = Fixture::new();
        for board in [&f.source, &f.base] {
            fs::write(
                board.with_extension("kicad_dru"),
                format!("(version 1)\n{rule}"),
            )
            .unwrap();
        }
        refused(f.admit(), text);
    }
}
#[test]
fn fill_must_be_literally_true_saved_supported_and_candidate_bound() {
    for (key, value) in [
        ("fill_result", json!(1)),
        ("pcbnew_version", json!("10.0.5")),
        (
            "invocation",
            json!({"operation":"ZONE_FILLER.Fill","saved":false}),
        ),
    ] {
        let f = Fixture::new();
        f.mutate("initial-fill.json", |r| r[key] = value);
        refused(f.admit(), "must explicitly succeed");
    }
    let f = Fixture::new();
    f.mutate("initial-fill.json", |r| {
        r["candidate"] = evidence::descriptor(&f.final_board).unwrap()
    });
    refused(f.admit(), "another candidate");
}
#[test]
fn unsuccessful_drc_or_a_command_off_the_candidate_blocks() {
    for code in [json!(1), json!(true)] {
        let f = Fixture::new();
        f.mutate("initial-drc.json", |r| r["returncode"] = code);
        refused(f.admit(), "did not succeed");
    }
    let f = Fixture::new();
    f.mutate("initial-drc.json", |r| {
        r["command"]
            .as_array_mut()
            .unwrap()
            .retain(|v| v != "--severity-all")
    });
    refused(f.admit(), "exact saved candidate/report");
    let f = Fixture::new();
    f.mutate("initial-drc.json", |r| {
        *r["command"].as_array_mut().unwrap().last_mut().unwrap() = json!(f.final_board)
    });
    refused(f.admit(), "exact saved candidate/report");
}
#[test]
fn a_thermal_finding_of_any_severity_or_an_ignored_thermal_check_is_fatal() {
    for severity in ["error", "warning", "exclusion"] {
        let f = Fixture::new();
        f.report(|r| r["violations"] = json!([{"type":"starved_thermal","severity":severity}]));
        refused(f.admit(), "thermal/excluded");
    }
    let f = Fixture::new();
    f.report(|r| r["ignored_checks"] = json!([{"key":"starved_thermal"}]));
    refused(f.admit(), "ignored");
}
#[test]
fn open_nets_come_from_native_uuids_not_report_descriptions() {
    let f = Fixture::new();
    let text = "Pad [/FB] (misleading diagnostic text)";
    f.report(|r| {
        r["unconnected_items"][0]["items"] =
            json!([{"uuid":"fb-a","description":text},{"uuid":"gnd-a","description":text}])
    });
    refused(f.admit(), "selected native nets");
}
#[test]
fn final_findings_or_a_different_drc_tool_cannot_discharge() {
    for (key, finding, text) in [
        (
            "unconnected_items",
            json!({"type":"unconnected_items","severity":"error","items":[{"uuid":"fb-a"},{"uuid":"fb-b"}]}),
            "zero opens",
        ),
        (
            "violations",
            json!({"type":"clearance","severity":"error"}),
            "reported errors",
        ),
        (
            "schematic_parity",
            json!({"type":"extra_footprint","severity":"warning"}),
            "schematic parity",
        ),
    ] {
        let f = Fixture::new();
        let c = f.admit().unwrap();
        f.report_of("final", |r| r[key] = json!([finding]));
        refused(f.discharge(&c), text);
    }
    let f = Fixture::new();
    let c = f.admit().unwrap();
    let other = f.path("different-cli");
    fs::write(&other, "a different native runtime").unwrap();
    f.mutate("final-drc.json", |d| {
        d["tool"] = evidence::descriptor(&other).unwrap();
        d["command"][0] = json!(other);
    });
    refused(f.discharge(&c), "runtime tools");
}
#[test]
fn capability_refuses_other_scope_forged_status_and_edited_report() {
    let f = Fixture::new();
    let c = f.admit().unwrap();
    refused(
        f.validator
            .validate_capability(&c, &f.source, &f.base, &["GND".into()], None),
        "selected native nets",
    );
    refused(
        f.validator
            .validate_capability(&c, &f.source, &f.base, &fb(), Some(&json!(3))),
        "authored count",
    );
    let mut forged = c.clone();
    forged["status"] = "passed".into();
    refused(f.validate(&reseal(forged)), "source, scope or evidence");
    let report = f.path("initial-report.json");
    let text = fs::read_to_string(&report).unwrap();
    fs::write(&report, text + " ").unwrap();
    refused(f.discharge(&c), "evidence input changed");
}
#[test]
fn source_alias_is_content_checked_but_not_a_discharge_dependency() {
    let f = Fixture::new();
    let c = f.admit().unwrap();
    let alias = f.path("promoted-workspace.kicad_pcb");
    fs::copy(&f.source, &alias).unwrap();
    for ext in ["kicad_pro", "kicad_dru"] {
        fs::copy(f.source.with_extension(ext), alias.with_extension(ext)).unwrap();
    }
    let validate = || {
        f.validator
            .validate_capability(&c, &alias, &f.base, &fb(), None)
    };
    let actual = validate().unwrap();
    assert_eq!(actual, c);
    assert!(actual["inputs"].get(alias.to_str().unwrap()).is_none());
    fs::write(&alias, "changed alias bytes").unwrap();
    refused(validate(), "immutable thermal source");
    assert_eq!(f.discharge(&c).unwrap()["status"], "passed");
}
#[test]
fn stale_candidate_changed_policy_changed_tool_or_missing_receipt_is_refused() {
    let f = Fixture::new();
    let c = f.admit().unwrap();
    let board = fs::read(&f.final_board).unwrap();
    fs::write(&f.final_board, "changed board bytes").unwrap();
    refused(f.discharge(&c), "stale");
    fs::write(&f.final_board, board).unwrap();
    let project = f.final_board.with_extension("kicad_pro");
    let authored = fs::read(&project).unwrap();
    settings(&f.final_board, |d| {
        d["rules"]["min_resolved_spokes"] = 3.into()
    });
    refused(f.discharge(&c), "project or DRU");
    fs::write(&project, authored).unwrap();
    fs::write(f.path("drc-tool"), "changed in place").unwrap();
    refused(f.discharge(&c), "evidence input changed");
    let f = Fixture::new();
    fs::remove_file(f.path("initial-fill.json")).unwrap();
    refused(f.admit(), "missing evidence file");
}
#[test]
fn zero_initial_opens_are_permitted_but_an_absent_net_is_not() {
    let f = Fixture::new();
    f.report(|r| r["unconnected_items"] = json!([]));
    assert_eq!(f.admit().unwrap()["initial"]["metrics"]["opens"], 0);
    refused(f.admit_with(true, &["/NOT_PRESENT".into()]), "absent");
}
#[test]
fn incomplete_reports_and_unsupported_runtimes_fail_closed() {
    for (key, value, text) in [
        ("included_severities", json!(["error"]), "did not include"),
        ("kicad_version", json!("10.0.7"), "runtime/report identity"),
        ("source", json!("different.kicad_pcb"), "another candidate"),
        ("violations", Value::Null, "report is incomplete"),
        ("ignored_checks", json!([{"bad":"unknown"}]), "evidence key"),
    ] {
        let f = Fixture::new();
        f.report(|r| r[key] = value);
        refused(f.admit(), text);
    }
}
