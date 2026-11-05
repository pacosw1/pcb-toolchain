//! The problem file as the reader writes it. problem.rs reads the part the search needs.

use super::grouping::Decap;
use super::project::{ClassGaps, DomainArea, EscapeRules};
use crate::dru::Rules;
use serde::Serialize;
use serde_json::Value;
use std::collections::BTreeMap;

pub type Xy = [f64; 2];
pub type Box4 = [f64; 4];

#[derive(Clone, Debug, Serialize)]
pub struct Edge {
    pub at: Xy,
    pub sides: String,
    pub tol: f64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub inset: Option<f64>,
}

/// A copper pad row: box relative to the unit and net code (-1: a no-via area).
#[derive(Clone, Debug, Serialize)]
pub struct CuRow(pub f64, pub f64, pub f64, pub f64, pub i64);

fn no(v: &bool) -> bool {
    !*v
}

#[derive(Clone, Debug, Default, Serialize)]
pub struct Unit {
    pub name: String,
    pub refs: Vec<String>,
    pub fixed: bool,
    pub x: f64,
    pub y: f64,
    pub rects: Vec<[f64; 5]>,
    pub pads: Vec<Xy>,
    pub centres: BTreeMap<String, Xy>,
    pub borders: Vec<String>,
    #[serde(rename = "box")]
    pub boxed: Option<Box4>,
    pub group: Option<String>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub hard: Vec<usize>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub dom: Vec<(usize, i64, f64, f64)>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub mech: Vec<usize>,
    #[serde(skip_serializing_if = "no")]
    pub nocu: bool,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub rho: Vec<(usize, f64)>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub border: Vec<usize>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub locked_cu: Vec<String>,
    pub cu: Vec<CuRow>,
    pub cu_pads: Vec<(String, String, String)>,
    pub pad_copper_layers: Vec<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub edge_pads: Option<Vec<Box4>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pad_rects: Option<Vec<Box4>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub edge: Option<Edge>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub ko: Vec<usize>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub zones: Vec<String>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub cuts: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub in_box: Option<Box4>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub near: Vec<[f64; 5]>,
}

impl Unit {
    /// A rect in board mm as a row relative to the unit, with its spacing class.
    pub fn local(&self, r: crate::geom::Rect, spacing: f64) -> [f64; 5] {
        [r.x0 - self.x, r.y0 - self.y, r.x1 - self.x, r.y1 - self.y, spacing]
    }
}

/// A net: real nets have points and a track; cohesion nets only tie a group.
#[derive(Clone, Debug, Serialize)]
pub struct Net {
    pub name: String,
    pub weight: f64,
    pub pins: Vec<(usize, f64, f64, f64, f64)>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pts: Option<Vec<Vec<Xy>>>,
    pub track: f64,
    #[serde(skip_serializing_if = "no")]
    pub cohesion: bool,
}

/// A copper row: layer (or 'via'), x0, y0, x1, y1, width.
#[derive(Clone, Debug, Serialize)]
pub struct CopperRow(pub String, pub f64, pub f64, pub f64, pub f64, pub f64);

#[derive(Debug, Serialize)]
pub struct BoardOut {
    pub outline: Vec<Xy>,
    pub keepouts: Vec<Vec<Xy>>,
    pub edge_clearance: f64,
    pub copper: Vec<CopperRow>,
    pub fixed_copper: Vec<CopperRow>,
    pub fixed_copper_layers: Vec<CopperRow>,
    pub via_keepouts: Vec<Vec<Xy>>,
    pub keepout_gaps: BTreeMap<String, f64>,
}

#[derive(Debug, Serialize)]
pub struct Region {
    #[serde(rename = "box")]
    pub boxed: Box4,
    pub weight: f64,
    pub refs: Vec<String>,
}

#[derive(Debug, Serialize)]
pub struct RouteRules {
    pub dru: DruRules,
    pub classes: BTreeMap<String, [f64; 2]>,
}

#[derive(Debug, Serialize)]
pub struct DruRules {
    pub domains: Vec<(String, f64, f64)>,
    pub holes: Vec<(String, Vec<String>, f64)>,
    pub pairs: Vec<(Vec<String>, Vec<String>, f64)>,
    pub members: Vec<(String, String, String)>,
}

impl From<&Rules> for DruRules {
    fn from(r: &Rules) -> Self {
        Self { domains: r.domains.clone(), holes: r.holes.clone(), pairs: r.pairs.clone(), members: r.members.clone() }
    }
}

#[derive(Debug, Serialize)]
pub struct ProblemOut {
    pub board_file: String,
    pub units: Vec<Unit>,
    pub nets: Vec<Net>,
    pub board: BoardOut,
    pub region: Option<Region>,
    pub move_box: Option<Box4>,
    pub decaps: Vec<Decap>,
    pub dru_ignored: Vec<String>,
    pub class_gaps: Option<ClassGaps>,
    pub domain_areas: Vec<DomainArea>,
    pub route_rules: RouteRules,
    pub escape_rules: EscapeRules,
    pub cu_nets: BTreeMap<String, (String, String)>,
    pub via_nets: Vec<i64>,
    pub plane_nets: Vec<String>,
    /// A reviewed engineering contract, when the read had one.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub engineering: Option<Value>,
}
