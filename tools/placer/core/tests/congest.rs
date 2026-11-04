//! Router congestion at the unit pins: the map of a route and the sum at the signal pins of a unit.

mod common;

use common::{parse, problem_json, square_board};
use iotplace::congest::{HistoryMap, PinHeat};
use serde_json::{Value, json};
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};

const SIZE: usize = 40;

/// History 2.0 (F.Cu 1.5 + B.Cu 0.5) in the 1 mm cells x 9..11, y 9..11 (round U1 at (10, 10)); 0 elsewhere.
fn route_map() -> Value {
    let (mut front, mut back) = (vec![0.0; SIZE * SIZE], vec![0.0; SIZE * SIZE]);
    for j in 9..12 {
        for i in 9..12 {
            front[j * SIZE + i] = 1.5;
            back[j * SIZE + i] = 0.5;
        }
    }
    json!({"schema": "iot-lab.route-congestion.v0", "cell": 1.0, "origin": [0.0, 0.0], "nx": SIZE, "ny": SIZE,
           "layers": [{"name": "F.Cu", "hist": front}, {"name": "B.Cu", "hist": back}]})
}

/// A file of this test, removed at the end of its scope.
struct TempFile(PathBuf);

impl TempFile {
    fn new(name: &str, v: &Value) -> Self {
        static NEXT_FILE: AtomicU64 = AtomicU64::new(0);
        let id = NEXT_FILE.fetch_add(1, Ordering::Relaxed);
        let path = std::env::temp_dir().join(format!("iotplace-{}-{id}-{name}", std::process::id()));
        std::fs::write(&path, v.to_string()).unwrap();
        Self(path)
    }
}

impl Drop for TempFile {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.0);
    }
}

fn load_map() -> HistoryMap {
    HistoryMap::load(&TempFile::new("map.json", &route_map()).0).unwrap()
}

#[test]
fn the_map_sums_the_layers_and_checks_the_schema() {
    let g = load_map();
    assert_eq!((g.nx, g.ny, g.cell), (SIZE, SIZE, 1.0));
    assert_eq!(g.history[10 * SIZE + 10], 2.0);
    assert_eq!(g.history.iter().sum::<f64>(), 18.0);
    let bad = json!({"schema": "x", "cell": 1.0, "origin": [0.0, 0.0], "nx": 1, "ny": 1, "layers": []});
    assert!(HistoryMap::load(&TempFile::new("bad.json", &bad).0).is_err());
}

fn part(name: &str, x: f64, y: f64) -> Value {
    json!({"name": name, "refs": [name], "fixed": false, "x": x, "y": y, "rects": [[-1.0, -0.5, 1.0, 0.5, 0.5]]})
}

#[test]
fn the_value_counts_signal_pins_in_hot_cells() {
    let units = json!([part("U1", 10.0, 10.0), part("R1", 14.0, 10.0), part("R2", 10.0, 14.0), part("TP1", 20.0, 20.0)]);
    let nets = json!([
        {"name": "A", "weight": 1.0, "pins": [[0, 0.5, 0, 0.5, 0], [1, -0.5, 0, -0.5, 0]], "pts": [[[0.5, 0.0]], [[-0.5, 0.0]]]},
        {"name": "B", "weight": 1.0, "pins": [[0, -0.5, 0, 0.5, 0.3], [2, 0.5, 0, 0.5, 0], [3, 0, 0, 0, 0]],
         "pts": [[[-0.5, 0.0], [0.5, 0.3]], [[0.5, 0.0]], [[0.0, 0.0]]]},
        {"name": "P", "weight": 1.0, "pins": [[1, 0.5, 0, 0.5, 0], [2, -0.5, 0, -0.5, 0]], "pts": [[[0.5, 0.0]], [[-0.5, 0.0]]]},
    ]);
    let mut v = problem_json(units, nets, square_board(40.0, 0.5));
    v["plane_nets"] = json!(["P"]);
    let pr = parse(v);
    let heat = PinHeat::new(&pr, load_map());
    let pose = pr.initial_pose();
    // U1 (10, 10): signal pins A (10.5, 10), B (9.5, 10) and (10.5, 10.3); the plane net P has no pin on U1
    assert_eq!(heat.value(0, pose[0]), 3.0 * 2.0);
    // R1 (14, 10): A pin at 13.5 is outside the hot cells; its P pin is a plane net (not counted)
    assert_eq!(heat.value(1, pose[1]), 0.0);
    assert_eq!(heat.value(1, (10.5, 10.0, 0)), 2.0); // A pin (10.0, 10.0) in the hot cells
}
