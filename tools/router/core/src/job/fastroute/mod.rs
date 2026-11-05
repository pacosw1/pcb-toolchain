//! `iotroute fastroute BOARD.kicad_pcb OUTDIR ...`: one Fastroute job: route a board copy, import, verify, count with KiCad DRC.
//!
//! Fastroute (github.com/parisxmas/fastroute, GPL-3.0, a Rust port of Freerouting): $FASTROUTE_BIN.
//!  1. --plane-nets (or --gnd-vias): gnd_pad_vias first for each plane net. GND_OPEN counts the open connections of all skipped nets.
//!  2. Existing copper is locked and kept. The DSN gets only --layers as signal layers; --skip-net nets are not routed.
//!  3. fastroute -mp PASSES with the board's minimum width and edge clearance, then the session goes onto the board as text.
//!  4. The via count must equal the router's report. 5. kicad-cli pcb drc on OUTDIR/routed.kicad_pcb.
//! Prints "UNROUTED <signal> GND_OPEN <n> ERRORS <n> ROUTER_UNROUTED <n> CONGESTION <n> BLOCKED <n> TRACK_MM <n> VIAS <n> SECONDS <n>".
//! Exit 3: routed with open signal connections (fail_fast). Exit 4: the result is not verified; do not use the board.
//!
//! The board is text between passes, and the import changes only copper: footprints cannot move and locked copper cannot change, so
//! pcbnew's pose and replay guards have nothing left to check. Fill, DRC and the save are KiCad 10's `kicad-cli`.
//!
//! Stops rather than run without a proof:
//! - `--native-thermal-checkback`: its receipts prove `ZONE_FILLER.Fill` returned true, which `kicad-cli` does not report.
//! - A board whose gate.json `route_rules` plugin has mandatory preserved-copper rules (`preserved_input_faults`): that plugin is Python.
pub mod args;
pub mod copper;
mod finish;
mod pass;
mod prepare;
pub mod repair;
mod stages;


use crate::job::clock::{self, DEADLINE_ENV, Env};
use crate::job::files::{atomic_json, digest_if_file};
use crate::job::progress::Progress;
use crate::job::record::{Record, RunRecord};
use crate::job::resources::{self, Reservation};
use crate::job::stage::Runner;
use crate::job::stop::{self, Stop};
use crate::route_features::{self, Features};
use crate::routing_rules::stages::Stage;
use args::Args;
use serde_json::{Value, json};
use stages::Hot;
use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

pub const STUCK_RC: i32 = 3;
pub(crate) const NOT_VERIFIED: i32 = 4;
const USAGE: &str = "usage: iotroute fastroute BOARD OUTDIR [--passes N] [--layers L,L] [--skip-net LIST] [--plane-nets LIST] [--only-nets LIST] [--max-time S] [--threads N] [--set KEY=VALUE] ...";
/// A routing job reserves its measured peak: BASE-PWR-B, the largest board in scope, peaks at 1.07 GB in kicad-cli DRC --refill-zones.
/// 2 GiB is about 2x.
const ROUTE_MEMORY_GIB: f64 = 2.0;
const ADMISSION_WAIT_S: f64 = 3600.0;

/// `feature.fail_fast`: off means off; the defaults apply only when the feature is on.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct FailFast {
    pub optimizer_if_routed: bool,
    pub stuck_exit: bool,
    pub stall_passes: u64,
}

/// One job, from the start to its last line.
pub struct Job {
    pub a: Args,
    pub out: PathBuf,
    pub board: PathBuf,
    /// The board path without its extension: the project and rules beside it.
    pub stem: PathBuf,
    pub base: PathBuf,
    pub routed: PathBuf,
    pub bin: PathBuf,
    pub cli: String,
    pub runner: Runner,
    pub progress: Arc<Mutex<Progress>>,
    pub record: RunRecord,
    pub feat: Features,
    pub rules_on: bool,
    pub fail_fast: FailFast,
    pub backend: Value,
    /// The board as the job has it now.
    pub text: String,
    /// The lock of each input item, by uuid.
    pub was: BTreeMap<String, bool>,
    pub unlock: BTreeSet<String>,
    pub nets: BTreeSet<String>,
    pub planes: Vec<String>,
    pub plane_names: BTreeSet<String>,
    pub skip: Vec<String>,
    pub min_um: i64,
    pub edge_um: i64,
    pub sources: Vec<PathBuf>,
    pub router_env: Env,
    pub deadline: Option<f64>,
    pub multi_pass: bool,
    pub solver_launches: Vec<String>,
    pub native_obligations: Vec<Value>,
}

impl Job {
    /// The file `name` of the job folder.
    pub fn file(&self, name: &str) -> PathBuf {
        self.out.join(name)
    }

    pub fn write_json(&self, name: &str, value: &impl serde::Serialize) -> Result<(), Stop> {
        atomic_json(self.file(name), value).map_err(Stop::failed)
    }

    pub fn progress(&self, stage: &str) {
        self.progress.lock().unwrap_or_else(|poison| poison.into_inner()).mark(stage);
    }

    /// `feat` as the job's files hold it.
    pub fn features_json(&self) -> Value {
        let mut map: serde_json::Map<String, Value> = self.feat.features.iter().map(|(name, feature)| (name.clone(), Value::Object(feature.clone()))).collect();
        map.insert("_board_dir".into(), self.feat.board_dir.as_ref().map_or(Value::Null, |dir| json!(dir.display().to_string())));
        Value::Object(map)
    }

    /// One run record per routing-rules decision, with its why.
    fn plan_records(&self, plan: &[Stage], fine: &BTreeMap<String, f64>, nets: usize, belt: f64, pitch: f64, hot: &BTreeMap<String, Hot>) -> Result<(), Stop> {
        for (name, stage_nets, keep) in plan {
            let why = if *keep { "reference-plane keepouts on the adjacent layer (rule 3: never cross a split)" } else { "no keepout: power/ground or exempt nets" };
            let record = Record::new("plan", format!("stage {name}"), format!("{why}; its copper is locked for the later stages (rule 1)"));
            self.record.append(record.inputs(json!({"nets": stage_nets.len()})).evidence("STAGES line").result(json!({"keepout": keep, "locked_after": true})))?;
        }
        if !fine.is_empty() {
            let why = format!("fine pitch <= {} mm (IPC-7351B): fan out inside a belt of one clearance + a via + a track before any wide copper", crate::model::num::short_float(pitch));
            let record = Record::new("plan", "escape belt", why).inputs(json!({"refs": fine.keys().collect::<Vec<_>>(), "nets": nets}));
            self.record.append(record.evidence("ESCAPE line").result(json!({"belt_mm": belt})))?;
        }
        for (net, loop_) in hot {
            let record = Record::new("plan", "hot loop", "switch node: corridor keepout, one layer, raised via cost (minimum loop area)");
            self.record.append(record.inputs(json!({"net": net, "pads": loop_.loop_pads})).evidence("HOT_LOOP line").result(json!({"max_mm": loop_.found.max_mm, "layer": loop_.layer})))?;
        }
        Ok(())
    }
}

/// `outcome.json` of a job the deadline ended: what was retained, none of it qualified.
fn timeout_outcome(outdir: &Path, cause: &str, cleanup: &Value) -> Result<(), String> {
    let names = ["board.dsn", "board.ses", "screen.ses", "report.json", "run.log", "stages.jsonl", "effective-configuration.json"];
    let artifacts: BTreeMap<&str, String> = names.iter().filter_map(|name| digest_if_file(outdir.join(name)).map(|digest| (*name, digest))).collect();
    let note = "deadline reached; checkpoints are incomplete evidence, not a verified candidate";
    atomic_json(outdir.join("outcome.json"), &json!({"status": "timeout", "returncode": 124, "qualified": false, "artifacts": artifacts, "cause": cause, "cleanup": cleanup, "note": note}))
}

/// An exit with no outcome.json still leaves terminal evidence for the live view.
fn final_records(outdir: &Path, stop: Option<&Stop>) {
    if !outdir.is_dir() {
        return;
    }
    let record = RunRecord::start(outdir);
    if !outdir.join("outcome.json").is_file() {
        let code = match stop {
            None => Some(0),
            Some(Stop::Exit { code, .. }) => Some(*code),
            Some(_) => None,
        };
        if let Some(code) = code {
            let message = stop.and_then(|stop| if let Stop::Exit { message, .. } = stop { message.clone() } else { None });
            let (action, why) = if code == 0 { ("exit OK", "the job exited without outcome.json") } else { ("exit FAILED", "the job exited without outcome.json: it failed") };
            let _ = record.append(Record::new("job", action, why).evidence("fastroute_job exit").result(json!({"returncode": code, "message": message})));
        }
    }
    let _ = record.sync();
}

fn end(outdir: &Path, result: Result<(), Stop>, admitted: bool, cpu: u32, memory: f64, wait: f64) -> i32 {
    let stop = result.err();
    // KiCad API servers of the job and its tools leave their project lock behind.
    for name in ["~base.kicad_pro.lck", "~routed.kicad_pro.lck"] {
        let _ = std::fs::remove_file(outdir.join(name));
    }
    if admitted {
        final_records(outdir, stop.as_ref());
    }
    match stop {
        None => 0,
        Some(Stop::Exit { code, message }) => {
            if let Some(message) = message {
                eprintln!("{message}");
            }
            code
        }
        Some(Stop::Timeout { cause, cleanup }) => {
            if outdir.is_dir() {
                let _ = timeout_outcome(outdir, &cause, &cleanup);
            }
            eprintln!("fastroute_job: deadline reached; retained checkpoints are unqualified");
            124
        }
        Some(Stop::AdmissionTimeout(error)) => {
            eprintln!("fastroute_job: ADMISSION TIMEOUT: no {cpu} CPU / {memory} GiB slot within {wait:.0} s ({error})");
            124
        }
        Some(Stop::Cancelled { signal, cleanup }) => {
            let code = 128 + signal.unwrap_or(2);
            if outdir.is_dir() {
                let _ = atomic_json(outdir.join("outcome.json"), &json!({"status": "cancelled", "returncode": code, "qualified": false, "signal": signal, "cleanup": cleanup}));
            }
            code
        }
    }
}

fn number_env(env: &Env, name: &str, fallback: f64) -> Result<f64, String> {
    env.get(name).map_or(Ok(fallback), |value| value.parse().map_err(|_| format!("{name} must be a number")))
}

fn reserve(a: &Args, cpu: u32, memory: f64, wait: f64, env: &Env) -> Result<(Reservation, Env), Stop> {
    let events = PathBuf::from(format!("{}.admission.jsonl", a.outdir));
    let reservation = resources::reserve(cpu, memory, wait, Some(&events), "routing", env)?;
    let mut budget = reservation.env.clone();
    if a.max_time > 0 {
        let deadline = clock::after(a.max_time as f64, &budget).map_err(Stop::failed)?;
        budget.insert(DEADLINE_ENV.to_string(), clock::encode(deadline));
    }
    Ok((reservation, budget))
}

pub fn cli(words: &[String]) -> i32 {
    let env: Env = std::env::vars().collect();
    let a = match args::parse(words, &env) {
        Ok(a) => a,
        Err(error) => {
            eprintln!("{USAGE}\niotroute fastroute: error: {error}");
            return 2;
        }
    };
    stop::catch_stop_signals();
    let outdir = PathBuf::from(&a.outdir);
    let budget = (|| -> Result<(u32, f64, f64), String> {
        let cpu = if a.threads > 0 { a.threads as u32 } else { resources::default_cpu(&env)? };
        Ok((cpu, number_env(&env, "IOT_ROUTE_MEMORY_GIB", ROUTE_MEMORY_GIB)?, number_env(&env, "IOT_ROUTE_ADMISSION_WAIT_S", ADMISSION_WAIT_S)?))
    })();
    let (cpu, memory, wait) = match budget {
        Ok(budget) => budget,
        Err(error) => {
            eprintln!("fastroute_job: {error}");
            return 1;
        }
    };
    match reserve(&a, cpu, memory, wait, &env) {
        Err(stop) => end(&outdir, Err(stop), false, cpu, memory, wait),
        Ok((reservation, job_env)) => {
            let result = prepare::run(a, cpu, job_env);
            let code = end(&outdir, result, true, cpu, memory, wait);
            drop(reservation);
            code
        }
    }
}

/// The feature file the job read, then the board's, as `sources` in the effective configuration.
pub(crate) fn feature_sources(feat: &Features) -> Vec<PathBuf> {
    let env = route_features::Env::current();
    let mut sources = vec![env.features_file.clone().map_or_else(route_features::defaults_path, PathBuf::from)];
    if let Some(dir) = &feat.board_dir {
        let halo = feat.setting("via_halo", "fast_nets_file").and_then(Value::as_str).unwrap_or("rp001-fast-nets.json");
        sources.extend([dir.join("gate.json"), dir.join(halo)]);
    }
    sources
}

