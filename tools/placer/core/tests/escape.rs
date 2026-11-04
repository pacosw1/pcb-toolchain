//! Pin-escape term and its place in the evaluator.

mod common;

use common::{model, parse, start_terms, within};
use iotplace::escape::EscapeState;
use iotplace::evaluator::Evaluator;
use iotplace::layout::Layout;
use iotplace::numeric::PyRandom;
use iotplace::params::Params;
use iotplace::problem::Problem;
use serde_json::{Value, json};

/// U1: 3 pads on the south side (0.3 x 0.8 mm, pitch 0.5) + 1 pad on each other side (net 0 = no net) and an exposed pad
/// (net 1). Pads in unit coordinates; the pad box spans y -1.0 .. 1.0.
fn ic_unit() -> Value {
    let mut cu: Vec<Value> = [11, 12, 13].iter().enumerate().map(|(k, n)| {
        let cx = (k as f64 - 1.0) * 0.5;
        json!([cx - 0.15, 0.2, cx + 0.15, 1.0, n])
    }).collect();
    cu.extend([json!([-1.0, -0.15, -0.2, 0.15, 0]), json!([0.2, -0.15, 1.0, 0.15, 0]), json!([-0.15, -1.0, 0.15, -0.2, 0]), json!([-0.4, -0.4, 0.4, 0.1, 1])]);
    let meta: Vec<Value> = ["1", "2", "3", "4", "5", "6", "EP"].iter().map(|n| json!(["U1", "smd", n])).collect();
    json!({"name": "U1", "refs": ["U1"], "fixed": true, "x": 10.0, "y": 10.0, "rects": [[-1.2, -1.2, 1.2, 1.2, 1.0]], "cu": cu, "cu_pads": meta})
}

/// A 2-pad part (0402-like) at (x, y): pads 0.5 x 0.5 mm, 1.0 mm apart along x.
fn part(reference: &str, x: f64, y: f64, nets: (i64, i64)) -> Value {
    json!({"name": reference, "refs": [reference], "fixed": false, "x": x, "y": y, "rects": [[-0.9, -0.45, 0.9, 0.45, 0.5]],
           "cu": [[-0.75, -0.25, -0.25, 0.25, nets.0], [0.25, -0.25, 0.75, 0.25, nets.1]],
           "cu_pads": [[reference, "smd", "1"], [reference, "smd", "2"]]})
}

/// A part with one 4 mm wide pad (net) and a small pad of net 6: it walls in every ray of the U1 south side.
fn wall(reference: &str, x: f64, y: f64, net: i64) -> Value {
    json!({"name": reference, "refs": [reference], "fixed": false, "x": x, "y": y, "rects": [[-2.2, -0.5, 2.2, 1.3, 0.5]],
           "cu": [[-2.0, -0.3, 2.0, 0.3, net], [-0.25, 0.7, 0.25, 1.1, 6]],
           "cu_pads": [[reference, "smd", "1"], [reference, "smd", "2"]]})
}

/// U1, the units, and the far ends of nets 11, 12 and 13 (they must leave U1).
fn problem(units: Vec<Value>) -> Problem {
    let mut all = vec![ic_unit()];
    all.extend(units);
    all.extend([part("R9", 20.0, 20.0, (11, 12)), part("R8", 22.0, 20.0, (13, 99))]);
    parse(json!({"units": all, "nets": [], "board": {"outline": [[0, 0], [30, 0], [30, 30], [0, 30]], "keepouts": [], "edge_clearance": 0.0},
                 "escape_rules": {"track": 0.15, "clearance": 0.15, "via_d": 0.6}}))
}

fn escape_params() -> Params {
    Params::from_args(&["w_esc=20"]).unwrap()
}

/// blocked(pin) of U1 in the start pose.
fn blocked(pr: &Problem) -> Vec<f64> {
    let p = escape_params();
    let m = model(pr, &p);
    let layout = Layout::new(&m, &pr.initial_pose());
    EscapeState::new(&m, m.escape.as_ref().unwrap(), &layout).units[&0].blocked.clone()
}

fn hard_sides(pr: &Problem) -> i64 {
    let p = escape_params();
    let m = model(pr, &p);
    let esc = m.escape.as_ref().unwrap();
    let layout = Layout::new(&m, &pr.initial_pose());
    EscapeState::new(&m, esc, &layout).hard_sides(&m, esc, &layout, 0)
}

#[test]
fn pins_sides_and_need() {
    let pr = problem(vec![]);
    let p = escape_params();
    let m = model(&pr, &p);
    let esc = m.escape.as_ref().unwrap();
    let q = esc.pins[0].as_ref().unwrap();
    assert_eq!(q.len(), 6); // the exposed pad is not a pin
    let mut sizes: Vec<usize> = (0..4).map(|s| q.side_of.iter().filter(|k| **k == s).count()).collect();
    sizes.sort();
    assert_eq!(sizes, vec![1, 1, 1, 3]); // E, N, W and S S S
    assert_eq!(q.need[..3], [1.0, 1.0, 1.0]);
    assert_eq!(q.need[3..], [0.0, 0.0, 0.0]); // no net
    assert!(esc.pins[1].is_none()); // a resistor is not an IC
}

#[test]
fn a_turned_unit_turns_its_corridors() {
    let pr = problem(vec![]);
    let p = escape_params();
    let m = model(&pr, &p);
    let q = m.escape.as_ref().unwrap().pins[0].as_ref().unwrap();
    assert!(q.pin_boxes((10.0, 10.0, 0))[0].y1 > 11.0); // south pin: the corridor goes to +y
    assert!(q.pin_boxes((10.0, 10.0, 1))[0].x1 > 11.0); // r = 1 maps (x, y) to (y, -x): south becomes east
}

#[test]
fn free_pins_cost_nothing() {
    let pr = problem(vec![]);
    assert_eq!(start_terms(&pr, &escape_params()).escape, 0.0);
    assert_eq!(hard_sides(&pr), 0);
}

#[test]
fn a_foreign_pad_in_front_blocks_and_a_partner_does_not() {
    let pr = problem(vec![wall("C1", 10.0, 11.8, 5)]); // a wide foreign pad right below the south pins
    within(start_terms(&pr, &escape_params()).escape, 3.0, 5e-8);
    assert_eq!(hard_sides(&pr), 1); // every south pin blocked
    let b = blocked(&problem(vec![wall("C1", 10.0, 11.8, 11)]));
    assert_eq!(b[..3], [0.0, 1.0, 1.0]); // the partner pad of net 11 does not block pin 1
}

#[test]
fn a_partner_within_reach_frees_the_pin() {
    let pr = problem(vec![part("C1", 9.75, 11.6, (11, 0)), part("C2", 10.4, 12.5, (5, 6))]);
    assert_eq!(blocked(&pr)[0], 0.0); // pin 1 (net 11) has its partner pad 0.35 mm below its toe
}

#[test]
fn one_free_ray_is_enough() {
    let pr = problem(vec![part("C1", 10.5, 12.3, (5, 6))]); // blocks the straight and the south-east rays of pin 3
    assert_eq!(blocked(&pr)[2], 0.0);
}

fn walled_board() -> Problem {
    let mut units = vec![wall("W1", 10.0, 16.0, 5)];
    units.extend((0..4).map(|k| part(&format!("C{k}"), 6.0 + 2.5 * k as f64, 20.0, (5, 6))));
    problem(units)
}

#[test]
fn the_term_is_off_by_default() {
    let pr = walled_board();
    let p = Params::default();
    assert!(model(&pr, &p).escape.is_none());
    assert_eq!(start_terms(&pr, &p).escape, 0.0);
}

#[test]
fn incremental_equals_full() {
    let pr = walled_board();
    let p = escape_params();
    let m = model(&pr, &p);
    let mut ev = Evaluator::new(&m, &p, &pr.initial_pose());
    let mut rng = PyRandom::new(1);
    let movable: Vec<usize> = (0..pr.units.len()).filter(|&i| !pr.units[i].fixed).collect();
    for _ in 0..300 {
        let i = rng.choice(&movable);
        let (x, y) = (10.0 + rng.uniform(-2.5, 2.5), 12.0 + rng.uniform(-0.5, 2.0));
        ev.propose(&[(i, (x, y, rng.below(4) as u8))]);
        if rng.random() < 0.5 {
            ev.commit();
        } else {
            ev.revert();
        }
    }
    let full = Evaluator::new(&m, &p, &ev.pose());
    within(ev.terms().escape, full.terms().escape, 5e-10);
    within(ev.cost(), full.cost(), 5e-7);
}

#[test]
fn a_move_into_the_corridor_costs() {
    let pr = walled_board();
    let p = escape_params();
    let m = model(&pr, &p);
    let mut ev = Evaluator::new(&m, &p, &pr.initial_pose());
    assert_eq!(ev.terms().escape, 0.0);
    let d = ev.propose(&[(1, (10.0, 11.8, 0))]);
    assert!(ev.terms().escape > 0.0);
    assert!(d > 0.0);
    ev.revert();
    assert_eq!(ev.terms().escape, 0.0);
}

#[test]
fn a_hard_side_is_illegal_only_with_esc_hard() {
    let pr = problem(vec![wall("C1", 10.0, 11.8, 5)]);
    let soft = escape_params();
    assert_eq!(common::legal_penalty(&pr, &soft, 1), 0.0);
    let hard = Params::from_args(&["w_esc=20", "esc_hard=1"]).unwrap();
    let m = model(&pr, &hard);
    let mut ev = Evaluator::new(&m, &hard, &pr.initial_pose());
    assert!(ev.legal_penalty(1) >= 1.0);
    assert_eq!(ev.legal_penalty_at(1, (10.0, 16.0, 0)), 0.0); // moved away: the rays are free
}
