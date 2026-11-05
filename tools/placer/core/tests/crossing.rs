//! Net crossings (Cypress, ISPD 2025): each net is a star (pin centre to the mean of its pin centres). Two segments of
//! different nets with line parameters t, u add B(t - 0.5) * B(u - 0.5); crossing = the sum over segment pairs.

mod common;

use common::*;
use iotplace::crossing::bump;
use iotplace::evaluator::Evaluator;
use iotplace::numeric::PyRandom;
use iotplace::params::Params;
use iotplace::problem::Problem;
use serde_json::{Value, json};

fn crossing_params() -> Params {
    small_params(&["w_x=5"])
}

fn dot(name: &str, x: f64, y: f64) -> Value {
    unit(name, x, y, json!([[-0.1, -0.1, 0.1, 0.1, 0]]))
}

/// N1 from (0, 0) to (4, 4), N2 from (0, 4) to (bx, by).
fn two_nets(bx: f64, by: f64) -> Problem {
    let units = json!([dot("A", 0.0, 0.0), dot("B", 4.0, 4.0), dot("C", 0.0, 4.0), dot("D", bx, by)]);
    problem(units, json!([net("N1", &[0, 1]), net("N2", &[2, 3])]), square_board(20.0, 0.0))
}

#[test]
fn the_bump_shape() {
    assert_eq!(bump(0.0), 1.0);
    near(bump(0.5), 0.5);
    near(bump(-0.75), 2.0 * 0.25 * 0.25);
    assert_eq!(bump(1.2), 0.0);
}

#[test]
fn an_x_is_one_crossing_and_parallel_nets_are_none() {
    // the star of a 2-pin net is 2 half segments; they meet at t = 1 of each half (B(0.5) = 0.5)
    assert!(start_terms(&two_nets(4.0, 0.0), &crossing_params()).crossing > 0.9);
    assert_eq!(start_terms(&two_nets(4.0, 8.0), &crossing_params()).crossing, 0.0);
}

#[test]
fn the_segments_of_one_net_do_not_cross_each_other() {
    let units = json!([dot("U0", 0.0, 0.0), dot("U1", 4.0, 0.0), dot("U2", 2.0, 4.0)]);
    let pr = problem(units, json!([net("N", &[0, 1, 2])]), square_board(20.0, 0.0));
    assert_eq!(start_terms(&pr, &crossing_params()).crossing, 0.0);
}

#[test]
fn incremental_equals_full_after_random_moves() {
    let mut rng = PyRandom::new(9);
    let pr = parse(random_problem(&mut rng, 10, 14));
    let p = crossing_params();
    let m = model(&pr, &p);
    let mut ev = Evaluator::new(&m, &p, &pr.initial_pose());
    for _ in 0..200 {
        ev.propose(&[random_move(&mut rng, 1, 10, 0.0, 20.0)]);
        if rng.random() < 0.5 {
            ev.commit();
        } else {
            ev.revert();
        }
        let full = Evaluator::new(&m, &p, &ev.pose());
        within(ev.terms().crossing, full.terms().crossing, 5e-7);
        within(ev.cost(), full.cost(), 5e-6);
    }
}
