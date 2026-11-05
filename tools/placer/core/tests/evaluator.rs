//! The incremental cost, and the rules that count as forbidden area: edge anchors, near rules, region boxes.

mod common;

use common::*;
use iotplace::evaluator::Evaluator;
use iotplace::geom::{Rect, turn_point};
use iotplace::numeric::PyRandom;
use iotplace::problem::Problem;
use iotplace::rudy::track_factor;
use serde_json::{Value, json};

#[test]
fn r1_is_kicad_plus_90() {
    // KiCad RotatePoint(+90 deg), y axis down: (x, y) to (y, -x).
    assert_eq!(turn_point((1.0, 0.0), 1), (0.0, -1.0));
    assert_eq!(turn_point((1.0, 2.0), 2), (-1.0, -2.0));
    assert_eq!(turn_point((1.0, 2.0), 3), (-2.0, 1.0));
}

#[test]
fn a_turned_rect_keeps_its_size_and_swaps_sides() {
    let r = Rect::new(0.0, 0.0, 2.0, 1.0);
    assert_eq!(r.turned(1), Rect::new(0.0, -2.0, 1.0, 0.0));
    assert_eq!(r.turned(2), Rect::new(-2.0, -1.0, 0.0, 0.0));
    assert_eq!(r.turned(3), Rect::new(-1.0, 0.0, 0.0, 2.0));
}

#[test]
fn incremental_equals_full_after_random_moves() {
    let mut rng = PyRandom::new(7);
    let pr = parse(random_problem(&mut rng, 8, 10));
    let p = small_params(&["pin_demand=0.4", "limit=0.05", "w_sp=2"]);
    let m = model(&pr, &p);
    let mut ev = Evaluator::new(&m, &p, &pr.initial_pose());
    for k in 0..300 {
        if k % 5 == 4 {
            let pick = sample(&mut rng, 7, 2);
            let (a, b) = (pick[0] + 1, pick[1] + 1);
            let (pa, pb) = (ev.place(a), ev.place(b));
            ev.propose(&[(a, (pb.0, pb.1, pa.2)), (b, (pa.0, pa.1, pb.2))]);
        } else {
            ev.propose(&[random_move(&mut rng, 1, 8, -2.0, 22.0)]);
        }
        if rng.random() < 0.5 {
            ev.commit();
        } else {
            ev.revert();
        }
        within(ev.cost(), Evaluator::new(&m, &p, &ev.pose()).cost(), 5e-6);
    }
}

#[test]
fn revert_restores_the_cost_and_the_pose() {
    let pr = parse(random_problem(&mut PyRandom::new(3), 8, 10));
    let p = small_params(&[]);
    let m = model(&pr, &p);
    let mut ev = Evaluator::new(&m, &p, &pr.initial_pose());
    let (cost, pose) = (ev.cost(), ev.pose());
    ev.propose(&[(2, (1.0, 1.0, 3))]);
    ev.revert();
    assert_eq!(ev.pose(), pose);
    near(ev.cost(), cost);
}

#[test]
#[should_panic(expected = "a fixed unit cannot move")]
fn a_fixed_unit_cannot_move() {
    let pr = parse(random_problem(&mut PyRandom::new(3), 8, 10));
    let p = small_params(&[]);
    let m = model(&pr, &p);
    Evaluator::new(&m, &p, &pr.initial_pose()).propose(&[(0, (1.0, 1.0, 0))]);
}

/// A unit whose left side must sit on one of `sides` (the inner edge line, edge clearance 1 mm).
fn anchored(x: f64, sides: &str) -> Value {
    let mut u = unit("J", x, 10.0, json!([[-1, -1, 1, 1, 0.0]]));
    u["edge"] = json!({"at": [-1.0, 0.0], "sides": sides, "tol": 0.5});
    u
}

fn anchored_problem(u: Value) -> Problem {
    problem(json!([u]), json!([]), square_board(20.0, 1.0))
}

fn oob_at(pr: &Problem, x: f64, r: u8) -> f64 {
    terms(pr, &[(x, 10.0, r)], &small_params(&[])).oob
}

#[test]
fn an_anchor_on_an_allowed_side_is_free_and_a_miss_costs_its_distance() {
    near(oob_at(&anchored_problem(anchored(2.0, "L")), 2.0, 0), 0.0);
    near(oob_at(&anchored_problem(anchored(5.0, "L")), 5.0, 0), 2.5);
}

#[test]
fn a_turned_unit_moves_its_anchor() {
    // r = 2 puts the anchor on the right of the unit: at x = 17 it touches the right line x = 19 ... 18
    near(oob_at(&anchored_problem(anchored(18.0, "R")), 18.0, 2), 0.0);
    near(oob_at(&anchored_problem(anchored(18.0, "L")), 18.0, 2), 17.5);
}

#[test]
fn an_edge_miss_is_illegal_and_a_move_takes_it_off() {
    let pr = anchored_problem(anchored(5.0, "L"));
    let p = small_params(&[]);
    let m = model(&pr, &p);
    let mut ev = Evaluator::new(&m, &p, &pr.initial_pose());
    near(ev.terms().oob, 2.5);
    near(ev.legal_penalty(0), 2.5);
    near(ev.legal_penalty_at(0, (2.0, 10.0, 0)), 0.0);
    near(ev.propose(&[(0, (2.0, 10.0, 0))]), -2.5);
}

#[test]
fn an_inset_sets_an_exact_line() {
    // cli.py read --edge J2=B:S:0 (FW-IO 2026-11-02): inset 0 = the courtyard side flush on the outline, tol 0.05.
    // The default line (edge_clearance 1.0, tol 0.5) leaves the flush pose 0.5 mm out of tolerance.
    near(oob_at(&anchored_problem(anchored(1.0, "L")), 1.0, 0), 0.5);
    let mut u = anchored(1.0, "L");
    u["edge"]["inset"] = json!(0.0);
    u["edge"]["tol"] = json!(0.05);
    let pr = anchored_problem(u);
    near(oob_at(&pr, 1.0, 0), 0.0);
    near(oob_at(&pr, 1.5, 0), 0.45);
    let p = small_params(&[]);
    let m = model(&pr, &p);
    let mut ev = Evaluator::new(&m, &p, &pr.initial_pose());
    near(ev.legal_penalty_at(0, (1.0, 10.0, 0)), 0.0);
    assert!(ev.legal_penalty_at(0, (2.0, 10.0, 0)) > 0.9);
}

/// The pad at the right end of the unit stays within 3 mm of (10, 2) (FW-IO 2026-11-02: the TVS pads at the J1 pins).
fn near_rule(x: f64, y: f64) -> Problem {
    let mut u = unit("D1", x, y, json!([[-1, -1, 1, 1, 0.5]]));
    u["near"] = json!([[1.0, 0.0, 10.0, 2.0, 3.0]]);
    problem(json!([u]), json!([]), square_board(20.0, 0.5))
}

#[test]
fn inside_is_free_beyond_counts_its_mm_and_a_turn_moves_the_pad() {
    let p = small_params(&[]);
    let pr = near_rule(9.0, 5.0);
    near(terms(&pr, &[(9.0, 5.0, 0)], &p).oob, 0.0); // pad (10, 5): 3.0 mm
    near(terms(&pr, &[(9.0, 7.0, 0)], &p).oob, 2.0); // pad (10, 7): 5.0 mm
    near(terms(&pr, &[(11.0, 5.0, 2)], &p).oob, 0.0); // r 2: pad (10, 5)
}

#[test]
fn a_near_miss_is_illegal_and_a_move_takes_it_off() {
    let pr = near_rule(9.0, 7.0);
    let p = small_params(&[]);
    let m = model(&pr, &p);
    let mut ev = Evaluator::new(&m, &p, &pr.initial_pose());
    near(ev.terms().oob, 2.0);
    near(ev.legal_penalty(0), 2.0);
    near(ev.legal_penalty_at(0, (9.0, 5.0, 0)), 0.0);
    near(ev.propose(&[(0, (9.0, 5.0, 0))]), -2.0);
}

/// TP1 must keep its courtyard in the box 16..19 x 2..12 (cli.py read --in-box); R1 has no box.
fn in_box(x: f64, y: f64) -> Problem {
    let mut u = unit("TP1", x, y, json!([[-1, -1, 1, 1, 0.3]]));
    u["in_box"] = json!([16.0, 2.0, 19.0, 12.0]);
    problem(json!([u, unit("R1", 5.0, 5.0, json!([[-1, -1, 1, 1, 0.5]]))]), json!([]), square_board(20.0, 0.5))
}

#[test]
fn inside_the_box_is_free_and_each_overshoot_counts_its_mm() {
    let oob = |x: f64, y: f64| start_terms(&in_box(x, y), &small_params(&[])).oob;
    near(oob(17.5, 6.0), 0.0);
    near(oob(15.5, 12.5), 3.0); // x 15.5: left side 14.5 (1.5 out); y 12.5: bottom 13.5 (1.5 out)
    near(oob(17.0, 3.0), 0.0); // spacing (0.3) is not in the box test: the courtyard may touch the box side
}

#[test]
fn a_unit_without_in_box_is_not_constrained() {
    near(terms(&in_box(17.5, 6.0), &[(17.5, 6.0, 0), (14.0, 15.0, 0)], &small_params(&[])).oob, 0.0);
}

#[test]
fn the_legal_penalty_is_positive_outside_the_box_and_a_move_takes_it_off() {
    let pr = in_box(5.0, 15.0); // left side x 4 is 12 mm left of x0 16; bottom y 16 is 4 mm below y1 12
    let p = small_params(&[]);
    let m = model(&pr, &p);
    let mut ev = Evaluator::new(&m, &p, &pr.initial_pose());
    near(ev.legal_penalty(0), 12.0 + 4.0);
    near(ev.legal_penalty_at(0, (17.5, 6.0, 0)), 0.0);
    assert!(ev.legal_penalty_at(0, (17.5, 1.5, 0)) > 0.0); // top 0.5 < 2.0
    near(ev.propose(&[(0, (17.5, 6.0, 0))]), -16.0 * p.w_oob);
    ev.commit();
    near(ev.legal_penalty(0), 0.0);
    within(ev.cost(), Evaluator::new(&m, &p, &ev.pose()).cost(), 5e-7);
}

#[test]
fn a_cohesion_net_costs_its_group_box_with_no_rudy_demand() {
    let cell = json!([[-1, -1, 1, 1, 0.5]]);
    let units = json!([unit("A", 2.0, 2.0, cell.clone()), unit("B", 8.0, 8.0, cell.clone()), unit("C", 5.0, 5.0, cell)]);
    let signal = json!({"name": "S", "weight": 1.0, "pins": [[0, 0, 0, 0, 0], [2, 0, 0, 0, 0]]});
    let cohesion = json!({"name": "~comp:X", "weight": 2.0, "pins": [[0, -1, -1, 1, 1], [1, -1, -1, 1, 1]], "track": 0.0, "cohesion": true});
    let board = box_board(10.0, 10.0);
    let (both, alone) = (problem(units.clone(), json!([signal, cohesion]), board.clone()), problem(units, json!([signal]), board));
    let p = small_params(&["limit=0.05", "tracks=1"]);
    near(start_terms(&both, &p).hpwl, 6.0 + 2.0 * 16.0); // group box 1..9 x 1..9: half perimeter 16
    assert_eq!(track_factor(&both.nets[1], &p), 0.0);
    let (with_net, without) = (start_terms(&both, &p).cong, start_terms(&alone, &p).cong);
    assert!(with_net > 0.0);
    near(with_net, without);
    let m = model(&both, &p);
    let mut ev = Evaluator::new(&m, &p, &both.initial_pose());
    let hpwl = ev.terms().hpwl;
    ev.propose(&[(1, (2.0, 6.0, 0))]); // B toward A: the group box shrinks
    near(ev.terms().hpwl - hpwl, -2.0 * 8.0);
}
