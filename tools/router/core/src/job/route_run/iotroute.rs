//! The in-house backend of a route plan: one stage on the engine of `iotroute run` (model, core, write), which is reused, not forked.
//!
//! What a stage says becomes model data before the core reads it: `only_nets` / `skip_nets` and the plane nets are `route_nets`, the
//! only nets the core routes; `layers` narrows each of them; `plane_nets` (without `route_planes`) get pad vias into their pour;
//! `neck_um` is the narrowest a wider net may neck; `passes` and `time_s` are --iters and --max-time. The router sees the board pours
//! of the plan during the stage (`pour_view`): pad vias and return vias must land in them. They leave the board again after the
//! route, and `finish` pours them on the final copper for either backend. Nets the gate exempts from RP-001 get no return vias.
//!
//! Features. These three are what the engine does anyway, so `true` asks for nothing more and `false` cannot be honoured:
//!  - rule_compiler: the model reads the .kicad_dru and the gate's deny_layers itself, and stops at a rule it does not know.
//!  - via_off_small_pads: the core puts a via in a pad only when the gate's viapads list allows it, which is stricter.
//!  - via_halo: the core reserves each signal via's ground return as it routes, so it needs the model's return net.
//!
//! Every other feature, `threads`, `unlock_nets` and `via_skip` have no meaning here and are refused by name.
use super::board_edit::{pour_area, pour_zone};
use crate::kicad::board::Board;
use crate::plan::{Plan, Pour, PourShape, Stage};
use crate::route_features::root;
use crate::run::parse_args;
use crate::run::steps::{Steps, last_line};
use serde_json::{Value, json};
use std::collections::BTreeSet;
use std::fs;
use std::path::{Path, PathBuf};

const NATIVE_FEATURES: [&str; 3] = ["rule_compiler", "via_off_small_pads", "via_halo"];
const VIA_HALO: &str = "via_halo";

/// Each thing in the plan the engine cannot honour, named in one error.
pub fn check_plan(plan: &Plan) -> Result<(), String> {
    let mut refused = Vec::new();
    for (name, on) in &plan.features {
        if !NATIVE_FEATURES.contains(&name.as_str()) {
            refused.push(format!("feature {name} has no iotroute meaning"));
        } else if !on {
            refused.push(format!("feature {name} cannot be off: iotroute always does this"));
        }
    }
    for stage in &plan.stages {
        for (set, option) in [(stage.budget.threads != 0, "threads"), (!stage.unlock_nets.is_empty(), "unlock_nets"), (!stage.via_skip.is_empty(), "via_skip")] {
            if set {
                refused.push(format!("stage {}: {option} has no iotroute meaning", stage.name));
            }
        }
    }
    if refused.is_empty() { Ok(()) } else { Err(format!("route: the iotroute backend refuses: {}", refused.join("; "))) }
}

pub fn wants_halo(plan: &Plan) -> bool {
    plan.features.contains_key(VIA_HALO)
}

/// The zones of the plan's board pours, for the router's copy of a stage board, and their names. An "around" pour follows copper
/// that is not routed yet, so it comes only in `finish`.
pub fn pour_view(board: &Board, pours: &[Pour], seed: &str) -> Result<(Vec<String>, Vec<String>), String> {
    let (mut names, mut zones) = (Vec::new(), Vec::new());
    for (index, pour) in pours.iter().enumerate().filter(|(_, pour)| pour.shape == PourShape::Board) {
        if let Some(area) = pour_area(board, pour)? {
            names.push(pour.name.clone());
            zones.push(pour_zone(pour, &area, &format!("{seed}-view"), index));
        }
    }
    Ok((names, zones))
}

/// A net wider than the neck may not go below it. A narrower net has nothing to neck, and a current floor above it stays.
fn neck_floor(net: &mut Value, neck_mm: f64) {
    if neck_mm <= 0.0 || net["width"].as_f64().is_none_or(|width| width <= neck_mm) {
        return;
    }
    net["min_width"] = net["min_width"].as_f64().map_or(neck_mm, |floor| floor.max(neck_mm)).into();
    for floor in net["min_width_layers"].as_object_mut().into_iter().flat_map(|layers| layers.values_mut()) {
        *floor = floor.as_f64().map_or(neck_mm, |width| width.max(neck_mm)).into();
    }
}

/// The stage on the model. `halo`: the plan asks for via_halo.
fn stage_model(model: &mut Value, stage: &Stage, halo: bool) -> Result<(), String> {
    if halo && model["return_net"].is_null() {
        return Err(format!("route: stage {}: feature {VIA_HALO} needs a return net, and the board's model has none", stage.name));
    }
    let nets = model["nets"].as_object_mut().ok_or("route: the model has no nets")?;
    let names: Vec<String> = nets.keys().cloned().collect();
    if let Some(net) = stage.plane_nets.iter().find(|net| !nets.contains_key(*net)) {
        return Err(format!("route: stage {}: plane net {net} is not on the board", stage.name));
    }
    let routed: BTreeSet<&str> = stage.kept_nets(&names).into_iter().chain(stage.plane_nets.iter().map(String::as_str)).collect();
    for name in &routed {
        let net = &mut nets[*name];
        let plane = !stage.route_planes && stage.plane_nets.iter().any(|p| p == name);
        if plane && net["plane_polys"].is_null() {
            return Err(format!("route: stage {}: plane net {name} has no pour to reach", stage.name));
        }
        net["plane"] = plane.into();
        let layers: Vec<Value> = net["layers"].as_array().map_or(Vec::new(), |list| list.iter().filter(|l| stage.layers.iter().any(|s| l.as_str() == Some(s))).cloned().collect());
        if layers.is_empty() {
            return Err(format!("route: stage {}: net {name} may use none of the stage layers", stage.name));
        }
        net["layers"] = layers.into();
        neck_floor(net, stage.neck_um as f64 / 1000.0);
    }
    let routed = json!(routed);
    model["route_nets"] = routed;
    Ok(())
}

/// Routes `src`; the board goes to `work`/routed.kicad_pcb. An open net is no failure here: the stage check decides.
pub fn route(stage: &Stage, folder: &Path, src: &Path, work: &Path, halo: bool) -> Result<PathBuf, String> {
    fs::create_dir_all(work).map_err(|e| format!("{}: {e}", work.display()))?;
    let steps = Steps::new(&root().join("tools"))?;
    let model = work.join("model.json");
    let (code, text) = steps.model(folder, src, &model, &work.join("model.log"), true)?;
    if code != 0 {
        return Err(format!("route: stage {}: iotroute model failed: {}", stage.name, last_line(&text)));
    }
    let read = fs::read_to_string(&model).map_err(|e| format!("{}: {e}", model.display()))?;
    let mut data: Value = serde_json::from_str(&read).map_err(|e| format!("{}: {e}", model.display()))?;
    stage_model(&mut data, stage, halo)?;
    fs::write(&model, data.to_string()).map_err(|e| format!("{}: {e}", model.display()))?;
    let routed = work.join("routed.kicad_pcb");
    let mut argv = vec![folder.display().to_string(), routed.display().to_string(), "--iters".to_string(), stage.budget.passes.to_string()];
    if stage.budget.time_s != 0 {
        argv.extend(["--max-time".to_string(), stage.budget.time_s.to_string()]);
    }
    steps.route_and_write(&parse_args(&argv)?, &model, src, &routed, work, &[], &[])?;
    Ok(routed)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::plan::load;

    fn plan(extra: Value) -> Plan {
        let mut cfg = json!({"schema": crate::plan::SCHEMA, "backend": "iotroute", "layers": ["F.Cu"], "stages": [{"name": "s", "only_nets": ["A"], "plane_nets": ["G"], "neck_um": 1000}]});
        cfg.as_object_mut().unwrap().extend(extra.as_object().unwrap().clone());
        load(&cfg, &["F.Cu".to_string(), "B.Cu".to_string()], None).unwrap()
    }

    #[test]
    fn a_stage_becomes_model_data_and_other_nets_stay_out() {
        let mut model = json!({"nets": {
            "A": {"layers": ["F.Cu", "B.Cu"], "width": 2.0, "min_width": 0.5, "plane": false},
            "G": {"layers": ["F.Cu", "B.Cu"], "plane": false, "plane_polys": [[[0, 0], [1, 0], [1, 1]]]},
            "OTHER": {"layers": ["F.Cu", "B.Cu"], "plane": true}}});
        stage_model(&mut model, &plan(json!({})).stages[0], false).unwrap();
        assert_eq!(model["route_nets"], json!(["A", "G"]));
        assert_eq!((&model["nets"]["A"]["layers"], &model["nets"]["A"]["min_width"]), (&json!(["F.Cu"]), &json!(1.0)));
        assert_eq!((&model["nets"]["G"]["plane"], &model["nets"]["OTHER"]["plane"]), (&json!(true), &json!(true)));
        model["nets"]["G"]["plane_polys"] = Value::Null;
        assert!(stage_model(&mut model, &plan(json!({})).stages[0], false).unwrap_err().contains("plane net G has no pour"));
    }

    #[test]
    fn what_the_engine_cannot_honour_is_refused_by_name() {
        assert!(check_plan(&plan(json!({"features": {"via_halo": true, "rule_compiler": true, "via_off_small_pads": true}}))).is_ok());
        let error = check_plan(&plan(json!({"features": {"routing_rules": true, "via_halo": false}, "budget": {"threads": 4}}))).unwrap_err();
        for name in ["feature routing_rules", "feature via_halo", "stage s: threads"] {
            assert!(error.contains(name), "{error}");
        }
    }
}
