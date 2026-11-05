//! A board as typed data, in KiCad's units and order. `kicad::api::read_board` fills it.
use super::geom::outline::arc_points;
use super::geom::{Iu, Polygon, Pt, Rect, to_mm};
use super::pad::{Copper, Pad, ZoneConnection};
use super::shape::{Arc, Graphic};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Board {
    pub path: String,
    /// Copper layer names from top to bottom.
    pub copper_layers: Vec<String>,
    /// From top to bottom.
    pub stackup: Vec<StackupLayer>,
    /// Every net with its net class, by name; the unconnected net "" is not one.
    pub nets: BTreeMap<String, String>,
    pub footprints: Vec<Footprint>,
    /// Tracks and vias in KiCad's order.
    pub copper: Vec<RoutedCopper>,
    /// Board zones and rule areas, not the footprints'.
    pub zones: Vec<Zone>,
    /// Board graphics, not the footprints'.
    pub graphics: Vec<Graphic>,
    /// Board texts, not the footprints'.
    #[serde(default)]
    pub texts: Vec<Text>,
    /// Every group, nested ones too: a nested group's id is in the items of its parent.
    #[serde(default)]
    pub groups: Vec<Group>,
    #[serde(default)]
    pub constraints: Constraints,
    /// The box of Edge.Cuts with line widths, as BOARD::GetBoardEdgesBoundingBox.
    pub edges_bbox: Rect,
    /// GetBoardPolygonOutlines with no inferred outline: empty when Edge.Cuts does not close.
    pub outlines: Vec<Polygon>,
}

impl Board {
    /// Tracks and arcs, in KiCad's order.
    pub fn tracks(&self) -> impl Iterator<Item = &Track> {
        self.copper.iter().filter_map(|c| if let RoutedCopper::Track(t) = c { Some(t) } else { None })
    }

    /// Vias, in KiCad's order.
    pub fn vias(&self) -> impl Iterator<Item = &Via> {
        self.copper.iter().filter_map(|c| if let RoutedCopper::Via(v) = c { Some(v) } else { None })
    }

    /// Every pad with its footprint, footprint by footprint.
    pub fn pads(&self) -> impl Iterator<Item = (&Footprint, &Pad)> {
        self.footprints.iter().flat_map(|f| f.pads.iter().map(move |p| (f, p)))
    }

    /// Board graphics, then each footprint's, on one layer.
    pub fn graphics_on<'a>(&'a self, layer: &'a str) -> impl Iterator<Item = &'a Graphic> {
        self.graphics.iter().chain(self.footprints.iter().flat_map(|f| &f.graphics)).filter(move |g| g.layer == layer)
    }

    /// The class of a net, Default for no net.
    pub fn net_class(&self, net: &str) -> &str {
        self.nets.get(net).map_or("Default", String::as_str)
    }
}

/// A PCB_TEXT of the board.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Text {
    pub id: String,
    pub text: String,
    pub layer: String,
    pub position: Pt,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Group {
    pub id: String,
    pub name: String,
    pub items: Vec<String>,
}

/// The board's minimum constraints (BOARD_DESIGN_SETTINGS).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
pub struct Constraints {
    pub min_clearance: Iu,
    pub min_track_width: Iu,
    pub min_via_size: Iu,
    pub copper_edge_clearance: Iu,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum StackupKind {
    Copper,
    Core,
    Prepreg,
    Other,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct StackupLayer {
    /// The layer name; "" for a dielectric, which has none in KiCad's API.
    pub layer: String,
    pub kind: StackupKind,
    /// A dielectric of several sublayers counts its first.
    pub thickness: Iu,
}

impl StackupLayer {
    pub fn thickness_mm(&self) -> f64 {
        to_mm(self.thickness)
    }
}

#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
pub struct Footprint {
    pub id: String,
    pub reference: String,
    pub value: String,
    pub lib_id: String,
    pub layer: String,
    pub position: Pt,
    pub orientation: f64,
    pub locked: bool,
    /// The footprint's copper clearance override, when it has one.
    #[serde(default)]
    pub clearance_override: Option<Iu>,
    /// The fields other than Reference and Value, as name and text.
    pub fields: Vec<(String, String)>,
    pub pads: Vec<Pad>,
    pub graphics: Vec<Graphic>,
    pub zones: Vec<Zone>,
    /// GetCourtyard of each side: empty when the side has none or it does not close.
    pub courtyard_front: Vec<Polygon>,
    pub courtyard_back: Vec<Polygon>,
}

impl Footprint {
    /// GetCourtyard(layer).BBox(): none when the side has no courtyard. A contour keeps the width of its graphic and
    /// SHAPE_LINE_CHAIN::BBox grows by that whole width, not half; contours of different widths count as the widest.
    pub fn courtyard_box(&self, layer: &str) -> Option<Rect> {
        let polygons = if layer.starts_with("B.") { &self.courtyard_back } else { &self.courtyard_front };
        let width = self.graphics.iter().filter(|g| g.layer == layer).map(|g| g.width).max().unwrap_or(0);
        polygons.iter().filter_map(Polygon::bbox).reduce(Rect::merged).map(|b| b.inflated(width))
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub enum RoutedCopper {
    Track(Track),
    Via(Via),
}

/// A segment, or an arc when `mid` is set.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Track {
    pub id: String,
    pub start: Pt,
    pub end: Pt,
    pub mid: Option<Pt>,
    pub width: Iu,
    pub layer: String,
    pub net: String,
    pub locked: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Via {
    pub id: String,
    pub at: Pt,
    pub size: Iu,
    pub drill: Iu,
    pub net: String,
    pub locked: bool,
    /// Copper layers in stack order.
    #[serde(default)]
    pub layers: Vec<String>,
}

impl Track {
    /// GetEffectiveShape: a segment, or an arc as its chords at the track width.
    pub fn copper(&self) -> Vec<Copper> {
        let Some(mid) = self.mid else { return vec![Copper::Segment { a: self.start, b: self.end, width: self.width }] };
        let points = arc_points(&Arc::through(self.start, mid, self.end), self.width);
        points.windows(2).map(|w| Copper::Segment { a: w[0], b: w[1], width: self.width }).collect()
    }
}

impl Via {
    /// GetEffectiveShape on a layer it flashes on.
    pub fn copper(&self) -> Copper {
        Copper::Circle { center: self.at, radius: self.size / 2 }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct FilledLayer {
    pub layer: String,
    pub polygons: Vec<Polygon>,
}

/// True for each item a rule area does not allow.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct RuleArea {
    pub tracks: bool,
    pub vias: bool,
    pub pour: bool,
    #[serde(default)]
    pub pads: bool,
    #[serde(default)]
    pub footprints: bool,
}

/// Copper zone settings; a rule area has none.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ZoneFill {
    pub clearance: Iu,
    pub priority: u32,
    pub min_thickness: Iu,
    pub corner_smoothing: i32,
    pub corner_radius: Iu,
    pub thermal_gap: Iu,
    pub spoke_width: Iu,
    pub pad_connection: Option<ZoneConnection>,
    /// KiCad's ISLAND_REMOVAL_MODE: 0 always, 1 never, 2 by area.
    pub island_removal_mode: i64,
    pub min_island_area: u64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Zone {
    pub id: String,
    pub name: String,
    pub net: String,
    /// Copper layers in stack order.
    pub layers: Vec<String>,
    pub outline: Vec<Polygon>,
    /// The fill as the file has it, per layer.
    pub filled: Vec<FilledLayer>,
    pub rule_area: Option<RuleArea>,
    pub fill: Option<ZoneFill>,
}

impl Zone {
    /// pcbnew's ZONE == for copper zones: settings and corners, with no regard to layer, net or name, so two pours of one outline
    /// are one zone to it.
    pub fn same_pour(&self, other: &Zone) -> bool {
        let settings = |z: &Zone| z.fill.as_ref().map(|f| (f.priority, f.min_thickness, f.corner_smoothing, f.corner_radius));
        settings(self) == settings(other) && self.outline == other.outline
    }
}
