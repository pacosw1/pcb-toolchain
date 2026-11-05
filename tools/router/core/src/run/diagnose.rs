//! What a route with opens leaves for the compaction (`iotroute run --diagnose`): OUT.iotroute/open-triage.json says for each open
//! connection whether it is enclosed and by what, and pin-escape.json which pins of the step board cannot leave their part. Both only
//! describe: the DRC on OUT stays the verdict, and a diagnosis that fails is reported in the record, not a failed run. Plane nets are
//! left out, as they are of the route. The grids and limits are the features `triage_opens` and `pin_escape_check`.
use crate::grid::escape::{self, EscapeConfig, EscapeScope, Runtime};
use crate::grid::triage::{TriageConfig, TriageScope, triage};
use crate::kicad::api::{PINNED_COMMIT, Server, read_board, read_rules};
use crate::kicad::board::Board;
use crate::kicad::rules::DesignRules;
use crate::route_features::defaults_path;
use crate::sha256::sha256;
use serde::Serialize;
use serde_json::Value;
use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::path::Path;

fn read(path: &Path) -> Result<(Board, DesignRules), String> {
    let read = {
        let (_server, mut client) = Server::start(path)?;
        let board = read_board(&mut client, path).map_err(|e| e.to_string())?;
        let rules = read_rules(&mut client, path).map_err(|e| e.to_string())?;
        (board, rules)
    };
    // The server is gone and leaves its project lock behind: no file of the run.
    if let Some(stem) = path.file_stem().and_then(|stem| stem.to_str()) {
        let _ = fs::remove_file(path.with_file_name(format!("~{stem}.kicad_pro.lck")));
    }
    Ok(read)
}

fn write_json(path: &Path, value: &impl Serialize) -> Result<(), String> {
    fs::write(path, serde_json::to_string_pretty(value).map_err(|e| e.to_string())?).map_err(|e| format!("{}: {e}", path.display()))
}

fn read_json(path: &Path) -> Result<Value, String> {
    serde_json::from_str(&fs::read_to_string(path).map_err(|e| format!("{}: {e}", path.display()))?).map_err(|e| format!("{}: {e}", path.display()))
}

/// The routing layers and the plane nets of a model.
fn route_scope(model: &Value) -> (Vec<String>, Vec<String>) {
    let names = |key: &str| model[key].as_array().map_or(Vec::new(), |list| list.iter().filter_map(|name| name.as_str().map(str::to_string)).collect::<Vec<_>>());
    let planes = names("plane_layers");
    let layers = names("copper_layers").into_iter().filter(|layer| !planes.contains(layer)).collect();
    let nets = model["nets"].as_object().map_or(Vec::new(), |nets| nets.iter().filter(|(_, net)| net["plane"] == true).map(|(name, _)| name.clone()).collect());
    (layers, nets)
}

/// The nets a narrowed route was given: the only ones it can have left stuck. None when it had them all.
fn routed_nets(model: &Value) -> Option<BTreeSet<String>> {
    model["route_nets"].as_array().map(|nets| nets.iter().filter_map(|net| net.as_str().map(str::to_string)).collect())
}

fn number(features: &Value, feature: &str, key: &str) -> Result<f64, String> {
    features["features"][feature][key].as_f64().ok_or_else(|| format!("route features: {feature}.{key} is not a number"))
}

fn open_triage(out: &Path, work: &Path, features: &Value, layers: &[String], skip: &[String], nets: Option<BTreeSet<String>>) -> Result<String, String> {
    let config = TriageConfig { grid_mm: number(features, "triage_opens", "grid_mm")?, max_opens: number(features, "triage_opens", "max_opens")? as usize };
    let scope = TriageScope { layers: layers.to_vec(), skip: skip.to_vec(), nets };
    let (board, rules) = read(out)?;
    let report = triage(&board, &rules, out, &read_json(&work.join("drc.json"))?, &config, &scope)?;
    write_json(&work.join("open-triage.json"), &report)?;
    Ok(report.line())
}

fn pin_escape(route_in: &Path, work: &Path, features: &Value, layers: &[String], skip: &[String], nets: Option<BTreeSet<String>>) -> Result<String, String> {
    let raw = features["features"]["pin_escape_check"].clone();
    let config = EscapeConfig { grid_mm: number(features, "pin_escape_check", "grid_mm")?, reach_mm: number(features, "pin_escape_check", "reach_mm")?, halo_hint_mm: number(features, "pin_escape_check", "halo_hint_mm")?, raw };
    let scope = EscapeScope { layers: layers.to_vec(), skip: skip.to_vec(), nets };
    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    let digest = sha256(&fs::read(&exe).map_err(|e| format!("{}: {e}", exe.display()))?);
    let runtime = Runtime { kicad_version: PINNED_COMMIT.to_string(), program: BTreeMap::from([(exe.display().to_string(), digest)]) };
    let (board, rules) = read(route_in)?;
    let report = escape::escape(&board, &rules, route_in, &config, &scope, escape::generator_inputs(&defaults_path())?, runtime)?;
    write_json(&work.join("pin-escape.json"), &report)?;
    Ok(report.line())
}

/// One line per diagnosis: what it found, or why it did not run.
pub fn diagnose(route_in: &Path, out: &Path, work: &Path, model: &Path) -> Vec<String> {
    let inputs = read_json(model).and_then(|model| Ok((read_json(&defaults_path())?, route_scope(&model), routed_nets(&model))));
    let (features, (layers, skip), nets) = match inputs {
        Ok(inputs) => inputs,
        Err(error) => return vec![format!("DIAGNOSE failed: {error}")],
    };
    let line = |name: &str, result: Result<String, String>| result.unwrap_or_else(|error| format!("{name} failed: {error}"));
    vec![line("TRIAGE", open_triage(out, work, &features, &layers, &skip, nets.clone())), line("ESCAPE", pin_escape(route_in, work, &features, &layers, &skip, nets))]
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn a_diagnosis_covers_the_routed_layers_and_leaves_the_plane_nets_out() {
        let model = json!({"copper_layers": ["F.Cu", "In1.Cu", "B.Cu"], "plane_layers": ["In1.Cu"], "nets": {"GND": {"plane": true}, "A": {"plane": false}}});
        assert_eq!(route_scope(&model), (vec!["F.Cu".to_string(), "B.Cu".to_string()], vec!["GND".to_string()]));
        assert_eq!(routed_nets(&model), None);
        assert_eq!(routed_nets(&json!({"route_nets": ["A"]})), Some(BTreeSet::from(["A".to_string()])));
    }
}
