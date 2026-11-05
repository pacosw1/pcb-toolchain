//! The search: move legality, determinism, the legalizer, end-to-end gain.

mod common;

use common::{model, near, problem_json, square_board, unit, within};
use iotplace::evaluator::{Evaluator, Move};
use iotplace::mains::Fault;
use iotplace::numeric::PyRandom;
use iotplace::params::Params;
use iotplace::problem::{Pose, Problem};
use iotplace::search::{Candidate, Mover, Plan, Schedule, SearchResult, anneal, distinct, epoch_params, legalize, optimize, rank};
use serde_json::{Value, json};
use std::collections::BTreeSet;

fn params(extra: &[&str]) -> Params {
    let mut args = vec!["rudy_cell=1", "mask_cell=0.25", "layers=2", "pitch=0.4", "limit=1", "grid=0.05"];
    args.extend_from_slice(extra);
    Params::from_args(&args).unwrap()
}

fn run(pr: Value, p: &Params, workers: usize, epochs: usize, steps: usize, seed: u64, top: usize) -> SearchResult {
    let mut pr: Problem = common::parse(pr);
    optimize(&mut pr, p, Plan { workers, epochs, steps, seed, top }, &|_| {}).unwrap()
}

fn pose_of(r: &SearchResult, k: usize) -> &Pose {
    &r.candidates[k].pose
}

/// A fixed 1 x 1 at (5, 5); B 1 x 1 far away; one net between the centres. Optimum: B next to A at the 0.5 mm gap, HPWL 1.5.
fn two_units() -> Value {
    let body = json!([[-0.5, -0.5, 0.5, 0.5, 0.5]]);
    let mut a = unit("A", 5.0, 5.0, body.clone());
    a["fixed"] = json!(true);
    problem_json(json!([a, unit("B", 15.0, 15.0, body)]), json!([common::net("N", &[0, 1])]), square_board(20.0, 1.0))
}

/// n units in a chain net topology, scattered at random on a 30 x 30 board.
fn chain(n: usize, seed: u64) -> Value {
    let mut rng = PyRandom::new(seed);
    let units: Vec<Value> = (0..n)
        .map(|i| {
            let (x, y) = (rng.uniform(3.0, 27.0), rng.uniform(3.0, 27.0));
            let gap = if i % 4 == 0 { 1.0 } else { 0.5 };
            unit(&format!("U{i}"), x, y, json!([[-1, -0.6, 1, 0.6, gap]]))
        })
        .collect();
    let nets: Vec<Value> = (0..n - 1)
        .map(|i| json!({"name": format!("N{i}"), "weight": 1.0, "pins": [[i, 0.8, 0, 0.8, 0], [i + 1, -0.8, 0, -0.8, 0]]}))
        .collect();
    problem_json(Value::from(units), Value::from(nets), square_board(30.0, 1.0))
}

#[derive(PartialEq, Eq, PartialOrd, Ord, Debug)]
enum Kind {
    Swap,
    Rotate,
    Translate,
}

fn kind_of(moves: &[Move], ev: &Evaluator) -> Kind {
    match moves {
        [_, _] => Kind::Swap,
        [(i, (_, _, r))] if *r != ev.place(*i).2 => Kind::Rotate,
        _ => Kind::Translate,
    }
}

#[test]
fn moves_are_legal() {
    let mut v = chain(10, 1);
    v["units"][0]["fixed"] = json!(true);
    v["units"][5]["rects"] = json!([[-3, -3, 3, 3, 1.0]]); // large: no swap partner
    let pr = common::parse(v);
    let p = params(&[]);
    let m = model(&pr, &p);
    let ev = Evaluator::new(&m, &p, &pr.initial_pose());
    let mover = Mover::new(&m, &p);
    let mut rng = PyRandom::new(5);
    let mut kinds = BTreeSet::new();
    for _ in 0..2000 {
        let moves = mover.propose(&mut rng, &ev, 5.0);
        let kind = kind_of(&moves, &ev);
        for &(i, (x, y, r)) in &moves {
            assert_ne!(i, 0);
            assert!(r < 4);
            assert!((0.0..=30.0).contains(&x) && (0.0..=30.0).contains(&y));
            // offsets on the grid: footprints stay on their placement grid
            let dx = (x - ev.place(i).0) / 0.05;
            within(dx, dx.round(), 5e-7);
        }
        match kind {
            Kind::Swap => {
                let (a, b) = (moves[0].0, moves[1].0);
                assert!(a != 5 && b != 5);
                assert!((moves[0].1.0 - ev.place(b).0).abs() <= 0.025 + 1e-9);
                assert!((moves[0].1.1 - ev.place(b).1).abs() <= 0.025 + 1e-9);
            }
            Kind::Translate => assert!((moves[0].1.0 - ev.place(moves[0].0).0).abs() <= 5.0 + 0.05),
            Kind::Rotate => {}
        }
        kinds.insert(kind);
    }
    assert_eq!(kinds.len(), 3);
}

#[test]
fn region_mode_keeps_unit_origins_in_the_move_box() {
    let mut v = chain(10, 1);
    v["move_box"] = json!([10, 10, 20, 20]);
    for u in v["units"].as_array_mut().unwrap() {
        let inside = (10.0..=20.0).contains(&u["x"].as_f64().unwrap()) && (10.0..=20.0).contains(&u["y"].as_f64().unwrap());
        u["fixed"] = json!(!inside);
    }
    let pr = common::parse(v);
    assert!(pr.units.iter().any(|u| !u.fixed));
    let p = params(&[]);
    let m = model(&pr, &p);
    let mut ev = Evaluator::new(&m, &p, &pr.initial_pose());
    let mover = Mover::new(&m, &p);
    let mut rng = PyRandom::new(2);
    for _ in 0..3000 {
        let moves = mover.propose(&mut rng, &ev, 15.0);
        for &(_, (x, y, _)) in &moves {
            assert!((10.0 - 1e-9..=20.0 + 1e-9).contains(&x) && (10.0 - 1e-9..=20.0 + 1e-9).contains(&y), "{x} {y}");
        }
        ev.propose(&moves);
        ev.commit();
    }
}

/// The first three units of a chain must keep their courtyards in a box.
fn boxed_chain() -> Problem {
    let mut v = chain(10, 1);
    for k in 0..3 {
        v["units"][k]["in_box"] = json!([24.0, 4.0, 29.0, 26.0]);
    }
    common::parse(v)
}

#[test]
fn a_translate_keeps_the_courtyard_in_the_box() {
    let pr = boxed_chain();
    let p = params(&["p_swap=0", "p_rot=0"]);
    let m = model(&pr, &p);
    let mut ev = Evaluator::new(&m, &p, &pr.initial_pose());
    let mover = Mover::new(&m, &p);
    let mut rng = PyRandom::new(3);
    let mut seen = BTreeSet::new();
    for _ in 0..3000 {
        let moves = mover.propose(&mut rng, &ev, 15.0);
        for &(i, (x, y, _)) in moves.iter().filter(|q| q.0 < 3) {
            seen.insert(i);
            assert!((25.0 - 1e-9..=28.0 + 1e-9).contains(&x) && (4.6 - 1e-9..=25.4 + 1e-9).contains(&y), "{i} {x} {y}");
        }
        ev.propose(&moves);
        ev.commit();
    }
    assert_eq!(seen, BTreeSet::from([0, 1, 2]));
    (0..3).for_each(|i| near(ev.forbidden_area(i), 0.0));
}

#[test]
fn the_legalizer_moves_a_unit_back_into_the_box() {
    let pr = boxed_chain();
    let p = params(&["legal_rotate=0"]);
    let m = model(&pr, &p);
    let mut ev = Evaluator::new(&m, &p, &pr.initial_pose());
    ev.propose(&[(0, (22.0, 15.0, ev.place(0).2))]); // 1 mm left of the box
    ev.commit();
    assert!(ev.legal_penalty(0) > 0.0);
    assert!(!legalize(&mut ev, &p).unwrap().contains(&0));
    near(ev.legal_penalty(0), 0.0);
    assert!(ev.place(0).0 - 1.0 >= 24.0 - 1e-9);
}

#[test]
fn the_same_seed_gives_the_same_result() {
    let p = params(&[]);
    let (a, b) = (run(chain(10, 1), &p, 1, 3, 800, 11, 1), run(chain(10, 1), &p, 1, 3, 800, 11, 1));
    assert_eq!(pose_of(&a, 0), pose_of(&b, 0));
}

#[test]
fn the_same_seed_gives_the_same_result_with_threads() {
    let p = params(&[]);
    let (a, b) = (run(chain(10, 1), &p, 2, 3, 500, 4, 2), run(chain(10, 1), &p, 2, 3, 500, 4, 2));
    let poses = |r: &SearchResult| r.candidates.iter().map(|c| c.pose.clone()).collect::<Vec<_>>();
    assert_eq!(poses(&a), poses(&b));
}

#[test]
fn another_seed_gives_another_result() {
    let p = params(&[]);
    let (a, b) = (run(chain(10, 1), &p, 1, 2, 500, 1, 1), run(chain(10, 1), &p, 1, 2, 500, 2, 1));
    assert_ne!(pose_of(&a, 0), pose_of(&b, 0));
}

#[test]
fn the_returned_best_cost_matches_the_returned_pose() {
    let pr = common::parse(chain(8, 4));
    let p = params(&[]);
    let m = model(&pr, &p);
    for seed in 0..3 {
        let mut ev = Evaluator::new(&m, &p, &pr.initial_pose());
        let mover = Mover::new(&m, &p);
        let schedule = Schedule { steps: 1500, t0: 50.0, t1: 0.5, w0: 10.0, w1: 0.5 };
        let best = anneal(&mut ev, &mover, &mut PyRandom::new(seed), schedule);
        within(best.cost, Evaluator::new(&m, &p, &best.pose).cost(), 5e-6);
        assert!(best.cost <= ev.cost() + 1e-9);
    }
}

#[test]
fn the_spacing_weights_grow_from_start_to_ramp_times() {
    let p = Params::from_args(&["w_ov=20", "w_oob=10", "ramp=20"]).unwrap();
    let (first, last) = (epoch_params(&p, 0, 5), epoch_params(&p, 4, 5));
    near(first.w_ov, 20.0);
    near(last.w_ov, 400.0);
    near(last.w_oob, 200.0);
    near(epoch_params(&p, 0, 1).w_ov, 400.0);
    assert_eq!(first.w_wl, p.w_wl);
}

#[test]
fn an_overlapping_unit_moves_to_a_legal_spot() {
    let mut v = two_units();
    v["units"][1]["x"] = json!(5.2);
    v["units"][1]["y"] = json!(5.1);
    let pr = common::parse(v);
    let p = params(&[]);
    let m = model(&pr, &p);
    let mut ev = Evaluator::new(&m, &p, &pr.initial_pose());
    assert!(ev.legal_penalty(1) > 0.0);
    assert_eq!(legalize(&mut ev, &p).unwrap(), Vec::<usize>::new());
    near(ev.legal_penalty(1), 0.0);
    within(ev.cost(), Evaluator::new(&m, &p, &ev.pose()).cost(), 5e-7);
    assert!(ev.terms().hpwl < 2.0);
}

#[test]
fn a_unit_on_kept_copper_only_is_legal_and_stays() {
    let mut v = two_units();
    v["board"]["copper"] = json!([["via", 15.0, 15.0, 15.0, 15.0, 0.6]]);
    v["units"][1]["pad_rects"] = json!([[-0.2, -0.2, 0.2, 0.2]]);
    let pr = common::parse(v);
    let p = params(&[]);
    let m = model(&pr, &p);
    let mut ev = Evaluator::new(&m, &p, &pr.initial_pose());
    assert!(ev.forbidden_area(1) > 0.0);
    let place = ev.place(1);
    assert_eq!(legalize(&mut ev, &p).unwrap(), Vec::<usize>::new());
    assert_eq!(ev.place(1), place);
}

#[test]
fn the_second_pass_doubles_the_radius() {
    let mut v = two_units();
    // the courtyards meet: needs a 0.8 mm move; radius 0.5 is too small
    v["units"][1]["x"] = json!(5.2);
    v["units"][1]["y"] = json!(5.0);
    let pr = common::parse(v);
    let p = params(&[]);
    let m = model(&pr, &p);
    let mut ev = Evaluator::new(&m, &p, &pr.initial_pose());
    assert_eq!(legalize(&mut ev, &params(&["legal_radius=0.5", "legal_passes=1"])).unwrap(), vec![1]);
    let mut ev = Evaluator::new(&m, &p, &pr.initial_pose());
    assert_eq!(legalize(&mut ev, &params(&["legal_radius=0.5", "legal_passes=2"])).unwrap(), Vec::<usize>::new());
    near(ev.legal_penalty(1), 0.0);
}

/// All units on one spot: much work for the legalizer.
fn stacked_chain() -> Value {
    let mut v = chain(10, 3);
    for u in v["units"].as_array_mut().unwrap() {
        u["x"] = json!(15.0);
        u["y"] = json!(15.0);
    }
    v
}

#[test]
fn the_time_limit_fails_closed() {
    let pr = common::parse(stacked_chain());
    let p = params(&["legal_time=0"]);
    let m = model(&pr, &p);
    let mut ev = Evaluator::new(&m, &p, &pr.initial_pose());
    let timeout = legalize(&mut ev, &p).expect_err("no time for the legalizer");
    assert!(!timeout.illegal.is_empty());
    timeout.illegal.iter().for_each(|&i| assert!(ev.legal_penalty(i) > 0.0));
}

#[test]
fn optimize_marks_a_timed_out_candidate_illegal() {
    let res = run(stacked_chain(), &params(&["legal_time=0"]), 1, 1, 10, 1, 1);
    let c = &res.candidates[0];
    assert!(c.timeout);
    assert!(!c.illegal.is_empty());
}

/// two_units() plus the mains net M (class MAINS_K1) from fixed A (5, 5) to fixed C (15, 5); with `wall`, a fixed SELV pad
/// W from edge to edge at x = 10 leaves no legal mains path (8 mm to SELV).
fn walled_mains(wall: bool) -> Value {
    let mut v = two_units();
    let pad = json!([[-0.5, -0.5, 0.5, 0.5, 1]]);
    v["units"][0]["cu"] = pad.clone();
    v["units"][0]["cu_pads"] = json!([["A", "pth"]]);
    let mut c = unit("C", 15.0, 5.0, json!([[-0.5, -0.5, 0.5, 0.5, 0.5]]));
    c["fixed"] = json!(true);
    c["cu"] = pad;
    c["cu_pads"] = json!([["C", "pth"]]);
    v["units"].as_array_mut().unwrap().push(c);
    if wall {
        let mut w = unit("W", 10.0, 10.0, json!([[-0.5, -10, 0.5, 10, 0.5]]));
        w["fixed"] = json!(true);
        w["cu"] = json!([[-0.5, -10, 0.5, 10, 2]]);
        w["cu_pads"] = json!([["W", "pth"]]);
        v["units"].as_array_mut().unwrap().push(w);
    }
    v["cu_nets"] = json!({"1": ["M", "MAINS_K1"], "2": ["S", "SELV"]});
    v["route_rules"] = json!({
        "dru": {"domains": [["MAINS_K*", 8.0, 3.0]], "holes": [], "pairs": []},
        "classes": {"MAINS_K1": [0.2, 2.0], "SELV": [0.2, 0.25], "Default": [0.2, 0.25]},
    });
    v
}

#[test]
fn the_mains_check_is_off_by_default() {
    let res = run(walled_mains(true), &params(&[]), 1, 1, 50, 1, 1);
    assert!(res.candidates[0].mains.is_empty());
}

#[test]
fn a_blocked_mains_net_is_a_fault_of_the_candidate() {
    let res = run(walled_mains(true), &params(&["mains=1"]), 1, 1, 50, 1, 1);
    let mains = &res.candidates[0].mains;
    assert_eq!(mains.iter().map(|f| f.net.as_str()).collect::<Vec<_>>(), vec!["M"]);
    assert!(mains[0].blockers.iter().any(|b| b.reference == "W"));
}

#[test]
fn an_open_mains_net_is_no_fault() {
    let res = run(walled_mains(false), &params(&["mains=1"]), 1, 1, 50, 1, 1);
    assert!(res.candidates[0].mains.is_empty());
}

#[test]
fn the_mains_check_without_route_rules_stops() {
    let mut v = walled_mains(true);
    v.as_object_mut().unwrap().remove("route_rules");
    let mut pr: Problem = common::parse(v);
    let plan = Plan { workers: 1, epochs: 1, steps: 50, seed: 1, top: 1 };
    assert!(optimize(&mut pr, &params(&["mains=1"]), plan, &|_| {}).is_err());
}

fn candidate(worker: usize, cost: f64, pose: Pose, illegal: &[&str], faults: &[&str]) -> Candidate {
    Candidate {
        route_score: None,
        route_pressure: None,
        worker,
        prelegal_pose: pose.clone(),
        pose,
        cost,
        components: Default::default(),
        illegal: illegal.iter().map(|s| s.to_string()).collect(),
        timeout: false,
        mains: faults.iter().map(|n| Fault { net: n.to_string(), least_bad: None, blockers: Vec::new() }).collect(),
        finish_seconds: 0.0,
    }
}

#[test]
fn a_candidate_with_mains_faults_ranks_after_one_without() {
    let mut all = [candidate(0, 1.0, vec![], &[], &["M"]), candidate(1, 9.0, vec![], &[], &[]), candidate(2, 0.5, vec![], &["B"], &[])];
    all.sort_by(rank);
    assert_eq!(all.iter().map(|c| c.worker).collect::<Vec<_>>(), vec![1, 0, 2]);
}

#[test]
fn equal_overflow_uses_pressure_without_overriding_legality_or_overflow() {
    let mut compact = candidate(0, 1.0, vec![], &[], &[]);
    compact.route_score = Some(0.0);
    compact.route_pressure = Some(0.1);
    let mut spread = compact.clone();
    spread.worker = 1;
    spread.cost = 2.0;
    spread.route_pressure = Some(0.05);
    assert!(rank(&spread, &compact).is_lt());
    spread.route_score = Some(1.0);
    assert!(rank(&compact, &spread).is_lt(), "overflow remains primary");
    spread.route_score = Some(0.0);
    spread.illegal.push("edge".into());
    assert!(rank(&compact, &spread).is_lt(), "legality remains primary");
}

#[test]
fn two_units_reach_the_known_optimum() {
    let res = run(two_units(), &params(&[]), 1, 4, 1500, 3, 1);
    let c = &res.candidates[0];
    assert!(c.illegal.is_empty());
    near(c.components.overlap, 0.0);
    assert!(c.components.hpwl < 1.5 + 0.1);
}

#[test]
fn the_history_keeps_the_best_pose_and_cost_parts_of_each_epoch() {
    let res = run(two_units(), &params(&[]), 1, 3, 500, 3, 1);
    assert_eq!(res.history.iter().map(|h| h.epoch).collect::<Vec<_>>(), vec![1, 2, 3]);
    let pr = common::parse(two_units());
    let p = params(&[]);
    for h in &res.history {
        assert_eq!(h.pose.len(), pr.units.len());
        within(h.components.hpwl, common::terms(&pr, &h.pose, &p).hpwl, 5e-7);
    }
}

#[test]
fn the_search_beats_the_initial_and_random_placements() {
    let p = params(&[]);
    let res = run(chain(12, 2), &p, 2, 4, 3000, 9, 1);
    let best = &res.candidates[0];
    assert!(best.illegal.is_empty());
    let pr = common::parse(chain(12, 2));
    let m = model(&pr, &p);
    let mut rng = PyRandom::new(0);
    let mut random_pose = || -> Pose { (0..pr.units.len()).map(|_| (rng.uniform(3.0, 27.0), rng.uniform(3.0, 27.0), rng.below(4) as u8)).collect() };
    let least = (0..20).map(|_| Evaluator::new(&m, &p, &random_pose()).cost()).fold(f64::INFINITY, f64::min);
    assert!(best.cost < 0.5 * res.initial.cost);
    assert!(best.cost < 0.5 * least);
    within(best.cost, Evaluator::new(&m, &p, &best.pose).cost(), 5e-6);
}

/// Poses of three units, the movable two shifted by dx; unit 0 is fixed.
fn shifted(cost: f64, dx: f64, illegal: &[&str]) -> Candidate {
    let pose = vec![(0.0, 0.0, 0), (5.0 + dx, 5.0, 0), (9.0 + dx, 1.0, 0)];
    candidate(0, cost, pose, illegal, &[])
}

fn near_copies() -> Vec<Candidate> {
    vec![shifted(1.0, 0.0, &[]), shifted(1.1, 0.2, &[]), shifted(1.2, 3.0, &[]), shifted(1.3, 3.1, &[]), shifted(0.5, 9.0, &["U1"])]
}

#[test]
fn near_copies_are_dropped() {
    let kept = distinct(near_copies(), 1.0, &[1, 2]);
    assert_eq!(kept.iter().map(|c| c.cost).collect::<Vec<_>>(), vec![1.0, 1.2, 0.5]);
}

#[test]
fn zero_keeps_all_but_exact_copies() {
    let mut all = near_copies();
    all.push(shifted(1.0, 0.0, &[]));
    assert_eq!(distinct(all, 0.0, &[1, 2]).len(), 5);
}

#[test]
fn optimize_returns_distinct_candidates() {
    let res = run(chain(12, 2), &params(&["distinct=0.5"]), 4, 2, 800, 3, 4);
    let poses: Vec<&Pose> = res.candidates.iter().map(|c| &c.pose).collect();
    for (k, a) in poses.iter().enumerate() {
        for b in &poses[..k] {
            let d: f64 = a.iter().zip(b.iter()).map(|(p, q)| (p.0 - q.0).hypot(p.1 - q.1)).sum::<f64>() / a.len() as f64;
            assert!(d >= 0.5, "{d}");
        }
    }
}

#[test]
fn many_moves_cannot_accumulate_beyond_the_seed_radius() {
    let pr = common::parse(two_units());
    let p = params(&["p_swap=0", "p_rot=0", "max_displacement=1"]);
    let m = model(&pr, &p);
    let mut ev = Evaluator::new(&m, &p, &pr.initial_pose());
    let mover = Mover::new(&m, &p);
    let mut rng = PyRandom::new(1);
    let (x0, y0, _) = pr.initial_pose()[1];
    for _ in 0..1000 {
        let moves = mover.propose(&mut rng, &ev, 3.0);
        ev.propose(&moves);
        ev.commit();
        let (x, y, _) = ev.place(1);
        assert!((x - x0).hypot(y - y0) <= 1.0 + 1e-9);
    }
}

#[test]
fn the_legalizer_cannot_turn_a_seeded_part_to_escape_illegality() {
    let wide = common::unit("WIDE", 1.5, 6.0, json!([[-2, -0.5, 2, 0.5, 0.0]]));
    let pr = common::parse(common::problem_json(json!([wide]), json!([]), common::box_board(3.0, 12.0)));
    let legal = ["mask_cell=0.25", "legal_step=0.25", "legal_radius=1", "legal_passes=1"];
    let with = |rotate: &'static str| Params::from_args(&[legal.as_slice(), &[rotate]].concat()).unwrap();
    let strict = with("legal_rotate=0");
    let m = model(&pr, &strict);
    let mut ev = Evaluator::new(&m, &strict, &pr.initial_pose());
    assert_eq!(legalize(&mut ev, &strict).unwrap(), vec![0]);
    assert_eq!(ev.place(0).2, 0);
    let free = with("legal_rotate=1");
    let m = model(&pr, &free);
    let mut ev = Evaluator::new(&m, &free, &pr.initial_pose());
    assert!(legalize(&mut ev, &free).unwrap().is_empty());
    assert!([1, 3].contains(&ev.place(0).2));
}

#[test]
fn live_observer_preserves_search_and_distinguishes_current_from_best() {
    use std::sync::{Arc,Mutex};
    let mut pr=common::parse(two_units());let p=params(&[]);
    let plan=Plan{workers:2,epochs:3,steps:1000,seed:13,top:2};
    let plain=optimize(&mut common::parse(two_units()),&p,plan,&|_|{}).unwrap();
    let frames=Arc::new(Mutex::new(Vec::new()));let got=frames.clone();
    let observe=move |worker,epoch,step,accepted,rejected,cost,current:&Pose,best_cost,best:&Pose| {
        assert_eq!(accepted+rejected,step);assert!(cost+1e-8>=best_cost);
        assert_eq!(current[0],(5.,5.,0));assert_eq!(best[0],(5.,5.,0));
        got.lock().unwrap().push((worker,epoch,step,current.clone(),best.clone()));
    };
    let live=iotplace::search::optimize_observed(&mut pr,&p,plan,&|_|{},&|_,_,_,_|{},Some(&observe), &iotplace::search::Sprint::default()).unwrap();
    assert!(frames.lock().unwrap().len()>=6);
    assert_eq!(serde_json::to_value(&plain.history).unwrap(),serde_json::to_value(&live.history).unwrap());
    for (a,b) in plain.candidates.iter().zip(&live.candidates) {assert_eq!(a.pose,b.pose);assert_eq!(a.cost,b.cost);assert_eq!(a.illegal,b.illegal);}
}

#[test]
fn a_plain_run_repairs_a_pad_inside_the_edge_clearance_the_raster_misses() {
    // The top edge at 30.06 is off the 0.1 mm raster: its band starts at 29.1, the 1 mm clearance at 29.06. The pad box ends at 29.08.
    let mut padded = unit("P", 5.0, 28.58, json!([[-0.5, -0.5, 0.5, 0.5, 0.1]]));
    padded["pad_rects"] = json!([[-0.5, -0.5, 0.5, 0.5]]);
    let board = json!({"outline": [[0, 0], [30, 0], [30, 30.06], [0, 30.06]], "keepouts": [], "edge_clearance": 1.0});
    let input = problem_json(json!([padded]), json!([]), board);
    let p = Params::default();
    let pr = common::parse(input.clone());
    let m = model(&pr, &p);
    let mut ev = Evaluator::new(&m, &p, &pr.initial_pose());
    assert_eq!(ev.legal_penalty(0), 0.0, "the raster misses this edge fault");
    assert!(m.edge_miss_at(0, ev.place(0)));
    assert!(legalize(&mut ev, &p).unwrap().is_empty());
    assert!(!m.edge_miss_at(0, ev.place(0)));
    assert_eq!(ev.legal_penalty(0), 0.0, "repair keeps the other legality checks");
    let res = run(input.clone(), &p, 1, 1, 0, 1, 1);
    assert_eq!(res.candidates[0].pose, ev.pose(), "plain run uses the shared legalizer");
    assert!(res.candidates[0].illegal.is_empty());

    let bounded = Params { max_displacement: 0.01, ..p.clone() };
    let res = run(input.clone(), &bounded, 1, 1, 0, 1, 1);
    assert_eq!(res.candidates[0].pose, pr.initial_pose(), "repair cannot override displacement bounds");
    assert!(res.candidates[0].illegal.contains(&"edge:P".to_string()));

    let legacy = Params { exact_edge: 0.0, ..p };
    let res = run(input, &legacy, 1, 1, 0, 1, 1);
    assert_eq!(res.candidates[0].pose, pr.initial_pose(), "explicit golden-comparison mode remains unchanged");
}
