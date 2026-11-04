//! Synthetic receipt validation, never an actual KiCad check.
use route_coverage::{
    Result,
    board::{BoardReader, NativeBoard},
    evidence,
    thermal::Validator,
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
        self.validator.admit(
            &self.source,
            &self.base,
            true,
            &["/FB".into()],
            &self.path("initial-fill.json"),
            &self.path("initial-drc.json"),
        )
    }
    fn mutate(&self, file: &str, f: impl FnOnce(&mut Value)) {
        let p = self.path(file);
        let mut v = evidence::read(&p).unwrap().0;
        f(&mut v);
        write(&p, &v);
    }
    fn report(&self, f: impl FnOnce(&mut Value)) {
        self.mutate("initial-report.json", f);
        self.mutate("initial-drc.json", |v| {
            v["report"] = evidence::descriptor(&self.path("initial-report.json")).unwrap()
        });
    }
}
fn write(path: &Path, v: &Value) {
    fs::write(path, v.to_string()).unwrap();
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
