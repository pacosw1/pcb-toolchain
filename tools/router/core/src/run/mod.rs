//! `iotroute run BOARD OUT.kicad_pcb [--pcb IN.kicad_pcb] [--iters N] [--max-time S] [--lock-from SRC.kicad_pcb]
//!               [--reuse PREV.kicad_pcb [--reuse-fallback full|none] [--reuse-net NET]...] [--seed N] [--stall-passes N] [--checkpoint]
//!               [--congestion] [--return-exempt] [--ref-reuse] [--diagnose] [--plane-net NET]... [--layer L]... [--net NET]... [--tools DIR] [--json]`
//!
//! One entry point for the in-house router: model, route, board copy, KiCad DRC (tools/router/DESIGN.md). BOARD is the board ID
//! (hardware-design/boards/<BOARD>) or that folder. The input is --pcb, else the project board; it is only read. --tools is the
//! tools folder, by default ./tools; the board ID is looked up beside it. Steps, each stopping the run at its first failure:
//!
//!  1. --lock-from SRC: a copy of the input without tracks and vias, with the copper of the lock nets from SRC, locked. Lock nets
//!     are the diff pairs and the nets with DRU via_count 0, read from the model of SRC. Without it all copper of the input stays
//!     and is locked. --route-crystals (needs --lock-from): the via_count 0 nets that are no pair member are stripped instead of
//!     locked and named in the model's `critical_nets`: the core routes them first, on one layer with no via, and freezes them
//!     (core critical.rs).
//!  2. The preflight (guard.rs): KiCad DRC of what will be routed, which stops at a fault of its existing copper. Then `iotroute model`,
//!     the route, the `widths` rules of the board's route.json and `iotroute write`, whose board must keep all copper of its input.
//!  3. OUT gets the board and the project files of the input; the input's .kicad_pro goes back if a save rewrote it.
//!  4. KiCad DRC with --schematic-parity on OUT, on the saved fill.
//!  5. --diagnose: when OUT has opens, why, for the compaction (diagnose.rs). It never changes the verdict.
//!  6. When OUT is not clean, the short report of that in OUT.iotroute/stuck.json (crate::stuck), against the report of --reuse PREV
//!     when it has one. Without --diagnose it has the DRC and the search but no triage.
//!
//! --reuse PREV (partial re-route, DESIGN.md 5c): the seed is PREV's route, the parts moved since, the nets PREV left open or in
//! a DRC error, and each --reuse-net. --reuse-fallback full (default): when the reuse result is not PASS, the full route of the same input runs too and
//! the better one is kept; a tie keeps the full route. none: the reuse result is the result.
//!
//! The router's own counts are never the verdict; the DRC on OUT is. Output, one line:
//! PASS|FAIL <drc errors> <unconnected> <parity> <tracks> <vias> <seconds>, or ERROR <seconds> <cause> when a step did not
//! complete; with --json the record on the next line. The record is also in OUT.iotroute/result.json. Exit: 0 PASS, 1 FAIL, 2 no
//! verdict.
pub mod diagnose;
pub mod guard;
pub mod lock;
pub mod measure;
pub mod planes;
pub mod policy;
pub mod prepared;
pub mod project;
pub mod record;
pub mod reuse;
pub mod steps;
mod widths;

use lock::{LockStage, lock_nets, make_locked_input, split_crystals};
use measure::{copper_counts, run_drc};
use planes::{FeedbackReuse, ModelFile, RefGate, Round, ROUNDS, fail_lines, planes_spec};
use project::{board_project, place_sidecars, restore_pro, sha_file};
use record::{AttemptStages, BinaryStage, CoreStage, DrcCounts, ModelStage, Record};
use reuse::{Attempt, reuse_seed};
use serde_json::Value;
use std::collections::BTreeMap;
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::time::Instant;
use steps::{Steps, last_line, sources_sha};

const USAGE: &str = "usage: iotroute run BOARD OUT.kicad_pcb [--pcb IN] [--iters N] [--max-time S] [--lock-from SRC] [--reuse PREV] [--reuse-fallback full|none] [--reuse-net NET]... [--route-crystals] [--congestion] [--return-exempt] [--ref-reuse] [--diagnose] [--plane-net NET]... [--layer L]... [--net NET]... [--seed N] [--stall-passes N] [--checkpoint] [--tools DIR] [--json]";

#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
pub struct Args {
    pub board: String,
    pub out: String,
    pub pcb: Option<String>,
    pub iters: u64,
    pub max_time: Option<f64>,
    pub lock_from: Option<String>,
    pub reuse: Option<String>,
    pub reuse_fallback: String,
    pub reuse_nets: Vec<String>,
    pub congestion: bool,
    pub return_exempt: bool,
    /// Opt-in: route the via_count 0 nets (crystals) first instead of keeping their copper; needs --lock-from.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub route_crystals: bool,
    /// Opt-in experiment: copper reuse after reference feedback, with fresh checks and full fallback.
    #[serde(default)]
    pub ref_reuse: bool,
    pub diagnose: bool,
    pub plane_nets: Vec<String>,
    pub layers: Vec<String>,
    pub nets: Vec<String>,
    pub seed: Option<u64>,
    #[serde(default)]
    pub via_cost: Option<f64>,
    pub stall_passes: Option<u64>,
    pub checkpoint: bool,
    pub tools: PathBuf,
    pub json: bool,
}

fn value<T: std::str::FromStr>(flag: &str, text: Option<&String>) -> Result<T, String> {
    let text = text.ok_or_else(|| format!("{flag}: a value is needed"))?;
    text.parse().map_err(|_| format!("{flag}: {text} is not valid"))
}

pub fn parse_args(argv: &[String]) -> Result<Args, String> {
    let mut a = Args {
        board: String::new(), out: String::new(), pcb: None, iters: 80, max_time: None, lock_from: None, reuse: None, reuse_fallback: "full".to_string(), reuse_nets: Vec::new(),
        congestion: std::env::var("IOTROUTE_CONGESTION").is_ok_and(|v| v == "1"), return_exempt: false, route_crystals: false, ref_reuse: false, diagnose: false, plane_nets: Vec::new(), layers: Vec::new(), nets: Vec::new(), seed: None, via_cost: None, stall_passes: None, checkpoint: false, tools: PathBuf::from("tools"), json: false,
    };
    let mut positional = Vec::new();
    let mut it = argv.iter();
    while let Some(arg) = it.next() {
        match arg.as_str() {
            "--pcb" => a.pcb = Some(value(arg, it.next())?),
            "--iters" => a.iters = value(arg, it.next())?,
            "--max-time" => a.max_time = Some(value(arg, it.next())?),
            "--lock-from" => a.lock_from = Some(value(arg, it.next())?),
            "--reuse" => a.reuse = Some(value(arg, it.next())?),
            "--reuse-fallback" => a.reuse_fallback = value(arg, it.next())?,
            "--reuse-net" => a.reuse_nets.push(value(arg, it.next())?),
            "--seed" => a.seed = Some(value(arg, it.next())?),
            "--stall-passes" => a.stall_passes = Some(value(arg, it.next())?),
            "--tools" => a.tools = PathBuf::from(value::<String>(arg, it.next())?),
            "--plane-net" => a.plane_nets.push(value(arg, it.next())?),
            "--layer" => a.layers.push(value(arg, it.next())?),
            "--net" => a.nets.push(value(arg, it.next())?),
            "--congestion" => a.congestion = true,
            "--return-exempt" => a.return_exempt = true,
            "--route-crystals" => a.route_crystals = true,
            "--ref-reuse" => a.ref_reuse = true,
            "--diagnose" => a.diagnose = true,
            "--checkpoint" => a.checkpoint = true,
            "--json" => a.json = true,
            other if other.starts_with('-') => return Err(format!("{other} is not an option")),
            _ => positional.push(arg.clone()),
        }
    }
    if !matches!(a.reuse_fallback.as_str(), "full" | "none") {
        return Err("--reuse-fallback: full or none".to_string());
    }
    if a.ref_reuse && a.reuse.is_some() {
        return Err("--ref-reuse cannot combine with --reuse; reference feedback needs a fresh initial route".into());
    }
    if a.route_crystals && a.lock_from.is_none() {
        return Err("--route-crystals needs --lock-from: without it all input copper stays locked".into());
    }
    let [board, out] = positional.as_slice() else { return Err("BOARD and OUT are needed".to_string()) };
    (a.board, a.out) = (board.clone(), out.clone());
    Ok(a)
}

fn absolute(path: &str) -> Result<PathBuf, String> {
    std::path::absolute(path).map_err(|e| format!("{path}: {e}"))
}

/// One run: what stays the same over its attempts.
struct Run<'a> {
    a: &'a Args,
    steps: Steps,
    model: PathBuf,
    route_in: PathBuf,
    route_in_sha256: String,
    src: PathBuf,
    folder: PathBuf,
    widths: Vec<crate::plan::WidthRule>,
}

fn scoped_feedback_passes(stages: &AttemptStages, drc: &DrcCounts, planes_failures: usize) -> bool {
    stages.core.exit == 0 && stages.write.exit == 0 && drc.clean() && planes_failures == 0
        && stages.core.claim.as_ref().is_some_and(|c| c.status == "PASS" && c.converged && c.failed == 0)
}

impl Run<'_> {
    /// Route and write -> OUT with its project files.
    fn attempt(&self, out: &Path, work: &Path, extra: &[String]) -> Result<(AttemptStages, bool), String> {
        let stages = self.steps.route_and_write(self.a, &self.model, &self.route_in, out, work, extra, &self.widths)?;
        place_sidecars(&self.src, out)?;
        Ok((stages, restore_pro(&self.src, out)?))
    }

    fn copy_results(&self, from: &Path, to: &Path, names: &[&str]) -> Result<(), String> {
        for name in names.iter().map(|n| from.join(n)).filter(|p| p.is_file()) {
            fs::copy(&name, to.join(name.file_name().expect("a file"))).map_err(|e| format!("{}: {e}", name.display()))?;
        }
        Ok(())
    }

    /// Try the existing copper-reuse engine under a fresh changed model. An
    /// unverified scoped result never replaces the candidate; full routing is
    /// the fallback, and the ordinary feedback/final gate still runs afterward.
    fn feedback_attempt(&self, previous: &Path, previous_route: &Path, out: &Path, work: &Path,
        before_model: &[u8], changed: &[String], spec: &Path) -> Result<(AttemptStages, FeedbackReuse), String> {
        self.feedback_attempt_using(previous, previous_route, out, work, before_model, changed, spec, run_drc)
    }

    fn feedback_attempt_using(&self, previous: &Path, previous_route: &Path, out: &Path, work: &Path,
        before_model: &[u8], changed: &[String], spec: &Path,
        native_check: impl Fn(&Path, &Path) -> Result<DrcCounts, String>) -> Result<(AttemptStages, FeedbackReuse), String> {
        if sha_file(&self.route_in)? != self.route_in_sha256 { return Err("feedback input changed during the run".into()); }
        let model_sha = sha_file(&self.model)?;
        let started = Instant::now();
        let mut evidence = FeedbackReuse { status: "pending", selected: "full", elapsed_s: None, binding: None, record: None,
            scoped_planes_fail_lines: None, fallback_reason: None };
        let seed = work.join("seed.json");
        let mut chosen: Option<(AttemptStages, PathBuf, PathBuf)> = None;
        let seeded = if self.widths.is_empty() {
            reuse::feedback_seed(before_model, &self.model, &self.route_in, &self.route_in_sha256, previous, previous_route, &seed, changed)
        } else {
            Err("scoped feedback reuse does not support route width rewriting; use the full route".into())
        };
        match seeded {
            Ok((record, binding)) => {
                evidence.record = Some(record); evidence.binding = Some(binding);
                let scoped = work.join("scoped"); fs::create_dir_all(&scoped).map_err(|e| e.to_string())?;
                let board = scoped.join(out.file_name().expect("OUT has a name"));
                let trial = (|| -> Result<(AttemptStages, DrcCounts, usize), String> {
                    let (stages, _) = self.attempt(&board, &scoped, &["--reuse".into(), seed.display().to_string(), "--reuse-recover".into(), "changed".into()])?;
                    let drc = native_check(&board, &scoped.join("drc.json"))?;
                    let text = self.steps.planes_check(&board, spec, &scoped.join("planes.log"))?;
                    Ok((stages, drc, fail_lines(&text).1))
                })();
                match trial {
                    Ok((stages, drc, planes)) => {
                        let mut attempt = reuse::Attempt::new(stages.clone()); attempt.set_drc(&drc);
                        evidence.record.as_mut().unwrap().attempts.insert("scoped".into(), attempt);
                        evidence.scoped_planes_fail_lines = Some(planes);
                        if scoped_feedback_passes(&stages, &drc, planes) {
                            evidence.selected = "scoped"; chosen = Some((stages, scoped, board));
                        } else {
                            evidence.fallback_reason = Some("scoped core, native or planes check did not pass".into());
                        }
                    }
                    Err(error) => evidence.fallback_reason = Some(error),
                }
            }
            Err(error) => evidence.fallback_reason = Some(error),
        }
        if sha_file(&self.model)? != model_sha || sha_file(&self.route_in)? != self.route_in_sha256 {
            return Err("feedback model or input changed during the scoped attempt".into());
        }
        // Preserve failed trial evidence even if the full fallback itself errors.
        fs::write(work.join("reuse.json"), serde_json::to_vec_pretty(&evidence).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
        let (stages, directory, board) = match chosen {
            Some(selected) => selected,
            None => {
                let full = work.join("full"); fs::create_dir_all(&full).map_err(|e| e.to_string())?;
                let board = full.join(out.file_name().expect("OUT has a name"));
                let (stages, _) = self.attempt(&board, &full, &[])?;
                let mut attempt = reuse::Attempt::new(stages.clone());
                attempt.set_drc(&native_check(&board, &full.join("drc.json"))?);
                if let Some(record) = &mut evidence.record { record.attempts.insert("full".into(), attempt); }
                (stages, full, board)
            }
        };
        if sha_file(&self.model)? != model_sha || sha_file(&self.route_in)? != self.route_in_sha256 {
            return Err("feedback model or input changed during feedback selection".into());
        }
        if let Some(record) = &mut evidence.record { record.chosen = Some(evidence.selected.into()); }
        self.copy_results(&directory, work, &["route.json", "route.log", "write.log"])?;
        fs::copy(&board, out).map_err(|e| e.to_string())?;
        place_sidecars(&self.src, out)?; restore_pro(&self.src, out)?;
        evidence.status = "complete"; evidence.elapsed_s = Some(started.elapsed().as_secs_f64());
        fs::write(work.join("reuse.json"), serde_json::to_vec_pretty(&evidence).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
        Ok((stages, evidence))
    }

    /// The gate's planes screen on the written board, and again after each raise of the failed soft nets.
    fn ref_gate(&self, out: &Path, work: &Path) -> Result<RefGate, String> {
        if !ModelFile::read(&self.model)?.has_soft_net() {
            return Ok(RefGate { rounds: Vec::new(), note: Some("no soft reference net") });
        }
        let Some(spec) = planes_spec(&self.folder)? else { return Ok(RefGate { rounds: Vec::new(), note: Some("no planes check in gate.json") }) };
        let mut rounds: Vec<Round> = Vec::new();
        for k in 0..=ROUNDS {
            let text = self.steps.planes_check(out, &self.folder.join(&spec), &work.join(format!("planes-r{}.log", k + 1)))?;
            let (nets, count) = fail_lines(&text);
            let before_model = if self.a.ref_reuse { Some(fs::read(&self.model).map_err(|e| e.to_string())?) } else { None };
            let mut model = ModelFile::read(&self.model)?;
            let (soft, raised, set_hard) = model.raise(&nets)?;
            rounds.push(Round { round: k + 1, planes_fail_lines: count, fail_nets: nets, raised, set_hard, next_core: None, next_core_seconds: None, reuse: None });
            if soft.is_empty() || k == ROUNDS {
                break;
            }
            model.write(&self.model)?;
            let again = work.join(format!("ref-r{}", k + 2));
            fs::create_dir_all(&again).map_err(|e| format!("{}: {e}", again.display()))?;
            let candidate = again.join(out.file_name().expect("OUT has a name"));
            let stages = match before_model {
                Some(before) => {
                    let (stages, evidence) = self.feedback_attempt(out, &work.join("route.json"), &candidate, &again, &before, &soft, &self.folder.join(&spec))?;
                    rounds.last_mut().unwrap().reuse = Some(evidence);
                    stages
                }
                None => self.attempt(&candidate, &again, &[])?.0,
            };
            rounds.last_mut().expect("a round").next_core_seconds = Some(stages.core.seconds);
            rounds.last_mut().expect("a round").next_core = Some(stages.core.claim);
            if k == 0 {
                // Keep the first pass/length-recovery log before the selected feedback log replaces it.
                fs::copy(work.join("route.log"), work.join("route-initial.log")).map_err(|e| format!("preserve initial route log: {e}"))?;
            }
            self.copy_results(&again, work, &["route.json", "route.log", "write.log"])?;
            fs::copy(&candidate, out).map_err(|e| format!("{}: {e}", out.display()))?;
            place_sidecars(&self.src, out)?;
            restore_pro(&self.src, out)?;
        }
        Ok(RefGate { rounds, note: None })
    }

    /// The partial route first; the full route only as the fallback of a result that is not PASS. Each attempt in its own folder;
    /// the chosen one's files go to work and its board to OUT. -> its stages and whether the project file went back.
    fn reuse_attempts(&self, previous: &str, out: &Path, work: &Path, rec: &mut Record) -> Result<(AttemptStages, bool), String> {
        let seed = work.join("seed.json");
        let mut record = reuse_seed(&absolute(previous)?, &self.route_in, &seed, &self.a.reuse_fallback, &self.a.reuse_nets)?;
        let incumbent = reuse::incumbent_claim(&absolute(previous)?, &self.model, &record.moved_refs);
        record.incumbent_note = Some(match &incumbent {
            Ok(_) => "same admitted model and receipt-bound previous model; replay eligible if routing leaves native problems".into(),
            Err(reason) => format!("not eligible: {reason}"),
        });
        let tries: Vec<(&str, Vec<String>)> = std::iter::once(("reuse", vec!["--reuse".to_string(), seed.display().to_string()])).chain((self.a.reuse_fallback == "full").then(|| ("full", Vec::new()))).collect();
        let mut chosen: Option<&str> = None;
        for (name, extra) in &tries {
            let folder = work.join(format!("a-{name}"));
            fs::create_dir_all(&folder).map_err(|e| format!("{}: {e}", folder.display()))?;
            let candidate = folder.join(out.file_name().expect("OUT has a name"));
            let (stages, _) = self.attempt(&candidate, &folder, extra)?;
            let mut attempt = Attempt::new(stages);
            if tries.len() == 1 && incumbent.is_err() {
                record.attempts.insert(name.to_string(), attempt);
                chosen = Some(name);
                break;
            }
            let drc = run_drc(&candidate, &folder.join("drc.json"))?;
            attempt.set_drc(&drc);
            let takes_over = chosen.is_none_or(|c| {
                let best = &record.attempts[c];
                attempt.better_than(best) || (*name == "full" && !best.better_than(&attempt))
            });
            record.attempts.insert(name.to_string(), attempt);
            if takes_over {
                chosen = Some(name);
            }
            if drc.clean() {
                break;
            }
        }
        // Retained nets may move during negotiation. If an attempt destroys a
        // previously useful connection (notably GND), do not discard the bound
        // incumbent. Replay it through today's writer/width/copper guards and
        // native DRC; never select using cached acceptance counts.
        if let Ok(claim) = incumbent {
            let best = &record.attempts[chosen.expect("at least one attempt")];
            if best.drc_errors.unwrap_or(0) + best.unconnected.unwrap_or(0) + best.parity.unwrap_or(0) > 0 {
                let folder = work.join("a-incumbent");
                fs::create_dir_all(&folder).map_err(|e| e.to_string())?;
                let route = folder.join("route.json");
                fs::copy(format!("{previous}.iotroute/route.json"), &route).map_err(|e| e.to_string())?;
                fs::write(folder.join("route.log"), "REUSE INCUMBENT: replay of receipt-bound unchanged problem; no search\n").map_err(|e| e.to_string())?;
                let candidate = folder.join(out.file_name().expect("OUT has a name"));
                let write = self.steps.write_route(&self.route_in, &route, &candidate, &folder, &self.widths)?;
                place_sidecars(&self.src, &candidate)?;
                restore_pro(&self.src, &candidate)?;
                let core = CoreStage { exit: 0, seconds: 0.0, claim: Some(claim) };
                let mut attempt = Attempt::new(AttemptStages { core, write });
                attempt.set_drc(&run_drc(&candidate, &folder.join("drc.json"))?);
                if attempt.better_than(best) { chosen = Some("incumbent"); }
                record.attempts.insert("incumbent".into(), attempt);
            }
        }
        let chosen = chosen.expect("at least one attempt");
        record.chosen = Some(chosen.to_string());
        let folder = work.join(format!("a-{chosen}"));
        self.copy_results(&folder, work, &["route.json", "route.log", "write.log", "congestion.json", "checkpoint.json"])?;
        let stages = record.attempts[chosen].stages.clone();
        rec.reuse = Some(record);
        fs::copy(folder.join(out.file_name().expect("OUT has a name")), out).map_err(|e| format!("{}: {e}", out.display()))?;
        place_sidecars(&self.src, out)?;
        Ok((stages, restore_pro(&self.src, out)?))
    }
}

/// `iotroute lock-input BOARD SRC.kicad_pcb OUT.kicad_pcb [--tools DIR] [--nets NET,NET]`: the locked copy of --lock-from on its own,
/// for tools that prepare a board. The lock nets come from SRC's model unless --nets names them. Prints a JSON line with what it did.
pub fn lock_input_cli(args: &[String]) -> i32 {
    let usage = "usage: iotroute lock-input BOARD SRC.kicad_pcb OUT.kicad_pcb [--tools DIR] [--nets NET,NET]";
    let (mut positional, mut tools, mut named) = (Vec::new(), PathBuf::from("tools"), None);
    let mut it = args.iter();
    while let Some(arg) = it.next() {
        match arg.as_str() {
            "--tools" => tools = it.next().map_or(tools, PathBuf::from),
            "--nets" => named = it.next().map(|n| n.split(',').map(str::to_string).collect::<std::collections::BTreeSet<_>>()),
            _ => positional.push(arg.as_str()),
        }
    }
    let [board, source, out] = positional[..] else {
        eprintln!("{usage}");
        return 2;
    };
    match lock_input(board, source, out, &tools, named) {
        Ok(line) => {
            println!("{line}");
            0
        }
        Err(e) => {
            eprintln!("{e}");
            2
        }
    }
}

fn lock_input(board: &str, source: &str, out: &str, tools: &Path, named: Option<std::collections::BTreeSet<String>>) -> Result<String, String> {
    let (source, out) = (absolute(source)?, absolute(out)?);
    let root = std::path::absolute(tools).map_err(|e| e.to_string())?;
    let (folder, _) = board_project(board, root.parent().unwrap_or(Path::new(".")))?;
    let nets = match named {
        Some(nets) => nets,
        None => {
            let work = PathBuf::from(format!("{}.lock", out.display()));
            fs::create_dir_all(&work).map_err(|e| format!("{}: {e}", work.display()))?;
            let model = work.join("lock-model.json");
            let (code, text) = Steps::new(tools)?.model(&folder, &source, &model, &work.join("lock-model.log"), false)?;
            if code != 0 {
                return Err(format!("iotroute model failed: {}", last_line(&text)));
            }
            lock_nets(&fs::read_to_string(&model).map_err(|e| format!("{}: {e}", model.display()))?)?
        }
    };
    let (removed, kept) = make_locked_input(&source, &source, &nets, &out)?;
    serde_json::to_string(&serde_json::json!({"removed": removed, "kept": kept, "nets": nets})).map_err(|e| e.to_string())
}

/// `iotroute sheets ROOT.kicad_sch BASE`: the sheets a root sheet names, relative to BASE, one per line.
pub fn sheets_cli(args: &[String]) -> i32 {
    let [root, base] = args else {
        eprintln!("usage: iotroute sheets ROOT.kicad_sch BASE");
        return 2;
    };
    for sheet in project::referenced_sheets(Path::new(root), Path::new(base)) {
        println!("{sheet}");
    }
    0
}

/// The verdict: KiCad DRC with parity on OUT, and its copper.
fn finish(rec: &mut Record, out: &Path, work: &Path) -> Result<DrcCounts, String> {
    let drc = run_drc(out, &work.join("drc.json"))?;
    let counts = copper_counts(&fs::read_to_string(out).map_err(|e| format!("{}: {e}", out.display()))?)?;
    (rec.drc_errors, rec.unconnected, rec.parity) = (Some(drc.errors), Some(drc.unconnected), Some(drc.parity));
    rec.drc_by_type = Some(drc.by_type.clone());
    (rec.tracks, rec.vias, rec.track_length_mm) = (Some(counts.tracks), Some(counts.vias), Some(counts.length_mm));
    rec.board_sha256 = Some(sha_file(out)?);
    rec.status = if drc.clean() { "PASS" } else { "FAIL" };
    Ok(drc)
}

fn lock_step(steps: &Steps, folder: &Path, src: &Path, work: &Path, lock_from: &str, route_crystals: bool) -> Result<(PathBuf, LockStage), String> {
    let source = absolute(lock_from)?;
    let model = work.join("lock-model.json");
    let (code, text) = steps.model(folder, &source, &model, &work.join("lock-model.log"), false)?;
    if code != 0 {
        return Err(format!("iotroute model on --lock-from failed: {}", last_line(&text)));
    }
    let text = fs::read_to_string(&model).map_err(|e| format!("{}: {e}", model.display()))?;
    let (nets, critical) = if route_crystals { split_crystals(&text)? } else { (lock_nets(&text)?, Default::default()) };
    let copy = work.join("input").join(src.file_name().ok_or("a board file has a name")?);
    let (removed, kept) = make_locked_input(src, &source, &nets, &copy)?;
    let stage = LockStage { removed, kept, nets: nets.into_iter().collect(), source: source.display().to_string(), source_sha256: sha_file(&source)?, critical: critical.into_iter().collect() };
    Ok((copy, stage))
}

/// --plane-net: the net gets pad vias into its pour and no tracks, as a stage's `plane_nets` in `iotroute route`.
fn set_plane_nets(model: &mut Value, names: &[String]) -> Result<(), String> {
    for name in names {
        let net = model["nets"].get_mut(name).ok_or_else(|| format!("--plane-net: {name} is not on the board"))?;
        if net["plane_polys"].is_null() {
            return Err(format!("--plane-net: {name} has no pour to reach"));
        }
        net["plane"] = true.into();
    }
    Ok(())
}

/// --layer: every net may use only these of the layers it had; a net left with none is refused by name.
fn set_layers(model: &mut Value, names: &[String]) -> Result<(), String> {
    if let Some(name) = names.iter().find(|name| !model["copper_layers"].as_array().is_some_and(|layers| layers.iter().any(|l| l.as_str() == Some(name)))) {
        return Err(format!("--layer: {name} is not a copper layer of the board"));
    }
    for (name, net) in model["nets"].as_object_mut().ok_or("the model has no nets")? {
        let Some(layers) = net["layers"].as_array_mut().filter(|layers| !layers.is_empty()) else { continue };
        layers.retain(|layer| names.iter().any(|allowed| layer.as_str() == Some(allowed)));
        if layers.is_empty() {
            return Err(format!("--layer: net {name} may use none of these layers"));
        }
    }
    Ok(())
}

/// --net: the core routes only these; the copper of every other net stays as it is. The DRC on OUT still judges the whole board.
fn set_route_nets(model: &mut Value, names: &[String]) -> Result<(), String> {
    if let Some(name) = names.iter().find(|name| model["nets"].get(name.as_str()).is_none()) {
        return Err(format!("--net: {name} is not on the board"));
    }
    model["route_nets"] = names.into();
    Ok(())
}

/// --route-crystals: the critical nets the core routes first, those on the board.
fn set_critical_nets(model: &mut Value, names: &[String]) {
    let on_board: Vec<String> = names.iter().filter(|name| model["nets"].get(name.as_str()).is_some()).cloned().collect();
    model["critical_nets"] = on_board.into();
}

/// What the caller narrows of a route, written into the model before its hash is recorded.
fn narrow_model(path: &Path, a: &Args, critical: &[String]) -> Result<(), String> {
    if a.plane_nets.is_empty() && a.layers.is_empty() && a.nets.is_empty() && critical.is_empty() {
        return Ok(());
    }
    let text = fs::read_to_string(path).map_err(|e| format!("{}: {e}", path.display()))?;
    let mut model: Value = serde_json::from_str(&text).map_err(|e| format!("{}: {e}", path.display()))?;
    set_plane_nets(&mut model, &a.plane_nets)?;
    if !a.layers.is_empty() {
        set_layers(&mut model, &a.layers)?;
    }
    if !a.nets.is_empty() {
        set_route_nets(&mut model, &a.nets)?;
    }
    if !critical.is_empty() {
        set_critical_nets(&mut model, critical);
    }
    fs::write(path, model.to_string()).map_err(|e| format!("{}: {e}", path.display()))
}

fn prepare<'a>(a: &'a Args, rec: &mut Record, out: &Path, work: &Path) -> Result<Run<'a>, String> {
    if out.extension().and_then(|e| e.to_str()) != Some("kicad_pcb") {
        return Err("OUT must end in .kicad_pcb".to_string());
    }
    if work.exists() || out.exists() {
        rec.work = None; // not ours: never write into it
        return Err(format!("OUT and its work folder must be new: {}", work.display()));
    }
    fs::create_dir_all(work).map_err(|e| format!("{}: {e}", work.display()))?;
    let root = std::path::absolute(&a.tools).map_err(|e| e.to_string())?;
    let (folder, project) = board_project(&a.board, root.parent().unwrap_or(Path::new(".")))?;
    let src = match &a.pcb {
        Some(p) => absolute(p)?,
        None => project.with_extension("kicad_pcb"),
    };
    rec.board = folder.file_name().map(|n| n.to_string_lossy().into_owned());
    (rec.input, rec.input_sha256, rec.iters, rec.seed) = (Some(src.display().to_string()), Some(sha_file(&src)?), Some(a.iters), a.seed);

    let steps = Steps::new(&a.tools)?;
    rec.stages.binary = Some(BinaryStage { path: steps.exe.display().to_string(), how: "self", sources_sha256: sources_sha(&a.tools), sha256: sha_file(&steps.exe)? });

    let mut route_in = src.clone();
    if let Some(lock_from) = &a.lock_from {
        let (copy, stage) = lock_step(&steps, &folder, &src, work, lock_from, a.route_crystals)?;
        route_in = copy;
        rec.stages.lock = Some(stage);
    }
    guard::preflight(&route_in, &work.join("preflight.json"))?;
    let model = work.join("model.json");
    let text = steps.admit(&folder, &route_in, &model, &work.join("model.log"), a.return_exempt)?;
    let critical = rec.stages.lock.as_ref().map_or(Vec::new(), |l| l.critical.clone());
    narrow_model(&model, a, &critical)?;
    rec.stages.model = Some(ModelStage { line: text.trim().lines().last().unwrap_or("").to_string(), sha256: sha_file(&model)? });

    let widths = widths::board_widths(&folder, &model)?;
    let route_in_sha256 = sha_file(&route_in)?;
    Ok(Run { a, steps, model, route_in, route_in_sha256, src, folder, widths })
}

fn run(a: &Args, rec: &mut Record, out: &Path, work: &Path) -> Result<(), String> {
    let context = prepare(a, rec, out, work)?;
    let (diagnose_in, diagnose_model) = (context.route_in.clone(), context.model.clone());
    let (stages, restored) = match &a.reuse {
        Some(previous) => context.reuse_attempts(previous, out, work, rec)?,
        None => context.attempt(out, work, &[])?,
    };
    (rec.stages.core, rec.stages.write) = (Some(stages.core), Some(stages.write));
    rec.pro_restored = Some(restored);
    if a.reuse.is_none() {
        rec.stages.ref_gate = Some(context.ref_gate(out, work)?);
    }
    let drc = finish(rec, out, work)?;
    if a.diagnose && drc.unconnected > 0 {
        rec.diagnosis = Some(diagnose::diagnose(&diagnose_in, out, work, &diagnose_model));
    }
    if !drc.clean() {
        let previous = a.reuse.as_ref().map(|prev| PathBuf::from(format!("{prev}.iotroute/stuck.json"))).filter(|path| path.is_file());
        let line = crate::stuck::write(work, rec.board.as_deref().unwrap_or(""), previous.as_deref()).map_or_else(|error| format!("STUCK failed: {error}"), |report| report.line());
        if a.diagnose {
            rec.diagnosis.get_or_insert_default().push(line);
        }
    }
    Ok(())
}

/// The record with sorted keys, as the JSON line.
fn sorted_json(rec: &Record) -> Result<String, String> {
    let value = serde_json::to_value(rec).map_err(|e| e.to_string())?;
    let sorted: BTreeMap<String, serde_json::Value> = serde_json::from_value(value).map_err(|e| e.to_string())?;
    serde_json::to_string(&sorted).map_err(|e| e.to_string())
}

pub fn cli(args: &[String]) -> i32 {
    let a = match parse_args(args) {
        Ok(a) => a,
        Err(e) => {
            eprintln!("{USAGE}\n{e}");
            return 2;
        }
    };
    let start = Instant::now();
    let out = absolute(&a.out).unwrap_or_else(|_| PathBuf::from(&a.out));
    let work = PathBuf::from(format!("{}.iotroute", out.display()));
    let mut rec = Record::new(out.display().to_string(), work.display().to_string());
    let code = match run(&a, &mut rec, &out, &work) {
        Ok(()) => i32::from(rec.status != "PASS"),
        Err(e) => {
            rec.status = "ERROR";
            rec.cause = Some(e);
            2
        }
    };
    rec.seconds = Some(crate::model::text::round_to(start.elapsed().as_secs_f64(), 1));
    if rec.work.is_some() && work.is_dir() {
        let text = serde_json::to_string_pretty(&rec).unwrap_or_default();
        let _ = fs::write(work.join("result.json"), text);
    }
    // A reader that went away is no reason to lose the exit code.
    let mut stdout = std::io::stdout();
    let _ = writeln!(stdout, "{}", rec.summary_line());
    if a.json
        && let Ok(line) = sorted_json(&rec)
    {
        let _ = writeln!(stdout, "{line}");
    }
    code
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn feedback_reuse_is_opt_in_and_does_not_silently_combine_with_public_reuse() {
        let args = |s: &str| parse_args(&s.split_whitespace().map(str::to_string).collect::<Vec<_>>());
        let baseline = args("BOARD out.kicad_pcb").unwrap(); assert!(!baseline.ref_reuse);
        assert!(args("BOARD out.kicad_pcb --ref-reuse").unwrap().ref_reuse);
        assert!(args("BOARD out.kicad_pcb --ref-reuse --reuse old.kicad_pcb").unwrap_err().contains("cannot combine"));
        let mut old_manifest = serde_json::to_value(&baseline).unwrap(); old_manifest.as_object_mut().unwrap().remove("ref_reuse");
        assert!(!serde_json::from_value::<Args>(old_manifest).unwrap().ref_reuse);
    }

    #[test]
    fn a_scoped_feedback_result_requires_core_native_and_planes_to_pass() {
        let claim = record::RouteClaim { status: "PASS".into(), converged: true, iters: 1, tracks: 1, vias: 0, failed: 0, stop: None };
        let stages = AttemptStages { core: CoreStage { exit: 0, seconds: 1.0, claim: Some(claim) }, write: record::WriteStage { exit: 0, line: String::new() } };
        assert!(scoped_feedback_passes(&stages, &DrcCounts::default(), 0));
        assert!(!scoped_feedback_passes(&stages, &DrcCounts::default(), 1));
        for drc in [DrcCounts { errors: 1, ..Default::default() }, DrcCounts { unconnected: 1, ..Default::default() }, DrcCounts { parity: 1, ..Default::default() }] {
            assert!(!scoped_feedback_passes(&stages, &drc, 0));
        }
        for changed in 0..5 {
            let mut trial = stages.clone();
            match changed {
                0 => trial.core.exit = 1,
                1 => trial.write.exit = 1,
                2 => trial.core.claim.as_mut().unwrap().failed = 1,
                3 => trial.core.claim.as_mut().unwrap().converged = false,
                _ => trial.core.claim = None,
            }
            assert!(!scoped_feedback_passes(&trial, &DrcCounts::default(), 0));
        }
    }

    #[cfg(unix)]
    #[test]
    fn feedback_selects_only_verified_scoped_copper_and_executes_full_fallback() {
        use std::os::unix::fs::PermissionsExt;
        struct Temp(PathBuf);
        impl Drop for Temp { fn drop(&mut self) { let _ = fs::remove_dir_all(&self.0); } }
        let root = Temp(std::env::temp_dir().join(format!("iotroute-feedback-control-{}", std::process::id())));
        fs::create_dir_all(&root.0).unwrap();
        let backend = root.0.join("backend.sh");
        fs::write(&backend, r##"#!/bin/sh
set -eu
mode=$(cat "$(dirname "$0")/mode")
case "$1" in
  write)
    mkdir -p "$4"
    printf '(kicad_pcb)\n' > "$4/input.kicad_pcb"
    echo 'WRITE PASS drc 0 {} unconnected 0 parity 0'
    ;;
  si-planes)
    case "$2" in */scoped/*)
      if [ "$mode" = planes ]; then echo 'FAIL unknown-driver F.Cu A: crossing'; exit 1; fi
      if [ "$mode" = plane-error ]; then echo 'ERROR no checker result'; exit 2; fi
    esac
    echo '0 reference-plane failures'
    ;;
  *)
    kind=FULL
    case "$2" in */scoped/*)
      kind=SCOPED
      if [ "$mode" = core-error ]; then echo 'core crashed'; exit 2; fi
    esac
    echo "$kind"
    printf '{"schema":"iot-lab.route-result.v0","passes":1,"tracks":[],"vias":[],"failed":[]}' > "$2"
    echo 'ROUTE PASS converged true iters 1 tracks 0 vias 0 failed 0 notes 0 0 s -> route.json'
    ;;
esac
"##).unwrap();
        fs::set_permissions(&backend, fs::Permissions::from_mode(0o700)).unwrap();
        let input = root.0.join("input.kicad_pcb"); fs::write(&input, "(kicad_pcb)").unwrap();
        fs::write(root.0.join("input.kicad_pro"), "{}").unwrap();
        let previous = root.0.join("previous.kicad_pcb"); fs::write(&previous, "(kicad_pcb)").unwrap();
        let route = root.0.join("previous-route.json");
        fs::write(&route, r#"{"schema":"iot-lab.route-result.v0","passes":15,"tracks":[],"vias":[],"failed":[]}"#).unwrap();
        let before = r#"{"schema":"iot-lab.route-model.v0","pcb":"input.kicad_pcb","nets":{"A":{"ref_soft":true,"ref_cost":3.0}}}"#;
        let model = root.0.join("model.json");
        let a = parse_args(&["BOARD".into(), "out.kicad_pcb".into(), "--ref-reuse".into()]).unwrap();
        let mut steps = Steps::new(&root.0).unwrap(); steps.exe = backend;
        let mut context = Run { a: &a, steps, model: model.clone(), route_in: input.clone(), route_in_sha256: sha_file(&input).unwrap(),
            src: input, folder: root.0.clone(), widths: Vec::new() };
        for mode in ["pass", "native", "planes", "plane-error", "core-error", "invalidate", "width-rewrite"] {
            context.widths = if mode == "width-rewrite" { vec![crate::plan::WidthRule { name: "region".into(), bounds: [0.0, 0.0, 1.0, 1.0], layers: vec!["F.Cu".into()], width_mm: 0.15 }] } else { Vec::new() };
            fs::write(root.0.join("mode"), mode).unwrap();
            let after = before.replace("3.0", "30.0");
            fs::write(&model, if mode == "invalidate" { after.replace("\"nets\":", "\"new_rule\":true,\"nets\":") } else { after }).unwrap();
            let work = root.0.join(mode); fs::create_dir_all(&work).unwrap();
            let (_, evidence) = context.feedback_attempt_using(&previous, &route, &work.join("out.kicad_pcb"), &work, before.as_bytes(), &["A".into()], Path::new("spec"),
                |board, _| Ok(DrcCounts { unconnected: usize::from(mode == "native" && board.parent().unwrap().ends_with("scoped")), ..Default::default() })).unwrap();
            assert_eq!(evidence.status, "complete"); assert!(evidence.elapsed_s.unwrap() > 0.0);
            let selected = if mode == "pass" { "scoped" } else { "full" };
            assert_eq!(evidence.selected, selected, "{mode}");
            assert_eq!(work.join("full").exists(), mode != "pass", "full fallback {mode}");
            assert!(fs::read_to_string(work.join("route.log")).unwrap().contains(if mode == "pass" { "SCOPED" } else { "FULL" }));
            assert_eq!(evidence.fallback_reason.is_some(), mode != "pass");
            if mode == "native" { assert_eq!(evidence.record.as_ref().unwrap().attempts["scoped"].unconnected, Some(1)); }
            if mode == "planes" { assert_eq!(evidence.scoped_planes_fail_lines, Some(1)); }
            if matches!(mode, "invalidate" | "width-rewrite") { assert!(evidence.record.is_none() && evidence.binding.is_none()); }
        }
        // A changed native input is not a failed search: refuse it before either path runs.
        fs::write(&context.route_in, "changed input").unwrap();
        let work = root.0.join("stale"); fs::create_dir_all(&work).unwrap();
        assert!(context.feedback_attempt_using(&previous, &route, &work.join("out.kicad_pcb"), &work, before.as_bytes(), &["A".into()], Path::new("spec"), |_, _| unreachable!()).unwrap_err().contains("input changed"));
        assert!(!work.join("full").exists() && !work.join("scoped").exists());
    }

    fn args(text: &str) -> Result<Args, String> {
        parse_args(&text.split_whitespace().map(str::to_string).collect::<Vec<_>>())
    }

    #[test]
    fn options_keep_their_defaults_until_given() {
        let a = args("NET-CORE o.kicad_pcb").unwrap();
        assert_eq!((a.iters, a.reuse.clone(), a.reuse_fallback.as_str(), a.json), (80, None, "full", false));
        let a = args("NET-CORE o.kicad_pcb --reuse p.kicad_pcb --seed 0 --stall-passes 12 --checkpoint --json --max-time 1.5").unwrap();
        assert_eq!((a.reuse.as_deref(), a.seed, a.stall_passes, a.checkpoint, a.max_time), (Some("p.kicad_pcb"), Some(0), Some(12), true, Some(1.5)));
    }

    #[test]
    fn what_a_caller_narrows_reaches_the_model_or_is_refused_by_name() {
        let names = |list: &[&str]| list.iter().map(|n| n.to_string()).collect::<Vec<_>>();
        let board = || serde_json::json!({"copper_layers": ["F.Cu", "In1.Cu", "B.Cu"], "nets": {
            "GND": {"plane": false, "layers": ["F.Cu", "In1.Cu", "B.Cu"], "plane_polys": [[[0, 0], [1, 0], [1, 1]]]},
            "A": {"plane": false, "layers": ["In1.Cu"]}, "NC": {"plane": false, "layers": []}}});
        let a = args("A B --plane-net GND --layer F.Cu --layer B.Cu --net /X --net GND").unwrap();
        assert_eq!((a.plane_nets, a.layers, a.nets), (names(&["GND"]), names(&["F.Cu", "B.Cu"]), names(&["/X", "GND"])));

        let mut model = board();
        set_plane_nets(&mut model, &names(&["GND"])).unwrap();
        assert_eq!((&model["nets"]["GND"]["plane"], &model["nets"]["A"]["plane"]), (&true.into(), &false.into()));
        assert!(set_plane_nets(&mut model, &names(&["A"])).unwrap_err().contains("A has no pour"));
        assert!(set_plane_nets(&mut model, &names(&["Z"])).unwrap_err().contains("Z is not on the board"));

        let mut model = board();
        set_layers(&mut model, &names(&["In1.Cu", "B.Cu"])).unwrap();
        assert_eq!(model["nets"]["GND"]["layers"], serde_json::json!(["In1.Cu", "B.Cu"]));
        assert!(set_layers(&mut board(), &names(&["F.Cu"])).unwrap_err().contains("net A may use none"));
        assert!(set_layers(&mut board(), &names(&["In3.Cu"])).unwrap_err().contains("In3.Cu is not a copper layer"));

        let mut model = board();
        set_route_nets(&mut model, &names(&["A"])).unwrap();
        assert_eq!(model["route_nets"], serde_json::json!(["A"]));
        assert!(set_route_nets(&mut model, &names(&["Z"])).unwrap_err().contains("Z is not on the board"));
    }

    #[test]
    fn route_crystals_is_opt_in_needs_lock_from_and_names_the_critical_nets() {
        assert!(!args("A B.kicad_pcb --lock-from S").unwrap().route_crystals);
        assert!(args("A B.kicad_pcb --lock-from S --route-crystals").unwrap().route_crystals);
        assert!(args("A B.kicad_pcb --route-crystals").unwrap_err().contains("needs --lock-from"));
        let off = serde_json::to_value(args("A B.kicad_pcb").unwrap()).unwrap();
        assert!(off.get("route_crystals").is_none(), "off: the recorded arguments are unchanged");
        let mut model = serde_json::json!({"nets": {"/OSC_IN": {}, "/OSC_OUT": {}}});
        set_critical_nets(&mut model, &["/OSC_IN".to_string(), "/GONE".to_string(), "/OSC_OUT".to_string()]);
        assert_eq!(model["critical_nets"], serde_json::json!(["/OSC_IN", "/OSC_OUT"]));
    }

    #[test]
    fn a_bad_call_is_refused() {
        assert!(args("ONLY").is_err());
        assert!(args("A B --nope").is_err());
        assert!(args("A B --reuse-fallback maybe").is_err());
    }

    #[test]
    fn an_existing_out_is_refused_and_not_written() {
        let dir = std::env::temp_dir().join(format!("iotroute-run-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        let out = dir.join("X.kicad_pcb");
        fs::write(&out, "keep").unwrap();
        let work = dir.join("X.kicad_pcb.iotroute");
        let a = args(&format!("NET-CORE {}", out.display())).unwrap();
        let mut rec = Record::new(out.display().to_string(), work.display().to_string());
        assert!(run(&a, &mut rec, &out, &work).is_err());
        assert_eq!(rec.work, None);
        assert_eq!(fs::read_to_string(&out).unwrap(), "keep");
        assert!(!work.exists());
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn the_record_line_has_sorted_keys() {
        let rec = Record::new("o".to_string(), "w".to_string());
        let line = sorted_json(&rec).unwrap();
        assert!(line.find("\"board_file\"").unwrap() < line.find("\"schema\"").unwrap());
    }
}
