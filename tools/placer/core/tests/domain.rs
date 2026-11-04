//! Domain areas: the convex hull of the domain pads of a class, grown by a gap. A part with no domain pad must not be in
//! it: its tracks would cross the mains area (the PORT2 creepage fault). A slot and a block border may be in it.

mod common;

use common::*;
use iotplace::evaluator::Evaluator;
use iotplace::numeric::PyRandom;
use iotplace::problem::Problem;
use serde_json::{Value, json};

fn mains(name: &str, x: f64, class: i64) -> Value {
    let mut u = unit(name, x, 20.0, json!([[-1, -1, 1, 1, 0.5], [-0.5, -0.5, 0.5, 0.5, 8.0]]));
    u["dom"] = json!([[1, class, 3.0, 0.5]]);
    u["mech"] = json!([0]);
    u
}

fn selv(y: f64) -> Value {
    unit("R", 25.0, y, json!([[-1, -1, 1, 1, 0.5]]))
}

fn with_areas(units: Value, areas: Value) -> Problem {
    let mut v = problem_json(units, json!([]), square_board(60.0, 0.0));
    v["domain_areas"] = areas;
    parse(v)
}

fn class_1() -> Value {
    json!([{"classes": [1], "gap": 8.0}])
}

fn overlap(units: Value, areas: Value) -> f64 {
    start_terms(&with_areas(units, areas), &small_params(&[])).overlap
}

/// Pads 29 mm apart, hull y 19.5..20.5.
fn k_pair_and(extra: Value) -> Value {
    json!([mains("K1", 10.0, 1), mains("K2", 40.0, 1), extra])
}

#[test]
fn a_part_between_mains_pads_is_illegal() {
    near(overlap(k_pair_and(selv(20.0)), json!([])), 0.0); // the pad gaps pass
    assert!(overlap(k_pair_and(selv(20.0)), class_1()) > 0.0);
    assert!(overlap(k_pair_and(selv(20.5 + 6.5 + 1.0)), class_1()) > 0.0);
    near(overlap(k_pair_and(selv(20.5 + 8.1 + 1.0)), class_1()), 0.0);
}

#[test]
fn domain_parts_slots_and_borders_may_be_in_the_area() {
    near(overlap(k_pair_and(mains("K3", 25.0, 1)), class_1()), 0.0);
    let mut slot = unit("S", 25.0, 40.0, json!([[-1, -1, 1, 1, 0.5], [-1, -21, 1, -19, 0.0]])); // slot on the pad line
    slot["ko"] = json!([1]);
    near(overlap(k_pair_and(slot), class_1()), 0.0);
    let mut border = unit("B", 25.0, 40.0, json!([[-1, -1, 1, 1, 0.5], [-3, -21, 3, -1, 0.0]])); // border into the area
    border["mech"] = json!([1]);
    border["border"] = json!([1]);
    near(overlap(k_pair_and(border), class_1()), 0.0);
}

#[test]
fn the_area_moves_with_the_domain_parts() {
    let pr = with_areas(json!([mains("K1", 10.0, 1), mains("K2", 12.0, 1), selv(20.0)]), class_1());
    let p = small_params(&[]);
    let m = model(&pr, &p);
    let mut ev = Evaluator::new(&m, &p, &pr.initial_pose());
    near(ev.terms().overlap, 0.0); // R 11.5 mm right of the K2 pad
    ev.propose(&[(1, (40.0, 20.0, 0))]); // K2 jumps over R: R is now inside the hull
    within(ev.terms().overlap, Evaluator::new(&m, &p, &ev.pose()).terms().overlap, 5e-7);
    assert!(ev.terms().overlap > 0.0);
    assert!(ev.legal_penalty(2) > 0.0);
    assert!(ev.legal_penalty(1) > 0.0);
    near(ev.legal_penalty_at(2, (25.0, 40.0, 0)), 0.0);
    ev.revert();
    near(ev.terms().overlap, 0.0);
    near(ev.legal_penalty(2), 0.0);
}

#[test]
fn incremental_equals_full_after_random_moves() {
    let units = json!([mains("K1", 10.0, 1), mains("K2", 40.0, 1), selv(30.0), selv(45.0), mains("K3", 25.0, 2)]);
    let pr = with_areas(units, class_1());
    let p = small_params(&[]);
    let m = model(&pr, &p);
    let mut ev = Evaluator::new(&m, &p, &pr.initial_pose());
    let mut rng = PyRandom::new(5);
    for _ in 0..200 {
        ev.propose(&[random_move(&mut rng, 0, 5, 5.0, 55.0)]);
        if rng.random() < 0.5 {
            ev.commit();
        } else {
            ev.revert();
        }
        within(ev.terms().overlap, Evaluator::new(&m, &p, &ev.pose()).terms().overlap, 5e-6);
    }
}
