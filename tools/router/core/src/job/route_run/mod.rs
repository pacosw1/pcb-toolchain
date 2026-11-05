//! `iotroute route BOARD OUTDIR [--input PLACED.kicad_pcb] [--config route.json] [--backend fastroute|tracemaker]`: route a board
//! from `<board>/route.json` (schema in `crate::plan`). Runs from the repo root, or with IOT_LAB set.
//!
//! Each stage: copy the board, remove the stage's zones, add its keepouts, route (Fastroute: `iotroute fastroute`, or the command in
//! IOTROUTE_FASTROUTE_CMD; TraceMaker: $TRACEMAKER_BIN, then only the new copper of the stage nets is kept), remove the keepouts,
//! put the zones back, and check the stage nets with kicad-cli DRC. The copper of a stage is locked for the next stage (both routers
//! keep existing copper). Then the widths rules and the pours go in, KiCad 10 fills, and kicad-cli DRC with --schematic-parity runs.
//! Result: OUTDIR/<BOARD>.kicad_pcb with its sidecars, and OUTDIR/result.json. The input board is only read.
//! Exit 0 only when every stage check passes and DRC reports 0 errors, 0 unconnected and 0 parity. 2 is a bad command line.
pub mod board_edit;
pub mod report;
#[cfg(test)]
mod tests;

use crate::kicad::api::{Server, read_board};
use crate::kicad::board::Board;
use crate::kicad::edit::Edit;
use crate::kicad::kicad_cli;
use crate::kicad::save::{WorkDir, put_in_place, save_refilled};
use crate::plan::{self, Backend, Plan, Stage, add_blocks, copy_block, open_nets, split_zones};
use crate::route_features::{defaults_path, root};
use crate::sha256::sha256;
use crate::tool_args::Args;
use board_edit::{TMP, keepout_area, keepout_zone, pour_area, pour_zone, set_widths};
use report::Json;
use serde_json::Value;
use std::collections::{BTreeSet, HashSet};
use std::fs;
use std::os::unix::process::ExitStatusExt;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

const USAGE: &str = "usage: iotroute route BOARD OUTDIR [--input PLACED.kicad_pcb] [--config route.json] [--backend fastroute|tracemaker]";
const SIDECARS: [&str; 3] = ["kicad_pro", "kicad_dru", "kicad_sch"];
/// The Fastroute job's exit for connections left open: the stage check decides.
const STUCK_RC: i32 = 3;
/// The stage router instead of `iotroute fastroute`: a command line split at spaces, before BOARD OUTDIR.
const FASTROUTE_COMMAND: &str = "IOTROUTE_FASTROUTE_CMD";

#[derive(Debug, PartialEq, Eq)]
struct Options {
    board: String,
    outdir: String,
    input: Option<String>,
    config: String,
    backend: Option<Backend>,
}

impl Options {
    /// None asks for the usage text.
    fn parse(args: &[String]) -> Result<Option<Options>, String> {
        let mut args = Args::new(args.iter().cloned());
        let (mut paths, mut input, mut config, mut backend) = (Vec::new(), None, "route.json".to_string(), None);
        while let Some(arg) = args.next() {
            match arg.as_str() {
                "-h" | "--help" => return Ok(None),
                "--input" => input = Some(args.value("--input")?),
                "--config" => config = args.value("--config")?,
                "--backend" => {
                    backend = Some(match args.value("--backend")?.as_str() {
                        "fastroute" => Backend::Fastroute,
                        "tracemaker" => Backend::Tracemaker,
                        other => return Err(format!("--backend: invalid choice: {other}")),
                    })
                }
                option if option.starts_with('-') && option != "-" => return Err(format!("unrecognized argument: {option}")),
                _ => paths.push(arg),
            }
        }
        let [board, outdir] = <[String; 2]>::try_from(paths).map_err(|_| "BOARD and OUTDIR are required".to_string())?;
        Ok(Some(Options { board, outdir, input, config, backend }))
    }
}

pub fn cli(args: &[String]) -> i32 {
    match Options::parse(args) {
        Ok(None) => {
            println!("{USAGE}");
            0
        }
        Err(e) => {
            eprintln!("{USAGE}\niotroute route: error: {e}");
            2
        }
        Ok(Some(options)) => route(&options).unwrap_or_else(|e| {
            eprintln!("{e}");
            1
        }),
    }
}

fn read_text(path: &Path) -> Result<String, String> {
    fs::read_to_string(path).map_err(|e| format!("{}: {e}", path.display()))
}

fn write_text(path: &Path, text: &str) -> Result<(), String> {
    fs::write(path, text).map_err(|e| format!("{}: {e}", path.display()))
}

fn copy_file(from: &Path, to: &Path) -> Result<(), String> {
    fs::copy(from, to).map(|_| ()).map_err(|e| format!("{}: {e}", from.display()))
}

/// The board through the KiCad API. The stopped server leaves its project lock, which is no part of a run's folders.
fn read_api(path: &Path) -> Result<Board, String> {
    let board = {
        let (_server, mut client) = Server::start(path)?;
        read_board(&mut client, path).map_err(|e| e.to_string())?
    };
    let stem = path.file_stem().and_then(|s| s.to_str()).ok_or("a board file has a name")?;
    let _ = fs::remove_file(path.with_file_name(format!("~{stem}.kicad_pro.lck")));
    Ok(board)
}

/// The folder of a board ID and its project, without extension and with links followed. Only gate.json counts, and the project must
/// lie under hardware-design/boards.
fn board_config(root: &Path, board: &str) -> Result<(PathBuf, PathBuf), String> {
    let mut chars = board.chars();
    let upper = |c: char| c.is_ascii_uppercase() || c.is_ascii_digit();
    if !chars.next().is_some_and(upper) || !chars.all(|c| upper(c) || c == '-') {
        return Err("invalid board ID".to_string());
    }
    let boards = root.join("hardware-design/boards");
    let folder = boards.join(board);
    let gate = folder.join("gate.json");
    let config: Value = serde_json::from_str(&read_text(&gate)?).map_err(|e| format!("{}: {e}", gate.display()))?;
    let project = config["project"].as_str().filter(|p| !p.is_empty()).ok_or("gate configuration requires a project")?;
    let project = folder.join(project);
    let parent = project.parent().ok_or("the project has no folder")?;
    let name = project.file_name().ok_or("the project has no name")?;
    let real = |path: &Path| fs::canonicalize(path).map_err(|e| format!("{}: {e}", path.display()));
    let project = real(parent)?.join(name);
    if !project.starts_with(real(&boards)?) {
        return Err("project escapes the board registry tree".to_string());
    }
    Ok((folder, project))
}

/// Copies a board and the sidecars of `sidecars_of` (default: of `src`) next to `dst`.
fn copy_project(src: &Path, dst: &Path, sidecars_of: Option<&Path>) -> Result<(), String> {
    let folder = dst.parent().ok_or("a board file has a folder")?;
    fs::create_dir_all(folder).map_err(|e| format!("{}: {e}", folder.display()))?;
    copy_file(src, dst)?;
    let base = sidecars_of.unwrap_or(src);
    for extension in SIDECARS {
        let side = base.with_extension(extension);
        if side.is_file() {
            copy_file(&side, &dst.with_extension(extension))?;
        }
    }
    Ok(())
}

/// Runs a command to its end; `log` gets the command line, stdout and stderr. The exit code; a signal counts as its negative.
fn run(command: &[String], log: &Path, env: &[(&str, &str)]) -> Result<i32, String> {
    let (program, args) = command.split_first().ok_or("an empty command")?;
    let done = Command::new(program).args(args).envs(env.iter().copied()).stdin(Stdio::null()).output().map_err(|e| format!("{program}: {e}"))?;
    let text = format!("{}\n{}{}", command.join(" "), String::from_utf8_lossy(&done.stdout), String::from_utf8_lossy(&done.stderr));
    write_text(log, &text)?;
    Ok(done.status.code().unwrap_or_else(|| -done.status.signal().unwrap_or(0)))
}

/// kicad-cli DRC with fresh fills: the report as JSON, also in `out`.
fn drc(pcb: &Path, out: &Path, parity: bool) -> Result<Value, String> {
    let mut command = vec![kicad_cli(), "pcb".to_string(), "drc".to_string()];
    if parity {
        command.push("--schematic-parity".to_string());
    }
    command.extend(["--refill-zones", "--severity-all", "--format", "json", "--units", "mm", "-o"].map(str::to_string));
    command.extend([out.display().to_string(), pcb.display().to_string()]);
    run(&command, Path::new(&format!("{}.log", out.display())), &[])?;
    if !out.is_file() {
        return Err(format!("route: kicad-cli DRC wrote no report for {}", pcb.display()));
    }
    serde_json::from_str(&read_text(out)?).map_err(|e| format!("{}: {e}", out.display()))
}

/// The command before BOARD OUTDIR.
fn fastroute_command() -> Result<Vec<String>, String> {
    match std::env::var(FASTROUTE_COMMAND) {
        Ok(line) if !line.trim().is_empty() => Ok(line.split_whitespace().map(str::to_string).collect()),
        _ => {
            let exe = std::env::current_exe().map_err(|e| format!("this executable: {e}"))?;
            Ok(vec![exe.display().to_string(), "fastroute".to_string()])
        }
    }
}

fn tracemaker_binary() -> String {
    std::env::var("TRACEMAKER_BIN").ok().filter(|b| !b.is_empty()).unwrap_or_else(|| {
        format!("{}/opt/tracemaker/build/macos-metal/src/app/tracemaker", std::env::var("HOME").unwrap_or_default())
    })
}

/// A stage router's board. Exit 3 means connections left open: the stage check decides. Any other failure stops the run.
fn route_fastroute(stage: &Stage, src: &Path, work: &Path, board_id: &str, features: &str) -> Result<PathBuf, String> {
    let folder = work.parent().ok_or("a work folder has a parent")?;
    let mut command = fastroute_command()?;
    command.extend([src.display().to_string(), work.display().to_string()]);
    command.extend(stage.fastroute_args());
    let code = run(&command, &folder.join("router.log"), &[("ROUTE_BOARD", board_id), ("ROUTE_FEATURES", features)])?;
    let routed = work.join("routed.kicad_pcb");
    if (code != 0 && code != STUCK_RC) || !routed.is_file() {
        return Err(format!("route: stage {}: fastroute_job exit {code}, see {}/router.log", stage.name, folder.display()));
    }
    Ok(routed)
}

/// TraceMaker exits non-zero when connections stay open; the stage check decides.
fn route_tracemaker(stage: &Stage, src: &Path, work: &Path, copper: &[String]) -> Result<PathBuf, String> {
    let binary = tracemaker_binary();
    if !Path::new(&binary).is_file() {
        return Err(format!("route: TraceMaker binary not found: {binary} (set TRACEMAKER_BIN)"));
    }
    fs::create_dir_all(work).map_err(|e| format!("{}: {e}", work.display()))?;
    let routed = work.join("routed.kicad_pcb");
    let (source, output, summary) = (src.display().to_string(), routed.display().to_string(), work.join("summary.json").display().to_string());
    let folder = work.parent().ok_or("a work folder has a parent")?;
    let code = run(&stage.tracemaker_args(copper, &binary, &source, &output, &summary), &folder.join("router.log"), &[])?;
    if !routed.is_file() {
        return Err(format!("route: stage {}: TraceMaker exit {code}, no board written", stage.name));
    }
    Ok(routed)
}

fn vias_on(board: &Board, nets: &BTreeSet<&str>) -> i64 {
    board.vias().filter(|v| nets.contains(v.net.as_str())).count() as i64
}

fn copper_ids(board: &Board) -> HashSet<&str> {
    board.tracks().map(|t| t.id.as_str()).chain(board.vias().map(|v| v.id.as_str())).collect()
}

/// The routed text without the stage's keepouts, which `routed` names.
fn without_keepouts(text: &str, routed: &Board) -> Result<String, String> {
    let names: BTreeSet<&str> = routed.zones.iter().map(|z| z.name.as_str()).filter(|n| n.starts_with(TMP)).collect();
    let names: Vec<String> = names.into_iter().map(str::to_string).collect();
    Ok(split_zones(text, &names)?.0)
}

/// Takes out the new copper of nets the stage does not keep. The count of items taken out.
fn drop_other_nets(text: String, routed: &Board, before: &HashSet<&str>, kept: &BTreeSet<&str>, seed: &str) -> Result<(String, usize), String> {
    let tracks = routed.tracks().map(|t| (t.id.as_str(), t.net.as_str()));
    let items = tracks.chain(routed.vias().map(|v| (v.id.as_str(), v.net.as_str())));
    let removed: HashSet<String> = items.filter(|(id, net)| !before.contains(id) && !kept.contains(net)).map(|(id, _)| id.to_string()).collect();
    if let Some(id) = removed.iter().find(|id| !text.contains(id.as_str())) {
        return Err(format!("route: item {id} is not in the board text: its uuid came from the reader"));
    }
    let dropped = removed.len();
    Ok((Edit { removed, ..Edit::default() }.apply(&text, seed)?, dropped))
}

struct Job {
    outdir: PathBuf,
    /// The project name, which names the board files.
    name: String,
    board_id: String,
    backend: Backend,
    features: String,
}

impl Job {
    fn board_file(&self, folder: &Path) -> PathBuf {
        folder.join(format!("{}.kicad_pcb", self.name))
    }

    fn run_stage(&self, number: usize, stage: &Stage, current: &Path) -> Result<(PathBuf, Json, Vec<String>), String> {
        let folder = self.outdir.join(format!("{}-{}", number + 1, stage.name));
        let src = self.board_file(&folder.join("in"));
        copy_project(current, &src, None)?;
        let (text, removed) = split_zones(&read_text(current)?, &stage.remove_zones)?;
        write_text(&src, &text)?;
        let before = read_api(&src)?;
        let seed = sha256(text.as_bytes());
        let mut keepouts = Vec::new();
        for (index, keepout) in stage.keepouts.iter().enumerate() {
            keepouts.push(keepout_zone(stage, keepout, &keepout_area(before.edges_bbox, keepout)?, &seed, index));
        }
        write_text(&src, &add_blocks(&text, &keepouts)?)?;
        let nets: Vec<String> = before.nets.keys().cloned().collect();
        let kept = stage.kept_nets(&nets);
        let work = folder.join("router");
        let routed_path = match self.backend {
            Backend::Fastroute => route_fastroute(stage, &src, &work, &self.board_id, &self.features)?,
            Backend::Tracemaker => route_tracemaker(stage, &src, &work, &before.copper_layers)?,
        };
        let routed = read_api(&routed_path)?;
        let mut text = without_keepouts(&read_text(&routed_path)?, &routed)?;
        let new_vias = vias_on(&routed, &kept) - vias_on(&before, &kept); // before the removal: it drops only nets that are not kept
        let mut dropped = 0;
        if self.backend == Backend::Tracemaker {
            (text, dropped) = drop_other_nets(text, &routed, &copper_ids(&before), &stage.tracemaker_kept(&nets), &seed)?;
        }
        let out = self.board_file(&folder);
        copy_project(&routed_path, &out, Some(&src))?;
        write_text(&out, &add_blocks(&text, &removed)?)?;
        let opens = open_nets(&drc(&out, &folder.join("drc.json"), false)?)?;
        let failures = stage.failures(&opens, new_vias.max(0) as u64);
        let record = Json::object([
            ("stage", Json::text(&stage.name)),
            ("open_on_stage_nets", Json::number(opens.iter().filter(|net| kept.contains(net.as_str())).count() as u64)),
            ("open_total", Json::number(opens.len() as u64)),
            ("new_vias_on_stage_nets", Json::number(new_vias)),
            ("dropped_other_net_items", Json::number(dropped as u64)),
            ("failures", Json::texts(&failures)),
        ]);
        Ok((out, record, failures))
    }

    /// The final board: widths, pours, KiCad 10's fill, the input's stackup and sidecars, DRC with parity. The fields of result.json
    /// that come from it, and the failure when DRC is not clean.
    fn finish(&self, plan: &Plan, current: &Path, start: &Path) -> Result<(Vec<(&'static str, Json)>, Option<String>), String> {
        let out = self.board_file(&self.outdir);
        copy_project(current, &out, Some(start))?;
        let mut board = read_api(&out)?;
        let (text, widths) = set_widths(&read_text(&out)?, &mut board, &plan.widths)?;
        let seed = sha256(text.as_bytes());
        let (mut zones, mut skipped) = (Vec::new(), Vec::new());
        for (index, pour) in plan.pours.iter().enumerate() {
            match pour_area(&board, pour)? {
                Some(area) => zones.push(pour_zone(pour, &area, &seed, index)),
                None => skipped.push(pour.name.clone()), // the route put no copper of this net on this layer
            }
        }
        let text = add_blocks(&text, &zones)?;
        {
            let work = WorkDir::beside(&out, "fill")?;
            put_in_place(&save_refilled(&out, &text, &work.0)?.path, &out)?;
        }
        let input = read_text(start)?;
        if input.contains("(stackup") {
            // A save may rewrite the stackup; the input stackup is the design value.
            write_text(&out, &copy_block(&input, &read_text(&out)?, "(stackup")?)?;
        }
        for extension in SIDECARS {
            copy_file(&start.with_extension(extension), &out.with_extension(extension))?;
        }
        let report = drc(&out, &self.outdir.join("drc.json"), true)?;
        Ok(final_fields(&report, &out, widths, plan.pours.len(), &skipped)?)
    }
}

/// The result.json fields of a final DRC report, and its failure.
fn final_fields(report: &Value, out: &Path, widths: Vec<(String, u64)>, pours: usize, skipped: &[String]) -> Result<(Vec<(&'static str, Json)>, Option<String>), String> {
    let empty = Vec::new();
    let violations = report["violations"].as_array().unwrap_or(&empty);
    let errors: Vec<&Value> = violations.iter().filter(|v| v["severity"] == "error").collect();
    let types: BTreeSet<&str> = errors.iter().map(|v| v["type"].as_str().ok_or("a DRC violation without a type")).collect::<Result<_, _>>()?;
    let unconnected = open_nets(report)?.len();
    let parity = report["schematic_parity"].as_array().map_or(0, Vec::len);
    let widths = widths.into_iter().map(|(name, count)| (name, Json::number(count))).collect();
    let fields = vec![
        ("widths", Json::Object(widths)),
        ("board_file", Json::text(&out.display().to_string())),
        ("pours", Json::number((pours - skipped.len()) as u64)),
        ("skipped_pours", Json::texts(skipped)),
        ("drc_errors", Json::number(errors.len() as u64)),
        ("unconnected", Json::number(unconnected as u64)),
        ("parity", Json::number(parity as u64)),
        ("error_types", Json::texts(&types.into_iter().collect::<Vec<_>>())),
    ];
    let clean = errors.is_empty() && unconnected == 0 && parity == 0;
    Ok((fields, (!clean).then(|| format!("final DRC: {} errors, {unconnected} unconnected, {parity} parity", errors.len()))))
}

fn known_features() -> Result<BTreeSet<String>, String> {
    let path = defaults_path();
    let file: Value = serde_json::from_str(&read_text(&path)?).map_err(|e| format!("{}: {e}", path.display()))?;
    let features = file["features"].as_object().ok_or_else(|| format!("{}: no features", path.display()))?;
    Ok(features.keys().cloned().collect())
}

/// An empty or missing folder, created, with links followed.
fn empty_outdir(outdir: &str) -> Result<PathBuf, String> {
    let given = Path::new(outdir);
    let real = |path: &Path| fs::canonicalize(path).map_err(|e| format!("{}: {e}", path.display()));
    if given.exists() && fs::read_dir(given).map_err(|e| format!("{outdir}: {e}"))?.next().is_some() {
        return Err(format!("route: {} is not empty", real(given)?.display()));
    }
    fs::create_dir_all(given).map_err(|e| format!("{outdir}: {e}"))?;
    real(given)
}

fn route(options: &Options) -> Result<i32, String> {
    let (folder, project) = board_config(&root(), &options.board)?;
    let project_board = project.with_extension("kicad_pcb");
    let source = match &options.input {
        Some(input) => fs::canonicalize(input).map_err(|e| format!("{input}: {e}"))?,
        None => project_board.clone(),
    };
    let config_path = folder.join(&options.config);
    let config: Value = serde_json::from_str(&read_text(&config_path)?).map_err(|e| format!("{}: {e}", config_path.display()))?;
    let outdir = empty_outdir(&options.outdir)?;
    let name = project.file_name().and_then(|n| n.to_str()).ok_or("the project has no name")?.to_string();
    let start = outdir.join("input").join(format!("{name}.kicad_pcb"));
    copy_project(&source, &start, Some(&project_board))?;
    let plan = plan::load(&config, &read_api(&start)?.copper_layers, Some(&known_features()?))?;
    let backend = options.backend.unwrap_or(plan.backend);
    if !plan.features.is_empty() && backend != Backend::Fastroute {
        return Err("route: features are Fastroute switches; the tracemaker backend cannot apply them".to_string());
    }
    let job = Job { outdir: outdir.clone(), name, board_id: options.board.clone(), backend, features: plan.feature_env() };
    let (mut current, mut stages, mut failures) = (start.clone(), Vec::new(), Vec::new());
    for (number, stage) in plan.stages.iter().enumerate() {
        let (out, record, stage_failures) = job.run_stage(number, stage, &current)?;
        println!("{}", record.line());
        current = out;
        stages.push(record);
        failures.extend(stage_failures);
        if !failures.is_empty() {
            break;
        }
    }
    let backend_name = if backend == Backend::Fastroute { "fastroute" } else { "tracemaker" };
    let mut fields = vec![
        ("board", Json::text(&options.board)),
        ("backend", Json::text(backend_name)),
        ("source", Json::text(&source.display().to_string())),
        ("stages", Json::List(stages)),
    ];
    if failures.is_empty() {
        let (finished, failure) = job.finish(&plan, &current, &start)?;
        fields.extend(finished);
        failures.extend(failure);
    }
    fields.push(("failures", Json::texts(&failures)));
    let result = Json::object(fields);
    write_text(&outdir.join("result.json"), &(result.indented() + "\n"))?;
    let summary = ["board", "backend", "drc_errors", "unconnected", "parity", "failures"].map(|key| (key, result.get(key)));
    println!("{}", Json::object(summary).line());
    Ok(i32::from(!failures.is_empty()))
}
