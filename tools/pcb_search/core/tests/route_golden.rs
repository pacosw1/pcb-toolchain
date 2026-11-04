//! Records written by the Python implementation before it was removed: `python -m pcb_search route`, Python 3.13.5 in
//! iot-lab-route:10.0. Python is gone, so these cannot be regenerated; a difference here is a change of behaviour.
//! `random_23` needs compensated summation. Text is compared, so 1 and 1.0 count as different.

use pcbsearch::budget::Budget;
use pcbsearch::contract::Problem;
use pcbsearch::patterns::route_patterns;
use pcbsearch::pyjson::{fingerprint, indented};
use serde_json::Value;

const GOLDEN: &str = include_str!("fixtures/route-golden.json");

fn without(record: &Value, fields: &[&str]) -> String {
    let mut record = record.clone();
    for field in fields {
        record.as_object_mut().unwrap().shift_remove(*field);
    }
    indented(&record).unwrap()
}

fn solve(input: &Value) -> Result<Value, String> {
    let problem = Problem::read(input).map_err(|error| error.to_string())?;
    let still = || 0.0;
    let mut record = serde_json::to_value(route_patterns(&problem, &Budget::new(5.0, &still))).unwrap();
    record["source_sha256"] = fingerprint(input).unwrap().into();
    Ok(record)
}

#[test]
fn records_match_the_python_implementation() {
    let cases: Vec<Value> = serde_json::from_str(GOLDEN).unwrap();
    assert_eq!(cases.len(), 22);
    for case in &cases {
        let name = case["name"].as_str().unwrap();
        match solve(&case["input"]) {
            Ok(record) => assert_eq!(without(&record, &["elapsed_s"]),
                                     without(&case["record"], &["elapsed_s", "implementation_sha256"]), "{name}"),
            Err(reason) => assert_eq!(format!("FAIL: {reason}"), case["refusal"].as_str().unwrap(), "{name}"),
        }
    }
}
