use iotroute::kicad::sexpr;
use route_coverage::{
    decimal as dec,
    project::{self, REQUIRED},
};
use serde_json::{Value, json};
fn request() -> project::Request {
    let rules: serde_json::Map<_, _> = REQUIRED.iter().map(|n| (n.to_string(), json!(0))).collect();
    serde_json::from_value(json!({"text":json!({"board":{"design_settings":{"rules":rules}},"net_settings":{"classes":[{"name":"Default","clearance":0,"via_diameter":0.6,"via_drill":0.3}]}}).to_string(),
        "source":"native.kicad_pro","dsn_text":"(pcb fixture (resolution um 10) (unit um) (structure (layer F.Cu (type signal)) (layer B.Cu (type power)) (rule (clearance 200))) (network (class Default A B (circuit (use_layer F.Cu)))))",
        "active_nets":["A"],"net_classes":{"A":"Default","B":"Default"},"obstacles":[{"NetName":"B"}],"holes":[],"holes_preserved":true,"immutable_geometry_preserved":true,"backend_command":["backend","--router.min_trace_width_um=250","--router.copper_to_edge_clearance_um=300"]})).unwrap()
}
fn set(r: &mut project::Request, name: &str, v: Value) {
    let mut p: Value = serde_json::from_str(r.text.as_ref().unwrap()).unwrap();
    p["board"]["design_settings"]["rules"][name] = v;
    r.text = Some(p.to_string());
}
fn row(r: &project::Request, name: &str) -> Value {
    project::evaluate(r)
        .into_iter()
        .find(|r| r["constraint"] == name)
        .unwrap()
}
#[test]
fn explicit_zeros_and_missing_minima_are_distinct() {
    let mut r = request();
    assert_eq!(row(&r, "min_connection")["disposition"], "not_applicable");
    r.text = Some(r.text.unwrap().replace("\"min_connection\":0,", ""));
    assert_eq!(row(&r, "min_connection")["disposition"], "unsupported");
}
#[test]
fn clearance_and_exact_argv_controls_match_the_actual_model() {
    let mut r = request();
    set(&mut r, "min_clearance", json!(0.2));
    assert_eq!(row(&r, "min_clearance")["disposition"], "covered");
    set(&mut r, "min_clearance", json!(0.200000000001f64));
    assert_eq!(
        row(&r, "min_clearance")["disposition"],
        "weaker_than_native"
    );
    set(&mut r, "min_track_width", json!(0.25));
    assert_eq!(row(&r, "min_track_width")["disposition"], "covered");
    r.backend_command.push("--router.neck_width_um=100".into());
    assert_eq!(
        row(&r, "min_track_width")["disposition"],
        "weaker_than_native"
    );
}
#[test]
fn duplicate_controls_never_silently_override() {
    let cmd = vec![
        "bin".into(),
        "--router.min_trace_width_um=100".into(),
        "--router.min_trace_width_um=250".into(),
    ];
    assert!(project::command_floor(&cmd, "min_trace_width_um").is_err());
    for v in ["-1", "1.5", "１２", "", "2e3"] {
        assert!(project::command_floor(&["bin".into(), format!("--router.x={v}")], "x").is_err());
    }
    assert_eq!(
        project::command_floor(&["bin".into(), "--router.x=250".into()], "x").unwrap(),
        dec::decimal(".25").unwrap()
    );
}
#[test]
fn unsupported_authored_requirements_stay_visible() {
    let mut r = request();
    set(&mut r, "future_rule", json!(0));
    assert_eq!(row(&r, "future_rule")["disposition"], "unsupported");
    set(&mut r, "min_track_width", json!(true));
    assert_eq!(row(&r, "min_track_width")["disposition"], "unsupported");
}
#[test]
fn missing_and_duplicate_project_documents_block() {
    assert!(project::load(None).is_err());
    assert!(project::load(Some("{\"board\":{},\"board\":{}}")).is_err());
    let mut r = request();
    r.text = None;
    assert_eq!(project::evaluate(&r)[0]["constraint"], "project_document");
}
#[test]
fn immutable_dimensions_require_exact_scope() {
    let mut r = request();
    set(&mut r, "min_via_diameter", json!(0.6));
    assert_eq!(
        row(&r, "min_via_diameter")["disposition"],
        "immutable_unchanged"
    );
    r.holes_preserved = false;
    assert_eq!(row(&r, "min_via_diameter")["disposition"], "unsupported");
}
#[test]
fn native_thermal_is_a_pending_postcondition() {
    let mut r = request();
    set(&mut r, "min_resolved_spokes", json!(2));
    assert_eq!(row(&r, "min_resolved_spokes")["disposition"], "unsupported");
    r.native_thermal_capability = json!({"schema":"iot-lab.native-thermal-capability.v1","status":"pending_native","required_count":2,"content_sha256":"bound"});
    assert_eq!(
        row(&r, "min_resolved_spokes")["disposition"],
        "native_postcondition"
    );
    r.native_thermal_capability["required_count"] = json!(3);
    assert_eq!(row(&r, "min_resolved_spokes")["disposition"], "unsupported");
}
#[test]
fn thermal_scope_preserves_unknowns() {
    let plain = sexpr::parse("(kicad_pcb (zone (connect_pads yes)))").unwrap();
    assert_eq!(
        project::thermal_scope(&plain, &[])["thermal_connections_possible"],
        false
    );
    let thermal = sexpr::parse("(kicad_pcb (zone (connect_pads (clearance .2))))").unwrap();
    assert_eq!(
        project::thermal_scope(&thermal, &[])["thermal_connections_possible"],
        true
    );
    let custom = sexpr::parse("(rule X (constraint zone_connection solid))").unwrap();
    assert_eq!(
        project::thermal_scope(&plain, &custom)["thermal_connections_possible"],
        true
    );
}
#[test]
fn moving_vias_are_checked_from_exact_dsn_and_netclass_sizes() {
    let mut r = request();
    r.dsn_text="(pcb x (resolution um 10) (unit um) (structure (layer F.Cu (type signal)) (layer B.Cu (type signal)) (via Via[0-1]_600:300_um) (rule (clearance 200))) (library (padstack Via[0-1]_600:300_um (shape (circle F.Cu 600)) (shape (circle B.Cu 600)))) (network (class Default A B)))".into();
    for (rule, value) in [
        ("min_via_diameter", 0.6),
        ("min_via_annular_width", 0.15),
        ("min_through_hole_diameter", 0.3),
        ("min_microvia_drill", 0.1),
    ] {
        set(&mut r, rule, json!(value));
        assert!(
            matches!(
                row(&r, rule)["disposition"].as_str(),
                Some("covered" | "not_applicable")
            ),
            "{}",
            row(&r, rule)
        );
    }
    set(&mut r, "min_hole_to_hole", json!(0.45));
    assert_eq!(
        row(&r, "min_hole_to_hole")["disposition"],
        "native_postcondition"
    );
    r.dsn_text = r.dsn_text.replace("(circle B.Cu 600)", "(circle B.Cu 500)");
    assert_eq!(row(&r, "min_via_diameter")["disposition"], "unsupported");
}
