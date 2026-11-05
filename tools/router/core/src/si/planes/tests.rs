//! The pure core of the reference-plane gate, with the expected values of tools/test_si_planes.py. The screens have their own files.
mod detour;
mod evidence;
mod native;
mod projection;

use super::sample::{Anchor, NetInputs, NetResult, RefAt, Run, Sample, Terminal, evaluate_net, sample_arc, sample_segment};
use super::screen::{Domains, Edges, Results, d124c_reference_failures, island_failures, max_min_distance, plane_cut_failures, reference_assessment};
use super::spec::{Caps, EdgeRates, Spec, load_edge_rates};
use super::trace::{TraceRecord, routed_trace_summary, trace_geometry};
use super::{Fill, driver_edges, ground_pieces};
use crate::kicad::board::Board;
use crate::kicad::geom::{FillIndex, Polygon, Pt, Rect, from_mm};
use crate::si::drivers::Edge;
use crate::si::drivers::netlist::{Netlist, Node};
use crate::si::fixture::{near, part, raw_spec, scratch, spec, spec_error, table_of, tools};
use crate::si::impedance::parse_stackup;
use crate::si::json::Json;
use std::collections::{BTreeMap, BTreeSet};
use std::f64::consts::PI;
use std::fs;

pub(super) fn terminal(x: f64, y: f64, snap: f64) -> Terminal {
    Terminal { x, y, snap }
}

pub(super) fn evaluate<'a>(samples: &[Sample], at: impl Fn(f64, f64) -> Option<&'a str> + 'a, domain: Option<&str>, anchors: &[Anchor], s: &Spec, net: &str, caps: &Caps) -> NetResult {
    let ref_at: &RefAt<'a> = &at;
    evaluate_net(samples, &NetInputs { ref_at, domain, anchors, spec: s, net, caps })
}

fn track(x0: f64, x1: f64) -> Vec<Sample> {
    sample_segment((x0, 0.0), (x1, 0.0), 0.25)
}

fn plain<'a>(samples: &[Sample], at: impl Fn(f64, f64) -> Option<&'a str> + 'a, s: &Spec) -> NetResult {
    evaluate(samples, at, Some("GND"), &[], s, "/X", &Caps::new())
}

/// A bad run between two terminals; its detour comes from the fake of `check`.
pub(super) fn run() -> Run {
    Run { length: 1.0, at: (0.0, 0.0), terminals: vec![terminal(0.0, 0.0, 0.1), terminal(1.0, 0.0, 0.1)], ..Run::default() }
}

fn res() -> NetResult {
    NetResult { length: 10.0, worst_at: Some((0.0, 0.0)), ..NetResult::default() }
}

pub(super) fn known(edge_ns: f64, driver: &str) -> Edge {
    Edge::Known { edge_ns, driver: driver.to_string() }
}

pub(super) fn edges_of(rows: &[(&str, Edge)]) -> Edges {
    rows.iter().map(|(n, e)| (n.to_string(), e.clone())).collect()
}

pub(super) fn one(layer: &str, net: &str, r: NetResult) -> Results {
    vec![((layer.to_string(), net.to_string()), r)]
}

pub(super) fn domain_of(net: &str, domain: Option<&str>) -> Domains {
    Domains::from([(net.to_string(), domain.map(str::to_string))])
}

/// The FAIL lines of one net, with a fake detour: `detour` mm, none over budget. The enforced and the proposed screen must agree.
fn check(s: &Spec, edges: &Edges, (layer, net): (&str, &str), r: NetResult, domain: Option<&str>, detour: Option<f64>, board_mm: f64) -> Vec<String> {
    let (results, domains) = (one(layer, net, r), domain_of(net, domain));
    let mut fake = |_: &str, _: &str, _: &Run, budget: f64| detour.filter(|d| *d <= budget);
    let enforced = d124c_reference_failures(&results, &domains, s, edges, &mut fake, board_mm).unwrap();
    assert_eq!(enforced, reference_assessment(&results, &domains, s, edges, &mut fake, board_mm).unwrap().screen);
    enforced
}

fn cuts(rows: &[(&str, &str, f64)]) -> Vec<((String, String), f64)> {
    rows.iter().map(|(l, n, mm)| ((l.to_string(), n.to_string()), *mm)).collect()
}

pub(super) fn board_with(layers: &[&str], nets: &[&str]) -> Board {
    Board {
        path: String::new(),
        copper_layers: layers.iter().map(|l| l.to_string()).collect(),
        stackup: Vec::new(),
        texts: Vec::new(),
        groups: Vec::new(),
        constraints: Default::default(),
        nets: nets.iter().map(|n| (n.to_string(), String::new())).collect(),
        footprints: Vec::new(),
        copper: Vec::new(),
        zones: Vec::new(),
        graphics: Vec::new(),
        edges_bbox: Rect::around(Pt::default()),
        outlines: Vec::new(),
    }
}

pub(super) fn square(x0: f64, y0: f64, x1: f64, y1: f64) -> Polygon {
    Polygon::of_ring([(x0, y0), (x1, y0), (x1, y1), (x0, y1)].iter().map(|p| Pt::new(from_mm(p.0), from_mm(p.1))).collect())
}

// Samples

#[test]
fn segment_samples_cover_the_length() {
    let pts = sample_segment((0.0, 0.0), (1.0, 0.0), 0.25);
    assert_eq!(pts.len(), 4);
    near(pts.iter().map(|s| s.w).sum(), 1.0);
    near(pts[0].x, 0.125);
    near(pts[3].x, 0.875);
}

#[test]
fn a_short_segment_gives_one_sample() {
    let pts = sample_segment((0.0, 0.0), (0.0, 0.1), 0.25);
    assert_eq!(pts.len(), 1);
    near(pts[0].w, 0.1);
}

#[test]
fn a_zero_length_segment_gives_no_sample() {
    assert_eq!(sample_segment((1.0, 1.0), (1.0, 1.0), 0.25), []);
}

#[test]
fn arc_samples_lie_on_the_circle_and_sum_to_the_arc_length() {
    // A half circle of radius 1 around (0, 0), through (0, 1).
    let pts = sample_arc((1.0, 0.0), (0.0, 1.0), (-1.0, 0.0), 0.25);
    for s in &pts {
        assert!((s.x * s.x + s.y * s.y - 1.0).abs() < 5e-7);
        assert!(s.y > 0.0);
    }
    assert!((pts.iter().map(|s| s.w).sum::<f64>() - 3.14159265).abs() < 5e-6);
}

#[test]
fn an_arc_goes_the_way_of_its_middle() {
    assert!(sample_arc((1.0, 0.0), (0.0, -1.0), (-1.0, 0.0), 0.25).iter().all(|s| s.y < 0.0));
}

// The spec

#[test]
fn a_minimal_spec_gets_the_defaults() {
    let s = spec(&[]);
    assert_eq!((s.via_allow_mm, s.step_mm), (0.6, 0.25));
}

#[test]
fn a_missing_key_is_an_error() {
    for key in ["grounds", "plane_layers"] {
        let Json::Obj(rows) = raw_spec(&[]) else { unreachable!() };
        let raw = Json::Obj(rows.into_iter().filter(|(k, _)| k != key).collect());
        assert!(Spec::load(&raw, tools()).unwrap_err().contains("missing spec keys"), "{key}");
    }
}

#[test]
fn a_two_layer_board_with_empty_plane_layers_loads() {
    assert!(spec(&[("adjacent", r#"{"F.Cu": "B.Cu"}"#), ("plane_layers", "[]")]).plane_layers.is_empty());
}

#[test]
fn empty_grounds_is_an_error() {
    assert!(spec_error(&[("grounds", "[]")]).contains("missing spec keys"));
}

#[test]
fn an_unknown_key_is_an_error() {
    assert!(spec_error(&[("max_gap", "3")]).contains("unknown spec keys"));
}

#[test]
fn an_exemption_needs_a_reason() {
    assert!(spec_error(&[("exempt", r#"{"nets": {"VIN": ""}}"#)]).contains("a written reason"));
    assert!(spec_error(&[("exempt", r#"{"areas": [{"box": [0, 0, 1, 1], "nets": ["/A"]}]}"#)]).contains("a written reason"));
}

#[test]
fn an_alt_ref_needs_a_domain_and_a_reason() {
    assert!(spec_error(&[("alt_refs", r#"{"VDD_3V3": {"domain": "GND"}}"#)]).contains("a written reason"));
    assert!(spec_error(&[("alt_refs", r#"{"VDD_3V3": {"domain": "NOPE", "reason": "x"}}"#)]).contains("domain must be one of the grounds"));
}

#[test]
fn a_domain_override_must_name_a_ground() {
    assert!(spec_error(&[("domains", r#"{"NOPE": ["/A*"]}"#)]).contains("key must be a ground"));
}

#[test]
fn the_board_check_rejects_stale_names() {
    let s = spec(&[("exempt", r#"{"nets": {"VIN": "power"}}"#)]);
    let all = ["F.Cu", "B.Cu", "In1.Cu", "In2.Cu"];
    assert!(s.check_against_board(&board_with(&all, &["GND", "ISO_0V"])).unwrap_err().contains("nets not on the board: ['VIN']"));
    assert!(s.check_against_board(&board_with(&["F.Cu", "B.Cu"], &["GND", "ISO_0V", "VIN"])).unwrap_err().contains("layers not on the board"));
    s.check_against_board(&board_with(&all, &["GND", "ISO_0V", "VIN"])).unwrap();
}

// The domain of a net

fn refs(names: &[Option<&str>]) -> Vec<Option<String>> {
    names.iter().map(|n| n.map(str::to_string)).collect()
}

#[test]
fn the_domain_is_the_majority_of_the_pads() {
    assert_eq!(spec(&[]).net_domain("/X", &refs(&[Some("GND"), Some("GND"), Some("ISO_0V"), None])).as_deref(), Some("GND"));
}

#[test]
fn no_pad_in_a_ground_zone_gives_no_domain() {
    assert_eq!(spec(&[]).net_domain("/X", &refs(&[None, None])), None);
}

#[test]
fn a_tie_gives_no_domain() {
    assert_eq!(spec(&[]).net_domain("/X", &refs(&[Some("GND"), Some("ISO_0V")])), None);
}

#[test]
fn an_override_pattern_wins() {
    let s = spec(&[("domains", r#"{"ISO_0V": ["/AI*"]}"#)]);
    assert_eq!(s.net_domain("/AI1_ADC", &refs(&[Some("GND"), Some("GND")])).as_deref(), Some("ISO_0V"));
}

#[test]
fn an_alt_ref_zone_counts_for_its_domain() {
    let s = spec(&[("alt_refs", r#"{"VDD_3V3": {"domain": "GND", "reason": "decoupled power plane"}}"#)]);
    assert_eq!(s.net_domain("/X", &refs(&[Some("VDD_3V3"), Some("VDD_3V3"), Some("ISO_0V")])).as_deref(), Some("GND"));
}

// One net against its reference

#[test]
fn a_fully_referenced_net() {
    let r = plain(&track(0.0, 10.0), |_, _| Some("GND"), &spec(&[]));
    near(r.length, 10.0);
    near(r.unref, 0.0);
    assert_eq!((r.worst, r.cross), (0.0, 0.0));
}

#[test]
fn a_slot_crossing_gives_the_worst_run() {
    // A 2 mm slot in the plane from x = 4 to x = 6.
    let r = plain(&track(0.0, 10.0), |x, _| if 4.0 < x && x < 6.0 { None } else { Some("GND") }, &spec(&[]));
    near(r.unref, 2.0);
    near(r.worst, 2.0);
    assert!((r.worst_at.unwrap().0 - 5.0).abs() <= 0.2);
}

#[test]
fn a_run_continues_across_a_bend() {
    let mut pts = sample_segment((0.0, 0.0), (1.0, 0.0), 0.25);
    pts.extend(sample_segment((1.0, 0.0), (1.0, 1.0), 0.25));
    near(plain(&pts, |_, _| None, &spec(&[])).worst, 2.0);
}

#[test]
fn two_separate_gaps_are_two_runs() {
    let r = plain(&track(0.0, 10.0), |x, _| if (1.0 < x && x < 2.0) || (5.0 < x && x < 6.5) { None } else { Some("GND") }, &spec(&[]));
    near(r.unref, 2.5);
    near(r.worst, 1.5);
}

#[test]
fn an_antipad_run_near_its_own_via_is_ok() {
    // The track ends at a via at x = 10 (radius 0.3). The plane has an antipad to x = 9.5.
    let r = evaluate(&track(0.0, 10.0), |x, _| if x > 9.5 { None } else { Some("GND") }, Some("GND"), &[(10.0, 0.0, 0.3)], &spec(&[]), "/X", &Caps::new());
    near(r.unref, 0.5);
    assert_eq!(r.worst, 0.0);
}

#[test]
fn a_run_longer_than_the_via_allowance_still_counts() {
    // Gap from x = 7 to 10; only the part within 0.3 + 0.6 mm of the via is excused.
    let r = evaluate(&track(0.0, 10.0), |x, _| if x > 7.0 { None } else { Some("GND") }, Some("GND"), &[(10.0, 0.0, 0.3)], &spec(&[]), "/X", &Caps::new());
    assert!((r.worst - 2.0).abs() <= 0.15);
}

#[test]
fn a_wrong_domain_is_a_crossing() {
    let r = plain(&track(0.0, 10.0), |x, _| Some(if x > 8.0 { "ISO_0V" } else { "GND" }), &spec(&[]));
    near(r.cross, 2.0);
    assert_eq!(r.cross_net.as_deref(), Some("ISO_0V"));
    near(r.worst, 2.0);
}

#[test]
fn a_crossing_near_its_own_via_is_ok() {
    let r = evaluate(&track(0.0, 10.0), |x, _| Some(if x > 9.8 { "ISO_0V" } else { "GND" }), Some("GND"), &[(10.0, 0.0, 0.3)], &spec(&[]), "/X", &Caps::new());
    assert_eq!(r.cross, 0.0);
}

#[test]
fn an_alt_ref_of_the_same_domain_is_a_reference() {
    let s = spec(&[("alt_refs", r#"{"VDD_3V3": {"domain": "GND", "reason": "decoupled"}}"#)]);
    near(plain(&track(0.0, 4.0), |_, _| Some("VDD_3V3"), &s).unref, 0.0);
}

#[test]
fn another_net_plane_is_no_reference() {
    let r = plain(&track(0.0, 4.0), |_, _| Some("BACKUP_5V"), &spec(&[]));
    near(r.unref, 4.0);
    assert_eq!(r.cross, 0.0);
}

#[test]
fn with_no_domain_nothing_is_a_reference() {
    near(evaluate(&track(0.0, 4.0), |_, _| Some("GND"), None, &[], &spec(&[]), "/X", &Caps::new()).unref, 4.0);
}

#[test]
fn an_exempt_area_excuses_samples() {
    let s = spec(&[("exempt", r#"{"areas": [{"box": [3, -1, 7, 1], "nets": ["/A"], "reason": "no plane under RJ45"}]}"#)]);
    let at = |x: f64, _: f64| if 4.0 < x && x < 6.0 { None } else { Some("GND") };
    assert_eq!(evaluate(&track(0.0, 10.0), at, Some("GND"), &[], &s, "/A", &Caps::new()).worst, 0.0);
    near(evaluate(&track(0.0, 10.0), at, Some("GND"), &[], &s, "/B", &Caps::new()).worst, 2.0);
}

#[test]
fn the_bad_length_is_reported() {
    let pts: Vec<Sample> = (0..10).map(|x| Sample { x: x as f64 + 0.5, y: 0.0, w: 1.0 }).collect();
    near(plain(&pts, |x, _| if (2.0..=5.0).contains(&x) { None } else { Some("GND") }, &spec(&[])).bad, 3.0);
}

#[test]
fn a_slot_run_has_two_referenced_terminals() {
    let r = plain(&track(0.0, 10.0), |x, _| if 4.0 < x && x < 6.0 { None } else { Some("GND") }, &spec(&[]));
    assert_eq!(r.runs.len(), 1);
    let mut ends: Vec<f64> = r.runs[0].terminals.iter().map(|t| t.x).collect();
    ends.sort_by(f64::total_cmp);
    near(ends[0], 3.875);
    near(ends[ends.len() - 1], 6.125);
}

// FAIL lines

fn failure_setup() -> (Spec, Edges) {
    (spec(&[("exempt", r#"{"nets": {"VIN": "power net, wide pour"}}"#)]), edges_of(&[("/A", known(1.0, "test driver, 1 ns"))]))
}

#[test]
fn the_driver_edge_sets_the_budget() {
    // D-124 addendum: the driver edge (here 1 ns) -> 6.7 mm detour budget
    let (s, e) = failure_setup();
    let fails = check(&s, &e, ("B.Cu", "/A"), NetResult { worst: 1.5, unref: 2.0, runs: vec![run()], ..res() }, Some("GND"), Some(9.0), 200.0);
    assert_eq!(fails.len(), 1);
    assert!(fails[0].starts_with("FAIL") && fails[0].contains("/A"));
}

#[test]
fn a_detour_inside_the_budget_passes() {
    let (s, e) = failure_setup();
    assert_eq!(check(&s, &e, ("B.Cu", "/A"), NetResult { worst: 3.0, runs: vec![run()], ..res() }, Some("GND"), Some(6.0), 200.0), [""; 0]);
}

#[test]
fn an_exempt_net_does_not_fail() {
    let (s, e) = failure_setup();
    assert_eq!(check(&s, &e, ("B.Cu", "VIN"), NetResult { worst: 5.0, unref: 5.0, ..res() }, Some("GND"), None, f64::INFINITY), [""; 0]);
}

#[test]
fn a_ground_net_is_not_checked() {
    let (s, e) = failure_setup();
    assert_eq!(check(&s, &e, ("F.Cu", "GND"), NetResult { worst: 5.0, unref: 5.0, ..res() }, Some("GND"), None, f64::INFINITY), [""; 0]);
}

#[test]
fn a_crossing_fails_separately() {
    let (s, e) = failure_setup();
    let fails = check(&s, &e, ("F.Cu", "/A"), NetResult { cross: 0.5, cross_net: Some("ISO_0V".to_string()), worst: 0.5, ..res() }, Some("GND"), None, f64::INFINITY);
    assert_eq!(fails.len(), 1);
    assert!(fails[0].contains("ISO_0V"));
}

#[test]
fn no_domain_fails() {
    let (s, e) = failure_setup();
    let fails = check(&s, &e, ("F.Cu", "/A"), NetResult { worst: 10.0, unref: 10.0, ..res() }, None, None, f64::INFINITY);
    assert!(fails.iter().any(|f| f.contains("domain")));
}

#[test]
fn a_plane_cut_fails_per_net() {
    let fails = plane_cut_failures(&cuts(&[("In2.Cu", "/A", 12.34), ("In2.Cu", "/B", 1.0)]), &failure_setup().0);
    assert_eq!(fails.len(), 2);
    assert!(fails[0].contains("12.3"));
}

#[test]
fn a_plane_cut_by_an_exempt_net_still_fails() {
    assert_eq!(plane_cut_failures(&cuts(&[("In2.Cu", "VIN", 3.0)]), &failure_setup().0).len(), 1);
}

#[test]
fn a_track_on_a_non_plane_layer_is_no_cut() {
    assert_eq!(plane_cut_failures(&cuts(&[("F.Cu", "/A", 3.0)]), &failure_setup().0), [""; 0]);
}

// A mixed layer

const MIXED: &str = r#"{"In2.Cu": {"allow": "slow", "fast_file": "fast.json", "power": ["GND", "VBUS", "/P*"], "reason": "user decision"}}"#;

fn with_fast(mut s: Spec, fast: &[&str]) -> Spec {
    s.mixed_layers[0].1.fast = fast.iter().map(|f| f.to_string()).collect();
    s
}

fn mixed() -> (Spec, Edges) {
    (with_fast(spec(&[("mixed_layers", MIXED)]), &["/USB_*", "/SCK*"]), edges_of(&[("/EN", known(1.0, "test driver, 1 ns"))]))
}

#[test]
fn a_mixed_layer_needs_a_plane_layer_a_reason_and_allow_slow() {
    let m = r#""allow": "slow", "fast_file": "fast.json", "power": ["GND"], "reason": "user decision""#;
    for bad in [
        format!(r#"{{"In3.Cu": {{{m}}}}}"#),
        r#"{"In2.Cu": {"allow": "slow", "fast_file": "f", "power": ["GND"], "reason": ""}}"#.to_string(),
        r#"{"In2.Cu": {"allow": "all", "fast_file": "f", "power": ["GND"], "reason": "r"}}"#.to_string(),
        r#"{"In2.Cu": {"allow": "slow", "fast_file": "f", "power": "GND", "reason": "r"}}"#.to_string(),
        r#"{"In2.Cu": {"allow": "slow", "power": ["GND"], "reason": "r"}}"#.to_string(),
    ] {
        spec_error(&[("mixed_layers", &bad)]);
    }
}

#[test]
fn a_fast_file_must_be_a_list_of_patterns() {
    let folder = scratch("fast-file");
    let path = folder.join("fast.json");
    fs::write(&path, r#"{"fast": ["/A*"]}"#).unwrap();
    let mut s = spec(&[("mixed_layers", MIXED)]);
    s.load_fast(&folder).unwrap();
    assert_eq!(s.mixed_layers[0].1.fast, ["/A*"]);
    for bad in ["{}", r#"{"fast": "/A*"}"#, r#"{"fast": []}"#, r#"{"fast": [1]}"#] {
        fs::write(&path, bad).unwrap();
        assert!(s.load_fast(&folder).unwrap_err().contains("must be a list of net patterns"), "{bad}");
    }
}

#[test]
fn a_missing_fast_file_fails_closed() {
    let (mut s, _) = mixed();
    assert!(s.load_fast(std::path::Path::new("/no/such/dir")).unwrap_err().contains("no fast net file"));
}

#[test]
fn the_kind_of_a_net_on_a_mixed_layer() {
    let (s, _) = mixed();
    let m = &s.mixed_layers[0].1;
    assert_eq!(s.net_kind("/USB_DP", m), "fast");
    assert_eq!(s.net_kind("VBUS", m), "power");
    assert_eq!(s.net_kind("/PROBE_3V3", m), "power");
    assert_eq!(s.net_kind("ISO_0V", m), "power"); // every ground is power
    assert_eq!(s.net_kind("/EN", m), "slow");
}

#[test]
fn a_slow_net_on_a_mixed_layer_is_no_cut() {
    assert_eq!(plane_cut_failures(&cuts(&[("In2.Cu", "/EN", 5.0)]), &mixed().0), [""; 0]);
}

#[test]
fn fast_and_power_on_a_mixed_layer_fail() {
    let fails = plane_cut_failures(&cuts(&[("In2.Cu", "/SCK", 2.0), ("In2.Cu", "VBUS", 1.0)]), &mixed().0);
    assert_eq!(fails.len(), 2);
    assert!(fails.iter().any(|f| f.contains("/SCK") && f.contains("fast")));
    assert!(fails.iter().any(|f| f.contains("VBUS") && f.contains("power")));
}

#[test]
fn a_slow_net_on_a_solid_plane_still_fails() {
    assert_eq!(plane_cut_failures(&cuts(&[("In1.Cu", "/EN", 1.0)]), &mixed().0).len(), 1);
}

#[test]
fn a_fast_net_allows_no_gap_on_any_layer() {
    // D-124: HyperLynx "net crossing gap / hole or slot" has no length allowance
    let (s, e) = mixed();
    for layer in ["B.Cu", "F.Cu"] {
        let fails = check(&s, &e, (layer, "/USB_DP"), NetResult { worst: 0.3, unref: 0.3, ..res() }, Some("GND"), None, f64::INFINITY);
        assert_eq!(fails.len(), 1);
        assert!(fails[0].contains("fast-crossing"));
    }
}

#[test]
fn a_slow_net_over_a_mixed_layer_uses_the_detour_budget() {
    let (s, e) = mixed();
    assert_eq!(check(&s, &e, ("B.Cu", "/EN"), NetResult { worst: 0.9, unref: 3.0, runs: vec![run()], ..res() }, Some("GND"), Some(2.0), 200.0), [""; 0]);
}

#[test]
fn a_power_net_has_no_plane_rule() {
    let (s, e) = mixed();
    assert_eq!(check(&s, &e, ("B.Cu", "VBUS"), NetResult { worst: 9.0, unref: 9.0, runs: vec![run()], ..res() }, Some("GND"), Some(50.0), 200.0), [""; 0]);
}

#[test]
fn an_island_with_no_ground_via_or_pad_fails() {
    let fails = island_failures(&[("In2.Cu".to_string(), "GND".to_string(), 3, (1.0, 2.0)), ("In2.Cu".to_string(), "GND".to_string(), 0, (5.25, 6.0))]);
    assert_eq!(fails.len(), 1);
    assert!(fails[0].contains("island"));
    assert!(fails[0].contains("(5.2, 6.0)"));
}

fn slow_only(alt: &str, fast: &[&str]) -> Spec {
    with_fast(spec(&[("mixed_layers", MIXED), ("alt_refs", alt)]), fast)
}

const SLOW_ONLY: &str = r#"{"+3V3": {"domain": "GND", "slow_only": true, "reason": "decoupling cap to GND within 5 mm"}}"#;

#[test]
fn a_slow_only_alt_ref_is_a_reference_for_a_slow_net() {
    let s = slow_only(SLOW_ONLY, &["/USB_*", "/SCK*"]);
    near(evaluate(&track(0.0, 4.0), |_, _| Some("+3V3"), Some("GND"), &[], &s, "/LED", &Caps::new()).unref, 0.0);
}

#[test]
fn a_slow_only_alt_ref_is_no_reference_for_a_fast_net() {
    let s = slow_only(SLOW_ONLY, &["/USB_*", "/SCK*"]);
    let r = evaluate(&track(0.0, 4.0), |_, _| Some("+3V3"), Some("GND"), &[], &s, "/USB_DP", &Caps::new());
    near(r.unref, 4.0);
    let fails = check(&s, &Edges::new(), ("B.Cu", "/USB_DP"), r, Some("GND"), None, f64::INFINITY);
    assert!(fails.iter().any(|f| f.contains("fast-crossing")));
}

#[test]
fn a_cap_mm_alt_ref_counts_only_near_a_decoupling_cap() {
    let s = slow_only(r#"{"+3V3": {"domain": "GND", "slow_only": true, "cap_mm": 5, "reason": "decoupling cap to GND within 5 mm"}}"#, &["/USB_*"]);
    let caps = Caps::from([("+3V3".to_string(), vec![(0.0, 3.0)])]);
    near(evaluate(&track(0.0, 10.0), |_, _| Some("+3V3"), Some("GND"), &[], &s, "/LED", &caps).unref, 6.0); // only x 0..4 are within 5 mm of the cap
}

#[test]
fn cap_mm_must_be_a_positive_number_and_slow_only_a_bool() {
    assert!(spec_error(&[("alt_refs", r#"{"+3V3": {"domain": "GND", "cap_mm": 0, "reason": "x"}}"#)]).contains("cap_mm"));
    assert!(spec_error(&[("alt_refs", r#"{"+3V3": {"domain": "GND", "slow_only": "yes", "reason": "x"}}"#)]).contains("slow_only"));
}

// D-124: the detour budget comes from the rise time of the net (tools/edge-rates.json)

fn edge_setup() -> (Spec, Edges) {
    let s = spec(&[("mixed_layers", MIXED), ("power", r#"["/VLIM"]"#), ("edge_classes", r#"{"i2c": ["/SDA", "/SCL"], "rs485": ["/RS485_A"]}"#)]);
    (with_fast(s, &["/SCK*"]), edges_of(&[("/EN", known(1.0, "test driver, 1 ns"))]))
}

fn with_run(worst: f64) -> NetResult {
    NetResult { length: 100.0, worst, runs: vec![run()], ..res() }
}

#[test]
fn the_table_has_sources_and_marks_assumptions() {
    let t = load_edge_rates(tools()).unwrap();
    assert_eq!(t.get("rs485").unwrap().tr_ns, 460.0);
    assert_eq!(t.get("gpio"), None); // D-124 addendum: no default class
    let ethernet = t.get("100base_tx").unwrap();
    assert!(!ethernet.assumption); // sourced 2026-10-11: IEEE 802.3 cl. 25 / ANSI X3.263 9.1.6
    assert_eq!(ethernet.tr_ns, 3.0);
    assert!(t.classes.iter().all(|(_, c)| !c.source.trim().is_empty()));
}

#[test]
fn the_budget_is_6_7_mm_per_ns() {
    let t = load_edge_rates(tools()).unwrap();
    assert!((t.budget_mm(1.0).unwrap() - 6.67).abs() < 0.005);
    assert!((t.budget_mm(4.0).unwrap() - 26.7).abs() < 0.05);
}

/// A folder with an edge-rates.json of one class.
fn rates_with(name: &str, value: &str) -> Result<EdgeRates, String> {
    let folder = scratch(name);
    let text = format!(r#"{{"classes": {{"test": {{"tr_ns": {value}, "source": "fixture", "applicability": {{"kind": "protocol", "reason": "fixture"}}}}}}, "budget": {{"nh_per_ns": 10, "nh_per_mm": 1}}}}"#);
    fs::write(folder.join("edge-rates.json"), text).unwrap();
    load_edge_rates(&folder)
}

#[test]
fn nonfinite_or_boolean_budget_inputs_fail_closed() {
    let rates = load_edge_rates(tools()).unwrap();
    for value in [f64::INFINITY, f64::NEG_INFINITY, f64::NAN, 0.0, -1.0] {
        assert!(rates.budget_mm(value).is_err(), "{value}");
    }
    for (i, value) in ["1e999", "-1e999", "true", "false", "0", "-1"].iter().enumerate() {
        spec_error(&[("step_mm", value)]);
        let alt = format!(r#"{{"/N": {{"domain": "GND", "cap_mm": {value}, "reason": "fixture"}}}}"#);
        spec_error(&[("alt_refs", &alt)]);
        assert!(rates_with(&format!("rates-{i}"), value).is_err(), "{value}");
        let folder = scratch(&format!("budget-{i}"));
        let text = format!(r#"{{"classes": {{"test": {{"tr_ns": 1, "source": "f", "applicability": {{"kind": "protocol", "reason": "f"}}}}}}, "budget": {{"nh_per_ns": {value}, "nh_per_mm": 1}}}}"#);
        fs::write(folder.join("edge-rates.json"), text).unwrap();
        assert!(load_edge_rates(&folder).unwrap_err().contains("budget coefficients"), "{value}");
    }
    assert!(Json::parse("NaN").is_err()); // Python reads NaN and refuses the value; here the text stops first
    assert!(EdgeRates { classes: Vec::new(), mm_per_ns: 1e308 }.budget_mm(1e308).is_err());
}

#[test]
fn a_class_is_the_interface_of_a_net() {
    let (s, _) = edge_setup();
    assert_eq!(s.edge_class("/SDA"), Some("i2c"));
    assert_eq!(s.edge_class("/EN"), None); // no class: the edge of the driver (no default)
}

#[test]
fn an_i2c_detour_under_80_mm_passes_and_over_fails() {
    let (s, e) = edge_setup();
    assert_eq!(check(&s, &e, ("F.Cu", "/SDA"), with_run(5.0), Some("GND"), Some(70.0), 200.0), [""; 0]);
    assert_eq!(check(&s, &e, ("F.Cu", "/SDA"), with_run(5.0), Some("GND"), Some(90.0), 200.0).len(), 1);
}

#[test]
fn a_budget_larger_than_the_board_means_no_rule() {
    let (s, mut e) = edge_setup();
    e.insert("/RS485_A".to_string(), known(460.0, "verified compatible THVD1410.A fixture"));
    assert_eq!(check(&s, &e, ("F.Cu", "/RS485_A"), with_run(30.0), Some("GND"), None, 200.0), [""; 0]);
    assert_eq!(check(&s, &e, ("F.Cu", "/SDA"), with_run(30.0), Some("GND"), None, 60.0), [""; 0]);
}

#[test]
fn an_unreachable_reference_fails() {
    let (s, e) = edge_setup();
    assert_eq!(check(&s, &e, ("F.Cu", "/EN"), with_run(3.0), Some("GND"), None, 200.0).len(), 1);
}

#[test]
fn a_top_level_power_net_has_no_plane_rule() {
    let (s, e) = edge_setup();
    assert_eq!(check(&s, &e, ("F.Cu", "/VLIM"), with_run(30.0), Some("GND"), None, 200.0), [""; 0]);
}

#[test]
fn the_removed_made_up_limits_are_rejected() {
    for (key, value) in [("max_unreferenced_mm", "1.0"), ("slow_max_gap_mm", "5.0"), ("slow_min_coverage_pct", "95")] {
        assert!(spec_error(&[(key, value)]).contains("unknown spec keys"));
    }
}

#[test]
fn an_unknown_edge_class_is_an_error() {
    assert!(spec_error(&[("edge_classes", r#"{"spi_fast": ["/A"]}"#)]).contains("not a class of"));
}

// The routed load

fn record(net: &str, layer: &str, path: &[(f64, f64)], width_mm: f64) -> TraceRecord {
    TraceRecord { net: net.to_string(), layer: layer.to_string(), path: path.iter().map(|p| Pt::new(from_mm(p.0), from_mm(p.1))).collect(), width_mm }
}

fn lengths(records: &[TraceRecord]) -> BTreeMap<String, f64> {
    routed_trace_summary(records).unwrap().0
}

#[test]
fn a_load_lookup_takes_the_geometry_and_the_interface_of_the_spec() {
    let s = spec(&[("edge_classes", r#"{"i2c": ["/S"]}"#)]);
    let node = Node { part: "U1".to_string(), pin: "1".to_string(), name: "OUT".to_string() };
    let netlist = Netlist { comps: BTreeMap::from([("U1".to_string(), "B".to_string())]), nets: vec![("/S".to_string(), vec![node.clone()]), ("/T".to_string(), vec![node])], ..Netlist::default() };
    let table = table_of(vec![part("b", r#"{"mpn": ["B"], "pins": [{"match": "OUT", "role": "push_pull", "source": "fixture", "bound": {"i_ma": 20, "i_source": "fixture", "vdd_v": 3.3}}]}"#, &[])]);
    let nets = BTreeSet::from(["/S", "/T", "GND"]);
    let geom = crate::si::drivers::Geometry {
        length_mm: BTreeMap::from([("/T".to_string(), 10.0)]),
        pf_per_mm: BTreeMap::from([("/T".to_string(), (0.1, "fixture".to_string()))]),
    };
    let edges = driver_edges(&nets, &s, &netlist, &table, &geom, true);
    assert_eq!(edges.keys().collect::<Vec<_>>(), ["/S", "/T"]); // a ground has no driver
    assert!(matches!(&edges["/S"], Edge::Known { edge_ns: 12.0, driver } if driver.contains("protocol i2c")));
    assert!(matches!(&edges["/T"], Edge::Known { .. }));
    assert!(matches!(&driver_edges(&nets, &s, &netlist, &table, &Default::default(), true)["/T"], Edge::Unknown(why) if why.contains("routed length")));
    assert_eq!(driver_edges(&nets, &s, &netlist, &table, &geom, false).keys().collect::<Vec<_>>(), ["/T"]); // D-124c: a class net needs no driver
}

#[test]
fn duplicate_reversed_split_and_overlap_do_not_inflate_the_load() {
    let rows = [
        record("/S", "F.Cu", &[(0.0, 0.0), (10.0, 0.0)], 0.2),
        record("/S", "F.Cu", &[(10.0, 0.0), (0.0, 0.0)], 0.2),
        record("/S", "F.Cu", &[(2.0, 0.0), (7.0, 0.0)], 0.1),
        record("/S", "F.Cu", &[(7.0, 0.0), (12.0, 0.0)], 0.2),
        record("/S", "B.Cu", &[(0.0, 0.0), (10.0, 0.0)], 0.3),
    ];
    let (length, width) = routed_trace_summary(&rows).unwrap();
    assert_eq!(length["/S"], 22.0);
    assert_eq!(width["/S"], 0.1);
}

#[test]
fn parallel_paths_a_nanometre_apart_and_a_branch_are_kept() {
    let rows = [
        record("/S", "F.Cu", &[(0.0, 0.0), (10.0, 0.0)], 0.2),
        record("/S", "F.Cu", &[(0.0, 0.000001), (10.0, 0.000001)], 0.2),
        record("/S", "F.Cu", &[(5.0, 0.0), (5.0, 3.0)], 0.2),
    ];
    assert_eq!(lengths(&rows)["/S"], 23.0);
}

#[test]
fn a_reversed_arc_counts_once_and_another_arc_counts() {
    let arc = [(1.0, 0.0), (0.0, 1.0), (-1.0, 0.0)];
    let reversed = [(-1.0, 0.0), (0.0, 1.0), (1.0, 0.0)];
    let rows = [record("/S", "F.Cu", &arc, 0.2), record("/S", "F.Cu", &reversed, 0.2), record("/S", "F.Cu", &[(1.0, 0.0), (0.0, -1.0), (-1.0, 0.0)], 0.2)];
    near(lengths(&rows)["/S"], 2.0 * PI);
}

#[test]
fn invalid_native_geometry_is_no_load() {
    assert!(routed_trace_summary(&[record("/S", "F.Cu", &[(0.0, 0.0), (1.0, 0.0)], 0.0)]).is_err());
    assert!(routed_trace_summary(&[record("/S", "F.Cu", &[(0.0, 0.0), (1.0, 0.0)], f64::NAN)]).is_err());
    assert!(routed_trace_summary(&[record("/S", "F.Cu", &[(0.0, 0.0)], 0.2)]).is_err());
}

#[test]
fn a_stackup_change_recomputes_the_screen_and_none_leaves_it_unresolved() {
    let board = |height: f64| format!(r#"(kicad_pcb (stackup (layer "F.Cu" (type "copper") (thickness .035)) (layer "dielectric 1" (type "core") (thickness {height}) (epsilon_r 4.2)) (layer "B.Cu" (type "copper") (thickness .035)) (copper_finish "ENIG")))"#);
    let s = spec(&[("adjacent", r#"{"F.Cu": "B.Cu"}"#), ("plane_layers", "[]")]);
    let rows = [record("/S", "F.Cu", &[(0.0, 0.0), (10.0, 0.0)], 0.2)];
    let geometry = |text: &str| trace_geometry(parse_stackup(text).unwrap().as_ref(), &s, &rows).unwrap();
    let (first, second) = (geometry(&board(0.2)), geometry(&board(0.4)));
    assert_ne!(first.pf_per_mm["/S"].0, second.pf_per_mm["/S"].0);
    assert!(first.pf_per_mm["/S"].1.contains("applicability unproved"));
    let missing = geometry("(kicad_pcb)");
    assert!(missing.pf_per_mm.is_empty());
    assert_eq!(missing.length_mm["/S"], 10.0);
}

// Stitching and islands

#[test]
fn the_farthest_point_from_the_vias() {
    near(max_min_distance(&[(0.0, 0.0), (3.0, 4.0), (10.0, 0.0)], &[(0.0, 0.0), (10.0, 0.0)]).unwrap(), 5.0);
}

#[test]
fn no_via_gives_none_and_no_points_zero() {
    assert_eq!(max_min_distance(&[(0.0, 0.0)], &[]), None);
    assert_eq!(max_min_distance(&[], &[(0.0, 0.0)]), Some(0.0));
}

fn pieces(polygons: &[Vec<Polygon>]) -> Vec<Polygon> {
    let fills: Vec<Fill> = polygons.iter().map(|p| Fill { net: "GND", polygons: p, index: FillIndex::new(p) }).collect();
    ground_pieces(&fills.iter().collect::<Vec<_>>()).unwrap()
}

#[test]
fn touching_fills_of_two_zones_are_one_piece() {
    // A small fill of zone A that touches the fill of zone B (same net) is the same copper, not an island.
    let one = pieces(&[vec![square(0.0, 0.0, 10.0, 10.0)], vec![square(10.0, 4.0, 10.3, 4.3)]]);
    assert_eq!(one.len(), 1);
    assert_eq!(one[0].bbox().unwrap().right, from_mm(10.3));
}

#[test]
fn separate_fills_stay_separate_pieces() {
    assert_eq!(pieces(&[vec![square(0.0, 0.0, 1.0, 1.0)], vec![square(5.0, 5.0, 6.0, 6.0)]]).len(), 2);
}
