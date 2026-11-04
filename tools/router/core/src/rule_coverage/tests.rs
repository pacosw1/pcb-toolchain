//! Actual-model rule coverage: no native tool, no router. tools/test_route_rule_coverage.py, the parts this module decides.
use super::*;
use crate::decimal::Decimal;
use crate::kicad::raw::Form;
use crate::route_features::strengthen_project_clearance;
use crate::sha256::sha256;
use serde_json::{Value, json};
use std::cell::{Cell, RefCell};
use std::collections::BTreeMap;
use std::path::Path;

pub(super) const LED: &str = "/LED_LINK_K";
pub(super) const POE: &str = "/POE_V2N";
const MDI: &str = "/ETH_TXP";

pub(super) fn strings(items: &[&str]) -> Vec<String> {
    items.iter().map(|item| item.to_string()).collect()
}

pub(super) fn classes() -> BTreeMap<String, String> {
    BTreeMap::from([(LED.to_string(), "Default".to_string()), (POE.to_string(), "POE".to_string())])
}

fn obstacle(net: &str, kind: &str, pad_type: Option<&str>) -> Obstacle {
    Obstacle { net_name: net.to_string(), kind: kind.to_string(), pad_type: pad_type.map(str::to_string) }
}

pub(super) fn obstacles() -> Vec<Obstacle> {
    vec![obstacle(POE, "Pad", Some("Through-hole")), obstacle(POE, "Track", Some(""))]
}

const DEFAULT_CONDITION: &str = "A.NetClass == 'POE' && B.NetClass != 'POE'";

pub(super) fn rule(kind: &str, value: &str, condition: &str) -> String {
    format!("(version 1)\n(rule \"PoE isolation\" (condition \"{condition}\") (constraint {kind} (min {value})))")
}

fn default_rule() -> String {
    rule("clearance", "3mm", DEFAULT_CONDITION)
}

#[derive(Clone, Copy)]
pub(super) struct Dsn<'a> {
    pub clearance: &'a str,
    pub mask: Option<&'a [&'a str]>,
    pub extra: &'a str,
    pub pairs: &'a str,
    pub unit: &'a str,
}

impl Default for Dsn<'_> {
    fn default() -> Self {
        Dsn { clearance: "200", mask: None, extra: "", pairs: "", unit: "um" }
    }
}

impl Dsn<'_> {
    pub fn text(self) -> String {
        let circuit = self.mask.map_or(String::new(), |mask| format!("(circuit (use_layer {}))", mask.join(" ")));
        r#"(pcb "coverage-fixture"
      (parser (string_quote ")) (resolution um 10) (unit UNIT)
      (structure (layer "F.Cu" (type signal)) (layer "B.Cu" (type signal))
        (rule (width 200) (clearance CLEARANCE)) EXTRA)
      (network (net "LED" (pins R10-1)) (net "POE" (pins J1-10))
        (class "DEFAULT" "LED" CIRCUIT (rule (clearance CLEARANCE)))
        (class "POE" "POE" (rule (clearance CLEARANCE))) PAIRS))"#
            .replace("UNIT", self.unit).replace("CLEARANCE", self.clearance).replace("EXTRA", self.extra)
            .replace("CIRCUIT", &circuit).replace("PAIRS", self.pairs)
            .replace("\"LED\"", &format!("\"{LED}\"")).replace("\"POE\"", &format!("\"{POE}\""))
    }
}

pub(super) fn dsn(clearance: &str) -> String {
    Dsn { clearance, ..Dsn::default() }.text()
}

/// A stand-in for the coverage modules with their own ports. `hole_status` is what the PTH proof says.
#[derive(Default)]
pub(super) struct Fake {
    pub pads: RefCell<Option<Result<Vec<Value>, String>>>,
    pub hole_status: Option<&'static str>,
    pub hole_calls: Cell<usize>,
    pub drilled: RefCell<Option<Box<dyn Fn(&DrilledRequest) -> Result<Value, String>>>>,
    pub holes: RefCell<Option<Result<Vec<Value>, String>>>,
    pub project_rows: RefCell<Vec<Row>>,
    pub after_project: RefCell<Option<Box<dyn Fn()>>>,
    pub capability: RefCell<Option<Result<Value, String>>>,
}

impl Collaborators for Fake {
    fn project_clearances(&self, project_text: &str) -> Result<ProjectClearances, String> {
        let project: Value = serde_json::from_str(project_text).map_err(|error| error.to_string())?;
        let decimal = |value: &Value| Decimal::parse(&value.to_string()).ok_or_else(|| "expected authored finite nonnegative number in millimetres".to_string());
        let items = project["net_settings"]["classes"].as_array().ok_or("project rules and nonempty netclass list are required")?;
        let classes = items.iter().enumerate().map(|(index, item)| {
            (item["name"].as_str().unwrap_or("").to_string(), ClassClearance { index, clearance: item.get("clearance").map(decimal) })
        });
        Ok(ProjectClearances { classes: classes.collect(), min_clearance: project["board"]["design_settings"]["rules"].get("min_clearance").map(decimal) })
    }

    fn evaluate_project(&self, _: &ProjectRequest) -> Result<Vec<Row>, String> {
        if let Some(mutate) = self.after_project.borrow().as_ref() {
            mutate();
        }
        Ok(self.project_rows.borrow().clone())
    }

    fn thermal_scope(&self, _: &[Form], _: &[Form]) -> Value {
        json!({"thermal_connections_possible": false})
    }

    fn native_pth_pads(&self, _: &Path) -> Result<Vec<Value>, String> {
        self.pads.borrow().clone().unwrap_or(Ok(Vec::new()))
    }

    fn native_drilled_geometry(&self, _: &Path) -> Result<Vec<Value>, String> {
        self.holes.borrow().clone().unwrap_or(Ok(Vec::new()))
    }

    fn inspect_holes(&self, _: &HoleRequest) -> Result<Value, String> {
        self.hole_calls.set(self.hole_calls.get() + 1);
        Ok(json!({"status": self.hole_status.unwrap_or("blocked"), "cause": "fixture containment rejected"}))
    }

    fn inspect_drilled(&self, request: &DrilledRequest) -> Result<Value, String> {
        self.drilled.borrow().as_ref().map_or(Ok(json!({"status": "covered"})), |proof| proof(request))
    }

    fn validate_thermal_capability(&self, supplied: &Value, _: &Path, _: &Path, _: &[String]) -> Result<Value, String> {
        self.capability.borrow().clone().unwrap_or_else(|| Ok(supplied.clone()))
    }
}

struct Run<'a> {
    active: Vec<String>,
    classes: BTreeMap<String, String>,
    obstacles: Vec<Obstacle>,
    layers: Vec<String>,
    stitching: bool,
    pads: Option<Vec<Value>>,
    fake: &'a Fake,
}

impl<'a> Run<'a> {
    fn new(fake: &'a Fake) -> Run<'a> {
        Run { active: strings(&[LED]), classes: classes(), obstacles: obstacles(), layers: strings(&["F.Cu", "B.Cu"]), stitching: false, pads: None, fake }
    }

    fn layers(mut self, layers: &[&str]) -> Self {
        self.layers = strings(layers);
        self
    }

    fn inspect(&self, rules: &str, model: &str) -> Coverage {
        let scope = RouteScope { active_nets: &self.active, net_classes: &self.classes, obstacles: &self.obstacles, layers: &self.layers };
        inspect(rules, model, &scope, self.stitching, self.pads.as_deref(), self.fake)
    }
}

fn check(rules: &str, model: &str) -> Coverage {
    Run::new(&Fake::default()).inspect(rules, model)
}

fn assert_blocked(result: &Coverage) {
    assert_eq!(result.status, Status::Blocked, "{result:?}");
    assert!(!result.solver_launch_allowed && !result.qualified && !result.cause.is_empty(), "{result:?}");
}

fn assert_passed(result: &Coverage) {
    assert_eq!(result.status, Status::Passed, "{result:?}");
    assert!(result.solver_launch_allowed && !result.qualified, "{result:?}");
}

fn assert_pending(result: &Coverage, obligation: Value) {
    assert_eq!(result.status, Status::PendingNative, "{result:?}");
    assert!(result.solver_launch_allowed && !result.qualified);
    assert!(result.requirements.iter().any(|row| row.disposition == Disposition::NativePostcondition && row.native_obligation.as_ref() == Some(&obligation)), "{result:?}");
}

#[test]
fn exported_point_two_mm_does_not_cover_three_mm_native_clearance() {
    let result = check(&default_rule(), &dsn("200"));
    assert_blocked(&result);
    let row = &result.requirements[0];
    assert_eq!(row.disposition, Disposition::WeakerThanNative);
    assert_eq!(row.required_mm.as_deref(), Some("3"));
    assert_eq!(row.model_floor_mm.as_deref(), Some("0.200"));
    assert_eq!(row.witness, Some(Witness { active: LED.to_string(), obstacle: Some(POE.to_string()) }));
}

#[test]
fn every_actual_dsn_clearance_at_native_minimum_is_covered() {
    for floor in ["3000", "4000"] {
        let result = check(&default_rule(), &dsn(floor));
        assert_passed(&result);
        assert_eq!(result.requirements[0].disposition, Disposition::Covered);
    }
}

#[test]
fn compiler_style_class_pair_does_not_prove_creepage() {
    let pairs = format!("(class_class (classes \"DEFAULT\" \"{POE}\") (rule (clearance 3000)))");
    let result = check(&rule("creepage", "3mm", DEFAULT_CONDITION), &Dsn { clearance: "3000", pairs: &pairs, ..Dsn::default() }.text());
    assert_blocked(&result);
    let row = &result.requirements[0];
    assert_eq!(row.disposition, Disposition::Unsupported);
    assert!(row.reason.as_deref().unwrap().contains("no proven enforcement"));
}

#[test]
fn spatial_clearance_selector_remains_unsupported_even_with_strong_dsn() {
    let condition = "A.NetClass == 'POE' && B.NetClass != 'POE' && A.intersectsCourtyard('J1') && B.intersectsCourtyard('J1')";
    let result = check(&rule("clearance", "1.25mm", condition), &dsn("3000"));
    assert_blocked(&result);
    assert_eq!(result.requirements[0].disposition, Disposition::Unsupported);
}

#[test]
fn unrelated_mdi_unary_rules_do_not_block_new_led_tracks() {
    let rules = "(version 1) (rule \"MDI\"
          (condition \"A.inDiffPair('/ETH_TX')\")
          (constraint track_width (min 0.2mm)) (constraint length (max 25mm))
          (constraint diff_pair_gap (min 0.18mm)) (constraint via_count (max 0)))";
    let base = dsn("200");
    let model = format!("{}(class \"MDI\" \"{MDI}\" (rule (clearance 200)))))", &base[..base.len() - 2]);
    let fake = Fake::default();
    let mut run = Run::new(&fake);
    run.classes.insert(MDI.to_string(), "MDI".to_string());
    run.obstacles.extend([obstacle(MDI, "Track", Some("")), obstacle(MDI, "Pad", Some("SMD"))]);
    let result = run.inspect(rules, &model);
    assert_passed(&result);
    assert!(result.requirements.iter().all(|row| row.disposition == Disposition::NotApplicable));
}

#[test]
fn led_to_retained_poe_requirements_are_relevant_in_either_orientation() {
    for condition in ["A.NetClass == 'POE' && B.NetClass != 'POE'", "B.NetClass == 'POE' && A.NetClass != 'POE'", "A.NetName == '/POE_*' && B.NetName == '/LED_*'"] {
        let result = check(&rule("clearance", "3mm", condition), &dsn("200"));
        assert_blocked(&result);
        assert_eq!(result.requirements[0].disposition, Disposition::WeakerThanNative);
    }
}

#[test]
fn quoted_net_operator_characters_remain_literal_and_relevant() {
    for active in ["/ALERT!", "/ALERT&&READY", "/ALERT||READY"] {
        let condition = format!("A.NetName == '{active}' && B.NetClass == 'POE'");
        let model = dsn("200").replace(&format!("\"{LED}\""), &format!("\"{active}\""));
        let fake = Fake::default();
        let mut run = Run::new(&fake);
        run.active = strings(&[active]);
        run.classes = BTreeMap::from([(active.to_string(), "Default".to_string()), (POE.to_string(), "POE".to_string())]);
        let result = run.inspect(&rule("clearance", "3mm", &condition), &model);
        assert_blocked(&result);
        let row = &result.requirements[0];
        assert_eq!(row.disposition, Disposition::WeakerThanNative);
        assert_eq!(row.witness, Some(Witness { active: active.to_string(), obstacle: Some(POE.to_string()) }));
    }
}

#[test]
fn unknown_or_malformed_native_selectors_and_bounds_fail_closed() {
    for condition in ["A.UnknownProperty == 'POE'", "A.unknownFunction('J1')", "A.NetClass ==", "A.NetClass == 'POE' && unbound_name"] {
        assert_blocked(&check(&rule("clearance", "3mm", condition), &dsn("3000")));
    }
    for value in ["nan", "inf", "-1mm", "3cm", "3e999mm", "unknown"] {
        assert_blocked(&check(&rule("clearance", value, DEFAULT_CONDITION), &dsn("3000")));
    }
    let text = default_rule();
    for bad in [&text[..text.len() - 1], "(version 2)", "(rule \"unterminated)", "(version 1) (rule \"x\" (constraint clearance (min 3mm)) (unrecognized 1))"] {
        assert_blocked(&check(bad, &dsn("3000")));
    }
}

#[test]
fn unknown_or_ambiguous_dsn_units_numbers_and_membership_fail_closed() {
    let strong = dsn("3000");
    let models = [
        dsn("nan"),
        dsn("-1"),
        dsn("3cm"),
        Dsn { clearance: "3000", unit: "unknown", ..Dsn::default() }.text(),
        strong.replace("(unit um)", "(unit um) (unit mm)"),
        strong.replacen("(clearance 3000)", "(clearance)", 1),
        strong.replace("(class \"DEFAULT\"", &format!("(class \"DEFAULT\" \"{POE}\"")),
        strong.replace(&format!("(class \"{POE}\""), "(class \"DEFAULT\""),
        strong.replace(&format!("(class \"DEFAULT\" \"{LED}\""), "(class \"DEFAULT\""),
    ];
    for model in &models {
        assert_blocked(&check(&default_rule(), model));
    }
    let fake = Fake::default();
    let mut run = Run::new(&fake);
    run.classes.remove(LED);
    assert_blocked(&run.inspect(&default_rule(), &dsn("200")));
    let mut run = Run::new(&fake);
    run.classes.insert("/unmodeled".to_string(), "Default".to_string());
    assert_blocked(&run.inspect(&default_rule(), &dsn("200")));
    let mut run = Run::new(&fake);
    run.obstacles = vec![obstacle("/unknown", "Pad", None)];
    assert_blocked(&run.inspect(&default_rule(), &dsn("200")));
}

#[test]
fn class_pair_does_not_hide_weaker_global_or_class_clearance() {
    let pair = format!("(class_class (classes \"DEFAULT\" \"{POE}\") (rule (clearance 3000)))");
    assert_blocked(&check(&default_rule(), &Dsn { pairs: &pair, ..Dsn::default() }.text()));
    let mixed = Dsn { clearance: "3000", pairs: &pair, ..Dsn::default() }.text().replacen("(rule (clearance 3000)))", "(rule (clearance 200)))", 1);
    assert_blocked(&check(&default_rule(), &mixed));
}

#[test]
fn backend_resolution_unit_cannot_disagree_with_the_coverage_unit() {
    for declaration in ["", "(resolution mm 10)", "(resolution um 0)", "(resolution um nan)", "(resolution um -1)", "(resolution um 2147483648)", "(resolution um 10) (resolution um 100)"] {
        assert_blocked(&check(&default_rule(), &dsn("3000").replace("(resolution um 10)", declaration)));
    }
    let millimetres = Dsn { clearance: "3", unit: "mm", ..Dsn::default() }.text().replace("(resolution um 10)", "(resolution mm 10)");
    assert_passed(&check(&default_rule(), &millimetres));
}

#[test]
fn typed_or_nested_weak_track_via_rules_cannot_fool_coverage() {
    let extras = ["(rule (clearance 200 (type wire_wire)))", "(rule (clearance 200 (type via_pin)))", "(region \"local\" (rule (clearance 200)))", "(unrecognized (nested (rule (clearance 200))))", "(rule (clearance nan (type via_pin)))"];
    for extra in extras {
        assert_blocked(&check(&default_rule(), &Dsn { clearance: "3000", extra, ..Dsn::default() }.text()));
    }
}

#[test]
fn exported_pad_only_clearance_exceptions_do_not_weaken_new_tracks() {
    for kind in ["smd_smd", "pin_pin", "pin_smd"] {
        let extra = format!("(rule (clearance 50 (type {kind})))");
        assert_passed(&check(&default_rule(), &Dsn { clearance: "3000", extra: &extra, ..Dsn::default() }.text()));
    }
}

#[test]
fn pads_only_prohibition_is_immutable_under_source_guard() {
    let rules = "(version 1) (rule \"fixed pad keepout\"
          (condition \"A.Type == 'Pad' && A.intersectsArea('H3_KEEPOUT')\")
          (constraint disallow pad))";
    let result = check(rules, &dsn("200"));
    assert_passed(&result);
    assert_eq!(result.requirements[0].disposition, Disposition::ImmutableUnchanged);
}

#[test]
fn exact_inactive_layer_is_irrelevant_but_active_unknown_and_wildcard_layers_block() {
    let model = Dsn { mask: Some(&["F.Cu"]), ..Dsn::default() }.text();
    let fake = Fake::default();
    for (layer, passed) in [("B.Cu", true), ("F.Cu", false), ("In1.Cu", false), ("*.Cu", false)] {
        let rules = format!("(version 1) (rule \"no tracks\" (layer \"{layer}\") (condition \"A.Type == 'Track'\") (constraint disallow track))");
        let result = Run::new(&fake).layers(&["F.Cu"]).inspect(&rules, &model);
        if passed { assert_passed(&result) } else { assert_blocked(&result) }
    }
    let inner = "(version 1) (rule \"inner\" (layer \"B.Cu\") (constraint disallow track))";
    assert_blocked(&check(inner, &Dsn { mask: Some(&["F.Cu", "B.Cu"]), ..Dsn::default() }.text()));
}

#[test]
fn silkscreen_rules_are_immutable_while_copper_clearance_still_blocks() {
    let silk = "(rule \"silk\" (condition \"A.memberOfFootprint('J1') && B.Layer == 'Edge.Cuts'\") (constraint silk_clearance (min -10mm)))";
    let one_layer = Dsn { mask: Some(&["F.Cu"]), ..Dsn::default() }.text();
    let fake = Fake::default();
    let result = Run::new(&fake).layers(&["F.Cu"]).inspect(&format!("(version 1) {silk}"), &one_layer);
    assert_passed(&result);
    assert_eq!(result.requirements[0].disposition, Disposition::ImmutableUnchanged);
    assert_blocked(&check(&format!("{} {silk}", default_rule()), &dsn("200")));
    let pending = check("(version 1) (rule \"silk to mask\" (constraint silk_clearance (min 1mm)))", &dsn("200"));
    assert_pending(&pending, json!({"rule": "silk to mask", "constraint": "silk_clearance", "enforcement": "native-drc", "drc_types": ["silk_overlap", "silk_over_copper"]}));
}

#[test]
fn new_via_hole_rules_are_native_obligations_but_track_only_proof_is_kept() {
    let either = "A.Pad_Type == 'Through-hole' || B.Pad_Type == 'Through-hole'";
    let both = "A.Pad_Type == 'Through-hole' && B.Pad_Type == 'Through-hole'";
    assert_pending(&check(&rule("hole_clearance", "0.28mm", either), &dsn("200")), json!({"rule": "PoE isolation", "constraint": "hole_clearance", "required_mm": "0.28", "enforcement": "native-drc", "drc_types": ["hole_clearance"]}));
    assert_pending(&check(&rule("hole_to_hole", "0.45mm", "True"), &dsn("200")), json!({"rule": "PoE isolation", "constraint": "hole_to_hole", "required_mm": "0.45", "enforcement": "native-drc", "drc_types": ["hole_to_hole", "holes_co_located"]}));
    assert_passed(&check(&rule("hole_to_hole", "0.45mm", both), &dsn("200")));
    let fake = Fake::default();
    let one_layer = Dsn { mask: Some(&["F.Cu"]), ..Dsn::default() }.text();
    assert_blocked(&Run::new(&fake).layers(&["F.Cu"]).inspect(&rule("hole_clearance", "0.28mm", either), &one_layer));
    assert_blocked(&check(&rule("hole_clearance", "0.28mm (max 1mm)", either), &dsn("200")));
}

#[test]
fn reference_stitching_requires_actual_single_layer_active_net_mask() {
    let gate = json!({"rule": "configured kicad_happy RP-001", "constraint": "reference_stitching", "enforcement": "configured-gate", "nets": [LED]});
    let fake = Fake::default();
    let stitched = |layers: &[&str], model: &str| {
        let mut run = Run::new(&fake).layers(layers);
        run.stitching = true;
        run.inspect("", model)
    };
    let both = ["F.Cu", "B.Cu"];
    assert_pending(&stitched(&both, &dsn("200")), gate.clone());
    assert_pending(&stitched(&both, &Dsn { mask: Some(&both), ..Dsn::default() }.text()), gate);
    let passed = stitched(&both, &Dsn { mask: Some(&["F.Cu"]), ..Dsn::default() }.text());
    assert_passed(&passed);
    assert_eq!(passed.requirements[0].disposition, Disposition::Covered);
    assert_blocked(&stitched(&both, &Dsn { mask: Some(&["Unknown.Cu"]), ..Dsn::default() }.text()));
    assert_blocked(&stitched(&["F.Cu"], &dsn("200")));
    assert_passed(&stitched(&["F.Cu"], &Dsn { mask: Some(&["F.Cu"]), ..Dsn::default() }.text()));
}

#[test]
fn actual_dsn_layer_declarations_must_support_requested_active_mask() {
    let model = Dsn { mask: Some(&["F.Cu"]), ..Dsn::default() }.text();
    let front = "(layer \"F.Cu\" (type signal))";
    let fake = Fake::default();
    for changed in [model.replace(front, ""), model.replace(front, "(layer \"F.Cu\" (type unknown))"), model.replace(front, &format!("{front} {front}"))] {
        let mut run = Run::new(&fake).layers(&["F.Cu"]);
        run.stitching = true;
        assert_blocked(&run.inspect("", &changed));
    }
}

#[test]
fn hole_proof_rejection_is_retained_and_cannot_admit_the_solver() {
    let rules = rule("hole_clearance", "0.28mm", "A.Pad_Type == 'Through-hole' || B.Pad_Type == 'Through-hole'");
    let model = Dsn { mask: Some(&["F.Cu"]), ..Dsn::default() }.text();
    for pads in [None, Some(Vec::new()), Some(vec![json!({"net": POE})])] {
        let fake = Fake::default();
        let mut run = Run::new(&fake).layers(&["F.Cu"]);
        run.pads = pads.clone();
        let result = run.inspect(&rules, &model);
        assert_blocked(&result);
        let row = &result.requirements[0];
        assert_eq!(row.disposition, Disposition::Unsupported);
        if pads.is_some_and(|pads| !pads.is_empty()) {
            assert_eq!(row.reason.as_deref(), Some("fixture containment rejected"));
            assert_eq!(fake.hole_calls.get(), 1);
        } else {
            assert_eq!(fake.hole_calls.get(), 0);
        }
    }
}

#[test]
fn custom_pth_selector_checks_every_active_net_before_using_the_pth_subset() {
    let later = "/ZZ_AFTER";
    let model = Dsn { mask: Some(&["F.Cu"]), ..Dsn::default() }.text()
        .replacen("(network ", &format!("(network (net \"{later}\" (pins R9-1)) "), 1)
        .replacen(&format!("(class \"DEFAULT\" \"{LED}\""), &format!("(class \"DEFAULT\" \"{LED}\" \"{later}\""), 1);
    let first = format!("(A.NetName == '{LED}' && B.Pad_Type == 'Through-hole')");
    let cases = [
        (format!("(A.NetName == '{later}' && B.Pad_Type == 'Through-hole' && B.intersectsArea('critical'))"), "selector applicability"),
        (format!("(A.NetName == '{later}' && B.Pad_Type == 'NPTH, mechanical')"), "PTH geometry and tracks only"),
    ];
    for (extra, wanted) in cases {
        let fake = Fake { hole_status: Some("covered"), ..Fake::default() };
        let mut run = Run::new(&fake).layers(&["F.Cu"]);
        run.active = strings(&[LED, later]);
        run.classes.insert(later.to_string(), "Default".to_string());
        run.classes.insert(String::new(), "Default".to_string());
        run.obstacles.push(obstacle("", "Pad", Some("NPTH, mechanical")));
        run.pads = Some(vec![json!({"net": POE})]);
        let result = run.inspect(&rule("hole_clearance", "0.28mm", &format!("{first} || {extra}")), &model);
        assert_blocked(&result);
        assert_eq!(fake.hole_calls.get(), 0);
        assert!(result.requirements[0].reason.as_deref().unwrap().contains(wanted));
    }
}

// Native postconditions.

fn report(violations: Vec<Value>, ignored: &[&str]) -> Value {
    let ignored: Vec<Value> = ignored.iter().map(|key| json!({"key": key})).collect();
    json!({"violations": violations, "unconnected_items": [], "schematic_parity": [], "ignored_checks": ignored, "included_severities": ["error", "warning", "exclusion"]})
}

fn holes_obligation() -> Value {
    json!({"constraint": "min_hole_to_hole", "required_mm": "0.25", "enforcement": "native-drc", "drc_types": ["hole_to_hole", "holes_co_located"]})
}

fn silk_obligation() -> Value {
    json!({"constraint": "min_silk_clearance", "required_mm": "0.15", "enforcement": "native-drc", "drc_types": ["silk_overlap", "silk_over_copper"]})
}

fn finding(kind: &str, uuids: &[&str]) -> Value {
    let items: Vec<Value> = uuids.iter().map(|uuid| json!({"description": "item", "uuid": uuid})).collect();
    json!({"type": kind, "severity": "warning", "items": items})
}

#[test]
fn clean_native_drc_discharges_and_gate_and_thermal_obligations_stay_typed() {
    let gate = json!({"rule": "configured kicad_happy RP-001", "constraint": "reference_stitching", "enforcement": "configured-gate", "nets": [LED]});
    let thermal = json!({"constraint": "min_resolved_spokes", "required_count": "2", "capability_sha256": "c".repeat(64)});
    let result = discharge_native(&[holes_obligation(), gate.clone(), thermal.clone()], &report(vec![json!({"type": "clearance", "severity": "error"})], &[]), None);
    assert_eq!(result.status, "passed", "{result:?}");
    let mut row = holes_obligation();
    row["violations"] = json!(0);
    assert_eq!(result.native_drc, [row]);
    assert_eq!(result.configured_gate, [gate]);
    assert_eq!(result.native_checkback, [thermal]);
    assert!(!result.qualified);
}

#[test]
fn violation_ignored_check_or_incomplete_report_fails_the_obligation() {
    let mut severities = report(Vec::new(), &[]);
    severities["included_severities"] = json!(["error"]);
    let cases = [
        report(vec![json!({"type": "hole_to_hole", "severity": "warning"})], &[]),
        report(vec![json!({"type": "holes_co_located", "severity": "exclusion", "excluded": true})], &[]),
        report(Vec::new(), &["hole_to_hole"]),
        severities,
        json!({"violations": []}),
    ];
    for case in &cases {
        let result = discharge_native(&[holes_obligation()], case, None);
        assert_eq!(result.status, "failed", "{result:?}");
        assert!(!result.cause.is_empty());
    }
    let unknown = discharge_native(&[json!({"constraint": "min_hole_to_hole"})], &report(Vec::new(), &[]), None);
    assert_eq!(unknown.status, "failed");
    assert_eq!(unknown.cause, "unknown native obligation: {\"constraint\": \"min_hole_to_hole\"}");
}

#[test]
fn finding_already_on_the_input_board_does_not_fail_the_obligation() {
    let old = finding("silk_over_copper", &["text-1", "pad-1"]);
    let result = discharge_native(&[silk_obligation()], &report(vec![old.clone()], &[]), Some(&report(vec![old], &[])));
    assert_eq!(result.status, "passed", "{result:?}");
    assert_eq!(result.native_drc[0]["violations"], 0);
    assert_eq!(result.native_drc[0]["preexisting"], 1);
}

#[test]
fn finding_that_touches_new_copper_fails_the_obligation() {
    let old = finding("silk_over_copper", &["text-1", "pad-1"]);
    let new = finding("silk_over_copper", &["text-1", "new-via"]);
    let result = discharge_native(&[silk_obligation()], &report(vec![old.clone(), new], &[]), Some(&report(vec![old], &[])));
    assert_eq!(result.status, "failed");
    assert_eq!(result.native_drc[0]["violations"], 1);
    assert_eq!(result.cause, "native project: min_silk_clearance has 1 native findings");
}

#[test]
fn a_repeated_input_finding_counts_once_only() {
    let old = finding("silk_over_copper", &["text-1", "pad-1"]);
    let result = discharge_native(&[silk_obligation()], &report(vec![old.clone(), old.clone()], &[]), Some(&report(vec![old], &[])));
    assert_eq!(result.status, "failed");
}

#[test]
fn incomplete_or_unidentified_baseline_fails() {
    let mut severities = report(Vec::new(), &[]);
    severities["included_severities"] = json!(["error"]);
    let no_uuid = report(vec![json!({"type": "silk_over_copper", "severity": "warning", "items": [{"description": "item"}]})], &[]);
    for baseline in [severities, no_uuid] {
        assert_eq!(discharge_native(&[silk_obligation()], &report(Vec::new(), &[]), Some(&baseline)).status, "failed");
    }
}

// Clearance strengthening.

fn project_text(floor: f64, unused: f64) -> String {
    json!({"board": {"design_settings": {"rules": {"min_clearance": 0}}}, "net_settings": {"classes": [
        {"name": "Default", "clearance": 0.2}, {"name": "POE", "clearance": floor}, {"name": "UNUSED", "clearance": unused}]}}).to_string()
}

fn strengthen(model: &str, project: &str) -> Result<(String, crate::route_features::StrengthenReceipt), String> {
    let (active, classes, obstacles, layers) = (strings(&[LED]), classes(), obstacles(), strings(&["F.Cu", "B.Cu"]));
    let scope = RouteScope { active_nets: &active, net_classes: &classes, obstacles: &obstacles, layers: &layers };
    strengthen_project_clearance(model, project, "actual-project.kicad_pro", &scope, &Fake::default())
}

fn default_project() -> String {
    project_text(0.3, 99.0)
}

#[test]
fn applicable_power_class_raises_every_weak_declaration_without_using_unused_class() {
    let extra = "(rule (clearance 50 (type smd_smd)))\n          (region \"nested\" (rule (clearance 100 (type wire_wire))))";
    let pairs = "(class_class (classes \"DEFAULT\" \"POE\") (rule (clearance 600)))";
    let name = |text: String| text.replace("\"coverage-fixture\"", "\"literal (clearance 200)\"");
    let model = format!("# comment (clearance 200)\n{}", name(Dsn { extra, pairs, ..Dsn::default() }.text()));
    let (actual, receipt) = strengthen(&model, &default_project()).unwrap();
    let expected = format!("# comment (clearance 200)\n{}", name(Dsn { clearance: "300", extra: &extra.replace("clearance 100", "clearance 300"), pairs, ..Dsn::default() }.text()));
    assert_eq!(actual, expected);
    assert_eq!(receipt.changes.len(), 4);
    assert_eq!(receipt.requirement.required_mm, "0.3");
    let netclasses: Vec<_> = receipt.requirement.requirements.iter().filter_map(|row| row.netclass.as_deref()).collect();
    assert_eq!(netclasses, ["Default", "POE"]);
    assert_eq!(receipt.before_sha256, sha256(model.as_bytes()));
    assert_eq!(receipt.after_sha256, sha256(actual.as_bytes()));
    assert_eq!(receipt.project.sha256, sha256(default_project().as_bytes()));
    assert!(!receipt.qualified);
}

#[test]
fn pad_only_exceptions_and_all_nonclearance_bytes_stay_exact() {
    let extra: String = ["smd_smd", "pin_pin", "pin_smd"].iter().map(|kind| format!("(rule (clearance 50 (type {kind})))")).collect();
    let model = Dsn { extra: &extra, ..Dsn::default() }.text();
    let (changed, receipt) = strengthen(&model, &default_project()).unwrap();
    assert_eq!(changed, Dsn { clearance: "300", extra: &extra, ..Dsn::default() }.text());
    let (mut cursor, mut pieces) = (0, String::new());
    for edit in &receipt.changes {
        assert_eq!(model[edit.start..edit.end], edit.before);
        pieces.push_str(&model[cursor..edit.start]);
        pieces.push_str(&edit.after);
        cursor = edit.end;
    }
    pieces.push_str(&model[cursor..]);
    assert_eq!(pieces, changed);
    let layers = strings(&["F.Cu"]);
    assert_eq!(Model::new(&changed, &layers).unwrap().membership, Model::new(&model, &layers).unwrap().membership);
}

#[test]
fn receipt_offsets_count_characters_not_bytes() {
    let model = dsn("200").replace("coverage-fixture", "Ω");
    let (_, receipt) = strengthen(&model, &default_project()).unwrap();
    let chars: Vec<char> = model.chars().collect();
    let first = &receipt.changes[0];
    assert_eq!(chars[first.start..first.end].iter().collect::<String>(), "200");
}

#[test]
fn stronger_model_is_unchanged_and_strengthening_is_idempotent() {
    let model = dsn("600");
    let (same, receipt) = strengthen(&model, &default_project()).unwrap();
    assert_eq!(same, model);
    assert!(receipt.changes.is_empty());
    let (once, _) = strengthen(&dsn("200"), &default_project()).unwrap();
    let (twice, report) = strengthen(&once, &default_project()).unwrap();
    assert_eq!(twice, once);
    assert!(report.changes.is_empty());
}

#[test]
fn exact_known_unit_conversions_and_nonrepresentable_values_abstain() {
    for (unit, initial, target, floor, resolution) in [("mm", "0.2", "0.3", 0.3, 10), ("mil", "5", "10", 0.254, 10), ("in", "0.05", "0.1", 2.54, 100)] {
        let model = Dsn { clearance: initial, unit, ..Dsn::default() }.text().replace("(resolution um 10)", &format!("(resolution {unit} {resolution})"));
        let (changed, _) = strengthen(&model, &project_text(floor, 99.0)).unwrap();
        assert_eq!(changed, model.replace(&format!("(clearance {initial})"), &format!("(clearance {target})")));
    }
    let cases = [
        (Dsn { clearance: "0.2", unit: "mm", ..Dsn::default() }.text().replace("(resolution um 10)", "(resolution mm 10)"), 0.25),
        (Dsn { clearance: "5", unit: "mil", ..Dsn::default() }.text().replace("(resolution um 10)", "(resolution mil 127)"), 0.3),
    ];
    for (model, floor) in cases {
        let error = strengthen(&model, &project_text(floor, 99.0)).unwrap_err();
        assert!(error.contains("exact") || error.contains("represent"), "{error}");
    }
}

#[test]
fn unknown_malformed_units_qualifiers_numbers_and_tokens_fail_closed() {
    let base = dsn("200");
    let with_extra = |extra: &str| Dsn { extra, ..Dsn::default() }.text();
    let variants = [
        Dsn { unit: "unknown", ..Dsn::default() }.text(),
        base.replace("(unit um)", "(unit um) (unit mm)"),
        base.replace("(resolution um 10)", "(resolution mm 10)"),
        dsn("nan"),
        dsn("-1"),
        with_extra("(rule (clearance 50 (type unsupported)))"),
        with_extra("(rule (clearance 50 (type smd_smd) (type pin_pin)))"),
        with_extra("(rule (clearance 50 (type smd_smd smd_smd)))"),
        with_extra("(rule (clearance 50 (type smd_smd) unknown))"),
        with_extra("(region x (unit mm))"),
        dsn("200um"),
        base[..base.len() - 1].to_string(),
        base.replace("(unit um)", "(unit (unknown))"),
        base.replace("\"coverage-fixture\"", "\"unterminated"),
    ];
    for model in &variants {
        assert!(strengthen(model, &default_project()).is_err(), "{model}");
    }
}

#[test]
fn used_class_or_native_membership_unknown_blocks_instead_of_dropping_obstacle() {
    let mut value: Value = serde_json::from_str(&default_project()).unwrap();
    value["net_settings"]["classes"].as_array_mut().unwrap().truncate(1);
    let error = strengthen(&dsn("200"), &value.to_string()).unwrap_err();
    assert!(error.contains("netclass clearance is unresolved"), "{error}");
    let membership = format!("(class \"{POE}\" \"{POE}\"");
    assert!(dsn("200").contains(&membership));
    let model = dsn("200").replacen(&membership, &format!("(class \"{POE}\""), 1);
    let error = strengthen(&model, &default_project()).unwrap_err();
    assert!(error.contains("absent from the DSN"), "{error}");
}

#[test]
fn unused_native_mapping_without_dsn_membership_does_not_set_the_floor() {
    let (active, mut classes, obstacles, layers) = (strings(&[LED]), classes(), obstacles(), strings(&["F.Cu", "B.Cu"]));
    classes.insert("UNUSED_DECLARATION".to_string(), "UNUSED".to_string());
    let scope = RouteScope { active_nets: &active, net_classes: &classes, obstacles: &obstacles, layers: &layers };
    let (changed, receipt) = strengthen_project_clearance(&dsn("200"), &default_project(), "actual-project.kicad_pro", &scope, &Fake::default()).unwrap();
    assert_eq!(changed, dsn("300"));
    assert_eq!(receipt.requirement.required_mm, "0.3");
    assert!(!receipt.requirement.counterparts.iter().any(|net| net == "UNUSED_DECLARATION"));
}

#[test]
fn a_pin_with_a_quoted_id_does_not_break_the_model() {
    let model = dsn("3000").replace("(pins R10-1)", "(pins R10-\"(1)\" \"U 1\"-2)");
    assert_passed(&check(&default_rule(), &model));
}
