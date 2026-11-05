//! The model must accept a known-good routed board and reject a placement that breaks its .kicad_dru rules. The boards are not in
//! this repo: tools/placer/testdata holds the problems the reader made of RELAY-4 and IO-6X6.

use iotplace::evaluator::Evaluator;
use iotplace::model::Model;
use iotplace::params::Params;
use iotplace::problem::{Pose, Problem};
use serde_json::{Value, json};
use std::collections::BTreeSet;

fn data(name: &str) -> Value {
    let path = format!("{}/../testdata/{name}.json", env!("CARGO_MANIFEST_DIR"));
    serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap()
}

fn problem(v: &Value) -> Problem {
    serde_json::from_value(v.clone()).unwrap()
}

/// The penalty of unit i in a pose.
fn penalty(pr: &Problem, pose: &Pose, i: usize) -> f64 {
    let params = Params::default();
    let model = Model::new(pr, &params).unwrap();
    Evaluator::new(&model, &params, pose).legal_penalty(i)
}

/// Names of the illegal movable units in a pose.
fn illegal(pr: &Problem, pose: &Pose) -> BTreeSet<String> {
    let params = Params::default();
    let model = Model::new(pr, &params).unwrap();
    let ev = Evaluator::new(&model, &params, pose);
    pr.units.iter().enumerate().filter(|(i, u)| !u.fixed && ev.legal_penalty(*i) > 0.0).map(|(_, u)| u.name.clone()).collect()
}

#[test]
fn the_relay4_original_is_legal() {
    let pr = problem(&data("relay4-prob"));
    assert_eq!(illegal(&pr, &pr.initial_pose()), BTreeSet::new());
}

#[test]
fn the_mains_area_keeps_c24_out_as_in_the_port2_winner() {
    let mut v = data("relay4-prob");
    assert_eq!(v["domain_areas"], json!([{"classes": [1, 2, 3, 4], "gap": 8.0}]), "one .kicad_dru domain: MAINS_K*, 8 mm to all other nets");
    let pr = problem(&v);
    let params = Params::default();
    let model = Model::new(&pr, &params).unwrap();
    let start = pr.initial_pose();
    assert!(Evaluator::new(&model, &params, &start).terms().overlap.abs() < 1e-9);
    let i = pr.units.iter().position(|u| u.name == "C24").unwrap();
    let mut pose = start;
    pose[i] = (147.8, 179.8, 1); // PORT2 s89: below the mains connectors, 8 mm from the J4 pads
    assert!(penalty(&pr, &pose, i) > 0.0);
    v["domain_areas"] = json!([]);
    assert!(penalty(&problem(&v), &pose, i).abs() < 1e-9, "the pad gaps pass");
}

#[test]
fn the_io6x6_original_is_legal() {
    // Its block borders BLOCK2 and DO1-2 overlap: legal, not DRC.
    let pr = problem(&data("io6x6-prob"));
    assert_eq!(illegal(&pr, &pr.initial_pose()), BTreeSet::new());
    let block = pr.units.iter().find(|u| u.name == "BLOCK2").unwrap();
    assert_eq!(block.border.len(), 1);
}

/// (unit index, right edge, centre y) of the right-most pad of a mains class.
fn rightmost_mains_pad(v: &Value) -> (usize, f64, f64) {
    let names = v["class_gaps"]["names"].as_array().unwrap();
    let mains: BTreeSet<i64> = names.iter().enumerate().filter(|(_, n)| n.as_str().unwrap().starts_with("MAINS_K")).map(|(k, _)| k as i64).collect();
    let mut best = None;
    for (i, u) in v["units"].as_array().unwrap().iter().enumerate() {
        let (x, y) = (u["x"].as_f64().unwrap(), u["y"].as_f64().unwrap());
        for d in u["dom"].as_array().into_iter().flatten().filter(|d| mains.contains(&d[1].as_i64().unwrap())) {
            let r = &u["rects"][d[0].as_u64().unwrap() as usize];
            let (right, centre) = (x + r[2].as_f64().unwrap(), y + (r[1].as_f64().unwrap() + r[3].as_f64().unwrap()) / 2.0);
            if best.is_none_or(|(_, b, _)| right > b) {
                best = Some((i, right, centre));
            }
        }
    }
    best.unwrap()
}

#[test]
fn a_selv_part_6_7_mm_from_a_mains_pad_is_illegal() {
    // The 8 mm gap comes from the RELAY-4 .kicad_dru "Mains to SELV and 24 V", read by the reader.
    let v = data("relay4-prob");
    let (i, right, y) = rightmost_mains_pad(&v);
    let mains = &v["units"][i];
    let reach = mains["rects"].as_array().unwrap().iter().map(|r| mains["x"].as_f64().unwrap() + r[2].as_f64().unwrap()).fold(f64::MIN, f64::max);
    assert!(reach <= right + 6.7, "nothing else of the unit reaches the test part");
    let gap_penalty = |gap: f64| {
        let mut held = mains.clone();
        held["fixed"] = json!(true);
        let selv = json!({"name": "R", "refs": ["R"], "fixed": false, "x": right + gap + 0.5, "y": y, "rects": [[-0.5, -0.5, 0.5, 0.5, 0.0]]});
        let mut q = v.clone();
        q["units"] = json!([held, selv]);
        q["nets"] = json!([]);
        q["decaps"] = json!([]);
        q["region"] = Value::Null;
        let pr = problem(&q);
        penalty(&pr, &pr.initial_pose(), 1)
    };
    assert!(gap_penalty(6.7) > 0.0);
    assert!(gap_penalty(8.1).abs() < 1e-9);
}

#[test]
fn the_bench_b_v2_placement_that_broke_the_mains_rule_is_illegal() {
    // The poses are by name: the board of this placement had 53 units. 16 of the listed units are illegal only by the mains area.
    let bench = data("relay4-bench-b-v2-P");
    let pr = problem(&data("relay4-prob"));
    let poses = bench["pose"].as_object().unwrap();
    let names: BTreeSet<&str> = pr.units.iter().map(|u| u.name.as_str()).collect();
    assert!(poses.keys().all(|k| names.contains(k.as_str())));
    let place = |p: &Value| (p[0].as_f64().unwrap(), p[1].as_f64().unwrap(), p[2].as_u64().unwrap() as u8);
    let pose: Pose = pr.units.iter().zip(pr.initial_pose()).map(|(u, start)| if u.fixed { start } else { poses.get(&u.name).map_or(start, place) }).collect();
    let found = illegal(&pr, &pose);
    let listed: BTreeSet<String> = bench["illegal_units"].as_array().unwrap().iter().map(|n| n.as_str().unwrap().to_string()).collect();
    assert!(listed.is_subset(&found), "missing {:?}", listed.difference(&found).collect::<Vec<_>>());
}
