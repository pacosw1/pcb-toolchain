//! Counts of a kicad-cli DRC JSON report, for router scoring (tools/placer/fr_job.sh).
//!
//! The net of an unconnected item is the [NET] in its first item description. kicad-cli lists at most CAP unconnected
//! items: a full list makes every open count a lower bound, and the count line ends in CAPPED.

use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet};

const CAP: usize = 499;

#[derive(Deserialize)]
struct Item {
    description: String,
}

#[derive(Deserialize)]
struct Unconnected {
    #[serde(default)]
    items: Vec<Item>,
}

#[derive(Deserialize)]
struct Violation {
    #[serde(default)]
    severity: String,
    #[serde(default, rename = "type")]
    kind: String,
}

#[derive(Deserialize)]
pub struct Report {
    #[serde(default)]
    unconnected_items: Vec<Unconnected>,
    #[serde(default)]
    violations: Vec<Violation>,
    #[serde(default)]
    schematic_parity: Vec<serde_json::Value>,
}

#[derive(Debug, Serialize, PartialEq)]
pub struct Counts {
    pub errors: usize,
    pub parity: usize,
    pub unconnected: usize,
    pub subset_unconnected: usize,
    pub open_nets: BTreeMap<String, usize>,
    pub error_types: BTreeMap<String, usize>,
    pub capped: bool,
}

/// The text between the first [ ] of a description.
fn bracketed(text: &str) -> Option<&str> {
    let (_, rest) = text.split_once('[')?;
    Some(rest.split_once(']')?.0)
}

fn net_of(u: &Unconnected) -> String {
    u.items.first().and_then(|i| bracketed(&i.description)).unwrap_or("?").to_string()
}

pub fn count(report: &Report, subset: &[String]) -> Counts {
    let mut open_nets = BTreeMap::new();
    for u in &report.unconnected_items {
        *open_nets.entry(net_of(u)).or_insert(0) += 1;
    }
    let mut error_types = BTreeMap::new();
    let errors = report.violations.iter().filter(|v| v.severity == "error");
    errors.clone().for_each(|v| *error_types.entry(v.kind.clone()).or_insert(0) += 1);
    let subset: BTreeSet<&String> = subset.iter().collect();
    Counts {
        errors: errors.count(),
        parity: report.schematic_parity.len(),
        unconnected: open_nets.values().sum(),
        subset_unconnected: open_nets.iter().filter(|(k, _)| subset.contains(k)).map(|(_, v)| v).sum(),
        open_nets,
        error_types,
        capped: report.unconnected_items.len() >= CAP,
    }
}

impl Counts {
    /// The line the router job logs and bench.py reads.
    pub fn line(&self) -> String {
        let capped = if self.capped { " CAPPED" } else { "" };
        format!("UNROUTED {} SUBSET {} ERRORS {}{capped}", self.unconnected, self.subset_unconnected, self.errors)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn report(text: &str) -> Report {
        serde_json::from_str(text).unwrap()
    }

    #[test]
    fn counts_by_net_and_type() {
        let r = report(
            r#"{"unconnected_items":[{"items":[{"description":"Pad 1 [N1]"}]},{"items":[{"description":"Pad 2 [N1]"}]},
                {"items":[{"description":"Track [N2] on F.Cu"}]},{"items":[]}],
                "violations":[{"severity":"error","type":"clearance"},{"severity":"warning","type":"silk"}],
                "schematic_parity":[{}]}"#,
        );
        let c = count(&r, &["N1".to_string()]);
        assert_eq!((c.errors, c.parity, c.unconnected, c.subset_unconnected), (1, 1, 4, 2));
        assert_eq!(c.open_nets["?"], 1);
        assert_eq!(c.error_types["clearance"], 1);
        assert_eq!(c.line(), "UNROUTED 4 SUBSET 2 ERRORS 1");
    }

    #[test]
    fn a_full_list_is_a_lower_bound() {
        let item = r#"{"items":[{"description":"[N]"}]}"#;
        let text = format!("{{\"unconnected_items\":[{}]}}", vec![item; CAP].join(","));
        let c = count(&report(&text), &[]);
        assert!(c.capped);
        assert_eq!(c.line(), "UNROUTED 499 SUBSET 0 ERRORS 0 CAPPED");
    }
}
