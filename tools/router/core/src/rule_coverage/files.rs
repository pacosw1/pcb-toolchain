//! Binding the decision to the exact original inputs and the final transformed DSN.
//!
//! `inputs` records what the decision read. Where the Python recorded its own source files, this records the running
//! executable: that is the code that decided.
use super::dsn_model::first_minimum;
use super::forms::rule_forms;
use super::identity::{FootprintIdentity, fixed_geometry, footprint_identity};
use super::{Collaborators, Coverage, Disposition, DrilledRequest, DsnBinding, FileBinding, Model, ProjectRequest, RouteScope, Row, Status, inspect, thermal_scope, validate_backend_command};
use crate::decimal::Decimal;
use crate::pytext::{Separators, dumps};
use crate::sha256::sha256;
use serde_json::{Value, json};
use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::path::{Path, PathBuf};

const FILES_SCOPE: &str = "native custom/project rule model coverage; final fresh native/configured gates remain mandatory";

/// One admission.
#[derive(Debug, Clone, Copy)]
pub struct CheckRequest<'a> {
    pub board: &'a Path,
    pub base: &'a Path,
    pub dsn: &'a Path,
    pub scope: RouteScope<'a>,
    pub gate: Option<&'a Path>,
    pub backend_command: Option<&'a [String]>,
    pub backend_policy: Option<&'a Value>,
    pub native_thermal_capability: Option<&'a Value>,
}

fn read_text(path: &Path) -> Result<String, String> {
    fs::read_to_string(path).map_err(|error| format!("{}: {error}", path.display()))
}

fn digest(path: &Path) -> Result<Option<String>, String> {
    if !path.is_file() {
        return Ok(None);
    }
    fs::read(path).map(|bytes| Some(sha256(&bytes))).map_err(|error| format!("{}: {error}", path.display()))
}

fn is_digest(value: &Value) -> bool {
    value.is_null() || value.as_str().is_some_and(|text| text.len() == 64 && text.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f')))
}

type Inputs = BTreeMap<String, Option<String>>;

fn bind(inputs: &mut Inputs, name: &str, value: &Value, changed: &str) -> Result<(), String> {
    let wanted = value.as_str().map(str::to_string);
    if inputs.get(name).is_some_and(|known| *known != wanted) {
        return Err(changed.to_string());
    }
    inputs.insert(name.to_string(), wanted);
    Ok(())
}

/// Every file of the admission and its digest now.
fn snapshot(request: &CheckRequest, sidecars: &Sidecars) -> Result<Inputs, String> {
    let mut paths: Vec<PathBuf> = vec![request.board.into(), request.base.into(), request.dsn.into(), sidecars.rules.clone(), sidecars.base_rules.clone(), sidecars.project.clone(), sidecars.base_project.clone()];
    paths.extend(std::env::current_exe().ok());
    paths.extend(request.backend_command.and_then(|command| command.first()).map(PathBuf::from));
    paths.extend(request.gate.map(PathBuf::from));
    paths.into_iter().map(|path| Ok((path.display().to_string(), digest(&path)?))).collect()
}

struct Sidecars {
    rules: PathBuf,
    base_rules: PathBuf,
    project: PathBuf,
    base_project: PathBuf,
}

impl Sidecars {
    fn of(board: &Path, base: &Path) -> Sidecars {
        Sidecars { rules: board.with_extension("kicad_dru"), base_rules: base.with_extension("kicad_dru"), project: board.with_extension("kicad_pro"), base_project: base.with_extension("kicad_pro") }
    }
}

/// The drilled items of the source and the base, as far as they could be read.
struct Holes {
    base: Option<Vec<Value>>,
    preserved: bool,
    added_vias: Option<Vec<Value>>,
}

fn identity_sort(holes: &[Value]) -> Vec<&Value> {
    let mut sorted: Vec<&Value> = holes.iter().collect();
    sorted.sort_by(|a, b| a.get("identity").and_then(Value::as_str).cmp(&b.get("identity").and_then(Value::as_str)));
    sorted
}

fn is_added_via(hole: &Value) -> bool {
    hole.get("kind").and_then(Value::as_str) == Some("via") && hole.get("supported").is_some_and(|value| value.as_bool() == Some(true))
}

/// A base that only adds supported through vias (job plane vias) keeps every source hole.
fn compare_holes(original: Vec<Value>, base: Vec<Value>) -> Holes {
    let preserved = identity_sort(&original) == identity_sort(&base);
    let text = |hole: &Value| dumps(hole, Separators::Spaced);
    let (source, kept): (BTreeSet<String>, BTreeSet<String>) = (original.iter().map(text).collect(), base.iter().map(text).collect());
    let added: Vec<Value> = base.iter().filter(|hole| !source.contains(&text(hole))).cloned().collect();
    let only_vias = !preserved && source.is_subset(&kept) && added.iter().all(is_added_via);
    Holes { base: Some(base), preserved, added_vias: only_vias.then_some(added) }
}

/// The state of one admission, as it grows.
struct Admission<'a> {
    request: &'a CheckRequest<'a>,
    native: &'a dyn Collaborators,
    dsn_text: String,
    inputs: Inputs,
    result: Coverage,
}

impl Admission<'_> {
    fn read_holes(&mut self) -> Holes {
        let read = || Ok::<_, String>((self.native.native_drilled_geometry(self.request.board)?, self.native.native_drilled_geometry(self.request.base)?));
        match read() {
            Ok((original, base)) => compare_holes(original, base),
            Err(error) => {
                self.result.native_drilled_geometry_unknown = Some(error);
                Holes { base: None, preserved: false, added_vias: None }
            }
        }
    }

    fn thermal_capability(&mut self) -> Option<Value> {
        let supplied = self.request.native_thermal_capability?;
        match self.validated_capability(supplied) {
            Ok(capability) => Some(capability),
            Err(error) => {
                self.result.requirements.push(Row::unsupported("native thermal capability", "native_thermal_evidence", error));
                None
            }
        }
    }

    fn validated_capability(&mut self, supplied: &Value) -> Result<Value, String> {
        let active = self.request.scope.sorted_active();
        let capability = self.native.validate_thermal_capability(supplied, self.request.board, self.request.base, &active)?;
        let inputs = capability.get("inputs").and_then(Value::as_object).ok_or("'inputs'")?;
        for (name, value) in inputs {
            if !is_digest(value) {
                return Err("native thermal evidence has an invalid input binding".to_string());
            }
            bind(&mut self.inputs, name, value, &format!("native thermal input changed during admission: {name}"))?;
        }
        Ok(capability)
    }

    /// The pure decision keeps its analytic subset; solver admission must also prove the backend's physical obstacle
    /// transform, even when the project has a smaller or zero hole minimum.
    fn reprove_holes(&mut self, holes: &Holes, model: &Result<Model, String>) {
        let mut rows = std::mem::take(&mut self.result.requirements);
        for row in rows.iter_mut().filter(|row| row.constraint == "hole_clearance" && row.disposition == Disposition::Covered) {
            row.analytical_hole_geometry = Some(row.hole_geometry.clone().unwrap_or(Value::Null));
            match self.drilled_proof(row, holes, model) {
                Ok(proof) => {
                    let covered = proof.get("status").and_then(Value::as_str) == Some("covered");
                    let reason = proof.get("cause").and_then(Value::as_str).unwrap_or("actual backend drilled containment proof").to_string();
                    row.hole_geometry = Some(proof);
                    row.settle(if covered { Disposition::Covered } else { Disposition::Unsupported }, reason);
                }
                Err(error) => row.settle(Disposition::Unsupported, error),
            }
        }
        self.result.requirements = rows;
    }

    fn drilled_proof(&self, row: &Row, holes: &Holes, model: &Result<Model, String>) -> Result<Value, String> {
        let drilled = holes.base.as_deref().filter(|_| holes.preserved).ok_or("custom hole clearance requires complete unchanged drilled geometry")?;
        let model = model.as_ref().map_err(Clone::clone)?;
        let scope = &self.request.scope;
        let mut floors = Vec::new();
        for net in scope.active_nets {
            for hole in drilled {
                floors.push(model.clearance_floor(net, hole.get("net").and_then(Value::as_str))?);
            }
        }
        let floor = first_minimum(&floors).unwrap_or(Decimal::ZERO).text();
        let active = scope.sorted_active();
        self.native.inspect_drilled(&DrilledRequest {
            dsn_text: &self.dsn_text,
            holes: drilled,
            active_nets: &active,
            layers: scope.layers,
            required_mm: row.required_mm.as_deref().ok_or("'required_mm'")?,
            clearance_floor_mm: &floor,
            applicability: "custom_pth_track",
            backend_command: self.request.backend_command,
            backend_policy: self.request.backend_policy,
        })
    }

    fn project_rows(&self, project: &Path, holes: &Holes, model: &Result<Model, String>, fixed_preserved: bool, thermal: &Value, capability: Option<&Value>) -> Vec<Row> {
        let evaluated = model.as_ref().map_err(Clone::clone).and_then(|model| {
            let text = if project.is_file() { Some(read_text(project)?) } else { None };
            self.native.evaluate_project(&ProjectRequest {
                text: text.as_deref(),
                source: project,
                model,
                dsn_text: &self.dsn_text,
                scope: self.request.scope,
                holes: holes.base.as_deref(),
                holes_preserved: holes.preserved,
                immutable_geometry_preserved: fixed_preserved,
                backend_command: self.request.backend_command,
                thermal,
                backend_policy: self.request.backend_policy,
                native_thermal_capability: capability,
                added_vias: holes.added_vias.as_deref(),
            })
        });
        evaluated.unwrap_or_else(|error| vec![Row::unsupported("native project", "project_model", error)])
    }

    /// Backend proofs name the files they read; those join the inputs.
    fn bind_proof_inputs(&mut self) -> Result<(), String> {
        let proofs: Vec<Value> = self.result.requirements.iter().flat_map(row_proofs).collect();
        for proof in &proofs {
            for (name, value) in proof.get("inputs").and_then(Value::as_object).into_iter().flatten() {
                if !is_digest(value) {
                    return Err("invalid backend proof input binding".to_string());
                }
                bind(&mut self.inputs, name, value, "backend proof input changed during admission")?;
            }
        }
        Ok(())
    }

    fn check_sources(&mut self, sidecars: &Sidecars) {
        let digest_of = |path: &Path| self.inputs.get(&path.display().to_string()).cloned().flatten();
        let (project, base_project) = (digest_of(&sidecars.project), digest_of(&sidecars.base_project));
        let (rules, base_rules) = (digest_of(&sidecars.rules), digest_of(&sidecars.base_rules));
        if project.is_none() || project != base_project {
            let mut row = Row::unsupported("native project", "project_source", "actual base project is absent or differs from the original authored project");
            row.source = Some(json!({"path": sidecars.project.display().to_string()}));
            row.extra.insert("base_project".to_string(), sidecars.base_project.display().to_string().into());
            self.result.requirements.push(row);
        }
        if rules != base_rules {
            let mut row = Row::unsupported("native custom rules", "rule_source", "actual base custom-rule presence/bytes differ from the original authored rules");
            row.source = Some(json!({"path": sidecars.rules.display().to_string()}));
            row.extra.insert("base_rules".to_string(), sidecars.base_rules.display().to_string().into());
            self.result.requirements.push(row);
        }
    }

    fn check_command(&mut self) {
        let Some(command) = self.request.backend_command else { return };
        let checked = validate_backend_command(command, self.request.dsn).and_then(|()| {
            if Path::new(&command[0]).is_file() { Ok(()) } else { Err("planned backend executable is not an attributable file".to_string()) }
        });
        if let Err(error) = checked {
            self.result.requirements.push(Row::unsupported("native project", "backend_command", error));
        }
    }

    /// The final status over every row, and the obligations left for the native gates.
    fn conclude(&mut self, capability: Option<Value>) -> (Vec<Value>, &'static str) {
        let rows = &self.result.requirements;
        let obligations: Vec<Value> = rows.iter().filter(|row| row.disposition == Disposition::NativePostcondition).filter_map(|row| row.native_obligation.clone()).collect();
        let blockers: Vec<String> = rows.iter().filter(|row| row.disposition.blocks()).map(|row| format!("{}: {} {}: {}", row.rule, row.constraint, row.disposition.name(), row.reason.as_deref().unwrap_or(""))).collect();
        let pending = !obligations.is_empty();
        let (status, model_status) = match (blockers.is_empty(), pending) {
            (false, _) => (Status::Blocked, "blocked"),
            (true, true) => (Status::PendingNative, "partial"),
            (true, false) => (Status::Passed, "complete"),
        };
        self.result.status = status;
        self.result.solver_launch_allowed = blockers.is_empty();
        self.result.cause = match (blockers.is_empty(), pending) {
            (false, _) => blockers.join("; "),
            (true, true) => "model admission complete except explicit pending native/configured-gate postconditions".to_string(),
            (true, false) => "applicable native custom/project requirements covered by final DSN and exact backend controls".to_string(),
        };
        if capability.is_some() || pending {
            self.result.native_postconditions = Some(obligations.clone());
        }
        self.result.native_thermal_capability = capability;
        (obligations, model_status)
    }
}

fn row_proofs(row: &Row) -> Vec<Value> {
    match &row.hole_geometry {
        Some(Value::Array(items)) => items.iter().map(|item| item.get("proof").cloned().unwrap_or_else(|| json!({}))).collect(),
        Some(proof) => vec![proof.clone()],
        None => Vec::new(),
    }
}

fn require_stitching(gate: Option<&Path>) -> Result<bool, String> {
    let bad = || "invalid configured board gate".to_string();
    let Some(gate) = gate else { return Ok(false) };
    let config: Value = serde_json::from_str(&read_text(gate)?).map_err(|error| error.to_string())?;
    let config = config.as_object().ok_or_else(bad)?;
    match config.get("checks") {
        None => Ok(false),
        Some(Value::Object(checks)) => Ok(checks.get("kicad_happy").is_some_and(|value| *value != Value::Bool(false))),
        Some(_) => Err(bad()),
    }
}

fn thermal_of(board_text: &str, base_text: &str, rules: &Path) -> Value {
    let read = || -> Result<Value, String> {
        let mut roots = rule_forms(board_text)?;
        roots.extend(rule_forms(base_text)?);
        let custom = if rules.is_file() { rule_forms(&read_text(rules)?)? } else { Vec::new() };
        Ok(thermal_scope(&roots, &custom))
    };
    read().unwrap_or_else(|reason| json!({"thermal_connections_possible": true, "reason": reason}))
}

fn scope_hash(value: &Value) -> String {
    sha256(dumps(value, Separators::Spaced).as_bytes())
}

fn footprint_scope(footprints: &BTreeMap<String, FootprintIdentity>) -> Result<String, String> {
    serde_json::to_value(footprints).map(|value| scope_hash(&value)).map_err(|error| error.to_string())
}

fn any_input_changed(inputs: &Inputs) -> Result<bool, String> {
    for (path, wanted) in inputs {
        if digest(Path::new(path))? != *wanted {
            return Ok(true);
        }
    }
    Ok(false)
}

/// The admission decision for one route stage. An error is an input that cannot be read or a footprint change, and the caller
/// records it as blocked; everything else blocks inside the record.
pub fn check_files(request: &CheckRequest, native: &dyn Collaborators) -> Result<Coverage, String> {
    let sidecars = Sidecars::of(request.board, request.base);
    let inputs = snapshot(request, &sidecars)?;
    let (board_text, base_text) = (read_text(request.board)?, read_text(request.base)?);
    let source_footprints = footprint_identity(&board_text)?;
    if source_footprints != footprint_identity(&base_text)? {
        return Err("footprint/pad definitions or poses changed before routing admission".to_string());
    }
    let fixed_preserved = fixed_geometry(&board_text)? == fixed_geometry(&base_text)?;
    let thermal = thermal_of(&board_text, &base_text, &sidecars.rules);
    let stitching = require_stitching(request.gate)?;
    let (pads, pad_error) = match native.native_pth_pads(request.base) {
        Ok(pads) => (Some(pads), None),
        Err(error) => (None, Some(error)),
    };
    let dru_text = if sidecars.rules.is_file() { read_text(&sidecars.rules)? } else { String::new() };
    let dsn_text = read_text(request.dsn)?;
    let mut result = inspect(&dru_text, &dsn_text, &request.scope, stitching, pads.as_deref(), native);
    result.native_pth_geometry_unknown = pad_error;
    result.scope = FILES_SCOPE.to_string();
    let mut admission = Admission { request, native, dsn_text, inputs, result };
    let holes = admission.read_holes();
    let capability = admission.thermal_capability();
    let model = Model::new(&admission.dsn_text, request.scope.layers);
    admission.reprove_holes(&holes, &model);
    let rows = admission.project_rows(&sidecars.project, &holes, &model, fixed_preserved, &thermal, capability.as_ref());
    admission.result.requirements.extend(rows);
    admission.bind_proof_inputs()?;
    admission.check_sources(&sidecars);
    admission.check_command();
    let (_, model_status) = admission.conclude(capability);
    let Admission { inputs, mut result, .. } = admission;
    let command = request.backend_command.map(<[String]>::to_vec);
    let command_hash = command.as_ref().map(|argv| sha256(dumps(&json!(argv), Separators::Compact).as_bytes()));
    let obstacles = serde_json::to_value(request.scope.obstacles).map_err(|error| error.to_string())?;
    let changed = any_input_changed(&inputs)?;
    result.files = Some(FileBinding {
        backend_command: command,
        backend_command_sha256: command_hash,
        backend_policy: request.backend_policy.filter(|policy| policy.is_object()).cloned(),
        drilled_geometry_preserved: holes.preserved,
        fixed_geometry_preserved: fixed_preserved,
        added_base_vias: holes.added_vias.as_ref().map_or(0, Vec::len),
        model_status: model_status.to_string(),
        dsn: DsnBinding { path: request.dsn.display().to_string(), sha256: inputs.get(&request.dsn.display().to_string()).cloned().flatten() },
        inputs,
        native_classes: request.scope.net_classes.clone(),
        footprint_scope_sha256: footprint_scope(&source_footprints)?,
        obstacle_scope_sha256: scope_hash(&obstacles),
    });
    if changed {
        result.status = Status::Blocked;
        result.solver_launch_allowed = false;
        result.cause = "coverage input changed during admission".to_string();
    }
    Ok(result)
}
