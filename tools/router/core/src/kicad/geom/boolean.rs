//! SHAPE_POLY_SET booleans and offsets, through the same algorithm KiCad uses: clipper2-rs is a bit-exact port of Clipper2.
use super::polygon::Polygon;
use super::{Iu, Pt};
use clipper2_rs::{ClipType, Clipper64, ClipperOffset, EndType, FillRule, JoinType, Path64, Paths64, Point64, PolyTree64};

/// KiCad's CHAMFER_ACUTE_CORNERS and ROUND_ACUTE_CORNERS: a miter with this limit.
const MITER_LIMIT: f64 = 2.0;
const MIN_SEGMENTS_PER_CIRCLE: f64 = 8.0;

fn path(ring: &[Pt]) -> Path64 {
    ring.iter().map(|p| Point64 { x: p.x, y: p.y }).collect()
}

fn paths(polygons: &[Polygon]) -> Paths64 {
    polygons.iter().flat_map(Polygon::rings).map(|r| path(r)).collect()
}

fn ring(path: &Path64) -> Vec<Pt> {
    path.iter().map(|p| Pt::new(p.x, p.y)).collect()
}

/// Outlines with their holes; an island in a hole is a polygon of its own.
fn polygons(tree: &PolyTree64) -> Vec<Polygon> {
    let mut out = Vec::new();
    for id in tree.dfs() {
        if tree.is_hole(id) {
            continue;
        }
        let node = tree.node(id);
        let holes = node.children.iter().map(|h| ring(&tree.node(*h).polygon)).collect();
        out.push(Polygon { outline: ring(&node.polygon), holes });
    }
    out
}

fn boolean(kind: ClipType, a: &[Polygon], b: &[Polygon]) -> Result<Vec<Polygon>, String> {
    let mut c = Clipper64::new();
    c.set_preserve_collinear(false);
    c.add_subject(&paths(a));
    c.add_clip(&paths(b));
    c.execute_tree(kind, FillRule::NonZero).map(|(tree, _)| polygons(&tree)).map_err(|e| format!("polygon boolean: {e:?}"))
}

/// BooleanAdd.
pub fn union(a: &[Polygon], b: &[Polygon]) -> Result<Vec<Polygon>, String> {
    boolean(ClipType::Union, a, b)
}

/// BooleanIntersection.
pub fn intersection(a: &[Polygon], b: &[Polygon]) -> Result<Vec<Polygon>, String> {
    boolean(ClipType::Intersection, a, b)
}

/// BooleanSubtract.
pub fn difference(a: &[Polygon], b: &[Polygon]) -> Result<Vec<Polygon>, String> {
    boolean(ClipType::Difference, a, b)
}

/// Simplify: strictly simple outlines with their holes.
pub fn simplify(a: &[Polygon]) -> Result<Vec<Polygon>, String> {
    union(a, &[])
}

/// GetArcToSegmentCount for a full circle.
pub fn circle_segments(radius: Iu, max_error: Iu) -> i64 {
    let rel_error = max_error.max(1) as f64 / radius.max(1) as f64;
    let increment = ((1.0 - rel_error).acos() * 2.0).to_degrees().min(360.0 / MIN_SEGMENTS_PER_CIRCLE);
    ((360.0 / increment).round() as i64).max(2)
}

/// Inflate with CHAMFER_ACUTE_CORNERS: `amount` nanometres outward, inward when negative.
pub fn inflate(a: &[Polygon], amount: Iu, max_error: Iu) -> Result<Vec<Polygon>, String> {
    let mut offset = ClipperOffset::new(MITER_LIMIT, 0.0, false, false);
    for polygon in a {
        offset.add_paths(&polygon.rings().map(|r| path(r)).collect(), JoinType::Miter, EndType::Polygon);
    }
    let segments = circle_segments(amount.abs(), max_error).max(6);
    offset.set_miter_limit(MITER_LIMIT);
    offset.set_arc_tolerance(amount.abs() as f64 * (1.0 - (std::f64::consts::PI / segments as f64).cos()));
    offset.execute_tree(amount as f64).map(|t| polygons(&t)).map_err(|e| format!("polygon offset: {e:?}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn square(x: Iu, y: Iu, side: Iu) -> Polygon {
        Polygon::of_ring(vec![Pt::new(x, y), Pt::new(x + side, y), Pt::new(x + side, y + side), Pt::new(x, y + side)])
    }

    fn area(p: &Polygon) -> i128 {
        let shoelace = |r: &Vec<Pt>| (0..r.len()).map(|i| r[i].x as i128 * r[(i + 1) % r.len()].y as i128 - r[(i + 1) % r.len()].x as i128 * r[i].y as i128).sum::<i128>().abs() / 2;
        shoelace(&p.outline) - p.holes.iter().map(shoelace).sum::<i128>()
    }

    #[test]
    fn a_union_of_touching_squares_leaves_no_seam() {
        let u = union(&[square(0, 0, 10)], &[square(10, 0, 10)]).unwrap();
        assert_eq!(u.len(), 1);
        assert_eq!(u[0].outline.len(), 4);
        assert_eq!(area(&u[0]), 200);
    }

    #[test]
    fn a_subtraction_inside_makes_a_hole() {
        let d = difference(&[square(0, 0, 10)], &[square(4, 4, 2)]).unwrap();
        assert_eq!((d.len(), d[0].holes.len()), (1, 1));
        assert_eq!(area(&d[0]), 96);
    }

    #[test]
    fn an_island_in_a_hole_is_its_own_polygon() {
        let ring = difference(&[square(0, 0, 100)], &[square(20, 20, 60)]).unwrap();
        assert_eq!(union(&ring, &[square(40, 40, 10)]).unwrap().len(), 2);
    }

    #[test]
    fn intersection_of_apart_squares_is_empty() {
        assert!(intersection(&[square(0, 0, 10)], &[square(20, 0, 10)]).unwrap().is_empty());
        assert_eq!(area(&intersection(&[square(0, 0, 10)], &[square(5, 5, 10)]).unwrap()[0]), 25);
    }

    #[test]
    fn a_negative_inflate_draws_a_rectangle_in() {
        let s = inflate(&[square(0, 0, 100_000)], -5_000, 5_000).unwrap();
        assert_eq!(area(&s[0]), 90_000i128 * 90_000);
    }
}
