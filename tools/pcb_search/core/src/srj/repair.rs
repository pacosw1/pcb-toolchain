//! Bounded local repair of a rejected route proposal. Native validation decides acceptance.

use std::collections::BTreeSet;

use serde_json::{Value, json};

use super::crossings::route_crossings;
use super::{coordinate, same_value, text, traces};
use crate::budget::Budget;
use crate::error::{Result, invalid};
use crate::pyjson::fingerprint;

type Spot = (u64, u64);

/// A hashable place. Adding zero turns -0.0 into 0.0, so equal coordinates give equal keys.
fn spot(point: &Value) -> Result<Spot> {
    Ok(((coordinate(point, "x")? + 0.0).to_bits(), (coordinate(point, "y")? + 0.0).to_bits()))
}

/// Remove one interior waypoint, only if that clears every known crossing.
///
/// Layers, widths, vias, terminals, endpoints and branch anchors stay. This proposes a shortcut; it does not prove
/// obstacle, clearance or connectivity safety. It repeats no routing job and changes no original copper.
pub fn prune_crossing_excursion(srj: &Value, proposal: &Value, budget: &Budget) -> Result<Value> {
    if proposal.get("input_sha256").and_then(Value::as_str) != Some(fingerprint(srj)?.as_str())
        || proposal["qualified"] != false || proposal["status"] != "geometry_reject" {
        return invalid("matching rejected proposal required for local repair");
    }
    let mut result = proposal.clone();
    result["parent_response_sha256"] = json!(fingerprint(proposal)?);
    result["repair"] = json!({"strategy": "one_waypoint_crossing_shortcut", "attempts": 0, "edits": []});
    let mut candidates = traces(&result["output"]).to_vec();
    let affected = affected_traces(srj, &candidates)?;
    let anchors = anchors(srj, &candidates)?;
    let mut attempts = 0;
    for index in 0..candidates.len() {
        if !affected.contains(text(&candidates[index], "pcb_trace_id")?) {
            continue;
        }
        let route = candidates[index]["route"].as_array().cloned().unwrap_or_default();
        for waypoint in 1..route.len().saturating_sub(1) {
            if budget.expired() {
                result["repair"]["attempts"] = json!(attempts);
                result["reason"] = json!("local repair deadline; original proposal retained");
                return Ok(result);
            }
            if !removable(&route[waypoint - 1..=waypoint + 1], &anchors)? {
                continue;
            }
            attempts += 1;
            let mut shorter = route.clone();
            shorter.remove(waypoint);
            candidates[index]["route"] = Value::Array(shorter);
            if route_crossings(srj, &candidates)?.is_empty() && !budget.expired() {
                accept(&mut result, candidates.clone(), &candidates[index], &route[waypoint], attempts, budget)?;
                return Ok(result);
            }
            candidates[index]["route"] = Value::Array(route.clone());
        }
    }
    result["repair"]["attempts"] = json!(attempts);
    result["reason"] = json!("no single safe-to-test waypoint shortcut; original proposal retained");
    result["repair"]["elapsed_s"] = json!(budget.elapsed_s());
    Ok(result)
}

fn affected_traces(srj: &Value, candidates: &[Value]) -> Result<BTreeSet<String>> {
    let originals: BTreeSet<&str> = traces(srj).iter().map(|trace| text(trace, "pcb_trace_id")).collect::<Result<_>>()?;
    Ok(route_crossings(srj, candidates)?.iter()
        .flat_map(|conflict| conflict["trace_ids"].as_array().cloned().unwrap_or_default())
        .filter_map(|id| id.as_str().map(String::from))
        .filter(|id| !originals.contains(id.as_str()))
        .collect())
}

/// Places a shortcut must keep: terminals, vias and the ends of every route.
fn anchors(srj: &Value, candidates: &[Value]) -> Result<BTreeSet<Spot>> {
    let mut anchors = BTreeSet::new();
    for connection in srj["connections"].as_array().into_iter().flatten() {
        for point in connection["pointsToConnect"].as_array().into_iter().flatten() {
            anchors.insert(spot(point)?);
        }
    }
    for trace in candidates {
        let route = trace["route"].as_array().map_or(&[][..], Vec::as_slice);
        for point in route.iter().filter(|point| point["route_type"] == "via").chain(route.first()).chain(route.last()) {
            anchors.insert(spot(point)?);
        }
    }
    Ok(anchors)
}

/// True when the middle of three route points is a plain bend on one layer at one width.
fn removable(triple: &[Value], anchors: &BTreeSet<Spot>) -> Result<bool> {
    let [before, point, after] = triple else { return Ok(false) };
    if !triple.iter().all(|row| row["route_type"] == "wire") {
        return Ok(false);
    }
    let uniform = [before, after].iter().all(|row| row["layer"] == point["layer"] && same_value(&row["width"], &point["width"]));
    let is_port = |field: &str| point.get(field).is_some_and(truthy);
    Ok(uniform && !anchors.contains(&spot(point)?) && !is_port("start_pcb_port_id") && !is_port("end_pcb_port_id"))
}

fn truthy(value: &Value) -> bool {
    !matches!(value, Value::Null) && value.as_str() != Some("") && value != &json!(false)
}

fn accept(result: &mut Value, candidates: Vec<Value>, trace: &Value, removed: &Value, attempts: u32, budget: &Budget) -> Result<()> {
    result["output"]["traces"] = Value::Array(candidates);
    result["status"] = json!("candidate");
    result["qualified"] = json!(false);
    result["native_validation_required"] = json!(true);
    result["conflicts"] = json!([]);
    result["reason"] = json!("local shortcut proposal; full native checks required");
    result["repair"]["attempts"] = json!(attempts);
    result["repair"]["edits"] = json!([{"trace_id": text(trace, "pcb_trace_id")?, "removed_waypoint": removed}]);
    result["repair"]["elapsed_s"] = json!(budget.elapsed_s());
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn trace(id: &str, net: &str, points: &[(f64, f64)], width: f64) -> Value {
        let route: Vec<Value> = points.iter()
            .map(|(x, y)| json!({"route_type": "wire", "x": x, "y": y, "layer": "bottom", "width": width})).collect();
        json!({"pcb_trace_id": id, "connection_name": net, "route": route})
    }

    /// The rejected ENV-SENSE /V_GAS route of CIP 839. Real coordinates; KiCad reported the conflict independently.
    fn crossing_case() -> (Value, Value) {
        let fixed = trace("134c5847-3003-48df-952f-b47d37bac1f3", "/SCL", &[(118.8453, 122.5076), (115.5582, 119.2204)], 0.15);
        let new = trace("/V_GAS_mst1_0", "/V_GAS", &[(115.73646838518003, 122.50776751596503),
            (117.8413322766497, 120.95757653371493), (116.15356072650107, 121.72155178294548)], 0.25);
        let srj = json!({"traces": [fixed], "connections": [{"name": "/V_GAS", "pointsToConnect": [new["route"][0], new["route"][2]]}]});
        let proposal = json!({"status": "geometry_reject", "qualified": false, "input_sha256": fingerprint(&srj).unwrap(),
                              "output": {"traces": [fixed, new]}});
        (srj, proposal)
    }

    fn repair(srj: &Value, proposal: &Value, limit_s: f64) -> Value {
        let still = || 0.0;
        prune_crossing_excursion(srj, proposal, &Budget::new(limit_s, &still)).unwrap()
    }

    #[test]
    fn native_failure_is_repaired_without_changing_protected_copper() {
        let (srj, proposal) = crossing_case();
        assert_eq!(route_crossings(&srj, traces(&proposal["output"])).unwrap().len(), 2);
        let repaired = repair(&srj, &proposal, 0.5);
        assert_eq!(repaired["status"], "candidate");
        assert_eq!(repaired["repair"]["edits"].as_array().unwrap().len(), 1);
        assert_eq!(repaired["output"]["traces"][0], srj["traces"][0]);
        assert!(route_crossings(&srj, traces(&repaired["output"])).unwrap().is_empty());
        assert_eq!(repaired["qualified"], false);
        assert_eq!(repaired["native_validation_required"], true);
    }

    #[test]
    fn terminals_width_changes_layer_changes_and_vias_are_not_shortcut() {
        let mutations: Vec<fn(&mut Value, &mut Value)> = vec![
            |srj, proposal| {
                let middle = proposal["output"]["traces"][1]["route"][1].clone();
                srj["connections"][0]["pointsToConnect"].as_array_mut().unwrap().push(middle);
            },
            |_, proposal| proposal["output"]["traces"][1]["route"][1]["width"] = json!(0.15),
            |_, proposal| proposal["output"]["traces"][1]["route"][1]["layer"] = json!("top"),
            |_, proposal| {
                let middle = &mut proposal["output"]["traces"][1]["route"][1];
                middle["route_type"] = json!("via");
                middle["from_layer"] = json!("bottom");
                middle["to_layer"] = json!("top");
            },
        ];
        for mutate in mutations {
            let (mut srj, mut proposal) = crossing_case();
            mutate(&mut srj, &mut proposal);
            proposal["input_sha256"] = json!(fingerprint(&srj).unwrap());
            let result = repair(&srj, &proposal, 0.5);
            assert_eq!(result["status"], "geometry_reject");
            assert_eq!(result["repair"]["edits"], json!([]));
        }
    }

    #[test]
    fn exhausted_effort_does_not_accept_a_partial_repair() {
        let (srj, proposal) = crossing_case();
        let result = repair(&srj, &proposal, 0.0);
        assert_eq!(result["status"], "geometry_reject");
        assert_eq!(result["qualified"], false);
    }

    #[test]
    fn a_proposal_that_is_not_rejected_is_refused() {
        let (srj, mut proposal) = crossing_case();
        proposal["status"] = json!("candidate");
        let still = || 0.0;
        assert!(prune_crossing_excursion(&srj, &proposal, &Budget::new(1.0, &still)).is_err());
    }
}
