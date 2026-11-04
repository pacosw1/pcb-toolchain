//! Small problems for the tests, built as JSON like the files the board reader writes.
#![allow(dead_code)]

use iotplace::evaluator::{Evaluator, Terms};
use iotplace::model::Model;
use iotplace::numeric::PyRandom;
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

pub fn box_board(w: f64, h: f64) -> Value {
    json!({"outline": [[0, 0], [w, 0], [w, h], [0, h]], "keepouts": [], "edge_clearance": 0.0})
}

/// A net of weight 1 with a pin at the origin of each unit.
pub fn net(name: &str, units: &[usize]) -> Value {
    let pins: Vec<Value> = units.iter().map(|u| json!([u, 0, 0, 0, 0])).collect();
    json!({"name": name, "weight": 1.0, "pins": pins})
}

pub fn problem(units: Value, nets: Value, board: Value) -> Problem {
    parse(problem_json(units, nets, board))
}

pub fn problem_json(units: Value, nets: Value, board: Value) -> Value {
    json!({"units": units, "nets": nets, "board": board})
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

pub fn model<'p>(pr: &'p Problem, p: &Params) -> Model<'p> {
    Model::new(pr, p).expect("a test model builds")
}

/// All terms of a pose.
pub fn terms(pr: &Problem, pose: &[Place], p: &Params) -> Terms {
    Evaluator::new(&model(pr, p), p, pose).terms()
}

/// All terms of the start pose.
pub fn start_terms(pr: &Problem, p: &Params) -> Terms {
    terms(pr, &pr.initial_pose(), p)
}

/// The legal penalty of unit i in the start pose.
pub fn legal_penalty(pr: &Problem, p: &Params, i: usize) -> f64 {
    Evaluator::new(&model(pr, p), p, &pr.initial_pose()).legal_penalty(i)
}

/// The forbidden area of unit i in a pose.
pub fn forbidden(pr: &Problem, pose: &[Place], p: &Params, i: usize) -> f64 {
    Evaluator::new(&model(pr, p), p, pose).forbidden_area(i)
}

pub fn near(a: f64, b: f64) {
    assert!((a - b).abs() < 1e-9, "{a} is not {b}");
}

/// Equal within a tolerance.
pub fn within(a: f64, b: f64, tolerance: f64) {
    assert!((a - b).abs() < tolerance, "{a} is not {b} within {tolerance}");
}

/// A random move of one of the units `first..n`, inside lo..hi.
pub fn random_move(rng: &mut PyRandom, first: usize, n: usize, lo: f64, hi: f64) -> (usize, Place) {
    let i = first + rng.below(n - first);
    let (x, y) = (rng.uniform(lo, hi), rng.uniform(lo, hi));
    (i, (x, y, rng.below(4) as u8))
}

/// k different values of 0..n.
pub fn sample(rng: &mut PyRandom, n: usize, k: usize) -> Vec<usize> {
    let mut pool: Vec<usize> = (0..n).collect();
    (0..k).map(|_| pool.swap_remove(rng.below(pool.len()))).collect()
}

/// n units on a 20 mm board with a keepout and a region; unit 0 is fixed, each third unit has a hard second rect.
pub fn random_problem(rng: &mut PyRandom, n: usize, nets: usize) -> Value {
    let units: Vec<Value> = (0..n).map(|i| random_unit(rng, i)).collect();
    let nets: Vec<Value> = (0..nets).map(|j| random_net(rng, j, n)).collect();
    let mut board = square_board(20.0, 1.0);
    board["keepouts"] = json!([[[8, 8], [12, 8], [12, 12], [8, 12]]]);
    let mut pr = problem_json(Value::from(units), Value::from(nets), board);
    pr["region"] = json!({"box": [0, 0, 10, 10], "weight": 2.0, "refs": []});
    pr
}

fn random_unit(rng: &mut PyRandom, i: usize) -> Value {
    let (w, h) = (rng.uniform(0.5, 3.0), rng.uniform(0.5, 3.0));
    let class = rng.choice(&[0.5, 1.0]);
    let mut rects = vec![json!([-w / 2.0, -h / 2.0, w / 2.0, h / 2.0, class])];
    if i % 3 == 0 {
        rects.push(json!([w / 2.0, -h / 2.0, w / 2.0 + 1.0, h / 2.0, 0.5]));
    }
    let (x, y) = (rng.uniform(0.0, 20.0), rng.uniform(0.0, 20.0));
    let mut u = unit(&format!("U{i}"), x, y, Value::from(rects));
    u["fixed"] = json!(i == 0);
    if i % 3 == 0 {
        u["hard"] = json!([1]);
    }
    let pads = rng.below(7);
    u["pads"] = Value::from((0..pads).map(|_| json!([rng.uniform(-w / 2.0, w / 2.0), rng.uniform(-h / 2.0, h / 2.0)])).collect::<Vec<_>>());
    u
}

fn random_net(rng: &mut PyRandom, j: usize, n: usize) -> Value {
    let count = 2 + rng.below(3);
    let pin = |rng: &mut PyRandom, u: usize| {
        let (x, y) = (rng.uniform(-1.0, 1.0), rng.uniform(-1.0, 1.0));
        json!([u, x, y, x + 0.2, y + 0.1])
    };
    let chosen = sample(rng, n, count);
    let weight = rng.choice(&[1.0, 2.0]);
    json!({"name": format!("N{j}"), "weight": weight, "pins": chosen.into_iter().map(|u| pin(rng, u)).collect::<Vec<_>>()})
}
