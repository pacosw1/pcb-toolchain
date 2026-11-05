//! What admission reads and what it records. The field names are the evidence format: rule-coverage*.json.
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::BTreeMap;

/// An item that stays on the board while the route runs.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Obstacle {
    #[serde(rename = "NetName")]
    pub net_name: String,
    #[serde(rename = "Type")]
    pub kind: String,
    #[serde(rename = "Pad_Type", default, skip_serializing_if = "Option::is_none")]
    pub pad_type: Option<String>,
}

/// What the route may touch: the nets it adds copper to, the native class of every net, what stays, the job layers.
#[derive(Debug, Clone, Copy)]
pub struct RouteScope<'a> {
    pub active_nets: &'a [String],
    pub net_classes: &'a BTreeMap<String, String>,
    pub obstacles: &'a [Obstacle],
    pub layers: &'a [String],
}

impl RouteScope<'_> {
    pub fn sorted_active(&self) -> Vec<String> {
        let mut nets = self.active_nets.to_vec();
        nets.sort();
        nets
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Disposition {
    Covered,
    Unsupported,
    WeakerThanNative,
    NotApplicable,
    ImmutableUnchanged,
    NativePostcondition,
}

impl Disposition {
    /// True when the row keeps the solver from starting.
    pub fn blocks(self) -> bool {
        matches!(self, Disposition::Unsupported | Disposition::WeakerThanNative)
    }

    pub fn name(self) -> &'static str {
        match self {
            Disposition::Covered => "covered",
            Disposition::Unsupported => "unsupported",
            Disposition::WeakerThanNative => "weaker_than_native",
            Disposition::NotApplicable => "not_applicable",
            Disposition::ImmutableUnchanged => "immutable_unchanged",
            Disposition::NativePostcondition => "native_postcondition",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Witness {
    pub active: String,
    /// None for a rule on one item.
    pub obstacle: Option<String>,
}

/// One requirement and what became of it.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Row {
    pub rule: String,
    pub constraint: String,
    pub disposition: Disposition,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub witness: Option<Witness>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub required_mm: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model_floor_mm: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub hole_geometry: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub analytical_hole_geometry: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub native_obligation: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub nets: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source: Option<Value>,
    /// Fields of the project rows that admission only carries.
    #[serde(flatten)]
    pub extra: BTreeMap<String, Value>,
}

impl Row {
    /// A row that is unsupported until proved otherwise.
    pub fn new(rule: &str, constraint: &str) -> Row {
        Row {
            rule: rule.to_string(),
            constraint: constraint.to_string(),
            disposition: Disposition::Unsupported,
            reason: None,
            witness: None,
            required_mm: None,
            model_floor_mm: None,
            hole_geometry: None,
            analytical_hole_geometry: None,
            native_obligation: None,
            nets: None,
            source: None,
            extra: BTreeMap::new(),
        }
    }

    pub fn unsupported(rule: &str, constraint: &str, reason: impl Into<String>) -> Row {
        let mut row = Row::new(rule, constraint);
        row.reason = Some(reason.into());
        row
    }

    pub fn settle(&mut self, disposition: Disposition, reason: impl Into<String>) {
        self.disposition = disposition;
        self.reason = Some(reason.into());
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Status {
    Blocked,
    PendingNative,
    Passed,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct DsnBinding {
    pub path: String,
    pub sha256: Option<String>,
}

/// What `check_files` adds to the decision: the exact inputs it is bound to.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct FileBinding {
    pub backend_command: Option<Vec<String>>,
    pub backend_command_sha256: Option<String>,
    pub backend_policy: Option<Value>,
    pub drilled_geometry_preserved: bool,
    pub fixed_geometry_preserved: bool,
    pub added_base_vias: usize,
    pub model_status: String,
    /// Absolute path to SHA-256, None for a file that is absent. Includes the running executable, the code that decided.
    pub inputs: BTreeMap<String, Option<String>>,
    pub dsn: DsnBinding,
    pub native_classes: BTreeMap<String, String>,
    pub footprint_scope_sha256: String,
    pub obstacle_scope_sha256: String,
}

/// The admission record, `iot-lab.route-rule-coverage.v1`.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Coverage {
    pub schema: &'static str,
    pub status: Status,
    pub solver_launch_allowed: bool,
    pub active_nets: Vec<String>,
    pub job_layers: Vec<String>,
    pub requirements: Vec<Row>,
    pub qualified: bool,
    pub scope: String,
    pub cause: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub native_pth_geometry_unknown: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub native_drilled_geometry_unknown: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub native_thermal_capability: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub native_postconditions: Option<Vec<Value>>,
    #[serde(flatten, skip_serializing_if = "Option::is_none")]
    pub files: Option<FileBinding>,
}
