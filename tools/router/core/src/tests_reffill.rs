//! Unit checks of the reference-plane fill edge (model `ref_fill`, reffill.rs; cargo test --release). Each test fails
//! on the code before this rule: there a track of a checked net over a void of its reference plane is free.
use super::*;

/// 30 x 20 mm, F.Cu / In1.Cu (plane) / B.Cu, F.Cu references In1.Cu. The GND fill on In1.Cu covers (1, 1)-(29, 19)
/// less a screw-hole void (10, 8)-(14, 12). SIG and SIG2 are checked nets of domain GND, OTH is checked with no
/// domain. A SIG pad (1.0 x 1.0) at (14.5, 10): its anchor disc (0.5 + via_allow 0.6) reaches into the void.
fn model(with_fill: bool) -> Value {
    let mut m = serde_json::json!({
        "copper_layers": ["F.Cu", "In1.Cu", "B.Cu"], "plane_layers": ["In1.Cu"], "adjacent": {"F.Cu": "In1.Cu"},
        "outline_bbox": [0.0, 0.0, 30.0, 20.0], "setup": {"edge_clearance": 0.3},
        "classes": {"Default": {"width": 0.15, "clearance": 0.15, "via": 0.6, "drill": 0.3}},
        "nets": {"SIG": {"class": "Default", "layers": ["F.Cu", "B.Cu"], "plane_ref": true, "ref_domain": "GND"},
                 "SIG2": {"class": "Default", "layers": ["F.Cu", "B.Cu"], "plane_ref": true, "ref_domain": "GND"},
                 "OTH": {"class": "Default", "layers": ["F.Cu", "B.Cu"], "plane_ref": true},
                 "GND": {"class": "Default", "layers": ["F.Cu", "B.Cu"], "plane": true}},
        "pads": [{"ref": "U1", "num": "1", "net": "SIG", "x": 14.5, "y": 10.0, "bbox": [14.0, 9.5, 15.0, 10.5],
                  "layers": ["F.Cu"], "drill": 0.0}],
        "copper": []
    });
    if with_fill {
        m["ref_fill"] = serde_json::json!({"via_allow": 0.6, "anchors": [[14.5, 10.0, 0.5, "SIG"]],
            "layers": {"F.Cu": {"plane": "In1.Cu", "domains": {"GND": [[
                [[1.0, 1.0], [29.0, 1.0], [29.0, 19.0], [1.0, 19.0]],
                [[10.0, 8.0], [10.0, 12.0], [14.0, 12.0], [14.0, 8.0]]]]}}}});
    }
    m
}

fn id(bd: &Board, n: &str) -> usize {
    bd.nets.iter().position(|q| q.name == n).unwrap()
}

#[test]
fn track_keeps_on_the_filled_reference() {
    let bd = load(&model(true), 0.28);
    let (sig, sig2, oth) = (id(&bd, "SIG"), id(&bd, "SIG2"), id(&bd, "OTH"));
    let cost = |net: usize, l: usize, x: f64| bd.track_cost(net, l, x, 10.0, 0.075, 0.25, None);
    assert!(cost(sig, 0, 12.0) < 0, "SIG over the void on F.Cu: blocked");
    assert!(cost(sig, 0, 5.0) >= 0, "SIG over the fill: free");
    assert!(cost(sig, 2, 12.0) >= 0, "B.Cu has no adjacent plane in the spec: free");
    assert!(cost(oth, 0, 12.0) >= 0, "a net with no domain: free");
    assert!(cost(sig, 0, 13.6) >= 0, "SIG inside its own pad anchor disc: free");
    assert!(cost(sig2, 0, 13.6) < 0, "SIG2 at the SIG anchor: blocked");
    // the routing margin (EPS) from the fill edge; the audit (eps 0) is the gate's margin 0
    assert!(cost(sig, 0, 9.999) < 0, "0.001 mm from the edge: inside EPS");
    assert!(cost(sig, 0, 9.99) >= 0);
    let mut audit = load(&model(true), 0.28);
    audit.eps = 0.0;
    assert!(audit.track_cost(sig, 0, 9.999, 10.0, 0.075, 0.25, None) >= 0, "audit: margin 0");
    // before this rule (no ref_fill in the model): free over the void
    let old = load(&model(false), 0.28);
    assert!(old.track_cost(sig, 0, 12.0, 10.0, 0.075, 0.25, None) >= 0);
}

#[test]
fn bucket_classes_agree_with_the_exact_test() {
    let bd = load(&model(true), 0.28);
    let d = bd.rfill.dom[id(&bd, "SIG")];
    assert_eq!(d, 1);
    // every 0.0371 mm over the board (off the bucket lattice): the fast path gives the even-odd answer
    let exact = |x: f64, y: f64| (1.0..=29.0).contains(&x) && (1.0..=19.0).contains(&y) && !((10.0..=14.0).contains(&x) && (8.0..=12.0).contains(&y));
    let mut n = 0;
    let mut x: f64 = 0.013;
    while x < 30.0 {
        let mut y: f64 = 0.007;
        while y < 20.0 {
            let near_edge = [1.0f64, 29.0, 10.0, 14.0].iter().any(|e| (x - e).abs() < 1e-6) || [1.0f64, 19.0, 8.0, 12.0].iter().any(|e| (y - e).abs() < 1e-6);
            if !near_edge && (x - 14.5).hypot(y - 10.0) > 1.1 {
                assert_eq!(bd.rfill.code(0, d, x, y, 0.0) == FREE, exact(x, y), "{x} {y}");
                n += 1;
            }
            y += 0.0371;
        }
        x += 0.0371;
    }
    assert!(n > 400_000);
}
