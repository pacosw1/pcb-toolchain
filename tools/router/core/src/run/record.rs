//! The run record (schema iot-lab.iotroute-run.v1): OUT.iotroute/result.json, and the summary line.
use super::lock::LockStage;
use super::planes::RefGate;
use super::reuse::ReuseRecord;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

pub const SCHEMA: &str = "iot-lab.iotroute-run.v1";

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct RouteClaim {
    pub status: String,
    pub converged: bool,
    pub iters: u64,
    pub tracks: u64,
    pub vias: u64,
    pub failed: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub stop: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct BinaryStage {
    pub path: String,
    pub how: &'static str,
    pub sources_sha256: Option<String>,
    pub sha256: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct ModelStage {
    pub line: String,
    pub sha256: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct CoreStage {
    pub exit: i32,
    pub seconds: f64,
    pub claim: Option<RouteClaim>,
}

#[derive(Debug, Clone, Serialize)]
pub struct WriteStage {
    pub exit: i32,
    pub line: String,
}

/// One route with its write.
#[derive(Debug, Clone, Serialize)]
pub struct AttemptStages {
    pub core: CoreStage,
    pub write: WriteStage,
}

#[derive(Debug, Clone, Default, Serialize)]
pub struct Stages {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub binary: Option<BinaryStage>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub lock: Option<LockStage>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model: Option<ModelStage>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub core: Option<CoreStage>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub write: Option<WriteStage>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ref_gate: Option<RefGate>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tune: Option<TuneStage>,
}

/// --tune: the targets the core was given (run/tune.rs). What the core did is in route.json notes and route.tune.json.
#[derive(Debug, Clone, Default, Serialize)]
pub struct TuneStage {
    /// the targets file the core read (`--tune`)
    pub targets: String,
    pub skew_groups: usize,
    pub length_targets: usize,
    /// rules whose condition the selector could not decide for some net: those nets are not tuned
    pub unknown_rules: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub correction: Option<TuneCorrection>,
}

/// One correction round: KiCad's DRC found length / skew violations on the tuned board, so its own lengths (KiCad - core per net)
/// went to the targets as offsets and the route ran again; the board with fewer DRC errors + unconnected + parity is kept.
#[derive(Debug, Clone, Default, Serialize)]
pub struct TuneCorrection {
    pub offsets: BTreeMap<String, f64>,
    /// errors, unconnected, parity of the first board and of the corrected one
    pub first: [usize; 3],
    #[serde(skip_serializing_if = "Option::is_none")]
    pub corrected: Option<[usize; 3]>,
    pub chosen: String,
}

/// What the DRC on a board says.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct DrcCounts {
    pub errors: usize,
    pub unconnected: usize,
    pub parity: usize,
    pub by_type: BTreeMap<String, usize>,
}

impl DrcCounts {
    pub fn clean(&self) -> bool {
        self.errors == 0 && self.unconnected == 0 && self.parity == 0
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct Record {
    pub schema: &'static str,
    pub status: &'static str,
    pub board_file: String,
    pub work: Option<String>,
    pub stages: Stages,
    pub drc_errors: Option<usize>,
    pub unconnected: Option<usize>,
    pub parity: Option<usize>,
    pub tracks: Option<usize>,
    pub vias: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub board: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub input: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub input_sha256: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub iters: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub seed: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reuse: Option<ReuseRecord>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pro_restored: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub drc_by_type: Option<BTreeMap<String, usize>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub track_length_mm: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub board_sha256: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub diagnosis: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cause: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub seconds: Option<f64>,
}

impl Record {
    pub fn new(board_file: String, work: String) -> Record {
        Record {
            schema: SCHEMA, status: "ERROR", board_file, work: Some(work), stages: Stages::default(), drc_errors: None, unconnected: None, parity: None, tracks: None, vias: None,
            board: None, input: None, input_sha256: None, iters: None, seed: None, reuse: None, pro_restored: None, drc_by_type: None, track_length_mm: None, board_sha256: None, diagnosis: None, cause: None, seconds: None,
        }
    }

    fn count(value: Option<usize>) -> String {
        value.map_or("None".to_string(), |v| v.to_string())
    }

    /// `PASS|FAIL <drc errors> <unconnected> <parity> <tracks> <vias> <seconds>`, or `ERROR <seconds> <cause>`.
    pub fn summary_line(&self) -> String {
        let seconds = self.seconds.unwrap_or(0.0);
        if self.status == "ERROR" {
            return format!("ERROR {seconds:.0} {}", self.cause.as_deref().unwrap_or(""));
        }
        let c = Record::count;
        format!("{} {} {} {} {} {} {seconds:.0}", self.status, c(self.drc_errors), c(self.unconnected), c(self.parity), c(self.tracks), c(self.vias))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_summary_line_has_the_counts_or_the_cause() {
        let mut r = Record::new("o".to_string(), "w".to_string());
        (r.status, r.drc_errors, r.unconnected, r.parity, r.tracks, r.vias, r.seconds) = ("FAIL", Some(1), Some(0), Some(0), Some(10), Some(2), Some(61.4));
        assert_eq!(r.summary_line(), "FAIL 1 0 0 10 2 61");
        let mut e = Record::new("o".to_string(), "w".to_string());
        e.seconds = Some(0.2);
        e.cause = Some("x".to_string());
        assert_eq!(e.summary_line(), "ERROR 0 x");
    }

    #[test]
    fn a_record_keeps_its_schema_and_leaves_out_what_did_not_happen() {
        let v = serde_json::to_value(Record::new("o".to_string(), "w".to_string())).unwrap();
        assert_eq!(v["schema"], SCHEMA);
        assert_eq!(v["status"], "ERROR");
        assert!(v["drc_errors"].is_null() && v.get("board").is_none());
    }
}
