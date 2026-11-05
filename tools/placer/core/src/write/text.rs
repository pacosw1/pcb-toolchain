//! Moves and turns as edits of board text. A footprint's items are stored relative to it, so moving one changes its `at`; a turn
//! also adds to the angles a file stores absolute (pads, texts). Everything else is in board coordinates.

use crate::kicad::doc::Pt;
use iotroute::kicad::geom::parse_iu;
use iotroute::kicad::item_text::{nm_text, quoted};
use iotroute::kicad::raw::Form;
use std::collections::HashMap;
use std::ops::Range;

/// A turn by `quarter` * 90 degrees about `origin`, then a shift: BOARD_ITEM::Rotate and Move.
#[derive(Clone, Copy, Debug)]
pub struct Transform {
    pub origin: Pt,
    pub quarter: u8,
    pub shift: Pt,
}

impl Transform {
    pub fn point(&self, p: Pt) -> Pt {
        (p - self.origin).rotated(90.0 * f64::from(self.quarter)) + self.origin + self.shift
    }

    fn turn(&self) -> f64 {
        90.0 * f64::from(self.quarter)
    }
}

/// Replacements in one text, by byte span. Spans do not overlap.
#[derive(Default)]
pub struct Changes(Vec<(Range<usize>, String)>);

impl Changes {
    pub fn put(&mut self, span: Range<usize>, text: String) {
        self.0.push((span, text));
    }

    pub fn apply(mut self, text: &str) -> String {
        self.0.sort_by_key(|(span, _)| span.start);
        let mut out = String::with_capacity(text.len());
        let mut at = 0;
        for (span, new) in self.0 {
            out += &text[at..span.start];
            out += &new;
            at = span.end;
        }
        out + &text[at..]
    }
}

fn pair(form: &Form) -> Option<Pt> {
    Some(Pt::new(parse_iu(form.text(1)?).ok()?, parse_iu(form.text(2)?).ok()?))
}

fn angle_text(deg: f64) -> String {
    format!("{}", deg.rem_euclid(360.0))
}

fn put_point(form: &Form, p: Pt, changes: &mut Changes) {
    changes.put(form.items()[1].span.clone(), nm_text(p.x));
    changes.put(form.items()[2].span.clone(), nm_text(p.y));
}

/// The angle of `(at x y [angle])` plus a turn; a form with no angle gets one after y.
fn turn_angle(at: &Form, turn: f64, changes: &mut Changes) {
    match at.items().get(3).and_then(|a| a.atom()).and_then(|a| a.parse::<f64>().ok()) {
        Some(angle) => changes.put(at.items()[3].span.clone(), angle_text(angle + turn)),
        None => {
            let end = at.items()[2].span.end;
            changes.put(end..end, format!(" {}", angle_text(turn)));
        }
    }
}

const POINT_FORMS: [&str; 6] = ["start", "end", "mid", "center", "xy", "at"];

/// Every point under a board item. An `at` of a text turns its angle too, as PCB_TEXT::Rotate.
fn board_points(form: &Form, t: &Transform, changes: &mut Changes) {
    for child in form.items() {
        if child.head().is_some_and(|h| POINT_FORMS.contains(&h)) {
            if let Some(p) = pair(child) {
                put_point(child, t.point(p), changes);
            }
            if child.is("at") && t.quarter != 0 && form.is("gr_text") {
                turn_angle(child, t.turn(), changes);
            }
        } else {
            board_points(child, t, changes);
        }
    }
}

/// A board-level item: graphic, text, zone, track or via.
pub fn move_board_item(item: &Form, t: &Transform, changes: &mut Changes) {
    board_points(item, t, changes);
}

fn turn_at_of(child: &Form, t: &Transform, changes: &mut Changes) {
    if let Some(at) = child.children("at").next() {
        turn_angle(at, t.turn(), changes);
    }
}

/// A footprint: its `at`, the angles a file stores absolute, and its zones, which a file stores in board coordinates.
pub fn move_footprint(fp: &Form, t: &Transform, changes: &mut Changes) {
    for child in fp.items() {
        if child.is("at") {
            if let Some(p) = pair(child) {
                put_point(child, t.point(p), changes);
            }
            if t.quarter != 0 {
                turn_angle(child, t.turn(), changes);
            }
        } else if child.is("zone") {
            board_points(child, t, changes);
        } else if t.quarter != 0 && (child.is("pad") || child.is("property") || child.is("fp_text")) {
            turn_at_of(child, t, changes);
        }
    }
}

/// A pad's net, which a board file stores by name: replaced, taken out with `None`, or added to a pad with none.
pub fn set_pad_net(pad: &Form, net: Option<&str>, changes: &mut Changes) {
    let new = net.map_or(String::new(), |n| format!("(net {})", quoted(n)));
    match pad.children("net").next() {
        Some(old) => changes.put(old.span.clone(), new),
        None if net.is_some() => {
            let close = pad.span.end - 1;
            changes.put(close..close, new);
        }
        None => {}
    }
}

/// The top-level items of a board by uuid.
pub fn items_by_uuid(root: &Form) -> HashMap<&str, &Form> {
    let mut out = HashMap::new();
    for item in root.items() {
        if let Some(id) = item.children("uuid").next().and_then(|u| u.text(1)) {
            out.insert(id.trim_matches('"'), item);
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use iotroute::kicad::raw::parse_first;

    fn turned(text: &str, quarter: u8) -> String {
        let form = parse_first(text).unwrap();
        let t = Transform { origin: Pt::new(1_000_000, 1_000_000), quarter, shift: Pt::new(500_000, 0) };
        let mut changes = Changes::default();
        if form.is("footprint") { move_footprint(&form, &t, &mut changes) } else { move_board_item(&form, &t, &mut changes) };
        changes.apply(text)
    }

    #[test]
    fn a_track_moves_its_ends() {
        assert_eq!(turned("(segment (start 1 1) (end 2 1) (width 0.2))", 0), "(segment (start 1.5 1) (end 2.5 1) (width 0.2))");
    }

    #[test]
    fn a_quarter_turn_follows_kicad_y_down() {
        assert_eq!(turned("(segment (start 1 1) (end 2 1))", 1), "(segment (start 1.5 1) (end 1.5 0))");
    }

    #[test]
    fn a_footprint_turns_its_at_pads_and_texts_but_not_their_places() {
        let got = turned("(footprint \"x\" (at 2 1) (property \"Reference\" \"R1\" (at 0 1 0)) (pad \"1\" smd rect (at 1 0 90)) (fp_line (start 0 0) (end 1 1)))", 1);
        assert_eq!(got, "(footprint \"x\" (at 1.5 0 90) (property \"Reference\" \"R1\" (at 0 1 90)) (pad \"1\" smd rect (at 1 0 180)) (fp_line (start 0 0) (end 1 1)))");
    }

    #[test]
    fn a_zone_in_a_footprint_is_in_board_coordinates() {
        let got = turned("(footprint \"x\" (at 1 1) (zone (polygon (pts (xy 2 2)))))", 0);
        assert_eq!(got, "(footprint \"x\" (at 1.5 1) (zone (polygon (pts (xy 2.5 2)))))");
    }

    fn with_net(text: &str, net: Option<&str>) -> String {
        let pad = parse_first(text).unwrap();
        let mut changes = Changes::default();
        set_pad_net(&pad, net, &mut changes);
        changes.apply(text)
    }

    #[test]
    fn a_pad_net_is_replaced_added_or_taken_out() {
        assert_eq!(with_net("(pad \"1\" smd (net \"/A\") (uuid \"x\"))", Some("/B")), "(pad \"1\" smd (net \"/B\") (uuid \"x\"))");
        assert_eq!(with_net("(pad \"1\" smd (uuid \"x\"))", Some("/B")), "(pad \"1\" smd (uuid \"x\")(net \"/B\"))");
        assert_eq!(with_net("(pad \"1\" smd (net \"/A\") (uuid \"x\"))", None), "(pad \"1\" smd  (uuid \"x\"))");
        assert_eq!(with_net("(pad \"1\" smd (uuid \"x\"))", None), "(pad \"1\" smd (uuid \"x\"))");
    }

    #[test]
    fn a_board_text_turns_with_the_item() {
        assert_eq!(turned("(gr_text \"A\" (at 1 1 0) (layer \"User.1\"))", 1), "(gr_text \"A\" (at 1.5 1 90) (layer \"User.1\"))");
    }
}
