//! The detour searches and the screens around them: the values of tools/test_si_detour_correctness.py, test_si_d124c_screen.py,
//! test_si_unknown_waste.py and the DetourTest of test_si_planes.py.
use super::super::detour::{Plane, d124c_detour_mm, detour_mm};
use super::super::native::single_leaf_candidate;
use super::super::projection::{Boundaries, Edge as Line, continuous_reference};
use super::super::sample::{NetResult, P, Run, Terminal};
use super::super::screen::{Assessment, Edges, d124c_net_edge, d124c_reference_failures, planes_outcome, reference_assessment};
use super::super::spec::Spec;
use super::{domain_of, edges_of, known, one, terminal};
use crate::si::drivers::Edge;
use crate::si::fixture::{near, spec};
use std::cell::RefCell;

pub(super) fn rectangle(x0: f64, y0: f64, x1: f64, y1: f64) -> Vec<Line> {
    let ring = [(x0, y0), (x1, y0), (x1, y1), (x0, y1)];
    (0..4).map(|i| (ring[i], ring[(i + 1) % 4])).collect()
}

/// A plane: its copper and the boundaries of that copper.
pub(super) struct Plate<'a> {
    pub ok: &'a dyn Fn(f64, f64) -> bool,
    pub lines: Vec<Line>,
}

impl Plate<'_> {
    pub fn edge(&self, a: P, b: P) -> bool {
        continuous_reference(self.ok, &Boundaries { index: None, extra: self.lines.clone() }, a, b, &[])
    }
}

pub(super) fn search(plane: &Plate, alternate: Option<&Plate>, terminals: &[Terminal], budget: f64, cell: f64, portals: &[P]) -> Option<f64> {
    let edge = |a: P, b: P| plane.edge(a, b);
    let first = Plane { ok: plane.ok, edge: &edge };
    match alternate {
        None => detour_mm(first, None, terminals, budget, cell, portals),
        Some(alt) => {
            let other = |a: P, b: P| alt.edge(a, b);
            detour_mm(first, Some(Plane { ok: alt.ok, edge: &other }), terminals, budget, cell, portals)
        }
    }
}

fn all_copper(_: f64, _: f64) -> bool {
    true
}

fn solid() -> Plate<'static> {
    Plate { ok: &all_copper, lines: Vec::new() }
}

// DetourTest

#[test]
fn a_straight_gap_with_copper_beside_it_is_short() {
    // Copper everywhere except a 1 mm wide strip x in (4.5, 5.5), y < 0.5: the return goes round the strip end.
    let ok = |x: f64, y: f64| !(4.5 < x && x < 5.5 && y < 0.5);
    let plate = Plate { ok: &ok, lines: rectangle(4.5, -100.0, 5.5, 0.5) };
    let d = search(&plate, None, &[terminal(4.4, 0.0, 0.1), terminal(5.6, 0.0, 0.1)], 6.7, 0.1, &[]).unwrap();
    assert!(d < 3.0, "{d}");
}

#[test]
fn a_long_slot_forces_a_long_detour() {
    // A 0.5 mm slot from y = -15 to y = 15: the return path goes round an end, about 30 mm.
    let ok = |x: f64, y: f64| !(4.75 < x && x < 5.25 && -15.0 < y && y < 15.0);
    let plate = Plate { ok: &ok, lines: rectangle(4.75, -15.0, 5.25, 15.0) };
    let ends = [terminal(4.6, 0.0, 0.1), terminal(5.4, 0.0, 0.1)];
    assert_eq!(search(&plate, None, &ends, 6.7, 0.1, &[]), None);
    assert!(search(&plate, None, &ends, 40.0, 0.2, &[]).unwrap() > 29.0);
}

#[test]
fn ground_vias_join_cut_plane_pieces() {
    // An In2 lane cuts the plane fully (x in 4.75..5.25 for all y): the return goes down a ground via on each side
    // (at (4, 1) and (6, 1)) and through the solid plane below.
    let ok = |x: f64, _: f64| !(4.75 < x && x < 5.25);
    let plate = Plate { ok: &ok, lines: rectangle(4.75, -100.0, 5.25, 100.0) };
    let ends = [terminal(4.6, 0.0, 0.1), terminal(5.4, 0.0, 0.1)];
    assert_eq!(search(&plate, None, &ends, 6.7, 0.1, &[]), None);
    let d = search(&plate, Some(&solid()), &ends, 6.7, 0.1, &[(4.0, 1.0), (6.0, 1.0)]).unwrap();
    assert!((d - (1.25 + 2.0 + 1.25)).abs() <= 0.2, "{d}"); // positive exact access cost, no shaved terminal radius
}

#[test]
fn no_copper_is_unreachable() {
    assert_eq!(search(&Plate { ok: &|_, _| false, lines: Vec::new() }, None, &[terminal(0.0, 0.0, 0.1), terminal(1.0, 0.0, 0.1)], 6.7, 0.1, &[]), None);
}

// Counterexamples of the continuous search

fn strip_ok(x: f64, y: f64) -> bool {
    (-1.0..=6.0).contains(&x) && (-2.0..=2.0).contains(&y) && !(0.21 < x && x < 0.39)
}

fn board_ok(x: f64, y: f64) -> bool {
    (-1.0..=6.0).contains(&x) && (-2.0..=2.0).contains(&y)
}

fn plane_with_strip() -> Plate<'static> {
    let mut lines = rectangle(-1.0, -2.0, 6.0, 2.0);
    lines.extend(rectangle(0.21, -2.0, 0.39, 2.0));
    Plate { ok: &strip_ok, lines }
}

const ENDS: [Terminal; 2] = [Terminal { x: 0.0, y: 0.0, snap: 0.01 }, Terminal { x: 5.0, y: 0.0, snap: 0.01 }];
const PORTALS: [P; 2] = [(0.0, 0.0), (5.0, 0.0)];

#[test]
fn a_coarse_grid_cannot_jump_a_thin_domain_break() {
    for cell in [0.1, 0.5] {
        assert_eq!(search(&plane_with_strip(), None, &ENDS, 100.0, cell, &[]), None);
    }
}

#[test]
fn portals_cannot_invent_alternate_copper() {
    let plate = plane_with_strip();
    assert_eq!(search(&plate, None, &ENDS, 100.0, 0.5, &PORTALS), None);
    assert_eq!(search(&plate, Some(&plane_with_strip()), &ENDS, 100.0, 0.5, &PORTALS), None);
}

#[test]
fn portals_transfer_only_through_an_actual_alternate_plane() {
    let alt = Plate { ok: &board_ok, lines: rectangle(-1.0, -2.0, 6.0, 2.0) };
    near(search(&plane_with_strip(), Some(&alt), &ENDS, 100.0, 0.5, &PORTALS).unwrap(), 5.0);
}

#[test]
fn a_hole_on_the_alternate_plane_forces_a_real_detour() {
    let ok = |x: f64, y: f64| board_ok(x, y) && !(2.0 < x && x < 3.0 && -1.0 < y && y < 1.0);
    let mut lines = rectangle(-1.0, -2.0, 6.0, 2.0);
    lines.extend(rectangle(2.0, -1.0, 3.0, 1.0));
    let alt = Plate { ok: &ok, lines };
    assert!(search(&plane_with_strip(), Some(&alt), &ENDS, 100.0, 0.5, &PORTALS).unwrap() > 5.0);
    assert_eq!(search(&plane_with_strip(), Some(&alt), &ENDS, 5.01, 0.5, &PORTALS), None);
}

#[test]
fn absent_terminals_are_no_proven_stub() {
    let none = Plate { ok: &|_, _| false, lines: Vec::new() };
    assert_eq!(search(&none, None, &[], 100.0, 0.1, &[]), None);
    assert_eq!(search(&none, None, &[terminal(0.0, 0.0, 0.1)], 100.0, 0.1, &[]), None);
}

#[test]
fn a_snap_overlap_does_not_erase_the_actual_length() {
    near(search(&solid(), None, &[terminal(0.0, 0.0, 0.5), terminal(0.2, 0.0, 0.5)], 10.0, 0.5, &[]).unwrap(), 0.2);
}

#[test]
fn off_grid_portals_keep_their_distance() {
    let d = search(&plane_with_strip(), Some(&solid()), &ENDS, 100.0, 0.5, &[(0.03, 0.0), (4.97, 0.0)]).unwrap();
    assert!(d >= 5.0, "{d}");
}

#[test]
fn a_cap_boundary_is_not_bridged_by_free_endpoints() {
    let ok = |x: f64, _: f64| x.abs() <= 0.1 || (x - 1.0).abs() <= 0.1;
    assert!(!continuous_reference(&ok, &Boundaries::default(), (0.0, 0.0), (1.0, 0.0), &[((0.0, 0.0), 0.1), ((1.0, 0.0), 0.1)]));
}

fn leaf(terminals: Vec<Terminal>, bad_points: Vec<P>) -> Run {
    Run { terminals, bad_points, ..Run::default() }
}

#[test]
fn a_straight_leaf_needs_a_contiguous_reference_prefix() {
    let run = leaf(vec![terminal(4.9, 0.0, 0.1)], vec![(5.1, 0.0), (7.9, 0.0)]);
    let reference = |x: f64, _: f64| x <= 5.0;
    let breaks = |_: P, _: P| vec![0.0, 0.5, 1.0];
    let (a, e) = ((2.0, 0.0), (8.0, 0.0));
    assert_eq!(single_leaf_candidate(a, e, &run, &reference, &breaks), Some((a, (5.0, 0.0), e)));
    assert_eq!(single_leaf_candidate(a, e, &run, &|_, _| false, &breaks), None);
    assert_eq!(single_leaf_candidate(a, e, &leaf(Vec::new(), run.bad_points.clone()), &reference, &breaks), None);
    assert_eq!(single_leaf_candidate(a, e, &leaf(run.terminals.clone(), vec![(6.0, 0.01)]), &reference, &breaks), None);
}

#[test]
fn a_gap_before_the_leaf_is_no_single_attachment() {
    let run = leaf(vec![terminal(4.9, 0.0, 0.1)], vec![(7.9, 0.0)]);
    let reference = |x: f64, _: f64| x <= 5.0 && !(3.0 < x && x < 4.0);
    let breaks = |_: P, _: P| vec![0.0, 1.0 / 6.0, 2.0 / 6.0, 0.5, 1.0];
    assert_eq!(single_leaf_candidate((2.0, 0.0), (8.0, 0.0), &run, &reference, &breaks), None);
}

// The screens side by side

fn screen_spec() -> Spec {
    spec(&[("adjacent", r#"{"F.Cu": "In1.Cu"}"#), ("plane_layers", r#"["In1.Cu"]"#), ("grounds", r#"["GND"]"#)])
}

fn result(terminals: Vec<Terminal>, length: f64) -> NetResult {
    let runs = vec![Run { length, at: (0.0, 0.0), terminals, net: "/SIG".to_string(), ..Run::default() }];
    NetResult { runs, worst: length, worst_at: Some((0.0, 0.0)), ..NetResult::default() }
}

fn lines(items: &[&str]) -> Vec<String> {
    items.iter().map(|l| l.to_string()).collect()
}

#[test]
fn a_stub_passes_the_enforced_screen_and_a_proposed_finding_is_not_counted() {
    let s = screen_spec();
    let edges = edges_of(&[("/SIG", Edge::Unknown("missing driver".to_string()))]);
    let (stub, domains) = (one("F.Cu", "/SIG", result(vec![terminal(0.0, 0.0, 0.1)], 0.2)), domain_of("/SIG", Some("GND")));
    // D-124c: a run with one terminal is a stub (detour 0), it passes at any edge.
    let mut detour = |_: &str, _: &str, run: &Run, budget: f64| d124c_detour_mm(&|_, _| true, &run.terminals, budget, 0.1, &[]);
    let enforced = d124c_reference_failures(&stub, &domains, &s, &edges, &mut detour, 200.0).unwrap();
    assert_eq!(enforced, [""; 0]);
    // D-124d proposal: an unproven stub has no detour, so it needs an edge time.
    let proposed = reference_assessment(&stub, &domains, &s, &edges, &mut |_, _, _, _| None, 200.0).unwrap();
    assert_eq!(proposed.screen.len(), 1);
    let (fails, report) = planes_outcome(Vec::new(), &enforced, &proposed);
    assert_eq!(fails, [""; 0]);
    assert!(report.iter().any(|l| l.starts_with("WARN D-124d-proposed unknown-driver F.Cu /SIG:")));
    assert!(!report.iter().any(|l| l.starts_with("FAIL ")));
}

#[test]
fn an_enforced_finding_is_counted_once_and_never_dropped() {
    let enforced = lines(&["FAIL detour B.Cu /A: 1 of 1 crossings ... detour 9.0 mm", "FAIL unknown-driver B.Cu /B: ..."]);
    let assessment = Assessment {
        screen: lines(&["FAIL detour B.Cu /A: 1 of 1 crossings ... detour 9.4 mm", "FAIL unknown-driver B.Cu /C: ..."]),
        evidence: lines(&["FAIL unproved-fastest-edge B.Cu /A: ..."]),
    };
    let geometry = lines(&["FAIL plane-cut In1.Cu /X: 1.0 mm of track"]);
    let (fails, report) = planes_outcome(geometry.clone(), &enforced, &assessment);
    // /B is found by the enforced screen only: it stays counted (no loosening).
    assert_eq!(fails, [geometry, enforced].concat());
    let warns: Vec<&String> = report.iter().filter(|l| l.starts_with("WARN D-124d-proposed")).collect();
    assert_eq!(warns, ["WARN D-124d-proposed unknown-driver B.Cu /C: ..."]);
    assert!(report.iter().any(|l| l == "WARN unproved-fastest-edge B.Cu /A: ..."));
}

#[test]
fn a_d124c_class_applies_to_its_nets() {
    let s = spec(&[("adjacent", r#"{"F.Cu": "In1.Cu"}"#), ("plane_layers", r#"["In1.Cu"]"#), ("grounds", r#"["GND"]"#), ("edge_classes", r#"{"rs485": ["/RS485_A"]}"#)]);
    let (tr, label) = d124c_net_edge("/RS485_A", &s, &Edges::new());
    assert_eq!(tr, Some(s.rates.get("rs485").unwrap().tr_ns));
    assert!(label.starts_with("class rs485"));
    assert_eq!(d124c_net_edge("/OTHER", &s, &edges_of(&[("/OTHER", Edge::Unknown("x".to_string()))])), (None, "x".to_string()));
}

#[test]
fn the_d124c_detour_counts_a_blocked_path_and_a_stub() {
    let ok = |x: f64, y: f64| !(0.9 < x && x < 1.1 && -2.0 < y && y < 2.0); // a slot across the direct path
    let ends = [terminal(0.0, 0.0, 0.1), terminal(2.0, 0.0, 0.1)];
    assert_eq!(d124c_detour_mm(&ok, &ends[..1], 10.0, 0.1, &[]), Some(0.0));
    assert!(d124c_detour_mm(&ok, &ends, 20.0, 0.1, &[]).unwrap() > 4.0);
    assert_eq!(d124c_detour_mm(&ok, &ends, 2.0, 0.1, &[]), None);
}

// Unknown timing: a positive detour cannot qualify it and a numeric zero is no proof

fn waste(terminals: usize) -> NetResult {
    let run = Run {
        length: 1.0,
        at: (0.5, 0.0),
        terminals: (0..terminals).map(|i| terminal(i as f64, 0.0, 0.1)).collect(),
        bad_points: vec![(0.25, 0.0), (0.75, 0.0)],
        net: "/SIG".to_string(),
        ..Run::default()
    };
    NetResult { worst: 1.0, worst_at: Some((0.5, 0.0)), runs: vec![run], ..NetResult::default() }
}

fn assess(r: NetResult, edge: Edge, detour: impl Fn(&Run, f64) -> Option<f64>) -> (Assessment, Vec<f64>) {
    let (results, domains, edges) = (one("F.Cu", "/SIG", r), domain_of("/SIG", Some("GND")), edges_of(&[("/SIG", edge)]));
    let calls = RefCell::new(Vec::new());
    let mut callback = |_: &str, _: &str, run: &Run, budget: f64| {
        calls.borrow_mut().push(budget);
        detour(run, budget)
    };
    let assessed = reference_assessment(&results, &domains, &screen_spec(), &edges, &mut callback, 450.0).unwrap();
    (assessed, calls.into_inner())
}

fn missing() -> Edge {
    Edge::Unknown("missing manufacturer edge".to_string())
}

#[test]
fn an_unknown_edge_is_inspected_at_zero_then_measured_for_the_report() {
    let (assessed, calls) = assess(waste(2), missing(), |_, _| None);
    assert_eq!(calls, [0.0, 20.0, 450.0]);
    assert_eq!((assessed.screen.len(), assessed.evidence.len()), (1, 1));
    assert!(assessed.screen[0].contains("detour none (no reference path)"), "{}", assessed.screen[0]);
}

#[test]
fn a_raw_zero_mints_no_stub() {
    let r = waste(1);
    let (assessed, _) = assess(r.clone(), missing(), |_, _| Some(0.0));
    assert_eq!(assessed.evidence.len(), 1);
    assert!(!r.runs[0].proven_stub.get());
}

#[test]
fn the_proof_of_the_native_producer_closes_the_evidence() {
    let producer = |run: &Run, _: f64| {
        run.proven_stub.set(true);
        Some(0.0)
    };
    let (assessed, calls) = assess(waste(1), missing(), producer);
    assert_eq!(calls, [0.0, 20.0]); // the report measures a run the screen has no edge for
    assert_eq!(assessed.screen, [""; 0]);
    assert_eq!(assessed.evidence, [""; 0]);
}

#[test]
fn a_known_budget_keeps_its_failure_diagnostic() {
    let (_, calls) = assess(waste(2), known(1.0, "fixture"), |_, _| None);
    assert_eq!(calls, [screen_spec().rates.budget_mm(1.0).unwrap(), 20.0, 450.0]);
}

