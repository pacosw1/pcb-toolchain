//! Plane geometry. Units are mm, KiCad axes (y down). A turn r in 0..3 is r * 90 degrees in the KiCad sense:
//! r = 1 maps a local point (x, y) to (y, -x).

use serde::de::{Deserializer, Error, SeqAccess, Visitor};
use serde::{Deserialize, Serialize, Serializer};
use std::fmt;

pub const EPS: f64 = 1e-9;

pub type Point = (f64, f64);

/// A turn of a whole number of quarter turns, 0..3.
pub type Turn = u8;

pub fn turn_point((x, y): Point, r: Turn) -> Point {
    match r % 4 {
        0 => (x, y),
        1 => (y, -x),
        2 => (-x, -y),
        _ => (-y, x),
    }
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Rect {
    pub x0: f64,
    pub y0: f64,
    pub x1: f64,
    pub y1: f64,
}

impl Rect {
    pub const fn new(x0: f64, y0: f64, x1: f64, y1: f64) -> Self {
        Self { x0, y0, x1, y1 }
    }

    pub fn turned(self, r: Turn) -> Self {
        let Self { x0, y0, x1, y1 } = self;
        match r % 4 {
            0 => self,
            1 => Self::new(y0, -x1, y1, -x0),
            2 => Self::new(-x1, -y1, -x0, -y0),
            _ => Self::new(-y1, x0, -y0, x1),
        }
    }

    pub fn shifted(self, dx: f64, dy: f64) -> Self {
        Self::new(self.x0 + dx, self.y0 + dy, self.x1 + dx, self.y1 + dy)
    }

    /// The four turns of a local rect.
    pub fn turns(self) -> [Self; 4] {
        [0, 1, 2, 3].map(|r| self.turned(r))
    }

    pub fn width(self) -> f64 {
        self.x1 - self.x0
    }

    pub fn height(self) -> f64 {
        self.y1 - self.y0
    }

    pub fn centre(self) -> Point {
        ((self.x0 + self.x1) / 2.0, (self.y0 + self.y1) / 2.0)
    }

    pub fn corners(self) -> [Point; 4] {
        [(self.x0, self.y0), (self.x1, self.y0), (self.x1, self.y1), (self.x0, self.y1)]
    }

    /// True when the open rects share an area. Boxes with an infinite empty side meet nothing.
    pub fn meets(self, other: Self) -> bool {
        self.x0 < other.x1 && self.x1 > other.x0 && self.y0 < other.y1 && self.y1 > other.y0
    }

    pub fn grown(self, g: f64) -> Self {
        Self::new(self.x0 - g, self.y0 - g, self.x1 + g, self.y1 + g)
    }

    /// The box around rects; None for no rects.
    pub fn bounding(rects: impl IntoIterator<Item = Self>) -> Option<Self> {
        rects.into_iter().reduce(|a, b| {
            Self::new(a.x0.min(b.x0), a.y0.min(b.y0), a.x1.max(b.x1), a.y1.max(b.y1))
        })
    }

    /// Distance on x and y from the rect to a point, 0 on an axis where the point is inside the span.
    pub fn axis_gaps(self, (x, y): Point) -> Point {
        ((self.x0 - x).max(x - self.x1).max(0.0), (self.y0 - y).max(y - self.y1).max(0.0))
    }
}

/// A rect is a JSON row [x0, y0, x1, y1, ...]; extra fields belong to the row types around it.
impl<'de> Deserialize<'de> for Rect {
    fn deserialize<D: Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        let row = Vec::<f64>::deserialize(d)?;
        match row[..] {
            [x0, y0, x1, y1, ..] => Ok(Self::new(x0, y0, x1, y1)),
            _ => Err(D::Error::custom("a rect row has at least 4 numbers")),
        }
    }
}

impl Serialize for Rect {
    fn serialize<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        [self.x0, self.y0, self.x1, self.y1].serialize(s)
    }
}

/// A rect with one more number in its JSON row: [x0, y0, x1, y1, value].
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct TaggedRect {
    pub rect: Rect,
    pub value: f64,
}

impl<'de> Deserialize<'de> for TaggedRect {
    fn deserialize<D: Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        struct Row;
        impl<'de> Visitor<'de> for Row {
            type Value = TaggedRect;
            fn expecting(&self, f: &mut fmt::Formatter) -> fmt::Result {
                f.write_str("a row [x0, y0, x1, y1, value]")
            }
            fn visit_seq<A: SeqAccess<'de>>(self, mut seq: A) -> Result<TaggedRect, A::Error> {
                let mut v = [0.0; 5];
                for slot in &mut v {
                    *slot = seq.next_element()?.ok_or_else(|| A::Error::custom("a row needs 5 numbers"))?;
                }
                Ok(TaggedRect { rect: Rect::new(v[0], v[1], v[2], v[3]), value: v[4] })
            }
        }
        d.deserialize_seq(Row)
    }
}

/// Even-odd test of a point in a polygon.
pub fn point_in_poly((x, y): Point, poly: &[Point]) -> bool {
    let mut inside = false;
    for (k, &(ax, ay)) in poly.iter().enumerate() {
        let (bx, by) = poly[(k + 1) % poly.len()];
        if ay != by && (ay > y) != (by > y) && x < ax + (y - ay) * (bx - ax) / (by - ay) {
            inside = !inside;
        }
    }
    inside
}

/// Squared distance from a point to a segment.
pub fn segment_d2((x, y): Point, (a0, b0): Point, (a1, b1): Point) -> f64 {
    let (dx, dy) = (a1 - a0, b1 - b0);
    let len2 = dx * dx + dy * dy;
    let t = if len2 > 0.0 { (((x - a0) * dx + (y - b0) * dy) / len2).clamp(0.0, 1.0) } else { 0.0 };
    let (ex, ey) = (x - a0 - t * dx, y - b0 - t * dy);
    ex * ex + ey * ey
}

/// Squared distance from a point to the edges of a polygon.
pub fn poly_edge_d2(p: Point, poly: &[Point]) -> f64 {
    (0..poly.len()).map(|k| segment_d2(p, poly[k], poly[(k + 1) % poly.len()])).fold(f64::INFINITY, f64::min)
}

/// Convex hull (Andrew's monotone chain); fewer than 3 distinct points stay as they are.
pub fn hull(points: &[Point]) -> Vec<Point> {
    let mut pts = points.to_vec();
    pts.sort_by(|a, b| a.0.total_cmp(&b.0).then(a.1.total_cmp(&b.1)));
    pts.dedup();
    if pts.len() < 3 {
        return pts;
    }
    let mut lower = half_hull(pts.iter().copied());
    let mut upper = half_hull(pts.iter().rev().copied());
    lower.pop();
    upper.pop();
    lower.append(&mut upper);
    lower
}

fn half_hull(points: impl Iterator<Item = Point>) -> Vec<Point> {
    let mut h: Vec<Point> = Vec::new();
    for p in points {
        while let [.., a, b] = h[..] {
            if (b.0 - a.0) * (p.1 - a.1) - (b.1 - a.1) * (p.0 - a.0) > 0.0 {
                break;
            }
            h.pop();
        }
        h.push(p);
    }
    h
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn turns_follow_kicad() {
        assert_eq!(turn_point((1.0, 2.0), 1), (2.0, -1.0));
        assert_eq!(turn_point((1.0, 2.0), 2), (-1.0, -2.0));
        assert_eq!(turn_point((1.0, 2.0), 3), (-2.0, 1.0));
        let r = Rect::new(0.0, 0.0, 2.0, 1.0);
        assert_eq!(r.turned(1), Rect::new(0.0, -2.0, 1.0, 0.0));
        assert_eq!(r.turned(4), r);
    }

    #[test]
    fn even_odd_polygon() {
        let square = [(0.0, 0.0), (2.0, 0.0), (2.0, 2.0), (0.0, 2.0)];
        assert!(point_in_poly((1.0, 1.0), &square));
        assert!(!point_in_poly((3.0, 1.0), &square));
    }

    #[test]
    fn hull_drops_inner_points() {
        let h = hull(&[(0.0, 0.0), (2.0, 0.0), (2.0, 2.0), (0.0, 2.0), (1.0, 1.0), (1.0, 1.0)]);
        assert_eq!(h.len(), 4);
        assert!(!h.contains(&(1.0, 1.0)));
        assert_eq!(hull(&[(1.0, 1.0), (1.0, 1.0)]), vec![(1.0, 1.0)]);
    }

    #[test]
    fn distances() {
        assert_eq!(segment_d2((1.0, 1.0), (0.0, 0.0), (2.0, 0.0)), 1.0);
        assert_eq!(segment_d2((5.0, 0.0), (0.0, 0.0), (2.0, 0.0)), 9.0);
        assert_eq!(segment_d2((1.0, 0.0), (0.0, 0.0), (0.0, 0.0)), 1.0);
    }
}
