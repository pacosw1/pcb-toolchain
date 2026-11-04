//! The calls admission makes into the hole, project and thermal proofs. Those live in tools/route-coverage, which depends on
//! this crate, so the job reaches them through its `route-coverage` binary. This trait is the whole surface.
use super::{Model, RouteScope, Row};
use serde_json::{Value, json};
use std::env;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

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
    /// `route_project_coverage.evaluate`.
    fn evaluate_project(&self, request: &ProjectRequest) -> Result<Vec<Row>, String>;
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

/// The proofs through the `route-coverage` binary: one JSON request in, one JSON value out.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RouteCoverageTool {
    pub binary: PathBuf,
}

impl Default for RouteCoverageTool {
    /// `ROUTE_COVERAGE_BIN`, else `route-coverage` from the PATH.
    fn default() -> Self {
        RouteCoverageTool { binary: env::var_os("ROUTE_COVERAGE_BIN").filter(|value| !value.is_empty()).map_or_else(|| "route-coverage".into(), PathBuf::from) }
    }
}

impl RouteCoverageTool {
    fn call(&self, operation: &str, request: &Value) -> Result<Value, String> {
        let spawn_error = |error: std::io::Error| format!("{}: {error}", self.binary.display());
        let mut child = Command::new(&self.binary).arg(operation).stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped()).spawn().map_err(spawn_error)?;
        let input = child.stdin.take().ok_or("route-coverage has no stdin")?;
        let body = request.to_string();
        let writer = std::thread::spawn(move || {
            let mut input = input;
            input.write_all(body.as_bytes())
        });
        let output = child.wait_with_output().map_err(spawn_error)?;
        writer.join().map_err(|_| "route-coverage writer panicked".to_string())?.map_err(spawn_error)?;
        if !output.status.success() {
            let text = String::from_utf8_lossy(&output.stderr);
            return Err(text.trim().trim_start_matches("FAIL: route-coverage: ").to_string());
        }
        serde_json::from_slice(&output.stdout).map_err(|error| format!("route-coverage {operation}: {error}"))
    }

    fn list(&self, operation: &str, board: &Path) -> Result<Vec<Value>, String> {
        match self.call(operation, &json!({"board": board}))? {
            Value::Array(items) => Ok(items),
            other => Err(format!("route-coverage {operation}: expected a list, got {other}")),
        }
    }
}

impl Collaborators for RouteCoverageTool {
    fn evaluate_project(&self, request: &ProjectRequest) -> Result<Vec<Row>, String> {
        let scope = &request.scope;
        let rows = self.call("evaluate", &json!({
            "text": request.text,
            "source": request.source,
            "dsn_text": request.dsn_text,
            "active_nets": scope.active_nets,
            "net_classes": scope.net_classes,
            "obstacles": scope.obstacles,
            "holes": request.holes,
            "holes_preserved": request.holes_preserved,
            "immutable_geometry_preserved": request.immutable_geometry_preserved,
            "backend_command": request.backend_command.unwrap_or_default(),
            "thermal": request.thermal,
            "backend_policy": request.backend_policy,
            "native_thermal_capability": request.native_thermal_capability,
            "added_vias": request.added_vias,
        }))?;
        serde_json::from_value(rows).map_err(|error| format!("route-coverage evaluate: {error}"))
    }

    fn native_pth_pads(&self, base: &Path) -> Result<Vec<Value>, String> {
        self.list("native-pth-pads", base)
    }

    fn native_drilled_geometry(&self, board: &Path) -> Result<Vec<Value>, String> {
        self.list("native-drilled-geometry", board)
    }

    fn inspect_holes(&self, request: &HoleRequest) -> Result<Value, String> {
        self.call("inspect", &json!({
            "dsn_text": request.dsn_text,
            "pads": request.pads,
            "active_nets": request.active_nets,
            "layers": request.layers,
            "required_mm": request.required_mm,
            "clearance_floor_mm": request.clearance_floor_mm,
        }))
    }

    fn inspect_drilled(&self, request: &DrilledRequest) -> Result<Value, String> {
        self.call("inspect-drilled", &json!({
            "dsn_text": request.dsn_text,
            "holes": request.holes,
            "active_nets": request.active_nets,
            "layers": request.layers,
            "required_mm": request.required_mm,
            "clearance_floor_mm": request.clearance_floor_mm,
            "applicability": request.applicability,
            "backend_command": request.backend_command.unwrap_or_default(),
            "backend_policy": request.backend_policy,
        }))
    }

    fn validate_thermal_capability(&self, supplied: &Value, board: &Path, base: &Path, selected_nets: &[String]) -> Result<Value, String> {
        self.call("validate-capability", &json!({"capability": supplied, "source": board, "base": base, "selected_nets": selected_nets}))
    }
}
