//! The analytic global placement: WA wirelength, electrostatic density, Nesterov with a growing density weight.

mod common;

use common::{box_board, fixed_unit, parse, problem_json, random_problem, square_board, start_terms, terms, unit, within};
use iotplace::gplace::{Matrix, Model, State, place};
use iotplace::numeric::{PyRandom, median};
use iotplace::params::Params;
use iotplace::problem::{Pose, Problem};
use iotplace::search::{Plan, optimize};
use serde_json::{Value, json};
use std::f64::consts::PI;

fn params(args: &[&str]) -> Params {
    Params::from_args(args).unwrap()
}

fn hpwl(pr: &Problem, pose: &Pose) -> f64 {
    terms(pr, pose, &Params::default()).hpwl
}

fn silent(_: &str) {}

fn start(m: &Model) -> State {
    State { x: m.x0.clone(), y: m.y0.clone() }
}

/// Two groups of 4 units (2 x 2 mm); each group is a clique of heavy nets; one light net between them.
fn clusters(seed: u64, stacked: bool) -> Value {
    let mut rng = PyRandom::new(seed);
    let units: Vec<Value> = (0..8)
        .map(|i| {
            let (x, y) = if stacked { (20.0, 10.0) } else { (rng.uniform(3.0, 37.0), rng.uniform(3.0, 17.0)) };
            unit(&format!("U{i}"), x, y, json!([[-1, -1, 1, 1, 0.0]]))
        })
        .collect();
    let pin = |u: usize| json!([u, -0.1, -0.1, 0.1, 0.1]);
    let mut nets = Vec::new();
    for g in [0, 4] {
        for a in g..g + 4 {
            for b in a + 1..g + 4 {
                nets.push(json!({"name": format!("N{a}{b}"), "weight": 1.0, "pins": [pin(a), pin(b)]}));
            }
        }
    }
    nets.push(json!({"name": "LINK", "weight": 0.1, "pins": [pin(0), pin(4)]}));
    problem_json(Value::from(units), Value::from(nets), box_board(40.0, 20.0))
}

#[test]
fn the_wa_gradient_equals_a_finite_difference() {
    let pr = parse(random_problem(&mut PyRandom::new(4), 8, 10));
    let p = params(&["gamma=0.8"]);
    let m = Model::new(&pr, &p);
    let (gamma, h) = (0.8, 1e-6);
    let n = m.x0.len();
    let (_, g) = m.wa(&start(&m), gamma);
    let at = |i: usize, dx: f64, dy: f64| {
        let mut z = start(&m);
        z.x[i] += dx;
        z.y[i] += dy;
        m.wa(&z, gamma).0
    };
    for &i in &m.movable {
        within(g[i], (at(i, h, 0.0) - at(i, -h, 0.0)) / (2.0 * h), 5e-5);
        within(g[n + i], (at(i, 0.0, h) - at(i, 0.0, -h)) / (2.0 * h), 5e-5);
    }
    assert!(m.fixed.iter().all(|&i| g[i] == 0.0 && g[n + i] == 0.0));
}

#[test]
fn wa_tends_to_hpwl_for_a_small_gamma() {
    let pr = parse(random_problem(&mut PyRandom::new(5), 8, 10));
    let p = params(&[]);
    let m = Model::new(&pr, &p);
    let v = m.wa(&start(&m), 0.01).0;
    assert!((v - start_terms(&pr, &p).hpwl).abs() <= 0.05 * v);
}

#[test]
fn the_density_gradient_pushes_stacked_units_apart() {
    let mut v = clusters(1, true);
    v["units"][1]["x"] = json!(20.5); // U1 right of the stack centre
    let pr = parse(v);
    let p = params(&["bins=32"]);
    let m = Model::new(&pr, &p);
    let (grad, overflow) = m.density(&start(&m));
    assert!(overflow > 0.5);
    assert!(grad[1] < 0.0); // descent (-gradient) moves U1 to the right, away from the stack
}

#[test]
fn the_overflow_falls_over_the_iterations() {
    let (_, history) = place(&parse(clusters(1, true)), &params(&["bins=32", "iters=400"]), &silent);
    assert!(history[0].overflow > 0.5);
    assert!(history.last().unwrap().overflow < 0.15);
}

#[test]
fn fixed_units_and_the_board_edge_hold() {
    let mut v = clusters(1, false);
    v["units"][2]["fixed"] = json!(true);
    let pr = parse(v);
    let (pose, _) = place(&pr, &params(&["bins=32", "iters=300"]), &silent);
    assert_eq!((pose[2].0, pose[2].1), (pr.units[2].x, pr.units[2].y));
    for &(x, y, r) in &pose {
        assert!((1.0 - 1e-6..=39.0 + 1e-6).contains(&x) && (1.0 - 1e-6..=19.0 + 1e-6).contains(&y));
        assert_eq!(r, 0); // rotation is left to the annealer
    }
}

#[test]
fn an_edge_anchored_unit_ends_on_its_side() {
    let mut v = clusters(1, false);
    v["board"]["edge_clearance"] = json!(0.5);
    v["units"][5]["edge"] = json!({"at": [0.0, 1.0], "sides": "B", "tol": 0.5}); // its S side on the bottom edge
    let (pose, _) = place(&parse(v), &params(&["bins=32", "iters=300"]), &silent);
    within(pose[5].1 + 1.0, 20.0 - 0.5, 5e-8);
}

/// 20 nets between two fixed units run over A; B sits in free bins.
fn bundle(track: Option<f64>) -> Problem {
    let body = json!([[-1, -1, 1, 1, 0.0]]);
    let units = json!([
        fixed_unit("F1", 2.0, 10.0, body.clone()),
        fixed_unit("F2", 38.0, 10.0, body.clone()),
        unit("A", 20.0, 10.0, body.clone()),
        unit("B", 20.0, 17.0, body),
    ]);
    let net = |k: usize| {
        let mut n = json!({"name": format!("N{k}"), "weight": 1.0, "pins": [[0, -0.1, -1.1, 0.1, -0.9], [1, -0.1, 0.9, 0.1, 1.1]]});
        if let Some(t) = track {
            n["track"] = json!(t);
        }
        n
    };
    parse(problem_json(units, Value::from((0..20).map(net).collect::<Vec<_>>()), box_board(40.0, 20.0)))
}

#[test]
fn units_under_congestion_grow_and_free_units_do_not() {
    let pr = bundle(None);
    let p = params(&["bins=32", "max_infl=2"]);
    let mut m = Model::new(&pr, &p);
    let (x, y) = (m.x0.clone(), m.y0.clone());
    m.inflate(&x, &y);
    within(m.bodies[2].inflation, 2.0, 5e-8);
    within(m.bodies[3].inflation, 1.0, 5e-8);
    within(m.bodies[2].area, 2.0 * 4.0, 5e-8);
    within(m.bodies[3].area, 4.0, 5e-8);
}

#[test]
fn a_wide_track_net_adds_track_over_pitch_times_the_demand() {
    let p = params(&["bins=32", "pitch=0.4", "tracks=1"]);
    let rudy = |pr: &Problem| {
        let m = Model::new(pr, &p);
        m.rudy(&m.x0, &m.y0).data
    };
    let (plain, wide) = (rudy(&bundle(None)), rudy(&bundle(Some(0.7))));
    plain.iter().zip(&wide).for_each(|(a, b)| assert!((b - 1.75 * a).abs() <= 1e-7 * b.abs()));
}

fn group_spread(pose: &Pose) -> f64 {
    let spread = |g: std::ops::Range<usize>| {
        let n = g.len() as f64;
        let (cx, cy) = (g.clone().map(|i| pose[i].0).sum::<f64>() / n, g.clone().map(|i| pose[i].1).sum::<f64>() / n);
        g.map(|i| (pose[i].0 - cx).hypot(pose[i].1 - cy)).fold(0.0, f64::max)
    };
    spread(0..4).max(spread(4..8))
}

#[test]
fn two_clusters_converge() {
    let pr = parse(clusters(3, false));
    let start_length = hpwl(&pr, &pr.initial_pose());
    let (mut lengths, mut spreads) = (Vec::new(), Vec::new());
    for seed in 1..6 {
        let p = params(&["bins=32", "iters=500", &format!("seed={seed}")]);
        let (pose, history) = place(&pr, &p, &silent);
        assert!(history.last().unwrap().overflow < 0.15);
        lengths.push(hpwl(&pr, &pose));
        spreads.push(group_spread(&pose));
    }
    assert!(median(&lengths) < 0.45 * start_length); // median of 5 seeds
    assert!(median(&spreads) < 4.5); // each group stays together
}

#[test]
fn optimize_with_global_starts_the_annealer_from_the_global_placement() {
    let args = ["global=1", "bins=32", "iters=500", "rudy_cell=1", "mask_cell=0.25"];
    let p = params(&args);
    let original = parse(clusters(3, false));
    let (pose, history) = place(&original, &p, &silent);
    let mut pr = parse(clusters(3, false));
    let res = optimize(&mut pr, &p, Plan { workers: 1, epochs: 2, steps: 300, seed: 1, top: 1 }, &|_| {}).unwrap();
    assert_eq!(res.initial.pose, pose);
    assert_eq!(res.global.as_ref().unwrap().iters, history.len());
    assert!(res.candidates[0].components.hpwl < hpwl(&original, &original.initial_pose()));
}

/// Density on an 8 x 8 mm board with 4 x 4 bins of 2 x 2 mm (target 0.9: room 3.6 mm2 per bin).
fn one_unit_overflow(x: f64, y: f64) -> f64 {
    let pr = parse(problem_json(json!([unit("A", x, y, json!([[-1, -1, 1, 1, 0.0]]))]), json!([]), square_board(8.0, 0.0)));
    let p = params(&["bins=4"]);
    let m = Model::new(&pr, &p);
    m.density(&start(&m)).1
}

#[test]
fn a_unit_on_one_bin_overflows_by_its_area_over_the_room() {
    within(one_unit_overflow(3.0, 3.0), (4.0 - 3.6) / 4.0, 5e-8);
}

#[test]
fn a_unit_on_the_corner_of_4_bins_does_not_overflow() {
    within(one_unit_overflow(4.0, 4.0), 0.0, 5e-8);
}

#[test]
fn the_field_solves_the_poisson_equation() {
    // rho = 1 + cos(pi x / W) + cos(pi x / W) cos(pi y / H): the potential of each cosine mode is the mode over
    // (wu^2 + wv^2) (the constant has none), and the field is minus its gradient (DCT on bin centres: exact).
    let pr = parse(clusters(2, false));
    let p = params(&["bins=16"]);
    let m = Model::new(&pr, &p);
    let b = m.bounds;
    let (ku, kv) = (PI / (b.x1 - b.x0), PI / (b.y1 - b.y0));
    let centres = |e: &[f64], origin: f64| e.windows(2).map(|w| (w[0] + w[1]) / 2.0 - origin).collect::<Vec<_>>();
    let (xc, yc) = (centres(&m.ex, b.x0), centres(&m.ey, b.y0));
    let n = xc.len();
    let rho = Matrix::from_fn(n, n, |i, j| {
        let (cx, cy) = ((ku * xc[i]).cos(), (kv * yc[j]).cos());
        1.0 + cx + cx * cy
    });
    let (ex, ey) = m.field(&rho);
    let (k1, k2) = (ku * ku, ku * ku + kv * kv);
    for i in 0..n {
        for j in 0..n {
            let (cx, sx, cy, sy) = ((ku * xc[i]).cos(), (ku * xc[i]).sin(), (kv * yc[j]).cos(), (kv * yc[j]).sin());
            within(ex.at(i, j), ku * sx / k1 + ku * sx * cy / k2, 1e-9);
            within(ey.at(i, j), kv * cx * sy / k2, 1e-9);
        }
    }
}

#[test]
fn one_seed_gives_one_result() {
    let run = |seed: &str| place(&parse(clusters(3, false)), &params(&["bins=32", "iters=300", seed]), &silent).0;
    let (a, b, c) = (run("seed=5"), run("seed=5"), run("seed=6"));
    assert_eq!(a, b);
    assert_ne!(a, c);
}
