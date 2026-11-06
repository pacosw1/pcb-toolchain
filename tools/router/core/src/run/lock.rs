//! --lock-from: a copy of the input without tracks and vias, with the copper of the lock nets of another board added and locked.
//! The board text is edited, then KiCad saves the copy, so items land where a save puts them: the copper order, and so the route,
//! follows from the uuids, which the copy keeps.
use super::project::{place_sidecars, restore_pro};
use crate::kicad::api::{Server, read_board};
use crate::kicad::item_text::with_items;
use crate::kicad::raw::{self, Form};
use crate::kicad::{Board, kicad_cli};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::path::Path;
use std::process::Command;

/// Pads closer than this are the same pad, in mm.
const PAD_TOLERANCE: f64 = 0.001;
const TRACK_HEADS: [&str; 3] = ["segment", "arc", "via"];

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LockStage {
    pub removed: usize,
    pub kept: usize,
    pub nets: Vec<String>,
    pub source: String,
    pub source_sha256: String,
    /// --route-pairs: the pairs routed before the core, and those that kept their input copper.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pairs: Option<super::pairs::PairStage>,
}

#[derive(Default, Deserialize)]
#[serde(default)]
struct LockModel {
    pairs: Vec<PairNets>,
    nets: BTreeMap<String, NetLimits>,
}

#[derive(Default, Deserialize)]
#[serde(default)]
struct PairNets {
    name: Option<String>,
    p: Option<String>,
    n: Option<String>,
}

#[derive(Default, Deserialize)]
#[serde(default)]
struct NetLimits {
    limits: Limits,
}

#[derive(Default, Deserialize)]
#[serde(default)]
struct Limits {
    via_count: Option<f64>,
}

/// Nets whose copper is kept: diff pairs and nets with DRU via_count 0, as M2 and NET-CORE did.
pub fn lock_nets(model_json: &str) -> Result<BTreeSet<String>, String> {
    let model: LockModel = serde_json::from_str(model_json).map_err(|e| format!("model: {e}"))?;
    let pairs = model.pairs.into_iter().flat_map(|p| [p.p, p.n]).flatten().filter(|n| !n.is_empty());
    let crystals = model.nets.into_iter().filter(|(_, n)| n.limits.via_count == Some(0.0)).map(|(name, _)| name);
    Ok(pairs.chain(crystals).collect())
}

/// The diff pairs of a model as (name, P, N); a pair with no name is named by its P net.
pub fn model_pairs(model_json: &str) -> Result<Vec<(String, String, String)>, String> {
    let model: LockModel = serde_json::from_str(model_json).map_err(|e| format!("model: {e}"))?;
    Ok(model.pairs.into_iter().filter_map(|pair| {
        let (p, n) = (pair.p.filter(|p| !p.is_empty())?, pair.n.filter(|n| !n.is_empty())?);
        Some((pair.name.unwrap_or_else(|| p.clone()), p, n))
    }).collect())
}

type PadMap = BTreeMap<(String, String), (f64, f64, String)>;

fn pads_of(board: &Board) -> PadMap {
    let mm = crate::kicad::geom::to_mm;
    board.pads().map(|(f, p)| ((f.reference.clone(), p.number.clone()), (mm(p.position.x), mm(p.position.y), p.net.clone()))).collect()
}

/// Pads of the lock nets that moved or are missing.
fn pad_mismatch(source: &PadMap, input: &PadMap, nets: &BTreeSet<String>) -> Vec<String> {
    let same = |a: &(f64, f64, String), b: &(f64, f64, String)| a.2 == b.2 && (a.0 - b.0).abs() <= PAD_TOLERANCE && (a.1 - b.1).abs() <= PAD_TOLERANCE;
    source.iter().filter(|(_, pad)| nets.contains(&pad.2)).filter(|(key, pad)| !input.get(*key).is_some_and(|other| same(pad, other))).map(|((r, n), pad)| format!("{r}.{n} {}", pad.2)).collect()
}

fn board_items(forms: &[Form]) -> Result<&[Form], String> {
    forms.first().filter(|f| f.is("kicad_pcb")).map(Form::items).ok_or_else(|| "not a kicad_pcb file".to_string())
}

fn is_copper(item: &Form) -> bool {
    TRACK_HEADS.iter().any(|h| item.is(h))
}

/// The input's text with its tracks and vias cut out, and how many.
fn without_copper(text: &str) -> Result<(String, usize), String> {
    let forms = raw::parse(text)?;
    let mut out = String::with_capacity(text.len());
    let (mut at, mut removed) = (0, 0);
    for item in board_items(&forms)?.iter().filter(|i| is_copper(i)) {
        out.push_str(text[at..item.span.start].trim_end_matches([' ', '\t']));
        at = item.span.end;
        removed += 1;
    }
    out.push_str(&text[at..]);
    Ok((out, removed))
}

/// The item's text with `(locked yes)` after its head, unless it says so already.
fn locked_text(text: &str, item: &Form) -> String {
    let body = &text[item.span.clone()];
    if item.children("locked").next().is_some() {
        return body.to_string();
    }
    let head = item.items().first().map_or(0, |h| h.span.end - item.span.start);
    format!("{} (locked yes){}", &body[..head], &body[head..])
}

/// The copper of the lock nets, locked, with its uuids.
fn lock_copper(text: &str, nets: &BTreeSet<String>) -> Result<(String, usize), String> {
    let forms = raw::parse(text)?;
    let mut out = String::new();
    let mut kept = 0;
    for item in board_items(&forms)?.iter().filter(|i| is_copper(i)) {
        if item.children("net").next().and_then(|n| n.text(1)).is_some_and(|net| nets.contains(net)) {
            out.push('\t');
            out.push_str(&locked_text(text, item));
            out.push('\n');
            kept += 1;
        }
    }
    Ok((out, kept))
}

/// KiCad reads the copy and saves it in its own form and order.
fn save_with_kicad(pcb: &Path) -> Result<(), String> {
    let cli = kicad_cli();
    let output = Command::new(&cli).args(["pcb", "upgrade", "--force"]).arg(pcb).output().map_err(|e| format!("{cli}: {e}"))?;
    if output.status.success() { Ok(()) } else { Err(format!("kicad-cli pcb upgrade failed: {}", String::from_utf8_lossy(&output.stderr).trim())) }
}

fn read_through_api(path: &Path) -> Result<Board, String> {
    let (_server, mut client) = Server::start(path)?;
    read_board(&mut client, path).map_err(|e| e.to_string())
}

fn read_text(path: &Path) -> Result<String, String> {
    fs::read_to_string(path).map_err(|e| format!("{}: {e}", path.display()))
}

/// Writes the locked copy at `out_pcb`, with its project files. Every pad of a lock net must be at the same place in both boards,
/// else the copper cannot fit.
pub fn make_locked_input(in_pcb: &Path, src_pcb: &Path, nets: &BTreeSet<String>, out_pcb: &Path) -> Result<(usize, usize), String> {
    let bad = pad_mismatch(&pads_of(&read_through_api(src_pcb)?), &pads_of(&read_through_api(in_pcb)?), nets);
    if !bad.is_empty() {
        return Err(format!("--lock-from: {} lock-net pads differ from the input: {}", bad.len(), bad[..bad.len().min(8)].join(", ")));
    }
    let (stripped, removed) = without_copper(&read_text(in_pcb)?)?;
    let (items, kept) = lock_copper(&read_text(src_pcb)?, nets)?;
    if let Some(parent) = out_pcb.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("{}: {e}", parent.display()))?;
    }
    place_sidecars(in_pcb, out_pcb)?;
    fs::write(out_pcb, with_items(&stripped, &items)?).map_err(|e| format!("{}: {e}", out_pcb.display()))?;
    save_with_kicad(out_pcb)?;
    restore_pro(in_pcb, out_pcb)?;
    Ok((removed, kept))
}

#[cfg(test)]
mod tests {
    use super::*;

    const BOARD: &str = "(kicad_pcb (version 20260206)\n\t(footprint \"a\" (at 0 0))\n\t(segment (start 0 0) (end 1 1) (width 0.2) (layer \"F.Cu\") (net \"A\") (uuid \"u1\"))\n\t(via (at 1 1) (size 0.6) (drill 0.3) (layers \"F.Cu\" \"B.Cu\") (locked yes) (net \"B\") (uuid \"u2\"))\n\t(arc (start 0 0) (mid 1 1) (end 2 0) (width 0.2) (layer \"F.Cu\") (net \"C\") (uuid \"u3\"))\n)\n";

    fn pad(x: f64, y: f64, net: &str) -> (f64, f64, String) {
        (x, y, net.to_string())
    }

    #[test]
    fn lock_nets_are_pairs_and_via_count_zero() {
        let model = r#"{"pairs": [{"p": "/USB_DP", "n": "/USB_DN"}], "nets": {"/OSC_IN": {"limits": {"via_count": 0.0}}, "/RMII": {"limits": {"via_count": 4.0}}, "VDD": {"limits": {"amps": 1.0}}, "/X": {"limits": {}}}}"#;
        let want: BTreeSet<String> = ["/USB_DP", "/USB_DN", "/OSC_IN"].map(str::to_string).into();
        assert_eq!(lock_nets(model).unwrap(), want);
    }

    #[test]
    fn a_mismatch_counts_only_lock_nets() {
        let key = |r: &str, n: &str| (r.to_string(), n.to_string());
        let src: PadMap = [(key("U1", "1"), pad(10.0, 10.0, "/A")), (key("U1", "2"), pad(11.0, 10.0, "/B")), (key("R1", "1"), pad(5.0, 5.0, "/A"))].into();
        let dst: PadMap = [(key("U1", "1"), pad(10.0, 10.0, "/A")), (key("U1", "2"), pad(20.0, 10.0, "/B"))].into();
        let nets = |n: &[&str]| n.iter().map(|s| s.to_string()).collect::<BTreeSet<_>>();
        assert_eq!(pad_mismatch(&src, &dst, &nets(&["/A"])), ["R1.1 /A"]);
        assert_eq!(pad_mismatch(&src, &dst, &nets(&["/B"])), ["U1.2 /B"]);
        assert!(pad_mismatch(&src, &src.clone(), &nets(&["/A", "/B"])).is_empty());
    }

    #[test]
    fn stripping_cuts_every_track_and_via_and_nothing_else() {
        let (text, removed) = without_copper(BOARD).unwrap();
        assert_eq!(removed, 3);
        assert!(text.contains("footprint") && !text.contains("segment") && !text.contains("(via") && !text.contains("(arc"));
        assert!(raw::parse(&text).is_ok());
    }

    #[test]
    fn lock_copper_keeps_uuids_and_locks_once() {
        let nets: BTreeSet<String> = ["A", "B"].map(str::to_string).into();
        let (text, kept) = lock_copper(BOARD, &nets).unwrap();
        assert_eq!(kept, 2);
        assert!(text.contains("(segment (locked yes) (start 0 0)") && text.contains("u1") && text.contains("u2") && !text.contains("u3"));
        assert_eq!(text.matches("(locked yes)").count(), 2);
    }
}
