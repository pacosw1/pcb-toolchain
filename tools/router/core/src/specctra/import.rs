//! A session onto a board as text: what `pcbnew.ImportSpecctraSES` did for the Fastroute job, with no board loaded and no save
//! from nightly.
//!
//! The copper the job left unlocked goes (the router may have ripped it up) and the session's copper is added. Nothing else in
//! the board text changes, so footprints cannot move and preserved copper cannot change; `pose` checks the placement the session
//! reports. What stays here is the policy for copper the session repeats. Fastroute returns preserved wiring as
//! protected copies, sometimes twice, and sometimes with no type; such a copy is proved against the source, the DSN and the
//! session and then not written. A coincidence that cannot be proved stops the import: it is a foreign result.
//!
//! Stricter than KiCad, which skips the item: a session net or layer the board does not have is an error, as in `iotroute write`.
use super::records::{Geometry, Modes, Point, Record, dsn_records, modes, session_records};
use crate::kicad::board::{Board, RoutedCopper};
use crate::kicad::item_text::{board_nets, copper_layers, item_uuid, net_line, nm_text, quoted, segment_text, via_text, with_items};
use crate::kicad::raw::{self, Form};
use serde::Serialize;
use std::collections::{BTreeMap, BTreeSet};

/// A segment shorter than this on both axes is no copper. Fastroute writes at 0.1 um and joins a point it rounded to one it did
/// not with such a stub; KiCad's DSN is in whole um, so the next pass could not match it.
const DSN_UNIT_NM: i64 = 1000;

/// A copper item of the board before the import.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Existing {
    pub id: String,
    pub geometry: Geometry,
}

/// The copper of a board in the form the import compares.
pub fn existing_copper(board: &Board) -> Vec<Existing> {
    let item = |copper: &RoutedCopper| match copper {
        RoutedCopper::Track(track) if track.mid.is_some() => Existing { id: track.id.clone(), geometry: Geometry::Unsupported(track.id.clone()) },
        RoutedCopper::Track(track) => {
            let (a, b) = ((track.start.x, track.start.y), (track.end.x, track.end.y));
            Existing { id: track.id.clone(), geometry: Geometry::segment(&track.net, &track.layer, track.width, a, b) }
        }
        RoutedCopper::Via(via) => {
            let geometry = Geometry::Via { net: via.net.clone(), at: (via.at.x, via.at.y), size: via.size, drill: via.drill };
            Existing { id: via.id.clone(), geometry }
        }
    };
    board.copper.iter().map(item).collect()
}

/// A session copy of preserved copper that was not written.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Replay {
    pub retained_uuid: String,
    pub copper: String,
    pub dsn_modes: Vec<String>,
    pub ses_modes: Vec<String>,
}

/// A new segment that was not written.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct DroppedSegment {
    pub net: String,
    pub layer: String,
    pub width_nm: i64,
    pub ends_nm: [Point; 2],
}

#[derive(Debug, PartialEq, Eq)]
pub struct Imported {
    pub text: String,
    pub replays: Vec<Replay>,
    /// The second of two identical new segments: Fastroute writes a wire twice now and then.
    pub duplicates: Vec<DroppedSegment>,
    pub short: Vec<DroppedSegment>,
    pub added: usize,
}

pub struct Session<'a> {
    pub board_text: &'a str,
    pub copper: &'a [Existing],
    /// The uuids the job kept: everything else was offered to the router and goes.
    pub preserved: &'a BTreeSet<String>,
    pub dsn: &'a str,
    pub ses: &'a str,
    /// Seeds the uuids of the new items; see `item_uuid`.
    pub seed: &'a str,
}

/// The new records after the two clean-ups, and what they dropped.
struct Sorted {
    new: Vec<Record>,
    duplicates: Vec<DroppedSegment>,
    short: Vec<DroppedSegment>,
    deduplicated: BTreeMap<Geometry, usize>,
}

fn dropped(record: &Record) -> Option<DroppedSegment> {
    let Geometry::Segment { net, layer, width, .. } = &record.geometry else { return None };
    Some(DroppedSegment { net: net.clone(), layer: layer.clone(), width_nm: *width, ends_nm: record.path })
}

fn is_short(record: &Record) -> bool {
    let [a, b] = record.path;
    (a.0 - b.0).abs() < DSN_UNIT_NM && (a.1 - b.1).abs() < DSN_UNIT_NM
}

/// A wire of type fix is locked on import and is left to the replay policy.
fn sort_records(records: Vec<Record>) -> Sorted {
    let mut sorted = Sorted { new: Vec::new(), duplicates: Vec::new(), short: Vec::new(), deduplicated: BTreeMap::new() };
    let mut seen = BTreeSet::new();
    for record in records {
        match dropped(&record).filter(|_| record.mode != "fix") {
            Some(row) if !seen.insert(record.geometry.clone()) => {
                *sorted.deduplicated.entry(record.geometry).or_default() += 1;
                sorted.duplicates.push(row);
            }
            Some(row) if is_short(&record) => sorted.short.push(row),
            _ => sorted.new.push(record),
        }
    }
    sorted
}

fn near(a: Point, b: Point) -> bool {
    (a.0 - b.0).abs() <= DSN_UNIT_NM && (a.1 - b.1).abs() <= DSN_UNIT_NM
}

/// The DSN record of a source: exact, else the same net, layer, width (and drill) with every coordinate within one DSN unit.
/// KiCad's DSN is in whole um; a router result imported at 0.1 um is offered rounded.
fn dsn_offer<'a>(dsn: &'a Modes, geometry: &'a Geometry) -> Option<&'a Geometry> {
    if dsn.contains_key(geometry) {
        return dsn.get_key_value(geometry).map(|(key, _)| key);
    }
    dsn.keys().find(|candidate| match (*candidate, geometry) {
        (Geometry::Segment { net: n1, layer: l1, width: w1, ends: [c, d] }, Geometry::Segment { net: n2, layer: l2, width: w2, ends: [a, b] }) => {
            n1 == n2 && l1 == l2 && w1 == w2 && ((near(*a, *c) && near(*b, *d)) || (near(*a, *d) && near(*b, *c)))
        }
        (Geometry::Via { net: n1, at: a1, size: s1, drill: d1 }, Geometry::Via { net: n2, at: a2, size: s2, drill: d2 }) => {
            n1 == n2 && s1 == s2 && d1 == d2 && near(*a1, *a2)
        }
        _ => false,
    })
}

/// The replay policy, on data only.
struct Policy<'a> {
    before: &'a [Existing],
    preserved: &'a BTreeSet<String>,
    dsn: &'a Modes,
    ses: &'a Modes,
    deduplicated: &'a BTreeMap<Geometry, usize>,
}

impl Policy<'_> {
    fn sources(&self, geometry: &Geometry) -> Vec<&Existing> {
        self.before.iter().filter(|item| item.geometry == *geometry).collect()
    }

    fn provenance(&self, geometry: &Geometry, label: &str) -> Result<Vec<String>, String> {
        let offered = dsn_offer(self.dsn, geometry);
        match offered.filter(|_| self.ses.contains_key(geometry)) {
            Some(key) => Ok(self.dsn[key].clone()),
            None => Err(format!(
                "missing source DSN/SES provenance{label}: {} (DSN offered {}, SES returned {})",
                geometry.describe(),
                offered.is_some(),
                self.ses.contains_key(geometry)
            )),
        }
    }

    fn check_count(&self, geometry: &Geometry, copies: usize) -> Result<(), String> {
        let returned = self.ses.get(geometry).map_or(0, Vec::len);
        if returned == copies + self.deduplicated.get(geometry).copied().unwrap_or(0) {
            Ok(())
        } else {
            Err(format!("SES replay multiplicity does not match import: {}", geometry.describe()))
        }
    }

    /// Copper the router was free to rip up came back unchanged: it is the router's copy now, so it is written.
    fn check_unlocked(&self, geometry: &Geometry, copies: usize, sources: &[&Existing]) -> Result<(), String> {
        if sources.len() != 1 {
            return Err("ambiguous unlocked source geometry".to_string());
        }
        let offered = self.provenance(geometry, "")?;
        if offered.iter().any(|mode| mode != "route") {
            return Err("unlocked source was not offered as unlocked wiring".to_string());
        }
        self.check_count(geometry, copies)
    }

    /// A copy of preserved copper: proved here and not written. Fastroute now and then returns a (type fix) wire with no type in a
    /// later stage of the same net; that is accepted only when the DSN offered this copper as fix and nothing else.
    fn replay(&self, geometry: &Geometry, copies: usize, source: &Existing) -> Result<Replay, String> {
        let dsn_modes = self.provenance(geometry, " (preserved)")?;
        if dsn_modes.iter().any(|mode| !matches!(mode.as_str(), "fix" | "protect" | "route")) {
            return Err("unsupported DSN source mode".to_string());
        }
        let ses_modes = self.ses[geometry].clone();
        let fixed_replay = !dsn_modes.is_empty() && dsn_modes.iter().all(|mode| mode == "fix") && ses_modes.iter().all(|mode| mode == "unspecified");
        if !fixed_replay && ses_modes.iter().any(|mode| !matches!(mode.as_str(), "fix" | "protect")) {
            return Err(format!("unprotected SES coincidence: {} (SES modes {ses_modes:?})", geometry.describe()));
        }
        self.check_count(geometry, copies)?;
        Ok(Replay { retained_uuid: source.id.clone(), copper: geometry.describe(), dsn_modes, ses_modes })
    }

    /// The replays among the new copper, by geometry. Everything else is written.
    fn classify(&self, new: &[Record]) -> Result<BTreeMap<Geometry, Replay>, String> {
        let known = |id: &String| self.before.iter().any(|item| item.id == *id);
        if !self.preserved.iter().all(known) {
            return Err("unknown preserved UUID".to_string());
        }
        let arc = |item: &&Existing| matches!(item.geometry, Geometry::Unsupported(_)) && self.preserved.contains(&item.id);
        if self.before.iter().any(|item| arc(&item)) {
            return Err("unsupported preserved source copper; arc replay not proved".to_string());
        }
        let mut replays = BTreeMap::new();
        for (geometry, modes) in modes(new) {
            let sources = self.sources(&geometry);
            let copies = modes.len();
            if let Some(kept) = sources.iter().find(|source| self.preserved.contains(&source.id)) {
                if sources.len() != 1 {
                    return Err("ambiguous preserved source geometry".to_string());
                }
                replays.insert(geometry.clone(), self.replay(&geometry, copies, kept)?);
            } else if copies > 1 {
                return Err("new-new duplicate without preserved source".to_string());
            } else if !sources.is_empty() {
                self.check_unlocked(&geometry, copies, &sources)?;
            }
        }
        Ok(replays)
    }
}

fn uuid_of(form: &Form) -> Option<&str> {
    form.children("uuid").next()?.text(1)
}

/// The text with these top-level copper items gone, each with its line.
fn without_items(text: &str, ids: &BTreeSet<&str>) -> Result<String, String> {
    let root = raw::parse_first(text).map_err(|error| format!("board text: {error}"))?;
    let mut out = String::with_capacity(text.len());
    let mut at = 0;
    let mut removed = 0;
    for form in root.items() {
        let copper = form.is("segment") || form.is("via") || form.is("arc");
        if !copper || !uuid_of(form).is_some_and(|id| ids.contains(id)) {
            continue;
        }
        let line = text[..form.span.start].rfind('\n').map_or(0, |newline| newline + 1);
        out.push_str(&text[at..line.max(at)]);
        at = if text[form.span.end..].starts_with('\n') { form.span.end + 1 } else { form.span.end };
        removed += 1;
    }
    if removed != ids.len() {
        return Err(format!("board text holds {removed} of {} unlocked items", ids.len()));
    }
    out.push_str(&text[at..]);
    Ok(out)
}

fn point_text(point: Point) -> String {
    format!("{} {}", nm_text(point.0), nm_text(point.1))
}

/// The new copper as board text. A net or layer the board lacks stops the import: the session was made for another board.
fn items_text(records: &[&Record], board: &str, seed: &str) -> Result<String, String> {
    let (nets, layers) = (board_nets(board), copper_layers(board)?);
    let net_text = |net: &str| {
        if net.is_empty() || nets.contains(&quoted(net)) { Ok(net_line(net)) } else { Err(format!("net {} is not on the board", quoted(net))) }
    };
    let mut out = String::new();
    for (n, record) in records.iter().enumerate() {
        let uuid = item_uuid(seed, n);
        match &record.geometry {
            Geometry::Segment { net, layer, width, .. } => {
                let layer = quoted(layer);
                if !layers.contains(&layer) {
                    return Err(format!("layer {layer} is not on the board"));
                }
                let [start, end] = record.path;
                out += &segment_text(&point_text(start), &point_text(end), &nm_text(*width), &layer, &net_text(net)?, &uuid);
            }
            Geometry::Via { net, at, size, drill } => out += &via_text(&point_text(*at), &nm_text(*size), &nm_text(*drill), &net_text(net)?, &uuid),
            Geometry::Unsupported(_) => return Err("session copper is never an arc".to_string()),
        }
    }
    Ok(out)
}

/// The board text with the session on it. Every check runs before any text is built.
pub fn import(session: &Session) -> Result<Imported, String> {
    let ses_records = session_records(session.ses)?;
    let (dsn, ses) = (modes(&dsn_records(session.dsn)?), modes(&ses_records));
    let Sorted { new, duplicates, short, deduplicated } = sort_records(ses_records);
    let policy = Policy { before: session.copper, preserved: session.preserved, dsn: &dsn, ses: &ses, deduplicated: &deduplicated };
    let replays = policy.classify(&new)?;
    let written: Vec<&Record> = new.iter().filter(|record| !replays.contains_key(&record.geometry)).collect();
    let items = items_text(&written, session.board_text, session.seed)?;
    let unlocked: BTreeSet<&str> = session.copper.iter().map(|item| item.id.as_str()).filter(|id| !session.preserved.contains(*id)).collect();
    let text = with_items(&without_items(session.board_text, &unlocked)?, &items)?;
    let added = written.len();
    Ok(Imported { text, replays: replays.into_values().collect(), duplicates, short, added })
}

#[cfg(test)]
mod tests;
