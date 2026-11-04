//! Closed outlines from graphic items (ConvertOutlineToPolygon): the board edge and footprint courtyards. Arcs and circles become
//! the same chords as in KiCad; open items chain end to end within a tolerance; a ring inside another is its hole.
use super::boolean::{inflate, simplify};
use super::polygon::Polygon;
use super::{Iu, Pt, ki_round};
use crate::kicad::board::{Board, Footprint};
use crate::kicad::shape::{Arc, Geometry, Graphic, radius};

/// BOARD_DESIGN_SETTINGS::m_MaxError default, and the courtyard's own value: 0.005 mm.
const MAX_ERROR: Iu = 5_000;
/// DEFAULT_CHAINING_EPSILON_MM.
const BOARD_CHAINING: Iu = 10_000;
const COURTYARD_CHAINING: Iu = 20_000;
const MIN_SEGMENTS_PER_CIRCLE: f64 = 8.0;

/// GetArcToSegmentCount.
fn arc_segments(radius: f64, max_error: Iu, sweep_deg: f64) -> i64 {
    let rel_error = max_error.max(1) as f64 / radius.max(1.0);
    let increment = ((1.0 - rel_error).acos() * 2.0).to_degrees().min(360.0 / MIN_SEGMENTS_PER_CIRCLE);
    ((sweep_deg.abs() / increment).round() as i64).max(2)
}

/// CircleToEndSegmentDeltaRadius.
fn delta_radius(radius: f64, segments: i64) -> f64 {
    let segments = segments.max(3) as f64;
    let alpha = std::f64::consts::PI / segments;
    radius / alpha.cos() - radius
}

/// SHAPE_ARC::ConvertToPolyline: the ends stay on the arc and the chords share the error on both sides of it.
fn arc_points(arc: &Arc, width: Iu) -> Vec<Pt> {
    let (start_deg, sweep) = (arc.start_angle(), arc.sweep());
    let r = arc.radius() as f64;
    let n = arc_segments(r + width as f64 / 2.0, MAX_ERROR, sweep);
    let error = delta_radius(r + width as f64 / 2.0, (n as f64 * 360.0 / sweep.abs()) as i64);
    let rr = r + error / 2.0;
    let mut out = vec![arc.start];
    for i in (1..n * 2).step_by(2) {
        let a = (start_deg + sweep * i as f64 / (n * 2) as f64).to_radians();
        out.push(Pt::new(ki_round(arc.center.x as f64 + rr * a.cos()), ki_round(arc.center.y as f64 + rr * a.sin())));
    }
    out.push(arc.end);
    out
}

/// TransformCircleToPolygon with the error outside, as outlines want.
fn circle_points(center: Pt, r: Iu) -> Vec<Pt> {
    let n = arc_segments(r as f64, MAX_ERROR, 360.0).max(6);
    (0..n).map(|i| {
        let a = (i as f64 * 360.0 / n as f64).to_radians();
        Pt::new(ki_round(center.x as f64 + r as f64 * a.cos()), ki_round(center.y as f64 + r as f64 * a.sin()))
    }).collect()
}

enum Piece {
    Closed(Vec<Pt>),
    Open(Vec<Pt>),
}

fn pieces(g: &Graphic) -> Vec<Piece> {
    match &g.geometry {
        Geometry::Segment { start, end } => vec![Piece::Open(vec![*start, *end])],
        Geometry::Arc(a) => vec![Piece::Open(arc_points(a, 0))],
        Geometry::Rect { top_left: a, bottom_right: b } => vec![Piece::Closed(vec![*a, Pt::new(b.x, a.y), *b, Pt::new(a.x, b.y)])],
        Geometry::Circle { center, radius_point } => vec![Piece::Closed(circle_points(*center, radius(*center, *radius_point)))],
        Geometry::Poly { rings } => rings.iter().cloned().map(Piece::Closed).collect(),
        Geometry::Other => Vec::new(),
    }
}

fn close(a: Pt, b: Pt, tolerance: Iu) -> bool {
    let (dx, dy) = ((a.x - b.x) as f64, (a.y - b.y) as f64);
    dx.hypot(dy) <= tolerance as f64
}

/// Takes the open piece that continues from `tip`, turned to run away from it.
fn next_piece(open: &mut Vec<Vec<Pt>>, tip: Pt, tolerance: Iu) -> Option<Vec<Pt>> {
    let at = open.iter().position(|p| close(p[0], tip, tolerance) || close(p[p.len() - 1], tip, tolerance))?;
    let mut piece = open.swap_remove(at);
    if !close(piece[0], tip, tolerance) {
        piece.reverse();
    }
    Some(piece)
}

/// Open pieces joined into rings. A chain that does not close is an error, as in KiCad.
fn chain(mut open: Vec<Vec<Pt>>, tolerance: Iu) -> Result<Vec<Vec<Pt>>, String> {
    let mut rings = Vec::new();
    while let Some(first) = open.pop() {
        let start = first[0];
        let mut ring = first;
        while !close(ring[ring.len() - 1], start, tolerance) || ring.len() < 3 {
            let tip = ring[ring.len() - 1];
            let next = next_piece(&mut open, tip, tolerance).ok_or_else(|| format!("outline does not close at ({}, {})", tip.x, tip.y))?;
            ring.extend(next.into_iter().skip(1));
        }
        ring.pop();
        rings.push(ring);
    }
    Ok(rings)
}

fn area(ring: &[Pt]) -> f64 {
    (0..ring.len()).map(|i| {
        let (a, b) = (ring[i], ring[(i + 1) % ring.len()]);
        a.x as f64 * b.y as f64 - b.x as f64 * a.y as f64
    }).sum::<f64>().abs() / 2.0
}

/// Rings from largest to smallest: a ring inside a polygon so far is its hole, any other starts a polygon.
fn nest(mut rings: Vec<Vec<Pt>>) -> Vec<Polygon> {
    rings.sort_by(|a, b| area(b).total_cmp(&area(a)));
    let mut out: Vec<Polygon> = Vec::new();
    for ring in rings {
        match out.iter_mut().find(|p| Polygon::of_ring(p.outline.clone()).contains(ring[0])) {
            Some(parent) => parent.holes.push(ring),
            None => out.push(Polygon::of_ring(ring)),
        }
    }
    out
}

fn polygons_of<'a>(items: impl Iterator<Item = &'a Graphic>, tolerance: Iu) -> Result<Vec<Polygon>, String> {
    let (mut closed, mut open) = (Vec::new(), Vec::new());
    for piece in items.flat_map(pieces) {
        match piece {
            Piece::Closed(r) => closed.push(r),
            Piece::Open(p) => open.push(p),
        }
    }
    closed.extend(chain(open, tolerance)?);
    Ok(nest(closed))
}

/// BOARD::GetBoardPolygonOutlines: the Edge.Cuts outlines with their holes, simplified. Empty when the board has no closed edge.
pub fn board_outlines(board: &Board) -> Result<Vec<Polygon>, String> {
    simplify(&polygons_of(board.graphics_on("Edge.Cuts"), BOARD_CHAINING)?)
}

/// FOOTPRINT::GetCourtyard on one side: drawn in by the arc error so touching courtyards stay legal.
pub fn courtyard(footprint: &Footprint, back: bool) -> Result<Vec<Polygon>, String> {
    let layer = if back { "B.CrtYd" } else { "F.CrtYd" };
    let items = footprint.graphics.iter().filter(|g| g.layer == layer);
    let polygons = polygons_of(items, COURTYARD_CHAINING)?;
    if polygons.is_empty() {
        return Ok(polygons);
    }
    inflate(&polygons, -MAX_ERROR, MAX_ERROR)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn line(a: (Iu, Iu), b: (Iu, Iu)) -> Graphic {
        Graphic { geometry: Geometry::Segment { start: Pt::new(a.0, a.1), end: Pt::new(b.0, b.1) }, layer: "F.CrtYd".to_string(), width: 50_000, filled: false }
    }

    fn rect(a: (Iu, Iu), b: (Iu, Iu)) -> Graphic {
        Graphic { geometry: Geometry::Rect { top_left: Pt::new(a.0, a.1), bottom_right: Pt::new(b.0, b.1) }, layer: "F.CrtYd".to_string(), width: 50_000, filled: false }
    }

    #[test]
    fn lines_chain_into_a_ring_in_any_order_and_direction() {
        let items = [line((0, 0), (10, 0)), line((10, 10), (0, 10)), line((10, 10), (10, 0)), line((0, 10), (0, 0))];
        let p = polygons_of(items.iter(), 1).unwrap();
        assert_eq!((p.len(), p[0].outline.len()), (1, 4));
    }

    #[test]
    fn chaining_bridges_a_gap_within_the_tolerance_only() {
        let items = [line((0, 0), (10, 0)), line((10, 2), (10, 10)), line((10, 10), (0, 10)), line((0, 10), (0, 0))];
        assert!(polygons_of(items.iter(), 3).is_ok());
        assert!(polygons_of(items.iter(), 1).is_err());
    }

    #[test]
    fn a_ring_inside_a_ring_is_a_hole() {
        let items = [rect((0, 0), (100, 100)), rect((10, 10), (20, 20)), rect((200, 0), (210, 10))];
        let p = polygons_of(items.iter(), 1).unwrap();
        assert_eq!(p.len(), 2);
        assert_eq!(p[0].holes.len(), 1);
    }

    #[test]
    fn an_arc_keeps_its_ends_and_stays_near_the_circle() {
        let a = Arc::through(Pt::new(1_000_000, 0), Pt::new(707_107, 707_107), Pt::new(0, 1_000_000));
        let pts = arc_points(&a, 0);
        assert_eq!((pts[0], pts[pts.len() - 1]), (a.start, a.end));
        for p in &pts[1..pts.len() - 1] {
            assert!((((p.x as f64).hypot(p.y as f64)) - 1e6).abs() < MAX_ERROR as f64);
        }
    }

    #[test]
    fn a_courtyard_is_drawn_in_by_the_error() {
        let fp = Footprint { graphics: vec![rect((0, 0), (1_000_000, 1_000_000))], ..Footprint::default() };
        let c = courtyard(&fp, false).unwrap();
        let b = c[0].bbox().unwrap();
        assert_eq!((b.left, b.right), (5_000, 995_000));
        assert!(courtyard(&fp, true).unwrap().is_empty());
    }
}
