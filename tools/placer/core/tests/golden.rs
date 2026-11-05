//! Seeded results of the Python placer: CPython 3.13.5 and numpy 2.2.6 in iot-lab-route:10.0.
//!
//! The expected poses are exact. The analytic placement cannot be: numpy runs its matrix products on OpenBLAS (another
//! summation order, FMA), and its descent amplifies that roundoff about 1e9 times in 100 steps, so the trace is checked
//! against a growing tolerance. Files: ENV-SENSE and PWR-24V-5V as read by cli.py, and synthetic.json, a made-up problem
//! that reaches what these two boards leave at zero (domains, keepouts, borders, edge and region rules, class gaps,
//! locked copper, blocked via sites, walled-in pins, a mains fault).

use iotplace::bench::scramble;
use iotplace::gplace::place;
use iotplace::params::Params;
use iotplace::problem::{Pose, Problem};
use iotplace::search::{Plan, optimize};
use serde::Deserialize;
use std::path::PathBuf;

#[derive(Deserialize)]
struct PlanFile {
    workers: usize,
    epochs: usize,
    steps: usize,
    seed: u64,
    top: usize,
}

#[derive(Deserialize)]
struct Candidate {
    pose: Pose,
    cost: f64,
    illegal: Vec<String>,
    mains: usize,
}

#[derive(Deserialize)]
struct Case {
    problem: String,
    plan: PlanFile,
    params: Vec<String>,
    t0: f64,
    candidates: Vec<Candidate>,
}

#[derive(Deserialize)]
struct Gplace {
    iterations: usize,
    overflow: Vec<f64>,
    wa: Vec<f64>,
    pose: Pose,
}

#[derive(Deserialize)]
struct Scramble {
    uniform: Vec<(f64, f64)>,
    gauss: Vec<(f64, f64)>,
}

#[derive(Deserialize)]
struct Golden {
    cases: Vec<Case>,
    gplace: Gplace,
    scramble: Scramble,
}

fn file(name: &str) -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/golden").join(name)
}

fn golden() -> Golden {
    serde_json::from_str(&std::fs::read_to_string(file("expected.json")).unwrap()).unwrap()
}

fn close(a: f64, b: f64, tolerance: f64) -> bool {
    (a - b).abs() <= tolerance * a.abs().max(b.abs()).max(1.0)
}

fn sorted(names: &[String]) -> Vec<&String> {
    let mut v: Vec<&String> = names.iter().collect();
    v.sort();
    v
}

fn check_case(c: &Case) {
    let mut pr = Problem::load(&file(&c.problem)).unwrap();
    let p = &c.plan;
    let plan = Plan { workers: p.workers, epochs: p.epochs, steps: p.steps, seed: p.seed, top: p.top };
    // The Python search had no exact edge check: it would rank other candidates first on these boards.
    let args = [c.params.as_slice(), &["exact_edge=0".to_string()]].concat();
    let res = optimize(&mut pr, &Params::from_args(&args).unwrap(), plan, &|_| {}).unwrap();
    let name = format!("{} {:?}", c.problem, c.params);
    assert!(close(res.t0, c.t0, 1e-12), "{name}: t0 {} vs {}", res.t0, c.t0);
    assert_eq!(res.candidates.len(), c.candidates.len(), "{name}");
    for (got, want) in res.candidates.iter().zip(&c.candidates) {
        assert_eq!(got.pose, want.pose, "{name}: pose");
        assert!(close(got.cost, want.cost, 1e-12), "{name}: cost {} vs {}", got.cost, want.cost);
        // Python ran out of legal_time on the synthetic problem: its timeout lists units by index, a finished
        // legalizer by size. The order is the clock, the set is the result.
        assert_eq!(sorted(&got.illegal), sorted(&want.illegal), "{name}: illegal");
        assert_eq!(got.mains.len(), want.mains, "{name}: mains");
    }
}

#[test]
fn seeded_search_matches_python_exactly() {
    golden().cases.iter().for_each(check_case);
}

#[test]
fn analytic_placement_follows_the_python_trace() {
    let g = golden().gplace;
    let pr = Problem::load(&file("synthetic.json")).unwrap();
    let (pose, history) = place(&pr, &Params::default(), &|_| {});
    assert_eq!(history.len(), g.iterations);
    for (k, it) in history.iter().enumerate() {
        // measured: 1e-16 at the start, 5.5e-7 at step 100
        let tolerance = if k < 30 { 1e-11 } else { 1e-5 };
        assert!(close(it.overflow, g.overflow[k], tolerance), "step {k}: {} vs {}", it.overflow, g.overflow[k]);
        assert!(close(it.wa, g.wa[k], tolerance), "step {k}: {} vs {}", it.wa, g.wa[k]);
    }
    for (a, b) in pose.iter().zip(&g.pose) {
        assert!((a.0 - b.0).abs() < 1e-3 && (a.1 - b.1).abs() < 1e-3, "{a:?} vs {b:?}");
    }
}

#[test]
fn scramble_matches_python_exactly() {
    let g = golden().scramble;
    let pr = Problem::load(&file("ENV-SENSE.json")).unwrap();
    let places = |pose: Pose| pose.into_iter().map(|q| (q.0, q.1)).collect::<Vec<_>>();
    assert_eq!(places(scramble(&pr, 7, None)), g.uniform);
    assert_eq!(places(scramble(&pr, 3, Some(2.5))), g.gauss);
}

#[test]
fn a_problem_outside_this_search_is_refused() {
    let text = r#"{"units":[],"nets":[],"board":{"outline":[[0,0],[1,0],[1,1]]},"engineering":{"rules":[]}}"#;
    let pr: Problem = serde_json::from_str(text).unwrap();
    assert!(pr.check_supported().is_err());
}
