//! The route model as the core reads it (schema iot-lab.route-model.v0). Lengths in mm. Object keys carry no order; every list
//! keeps its order.
use super::num::Num;
use serde::{Deserialize, Serialize};
use serde_json::value::RawValue;
use std::collections::BTreeMap;

pub type Point = [f64; 2];
pub type Box4 = [f64; 4];

#[derive(Debug, Serialize)]
pub struct Model {
    pub schema: &'static str,
    pub board: String,
    pub pcb: String,
    pub copper_layers: Vec<String>,
    pub plane_layers: Vec<String>,
    pub adjacent: BTreeMap<String, String>,
    pub grounds: Vec<String>,
    #[serde(rename = "current_dT")]
    pub current_dt: f64,
    pub copper_thickness: BTreeMap<String, f64>,
    pub outline_bbox: Box4,
    pub setup: Setup,
    pub return_rule: Option<ReturnRule>,
    pub via_length: Option<f64>,
    pub classes: BTreeMap<String, Class>,
    pub nets: BTreeMap<String, Net>,
    pub pairs: Vec<Box<RawValue>>,
    pub zones: Vec<Zone>,
    pub keepouts: Vec<Keepout>,
    pub edges: Vec<Box4>,
    pub hole_rules: HoleRules,
    pub pads: Vec<Pad>,
    pub copper: Vec<Copper>,
    pub rules: Vec<RuleReport>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub iso: Option<Iso>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ref_fill: Option<RefFill>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub return_net: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub return_nets: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub return_exempt: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub return_scope: Option<ReturnScope>,
}

#[derive(Debug, Serialize)]
pub struct Setup {
    pub min_via: Option<Num>,
    pub min_drill: Option<Num>,
    pub min_clearance: Option<Num>,
    pub min_track: Option<Num>,
    pub edge_clearance: Option<Num>,
    pub min_spokes: Num,
}

#[derive(Debug, Clone, Serialize)]
pub struct Class {
    pub width: Option<Num>,
    pub clearance: Option<Num>,
    pub via: Option<Num>,
    pub drill: Option<Num>,
}

#[derive(Debug, Serialize)]
pub struct ReturnRule {
    pub radius: f64,
    pub pads: bool,
    pub source: String,
}

#[derive(Debug, Serialize)]
pub struct ReturnScope {
    pub source: &'static str,
    pub power_rails: Vec<String>,
    pub skip: Vec<String>,
}

#[derive(Debug, Clone, Default, Serialize)]
pub struct Limits {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub via_count: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub length: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub amps: Option<Num>,
}

/// The via of a net. `current` says why the current made it larger.
#[derive(Debug, Clone, Default, Serialize)]
pub struct NetVia {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub hole_size: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub via_diameter: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub annular_width: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub current: Option<String>,
}

#[derive(Debug, Clone, Default, Serialize)]
pub struct Net {
    pub class: String,
    pub pins: Vec<String>,
    pub fast: bool,
    pub plane: bool,
    pub layers: Vec<String>,
    pub width: Option<Num>,
    pub clearance: Option<Num>,
    pub limits: Limits,
    pub plane_ref: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub via: Option<NetVia>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub twin: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub plane_off: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub plane_polys: Option<Vec<Vec<Point>>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub power_chains: Option<Vec<PowerChain>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub min_width: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub min_width_layers: Option<BTreeMap<String, f64>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ref_domain: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ref_soft: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub input_vias: Option<u32>,
}

#[derive(Debug, Clone, Serialize)]
pub struct PowerChain {
    pub pads: Vec<String>,
    pub amps: Num,
    pub min_width: f64,
    pub min_width_layers: BTreeMap<String, f64>,
}

/// DRU clearance of an item type to a zone.
#[derive(Debug, Clone, Default, PartialEq, Serialize)]
pub struct ItemClearance {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub track: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub via: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pad: Option<f64>,
}

#[derive(Debug, Clone, Serialize)]
pub struct Zone {
    pub net: String,
    pub layer: String,
    pub clearance: f64,
    pub thermal_gap: f64,
    pub spoke_width: f64,
    pub pad_connection: &'static str,
    pub min_thickness: f64,
    pub island_removal_mode: i64,
    pub min_island_area_mm2: f64,
    pub bbox: Box4,
    pub net_clearance: BTreeMap<String, ItemClearance>,
}

#[derive(Debug, Serialize)]
pub struct Keepout {
    pub name: String,
    pub footprint: String,
    pub layers: Vec<String>,
    pub tracks: bool,
    pub vias: bool,
    pub pour: bool,
    pub rect: bool,
    pub bbox: Box4,
    pub pts: Vec<Vec<Point>>,
    pub holes: Vec<Vec<Point>>,
}

#[derive(Debug, Clone, Serialize)]
pub struct HoleRule {
    pub rule: String,
    pub min: f64,
    pub scope: &'static str,
}

#[derive(Debug, Serialize)]
pub struct PlaneClearance {
    pub min: f64,
    pub source: String,
}

#[derive(Debug, Serialize)]
pub struct BoardMin {
    pub hole_clearance: Option<Num>,
    pub hole_to_hole: Option<Num>,
}

#[derive(Debug, Serialize)]
pub struct HoleRules {
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub hole_to_hole: Vec<HoleRule>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub hole_clearance: Vec<HoleRule>,
    pub plane_clearance: PlaneClearance,
    pub board_min: BoardMin,
}

#[derive(Debug, Clone, Default, Serialize)]
pub struct Pad {
    #[serde(rename = "ref")]
    pub reference: String,
    pub num: String,
    pub net: String,
    pub x: f64,
    pub y: f64,
    pub bbox: Box4,
    pub layers: Vec<String>,
    pub drill: f64,
    pub shape: &'static str,
    pub spoke_deg: f64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub via_in_pad: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub zone_conn: Option<&'static str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub proxy_spokes: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub iso_grp: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub fanout_via: Option<FanoutVia>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub thermal_vias: Option<ThermalVias>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub escape: Option<Escape>,
}

impl Pad {
    pub fn name(&self) -> String {
        format!("{}.{}", self.reference, self.num)
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct FanoutVia {
    pub hole_size: f64,
    pub via_diameter: f64,
    pub amps: Num,
}

#[derive(Debug, Clone, Serialize)]
pub struct ThermalVias {
    pub vias: Vec<Point>,
    pub d: f64,
    pub drill: f64,
    pub long: i64,
    pub short: i64,
    pub pitch: [f64; 2],
    pub source: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct Escape {
    pub width: f64,
    pub length: f64,
    pub pin_amps: Num,
    pub net_amps: Num,
    pub source: String,
}

#[derive(Debug, Serialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum Copper {
    Via { net: String, x: f64, y: f64, d: f64, drill: f64 },
    Track { net: String, layer: String, a: Point, b: Point, w: f64 },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum RuleState {
    Applied,
    Checked,
    Plane,
    Stage,
    Unknown,
}

impl RuleState {
    pub fn name(self) -> &'static str {
        match self {
            RuleState::Applied => "applied",
            RuleState::Checked => "checked",
            RuleState::Plane => "plane",
            RuleState::Stage => "stage",
            RuleState::Unknown => "unknown",
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RuleReport {
    pub rule: String,
    pub constraint: String,
    pub state: RuleState,
    pub nets: Vec<String>,
    pub why: String,
}

#[derive(Debug, Serialize)]
pub struct IsoRegion {
    pub key: String,
    pub polys: Vec<Vec<Point>>,
}

#[derive(Debug, Serialize)]
pub struct IsoNet {
    pub track: Vec<usize>,
    pub via: Vec<usize>,
}

#[derive(Debug, Serialize)]
pub struct Iso {
    pub groups: usize,
    pub table: Vec<f64>,
    pub var: BTreeMap<String, IsoNet>,
    pub max: f64,
    pub regions: Vec<IsoRegion>,
    pub rules: Vec<String>,
    pub reps: Vec<String>,
}

#[derive(Debug, Serialize)]
pub struct RefLayer {
    pub plane: String,
    /// Per domain, polygons of an outline and holes.
    pub domains: BTreeMap<String, Vec<Vec<Vec<Point>>>>,
}

/// x, y, radius, net.
pub type Anchor = (f64, f64, f64, String);

#[derive(Debug, Serialize)]
pub struct RefFill {
    pub source: &'static str,
    pub via_allow: Num,
    pub layers: BTreeMap<String, RefLayer>,
    pub anchors: Vec<Anchor>,
}
