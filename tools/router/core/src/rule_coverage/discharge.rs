//! Discharging the pending native-DRC obligations from the final native DRC report. No native tool runs here.
use super::inspect::drc_types;
use crate::pytext::{Separators, dumps};
use serde::Serialize;
use serde_json::{Value, json};
use std::collections::{BTreeMap, BTreeSet};

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Discharge {
    pub status: String,
    pub native_drc: Vec<Value>,
    pub configured_gate: Vec<Value>,
    pub native_checkback: Vec<Value>,
    pub qualified: bool,
    pub configured_gate_required: bool,
    pub cause: String,
}

fn complete_report(report: &Value, label: &str) -> Result<(), String> {
    let list = |name: &str| report.get(name).and_then(Value::as_array);
    let severities = list("included_severities").map(|items| {
        let mut names: Vec<&str> = items.iter().filter_map(Value::as_str).collect();
        names.sort();
        names
    });
    let complete = list("violations").is_some() && list("ignored_checks").is_some() && severities.as_deref() == Some(&["error", "exclusion", "warning"]);
    if !complete {
        return Err(format!("{label} native DRC report is incomplete: all severities, findings and ignored checks are required"));
    }
    if list("ignored_checks").into_iter().flatten().any(|item| item.get("key").and_then(Value::as_str).is_none()) {
        return Err("malformed ignored native DRC check".to_string());
    }
    if list("violations").into_iter().flatten().any(|item| item.get("type").and_then(Value::as_str).is_none()) {
        return Err("malformed native DRC finding".to_string());
    }
    Ok(())
}

fn violations(report: &Value) -> &[Value] {
    report.get("violations").and_then(Value::as_array).map_or(&[], Vec::as_slice)
}

fn kind(finding: &Value) -> &str {
    finding.get("type").and_then(Value::as_str).unwrap_or("")
}

type FindingId = (String, Vec<String>);

/// Type plus the UUIDs of its items; None when an item has no UUID.
fn finding_id(finding: &Value) -> Option<FindingId> {
    let items = finding.get("items")?.as_array().filter(|items| !items.is_empty())?;
    let mut uuids: Vec<String> = items.iter().map(|item| item.get("uuid")?.as_str().map(str::to_string)).collect::<Option<_>>()?;
    uuids.sort();
    Some((kind(finding).to_string(), uuids))
}

fn string_list(value: Option<&Value>) -> Vec<&str> {
    value.and_then(Value::as_array).map_or(Vec::new(), |items| items.iter().filter_map(Value::as_str).collect())
}

/// The findings of the obligation types on the input board, counted.
fn baseline_findings(baseline: Option<&Value>, types: &BTreeSet<&str>) -> Result<BTreeMap<FindingId, usize>, String> {
    let mut counts = BTreeMap::new();
    let Some(baseline) = baseline else { return Ok(counts) };
    complete_report(baseline, "input")?;
    for finding in violations(baseline).iter().filter(|finding| types.contains(kind(finding))) {
        let id = finding_id(finding).ok_or_else(|| format!("input native DRC finding without item UUIDs: {}", kind(finding)))?;
        *counts.entry(id).or_insert(0) += 1;
    }
    Ok(counts)
}

/// New and already-present findings of the types. Each input finding excuses one final finding only.
fn count_findings(report: &Value, types: &[&str], before: &BTreeMap<FindingId, usize>) -> (usize, usize) {
    let (mut left, mut new, mut old) = (before.clone(), 0, 0);
    for finding in violations(report).iter().filter(|finding| types.contains(&kind(finding))) {
        match finding_id(finding).and_then(|id| left.get_mut(&id).filter(|count| **count > 0).map(|count| *count -= 1)) {
            Some(()) => old += 1,
            None => new += 1,
        }
    }
    (new, old)
}

fn is_native_drc(item: &Value) -> bool {
    let wanted = item.get("constraint").and_then(Value::as_str).and_then(drc_types);
    item.get("enforcement").and_then(Value::as_str) == Some("native-drc") && wanted.is_some_and(|types| string_list(item.get("drc_types")) == types && item["drc_types"].as_array().is_some_and(|all| all.len() == types.len()))
}

fn is_gate(item: &Value) -> bool {
    item.get("enforcement").and_then(Value::as_str) == Some("configured-gate") && item.get("constraint").and_then(Value::as_str) == Some("reference_stitching")
}

fn is_checkback(item: &Value) -> bool {
    let sha = item.get("capability_sha256").is_some_and(|value| value.as_str().is_some_and(|text| !text.is_empty()));
    item.get("enforcement").is_none() && item.get("constraint").and_then(Value::as_str) == Some("min_resolved_spokes") && sha
}

fn native_row(item: &Value, report: &Value, ignored: &BTreeSet<&str>, before: &BTreeMap<FindingId, usize>, has_baseline: bool) -> (Value, Option<String>) {
    let types = string_list(item.get("drc_types"));
    let (new, old) = count_findings(report, &types, before);
    let mut row = item.clone();
    row["violations"] = json!(new);
    if has_baseline {
        row["preexisting"] = json!(old);
    }
    let skipped: BTreeSet<&str> = types.iter().copied().filter(|name| ignored.contains(name)).collect();
    if !skipped.is_empty() {
        row["ignored"] = json!(skipped);
    }
    let failure = (new > 0 || !skipped.is_empty()).then(|| {
        let rule = item.get("rule").and_then(Value::as_str).unwrap_or("native project");
        let constraint = item["constraint"].as_str().unwrap_or("");
        let note = if skipped.is_empty() { String::new() } else { format!(", ignored check {}", skipped.into_iter().collect::<Vec<_>>().join(",")) };
        format!("{rule}: {constraint} has {new} native findings{note}")
    });
    (row, failure)
}

fn sort_obligations(result: &mut Discharge, obligations: &[Value], report: &Value, baseline: Option<&Value>) -> Result<Vec<String>, String> {
    complete_report(report, "final")?;
    let types: BTreeSet<&str> = obligations.iter().flat_map(|item| string_list(item.get("drc_types"))).collect();
    let before = baseline_findings(baseline, &types)?;
    let ignored: BTreeSet<&str> = report["ignored_checks"].as_array().into_iter().flatten().filter_map(|item| item.get("key")?.as_str()).collect();
    let mut failures = Vec::new();
    for item in obligations {
        if !item.is_object() {
            return Err("malformed native obligation".to_string());
        }
        if is_native_drc(item) {
            let (row, failure) = native_row(item, report, &ignored, &before, baseline.is_some());
            failures.extend(failure);
            result.native_drc.push(row);
        } else if is_gate(item) {
            result.configured_gate.push(item.clone());
        } else if is_checkback(item) {
            result.native_checkback.push(item.clone());
        } else {
            return Err(format!("unknown native obligation: {}", dumps(item, Separators::Spaced)));
        }
    }
    Ok(failures)
}

/// One finding of an obligation type (any severity, also an exclusion) or an ignored check of that type fails it. With
/// `baseline`, the native DRC of the input board with the same flags, a finding with the same type and item UUIDs was not made
/// by the route; items of new copper have new UUIDs. The thermal obligation has its own native-checkback discharge, and
/// configured-gate obligations stay typed for the configured board gate.
pub fn discharge_native(obligations: &[Value], report: &Value, baseline: Option<&Value>) -> Discharge {
    let mut result = Discharge { status: "failed".to_string(), native_drc: Vec::new(), configured_gate: Vec::new(), native_checkback: Vec::new(), qualified: false, configured_gate_required: true, cause: String::new() };
    match sort_obligations(&mut result, obligations, report, baseline) {
        Ok(failures) if failures.is_empty() => {
            result.status = "passed".to_string();
            result.cause = "final native DRC has zero findings of every pending type; configured gate still required".to_string();
        }
        Ok(failures) => result.cause = failures.join("; "),
        Err(error) => result.cause = error,
    }
    result
}
