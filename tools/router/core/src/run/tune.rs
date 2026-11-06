//! `iotroute run --tune` (opt-in, policy `"tune": true`): the length and skew targets of the board's .kicad_dru for the core's
//! post-route tuning stage (core `tune.rs`, DESIGN.md 5f). Written to OUT.iotroute/tune.json and given to the core as `--tune`.
//!
//! KiCad's matched-length DRC takes, per net and constraint kind, the last rule of the file whose condition holds (rules are
//! evaluated from the end, the first match wins). A `skew` constraint compares the nets of one rule with each other (KiCad 10:
//! |length - longest length of the rule| <= max); with `within_diff_pairs` only the two nets of each pair. A `length` constraint
//! holds per net. A condition the selector cannot decide for a net leaves that net out, named in `unknown`.
use crate::model::dru::{Rule, number};
use crate::model::selector::{Item, Scope};
use serde::Serialize;
use serde_json::Value;
use std::collections::BTreeMap;

pub const SCHEMA: &str = "iot-lab.route-tune.v0";

#[derive(Debug, Serialize, PartialEq)]
pub struct SkewGroup {
    pub rule: String,
    pub nets: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub min: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub max: Option<f64>,
}

#[derive(Debug, Serialize, PartialEq)]
pub struct LengthTarget {
    pub rule: String,
    pub net: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub min: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub max: Option<f64>,
}

#[derive(Debug, Serialize, PartialEq)]
pub struct Targets {
    pub schema: &'static str,
    pub skew: Vec<SkewGroup>,
    pub length: Vec<LengthTarget>,
    /// rule: nets whose condition could not be decided
    pub unknown: BTreeMap<String, Vec<String>>,
}

impl Targets {
    pub fn is_empty(&self) -> bool {
        self.skew.is_empty() && self.length.is_empty()
    }
}

/// The targets file of a run: beside its model, in the run's work folder (every attempt and reference round reads the same one).
pub fn path_beside(model: &std::path::Path) -> std::path::PathBuf {
    model.with_file_name("tune.json")
}

/// The diff pair base of a net name (KiCad: a trailing `_P` / `_N`, `+` / `-`, `P` / `N`), or None.
pub fn pair_base(net: &str) -> Option<&str> {
    ["_P", "_N", "+", "-", "P", "N"].iter().find_map(|s| net.strip_suffix(s)).filter(|b| !b.is_empty())
}

fn values(con: &crate::model::dru::Constraint) -> Result<(Option<f64>, Option<f64>), String> {
    let get = |k: &str| con.values.get(k).map(|v| number(v)).transpose();
    Ok((get("min")?, get("max")?))
}

/// The targets of `rules` for the nets of a route model (`nets`: name -> class).
pub fn targets(rules: &[Rule], nets: &BTreeMap<String, String>) -> Result<Targets, String> {
    let mut out = Targets { schema: SCHEMA, skew: Vec::new(), length: Vec::new(), unknown: BTreeMap::new() };
    for kind in ["skew", "length"] {
        // per net: the index of the last rule of this kind whose condition holds
        let mut owner: BTreeMap<&str, usize> = BTreeMap::new();
        for (i, rule) in rules.iter().enumerate() {
            if !rule.constraints.iter().any(|c| c.kind == kind) {
                continue;
            }
            for (net, class) in nets {
                let item = Item::plain(net, class, "Track");
                match rule.condition.eval(Scope { a: &item, b: &Item::default(), pair: false }) {
                    Some(true) => {
                        owner.insert(net, i);
                    }
                    Some(false) => {}
                    None => out.unknown.entry(rule.name.clone()).or_default().push(net.clone()),
                }
            }
        }
        for (i, rule) in rules.iter().enumerate() {
            let hits: Vec<&str> = owner.iter().filter(|(_, r)| **r == i).map(|(n, _)| *n).collect();
            if hits.is_empty() {
                continue;
            }
            for con in rule.constraints.iter().filter(|c| c.kind == kind) {
                let (min, max) = values(con)?;
                if kind == "length" {
                    out.length.extend(hits.iter().map(|n| LengthTarget { rule: rule.name.clone(), net: n.to_string(), min, max }));
                    continue;
                }
                if con.flags.iter().chain(&con.items).any(|w| w == "within_diff_pairs") {
                    let mut by_pair: BTreeMap<&str, Vec<String>> = BTreeMap::new();
                    for n in &hits {
                        if let Some(base) = pair_base(n) {
                            by_pair.entry(base).or_default().push(n.to_string());
                        }
                    }
                    out.skew.extend(by_pair.into_values().filter(|v| v.len() > 1).map(|nets| SkewGroup { rule: rule.name.clone(), nets, min, max }));
                } else if hits.len() > 1 {
                    out.skew.push(SkewGroup { rule: rule.name.clone(), nets: hits.iter().map(|n| n.to_string()).collect(), min, max });
                }
            }
        }
    }
    Ok(out)
}

fn number_after<'a>(text: &'a str, key: &str) -> Option<(f64, &'a str)> {
    let rest = &text[text.find(key)? + key.len()..];
    let end = rest.find(|c: char| !(c.is_ascii_digit() || c == '.' || c == '-')).unwrap_or(rest.len());
    Some((rest[..end].parse().ok()?, &rest[end..]))
}

/// KiCad's own net lengths, read from the `skew_out_of_range` and `length_out_of_range` violations of a DRC report (kicad-cli json):
/// net -> mm. A skew violation names the violating net (its item) with its length and the longest net of the rule with its length.
pub fn kicad_lengths(report: &Value) -> BTreeMap<String, f64> {
    let mut out = BTreeMap::new();
    for v in report["violations"].as_array().into_iter().flatten() {
        let kind = v["type"].as_str().unwrap_or("");
        if kind != "skew_out_of_range" && kind != "length_out_of_range" {
            continue;
        }
        let text = v["description"].as_str().unwrap_or("");
        let net = v["items"].as_array().into_iter().flatten().filter_map(|i| i["description"].as_str())
            .find_map(|d| d.split_once('[').and_then(|(_, r)| r.split_once(']')).map(|(n, _)| n.to_string()));
        if kind == "skew_out_of_range" {
            if let Some((target, rest)) = number_after(text, "target net length ")
                && let Some(from) = rest.split_once("(from ").and_then(|(_, r)| r.split_once(')')).map(|(n, _)| n.to_string())
            {
                out.insert(from, target);
            }
        }
        if let (Some(net), Some(pos)) = (net, text.rfind("actual ")) {
            if let Some((len, _)) = number_after(&text[pos..], "actual ") {
                out.insert(net, len);
            }
        }
    }
    out
}

/// The nets of a route model with their class.
pub fn model_nets(model: &Value) -> BTreeMap<String, String> {
    model["nets"].as_object().map(|o| o.iter().map(|(n, v)| (n.clone(), v["class"].as_str().unwrap_or("Default").to_string())).collect()).unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::dru::parse_rules;

    fn nets(names: &[&str]) -> BTreeMap<String, String> {
        names.iter().map(|n| (n.to_string(), "Default".to_string())).collect()
    }

    #[test]
    fn a_skew_rule_groups_its_nets_and_within_diff_pairs_groups_per_pair() {
        let rules = parse_rules(r#"(version 1)
(rule "bus" (condition "A.NetName == '/D0' || A.NetName == '/D1' || A.NetName == '/D2'") (constraint skew (max 2mm)))
(rule "pairs" (condition "A.inDiffPair('/U0') || A.inDiffPair('/U1')") (constraint skew (max 1.27mm) (within_diff_pairs)))"#).unwrap();
        let t = targets(&rules, &nets(&["/D0", "/D1", "/D2", "/U0_P", "/U0_N", "/U1_P", "/U1_N", "/X"])).unwrap();
        assert_eq!(t.skew.len(), 3, "{t:?}");
        assert_eq!(t.skew[0], SkewGroup { rule: "bus".into(), nets: vec!["/D0".into(), "/D1".into(), "/D2".into()], min: None, max: Some(2.0) });
        assert_eq!(t.skew[1].nets, ["/U0_N", "/U0_P"]);
        assert_eq!(t.skew[2].max, Some(1.27));
        assert!(t.length.is_empty() && t.unknown.is_empty());
    }

    #[test]
    fn the_last_matching_rule_owns_a_net_and_lengths_hold_per_net() {
        let rules = parse_rules(r#"(version 1)
(rule "all" (condition "A.NetClass == 'Default'") (constraint length (max 60mm)))
(rule "clk" (condition "A.NetName == '/CLK'") (constraint length (min 20mm) (max 30mm)))"#).unwrap();
        let t = targets(&rules, &nets(&["/CLK", "/A"])).unwrap();
        assert_eq!(t.length, vec![
            LengthTarget { rule: "all".into(), net: "/A".into(), min: None, max: Some(60.0) },
            LengthTarget { rule: "clk".into(), net: "/CLK".into(), min: Some(20.0), max: Some(30.0) },
        ]);
    }

    #[test]
    fn kicad_lengths_come_from_the_skew_and_length_violations() {
        let report = serde_json::json!({"violations": [
            {"type": "skew_out_of_range", "description": "Skew between tracks out of range (rule 'FIXTURE I2C skew' max skew 2.0000 mm; actual -2.3301 mm; target net length 67.7401 mm (from /SCL); actual 65.4100 mm)",
             "items": [{"description": "Track [/SDA] on B.Cu, length 0.4500 mm"}]},
            {"type": "length_out_of_range", "description": "Length out of range (rule 'clk' min length 20.0000 mm; actual 12.5000 mm)", "items": [{"description": "Track [/CLK] on F.Cu, length 3.0 mm"}]},
            {"type": "clearance", "description": "Clearance violation (actual 0.1 mm)", "items": [{"description": "Track [/X] on F.Cu"}]}]});
        let l = kicad_lengths(&report);
        assert_eq!(l, BTreeMap::from([("/SCL".to_string(), 67.7401), ("/SDA".to_string(), 65.41), ("/CLK".to_string(), 12.5)]));
    }

    #[test]
    fn an_undecidable_condition_is_named_not_guessed() {
        let rules = parse_rules(r#"(version 1)
(rule "area" (condition "A.intersectsArea('X')") (constraint skew (max 2mm)))"#).unwrap();
        let t = targets(&rules, &nets(&["/A", "/B"])).unwrap();
        assert!(t.is_empty());
        assert_eq!(t.unknown["area"], ["/A", "/B"]);
    }
}
