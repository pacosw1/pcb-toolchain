//! Two guards of a route, for `iotroute run` and `iotroute route` alike. The preflight refuses a board whose existing copper is
//! already at fault, before routing is spent. The copper guard refuses a result that lost a track or via of its input.
use crate::kicad::geom::parse_iu;
use crate::kicad::kicad_cli;
use crate::kicad::raw::{self, Form};
use serde_json::Value;
use std::collections::BTreeSet;
use std::fs;
use std::path::Path;
use std::process::Command;

/// The DRC findings that are faults of copper already on the board. Opens are what a route is for. So is starved_thermal, which the
/// Fastroute preflight checked after its thermal repair: unrouted NET-CORE has 2, the core's forced fan-outs answer them, and the
/// final DRC still fails any that stays.
const PREFLIGHT_TYPES: [&str; 3] = ["shorting_items", "clearance", "copper_edge_clearance"];

fn blocks_routing(finding: &Value) -> bool {
    finding["severity"] == "error" && finding["excluded"] != true && PREFLIGHT_TYPES.iter().any(|kind| finding["type"] == *kind)
}

/// The blocking findings of a DRC report; a report that is not one is an error, not a clean board.
fn blocking(report: &Value) -> Result<usize, String> {
    let findings = report["violations"].as_array().filter(|_| report["unconnected_items"].is_array()).ok_or("preflight: malformed DRC report")?;
    Ok(findings.iter().filter(|finding| blocks_routing(finding)).count())
}

/// KiCad DRC of the board to route, with fresh fills, in `report`. Err when its existing copper is at fault.
pub fn preflight(pcb: &Path, report: &Path) -> Result<(), String> {
    let cli = kicad_cli();
    let output = Command::new(&cli).args(["pcb", "drc", "--refill-zones", "--severity-all", "--format", "json", "--units", "mm", "--output"]).arg(report).arg(pcb).output().map_err(|e| format!("{cli}: {e}"))?;
    if !report.is_file() {
        return Err(format!("preflight: kicad-cli drc wrote no report (exit {:?}): {}", output.status.code(), String::from_utf8_lossy(&output.stderr).trim().chars().take(300).collect::<String>()));
    }
    let text = fs::read_to_string(report).map_err(|e| format!("{}: {e}", report.display()))?;
    let faults = blocking(&serde_json::from_str(&text).map_err(|e| format!("{}: {e}", report.display()))?)?;
    if faults != 0 {
        return Err(format!("preflight blocked: {faults} existing-copper faults; see {}", report.display()));
    }
    Ok(())
}

type Nm = (i64, i64);
/// What makes an item the same item in two boards: head, net, layer, start, end. Its uuid and width may change, its place may not.
type Key = (String, String, String, Nm, Nm);

fn point(form: &Form, head: &str) -> Result<Nm, String> {
    let point = form.children(head).next().ok_or_else(|| format!("a copper item has no {head}"))?;
    let number = |index| parse_iu(point.text(index).unwrap_or_default());
    Ok((number(1)?, number(2)?))
}

fn name(form: &Form, head: &str) -> String {
    form.children(head).next().and_then(|child| child.text(1)).unwrap_or_default().to_string()
}

fn copper(board: &str) -> Result<BTreeSet<Key>, String> {
    let root = raw::parse_first(board).map_err(|error| format!("board text: {error}"))?;
    let mut keys = BTreeSet::new();
    for form in root.items() {
        let key = match form.head() {
            Some(kind @ ("segment" | "arc")) => (kind.to_string(), name(form, "net"), name(form, "layer"), point(form, "start")?, point(form, "end")?),
            Some("via") => {
                let at = point(form, "at")?;
                ("via".to_string(), name(form, "net"), name(form, "layers"), at, at)
            }
            _ => continue,
        };
        keys.insert(key);
    }
    Ok(keys)
}

/// Err when a track, arc or via of `source` is not in `result`.
pub fn keeps_copper(source: &str, result: &str) -> Result<(), String> {
    let have = copper(result)?;
    let lost: Vec<Key> = copper(source)?.into_iter().filter(|key| !have.contains(key)).collect();
    match lost.first() {
        None => Ok(()),
        Some(first) => Err(format!("SOURCE COPPER LOST: {} input tracks/vias are missing (first {} of {} on {}); the result is not used", lost.len(), first.0, first.1, first.2)),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    const BOARD: &str = "(kicad_pcb\n\t(segment\n\t\t(start 1 2)\n\t\t(end 3.5 2)\n\t\t(width 0.25)\n\t\t(layer \"F.Cu\")\n\t\t(net \"/A\")\n\t\t(uuid \"t\")\n\t)\n\t(via\n\t\t(at 3.5 2)\n\t\t(size 0.6)\n\t\t(drill 0.3)\n\t\t(layers \"F.Cu\" \"B.Cu\")\n\t\t(net \"/A\")\n\t\t(uuid \"v\")\n\t)\n)\n";

    #[test]
    fn a_result_without_its_source_copper_is_refused() {
        let renamed = BOARD.replace("(uuid \"t\")", "(uuid \"other\")").replace("(width 0.25)", "(width 0.15)");
        assert_eq!(keeps_copper(BOARD, &renamed), Ok(()));
        let moved = BOARD.replace("(at 3.5 2)", "(at 3.6 2)");
        let error = keeps_copper(BOARD, &moved).unwrap_err();
        assert!(error.contains("SOURCE COPPER LOST: 1 input") && error.contains("via of /A"), "{error}");
    }

    #[test]
    fn only_a_fault_of_existing_copper_blocks_the_route() {
        let report = |finding: Value| json!({"violations": [finding], "unconnected_items": [{"type": "unconnected_items"}]});
        assert_eq!(blocking(&report(json!({"type": "shorting_items", "severity": "error"}))), Ok(1));
        assert_eq!(blocking(&report(json!({"type": "clearance", "severity": "error", "excluded": true}))), Ok(0));
        assert_eq!(blocking(&report(json!({"type": "silk_overlap", "severity": "error"}))), Ok(0));
        assert!(blocking(&json!({"violations": []})).is_err());
    }
}
