//! Proof benchmarks: Spearman rank correlation and seeded scrambled placements.

mod common;

use common::{fixed_unit, parse, problem_json, square_board, unit, within};
use iotplace::bench::{scramble, spearman};
use iotplace::problem::Problem;
use serde_json::{Value, json};
use std::process::Command;

#[test]
fn the_rank_correlation() {
    within(spearman(&[1.0, 2.0, 3.0, 4.0], &[10.0, 20.0, 30.0, 40.0]), 1.0, 5e-8);
    within(spearman(&[1.0, 2.0, 3.0, 4.0], &[4.0, 3.0, 2.0, 1.0]), -1.0, 5e-8);
    within(spearman(&[1.0, 2.0, 3.0], &[1.0, 3.0, 2.0]), 0.5, 5e-8);
    within(spearman(&[1.0, 1.0, 2.0], &[1.0, 2.0, 3.0]), 0.8660254, 5e-7); // ties get the average rank
}

fn small() -> Problem {
    let body = json!([[-0.5, -0.5, 0.5, 0.5, 0.5]]);
    let units = json!([unit("A", 5.0, 5.0, body.clone()), unit("B", 10.0, 10.0, body.clone()), fixed_unit("H", 1.0, 1.0, body)]);
    parse(problem_json(units, json!([]), square_board(20.0, 1.0)))
}

fn on_the_board(v: f64) -> bool {
    (1.5..=18.5).contains(&v)
}

#[test]
fn a_uniform_scramble_keeps_fixed_units_and_stays_in_the_board() {
    let pr = small();
    let a = scramble(&pr, 4, None);
    assert_eq!(a, scramble(&pr, 4, None));
    assert_ne!(a, scramble(&pr, 5, None));
    assert_eq!(a[2], (1.0, 1.0, 0));
    a[..2].iter().for_each(|&(x, y, r)| assert!(on_the_board(x) && on_the_board(y) && r < 4));
}

#[test]
fn a_sigma_scramble_moves_units_about_sigma_and_clips_to_the_board() {
    let pr = small();
    let p = scramble(&pr, 1, Some(0.01));
    assert!((p[0].0 - 5.0).abs() + (p[0].1 - 5.0).abs() < 0.2);
    let p = scramble(&pr, 1, Some(100.0));
    p[..2].iter().for_each(|&(x, y, _)| assert!(on_the_board(x) && on_the_board(y)));
}

#[test]
fn the_command_writes_a_problem_copy_with_scrambled_start_positions() {
    let dir = std::env::temp_dir().join(format!("iotplace-scramble-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let (src, out) = (dir.join("p.json"), dir.join("q.json"));
    let body = json!([[-0.5, -0.5, 0.5, 0.5, 0.5]]);
    let units = json!([unit("A", 5.0, 5.0, body.clone()), unit("B", 10.0, 10.0, body.clone()), fixed_unit("H", 1.0, 1.0, body)]);
    std::fs::write(&src, problem_json(units, json!([]), square_board(20.0, 1.0)).to_string()).unwrap();
    let run = Command::new(env!("CARGO_BIN_EXE_iotplace")).arg("scramble").arg(&src).arg("-o").arg(&out).args(["--seed", "3", "--sigma", "4"]).output().unwrap();
    assert!(run.status.success());
    let written: Value = serde_json::from_str(&std::fs::read_to_string(&out).unwrap()).unwrap();
    std::fs::remove_dir_all(&dir).unwrap();
    let pose = scramble(&small(), 3, Some(4.0));
    for (u, (x, y, _)) in written["units"].as_array().unwrap().iter().zip(&pose) {
        assert_eq!((u["x"].as_f64().unwrap(), u["y"].as_f64().unwrap()), (*x, *y));
    }
    assert_eq!((written["units"][2]["x"].as_f64(), written["units"][2]["y"].as_f64()), (Some(1.0), Some(1.0)));
}
