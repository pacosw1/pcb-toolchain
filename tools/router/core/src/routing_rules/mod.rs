//! Routing stages, reference-plane keepouts, fan-out and repair selection. All distances are board millimetres, y down.
//! Used by the `routing_rules` JSON CLI inside a route job; no KiCad process is needed for this arithmetic.
pub mod geometry;
pub mod report;
pub mod stages;

use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet};

pub type Point = [f64; 2];
pub type Rect = [f64; 4];
pub type Disc = [f64; 3];
pub type Rings = Vec<Vec<Point>>;
pub type Keepouts = BTreeMap<String, Vec<Rect>>;

pub fn matches(net: &str, patterns: &[String]) -> bool {
    patterns
        .iter()
        .any(|p| iotroute::model::text::glob_match(net, p))
}

pub fn distance(a: Point, b: Point) -> f64 {
    (a[0] - b[0]).hypot(a[1] - b[1])
}

#[derive(Debug, Clone, Default, Deserialize, Serialize)]
#[serde(default)]
pub struct MixedLayer {
    pub power: Vec<String>,
    pub fast_file: Option<String>,
    #[serde(flatten)]
    pub extra: BTreeMap<String, serde_json::Value>,
}

#[derive(Debug, Clone, Default, Deserialize, Serialize)]
#[serde(default)]
pub struct AltReference {
    pub cap_mm: Option<f64>,
    pub slow_only: bool,
    #[serde(flatten)]
    pub extra: BTreeMap<String, serde_json::Value>,
}

#[derive(Debug, Clone, Default, Deserialize, Serialize)]
#[serde(default)]
pub struct Exemptions {
    pub nets: BTreeMap<String, serde_json::Value>,
    #[serde(flatten)]
    pub extra: BTreeMap<String, serde_json::Value>,
}

#[derive(Debug, Clone, Default, Deserialize, Serialize)]
#[serde(default)]
pub struct ReferenceSpec {
    pub grounds: Vec<String>,
    pub power: Vec<String>,
    pub adjacent: BTreeMap<String, String>,
    pub mixed_layers: BTreeMap<String, MixedLayer>,
    pub exempt: Exemptions,
    pub alt_refs: BTreeMap<String, AltReference>,
    pub fast_file: Option<String>,
    #[serde(flatten)]
    pub extra: BTreeMap<String, serde_json::Value>,
}

impl ReferenceSpec {
    pub fn power_patterns(&self) -> Vec<String> {
        self.power
            .iter()
            .chain(self.mixed_layers.values().flat_map(|m| &m.power))
            .cloned()
            .collect()
    }

    pub fn ref_nets(&self, fast: bool) -> BTreeSet<String> {
        self.grounds
            .iter()
            .cloned()
            .chain(
                self.alt_refs
                    .iter()
                    .filter(|(_, a)| a.cap_mm.is_none() && !(fast && a.slow_only))
                    .map(|(n, _)| n.clone()),
            )
            .collect()
    }
}
