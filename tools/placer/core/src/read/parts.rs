//! One footprint in the placement model: its rect, what keeps it fixed, how its pads relate.

use super::options::Options;
use crate::dru::fnmatch;
use crate::geom::Rect;
use crate::kicad::doc::{Copper, CopperItem, Footprint, Geometry, Pad, PadKind, PtMm, RectMm, mm, pad_boxes, ring_mm};
use crate::kicad::hit::{copper_hit, pad_hit};

/// A part rect is its pads + this when it has no courtyard.
const PAD_MARGIN: f64 = 0.25;

/// The letters of a reference.
pub fn ref_prefix(reference: &str) -> &str {
    let end = reference.find(|c: char| !(c.is_ascii_alphabetic() || c == '_')).unwrap_or(reference.len());
    &reference[..end]
}

pub fn is_test_point(reference: &str) -> bool {
    ref_prefix(reference) == "TP"
}

pub fn is_connector(reference: &str) -> bool {
    matches!(ref_prefix(reference), "J" | "P" | "CN")
}

/// H<n>, or a MountingHole footprint.
pub fn is_mounting_hole(fp: &Footprint) -> bool {
    let r = fp.reference.as_bytes();
    (r.len() > 1 && r[0] == b'H' && r[1..].iter().all(u8::is_ascii_digit)) || fp.lib_id.to_lowercase().contains("mountinghole")
}

/// The F.CrtYd points' box (no line width); without a courtyard the pads + a margin, else the position.
pub fn fp_rect(fp: &Footprint) -> Rect {
    let courtyard = fp.courtyard_front.iter().flat_map(|c| ring_mm(&c.outline));
    if let Some(r) = Rect::bounding(courtyard.map(|(x, y)| Rect::new(x, y, x, y))) {
        return r;
    }
    let (x, y) = fp.position.mm();
    Rect::bounding(pad_boxes(fp)).unwrap_or(Rect::new(x, y, x, y)).grown(PAD_MARGIN)
}

/// `rc` grown to cover the copper pads of fp (an NPTH hole has no copper).
pub fn pads_box(fp: &Footprint, rc: Rect) -> Rect {
    let copper = fp.pads.iter().filter(|p| p.kind != PadKind::NpThroughHole).map(|p| p.bbox.mm());
    Rect::bounding(std::iter::once(rc).chain(copper)).unwrap_or(rc)
}

/// (centre x, centre y, radius) when the courtyard is one circle (a test point).
pub fn round_courtyard(fp: &Footprint) -> Option<(f64, f64, f64)> {
    let mut courtyard = fp.graphics.iter().filter(|g| g.layer == "F.CrtYd");
    let (first, second) = (courtyard.next()?, courtyard.next());
    let (Geometry::Circle { center, radius_point }, None) = (&first.geometry, second) else { return None };
    let (dx, dy) = ((radius_point.x - center.x) as f64, (radius_point.y - center.y) as f64);
    let radius = (dx.hypot(dy).round() as i64).max(1);
    Some((mm(center.x), mm(center.y), round6(mm(radius))))
}

/// Python's round(v, 6): the nearest decimal of the exact value.
pub fn round6(v: f64) -> f64 {
    format!("{v:.6}").parse().unwrap_or(v)
}

/// Edge-to-edge distance in mm of the boxes of two pads.
pub fn pad_gap(a: &Pad, b: &Pad) -> f64 {
    let (p, q) = (a.bbox, b.bbox);
    let dx = (q.left - p.right).max(p.left - q.right).max(0);
    let dy = (q.top - p.bottom).max(p.top - q.bottom).max(0);
    (dx as f64).hypot(dy as f64) / 1e6
}

/// Even-odd test of a point in a ring, on the numbers the search uses.
pub fn in_ring(x: f64, y: f64, ring: &[(f64, f64)]) -> bool {
    let mut inside = false;
    for (k, &(ax, ay)) in ring.iter().enumerate() {
        let (bx, by) = ring[(k + 1) % ring.len()];
        if ay != by && (ay > y) != (by > y) && x < ax + (y - ay) * (bx - ax) / (by - ay) {
            inside = !inside;
        }
    }
    inside
}

/// True when a locked track or via of a pad's net meets the pad: the route is fixed.
pub fn locked_on_pad(fp: &Footprint, locked: &[&Copper]) -> bool {
    fp.pads.iter().filter(|p| !p.net.is_empty()).any(|p| {
        locked.iter().any(|t| t.net() == p.net.as_str() && (copper_hit(t, p.position) || t.ends().iter().any(|e| pad_hit(p, *e))))
    })
}

/// A connector whose courtyard crosses the outline, within `gap`; one wholly outside is staged for placement and stays movable.
fn connector_at_edge(rc: Rect, outline: &[(f64, f64)], gap: f64) -> bool {
    let corners = rc.grown(gap).corners();
    let inside = corners.iter().filter(|(x, y)| in_ring(*x, *y, outline)).count();
    0 < inside && inside < 4
}

/// A part the problem keeps fixed: locked, a mounting hole, not on F.Cu, in `fix`, a connector at the edge (rc = its rect), or
/// a pad on locked copper of its net.
pub fn part_fixed(fp: &Footprint, rc: Rect, outline: &[(f64, f64)], options: &Options, locked: &[&Copper]) -> bool {
    if fp.locked || is_mounting_hole(fp) || fp.layer != "F.Cu" || options.fix.iter().any(|p| fnmatch(&fp.reference, p)) {
        return true;
    }
    if is_connector(&fp.reference) && connector_at_edge(rc, outline, options.edge_dist) {
        return true;
    }
    locked_on_pad(fp, locked)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_prefix_is_the_leading_letters() {
        assert_eq!(ref_prefix("TP12"), "TP");
        assert_eq!(ref_prefix("U1A"), "U");
        assert_eq!(ref_prefix("12"), "");
    }

    #[test]
    fn six_places_round_like_python() {
        assert_eq!(round6(1.2345678), 1.234568);
        assert_eq!(round6(-4.819999999999993), -4.82);
    }

    #[test]
    fn a_connector_across_the_outline_is_at_the_edge() {
        let outline = [(0.0, 0.0), (10.0, 0.0), (10.0, 10.0), (0.0, 10.0)];
        assert!(connector_at_edge(Rect::new(8.0, 4.0, 11.0, 6.0), &outline, 0.0));
        assert!(!connector_at_edge(Rect::new(4.0, 4.0, 6.0, 6.0), &outline, 0.0));
        assert!(!connector_at_edge(Rect::new(14.0, 4.0, 16.0, 6.0), &outline, 0.0));
    }
}
