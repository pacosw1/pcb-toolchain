//! The clearances of a `.kicad_pro`, with their written decimals. A project with a repeated key anywhere is refused, as is a
//! document without the rules and netclasses the floor needs: no KiCad default is invented.
use crate::decimal::Decimal;
use serde::Deserialize;
use serde::de::{Deserializer, Error, MapAccess, Visitor};
use serde_json::value::RawValue;
use std::collections::BTreeMap;
use std::fmt;

/// A netclass of the project: its position in the file (the source pointer) and its authored clearance. A value that is not
/// a finite non-negative number keeps its error until something needs it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ClassClearance {
    pub index: usize,
    pub clearance: Option<Result<Decimal, String>>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ProjectClearances {
    pub classes: BTreeMap<String, ClassClearance>,
    pub min_clearance: Option<Result<Decimal, String>>,
}

/// An object as raw members, refusing a repeated key.
struct Members(BTreeMap<String, Box<RawValue>>);

impl<'de> Deserialize<'de> for Members {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        struct Reader;
        impl<'de> Visitor<'de> for Reader {
            type Value = Members;
            fn expecting(&self, formatter: &mut fmt::Formatter) -> fmt::Result {
                formatter.write_str("a JSON object")
            }
            fn visit_map<A: MapAccess<'de>>(self, mut map: A) -> Result<Members, A::Error> {
                let mut members = BTreeMap::new();
                while let Some((key, value)) = map.next_entry::<String, Box<RawValue>>()? {
                    if members.contains_key(&key) {
                        return Err(A::Error::custom(format!("duplicate project field: {key}")));
                    }
                    members.insert(key, value);
                }
                Ok(Members(members))
            }
        }
        deserializer.deserialize_map(Reader)
    }
}

fn members(raw: &str) -> Result<BTreeMap<String, Box<RawValue>>, String> {
    serde_json::from_str::<Members>(raw).map(|members| members.0).map_err(|error| error.to_string())
}

fn is_object(raw: &str) -> bool {
    raw.starts_with('{')
}

/// Every object of the document, read for repeated keys.
fn check_unique(raw: &str) -> Result<(), String> {
    if is_object(raw) {
        return members(raw)?.values().try_for_each(|value| check_unique(value.get()));
    }
    if raw.starts_with('[') {
        let items: Vec<Box<RawValue>> = serde_json::from_str(raw).map_err(|error| error.to_string())?;
        return items.iter().try_for_each(|item| check_unique(item.get()));
    }
    Ok(())
}

fn number(raw: &str) -> Result<Decimal, String> {
    let bad = || "expected authored finite nonnegative number in millimetres".to_string();
    let numeric = raw.starts_with(|c: char| c.is_ascii_digit() || c == '-');
    let value = Decimal::parse(raw).filter(|_| numeric).ok_or_else(bad)?;
    if value < Decimal::ZERO { Err(bad()) } else { Ok(value) }
}

fn member<'a>(object: &'a BTreeMap<String, Box<RawValue>>, name: &str) -> Result<&'a str, String> {
    object.get(name).map(|value| value.get()).ok_or_else(|| "project rules/netclass requirements are unresolved".to_string())
}

fn object_at(raw: &str) -> Result<BTreeMap<String, Box<RawValue>>, String> {
    if is_object(raw) { members(raw) } else { Err("project rules/netclass requirements are unresolved".to_string()) }
}

fn read_classes(raw: &str) -> Result<BTreeMap<String, ClassClearance>, String> {
    let names_bad = || "project netclasses have missing/duplicate names".to_string();
    let items: Vec<Box<RawValue>> = serde_json::from_str(raw).map_err(|_| "project rules and nonempty netclass list are required".to_string())?;
    if items.is_empty() {
        return Err("project rules and nonempty netclass list are required".to_string());
    }
    let mut classes = BTreeMap::new();
    for (index, item) in items.iter().enumerate() {
        let body = if is_object(item.get()) { members(item.get())? } else { return Err(names_bad()) };
        let name: String = body.get("name").and_then(|raw| serde_json::from_str(raw.get()).ok()).filter(|name: &String| !name.is_empty()).ok_or_else(names_bad)?;
        let clearance = body.get("clearance").map(|raw| number(raw.get()));
        if classes.insert(name, ClassClearance { index, clearance }).is_some() {
            return Err(names_bad());
        }
    }
    if classes.contains_key("Default") { Ok(classes) } else { Err("explicit Default netclass is required".to_string()) }
}

/// The netclass clearances and project minimum of a project text.
pub fn project_clearances(text: &str) -> Result<ProjectClearances, String> {
    let raw: Box<RawValue> = serde_json::from_str(text).map_err(|error| error.to_string())?;
    check_unique(raw.get())?;
    if !is_object(raw.get()) {
        return Err("native project must be an object".to_string());
    }
    let project = members(raw.get())?;
    let board = object_at(member(&project, "board")?)?;
    let settings = object_at(member(&board, "design_settings")?)?;
    let rules_text = member(&settings, "rules")?;
    let net_settings = object_at(member(&project, "net_settings")?)?;
    let classes_text = member(&net_settings, "classes")?;
    if !is_object(rules_text) {
        return Err("project rules and nonempty netclass list are required".to_string());
    }
    let classes = read_classes(classes_text)?;
    let min_clearance = members(rules_text)?.get("min_clearance").map(|raw| number(raw.get()));
    Ok(ProjectClearances { classes, min_clearance })
}

#[cfg(test)]
mod tests {
    use super::*;

    const PROJECT: &str = r#"{"board": {"design_settings": {"rules": {"min_clearance": 0.0}}},
        "net_settings": {"classes": [{"name": "Default", "clearance": 0.2}, {"name": "POE", "clearance": 1e-06}, {"name": "X", "clearance": true}, {"name": "Y"}]}}"#;

    #[test]
    fn written_decimals_survive() {
        let project = project_clearances(PROJECT).unwrap();
        let text = |name: &str| project.classes[name].clearance.clone().unwrap().unwrap().text();
        assert_eq!(text("Default"), "0.2");
        assert_eq!(text("POE"), "0.000001");
        assert_eq!(project.classes["POE"].index, 1);
        assert_eq!(project.min_clearance.unwrap().unwrap().text(), "0.0");
        assert!(project.classes["X"].clearance.as_ref().unwrap().is_err());
        assert_eq!(project.classes["Y"].clearance, None);
    }

    #[test]
    fn unresolved_documents_are_refused() {
        for text in ["{}", "[]", "{", r#"{"board":{},"board":{}}"#, r#"{"board":{"design_settings":{"rules":{}}},"net_settings":{"classes":[]}}"#] {
            assert!(project_clearances(text).is_err(), "{text}");
        }
        let no_default = r#"{"board":{"design_settings":{"rules":{}}},"net_settings":{"classes":[{"name":"A"}]}}"#;
        assert_eq!(project_clearances(no_default).unwrap_err(), "explicit Default netclass is required");
        let repeated = r#"{"board":{"design_settings":{"rules":{"a":1,"a":2}}},"net_settings":{"classes":[{"name":"Default"}]}}"#;
        assert!(project_clearances(repeated).unwrap_err().contains("duplicate project field: a"));
    }
}
