//! What the verdict rests on: KiCad's DRC with parity on a saved board, and the copper of that board. The router's own counts are
//! never the verdict.
use super::record::DrcCounts;
use crate::kicad::sexpr::{Node, parse};
use crate::kicad::{geom, kicad_cli};
use crate::model::text::round_to;
use serde::Deserialize;
use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::path::Path;
use std::process::Command;

#[derive(Debug, Default, Deserialize)]
pub struct DrcReport {
    #[serde(default)]
    pub violations: Vec<Violation>,
    #[serde(default)]
    pub unconnected_items: Vec<Violation>,
    #[serde(default)]
    pub schematic_parity: Vec<serde_json::Value>,
}

#[derive(Debug, Default, Deserialize)]
pub struct Violation {
    #[serde(rename = "type", default)]
    pub kind: Option<String>,
    #[serde(default)]
    pub severity: Option<String>,
    #[serde(default)]
    pub items: Vec<DrcItem>,
}

#[derive(Debug, Default, Deserialize)]
pub struct DrcItem {
    #[serde(default)]
    pub description: String,
}

impl Violation {
    fn is_error(&self) -> bool {
        self.severity.as_deref() == Some("error")
    }
}

pub fn drc_counts(report: &DrcReport) -> DrcCounts {
    let errors: Vec<&Violation> = report.violations.iter().filter(|v| v.is_error()).collect();
    let mut by_type = BTreeMap::new();
    for v in &errors {
        *by_type.entry(v.kind.clone().unwrap_or_else(|| "?".to_string())).or_insert(0) += 1;
    }
    DrcCounts { errors: errors.len(), unconnected: report.unconnected_items.len(), parity: report.schematic_parity.len(), by_type }
}

pub fn read_report(path: &Path) -> Result<DrcReport, String> {
    let text = fs::read_to_string(path).map_err(|e| format!("{}: {e}", path.display()))?;
    serde_json::from_str(&text).map_err(|e| format!("{}: {e}", path.display()))
}

/// KiCad DRC on the saved fill: no --refill-zones, so a stale fill shows here.
pub fn run_drc(pcb: &Path, out_json: &Path) -> Result<DrcCounts, String> {
    let cli = kicad_cli();
    let output = Command::new(&cli).args(["pcb", "drc", "--schematic-parity", "--severity-all", "--format", "json", "--units", "mm", "--output"]).arg(out_json).arg(pcb).output().map_err(|e| format!("{cli}: {e}"))?;
    if !out_json.is_file() {
        let text = String::from_utf8_lossy(&output.stderr);
        return Err(format!("kicad-cli drc wrote no report (exit {:?}): {}", output.status.code(), text.trim().chars().take(300).collect::<String>()));
    }
    Ok(drc_counts(&read_report(out_json)?))
}

/// The text between each pair of square brackets.
fn bracketed(text: &str) -> impl Iterator<Item = &str> {
    text.split('[').skip(1).filter_map(|part| part.split_once(']').map(|(name, _)| name)).filter(|name| !name.is_empty())
}

/// Nets named in the error violations and unconnected items: the `[NET]` of their text.
pub fn drc_nets(report: &DrcReport) -> BTreeSet<String> {
    let items = report.violations.iter().filter(|v| v.is_error()).chain(&report.unconnected_items);
    items.flat_map(|v| &v.items).flat_map(|i| bracketed(&i.description)).map(str::to_string).collect()
}

#[derive(Debug, PartialEq)]
pub struct CopperCounts {
    pub tracks: usize,
    pub vias: usize,
    /// Straight tracks only, as PCB_TRACK.
    pub length_mm: f64,
}

fn end_point(track: &Node, head: &str) -> Result<(f64, f64), String> {
    let at = track.child(head).ok_or_else(|| format!("a segment with no {head}"))?;
    let value = |i: usize| geom::parse_iu(at.text(i).unwrap_or("")).map(|v| v as f64);
    Ok((value(1)?, value(2)?))
}

/// Tracks, vias and track length of a saved board's text.
pub fn copper_counts(text: &str) -> Result<CopperCounts, String> {
    let forms = parse(text)?;
    let root = forms.first().ok_or("an empty board file")?;
    let (mut tracks, mut vias, mut length) = (0, 0, 0.0);
    for item in root.items() {
        if item.is("via") {
            vias += 1;
        } else if item.is("segment") {
            let (a, b) = (end_point(item, "start")?, end_point(item, "end")?);
            tracks += 1;
            length += (b.0 - a.0).hypot(b.1 - a.1) / 1e6;
        }
    }
    Ok(CopperCounts { tracks, vias, length_mm: round_to(length, 1) })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn report(text: &str) -> DrcReport {
        serde_json::from_str(text).unwrap()
    }

    #[test]
    fn drc_counts_are_of_errors_only() {
        let r = report(r#"{"violations": [{"type": "clearance", "severity": "error"}, {"type": "silk_overlap", "severity": "warning"},
            {"type": "starved_thermal", "severity": "error"}, {"type": "clearance", "severity": "error"}],
            "unconnected_items": [{}, {}], "schematic_parity": [{}]}"#);
        let c = drc_counts(&r);
        assert_eq!((c.errors, c.unconnected, c.parity), (3, 2, 1));
        assert_eq!(c.by_type, BTreeMap::from([("clearance".to_string(), 2), ("starved_thermal".to_string(), 1)]));
        assert!(!c.clean());
    }

    #[test]
    fn drc_nets_come_from_errors_and_unconnected_items() {
        let r = report(r#"{"violations": [{"severity": "error", "items": [{"description": "Track [/A] on F.Cu"}, {"description": "Pad 1 [GND] of C1"}]},
            {"severity": "warning", "items": [{"description": "Track [/W] on F.Cu"}]}],
            "unconnected_items": [{"items": [{"description": "Pad 3 [/NAND_WP] of U6 on F.Cu"}, {"description": "Pad 15 [/NAND_WP] of U1"}]}]}"#);
        assert_eq!(drc_nets(&r), BTreeSet::from(["/A".to_string(), "GND".to_string(), "/NAND_WP".to_string()]));
    }

    #[test]
    fn copper_counts_leave_out_arcs_from_tracks() {
        let text = r#"(kicad_pcb (segment (start 0 0) (end 3 4) (width 0.2) (layer "F.Cu"))
            (arc (start 0 0) (mid 1 1) (end 2 0) (width 0.2) (layer "F.Cu"))
            (via (at 1 1) (size 0.6) (drill 0.3) (layers "F.Cu" "B.Cu")))"#;
        assert_eq!(copper_counts(text).unwrap(), CopperCounts { tracks: 1, vias: 1, length_mm: 5.0 });
    }
}
