//! SHAPE::Collide with a clearance, for copper primitives and graphic items. A hit is a distance of 0 or one under the clearance,
//! never one equal to it, so a part placed exactly on the clearance stays legal as it does in KiCad.
use super::polygon::{point_segment_sq, ring_contains, ring_edges, segment_segment_sq};
use super::{Iu, Pt, Rect};
use crate::kicad::pad::Copper;
use crate::kicad::shape::{Arc, Geometry, Graphic, radius};

fn hit(distance_sq: f64, reach: Iu) -> bool {
    distance_sq == 0.0 || distance_sq < (reach as f64).powi(2)
}

fn distance(a: Pt, b: Pt) -> f64 {
    ((a.x - b.x) as f64).hypot((a.y - b.y) as f64)
}

/// A ring of copper against a segment: inside it, or closer to an edge than `clearance`.
fn ring_near_segment(ring: &[Pt], a: Pt, b: Pt, clearance: Iu) -> bool {
    ring_contains(ring, a) || ring_edges(ring).any(|(c, d)| hit(segment_segment_sq(a, b, c, d), clearance))
}

/// SHAPE::Collide of a zero-width segment with a clearance.
pub fn near_segment(copper: &Copper, a: Pt, b: Pt, clearance: Iu) -> bool {
    match copper {
        Copper::Circle { center, radius } => hit(point_segment_sq(*center, a, b), radius + clearance),
        Copper::Segment { a: c, b: d, width } => hit(segment_segment_sq(a, b, *c, *d), (width + 1) / 2 + clearance),
        Copper::Polygon(ring) => ring_near_segment(ring, a, b, clearance),
    }
}

/// SHAPE::Collide of a point with a clearance.
pub fn near_point(copper: &Copper, p: Pt, clearance: Iu) -> bool {
    near_segment(copper, p, p, clearance)
}

/// The box of pieces of copper, for a quick miss before the exact test.
pub fn bbox_of(copper: &[Copper]) -> Option<Rect> {
    copper.iter().map(Copper::bbox).reduce(Rect::merged)
}

/// A point at `reach` from the box or further cannot hit what is inside it.
pub fn beyond(bbox: &Rect, a: Pt, b: Pt, reach: Iu) -> bool {
    a.x.max(b.x) + reach < bbox.left || a.x.min(b.x) - reach > bbox.right || a.y.max(b.y) + reach < bbox.top || a.y.min(b.y) - reach > bbox.bottom
}

/// Distance from a point to an arc: to the circle inside its sweep, else to the nearer end.
fn arc_distance(arc: &Arc, p: Pt) -> f64 {
    let d = p - arc.center;
    let angle = (d.y as f64).atan2(d.x as f64).to_degrees();
    let (start, sweep) = (arc.start_angle(), arc.sweep());
    let turned = if sweep >= 0.0 { (angle - start).rem_euclid(360.0) } else { (start - angle).rem_euclid(360.0) };
    if turned <= sweep.abs() {
        (distance(p, arc.center) - arc.radius() as f64).abs()
    } else {
        distance(p, arc.start).min(distance(p, arc.end))
    }
}

/// EDA_SHAPE's effective shape against a point: its line at its width, and the area when it is filled.
pub fn graphic_near_point(g: &Graphic, p: Pt, clearance: Iu) -> bool {
    let reach = clearance + g.width / 2;
    let edge = |ring: &[Pt]| ring_edges(ring).any(|(a, b)| hit(point_segment_sq(p, a, b), reach));
    let solid = |ring: &[Pt]| g.filled && ring_contains(ring, p);
    match &g.geometry {
        Geometry::Segment { start, end } => hit(point_segment_sq(p, *start, *end), clearance + (g.width + 1) / 2),
        Geometry::Rect { top_left: a, bottom_right: b } => {
            let ring = [*a, Pt::new(b.x, a.y), *b, Pt::new(a.x, b.y)];
            solid(&ring) || edge(&ring)
        }
        Geometry::Circle { center, radius_point } => {
            let (d, r) = (distance(p, *center), radius(*center, *radius_point) as f64);
            if g.filled { d < r + reach as f64 } else { (d - r).abs() < reach as f64 }
        }
        Geometry::Arc(arc) => arc_distance(arc, p) < reach as f64,
        Geometry::Poly { rings } => rings.iter().any(|r| solid(r) || edge(r)),
        Geometry::Other => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn square() -> Copper {
        Copper::Polygon(vec![Pt::new(0, 0), Pt::new(10, 0), Pt::new(10, 10), Pt::new(0, 10)])
    }

    #[test]
    fn a_hit_is_under_the_clearance_never_equal_to_it() {
        assert!(near_point(&square(), Pt::new(13, 5), 4));
        assert!(!near_point(&square(), Pt::new(13, 5), 3));
        assert!(near_point(&square(), Pt::new(5, 5), 0));
        let via = Copper::Circle { center: Pt::new(0, 0), radius: 5 };
        assert!(near_point(&via, Pt::new(6, 8), 6));
        assert!(!near_point(&via, Pt::new(6, 8), 5));
    }

    #[test]
    fn a_track_counts_half_its_width_rounded_up() {
        let t = Copper::Segment { a: Pt::new(0, 0), b: Pt::new(10, 0), width: 3 };
        assert!(near_point(&t, Pt::new(5, 3), 2));
        assert!(!near_point(&t, Pt::new(5, 3), 1));
    }

    #[test]
    fn a_segment_finds_copper_a_point_at_its_end_would_miss() {
        let via = Copper::Circle { center: Pt::new(50, 0), radius: 5 };
        assert!(near_segment(&via, Pt::new(0, 0), Pt::new(100, 0), 0));
        assert!(!near_point(&via, Pt::new(0, 0), 0));
    }

    #[test]
    fn a_box_rules_out_only_what_is_out_of_reach() {
        let b = square().bbox();
        assert!(beyond(&b, Pt::new(20, 5), Pt::new(20, 5), 9));
        assert!(!beyond(&b, Pt::new(20, 5), Pt::new(20, 5), 10));
    }

    #[test]
    fn a_graphic_keeps_its_line_width() {
        let line = Graphic { geometry: Geometry::Segment { start: Pt::new(0, 0), end: Pt::new(100, 0) }, layer: "Edge.Cuts".to_string(), width: 10, filled: false };
        assert!(graphic_near_point(&line, Pt::new(50, 14), 10));
        assert!(!graphic_near_point(&line, Pt::new(50, 15), 10));
    }

    #[test]
    fn an_open_circle_has_a_clear_middle_and_a_filled_one_does_not() {
        let circle = |filled| Graphic { geometry: Geometry::Circle { center: Pt::new(0, 0), radius_point: Pt::new(100, 0) }, layer: "Edge.Cuts".to_string(), width: 0, filled };
        assert!(!graphic_near_point(&circle(false), Pt::new(0, 0), 10));
        assert!(graphic_near_point(&circle(true), Pt::new(0, 0), 10));
        assert!(graphic_near_point(&circle(false), Pt::new(95, 0), 10));
    }

    #[test]
    fn an_arc_ends_where_it_ends() {
        let arc = Arc::through(Pt::new(100, 0), Pt::new(71, 71), Pt::new(0, 100));
        let g = Graphic { geometry: Geometry::Arc(arc), layer: "Edge.Cuts".to_string(), width: 0, filled: false };
        assert!(graphic_near_point(&g, Pt::new(71, 75), 10));
        assert!(!graphic_near_point(&g, Pt::new(-71, -71), 10));
    }
}
