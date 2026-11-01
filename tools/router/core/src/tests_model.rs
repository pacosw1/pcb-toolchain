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
