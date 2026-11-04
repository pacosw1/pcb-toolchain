use route_coverage::{
    board::{self, NativeBoard},
    decimal as dec, evidence,
    hole::{self, Obstacle},
};
use serde_json::{Value, json};
fn dsn() -> String {
    r#"(pcb fixture (parser (string_quote ")) (resolution um 10) (unit um)
 (structure (layer F.Cu (type signal)) (layer B.Cu (type power)))
 (placement (component TERM (place J1 100000 -100000 front 0)))
 (library (image TERM (pin Round[A]Pad_2100.000000_um 1 -1750 0))
 (padstack Round[A]Pad_2100.000000_um (shape (circle F.Cu 2100)) (shape (circle B.Cu 2100))))
 (network (net /POWER (pins J1-1)) (net /LED_A (pins D3-1))))"#
        .into()
}
fn pad() -> Value {
    json!({"reference":"J1","pad":"1","net":"/POWER","side":"front","footprint_position_mm":["100","100"],"footprint_rotation_deg":"0","position_mm":["98.25","100"],"size_mm":["2.1","2.1"],"drill_mm":["1.399997","1.399997"],"drill_offset_mm":["0","0"],"shape":"circle","layers":["F.Cu","B.Cu"],"identity":"physical-1","rotation_deg":"0","export_pin":"1"})
}
fn request() -> hole::PthRequest {
    serde_json::from_value(json!({"dsn_text":dsn(),"pads":[pad()],"active_nets":["/LED_A"],"layers":["F.Cu"],"required_mm":"0.28","clearance_floor_mm":"0.2"})).unwrap()
}
#[test]
fn legacy_exact_boundary_numbers_are_preserved() {
    let proof = hole::inspect(&request());
    assert_eq!(proof["status"], "covered", "{proof}");
    assert_eq!(
        proof["covered_pads"][0]["native_drill_radius_mm"],
        "0.6999985"
    );
    assert_eq!(
        proof["covered_pads"][0]["containment_slack_radius_mm"],
        "0.0700015"
    );
    assert_eq!(proof["qualified"], false);
}
#[test]
fn tangency_uses_exact_squared_distance() {
    let mut r = request();
    r.pads[0]["drill_mm"] = json!(["1.4", "1.4"]);
    r.scope.clearance_floor_mm = "0".into();
    r.dsn_text = r.dsn_text.replace("1 -1750 0", "1 -1708 -56");
    assert_eq!(hole::inspect(&r)["status"], "covered");
    r.dsn_text = r.dsn_text.replace("-1708 -56", "-1707.999999 -56");
    assert_eq!(hole::inspect(&r)["status"], "blocked");
}
#[test]
fn floor_credit_cannot_round_up() {
    let mut r = request();
    r.pads[0]["size_mm"] = json!(["0.6", "0.6"]);
    r.pads[0]["drill_mm"] = json!(["0.3", "0.3"]);
    r.dsn_text = r
        .dsn_text
        .replace("(circle F.Cu 2100)", "(circle F.Cu 600)");
    r.scope.clearance_floor_mm = "0.13".into();
    assert_eq!(hole::inspect(&r)["status"], "covered");
    r.scope.clearance_floor_mm = "0.129999999999".into();
    assert_eq!(hole::inspect(&r)["status"], "blocked");
}
#[test]
fn hostile_or_unbound_inputs_fail_closed() {
    let base = request();
    let mut cases = Vec::new();
    let mut r = request();
    r.scope.layers.push("B.Cu".into());
    cases.push(r);
    let mut r = request();
    r.scope.active_nets = vec!["/POWER".into()];
    cases.push(r);
    let mut r = request();
    r.pads.push(pad());
    cases.push(r);
    let mut r = request();
    r.pads[0]["side"] = "back".into();
    cases.push(r);
    let mut r = request();
    r.pads[0]["position_mm"] = json!(["98.35", "100"]);
    r.scope.clearance_floor_mm = "0".into();
    cases.push(r);
    let mut r = request();
    r.pads[0]["drill_offset_mm"] = json!(["0.1", "0"]);
    cases.push(r);
    let mut r = request();
    r.dsn_text = r.dsn_text.replace("(type power)", "(type signal)");
    cases.push(r);
    let mut r = request();
    r.dsn_text = r
        .dsn_text
        .replace("(net /POWER (pins J1-1))", "(net /OTHER (pins J1-1))");
    cases.push(r);
    let mut r = request();
    r.dsn_text = r
        .dsn_text
        .replace("(resolution um 10)", "(resolution mm 10)");
    cases.push(r);
    let mut r = request();
    r.dsn_text.push(')');
    cases.push(r);
    for r in cases {
        let proof = hole::inspect(&r);
        assert_eq!(proof["status"], "blocked", "{proof}");
        assert!(proof["cause"].as_str().is_some_and(|s| !s.is_empty()));
    }
    assert_eq!(hole::inspect(&base)["status"], "covered");
}
#[test]
fn rectangle_preserves_native_rotation() {
    let mut r = request();
    r.pads[0]["shape"] = "rect".into();
    r.dsn_text = r
        .dsn_text
        .replace("(circle F.Cu 2100)", "(rect F.Cu -1050 -1050 1050 1050)");
    assert_eq!(hole::inspect(&r)["status"], "covered");
    r.pads[0]["size_mm"] = json!(["2.1", "2.2"]);
    assert_eq!(hole::inspect(&r)["status"], "blocked");
}
#[test]
fn aliases_need_distinct_physical_identities_and_exact_geometry() {
    let mut r = request();
    let mut p = pad();
    p["identity"] = "physical-2".into();
    p["export_pin"] = "1@1".into();
    r.pads.push(p);
    r.dsn_text=r.dsn_text.replace("(pin Round[A]Pad_2100.000000_um 1 -1750 0)","(pin Round[A]Pad_2100.000000_um 1 -1750 0) (pin Round[A]Pad_2100.000000_um 1@1 -1750 0)").replace("(pins J1-1)","(pins J1-1 J1-1@1)");
    assert_eq!(hole::inspect(&r)["status"], "covered");
    r.pads[1]["identity"] = "physical-1".into();
    assert_eq!(hole::inspect(&r)["status"], "blocked");
}
fn point(x: &str, y: &str) -> dec::Point {
    [dec::decimal(x).unwrap(), dec::decimal(y).unwrap()]
}
#[test]
fn capsule_and_rectangle_containment_do_not_sample_or_round() {
    let outer = hole::capsule(point("0", "0"), point("2", "2"), 0);
    let drill = hole::capsule(point("0.07", "0"), point("1.4", "1.4"), 0);
    assert!(hole::contains(&outer, &drill, &dec::decimal("0.23").unwrap(), &dec::zero()).unwrap());
    assert!(
        !hole::contains(
            &outer,
            &drill,
            &dec::decimal("0.230000000001").unwrap(),
            &dec::zero()
        )
        .unwrap()
    );
    let rect = Obstacle::Rect([
        dec::decimal("-1").unwrap(),
        dec::decimal("-1").unwrap(),
        dec::decimal("1").unwrap(),
        dec::decimal("1").unwrap(),
    ]);
    assert!(hole::contains(&rect, &drill, &dec::decimal("0.23").unwrap(), &dec::zero()).unwrap());
}
#[test]
fn complete_empty_inventory_still_binds_actual_dsn() {
    let r:hole::DrilledRequest=serde_json::from_value(json!({"dsn_text":dsn(),"holes":[],"active_nets":["/LED_A"],"layers":["F.Cu"],"required_mm":".28","clearance_floor_mm":".2"})).unwrap();
    assert_eq!(hole::inspect_drilled(&r)["status"], "covered");
}
#[test]
fn same_net_drills_still_bind_their_exact_physical_instance() {
    let mut h = pad();
    h["kind"] = "pth".into();
    h["supported"] = true.into();
    h["cause"] = Value::Null;
    h["native_form_sha256"] = "a".repeat(64).into();
    h["drill_shape"] = "circle".into();
    h["hole_layers"] = json!(["F.Cu", "B.Cu"]);
    let mut r:hole::DrilledRequest=serde_json::from_value(json!({"dsn_text":dsn(),"holes":[h],"active_nets":["/POWER"],"layers":["F.Cu"],"required_mm":".28","clearance_floor_mm":".2","applicability":"kicad10_project_track"})).unwrap();
    let proof = hole::inspect_drilled(&r);
    assert_eq!(proof["status"], "covered", "{proof}");
    assert_eq!(
        proof["covered_holes"][0]["disposition"],
        "native_not_applicable"
    );
    r.holes[0]["position_mm"] = json!(["98.2", "100"]);
    assert_eq!(hole::inspect_drilled(&r)["status"], "blocked");
}
#[test]
fn api_inventory_keeps_aliases_and_unsupported_geometry() {
    let mut pad = json!({"id":"one","number":"9","kind":"ThroughHole","shape":"Circle","net":"GND","position":{"x":0,"y":0},"orientation":0,"size":{"x":600000,"y":600000},"drill":{"x":300000,"y":300000},"layers":["F.Cu","B.Cu"],"copper":[{"Circle":{"center":{"x":0,"y":0},"radius":300000}}]});
    let mut second = pad.clone();
    second["id"] = "two".into();
    second["shape"] = "Custom".into();
    pad["id"] = "one".into();
    let b:NativeBoard=serde_json::from_value(json!({"copper_layers":["F.Cu","B.Cu"],"footprints":[{"reference":"U1","layer":"F.Cu","position":{"x":0,"y":0},"orientation":0,"pads":[pad,second]}],"copper":[]})).unwrap();
    let rows = board::native_drilled_geometry(&b).unwrap();
    assert_eq!(rows.len(), 2);
    assert_eq!(rows[0]["export_pin"], "9");
    assert_eq!(rows[1]["supported"], false);
    assert!(board::native_pth_pads(&b).is_err());
}
#[test]
fn strict_json_rejects_duplicate_keys_recursively() {
    assert!(evidence::parse(r#"{"a":{"x":1,"x":2}}"#).is_err());
    assert!(evidence::parse(r#"{"a":NaN}"#).is_err());
    assert_eq!(
        evidence::parse(r#"{"a":0.10000000000000000000001}"#).unwrap()["a"].to_string(),
        "0.10000000000000000000001"
    );
}

#[test]
fn missing_api_via_type_and_extent_cannot_certify_a_through_via() {
    let board: NativeBoard = serde_json::from_value(json!({
        "copper_layers": ["F.Cu", "B.Cu"], "footprints": [],
        "copper": [{"Via": {"id": "via", "at": {"x": 0, "y": 0},
            "size": 600000, "drill": 300000, "net": "GND", "locked": false}}]
    }))
    .unwrap();
    let rows = board::native_drilled_geometry(&board).unwrap();
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0]["supported"], false);
    assert!(
        rows[0]["cause"]
            .as_str()
            .unwrap()
            .contains("extent is unresolved")
    );
}

#[test]
fn a_sub_hundred_digit_boundary_difference_must_not_round_into_coverage() {
    let mut r = request();
    r.pads[0]["size_mm"] = json!(["0.6", "0.6"]);
    let drill = format!("0.3{}1", "0".repeat(120));
    r.pads[0]["drill_mm"] = json!([drill, drill]);
    r.dsn_text = r
        .dsn_text
        .replace("(circle F.Cu 2100)", "(circle F.Cu 600)");
    r.scope.clearance_floor_mm = "0.13".into();
    assert_eq!(hole::inspect(&r)["status"], "blocked");
    assert!(dec::divide(&dec::decimal("1").unwrap(), &dec::decimal("3").unwrap()).is_err());
}
