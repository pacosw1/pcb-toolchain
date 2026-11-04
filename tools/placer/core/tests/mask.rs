//! Forbidden area: the outline, keepouts, the copper-to-edge band, kept and locked copper, keepout gaps.

mod common;

use common::*;
use iotplace::evaluator::Evaluator;
use iotplace::params::Params;
use iotplace::problem::Problem;
use iotplace::search::legalize;
use serde_json::{Value, json};

/// The mask of the kept copper tests: 0.1 mm cells; the gap is the default 0.2 mm.
fn fine() -> Params {
    small_params(&["mask_cell=0.1"])
}

fn with_copper(rows: Value) -> Value {
    let mut b = square_board(10.0, 0.0);
    b["copper"] = rows;
    b
}

#[test]
fn front_copper_and_vias_are_obstacles_back_copper_is_not() {
    let board = with_copper(json!([["F.Cu", 2.0, 5.0, 8.0, 5.0, 0.2], ["B.Cu", 2.0, 3.0, 8.0, 3.0, 0.2], ["via", 5.0, 8.0, 5.0, 8.0, 0.6]]));
    let body = json!([[-0.5, -0.5, 0.5, 0.5, 0.5]]);
    let units = json!([
        unit("A", 5.0, 5.0, body.clone()),
        unit("B", 5.0, 3.0, body.clone()),
        unit("C", 5.0, 8.0, body),
        unit("D", 5.0, 1.5, json!([[-0.2, -0.2, 0.2, 0.2, 0.5]])),
    ]);
    let pr = problem(units, json!([]), board);
    let pose = pr.initial_pose();
    assert!(forbidden(&pr, &pose, &fine(), 0) > 0.0);
    near(forbidden(&pr, &pose, &fine(), 1), 0.0);
    assert!(forbidden(&pr, &pose, &fine(), 2) > 0.0);
    near(forbidden(&pr, &pose, &fine(), 3), 0.0);
}

fn body_on_a_via(pads: Value) -> Problem {
    let mut a = unit("A", 5.0, 5.0, json!([[-2, -2, 2, 2, 0.5]]));
    a["pad_rects"] = pads;
    problem(json!([a]), json!([]), with_copper(json!([["via", 5.0, 5.0, 5.0, 5.0, 0.6]])))
}

#[test]
fn copper_under_the_body_between_pads_is_no_obstacle_with_pad_rects() {
    // a via under the body of a part, clear of its pads (as under an LQFP), is legal when pad_rects are known
    let pr = body_on_a_via(json!([[-2, -2, -1.5, 2], [1.5, -2, 2, 2]]));
    near(forbidden(&pr, &pr.initial_pose(), &fine(), 0), 0.0);
}

#[test]
fn a_pad_on_the_via_is_an_obstacle_also_after_a_turn() {
    let pr = body_on_a_via(json!([[-0.5, -0.5, 0.5, 0.5]]));
    assert!(forbidden(&pr, &pr.initial_pose(), &fine(), 0) > 0.0);
    assert!(forbidden(&pr, &[(5.0, 5.0, 1)], &fine(), 0) > 0.0);
}

#[test]
fn the_courtyard_still_counts_against_the_board_edge() {
    let pr = body_on_a_via(json!([]));
    assert!(forbidden(&pr, &[(1.0, 5.0, 0)], &fine(), 0) > 0.0);
    near(forbidden(&pr, &[(5.0, 5.0, 0)], &fine(), 0), 0.0);
}

#[test]
fn the_legal_penalty_ignores_kept_copper_but_not_the_edge() {
    // the writer rips up kept copper that a moved pad lands on: copper is a cost, not a legality rule
    let mut a = unit("A", 5.0, 5.0, json!([[-1, -1, 1, 1, 0.5]]));
    a["pad_rects"] = json!([[-0.5, -0.5, 0.5, 0.5]]);
    let pr = problem(json!([a]), json!([]), with_copper(json!([["via", 5.0, 5.0, 5.0, 5.0, 0.6]])));
    let p = small_params(&[]);
    let m = model(&pr, &p);
    let mut ev = Evaluator::new(&m, &p, &pr.initial_pose());
    assert!(ev.forbidden_area(0) > 0.0);
    near(ev.legal_penalty(0), 0.0);
    near(ev.legal_penalty_at(0, (5.0, 5.0, 1)), 0.0);
    assert!(ev.legal_penalty_at(0, (0.5, 5.0, 0)) > 0.0);
}

#[test]
fn the_edge_clearance_and_a_keepout_count_as_forbidden_area() {
    let body = json!([[-0.5, -0.5, 0.5, 0.5, 0.5]]);
    let mut a = unit("A", 0.5, 0.5, body.clone());
    a["pad_rects"] = json!([[-0.5, -0.5, 0.5, 0.5]]); // the band is for copper (pads) only
    let mut board = square_board(10.0, 1.0);
    board["keepouts"] = json!([[[5, 5], [7, 5], [7, 7], [5, 7]]]);
    let pr = problem(json!([a, unit("B", 2.5, 2.5, body.clone()), unit("C", 5.5, 5.5, body)]), json!([]), board);
    let (pose, p) = (pr.initial_pose(), small_params(&[]));
    near(forbidden(&pr, &pose, &p, 0), 1.0);
    near(forbidden(&pr, &pose, &p, 1), 0.0);
    near(forbidden(&pr, &pose, &p, 2), 1.0);
}

#[test]
fn outside_the_grid_counts() {
    let pr = problem(json!([unit("A", -20.0, -20.0, json!([[-0.5, -0.5, 0.5, 0.5, 0.5]]))]), json!([]), square_board(10.0, 0.0));
    near(forbidden(&pr, &pr.initial_pose(), &small_params(&[]), 0), 1.0);
}

/// (legal penalty, forbidden area) with 0.05 mm cells.
fn legal_and_forbidden(pr: &Problem) -> [f64; 2] {
    let p = small_params(&["mask_cell=0.05"]);
    [legal_penalty(pr, &p, 0), forbidden(pr, &pr.initial_pose(), &p, 0)]
}

/// A 1 mm pad at pad_x0, a board keepout at x 10..12 with a gap of 0.75 mm for class 1.
fn pad_by_keepout(pad_x0: f64, class: i64) -> [f64; 2] {
    let rect = [pad_x0 - 5.0, -0.5, pad_x0 - 4.0, 0.5];
    let mut u = unit("A", 5.0, 10.0, json!([[rect[0], rect[1], rect[2], rect[3], 0.0]]));
    u["pad_rects"] = json!([rect]);
    if class != 0 {
        u["dom"] = json!([[0, class, 0.0, 0.2]]);
    }
    let mut b = square_board(20.0, 0.0);
    b["keepouts"] = json!([[[10, 0], [12, 0], [12, 20], [10, 20]]]);
    b["keepout_gaps"] = json!({"1": 0.75});
    legal_and_forbidden(&problem(json!([u]), json!([]), b))
}

#[test]
fn a_domain_pad_nearer_than_the_gap_is_illegal() {
    pad_by_keepout(8.5, 1).iter().for_each(|v| assert!(*v > 0.0)); // pad edge 9.5, keepout at 10: 0.5 mm < 0.75 mm
}

#[test]
fn a_domain_pad_beyond_the_gap_is_legal() {
    pad_by_keepout(8.2, 1).iter().for_each(|v| near(*v, 0.0)); // 0.8 mm
}

#[test]
fn a_pad_of_another_class_may_be_near_a_keepout() {
    pad_by_keepout(8.5, 0).iter().for_each(|v| near(*v, 0.0));
}

#[test]
fn a_gap_keepout_holds_the_gap_but_a_courtyard_may_cover_it() {
    // BACKUP-POWER BARRIER_*: tracks not allowed, footprints and pads allowed; only the creepage gap holds
    let pen = |pad_x0: f64, court_x1: f64| {
        let pad = [pad_x0 - 5.0, -0.5, pad_x0 - 4.0, 0.5];
        let rects = json!([[pad[0], -0.5, court_x1 - 5.0, 0.5, 0.0], [pad[0], -0.5, pad[2], 0.5, 0.0]]);
        let mut u = unit("A", 5.0, 10.0, rects);
        u["pad_rects"] = json!([pad]);
        u["mech"] = json!([0]);
        u["dom"] = json!([[1, 1, 0.0, 0.2]]);
        let mut b = square_board(20.0, 0.0);
        b["gap_keepouts"] = json!([[[10, 0], [12, 0], [12, 20], [10, 20]]]);
        b["keepout_gaps"] = json!({"1": 0.75});
        legal_and_forbidden(&problem(json!([u]), json!([]), b))
    };
    pen(8.2, 11.0).iter().for_each(|v| near(*v, 0.0)); // pad 0.8 mm off, courtyard 1 mm into the area
    pen(8.5, 9.5).iter().for_each(|v| assert!(*v > 0.0)); // pad 0.5 mm off
}

/// The copper-to-edge clearance applies to pads only; a courtyard 0.2 mm from the left edge.
fn band_part(pad_x0: f64, key: &str) -> Value {
    let mut u = unit("A", 5.0, 10.0, json!([[-4.8, -1, 1, 1, 0.0]]));
    u[key] = json!([[pad_x0 - 5.0, -0.5, pad_x0 - 4.0, 0.5]]);
    u
}

fn band_penalty(u: Value) -> f64 {
    legal_penalty(&problem(json!([u]), json!([]), square_board(20.0, 0.5)), &small_params(&[]), 0)
}

#[test]
fn a_courtyard_in_the_band_is_legal() {
    near(band_penalty(band_part(2.0, "pad_rects")), 0.0);
    near(band_penalty(band_part(2.0, "edge_pads")), 0.0);
}

#[test]
fn a_pad_in_the_band_is_illegal() {
    assert!(band_penalty(band_part(0.25, "pad_rects")) > 0.0);
    assert!(band_penalty(band_part(0.25, "edge_pads")) > 0.0);
}

#[test]
fn a_courtyard_outside_the_outline_is_illegal() {
    let mut u = band_part(2.0, "pad_rects");
    u["x"] = json!(4.0);
    assert!(band_penalty(u) > 0.0);
}

/// 1 mm over the bottom edge (y 20); BASE-PWR U1_ANTENNA over the outline notch.
fn overhang(keepout: Option<[f64; 4]>) -> f64 {
    let mut u = unit("U1", 10.0, 18.0, json!([[-3, -3, 3, 3, 0.0]]));
    if let Some([x0, y0, x1, y1]) = keepout {
        u["rects"].as_array_mut().unwrap().push(json!([x0, y0, x1, y1, 0.0]));
        u["ko"] = json!([1]);
    }
    legal_penalty(&problem(json!([u]), json!([]), square_board(20.0, 0.0)), &small_params(&[]), 0)
}

#[test]
fn the_overhang_inside_its_own_keepout_is_legal() {
    near(overhang(Some([-4.0, 1.5, 4.0, 6.0])), 0.0);
}

#[test]
fn the_overhang_without_a_keepout_is_illegal() {
    assert!(overhang(None) > 0.0);
}

#[test]
fn the_overhang_beyond_its_keepout_is_illegal() {
    assert!(overhang(Some([-1.0, 1.5, 1.0, 6.0])) > 0.0); // the keepout covers 2 of the 6 mm
}

/// A pad at pad_x near a locked track at x 11.5.
fn locked(pad_x: f64) -> f64 {
    let mut u = unit("A", 10.0, 10.0, json!([[-2, -1, 2, 1, 0.0]]));
    u["pad_rects"] = json!([[pad_x - 10.25, -0.25, pad_x - 9.75, 0.25]]);
    let mut board = square_board(20.0, 0.0);
    board["fixed_copper"] = json!([["F.Cu", 11.5, 5.0, 11.5, 15.0, 0.2]]);
    legal_penalty(&problem(json!([u]), json!([]), board), &small_params(&[]), 0)
}

#[test]
fn a_pad_over_fixed_copper_is_illegal() {
    assert!(locked(11.5) > 0.0);
}

#[test]
fn a_courtyard_over_fixed_copper_is_legal() {
    near(locked(8.5), 0.0);
}

/// TP7 with a pad on a locked row. `membership` None: no layer list for the pad. `legacy`: no layer rows on the board.
fn layered(layer: &str, membership: Option<Value>, legacy: bool) -> Problem {
    let mut u = unit("TP7", 113.0, 101.7, json!([[-1.75, -1.75, 1.75, 1.75, 0.0]]));
    u["pad_rects"] = json!([[-1.25, -1.25, 1.25, 1.25]]);
    if let Some(m) = membership {
        u["pad_copper_layers"] = json!([m]);
    }
    let row = json!([layer, 114.6, 100.95, 111.0, 100.95, 0.2]);
    let mut board = square_board(150.0, 0.0);
    board["fixed_copper"] = json!([row]);
    if !legacy {
        board["fixed_copper_layers"] = json!([row]);
    }
    problem(json!([u]), json!([]), board)
}

#[test]
fn a_pth_over_locked_bottom_or_inner_copper_is_hard_illegal() {
    for layer in ["B.Cu", "In2.Cu"] {
        let pr = layered(layer, Some(json!(["F.Cu", "In2.Cu", "B.Cu"])), false);
        let p = small_params(&["legal_radius=0", "legal_time=5"]);
        let m = model(&pr, &p);
        let mut ev = Evaluator::new(&m, &p, &pr.initial_pose());
        assert!(ev.legal_penalty(0) > 0.0);
        assert!(ev.legal_penalty_at(0, (113.0, 101.7, 0)) > 0.0);
        assert!(ev.forbidden_area(0) > 0.0);
        // A zero-radius pass cannot claim a collision is legal.
        assert_eq!(legalize(&mut ev, &p).unwrap(), vec![0]);
    }
}

#[test]
fn a_top_smd_over_bottom_copper_remains_legal() {
    let pr = layered("B.Cu", Some(json!(["F.Cu"])), false);
    let p = small_params(&[]);
    let m = model(&pr, &p);
    let mut ev = Evaluator::new(&m, &p, &pr.initial_pose());
    assert_eq!(ev.legal_penalty(0), 0.0);
    assert_eq!(ev.forbidden_area(0), 0.0);
    assert!(ev.legal_penalty_at(0, (151.0, 101.7, 0)) > 0.0);
}

#[test]
fn a_bottom_smd_and_a_spanned_via_use_only_shared_layers() {
    for (membership, bad) in [(json!(["B.Cu"]), true), (json!(["F.Cu"]), false), (json!([]), false)] {
        let pr = layered("B.Cu", Some(membership), false);
        assert_eq!(legal_penalty(&pr, &small_params(&[]), 0) > 0.0, bad);
    }
}

#[test]
fn a_missing_membership_and_an_unspanned_via_are_conservative() {
    for (layer, membership) in [("B.Cu", None), ("via", Some(json!(["F.Cu"])))] {
        assert!(legal_penalty(&layered(layer, membership, true), &small_params(&[]), 0) > 0.0);
    }
}
