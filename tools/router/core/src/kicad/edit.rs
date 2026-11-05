//! New copper and copper to take out, as typed data, applied to board text. kicad::save then has KiCad 10 put it in its place.
use super::geom::{Iu, Pt};
use super::item_text::{board_nets, copper_layers, item_uuid, locked_net_line, net_line, nm_text, quoted, segment_text, via_text, with_items};
use super::raw::{Form, parse};
use std::collections::HashSet;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NewTrack {
    pub start: Pt,
    pub end: Pt,
    pub width: Iu,
    pub layer: String,
    pub net: String,
    pub locked: bool,
}

/// A through via.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NewVia {
    pub at: Pt,
    pub size: Iu,
    pub drill: Iu,
    pub net: String,
    pub locked: bool,
}

/// What a tool changes on a board.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct Edit {
    pub tracks: Vec<NewTrack>,
    pub vias: Vec<NewVia>,
    /// Uuids of tracks, arcs and vias to take out.
    pub removed: HashSet<String>,
}

fn point_text(p: Pt) -> String {
    format!("{} {}", nm_text(p.x), nm_text(p.y))
}

fn net_text(net: &str, locked: bool) -> String {
    if locked { locked_net_line(net) } else { net_line(net) }
}

/// The byte ranges of the removed items of a board, with the line each stands on.
fn removed_spans(board: &str, removed: &HashSet<String>) -> Result<Vec<std::ops::Range<usize>>, String> {
    let forms = parse(board)?;
    let root = forms.first().ok_or("an empty board file")?;
    let copper = |f: &&Form| f.is("segment") || f.is("arc") || f.is("via");
    let gone = |f: &Form| f.children("uuid").next().and_then(|u| u.text(1)).is_some_and(|id| removed.contains(id));
    let line_start = |at: usize| board[..at].rfind('\n').map_or(0, |i| i + 1);
    let line_end = |at: usize| board[at..].find('\n').map_or(board.len(), |i| at + i + 1);
    Ok(root.items().iter().filter(copper).filter(|f| gone(f)).map(|f| line_start(f.span.start)..line_end(f.span.end)).collect())
}

fn without(board: &str, spans: &[std::ops::Range<usize>]) -> String {
    let mut out = String::with_capacity(board.len());
    let mut at = 0;
    for span in spans {
        out += &board[at..span.start];
        at = span.end;
    }
    out + &board[at..]
}

impl Edit {
    pub fn is_empty(&self) -> bool {
        self.tracks.is_empty() && self.vias.is_empty() && self.removed.is_empty()
    }

    /// The items as board text. A net or layer the board does not have stops the edit: it was made for another board.
    fn items_text(&self, board: &str, seed: &str) -> Result<String, String> {
        let (nets, layers) = (board_nets(board), copper_layers(board)?);
        let known = |net: &str| if net.is_empty() || nets.contains(&quoted(net)) { Ok(()) } else { Err(format!("net {} is not on the board", quoted(net))) };
        let mut out = String::new();
        for (n, t) in self.tracks.iter().enumerate() {
            let layer = quoted(&t.layer);
            if !layers.contains(&layer) {
                return Err(format!("layer {layer} is not on the board"));
            }
            known(&t.net)?;
            out += &segment_text(&point_text(t.start), &point_text(t.end), &nm_text(t.width), &layer, &net_text(&t.net, t.locked), &item_uuid(seed, n));
        }
        for (n, v) in self.vias.iter().enumerate() {
            known(&v.net)?;
            out += &via_text(&point_text(v.at), &nm_text(v.size), &nm_text(v.drill), &net_text(&v.net, v.locked), &item_uuid(seed, self.tracks.len() + n));
        }
        Ok(out)
    }

    /// The board text with the edit done. `seed` makes the new uuids: the same input gives the same file.
    pub fn apply(&self, board: &str, seed: &str) -> Result<String, String> {
        let kept = if self.removed.is_empty() { board.to_string() } else { without(board, &removed_spans(board, &self.removed)?) };
        with_items(&kept, &self.items_text(board, seed)?)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const BOARD: &str = "(kicad_pcb\n\t(layers\n\t\t(0 \"F.Cu\" signal)\n\t)\n\t(footprint \"a\"\n\t\t(pad \"1\" smd rect (net \"/A\"))\n\t)\n\t(segment\n\t\t(start 0 0)\n\t\t(end 1 0)\n\t\t(uuid \"gone\")\n\t)\n\t(via\n\t\t(at 1 0)\n\t\t(uuid \"kept\")\n\t)\n)\n";

    fn track(net: &str, layer: &str, locked: bool) -> NewTrack {
        NewTrack { start: Pt::new(1_000_000, 2_500_000), end: Pt::new(3_000_000, 2_500_000), width: 200_000, layer: layer.to_string(), net: net.to_string(), locked }
    }

    #[test]
    fn new_items_are_written_in_nanometres_with_their_lock() {
        let edit = Edit { tracks: vec![track("/A", "F.Cu", true)], vias: vec![NewVia { at: Pt::new(3_000_000, 2_500_000), size: 600_000, drill: 300_000, net: "/A".to_string(), locked: false }], ..Edit::default() };
        let t = edit.apply(BOARD, "seed").unwrap();
        assert!(t.contains("(start 1 2.5)\n\t\t(end 3 2.5)\n\t\t(width 0.2)\n\t\t(layer \"F.Cu\")\n\t\t(locked yes)\n\t\t(net \"/A\")"), "{t}");
        assert!(t.contains("(at 3 2.5)\n\t\t(size 0.6)\n\t\t(drill 0.3)\n\t\t(layers \"F.Cu\" \"B.Cu\")\n\t\t(net \"/A\")"), "{t}");
    }

    #[test]
    fn items_are_taken_out_by_uuid_with_their_lines() {
        let edit = Edit { removed: ["gone".to_string()].into_iter().collect(), ..Edit::default() };
        let t = edit.apply(BOARD, "seed").unwrap();
        assert!(!t.contains("gone") && t.contains("\"kept\"") && t.contains("(pad \"1\""), "{t}");
        assert!(parse(&t).is_ok());
    }

    #[test]
    fn a_net_or_layer_of_another_board_stops_the_edit() {
        assert!(Edit { tracks: vec![track("/GONE", "F.Cu", false)], ..Edit::default() }.apply(BOARD, "s").unwrap_err().contains("/GONE"));
        assert!(Edit { tracks: vec![track("/A", "In1.Cu", false)], ..Edit::default() }.apply(BOARD, "s").unwrap_err().contains("In1.Cu"));
    }
}
