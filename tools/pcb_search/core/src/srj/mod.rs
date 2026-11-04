//! SimpleRouteJson: the model a routing backend reads and returns.
//!
//! Backends add their own annotations, so documents stay `serde_json::Value` and pass through whole. Only the geometry
//! these checks need is read into types.

pub mod check;
pub mod crossings;
pub mod repair;
pub mod scope;
pub mod vias;

use serde_json::Value;

use crate::error::{Invalid, Result};

/// `==` of Python's JSON values: 2 and 2.0 are equal, which `Value`'s own comparison denies.
pub fn same_value(a: &Value, b: &Value) -> bool {
    match (a, b) {
        (Value::Number(x), Value::Number(y)) => x.as_f64() == y.as_f64(),
        (Value::Array(x), Value::Array(y)) => x.len() == y.len() && x.iter().zip(y).all(|(p, q)| same_value(p, q)),
        (Value::Object(x), Value::Object(y)) => {
            x.len() == y.len() && x.iter().all(|(key, p)| y.get(key).is_some_and(|q| same_value(p, q)))
        }
        _ => a == b,
    }
}

/// Backend annotations are allowed, but every field that was supplied must come back unchanged.
pub fn retains_fields(actual: &Value, expected: &Value) -> bool {
    match expected {
        Value::Object(fields) => actual.as_object().is_some_and(|row| {
            fields.iter().all(|(key, value)| row.get(key).is_some_and(|got| retains_fields(got, value)))
        }),
        Value::Array(items) => actual.as_array().is_some_and(|rows| {
            rows.len() == items.len() && rows.iter().zip(items).all(|(got, value)| retains_fields(got, value))
        }),
        _ => same_value(actual, expected),
    }
}

/// The traces of a document; an absent list is empty.
pub fn traces(document: &Value) -> &[Value] {
    document.get("traces").and_then(Value::as_array).map_or(&[], Vec::as_slice)
}

/// A required text field of a route document.
pub fn text<'a>(row: &'a Value, field: &str) -> Result<&'a str> {
    row.get(field).and_then(Value::as_str).ok_or_else(|| Invalid(format!("missing text field {field}")))
}

/// A required number field of a route document.
pub fn coordinate(row: &Value, field: &str) -> Result<f64> {
    row.get(field).and_then(Value::as_f64).ok_or_else(|| Invalid(format!("missing number field {field}")))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn parsed(text: &str) -> Value {
        serde_json::from_str(text).unwrap()
    }

    #[test]
    fn annotations_are_allowed_but_not_changes_to_geometry_or_connectivity() {
        assert!(retains_fields(&parsed(r#"{"width": 2, "__zLayers": [0, 1]}"#), &parsed(r#"{"width": 2.0}"#)));
        assert!(!retains_fields(&json!({"width": 1, "__zLayers": [0, 1]}), &json!({"width": 2})));
        assert!(!retains_fields(&json!({"connectedTo": ["B"]}), &json!({"connectedTo": ["A"]})));
        assert!(!retains_fields(&json!({"width": true}), &json!({"width": 1})));
    }

    #[test]
    fn numbers_compare_by_value_not_by_text() {
        assert!(same_value(&parsed("[1, {\"x\": 2.50}]"), &parsed("[1.0, {\"x\": 2.5}]")));
        assert!(!same_value(&parsed("{\"x\": 1}"), &parsed("{\"x\": 1, \"y\": 2}")));
    }
}
