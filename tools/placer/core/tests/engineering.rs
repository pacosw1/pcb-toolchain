//! A reviewed contract in the search: the misses it adds to legal_penalty, and the bytes it trusts.

mod common;

use common::{box_board, unit};
use iotplace::engineering::Contract;
use iotplace::evaluator::Evaluator;
use iotplace::model::Model;
use iotplace::params::Params;
use iotplace::problem::Problem;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};

fn pad(x: f64, y: f64) -> Value {
    json!({"center": [x, y], "shape": "rect", "size": [1.0, 2.0], "axis_aligned": true, "layers": ["F.Cu"], "kind": "smd"})
}

fn part(x: f64, y: f64, pad_x: f64, locked: bool) -> Value {
    json!({"origin": [x, y], "quarter": 0, "pads": {"1": [pad(pad_x, y)]}, "courtyard": [x - 1.0, y - 1.0, x + 1.0, y + 1.0], "locked": locked})
}

fn contract(rules: Value) -> Value {
    json!({
        "rules": rules,
        "geometry": {"refs": {"U1": part(10.0, 10.0, 11.0, false), "C1": part(14.0, 10.0, 14.0, false), "J1": part(1.0, 3.0, 1.0, false)}, "bounds": [0, 0, 20, 20]},
        "where": {"U1": 0, "C1": 1, "J1": 2},
    })
}

fn units() -> Value {
    let rects = json!([[-1.0, -1.0, 1.0, 1.0, 0.0]]);
    json!([unit("U1", 10.0, 10.0, rects.clone()), unit("C1", 14.0, 10.0, rects.clone()), unit("J1", 1.0, 3.0, rects)])
}

fn problem(engineering: Value) -> (Problem, Vec<u8>) {
    let text = serde_json::to_vec(&json!({"units": units(), "nets": [], "board": box_board(20.0, 20.0), "engineering": engineering})).unwrap();
    (serde_json::from_slice(&text).unwrap(), text)
}

fn digest(bytes: &[u8]) -> String {
    Sha256::digest(bytes).iter().map(|b| format!("{b:02x}")).collect()
}

fn reviewed(rules: Value) -> Problem {
    let (mut pr, bytes) = problem(contract(rules));
    pr.bind_engineering(&bytes, Some(&digest(&bytes))).unwrap();
    pr
}

fn miss(rules: Value, unit: usize, pose: Vec<(f64, f64, u8)>) -> f64 {
    reviewed(rules).contract.unwrap().miss(unit, &pose)
}

const HOME: [(f64, f64, u8); 3] = [(10.0, 10.0, 0), (14.0, 10.0, 0), (1.0, 3.0, 0)];

#[test]
fn a_distance_miss_is_in_mm_and_a_move_repairs_it() {
    let rule = json!([{"id": "d", "kind": "pin_distance", "a": {"ref": "U1", "pad": "1"}, "b": {"ref": "C1", "pad": "1"}, "max_mm": 2}]);
    assert_eq!(miss(rule.clone(), 1, HOME.to_vec()), 1.0);
    assert_eq!(miss(rule.clone(), 1, vec![HOME[0], (13.0, 10.0, 0), HOME[2]]), 0.0);
    assert_eq!(miss(rule, 2, HOME.to_vec()), 0.0);
}

#[test]
fn the_miss_reaches_legal_penalty_and_not_the_cost() {
    let rule = json!([{"id": "d", "kind": "pin_distance", "a": {"ref": "U1", "pad": "1"}, "b": {"ref": "C1", "pad": "1"}, "max_mm": 2}]);
    let pr = reviewed(rule);
    let params = Params::default();
    let model = Model::new(&pr, &params).unwrap();
    let ev = Evaluator::new(&model, &params, &HOME);
    assert_eq!(ev.legal_penalty(1), 1.0);
    assert_eq!(ev.forbidden_area(1), 0.0);
}

#[test]
fn a_turn_swaps_the_pad_size_for_the_copper_gap() {
    let rule = json!([{"id": "c", "kind": "clearance", "a": {"ref": "U1", "pad": "1"}, "b": {"ref": "C1", "pad": "1"}, "min_mm": 2.5}]);
    // Pads 1 x 2 at x = 11 and 14: edge gap 2. A quarter turn of C1 makes its pad 2 x 1 wide: edge gap 1.5.
    assert_eq!(miss(rule.clone(), 0, HOME.to_vec()), 0.5);
    assert_eq!(miss(rule, 0, vec![HOME[0], (14.0, 10.0, 1), HOME[2]]), 1.0);
}

#[test]
fn a_rigid_group_may_move_together_only() {
    let rule = json!([{"id": "g", "kind": "rigid_group", "refs": ["U1", "C1"]}]);
    assert_eq!(miss(rule.clone(), 0, vec![(12.0, 11.0, 0), (16.0, 11.0, 0), HOME[2]]), 0.0);
    assert_eq!(miss(rule, 0, vec![(12.0, 11.0, 0), (16.0, 12.0, 0), HOME[2]]), 1.0);
}

#[test]
fn retained_copper_freezes_a_group_and_fixed_freezes_a_part() {
    let group = json!([{"id": "g", "kind": "rigid_group", "refs": ["U1", "C1"], "retained_internal_copper": true}]);
    assert_eq!(miss(group, 0, vec![(12.0, 10.0, 0), (16.0, 10.0, 0), HOME[2]]), 1.0);
    let fixed = json!([{"id": "f", "kind": "fixed", "refs": ["U1"]}]);
    assert_eq!(miss(fixed.clone(), 0, HOME.to_vec()), 0.0);
    assert_eq!(miss(fixed, 0, vec![(10.0, 10.0, 2), HOME[1], HOME[2]]), 1.0);
}

#[test]
fn a_connector_corridor_needs_its_edge_and_no_courtyard() {
    let rule = json!([{"id": "a", "kind": "connector_access", "ref": "J1", "corridor_mm": [-1.0, -3.0, 1.0, 0.0], "exit_side": "T"}]);
    assert_eq!(miss(rule.clone(), 0, HOME.to_vec()), 0.0, "every unit sees a connector rule");
    assert_eq!(miss(rule.clone(), 0, vec![(1.0, 1.0, 0), HOME[1], HOME[2]]), 1.0, "U1 stands in the corridor");
    assert_eq!(miss(rule, 2, vec![HOME[0], HOME[1], (1.0, 4.0, 0)]), 1.0, "the corridor no longer reaches the top edge");
}

#[test]
fn a_locked_part_of_a_rule_that_moved_counts() {
    let mut document = contract(json!([{"id": "d", "kind": "pin_distance", "a": {"ref": "U1", "pad": "1"}, "b": {"ref": "C1", "pad": "1"}, "max_mm": 100}]));
    document["geometry"]["refs"]["U1"]["locked"] = json!(true);
    let (mut pr, bytes) = problem(document);
    pr.bind_engineering(&bytes, Some(&digest(&bytes))).unwrap();
    let contract = pr.contract.unwrap();
    assert_eq!(contract.miss(1, &HOME.to_vec()), 0.0);
    assert_eq!(contract.miss(1, &vec![(11.0, 10.0, 0), HOME[1], HOME[2]]), 1.0);
}

#[test]
fn an_escape_rule_has_no_pose_proxy() {
    assert_eq!(miss(json!([{"id": "e", "kind": "escape", "refs": ["U1"]}]), 0, vec![(2.0, 2.0, 3), HOME[1], HOME[2]]), 0.0);
}

#[test]
fn only_the_bytes_the_producer_verified_are_trusted() {
    let (mut pr, bytes) = problem(contract(json!([])));
    assert!(pr.check_supported().is_err(), "no digest, no contract");
    let wrong = pr.bind_engineering(&bytes, Some("0000")).unwrap_err();
    assert!(wrong.to_string().contains("fingerprint differs"));
    pr.bind_engineering(&bytes, Some(&digest(&bytes))).unwrap();
    pr.check_supported().unwrap();
}

#[test]
fn a_digest_on_a_problem_without_a_contract_is_refused() {
    let (mut pr, bytes) = problem(Value::Null);
    let error = pr.bind_engineering(&bytes, Some(&digest(&bytes))).unwrap_err();
    assert!(error.to_string().contains("fingerprint differs"));
}

#[test]
fn a_rule_this_module_cannot_measure_stops_the_run() {
    let ambiguous = json!([{"id": "d", "kind": "pin_distance", "a": {"ref": "U1", "pad": "9"}, "b": {"ref": "C1", "pad": "1"}, "max_mm": 2}]);
    let (pr, _) = problem(contract(ambiguous.clone()));
    assert!(Contract::new(&contract(ambiguous), &pr.units).unwrap_err().to_string().contains("pad endpoint"));
    assert!(Contract::new(&contract(json!([{"id": "t", "kind": "thermal_loop", "refs": ["U1"]}])), &pr.units).is_err());
}
