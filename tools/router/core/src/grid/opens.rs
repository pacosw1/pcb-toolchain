//! The open connections of a KiCad DRC report, and the grid items at their ends.
use super::board::GridBoard;
use crate::kicad::save::kicad_cli;
use serde_json::Value;
use std::collections::HashMap;
use std::fs;
use std::path::Path;
use std::process::{Command, Stdio};

/// One end of an open connection, as the report gives it.
#[derive(Debug, Clone, PartialEq)]
pub struct End {
    pub description: String,
    pub pos: Value,
    pub uuid: String,
}

impl End {
    fn read(v: &Value) -> End {
        End { description: v["description"].as_str().unwrap_or("").to_string(), pos: v["pos"].clone(), uuid: v["uuid"].as_str().unwrap_or("").to_string() }
    }

    pub fn x(&self) -> f64 {
        self.pos["x"].as_f64().unwrap_or(0.0)
    }

    pub fn y(&self) -> f64 {
        self.pos["y"].as_f64().unwrap_or(0.0)
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct Open {
    pub net: String,
    pub a: End,
    pub b: End,
}

/// The first `[net]` of an item's text. Any `[` up to the first `]` belongs to the name.
pub fn bracket_net(description: &str) -> Option<&str> {
    let open = description.find('[')?;
    let close = description[open + 1..].find(']')?;
    Some(&description[open + 1..open + 1 + close])
}

/// `Pad NUM [NET] of REF`, with its other spellings: number, net and reference.
pub fn pad_of(description: &str) -> Option<(&str, &str, &str)> {
    let rest = ["Pad ", "PTH pad ", "SMD pad "].iter().find_map(|p| description.strip_prefix(p))?;
    let (number, rest) = rest.split_once(" [")?;
    let (net, rest) = rest.split_once(']')?;
    let reference = rest.strip_prefix(" of ")?.split_whitespace().next()?;
    (!number.contains(char::is_whitespace)).then_some((number, net, reference))
}

/// The open connections with two ends, in report order. Each stands with the net of its first end, "" when it names none.
pub fn all_opens(report: &Value) -> Vec<Open> {
    let items = report["unconnected_items"].as_array().map_or(&[][..], |a| a);
    items.iter().filter_map(|u| {
        let ends = u["items"].as_array()?;
        let (a, b) = (End::read(ends.first()?), End::read(ends.get(1)?));
        Some(Open { net: bracket_net(&a.description).unwrap_or("").to_string(), a, b })
    }).collect()
}

/// The connections the finishers route: exactly two ends, a named net, no zone at either end, not a skipped net.
pub fn signal_opens(report: &Value, skip: &[&str]) -> Vec<Open> {
    let items = report["unconnected_items"].as_array().map_or(&[][..], |a| a);
    items.iter().filter_map(|u| {
        let ends = u["items"].as_array().filter(|e| e.len() == 2)?;
        let (a, b) = (End::read(&ends[0]), End::read(&ends[1]));
        let net = bracket_net(&a.description)?.to_string();
        let zone = a.description.contains("Zone") || b.description.contains("Zone");
        (!zone && !skip.contains(&net.as_str())).then_some(Open { net, a, b })
    }).collect()
}

/// `kicad-cli pcb drc` on a board as it is, no refill. The report lands at `report` and is read back.
pub fn run_drc(board: &Path, report: &Path) -> Result<Value, String> {
    let cli = kicad_cli();
    let status = Command::new(&cli).args(["pcb", "drc", "--format", "json", "--units", "mm", "-o"]).arg(report).arg(board).stdout(Stdio::null()).stderr(Stdio::null()).status().map_err(|e| format!("{cli}: {e}"))?;
    let text = fs::read(report).map_err(|e| format!("{cli} wrote no report ({status}): {e}"))?;
    serde_json::from_slice(&text).map_err(|e| format!("{}: {e}", report.display()))
}

/// Pads by uuid. When a uuid repeats the last pad holds it.
pub fn pads_by_uuid(grid: &GridBoard) -> HashMap<String, usize> {
    grid.net_pads.iter().flat_map(|(_, pads)| pads).map(|at| (grid.pad(at).1.id.clone(), at.item)).collect()
}

/// The item at an end: by uuid, then by the pad its text names, then the first item of the net whose box holds the position,
/// else the nearest of the net.
pub fn item_for(grid: &GridBoard, end: &End, by_uuid: &HashMap<String, usize>) -> Option<usize> {
    if let Some(item) = by_uuid.get(&end.uuid) {
        return Some(*item);
    }
    if let Some((number, net, reference)) = pad_of(&end.description) {
        let named = grid.pads_of(net).iter().find(|at| {
            let (footprint, pad) = grid.pad(at);
            footprint.reference == reference && pad.number == number
        });
        if let Some(at) = named {
            return Some(at.item);
        }
    }
    let net = bracket_net(&end.description).unwrap_or("");
    let (px, py) = (end.x(), end.y());
    let mut best: Option<(f64, usize)> = None;
    for (k, item) in grid.items.iter().enumerate().filter(|(_, it)| it.net == net) {
        let [x1, y1, x2, y2] = item.bbox;
        let (cx, cy) = ((x1 + x2) / 2.0, (y1 + y2) / 2.0);
        let inside = x1 - 0.01 <= px && px <= x2 + 0.01 && y1 - 0.01 <= py && py <= y2 + 0.01;
        let d = if inside { -1.0 } else { (cx - px).powi(2) + (cy - py).powi(2) };
        if best.is_none_or(|(old, _)| d < old) {
            best = Some((d, k));
        }
    }
    best.map(|(_, k)| k)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn the_net_is_the_first_bracket() {
        assert_eq!(bracket_net("Pad 2 [GND] of C1"), Some("GND"));
        assert_eq!(bracket_net("Track [/A[3]] on F.Cu"), Some("/A[3"));
        assert_eq!(bracket_net("Via"), None);
        assert_eq!(bracket_net("broken [x"), None);
    }

    #[test]
    fn pad_text_has_three_spellings() {
        assert_eq!(pad_of("Pad 2 [GND] of C1 on F.Cu"), Some(("2", "GND", "C1")));
        assert_eq!(pad_of("PTH pad A1 [/X] of J1"), Some(("A1", "/X", "J1")));
        assert_eq!(pad_of("SMD pad 3 [] of U1"), Some(("3", "", "U1")));
        assert_eq!(pad_of("Via [GND]"), None);
    }

    #[test]
    fn signal_opens_leave_zones_skips_and_loose_ends_out() {
        let end = |d: &str| json!({"description": d, "pos": {"x": 1.0, "y": 2.0}, "uuid": "u"});
        let report = json!({"unconnected_items": [
            {"items": [end("Pad 1 [A] of U1"), end("Pad 2 [A] of U2")]},
            {"items": [end("Pad 1 [GND] of U1"), end("Pad 2 [GND] of U2")]},
            {"items": [end("Pad 1 [B] of U1"), end("Zone [B] on F.Cu")]},
            {"items": [end("Pad 1 [C] of U1")]},
        ]});
        let opens = signal_opens(&report, &["GND"]);
        assert_eq!(opens.iter().map(|o| o.net.as_str()).collect::<Vec<_>>(), ["A"]);
        assert_eq!(all_opens(&report).len(), 3);
    }
}
