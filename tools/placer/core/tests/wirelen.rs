//! Wire-length term: the MST of the net pad centres, and its place in the evaluator.

mod common;

use common::{model, near, parse, problem_json, sample, square_board, start_terms, within};
use iotplace::evaluator::Evaluator;
use iotplace::geom::Point;
use iotplace::layout::Layout;
use iotplace::numeric::PyRandom;
use iotplace::params::Params;
use iotplace::problem::{Place, Problem};
use iotplace::wirelen::{WirelenModel, WirelenState, mst_length};
use serde_json::{Value, json};
use std::collections::BTreeMap;

#[test]
fn known_lengths() {
    assert_eq!(mst_length(&[]), 0.0);
    assert_eq!(mst_length(&[(1.0, 1.0)]), 0.0);
    near(mst_length(&[(0.0, 0.0), (3.0, 4.0)]), 5.0);
    // unit square: 3 sides; a star of 4 points round a centre: 4 spokes
    near(mst_length(&[(0.0, 0.0), (1.0, 0.0), (1.0, 1.0), (0.0, 1.0)]), 3.0);
    near(mst_length(&[(0.0, 0.0), (2.0, 0.0), (-2.0, 0.0), (0.0, 2.0), (0.0, -2.0)]), 8.0);
}

/// The reference: Kruskal.
fn kruskal(pts: &[Point]) -> f64 {
    let mut edges: Vec<(f64, usize, usize)> = Vec::new();
    for a in 0..pts.len() {
        for b in 0..a {
            edges.push(((pts[a].0 - pts[b].0).hypot(pts[a].1 - pts[b].1), a, b));
        }
    }
    edges.sort_by(|x, y| x.0.total_cmp(&y.0));
    let mut parent: Vec<usize> = (0..pts.len()).collect();
    fn find(parent: &[usize], mut a: usize) -> usize {
        while parent[a] != a {
            a = parent[a];
        }
        a
    }
    let mut total = 0.0;
    for (d, a, b) in edges {
        let (ra, rb) = (find(&parent, a), find(&parent, b));
        if ra != rb {
            parent[ra] = rb;
            total += d;
        }
    }
    total
}

#[test]
fn the_length_agrees_with_kruskal() {
    let mut rng = PyRandom::new(3);
    for _ in 0..30 {
        let n = 2 + rng.below(6);
        let pts: Vec<Point> = (0..n).map(|_| (rng.uniform(0.0, 10.0), rng.uniform(0.0, 10.0))).collect();
        near(mst_length(&pts), kruskal(&pts));
    }
}

fn body(name: &str, x: f64, y: f64, fixed: bool) -> Value {
    json!({"name": name, "refs": [name], "fixed": fixed, "x": x, "y": y, "rects": [[-1.0, -0.5, 1.0, 0.5, 0.5]]})
}

/// One pin box per unit (the box of its points), with the points as pts.
fn net(name: &str, pins: &[(usize, f64, f64)]) -> Value {
    let mut by: BTreeMap<usize, Vec<Point>> = BTreeMap::new();
    pins.iter().for_each(|&(u, x, y)| by.entry(u).or_default().push((x, y)));
    let fold = |q: &[Point], f: fn(f64, f64) -> f64, g: fn(&Point) -> f64| q.iter().map(g).reduce(f).unwrap();
    let pin = |(u, q): (&usize, &Vec<Point>)| {
        json!([u, fold(q, f64::min, |p| p.0), fold(q, f64::min, |p| p.1), fold(q, f64::max, |p| p.0), fold(q, f64::max, |p| p.1)])
    };
    let rows: Vec<Value> = by.iter().map(pin).collect();
    json!({"name": name, "weight": 1.0, "track": 0.3, "pins": rows, "pts": by.values().collect::<Vec<_>>()})
}

fn wired() -> Value {
    let units = json!([body("U1", 10.0, 10.0, true), body("R1", 14.0, 10.0, false), body("R2", 10.0, 14.0, false), body("TP1", 20.0, 20.0, false)]);
    let nets = json!([
        net("A", &[(0, 0.5, 0.0), (1, -0.5, 0.0)]),
        net("B", &[(0, -0.5, 0.0), (0, 0.5, 0.3), (2, 0.5, 0.0), (3, 0.0, 0.0)]),
        net("P", &[(1, 0.5, 0.0), (2, -0.5, 0.0)]), // a plane net
        {"name": "~comp:x", "weight": 1.0, "track": 0.0, "cohesion": true, "pins": [[1, -1, -0.5, 1, 0.5], [2, -1, -0.5, 1, 0.5]]},
    ]);
    let mut v = problem_json(units, nets, square_board(40.0, 0.5));
    v["plane_nets"] = json!(["P"]);
    v
}

/// The length per net index of a pose.
fn per_net(pr: &Problem, pose: &[Place]) -> BTreeMap<usize, f64> {
    let p = Params::default();
    let m = model(pr, &p);
    WirelenState::new(&WirelenModel::new(pr), &Layout::new(&m, pose)).values
}

#[test]
fn the_term_holds_the_signal_nets_with_their_pad_points() {
    let pr = parse(wired());
    let per = per_net(&pr, &pr.initial_pose());
    assert_eq!(per.keys().copied().collect::<Vec<_>>(), vec![0, 1]); // no plane net, no cohesion net
    near(per[&0], 3.0); // (10.5, 10) - (13.5, 10)
    near(per[&1], mst_length(&[(9.5, 10.0), (10.5, 10.3), (10.5, 14.0), (20.0, 20.0)]));
    let p = Params::from_args(&["w_mst=1"]).unwrap();
    near(start_terms(&pr, &p).wirelen, per[&0] + per[&1]);
}

#[test]
fn a_turn_moves_the_points() {
    let pr = parse(wired());
    let mut pose = pr.initial_pose();
    pose[1] = (14.0, 10.0, 2); // R1 turned 180 deg: its A pad goes to (14.5, 10)
    near(per_net(&pr, &pose)[&0], 4.0);
}

#[test]
fn an_old_problem_uses_box_centres() {
    let mut v = wired();
    v["nets"].as_array_mut().unwrap().iter_mut().for_each(|n| {
        n.as_object_mut().unwrap().remove("pts");
    });
    let pr = parse(v);
    let per = per_net(&pr, &pr.initial_pose());
    near(per[&0], 3.0);
    // U1 B pins merge to one box centre (10, 10.15)
    near(per[&1], mst_length(&[(10.0, 10.15), (10.5, 14.0), (20.0, 20.0)]));
}

#[test]
fn the_term_is_off_by_default() {
    let pr = parse(wired());
    let p = Params::default();
    assert!(model(&pr, &p).wirelen.is_none());
    assert_eq!(start_terms(&pr, &p).wirelen, 0.0);
}

#[test]
fn incremental_equals_full() {
    let pr = parse(wired());
    let p = Params::from_args(&["w_mst=2"]).unwrap();
    let m = model(&pr, &p);
    let mut ev = Evaluator::new(&m, &p, &pr.initial_pose());
    let mut rng = PyRandom::new(1);
    for _ in 0..300 {
        let count = 1 + rng.below(2);
        let moves: Vec<_> = sample(&mut rng, 3, count)
            .into_iter()
            .map(|k| (k + 1, (rng.uniform(3.0, 37.0), rng.uniform(3.0, 37.0), rng.below(4) as u8)))
            .collect();
        ev.propose(&moves);
        if rng.random() < 0.5 {
            ev.commit();
        } else {
            ev.revert();
        }
    }
    let full = Evaluator::new(&m, &p, &ev.pose());
    within(ev.terms().wirelen, full.terms().wirelen, 5e-10);
    within(ev.cost(), full.cost(), 5e-7);
}

#[test]
fn delta_and_revert() {
    let pr = parse(wired());
    let p = Params::from_args(&["w_mst=1", "w_wl=0", "w_cong=0"]).unwrap();
    let m = model(&pr, &p);
    let mut ev = Evaluator::new(&m, &p, &pr.initial_pose());
    let (w0, c0) = (ev.terms().wirelen, ev.cost());
    let d = ev.propose(&[(3, (11.0, 15.0, 0))]); // the test point next to R2: net B gets shorter
    assert!(ev.terms().wirelen < w0);
    within(d, ev.cost() - c0, 5e-10);
    assert!(d < 0.0);
    ev.revert();
    assert_eq!(ev.terms().wirelen, w0);
    assert_eq!(ev.cost(), c0);
}
