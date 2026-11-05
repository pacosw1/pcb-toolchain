//! Move one unlocked two-layer via along an incident straight trace, keeping both traces and adding a bridge on the other
//! layer. This is a proposal: native DRC, connectivity and the board's gates decide acceptance.

use std::collections::BTreeSet;
use std::fs;
use std::path::Path;

use serde_json::{Value, json};
use sha1::{Digest, Sha1};

use super::board::{Board, NativePoint, child, child_atoms, child_text, has_atom, locked, point};
use super::copper::{Copper, CopperItem};
use super::digest::{copy_sidecars, geometry_digest, source_set};
use crate::contract::check_positive;
use crate::decimal::Decimal;
use crate::error::{Result, invalid};
use crate::pyjson::{fingerprint, float_repr, indented, inline};
use crate::raw::Form;

/// Native coordinates are integer nanometres: serialization precision, not a clearance tolerance.
const GRID_PLACES: u32 = 6;
const NAMESPACE_URL: [u8; 16] = [0x6b, 0xa7, 0xb8, 0x11, 0x9d, 0xad, 0x11, 0xd1, 0x80, 0xb4, 0x00, 0xc0, 0x4f, 0xd4, 0x30, 0xc8];

/// A checked move, before anything is written.
pub struct Shift<'a> {
    pub other: &'a CopperItem<'a>,
    pub origin: NativePoint,
    pub destination: NativePoint,
}

/// Validate one exact local topology and compute the move.
pub fn prepare_shift<'a>(board: &Board, copper: &'a Copper<'a>, via_id: &str, along_id: &str, fraction: f64) -> Result<Shift<'a>> {
    check_positive(fraction, "fraction")?;
    if fraction >= 1.0 {
        return invalid("fraction must lie strictly inside the incident trace");
    }
    check_two_layers(board)?;
    let via = copper.get(via_id).filter(|item| item.kind == "via");
    let Some(via) = via else { return invalid("identified source via required") };
    if locked(via.form)? || has_atom(via.form, "blind") || has_atom(via.form, "micro")
        || child_atoms(via.form, "layers")? != ["F.Cu", "B.Cu"] {
        return invalid("unlocked through via required");
    }
    let origin = point(via.form, "at")?;
    let incident = incident_traces(copper, via, origin)?;
    let [first, second] = incident.as_slice() else { return invalid("exactly two incident source segments required") };
    let (along, other) = match (first.id == along_id, second.id == along_id) {
        (true, _) => (*first, *second),
        (_, true) => (*second, *first),
        _ => return invalid("exactly two incident source segments required"),
    };
    check_opposite_layers(along, other)?;
    let anchor = far_end(along, origin)?;
    let destination = destination(origin, anchor, fraction)?;
    Ok(Shift { other, origin, destination })
}

fn check_two_layers(board: &Board) -> Result<()> {
    let rows = child(&board.root, "layers")?.unwrap_or(&[]);
    let copper: BTreeSet<&str> = rows.iter().filter_map(|row| row.text(1)).filter(|name| name.ends_with(".Cu")).collect();
    if copper != BTreeSet::from(["F.Cu", "B.Cu"]) {
        return invalid("this local pattern requires a two-layer board");
    }
    Ok(())
}

/// The same-net segments ending at the via. A branch through it, or a curve at it, needs a richer repair.
fn incident_traces<'a>(copper: &'a Copper<'a>, via: &CopperItem, origin: NativePoint) -> Result<Vec<&'a CopperItem<'a>>> {
    let mut incident = Vec::new();
    for item in &copper.items {
        if item.net != via.net || !matches!(item.kind, "segment" | "arc") {
            continue;
        }
        let (start, end) = (point(item.form, "start")?, point(item.form, "end")?);
        if origin == start || origin == end {
            if item.kind != "segment" {
                return invalid("incident arc requires a richer repair");
            }
            incident.push(item);
        } else if item.kind == "segment" && lies_inside(origin, start, end) {
            return invalid("via lies inside another segment; branch repair required");
        }
    }
    Ok(incident)
}

fn lies_inside(p: NativePoint, a: NativePoint, b: NativePoint) -> bool {
    (b.0 - a.0) * (p.1 - a.1) == (b.1 - a.1) * (p.0 - a.0)
        && a.0.min(b.0) <= p.0 && p.0 <= a.0.max(b.0)
        && a.1.min(b.1) <= p.1 && p.1 <= a.1.max(b.1)
}

fn check_opposite_layers(along: &CopperItem, other: &CopperItem) -> Result<()> {
    if locked(along.form)? || locked(other.form)? {
        return invalid("locked incident copper requires explicit ownership handling");
    }
    let layers = BTreeSet::from([child_text(along.form, "layer")?, child_text(other.form, "layer")?]);
    if layers != BTreeSet::from([Some("F.Cu"), Some("B.Cu")]) {
        return invalid("incident traces must occupy opposite layers");
    }
    Ok(())
}

fn far_end(trace: &CopperItem, origin: NativePoint) -> Result<NativePoint> {
    for field in ["start", "end"] {
        let end = point(trace.form, field)?;
        if end != origin {
            return Ok(end);
        }
    }
    invalid("zero-length incident trace")
}

fn destination(origin: NativePoint, anchor: NativePoint, fraction: f64) -> Result<NativePoint> {
    let Some(share) = Decimal::parse(&float_repr(fraction)) else { return invalid("fraction must be finite") };
    let along = |a: Decimal, b: Decimal| (a + (b - a) * share).quantized(GRID_PLACES);
    let moved = (along(origin.0, anchor.0), along(origin.1, anchor.1));
    if moved == origin || moved == anchor {
        return invalid("fraction collapses at native coordinate precision");
    }
    // Rounding to the grid must not move the via off the unchanged trace centreline.
    if (anchor.0 - origin.0) * (moved.1 - origin.1) != (anchor.1 - origin.1) * (moved.0 - origin.0) {
        return invalid("quantized position is not on the incident centreline");
    }
    Ok(moved)
}

fn text_of(place: NativePoint) -> String {
    format!("{} {}", place.0.plain(), place.1.plain())
}

/// RFC 4122 version 5 in the URL namespace.
fn uuid5(name: &str) -> String {
    let digest = Sha1::new().chain_update(NAMESPACE_URL).chain_update(name).finalize();
    let mut bytes: [u8; 16] = digest[..16].try_into().expect("SHA-1 has 20 bytes");
    bytes[6] = (bytes[6] & 0x0f) | 0x50;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    let hex: String = bytes.iter().map(|byte| format!("{byte:02x}")).collect();
    format!("{}-{}-{}-{}-{}", &hex[..8], &hex[8..12], &hex[12..16], &hex[16..20], &hex[20..])
}

fn only_child<'a>(form: &'a Form, head: &'a str, complaint: &str) -> Result<&'a Form> {
    let mut rows = form.children(head);
    match (rows.next(), rows.next()) {
        (Some(row), None) => Ok(row),
        _ => invalid(complaint),
    }
}

/// Write the moved via and its bridge into a new folder, and return the record.
pub fn shift_via(source: &Path, via_id: &str, along_id: &str, out: &Path, fraction: f64) -> Result<Value> {
    let (source, out) = (fs::canonicalize(source)?, std::path::absolute(out)?);
    if out.exists() || Some(out.as_path()) == source.parent() {
        return invalid("new separate output directory required");
    }
    let before = source_set(&source)?;
    let board = Board::read(&source)?;
    let copper = Copper::read(&board)?;
    let shift = prepare_shift(&board, &copper, via_id, along_id, fraction)?;
    let origin_mm = [shift.origin.0.plain(), shift.origin.1.plain()];
    let destination_mm = [shift.destination.0.plain(), shift.destination.1.plain()];
    let bridge_id = uuid5(&fingerprint(&json!({"sources": before, "via": via_id, "along": along_id, "destination": destination_mm}))?);
    if copper.get(&bridge_id).is_some() {
        return invalid("bridge identity already exists");
    }
    let proposal = edited_text(&board, &copper, via_id, &shift, &bridge_id)?;

    fs::create_dir(&out)?;
    let target = out.join("proposal.kicad_pcb");
    fs::write(&target, &proposal)?;
    copy_sidecars(&source, &target)?;
    let moved = BTreeSet::from([via_id.to_string()]);
    let with_bridge = BTreeSet::from([via_id.to_string(), bridge_id.clone()]);
    let protected = geometry_digest(&board, &moved)?;
    if source_set(&source)? != before || protected != geometry_digest(&Board::from_text(proposal)?, &with_bridge)? {
        return invalid("source changed or repair touched unrelated native content");
    }
    let record = json!({
        "schema": "iot-lab.native-via-eco.v1", "status": "candidate", "qualified": false, "sources": before,
        "output_files": source_set(&target)?, "via_id": via_id, "along_trace_id": along_id, "other_trace_id": shift.other.id,
        "added_bridge_id": bridge_id, "fraction": fraction, "origin_mm": origin_mm, "destination_mm": destination_mm,
        "protected_geometry_sha256": protected, "edits": "One via origin and one new bridge; all original tracks unchanged",
        "native_and_board_specific_gates_required": true,
    });
    fs::write(out.join("record.json"), indented(&record)?)?;
    Ok(record)
}

/// The board text with the via moved and the bridge added before the final bracket.
fn edited_text(board: &Board, copper: &Copper, via_id: &str, shift: &Shift, bridge_id: &str) -> Result<String> {
    let via = copper.get(via_id).map(|item| item.form).ok_or_else(|| crate::error::Invalid("identified source via required".into()))?;
    let at = only_child(via, "at", "ambiguous via origin")?;
    let other = shift.other.form;
    let Some(width) = child_text(other, "width")? else { return invalid("source track width must be finite") };
    check_positive(width.parse().unwrap_or(f64::NAN), "source track width")?;
    let net = only_child(other, "net", "ambiguous source net")?;
    let layer = child_text(other, "layer")?.unwrap_or("");
    let bridge = format!("\n(segment (start {}) (end {}) (width {width}) (layer {}) {} (uuid \"{bridge_id}\"))\n",
                         text_of(shift.origin), text_of(shift.destination), inline(&json!(layer))?, board.source(net));
    let mut text = board.text.clone();
    text.replace_range(at.span.clone(), &format!("(at {})", text_of(shift.destination)));
    let end = text.rfind(')').ok_or_else(|| crate::error::Invalid("unexpected native board root".into()))?;
    text.insert_str(end, &bridge);
    Ok(text)
}

#[cfg(test)]
mod tests;
