//! A filled area read many times: SHAPE_POLY_SET::Contains by y band. The ray test only looks at edges that span the point's y,
//! so a band holds those edges and the answer is the same as Polygon::contains, without walking every edge.
use super::polygon::{ray_crosses, ring_edges};
use super::{Iu, Polygon, Pt, Rect};

const EDGES_PER_BAND: usize = 4;
const MAX_BANDS: usize = 4096;

struct Ring {
    top: Iu,
    height: Iu,
    bands: Vec<Vec<(Pt, Pt)>>,
}

impl Ring {
    fn new(points: &[Pt]) -> Ring {
        let (top, bottom) = points.iter().fold((Iu::MAX, Iu::MIN), |(t, b), p| (t.min(p.y), b.max(p.y)));
        let count = (points.len() / EDGES_PER_BAND).clamp(1, MAX_BANDS) as Iu;
        let height = ((bottom - top) / count + 1).max(1);
        let mut ring = Ring { top, height, bands: vec![Vec::new(); count as usize + 1] };
        if points.len() >= 3 {
            for (a, b) in ring_edges(points) {
                for band in ring.band(a.y.min(b.y))..=ring.band(a.y.max(b.y)) {
                    ring.bands[band].push((a, b));
                }
            }
        }
        ring
    }

    fn band(&self, y: Iu) -> usize {
        ((y - self.top) / self.height) as usize
    }

    fn contains(&self, p: Pt) -> bool {
        if p.y < self.top || self.band(p.y) >= self.bands.len() {
            return false;
        }
        self.bands[self.band(p.y)].iter().filter(|&&(a, b)| ray_crosses(a, b, p)).count() % 2 == 1
    }
}

struct Piece {
    bbox: Rect,
    outline: Ring,
    holes: Vec<Ring>,
}

impl Piece {
    fn contains(&self, p: Pt) -> bool {
        let b = self.bbox;
        b.left <= p.x && p.x <= b.right && b.top <= p.y && p.y <= b.bottom && self.outline.contains(p) && !self.holes.iter().any(|h| h.contains(p))
    }
}

/// The polygons of one fill.
#[derive(Default)]
pub struct FillIndex {
    pieces: Vec<Piece>,
}

impl FillIndex {
    pub fn new(polygons: &[Polygon]) -> FillIndex {
        let with_box = polygons.iter().filter_map(|p| Some((p, p.bbox()?)));
        FillIndex { pieces: with_box.map(|(p, bbox)| Piece { bbox, outline: Ring::new(&p.outline), holes: p.holes.iter().map(|h| Ring::new(h)).collect() }).collect() }
    }

    /// SHAPE_POLY_SET::Contains(point, -1, 0): in any polygon of the set.
    pub fn contains(&self, p: Pt) -> bool {
        self.pieces.iter().any(|piece| piece.contains(p))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn polygon() -> Polygon {
        let outline = vec![Pt::new(0, 0), Pt::new(100, 0), Pt::new(120, 60), Pt::new(100, 100), Pt::new(50, 80), Pt::new(0, 100)];
        Polygon { outline, holes: vec![vec![Pt::new(40, 40), Pt::new(60, 40), Pt::new(60, 60), Pt::new(40, 60)]] }
    }

    #[test]
    fn the_index_answers_as_the_polygon_does() {
        let p = polygon();
        let index = FillIndex::new(std::slice::from_ref(&p));
        for x in -5..130 {
            for y in -5..110 {
                let q = Pt::new(x, y);
                assert_eq!(index.contains(q), p.contains(q), "{q:?}");
            }
        }
    }

    #[test]
    fn an_empty_fill_holds_nothing() {
        assert!(!FillIndex::new(&[]).contains(Pt::new(0, 0)));
    }
}
