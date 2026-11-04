//! Point and shape tests on board copper, in whole nanometres, following pcbnew (PAD::HitTest, PCB_TRACK::HitTest,
//! BOARD_ITEM collisions). tools/lib/board-hit.ts holds the same tests for the TypeScript tools.

use super::doc::{Copper, Nm, Pad, PadCopper, Polygon, Pt, Track, Via};

fn dot(a: (f64, f64), b: (f64, f64)) -> f64 {
    a.0 * b.0 + a.1 * b.1
}

fn minus(a: Pt, b: Pt) -> (f64, f64) {
    ((a.x - b.x) as f64, (a.y - b.y) as f64)
}

/// Squared distance from a point to a segment.
pub fn point_segment_sq(p: Pt, a: Pt, b: Pt) -> f64 {
    let (ab, ap) = (minus(b, a), minus(p, a));
    let length = dot(ab, ab);
    let t = if length == 0.0 { 0.0 } else { (dot(ap, ab) / length).clamp(0.0, 1.0) };
    let (dx, dy) = (ap.0 - t * ab.0, ap.1 - t * ab.1);
    dx * dx + dy * dy
}

fn side(o: Pt, a: Pt, b: Pt) -> i128 {
    (a.x - o.x) as i128 * (b.y - o.y) as i128 - (a.y - o.y) as i128 * (b.x - o.x) as i128
}

fn on_span(a: Pt, b: Pt, p: Pt) -> bool {
    p.x >= a.x.min(b.x) && p.x <= a.x.max(b.x) && p.y >= a.y.min(b.y) && p.y <= a.y.max(b.y)
}

fn segments_cross(a: Pt, b: Pt, c: Pt, d: Pt) -> bool {
    let (d1, d2, d3, d4) = (side(c, d, a), side(c, d, b), side(a, b, c), side(a, b, d));
    if d1.signum() * d2.signum() < 0 && d3.signum() * d4.signum() < 0 {
        return true;
    }
    (d1 == 0 && on_span(c, d, a)) || (d2 == 0 && on_span(c, d, b)) || (d3 == 0 && on_span(a, b, c)) || (d4 == 0 && on_span(a, b, d))
}

pub fn segment_segment_sq(a: Pt, b: Pt, c: Pt, d: Pt) -> f64 {
    if segments_cross(a, b, c, d) {
        return 0.0;
    }
    point_segment_sq(a, c, d).min(point_segment_sq(b, c, d)).min(point_segment_sq(c, a, b)).min(point_segment_sq(d, a, b))
}

/// `a * b / c` rounded to the nearest, as KiCad's rescale.
fn rescale(a: Nm, b: Nm, c: Nm) -> i128 {
    let (n, d) = (a as i128 * b as i128, c as i128);
    let half = d.abs() / 2;
    if (n < 0) != (d < 0) { (n - half) / d } else { (n + half) / d }
}

/// SHAPE_LINE_CHAIN::PointInside with no accuracy margin: an even-odd ray to +x.
pub fn ring_contains(ring: &[Pt], p: Pt) -> bool {
    if ring.len() < 3 {
        return false;
    }
    let mut inside = false;
    for (i, a) in ring.iter().enumerate() {
        let b = ring[(i + 1) % ring.len()];
        if a.y != b.y && (a.y >= p.y) != (b.y >= p.y) && ((p.x - a.x) as i128) < rescale(b.x - a.x, p.y - a.y, b.y - a.y) {
            inside = !inside;
        }
    }
    inside
}

pub fn polygon_contains(polygon: &Polygon, p: Pt) -> bool {
    ring_contains(&polygon.outline, p) && !polygon.holes.iter().any(|h| ring_contains(h, p))
}

fn copper_contains(copper: &PadCopper, p: Pt) -> bool {
    match copper {
        PadCopper::Circle { center, radius } => {
            let v = minus(p, *center);
            dot(v, v) <= (*radius as f64).powi(2)
        }
        PadCopper::Segment { a, b, width } => point_segment_sq(p, *a, *b) <= (*width as f64 / 2.0).powi(2),
        PadCopper::Polygon(ring) => ring_contains(ring, p),
    }
}

/// A drill as PAD::GetEffectiveHoleShape: a round hole, or a slot along the longer side, turned with the pad.
fn hole_hit(pad: &Pad, p: Pt) -> bool {
    let Pt { x, y } = pad.drill;
    if x <= 0 && y <= 0 {
        return false;
    }
    let half = x.min(y) / 2;
    let (sin, cos) = pad.orientation.to_radians().sin_cos();
    let (leg_x, leg_y) = ((x / 2 - half) as f64, (y / 2 - half) as f64);
    let leg = Pt { x: (leg_y * sin + leg_x * cos).round() as Nm, y: (leg_y * cos - leg_x * sin).round() as Nm };
    let a = Pt { x: pad.position.x - leg.x, y: pad.position.y - leg.y };
    let b = Pt { x: pad.position.x + leg.x, y: pad.position.y + leg.y };
    let distance = point_segment_sq(p, a, b);
    distance == 0.0 || distance < (half as f64).powi(2)
}

/// PAD::HitTest at accuracy 0: the effective shape or the hole. A pad that shares its uuid has no polygons: then its copper.
pub fn pad_hit(pad: &Pad, p: Pt) -> bool {
    let copper = if pad.polygons.is_empty() { pad.copper.iter().any(|c| copper_contains(c, p)) } else { pad.polygons.values().any(|g| polygon_contains(g, p)) };
    copper || hole_hit(pad, p)
}

fn circle_centre(a: Pt, b: Pt, c: Pt) -> (f64, f64) {
    let (ab, ac) = (minus(b, a), minus(c, a));
    let d = 2.0 * (ab.0 * ac.1 - ab.1 * ac.0);
    let (ab_sq, ac_sq) = (dot(ab, ab), dot(ac, ac));
    (a.x as f64 + (ac.1 * ab_sq - ab.1 * ac_sq) / d, a.y as f64 + (ab.0 * ac_sq - ac.0 * ab_sq) / d)
}

fn normalize180(deg: f64) -> f64 {
    let d = deg.rem_euclid(360.0);
    if d > 180.0 { d - 360.0 } else { d }
}

/// PCB_ARC::HitTest.
fn arc_hit(track: &Track, mid: Pt, p: Pt) -> bool {
    let reach = track.width as f64 / 2.0;
    let near = |e: Pt| {
        let v = minus(e, p);
        dot(v, v).sqrt() <= reach
    };
    if near(track.start) || near(track.end) {
        return true;
    }
    let centre = circle_centre(track.start, mid, track.end);
    let from = |q: Pt| (q.x as f64 - centre.0, q.y as f64 - centre.1);
    let angle = |v: (f64, f64)| v.1.atan2(v.0).to_degrees();
    let (start, middle, end, at) = (from(track.start), from(mid), from(track.end), from(p));
    if (dot(at, at).sqrt().trunc() - dot(start, start).sqrt()).abs() > reach {
        return false;
    }
    let sweep = normalize180(angle(middle) - angle(start)) + normalize180(angle(end) - angle(middle));
    let hit = (angle(at) - angle(start).rem_euclid(360.0)).rem_euclid(360.0);
    if sweep < 0.0 { hit >= 360.0 + sweep } else { hit <= sweep }
}

/// PCB_TRACK::HitTest and PCB_ARC::HitTest.
pub fn track_hit(track: &Track, p: Pt) -> bool {
    match track.mid {
        Some(mid) => arc_hit(track, mid, p),
        None => point_segment_sq(p, track.start, track.end) < ((track.width / 2 + 1) as f64).powi(2),
    }
}

/// PCB_VIA::HitTest.
pub fn via_hit(via: &Via, p: Pt) -> bool {
    let v = minus(p, via.at);
    dot(v, v) <= ((via.size / 2) as f64).powi(2)
}

pub fn copper_hit(item: &Copper, p: Pt) -> bool {
    match item {
        Copper::Track(t) => track_hit(t, p),
        Copper::Via(v) => via_hit(v, p),
    }
}

/// One piece of copper as stick and radius: every shape the writer tests is a set of these or a polygon.
#[derive(Clone, Debug)]
pub enum Shape {
    Stick { a: Pt, b: Pt, radius: Nm },
    Polygon(Polygon),
}

fn edges(polygon: &Polygon) -> Vec<(Pt, Pt)> {
    let ring = |r: &[Pt]| -> Vec<(Pt, Pt)> { (0..r.len()).map(|i| (r[i], r[(i + 1) % r.len()])).collect() };
    std::iter::once(&polygon.outline).chain(&polygon.holes).flat_map(|r| ring(r)).collect()
}

fn polygon_stick_sq(polygon: &Polygon, a: Pt, b: Pt) -> f64 {
    if polygon_contains(polygon, a) || polygon_contains(polygon, b) {
        return 0.0;
    }
    edges(polygon).iter().map(|(c, d)| segment_segment_sq(a, b, *c, *d)).fold(f64::INFINITY, f64::min)
}

fn polygons_gap_sq(p: &Polygon, q: &Polygon) -> f64 {
    let inside = |a: &Polygon, b: &Polygon| b.outline.first().is_some_and(|v| polygon_contains(a, *v));
    if inside(p, q) || inside(q, p) {
        return 0.0;
    }
    let (ep, eq) = (edges(p), edges(q));
    ep.iter().flat_map(|(a, b)| eq.iter().map(move |(c, d)| segment_segment_sq(*a, *b, *c, *d))).fold(f64::INFINITY, f64::min)
}

/// SHAPE::Collide: closer than the clearance, edge to edge.
pub fn shapes_collide(a: &Shape, b: &Shape, clearance: Nm) -> bool {
    let (distance_sq, reach) = match (a, b) {
        (Shape::Stick { a, b, radius }, Shape::Stick { a: c, b: d, radius: r }) => (segment_segment_sq(*a, *b, *c, *d), clearance + radius + r),
        (Shape::Stick { a, b, radius }, Shape::Polygon(p)) | (Shape::Polygon(p), Shape::Stick { a, b, radius }) => (polygon_stick_sq(p, *a, *b), clearance + radius),
        (Shape::Polygon(p), Shape::Polygon(q)) => (polygons_gap_sq(p, q), clearance),
    };
    distance_sq == 0.0 || distance_sq < (reach as f64).powi(2)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn pt(x: Nm, y: Nm) -> Pt {
        Pt { x, y }
    }

    fn square() -> Polygon {
        Polygon { outline: vec![pt(0, 0), pt(10, 0), pt(10, 10), pt(0, 10)], holes: Vec::new() }
    }

    #[test]
    fn a_ring_holds_its_inside_and_not_the_far_edge() {
        assert!(ring_contains(&square().outline, pt(5, 5)));
        assert!(!ring_contains(&square().outline, pt(11, 5)));
    }

    #[test]
    fn a_stick_collides_within_clearance_and_radius() {
        let stick = Shape::Stick { a: pt(14, 0), b: pt(14, 10), radius: 2 };
        let body = Shape::Polygon(square());
        assert!(shapes_collide(&stick, &body, 3));
        assert!(!shapes_collide(&stick, &body, 2));
    }

    #[test]
    fn crossing_sticks_have_no_gap() {
        assert_eq!(segment_segment_sq(pt(0, 0), pt(10, 10), pt(0, 10), pt(10, 0)), 0.0);
    }

    #[test]
    fn a_track_end_hits_within_half_its_width() {
        let t = Track { id: String::new(), start: pt(0, 0), end: pt(100, 0), mid: None, width: 20, layer: String::new(), net: String::new(), locked: false };
        assert!(track_hit(&t, pt(50, 10)));
        assert!(!track_hit(&t, pt(50, 12)));
    }
}
