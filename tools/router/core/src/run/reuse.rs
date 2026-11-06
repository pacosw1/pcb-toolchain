//! --reuse: the seed of a partial re-route from an earlier result, and the choice between attempts. The seed is the copper of that
//! route, the parts that moved since, and the nets it left open or in a DRC error (DESIGN.md 5c).
use super::measure::{drc_nets, read_report};
use super::project::sha_file;
use super::record::{AttemptStages, DrcCounts, RouteClaim};
use crate::kicad::api::{Server, read_board};
use crate::kicad::Board;
use serde::{Deserialize, Serialize};
use serde_json::value::RawValue;
use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::path::Path;

const SEED_SCHEMA: &str = "iot-lab.route-seed.v0";
/// Parts closer than this have not moved, in nm.
const MOVE_TOLERANCE: i64 = 100;

#[derive(Debug, Clone, Serialize)]
pub struct Attempt {
    pub stages: AttemptStages,
    pub claim: Option<super::record::RouteClaim>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub drc_errors: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub unconnected: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub parity: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub drc_by_type: Option<BTreeMap<String, usize>>,
}

impl Attempt {
    pub fn new(stages: AttemptStages) -> Attempt {
        let claim = stages.core.claim.clone();
        Attempt { stages, claim, drc_errors: None, unconnected: None, parity: None, drc_by_type: None }
    }

    pub fn set_drc(&mut self, drc: &DrcCounts) {
        (self.drc_errors, self.unconnected, self.parity, self.drc_by_type) = (Some(drc.errors), Some(drc.unconnected), Some(drc.parity), Some(drc.by_type.clone()));
    }

    fn key(&self) -> (usize, u64) {
        let problems = self.drc_errors.unwrap_or(0) + self.unconnected.unwrap_or(0) + self.parity.unwrap_or(0);
        (problems, self.claim.as_ref().map_or(1_000_000, |c| c.failed))
    }

    /// Fewer DRC errors, unconnected items and parity items, then fewer failed nets.
    pub fn better_than(&self, other: &Attempt) -> bool {
        self.key() < other.key()
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct ReuseRecord {
    pub source: String,
    pub source_sha256: String,
    pub moved_refs: Vec<String>,
    pub failed_nets: Vec<String>,
    pub passes: i64,
    pub tracks: usize,
    pub vias: usize,
    pub seed_sha256: String,
    pub fallback: String,
    pub attempts: BTreeMap<String, Attempt>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub chosen: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub incumbent_note: Option<String>,
}

/// An earlier route may compete as an incumbent only for the same admitted
/// problem. The input-copy filename is metadata; every geometry/rule/policy
/// value must match. Verify the earlier model against its own run receipt first.
pub fn incumbent_claim(previous: &Path, current_model: &Path, moved: &[String]) -> Result<RouteClaim, String> {
    if !moved.is_empty() { return Err("parts moved; previous route is not an unchanged-input incumbent".into()); }
    let work = std::path::PathBuf::from(format!("{}.iotroute", previous.display()));
    let model = work.join("model.json");
    let receipt: serde_json::Value = read_json(&work.join("result.json"))?;
    if receipt["stages"]["model"]["sha256"].as_str() != Some(sha_file(&model)?.as_str()) {
        return Err("previous model does not match its receipt".into());
    }
    let before: serde_json::Value = read_json(&model)?;
    let now: serde_json::Value = read_json(current_model)?;
    if !same_problem(before, now) { return Err("admitted model changed; previous copper must not be replayed".into()); }
    let route: serde_json::Value = read_json(&work.join("route.json"))?;
    if route["schema"].as_str() != Some("iot-lab.route-result.v0") { return Err("previous route schema is not supported".into()); }
    let tracks = route["tracks"].as_array().ok_or("previous route has no tracks")?.len() as u64;
    let vias = route["vias"].as_array().ok_or("previous route has no vias")?.len() as u64;
    let failed = route["failed"].as_array().ok_or("previous route has no failure ledger")?.len() as u64;
    Ok(RouteClaim { status: if failed == 0 { "PASS" } else { "FAIL" }.into(), converged: failed == 0,
        iters: route["passes"].as_u64().ok_or("previous route has no passes")?, tracks, vias, failed, stop: None })
}

fn same_problem(mut before: serde_json::Value, mut now: serde_json::Value) -> bool {
    let valid = |v: &serde_json::Value| v["schema"].as_str() == Some("iot-lab.route-model.v0") && v["pcb"].is_string();
    if !valid(&before) || !valid(&now) { return false; }
    before.as_object_mut().unwrap().remove("pcb");
    now.as_object_mut().unwrap().remove("pcb");
    before == now
}

#[derive(Deserialize)]
struct EarlierRecord {
    board_sha256: Option<String>,
    #[serde(default)]
    reuse: Option<EarlierReuse>,
}

#[derive(Deserialize)]
struct EarlierReuse {
    chosen: Option<String>,
    passes: Option<i64>,
}

#[derive(Deserialize)]
struct EarlierRoute {
    #[serde(default)]
    failed: Vec<FailedNet>,
    #[serde(default)]
    passes: i64,
    tracks: Vec<Box<RawValue>>,
    vias: Vec<Box<RawValue>>,
}

#[derive(Deserialize)]
struct FailedNet {
    net: String,
}

#[derive(Serialize)]
struct Seed<'a> {
    failed_nets: &'a [String],
    moved_refs: &'a [String],
    passes: i64,
    schema: &'static str,
    source: &'a str,
    source_sha256: &'a str,
    tracks: &'a [Box<RawValue>],
    vias: &'a [Box<RawValue>],
}

/// An internal feedback seed is bound to the exact input, route and model transition.
/// This is copper reuse, not permission to resume stale search/history state.
#[derive(Debug, Clone, Serialize)]
pub struct FeedbackBinding {
    pub input_sha256: String,
    pub source_route_sha256: String,
    pub source_model_sha256: String,
    pub model_sha256: String,
}

/// Only the existing reference-cost raise/hardening on the named signal nets may differ.
/// Every geometry, rule, width, layer and unrelated policy value must remain identical.
fn feedback_transition(before: &[u8], after: &[u8], changed: &[String]) -> Result<(), String> {
    type Object = BTreeMap<String, Box<RawValue>>;
    let mut expected: Object = serde_json::from_slice(before).map_err(|e| e.to_string())?;
    let mut current: Object = serde_json::from_slice(after).map_err(|e| e.to_string())?;
    let string = |key: &str| expected.get(key).and_then(|v| serde_json::from_str::<String>(v.get()).ok());
    if string("schema").as_deref() != Some("iot-lab.route-model.v0") || string("pcb").is_none() {
        return Err("feedback reuse requires an admitted native model".into());
    }
    if changed.is_empty() || changed.iter().collect::<BTreeSet<_>>().len() != changed.len() {
        return Err("feedback reuse requires distinct changed nets".into());
    }
    let before_nets = expected.remove("nets").ok_or("feedback model has no nets")?;
    let after_nets = current.remove("nets").ok_or("feedback model has no nets")?;
    let mut nets: BTreeMap<String, Object> = serde_json::from_str(before_nets.get()).map_err(|e| e.to_string())?;
    let now: BTreeMap<String, Object> = serde_json::from_str(after_nets.get()).map_err(|e| e.to_string())?;
    for name in changed {
        let net = nets.get_mut(name).ok_or_else(|| format!("feedback net {name} is absent"))?;
        if net.get("ref_soft").map(|v| v.get()) != Some("true") || net.get("plane").map(|v| v.get()) == Some("true") {
            return Err(format!("feedback net {name} is not a soft signal net"));
        }
        let cost = match net.get("ref_cost") {
            None => 3.0,
            Some(v) => v.get().parse::<f64>().ok().filter(|v| v.is_finite() && *v > 0.0).ok_or_else(|| format!("feedback net {name} has invalid reference cost"))?,
        };
        if cost < 300.0 {
            net.insert("ref_cost".into(), serde_json::value::to_raw_value(&(cost * 10.0)).map_err(|e| e.to_string())?);
        } else {
            net.insert("ref_soft".into(), serde_json::value::to_raw_value(&false).map_err(|e| e.to_string())?);
        }
    }
    // Compare untouched values as raw JSON: f64 round-tripping must not hide a
    // geometry/rule change or silently round a high-precision coordinate.
    let equal = |a: &Object, b: &Object| a.len() == b.len() && a.iter().all(|(k, v)| b.get(k).is_some_and(|w| v.get() == w.get()));
    if !equal(&expected, &current) || nets.len() != now.len() || !nets.iter().all(|(n, v)| now.get(n).is_some_and(|w| equal(v, w))) {
        return Err("feedback model changed beyond the named reference-cost transition".into());
    }
    Ok(())
}

/// Build the ordinary reuse seed from this run's current route, before its final
/// board receipt exists. A new core loads/rechecks copper under the updated model;
/// no cached maze state, history field or native acceptance is carried forward.
pub fn feedback_seed(before_model: &[u8], model: &Path, input: &Path, expected_input_sha: &str,
    previous: &Path, route: &Path, out_json: &Path, changed: &[String]) -> Result<(ReuseRecord, FeedbackBinding), String> {
    let input_sha = sha_file(input)?;
    if input_sha != expected_input_sha { return Err("feedback input changed during the run".into()); }
    let after_model = fs::read(model).map_err(|e| format!("{}: {e}", model.display()))?;
    feedback_transition(before_model, &after_model, changed)?;
    let route_bytes = fs::read(route).map_err(|e| format!("{}: {e}", route.display()))?;
    let raw: serde_json::Value = serde_json::from_slice(&route_bytes).map_err(|e| e.to_string())?;
    if raw["schema"] != "iot-lab.route-result.v0" || raw["failed"].as_array().is_none_or(|v| !v.is_empty()) {
        return Err("feedback reuse requires a finalized route without core failures".into());
    }
    let earlier: EarlierRoute = serde_json::from_slice(&route_bytes).map_err(|e| e.to_string())?;
    if earlier.passes < 1 { return Err("feedback route has no completed negotiation".into()); }
    let source = previous.display().to_string();
    let sha = sha_file(previous)?;
    let seed = Seed { failed_nets: changed, moved_refs: &[], passes: earlier.passes, schema: SEED_SCHEMA,
        source: &source, source_sha256: &sha, tracks: &earlier.tracks, vias: &earlier.vias };
    fs::write(out_json, serde_json::to_vec(&seed).map_err(|e| e.to_string())?).map_err(|e| format!("{}: {e}", out_json.display()))?;
    let binding = FeedbackBinding { input_sha256: input_sha,
        source_route_sha256: crate::sha256::sha256(&route_bytes), source_model_sha256: crate::sha256::sha256(before_model),
        model_sha256: crate::sha256::sha256(&after_model) };
    Ok((ReuseRecord { source, source_sha256: sha, moved_refs: Vec::new(), failed_nets: changed.to_vec(), passes: earlier.passes,
        tracks: earlier.tracks.len(), vias: earlier.vias.len(), seed_sha256: sha_file(out_json)?, fallback: "full".into(),
        attempts: BTreeMap::new(), chosen: None, incumbent_note: Some("feedback seed only; changed model forbids stale incumbent replay".into()) }, binding))
}

/// Position in nm, orientation in 0.1 degree, side.
type Pose = (i64, i64, i64, String);

fn poses(board: &Board) -> BTreeMap<String, Pose> {
    board.footprints.iter().map(|f| {
        let tenths = ((f.orientation * 10.0).round_ties_even() as i64).rem_euclid(3600);
        (f.reference.clone(), (f.position.x, f.position.y, tenths, f.layer.clone()))
    }).collect()
}

/// References whose position, orientation or side differ. A reference in only one board stops: not the same board.
fn moved_refs(earlier: &BTreeMap<String, Pose>, now: &BTreeMap<String, Pose>) -> Result<Vec<String>, String> {
    let (a, b): (BTreeSet<&String>, BTreeSet<&String>) = (earlier.keys().collect(), now.keys().collect());
    let other: Vec<&str> = a.symmetric_difference(&b).map(|s| s.as_str()).take(8).collect();
    if !other.is_empty() {
        return Err(format!("--reuse: the earlier board has other parts: {}", other.join(", ")));
    }
    let moved = |p: &Pose, q: &Pose| (p.0 - q.0).abs() > MOVE_TOLERANCE || (p.1 - q.1).abs() > MOVE_TOLERANCE || p.2 != q.2 || p.3 != q.3;
    Ok(now.iter().filter(|(r, pose)| moved(&earlier[*r], pose)).map(|(r, _)| r.clone()).collect())
}

fn board_poses(path: &Path) -> Result<BTreeMap<String, Pose>, String> {
    let (_server, mut client) = Server::start(path)?;
    read_board(&mut client, path).map(|b| poses(&b)).map_err(|e| e.to_string())
}

fn read_json<T: serde::de::DeserializeOwned>(path: &Path) -> Result<T, String> {
    let text = fs::read_to_string(path).map_err(|e| format!("{}: {e}", path.display()))?;
    serde_json::from_str(&text).map_err(|e| format!("{}: {e}", path.display()))
}

/// The present cost starts where the earlier negotiation ended; an earlier reuse route itself started at its seed's passes.
fn seed_passes(route_passes: i64, earlier: Option<&EarlierReuse>) -> i64 {
    match earlier {
        Some(EarlierReuse { chosen: Some(c), passes: Some(p) }) if c == "reuse" && *p != 0 => p + route_passes - 1,
        _ => route_passes,
    }
}

/// Writes the seed of a reuse route from the run work folder beside `previous`.
pub fn reuse_seed(previous: &Path, route_in: &Path, out_json: &Path, fallback: &str, nets: &[String]) -> Result<ReuseRecord, String> {
    seed_from(previous, Path::new(&format!("{}.iotroute", previous.display())), route_in, out_json, fallback, nets)
}

/// The seed from the files of `previous` in `work`; `nets` are routed again with the nets it left open.
pub fn seed_from(previous: &Path, work: &Path, route_in: &Path, out_json: &Path, fallback: &str, nets: &[String]) -> Result<ReuseRecord, String> {
    let (result, route, drc) = (work.join("result.json"), work.join("route.json"), work.join("drc.json"));
    if !result.is_file() || !route.is_file() {
        return Err(format!("--reuse: {} has no run work folder with result.json and route.json", previous.display()));
    }
    let record: EarlierRecord = read_json(&result)?;
    let sha = sha_file(previous)?;
    if record.board_sha256.as_deref() != Some(sha.as_str()) {
        return Err(format!("--reuse: {} is not the board of its result.json (sha256 differs)", previous.display()));
    }
    let earlier: EarlierRoute = read_json(&route)?;
    let moved = moved_refs(&board_poses(previous)?, &board_poses(route_in)?)?;
    let mut failed: BTreeSet<String> = earlier.failed.iter().map(|f| f.net.clone()).collect();
    if drc.is_file() {
        failed.extend(drc_nets(&read_report(&drc)?));
    }
    failed.extend(nets.iter().cloned());
    let failed: Vec<String> = failed.into_iter().collect();
    let passes = seed_passes(earlier.passes, record.reuse.as_ref());
    let source = previous.display().to_string();
    let seed = Seed { failed_nets: &failed, moved_refs: &moved, passes, schema: SEED_SCHEMA, source: &source, source_sha256: &sha, tracks: &earlier.tracks, vias: &earlier.vias };
    fs::write(out_json, serde_json::to_string(&seed).map_err(|e| e.to_string())?).map_err(|e| format!("{}: {e}", out_json.display()))?;
    Ok(ReuseRecord { source, source_sha256: sha, moved_refs: moved, failed_nets: failed, passes, tracks: earlier.tracks.len(), vias: earlier.vias.len(), seed_sha256: sha_file(out_json)?, fallback: fallback.to_string(), attempts: BTreeMap::new(), chosen: None, incumbent_note: None })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::run::record::{CoreStage, RouteClaim, WriteStage};

    fn feedback_model(cost: &str) -> String {
        format!(r#"{{"schema":"iot-lab.route-model.v0","pcb":"input.kicad_pcb","pads":[{{"x":0.30000000000000000001}}],"rules":[{{"min":0.15}}],"nets":{{"A":{{"ref_soft":true,"ref_cost":{cost},"width":0.2}},"B":{{"ref_soft":true,"ref_cost":3.0}}}}}}"#)
    }

    #[test]
    fn feedback_reuse_accepts_only_the_existing_named_cost_transition() {
        let before = feedback_model("3.0");
        let after = feedback_model("30.0");
        assert!(feedback_transition(before.as_bytes(), after.as_bytes(), &["A".into()]).is_ok());
        let hard = feedback_model("300.0");
        let hardened = hard.replacen("\"ref_soft\":true", "\"ref_soft\":false", 1);
        assert!(feedback_transition(hard.as_bytes(), hardened.as_bytes(), &["A".into()]).is_ok());
        assert!(feedback_transition(before.as_bytes(), after.as_bytes(), &[]).is_err());
        assert!(feedback_transition(before.as_bytes(), after.as_bytes(), &["A".into(), "A".into()]).is_err());
        assert!(feedback_transition(before.as_bytes(), after.as_bytes(), &["missing".into()]).is_err());
        assert!(feedback_transition(before.as_bytes(), before.as_bytes(), &["A".into()]).is_err());
    }

    #[test]
    fn feedback_reuse_invalidates_geometry_rules_and_unrelated_cost_changes_exactly() {
        let before = feedback_model("3.0");
        let after = feedback_model("30.0");
        for changed in [
            after.replace("input.kicad_pcb", "other.kicad_pcb"),
            after.replace("0.30000000000000000001", "0.30000000000000000002"),
            after.replace("\"min\":0.15", "\"min\":0.2"),
            after.replace("\"width\":0.2", "\"width\":0.3"),
            after.replace("\"ref_cost\":3.0", "\"ref_cost\":30.0"),
            after.replace("\"pcb\":", "\"new_policy\":true,\"pcb\":"),
        ] {
            assert!(feedback_transition(before.as_bytes(), changed.as_bytes(), &["A".into()]).is_err(), "{changed}");
        }
        let plane = before.replacen("\"width\":0.2", "\"width\":0.2,\"plane\":true", 1);
        assert!(feedback_transition(plane.as_bytes(), after.as_bytes(), &["A".into()]).is_err());
    }

    #[test]
    fn feedback_guard_matches_the_actual_reference_raise_producer() {
        let path = std::env::temp_dir().join(format!("iotroute-feedback-transition-{}", std::process::id()));
        for cost in ["3", "30.0", "300.0"] {
            let before = feedback_model(cost); fs::write(&path, &before).unwrap();
            let mut model = super::super::planes::ModelFile::read(&path).unwrap();
            let (changed, _, _) = model.raise(&["A".into()]).unwrap(); model.write(&path).unwrap();
            assert!(feedback_transition(before.as_bytes(), &fs::read(&path).unwrap(), &changed).is_ok(), "cost {cost}");
        }
        fs::remove_file(path).unwrap();
    }

    #[test]
    fn internal_feedback_seed_preserves_copper_and_binds_current_inputs_without_old_acceptance() {
        struct Temp(std::path::PathBuf);
        impl Drop for Temp { fn drop(&mut self) { let _ = fs::remove_dir_all(&self.0); } }
        let temp = Temp(std::env::temp_dir().join(format!("iotroute-feedback-{}", std::process::id())));
        fs::create_dir_all(&temp.0).unwrap();
        let (input, board, route, model, seed) = (temp.0.join("input"), temp.0.join("board"), temp.0.join("route.json"), temp.0.join("model.json"), temp.0.join("seed.json"));
        fs::write(&input, "unchanged native input").unwrap(); fs::write(&board, "written candidate").unwrap();
        let old = feedback_model("3.0"); fs::write(&model, feedback_model("30.0")).unwrap();
        let copper = r#"{"schema":"iot-lab.route-result.v0","failed":[],"passes":15,"tracks":[{"net":"B","a":[0.30000000000000000001,1]}],"vias":[{"net":"GND","role":"return"}]}"#;
        fs::write(&route, copper).unwrap();
        let input_sha = sha_file(&input).unwrap();
        let (record, binding) = feedback_seed(old.as_bytes(), &model, &input, &input_sha, &board, &route, &seed, &["A".into()]).unwrap();
        assert_eq!(record.failed_nets, ["A"]); assert!(record.moved_refs.is_empty());
        assert_eq!((record.passes, record.tracks, record.vias), (15, 1, 1));
        assert!(record.attempts.is_empty() && record.chosen.is_none());
        assert_eq!(binding.model_sha256, sha_file(&model).unwrap());
        assert_eq!(binding.source_route_sha256, sha_file(&route).unwrap());
        let bytes = fs::read_to_string(&seed).unwrap();
        assert!(bytes.contains("0.30000000000000000001"), "raw copper coordinates must not round-trip through f64");
        let raw: serde_json::Value = serde_json::from_str(&bytes).unwrap();
        assert_eq!(raw["schema"], SEED_SCHEMA); assert_eq!(raw["failed_nets"], serde_json::json!(["A"]));
        fs::write(&input, "changed native input").unwrap();
        assert!(feedback_seed(old.as_bytes(), &model, &input, &input_sha, &board, &route, &seed, &["A".into()]).unwrap_err().contains("input changed"));
        fs::write(&input, "unchanged native input").unwrap();
        fs::write(&route, copper.replace("\"failed\":[]", "\"failed\":[{\"net\":\"B\"}]")).unwrap();
        assert!(feedback_seed(old.as_bytes(), &model, &input, &input_sha, &board, &route, &seed, &["A".into()]).unwrap_err().contains("core failures"));
    }

    fn pose(x: i64, y: i64, turn: i64, layer: &str) -> Pose {
        (x, y, turn, layer.to_string())
    }

    fn map(items: &[(&str, Pose)]) -> BTreeMap<String, Pose> {
        items.iter().map(|(k, v)| (k.to_string(), v.clone())).collect()
    }

    #[test]
    fn a_part_moves_by_position_turn_or_side() {
        let earlier = map(&[("C1", pose(100, 200, 0, "F.Cu")), ("C2", pose(100, 200, 900, "F.Cu")), ("U1", pose(5000, 5000, 0, "F.Cu")), ("R1", pose(0, 0, 0, "F.Cu"))]);
        let now = map(&[("C1", pose(150, 200, 0, "F.Cu")), ("C2", pose(100, 200, 0, "F.Cu")), ("U1", pose(505000, 5000, 0, "F.Cu")), ("R1", pose(0, 0, 0, "B.Cu"))]);
        assert_eq!(moved_refs(&earlier, &now).unwrap(), ["C2", "R1", "U1"]);
        let mut more = now.clone();
        more.insert("C9".to_string(), pose(0, 0, 0, "F.Cu"));
        assert!(moved_refs(&earlier, &more).unwrap_err().contains("other parts: C9"));
    }

    fn attempt(unconnected: usize, failed: u64) -> Attempt {
        let claim = RouteClaim { status: "PASS".to_string(), converged: true, iters: 1, tracks: 0, vias: 0, failed, stop: None };
        let stages = AttemptStages { core: CoreStage { exit: 0, seconds: 0.0, claim: Some(claim) }, write: WriteStage { exit: 0, line: String::new() } };
        let mut a = Attempt::new(stages);
        a.set_drc(&DrcCounts { unconnected, ..DrcCounts::default() });
        a
    }

    #[test]
    fn the_better_attempt_has_fewer_problems_then_fewer_failed_nets() {
        let (reuse, full) = (attempt(1, 1), attempt(0, 0));
        assert!(full.better_than(&reuse) && !reuse.better_than(&full));
        assert!(!reuse.better_than(&reuse.clone()));
        assert!(attempt(1, 0).better_than(&reuse));
    }

    #[test]
    fn passes_continue_from_an_earlier_reuse_route() {
        assert_eq!(seed_passes(7, None), 7);
        assert_eq!(seed_passes(7, Some(&EarlierReuse { chosen: Some("reuse".to_string()), passes: Some(5) })), 11);
        assert_eq!(seed_passes(7, Some(&EarlierReuse { chosen: Some("full".to_string()), passes: Some(5) })), 7);
    }

    #[test]
    fn incumbent_model_comparison_ignores_only_the_input_copy_path() {
        let model = serde_json::json!({"schema":"iot-lab.route-model.v0", "pcb":"/old/input.kicad_pcb",
            "nets":{"GND":{"layers":["F.Cu"]}}, "pads":[{"x":1.0}], "rules":[], "copper":[]});
        let mut now = model.clone();
        now["pcb"] = "/new/input.kicad_pcb".into();
        assert!(same_problem(model.clone(), now.clone()));
        for field in ["nets", "pads", "rules", "copper"] {
            let mut changed = now.clone(); changed[field] = serde_json::json!(["changed"]);
            assert!(!same_problem(model.clone(), changed), "changed {field} must block replay");
        }
        now.as_object_mut().unwrap().remove("pcb");
        assert!(!same_problem(model, now));
    }

    #[test]
    fn incumbent_requires_unmoved_parts_and_an_intact_model_receipt() {
        assert!(incumbent_claim(Path::new("missing"), Path::new("missing"), &["U1".into()]).unwrap_err().contains("parts moved"));
        struct Temp(std::path::PathBuf);
        impl Drop for Temp { fn drop(&mut self) { let _ = fs::remove_dir_all(&self.0); } }
        let temp = Temp(std::env::temp_dir().join(format!("iotroute-incumbent-{}", std::process::id())));
        let previous = temp.0.join("old.kicad_pcb");
        let work = temp.0.join("old.kicad_pcb.iotroute");
        fs::create_dir_all(&work).unwrap();
        let model = serde_json::json!({"schema":"iot-lab.route-model.v0", "pcb":"old/input.kicad_pcb", "nets":{"GND":{}}, "pads":[], "rules":[]});
        let old_model = work.join("model.json");
        let current = temp.0.join("current.json");
        fs::write(&old_model, model.to_string()).unwrap();
        fs::write(&current, model.to_string()).unwrap();
        let receipt = serde_json::json!({"stages":{"model":{"sha256":sha_file(&old_model).unwrap()}}});
        fs::write(work.join("result.json"), receipt.to_string()).unwrap();
        fs::write(work.join("route.json"), serde_json::json!({"schema":"iot-lab.route-result.v0", "tracks":[],"vias":[],"failed":[{"net":"/SCL"}],"passes":6}).to_string()).unwrap();
        let claim = incumbent_claim(&previous, &current, &[]).unwrap();
        assert_eq!((claim.status.as_str(), claim.failed, claim.iters), ("FAIL", 1, 6), "an incomplete incumbent is never called PASS");
        let mut changed = model.clone(); changed["pads"] = serde_json::json!([{"x":1.0}]);
        fs::write(&current, changed.to_string()).unwrap();
        assert!(incumbent_claim(&previous, &current, &[]).unwrap_err().contains("admitted model changed"));
        fs::write(&old_model, changed.to_string()).unwrap();
        assert!(incumbent_claim(&previous, &current, &[]).unwrap_err().contains("receipt"));
    }
}
