//! Net length, RUDY demand and overflow, kept copper demand, and the bench calibration of track RUDY.

mod common;

use common::*;
use iotplace::bench::spearman;
use iotplace::evaluator::Evaluator;
use iotplace::layout::Layout;
use iotplace::numeric::PyRandom;
use iotplace::params::Params;
use iotplace::problem::{Place, Pose, Problem};
use iotplace::rudy::NetState;
use serde_json::{Value, json};
use std::collections::BTreeMap;

const GRID: usize = 10;

fn demand(pr: &Problem, pose: &[Place], p: &Params) -> Vec<f64> {
    let m = model(pr, p);
    NetState::new(&m, &Layout::new(&m, pose)).demand
}

fn sum(g: &[f64]) -> f64 {
    g.iter().sum()
}

fn two_pads(x: f64, y: f64) -> Problem {
    let small = json!([[-0.5, -0.5, 0.5, 0.5, 0.5]]);
    problem(json!([unit("A", 0.0, 0.0, small.clone()), unit("B", x, y, small)]), json!([net("N", &[0, 1])]), square_board(10.0, 0.0))
}

#[test]
fn hpwl_of_two_points_is_dx_plus_dy() {
    near(start_terms(&two_pads(3.0, 4.0), &small_params(&[])).hpwl, 7.0);
}

#[test]
fn a_turn_moves_the_pin() {
    // Pin at local (1, 0); r = 1 puts it at (0, -1). Other pin at (0, 1): HPWL 0 + 2.
    let units = json!([unit("A", 0.0, 0.0, json!([[-1, -1, 1, 1, 0.5]])), unit("B", 0.0, 1.0, json!([[-0.5, -0.5, 0.5, 0.5, 0.5]]))]);
    let nets = json!([{"name": "N", "weight": 1.0, "pins": [[0, 1, 0, 1, 0], [1, 0, 0, 0, 0]]}]);
    let pr = problem(units, nets, square_board(10.0, 0.0));
    near(terms(&pr, &[(0.0, 0.0, 1), (0.0, 1.0, 0)], &small_params(&[])).hpwl, 2.0);
}

#[test]
fn the_net_weight_scales_hpwl() {
    let units = json!([unit("A", 0.0, 0.0, json!([[0, 0, 1, 1, 0.5]])), unit("B", 2.0, 0.0, json!([[0, 0, 1, 1, 0.5]]))]);
    let nets = json!([{"name": "N", "weight": 3.0, "pins": [[0, 0, 0, 0, 0], [1, 0, 0, 0, 0]]}]);
    near(start_terms(&problem(units, nets, square_board(10.0, 0.0)), &small_params(&[])).hpwl, 6.0);
}

/// Pins at (1, 1) and (3, 3).
fn diagonal() -> Value {
    let small = json!([[-0.1, -0.1, 0.1, 0.1, 0.5]]);
    problem_json(json!([unit("A", 1.0, 1.0, small.clone()), unit("B", 3.0, 3.0, small)]), json!([net("N", &[0, 1])]), square_board(10.0, 0.0))
}

#[test]
fn a_net_spreads_its_hpwl_over_its_box() {
    // box 2 x 2 mm = 4 cells, HPWL 4: 1 mm of wire per cell
    let pr = parse(diagonal());
    let g = demand(&pr, &pr.initial_pose(), &small_params(&[]));
    near(sum(&g), 4.0);
    near([(1, 1), (1, 2), (2, 1), (2, 2)].iter().map(|(j, i)| g[j * GRID + i]).sum(), 4.0);
    near(g.iter().copied().fold(0.0, f64::max), 1.0);
}

#[test]
fn overflow_is_the_demand_above_the_limit() {
    // capacity per cell = 1 mm2 * 1 layer / 1 mm pitch = 1; limit 0.5: 0.5 over in each of 4 cells
    near(start_terms(&parse(diagonal()), &small_params(&[])).cong, 2.0);
}

#[test]
fn the_region_weight_multiplies_the_overflow_inside_its_box() {
    let mut pr = diagonal();
    pr["region"] = json!({"box": [1, 1, 2, 2], "weight": 5.0, "refs": []});
    near(start_terms(&parse(pr), &small_params(&[])).cong, 0.5 * 5.0 + 3.0 * 0.5);
}

#[test]
fn each_pad_adds_pin_demand_in_its_cell() {
    let mut a = unit("A", 1.0, 1.0, json!([[-0.5, -0.5, 0.5, 0.5, 0.5]]));
    a["pads"] = json!([[0.5, 0.5], [0.5, 0.6], [-0.5, -0.5]]);
    let pr = problem(json!([a]), json!([]), square_board(10.0, 0.0));
    let g = demand(&pr, &pr.initial_pose(), &small_params(&["pin_demand=0.3"]));
    near(g[GRID + 1], 0.6);
    near(g[0], 0.3);
    near(sum(&g), 0.9);
}

#[test]
fn pads_turn_with_the_unit() {
    let mut a = unit("A", 5.0, 5.0, json!([[-0.5, -0.5, 0.5, 0.5, 0.5]]));
    a["pads"] = json!([[1.5, 0.2]]);
    let pr = problem(json!([a]), json!([]), square_board(10.0, 0.0));
    let g = demand(&pr, &[(5.0, 5.0, 1)], &small_params(&["pin_demand=1"]));
    near(g[3 * GRID + 5], 1.0); // (0.2, -1.5) + (5, 5) = (5.2, 3.5)
}

fn copper_board(rows: Value) -> Value {
    let mut b = square_board(10.0, 0.0);
    b["copper"] = rows;
    b
}

fn kept_demand(rows: Value, p: &Params) -> Vec<f64> {
    let pr = problem(json!([]), json!([]), copper_board(rows));
    model(&pr, p).kept_demand
}

#[test]
fn a_track_on_a_routing_layer_uses_capacity() {
    let g = kept_demand(json!([["F.Cu", 2.0, 5.5, 5.0, 5.5, 0.2]]), &small_params(&["pitch=0.4", "gap=0.2"]));
    // 3 mm of a 0.2 mm track + 0.2 mm gap = 3 * 0.4 / 0.4 = 3 mm of wire, in row 5, cells 2..4
    within(sum(&g), 3.0, 0.005);
    within(sum(&g[5 * GRID + 2..5 * GRID + 5]), 3.0, 0.005);
}

#[test]
fn an_inner_layer_track_uses_no_routing_capacity() {
    near(sum(&kept_demand(json!([["In1.Cu", 2.0, 5.5, 5.0, 5.5, 0.2]]), &small_params(&[]))), 0.0);
}

#[test]
fn a_via_uses_capacity_on_each_routing_layer() {
    let g = kept_demand(json!([["via", 5.5, 5.5, 5.5, 5.5, 0.6]]), &small_params(&["pitch=0.4", "gap=0.2", "layers=2"]));
    within(g[5 * GRID + 5], 2.0 * 0.64 / 0.4, 5e-7); // (0.6 + 0.2)^2 / 0.4 per layer, 2 layers
}

#[test]
fn kept_copper_counts_in_the_overflow() {
    let units = json!([unit("A", 1.0, 1.0, json!([[-0.1, -0.1, 0.1, 0.1, 0.5]]))]);
    let pr = problem(units, json!([]), copper_board(json!([["F.Cu", 0.0, 5.5, 10.0, 5.5, 0.2]])));
    assert!(start_terms(&pr, &small_params(&["pitch=0.4", "gap=0.2", "layers=1", "limit=0.1"])).cong > 0.0);
}

fn track_problem(track: Option<f64>) -> Value {
    let body = json!([[-0.5, -0.5, 0.5, 0.5, 0]]);
    let mut n = json!({"name": "N", "weight": 1.0, "pins": [[0, -0.1, -0.1, 0.1, 0.1], [1, -0.1, -0.1, 0.1, 0.1]]});
    if let Some(t) = track {
        n["track"] = json!(t);
    }
    problem_json(json!([unit("A", 5.0, 5.0, body.clone()), unit("B", 15.0, 12.0, body)]), json!([n]), square_board(20.0, 0.0))
}

#[test]
fn the_demand_scales_with_the_track() {
    let p = small_params(&["pitch=0.4", "tracks=1"]);
    let plain = parse(track_problem(None));
    let wide = parse(track_problem(Some(0.7)));
    let (g1, g2) = (demand(&plain, &plain.initial_pose(), &p), demand(&wide, &wide.initial_pose(), &p));
    assert!(sum(&g1) > 0.0);
    g1.iter().zip(&g2).for_each(|(a, b)| near(*b, 1.75 * a));
}

#[test]
fn incremental_equals_full_with_track_nets() {
    let mut rng = PyRandom::new(8);
    let mut v = random_problem(&mut rng, 8, 10);
    for n in v["nets"].as_array_mut().unwrap().iter_mut().skip(1).step_by(2) {
        n["track"] = json!(rng.choice(&[0.5, 2.0, 5.0]));
    }
    let pr = parse(v);
    let p = small_params(&["limit=0.05", "tracks=1"]);
    let m = model(&pr, &p);
    let mut ev = Evaluator::new(&m, &p, &pr.initial_pose());
    for _ in 0..200 {
        ev.propose(&[random_move(&mut rng, 1, 8, -2.0, 22.0)]);
        if rng.random() < 0.5 {
            ev.commit();
        } else {
            ev.revert();
        }
        within(ev.cost(), Evaluator::new(&m, &p, &ev.pose()).cost(), 5e-6);
    }
}

/// Bench fixtures of RELAY-4: the problem, the routed poses and their Freerouting opens.
fn fixture(name: &str) -> Value {
    let path = format!("{}/../fixtures/{name}", env!("CARGO_MANIFEST_DIR"));
    serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap()
}

/// The congestion of pose O (the read positions) and of each bench pose.
fn congestion(fx: &Value, args: &[&str]) -> BTreeMap<String, f64> {
    let pr = parse(fx["problem"].clone());
    let p = Params::from_args(args).unwrap();
    let m = model(&pr, &p);
    let cong = |pose: &Pose| Evaluator::new(&m, &p, pose).terms().cong;
    let mut c = BTreeMap::from([("O".to_string(), cong(&pr.initial_pose()))]);
    for (name, pose) in fx["poses"].as_object().unwrap() {
        c.insert(name.clone(), cong(&serde_json::from_value(pose.clone()).unwrap()));
    }
    c
}

#[test]
fn track_rudy_at_0_7_ranks_the_original_below_the_searched_poses() {
    // RELAY-4 Freerouting opens (median of 5): bench v3 O 8 < S 133 < P 142
    let c = congestion(&fixture("relay4-bench-v3.json"), &["tracks=1", "limit=0.7"]);
    assert!(c["O"] > 0.0);
    assert!(c["O"] < c["S"]);
    assert!(c["O"] < c["P"]);
}

#[test]
fn track_rudy_at_0_7_ranks_the_routable_poses_below_the_failed_one() {
    // bench v4: O 8, P2 6 < P 67
    let c = congestion(&fixture("relay4-bench-v4.json"), &["tracks=1", "limit=0.7"]);
    assert!(c["O"] < c["P"]);
    assert!(c["P2"] < c["P"]);
}

#[test]
fn track_rudy_at_0_3_ranks_the_nine_routed_poses_and_is_never_zero() {
    // bench v5: the P3 search drove the term to 0 at limit 0.7 and routed worse (11-13) than O (8)
    let fx = fixture("relay4-bench-v5.json");
    let c = congestion(&fx, &["tracks=1", "limit=0.3"]);
    assert!(c.values().all(|v| *v > 0.0));
    let unrouted = fx["unrouted"].as_object().unwrap();
    let cong: Vec<f64> = unrouted.keys().map(|t| c[t]).collect();
    let opens: Vec<f64> = unrouted.values().map(|v| v.as_f64().unwrap()).collect();
    assert!(spearman(&cong, &opens) >= 0.5);
}

#[test]
fn the_default_is_the_old_rudy() {
    // P5 holdout: the P2R config with track RUDY 0.3 routed median 8 vs P2R 7, so the default stays the cost of P2 and
    // P2R: net tracks off, limit 0.1
    let fx = fixture("relay4-bench-v5.json");
    let got = congestion(&fx, &[]);
    let mut bare = fx.clone();
    bare["problem"]["nets"].as_array_mut().unwrap().iter_mut().for_each(|n| {
        n.as_object_mut().unwrap().remove("track");
    });
    let want = congestion(&bare, &["limit=0.1"]);
    assert_eq!(got.keys().collect::<Vec<_>>(), want.keys().collect::<Vec<_>>());
    want.iter().for_each(|(t, v)| within(got[t], *v, 5e-7));
}

#[test]
fn cong_soft_is_off_by_default_and_must_not_be_negative() {
    assert_eq!(Params::default().cong_soft, 0.0);
    assert!(Params::from_args(&["cong_soft=-1"]).is_err());
}

#[test]
fn cong_soft_scores_sparse_poses_that_the_clipped_term_cannot() {
    let rects = json!([[-0.5, -0.5, 0.5, 0.5, 0.0]]);
    let pr = problem(json!([unit("A", 3.0, 3.0, rects.clone()), unit("B", 9.0, 9.0, rects)]), json!([net("signal", &[0, 1])]), square_board(30.0, 1.0));
    let cong = |extra: &[&str], b: Place| {
        let p = small_params(extra);
        let m = model(&pr, &p);
        NetState::new(&m, &Layout::new(&m, &[(3.0, 3.0, 0), b])).congestion(&m)
    };
    let (near_pose, far_pose) = ((9.0, 9.0, 0), (21.0, 21.0, 0));
    assert_eq!((cong(&[], near_pose), cong(&[], far_pose)), (0.0, 0.0));
    let (a, b) = (cong(&["cong_soft=1"], near_pose), cong(&["cong_soft=1"], far_pose));
    assert!(a > 0.0 && b > 0.0 && a != b, "{a} {b}");
    near(cong(&["cong_soft=2"], near_pose), 2.0 * a);
}

#[test]
fn cong_soft_leaves_the_clipped_overflow_unchanged() {
    let pr = two_pads(3.0, 4.0);
    let m = model(&pr, &small_params(&["cong_soft=3"]));
    let m0 = model(&pr, &small_params(&[]));
    let at = |m: &_| NetState::new(m, &Layout::new(m, &pr.initial_pose())).overflow(m);
    assert_eq!(at(&m), at(&m0));
}

#[test]
fn cong_soft_incremental_equals_full() {
    let mut rng = PyRandom::new(11);
    let pr = parse(random_problem(&mut rng, 8, 10));
    let p = small_params(&["cong_soft=0.5", "pin_demand=0.4"]);
    let m = model(&pr, &p);
    let mut ev = Evaluator::new(&m, &p, &pr.initial_pose());
    for k in 0..200 {
        ev.propose(&[random_move(&mut rng, 1, 8, -2.0, 22.0)]);
        if k % 2 == 0 { ev.commit() } else { ev.revert() }
        within(ev.cost(), Evaluator::new(&m, &p, &ev.pose()).cost(), 5e-6);
    }
}
