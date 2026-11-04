//! Proposals written by the Python implementation: `python -m pcb_search.native_srj scope|repair`, Python 3.13.5 in
//! iot-lab-route:10.0. Text is compared, so 1 and 1.0 count as different. The repair_success cases are the only ones
//! where a waypoint is removed.

use pcbsearch::budget::Budget;
use pcbsearch::pyjson::indented;
use pcbsearch::srj::repair::prune_crossing_excursion;
use pcbsearch::srj::scope::selected_route_proposal;
use serde_json::Value;

const GOLDEN: &str = include_str!("fixtures/srj-golden.json");

fn without_elapsed(proposal: &Value) -> String {
    let mut proposal = proposal.clone();
    if let Some(repair) = proposal.get_mut("repair").and_then(Value::as_object_mut) {
        repair.shift_remove("elapsed_s");
    }
    indented(&proposal).unwrap()
}

fn run(case: &Value) -> Result<Value, String> {
    let still = || 0.0;
    let outcome = if case["mode"] == "repair" {
        prune_crossing_excursion(&case["srj"], &case["response"], &Budget::new(5.0, &still))
    } else {
        let nets: Vec<String> = serde_json::from_value(case["nets"].clone()).unwrap();
        selected_route_proposal(&case["srj"], &case["response"], &nets)
    };
    outcome.map_err(|error| error.to_string())
}

#[test]
fn proposals_match_the_python_implementation() {
    let cases: Vec<Value> = serde_json::from_str(GOLDEN).unwrap();
    assert_eq!(cases.len(), 36);
    let mut repaired = 0;
    for case in &cases {
        let name = case["name"].as_str().unwrap();
        match run(case) {
            Ok(proposal) => {
                assert_eq!(without_elapsed(&proposal), without_elapsed(&case["proposal"]), "{name}");
                repaired += usize::from(proposal["repair"]["edits"].as_array().is_some_and(|edits| !edits.is_empty()));
            }
            Err(reason) => assert_eq!(format!("STUCK: {reason}"), case["stdout"].as_str().unwrap(), "{name}"),
        }
    }
    assert_eq!(repaired, 3, "the golden set must keep its successful repairs");
}
