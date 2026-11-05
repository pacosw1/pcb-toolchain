//! Binding to exact files, and input races. tools/test_route_rule_coverage.py FileCoverageTests, with the project and hole
//! modules faked: their own rules are tested with their ports.
use super::tests::{Dsn, Fake, LED, POE, classes, dsn, obstacles, rule, strings};
use super::*;
use crate::sha256::sha256;
use serde_json::{Value, json};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};

const NATIVE: &str = r#"(kicad_pcb (version 20260101)
      (layers (0 "F.Cu" signal) (31 "B.Cu" signal))
      (footprint "Fixture:Resistor" (layer "F.Cu") (at 10 10 180) (uuid "R10")
        (property "Reference" "R10") (property "Value" "1k")
        (pad "1" smd rect (at -1 0 180) (size 1 1) (layers "F.Cu" "F.Mask") (net "/LED_LINK_K") (uuid "R10-1"))
        (pad "2" smd rect (at 1 0 180) (size 1 1) (layers "F.Cu" "F.Mask") (net "/POE_V2N") (uuid "R10-2"))))"#;
const DEFAULT_CONDITION: &str = "A.NetClass == 'POE' && B.NetClass != 'POE'";

struct Fixture {
    root: PathBuf,
}

impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.root);
    }
}

static NEXT: AtomicUsize = AtomicUsize::new(0);

impl Fixture {
    fn new() -> Fixture {
        let root = std::env::temp_dir().join(format!("rule-coverage-{}-{}", std::process::id(), NEXT.fetch_add(1, Ordering::Relaxed)));
        fs::create_dir_all(&root).unwrap();
        let fixture = Fixture { root };
        fixture.write(&fixture.board(), NATIVE);
        fixture.write(&fixture.base(), NATIVE);
        fixture.write_rules(&rule("clearance", "3mm", DEFAULT_CONDITION));
        for path in [fixture.board(), fixture.base()] {
            fixture.write(&path.with_extension("kicad_pro"), "{}");
        }
        fixture.write(&fixture.model(), &dsn("3000"));
        fixture.write(&fixture.gate(), r#"{"checks": {"drc": true}}"#);
        fixture
    }

    fn write(&self, path: &Path, text: &str) {
        fs::write(path, text).unwrap();
    }

    fn write_rules(&self, text: &str) {
        self.write(&self.rules(), text);
        self.write(&self.base().with_extension("kicad_dru"), text);
    }

    fn board(&self) -> PathBuf {
        self.root.join("source.kicad_pcb")
    }

    fn base(&self) -> PathBuf {
        self.root.join("base.kicad_pcb")
    }

    fn rules(&self) -> PathBuf {
        self.board().with_extension("kicad_dru")
    }

    fn model(&self) -> PathBuf {
        self.root.join("board.dsn")
    }

    fn gate(&self) -> PathBuf {
        self.root.join("gate.json")
    }

    fn check(&self, fake: &Fake) -> Result<Coverage, String> {
        self.check_with(fake, None, None)
    }

    fn check_with(&self, fake: &Fake, command: Option<&[String]>, capability: Option<&Value>) -> Result<Coverage, String> {
        let (active, classes, obstacles, layers) = (strings(&[LED]), classes(), obstacles(), strings(&["F.Cu", "B.Cu"]));
        let scope = RouteScope { active_nets: &active, net_classes: &classes, obstacles: &obstacles, layers: &layers };
        let gate = self.gate();
        let (board, base, dsn) = (self.board(), self.base(), self.model());
        check_files(&CheckRequest { board: &board, base: &base, dsn: &dsn, scope, gate: Some(&gate), backend_command: command, backend_policy: None, native_thermal_capability: capability }, fake)
    }
}

fn hash(path: &Path) -> Option<String> {
    Some(sha256(&fs::read(path).unwrap()))
}

#[test]
fn receipt_binds_original_base_rules_project_gate_and_exact_dsn() {
    let fixture = Fixture::new();
    let result = fixture.check(&Fake::default()).unwrap();
    assert_eq!(result.status, Status::Passed, "{result:?}");
    let files = result.files.as_ref().unwrap();
    let exe = std::env::current_exe().unwrap();
    for path in [fixture.board(), fixture.base(), fixture.rules(), fixture.base().with_extension("kicad_dru"), fixture.board().with_extension("kicad_pro"), fixture.base().with_extension("kicad_pro"), fixture.model(), fixture.gate(), exe] {
        assert_eq!(files.inputs[&path.display().to_string()], hash(&path), "{}", path.display());
    }
    assert_eq!(files.dsn, DsnBinding { path: fixture.model().display().to_string(), sha256: hash(&fixture.model()) });
    assert_eq!(files.model_status, "complete");
    assert!(!result.qualified);
    let value = serde_json::to_value(&result).unwrap();
    assert_eq!(value["status"], "passed");
    assert_eq!(value["inputs"][fixture.gate().display().to_string()], hash(&fixture.gate()).unwrap());
    assert!(value["backend_command"].is_null() && value["backend_command_sha256"].is_null());
}

#[test]
fn pads_only_disposition_cannot_hide_moved_or_changed_base_footprints() {
    let fixture = Fixture::new();
    fixture.write_rules("(version 1) (rule \"pads fixed\" (constraint disallow pad))");
    for changed in [NATIVE.replace("(at 10 10 180)", "(at 11 10 180)"), NATIVE.replacen("(size 1 1)", "(size 2 1)", 1), NATIVE.replacen("(net \"/LED_LINK_K\")", "(net \"/OTHER\")", 1)] {
        fixture.write(&fixture.base(), &changed);
        assert_eq!(fixture.check(&Fake::default()).unwrap_err(), "footprint/pad definitions or poses changed before routing admission");
    }
}

#[test]
fn input_changed_during_admission_is_blocked_even_when_decision_was_passed() {
    let fixture = Fixture::new();
    let paths = [fixture.board(), fixture.base(), fixture.rules(), fixture.base().with_extension("kicad_dru"), fixture.board().with_extension("kicad_pro"), fixture.base().with_extension("kicad_pro"), fixture.model(), fixture.gate()];
    for path in paths {
        let before = fs::read(&path).unwrap();
        let fake = Fake::default();
        let (target, bytes) = (path.clone(), before.clone());
        *fake.after_project.borrow_mut() = Some(Box::new(move || fs::write(&target, [bytes.as_slice(), b"\n"].concat()).unwrap()));
        let result = fixture.check(&fake).unwrap();
        assert_eq!(result.status, Status::Blocked, "{}", path.display());
        assert!(!result.solver_launch_allowed);
        assert!(result.cause.contains("changed"), "{}", result.cause);
        fs::write(&path, &before).unwrap();
    }
}

#[test]
fn changed_dsn_is_reinterpreted_and_gate_stitching_is_not_ignored() {
    let fixture = Fixture::new();
    fixture.write(&fixture.model(), &dsn("200"));
    assert_eq!(fixture.check(&Fake::default()).unwrap().status, Status::Blocked);
    fixture.write_rules("(version 1)");
    fixture.write(&fixture.gate(), r#"{"checks": {"drc": true, "kicad_happy": true}}"#);
    let pending = fixture.check(&Fake::default()).unwrap();
    assert_eq!(pending.status, Status::PendingNative, "{pending:?}");
    let enforcement: Vec<&Value> = pending.native_postconditions.as_ref().unwrap().iter().map(|item| &item["enforcement"]).collect();
    assert_eq!(enforcement, ["configured-gate"]);
    assert_eq!(pending.files.as_ref().unwrap().model_status, "partial");
    fixture.write(&fixture.model(), &Dsn { mask: Some(&["F.Cu"]), ..Dsn::default() }.text());
    assert_eq!(fixture.check(&Fake::default()).unwrap().status, Status::Passed);
}

#[test]
fn unknown_native_hole_geometry_cannot_be_silently_omitted() {
    let fixture = Fixture::new();
    let fake = Fake::default();
    *fake.pads.borrow_mut() = Some(Err("unsupported offset drill".to_string()));
    let unrelated = fixture.check(&fake).unwrap();
    assert_eq!(unrelated.status, Status::Passed, "{unrelated:?}");
    assert_eq!(unrelated.native_pth_geometry_unknown.as_deref(), Some("unsupported offset drill"));
    fixture.write_rules(&rule("hole_clearance", "0.28mm", "A.Pad_Type == 'Through-hole' || B.Pad_Type == 'Through-hole'"));
    fixture.write(&fixture.model(), &Dsn { clearance: "3000", mask: Some(&["F.Cu"]), ..Dsn::default() }.text());
    let relevant = fixture.check(&fake).unwrap();
    assert_eq!(relevant.status, Status::Blocked, "{relevant:?}");
    assert!(!relevant.solver_launch_allowed);
    assert_eq!(relevant.requirements[0].disposition, Disposition::Unsupported);
    assert_eq!(relevant.native_pth_geometry_unknown.as_deref(), Some("unsupported offset drill"));
}

#[test]
fn malformed_custom_rules_keep_the_blocked_receipts_source_bindings() {
    let fixture = Fixture::new();
    fixture.write_rules("(rule \"unterminated)");
    let result = fixture.check(&Fake::default()).unwrap();
    assert_eq!(result.status, Status::Blocked, "{result:?}");
    assert!(!result.solver_launch_allowed);
    assert_eq!(result.files.unwrap().inputs[&fixture.rules().display().to_string()], hash(&fixture.rules()));
}

#[test]
fn base_project_rules_and_fixed_geometry_are_bound() {
    let fixture = Fixture::new();
    fixture.write(&fixture.base().with_extension("kicad_pro"), "{\"changed\": 1}");
    let result = fixture.check(&Fake::default()).unwrap();
    assert_eq!(result.status, Status::Blocked);
    assert!(result.requirements.iter().any(|row| row.constraint == "project_source"));
    fixture.write(&fixture.base().with_extension("kicad_pro"), "{}");
    fixture.write(&fixture.base().with_extension("kicad_dru"), "(version 1) (rule \"unexpected base policy\" (constraint clearance (min 1mm)))");
    let result = fixture.check(&Fake::default()).unwrap();
    assert_eq!(result.status, Status::Blocked);
    assert!(result.requirements.iter().any(|row| row.constraint == "rule_source"));
    fs::remove_file(fixture.base().with_extension("kicad_dru")).unwrap();
    fs::remove_file(fixture.rules()).unwrap();
    fixture.write(&fixture.base(), &format!("{}(gr_text \"changed\" (at 0 0) (layer \"F.SilkS\")))", &NATIVE[..NATIVE.len() - 1]));
    let result = fixture.check(&Fake::default()).unwrap();
    assert!(!result.files.unwrap().fixed_geometry_preserved);
}

#[test]
fn a_command_is_bound_and_a_bad_one_blocks() {
    let fixture = Fixture::new();
    let router = fixture.root.join("router");
    fixture.write(&router, "attributed backend fixture; never executed");
    let model = fixture.model().display().to_string();
    let command = strings(&[&router.display().to_string(), "-de", &model, "--diagnose"]);
    let result = fixture.check_with(&Fake::default(), Some(&command), None).unwrap();
    assert_eq!(result.status, Status::Passed, "{result:?}");
    let files = result.files.unwrap();
    assert_eq!(files.backend_command.as_ref(), Some(&command));
    assert_eq!(files.inputs[&router.display().to_string()], hash(&router));
    let text = serde_json::to_string(&command).unwrap();
    assert_eq!(files.backend_command_sha256, Some(sha256(text.as_bytes())));
    let unknown = strings(&[&router.display().to_string(), "-de", &model, "--config=x"]);
    let blocked = fixture.check_with(&Fake::default(), Some(&unknown), None).unwrap();
    assert_eq!(blocked.status, Status::Blocked);
    assert!(blocked.cause.contains("backend_command"), "{}", blocked.cause);
}

#[test]
fn a_custom_hole_limit_needs_the_actual_backend_proof_and_its_inputs_are_bound() {
    let fixture = Fixture::new();
    let evidence = fixture.root.join("proof.json");
    fixture.write(&evidence, "{}");
    let name = evidence.display().to_string();
    let digest = hash(&evidence).unwrap();
    fixture.write_rules(&rule("hole_clearance", "0.4mm", "A.Pad_Type == 'Through-hole' || B.Pad_Type == 'Through-hole'"));
    fixture.write(&fixture.model(), &Dsn { clearance: "3000", mask: Some(&["F.Cu"]), ..Dsn::default() }.text());
    let fake = Fake { hole_status: Some("covered"), ..Fake::default() };
    *fake.pads.borrow_mut() = Some(Ok(vec![json!({"net": POE})]));
    *fake.holes.borrow_mut() = Some(Ok(vec![json!({"identity": "pth", "kind": "pth", "net": POE, "supported": true})]));
    let bound = (name.clone(), digest.clone());
    *fake.drilled.borrow_mut() = Some(Box::new(move |request| {
        assert_eq!(request.required_mm, "0.4");
        assert_eq!(request.applicability, "custom_pth_track");
        Ok(json!({"status": "covered", "inputs": {bound.0.clone(): bound.1.clone()}}))
    }));
    let result = fixture.check(&fake).unwrap();
    assert_eq!(result.status, Status::Passed, "{result:?}");
    assert_eq!(result.requirements[0].analytical_hole_geometry.as_ref().unwrap()["status"], "covered");
    assert_eq!(result.files.as_ref().unwrap().inputs[&name], Some(digest));
    *fake.drilled.borrow_mut() = Some(Box::new(|_| Ok(json!({"status": "blocked", "cause": "fixture proof refused"}))));
    let refused = fixture.check(&fake).unwrap();
    assert_eq!(refused.status, Status::Blocked);
    assert_eq!(refused.requirements[0].reason.as_deref(), Some("fixture proof refused"));
    *fake.holes.borrow_mut() = Some(Err("unknown drill".to_string()));
    let unknown = fixture.check(&fake).unwrap();
    assert_eq!(unknown.status, Status::Blocked);
    assert_eq!(unknown.native_drilled_geometry_unknown.as_deref(), Some("unknown drill"));
}

#[test]
fn an_invalid_native_capability_blocks_even_when_the_thermal_requirement_is_inactive() {
    let fixture = Fixture::new();
    let fake = Fake::default();
    *fake.capability.borrow_mut() = Some(Err("missing native input evidence".to_string()));
    let result = fixture.check_with(&fake, None, Some(&json!({}))).unwrap();
    assert_eq!(result.status, Status::Blocked);
    assert!(!result.solver_launch_allowed);
    assert!(result.cause.contains("missing native input evidence"), "{}", result.cause);
}

#[test]
fn a_verified_capability_is_recorded_with_its_postconditions() {
    let fixture = Fixture::new();
    let capability = json!({"status": "pending_native", "inputs": {}});
    let result = fixture.check_with(&Fake::default(), None, Some(&capability)).unwrap();
    assert_eq!(result.native_thermal_capability, Some(capability));
    assert_eq!(result.native_postconditions, Some(Vec::new()));
}

#[test]
fn the_scope_hashes_match_python_json() {
    let fixture = Fixture::new();
    let result = fixture.check(&Fake::default()).unwrap();
    let text = format!(r#"[{{"NetName": "{POE}", "Pad_Type": "Through-hole", "Type": "Pad"}}, {{"NetName": "{POE}", "Pad_Type": "", "Type": "Track"}}]"#);
    assert_eq!(result.files.unwrap().obstacle_scope_sha256, sha256(text.as_bytes()));
}
