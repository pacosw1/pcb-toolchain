//! Whether any pad can get a thermal connection. Proves only the complete no-zone, all-explicit-solid, no-override subset.
use crate::kicad::raw::Form;
use serde_json::{Value, json};

const SOURCES: [&str; 3] = [
    "https://raw.githubusercontent.com/KiCad/kicad-source-mirror/10.0.6/pcbnew/pcb_io/kicad_sexpr/pcb_io_kicad_sexpr_parser.cpp",
    "https://raw.githubusercontent.com/KiCad/kicad-source-mirror/10.0.6/pcbnew/zones.h",
    "https://raw.githubusercontent.com/KiCad/kicad-source-mirror/10.0.6/pcbnew/drc/drc_test_provider_zone_connections.cpp",
];

/// Calls `visit` on the form and on every list under it.
fn walk<'a>(form: &'a Form, visit: &mut impl FnMut(&'a Form) -> Result<(), String>) -> Result<(), String> {
    if form.atom().is_some() {
        return Ok(());
    }
    visit(form)?;
    form.items().iter().try_for_each(|item| walk(item, visit))
}

fn check_zone(zone: &Form) -> Result<(), String> {
    let connections: Vec<&Form> = zone.children("connect_pads").collect();
    let [connection] = connections.as_slice() else { return Err("zone thermal mode is missing or ambiguous".to_string()) };
    let modes: Vec<&str> = connection.items()[1..].iter().filter_map(Form::atom).collect();
    if modes == ["yes"] || modes == ["no"] { Ok(()) } else { Err("native zone mode is thermal/default/unknown".to_string()) }
}

/// Native enum: INHERITED=-1, NONE=0, THERMAL=1, FULL=2, THT_THERMAL=3.
fn check_override(form: &Form) -> Result<(), String> {
    match form.items() {
        [_, mode] if matches!(mode.atom(), Some("-1" | "0" | "2")) => Ok(()),
        _ => Err("footprint/pad zone mode can require thermal reliefs".to_string()),
    }
}

/// `native_roots`: the boards; `custom_rules`: the forms of the rule file.
pub fn thermal_scope(native_roots: &[Form], custom_rules: &[Form]) -> Value {
    let (mut zones, mut overrides) = (0, 0);
    let mut scan = || -> Result<(), String> {
        for form in custom_rules {
            walk(form, &mut |item| {
                if item.is("constraint") && item.text(1) == Some("zone_connection") {
                    return Err("custom zone-connection rules need native applicability resolution".to_string());
                }
                Ok(())
            })?;
        }
        for root in native_roots {
            walk(root, &mut |form| {
                if form.is("zone") && form.children("keepout").next().is_none() {
                    zones += 1;
                    check_zone(form)
                } else if form.is("zone_connect") {
                    overrides += 1;
                    check_override(form)
                } else {
                    Ok(())
                }
            })?;
        }
        Ok(())
    };
    let scanned = scan();
    let (possible, reason) = match scanned {
        Ok(()) => (false, "complete native scope has no zones or only explicit solid/none zones, with no thermal footprint/pad/custom-rule override".to_string()),
        Err(error) => (true, error),
    };
    json!({"thermal_connections_possible": possible, "zones": zones, "overrides": overrides, "primary_sources": SOURCES, "reason": reason})
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::kicad::raw::parse;

    fn scope(board: &str, rules: &str) -> Value {
        thermal_scope(&parse(board).unwrap(), &parse(rules).unwrap())
    }

    #[test]
    fn explicit_solid_zones_leave_no_thermals() {
        let result = scope("(kicad_pcb (zone (connect_pads yes (clearance 0.2))) (zone (keepout) ) (zone_connect 2))", "");
        assert_eq!(result["thermal_connections_possible"], false);
        assert_eq!(result["zones"], 1);
        assert_eq!(result["overrides"], 1);
    }

    #[test]
    fn anything_else_stays_possible_with_its_reason() {
        let cases = [
            ("(kicad_pcb (zone (connect_pads (clearance 0.2))))", "", "native zone mode is thermal/default/unknown"),
            ("(kicad_pcb (zone))", "", "zone thermal mode is missing or ambiguous"),
            ("(kicad_pcb (zone_connect 1))", "", "footprint/pad zone mode can require thermal reliefs"),
            ("(kicad_pcb)", "(rule x (constraint zone_connection solid))", "custom zone-connection rules need native applicability resolution"),
        ];
        for (board, rules, reason) in cases {
            let result = scope(board, rules);
            assert_eq!(result["thermal_connections_possible"], true);
            assert_eq!(result["reason"], reason);
        }
    }
}
