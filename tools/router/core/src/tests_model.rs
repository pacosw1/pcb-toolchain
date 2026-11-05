//! Unit checks of the model-driven rules (cargo test --release).
use super::*;

/// One PTH pad (hole 0.6 mm) of net A at (10, 10) on a 2-layer board, a probe track of net B beside it. The model's
/// hole_rules value must decide whether the probe is blocked.
fn model(hole_clr: f64, hth: f64, plane: f64) -> Value {
    serde_json::json!({
        "copper_layers": ["F.Cu", "B.Cu"], "plane_layers": [], "outline_bbox": [0.0, 0.0, 30.0, 30.0],
        "setup": {"edge_clearance": 0.5},
        "classes": {"Default": {"width": 0.15, "clearance": 0.15, "via": 0.6, "drill": 0.3}},
        "nets": {"A": {"class": "Default", "width": 0.15, "clearance": 0.15, "layers": ["F.Cu", "B.Cu"]},
                 "B": {"class": "Default", "width": 0.15, "clearance": 0.15, "layers": ["F.Cu", "B.Cu"]}},
        "pads": [{"ref": "J1", "num": "1", "net": "A", "x": 10.0, "y": 10.0, "bbox": [9.5, 9.5, 10.5, 10.5],
                  "layers": ["F.Cu", "B.Cu"], "drill": 0.6}],
        "copper": [],
        "hole_rules": {"hole_clearance": [{"rule": "r", "min": hole_clr, "scope": "either_th"}],
                       "hole_to_hole": [{"rule": "r", "min": hth, "scope": "both_th"}],
                       "plane_clearance": {"min": plane}, "board_min": {"hole_clearance": 0.0, "hole_to_hole": 0.0}}
    })
}

fn blocked_at(m: &Value, x: f64) -> bool {
    let (hc, _, _) = hole_rules(m);
    let bd = load(m, hc.unwrap());
    let b = bd.nets.iter().position(|n| n.name == "B").unwrap();
    bd.track_cost(b, 0, x, 10.0, 0.075, 0.25, None) < 0
}

#[test]
fn model_hole_rules_are_read() {
    let (h, t, p) = hole_rules(&model(0.28, 0.45, 0.25));
    assert_eq!((h, t, p), (Some(0.28), Some(0.45), Some(0.25)));
    assert_eq!(hole_rules(&serde_json::json!({})), (None, None, None));
}

#[test]
fn hole_clearance_value_changes_behaviour() {
    // pad copper edge at x = 10.5, hole edge at x = 10.3. A track of half width 0.075 at x = 10.8 keeps 0.225 to the
    // pad copper (clearance 0.15: free) and 0.425 to the hole edge.
    assert!(!blocked_at(&model(0.28, 0.45, 0.25), 10.8), "hole rule 0.28 must not block at 10.8");
    // a hole rule of 0.8 needs 0.8 + 0.075 from the hole edge: x >= 11.175
    assert!(blocked_at(&model(0.8, 0.45, 0.25), 10.8), "hole rule 0.8 must block at 10.8");
    assert!(!blocked_at(&model(0.8, 0.45, 0.25), 11.3), "hole rule 0.8 must free x = 11.3");
}

/// M2 (H7-CORE): the model's return_rule decides whether a GND through-hole pad is an RP-001 return (the gate with
/// return_planes counts it; kicad-happy alone does not), and a pad with via_in_pad is on the viapads allow list.
#[test]
fn return_rule_and_via_in_pad_are_read() {
    let with = |pads: Option<bool>| {
        let mut m = model(0.28, 0.45, 0.25);
        m["nets"]["GND"] = serde_json::json!({"class": "Default", "plane": true, "layers": ["F.Cu", "B.Cu"]});
        m["pads"].as_array_mut().unwrap().push(serde_json::json!({"ref": "J1", "num": "2", "net": "GND", "x": 20.0, "y": 10.0,
            "bbox": [19.5, 9.5, 20.5, 10.5], "layers": ["F.Cu", "B.Cu"], "drill": 0.6}));
        m["pads"].as_array_mut().unwrap().push(serde_json::json!({"ref": "U1", "num": "9", "net": "GND", "x": 20.0, "y": 20.0,
            "bbox": [19.0, 19.0, 21.0, 21.0], "layers": ["F.Cu"], "drill": 0.0, "via_in_pad": true}));
        if let Some(p) = pads {
            m["return_rule"] = serde_json::json!({"radius": 1.0, "pads": p});
        }
        load(&m, 0.28)
    };
    assert_eq!(with(Some(false)).gnd_fixed.len(), 0, "kicad-happy alone: a GND through-hole pad is no return");
    assert_eq!(with(Some(true)).gnd_fixed, vec![(20.0, 10.0)], "gate return_planes: it is one");
    assert_eq!(with(None).gnd_fixed.len(), 1, "no rule in the model: as before (counts)");
    assert_eq!(with(None).vip, vec![(19.0, 19.0, 21.0, 21.0)]);
    assert!(with(None).tvia.is_empty(), "no thermal_vias key: no array");
}

/// model pad thermal_vias (src/model/thermal.rs) -> Board::tvia: the via centres, diameter and drill as written.
#[test]
fn thermal_vias_are_read() {
    let mut m = model(0.28, 0.45, 0.25);
    m["nets"]["GND"] = serde_json::json!({"class": "Default", "plane": true, "layers": ["F.Cu", "B.Cu"]});
    m["pads"].as_array_mut().unwrap().push(serde_json::json!({"ref": "U4", "num": "9", "net": "GND", "x": 20.0, "y": 20.0,
        "bbox": [18.75, 18.4, 21.25, 21.6], "layers": ["F.Cu"], "drill": 0.0, "via_in_pad": true,
        "thermal_vias": {"vias": [[19.45, 19.365], [20.55, 19.365], [19.45, 20.635], [20.55, 20.635]], "d": 0.6, "drill": 0.3,
                         "long": 2, "short": 2, "pitch": [1.27, 1.1], "source": "test"}}));
    let bd = load(&m, 0.28);
    assert_eq!(bd.tvia.len(), 1);
    let (bb, pts, d, dr, name) = &bd.tvia[0];
    assert_eq!(*bb, (18.75, 18.4, 21.25, 21.6));
    assert_eq!(pts, &vec![(19.45, 19.365), (20.55, 19.365), (19.45, 20.635), (20.55, 20.635)]);
    assert_eq!((*d, *dr, name.as_str()), (0.6, 0.3, "U4.9"));
}

#[test]
fn a_stage_neck_is_a_retry_width_of_any_wide_net() {
    let mut m = model(0.28, 0.45, 0.25);
    m["nets"]["A"]["width"] = serde_json::json!(2.0);
    let widths = |m: &Value| net_widths(load(m, 0.28).nets.iter().find(|n| n.name == "A").unwrap());
    assert_eq!(widths(&m), [2.0], "a signal net has one width until a stage names a neck");
    m["nets"]["A"]["min_width"] = serde_json::json!(1.0);
    m["nets"]["A"]["neck_width"] = serde_json::json!(1.0);
    assert_eq!(widths(&m), [2.0, 1.0], "the neck is tried, and nothing narrower");
}
