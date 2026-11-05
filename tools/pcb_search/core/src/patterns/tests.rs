use std::cell::Cell;

use serde_json::{Value, json};

use super::*;

fn net(name: &str) -> Value {
    json!({"name": name, "width": 0.2, "clearance": 0.2, "layers": ["F.Cu", "B.Cu"], "source": "synthetic fixture"})
}

fn problem() -> Value {
    json!({"schema": "iot-lab.route-problem.v1", "bounds": [0, 0, 10, 10], "edge_clearance": 0.2,
           "edge_source": "synthetic fixture", "layers": ["F.Cu", "B.Cu"], "nets": [net("A"), net("B")],
           "obstacles": [], "pair_clearances": [], "unsupported": [], "inputs": {"fixture": "0".repeat(64)},
           "connections": [{"name": "a", "net": "A", "start": [1, 5], "end": [9, 5], "layers": ["F.Cu"]}]})
}

fn obstacle(name: &str, bounds: [f64; 4], net: &str) -> Value {
    json!({"name": name, "bounds": bounds, "net": net, "layers": ["F.Cu"], "clearance": 0})
}

fn solve(raw: &Value) -> Outcome {
    let still = || 0.0;
    route_patterns(&Problem::read(raw).unwrap(), &Budget::new(1.0, &still))
}

fn blockers_of(outcome: &Outcome) -> Vec<String> {
    match &outcome.unresolved[0] {
        Unresolved::Searched { blockers, .. } => blockers.clone(),
        other => panic!("not searched: {other:?}"),
    }
}

#[test]
fn malformed_or_unsourced_rules_never_become_defaults() {
    let mutations: Vec<fn(&mut Value)> = vec![
        |r| r["extra_rule"] = json!(8),
        |r| r["layers"] = json!("F.Cu"),
        |r| r["obstacles"] = json!({}),
        |r| r["inputs"] = json!({}),
        |r| r["nets"][0]["width"] = json!(true),
        |r| r["nets"][0]["source"] = json!(""),
        |r| {
            let copy = r["nets"][0].clone();
            r["nets"].as_array_mut().unwrap().push(copy);
        },
        |r| r["connections"][0]["layers"] = json!(["In1.Cu"]),
        |r| r["connections"][0]["net"] = json!("missing"),
        |r| r["connections"][0]["start"] = Value::Null,
        |r| r["pair_clearances"] = json!([{"nets": ["A", "B"], "clearance": 1, "source": true}]),
    ];
    for mutate in mutations {
        let mut raw = problem();
        mutate(&mut raw);
        assert!(Problem::read(&raw).is_err(), "accepted {raw}");
    }
}

#[test]
fn an_overflowing_width_is_not_a_number() {
    let text = problem().to_string().replacen("\"width\":0.2", "\"width\":1e999", 1);
    assert!(Problem::read(&serde_json::from_str(&text).unwrap()).is_err());
}

#[test]
fn clearance_pair_is_symmetric_and_cannot_weaken_other_rules() {
    let mut raw = problem();
    raw["pair_clearances"] = json!([{"nets": ["A", "B"], "clearance": 2.0, "source": "synthetic"}]);
    let read = Problem::read(&raw).unwrap();
    assert_eq!(read.gap("A", "B", 0.0), read.gap("B", "A", 0.0));
    assert_eq!(read.gap("A", "B", 0.0), 2.0);
    raw["pair_clearances"][0]["clearance"] = json!(0.1);
    assert_eq!(Problem::read(&raw).unwrap().gap("A", "B", 0.3), 0.3);
}

#[test]
fn rule_and_input_changes_change_identity() {
    let mut raw = problem();
    let before = Problem::read(&raw).unwrap().identity;
    raw["nets"][0]["width"] = json!(0.4);
    let widened = Problem::read(&raw).unwrap().identity;
    assert_ne!(before, widened);
    raw["inputs"]["fixture"] = json!("1".repeat(64));
    assert_ne!(widened, Problem::read(&raw).unwrap().identity);
}

#[test]
fn complete_proposal_is_deterministic_and_unqualified() {
    let (first, second) = (solve(&problem()), solve(&problem()));
    assert_eq!(first.routes[0].points, second.routes[0].points);
    assert!(first.unresolved.is_empty());
    assert_eq!(first.routes[0].length_mm, 8.0);
    assert!(!first.qualified);
    assert!(first.native_validation_required);
}

#[test]
fn actual_width_closes_a_channel_the_minimum_width_would_pass() {
    let mut raw = problem();
    raw["obstacles"] = json!([obstacle("lower", [0.0, 0.0, 10.0, 4.5], ""), obstacle("upper", [0.0, 5.5, 10.0, 10.0], "")]);
    assert!(solve(&raw).unresolved.is_empty());
    raw["nets"][0]["width"] = json!(0.8);
    let result = solve(&raw);
    assert!(result.routes.is_empty());
    assert_eq!(blockers_of(&result), ["lower", "upper"]);
}

#[test]
fn layers_and_pair_rules_are_preserved() {
    let mut raw = problem();
    raw["obstacles"] = json!([obstacle("B-pad", [4.0, 5.6, 6.0, 6.6], "B")]);
    assert!(solve(&raw).unresolved.is_empty());
    raw["pair_clearances"] = json!([{"nets": ["A", "B"], "clearance": 1, "source": "synthetic"}]);
    assert!(!solve(&raw).unresolved.is_empty());
    raw["connections"][0]["layers"] = json!(["B.Cu"]);
    let result = solve(&raw);
    assert!(result.unresolved.is_empty());
    assert_eq!(result.routes[0].layer, "B.Cu");
}

#[test]
fn copper_on_another_net_blocks_and_own_net_connects() {
    let mut raw = problem();
    raw["obstacles"] = json!([obstacle("locked-trace-envelope", [4.0, 0.0, 6.0, 10.0], "B")]);
    assert!(!solve(&raw).unresolved.is_empty());
    raw["obstacles"][0]["net"] = json!("A");
    assert!(solve(&raw).unresolved.is_empty());
}

#[test]
fn generated_routes_cannot_short_each_other() {
    let mut raw = problem();
    let crossing = json!({"name": "b", "net": "B", "start": [5, 1], "end": [5, 9], "layers": ["F.Cu"]});
    raw["connections"].as_array_mut().unwrap().push(crossing);
    let result = solve(&raw);
    assert_eq!(result.routes.len(), 1);
    assert_eq!(blockers_of(&result), ["route:a"]);
    raw["connections"][1]["layers"] = json!(["B.Cu"]);
    assert_eq!(solve(&raw).routes.len(), 2);
}

#[test]
fn board_edge_is_checked() {
    let read = Problem::read(&problem()).unwrap();
    let route = Route { connection: "x".into(), net: "A".into(), layer: "F.Cu".into(), width: 0.2,
                        points: vec![[0.1, 5.0], [9.0, 5.0]], length_mm: 8.9 };
    let still = || 0.0;
    let found = blockers(&read, &route, &[], &Budget::new(1.0, &still));
    assert_eq!(found.ok().unwrap().into_iter().collect::<Vec<_>>(), ["board_edge"]);
}

#[test]
fn unsupported_constraints_abstain_before_search() {
    let mut raw = problem();
    raw["unsupported"] = json!(["differential-pair skew constraint"]);
    let result = solve(&raw);
    assert_eq!(result.status, "unsupported");
    assert_eq!(result.attempts, 0);
    assert!(result.routes.is_empty());
}

#[test]
fn timeout_inside_geometry_never_accepts_a_half_checked_route() {
    let mut raw = problem();
    raw["obstacles"] = json!([obstacle("far", [1.0, 1.0, 2.0, 2.0], "")]);
    let ticks = Cell::new(0);
    let clock = || {
        ticks.set(ticks.get() + 1);
        if ticks.get() > 3 { 2.0 } else { 0.0 }
    };
    let result = route_patterns(&Problem::read(&raw).unwrap(), &Budget::new(1.0, &clock));
    assert_eq!(result.status, "timeout");
    assert!(result.routes.is_empty());
    assert!(matches!(result.unresolved[0], Unresolved::Searched { reason: "budget", .. }));
}
