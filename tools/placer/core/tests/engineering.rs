use iotplace::engineering::pin_distance_rules;
use serde_json::json;

fn contract() -> serde_json::Value {
    json!({"where": {"U1": 0, "C1": 1}, "geometry": {"refs": {
      "U1": {"pads": {"1": [{"center": [11.0, 10.0]}]}},
      "C1": {"pads": {"1": [{"center": [14.0, 10.0]}]}}
    }}, "rules": [{"id": "pin", "kind": "pin_distance", "metric": "pad_center_euclidean",
      "a": {"ref":"U1", "pad":"1"}, "b": {"ref":"C1", "pad":"1"}, "max_mm":3.0}]})
}
#[test]
fn pin_distance_tracks_both_unit_poses_and_rotation() {
    let rules = pin_distance_rules(&contract(), &[(10.0, 10.0), (14.0, 10.0)]).unwrap();
    let r = &rules[0];
    assert!(r.affects(0) && r.affects(1) && !r.affects(2));
    assert_eq!(
        r.miss(&vec![(10.0, 10.0, 0), (14.0, 10.0, 0)]).unwrap(),
        0.0
    );
    assert_eq!(
        r.miss(&vec![(10.0, 10.0, 0), (15.0, 10.0, 0)]).unwrap(),
        1.0
    );
    let miss = r.miss(&vec![(10.0, 10.0, 1), (14.0, 10.0, 0)]).unwrap();
    assert!((miss - (17.0_f64.sqrt() - 3.0)).abs() < 1e-12);
}
#[test]
fn malformed_or_unsupported_rules_fail_closed() {
    let origins = [(10.0, 10.0), (14.0, 10.0)];
    let mut bad = contract();
    bad["rules"][0]["kind"] = json!("clearance");
    assert!(pin_distance_rules(&bad, &origins).is_err());
    let mut bad = contract();
    bad["geometry"]["refs"]["U1"]["pads"]["1"] = json!([]);
    assert!(pin_distance_rules(&bad, &origins).is_err());
    let mut bad = contract();
    bad["rules"][0]["min_mm"] = json!(4.0);
    assert!(pin_distance_rules(&bad, &origins).is_err());
    let mut numeric = contract();
    numeric["rules"][0]["a"]["pad"] = json!(1);
    assert!(pin_distance_rules(&numeric, &origins).is_ok());
}

#[test]
fn copper_clearance_tracks_rotated_pad_edges_and_rejects_unknown_geometry() {
    use iotplace::engineering::clearance_rules;
    let mut input = contract();
    input["rules"][0]["kind"] = json!("clearance");
    input["rules"][0]["metric"] = json!("copper_edge_2d");
    input["rules"][0].as_object_mut().unwrap().remove("max_mm");
    input["rules"][0]["min_mm"] = json!(2.0);
    for r in ["U1", "C1"] {
        let pad = &mut input["geometry"]["refs"][r]["pads"]["1"][0];
        pad["size"] = json!([1.0, 1.0]);
        pad["shape"] = json!("rect");
        pad["axis_aligned"] = json!(true);
        pad["kind"] = json!("smd");
        pad["layers"] = json!(["F.Cu"]);
    }
    let rules = clearance_rules(&input, &[(10.0, 10.0), (14.0, 10.0)]).unwrap();
    assert_eq!(
        rules[0]
            .miss(&vec![(10.0, 10.0, 0), (14.0, 10.0, 0)])
            .unwrap(),
        0.0
    );
    assert_eq!(
        rules[0]
            .miss(&vec![(10.0, 10.0, 0), (13.0, 10.0, 0)])
            .unwrap(),
        1.0
    );
    input["geometry"]["refs"]["C1"]["pads"]["1"][0]["shape"] = json!("oval");
    assert!(clearance_rules(&input, &[(10.0, 10.0), (14.0, 10.0)]).is_err());
}
