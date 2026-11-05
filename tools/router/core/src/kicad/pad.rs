//! Pads and the copper KiCad builds for them (PAD::buildEffectiveShape): the primitives its collision tests run on.
use super::geom::{Iu, Polygon, Pt, Rect, ki_round};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

/// Roundrect pads this close to a circle are circles in KiCad (0.0001 mm).
const MIN_ROUND_LEG: Iu = 100;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum PadKind {
    ThroughHole,
    Smd,
    EdgeConnector,
    NpThroughHole,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum PadShape {
    Circle,
    Rect,
    Oval,
    RoundRect,
    Custom,
    /// Trapezoid or chamfered: no board uses one; `copper` is empty.
    Other,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum ZoneConnection {
    None,
    Thermal,
    Full,
    ThtThermal,
}

/// One piece of copper, in board coordinates.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub enum Copper {
    Circle { center: Pt, radius: Iu },
    Segment { a: Pt, b: Pt, width: Iu },
    Polygon(Vec<Pt>),
}

impl Copper {
    /// As SHAPE::BBox.
    pub fn bbox(&self) -> Rect {
        match self {
            Copper::Circle { center, radius } => Rect::around(*center).inflated(*radius),
            Copper::Segment { a, b, width } => Rect::of_points([*a, *b]).expect("two points").inflated((width + 1) / 2),
            Copper::Polygon(points) => Rect::of_points(points.iter().copied()).expect("a polygon has points"),
        }
    }
}

/// The box of the hole on the pad position, as PAD::BuildEffectiveShapes. It holds the position also with no hole.
pub fn hole_box(size: Pt, oval: bool, position: Pt, orientation: f64) -> Rect {
    let half = Pt::new(size.x / 2, size.y / 2);
    let half_width = if oval { half.x.min(half.y) } else { half.x };
    let leg = if oval { Pt::new(half.x - half_width, half.y - half_width) } else { Pt::default() }.rotated(orientation);
    Copper::Segment { a: position - leg, b: position + leg, width: half_width * 2 }.bbox()
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Pad {
    pub id: String,
    pub number: String,
    pub kind: PadKind,
    pub shape: PadShape,
    pub net: String,
    pub position: Pt,
    /// Degrees in [0, 360).
    pub orientation: f64,
    pub size: Pt,
    pub drill: Pt,
    /// Every layer of the pad; copper ones are the names in Board::copper_layers.
    pub layers: Vec<String>,
    /// The box of the copper and the hole, as PAD::GetBoundingBox.
    pub bbox: Rect,
    pub zone_connection: Option<ZoneConnection>,
    pub thermal_spoke_angle: f64,
    /// Thermal spoke templates of a custom pad.
    pub spoke_templates: usize,
    /// The primitives of GetEffectiveShape.
    pub copper: Vec<Copper>,
    /// GetEffectivePolygon per copper layer, KiCad's own. Missing for a pad that shares its uuid with another: the API cannot
    /// tell them apart.
    pub polygons: BTreeMap<String, Polygon>,
    /// GetSolderMaskExpansion, without DRU solder_mask_expansion rules.
    pub solder_mask_expansion: Iu,
    /// Side-specific margins; does not include custom rule overrides.
    #[serde(default)]
    pub solder_mask_expansion_by_layer: BTreeMap<String, Iu>,
    /// The pad's copper clearance override, when it has one.
    #[serde(default)]
    pub clearance_override: Option<Iu>,
}

/// PAD::GetSolderMaskExpansion: the pad's margin, else the footprint's, else the board's. A shrink stops at half the narrow side.
pub fn mask_expansion(pad: Option<Iu>, footprint: Option<Iu>, board: Iu, size: Pt) -> Iu {
    let margin = pad.or(footprint).unwrap_or(board);
    margin.max(-(size.x.min(size.y)) / 2)
}

/// What the copper of a pad is built from.
pub struct PadForm {
    pub shape: PadShape,
    /// The pad position plus its turned offset (PAD::ShapePos).
    pub center: Pt,
    pub orientation: f64,
    pub size: Pt,
    pub corner_ratio: f64,
}

impl PadForm {
    /// The pad's own copper, for a custom pad its anchor. A primitive of a custom pad is added by the reader.
    pub fn copper(&self) -> Vec<Copper> {
        let (size, center) = (self.size, self.center);
        match self.shape {
            PadShape::Oval if size.x != size.y => vec![self.oval()],
            PadShape::Circle | PadShape::Oval => vec![Copper::Circle { center, radius: size.x / 2 }],
            PadShape::Rect => vec![Copper::Polygon(self.corners(0))],
            PadShape::RoundRect => self.round_rect(),
            PadShape::Custom | PadShape::Other => Vec::new(),
        }
    }

    fn oval(&self) -> Copper {
        let half = Pt::new(self.size.x / 2, self.size.y / 2);
        let half_width = half.x.min(half.y);
        let leg = Pt::new(half.x - half_width, half.y - half_width).rotated(self.orientation);
        Copper::Segment { a: self.center - leg, b: self.center + leg, width: half_width * 2 }
    }

    /// The corners of the pad rectangle, drawn in by `inset`.
    fn corners(&self, inset: Iu) -> Vec<Pt> {
        let (hx, hy) = (self.size.x / 2 - inset, self.size.y / 2 - inset);
        [Pt::new(-hx, hy), Pt::new(hx, hy), Pt::new(hx, -hy), Pt::new(-hx, -hy)].iter().map(|c| c.rotated(self.orientation) + self.center).collect()
    }

    fn round_rect(&self) -> Vec<Copper> {
        let r = ki_round(self.size.x.min(self.size.y) as f64 * self.corner_ratio);
        if r == 0 {
            return vec![Copper::Polygon(self.corners(0))];
        }
        if self.size.x / 2 - r < MIN_ROUND_LEG && self.size.y / 2 - r < MIN_ROUND_LEG {
            return vec![Copper::Circle { center: self.center, radius: r }];
        }
        let inner = self.corners(r);
        let sides = (0..4).map(|i| Copper::Segment { a: inner[i], b: inner[(i + 1) % 4], width: r * 2 });
        std::iter::once(Copper::Polygon(inner.clone())).chain(sides).collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn form(shape: PadShape, size: Pt, orientation: f64) -> PadForm {
        PadForm { shape, center: Pt::new(10_000_000, 20_000_000), orientation, size, corner_ratio: 0.25 }
    }

    #[test]
    fn an_oval_is_a_thick_segment_and_a_square_oval_a_circle() {
        let c = form(PadShape::Oval, Pt::new(2_000_000, 1_000_000), 0.0).copper();
        assert_eq!(c, [Copper::Segment { a: Pt::new(9_500_000, 20_000_000), b: Pt::new(10_500_000, 20_000_000), width: 1_000_000 }]);
        assert!(matches!(form(PadShape::Oval, Pt::new(1_000_000, 1_000_000), 0.0).copper()[0], Copper::Circle { .. }));
    }

    #[test]
    fn mask_margin_comes_from_the_nearest_owner_and_stops_at_half_the_pad() {
        let size = Pt::new(1_000, 600);
        assert_eq!(mask_expansion(Some(10), Some(20), 30, size), 10);
        assert_eq!(mask_expansion(None, Some(20), 30, size), 20);
        assert_eq!(mask_expansion(None, None, 30, size), 30);
        assert_eq!(mask_expansion(Some(-1_000), None, 30, size), -300);
    }

    #[test]
    fn a_hole_box_is_round_or_oblong() {
        let p = Pt::new(10, 20);
        assert_eq!(hole_box(Pt::new(4, 4), false, p, 0.0), Rect { left: 8, top: 18, right: 12, bottom: 22 });
        assert_eq!(hole_box(Pt::new(8, 4), true, p, 90.0), Rect { left: 8, top: 16, right: 12, bottom: 24 });
        assert_eq!(hole_box(Pt::default(), false, p, 0.0), Rect::around(p));
    }

    #[test]
    fn a_turned_rectangle_turns_its_corners() {
        let Copper::Polygon(c) = &form(PadShape::Rect, Pt::new(2_000_000, 1_000_000), 90.0).copper()[0] else { panic!() };
        assert_eq!(c[0], Pt::new(10_000_000 + 500_000, 20_000_000 + 1_000_000));
    }

    #[test]
    fn a_roundrect_is_its_inner_rectangle_and_four_rounded_sides() {
        assert_eq!(form(PadShape::RoundRect, Pt::new(2_000_000, 1_000_000), 0.0).copper().len(), 5);
    }

    #[test]
    fn a_roundrect_that_is_nearly_round_is_a_circle() {
        let f = PadForm { corner_ratio: 0.5, ..form(PadShape::RoundRect, Pt::new(1_000_000, 1_000_000), 0.0) };
        assert_eq!(f.copper(), [Copper::Circle { center: f.center, radius: 500_000 }]);
    }
}
