//! Select one bounded local via repair from attributed native DRC evidence.
//!
//! Moving away from conflicting pad anchors ranks proposals; it proves no clearance. Native and board gates still decide.

use std::cmp::Ordering;
use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::path::{Path, PathBuf};

use serde_json::{Map, Value, json};

use super::board::{Board, NativePoint, child, child_text, footprints, point, rotate};
use super::copper::Copper;
use super::digest::{file_sha256, source_set};
use super::eco::{prepare_shift, shift_via};
use crate::budget::Budget;
use crate::decimal::Decimal;
use crate::error::{Invalid, Result, invalid};
use crate::pyjson::{float_repr, indented};
use crate::srj::same_value;

const RANKING: &str = "Most reported conflicts targeted, then shortest bridge; move initially away from every conflicting pad anchor";
const STALE: &str = "stale, incomplete or unattributed native DRC evidence";

struct Evidence {
    board: PathBuf,
    inputs: Value,
    drc: Value,
    files: Map<String, Value>,
}

fn read_json(path: &Path) -> Result<Value> {
    Ok(serde_json::from_str(&fs::read_to_string(path)?)?)
}

fn texts(value: &Value) -> BTreeSet<&str> {
    value.as_array().into_iter().flatten().filter_map(Value::as_str).collect()
}

fn native_evidence(folder: &Path) -> Result<Evidence> {
    let folder = fs::canonicalize(folder)?;
    let (manifest, report) = (folder.join("record.json"), folder.join("drc.json"));
    let record = read_json(&manifest)?;
    let board = record["board"].as_str().ok_or_else(|| Invalid(STALE.into()))?;
    let board = fs::canonicalize(board)?;
    let accepted = ["reject", "candidate", "needs_native_check", "model_rejected"];
    let flags = BTreeSet::from(["--schematic-parity", "--refill-zones", "--severity-all"]);
    let fresh = record["schema"] == "iot-lab.native-export.v1"
        && record["status"].as_str().is_some_and(|status| accepted.contains(&status))
        && record["source_mutated"] == false
        && record["drc_returncode"].as_f64() == Some(0.0)
        && same_value(&record["inputs"], &source_set(&board)?)
        && record["drc_sha256"].as_str() == Some(file_sha256(&report)?.as_str())
        && flags.is_subset(&texts(&record["drc_command"]));
    if !fresh {
        return invalid(STALE);
    }
    let drc = read_json(&report)?;
    check_report(&drc, &board)?;
    let mut files = Map::new();
    for path in [&manifest, &report] {
        files.insert(path.display().to_string(), file_sha256(path)?.into());
    }
    Ok(Evidence { board, inputs: record["inputs"].clone(), drc, files })
}

fn check_report(drc: &Value, board: &Path) -> Result<()> {
    let name = board.file_name().map(|name| name.to_string_lossy().into_owned());
    let complete = drc["source"].as_str() == name.as_deref() && drc["coordinate_units"] == "mm"
        && texts(&drc["included_severities"]).contains("error")
        && ["violations", "unconnected_items", "schematic_parity"].iter().all(|field| drc[*field].is_array());
    if !complete {
        return invalid("incomplete native DRC report");
    }
    if drc["schematic_parity"].as_array().is_some_and(|rows| !rows.is_empty()) {
        return invalid("schematic parity must be resolved before copper repair");
    }
    Ok(())
}

/// World positions of the named pads. The arithmetic only ranks proposals; exact native clearance stays the gate.
pub fn pad_anchors(board: &Board, wanted: &BTreeSet<String>) -> Result<BTreeMap<String, NativePoint>> {
    let mut anchors = BTreeMap::new();
    for footprint in footprints(board)? {
        let [x, y, degrees] = footprint.pose;
        for pad in footprint.form.children("pad") {
            let id = child_text(pad, "uuid")?.unwrap_or("");
            if !wanted.contains(id) {
                continue;
            }
            let (px, py) = local_to_world(pad_origin(pad)?, degrees);
            if anchors.insert(id.to_string(), (x + px, y + py)).is_some() {
                return invalid("duplicate native pad identity");
            }
        }
    }
    Ok(anchors)
}

fn pad_origin(pad: &crate::raw::Form) -> Result<NativePoint> {
    let values = child(pad, "at")?.unwrap_or(&[]);
    if !matches!(values.len(), 2 | 3) {
        return invalid("missing native pad origin");
    }
    let number = |index: usize| values[index].atom().and_then(Decimal::parse);
    match (number(0), number(1)) {
        (Some(x), Some(y)) => Ok((x, y)),
        _ => invalid("nonfinite native pad origin"),
    }
}

fn local_to_world((x, y): NativePoint, degrees: Decimal) -> NativePoint {
    if degrees.rem(90).is_zero() {
        return rotate(x, y, (degrees.wrapped_degrees().to_f64() / 90.0) as u32);
    }
    let angle = degrees.to_f64().to_radians();
    let exact = |value: f64| Decimal::parse(&float_repr(value)).unwrap_or(Decimal::ZERO);
    let (c, s) = (exact(angle.cos()), exact(angle.sin()));
    (c * x + s * y, Decimal::ZERO - s * x + c * y)
}

#[derive(Default)]
struct Group {
    pads: BTreeSet<String>,
    errors: Vec<usize>,
}

/// DRC errors a via repair can answer, by via, and the indices of the rest.
fn group_errors(errors: &[&Value], copper: &Copper) -> (BTreeMap<String, Group>, Vec<usize>) {
    let mut groups: BTreeMap<String, Group> = BTreeMap::new();
    let mut unsupported = Vec::new();
    for (index, row) in errors.iter().enumerate() {
        match via_and_pad(row, copper) {
            Some((via, other)) => {
                let group = groups.entry(via).or_default();
                group.pads.insert(other);
                group.errors.push(index);
            }
            None => unsupported.push(index),
        }
    }
    (groups, unsupported)
}

fn via_and_pad(row: &Value, copper: &Copper) -> Option<(String, String)> {
    if !matches!(row["type"].as_str(), Some("clearance" | "hole_clearance")) {
        return None;
    }
    let ids: Vec<&str> = row["items"].as_array()?.iter().map(|item| item["uuid"].as_str()).collect::<Option<_>>()?;
    let [a, b] = ids.as_slice() else { return None };
    let is_via = |id: &str| copper.get(id).is_some_and(|item| item.kind == "via");
    match (a != b, is_via(a), is_via(b)) {
        (true, true, false) => Some((a.to_string(), b.to_string())),
        (true, false, true) => Some((b.to_string(), a.to_string())),
        _ => None,
    }
}

struct Ranked {
    conflicts: usize,
    displacement2: Decimal,
    via: String,
    along: String,
    fraction: f64,
    choice: Value,
}

impl Ranked {
    fn better_than(&self, other: &Ranked) -> bool {
        other.conflicts.cmp(&self.conflicts)
            .then(self.displacement2.cmp(&other.displacement2))
            .then(self.via.cmp(&other.via))
            .then(self.along.cmp(&other.along))
            .then(self.fraction.partial_cmp(&other.fraction).unwrap_or(Ordering::Equal))
            == Ordering::Less
    }
}

/// The straight same-net traces that end at `origin`, by identity.
fn incident_ids(copper: &Copper, net: &str, origin: NativePoint) -> Result<Vec<String>> {
    let mut ids = Vec::new();
    for item in copper.items.iter().filter(|item| item.kind == "segment" && item.net == net) {
        if origin == point(item.form, "start")? || origin == point(item.form, "end")? {
            ids.push(item.id.to_string());
        }
    }
    ids.sort();
    Ok(ids)
}

struct Search<'a> {
    board: &'a Board,
    copper: &'a Copper<'a>,
    anchors: &'a BTreeMap<String, NativePoint>,
    fractions: &'a [f64],
    budget: &'a Budget<'a>,
    best: Option<Ranked>,
    reasons: Map<String, Value>,
    evaluated: u32,
    timed_out: bool,
}

impl Search<'_> {
    fn try_via(&mut self, via: &str, group: &Group) -> Result<()> {
        if !group.pads.iter().all(|pad| self.anchors.contains_key(pad)) {
            self.reasons.insert(via.into(), "conflict is not a represented native pad".into());
            return Ok(());
        }
        let item = self.copper.get(via).ok_or_else(|| Invalid("identified source via required".into()))?;
        let origin = point(item.form, "at")?;
        let incident = incident_ids(self.copper, &item.net, origin)?;
        for along in &incident {
            for &fraction in self.fractions {
                if self.budget.expired() {
                    self.timed_out = true;
                    return Ok(());
                }
                self.try_move(via, along, fraction, origin, group);
            }
        }
        if incident.is_empty() {
            self.reasons.insert(via.into(), "no incident straight trace".into());
        }
        Ok(())
    }

    fn try_move(&mut self, via: &str, along: &str, fraction: f64, origin: NativePoint, group: &Group) {
        let shift = match prepare_shift(self.board, self.copper, via, along, fraction) {
            Ok(shift) => shift,
            Err(error) => {
                self.reasons.insert(via.into(), error.0.into());
                return;
            }
        };
        self.evaluated += 1;
        let destination = shift.destination;
        let vector = (destination.0 - origin.0, destination.1 - origin.1);
        let moves_away = |pad: &String| {
            let anchor = self.anchors[pad];
            vector.0 * (origin.0 - anchor.0) + vector.1 * (origin.1 - anchor.1) > Decimal::ZERO
        };
        if !group.pads.iter().all(moves_away) {
            self.reasons.insert(via.into(), "an incident-direction candidate approaches a conflicting pad anchor".into());
            return;
        }
        let displacement2 = vector.0 * vector.0 + vector.1 * vector.1;
        let ranked = Ranked {
            conflicts: group.errors.len(), displacement2, via: via.into(), along: along.into(), fraction,
            choice: json!({"via_id": via, "along_trace_id": along, "fraction": fraction, "conflict_error_indices": group.errors,
                           "pad_ids": group.pads, "destination_mm": [destination.0.plain(), destination.1.plain()],
                           "bridge_length_mm": displacement2.sqrt_f64()}),
        };
        if self.best.as_ref().is_none_or(|best| ranked.better_than(best)) {
            self.best = Some(ranked);
        }
    }
}

fn check_fractions(fractions: &[f64]) -> Result<()> {
    let inside = fractions.iter().all(|fraction| 0.0 < *fraction && *fraction < 1.0);
    let unique = fractions.iter().enumerate().all(|(index, fraction)| !fractions[..index].contains(fraction));
    if fractions.is_empty() || !inside || !unique {
        return invalid("unique fractions strictly inside a source segment required");
    }
    Ok(())
}

pub fn select_repair(folder: &Path, fractions: &[f64], limit_s: f64, budget: &Budget) -> Result<Value> {
    check_fractions(fractions)?;
    let evidence = native_evidence(folder)?;
    let board = Board::read(&evidence.board)?;
    let copper = Copper::read(&board)?;
    let rows = evidence.drc["violations"].as_array().map_or(&[][..], Vec::as_slice);
    let errors: Vec<&Value> = rows.iter().filter(|row| row["severity"] == "error").collect();
    let (groups, unsupported) = group_errors(&errors, &copper);
    let wanted = groups.values().flat_map(|group| group.pads.iter().cloned()).collect();
    let anchors = pad_anchors(&board, &wanted)?;
    let mut search = Search { board: &board, copper: &copper, anchors: &anchors, fractions, budget,
                              best: None, reasons: Map::new(), evaluated: 0, timed_out: false };
    for (via, group) in &groups {
        search.try_via(via, group)?;
        if search.timed_out {
            break;
        }
    }
    let elapsed_s = budget.elapsed_s();
    let status = if search.timed_out || elapsed_s >= limit_s { "timeout" }
                 else if search.best.is_some() { "candidate" } else { "unsupported" };
    check_evidence_unchanged(&evidence)?;
    let choice = search.best.filter(|_| status == "candidate").map(|best| best.choice);
    let addressed = choice.as_ref().map(|choice| indices(&choice["conflict_error_indices"])).unwrap_or_default();
    let untargeted: Vec<usize> = (0..errors.len()).filter(|index| !addressed.contains(index)).collect();
    Ok(json!({
        "schema": "iot-lab.native-conflict-selection.v1", "status": status, "qualified": false,
        "source_board": evidence.board.display().to_string(), "sources": evidence.inputs, "evidence_files": evidence.files,
        "fractions": fractions, "budget_s": limit_s, "elapsed_s": elapsed_s, "evaluated": search.evaluated, "choice": choice,
        "input_error_count": errors.len(), "input_open_count": evidence.drc["unconnected_items"].as_array().map_or(0, Vec::len),
        "untargeted_error_indices": untargeted, "unsupported_error_indices": unsupported, "diagnostic_reasons": search.reasons,
        "ranking": RANKING, "native_and_board_specific_gates_required": true,
    }))
}

fn indices(value: &Value) -> BTreeSet<usize> {
    value.as_array().into_iter().flatten().filter_map(Value::as_u64).map(|index| index as usize).collect()
}

fn check_evidence_unchanged(evidence: &Evidence) -> Result<()> {
    let same_file = |(path, digest): (&String, &Value)| file_sha256(Path::new(path)).is_ok_and(|now| digest.as_str() == Some(now.as_str()));
    if !same_value(&evidence.inputs, &source_set(&evidence.board)?) || !evidence.files.iter().all(same_file) {
        return invalid("native evidence changed during diagnosis");
    }
    Ok(())
}

pub fn propose(folder: &Path, out: &Path, fractions: &[f64], limit_s: f64, budget: &Budget) -> Result<Value> {
    let out = std::path::absolute(out)?;
    if out.exists() {
        return invalid("new separate output directory required");
    }
    let plan = select_repair(folder, fractions, limit_s, budget)?;
    if plan["status"] != "candidate" {
        fs::create_dir(&out)?;
        fs::write(out.join("record.json"), indented(&plan)?)?;
        return Ok(plan);
    }
    let source = PathBuf::from(plan["source_board"].as_str().unwrap_or(""));
    if !same_value(&source_set(&source)?, &plan["sources"]) {
        return invalid("source changed before local repair");
    }
    let choice = &plan["choice"];
    let via = choice["via_id"].as_str().unwrap_or("");
    let along = choice["along_trace_id"].as_str().unwrap_or("");
    let mut result = shift_via(&source, via, along, &out, choice["fraction"].as_f64().unwrap_or(f64::NAN))?;
    result["conflict_selection"] = plan;
    fs::write(out.join("record.json"), indented(&result)?)?;
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_quarter_turn_stays_exact_and_other_angles_use_the_rotation() {
        let one = Decimal::parse("1").unwrap();
        let (x, y) = local_to_world((one, Decimal::ZERO), Decimal::parse("90").unwrap());
        assert_eq!((x, y), (Decimal::ZERO, Decimal::ZERO - one));
        let (x, _) = local_to_world((one, Decimal::ZERO), Decimal::parse("45").unwrap());
        assert_eq!(x.plain(), float_repr(45f64.to_radians().cos()));
    }

    #[test]
    fn fractions_must_be_unique_and_inside_the_segment() {
        assert!(check_fractions(&[]).is_err());
        assert!(check_fractions(&[0.5, 0.5]).is_err());
        assert!(check_fractions(&[1.0]).is_err());
        assert!(check_fractions(&[0.25, 0.5]).is_ok());
    }
}
