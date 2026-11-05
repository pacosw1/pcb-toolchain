//! The complete drilled inventory against real pin, keepout and via descriptors, and the backend bindings a positive proof needs.
//! The backend bytes are a protocol fixture: they exercise the real binder and hashes, and claim no tested executable.
mod hole_common;
use hole_common::{MM, dsn, footprint, inventory, pth, reshape};
use route_coverage::{
    evidence,
    hole::{self, DrilledRequest},
};
use serde_json::{Value, json};
use std::{
    collections::BTreeSet,
    fs,
    path::{Path, PathBuf},
    sync::atomic::{AtomicUsize, Ordering},
};

const UPSTREAM: &str = "e5d52c4544795422b8b28077acc0605fdf11265a";
const LOCK: &str = "4761175c5d8df0ed4c2c69036df2686dc7e3a186cd085d2ae766936134cab9a6";
const VIA: &str = r#"(via "Via[0-1]_600:300_um" 140000 -100000 (net GND) (type fix))"#;
const KEEPOUT: &str = r#"(keepout "" (circle F.Cu 3760))"#;
const PROJECT: &str = "kicad10_project_track";
const CUSTOM: &str = "custom_pth_track";
static NEXT: AtomicUsize = AtomicUsize::new(0);

/// Two slotted J3 pads and one retained through via, beside the shared board.
fn native() -> Value {
    let slot = |id: &str, y| {
        let mut pad = pth("7", "GND", [132 * MM, y], 180, "Rect", [1_100_000, 1_900_000], [600_000, 1_300_000]);
        pad["id"] = id.into();
        pad
    };
    let mut board = hole_common::native();
    let j3 = footprint("J3", [130 * MM, 100 * MM], 90, vec![slot("slot1", 99 * MM), slot("slot2", 101 * MM)]);
    board["footprints"].as_array_mut().unwrap().push(j3);
    board["copper"] = json!([{"Via": {"id": "via1", "at": {"x": 140 * MM, "y": 100 * MM}, "size": 600_000, "drill": 300_000,
        "net": "GND", "locked": false, "layers": ["F.Cu", "B.Cu"], "via_type": "Through"}}]);
    board
}
fn model() -> String {
    let model = dsn()
        .replace(
            "(place J2 110000 -100000 front 180 (PN connector))))",
            "(place J2 110000 -100000 front 180 (PN connector)))
              (component MOUNT (place H1 120000 -100000 front 0))
              (component USB (place J3 130000 -100000 front 90)))",
        )
        .replace(
            "(library (image \"TERM\"",
            r#"(library
              (image MOUNT (keepout "" (circle F.Cu 3760)))
              (image USB (pin OVAL (rotate 90) 7 1000 -2000)
                (pin OVAL (rotate 90) 7@1 -1000 -2000))
              (padstack OVAL (shape (rect F.Cu -550 -950 550 950)))
              (padstack "Via[0-1]_600:300_um" (shape (circle F.Cu 600))
                (shape (circle B.Cu 600)))
              (image "TERM""#,
        )
        .replace("(network (net /POWER", "(network (net GND (pins J3-7 J3-7@1)) (net /POWER")
        .replacen("(structure ", "(structure (boundary (path pcb 0 0 0 200000 0 200000 -200000 0 -200000 0 0)) ", 1);
    format!("{}(wiring {VIA}))", &model[..model.len() - 1])
}
fn without_via(model: &str) -> String {
    format!("{})", &model[..model.find("(wiring").unwrap()])
}
fn of_kind(holes: &[Value], kind: &str) -> Vec<Value> {
    holes.iter().filter(|h| h["kind"] == kind).cloned().collect()
}
fn slots(holes: &[Value]) -> Vec<Value> {
    holes.iter().filter(|h| h["reference"] == "J3").cloned().collect()
}

struct Fixture {
    root: PathBuf,
    binary: PathBuf,
    manifest: PathBuf,
    native_evidence: PathBuf,
    native: Value,
    holes: Vec<Value>,
    policy: Value,
}
impl Drop for Fixture {
    fn drop(&mut self) {
        fs::remove_dir_all(&self.root).unwrap();
    }
}
impl Fixture {
    fn new() -> Self {
        let root = std::env::temp_dir().join(format!("route-hole-{}-{}", std::process::id(), NEXT.fetch_add(1, Ordering::Relaxed)));
        fs::create_dir(&root).unwrap();
        let root = root.canonicalize().unwrap();
        let (binary, manifest, native_evidence) = (root.join("backend"), root.join("backend-manifest.json"), root.join("native-evidence.json"));
        fs::write(&binary, "unit fixture binary").unwrap();
        fs::write(&native_evidence, r#"{"fixture":true}"#).unwrap();
        let patch = Path::new(env!("CARGO_MANIFEST_DIR")).join("../backend-patches/fastroute-quality-773/quality-first.patch");
        let patch_sha256 = evidence::hash(&patch).unwrap();
        let binary_sha256 = evidence::hash(&binary).unwrap();
        let data = json!({"schema": 1, "upstream_commit": UPSTREAM, "cargo_lock_sha256": LOCK, "patch_sha256": patch_sha256,
            "binary_sha256": binary_sha256, "native_validation": {"status": "passed",
                "evidence": [evidence::descriptor(&native_evidence).unwrap()]}});
        fs::write(&manifest, data.to_string()).unwrap();
        let bound = evidence::descriptor(&manifest).unwrap();
        let policy = json!({"mode": "quality-first", "manifest": bound["path"], "manifest_sha256": bound["sha256"],
            "binary_sha256": binary_sha256, "patch_sha256": patch_sha256, "upstream_commit": UPSTREAM, "qualified": false});
        let native = native();
        let holes = inventory(&native);
        Self { root, binary, manifest, native_evidence, native, holes, policy }
    }
    fn request(&self) -> DrilledRequest {
        serde_json::from_value(json!({"dsn_text": model(), "holes": self.holes, "active_nets": ["/LED_A"], "layers": ["F.Cu"],
            "required_mm": "0.28", "clearance_floor_mm": "0.2",
            "backend_command": [self.binary.to_str().unwrap(), "--quality-first"], "backend_policy": self.policy}))
        .unwrap()
    }
}
/// The options of one proof, on top of the fixture's defaults.
trait Options {
    fn swap(self, from: &str, to: &str) -> Self;
    fn text(self, model: String) -> Self;
    fn holes(self, holes: &[Value]) -> Self;
    fn floor(self, mm: &str) -> Self;
    fn required(self, mm: &str) -> Self;
    fn nets(self, nets: &[&str]) -> Self;
    fn applicability(self, name: &str) -> Self;
}
impl Options for DrilledRequest {
    fn swap(mut self, from: &str, to: &str) -> Self {
        assert!(self.dsn_text.contains(from), "{from}");
        self.dsn_text = self.dsn_text.replace(from, to);
        self
    }
    fn text(mut self, model: String) -> Self {
        self.dsn_text = model;
        self
    }
    fn holes(mut self, holes: &[Value]) -> Self {
        self.holes = holes.to_vec();
        self
    }
    fn floor(mut self, mm: &str) -> Self {
        self.scope.clearance_floor_mm = mm.into();
        self
    }
    fn required(mut self, mm: &str) -> Self {
        self.scope.required_mm = mm.into();
        self
    }
    fn nets(mut self, nets: &[&str]) -> Self {
        self.scope.active_nets = nets.iter().map(|n| n.to_string()).collect();
        self
    }
    fn applicability(mut self, name: &str) -> Self {
        self.applicability = name.into();
        self
    }
}
fn covered(r: DrilledRequest) -> Value {
    let proof = hole::inspect_drilled(&r);
    assert_eq!(proof["status"], "covered", "{proof}");
    assert_eq!(proof["qualified"], false, "{proof}");
    proof
}
fn blocked(r: DrilledRequest) -> Value {
    let proof = hole::inspect_drilled(&r);
    assert_eq!(proof["status"], "blocked", "{proof}");
    assert_eq!(proof["qualified"], false, "{proof}");
    assert!(proof["cause"].as_str().is_some_and(|s| !s.is_empty()), "{proof}");
    proof
}
fn rows(proof: &Value) -> &Vec<Value> {
    proof["covered_holes"].as_array().unwrap()
}

#[test]
fn complete_inventory_keeps_pth_npth_slots_and_the_retained_via() {
    let f = Fixture::new();
    assert_eq!(f.holes.len(), 6);
    assert!(f.holes.iter().all(|h| h["supported"] == true), "{:?}", f.holes);
    let kinds: Vec<_> = f.holes.iter().map(|h| h["kind"].as_str().unwrap()).collect();
    assert_eq!(kinds, ["pth", "pth", "npth", "pth", "pth", "via"]);
    let slots = slots(&f.holes);
    assert_eq!(slots[0]["export_pin"], "7");
    assert_eq!(slots[1]["export_pin"], "7@1");
    assert_eq!(slots[0]["position_mm"], json!(["132", "99"]));
    assert_eq!(slots[1]["position_mm"], json!(["132", "101"]));
    assert_eq!(slots[0]["rotation_deg"], "180");
    assert_eq!(slots[0]["drill_mm"], json!(["0.6", "1.3"]));
    let proof = covered(f.request());
    assert_eq!(proof["native_hole_count"], 6);
    assert_eq!(rows(&proof).iter().map(|h| h["identity"].as_str()).collect::<BTreeSet<_>>().len(), 6);
    let npth = rows(&proof).iter().find(|h| h["kind"] == "npth").unwrap();
    assert_eq!(npth["credited_clearance_mm"], "0");
}

#[test]
fn slot_capsule_and_rectangle_proofs_use_the_exact_boundary_and_rotation() {
    let f = Fixture::new();
    let slots_only = slots(&f.holes);
    // Without the instantiated via, this isolates slot containment.
    let base = || f.request().text(without_via(&model())).holes(&slots_only);
    covered(base().floor("0.03"));
    blocked(base().floor("0.029999999999999"));
    blocked(base().swap("(rotate 90)", "(rotate 0)"));
    blocked(base().swap("-550 -950 550 950", "-549 -950 550 950"));
    blocked(base().swap("7@1 -1000 -2000", "7@1 -1001 -2000"));
    blocked(base().swap("J3-7@1", "J3-wrong"));
    let mut wider = f.native.clone();
    for pad in wider["footprints"][3]["pads"].as_array_mut().unwrap() {
        pad["size"] = json!({"x": 1_200_000, "y": 2 * MM});
        reshape(pad);
    }
    let rects = slots(&inventory(&wider));
    let base = || base().holes(&rects).swap("(rect F.Cu -550 -950 550 950)", "(rect F.Cu -600 -1000 600 1000)").floor("0");
    covered(base());
    blocked(base().required("0.300000000001"));
}

#[test]
fn npth_requires_an_actual_wire_keepout_without_pin_clearance_credit() {
    let f = Fixture::new();
    assert_eq!(of_kind(&f.holes, "npth")[0]["net"], "");
    blocked(f.request().swap("(circle F.Cu 3760)", "(circle F.Cu 3759.999999999)").floor("100"));
    blocked(f.request().swap("(keepout \"\"", "(via_keepout \"\""));
    blocked(f.request().swap("(circle F.Cu 3760)", "(circle F.Cu 3760 1 0)"));
    blocked(f.request().swap(KEEPOUT, ""));
    covered(f.request().swap("(keepout \"\"", "(wire_keepout \"\""));
}

#[test]
fn an_oval_ideal_capsule_never_claims_actual_integer_backend_coverage() {
    let f = Fixture::new();
    let mut oval = f.native.clone();
    for pad in oval["footprints"][3]["pads"].as_array_mut().unwrap() {
        pad["shape"] = "Oval".into();
        reshape(pad);
    }
    let holes = inventory(&oval);
    assert!(holes.iter().all(|h| h["supported"] == true), "{holes:?}");
    let proof = blocked(f.request().holes(&holes).swap("(rect F.Cu -550 -950 550 950)", "(path F.Cu 1100 0 -400 0 400)"));
    assert!(proof["cause"].as_str().unwrap().contains("integer-octagon"), "{proof}");
}

#[test]
fn exact_grid_and_actual_policy_bindings_are_required_for_positive_geometry() {
    let f = Fixture::new();
    let good = covered(f.request());
    for file in [&f.binary, &f.manifest, &f.native_evidence] {
        assert!(good["inputs"].get(file.to_str().unwrap()).is_some(), "{good}");
    }
    let with_policy = |key: &str, value: Value| {
        let mut policy = f.policy.clone();
        policy[key] = value;
        policy
    };
    for policy in [Value::Null, json!({"mode": "legacy-unverified"}), with_policy("binary_sha256", "0".repeat(64).into()), with_policy("patch_sha256", "0".repeat(64).into())] {
        let mut r = f.request();
        r.backend_policy = policy;
        blocked(r);
    }
    let mut r = f.request();
    r.backend_command.truncate(1);
    blocked(r);
    blocked(f.request().floor("0.200000001"));
    blocked(f.request().swap("(circle F.Cu 3760)", "(circle F.Cu 3760.000001)"));
    let mut near = f.native.clone();
    near["copper"][0]["Via"]["at"]["x"] = 140_000_001.into();
    blocked(f.request().holes(&inventory(&near)).swap("140000 -100000 (net GND)", "140000.001 -100000 (net GND)"));
    blocked(f.request().swap("200000", "700000"));
    fs::write(&f.binary, "changed binary").unwrap();
    blocked(f.request());
    fs::write(&f.binary, "unit fixture binary").unwrap();
    fs::write(&f.native_evidence, "changed native evidence").unwrap();
    blocked(f.request());
}

#[test]
fn npth_offset_position_uses_the_footprint_transform_and_multiplicity() {
    let f = Fixture::new();
    let mut turned = f.native.clone();
    turned["footprints"][2]["orientation"] = 90.into();
    let pad = &mut turned["footprints"][2]["pads"][0];
    pad["position"] = json!({"x": 122 * MM, "y": 99 * MM});
    reshape(pad);
    let holes = inventory(&turned);
    assert_eq!(of_kind(&holes, "npth")[0]["position_mm"], json!(["122", "99"]));
    let base = || f.request().holes(&holes).swap("H1 120000 -100000 front 0", "H1 120000 -100000 front 90").swap("(circle F.Cu 3760)", "(circle F.Cu 3760 1000 -2000)");
    covered(base());
    blocked(base().swap("3760 1000 -2000", "3760 1000 2000"));
}

#[test]
fn via_requires_its_exact_fixed_physical_instance_net_and_copper() {
    let f = Fixture::new();
    for (from, to) in [
        ("140000 -100000 (net GND)", "140001 -100000 (net GND)"),
        ("140000 -100000 (net GND)", "140000 -100000 (net /POWER)"),
        ("(type fix)", "(type route)"),
        ("(type fix)", "(type fix extra)"),
        ("(circle F.Cu 600)", "(circle F.Cu 601)"),
        (VIA, ""),
    ] {
        blocked(f.request().swap(from, to));
    }
    // Pin and NPTH obstacles may remain; every instantiated via must be bound.
    let via = of_kind(&f.holes, "via");
    covered(f.request().holes(&via).floor("0.13"));
    blocked(f.request().holes(&via).floor("0.129999999999"));
    blocked(f.request().holes(&[]));
}

#[test]
fn via_binds_the_exporter_six_digit_center_and_proves_the_offset() {
    // KiCad 10.0.6 specctra.h:2980 writes via points with "%.6g": 140000.4 um becomes 140000.
    let f = Fixture::new();
    let mut offset = f.native.clone();
    offset["copper"][0]["Via"]["at"]["x"] = 140_000_400.into();
    let via = of_kind(&inventory(&offset), "via");
    let base = || f.request().holes(&via);
    covered(base().floor("0.1304"));
    // The 0.4 um between the router obstacle and the native drill is not free.
    blocked(base().floor("0.1303"));
    // Only the exporter's exact text binds; a near or unrounded center does not.
    for center in ["140000.4 -100000", "140001 -100000"] {
        blocked(base().floor("0.1304").swap("140000 -100000 (net GND)", &format!("{center} (net GND)")));
    }
}

#[test]
fn unknown_native_drills_are_retained_and_block_instead_of_vanishing() {
    let f = Fixture::new();
    let cases: [fn(&mut Value); 5] = [
        |b| b["footprints"][2]["pads"][0]["drill"]["y"] = 3_400_000.into(),
        |b| {
            for point in b["footprints"][3]["pads"][0]["copper"][0]["Polygon"].as_array_mut().unwrap() {
                point["x"] = (point["x"].as_i64().unwrap() + 100_000).into();
            }
        },
        |b| b["footprints"][3]["layer"] = "B.Cu".into(),
        |b| b["copper"][0]["Via"]["via_type"] = "BlindBuried".into(),
        |b| b["footprints"][3]["pads"][0]["drill"] = json!({"x": 0, "y": 0}),
    ];
    for (index, change) in cases.into_iter().enumerate() {
        let mut board = f.native.clone();
        change(&mut board);
        let holes = inventory(&board);
        assert_eq!(holes.len(), 6, "case {index}");
        assert!(holes.iter().any(|h| h["supported"] != true), "case {index}");
        blocked(f.request().holes(&holes));
    }
}

#[test]
fn same_net_holes_and_ambiguous_multiplicity_never_get_obstacle_credit() {
    let f = Fixture::new();
    blocked(f.request().nets(&["/LED_A", "GND"]));
    blocked(f.request().nets(&["/LED_A", "/POWER"]));
    let mut holes = f.holes.clone();
    holes[5]["identity"] = holes[0]["identity"].clone();
    blocked(f.request().holes(&holes));
    let mut holes = f.holes.clone();
    holes[5]["supported"] = 1.into();
    blocked(f.request().holes(&holes));
    blocked(f.request().swap(VIA, &VIA.repeat(2)));
    blocked(f.request().swap(KEEPOUT, &KEEPOUT.repeat(2)));
}

#[test]
fn project_same_net_scope_still_binds_all_instances_and_never_exempts_npth() {
    let f = Fixture::new();
    let project = || f.request().nets(&["GND"]).applicability(PROJECT);
    let proof = covered(project().floor("0"));
    assert_eq!(rows(&proof).len(), 6);
    let excluded: Vec<_> = rows(&proof).iter().filter(|r| r["disposition"] == "native_not_applicable").collect();
    assert_eq!(excluded.iter().map(|r| r["identity"].as_str().unwrap()).collect::<BTreeSet<_>>(), BTreeSet::from(["slot1", "slot2", "via1"]));
    assert!(excluded.iter().all(|r| r["credited_clearance_mm"] == "0" && r["applicability_source"].is_string()));
    blocked(project().swap("140000 -100000 (net GND)", "140001 -100000 (net GND)"));
    blocked(project().swap("(circle F.Cu 3760)", "(circle F.Cu 3200)"));
    blocked(f.request().nets(&["GND", "/LED_A"]).applicability(PROJECT));
    blocked(f.request().applicability("assume_exempt"));
}

#[test]
fn custom_pth_minimum_does_not_expand_the_npth_or_via_requirement() {
    // The .36 custom PTH minimum fits every plated pad, but exceeds the NPTH's .28 keepout margin and the via's .35 copper plus clearance.
    let f = Fixture::new();
    blocked(f.request().required(".36"));
    let proof = covered(f.request().required(".36").applicability(CUSTOM));
    assert_eq!(proof["native_hole_count"], 6);
    for row in rows(&proof) {
        if row["kind"] == "pth" {
            assert_eq!(row["disposition"], "covered");
            assert_eq!(row["required_mm"], "0.36");
        } else {
            assert_eq!(row["disposition"], "custom_not_applicable");
            assert_eq!(row["required_mm"], "0");
            assert_eq!(row["credited_clearance_mm"], "0");
        }
    }
    // Project applicability is separate: the NPTH keeps the actual project minimum and cannot inherit the custom exclusion.
    blocked(f.request().required(".36").applicability(PROJECT));
    blocked(f.request().required(".4500000000001").applicability(CUSTOM));
}

#[test]
fn custom_non_pth_exclusion_keeps_every_physical_binding_and_backend_proof() {
    let f = Fixture::new();
    let custom = || f.request().required(".36").applicability(CUSTOM);
    for (from, to) in [
        (KEEPOUT, String::new()),
        ("(circle F.Cu 3760)", "(circle F.Cu 3199)".into()),
        ("(circle F.Cu 3760)", "(circle F.Cu 3760 1 0)".into()),
        ("(circle F.Cu 3760)", "(circle F.Cu 3760.000001)".into()),
        ("140000 -100000 (net GND)", "140001 -100000 (net GND)".into()),
        ("(circle F.Cu 600)", "(circle F.Cu 601)".into()),
        (VIA, String::new()),
        (VIA, VIA.repeat(2)),
    ] {
        blocked(custom().swap(from, &to));
    }
    blocked(custom().holes(&f.holes[..5]));
    let mut holes = f.holes.clone();
    holes[5]["identity"] = holes[0]["identity"].clone();
    blocked(custom().holes(&holes));
    let mut holes = f.holes.clone();
    holes[2]["supported"] = false.into();
    holes[2]["cause"] = "unknown NPTH".into();
    blocked(custom().holes(&holes));
    let mut r = custom();
    r.backend_policy = Value::Null;
    blocked(r);
}

#[test]
fn custom_pth_same_net_stays_blocked_but_a_non_pth_via_stays_bound() {
    let f = Fixture::new();
    blocked(f.request().nets(&["/POWER"]).applicability(CUSTOM));
    blocked(f.request().nets(&["GND"]).applicability(CUSTOM));
    let mut active = f.native.clone();
    active["copper"][0]["Via"]["net"] = "/LED_A".into();
    let holes = inventory(&active);
    let base = || f.request().holes(&holes).applicability(CUSTOM).swap("140000 -100000 (net GND)", "140000 -100000 (net /LED_A)");
    let proof = covered(base());
    let via = rows(&proof).iter().find(|r| r["kind"] == "via").unwrap();
    assert_eq!(via["disposition"], "custom_not_applicable");
    assert!(via.get("applicability_source").is_none(), "{via}");
    blocked(base().swap("140000 -100000 (net /LED_A)", "140001 -100000 (net /LED_A)"));
}

#[test]
fn a_mutated_native_slot_changes_the_inventory_and_cannot_reuse_the_old_export() {
    let f = Fixture::new();
    let mut moved = f.native.clone();
    let pad = &mut moved["footprints"][3]["pads"][0];
    pad["position"]["y"] = 98_999_000.into();
    reshape(pad);
    let changed = inventory(&moved);
    assert_ne!(changed, f.holes);
    let form = |holes: &[Value]| holes.iter().find(|h| h["identity"] == "slot1").unwrap()["native_form_sha256"].clone();
    assert_ne!(form(&changed), form(&f.holes));
    blocked(f.request().holes(&changed));
}

#[test]
fn malformed_units_layers_inventory_and_numerics_fail_closed() {
    let f = Fixture::new();
    for (from, to) in [
        ("(resolution um 10)", "(resolution mm 10)"),
        ("(type power)", "(type signal)"),
        ("(rect F.Cu -550 -950 550 950)", "(path F.Cu 1100 1 -400 -1 400)"),
        ("(circle F.Cu 600)", "(circle F.Cu NaN)"),
        ("(network ", "(network (net gnd (pins X-1)) "),
        ("J3-7 J3-7@1", "J3-7 j3-7 J3-7@1"),
    ] {
        blocked(f.request().swap(from, to));
    }
    let missing = json!({"dsn_text": model(), "holes": null, "active_nets": ["/LED_A"], "layers": ["F.Cu"], "required_mm": ".28", "clearance_floor_mm": ".2"});
    assert!(serde_json::from_value::<DrilledRequest>(missing).is_err());
    let mut r = f.request();
    r.scope.required_mm = true.into();
    blocked(r);
    blocked(f.request().floor("nan"));
    blocked(f.request().required("-.1"));
}
