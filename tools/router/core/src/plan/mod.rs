//! Route plan: `<board>/route.json` and what follows from it. No board access and no process.
//!
//! Schema `iot-lab.route.v1`, which replaces the per-board route scripts:
//!
//! ```text
//! {"schema": "iot-lab.route.v1", "about": "...", "backend": "tracemaker" | "iotroute",
//!  "layers": ["F.Cu", "B.Cu"],                      signal layers of every stage unless the stage sets its own
//!  "budget": {"passes": 60, "time_s": 300, "threads": 0},
//!  "stages": [{                                     run in order; the copper of a stage is locked for the next
//!      "name": "mains",
//!      "only_nets": [...] | "skip_nets": [...],     not both; skip_nets are glob patterns
//!      "layers": [...], "passes": N, "time_s": N, "threads": N,
//!      "plane_nets": [...], "route_planes": false,  plane nets get pad vias and are not routed (unless route_planes)
//!      "neck_um": 0, "unlock_nets": [...], "via_skip": ["U2", "R7.1"],
//!      "remove_zones": ["BARRIER_BAND"],            zones taken out for this stage only, then put back
//!      "keepouts": [{"name": "SELV", "inside" | "outside": [x0, y0, x1, y1], "layers": [...]}],   this stage only;
//!                                                   no tracks, vias or fills; default layers: all copper
//!      "require": {"open": 0, "vias": null}}],      fail the run above these counts on the stage nets
//!  "pours": [{"name", "net", "layer", "shape": "board" | "around", "grow_mm", "priority", "connection",
//!             "minus": [[x0, y0, x1, y1]],          boxes cut out of the pour
//!             "clearance_mm": 0.3, "thermal_gap_mm": 0.4, "spoke_mm": 1.0}],
//!  "widths": [{"name", "box": [x0, y0, x1, y1], "layers": [...], "width_mm"}],   after the route, before the pours:
//!                                                   a track whose midpoint is in the box gets width_mm (never wider)
//!  "features": {"via_off_small_pads": true}}        tools/route-features.json switches; job/route_run/iotroute.rs says which iotroute takes
//! ```
//!
//! Boxes are in mm, board coordinates. "around" pours cover the pads and copper of the net grown by grow_mm.
mod board_text;
mod load;
mod stage;
#[cfg(test)]
mod tests;

use serde::Serialize;
use std::collections::BTreeMap;

pub use board_text::{add_blocks, copy_block, split_zones};
pub use load::load;
pub use stage::open_nets;

pub const SCHEMA: &str = "iot-lab.route.v1";
/// What a plan or command line that still names the removed router gets.
pub const NO_FASTROUTE: &str = "backend fastroute was removed on 2026-11-05: this board needs the iotroute backend of `iotroute route`";
/// KiCad 10 stops its list of open connections here, so a full list cannot prove that a net is connected.
pub const DRC_UNCONNECTED_CAP: usize = 499;

/// `[x0, y0, x1, y1]` in mm, with x0 < x1 and y0 < y1.
pub type Rect = [f64; 4];

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Backend {
    Tracemaker,
    Iotroute,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub struct Budget {
    pub passes: u64,
    pub time_s: u64,
    pub threads: u64,
}

pub const DEFAULT_BUDGET: Budget = Budget { passes: 60, time_s: 300, threads: 0 };

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum KeepoutMode {
    Inside,
    /// Covers the board box grown by 5 mm minus the box.
    Outside,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Keepout {
    pub name: String,
    pub mode: KeepoutMode,
    #[serde(rename = "box")]
    pub bounds: Rect,
    pub layers: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Stage {
    pub name: String,
    pub only_nets: Vec<String>,
    pub skip_nets: Vec<String>,
    pub layers: Vec<String>,
    pub plane_nets: Vec<String>,
    pub route_planes: bool,
    pub neck_um: u64,
    pub unlock_nets: Vec<String>,
    pub via_skip: Vec<String>,
    pub remove_zones: Vec<String>,
    pub keepouts: Vec<Keepout>,
    #[serde(flatten)]
    pub budget: Budget,
    pub require_open: u64,
    pub max_vias: Option<u64>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum PourShape {
    Board,
    Around,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum PourConnection {
    Full,
    Thermal,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Pour {
    pub name: String,
    pub net: String,
    pub layer: String,
    pub shape: PourShape,
    /// Set for an "around" pour; a "board" pour does not use it.
    pub grow_mm: Option<f64>,
    pub priority: u64,
    pub connection: PourConnection,
    pub minus: Vec<Rect>,
    pub clearance_mm: f64,
    pub thermal_gap_mm: f64,
    pub spoke_mm: f64,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct WidthRule {
    pub name: String,
    #[serde(rename = "box")]
    pub bounds: Rect,
    pub layers: Vec<String>,
    pub width_mm: f64,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Plan {
    pub backend: Backend,
    pub about: String,
    pub layers: Vec<String>,
    pub stages: Vec<Stage>,
    pub pours: Vec<Pour>,
    pub widths: Vec<WidthRule>,
    pub features: BTreeMap<String, bool>,
}
