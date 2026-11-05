//! Repeated blocks (units of 2 or more parts with the same part count, pad count and rect sizes) should sit in one row
//! or column at an equal pitch. Weight w_row, default 0.

mod common;

use common::*;
use iotplace::evaluator::Evaluator;
use iotplace::numeric::PyRandom;
use iotplace::problem::Problem;
use iotplace::rows::row_groups;
use serde_json::{Value, json};

fn block(name: &str, x: f64, y: f64, w: f64) -> Value {
    let mut u = unit(name, x, y, json!([[-w / 2.0, -2, w / 2.0, 2, 0.5]]));
    u["refs"] = json!([format!("{name}_K"), format!("{name}_R")]);
    u
}

fn units(xs: [f64; 4], ys: [f64; 4]) -> Vec<Value> {
    let mut us: Vec<Value> = (0..4).map(|k| block(&format!("B{k}"), xs[k], ys[k], 4.0)).collect();
    us.push(unit("R1", 12.0, 30.0, json!([[-0.5, -0.5, 0.5, 0.5, 0.5]]))); // a single part: not a block
    us.push(block("W", 25.0, 40.0, 6.0)); // another block kind: not in the row group
    us
}

fn blocks(xs: [f64; 4], ys: [f64; 4]) -> Problem {
    problem(Value::from(units(xs, ys)), json!([]), square_board(60.0, 0.0))
}

const XS: [f64; 4] = [10.0, 20.0, 30.0, 40.0];
const LEVEL: [f64; 4] = [10.0; 4];

fn row(pr: &Problem) -> f64 {
    start_terms(pr, &small_params(&["w_row=1"])).row
}

#[test]
fn equal_blocks_in_a_row_at_equal_pitch_cost_0() {
    assert_eq!(row(&blocks(XS, LEVEL)), 0.0);
    assert_eq!(row(&blocks([5.0; 4], [10.0, 20.0, 30.0, 40.0])), 0.0); // a column
}

#[test]
fn a_block_out_of_the_row_costs_its_offset() {
    near(row(&blocks(XS, [10.0, 10.0, 18.0, 10.0])), 8.0);
}

#[test]
fn an_unequal_pitch_costs_more_than_0() {
    assert!(row(&blocks([10.0, 20.0, 26.0, 40.0], LEVEL)) > 0.0);
}

#[test]
fn row_pitch_0_leaves_only_the_alignment() {
    let pr = blocks([10.0, 20.0, 26.0, 40.0], [10.0, 10.0, 13.0, 10.0]);
    near(start_terms(&pr, &small_params(&["w_row=1", "row_pitch=0"])).row, 3.0); // RELAY-4 O: pitch 24/15/24 mm
    assert!(row(&pr) > 3.0);
}

#[test]
fn blocks_within_0_2_mm_of_each_other_are_one_kind() {
    let mut us = units(XS, LEVEL);
    us[2]["rects"][0][2] = json!(2.1); // 4.1 mm wide: a rounding drift of the same block (RELAY-4 2.65 mm)
    let pr = problem(Value::from(us), json!([]), square_board(60.0, 0.0));
    assert_eq!(row_groups(&pr), vec![vec![0, 1, 2, 3]]);
}

#[test]
fn weight_0_is_the_default() {
    assert_eq!(start_terms(&blocks(XS, [10.0, 10.0, 18.0, 10.0]), &small_params(&[])).row, 0.0);
}

#[test]
fn the_row_term_is_incremental() {
    let pr = blocks(XS, [10.0, 10.0, 18.0, 10.0]);
    let p = small_params(&["w_row=2"]);
    let m = model(&pr, &p);
    let mut ev = Evaluator::new(&m, &p, &pr.initial_pose());
    near(ev.terms().row, 8.0);
    let mut rng = PyRandom::new(5);
    for _ in 0..100 {
        ev.propose(&[random_move(&mut rng, 0, 6, 5.0, 50.0)]);
        if rng.random() < 0.5 {
            ev.commit();
        } else {
            ev.revert();
        }
        let full = Evaluator::new(&m, &p, &ev.pose());
        within(ev.cost(), full.cost(), 5e-7);
        within(ev.terms().row, full.terms().row, 5e-7);
    }
}
