//! Counts of a kicad-cli DRC report.

use iotplace::drc_count::{Report, count};
use serde_json::{Value, json};
use std::collections::BTreeMap;

fn item(net: &str) -> Value {
    json!({"items": [{"description": format!("Pad 1 [{net}] of R1 on F.Cu")}, {"description": format!("Pad 2 [{net}] of R2")}]})
}

fn report(items: Vec<Value>, violations: Value) -> Report {
    serde_json::from_value(json!({"unconnected_items": items, "violations": violations, "schematic_parity": []})).unwrap()
}

#[test]
fn the_unconnected_total_and_subset() {
    let violations = json!([{"severity": "error", "type": "clearance"}, {"severity": "warning", "type": "silk"}]);
    let r = report(vec![item("/MCU/A"), item("/MCU/A"), item("/MCU/B"), item("C")], violations);
    let c = count(&r, &["/MCU/A".to_string(), "C".to_string()]);
    assert_eq!(c.unconnected, 4);
    assert_eq!(c.subset_unconnected, 3);
    assert_eq!(c.errors, 1);
    let nets = [("/MCU/A", 2), ("/MCU/B", 1), ("C", 1)].map(|(n, k)| (n.to_string(), k));
    assert_eq!(c.open_nets, BTreeMap::from(nets));
}

#[test]
fn a_list_at_the_kicad_cap_of_499_is_flagged_capped() {
    // kicad-cli DRC JSON lists at most 499 unconnected items (MC-MAIN, 2026-09-28): the count is a lower bound
    assert!(count(&report(vec![item("A"); 499], json!([])), &[]).capped);
    assert!(!count(&report(vec![item("A"); 498], json!([])), &[]).capped);
}

#[test]
fn the_count_line_says_capped() {
    assert_eq!(count(&report(vec![item("A"); 499], json!([])), &[]).line(), "UNROUTED 499 SUBSET 0 ERRORS 0 CAPPED");
}
