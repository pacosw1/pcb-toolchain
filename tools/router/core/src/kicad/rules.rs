//! The design rules of a board as KiCad applies them to one item: the board minimums, the effective class of each net and the
//! custom clearance rules, with BOARD_CONNECTED_ITEM::GetOwnClearance on top. `kicad::api::read_rules` fills it.
use super::board::{Board, Footprint};
use super::geom::Iu;
use super::pad::Pad;
use crate::model::dru::{Rule, parse_rules};
use crate::model::isolation::pad_type;
use crate::model::selector::{Item, Selector};
use std::collections::BTreeMap;
use std::fs;
use std::path::Path;

/// The board setup minimums, BOARD_DESIGN_SETTINGS's m_* of the same names.
#[derive(Debug, Clone, Copy, PartialEq, Default)]
pub struct Minimums {
    pub clearance: Iu,
    pub track_width: Iu,
    pub via_size: Iu,
    pub copper_edge_clearance: Iu,
    pub hole_clearance: Iu,
    pub hole_to_hole: Iu,
}

/// What a net class sets; None when it leaves the value to its parent.
#[derive(Debug, Clone, Copy, PartialEq, Default)]
pub struct ClassValues {
    pub clearance: Option<Iu>,
    pub via_diameter: Option<Iu>,
}

/// A custom `clearance` constraint with a minimum.
#[derive(Debug, Clone, PartialEq)]
pub struct ClearanceRule {
    pub name: String,
    pub condition: Selector,
    pub layer: Option<String>,
    pub min: Iu,
}

#[derive(Debug, Clone, PartialEq, Default)]
pub struct DesignRules {
    pub minimums: Minimums,
    /// The effective class of each net; "" is the class of items with no net.
    pub classes: BTreeMap<String, ClassValues>,
    /// In file order: the last rule that matches wins.
    pub clearance_rules: Vec<ClearanceRule>,
}

/// The custom clearance rules of the .kicad_dru beside a board. No file is no rule.
pub fn clearance_rules_of(board: &Path) -> Result<Vec<ClearanceRule>, String> {
    let path = board.with_extension("kicad_dru");
    let Ok(text) = fs::read_to_string(&path) else { return Ok(Vec::new()) };
    let rules = parse_rules(&text).map_err(|e| format!("{}: {e}", path.display()))?;
    rules.iter().flat_map(clearance_of).collect()
}

fn clearance_of(rule: &Rule) -> Vec<Result<ClearanceRule, String>> {
    let mins = rule.constraints.iter().filter(|c| c.kind == "clearance").filter_map(|c| c.value("min"));
    mins.map(|min| {
        Ok(ClearanceRule { name: rule.name.clone(), condition: rule.condition.clone(), layer: rule.layer.clone(), min: super::geom::from_mm(min?) })
    }).collect()
}

/// A rule's `(layer ...)` against a copper layer.
fn on_layer(rule: &ClearanceRule, layer: &str) -> bool {
    match rule.layer.as_deref() {
        None => true,
        Some("outer") => matches!(layer, "F.Cu" | "B.Cu"),
        Some("inner") => layer.starts_with("In"),
        Some(name) => crate::model::text::glob_match(layer, name),
    }
}

impl DesignRules {
    fn class(&self, net: &str) -> ClassValues {
        self.classes.get(net).copied().unwrap_or_default()
    }

    /// The via diameter of a net's class, the board minimum when the class has none.
    pub fn via_diameter(&self, net: &str) -> Iu {
        self.class(net).via_diameter.unwrap_or(self.minimums.via_size)
    }

    /// DRC_ENGINE::EvalRules with no second item: the item's own override, else the last custom rule that holds, else its class.
    /// A rule that cannot be decided stops the caller: a guess here is a short or a false block.
    fn clearance(&self, item: &Item, override_value: Option<Iu>, layer: &str) -> Result<Iu, String> {
        if let Some(value) = override_value.filter(|v| *v != 0) {
            return Ok(value.max(self.minimums.clearance));
        }
        for rule in self.clearance_rules.iter().rev().filter(|r| on_layer(r, layer)) {
            match rule.condition.eval_alone(item) {
                Some(true) => return Ok(rule.min),
                Some(false) => {}
                None => return Err(format!("clearance rule {}: cannot decide {}", rule.name, rule.condition.text)),
            }
        }
        Ok(self.class(item.net_name.as_deref().unwrap_or("")).clearance.unwrap_or(self.minimums.clearance))
    }

    /// GetOwnClearance of a pad: its override, then its footprint's.
    pub fn pad_clearance(&self, board: &Board, footprint: &Footprint, pad: &Pad, layer: &str) -> Result<Iu, String> {
        let item = Item {
            pad_type: Some(pad_type(pad.kind).to_string()),
            reference: Some(footprint.reference.clone()),
            pad_number: Some(pad.number.clone()),
            ..Item::plain(&pad.net, board.net_class(&pad.net), "Pad")
        };
        self.clearance(&item, pad.clearance_override.or(footprint.clearance_override), layer)
    }

    /// GetOwnClearance of a track or an arc.
    pub fn track_clearance(&self, board: &Board, net: &str, layer: &str) -> Result<Iu, String> {
        self.clearance(&Item::plain(net, board.net_class(net), "Track"), None, layer)
    }

    /// GetOwnClearance of a via.
    pub fn via_clearance(&self, board: &Board, net: &str, layer: &str) -> Result<Iu, String> {
        self.clearance(&Item::plain(net, board.net_class(net), "Via"), None, layer)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rule(condition: &str, min: Iu, layer: Option<&str>) -> ClearanceRule {
        ClearanceRule { name: "r".to_string(), condition: Selector::new(condition), layer: layer.map(str::to_string), min }
    }

    fn rules(custom: Vec<ClearanceRule>) -> DesignRules {
        let classes = [("A".to_string(), ClassValues { clearance: Some(200), via_diameter: Some(600) })].into_iter().collect();
        DesignRules { minimums: Minimums { clearance: 100, via_size: 450, ..Minimums::default() }, classes, clearance_rules: custom }
    }

    fn board() -> Board {
        Board { path: String::new(), copper_layers: Vec::new(), stackup: Vec::new(), nets: [("A".to_string(), "HV".to_string())].into_iter().collect(), footprints: Vec::new(), copper: Vec::new(), zones: Vec::new(), graphics: Vec::new(), edges_bbox: crate::kicad::geom::Rect { left: 0, top: 0, right: 0, bottom: 0 }, outlines: Vec::new() }
    }

    #[test]
    fn with_no_rule_the_class_decides() {
        assert_eq!(rules(Vec::new()).track_clearance(&board(), "A", "F.Cu"), Ok(200));
        assert_eq!(rules(Vec::new()).track_clearance(&board(), "unknown", "F.Cu"), Ok(100));
    }

    #[test]
    fn the_last_rule_that_holds_wins_over_the_class() {
        let r = rules(vec![rule("A.NetClass == 'HV'", 500, None), rule("A.Type == 'Track'", 300, None)]);
        assert_eq!(r.track_clearance(&board(), "A", "F.Cu"), Ok(300));
        assert_eq!(r.via_clearance(&board(), "A", "F.Cu"), Ok(500));
    }

    #[test]
    fn a_rule_that_reads_a_second_item_does_not_hold_for_one_item() {
        let r = rules(vec![rule("A.NetClass == 'HV' && B.NetClass != 'HV'", 500, None), rule("A.isCoupledDiffPair()", 700, None)]);
        assert_eq!(r.track_clearance(&board(), "A", "F.Cu"), Ok(200));
    }

    #[test]
    fn a_rule_on_another_layer_is_passed_over() {
        let r = rules(vec![rule("A.NetClass == 'HV'", 500, Some("In1.Cu"))]);
        assert_eq!(r.track_clearance(&board(), "A", "F.Cu"), Ok(200));
        assert_eq!(r.track_clearance(&board(), "A", "In1.Cu"), Ok(500));
    }

    #[test]
    fn a_rule_that_cannot_be_decided_stops() {
        let r = rules(vec![rule("A.intersectsArea('X')", 500, None)]);
        assert!(r.track_clearance(&board(), "A", "F.Cu").unwrap_err().contains("intersectsArea"));
    }

    #[test]
    fn an_override_holds_but_not_under_the_board_minimum() {
        let r = rules(Vec::new());
        assert_eq!(r.clearance(&Item::plain("A", "HV", "Pad"), Some(400), "F.Cu"), Ok(400));
        assert_eq!(r.clearance(&Item::plain("A", "HV", "Pad"), Some(50), "F.Cu"), Ok(100));
        assert_eq!(r.clearance(&Item::plain("A", "HV", "Pad"), Some(0), "F.Cu"), Ok(200));
    }

    #[test]
    fn a_class_with_no_via_falls_back_to_the_board_minimum() {
        assert_eq!(rules(Vec::new()).via_diameter("A"), 600);
        assert_eq!(rules(Vec::new()).via_diameter("unknown"), 450);
    }
}
