//! Spacing of unit pairs: hard overlap (what KiCad DRC enforces) and the soft D-040 halo.

mod common;

use common::*;
use iotplace::problem::{Place, Problem};
use serde_json::{Value, json};

fn board60() -> Value {
    square_board(60.0, 0.0)
}

fn overlap_of(pr: &Problem) -> f64 {
    start_terms(pr, &small_params(&[])).overlap
}

fn overlap(units: Value) -> f64 {
    overlap_of(&problem(units, json!([]), board60()))
}

/// The full penalty of two units at the origin: hard overlap + soft spacing.
fn pair_penalty(a: Value, b: Value) -> f64 {
    let pr = problem(json!([unit("A", 0.0, 0.0, a), unit("B", 0.0, 0.0, b)]), json!([]), square_board(10.0, 0.0));
    let t = start_terms(&pr, &small_params(&[]));
    t.overlap + t.spacing
}

#[test]
fn the_pair_penalty_counts_below_the_gap() {
    // x: 1 - 1.3 + 0.5 = 0.2; y: 1 - 0 + 0.5 = 1.5: 0.3
    near(pair_penalty(json!([[0, 0, 1, 1, 0.5]]), json!([[1.3, 0, 2.3, 1, 0.5]])), 0.3);
    near(pair_penalty(json!([[0, 0, 1, 1, 0.5]]), json!([[1.6, 0, 2.6, 1, 0.5]])), 0.0);
}

#[test]
fn an_ic_class_needs_a_larger_gap() {
    near(pair_penalty(json!([[0, 0, 1, 1, 1.0]]), json!([[1.6, 0, 2.6, 1, 0.5]])), 0.4 * 2.0);
}

fn two_rects_and_one(b_rect: Value, x: f64) -> Value {
    let a = unit("A", x, 2.0, json!([[0, 0, 1, 1, 0.5], [0.5, 0, 1.5, 1, 0.5]]));
    json!([a, unit("B", x + 1.3, 2.0, json!([b_rect]))])
}

#[test]
fn each_pair_counts_once_and_a_unit_not_with_itself() {
    // A-B: rect 1 x term 0.2: 0.3; rect 2: 1.5 - 1.3 + 0.5 = 0.7: 1.05. Inside A: not counted.
    // Hard: only rect 2 meets B (0.2 x 1 = 0.2); the rest of the D-040 halo is soft spacing.
    let t = start_terms(&problem(two_rects_and_one(json!([0, 0, 1, 1, 0.5]), 0.0), json!([]), square_board(10.0, 0.0)), &small_params(&[]));
    near(t.overlap, 0.2);
    near(t.spacing, 1.15);
}

#[test]
fn the_terms_follow_the_pose_the_rects_and_the_fixed_flags() {
    let p = small_params(&[]);
    let board = || square_board(10.0, 0.0);
    let pr = problem(two_rects_and_one(json!([0, 0, 1, 1, 0.5]), 2.0), json!([]), board());
    let pose = pr.initial_pose();
    let t = terms(&pr, &pose, &p);
    near(t.overlap, 0.2);
    near(t.spacing, 1.15);
    let apart: [Place; 2] = [pose[0], (7.0, 2.0, 1)];
    let t = terms(&pr, &apart, &p);
    assert_eq!((t.overlap, t.spacing), (0.0, 0.0));
    let wider = two_rects_and_one(json!([0, 0, 2, 1, 1]), 2.0);
    assert!(terms(&problem(wider.clone(), json!([]), board()), &pose, &p).spacing > 1.15);
    let mut fixed = wider;
    fixed[0]["fixed"] = json!(true);
    fixed[1]["fixed"] = json!(true);
    let t = terms(&problem(fixed, json!([]), board()), &pose, &p);
    assert_eq!((t.overlap, t.spacing), (0.0, 0.0));
}

#[test]
fn fixed_pairs_do_not_count() {
    let rect = json!([[0, 0, 1, 1, 0.5]]);
    near(overlap(json!([fixed_unit("A", 0.0, 0.0, rect.clone()), fixed_unit("B", 0.0, 0.0, rect)])), 0.0);
}

#[test]
fn changed_class_gaps_change_the_overlap() {
    let domain_unit = |name: &str, x: f64, class: i64| {
        let mut u = unit(name, x, 20.0, json!([[-1, -1, 1, 1, 0.5], [-0.5, -0.5, 0.5, 0.5, 0.2]]));
        u["dom"] = json!([[1, class, 0.0, 0.2]]);
        u["mech"] = json!([0]);
        u
    };
    let with_gap = |gap: f64| {
        let mut v = problem_json(json!([domain_unit("A", 10.0, 1), domain_unit("B", 14.0, 2)]), json!([]), board60());
        v["class_gaps"] = json!({"names": ["FIELD", "HOST"], "gaps": [[0, 0, 0], [0, 0, gap], [0, gap, 0]]});
        parse(v)
    };
    assert!(overlap_of(&with_gap(4.0)) > 0.0);
    near(overlap_of(&with_gap(0.0)), 0.0);
}

/// A courtyard with a pad-clearance rect beside a neighbour: pad edge 5.5, B courtyard 6.3 (0.8 < 1.5).
fn halo(hard: bool) -> Problem {
    let mut a = unit("A", 5.0, 5.0, json!([[-1, -1, 1, 1, 0.5], [-0.5, -0.5, 0.5, 0.5, 1.5]]));
    if hard {
        a["hard"] = json!([1]);
    }
    problem(json!([a, unit("B", 7.3, 5.0, json!([[-1, -1, 1, 1, 0.5]]))]), json!([]), square_board(20.0, 0.0))
}

#[test]
fn the_d040_halo_is_soft_and_legal() {
    let pr = halo(false);
    let p = small_params(&["w_sp=3"]);
    let t = start_terms(&pr, &p);
    near(t.overlap, 0.0);
    assert!(t.spacing > 0.0);
    near(legal_penalty(&pr, &p, 1), 0.0);
}

#[test]
fn a_pad_clearance_rect_is_hard() {
    let pr = halo(true);
    let p = small_params(&[]);
    assert!(start_terms(&pr, &p).overlap > 0.0);
    assert!(legal_penalty(&pr, &p, 1) > 0.0);
}

/// A: a part at (5, 5) with a keepout rect to its right; B: a part at bx with a keepout rect to its left.
fn keepouts(bx: f64) -> Problem {
    let mut a = unit("A", 5.0, 5.0, json!([[-1, -1, 1, 1, 0.5], [1, -1, 4, 1, 0.0]]));
    let mut b = unit("B", bx, 5.0, json!([[-1, -1, 1, 1, 0.5], [-4, -1, -1, 1, 0.0]]));
    a["ko"] = json!([1]);
    b["ko"] = json!([1]);
    let mut board = square_board(30.0, 0.0);
    board["keepouts"] = json!([[[7, 3], [9, 3], [9, 7], [7, 7]]]);
    problem(json!([a, b]), json!([]), board)
}

#[test]
fn keepout_over_keepout_is_legal() {
    let pr = keepouts(12.0); // A keepout 6..9 over the board keepout 7..9 and over B keepout 8..11
    let p = small_params(&[]);
    let t = start_terms(&pr, &p);
    near(t.overlap, 0.0);
    near(t.oob, 0.0);
    near(legal_penalty(&pr, &p, 0), 0.0);
    near(legal_penalty(&pr, &p, 1), 0.0);
    near(forbidden(&pr, &pr.initial_pose(), &p, 1), 0.0);
}

#[test]
fn a_courtyard_in_a_keepout_rect_stays_illegal() {
    let pr = keepouts(9.5); // B courtyard 8.5..10.5 is in A keepout 6..9
    let p = small_params(&[]);
    assert!(legal_penalty(&pr, &p, 1) > 0.0);
    assert!(start_terms(&pr, &p).overlap > 0.0);
}

/// BASE-PWR H1 inside U1_ANTENNA: the rule area forbids copper, not footprints.
fn over_a_hole(keepout: bool) -> f64 {
    let mut a = unit("U1", 10.0, 10.0, json!([[-1, -1, 1, 1, 0.0], [-5, -5, 5, 5, 0.0]]));
    a["ko"] = if keepout { json!([1]) } else { json!([]) };
    let mut h = fixed_unit("H1", 13.0, 10.0, json!([[-1, -1, 1, 1, 0.0]]));
    h["nocu"] = json!(true);
    legal_penalty(&problem(json!([a, h]), json!([]), square_board(30.0, 0.0)), &small_params(&[]), 0)
}

#[test]
fn a_keepout_over_a_no_copper_part_is_legal() {
    near(over_a_hole(true), 0.0);
}

#[test]
fn a_courtyard_over_a_no_copper_part_is_illegal() {
    assert!(over_a_hole(false) > 0.0);
}

/// Round courtyards: a box with corners rounded by the radius, a circle when the box is square.
fn circles(dx: f64, dy: f64) -> f64 {
    let mut a = unit("A", 10.0, 10.0, json!([[-1.3, -1.3, 1.3, 1.3, 0.0]]));
    let mut b = unit("B", 10.0 + dx, 10.0 + dy, json!([[-1.8, -1.8, 1.8, 1.8, 0.0]]));
    a["rho"] = json!([[0, 1.3]]);
    b["rho"] = json!([[0, 1.8]]);
    overlap_of(&problem(json!([a, b]), json!([]), square_board(40.0, 0.0)))
}

#[test]
fn circles_apart_on_a_diagonal_are_legal() {
    near(circles(1.0, 2.94), 0.0); // centres 3.105 apart, radii 3.1
}

#[test]
fn circles_that_meet_are_illegal() {
    assert!(circles(1.0, 2.8) > 0.0); // centres 2.97 apart
}

/// KiCad DRC measures a clearance as the true distance (INPUT-4D2A U14 to U3: dx 2.66, dy 3.20, distance 4.17 mm,
/// barrier 4 mm).
fn corner(dx: f64, dy: f64) -> f64 {
    let mut a = unit("A", 10.0, 10.0, json!([[0, 0, 1, 1, 4.0]]));
    let mut b = unit("B", 11.0 + dx, 11.0 + dy, json!([[0, 0, 1, 1, 4.0]]));
    a["hard"] = json!([0]);
    b["hard"] = json!([0]);
    overlap_of(&problem(json!([a, b]), json!([]), square_board(40.0, 0.0)))
}

#[test]
fn a_corner_farther_than_the_gap_is_legal() {
    near(corner(2.66, 3.20), 0.0);
}

#[test]
fn a_corner_nearer_than_the_gap_is_illegal() {
    assert!(corner(2.5, 2.8) > 0.0); // distance 3.75
}

#[test]
fn one_axis_apart_keeps_the_box_penalty() {
    near(corner(3.0, -0.5), 1.0 * 4.5); // x: 4 - 3 mm, y: 0.5 mm overlap + 4 mm
}

/// A courtyard of 2 x 2 mm inside a block border of 6 x 6 mm.
fn block(name: &str, x: f64) -> Value {
    let mut u = unit(name, x, 10.0, json!([[-1, -1, 1, 1, 0.0], [-3, -3, 3, 3, 0.0]]));
    u["border"] = json!([1]);
    u
}

fn check_border(units: Value, hard: bool) {
    let pr = problem(units, json!([]), square_board(40.0, 0.0));
    let p = small_params(&[]);
    let t = start_terms(&pr, &p);
    assert_eq!(t.overlap > 0.0, hard, "{}", t.overlap);
    assert!(t.spacing > 0.0);
    assert_eq!(legal_penalty(&pr, &p, 1) > 0.0, hard);
}

#[test]
fn a_border_over_a_border_is_soft() {
    check_border(json!([block("A", 10.0), block("B", 14.0)]), false);
}

#[test]
fn a_border_over_a_foreign_part_is_soft() {
    check_border(json!([block("A", 10.0), unit("R", 12.5, 10.0, json!([[-1, -1, 1, 1, 0.0]]))]), false);
}

#[test]
fn a_courtyard_over_a_courtyard_stays_hard() {
    check_border(json!([block("A", 10.0), unit("R", 11.5, 10.0, json!([[-1, -1, 1, 1, 0.0]]))]), true);
}

fn barrier_pad(name: &str, x: f64, class: i64) -> Value {
    let mut u = unit(name, x, 20.0, json!([[-1, -1, 1, 1, 0.5], [-0.5, -0.5, 0.5, 0.5, 0.2]]));
    u["dom"] = json!([[1, class, 0.0, 0.2]]);
    u["mech"] = json!([0]);
    u
}

/// The IO-6X6 barrier: FIELD to HOST 4 mm.
fn barrier(units: Value) -> f64 {
    let mut v = problem_json(units, json!([]), board60());
    v["class_gaps"] = json!({"names": ["FIELD", "HOST"], "gaps": [[0, 0, 0], [0, 0, 4.0], [0, 4.0, 0]]});
    overlap_of(&parse(v))
}

#[test]
fn the_two_sets_keep_the_barrier_gap() {
    assert!(barrier(json!([barrier_pad("A", 10.0, 1), barrier_pad("B", 14.0, 2)])) > 0.0); // pads 3 mm
    near(barrier(json!([barrier_pad("A", 10.0, 1), barrier_pad("B", 15.2, 2)])), 0.0); // 4.2 mm
}

#[test]
fn one_set_to_other_nets_keeps_the_net_clearance() {
    near(barrier(json!([barrier_pad("A", 10.0, 1), unit("R", 12.3, 20.0, json!([[-1, -1, 1, 1, 0.5]]))])), 0.0);
    near(barrier(json!([barrier_pad("A", 10.0, 1), barrier_pad("C", 12.5, 1)])), 0.0);
}

#[test]
fn two_classes_without_a_rule_keep_the_net_clearance() {
    // the pad fills the courtyard: only the pad gap is left
    let edge_pad = |name: &str, x: f64, class: i64| {
        let mut u = unit(name, x, 20.0, json!([[-1, -1, 1, 1, 0.0], [-1, -1, 1, 1, 0.2]]));
        u["dom"] = json!([[1, class, 0.0, 0.2]]);
        u["mech"] = json!([0]);
        u
    };
    let mut v = problem_json(json!([edge_pad("A", 10.0, 1), edge_pad("B", 12.1, 3)]), json!([]), board60()); // 0.1 mm apart
    v["class_gaps"] = json!({"names": ["", "FIELD", "HOST", "OTHER"], "gaps": vec![vec![0.0; 4]; 4]});
    assert!(overlap_of(&parse(v)) > 0.0);
}

/// A pad of a domain with rect clearance 8 mm to other nets, 3 mm to another class, 0.5 mm in its class.
fn mains(name: &str, x: f64, class: i64) -> Value {
    let mut u = unit(name, x, 20.0, json!([[-1, -1, 1, 1, 0.5], [-0.5, -0.5, 0.5, 0.5, 8.0]]));
    u["dom"] = json!([[1, class, 3.0, 0.5]]);
    u["mech"] = json!([0]);
    u
}

#[test]
fn other_nets_keep_the_domain_gap() {
    let selv = |x: f64| unit("R", x, 20.0, json!([[-1, -1, 1, 1, 0.5]]));
    assert!(overlap(json!([mains("K1", 10.0, 1), selv(10.0 + 0.5 + 6.7 + 1.0)])) > 0.0);
    near(overlap(json!([mains("K1", 10.0, 1), selv(10.0 + 0.5 + 8.1 + 1.0)])), 0.0);
}

#[test]
fn two_domain_classes_keep_the_class_gap_and_one_class_the_net_clearance() {
    // pad edges 4 mm apart; courtyards stay 2 mm apart
    near(overlap(json!([mains("K1", 10.0, 1), mains("K2", 15.0, 2)])), 0.0);
    assert!(overlap(json!([mains("K1", 10.0, 1), mains("K2", 12.8, 2)])) > 0.0);
    near(overlap(json!([mains("K1", 10.0, 1), mains("J1", 12.8, 1)])), 0.0);
}

#[test]
fn a_block_border_rect_keeps_its_own_class_only() {
    let mut b = unit("B", 20.0, 20.0, json!([[-1, -1, 1, 1, 0.5], [-8, -2, 8, 2, 0.0]])); // its part 8.5 mm from the pad
    b["mech"] = json!([1]);
    near(overlap(json!([mains("K1", 10.0, 1), b])), 0.0); // pad 1.5 mm from the border
    let mut b = unit("B", 19.6, 20.0, json!([[7, -1, 9, 1, 0.5], [-8, -2, 8, 2, 0.0]])); // border 1.1 mm from the pad
    b["mech"] = json!([1]);
    near(overlap(json!([mains("K1", 10.0, 1), b])), 0.0);
}

#[test]
fn a_hole_rule_keeps_its_gap_to_domain_pads_only() {
    let mut h = fixed_unit("H", 20.0, 20.0, json!([[-2, -2, 2, 2, 0.0], [-1, -1, 1, 1, 0.0]])); // courtyard, NPTH hole
    h["dom"] = json!([[1, -1, 9.65, 0.0]]);
    h["mech"] = json!([0]);
    assert!(overlap(json!([mains("K1", 10.0, 1), h])) > 0.0); // pad 8.5 mm from the hole; the pair search sees 9.65 mm
    near(overlap(json!([mains("K1", 8.0, 1), h])), 0.0); // 10.5 mm
    near(overlap(json!([unit("R", 16.0, 20.0, json!([[-1, -1, 1, 1, 0.5]])), h])), 0.0); // other parts: courtyard rule only
}

#[test]
fn a_slot_next_to_a_domain_pad_is_legal() {
    let mut s = unit("S", 12.6, 30.0, json!([[-1, -1, 1, 1, 0.5], [-1, -11, 1, -9, 0.0]])); // slot 1.1 mm from the pad
    s["ko"] = json!([1]);
    near(overlap(json!([mains("K1", 10.0, 1), s])), 0.0);
}
