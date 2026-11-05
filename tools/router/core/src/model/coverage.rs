//! Rule coverage: the admission of a route. What a board asks of the router must be something the model holds, or the route stops
//! before any routing is spent and names the rule. `rules.rs` gives each DRU constraint its state; this pass refuses what that reading
//! has no state for (rule fields, bounds nobody keeps) and the native rules outside the DRU: a pad's layers and clearance, and the
//! project's minimum connection width. Each refusal is a row of `Model::rules` in the state unknown, so `iotroute model` exits 1.
use super::dru::Rule;
use super::files::DesignRules;
use super::output::{Model, RuleReport, RuleState};
use crate::kicad::board::Board;
use crate::kicad::geom::to_mm;
use crate::kicad::raw;
use std::collections::BTreeMap;

/// The constraints read as one minimum: the per-net clearance, the pair table and the hole rules keep nothing else of them.
const MINIMUM_ONLY: [&str; 4] = ["clearance", "creepage", "hole_clearance", "hole_to_hole"];

fn refusal(rule: impl Into<String>, constraint: &str, why: impl Into<String>) -> RuleReport {
    RuleReport { rule: rule.into(), constraint: constraint.to_string(), state: RuleState::Unknown, nets: Vec::new(), why: why.into() }
}

/// Runs after the pair table, which marks its rules applied by name and so could not hold a refusal of `rules.rs`.
pub fn check_rules(rules: &[Rule], design: &DesignRules, report: &mut Vec<RuleReport>) {
    for rule in rules {
        for con in rule.constraints.iter().filter(|c| MINIMUM_ONLY.contains(&c.kind.as_str())) {
            if con.values.keys().eq(["min"].iter().copied()) {
                continue;
            }
            for row in report.iter_mut().filter(|r| r.rule == rule.name && r.constraint == con.kind) {
                row.state = RuleState::Unknown;
                row.why = format!("{}: the router keeps one minimum, and this rule gives {}", con.kind, bounds(con.values.keys()));
            }
        }
        report.extend(rule.unread.iter().map(|field| refusal(&rule.name, "rule_fields", format!("{field}: not read, so not honoured"))));
    }
    if design.min_connection.is_some_and(|width| width.get() > 0.0) {
        report.push(refusal("native project", "min_connection", "the router has no connection width check"));
    }
}

fn bounds<'a>(names: impl Iterator<Item = &'a String>) -> String {
    let names: Vec<&str> = names.map(String::as_str).collect();
    if names.is_empty() { "no bound".to_string() } else { names.join(" ") }
}

/// The `layers` of each footprint pad of the file, by uuid. The API lists `*.Cu` on every copper layer KiCad knows, enabled or not,
/// so only the file tells a wildcard from a pad that names a disabled layer.
fn authored_layers(text: &str) -> Result<BTreeMap<String, Vec<String>>, String> {
    let root = raw::parse_first(text)?;
    let mut out = BTreeMap::new();
    for pad in root.children("footprint").flat_map(|footprint| footprint.children("pad")) {
        let Some(id) = pad.children("uuid").next().and_then(|uuid| uuid.text(1)) else { continue };
        let Some(layers) = pad.children("layers").next() else { continue };
        let names = layers.items().iter().skip(1).filter_map(raw::Form::atom).map(str::to_string).collect();
        if out.insert(id.to_string(), names).is_some() {
            return Err(format!("ambiguous pad uuid {id}"));
        }
    }
    Ok(out)
}

/// Why a pad cannot be routed to, from its layers in the file. Only names are read here: its geometry comes from the API.
fn layer_fault(authored: Option<&Vec<String>>, drilled: bool, copper: &[String]) -> Option<String> {
    let Some(layers) = authored else {
        return drilled.then(|| "a drilled pad has no layers in the board file".to_string());
    };
    let disabled = layers.iter().find(|name| name.ends_with(".Cu") && *name != "*.Cu" && !copper.contains(name))?;
    Some(format!("names copper layer {disabled}, which the board does not enable"))
}

/// The native rules a board file holds outside the DRU. `text` is the file the API read.
pub fn check_board(model: &mut Model, board: &Board, text: &str) -> Result<(), String> {
    let authored = authored_layers(text)?;
    let default = model.classes.get("Default").and_then(|class| class.clearance);
    let mut rows = Vec::new();
    for (footprint, pad) in board.pads() {
        let name = format!("pad {}.{}", footprint.reference, pad.number);
        if let Some(why) = layer_fault(authored.get(&pad.id), pad.drill.x != 0 || pad.drill.y != 0, &board.copper_layers) {
            rows.push(refusal(&name, "layers", why));
        }
        let kept = model.nets.get(&pad.net).and_then(|net| net.clearance).or(default).map_or(0.0, |clearance| clearance.get());
        // A smaller override only relaxes the pad, which the router's larger clearance still keeps.
        if let Some(wanted) = pad.clearance_override.or(footprint.clearance_override).map(to_mm).filter(|wanted| *wanted > kept) {
            rows.push(refusal(&name, "clearance", format!("a local clearance of {wanted} mm, and the router keeps only the net's {kept} mm")));
        }
    }
    model.rules.extend(rows);
    Ok(())
}

/// One line per refused row, as `iotroute model` prints them and a route reports them.
pub fn refused_lines(model: &Model) -> Vec<String> {
    model.rules.iter().filter(|row| row.state == RuleState::Unknown).map(|row| format!("REFUSED {} / {}: {}", row.rule, row.constraint, row.why)).collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::dru::parse_rules;
    use crate::model::num::Num;
    use crate::model::output::Net;
    use crate::model::rules::apply_rules;
    use std::collections::BTreeSet;

    /// The rows of a rule file against one net of each class, as the model ends them.
    fn rows(text: &str) -> Vec<RuleReport> {
        let net = |class: &str| Net { class: class.to_string(), layers: ["F.Cu", "In1.Cu", "B.Cu"].map(str::to_string).to_vec(), width: Some(Num::Float(0.2)), clearance: Some(Num::Float(0.2)), ..Net::default() };
        let mut nets = BTreeMap::from([("ISO1".to_string(), net("ISO")), ("X".to_string(), net("Default"))]);
        let rules = parse_rules(text).unwrap();
        let mut report = apply_rules(&rules, &mut nets, &BTreeSet::new(), &BTreeSet::new()).unwrap().report;
        check_rules(&rules, &DesignRules::default(), &mut report);
        report
    }

    #[test]
    fn a_rule_the_router_does_not_hold_is_refused_by_name_and_env_sense_is_not() {
        // ENV-SENSE's own rule file, and the rule kinds the boards use.
        let admitted = r#"(version 1)
(rule "JLC PTH hole to hole" (constraint hole_to_hole (min 0.45mm)) (condition "A.Pad_Type == 'Through-hole' && B.Pad_Type == 'Through-hole'"))
(rule "JLC PTH hole to copper" (constraint hole_clearance (min 0.28mm)) (condition "A.Pad_Type == 'Through-hole' || B.Pad_Type == 'Through-hole'"))
(rule "silk" (severity ignore) (condition "A.memberOfFootprint('J1') && B.Layer == 'Edge.Cuts'") (constraint silk_clearance (min -10mm)))
(rule "spokes" (condition "A.NetClass == 'ISO'") (constraint min_resolved_spokes 1))
(rule "zone" (condition "A.NetClass == 'ISO' && A.Type == 'Track' && B.Type == 'Zone'") (constraint clearance (min 0.5mm)))
(rule "gap" (condition "A.isCoupledDiffPair()") (constraint clearance (min 0.12mm)))
(rule "none" (condition "A.NetClass == 'NOBODY'") (constraint connection_width (min 1mm)))"#;
        assert!(rows(admitted).iter().all(|row| row.state != RuleState::Unknown), "{:?}", rows(admitted));
        for (rule, name, why) in [
            (r#"(rule "r" (constraint connection_width (min 1mm)))"#, "connection_width", "not modelled"),
            (r#"(rule "r" (condition "A.NetClass == 'ISO'") (constraint edge_clearance (min 1mm)))"#, "edge_clearance", "not modelled"),
            (r#"(rule "r" (condition "A.NetClass == 'ISO'") (constraint clearance (min 1mm) (max 2mm)))"#, "clearance", "max min"),
            (r#"(rule "r" (constraint hole_to_hole (min 1mm) (opt 2mm)))"#, "hole_to_hole", "min opt"),
            (r#"(rule "r" (condition "A.NetClass == 'ISO'") (constraint clearance))"#, "clearance", "no bound"),
            (r#"(rule "r" (condition "A.NetClass == 'ISO' && A.intersectsArea('K')") (constraint clearance (min 1mm)))"#, "clearance", "selector"),
            (r#"(rule "r" (condition "A.NetClass == 'ISO' && B.Type == 'Pad'") (constraint clearance (min 1mm)))"#, "clearance", "selector"),
            (r#"(rule "r" (condition "A.NetClass == 'ISO' || A.intersectsArea('K')") (constraint track_width (opt 1mm)))"#, "track_width", "selector"),
            (r#"(rule "r" (condition "A.intersectsArea('K')") (constraint via_diameter (min 1mm)))"#, "via_diameter", "selector"),
            (r#"(rule "r" (condition "A.NetClass == 'ISO'") (constraint disallow sphere))"#, "disallow", "sphere"),
            (r#"(rule "r" (surprise 1) (constraint clearance (min 1mm)))"#, "rule_fields", "surprise"),
            (r#"(rule "r" (layer "F.Cu") (layer "B.Cu") (constraint clearance (min 1mm)))"#, "rule_fields", "layer"),
            (r#"(thing "r" (constraint clearance (min 1mm)))"#, "rule_fields", "thing"),
        ] {
            let all = rows(rule);
            let row = all.iter().find(|row| row.state == RuleState::Unknown).unwrap_or_else(|| panic!("admitted: {rule}"));
            assert_eq!((row.rule.as_str(), row.constraint.as_str()), ("r", name), "{rule}");
            assert!(row.why.contains(why), "{rule}: {}", row.why);
        }
    }

    #[test]
    fn a_pad_naming_a_disabled_copper_layer_is_refused() {
        let layers = |line: &str, uuid: &str| {
            let text = format!("(kicad_pcb (footprint \"x\" (pad \"1\" thru_hole circle (layers {line}) (uuid \"{uuid}\"))))");
            let authored = authored_layers(&text).unwrap();
            layer_fault(authored.get("a"), true, &["F.Cu".to_string(), "B.Cu".to_string()])
        };
        assert_eq!(layers(r#""*.Cu" "*.Mask""#, "a"), None);
        assert_eq!(layers(r#""F.Cu" "B.Cu" "F.Mask""#, "a"), None);
        for line in [r#""F.Cu" "B.Cu" "In3.Cu""#, r#""*.Cu" "In3.Cu""#, r#""F&B.Cu""#] {
            assert!(layers(line, "a").unwrap().contains("does not enable"), "{line}");
        }
        assert_eq!(layers(r#""*.Cu""#, "other").as_deref(), Some("a drilled pad has no layers in the board file"));
        assert_eq!(layer_fault(None, false, &[]), None);
    }
}
