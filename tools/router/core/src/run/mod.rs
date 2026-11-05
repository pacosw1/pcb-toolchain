//! `iotroute run BOARD OUT.kicad_pcb [--pcb IN.kicad_pcb] [--iters N] [--max-time S] [--lock-from SRC.kicad_pcb]
//!               [--reuse PREV.kicad_pcb [--reuse-fallback full|none]] [--seed N] [--stall-passes N] [--checkpoint]
//!               [--congestion] [--return-exempt] [--tools DIR] [--json]`
//!
//! One entry point for the in-house router: model, route, board copy, KiCad DRC (tools/router/DESIGN.md). BOARD is the board ID
//! (hardware-design/boards/<BOARD>) or that folder. The input is --pcb, else the project board; it is only read. --tools is the
//! tools folder, by default ./tools; the board ID is looked up beside it. Steps, each stopping the run at its first failure:
//!
//!  1. --lock-from SRC: a copy of the input without tracks and vias, with the copper of the lock nets from SRC, locked. Lock nets
//!     are the diff pairs and the nets with DRU via_count 0, read from the model of SRC. Without it all copper of the input stays
//!     and is locked.
//!  2. The preflight (guard.rs): KiCad DRC of what will be routed, which stops at a fault of its existing copper. Then `iotroute model`,
//!     the route, the `widths` rules of the board's route.json and `iotroute write`, whose board must keep all copper of its input.
//!  3. OUT gets the board and the project files of the input; the input's .kicad_pro goes back if a save rewrote it.
//!  4. KiCad DRC with --schematic-parity on OUT, on the saved fill.
//!
//! --reuse PREV (partial re-route, DESIGN.md 5c): the seed is PREV's route, the parts moved since and the nets PREV left open or in
//! a DRC error. --reuse-fallback full (default): when the reuse result is not PASS, the full route of the same input runs too and
//! the better one is kept; a tie keeps the full route. none: the reuse result is the result.
//!
//! The router's own counts are never the verdict; the DRC on OUT is. Output, one line:
//! PASS|FAIL <drc errors> <unconnected> <parity> <tracks> <vias> <seconds>, or ERROR <seconds> <cause> when a step did not
//! complete; with --json the record on the next line. The record is also in OUT.iotroute/result.json. Exit: 0 PASS, 1 FAIL, 2 no
//! verdict.
pub mod guard;
pub mod lock;
pub mod measure;
pub mod planes;
pub mod policy;
pub mod project;
pub mod record;
pub mod reuse;
pub mod steps;
mod widths;

use lock::{LockStage, lock_nets, make_locked_input};
use measure::{copper_counts, run_drc};
use planes::{ModelFile, RefGate, Round, ROUNDS, fail_lines, planes_spec};
use project::{board_project, place_sidecars, restore_pro, sha_file};
use record::{AttemptStages, BinaryStage, DrcCounts, ModelStage, Record};
use reuse::{Attempt, reuse_seed};
use std::collections::BTreeMap;
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::time::Instant;
use steps::{Steps, last_line, sources_sha};

const USAGE: &str = "usage: iotroute run BOARD OUT.kicad_pcb [--pcb IN] [--iters N] [--max-time S] [--lock-from SRC] [--reuse PREV] [--reuse-fallback full|none] [--congestion] [--return-exempt] [--seed N] [--stall-passes N] [--checkpoint] [--tools DIR] [--json]";

#[derive(Debug, Clone, PartialEq)]
pub struct Args {
    pub board: String,
    pub out: String,
    pub pcb: Option<String>,
    pub iters: u64,
    pub max_time: Option<f64>,
    pub lock_from: Option<String>,
    pub reuse: Option<String>,
    pub reuse_fallback: String,
    pub congestion: bool,
    pub return_exempt: bool,
    pub seed: Option<u64>,
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
        board: String::new(), out: String::new(), pcb: None, iters: 80, max_time: None, lock_from: None, reuse: None, reuse_fallback: "full".to_string(),
        congestion: std::env::var("IOTROUTE_CONGESTION").is_ok_and(|v| v == "1"), return_exempt: false, seed: None, stall_passes: None, checkpoint: false, tools: PathBuf::from("tools"), json: false,
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
            "--seed" => a.seed = Some(value(arg, it.next())?),
            "--stall-passes" => a.stall_passes = Some(value(arg, it.next())?),
            "--tools" => a.tools = PathBuf::from(value::<String>(arg, it.next())?),
            "--congestion" => a.congestion = true,
            "--return-exempt" => a.return_exempt = true,
            "--checkpoint" => a.checkpoint = true,
            "--json" => a.json = true,
            other if other.starts_with('-') => return Err(format!("{other} is not an option")),
            _ => positional.push(arg.clone()),
        }
    }
    if !matches!(a.reuse_fallback.as_str(), "full" | "none") {
        return Err("--reuse-fallback: full or none".to_string());
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
    src: PathBuf,
    folder: PathBuf,
    widths: Vec<crate::plan::WidthRule>,
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
            let mut model = ModelFile::read(&self.model)?;
            let (soft, raised, set_hard) = model.raise(&nets)?;
            rounds.push(Round { round: k + 1, planes_fail_lines: count, fail_nets: nets, raised, set_hard, next_core: None });
            if soft.is_empty() || k == ROUNDS {
                break;
            }
            model.write(&self.model)?;
            let again = work.join(format!("ref-r{}", k + 2));
            fs::create_dir_all(&again).map_err(|e| format!("{}: {e}", again.display()))?;
            let candidate = again.join(out.file_name().expect("OUT has a name"));
            let (stages, _) = self.attempt(&candidate, &again, &[])?;
            rounds.last_mut().expect("a round").next_core = Some(stages.core.claim);
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
        let mut record = reuse_seed(&absolute(previous)?, &self.route_in, &seed, &self.a.reuse_fallback)?;
        let tries: Vec<(&str, Vec<String>)> = std::iter::once(("reuse", vec!["--reuse".to_string(), seed.display().to_string()])).chain((self.a.reuse_fallback == "full").then(|| ("full", Vec::new()))).collect();
        let mut chosen: Option<&str> = None;
        for (name, extra) in &tries {
            let folder = work.join(format!("a-{name}"));
            fs::create_dir_all(&folder).map_err(|e| format!("{}: {e}", folder.display()))?;
            let candidate = folder.join(out.file_name().expect("OUT has a name"));
            let (stages, _) = self.attempt(&candidate, &folder, extra)?;
            let mut attempt = Attempt::new(stages);
            if tries.len() == 1 {
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
        let chosen = chosen.expect("at least one attempt");
        record.chosen = Some(chosen.to_string());
        let folder = work.join(format!("a-{chosen}"));
        self.copy_results(&folder, work, &["route.json", "route.log", "write.log", "congestion.json"])?;
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

fn lock_step(steps: &Steps, folder: &Path, src: &Path, work: &Path, lock_from: &str) -> Result<(PathBuf, LockStage), String> {
    let source = absolute(lock_from)?;
    let model = work.join("lock-model.json");
    let (code, text) = steps.model(folder, &source, &model, &work.join("lock-model.log"), false)?;
    if code != 0 {
        return Err(format!("iotroute model on --lock-from failed: {}", last_line(&text)));
    }
    let nets = lock_nets(&fs::read_to_string(&model).map_err(|e| format!("{}: {e}", model.display()))?)?;
    let copy = work.join("input").join(src.file_name().ok_or("a board file has a name")?);
    let (removed, kept) = make_locked_input(src, &source, &nets, &copy)?;
    let stage = LockStage { removed, kept, nets: nets.into_iter().collect(), source: source.display().to_string(), source_sha256: sha_file(&source)? };
    Ok((copy, stage))
}

fn run(a: &Args, rec: &mut Record, out: &Path, work: &Path) -> Result<(), String> {
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
        let (copy, stage) = lock_step(&steps, &folder, &src, work, lock_from)?;
        route_in = copy;
        rec.stages.lock = Some(stage);
    }
    guard::preflight(&route_in, &work.join("preflight.json"))?;
    let model = work.join("model.json");
    let text = steps.admit(&folder, &route_in, &model, &work.join("model.log"), a.return_exempt)?;
    rec.stages.model = Some(ModelStage { line: text.trim().lines().last().unwrap_or("").to_string(), sha256: sha_file(&model)? });

    let widths = widths::board_widths(&folder, &model)?;
    let context = Run { a, steps, model, route_in, src, folder, widths };
    let (stages, restored) = match &a.reuse {
        Some(previous) => context.reuse_attempts(previous, out, work, rec)?,
        None => context.attempt(out, work, &[])?,
    };
    (rec.stages.core, rec.stages.write) = (Some(stages.core), Some(stages.write));
    rec.pro_restored = Some(restored);
    if a.reuse.is_none() {
        rec.stages.ref_gate = Some(context.ref_gate(out, work)?);
    }
    finish(rec, out, work).map(|_| ())
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
