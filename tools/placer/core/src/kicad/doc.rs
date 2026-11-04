//! The board JSON of `iotroute board-json`, as far as the placer reads it. Lengths are whole nanometres, y down.

use crate::geom::Rect;
use serde::Deserialize;
use std::collections::BTreeMap;
use std::path::Path;

pub type Nm = i64;

pub const NM_PER_MM: f64 = 1e6;

pub fn mm(v: Nm) -> f64 {
    v as f64 / NM_PER_MM
}

#[derive(Clone, Copy, Debug, Default, Deserialize, PartialEq, Eq, Hash)]
pub struct Pt {
    pub x: Nm,
    pub y: Nm,
}

impl Pt {
    pub fn mm(self) -> (f64, f64) {
        (mm(self.x), mm(self.y))
    }
}

#[derive(Clone, Copy, Debug, Default, Deserialize, PartialEq)]
pub struct NmRect {
    pub left: Nm,
    pub top: Nm,
    pub right: Nm,
    pub bottom: Nm,
}

impl NmRect {
    pub fn mm(self) -> Rect {
        Rect::new(mm(self.left), mm(self.top), mm(self.right), mm(self.bottom))
    }
}

#[derive(Clone, Debug, Default, Deserialize, PartialEq)]
pub struct Polygon {
    pub outline: Vec<Pt>,
    #[serde(default)]
    pub holes: Vec<Vec<Pt>>,
}

#[derive(Clone, Debug, Deserialize, PartialEq)]
pub enum Geometry {
    Segment { start: Pt, end: Pt },
    Rect { top_left: Pt, bottom_right: Pt },
    Circle { center: Pt, radius_point: Pt },
    Arc { start: Pt, end: Pt, center: Pt },
    Poly { rings: Vec<Vec<Pt>> },
    Other,
}

#[derive(Clone, Debug, Deserialize)]
pub struct Graphic {
    pub id: String,
    pub geometry: Geometry,
    pub layer: String,
    pub width: Nm,
}

#[derive(Clone, Debug, Deserialize)]
pub enum PadCopper {
    Circle { center: Pt, radius: Nm },
    Segment { a: Pt, b: Pt, width: Nm },
    Polygon(Vec<Pt>),
}

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq)]
pub enum PadKind {
    ThroughHole,
    Smd,
    EdgeConnector,
    NpThroughHole,
}

#[derive(Clone, Debug, Deserialize)]
pub struct Pad {
    pub number: String,
    pub kind: PadKind,
    pub net: String,
    pub position: Pt,
    pub orientation: f64,
    pub drill: Pt,
    pub layers: Vec<String>,
    pub bbox: NmRect,
    pub copper: Vec<PadCopper>,
    #[serde(default)]
    pub polygons: BTreeMap<String, Polygon>,
    pub clearance_override: Option<Nm>,
}

#[derive(Clone, Debug, Deserialize)]
pub struct Footprint {
    pub id: String,
    pub reference: String,
    pub lib_id: String,
    pub layer: String,
    pub position: Pt,
    pub orientation: f64,
    pub locked: bool,
    pub clearance_override: Option<Nm>,
    pub pads: Vec<Pad>,
    pub graphics: Vec<Graphic>,
    pub courtyard_front: Vec<Polygon>,
}

#[derive(Clone, Debug, Deserialize)]
pub struct Track {
    pub id: String,
    pub start: Pt,
    pub end: Pt,
    pub mid: Option<Pt>,
    pub width: Nm,
    pub layer: String,
    pub net: String,
    pub locked: bool,
}

#[derive(Clone, Debug, Deserialize)]
pub struct Via {
    pub id: String,
    pub at: Pt,
    pub size: Nm,
    pub net: String,
    pub locked: bool,
    pub layers: Vec<String>,
}

#[derive(Clone, Debug, Deserialize)]
pub enum Copper {
    Track(Track),
    Via(Via),
}

impl Copper {
    pub fn id(&self) -> &str {
        match self {
            Self::Track(t) => &t.id,
            Self::Via(v) => &v.id,
        }
    }

    pub fn net(&self) -> &str {
        match self {
            Self::Track(t) => &t.net,
            Self::Via(v) => &v.net,
        }
    }

    pub fn locked(&self) -> bool {
        match self {
            Self::Track(t) => t.locked,
            Self::Via(v) => v.locked,
        }
    }

    /// The end points: a via has one.
    pub fn ends(&self) -> Vec<Pt> {
        match self {
            Self::Track(t) => vec![t.start, t.end],
            Self::Via(v) => vec![v.at],
        }
    }

    pub fn is_via(&self) -> bool {
        matches!(self, Self::Via(_))
    }

    pub fn layers(&self) -> Vec<&str> {
        match self {
            Self::Track(t) => vec![t.layer.as_str()],
            Self::Via(v) => v.layers.iter().map(String::as_str).collect(),
        }
    }
}

#[derive(Clone, Copy, Debug, Deserialize)]
pub struct RuleArea {
    pub vias: bool,
    pub footprints: bool,
}

#[derive(Clone, Debug, Deserialize)]
pub struct Zone {
    pub id: String,
    pub name: String,
    pub net: String,
    pub layers: Vec<String>,
    pub outline: Vec<Polygon>,
    pub rule_area: Option<RuleArea>,
}

impl Zone {
    /// The box of the outline (ZONE::GetBoundingBox).
    pub fn bbox(&self) -> Option<Rect> {
        let points = self.outline.iter().flat_map(|p| &p.outline);
        Rect::bounding(points.map(|p| {
            let (x, y) = p.mm();
            Rect::new(x, y, x, y)
        }))
    }
}

#[derive(Clone, Debug, Deserialize)]
pub struct Text {
    pub id: String,
    pub text: String,
    pub layer: String,
    pub position: Pt,
}

#[derive(Clone, Debug, Deserialize)]
pub struct Group {
    pub id: String,
    pub name: String,
    pub items: Vec<String>,
}

#[derive(Clone, Copy, Debug, Deserialize)]
pub struct Constraints {
    pub min_clearance: Nm,
    pub min_track_width: Nm,
    pub min_via_size: Nm,
    pub copper_edge_clearance: Nm,
}

#[derive(Clone, Debug, Deserialize)]
pub struct Board {
    pub copper_layers: Vec<String>,
    pub nets: BTreeMap<String, String>,
    pub footprints: Vec<Footprint>,
    pub copper: Vec<Copper>,
    pub zones: Vec<Zone>,
    pub graphics: Vec<Graphic>,
    pub texts: Vec<Text>,
    pub groups: Vec<Group>,
    pub constraints: Constraints,
    pub outlines: Vec<Polygon>,
}

#[derive(Debug, Deserialize)]
struct Document {
    board: Board,
}

impl Board {
    /// Reads a board document. A document older than these fields fails here, by name.
    pub fn load(path: &Path) -> crate::Result<Self> {
        let text = std::fs::read_to_string(path).map_err(|e| format!("{}: {e}", path.display()))?;
        let document: Document = serde_json::from_str(&text).map_err(|e| format!("{}: {e} (a board JSON from an older iotroute?)", path.display()))?;
        Ok(document.board)
    }

    /// The class of a net; a pad with no net has the Default class.
    pub fn net_class(&self, net: &str) -> &str {
        self.nets.get(net).map_or("Default", String::as_str)
    }

    /// The outline and its holes in mm (GetBoardPolygonOutlines).
    pub fn outline(&self) -> crate::Result<(Vec<(f64, f64)>, Vec<Vec<(f64, f64)>>)> {
        let first = self.outlines.first().ok_or("no closed board outline on Edge.Cuts")?;
        Ok((ring_mm(&first.outline), first.holes.iter().map(|h| ring_mm(h)).collect()))
    }
}

pub fn ring_mm(ring: &[Pt]) -> Vec<(f64, f64)> {
    ring.iter().map(|p| p.mm()).collect()
}

/// The box of each pad of a footprint.
pub fn pad_boxes(fp: &Footprint) -> impl Iterator<Item = Rect> + '_ {
    fp.pads.iter().map(|p| p.bbox.mm())
}
