//! Soft clusters: proposed from the board, moved as one by the search, never over a constraint.

mod common;

use common::board::{Fixture, buck};
use iotplace::model::Model;
use iotplace::numeric::hypot;
use iotplace::params::Params;
use iotplace::problem::Problem;
use iotplace::read::options::Options;
use iotplace::search::cluster::{groups, held};
use iotplace::search::{Plan, optimize};
use serde_json::{Value, json};

#[test]
fn a_proposal_moves_as_one_and_leaves_a_held_unit_out() {
    let fx = Fixture::new(buck());
    assert!(!serde_json::to_string(&fx.read(&Options::default())).unwrap().contains("\"clusters\""), "no flag, no field: the old problem file");
    let out = fx.read(&Options { auto_clusters: Some(1.0), ..Options::default() });
    let rules: Vec<&str> = out.clusters.iter().flat_map(|c| &c.ties).map(|t| t.rule.as_str()).collect();
    assert!(rules.contains(&"regulator"), "{rules:?}");
    assert!(out.nets.iter().any(|n| n.cohesion && n.name.starts_with("~clu:")), "a tie is a soft pull");
    let cluster = out.clusters.iter().max_by_key(|c| c.units.len()).unwrap();
    assert!(cluster.units.len() >= 3);
    let (kept, boxed) = (cluster.units[..2].to_vec(), cluster.units[2]);

    let mut value: Value = serde_json::from_str(&serde_json::to_string(&out).unwrap()).unwrap();
    let (x, y) = (out.units[boxed].x, out.units[boxed].y);
    value["units"][boxed]["in_box"] = json!([x - 5.0, y - 5.0, x + 5.0, y + 5.0]);
    let mut pr: Problem = serde_json::from_value(value).unwrap();
    let p = Params::from_args(&["clu_phase=1", "clu_gather=0"]).unwrap();
    let plan = Plan { workers: 1, epochs: 2, steps: 400, seed: 1, top: 1 };
    let group = {
        let model = Model::new(&pr, &p).unwrap();
        let found = groups(&model);
        assert!(held(&pr, boxed) && found.iter().all(|g| !g.units.contains(&boxed)), "a region box keeps its unit out of a group");
        found.into_iter().find(|g| g.units.contains(&kept[0])).expect("the others stay a group").units
    };
    let start = pr.initial_pose();
    let res = optimize(&mut pr, &p, plan, &|_| {}).unwrap();
    let moved = &res.candidates[0].prelegal_pose;
    let gap = |pose: &[(f64, f64, u8)], a: usize, b: usize| hypot(pose[a].0 - pose[b].0, pose[a].1 - pose[b].1);
    assert!(group.iter().any(|&i| moved[i] != start[i]), "the group moved");
    for &i in &group[1..] {
        assert!((gap(moved, group[0], i) - gap(&start, group[0], i)).abs() < 1e-6, "a group keeps its shape");
    }
}
