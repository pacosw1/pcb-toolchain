//! --reuse: the seed of a partial re-route from an earlier result, and the choice between attempts. The seed is the copper of that
//! route, the parts that moved since, and the nets it left open or in a DRC error (DESIGN.md 5c).
use super::measure::{drc_nets, read_report};
use super::project::sha_file;
use super::record::{AttemptStages, DrcCounts};
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
    Ok(ReuseRecord { source, source_sha256: sha, moved_refs: moved, failed_nets: failed, passes, tracks: earlier.tracks.len(), vias: earlier.vias.len(), seed_sha256: sha_file(out_json)?, fallback: fallback.to_string(), attempts: BTreeMap::new(), chosen: None })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::run::record::{CoreStage, RouteClaim, WriteStage};

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
}
