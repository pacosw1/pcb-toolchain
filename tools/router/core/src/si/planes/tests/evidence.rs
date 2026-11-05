//! Accepted numeric screening values cannot silently certify fastest-edge bounds: the values of tools/test_si_evidence.py. The port
//! has no qualified bound at all, so every net with a non-stub run stays in the evidence list.
use super::super::sample::{NetResult, Run};
use super::super::screen::{Assessment, planes_outcome, reference_assessment};
use super::super::spec::Spec;
use super::{domain_of, edges_of, known, one, terminal};
use crate::si::drivers::table::Table;
use crate::si::drivers::{Edge, Geometry, Lookup, net_edge};
use crate::si::fixture::{netlist, part, real_table, spec, table_of};

fn base() -> Spec {
    spec(&[("adjacent", r#"{"F.Cu": "In1.Cu"}"#), ("plane_layers", r#"["In1.Cu"]"#), ("grounds", r#"["GND"]"#)])
}

fn edge_of(nl: &crate::si::drivers::netlist::Netlist, table: &Table, interface: Option<&str>) -> Edge {
    let s = base();
    let geom = Geometry::default();
    net_edge("/SIG", &Lookup { netlist: nl, table, receivers: &[], offboard: &[], rates: &s.rates, power: &[], geom: &geom }, interface)
}

fn driver_edge(mpn: &str, pin: &str, table: &Table, interface: Option<&str>) -> Edge {
    edge_of(&netlist(&[("U1", mpn)], &[("/SIG", &[("U1", "1", pin)])]), table, interface)
}

fn two_terminals() -> NetResult {
    let run = Run { length: 2.0, at: (0.0, 0.0), terminals: vec![terminal(0.0, 0.0, 0.1), terminal(2.0, 0.0, 0.1)], ..Run::default() };
    NetResult { runs: vec![run], worst: 2.0, worst_at: Some((0.0, 0.0)), ..NetResult::default() }
}

fn one_terminal() -> NetResult {
    let run = Run { length: 2.0, at: (1.0, 0.0), terminals: vec![terminal(0.0, 0.0, 0.1)], bad_points: vec![(1.0, 0.0), (2.0, 0.0)], net: "/SIG".to_string(), ..Run::default() };
    NetResult { runs: vec![run], worst: 2.0, worst_at: Some((1.0, 0.0)), ..NetResult::default() }
}

fn assess_with(r: NetResult, edge: Edge, detour: &mut dyn FnMut(&Run, f64) -> Option<f64>) -> Assessment {
    let mut callback = |_: &str, _: &str, run: &Run, budget: f64| detour(run, budget);
    reference_assessment(&one("F.Cu", "/SIG", r), &domain_of("/SIG", Some("GND")), &base(), &edges_of(&[("/SIG", edge)]), &mut callback, 200.0).unwrap()
}

fn assess(edge: Edge) -> Assessment {
    assess_with(two_terminals(), edge, &mut |_, _| Some(0.0))
}

#[test]
fn report_only_timing_keeps_the_missing_evidence_without_counting_it() {
    for edge in [Edge::Unknown("missing driver".to_string()), known(2000.0, "screening only")] {
        let result = assess(edge);
        assert_eq!(result.screen, [""; 0]);
        assert_eq!(result.evidence.len(), 1);
        let (fails, report) = planes_outcome(Vec::new(), &[], &result);
        assert_eq!(fails, [""; 0]);
        assert!(report.iter().any(|l| l.starts_with("WARN unproved-fastest-edge")));
    }
    let result = assess_with(two_terminals(), Edge::Unknown("missing driver".to_string()), &mut |_, _| None);
    assert_eq!(result.screen.len(), 1);
    assert!(result.screen[0].starts_with("FAIL unknown-driver"));
}

#[test]
fn a_thvd_typ_460_perimeter_screen_is_no_physical_bound() {
    let edge = driver_edge("THVD1410DR", "A", &real_table(), Some("rs485"));
    assert!(matches!(edge, Edge::Known { edge_ns: 460.0, .. }));
    let result = assess(edge);
    assert_eq!(result.screen, [""; 0]);
    assert_eq!(result.evidence.len(), 1);
}

#[test]
fn a_max_only_driver_cannot_certify_the_fastest_edge() {
    let edge = driver_edge("STM32H743VIT6", "PE10", &real_table(), None);
    assert!(matches!(edge, Edge::Known { .. }));
    assert_eq!(assess(edge).evidence.len(), 1);
}

#[test]
fn a_line_side_100base_edge_stays_screening_only() {
    let edge = driver_edge("UNKNOWN", "OUT", &real_table(), Some("100base_tx"));
    assert!(matches!(edge, Edge::Known { edge_ns: 3.0, .. }));
    assert_eq!(assess(edge).evidence.len(), 1);
}

#[test]
fn the_lan8742_minimum_is_kept_but_stays_unqualified() {
    let edge = driver_edge("LAN8742A-CZ-TR", "TXP", &real_table(), None);
    assert!(matches!(edge, Edge::Known { edge_ns: 3.0, .. }));
    assert_eq!(assess(edge).evidence.len(), 1);
}

#[test]
fn a_typical_driver_cannot_hide_behind_a_faster_stored_minimum() {
    let min = part("minimum", r#"{"mpn": ["MIN"], "pins": [{"match": "OUT", "role": "push_pull", "tr_ns": 1, "tf_ns": 1, "stat": "min", "source": "fixture minimum"}]}"#, &[]);
    let typ = part("typical", r#"{"mpn": ["TYP"], "pins": [{"match": "OUT", "role": "push_pull", "tr_ns": 20, "tf_ns": 20, "stat": "typ", "source": "fixture typical"}]}"#, &[]);
    let nl = netlist(&[("U1", "MIN"), ("U2", "TYP")], &[("/SIG", &[("U1", "1", "OUT"), ("U2", "1", "OUT")])]);
    let edge = edge_of(&nl, &table_of(vec![min, typ]), None);
    assert!(matches!(edge, Edge::Known { edge_ns: 1.0, .. }));
    assert_eq!(assess(edge).evidence.len(), 1);
}

#[test]
fn an_unknown_sp3485_cannot_inherit_a_part_class() {
    let edge = driver_edge("SP3485EN-L/TR", "A", &real_table(), Some("rs485"));
    assert!(matches!(edge, Edge::Unknown(_)));
    assert_eq!(assess(edge).evidence.len(), 1);
}

#[test]
fn a_continuous_reference_needs_no_timing() {
    let edge = driver_edge("THVD1410DR", "A", &real_table(), Some("rs485"));
    let result = assess_with(NetResult { worst: 2.0, worst_at: Some((0.0, 0.0)), ..NetResult::default() }, edge, &mut |_, _| Some(0.0));
    assert_eq!(result.evidence, [""; 0]);
}

#[test]
fn only_a_stub_proof_closes_the_evidence() {
    let proved = one_terminal();
    proved.runs[0].proven_stub.set(true);
    assert_eq!(assess_with(proved, Edge::Unknown("fixture".to_string()), &mut |_, _| Some(0.0)).evidence, [""; 0]);
    assert_eq!(assess_with(one_terminal(), Edge::Unknown("fixture".to_string()), &mut |_, _| Some(0.0)).evidence.len(), 1);
}

#[test]
fn a_raw_zero_callback_never_mints_a_single_terminal_stub_proof() {
    let edge = driver_edge("THVD1410DR", "A", &real_table(), Some("rs485"));
    let (r, mut calls) = (one_terminal(), Vec::new());
    let result = assess_with(r.clone(), edge, &mut |_, budget| {
        calls.push(budget);
        Some(0.0)
    });
    assert_eq!(calls, [0.0]);
    assert_eq!(result.screen, [""; 0]);
    assert_eq!(result.evidence.len(), 1);
    assert!(!r.runs[0].proven_stub.get());
}
