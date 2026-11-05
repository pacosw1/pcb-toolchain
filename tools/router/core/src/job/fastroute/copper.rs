//! Tracks and vias straight from board text: the job holds its board as text between router passes, so counting and comparing
//! copper needs no KiCad.
use crate::kicad::geom::parse_iu;
use crate::kicad::raw::{self, Form};
use std::collections::BTreeSet;

pub type Nm = (i64, i64);

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum Kind {
    Track,
    Arc,
    Via,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Item {
    pub kind: Kind,
    pub id: String,
    pub net: String,
    /// The track's layer; a via has its top layer.
    pub layer: String,
    pub start: Nm,
    pub end: Nm,
    /// The track width or the via size.
    pub width: i64,
    pub drill: i64,
    pub locked: bool,
}

/// What makes an item the same item in two boards: its uuid may change, its geometry may not.
pub type Key = (Kind, String, String, Nm, Nm);

impl Item {
    pub fn is_via(&self) -> bool {
        self.kind == Kind::Via
    }

    pub fn key(&self) -> Key {
        (self.kind, self.net.clone(), self.layer.clone(), self.start, self.end)
    }
}

fn point(form: &Form, head: &str) -> Result<Nm, String> {
    let point = form.children(head).next().ok_or_else(|| format!("a copper item has no {head}"))?;
    let number = |index| parse_iu(point.text(index).unwrap_or_default());
    Ok((number(1)?, number(2)?))
}

fn number(form: &Form, head: &str) -> Result<i64, String> {
    parse_iu(form.children(head).next().and_then(|child| child.text(1)).ok_or_else(|| format!("a copper item has no {head}"))?)
}

fn name(form: &Form, head: &str) -> String {
    form.children(head).next().and_then(|child| child.text(1)).unwrap_or_default().to_string()
}

fn item(form: &Form, kind: Kind) -> Result<Item, String> {
    let via = kind == Kind::Via;
    let start = if via { point(form, "at")? } else { point(form, "start")? };
    Ok(Item {
        kind,
        id: name(form, "uuid"),
        net: name(form, "net"),
        layer: if via { name(form, "layers") } else { name(form, "layer") },
        start,
        end: if via { start } else { point(form, "end")? },
        width: if via { number(form, "size")? } else { number(form, "width")? },
        drill: if via { number(form, "drill")? } else { 0 },
        locked: name(form, "locked") == "yes",
    })
}

/// Every track, arc and via of a board, in file order.
pub fn read(board: &str) -> Result<Vec<Item>, String> {
    let root = raw::parse_first(board).map_err(|error| format!("board text: {error}"))?;
    let mut items = Vec::new();
    for form in root.items() {
        let kind = match form.head() {
            Some("segment") => Kind::Track,
            Some("arc") => Kind::Arc,
            Some("via") => Kind::Via,
            _ => continue,
        };
        items.push(item(form, kind)?);
    }
    Ok(items)
}

pub fn vias(items: &[Item]) -> usize {
    items.iter().filter(|item| item.is_via()).count()
}

pub fn keys(items: &[Item]) -> BTreeSet<Key> {
    items.iter().map(Item::key).collect()
}

/// What of `kept` is not in `items`, in order.
pub fn missing(items: &[Item], kept: &BTreeSet<Key>) -> Vec<Key> {
    let have = keys(items);
    kept.iter().filter(|key| !have.contains(*key)).cloned().collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    const BOARD: &str = "(kicad_pcb\n\t(segment\n\t\t(start 1 2)\n\t\t(end 3.5 2)\n\t\t(width 0.25)\n\t\t(layer \"F.Cu\")\n\t\t(locked yes)\n\t\t(net \"/A\")\n\t\t(uuid \"t\")\n\t)\n\t(via\n\t\t(at 3.5 2)\n\t\t(size 0.6)\n\t\t(drill 0.3)\n\t\t(layers \"F.Cu\" \"B.Cu\")\n\t\t(net \"/A\")\n\t\t(uuid \"v\")\n\t)\n\t(footprint \"x\")\n)\n";

    #[test]
    fn reads_tracks_and_vias_in_nanometres() {
        let items = read(BOARD).unwrap();
        assert_eq!(items.len(), 2);
        assert_eq!((items[0].start, items[0].end, items[0].width, items[0].locked), ((1_000_000, 2_000_000), (3_500_000, 2_000_000), 250_000, true));
        assert_eq!((items[1].kind, items[1].start, items[1].width, items[1].drill, items[1].locked), (Kind::Via, (3_500_000, 2_000_000), 600_000, 300_000, false));
        assert_eq!(vias(&items), 1);
    }

    #[test]
    fn missing_lists_what_is_gone_and_ignores_uuids() {
        let items = read(BOARD).unwrap();
        let kept = keys(&items);
        let mut changed = items.clone();
        changed[0].id = "other".into();
        assert!(missing(&changed, &kept).is_empty());
        assert_eq!(missing(&items[1..], &kept), vec![items[0].key()]);
    }
}
