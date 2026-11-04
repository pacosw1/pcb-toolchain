//! Keeping only the requested new copper of an unqualified solver response.

use std::collections::BTreeSet;

use serde_json::{Value, json};

use super::crossings::route_crossings;
use super::{text, traces};
use crate::error::{Result, invalid};
use crate::pyjson::fingerprint;

/// The topology solver can nudge preloaded traces, and those edits cannot enter the native board. Discard them, restore
/// the exact original traces, and leave independent DRC to judge against that unchanged copper.
pub fn selected_route_proposal(srj: &Value, result: &Value, selected_nets: &[String]) -> Result<Value> {
    let completed = result["status"] == "candidate" || result["status"] == "model_mismatch";
    if result.get("input_sha256").and_then(Value::as_str) != Some(fingerprint(srj)?.as_str())
        || result["qualified"] != false || !completed {
        return invalid("no completed matching route proposal to restrict");
    }
    let changes = result.get("changed_fields").cloned().unwrap_or_else(|| json!([]));
    let only_copper = changes.as_array().into_iter().flatten()
        .all(|change| change.as_str().is_some_and(|text| text.starts_with("preserved trace:")));
    if !only_copper {
        return invalid("solver changed non-copper model fields");
    }
    let new = new_copper(srj, result, selected_nets)?;
    let mut merged = traces(srj).to_vec();
    merged.extend(new);

    let mut proposal = result.clone();
    let parent = fingerprint(result)?;
    let fields = [
        ("status", json!("candidate")),
        ("qualified", json!(false)),
        ("native_validation_required", json!(true)),
        ("reason", json!("selected new routes only; original copper restored; native checks required")),
        ("parent_response_sha256", json!(parent)),
        ("discarded_backend_changes", changes),
        ("changed_fields", json!([])),
        ("selected_nets", json!(selected_nets)),
    ];
    for (field, value) in fields {
        proposal[field] = value;
    }
    let conflicts = route_crossings(srj, &merged)?;
    let mut output = srj.clone();
    output["traces"] = Value::Array(merged);
    proposal["output"] = output;
    if !conflicts.is_empty() {
        proposal["status"] = json!("geometry_reject");
        proposal["reason"] = json!("new copper crosses protected or other-net routing");
        proposal["conflicts"] = Value::Array(conflicts);
    }
    Ok(proposal)
}

fn new_copper(srj: &Value, result: &Value, selected_nets: &[String]) -> Result<Vec<Value>> {
    let preserved: BTreeSet<&str> = traces(srj).iter().map(|trace| text(trace, "pcb_trace_id")).collect::<Result<_>>()?;
    let new: Vec<Value> = traces(&result["output"]).iter()
        .filter(|trace| !trace["pcb_trace_id"].as_str().is_some_and(|id| preserved.contains(id)))
        .cloned().collect();
    let selected = |trace: &Value| trace["connection_name"].as_str().is_some_and(|net| selected_nets.iter().any(|name| name == net));
    if new.is_empty() || !new.iter().all(selected) {
        return invalid("new copper outside requested nets or no new copper");
    }
    Ok(new)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn wire(id: &str, net: &str, points: &[[f64; 2]]) -> Value {
        let route: Vec<Value> = points.iter()
            .map(|[x, y]| json!({"route_type": "wire", "x": x, "y": y, "layer": "top", "width": 0.2})).collect();
        json!({"pcb_trace_id": id, "connection_name": net, "route": route})
    }

    fn model() -> Value {
        json!({"traces": [wire("old", "B", &[[0.0, 0.0], [4.0, 4.0]])]})
    }

    fn response(srj: &Value, traces: Vec<Value>) -> Value {
        json!({"status": "candidate", "qualified": false, "input_sha256": fingerprint(srj).unwrap(), "output": {"traces": traces}})
    }

    fn names() -> Vec<String> {
        vec!["A".to_string()]
    }

    #[test]
    fn nudged_copper_is_restored_and_new_copper_kept() {
        let srj = model();
        let nudged = wire("old", "B", &[[9.0, 9.0], [8.0, 8.0]]);
        let new = wire("new", "A", &[[0.0, 5.0], [4.0, 5.0]]);
        let proposal = selected_route_proposal(&srj, &response(&srj, vec![nudged, new.clone()]), &names()).unwrap();
        assert_eq!(proposal["status"], "candidate");
        assert_eq!(proposal["output"]["traces"], json!([srj["traces"][0], new]));
    }

    #[test]
    fn a_crossing_is_a_geometry_reject_not_an_error() {
        let srj = model();
        let crossing = wire("new", "A", &[[0.0, 4.0], [4.0, 0.0]]);
        let proposal = selected_route_proposal(&srj, &response(&srj, vec![crossing]), &names()).unwrap();
        assert_eq!(proposal["status"], "geometry_reject");
        assert_eq!(proposal["conflicts"].as_array().unwrap().len(), 1);
    }

    #[test]
    fn other_nets_stale_hashes_and_model_edits_are_refused() {
        let srj = model();
        let other = wire("new", "C", &[[0.0, 5.0], [4.0, 5.0]]);
        assert!(selected_route_proposal(&srj, &response(&srj, vec![other]), &names()).is_err());
        let mut stale = response(&srj, vec![wire("new", "A", &[[0.0, 5.0], [4.0, 5.0]])]);
        stale["input_sha256"] = json!("0");
        assert!(selected_route_proposal(&srj, &stale, &names()).is_err());
        let mut edited = response(&srj, vec![wire("new", "A", &[[0.0, 5.0], [4.0, 5.0]])]);
        edited["changed_fields"] = json!(["bounds"]);
        assert!(selected_route_proposal(&srj, &edited, &names()).is_err());
    }
}
