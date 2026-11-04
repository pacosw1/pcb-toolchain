//! Polygons with holes and the point and shape tests of SHAPE_POLY_SET.
use super::{Iu, Pt, Rect};
use crate::kicad::pad::Copper;
use serde::{Deserialize, Serialize};

/// A polygon: an outline and its holes. A ring closes by its last point joining its first.
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
pub struct Polygon {
    pub outline: Vec<Pt>,
    pub holes: Vec<Vec<Pt>>,
}

/// `a * b / c` rounded to the nearest, as KiCad's rescale.
fn rescale(a: i64, b: i64, c: i64) -> i64 {
    let n = a as i128 * b as i128;
    let c = c as i128;
    let half = c.abs() / 2;
    (if (n < 0) != (c < 0) { (n - half) / c } else { (n + half) / c }) as i64
}

/// SHAPE_LINE_CHAIN::PointInside with no accuracy margin: an even-odd ray to +x, so a point on a left or top edge is inside and
/// one on a right or bottom edge is not.
fn ring_contains(ring: &[Pt], p: Pt) -> bool {
    if ring.len() < 3 {
        return false;
    }
    ring_edges(ring).filter(|&(a, b)| ray_crosses(a, b, p)).count() % 2 == 1
}

/// Does the ray to +x from `p` cross this edge? Only an edge that spans p.y can.
pub(super) fn ray_crosses(a: Pt, b: Pt, p: Pt) -> bool {
    let (dx, dy) = (b.x - a.x, b.y - a.y);
    dy != 0 && ((a.y >= p.y) != (b.y >= p.y)) && p.x - a.x < rescale(dx, p.y - a.y, dy)
}

pub(super) fn ring_edges(ring: &[Pt]) -> impl Iterator<Item = (Pt, Pt)> + '_ {
    (0..ring.len()).map(|i| (ring[i], ring[(i + 1) % ring.len()]))
}

/// SHAPE_LINE_CHAIN::Area, absolute.
fn ring_area(ring: &[Pt]) -> f64 {
    let area: f64 = ring_edges(ring).map(|(a, b)| (a.x as f64 + b.x as f64) * (a.y as f64 - b.y as f64)).sum();
    (area * 0.5).abs()
}

fn dot(a: Pt, b: Pt) -> f64 {
    a.x as f64 * b.x as f64 + a.y as f64 * b.y as f64
}

/// Squared distance from a point to a segment.
fn point_segment_sq(p: Pt, a: Pt, b: Pt) -> f64 {
    let (ab, ap) = (b - a, p - a);
    let len = dot(ab, ab);
    let t = if len == 0.0 { 0.0 } else { (dot(ap, ab) / len).clamp(0.0, 1.0) };
    let (dx, dy) = (ap.x as f64 - t * ab.x as f64, ap.y as f64 - t * ab.y as f64);
    dx * dx + dy * dy
}

fn cross(o: Pt, a: Pt, b: Pt) -> i128 {
    (a.x - o.x) as i128 * (b.y - o.y) as i128 - (a.y - o.y) as i128 * (b.x - o.x) as i128
}

fn segments_cross(a: Pt, b: Pt, c: Pt, d: Pt) -> bool {
    let (d1, d2, d3, d4) = (cross(c, d, a), cross(c, d, b), cross(a, b, c), cross(a, b, d));
    (d1.signum() * d2.signum() <= 0 && d3.signum() * d4.signum() <= 0) && (d1 != 0 || d2 != 0 || d3 != 0 || d4 != 0 || overlap_on_line(a, b, c, d))
}

/// Four collinear points: do the spans overlap?
fn overlap_on_line(a: Pt, b: Pt, c: Pt, d: Pt) -> bool {
    a.x.min(b.x) <= c.x.max(d.x) && c.x.min(d.x) <= a.x.max(b.x) && a.y.min(b.y) <= c.y.max(d.y) && c.y.min(d.y) <= a.y.max(b.y)
}

fn segment_segment_sq(a: Pt, b: Pt, c: Pt, d: Pt) -> f64 {
    if segments_cross(a, b, c, d) {
        return 0.0;
    }
    point_segment_sq(a, c, d).min(point_segment_sq(b, c, d)).min(point_segment_sq(c, a, b)).min(point_segment_sq(d, a, b))
}

impl Polygon {
    pub fn of_ring(outline: Vec<Pt>) -> Polygon {
        Polygon { outline, holes: Vec::new() }
    }

    pub fn rings(&self) -> impl Iterator<Item = &Vec<Pt>> {
        std::iter::once(&self.outline).chain(&self.holes)
    }

    fn edges(&self) -> impl Iterator<Item = (Pt, Pt)> + '_ {
        self.rings().flat_map(|r| ring_edges(r))
    }

    pub fn bbox(&self) -> Option<Rect> {
        Rect::of_points(self.outline.iter().copied())
    }

    /// SHAPE_POLY_SET::Area of this polygon, in square nanometres.
    pub fn area(&self) -> f64 {
        ring_area(&self.outline) - self.holes.iter().map(|h| ring_area(h)).sum::<f64>()
    }

    /// SHAPE_POLY_SET::Contains with accuracy 0: inside the outline and in no hole.
    pub fn contains(&self, p: Pt) -> bool {
        ring_contains(&self.outline, p) && !self.holes.iter().any(|h| ring_contains(h, p))
    }

    /// Squared distance to the polygon, 0 inside it.
    fn distance_sq(&self, p: Pt) -> f64 {
        if self.contains(p) {
            return 0.0;
        }
        self.edges().map(|(a, b)| point_segment_sq(p, a, b)).fold(f64::INFINITY, f64::min)
    }

    /// SHAPE_POLY_SET::Collide of a point with a clearance: inside, or closer than `clearance`.
    pub fn near(&self, p: Pt, clearance: Iu) -> bool {
        let d = self.distance_sq(p);
        d == 0.0 || d < (clearance as f64).powi(2)
    }

    fn segment_distance_sq(&self, a: Pt, b: Pt) -> f64 {
        if self.contains(a) && self.contains(b) {
            return 0.0;
        }
        self.edges().map(|(c, d)| segment_segment_sq(a, b, c, d)).fold(f64::INFINITY, f64::min)
    }

    /// SHAPE_POLY_SET::Collide of a segment with a clearance.
    pub fn near_segment(&self, a: Pt, b: Pt, clearance: Iu) -> bool {
        let d = self.segment_distance_sq(a, b);
        d == 0.0 || d < (clearance as f64).powi(2)
    }

    /// Do the polygons share any area or touch? Outline crossings, or one inside the other.
    pub fn overlaps(&self, other: &Polygon) -> bool {
        let crossing = self.edges().any(|(a, b)| other.edges().any(|(c, d)| segments_cross(a, b, c, d)));
        crossing || other.outline.first().is_some_and(|p| self.contains(*p)) || self.outline.first().is_some_and(|p| other.contains(*p))
    }

    /// SHAPE_POLY_SET::Collide of a piece of copper.
    pub fn collides(&self, copper: &Copper) -> bool {
        match copper {
            Copper::Circle { center, radius } => self.near(*center, *radius),
            Copper::Segment { a, b, width } => self.near_segment(*a, *b, width / 2),
            Copper::Polygon(points) => self.overlaps(&Polygon::of_ring(points.clone())),
        }
    }
}

/// Is the point on this piece of copper? The model's stand-in for PAD::HitTest with no margin.
pub fn copper_contains(copper: &Copper, p: Pt) -> bool {
    match copper {
        Copper::Circle { center, radius } => {
            let d = p - *center;
            dot(d, d) <= (*radius as f64).powi(2)
        }
        Copper::Segment { a, b, width } => point_segment_sq(p, *a, *b) <= (*width as f64 / 2.0).powi(2),
        Copper::Polygon(points) => ring_contains(points, p),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn square(x: Iu, y: Iu, side: Iu) -> Vec<Pt> {
        vec![Pt::new(x, y), Pt::new(x + side, y), Pt::new(x + side, y + side), Pt::new(x, y + side)]
    }

    #[test]
    fn contains_follows_kicads_edges() {
        let s = Polygon::of_ring(square(0, 0, 10));
        assert!(s.contains(Pt::new(5, 5)));
        assert!(s.contains(Pt::new(0, 5)));
        assert!(!s.contains(Pt::new(10, 5)));
        assert!(!s.contains(Pt::new(11, 5)));
    }

    #[test]
    fn a_point_in_a_hole_is_outside() {
        let p = Polygon { outline: square(0, 0, 10), holes: vec![square(4, 4, 2)] };
        assert!(!p.contains(Pt::new(5, 5)));
        assert!(p.contains(Pt::new(2, 5)));
    }

    #[test]
    fn near_is_strict_at_the_clearance() {
        let s = Polygon::of_ring(square(0, 0, 10));
        assert!(s.near(Pt::new(5, 5), 0));
        assert!(s.near(Pt::new(13, 5), 4));
        assert!(!s.near(Pt::new(13, 5), 3));
    }

    #[test]
    fn a_segment_collides_by_its_half_width() {
        let s = Polygon::of_ring(square(0, 0, 10));
        assert!(s.collides(&Copper::Segment { a: Pt::new(13, 0), b: Pt::new(13, 9), width: 8 }));
        assert!(!s.collides(&Copper::Segment { a: Pt::new(13, 0), b: Pt::new(13, 9), width: 6 }));
        assert!(s.collides(&Copper::Segment { a: Pt::new(-5, 5), b: Pt::new(15, 5), width: 0 }));
    }

    #[test]
    fn polygons_overlap_when_they_cross_or_nest() {
        let s = Polygon::of_ring(square(0, 0, 10));
        assert!(s.overlaps(&Polygon::of_ring(square(5, 5, 10))));
        assert!(s.overlaps(&Polygon::of_ring(square(2, 2, 2))));
        assert!(Polygon::of_ring(square(2, 2, 2)).overlaps(&s));
        assert!(!s.overlaps(&Polygon::of_ring(square(20, 20, 2))));
    }

    #[test]
    fn copper_in_a_hole_does_not_collide() {
        let p = Polygon { outline: square(0, 0, 100), holes: vec![square(40, 40, 20)] };
        assert!(!p.collides(&Copper::Circle { center: Pt::new(50, 50), radius: 5 }));
        assert!(p.collides(&Copper::Circle { center: Pt::new(50, 50), radius: 11 }));
    }

    #[test]
    fn a_point_on_copper_is_inside_it() {
        assert!(copper_contains(&Copper::Circle { center: Pt::new(0, 0), radius: 5 }, Pt::new(3, 4)));
        assert!(!copper_contains(&Copper::Segment { a: Pt::new(0, 0), b: Pt::new(10, 0), width: 2 }, Pt::new(5, 2)));
    }
}
