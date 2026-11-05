//! A sprint: seeds that stay apart, a checkpoint per epoch, a run inside its budget, a winner by route score.

mod common;

use common::{net, problem_json, square_board, unit};
use iotplace::params::Params;
use iotplace::problem::Problem;
use iotplace::search::sprint::edge_misses;
use iotplace::search::{Plan, SearchResult, Sprint, optimize_with_preview};
use serde_json::{Value, json};

fn chain() -> Problem {
    let units: Vec<Value> = (0..8).map(|i| unit(&format!("U{i}"), 3.0 + 3.0 * i as f64, 5.0 + (i % 3) as f64 * 7.0, json!([[-1, -0.6, 1, 0.6, 0.5]]))).collect();
    let nets: Vec<Value> = (0..7).map(|i| net(&format!("N{i}"), &[i, i + 1])).collect();
    common::parse(problem_json(Value::from(units), Value::from(nets), square_board(30.0, 1.0)))
}

#[test]
fn sparse_poses_keep_zero_overflow_but_have_distinct_unclipped_pressure() {
    let rects = json!([[-0.5, -0.5, 0.5, 0.5, 0.0]]);
    let pr = common::problem(json!([unit("A", 3.0, 3.0, rects.clone()), unit("B", 9.0, 9.0, rects)]),
        json!([net("signal", &[0, 1])]), square_board(30.0, 1.0));
    let scorer = iotplace::search::sprint::Scorer::new(&pr, &Params::default()).unwrap();
    let compact = scorer.metrics(&vec![(3.0, 3.0, 0), (9.0, 9.0, 0)]);
    let spread = scorer.metrics(&vec![(3.0, 3.0, 0), (21.0, 21.0, 0)]);
    assert_eq!((compact.0, spread.0), (0.0, 0.0));
    assert!(compact.1 > spread.1 && spread.1 > 0.0, "unclipped demand must distinguish both sparse maps: {compact:?} {spread:?}");
}

#[test]
fn pressure_ranking_is_opt_in_and_leaves_the_search_poses_unchanged() {
    let plan = Plan { workers: 3, epochs: 4, steps: 300, seed: 7, top: 3 };
    let sprint = Sprint { budget_s: Some(1000.0), ..Sprint::default() };
    let run = |params: &Params| optimize_with_preview(&mut chain(), params, plan, &|_| {}, &|_, _, _, _| {}, &sprint).unwrap();
    let before = run(&Params::default());
    let enabled = Params::from_args(&["route_pressure=1"]).unwrap();
    let after = run(&enabled);
    let by_worker = |r: &SearchResult| {
        let mut poses: Vec<_> = r.candidates.iter().map(|c| (c.worker, c.pose.clone())).collect();
        poses.sort_by_key(|c| c.0); poses
    };
    assert_eq!(by_worker(&before), by_worker(&after));
    assert!(before.candidates.iter().all(|c| c.route_pressure.is_none()));
    assert!(after.candidates.iter().all(|c| c.route_pressure.is_some()));
    assert!(Params::from_args(&["route_pressure=0.5"]).is_err(), "a switch must not become an unmeasured weight");
}

fn sprint(sprint: &Sprint, steps: usize) -> SearchResult {
    let plan = Plan { workers: 3, epochs: 4, steps, seed: 7, top: 3 };
    optimize_with_preview(&mut chain(), &Params::default(), plan, &|_| {}, &|_, _, _, _| {}, sprint).unwrap()
}

#[test]
fn a_sprint_keeps_its_seeds_apart_saves_each_epoch_and_stays_in_its_budget() {
    let dir = std::env::temp_dir().join(format!("iotplace-sprint-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let path = dir.join("checkpoint.json");
    let timed = Sprint { budget_s: Some(0.2), checkpoint: Some(path.clone()), bind: "input".into() };
    let res = sprint(&timed, 0);
    let report = res.sprint.as_ref().expect("a sprint reports");
    assert!(res.steps > 0 && report.epochs_run == 4, "the steps fit the budget, so the schedule cools to its end");
    assert!(res.wall_s < 2.0, "{} s", res.wall_s);
    assert!(report.unique > 1, "no exchange: the seeds stay apart");
    let scores: Vec<f64> = res.candidates.iter().map(|c| c.route_score.expect("a sprint scores its candidates")).collect();
    assert!(scores.windows(2).all(|w| w[0] <= w[1]), "the route score comes before cost: {scores:?}");

    let file: Value = serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
    std::fs::remove_dir_all(&dir).unwrap();
    assert_eq!((file["schema"].as_str(), file["state"].as_str(), file["bind"].as_str()), (Some("iot-lab.place-checkpoint.v0"), Some("done"), Some("input")));
    assert_eq!(file["trail"].as_array().unwrap().len(), report.epochs_run);
    assert_eq!(file["workers"].as_array().unwrap().len(), 3);

    let fixed = Sprint { budget_s: Some(1000.0), ..Sprint::default() };
    let poses = |r: &SearchResult| r.candidates.iter().map(|c| c.pose.clone()).collect::<Vec<_>>();
    assert_eq!(poses(&sprint(&fixed, 300)), poses(&sprint(&fixed, 300)), "the same steps and seed repeat a sprint");

    // A pad box 0.97 mm from the edge of a board with a 1 mm clearance: inside by less than a raster cell.
    let mut padded = unit("P", 5.0, 1.47, json!([[-0.5, -0.5, 0.5, 0.5, 0.1]]));
    padded["pad_rects"] = json!([[-0.5, -0.5, 0.5, 0.5]]);
    let pr = common::parse(problem_json(json!([padded]), json!([]), square_board(30.0, 1.0)));
    let model = common::model(&pr, &Params::default());
    assert_eq!(edge_misses(&model, &vec![(5.0, 1.47, 0)]), ["edge:P"]);
    assert!(edge_misses(&model, &vec![(5.0, 1.5, 0)]).is_empty());
}
