//! The command as a caller sees it: exit codes, the saved record, and what it refuses.

use std::fs;
use std::path::PathBuf;
use std::process::{Command, Output};

use serde_json::{Value, json};

fn folder(name: &str) -> PathBuf {
    let path = std::env::temp_dir().join(format!("pcbsearch-cli-{name}-{}", std::process::id()));
    let _ = fs::remove_dir_all(&path);
    fs::create_dir_all(&path).unwrap();
    path
}

fn walled_problem() -> Value {
    let net = |name: &str| json!({"name": name, "width": 0.2, "clearance": 0.2, "layers": ["F.Cu"], "source": "synthetic"});
    json!({"schema": "iot-lab.route-problem.v1", "bounds": [0, 0, 10, 10], "edge_clearance": 0.2, "edge_source": "synthetic",
           "layers": ["F.Cu"], "nets": [net("A")], "pair_clearances": [], "unsupported": [], "inputs": {"fixture": "0".repeat(64)},
           "obstacles": [{"name": "wall", "bounds": [4, 0, 6, 10], "net": "", "layers": ["F.Cu"], "clearance": 0}],
           "connections": [{"name": "a", "net": "A", "start": [1, 5], "end": [9, 5], "layers": ["F.Cu"]}]})
}

fn route(input: &PathBuf, output: &PathBuf, budget: &str) -> Output {
    Command::new(env!("CARGO_BIN_EXE_pcbsearch"))
        .args(["route", input.to_str().unwrap(), "--output", output.to_str().unwrap(), "--budget-s", budget])
        .output().unwrap()
}

#[test]
fn partial_route_is_stuck_and_an_existing_output_is_refused() {
    let dir = folder("partial");
    let (input, output) = (dir.join("input.json"), dir.join("output.json"));
    fs::write(&input, walled_problem().to_string()).unwrap();
    let original = fs::read(&input).unwrap();

    let first = route(&input, &output, "1");
    assert_eq!(first.status.code(), Some(3));
    assert!(String::from_utf8_lossy(&first.stdout).starts_with("STUCK:"));
    let record: Value = serde_json::from_str(&fs::read_to_string(&output).unwrap()).unwrap();
    assert_eq!(record["qualified"], false);
    assert_eq!(record["unresolved"][0]["unroutable_proven"], false);
    assert_eq!(fs::read(&input).unwrap(), original);

    let second = route(&input, &output, "1");
    assert_eq!(second.status.code(), Some(2));
    assert!(String::from_utf8_lossy(&second.stderr).contains("output must be new"));
}

#[test]
fn a_budget_that_is_not_positive_is_refused() {
    let dir = folder("budget");
    let (input, output) = (dir.join("input.json"), dir.join("output.json"));
    fs::write(&input, walled_problem().to_string()).unwrap();
    let refused = route(&input, &output, "0");
    assert_eq!(refused.status.code(), Some(2));
    assert!(!output.exists());
}
