//! What must not change between the source board and the routed base: footprints with their poses, and the fixed geometry.
use super::forms::{form_repr, rule_forms};
use crate::decimal::Decimal;
use crate::kicad::raw::{Body, Form, parse};
use crate::pytext::fingerprint;
use serde::Serialize;
use serde_json::{Value, json};
use std::collections::BTreeMap;

/// A footprint's definition hash and its normalized pose. Serialized as evidence: footprint_scope_sha256 hashes this.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct FootprintIdentity {
    pub signature: String,
    pub pose: Vec<String>,
}

fn form_value(form: &Form) -> Value {
    match &form.body {
        Body::Atom(text) => Value::String(text.clone()),
        Body::List(items) => Value::Array(items.iter().map(form_value).collect()),
    }
}

fn decimal(text: &str) -> Result<Decimal, String> {
    Decimal::parse(text).ok_or_else(|| "[<class 'decimal.ConversionSyntax'>]".to_string())
}

fn pose(footprint: &Form) -> Result<[Decimal; 3], String> {
    let mut rows = footprint.children("at");
    let at = rows.next();
    if rows.next().is_some() {
        return Err("ambiguous native field: at".to_string());
    }
    let values: Vec<Decimal> = match at.map(|form| &form.items()[1..]) {
        Some(values) if matches!(values.len(), 2 | 3) => values.iter().map(|value| decimal(value.atom().unwrap_or(""))).collect::<Result<_, _>>()?,
        _ => return Err("missing footprint pose".to_string()),
    };
    Ok([values[0], values[1], values.get(2).copied().unwrap_or(Decimal::ZERO)])
}

/// A pad, property or text `at` is a world angle in KiCad: normalized to the parent, so a rigid move leaves it alone.
fn local_pose(at: &Form, angle: Decimal) -> Result<Value, String> {
    let items = at.items();
    if !matches!(items.len(), 3 | 4) {
        return Err("unsupported local pose".to_string());
    }
    let value = |index: usize| decimal(items[index].atom().unwrap_or(""));
    let degrees = if items.len() == 4 { value(3)? } else { Decimal::ZERO } - angle;
    Ok(json!(["at", value(1)?.normalized(), value(2)?.normalized(), degrees.wrapped_degrees().normalized()]))
}

fn field_value(field: &Form, angle: Decimal) -> Result<Value, String> {
    let posed = ["pad", "property", "fp_text"].iter().any(|head| field.is(head));
    if !posed {
        return Ok(form_value(field));
    }
    let items: Vec<Value> = field.items().iter().map(|item| if item.is("at") { local_pose(item, angle) } else { Ok(form_value(item)) }).collect::<Result<_, _>>()?;
    Ok(Value::Array(items))
}

/// The footprint definition, free of its rigid pose. Local coordinates, pad shapes, nets, properties, ids and everything else
/// stay in, so an unknown change abstains. KiCad sorts independent items differently after a rotation, so the order of the
/// sibling forms does not count; their number does.
fn signature(footprint: &Form, angle: Decimal) -> Result<String, String> {
    let items: Vec<Value> = footprint.items().iter().filter(|item| !item.is("at")).map(|item| field_value(item, angle)).collect::<Result<_, _>>()?;
    let split = items.len().min(2);
    let mut fields: Vec<String> = items[split..].iter().map(fingerprint).collect();
    fields.sort();
    Ok(fingerprint(&json!({"header": items[..split], "fields": fields})))
}

fn reference(footprint: &Form) -> Result<Option<&str>, String> {
    let mut props = BTreeMap::new();
    for row in footprint.children("property") {
        if props.insert(row.text(1).unwrap_or(""), row.text(2).unwrap_or("")).is_some() {
            return Err("duplicate footprint property".to_string());
        }
    }
    Ok(props.get("Reference").copied())
}

/// Reference to identity for every footprint of a board text.
pub fn footprint_identity(text: &str) -> Result<BTreeMap<String, FootprintIdentity>, String> {
    let forms = parse(text).map_err(|_| "expected native PCB".to_string())?;
    let [root] = forms.as_slice() else { return Err("expected native PCB".to_string()) };
    if !root.is("kicad_pcb") {
        return Err("expected native PCB".to_string());
    }
    let mut result = BTreeMap::new();
    for footprint in root.children("footprint") {
        let at = pose(footprint)?;
        let reference = reference(footprint)?.filter(|name| !name.is_empty()).ok_or("ambiguous native footprint membership")?;
        let identity = FootprintIdentity { signature: signature(footprint, at[2])?, pose: at.iter().map(|value| value.normalized()).collect() };
        if result.insert(reference.to_string(), identity).is_some() {
            return Err("ambiguous native footprint membership".to_string());
        }
    }
    Ok(result)
}

/// Every form of a board that a route leaves alone, sorted: not the copper or footprints, and not a zone's fill.
pub fn fixed_geometry(text: &str) -> Result<Vec<String>, String> {
    let forms = rule_forms(text)?;
    let [root] = forms.as_slice() else { return Err("expected one complete native PCB for project applicability".to_string()) };
    if !root.is("kicad_pcb") {
        return Err("expected one complete native PCB for project applicability".to_string());
    }
    let mut values = Vec::new();
    for form in &root.items()[1..] {
        if form.items().is_empty() {
            return Err("malformed native board geometry".to_string());
        }
        if ["segment", "arc", "via", "footprint"].iter().any(|head| form.is(head)) {
            continue;
        }
        let kept = form.items().iter().filter(|item| !form.is("zone") || !(item.is("filled_polygon") || item.is("fill_segments")));
        values.push(kept.map(form_repr).collect::<Vec<_>>().join(" "));
    }
    values.sort();
    Ok(values)
}

#[cfg(test)]
mod tests {
    use super::*;

    const BOARD: &str = r#"(kicad_pcb (version 20260101)
      (footprint "Fixture:Resistor" (layer "F.Cu") (at 10 10 180) (uuid "R10")
        (property "Reference" "R10") (property "Value" "1k")
        (pad "1" smd rect (at -1 0 180) (size 1 1) (layers "F.Cu" "F.Mask") (net "/A") (uuid "R10-1"))))"#;

    #[test]
    fn a_rigid_turn_keeps_the_signature_and_changes_the_pose() {
        let turned = BOARD.replace("(at 10 10 180)", "(at 10 10 90)").replace("(at -1 0 180)", "(at -1 0 90)");
        let (a, b) = (footprint_identity(BOARD).unwrap(), footprint_identity(&turned).unwrap());
        assert_eq!(a["R10"].signature, b["R10"].signature);
        assert_eq!(a["R10"].pose, ["1E+1", "1E+1", "1.8E+2"]);
        assert_ne!(a["R10"].pose, b["R10"].pose);
    }

    #[test]
    fn a_changed_pad_or_net_changes_the_signature() {
        let base = footprint_identity(BOARD).unwrap();
        for changed in [BOARD.replace("(size 1 1)", "(size 2 1)"), BOARD.replace("/A", "/B")] {
            assert_ne!(footprint_identity(&changed).unwrap()["R10"].signature, base["R10"].signature);
        }
    }

    #[test]
    fn a_zone_fill_is_not_fixed_geometry_but_the_zone_is() {
        let board = |fill: &str, layer: &str| format!(r#"(kicad_pcb (segment (start 0 0)) (zone (layer "{layer}") {fill}))"#);
        assert_eq!(fixed_geometry(&board("", "F.Cu")).unwrap(), fixed_geometry(&board("(filled_polygon (pts))", "F.Cu")).unwrap());
        assert_ne!(fixed_geometry(&board("", "F.Cu")).unwrap(), fixed_geometry(&board("", "B.Cu")).unwrap());
    }
}
