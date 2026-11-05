//! The placement problem, as the board reader writes it (tools/placer/README.md).
//! Units are mm, KiCad axes. Everything here is read only; the search state lives in `layout`.

use crate::geom::{Point, Rect, TaggedRect, Turn};
use serde::de::{Deserializer, Error as _};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::BTreeMap;
use std::path::Path;

/// Where one unit is: x, y, turn. A JSON row [x, y, r].
pub type Place = (f64, f64, Turn);

/// A place per unit, in unit order.
pub type Pose = Vec<Place>;

#[derive(Debug, Deserialize)]
pub struct Problem {
    pub units: Vec<Unit>,
    pub nets: Vec<Net>,
    pub board: Board,
    #[serde(default)]
    pub region: Option<Region>,
    #[serde(default)]
    pub move_box: Option<Rect>,
    #[serde(default)]
    pub class_gaps: Option<ClassGaps>,
    #[serde(default)]
    pub domain_areas: Option<Vec<DomainArea>>,
    #[serde(default)]
    pub via_nets: Option<Vec<i64>>,
    #[serde(default)]
    pub plane_nets: Option<Vec<String>>,
    #[serde(default)]
    pub escape_rules: Option<EscapeRules>,
    #[serde(default)]
    pub route_rules: Option<RouteRules>,
    #[serde(default)]
    pub cu_nets: BTreeMap<String, (String, String)>,
    /// Reviewed engineering contract: the rules live in tools/engineering_constraints.py (see `check_supported`).
    #[serde(default)]
    engineering: Value,
    /// Rules of the pcb_search placer only (see `check_supported`).
    #[serde(default)]
    part_rules: Value,
}

#[derive(Debug, Deserialize)]
pub struct Unit {
    pub name: String,
    #[serde(default)]
    pub refs: Vec<String>,
    pub fixed: bool,
    pub x: f64,
    pub y: f64,
    /// Courtyard boxes at r = 0, relative to the origin; the value is the spacing class.
    pub rects: Vec<TaggedRect>,
    /// Rects that are copper-free rule areas.
    #[serde(default)]
    pub ko: Vec<usize>,
    /// Rects with a hard gap (a pad with its clearance); the gap of the others is soft.
    #[serde(default)]
    pub hard: Vec<usize>,
    /// Domain pads.
    #[serde(default)]
    pub dom: Vec<DomainRect>,
    /// Rects that hold no pad of their own.
    #[serde(default)]
    pub mech: Vec<usize>,
    /// Soft-only rects (a block border: DRC does not check it).
    #[serde(default)]
    pub border: Vec<usize>,
    /// Corner radius per rect: [rect index, radius].
    #[serde(default)]
    pub rho: Vec<(usize, f64)>,
    /// No copper pad at all (an NPTH hole).
    #[serde(default)]
    pub nocu: bool,
    #[serde(default = "yes")]
    pub rotate: bool,
    /// Local pad points (pin RUDY).
    #[serde(default)]
    pub pads: Vec<Point>,
    #[serde(default)]
    pub pad_rects: Option<Vec<Rect>>,
    #[serde(default)]
    pub edge_pads: Option<Vec<Rect>>,
    /// Copper layers per pad; a null row means unknown. Lines up with pad_rects, else edge_pads.
    #[serde(default)]
    pub pad_copper_layers: Option<Vec<Option<Vec<String>>>>,
    /// Copper pads with their net code.
    #[serde(default)]
    pub cu: Vec<TaggedRect>,
    #[serde(default)]
    pub cu_pads: Vec<CuPad>,
    #[serde(default, rename = "box")]
    pub block_box: Option<Rect>,
    #[serde(default)]
    pub edge: Option<EdgeAnchor>,
    #[serde(default)]
    pub in_box: Option<Rect>,
    #[serde(default)]
    pub near: Vec<NearRule>,
}

fn yes() -> bool {
    true
}

impl Unit {
    pub fn place(&self) -> Place {
        (self.x, self.y, 0)
    }
}

/// [rect index, class id, gap to another class of the domain, net-class clearance]. Class -1 = a hole rule.
#[derive(Clone, Copy, Debug, Deserialize)]
pub struct DomainRect(pub usize, pub i64, pub f64, pub f64);

#[derive(Debug)]
pub struct CuPad {
    pub reference: String,
    pub kind: String,
    pub number: Option<String>,
}

/// A JSON row [ref, kind, number?].
impl<'de> Deserialize<'de> for CuPad {
    fn deserialize<D: Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        let row = Vec::<String>::deserialize(d)?;
        match row.as_slice() {
            [reference, kind, rest @ ..] => {
                Ok(Self { reference: reference.clone(), kind: kind.clone(), number: rest.first().cloned() })
            }
            _ => Err(D::Error::custom("a cu_pads row is [ref, kind, number?]")),
        }
    }
}

#[derive(Debug, Deserialize)]
pub struct EdgeAnchor {
    pub at: Point,
    pub sides: String,
    #[serde(default = "edge_tol")]
    pub tol: f64,
    #[serde(default)]
    pub inset: Option<f64>,
}

fn edge_tol() -> f64 {
    0.5
}

/// [local x, local y, world x, world y, distance].
#[derive(Clone, Copy, Debug, Deserialize)]
pub struct NearRule(pub f64, pub f64, pub f64, pub f64, pub f64);

#[derive(Debug, Deserialize)]
pub struct Net {
    pub name: String,
    pub weight: f64,
    pub pins: Vec<Pin>,
    #[serde(default)]
    pub track: Option<f64>,
    /// A virtual group net: no wire, no RUDY demand.
    #[serde(default)]
    pub cohesion: bool,
    /// Per pin the pad centres of the net on that unit.
    #[serde(default)]
    pub pts: Option<Vec<Vec<Point>>>,
}

/// A JSON row [unit, x0, y0, x1, y1].
#[derive(Clone, Copy, Debug)]
pub struct Pin {
    pub unit: usize,
    pub rect: Rect,
}

impl<'de> Deserialize<'de> for Pin {
    fn deserialize<D: Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        let (unit, x0, y0, x1, y1) = <(usize, f64, f64, f64, f64)>::deserialize(d)?;
        Ok(Self { unit, rect: Rect::new(x0, y0, x1, y1) })
    }
}

#[derive(Debug, Deserialize)]
pub struct Board {
    pub outline: Vec<Point>,
    #[serde(default)]
    pub keepouts: Vec<Vec<Point>>,
    #[serde(default)]
    pub edge_clearance: f64,
    #[serde(default)]
    pub copper: Vec<CopperRow>,
    #[serde(default)]
    pub fixed_copper: Vec<CopperRow>,
    #[serde(default)]
    pub fixed_copper_layers: Option<Vec<CopperRow>>,
    #[serde(default)]
    pub via_keepouts: Vec<Vec<Point>>,
    /// Class id to the no-net creepage gap of the class.
    #[serde(default)]
    pub keepout_gaps: BTreeMap<String, f64>,
    #[serde(default)]
    pub gap_keepouts: Vec<Vec<Point>>,
}

impl Board {
    /// Locked copper; a problem read before the layer rows has the plain rows only.
    pub fn locked_copper(&self) -> &[CopperRow] {
        self.fixed_copper_layers.as_deref().unwrap_or(&self.fixed_copper)
    }

    /// The box around the outline.
    pub fn outline_box(&self) -> Rect {
        let fold = |f: fn(f64, f64) -> f64, g: fn(&Point) -> f64| {
            self.outline.iter().map(g).reduce(f).expect("a board outline has points")
        };
        Rect::new(fold(f64::min, |p| p.0), fold(f64::min, |p| p.1), fold(f64::max, |p| p.0), fold(f64::max, |p| p.1))
    }
}

/// [layer, x0, y0, x1, y1, width]; layer 'via' = a via at (x0, y0) with diameter width.
#[derive(Clone, Debug, Deserialize)]
pub struct CopperRow(pub String, pub f64, pub f64, pub f64, pub f64, pub f64);

#[derive(Debug, Deserialize)]
pub struct Region {
    #[serde(default, rename = "box")]
    pub area: Option<Rect>,
    #[serde(default = "one")]
    pub weight: f64,
}

fn one() -> f64 {
    1.0
}

#[derive(Debug, Deserialize)]
pub struct ClassGaps {
    #[serde(default)]
    pub gaps: Vec<Vec<f64>>,
}

#[derive(Debug, Deserialize)]
pub struct DomainArea {
    pub classes: Vec<i64>,
    pub gap: f64,
}

#[derive(Debug, Deserialize)]
pub struct EscapeRules {
    pub track: f64,
    pub clearance: f64,
    pub via_d: f64,
}

#[derive(Debug, Deserialize)]
pub struct RouteRules {
    /// Net class to [clearance, track].
    pub classes: BTreeMap<String, (f64, f64)>,
    pub dru: crate::dru::Rules,
}

impl Problem {
    pub fn load(path: &Path) -> crate::Result<Self> {
        let text = std::fs::read_to_string(path).map_err(|e| format!("{}: {e}", path.display()))?;
        let problem: Self = serde_json::from_str(&text).map_err(|e| format!("{}: {e}", path.display()))?;
        problem.check_supported()?;
        Ok(problem)
    }

    /// The two rule sets this search does not evaluate. They make a place illegal, so a run must not skip them.
    pub fn check_supported(&self) -> crate::Result<()> {
        if truthy(&self.engineering) {
            return Err("a problem with a reviewed engineering contract runs on tools/placer/cli.py".into());
        }
        if truthy(&self.part_rules) {
            return Err("part_rules belong to the pcb_search placer".into());
        }
        Ok(())
    }

    pub fn initial_pose(&self) -> Pose {
        self.units.iter().map(Unit::place).collect()
    }

    /// The box a unit origin may move in.
    pub fn move_box(&self) -> Rect {
        self.move_box.unwrap_or_else(|| self.board.outline_box())
    }
}

fn truthy(v: &Value) -> bool {
    match v {
        Value::Null => false,
        Value::Bool(b) => *b,
        Value::Array(a) => !a.is_empty(),
        Value::Object(o) => !o.is_empty(),
        _ => true,
    }
}

/// A pose row of a result file, for the commands that read one back.
#[derive(Debug, Serialize, Deserialize)]
pub struct PoseFile {
    pub pose: Pose,
}
