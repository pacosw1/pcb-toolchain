//! The board of `iotroute board-json`: iotroute's typed board, with what the placer asks of it in mm. Lengths in the document are
//! whole nanometres, y down.

use crate::geom::Rect;
pub use iotroute::kicad::board::{Board, Footprint, RoutedCopper as Copper, Track, Via, Zone};
pub use iotroute::kicad::geom::{Iu as Nm, Polygon, Pt, Rect as NmRect, to_mm as mm};
pub use iotroute::kicad::pad::{Copper as PadCopper, Pad, PadKind};
pub use iotroute::kicad::shape::{Geometry, Graphic};
use serde::Deserialize;
use std::path::Path;

pub trait PtMm {
    fn mm(self) -> (f64, f64);
}

impl PtMm for Pt {
    fn mm(self) -> (f64, f64) {
        (mm(self.x), mm(self.y))
    }
}

pub trait RectMm {
    fn mm(self) -> Rect;
}

impl RectMm for NmRect {
    fn mm(self) -> Rect {
        Rect::new(mm(self.left), mm(self.top), mm(self.right), mm(self.bottom))
    }
}

/// What the placer asks of a track or via.
pub trait CopperItem {
    fn id(&self) -> &str;
    fn net(&self) -> &str;
    fn locked(&self) -> bool;
    /// The end points: a via has one.
    fn ends(&self) -> Vec<Pt>;
    fn layers(&self) -> Vec<&str>;
}

impl CopperItem for Copper {
    fn id(&self) -> &str {
        match self {
            Self::Track(t) => &t.id,
            Self::Via(v) => &v.id,
        }
    }

    fn net(&self) -> &str {
        match self {
            Self::Track(t) => &t.net,
            Self::Via(v) => &v.net,
        }
    }

    fn locked(&self) -> bool {
        match self {
            Self::Track(t) => t.locked,
            Self::Via(v) => v.locked,
        }
    }

    fn ends(&self) -> Vec<Pt> {
        match self {
            Self::Track(t) => vec![t.start, t.end],
            Self::Via(v) => vec![v.at],
        }
    }

    fn layers(&self) -> Vec<&str> {
        match self {
            Self::Track(t) => vec![t.layer.as_str()],
            Self::Via(v) => v.layers.iter().map(String::as_str).collect(),
        }
    }
}

/// The box of a zone's outline (ZONE::GetBoundingBox).
pub fn zone_box(zone: &Zone) -> Option<Rect> {
    let points = zone.outline.iter().flat_map(|p| &p.outline);
    Rect::bounding(points.map(|p| {
        let (x, y) = p.mm();
        Rect::new(x, y, x, y)
    }))
}

#[derive(Debug, Deserialize)]
struct Document {
    board: Board,
}

/// Reads a board document.
pub fn load_board(path: &Path) -> crate::Result<Board> {
    let text = std::fs::read_to_string(path).map_err(|e| format!("{}: {e}", path.display()))?;
    let document: Document = serde_json::from_str(&text).map_err(|e| format!("{}: {e}", path.display()))?;
    Ok(document.board)
}

/// The outline and its holes in mm (GetBoardPolygonOutlines).
pub fn board_outline(board: &Board) -> crate::Result<(Vec<(f64, f64)>, Vec<Vec<(f64, f64)>>)> {
    let first = board.outlines.first().ok_or("no closed board outline on Edge.Cuts")?;
    Ok((ring_mm(&first.outline), first.holes.iter().map(|h| ring_mm(h)).collect()))
}

pub fn ring_mm(ring: &[Pt]) -> Vec<(f64, f64)> {
    ring.iter().map(|p| p.mm()).collect()
}

/// The box of each pad of a footprint.
pub fn pad_boxes(fp: &Footprint) -> impl Iterator<Item = Rect> + '_ {
    fp.pads.iter().map(|p| p.bbox.mm())
}
