//! Copper and rule areas as the grid sees them, in millimetres.

pub type Point = (f64, f64);

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ItemKind {
    Copper,
    Pad,
    KeepTrack,
    KeepVia,
}

#[derive(Debug, Clone, PartialEq)]
pub enum Shape {
    /// x1, y1, x2, y2 and the half width.
    Segment([f64; 4], f64),
    /// Outlines.
    Polygons(Vec<Vec<Point>>),
}

/// One obstacle. `layers` holds one bit per job layer.
#[derive(Debug, Clone, PartialEq)]
pub struct Item {
    pub net: String,
    pub owner: String,
    pub layers: u32,
    pub clearance: f64,
    pub kind: ItemKind,
    pub shape: Shape,
    /// x1, y1, x2, y2.
    pub bbox: [f64; 4],
}

fn polygons_box(polygons: &[Vec<Point>]) -> [f64; 4] {
    let points = || polygons.iter().flatten();
    let fold = |pick: fn(&Point) -> f64, f: fn(f64, f64) -> f64, start: f64| points().map(pick).fold(start, f);
    [fold(|p| p.0, f64::min, f64::INFINITY), fold(|p| p.1, f64::min, f64::INFINITY), fold(|p| p.0, f64::max, f64::NEG_INFINITY), fold(|p| p.1, f64::max, f64::NEG_INFINITY)]
}

impl Item {
    pub fn segment(net: &str, owner: &str, layers: u32, clearance: f64, seg: [f64; 4], half_width: f64) -> Item {
        let [x1, y1, x2, y2] = seg;
        let bbox = [x1.min(x2) - half_width, y1.min(y2) - half_width, x1.max(x2) + half_width, y1.max(y2) + half_width];
        Item { net: net.to_string(), owner: owner.to_string(), layers, clearance, kind: ItemKind::Copper, shape: Shape::Segment(seg, half_width), bbox }
    }

    pub fn polygons(net: &str, owner: &str, layers: u32, clearance: f64, kind: ItemKind, polygons: Vec<Vec<Point>>) -> Item {
        Item { net: net.to_string(), owner: owner.to_string(), layers, clearance, kind, bbox: polygons_box(&polygons), shape: Shape::Polygons(polygons) }
    }

    pub fn on_layer(&self, layer: usize) -> bool {
        self.layers & (1 << layer) != 0
    }

    /// Distance from a point to the item's copper, 0 on it.
    pub fn distance(&self, x: f64, y: f64) -> f64 {
        match &self.shape {
            Shape::Segment(seg, half_width) => (seg_dist(x, y, *seg) - half_width).max(0.0),
            Shape::Polygons(polygons) if polygons.iter().any(|p| in_poly(x, y, p)) => 0.0,
            Shape::Polygons(polygons) => polygons.iter().map(|p| poly_dist(x, y, p)).fold(f64::INFINITY, f64::min),
        }
    }

    /// The reference of a pad or hole owner: "U1" of "U1.3".
    pub fn reference(&self) -> &str {
        self.owner.split('.').next().unwrap_or("")
    }
}

/// Distance from a point to a segment, in the order of operations of the numpy code, so a cell falls on the same side of a limit.
pub fn seg_dist(px: f64, py: f64, seg: [f64; 4]) -> f64 {
    let [x1, y1, x2, y2] = seg;
    let (dx, dy) = (x2 - x1, y2 - y1);
    let length = dx * dx + dy * dy;
    if length == 0.0 {
        return (px - x1).hypot(py - y1);
    }
    let t = (((px - x1) * dx + (py - y1) * dy) / length).clamp(0.0, 1.0);
    (px - (x1 + t * dx)).hypot(py - (y1 + t * dy))
}

/// Even-odd test against one outline, its closing edge first.
pub fn in_poly(px: f64, py: f64, points: &[Point]) -> bool {
    let mut inside = false;
    for (k, &(a, b)) in points.iter().enumerate() {
        let (c, d) = points[(k + points.len() - 1) % points.len()];
        if b == d {
            continue;
        }
        if (b > py) != (d > py) && px < (c - a) * (py - b) / (d - b) + a {
            inside = !inside;
        }
    }
    inside
}

/// Distance from a point to an outline.
pub fn poly_dist(px: f64, py: f64, points: &[Point]) -> f64 {
    let mut best = f64::INFINITY;
    for (k, &(a, b)) in points.iter().enumerate() {
        let (c, d) = points[(k + points.len() - 1) % points.len()];
        best = best.min(seg_dist(px, py, [a, b, c, d]));
    }
    best
}

#[cfg(test)]
mod tests {
    use super::*;

    const SQUARE: [Point; 4] = [(0.0, 0.0), (2.0, 0.0), (2.0, 2.0), (0.0, 2.0)];

    #[test]
    fn segment_distance_stops_at_the_ends() {
        assert_eq!(seg_dist(1.0, 1.0, [0.0, 0.0, 2.0, 0.0]), 1.0);
        assert_eq!(seg_dist(5.0, 0.0, [0.0, 0.0, 2.0, 0.0]), 3.0);
        assert_eq!(seg_dist(3.0, 4.0, [0.0, 0.0, 0.0, 0.0]), 5.0);
    }

    #[test]
    fn points_inside_and_out() {
        assert!(in_poly(1.0, 1.0, &SQUARE));
        assert!(!in_poly(3.0, 1.0, &SQUARE));
        assert_eq!(poly_dist(3.0, 1.0, &SQUARE), 1.0);
    }

    #[test]
    fn a_polygon_item_has_the_box_of_its_points() {
        let item = Item::polygons("", "x", 1, 0.0, ItemKind::Pad, vec![SQUARE.to_vec()]);
        assert_eq!(item.bbox, [0.0, 0.0, 2.0, 2.0]);
    }

    #[test]
    fn the_reference_is_before_the_first_dot() {
        assert_eq!(Item::segment("", "U1.3(hole)", 1, 0.0, [0.0; 4], 0.0).reference(), "U1");
    }
}
