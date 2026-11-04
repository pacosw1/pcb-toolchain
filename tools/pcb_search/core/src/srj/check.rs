//! Checks on an SRJ model before any backend runs, so a bad model fails in milliseconds.

use serde_json::{Map, Value, json};

use super::{coordinate, text};
use crate::contract::{number, positive, read_box};
use crate::error::{Result, invalid};
use crate::pyjson::fingerprint;

const REQUIRED: &[&str] = &["layerCount", "minTraceWidth", "minViaPadDiameter", "minViaHoleDiameter", "defaultObstacleMargin",
                            "minBoardEdgeClearance", "allowViaInPad", "allowJumpers", "obstacles", "connections", "bounds"];
const OPTIONAL: &[&str] = &["allowBlindAndBuriedVias", "nominalTraceWidth", "minViaDiameter", "min_via_hole_diameter",
                            "min_via_pad_diameter", "minTraceToPadEdgeClearance", "minTraceToHoleEdgeClearance",
                            "minViaEdgeToPadEdgeClearance", "minViaHoleEdgeToViaHoleEdgeClearance",
                            "minPlatedHoleDrillEdgeToDrillEdgeClearance", "minPadEdgeToPadEdgeClearance",
                            "differentialPairs", "buses", "outline", "traces", "jumpers", "availableJumperTypes"];

/// Every routing dimension and policy must be explicit. Returns the model's fingerprint.
pub fn check_input(srj: &Value) -> Result<String> {
    let row = read_fields(srj)?;
    if !row["layerCount"].as_u64().is_some_and(|count| count >= 1) {
        return invalid("invalid layer count");
    }
    let hole = positive(&row["minViaHoleDiameter"], "minViaHoleDiameter")?;
    let pad = positive(&row["minViaPadDiameter"], "minViaPadDiameter")?;
    positive(&row["minTraceWidth"], "minTraceWidth")?;
    number(&row["defaultObstacleMargin"], "defaultObstacleMargin")?;
    number(&row["minBoardEdgeClearance"], "minBoardEdgeClearance")?;
    if hole >= pad {
        return invalid("via hole must be smaller than its copper pad");
    }
    if !(row["allowViaInPad"].is_boolean() && row["allowJumpers"].is_boolean()) {
        return invalid("explicit boolean fabrication policy required");
    }
    check_bounds(&row["bounds"])?;
    if !(row["obstacles"].is_array() && row["connections"].is_array()) {
        return invalid("SRJ geometry and connection arrays required");
    }
    check_connection_names(&row["connections"])?;
    // Also refuses out-of-range numbers anywhere, including nested geometry.
    fingerprint(srj)
}

fn read_fields(srj: &Value) -> Result<&Map<String, Value>> {
    let known = |key: &String| REQUIRED.contains(&key.as_str()) || OPTIONAL.contains(&key.as_str());
    match srj.as_object() {
        Some(row) if REQUIRED.iter().all(|key| row.contains_key(*key)) && row.keys().all(known) => Ok(row),
        _ => invalid("missing or unknown SRJ fields; routing dimensions/policies must be explicit"),
    }
}

fn check_bounds(bounds: &Value) -> Result<()> {
    let edges = ["minX", "minY", "maxX", "maxY"];
    let Some(row) = bounds.as_object().filter(|row| row.len() == 4 && edges.iter().all(|edge| row.contains_key(*edge))) else {
        return invalid("invalid SRJ bounds");
    };
    read_box(&Value::Array(edges.iter().map(|edge| row[*edge].clone()).collect())).map(|_| ())
}

fn check_connection_names(connections: &Value) -> Result<()> {
    let rows = connections.as_array().map_or(&[][..], Vec::as_slice);
    let names: Vec<Option<&str>> = rows.iter().map(|row| row.get("name").and_then(Value::as_str)).collect();
    let mut seen = std::collections::BTreeSet::new();
    if names.iter().all(|name| name.is_some_and(|name| !name.is_empty() && seen.insert(name))) {
        Ok(())
    } else {
        invalid("unique connection names required")
    }
}

/// Terminals blocked on every layer they can reach, in the supplied model. A conflict asks for the model and the native
/// board to be reconciled; it never proves the board unroutable.
pub fn terminal_conflicts(srj: &Value) -> Result<Vec<Value>> {
    let mut conflicts = Vec::new();
    for connection in rows(srj, "connections") {
        let name = text(connection, "name")?;
        for point in rows(connection, "pointsToConnect") {
            let mut blocked = Map::new();
            for layer in access_layers(point)? {
                blocked.insert(layer.to_string(), Value::Array(Vec::new()));
            }
            for obstacle in rows(srj, "obstacles") {
                note_blockers(srj, name, point, obstacle, &mut blocked)?;
            }
            if blocked.values().all(|found| found.as_array().is_some_and(|rows| !rows.is_empty())) {
                conflicts.push(json!({"connection": name, "point": point, "blockers": blocked, "unroutable_proven": false}));
            }
        }
    }
    Ok(conflicts)
}

fn rows<'a>(row: &'a Value, field: &str) -> &'a [Value] {
    row.get(field).and_then(Value::as_array).map_or(&[], Vec::as_slice)
}

fn access_layers(point: &Value) -> Result<Vec<&str>> {
    let names: Option<Vec<&str>> = match point.get("layers") {
        Some(layers) => layers.as_array().and_then(|rows| rows.iter().map(Value::as_str).collect()),
        None => point.get("layer").and_then(Value::as_str).map(|layer| vec![layer]),
    };
    match names {
        Some(names) if !names.is_empty() => Ok(names),
        _ => invalid("terminal copper access layers required"),
    }
}

fn note_blockers(srj: &Value, connection: &str, point: &Value, obstacle: &Value, blocked: &mut Map<String, Value>) -> Result<()> {
    let own_net = rows(obstacle, "connectedTo").iter().any(|net| net.as_str() == Some(connection));
    if own_net || distance_to_obstacle(point, obstacle)? >= clearance_from(srj, obstacle)? {
        return Ok(());
    }
    let id = obstacle.get("obstacleId").cloned().unwrap_or_else(|| json!("unnamed obstacle"));
    for layer in rows(obstacle, "layers").iter().filter_map(Value::as_str) {
        if let Some(Value::Array(found)) = blocked.get_mut(layer) {
            found.push(id.clone());
        }
    }
    Ok(())
}

fn clearance_from(srj: &Value, obstacle: &Value) -> Result<f64> {
    let margin = coordinate(srj, "defaultObstacleMargin")?;
    let hole = obstacle.get("isNonPlatedHole").and_then(Value::as_bool).unwrap_or(false);
    let gap = if hole { srj.get("minTraceToHoleEdgeClearance").and_then(Value::as_f64).unwrap_or(margin) } else { margin };
    Ok(gap + coordinate(srj, "minTraceWidth")? / 2.0)
}

fn distance_to_obstacle(point: &Value, obstacle: &Value) -> Result<f64> {
    let center = &obstacle["center"];
    let dx = coordinate(point, "x")? - coordinate(center, "x")?;
    let dy = coordinate(point, "y")? - coordinate(center, "y")?;
    let angle = obstacle.get("ccwRotationDegrees").and_then(Value::as_f64).unwrap_or(0.0).to_radians();
    let (x, y) = (dx * angle.cos() + dy * angle.sin(), -dx * angle.sin() + dy * angle.cos());
    let (width, height) = (coordinate(obstacle, "width")?, coordinate(obstacle, "height")?);
    if obstacle.get("shape").and_then(Value::as_str) == Some("circle") {
        if width != height {
            return invalid("circle obstacle must have equal diameters");
        }
        return Ok((x.hypot(y) - width / 2.0).max(0.0));
    }
    Ok((x.abs() - width / 2.0).max(0.0).hypot((y.abs() - height / 2.0).max(0.0)))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn srj() -> Value {
        json!({"layerCount": 2, "minTraceWidth": 0.2, "minViaPadDiameter": 0.6, "minViaHoleDiameter": 0.3,
               "defaultObstacleMargin": 0.2, "minBoardEdgeClearance": 0.2, "allowViaInPad": false, "allowJumpers": false,
               "bounds": {"minX": 0, "minY": 0, "maxX": 10, "maxY": 10},
               "obstacles": [{"type": "rect", "obstacleId": "wall", "layers": ["top", "bottom"],
                              "center": {"x": 5, "y": 5}, "width": 2, "height": 4, "connectedTo": []}],
               "connections": [{"name": "A", "pointsToConnect": [{"x": 1, "y": 5, "layer": "top"}, {"x": 9, "y": 5, "layer": "top"}]}]})
    }

    #[test]
    fn missing_rules_unknown_fields_and_duplicate_connections_are_refused() {
        let mutations: Vec<fn(&mut Value)> = vec![
            |p| { p.as_object_mut().unwrap().shift_remove("minViaHoleDiameter"); },
            |p| p["unknown_rule"] = json!(1),
            |p| p["allowViaInPad"] = json!("yes"),
            |p| {
                let copy = p["connections"][0].clone();
                p["connections"].as_array_mut().unwrap().push(copy);
            },
        ];
        assert!(check_input(&srj()).is_ok());
        for mutate in mutations {
            let mut model = srj();
            mutate(&mut model);
            assert!(check_input(&model).is_err(), "accepted {model}");
        }
    }

    #[test]
    fn blocked_terminal_is_reported_without_claiming_unroutable() {
        let mut model = srj();
        model["obstacles"][0]["center"] = json!({"x": 1, "y": 5});
        let conflicts = terminal_conflicts(&model).unwrap();
        assert_eq!(conflicts[0]["unroutable_proven"], false);
        model["connections"][0]["pointsToConnect"][0] = json!({"x": 1, "y": 5, "layers": ["top", "bottom"]});
        model["obstacles"][0]["layers"] = json!(["top"]);
        assert!(terminal_conflicts(&model).unwrap().is_empty());
        model["obstacles"][0]["layers"] = json!(["top", "bottom"]);
        model["obstacles"][0]["connectedTo"] = json!(["A"]);
        assert!(terminal_conflicts(&model).unwrap().is_empty());
    }

    #[test]
    fn rotated_obstacle_does_not_use_its_large_axis_aligned_box() {
        let mut model = srj();
        let wall = &mut model["obstacles"][0];
        wall["center"] = json!({"x": 2, "y": 4});
        wall["width"] = json!(4);
        wall["height"] = json!(0.2);
        wall["ccwRotationDegrees"] = json!(45);
        assert!(terminal_conflicts(&model).unwrap().is_empty());
        model["connections"][0]["pointsToConnect"][0]["x"] = json!(1);
        model["connections"][0]["pointsToConnect"][0]["y"] = json!(3);
        assert!(!terminal_conflicts(&model).unwrap().is_empty());
    }
}
