//! Small problems for the tests, built as JSON like the files the board reader writes.
#![allow(dead_code)]

use iotplace::evaluator::{Evaluator, Terms};
use iotplace::model::Model;
use iotplace::params::Params;
use iotplace::problem::{Place, Problem};
use serde_json::{Value, json};

pub fn unit(name: &str, x: f64, y: f64, rects: Value) -> Value {
    json!({"name": name, "refs": [name], "fixed": false, "x": x, "y": y, "rects": rects})
}

pub fn fixed_unit(name: &str, x: f64, y: f64, rects: Value) -> Value {
    json!({"name": name, "refs": [name], "fixed": true, "x": x, "y": y, "rects": rects})
}

pub fn square_board(size: f64, edge: f64) -> Value {
    json!({"outline": [[0, 0], [size, 0], [size, size], [0, size]], "keepouts": [], "edge_clearance": edge})
}

pub fn problem(units: Value, nets: Value, board: Value) -> Problem {
    serde_json::from_value(json!({"units": units, "nets": nets, "board": board})).expect("a test problem parses")
}

/// A problem from any JSON object.
pub fn parse(v: Value) -> Problem {
    serde_json::from_value(v).expect("a test problem parses")
}

/// The cost parameters of the small tests: cells of 1 and 0.25 mm, one layer, unit weights.
pub fn small_params(extra: &[&str]) -> Params {
    let mut args = vec!["rudy_cell=1", "mask_cell=0.25", "layers=1", "pitch=1", "limit=0.5", "w_wl=1", "w_cong=1", "w_ov=1", "w_oob=1"];
    args.extend_from_slice(extra);
    Params::from_args(&args).expect("test parameters parse")
}

/// All terms of a pose.
pub fn terms(pr: &Problem, pose: &[Place], p: &Params) -> Terms {
    let model = Model::new(pr, p).expect("a test model builds");
    Evaluator::new(&model, p, pose).terms()
}

pub fn near(a: f64, b: f64) {
    assert!((a - b).abs() < 1e-9, "{a} is not {b}");
}
