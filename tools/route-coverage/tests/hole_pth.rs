//! The PTH proof from native inventory to DSN obstacle. Native input is the API board, so source-text spellings have no form here.
mod hole_common;
use hole_common::{MM, board, dsn, footprint, native, pth, read};
use route_coverage::{
    board::native_pth_pads,
    decimal as dec,
    hole::{self, PthRequest},
};
use serde_json::{Value, json};
use std::collections::BTreeSet;

fn pads(native: &Value) -> Vec<Value> {
    native_pth_pads(&read(native)).unwrap()
}
fn request(model: &str, pads: &[Value], floor: &str) -> PthRequest {
    serde_json::from_value(json!({"dsn_text": model, "pads": pads, "active_nets": ["/LED_A"], "layers": ["F.Cu"],
        "required_mm": "0.28", "clearance_floor_mm": floor}))
    .unwrap()
}
fn check(model: &str, pads: &[Value], floor: &str) -> Value {
    hole::inspect(&request(model, pads, floor))
}
fn covered(proof: Value) -> Value {
    assert_eq!(proof["status"], "covered", "{proof}");
    assert_eq!(proof["qualified"], false, "{proof}");
    proof
}
fn blocked(proof: Value) {
    assert_eq!(proof["status"], "blocked", "{proof}");
    assert_eq!(proof["qualified"], false, "{proof}");
    assert!(proof["cause"].as_str().is_some_and(|s| !s.is_empty()), "{proof}");
}
fn strip_physical(pads: &[Value]) -> Vec<Value> {
    let mut pads = pads.to_vec();
    for pad in &mut pads {
        for key in ["identity", "rotation_deg", "export_pin"] {
            pad.as_object_mut().unwrap().remove(key);
        }
    }
    pads
}

#[test]
fn native_collector_keeps_every_pth_and_its_exact_rotated_geometry() {
    let pads = pads(&native());
    let names: Vec<_> = pads.iter().map(|p| (p["reference"].as_str().unwrap(), p["pad"].as_str().unwrap())).collect();
    assert_eq!(names, [("J1", "1"), ("J2", "1")]);
    assert_eq!(pads[0]["position_mm"], json!(["98.25", "100"]));
    assert_eq!(pads[1]["position_mm"], json!(["111.75", "100"]));
    assert_eq!(pads[0]["drill_mm"], json!(["1.399997", "1.399997"]));
    assert_eq!(pads[0]["layers"], json!(["F.Cu", "B.Cu"]));
}

#[test]
fn actual_circular_obstacles_contain_expanded_other_net_drills() {
    let proof = covered(check(&dsn(), &pads(&native()), "0.2"));
    assert_eq!(proof["covered_pads"].as_array().unwrap().len(), 2);
    assert_eq!(proof["covered_pads"][0]["native_drill_radius_mm"], "0.6999985");
    assert_eq!(proof["covered_pads"][0]["containment_slack_radius_mm"], "0.0700015");
}

#[test]
fn containment_uses_squared_displacement_without_rounding() {
    let mut pad = pads(&native())[..1].to_vec();
    pad[0]["drill_mm"] = json!(["1.4", "1.4"]);
    // 0.042² + 0.056² = 0.07²: exactly tangent.
    let tangent = dsn().replace("1 -1750 0", "1 -1708 -56");
    covered(check(&tangent, &pad, "0"));
    blocked(check(&tangent.replace("-1708 -56", "-1707.999999 -56"), &pad, "0"));
    blocked(check(&dsn().replace("(circle F.Cu 2100)", "(circle F.Cu 1900)"), &pad, "0"));
}

#[test]
fn only_the_verified_floor_is_credited_at_its_exact_boundary() {
    let mut pad = pads(&native())[..1].to_vec();
    pad[0]["size_mm"] = json!(["0.6", "0.6"]);
    pad[0]["drill_mm"] = json!(["0.3", "0.3"]);
    let model = dsn().replace("(circle F.Cu 2100)", "(circle F.Cu 600)");
    let proof = covered(check(&model, &pad, "0.13"));
    let row = &proof["covered_pads"][0];
    let number = |key: &str| dec::decimal(row[key].as_str().unwrap()).unwrap();
    assert_eq!(number("containment_slack_radius_mm"), dec::decimal("-0.13").unwrap());
    assert_eq!(row["credited_clearance_mm"], "0.13");
    assert_eq!(number("effective_containment_slack_mm"), dec::zero());
    blocked(check(&model, &pad, "0.129999999999"));
}

/// The KiCad 10 CELLULAR/PWR export: six thermal PTHs and an SMD EP share number 9, and the EP consumes the @3 suffix.
fn repeated_drills() -> (Vec<Value>, String) {
    let places = [(-1300, -650), (-1300, 650), (0, -650), (0, 0), (0, 650), (1300, -650), (1300, 650)];
    let (mut native, mut pins, mut members) = (Vec::new(), String::new(), Vec::new());
    for (index, (x, y)) in places.into_iter().enumerate() {
        let at = [(100_000 - x) * 1000, (100_000 - y) * 1000];
        let mut pad = if index == 3 {
            let mut smd = pth("9", "GND", at, 180, "Rect", [3_100_000, 2_400_000], [0, 0]);
            smd["kind"] = "Smd".into();
            smd
        } else {
            pth("9", "GND", at, 180, "Circle", [600_000; 2], [300_000; 2])
        };
        pad["id"] = format!("physical-{index}").into();
        native.push(pad);
        let name = if index == 0 { "9".to_string() } else { format!("9@{index}") };
        pins.push_str(&format!("(pin Round[A]Pad_600_um {name} {x} {})", -y));
        members.push(format!("U1-{name}"));
    }
    let model = format!(
        "(pcb fixture (resolution um 10) (unit um)
          (structure (layer F.Cu (type signal)) (layer B.Cu (type power)))
          (placement (component EP (place U1 100000 -100000 front 180)))
          (library (image EP {pins}) (padstack Round[A]Pad_600_um (shape (circle F.Cu 600))))
          (network (net GND (pins {})) (net /LED_A (pins D1-1 R1-1))))",
        members.join(" ")
    );
    (pads(&board(vec![footprint("U1", [100 * MM, 100 * MM], 180, native)])), model)
}

#[test]
fn a_repeated_number_counts_an_npth_pad_in_native_order() {
    let plated = |x| pth("9", "GND", [x, 100 * MM], 0, "Circle", [2_000_000; 2], [1_000_000; 2]);
    let mut hole = pth("9", "", [105 * MM, 100 * MM], 0, "Circle", [3_000_000; 2], [3_000_000; 2]);
    hole["kind"] = "NpThroughHole".into();
    let native = board(vec![footprint("U1", [100 * MM, 100 * MM], 0, vec![plated(100 * MM), hole, plated(110 * MM)])]);
    let rows = native_pth_pads(&read(&native)).unwrap();
    let aliases: Vec<_> = rows.iter().map(|p| p["export_pin"].as_str().unwrap()).collect();
    assert_eq!(aliases, ["9", "9@2"]);
}

#[test]
fn repeated_physical_drills_bind_actual_export_aliases_not_one_pad_number() {
    let (pads, model) = repeated_drills();
    assert_eq!(pads.len(), 6);
    assert_eq!(pads.iter().map(|p| p["identity"].as_str()).collect::<BTreeSet<_>>().len(), 6);
    let aliases: Vec<_> = pads.iter().map(|p| p["export_pin"].as_str().unwrap()).collect();
    assert_eq!(aliases, ["9", "9@1", "9@2", "9@4", "9@5", "9@6"]);
    let proof = covered(check(&model, &pads, "0.2"));
    let rows = proof["covered_pads"].as_array().unwrap();
    assert_eq!(rows.len(), 6);
    assert_eq!(rows.iter().map(|p| p["dsn_pin"].as_str()).collect::<BTreeSet<_>>().len(), 6);
    for (from, to) in [("U1-9@5", "U1-MISSING"), ("9@5 1300 650", "9@5 1301 650"), ("9@5 1300 650", "9@5 -1300 650")] {
        assert!(model.contains(from), "{from}");
        blocked(check(&model.replace(from, to), &pads, "0.2"));
    }
    for key in ["identity", "export_pin"] {
        let mut forged = pads.clone();
        forged[1][key] = forged[0][key].clone();
        blocked(check(&model, &forged, "0.2"));
    }
    blocked(check(&model, &strip_physical(&pads), "0.2"));
}

#[test]
fn true_rectangle_uses_composed_rotation_and_the_exact_inscribed_disk() {
    let mut turned = native();
    turned["footprints"][0]["orientation"] = 90.into();
    turned["footprints"][0]["pads"][0] = pth("1", "/POWER", [100 * MM, 101_750_000], 180, "Rect", [3 * MM, 2 * MM], [1_399_997; 2]);
    let mut pad = pads(&turned)[..1].to_vec();
    assert_eq!(pad[0]["position_mm"], json!(["100", "101.75"]));
    let model = dsn()
        .replacen("front 0", "front 90", 1)
        .replace("(pin Round[A]Pad_2100.000000_um 1 -1750 0)", "(pin Round[A]Pad_2100.000000_um (rotate 90) 1 -1750 0)")
        .replace("(circle F.Cu 2100)", "(rect F.Cu -1500 -1000 1500 1000)");
    let proof = covered(check(&model, &pad, "0.2"));
    assert_eq!(proof["covered_pads"][0]["dsn_rotation_deg"], 180);
    blocked(check(&model.replace("(rotate 90)", "(rotate 0)"), &pad, "0.2"));
    blocked(check(&model.replace("-1500 -1000 1500 1000", "-1499 -1000 1500 1000"), &pad, "0.2"));
    pad[0]["size_mm"] = json!(["1.6", "2"]);
    pad[0]["drill_mm"] = json!(["1.2", "1.2"]);
    let model = model.replace("-1500 -1000 1500 1000", "-800 -1000 800 1000");
    covered(check(&model, &pad, "0.08"));
    blocked(check(&model, &pad, "0.079999999999"));
}

#[test]
fn a_chamfered_rectangle_is_refused_by_the_collector() {
    // The API gives a chamfered pad as shape Other, with no copper.
    let mut chamfered = native();
    let pad = &mut chamfered["footprints"][0]["pads"][0];
    pad["shape"] = "Other".into();
    pad["copper"] = json!([]);
    assert!(native_pth_pads(&read(&chamfered)).is_err());
}

#[test]
fn empty_missing_same_net_and_invalid_clearance_are_not_proofs() {
    let pads = pads(&native());
    blocked(check(&dsn(), &[], "0.2"));
    let mut missing = json!({"dsn_text": dsn(), "pads": null, "active_nets": ["/LED_A"], "layers": ["F.Cu"],
        "required_mm": "0.28", "clearance_floor_mm": "0.2"});
    assert!(serde_json::from_value::<PthRequest>(missing.clone()).is_err());
    missing.as_object_mut().unwrap().remove("pads");
    assert!(serde_json::from_value::<PthRequest>(missing).is_err());
    let mut same_net = request(&dsn(), &pads, "0.2");
    same_net.scope.active_nets = vec!["/POWER".into()];
    blocked(hole::inspect(&same_net));
    for value in [json!("nan"), json!("Infinity"), json!("-0.001"), json!(true)] {
        let mut r = request(&dsn(), &pads, "0.2");
        r.scope.required_mm = value.clone();
        blocked(hole::inspect(&r));
        let mut r = request(&dsn(), &pads, "0.2");
        r.scope.clearance_floor_mm = value;
        blocked(hole::inspect(&r));
    }
}

#[test]
fn slots_offsets_custom_mirrored_and_unknown_pth_fail_instead_of_disappearing() {
    let cases: [fn(&mut Value); 6] = [
        |b| b["footprints"][0]["pads"][0]["drill"]["y"] = 1_800_000.into(),
        // A drill offset and a pad offset are one API field: the effective copper leaves the pad position.
        |b| b["footprints"][0]["pads"][0]["copper"][0]["Circle"]["center"]["x"] = 98_350_000.into(),
        |b| b["footprints"][0]["pads"][0]["shape"] = "Oval".into(),
        |b| b["footprints"][0]["layer"] = "B.Cu".into(),
        |b| b["footprints"][0]["orientation"] = 45.into(),
        |b| b["footprints"][0]["pads"][0]["kind"] = "UnknownHole".into(),
    ];
    for (index, change) in cases.into_iter().enumerate() {
        let mut board = native();
        change(&mut board);
        assert!(native_pth_pads(&read(&board)).is_err(), "case {index}");
    }
}

#[test]
fn physical_ids_and_numbered_aliases_cannot_hide_conflicting_native_membership() {
    let mut conflict = native();
    let mut duplicate = pth("1", "/WRONG", [101_750_000, 100 * MM], 0, "Circle", [2_100_000; 2], [1_399_997; 2]);
    duplicate["id"] = "other".into();
    conflict["footprints"][0]["pads"].as_array_mut().unwrap().push(duplicate);
    assert!(native_pth_pads(&read(&conflict)).is_err());
    let pads = pads(&native());
    let mut forged = pads.clone();
    forged[0]["rotation_deg"] = "45".into();
    blocked(check(&dsn(), &forged, "0.2"));
    let mut forged = pads.clone();
    forged[0]["layers"].as_array_mut().unwrap().push("Unknown.Cu".into());
    blocked(check(&dsn(), &forged, "0.2"));
    let mut forged = pads;
    forged[0]["export_pin"] = "1@0".into();
    blocked(check(&dsn(), &forged, "0.2"));
}

#[test]
fn legacy_unique_circular_rows_remain_usable_without_physical_aliases() {
    let proof = covered(check(&dsn(), &strip_physical(&pads(&native())), "0"));
    assert_eq!(proof["covered_pads"].as_array().unwrap().len(), 2);
}

#[test]
fn model_identity_pose_mirror_membership_and_duplicates_fail_closed() {
    let pads = pads(&native());
    let model = dsn();
    let pin = "(pin Round[A]Pad_2100.000000_um 1 -1750 0)";
    let duplicate_pin = format!("{pin} (pin Round[A]Pad_2100.000000_um 1 0 0)");
    for changed in [
        model.replacen("(place J1", "(place J9", 1),
        model.replacen("J1 100000", "J1 100001", 1),
        model.replacen("front 0", "front 90", 1),
        model.replacen("front 0", "back 0", 1),
        model.replace("(pins J1-1 J2-1)", "(pins J2-1)"),
        model.replace("(net /LED_A (pins R2-2 D3-1))", "(net /LED_A (pins R2-2 D3-1 J1-1))"),
        model.replace(pin, &duplicate_pin),
        model.replacen("(place J1 100000", "(place J1 100000 -100000 front 0) (place J1 100000", 1),
    ] {
        assert_ne!(changed, model);
        blocked(check(&changed, &pads, "0.2"));
    }
}

#[test]
fn only_a_declared_single_layer_circle_with_exact_units_can_cover() {
    let pads = pads(&native());
    let model = dsn();
    let shape = "(shape (circle F.Cu 2100))";
    for changed in [
        model.replace("(unit um)", "(unit cm)"),
        model.replace("(unit um)", "(unit um) (unit mm)"),
        model.replace("(type power)", "(type signal)"),
        model.replace("(circle F.Cu 2100)", "(circle B.Cu 2100)"),
        model.replace("(circle F.Cu 2100)", "(rect F.Cu -1050 -1050 1050 1050)"),
        model.replace("(circle F.Cu 2100)", "(circle F.Cu 2100 1 0)"),
        model.replace(shape, &format!("{shape} {shape}")),
        model.replace("(circle F.Cu 2100)", "(circle F.Cu nan)"),
        model[..model.len() - 1].to_string(),
    ] {
        assert_ne!(changed, model);
        blocked(check(&changed, &pads, "0.2"));
    }
    let mut both = request(&model, &pads, "0.2");
    both.scope.layers = vec!["F.Cu".into(), "B.Cu".into()];
    blocked(hole::inspect(&both));
}

#[test]
fn importer_resolution_units_cannot_disagree_with_the_geometry_interpretation() {
    // The backend reads its unit from resolution, ignoring the unit declaration: contradictory scopes must never cover.
    let pads = pads(&native());
    for resolution in [
        "(resolution mm 10)",
        "(resolution unknown 10)",
        "",
        "(resolution um 10) (resolution um 10)",
        "(resolution um 0)",
        "(resolution um -1)",
        "(resolution um 1.5)",
        "(resolution um 2147483648)",
    ] {
        blocked(check(&dsn().replace("(resolution um 10)", resolution), &pads, "0.2"));
    }
}

#[test]
fn importer_name_aliases_cannot_hide_different_actual_pad_geometry() {
    let pads = pads(&native());
    let model = dsn();
    for changed in [
        model.replace("(attach off)))", "(attach off)) (padstack Round[A]Pad_2100.123_um (shape (circle F.Cu 100))))"),
        model.replace("(library (image \"TERM\"", "(library (image \"TERM::1\" (pin Round[A]Pad_2100.000000_um 1 0 0)) (image \"TERM\""),
        model.replacen("(library ", "(library (padstack round[a]pad_2100.000000_um (shape (circle F.Cu 100))) ", 1),
    ] {
        assert_ne!(changed, model);
        blocked(check(&changed, &pads, "0.2"));
    }
}
