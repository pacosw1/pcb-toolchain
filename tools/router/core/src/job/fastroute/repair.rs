//! Repairs after routing: plane vias that came too close to routed copper, and the detection of starved plane thermals.
use super::{Job, copper, prepare};
use crate::kicad::board::Board;
use crate::kicad::edit::Edit;
use crate::kicad::geom::to_mm;
use crate::job::stop::Stop;
use regex_lite::Regex;
use serde_json::{Value, json};
use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::path::Path;

/// DRC gives a position to 1e-4 mm or better; a via is the one at the same place to 1 um.
const SAME_PLACE_MM: f64 = 1e-3;

pub type Pads = BTreeMap<String, BTreeSet<String>>;

fn regex(pattern: &str) -> Regex {
    Regex::new(pattern).expect("a fixed pattern")
}

/// The plane-net vias a DRC lists in a clearance error, with their position.
pub fn clearance_hits(drc: &Value, planes: &BTreeSet<String>) -> Vec<(String, f64, f64)> {
    let via = regex(r"^Via \[([^\]]*)\]");
    let mut hits = Vec::new();
    for finding in drc["violations"].as_array().into_iter().flatten().filter(|finding| finding["severity"] == "error" && finding["type"] == "clearance") {
        for item in finding["items"].as_array().into_iter().flatten() {
            let description = item["description"].as_str().unwrap_or_default();
            let Some(net) = via.captures(description).map(|found| found[1].to_string()) else { continue };
            if let (true, Some(x), Some(y)) = (planes.contains(&net), item["pos"]["x"].as_f64(), item["pos"]["y"].as_f64()) {
                hits.push((net, x, y));
            }
        }
    }
    hits
}

/// What to take out for each hit, and the pad to connect again: a via with one stub to a pad of its net. Only copper of this job:
/// a locked item or one of the input board (`preserve`) is never deleted.
pub fn plan_via_repair(hits: &[(String, f64, f64)], items: &[copper::Item], pads: &[(String, String, copper::Nm)], preserve: &BTreeSet<copper::Key>) -> (Pads, BTreeSet<String>) {
    let (mut todo, mut gone) = (Pads::new(), BTreeSet::new());
    for (net, x, y) in hits {
        let at = |via: &&copper::Item| via.is_via() && &via.net == net && (to_mm(via.start.0) - x).abs() < SAME_PLACE_MM && (to_mm(via.start.1) - y).abs() < SAME_PLACE_MM;
        let Some(via) = items.iter().find(at) else { continue };
        if gone.contains(&via.id) {
            continue;
        }
        let stubs: Vec<&copper::Item> = items.iter().filter(|item| item.kind == copper::Kind::Track && &item.net == net && (item.start == via.start || item.end == via.start)).collect();
        let [stub] = stubs[..] else { continue };
        if via.locked || stub.locked || preserve.contains(&via.key()) || preserve.contains(&stub.key()) {
            continue;
        }
        let far = if stub.start == via.start { stub.end } else { stub.start };
        let Some((name, _, _)) = pads.iter().find(|(_, pad_net, position)| pad_net == net && *position == far) else { continue };
        todo.entry(net.clone()).or_default().insert(name.clone());
        gone.extend([via.id.clone(), stub.id.clone()]);
    }
    (todo, gone)
}

fn pad_rows(board: &Board) -> Vec<(String, String, copper::Nm)> {
    board.pads().map(|(footprint, pad)| (format!("{}.{}", footprint.reference, pad.number), pad.net.clone(), (pad.position.x, pad.position.y))).collect()
}

/// A plane via too close to routed copper goes, with its stub; the pad goes to the repair list, so the via is placed again with the
/// routed copper as the obstacle. No track is moved.
pub fn plane_via_clearance(path: &Path, drc: &Value, planes: &BTreeSet<String>, preserve: &BTreeSet<copper::Key>) -> Result<Pads, Stop> {
    let hits = clearance_hits(drc, planes);
    if hits.is_empty() {
        return Ok(Pads::new());
    }
    let (board, _) = prepare::read(path)?;
    let text = fs::read_to_string(path).map_err(|e| Stop::failed(e.to_string()))?;
    let (todo, gone) = plan_via_repair(&hits, &copper::read(&text)?, &pad_rows(&board), preserve);
    if !gone.is_empty() {
        let edit = Edit { removed: gone.into_iter().collect(), ..Default::default() };
        fs::write(path, edit.apply(&text, "plane-via-repair")?).map_err(|e| Stop::failed(e.to_string()))?;
    }
    Ok(todo)
}

/// Pure detector: native UUID, pad, ref, net and owning zone must all agree.
pub fn thermal_targets(drc: &Value, pads: &BTreeMap<String, (String, String, String)>, zones: &BTreeMap<String, String>, planes: &BTreeSet<String>) -> Result<BTreeMap<String, Vec<String>>, String> {
    // kicad-cli wording: "Pad 2 [GND] of U16 on F.Cu" (SMD) or "PTH pad 11 [GND] of U10" (through hole, 10.0.6).
    let wording = regex(r"^(?:Pad|PTH pad) (\S+) \[([^\]]*)\] of (\S+)(?: on (.+))?$");
    let mut todo: BTreeMap<String, BTreeSet<String>> = BTreeMap::new();
    for finding in drc["violations"].as_array().into_iter().flatten().filter(|finding| finding["type"] == "starved_thermal" && finding["severity"] == "error") {
        let items = finding["items"].as_array().filter(|items| items.len() == 2 && items.iter().all(|item| item["uuid"].is_string() && item["description"].is_string())).ok_or("malformed native thermal violation")?;
        let mut found = Vec::new();
        for item in items {
            let Some((reference, number, net)) = pads.get(item["uuid"].as_str().unwrap_or_default()) else { continue };
            let description = item["description"].as_str().unwrap_or_default();
            let same = wording.captures(description).is_some_and(|text| &text[3] == reference && &text[1] == number && &text[2] == net);
            if !same {
                return Err("native thermal pad identity mismatch".into());
            }
            if !items.iter().any(|other| zones.get(other["uuid"].as_str().unwrap_or_default()) == Some(net)) {
                return Err("native thermal zone identity mismatch".into());
            }
            found.push((net.clone(), format!("{reference}.{number}")));
        }
        let [(net, name)] = &found[..] else { return Err("ambiguous native thermal pads".into()) };
        if planes.contains(net) {
            todo.entry(net.clone()).or_default().insert(name.clone());
        }
    }
    Ok(todo.into_iter().map(|(net, names)| (net, names.into_iter().collect())).collect())
}

/// The decision on starved plane thermals. With none, nothing changes. With some, no proposal is made here: the fault stays in the
/// DRC and counts in ERRORS, and the evidence says why.
pub fn thermal(job: &Job, board_path: &Path, _project: &Path, drc: Value, _via_args: &[String], label: &str) -> Result<(Value, Value), Stop> {
    let (board, _) = prepare::read(board_path)?;
    let pads = board.pads().map(|(footprint, pad)| (pad.id.clone(), (footprint.reference.clone(), pad.number.clone(), pad.net.clone()))).collect();
    let zones = board.zones.iter().map(|zone| (zone.id.clone(), zone.net.clone())).collect();
    let targets = thermal_targets(&drc, &pads, &zones, &job.plane_names)?;
    let reason = if targets.is_empty() { "no plane thermal targets" } else { "thermal copper proposals are not made by this job; the faults stay in the DRC" };
    if !targets.is_empty() {
        println!("THERMAL {label}: {} plane nets with starved pads left as faults", targets.len());
    }
    Ok((drc, json!({"targets": targets, "accepted": false, "qualified": false, "reason": reason})))
}

#[cfg(test)]
mod tests {
    use super::*;
    use copper::{Item, Kind};

    fn item(kind: Kind, id: &str, net: &str, start: copper::Nm, end: copper::Nm, locked: bool) -> Item {
        Item { kind, id: id.into(), net: net.into(), layer: "F.Cu".into(), start, end, width: 200_000, drill: 0, locked }
    }

    fn planes() -> BTreeSet<String> {
        BTreeSet::from(["GND".to_string()])
    }

    fn drc_at(x: f64, y: f64) -> Value {
        json!({"violations": [{"severity": "error", "type": "clearance", "items": [{"description": "Via [GND] on F.Cu - B.Cu", "pos": {"x": x, "y": y}}, {"description": "Track [BACKUP_5V] on F.Cu"}]}]})
    }

    #[test]
    fn a_job_via_and_its_stub_go_and_the_pad_is_listed() {
        let hits = clearance_hits(&drc_at(1.0, 2.0), &planes());
        assert_eq!(hits, vec![("GND".to_string(), 1.0, 2.0)]);
        let items = vec![item(Kind::Via, "v", "GND", (1_000_000, 2_000_000), (1_000_000, 2_000_000), false), item(Kind::Track, "s", "GND", (1_000_000, 2_000_000), (3_000_000, 2_000_000), false)];
        let pads = vec![("U1.3".to_string(), "GND".to_string(), (3_000_000, 2_000_000))];
        let (todo, gone) = plan_via_repair(&hits, &items, &pads, &BTreeSet::new());
        assert_eq!(todo["GND"], BTreeSet::from(["U1.3".to_string()]));
        assert_eq!(gone, BTreeSet::from(["v".to_string(), "s".to_string()]));
    }

    #[test]
    fn source_copper_is_never_repaired_audit_815() {
        let hits = clearance_hits(&drc_at(1.0, 2.0), &planes());
        let via = item(Kind::Via, "v", "GND", (1_000_000, 2_000_000), (1_000_000, 2_000_000), false);
        let stub = item(Kind::Track, "s", "GND", (1_000_000, 2_000_000), (3_000_000, 2_000_000), false);
        let pads = vec![("U1.3".to_string(), "GND".to_string(), (3_000_000, 2_000_000))];
        for preserve in [BTreeSet::from([via.key()]), BTreeSet::from([stub.key()])] {
            let (todo, gone) = plan_via_repair(&hits, &[via.clone(), stub.clone()], &pads, &preserve);
            assert!(todo.is_empty() && gone.is_empty());
        }
        let locked = item(Kind::Via, "v", "GND", (1_000_000, 2_000_000), (1_000_000, 2_000_000), true);
        assert!(plan_via_repair(&hits, &[locked, stub.clone()], &pads, &BTreeSet::new()).1.is_empty());
    }

    #[test]
    fn a_via_with_no_single_stub_to_a_pad_is_left_alone() {
        let hits = clearance_hits(&drc_at(1.0, 2.0), &planes());
        let via = item(Kind::Via, "v", "GND", (1_000_000, 2_000_000), (1_000_000, 2_000_000), false);
        let stub = item(Kind::Track, "s", "GND", (1_000_000, 2_000_000), (3_000_000, 2_000_000), false);
        let other = item(Kind::Track, "t", "GND", (1_000_000, 2_000_000), (1_000_000, 9_000_000), false);
        let pads = vec![("U1.3".to_string(), "GND".to_string(), (3_000_000, 2_000_000))];
        assert!(plan_via_repair(&hits, &[via.clone(), stub.clone(), other], &pads, &BTreeSet::new()).1.is_empty());
        assert!(plan_via_repair(&hits, &[via, stub], &[], &BTreeSet::new()).1.is_empty());
    }

    #[test]
    fn a_clearance_on_another_net_or_a_warning_is_no_hit() {
        assert!(clearance_hits(&drc_at(1.0, 2.0), &BTreeSet::new()).is_empty());
        assert!(clearance_hits(&json!({"violations": [{"severity": "warning", "type": "clearance", "items": []}]}), &planes()).is_empty());
    }

    fn thermal_drc(description: &str) -> Value {
        json!({"violations": [{"type": "starved_thermal", "severity": "error", "items": [{"uuid": "p", "description": description}, {"uuid": "z", "description": "Zone [GND] on B.Cu"}]}]})
    }

    #[test]
    fn thermal_targets_need_every_identity_to_agree() {
        let pads = BTreeMap::from([("p".to_string(), ("U16".to_string(), "2".to_string(), "GND".to_string()))]);
        let zones = BTreeMap::from([("z".to_string(), "GND".to_string())]);
        let found = thermal_targets(&thermal_drc("Pad 2 [GND] of U16 on F.Cu"), &pads, &zones, &planes()).unwrap();
        assert_eq!(found["GND"], vec!["U16.2".to_string()]);
        let through = thermal_targets(&thermal_drc("PTH pad 2 [GND] of U16"), &pads, &zones, &planes()).unwrap();
        assert_eq!(through["GND"], vec!["U16.2".to_string()]);
        assert!(thermal_targets(&thermal_drc("Pad 3 [GND] of U16 on F.Cu"), &pads, &zones, &planes()).unwrap_err().contains("pad identity"));
        assert!(thermal_targets(&thermal_drc("Pad 2 [GND] of U16 on F.Cu"), &pads, &BTreeMap::new(), &planes()).unwrap_err().contains("zone identity"));
        assert!(thermal_targets(&thermal_drc("Pad 2 [GND] of U16 on F.Cu"), &pads, &zones, &BTreeSet::new()).unwrap().is_empty());
    }
}
