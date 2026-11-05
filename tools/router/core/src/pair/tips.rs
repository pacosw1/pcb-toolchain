//! The free ends of a net's tracks: where a pair route starts and stops.
use super::Point;
use crate::grid::astar::exact_hypot;
use crate::kicad::board::{Board, Track};
use crate::kicad::geom::polygon::copper_contains;
use crate::kicad::geom::{Pt, to_mm};
use crate::kicad::pad::Pad;

/// Two track ends closer than this touch.
const TOUCH_MM: f64 = 0.01;

/// A free track end.
#[derive(Debug, Clone, PartialEq)]
pub struct Tip {
    pub at: Point,
    /// A unit vector along the track, out of its free end.
    pub out: Point,
    /// The uuid of the track.
    pub track: String,
}

fn mm(p: Pt) -> Point {
    (to_mm(p.x), to_mm(p.y))
}

fn close(a: Point, b: Point) -> bool {
    exact_hypot(a.0 - b.0, a.1 - b.1) < TOUCH_MM
}

fn on_pad(pad: &Pad, p: Pt) -> bool {
    pad.copper.iter().any(|copper| copper_contains(copper, p))
}

/// Track ends on `layer` that touch no other item of the net.
pub fn free_tips(board: &Board, net: &str, layer: &str) -> Vec<Tip> {
    // Arcs do not end a pair; a track of no length has no direction to leave along.
    let tracks: Vec<&Track> = board.tracks().filter(|t| t.net == net && t.mid.is_none() && t.start != t.end).collect();
    let ends: Vec<(Pt, Pt, usize)> = tracks.iter().enumerate().flat_map(|(k, t)| [(t.start, t.end, k), (t.end, t.start, k)]).collect();
    let vias: Vec<Point> = board.vias().filter(|v| v.net == net).map(|v| mm(v.at)).collect();
    let pads: Vec<&Pad> = board.pads().map(|(_, pad)| pad).filter(|p| p.net == net && p.layers.iter().any(|l| l == layer)).collect();
    let mut tips = Vec::new();
    for &(end, other, k) in ends.iter().filter(|(_, _, k)| tracks[*k].layer == layer) {
        let at = mm(end);
        let touching = ends.iter().any(|&(e, _, o)| o != k && close(at, mm(e))) || vias.iter().any(|&v| close(at, v));
        if touching || pads.iter().any(|pad| on_pad(pad, end)) {
            continue;
        }
        let (dx, dy) = (to_mm(end.x - other.x), to_mm(end.y - other.y));
        let n = exact_hypot(dx, dy);
        tips.push(Tip { at, out: (dx / n, dy / n), track: tracks[k].id.clone() });
    }
    tips
}
