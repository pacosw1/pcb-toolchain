//! Run the pinned tscircuit capacity solver on SRJ. This is a backend boundary, not an acceptance certificate: callers
//! supply a faithful model and validate the output natively.

use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::Instant;

use serde_json::{Map, Value, json};

use super::check::{check_input, terminal_conflicts};
use super::vias::resolve_existing_vias;
use super::{retains_fields, traces};
use crate::error::{Result, invalid};
use crate::native::digest::file_sha256;
use crate::process::{Finished, run_bounded};
use crate::pyjson::inline;

const PROGRESS_PREFIX: &str = "IOT_CAPACITY_PROGRESS ";
const PROGRESS_SCHEMA: &str = "iot-lab.capacity-progress.v1";
const PROGRESS_KEPT: usize = 32;
const STDERR_KEPT: usize = 2000;
const ADAPTER_FILES: [&str; 5] = ["run.mjs", "planning.mjs", "reuse.mjs", "package.json", "package-lock.json"];

pub struct Backend {
    /// The folder with run.mjs and its pinned packages.
    pub adapter: PathBuf,
    pub node: String,
    pub pipeline: String,
    pub capture_stages: bool,
    pub budget_s: f64,
}

pub fn run(srj: &Value, backend: &Backend) -> Result<Value> {
    if !matches!(backend.pipeline.as_str(), "topology" | "fanout" | "reuse") {
        return invalid("unknown capacity pipeline");
    }
    let source_sha = check_input(srj)?;
    let conflicts = terminal_conflicts(srj)?;
    if !conflicts.is_empty() {
        return Ok(json!({"status": "model_conflict", "qualified": false, "input_sha256": source_sha,
                         "reason": "terminal blocked in supplied obstacle model; reconcile native geometry",
                         "conflicts": conflicts, "native_validation_required": true}));
    }
    let adapter_files = adapter_files(&backend.adapter)?;
    let started = Instant::now();
    let finished = run_process(srj, &source_sha, backend)?;
    let elapsed = || started.elapsed().as_secs_f64();
    let progress = progress_records(&finished.stderr);
    let failure = |status: &str, reason: String| json!({
        "status": status, "qualified": false, "input_sha256": source_sha, "reason": reason, "elapsed_s": elapsed(),
        "progress": progress, "adapter_files": adapter_files,
    });
    match finished.code {
        None => return Ok(failure("timeout", "capacity process deadline".into())),
        Some(0) => {}
        Some(_) => return Ok(failure("backend_error", tail(&finished.stderr))),
    }
    let mut result: Value = serde_json::from_str(&finished.stdout)?;
    check_response(&result, &source_sha)?;
    fill_reason(&mut result);
    if result["status"] == "candidate" && !admit_candidate(srj, &mut result)? {
        result["elapsed_s"] = json!(elapsed());
        result["adapter_files"] = adapter_files;
        result["progress"] = progress.into();
        return Ok(result);
    }
    result["elapsed_s"] = json!(elapsed());
    result["rule_coverage"] = json!("caller model; native checks required");
    result["adapter_files"] = adapter_files;
    result["progress"] = progress.into();
    if elapsed() >= backend.budget_s {
        result["status"] = json!("timeout");
        result["reason"] = json!("capacity response validation exceeded deadline");
    }
    Ok(result)
}

fn adapter_files(adapter: &Path) -> Result<Value> {
    let mut files = Map::new();
    for name in ADAPTER_FILES {
        files.insert(name.to_string(), file_sha256(&adapter.join(name))?.into());
    }
    Ok(Value::Object(files))
}

/// Node's permission mode denies network, subprocesses and writes. An older runtime fails on the option; it never falls back.
fn run_process(srj: &Value, source_sha: &str, backend: &Backend) -> Result<Finished> {
    let request = json!({"input": srj, "input_sha256": source_sha, "budget_ms": backend.budget_s * 1000.0,
                         "pipeline": backend.pipeline, "capture_stages": backend.capture_stages});
    let mut command = Command::new(&backend.node);
    command.arg("--permission").arg(format!("--allow-fs-read={}", backend.adapter.display())).arg(backend.adapter.join("run.mjs"));
    run_bounded(&mut command, inline(&request)?, backend.budget_s)
}

fn tail(text: &str) -> String {
    let skip = text.chars().count().saturating_sub(STDERR_KEPT);
    text.chars().skip(skip).collect()
}

/// Last observed work only; never evidence that a timed-out route completed.
fn progress_records(stderr: &str) -> Vec<Value> {
    let rows: Vec<Value> = stderr.lines()
        .filter_map(|line| line.strip_prefix(PROGRESS_PREFIX))
        .filter_map(|text| serde_json::from_str::<Value>(text).ok())
        .filter(|row| row["schema"] == PROGRESS_SCHEMA)
        .collect();
    rows[rows.len().saturating_sub(PROGRESS_KEPT)..].to_vec()
}

fn check_response(result: &Value, source_sha: &str) -> Result<()> {
    let valid = result["schema"] == "iot-lab.capacity-route.v1" && result["input_sha256"].as_str() == Some(source_sha)
        && result["qualified"] == false && result["native_validation_required"] == true;
    if valid { Ok(()) } else { invalid("invalid capacity response contract") }
}

fn truthy(value: &Value) -> bool {
    !matches!(value, Value::Null | Value::Bool(false)) && value.as_str() != Some("")
}

fn fill_reason(result: &mut Value) {
    if truthy(&result["error"]) && !truthy(&result["reason"]) {
        result["reason"] = result["error"].clone();
    }
}

/// Keep only traces from a completed response, on our exact original model. False when a transition cannot be resolved:
/// the costly solver output stays for diagnosis, without the admissible field or the candidate status.
fn admit_candidate(srj: &Value, result: &mut Value) -> Result<bool> {
    let output = result["output"].clone();
    if !output.is_object() || !output["traces"].is_array() {
        return invalid("completed capacity result lacks traces");
    }
    let mut changed = changed_fields(srj, &output);
    let resolved = match resolve_existing_vias(srj, traces(&output)) {
        Ok(resolved) => resolved,
        Err(error) => {
            result["status"] = json!("unsupported");
            result["reason"] = json!(error.0);
            if let Some(row) = result.as_object_mut() {
                row.shift_remove("output");
                row.insert("backend_output".into(), output);
            }
            return Ok(false);
        }
    };
    changed.extend(changed_traces(srj, &resolved));
    if !changed.is_empty() {
        result["status"] = json!("model_mismatch");
        result["reason"] = json!("capacity output changed supplied fields");
        result["changed_fields"] = json!(changed);
    }
    let mut kept = srj.clone();
    kept["traces"] = Value::Array(resolved);
    result["output"] = kept;
    Ok(true)
}

/// Geometry comes from traces alone. The backend may not alter endpoints, layers, obstacles or rule declarations.
fn changed_fields(srj: &Value, output: &Value) -> Vec<String> {
    let fields = srj.as_object().into_iter().flatten().filter(|(key, _)| key.as_str() != "traces");
    fields.filter(|(key, value)| !retains_fields(output.get(key.as_str()).unwrap_or(&Value::Null), value))
        .map(|(key, _)| key.clone()).collect()
}

fn changed_traces(srj: &Value, resolved: &[Value]) -> Vec<String> {
    let mut changed = Vec::new();
    for old in traces(srj) {
        let matches: Vec<&Value> = resolved.iter().filter(|trace| trace["pcb_trace_id"] == old["pcb_trace_id"]).collect();
        if !matches!(matches.as_slice(), [one] if retains_fields(one, old)) {
            changed.push(format!("preserved trace:{}", old["pcb_trace_id"].as_str().unwrap_or("None")));
        }
    }
    changed
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_incomplete_line_does_not_hide_the_last_complete_phase() {
        let phase = json!({"schema": PROGRESS_SCHEMA, "phase": "highDensityRouteSolver", "iterations": 42});
        let stderr = format!("unrelated log\n{PROGRESS_PREFIX}{phase}\n{PROGRESS_PREFIX}{{\"schema\":\"iot");
        assert_eq!(progress_records(&stderr), vec![phase]);
    }

    #[test]
    fn only_the_last_records_are_kept() {
        let lines: Vec<String> = (0..40).map(|n| format!("{PROGRESS_PREFIX}{}", json!({"schema": PROGRESS_SCHEMA, "n": n}))).collect();
        let kept = progress_records(&lines.join("\n"));
        assert_eq!((kept.len(), kept[0]["n"].as_u64()), (PROGRESS_KEPT, Some(8)));
    }

    #[test]
    fn the_stderr_tail_counts_characters() {
        assert_eq!(tail(&"é".repeat(STDERR_KEPT + 5)).chars().count(), STDERR_KEPT);
    }
}
