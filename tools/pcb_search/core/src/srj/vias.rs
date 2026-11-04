//! Turning a backend's "through obstacle" step back into the exact source via it passed through.

use serde_json::{Value, json};

use super::{same_value, text, traces};
use crate::error::{Result, invalid};

struct SourceVia<'a> {
    id: &'a str,
    net: &'a str,
    point: &'a Value,
}

/// Resolve only exact transitions through source-bound, via-only traces. A multilayer obstacle or a shared net name
/// alone is not connectivity evidence. Native import checks the referenced via again before adding copper.
pub fn resolve_existing_vias(srj: &Value, output: &[Value]) -> Result<Vec<Value>> {
    let vias = source_vias(srj)?;
    let mut resolved = output.to_vec();
    for trace in &mut resolved {
        let net = text(trace, "connection_name")?.to_string();
        for point in trace["route"].as_array_mut().into_iter().flatten() {
            if point["route_type"] == "through_obstacle" {
                *point = reused_via(point, &net, &vias)?;
            }
        }
    }
    Ok(resolved)
}

fn source_vias(srj: &Value) -> Result<Vec<SourceVia<'_>>> {
    let mut vias = Vec::new();
    for trace in traces(srj) {
        if let [point] = trace["route"].as_array().map_or(&[][..], Vec::as_slice) {
            if point["route_type"] == "via" {
                vias.push(SourceVia { id: text(trace, "pcb_trace_id")?, net: text(trace, "connection_name")?, point });
            }
        }
    }
    Ok(vias)
}

fn reused_via(step: &Value, net: &str, vias: &[SourceVia]) -> Result<Value> {
    if !step["start"].is_object() || !same_value(&step["start"], &step["end"]) {
        return invalid("unsupported transition through an obstacle; exact original via required");
    }
    let matches: Vec<&SourceVia> = vias.iter().filter(|via| via.net == net && passes_through(step, via.point)).collect();
    let [via] = matches.as_slice() else { return invalid("existing layer transition lacks one exact source via") };
    let old = via.point;
    Ok(json!({"route_type": "via", "x": old["x"], "y": old["y"], "from_layer": step["from_layer"], "to_layer": step["to_layer"],
              "via_diameter": old["via_diameter"], "via_hole_diameter": old["via_hole_diameter"], "reuse_via_id": via.id}))
}

fn passes_through(step: &Value, via: &Value) -> bool {
    let (from, to) = (&step["from_layer"], &step["to_layer"]);
    let same_layers = (from == &via["from_layer"] && to == &via["to_layer"]) || (from == &via["to_layer"] && to == &via["from_layer"]);
    from != to && same_layers && same_value(&step["start"], &json!({"x": via["x"], "y": via["y"]}))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn via(id: &str) -> Value {
        json!({"pcb_trace_id": id, "connection_name": "A", "route": [{"route_type": "via", "x": 2, "y": 3,
               "from_layer": "top", "to_layer": "bottom", "via_diameter": 0.6, "via_hole_diameter": 0.3}]})
    }

    fn step() -> Value {
        json!({"route_type": "through_obstacle", "start": {"x": 2, "y": 3}, "end": {"x": 2, "y": 3},
               "from_layer": "bottom", "to_layer": "top", "width": 0.2})
    }

    fn trace(net: &str, step: Value) -> Value {
        json!({"pcb_trace_id": "new", "connection_name": net, "route": [step]})
    }

    #[test]
    fn a_transition_needs_the_exact_via_and_net() {
        let srj = json!({"traces": [via("native-via")]});
        let resolved = resolve_existing_vias(&srj, &[trace("A", step())]).unwrap();
        assert_eq!(resolved[0]["route"][0]["reuse_via_id"], "native-via");
        assert_eq!(resolved[0]["route"][0]["from_layer"], "bottom");
        assert!(resolve_existing_vias(&srj, &[trace("B", step())]).is_err());
        let mut moved = step();
        moved["end"] = json!({"x": 2.000001, "y": 3});
        assert!(resolve_existing_vias(&srj, &[trace("A", moved)]).is_err());
    }

    #[test]
    fn no_via_or_two_candidates_is_refused() {
        for originals in [json!([]), json!([via("one"), via("two")])] {
            assert!(resolve_existing_vias(&json!({"traces": originals}), &[trace("A", step())]).is_err());
        }
    }
}
