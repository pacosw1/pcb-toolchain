//! Via room: each pad of a via net needs a free via site near it: 16 sites (4 sides, 4 corners; 0.2 and 0.5 mm beyond the
//! pad edge + via radius). A site is blocked by copper of another net within via radius + clearance, or when it is within
//! edge_clearance + via radius of the board edge. via = the count of via-net pads with no free site.

mod common;

use common::*;
use iotplace::evaluator::Evaluator;
use iotplace::numeric::PyRandom;
use iotplace::params::Params;
use serde_json::{Value, json};
use std::collections::BTreeSet;

const FRAME: [[f64; 4]; 4] = [[-2.0, -2.0, -0.7, 2.0], [0.7, -2.0, 2.0, 2.0], [-2.0, -2.0, 2.0, -0.7], [-2.0, 0.7, 2.0, 2.0]];

fn via_params() -> Params {
    small_params(&["via_d=0.6", "via_clr=0.2", "w_via=10"])
}

fn copper(rects: &[[f64; 4]], net: f64) -> Value {
    rects.iter().map(|r| json!([r[0], r[1], r[2], r[3], net])).collect()
}

/// A pad G of via net 1 at gx, inside a frame F of copper at fx.
fn framed(gx: f64, fx: f64, frame: Value, board: Value) -> Value {
    let mut g = unit("G", gx, 10.0, json!([[-0.5, -0.5, 0.5, 0.5, 0]]));
    g["cu"] = json!([[-0.5, -0.5, 0.5, 0.5, 1]]);
    let mut f = unit("F", fx, 10.0, json!([[-2, -2, 2, 2, 0]]));
    f["cu"] = frame;
    let mut pr = problem_json(json!([g, f]), json!([]), board);
    pr["via_nets"] = json!([1]);
    pr
}

fn board() -> Value {
    square_board(20.0, 0.5)
}

fn via(pr: Value) -> f64 {
    start_terms(&parse(pr), &via_params()).via
}

/// The frame without its left side: the left sites are free.
fn three_sides(gx: f64) -> Value {
    framed(gx, gx, copper(&FRAME[1..], 2.0), board())
}

#[test]
fn a_free_pad_has_room() {
    assert_eq!(via(framed(10.0, 16.0, copper(&FRAME, 2.0), board())), 0.0);
}

#[test]
fn other_net_copper_on_all_sides_blocks_the_pad() {
    assert_eq!(via(framed(10.0, 10.0, copper(&FRAME, 2.0), board())), 1.0);
}

#[test]
fn same_net_copper_does_not_block() {
    assert_eq!(via(framed(10.0, 10.0, copper(&FRAME, 1.0), board())), 0.0);
}

#[test]
fn three_sides_leave_one_side_free() {
    assert_eq!(via(three_sides(10.0)), 0.0);
}

#[test]
fn the_board_edge_blocks_the_free_side() {
    // left side open, but the pad is 0.9 mm from the left edge: a via there is within 0.5 + 0.3 mm
    assert_eq!(via(three_sides(1.4)), 1.0);
    assert_eq!(via(three_sides(10.0)), 0.0);
}

#[test]
fn a_board_via_keepout_blocks_the_sites_inside_it() {
    // the pad is free (frame far away) but it sits in a no-via rule area of the board
    let with_keepout = |poly: Value| {
        let mut b = board();
        b["via_keepouts"] = json!([poly]);
        framed(10.0, 16.0, copper(&FRAME, 2.0), b)
    };
    assert_eq!(via(with_keepout(json!([[7, 7], [13, 7], [13, 13], [7, 13]]))), 1.0);
    assert_eq!(via(with_keepout(json!([[7, 7], [13, 7], [13, 9.9], [7, 9.9]]))), 0.0); // the lower sites stay free
}

#[test]
fn a_no_via_area_of_a_unit_blocks_within_the_via_radius_only() {
    // net code -1 = a no-via rule area that moves with its unit: no clearance, only the via radius
    let with_extra = |row: Value| {
        let mut pr = three_sides(10.0);
        pr["units"][1]["cu"].as_array_mut().unwrap().push(row);
        pr
    };
    assert_eq!(via(with_extra(json!([-2.0, -0.35, -1.55, 0.35, 2]))), 0.0); // 0.25 mm from the far left site; the near one is free
    assert_eq!(via(with_extra(json!([-1.2, -2, -0.85, 2, 2]))), 1.0); // 0.15 mm from the near site: blocked, far site too
    assert_eq!(via(with_extra(json!([-2.0, -2, -1.35, 2, -1]))), 0.0); // no-via area 0.35 mm from the near left site: free
    assert_eq!(via(with_extra(json!([-2.0, -2, -1.25, 2, -1]))), 1.0); // 0.25 mm < via radius: blocked
}

#[test]
fn no_via_nets_gives_zero() {
    let mut pr = framed(10.0, 10.0, copper(&FRAME, 2.0), board());
    pr.as_object_mut().unwrap().remove("via_nets");
    assert_eq!(via(pr), 0.0);
}

#[test]
fn the_weight_adds_to_the_total() {
    let pr = parse(framed(10.0, 10.0, copper(&FRAME, 2.0), board()));
    let p = via_params();
    let free = Params { w_via: 0.0, ..p.clone() };
    let m = model(&pr, &p);
    let (with, without) = (Evaluator::new(&m, &p, &pr.initial_pose()), Evaluator::new(&m, &free, &pr.initial_pose()));
    assert_eq!(with.terms().via, 1.0);
    near(with.cost() - without.cost(), 10.0);
}

fn scattered_unit(rng: &mut PyRandom, k: usize) -> Value {
    let (x, y) = (rng.uniform(2.0, 8.0), rng.uniform(2.0, 8.0));
    let mut u = unit(&format!("U{k}"), x, y, json!([[-1, -1, 1, 1, 0]]));
    let (a, b) = (rng.choice(&[1, 2, 3]), rng.choice(&[1, 2, 3]));
    u["cu"] = json!([[-1, -1, -0.2, -0.2, a], [0.2, 0.2, 1, 1, b], [0.2, -1, 1, -0.5, 1]]);
    u
}

#[test]
fn incremental_equals_full_after_random_moves() {
    let mut rng = PyRandom::new(5);
    let units: Vec<Value> = (0..8).map(|k| scattered_unit(&mut rng, k)).collect();
    let mut v = problem_json(Value::from(units), json!([]), square_board(10.0, 0.5));
    v["via_nets"] = json!([1]);
    let pr = parse(v);
    let p = via_params();
    let m = model(&pr, &p);
    let mut ev = Evaluator::new(&m, &p, &pr.initial_pose());
    let mut seen = BTreeSet::new();
    for _ in 0..300 {
        ev.propose(&[random_move(&mut rng, 0, 8, 1.0, 9.0)]);
        if rng.random() < 0.5 {
            ev.commit();
        } else {
            ev.revert();
        }
        let full = Evaluator::new(&m, &p, &ev.pose());
        seen.insert(full.terms().via as i64);
        assert_eq!(ev.terms().via, full.terms().via);
        within(ev.cost(), full.cost(), 5e-6);
    }
    assert!(seen.len() > 1); // the moves did change the count
}
