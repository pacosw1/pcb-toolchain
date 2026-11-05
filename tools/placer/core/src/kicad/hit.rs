//! Item tests of pcbnew on board JSON (PAD::HitTest, PCB_TRACK::HitTest, PCB_VIA::HitTest, collisions), on the shapes of
//! iotroute's geometry. tools/lib/board-hit.ts holds the same tests for the TypeScript tools.

use super::doc::{Copper, Nm, NmRect, Pad, PadCopper, Polygon, Pt, Track, Via};
use iotroute::kicad::geom::collide::{bbox_of, graphic_near_point, near_point, near_segment};
use iotroute::kicad::geom::polygon::copper_contains;
use iotroute::kicad::shape::{Arc, Geometry, Graphic};

/// A drill as PAD::GetEffectiveHoleShape: a round hole, or a slot along the longer side, turned with the pad.
fn hole_hit(pad: &Pad, p: Pt) -> bool {
    let Pt { x, y } = pad.drill;
    if x <= 0 && y <= 0 {
        return false;
    }
    let half = x.min(y) / 2;
    let leg = Pt::new(x / 2 - half, y / 2 - half).rotated(pad.orientation);
    let slot = PadCopper::Segment { a: pad.position - leg, b: pad.position + leg, width: 2 * half };
    near_point(&slot, p, 0)
}

/// PAD::HitTest at accuracy 0: the effective shape or the hole. A pad that shares its uuid has no polygons: then its copper.
pub fn pad_hit(pad: &Pad, p: Pt) -> bool {
    let copper = if pad.polygons.is_empty() { pad.copper.iter().any(|c| copper_contains(c, p)) } else { pad.polygons.values().any(|g| g.contains(p)) };
    copper || hole_hit(pad, p)
}

fn arc_of(track: &Track, mid: Pt) -> Graphic {
    Graphic { id: String::new(), geometry: Geometry::Arc(Arc::through(track.start, mid, track.end)), layer: String::new(), width: track.width, filled: false }
}

/// PCB_TRACK::HitTest and PCB_ARC::HitTest. TestSegmentHit has one nanometre of margin.
pub fn track_hit(track: &Track, p: Pt) -> bool {
    match track.mid {
        Some(mid) => graphic_near_point(&arc_of(track, mid), p, 1),
        None => near_point(&PadCopper::Segment { a: track.start, b: track.end, width: track.width }, p, 1),
    }
}

/// PCB_VIA::HitTest.
pub fn via_hit(via: &Via, p: Pt) -> bool {
    let (dx, dy) = ((p.x - via.at.x) as f64, (p.y - via.at.y) as f64);
    dx.hypot(dy) <= (via.size / 2) as f64
}

pub fn copper_hit(item: &Copper, p: Pt) -> bool {
    match item {
        Copper::Track(t) => track_hit(t, p),
        Copper::Via(v) => via_hit(v, p),
    }
}

/// GetEffectiveShape of a track or via, as pad copper: a segment, an arc as its chords, a via as a circle.
fn sticks(item: &Copper) -> Vec<PadCopper> {
    match item {
        Copper::Track(t) => t.copper(),
        Copper::Via(v) => vec![v.copper()],
    }
}

/// The box of a track or via, an arc's bend included (GetBoundingBox).
pub fn copper_box(item: &Copper) -> NmRect {
    bbox_of(&sticks(item)).expect("a track or via has copper")
}

fn stick_ends(copper: &PadCopper) -> (Pt, Pt, Nm) {
    match copper {
        PadCopper::Segment { a, b, width } => (*a, *b, (width + 1) / 2),
        PadCopper::Circle { center, radius } => (*center, *center, *radius),
        PadCopper::Polygon(ring) => (ring[0], ring[0], 0),
    }
}

/// SHAPE::Collide of a track or via with a pad's effective shape on one layer.
pub fn collides_with_polygon(item: &Copper, polygon: &Polygon, clearance: Nm) -> bool {
    sticks(item).iter().map(stick_ends).any(|(a, b, reach)| polygon.near_segment(a, b, clearance + reach))
}

/// SHAPE::Collide of a track or via with one piece of copper.
pub fn collides_with_piece(item: &Copper, piece: &PadCopper, clearance: Nm) -> bool {
    sticks(item).iter().map(stick_ends).any(|(a, b, reach)| near_segment(piece, a, b, clearance + reach))
}

/// SHAPE::Collide of two tracks or vias.
pub fn collides_with_copper(a: &Copper, b: &Copper, clearance: Nm) -> bool {
    sticks(a).iter().any(|piece| collides_with_piece(b, piece, clearance))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn square() -> Polygon {
        Polygon { outline: vec![Pt::new(0, 0), Pt::new(10, 0), Pt::new(10, 10), Pt::new(0, 10)], holes: Vec::new() }
    }

    fn track(a: (i64, i64), b: (i64, i64), width: Nm) -> Track {
        Track { id: String::new(), start: Pt::new(a.0, a.1), end: Pt::new(b.0, b.1), mid: None, width, layer: String::new(), net: String::new(), locked: false }
    }

    #[test]
    fn a_track_collides_within_its_half_width_and_the_clearance() {
        let t = Copper::Track(track((14, 0), (14, 10), 4));
        assert!(collides_with_polygon(&t, &square(), 3));
        assert!(!collides_with_polygon(&t, &square(), 2));
    }

    #[test]
    fn two_tracks_collide_edge_to_edge() {
        let (a, b) = (Copper::Track(track((0, 0), (10, 0), 2)), Copper::Track(track((0, 6), (10, 6), 2)));
        assert!(collides_with_copper(&a, &b, 5));
        assert!(!collides_with_copper(&a, &b, 4));
    }

    #[test]
    fn a_track_end_hits_within_half_its_width() {
        let t = track((0, 0), (100, 0), 20);
        assert!(track_hit(&t, Pt::new(50, 10)));
        assert!(!track_hit(&t, Pt::new(50, 12)));
    }
}
