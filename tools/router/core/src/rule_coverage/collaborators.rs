//! The calls admission makes into route_hole_coverage, route_project_coverage and route_native_thermals, which have their own
//! ports. This is the whole surface: what each call takes and gives, named as the Python functions are.
use super::{Model, RouteScope, Row};
use crate::decimal::Decimal;
use crate::kicad::raw::Form;
use serde_json::Value;
use std::collections::BTreeMap;
use std::path::Path;

/// A netclass of the project: its position in the file (the source pointer) and its authored clearance. A value that is not
/// a finite non-negative number is the error `_number` gives, kept until something needs it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ClassClearance {
    pub index: usize,
    pub clearance: Option<Result<Decimal, String>>,
}

/// What `route_project_coverage._load` and `_number` give the clearance floor.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ProjectClearances {
    pub classes: BTreeMap<String, ClassClearance>,
    pub min_clearance: Option<Result<Decimal, String>>,
}

/// `route_hole_coverage.inspect`.
#[derive(Debug, Clone, Copy)]
pub struct HoleRequest<'a> {
    pub dsn_text: &'a str,
    pub pads: &'a [Value],
    pub active_nets: &'a [String],
    pub layers: &'a [String],
    pub required_mm: &'a str,
    pub clearance_floor_mm: &'a str,
}

/// `route_hole_coverage.inspect_drilled`.
#[derive(Debug, Clone, Copy)]
pub struct DrilledRequest<'a> {
    pub dsn_text: &'a str,
    pub holes: &'a [Value],
    pub active_nets: &'a [String],
    pub layers: &'a [String],
    pub required_mm: &'a str,
    pub clearance_floor_mm: &'a str,
    pub applicability: &'a str,
    pub backend_command: Option<&'a [String]>,
    pub backend_policy: Option<&'a Value>,
}

/// `route_project_coverage.evaluate`.
#[derive(Clone, Copy)]
pub struct ProjectRequest<'a> {
    /// None for a missing project file.
    pub text: Option<&'a str>,
    pub source: &'a Path,
    pub model: &'a Model,
    pub dsn_text: &'a str,
    pub scope: RouteScope<'a>,
    pub holes: Option<&'a [Value]>,
    pub holes_preserved: bool,
    pub immutable_geometry_preserved: bool,
    pub backend_command: Option<&'a [String]>,
    pub thermal: &'a Value,
    pub backend_policy: Option<&'a Value>,
    pub native_thermal_capability: Option<&'a Value>,
    pub added_vias: Option<&'a [Value]>,
}

pub trait Collaborators {
    /// `route_project_coverage._load`, with `_number` of the clearances.
    fn project_clearances(&self, project_text: &str) -> Result<ProjectClearances, String>;
    /// `route_project_coverage.evaluate`.
    fn evaluate_project(&self, request: &ProjectRequest) -> Result<Vec<Row>, String>;
    /// `route_project_coverage.thermal_scope`.
    fn thermal_scope(&self, native_roots: &[Form], custom_rules: &[Form]) -> Value;
    /// `route_hole_coverage.native_pth_pads`.
    fn native_pth_pads(&self, base: &Path) -> Result<Vec<Value>, String>;
    /// `route_hole_coverage.native_drilled_geometry`.
    fn native_drilled_geometry(&self, board: &Path) -> Result<Vec<Value>, String>;
    /// `route_hole_coverage.inspect`.
    fn inspect_holes(&self, request: &HoleRequest) -> Result<Value, String>;
    /// `route_hole_coverage.inspect_drilled`.
    fn inspect_drilled(&self, request: &DrilledRequest) -> Result<Value, String>;
    /// `route_native_thermals.validate_capability`.
    fn validate_thermal_capability(&self, supplied: &Value, board: &Path, base: &Path, selected_nets: &[String]) -> Result<Value, String>;
}
