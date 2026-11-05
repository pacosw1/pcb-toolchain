use iotplace::engineering::pin_distance_rules;
use serde_json::{json, Value};

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

#[test]
fn fixed_and_rigid_groups_follow_reviewed_unit_mapping() {
    use iotplace::engineering::rigid_rules;
    let mut input = contract();
    input["geometry"]["refs"]["U1"]["origin"] = json!([10.0, 10.0]);
    input["geometry"]["refs"]["C1"]["origin"] = json!([14.0, 10.0]);
    input["rules"] = json!([{"id":"group","kind":"rigid_group","refs":["U1","C1"]}]);
    assert!(rigid_rules(&input, &[(10.0, 10.0), (14.0, 10.0)]).is_err());
    input["where"]["C1"] = json!(0);
    let rules = rigid_rules(&input, &[(10.0, 10.0)]).unwrap();
    assert_eq!(rules[0].miss(&vec![(11.0, 10.0, 0)]).unwrap(), 0.0);
    input["rules"][0]["retained_internal_copper"] = json!(true);
    let rules = rigid_rules(&input, &[(10.0, 10.0)]).unwrap();
    assert_eq!(rules[0].miss(&vec![(11.0, 10.0, 0)]).unwrap(), 1.0);
}

#[test]
fn mixed_reviewed_rules_compile_and_unknown_rules_fail_closed() {
    use iotplace::engineering::compile_supported_rules;
    let mut input = contract();
    input["geometry"]["refs"]["U1"]["origin"] = json!([10.0, 10.0]);
    input["rules"]
        .as_array_mut()
        .unwrap()
        .push(json!({"id":"fixed", "kind":"fixed", "refs":["U1"]}));
    let rules = compile_supported_rules(&input, &[(10.0, 10.0), (14.0, 10.0)]).unwrap();
    assert_eq!(rules.len(), 2);
    assert_eq!(
        rules[1]
            .miss(&vec![(11.0, 10.0, 0), (14.0, 10.0, 0)])
            .unwrap(),
        1.0
    );
    input["rules"]
        .as_array_mut()
        .unwrap()
        .push(json!({"id":"escape", "kind":"escape"}));
    assert!(compile_supported_rules(&input, &[(10.0, 10.0), (14.0, 10.0)]).is_err());
}

#[test]
fn direct_library_model_cannot_bypass_reviewed_contract_rejection() {
    use iotplace::{model::Model, params::Params, problem::Problem};
    let path =
        std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/golden/synthetic.json");
    let mut raw: serde_json::Value = serde_json::from_slice(&std::fs::read(path).unwrap()).unwrap();
    raw["engineering"] = contract();
    let problem: Problem = serde_json::from_value(raw).unwrap();
    assert!(Model::new(&problem, &Params::default()).is_err());
}

#[test]
fn connector_corridor_checks_board_exit_and_other_courtyards() {
    use iotplace::engineering::connector_rules;
    let mut input = contract();
    input["geometry"]["bounds"] = json!([0.0, 0.0, 20.0, 20.0]);
    input["geometry"]["refs"]["U1"]["origin"] = json!([1.0, 3.0]);
    input["geometry"]["refs"]["U1"]["quarter"] = json!(0.0);
    input["geometry"]["refs"]["U1"]["courtyard"] = json!([0.5, 2.5, 1.5, 3.5]);
    input["geometry"]["refs"]["C1"]["origin"] = json!([14.0, 10.0]);
    input["geometry"]["refs"]["C1"]["quarter"] = json!(0.0);
    input["geometry"]["refs"]["C1"]["courtyard"] = json!([13.5, 9.5, 14.5, 10.5]);
    input["rules"] = json!([{"id":"connector","kind":"connector_access", "ref":"U1", "metric":"courtyard_corridor_2d", "corridor_mm":[-4.0,-0.6,0.0,0.6], "exit_side":"L"}]);
    let rules = connector_rules(&input, &[(1.0, 3.0), (14.0, 10.0)]).unwrap();
    assert_eq!(
        rules[0]
            .miss(&vec![(1.0, 3.0, 0), (14.0, 10.0, 0)])
            .unwrap(),
        0.0
    );
    assert_eq!(
        rules[0].miss(&vec![(1.0, 3.0, 0), (0.0, 3.0, 0)]).unwrap(),
        1.0
    );
    assert_eq!(
        rules[0]
            .miss(&vec![(5.0, 3.0, 0), (14.0, 10.0, 0)])
            .unwrap(),
        1.0
    );
    input["geometry"]["refs"]["C1"]["courtyard"] = serde_json::Value::Null;
    assert!(connector_rules(&input, &[(1.0, 3.0), (14.0, 10.0)]).is_err());
}

#[test]
fn native_locked_parts_cannot_move_without_a_manifest_rule() {
    use iotplace::engineering::native_locks;
    let mut input = contract();
    input["geometry"]["refs"]["U1"]["origin"] = json!([10.0, 10.0]);
    input["geometry"]["refs"]["U1"]["locked"] = json!(true);
    let locks = native_locks(&input, &[(10.0, 10.0), (14.0, 10.0)]).unwrap();
    assert_eq!(locks.len(), 1);
    assert_eq!(
        locks[0]
            .miss(&vec![(10.0, 10.0, 0), (14.0, 10.0, 0)])
            .unwrap(),
        0.0
    );
    assert_eq!(
        locks[0]
            .miss(&vec![(10.1, 10.0, 0), (14.0, 10.0, 0)])
            .unwrap(),
        1.0
    );
    assert_eq!(
        locks[0]
            .miss(&vec![(10.0, 10.0, 1), (14.0, 10.0, 0)])
            .unwrap(),
        1.0
    );
}

#[test]
fn unit_misses_recompute_cross_unit_dependents_and_verify_mapping() {
    use iotplace::engineering::ReviewedGeometry;
    let input = contract();
    let refs = vec![vec!["U1".into()], vec!["C1".into()]];
    let geometry = ReviewedGeometry::compile(&input, &refs, &[(10.0, 10.0), (14.0, 10.0)]).unwrap();
    assert_eq!(
        geometry
            .all_unit_misses(&vec![(10.0, 10.0, 0), (15.0, 10.0, 0)])
            .unwrap(),
        vec![1.0, 1.0]
    );
    let reversed = vec![vec!["C1".into()], vec!["U1".into()]];
    assert!(ReviewedGeometry::compile(&input, &reversed, &[(10.0, 10.0), (14.0, 10.0)]).is_err());
    let mut extra = input.clone();
    extra["geometry"]["refs"]["UNMAPPED"] = json!({"pads": {}});
    assert!(ReviewedGeometry::compile(&extra, &refs, &[(10.0, 10.0), (14.0, 10.0)]).is_err());
}

#[test]
fn final_screen_checks_unreferenced_native_locks() {
    use iotplace::engineering::ReviewedGeometry;
    let mut input = contract();
    input["rules"] = json!([]);
    input["geometry"]["refs"]["U1"]["origin"] = json!([10.0, 10.0]);
    input["geometry"]["refs"]["U1"]["locked"] = json!(true);
    let refs = vec![vec!["U1".into()], vec!["C1".into()]];
    let geometry = ReviewedGeometry::compile(&input, &refs, &[(10.0, 10.0), (14.0, 10.0)]).unwrap();
    let pose = vec![(10.1, 10.0, 0), (14.0, 10.0, 0)];
    assert_eq!(geometry.miss_for_unit(0, &pose).unwrap(), 0.0);
    assert_eq!(geometry.native_lock_miss_for_unit(0, &pose).unwrap(), 1.0);
    assert_eq!(geometry.native_lock_miss_for_unit(1, &pose).unwrap(), 0.0);
}

#[test]
fn digest_alone_cannot_admit_reviewed_models() {
    use sha2::{Digest, Sha256};
    use std::process::Command;
    let dir = std::env::temp_dir().join(format!("iotplace-reviewed-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let input = dir.join("input.json");
    let output = dir.join("output.json");
    let problem = json!({
        "units": [
            {"name":"U1","refs":["U1"],"fixed":false,"x":10,"y":10,"rects":[[-0.2,-0.2,0.2,0.2,1]]},
            {"name":"C1","refs":["C1"],"fixed":false,"x":14,"y":10,"rects":[[-0.2,-0.2,0.2,0.2,1]]}
        ], "nets":[], "board":{"outline":[[0,0],[30,0],[30,30],[0,30]]}, "engineering":contract()
    });
    let run = |digest: Option<&str>| {
        let mut cmd = Command::new(env!("CARGO_BIN_EXE_iotplace"));
        cmd.arg("run").arg(&input).arg("-o").arg(&output).args(["--workers","1","--epochs","1","--steps","1","--top","1"]);
        if let Some(d) = digest { cmd.args(["--engineering-frozen-model-sha256",d]); }
        cmd.output().unwrap()
    };
    let bytes = serde_json::to_vec(&problem).unwrap();
    std::fs::write(&input, &bytes).unwrap();
    let digest = format!("{:x}", Sha256::digest(&bytes));
    assert!(!run(None).status.success());
    assert!(!run(Some(&"0".repeat(64))).status.success());
    assert!(!run(Some(&digest)).status.success());
    let mut fixed = problem.clone();
    fixed["engineering"]["geometry"]["refs"]["U1"]["origin"] = json!([10.0,10.0]);
    fixed["engineering"]["rules"] = json!([{"id":"fixed","kind":"fixed","refs":["U1"]}]);
    let bytes = serde_json::to_vec(&fixed).unwrap();
    std::fs::write(&input, &bytes).unwrap();
    let fixed_digest = format!("{:x}", Sha256::digest(&bytes));
    assert!(!run(Some(&fixed_digest)).status.success());
    let mut bad = problem;
    bad["engineering"]["rules"][0]["kind"] = json!("escape");
    let bytes = serde_json::to_vec(&bad).unwrap();
    std::fs::write(&input, &bytes).unwrap();
    let digest = format!("{:x}", Sha256::digest(&bytes));
    assert!(!run(Some(&digest)).status.success());
    std::fs::remove_dir_all(dir).unwrap();
}


#[test]
fn final_pose_screen_evaluates_each_rule_and_every_native_lock() {
    use iotplace::engineering::ReviewedGeometry;
    let mut input = contract();
    input["geometry"]["refs"]["U1"]["origin"] = json!([10.0,10.0]);
    input["geometry"]["refs"]["U1"]["locked"] = json!(true);
    let refs=vec![vec!["U1".into()],vec!["C1".into()]];
    let geometry=ReviewedGeometry::compile(&input,&refs,&[(10.0,10.0),(14.0,10.0)]).unwrap();
    assert!(geometry.check_pose(&vec![(10.0,10.0,0),(14.0,10.0,0)]).unwrap().is_empty());
    let blockers=geometry.check_pose(&vec![(10.1,10.0,0),(15.0,10.0,0)]).unwrap();
    assert_eq!(blockers.len(),2);
    assert_eq!(blockers[0].id,"pin");
    assert_eq!(blockers[1].id,"native-lock:U1");
    assert!(geometry.check_pose(&vec![(f64::NAN,10.0,0),(14.0,10.0,0)]).is_err());
}

#[test]
fn candidate_geometry_cli_never_implies_source_authority() {
    use std::process::Command;
    let root=std::env::temp_dir().join(format!("iotplace-geometry-{}",std::process::id()));
    std::fs::create_dir_all(&root).unwrap();
    let model=root.join("model.json"); let pose=root.join("pose.json");
    let problem=json!({"units":[{"refs":["U1"],"x":10,"y":10},{"refs":["C1"],"x":14,"y":10}],"engineering":contract()});
    std::fs::write(&model,serde_json::to_vec(&problem).unwrap()).unwrap();
    let run=|p:Value| {
        std::fs::write(&pose,serde_json::to_vec(&p).unwrap()).unwrap();
        let out=Command::new(env!("CARGO_BIN_EXE_iotplace")).arg("review-geometry").arg(&model).arg("--pose").arg(&pose).output().unwrap();
        assert_eq!(out.status.code(),Some(3));serde_json::from_slice::<Value>(&out.stdout).unwrap()
    };
    let good=run(json!([[10,10,0],[14,10,0]]));
    assert_eq!(good["status"],"geometry_passed_unverified");assert_eq!(good["qualified"],false);
    let bad=run(json!([[10,10,0],[15,10,0]]));
    assert_eq!(bad["status"],"blocked");assert_eq!(bad["blockers"][0]["id"],"pin");
    std::fs::remove_dir_all(root).unwrap();
}
