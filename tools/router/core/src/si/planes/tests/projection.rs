//! The continuous projection and its index: the values of tools/test_si_projection.py, test_si_junctions.py, test_si_spatial.py and
//! test_si_speed_index.py.
use super::super::detour::{Plane, detour_mm};
use super::super::projection::{Boundaries, Edge as Line, EdgeIndex, PathInputs, Round, continuous_reference, evaluate_paths, reference_breaks};
use super::super::sample::{Anchor, NetResult, P, RefAt, Run};
use super::super::screen::{Edges, d124c_reference_failures, reference_assessment};
use super::super::spec::{Caps, Spec};
use super::detour::rectangle;
use super::{domain_of, edges_of, known, one};
use crate::si::fixture::{near, spec};
use std::f64::consts::PI;

const ARC: [P; 3] = [(1.0, 0.0), (0.0, 1.0), (-1.0, 0.0)];

fn project_net<'a>(paths: &[Vec<P>], lines: Vec<Line>, at: impl Fn(f64, f64) -> Option<&'a str> + 'a, anchors: &[Anchor], s: &Spec, net: &str, caps: &Caps) -> NetResult {
    let index = EdgeIndex::new(lines);
    let ref_at: &RefAt<'a> = &at;
    evaluate_paths(paths, &PathInputs { boundaries: Some(&index), ref_at, domain: Some("GND"), anchors, spec: s, net, caps })
}

fn project<'a>(paths: &[Vec<P>], lines: Vec<Line>, at: impl Fn(f64, f64) -> Option<&'a str> + 'a, s: &Spec) -> NetResult {
    project_net(paths, lines, at, &[], s, "SIG", &Caps::new())
}

fn path(points: &[P]) -> Vec<Vec<P>> {
    vec![points.to_vec()]
}

fn terminals(r: &NetResult) -> Vec<usize> {
    let mut counts: Vec<usize> = r.runs.iter().map(|run| run.terminals.len()).collect();
    counts.sort_unstable();
    counts
}

/// A spec with no via allowance: pure geometry, not an accepted production spec.
fn zero(extra: &[(&str, &str)], fast: &[&str]) -> Spec {
    let mut rows = vec![("adjacent", r#"{"F.Cu": "In1.Cu"}"#), ("plane_layers", r#"["In1.Cu"]"#), ("grounds", r#"["GND", "ISO"]"#)];
    rows.extend_from_slice(extra);
    let mut s = spec(&rows);
    s.via_allow_mm = 0.0;
    s.fast_top = fast.iter().map(|f| f.to_string()).collect();
    s
}

fn narrow_void(x: f64, _: f64) -> Option<&'static str> {
    if 0.11 < x && x < 0.12 { None } else { Some("GND") }
}

/// The lines of the screens with no driver looked up and no reference path.
fn screen(r: NetResult, s: &Spec) -> Vec<String> {
    let (results, domains) = (one("F.Cu", "SIG", r), domain_of("SIG", Some("GND")));
    let enforced = d124c_reference_failures(&results, &domains, s, &Edges::new(), &mut |_, _, _, _| None, f64::INFINITY).unwrap();
    assert_eq!(enforced, reference_assessment(&results, &domains, s, &Edges::new(), &mut |_, _, _, _| None, f64::INFINITY).unwrap().screen);
    enforced
}

#[test]
fn the_exact_narrow_void_of_a_fast_crossing() {
    let s = zero(&[], &["SIG"]);
    let r = project(&path(&[(0.0, 0.0), (1.0, 0.0)]), rectangle(0.11, -1.0, 0.12, 1.0), narrow_void, &s);
    near(r.bad, 0.01);
    assert_eq!(terminals(&r), [2]);
    assert!(screen(r, &s).iter().any(|l| l.contains("fast-crossing")));
}

#[test]
fn a_slow_unknown_void_does_not_disappear() {
    let s = zero(&[], &[]);
    let r = project(&path(&[(0.0, 0.0), (1.0, 0.0)]), rectangle(0.11, -1.0, 0.12, 1.0), narrow_void, &s);
    assert!(screen(r, &s).iter().any(|l| l.contains("unknown-driver")));
}

#[test]
fn a_wrong_domain_narrow_strip() {
    let s = zero(&[], &[]);
    let r = project(&path(&[(0.0, 0.0), (1.0, 0.0)]), rectangle(0.11, -1.0, 0.12, 1.0), |x, _| Some(if 0.11 < x && x < 0.12 { "ISO" } else { "GND" }), &s);
    near(r.cross, 0.01);
    assert!(screen(r, &s).iter().any(|l| l.contains("domain-cross")));
}

#[test]
fn an_arc_crossing_between_the_original_midpoints() {
    let r = project(&path(&ARC), rectangle(0.11, -2.0, 0.12, 2.0), narrow_void, &zero(&[], &["SIG"]));
    near(r.length, PI);
    near(r.bad, 0.11f64.acos() - 0.12f64.acos());
    assert_eq!(r.runs[0].terminals.len(), 2);
}

#[test]
fn an_anchor_circle_splits_a_partial_permission_exactly() {
    let r = project_net(&path(&[(0.0, 0.0), (1.0, 0.0)]), Vec::new(), |_, _| None, &[(0.0, 0.0, 0.12)], &zero(&[], &[]), "SIG", &Caps::new());
    near(r.bad, 0.88);
    assert_eq!(r.runs[0].terminals.len(), 1);
}

#[test]
fn an_arc_anchor_intersection_is_exact() {
    let r = project_net(&path(&ARC), Vec::new(), |_, _| None, &[(1.0, 0.0, 0.12)], &zero(&[], &[]), "SIG", &Caps::new());
    near(r.bad, PI - 2.0 * 0.06f64.asin());
}

#[test]
fn an_exemption_cannot_hide_the_unexempt_fraction() {
    let s = zero(&[("exempt", r#"{"areas": [{"box": [0.11, -1, 0.115, 1], "nets": ["SIG"], "reason": "bounded fixture exemption"}]}"#)], &[]);
    near(project(&path(&[(0.0, 0.0), (1.0, 0.0)]), rectangle(0.11, -1.0, 0.12, 1.0), narrow_void, &s).bad, 0.005);
}

#[test]
fn a_cap_boundary_limits_an_alt_reference() {
    let s = zero(&[("alt_refs", r#"{"VDD": {"domain": "GND", "cap_mm": 0.12, "reason": "fixture"}}"#)], &[]);
    let caps = Caps::from([("VDD".to_string(), vec![(0.0, 0.0)])]);
    near(project_net(&path(&[(0.0, 0.0), (1.0, 0.0)]), Vec::new(), |_, _| Some("VDD"), &[], &s, "SIG", &caps).bad, 0.88);
}

#[test]
fn a_native_junction_connects_intervals_without_a_step_jump() {
    let paths = vec![vec![(0.0, 0.0), (0.3, 0.0)], vec![(0.3, 0.0), (1.0, 0.0)]];
    let r = project(&paths, rectangle(0.1, -1.0, 0.5, 1.0), |x, _| if 0.1 < x && x < 0.5 { None } else { Some("GND") }, &zero(&[], &[]));
    assert_eq!(terminals(&r), [2]);
    near(r.bad, 0.4);
}

#[test]
fn separated_bad_paths_are_not_merged_by_the_step_radius() {
    let paths = vec![vec![(0.0, 0.0), (0.1, 0.0)], vec![(0.2, 0.0), (0.3, 0.0)]];
    assert_eq!(project(&paths, Vec::new(), |_, _| None, &zero(&[], &[])).runs.len(), 2);
}

#[test]
fn a_reversed_arc_has_the_same_measure() {
    for points in [ARC, [(-1.0, 0.0), (0.0, 1.0), (1.0, 0.0)]] {
        near(project(&path(&points), rectangle(0.11, -2.0, 0.12, 2.0), narrow_void, &zero(&[], &[])).bad, 0.11f64.acos() - 0.12f64.acos());
    }
}

// Junctions: the centreline, independent of the sample step

fn junction_spec(step: f64) -> Spec {
    let step = step.to_string();
    spec(&[("adjacent", r#"{"F.Cu": "In1.Cu"}"#), ("plane_layers", r#"["In1.Cu"]"#), ("grounds", r#"["GND"]"#), ("step_mm", &step), ("via_allow_mm", "0.001")])
}

#[test]
fn unsplit_and_split_t_junctions_have_the_same_detour() {
    let at = |x: f64, y: f64| if (-1.0..=3.0).contains(&x) && (0.1..=2.0).contains(&y) { Some("GND") } else { None };
    let lines = rectangle(-1.0, 0.1, 3.0, 2.0);
    let branches = vec![vec![(0.43, 0.0), (0.43, 1.0)], vec![(1.57, 0.0), (1.57, 1.0)]];
    let split = vec![vec![(0.0, 0.0), (0.43, 0.0)], vec![(0.43, 0.0), (1.57, 0.0)], vec![(1.57, 0.0), (2.0, 0.0)]];
    let edges = edges_of(&[("SIG", known(1.0, "controlled geometry-only fixture"))]);
    let ok = |x: f64, y: f64| at(x, y) == Some("GND");
    let edge = |a: P, b: P| continuous_reference(&ok, &Boundaries { index: None, extra: lines.clone() }, a, b, &[]);
    for step in [0.17, 0.25, 0.31] {
        for main in [vec![vec![(0.0, 0.0), (2.0, 0.0)]], split.clone()] {
            let s = junction_spec(step);
            let r = project(&[main, branches.clone()].concat(), lines.clone(), at, &s);
            assert_eq!(terminals(&r), [2]);
            near(r.bad, 2.2);
            let mut detour = |_: &str, _: &str, run: &Run, budget: f64| detour_mm(Plane { ok: &ok, edge: &edge }, None, &run.terminals, budget, 0.1, &[]);
            let assessed = reference_assessment(&one("F.Cu", "SIG", r), &domain_of("SIG", Some("GND")), &s, &edges, &mut detour, 20.0).unwrap();
            assert_eq!(assessed.screen, [""; 0]);
        }
    }
}

#[test]
fn a_line_crossing_inside_both_paths() {
    let mut lines = rectangle(-2.0, 0.1, 2.0, 2.0);
    lines.extend(rectangle(-2.0, -2.0, 2.0, -0.1));
    let paths = vec![vec![(-1.0, 0.0), (1.0, 0.0)], vec![(0.0, -1.0), (0.0, 1.0)]];
    let r = project(&paths, lines, |_, y: f64| if y.abs() >= 0.1 { Some("GND") } else { None }, &junction_spec(0.31));
    assert_eq!(terminals(&r), [2]);
    near(r.bad, 2.2);
}

fn above(limit: f64) -> impl Fn(f64, f64) -> Option<&'static str> {
    move |_, y| if y >= limit { Some("GND") } else { None }
}

#[test]
fn an_endpoint_on_an_arc_interior() {
    let paths = vec![ARC.to_vec(), vec![(0.8, 0.6), (0.8, 1.5)]];
    let r = project(&paths, rectangle(-2.0, 0.7, 2.0, 2.0), above(0.7), &junction_spec(0.25));
    assert_eq!(terminals(&r), [1, 2]);
}

#[test]
fn a_line_crosses_an_arc_interior() {
    let paths = vec![ARC.to_vec(), vec![(0.8, -0.5), (0.8, 1.5)]];
    let r = project(&paths, rectangle(-2.0, 0.9, 2.0, 2.0), above(0.9), &junction_spec(0.25));
    assert_eq!(terminals(&r), [1, 2]);
}

#[test]
fn an_arc_crossing_inside_both_sweeps() {
    let paths = vec![ARC.to_vec(), vec![(2.0, 0.0), (1.0, 1.0), (0.0, 0.0)]];
    let r = project(&paths, rectangle(-2.0, 0.9, 3.0, 2.0), above(0.9), &junction_spec(0.25));
    assert_eq!(terminals(&r), [1, 1, 2]);
}

#[test]
fn coincident_arcs_partition_at_the_other_native_endpoint() {
    // (1, 0) is an endpoint of the first arc and an interior point of the second. Equal supporting circles alone have no finite
    // intersections.
    let paths = vec![ARC.to_vec(), vec![(0.0, 1.0), (1.0, 0.0), (0.0, -1.0)]];
    assert_eq!(project(&paths, rectangle(-2.0, 0.9, 2.0, 2.0), above(0.9), &junction_spec(0.31)).runs.len(), 2);
}

#[test]
fn a_near_endpoint_is_no_step_radius_connection() {
    let paths = vec![vec![(0.0, 0.0), (2.0, 0.0)], vec![(0.43, 0.01), (0.43, 1.0)]];
    for step in [0.17, 0.25, 0.31] {
        let r = project(&paths, rectangle(-1.0, 0.1, 3.0, 2.0), above(0.1), &junction_spec(step));
        assert_eq!(terminals(&r), [0, 1]);
    }
}

#[test]
fn an_arc_support_circle_outside_the_sweep_does_not_join() {
    let paths = vec![ARC.to_vec(), vec![(-0.8, -0.6), (-0.8, -1.5)]];
    let r = project(&paths, rectangle(-2.0, 0.9, 2.0, 2.0), above(0.9), &junction_spec(0.25));
    assert_eq!(terminals(&r), [0, 1, 1]);
}

// The index gives the answers of the plain list

/// A small generator: the seeds of the Python tests picked their cases, the cases are what matter.
struct Rng(u64);

impl Rng {
    fn unit(&mut self) -> f64 {
        self.0 = self.0.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
        (self.0 >> 11) as f64 / (1u64 << 53) as f64
    }

    fn uniform(&mut self, low: f64, high: f64) -> f64 {
        low + (high - low) * self.unit()
    }

    fn point(&mut self, low: f64, high: f64) -> P {
        (self.uniform(low, high), self.uniform(low, high))
    }
}

fn plain(lines: &[Line]) -> Boundaries<'static> {
    Boundaries { index: None, extra: lines.to_vec() }
}

fn indexed(index: &EdgeIndex) -> Boundaries<'_> {
    Boundaries { index: Some(index), extra: Vec::new() }
}

#[test]
fn random_exact_intersections_and_continuous_results_agree() {
    let mut rng = Rng(777);
    let lines: Vec<Line> = (0..250).map(|_| (rng.point(-100.0, 100.0), rng.point(-100.0, 100.0))).collect();
    let circles: Vec<Round> = (0..60).map(|_| (rng.point(-100.0, 100.0), rng.uniform(0.0, 10.0))).collect();
    let index = EdgeIndex::new(lines.clone());
    let ok = |x: f64, y: f64| ((x * 10.0) as i64 + (y * 10.0) as i64) % 7 != 0;
    for _ in 0..300 {
        let (a, b) = (rng.point(-120.0, 120.0), rng.point(-120.0, 120.0));
        for (start, end) in [(a, b), (b, a)] {
            assert_eq!(reference_breaks(&plain(&lines), start, end, &circles), reference_breaks(&indexed(&index), start, end, &circles));
            assert_eq!(continuous_reference(&ok, &plain(&lines), start, end, &circles), continuous_reference(&ok, &indexed(&index), start, end, &circles));
        }
    }
}

#[test]
fn tangency_collinear_zero_length_and_a_narrow_void_agree() {
    let lines: Vec<Line> = vec![
        ((0.11, -1.0), (0.11, 1.0)),
        ((0.12, -1.0), (0.12, 1.0)),
        ((0.0, 0.0), (0.25, 0.0)),
        ((0.25, 0.0), (0.25, 0.0)),
        ((0.0, 1e-16), (1.0, 1e-16)),
    ];
    let circles: Vec<Round> = vec![((0.5, 1.0), 1.0), ((0.5, 0.0), 0.0), ((1.0, 0.0), 1e-9)];
    let index = EdgeIndex::new(lines.clone());
    for (a, b) in [((0.0, 0.0), (1.0, 0.0)), ((1.0, 0.0), (0.0, 0.0)), ((0.11, 0.0), (0.11, 0.0)), ((0.0, 0.0), (1e-9, 0.0)), ((0.0, 0.0), (1.0, 1e-14))] {
        assert_eq!(reference_breaks(&plain(&lines), a, b, &circles), reference_breaks(&indexed(&index), a, b, &circles));
    }
    assert!(!continuous_reference(&|x, _| !(0.11 < x && x < 0.12), &indexed(&index), (0.0, 0.0), (1.0, 0.0), &[]));
}

#[test]
fn intersections_agree_at_every_scale() {
    let mut rng = Rng(3);
    for exponent in [-12, -8, -3, 0, 6, 12] {
        let scale = 10f64.powi(exponent);
        for _ in 0..100 {
            let lines: Vec<Line> = (0..10).map(|_| (rng.point(-scale, scale), rng.point(-scale, scale))).collect();
            let circles: Vec<Round> = (0..10).map(|_| (rng.point(-scale, scale), rng.unit() * scale)).collect();
            let (a, b) = (rng.point(-scale, scale), rng.point(-scale, scale));
            assert_eq!(reference_breaks(&plain(&lines), a, b, &circles), reference_breaks(&indexed(&EdgeIndex::new(lines.clone())), a, b, &circles));
        }
    }
}

#[test]
fn a_query_includes_box_edges_and_keeps_the_original_order() {
    let index = EdgeIndex::new((0..100).map(|i| ((i as f64, 0.0), (i as f64 + 2.0, 2.0))).collect());
    let found: Vec<f64> = index.near((20.0, 0.0), (20.0, 1e-5)).iter().map(|e| e.0.0).collect();
    assert_eq!(found, [18.0, 19.0, 20.0]);
    assert_eq!(index.near((-2.0, 0.0), (-1.0, 1.0)), []);
}

/// The edges a brute-force scan finds for the box of a-b, with the margin of the index.
fn brute(lines: &[Line], a: P, b: P) -> Vec<Line> {
    let margin = 1e-6;
    let (x0, y0, x1, y1) = (a.0.min(b.0) - margin, a.1.min(b.1) - margin, a.0.max(b.0) + margin, a.1.max(b.1) + margin);
    lines.iter().copied().filter(|(p, q)| p.0.min(q.0) <= x1 && x0 <= p.0.max(q.0) && p.1.min(q.1) <= y1 && y0 <= p.1.max(q.1)).collect()
}

#[test]
fn the_tree_and_a_brute_scan_agree() {
    let mut rng = Rng(11);
    for scale in [1e-3, 1.0, 150.0, 1e6] {
        let mut lines: Vec<Line> = (0..600).map(|_| {
            let (x, y) = rng.point(-scale, scale);
            ((x, y), (x + scale * 0.03 * rng.unit(), y + scale * 0.03 * rng.unit()))
        }).collect();
        lines.extend([((-scale, -scale), (scale, scale)), ((1.0, 1.0), (1.0, 1.0)), ((-scale, 0.0), (scale, 0.0))]);
        let index = EdgeIndex::new(lines.clone());
        for _ in 0..800 {
            let a = rng.point(-1.2 * scale, 1.2 * scale);
            let size = [0.01, 0.1, 1.0][(rng.unit() * 3.0) as usize] * scale; // never under the 1 nm a query answers with every edge
            let b = (a.0 + size * (0.1 + rng.unit()), a.1 + size * (0.1 + rng.unit()));
            assert_eq!(index.near(a, b), brute(&lines, a, b));
        }
        let outside = (-2.0 * scale, -2.0 * scale);
        assert_eq!(index.near(outside, (-1.5 * scale, -1.5 * scale)), brute(&lines, outside, (-1.5 * scale, -1.5 * scale)));
    }
}

#[test]
fn box_edges_are_inclusive() {
    let lines: Vec<Line> = (0..100).map(|i| ((i as f64, 0.0), (i as f64 + 1.0, 1.0))).collect();
    let index = EdgeIndex::new(lines.clone());
    for (a, b) in [((5.0, 0.0), (5.0, 1e-5)), ((5.5, 0.5), (5.5, 0.50001)), ((99.0, 1.0), (99.0, 1.00001)), ((100.0, 0.0), (100.0, 1e-5)), ((0.0, 1.0), (0.0, 1.00001))] {
        assert_eq!(index.near(a, b), brute(&lines, a, b));
    }
}

#[test]
fn an_index_and_extra_edges_equal_one_plain_list() {
    let mut rng = Rng(5);
    let lines: Vec<Line> = (0..400).map(|_| (rng.point(0.0, 50.0), rng.point(0.0, 50.0))).collect();
    let mut extra: Vec<Line> = (0..20).map(|_| (rng.point(0.0, 50.0), rng.point(0.0, 50.0))).collect();
    extra.push(((1.0, 1.0), (1.0, 1.0)));
    let index = EdgeIndex::new(lines.clone());
    let union = Boundaries { index: Some(&index), extra: extra.clone() };
    let every = plain(&[lines, extra].concat());
    let circles: Vec<Round> = (0..20).map(|_| (rng.point(0.0, 50.0), rng.uniform(0.0, 3.0))).collect();
    for _ in 0..500 {
        let a = rng.point(0.0, 50.0);
        let b = if rng.unit() < 0.5 { (a.0 + rng.uniform(-0.5, 0.5), a.1 + rng.uniform(-0.5, 0.5)) } else { rng.point(0.0, 50.0) };
        assert_eq!(reference_breaks(&union, a, b, &circles), reference_breaks(&every, a, b, &circles));
    }
}

#[test]
fn far_edges_in_the_index_change_no_projection() {
    let s = spec(&[
        ("adjacent", r#"{"F.Cu": "In1.Cu"}"#),
        ("plane_layers", r#"["In1.Cu"]"#),
        ("grounds", r#"["GND"]"#),
        ("via_allow_mm", "0.3"),
        ("exempt", r#"{"areas": [{"box": [4, 4, 6, 6], "nets": ["N"], "reason": "fixture"}]}"#),
    ]);
    let mut lines = rectangle(0.0, 0.0, 10.0, 10.0);
    lines.extend(rectangle(3.0, 3.0, 7.0, 7.0));
    let mut far = lines.clone();
    far.extend((0..80).map(|i| ((20.0 + i as f64, 0.0), (20.0 + i as f64, 1.0))));
    let at = |x: f64, y: f64| if 0.0 < x && x < 10.0 && 0.0 < y && y < 10.0 && !(3.0 < x && x < 7.0 && 3.0 < y && y < 7.0) { Some("GND") } else { None };
    let paths = vec![vec![(1.0, 5.0), (9.0, 5.0)], vec![(5.0, 1.0), (5.0, 9.0)], vec![(1.0, 1.0), (2.0, 2.0), (3.0, 1.0)]];
    let anchors = [(1.0, 5.0, 0.2)];
    let narrow = project_net(&paths, lines, at, &anchors, &s, "N", &Caps::new());
    assert_eq!(project_net(&paths, far, at, &anchors, &s, "N", &Caps::new()), narrow);
    assert!(narrow.unref > 0.0);
}
