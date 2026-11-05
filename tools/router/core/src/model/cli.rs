//! `iotroute model BOARD_DIR [--pcb FILE] [--out FILE] [--tools DIR] [--return-exempt]`: the route model of a board.
//!
//! BOARD_DIR is hardware-design/boards/<BOARD>; gate.json or gate.pending.json names the project. The board comes through the
//! pinned KiCad's API. The fill comes from a copy that KiCad 10 refilled, read the same way: fill stays on KiCad 10. The RP-001
//! scope comes from tools/router/rpscope.py, because kicad-happy is Python and its own rules decide. Prints one line:
//! MODEL ok|FAIL nets N pads N copper N rules <state> <count> ... -> OUT. Exit 0 ok, 1 a rule is unknown, 2 no model.
use super::build::{Inputs, build, summary};
use super::files::{BoardFiles, read_pin_ratings};
use super::returns::RpScope;
use crate::kicad::{Board, kicad_cli};
use crate::kicad::api::{Server, read_board};
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

const DEFAULT_PYTHON: &str = "python3";

struct Args {
    board_dir: PathBuf,
    pcb: Option<PathBuf>,
    out: Option<PathBuf>,
    tools: PathBuf,
    return_exempt: bool,
}

fn parse_args(args: &[String]) -> Result<Args, String> {
    let usage = || "usage: iotroute model BOARD_DIR [--pcb FILE] [--out FILE] [--tools DIR] [--return-exempt]".to_string();
    let mut it = args.iter();
    let board_dir = it.next().ok_or_else(usage)?.into();
    let mut parsed = Args { board_dir, pcb: None, out: None, tools: PathBuf::from("tools"), return_exempt: false };
    while let Some(flag) = it.next() {
        let mut value = || it.next().map(PathBuf::from).ok_or_else(usage);
        match flag.as_str() {
            "--pcb" => parsed.pcb = Some(value()?),
            "--out" => parsed.out = Some(value()?),
            "--tools" => parsed.tools = value()?,
            "--return-exempt" => parsed.return_exempt = true,
            _ => return Err(usage()),
        }
    }
    Ok(parsed)
}

fn read_through_api(path: &Path) -> Result<Board, String> {
    let (_server, mut client) = Server::start(path)?;
    read_board(&mut client, path).map_err(|e| e.to_string())
}

/// A folder removed when dropped.
struct Scratch(PathBuf);

impl Scratch {
    fn new() -> Result<Scratch, String> {
        let path = std::env::temp_dir().join(format!("iotroute-model-{}", std::process::id()));
        fs::create_dir_all(&path).map_err(|e| format!("{}: {e}", path.display()))?;
        Ok(Scratch(path))
    }
}

impl Drop for Scratch {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

/// The board with its zones refilled by KiCad 10, read back through the API. The input is not touched. The fill is the same with
/// or without DRC findings, so only a missing saved file is a failure.
fn refilled(pcb: &Path, project_base: &Path) -> Result<Board, String> {
    let scratch = Scratch::new()?;
    let name = pcb.file_stem().ok_or("a board file has a name")?;
    let copy = scratch.0.join(pcb.file_name().ok_or("a board file has a name")?);
    fs::copy(pcb, &copy).map_err(|e| format!("{}: {e}", pcb.display()))?;
    for extension in ["kicad_pro", "kicad_dru"] {
        let from = project_base.with_extension(extension);
        if from.exists() {
            fs::copy(&from, scratch.0.join(name).with_extension(extension)).map_err(|e| format!("{}: {e}", from.display()))?;
        }
    }
    let before = fs::metadata(&copy).and_then(|m| m.modified()).ok();
    let report = scratch.0.join("drc.json");
    let cli = kicad_cli();
    let status = Command::new(&cli).args(["pcb", "drc", "--refill-zones", "--save-board", "--format", "json", "--output"]).arg(&report).arg(&copy).stdout(Stdio::null()).stderr(Stdio::null()).status().map_err(|e| format!("{cli}: {e}"))?;
    if !report.exists() || fs::metadata(&copy).and_then(|m| m.modified()).ok() == before {
        return Err(format!("{cli} pcb drc --refill-zones did not save the board ({status})"));
    }
    read_through_api(&copy)
}

/// The kicad-happy boundary: tools/router/rpscope.py on the project board with the net names on stdin. Env PYTHON_MODERN names the
/// interpreter; kicad-happy needs 3.10 or later.
fn rp_scope(tools: &Path, project_pcb: &Path, nets: &[&String]) -> Result<RpScope, String> {
    let python = std::env::var("PYTHON_MODERN").unwrap_or_else(|_| DEFAULT_PYTHON.to_string());
    let mut child = Command::new(&python).arg(tools.join("router/rpscope.py")).arg(project_pcb)
        .stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped()).spawn().map_err(|e| format!("{python}: {e}"))?;
    let names = serde_json::to_vec(nets).map_err(|e| e.to_string())?;
    child.stdin.take().ok_or("no stdin")?.write_all(&names).map_err(|e| e.to_string())?;
    let output = child.wait_with_output().map_err(|e| e.to_string())?;
    if !output.status.success() {
        return Err(format!("rpscope failed: {}", String::from_utf8_lossy(&output.stderr).trim()));
    }
    serde_json::from_slice(&output.stdout).map_err(|e| format!("rpscope: {e}"))
}

fn run(args: &Args) -> Result<i32, String> {
    let folder = std::path::absolute(&args.board_dir).map_err(|e| e.to_string())?;
    let files = BoardFiles::load(&folder)?;
    let project_pcb = files.project_base().with_extension("kicad_pcb");
    let pcb = match &args.pcb {
        Some(p) => std::path::absolute(p).map_err(|e| e.to_string())?,
        None => project_pcb.clone(),
    };
    let ratings = read_pin_ratings(&args.tools)?;
    let board = read_through_api(&pcb)?;
    let fresh = if files.planes.adjacent.is_empty() { None } else { Some(refilled(&pcb, &files.project_base())?) };
    let nets: Vec<&String> = board.nets.keys().filter(|n| !n.starts_with("unconnected-(")).collect();
    let scope = files.gate.checks.happy_settings().map(|_| rp_scope(&args.tools, &project_pcb, &nets)).transpose()?;
    let model = build(Inputs { board: &board, filled: fresh.as_ref().unwrap_or(&board), files: &files, ratings: &ratings, rp_scope: scope, return_exempt: args.return_exempt })?;
    let out = args.out.clone().unwrap_or_else(|| folder.join(".router/model.json"));
    if let Some(parent) = out.parent().filter(|p| !p.as_os_str().is_empty()) {
        fs::create_dir_all(parent).map_err(|e| format!("{}: {e}", parent.display()))?;
    }
    let text = serde_json::to_string_pretty(&model).map_err(|e| e.to_string())?;
    fs::write(&out, text).map_err(|e| format!("{}: {e}", out.display()))?;
    let (ok, line) = summary(&model);
    println!("{line} -> {}", out.display());
    Ok(if ok { 0 } else { 1 })
}

pub fn cli(args: &[String]) -> i32 {
    match parse_args(args).and_then(|a| run(&a)) {
        Ok(code) => code,
        Err(e) => {
            eprintln!("{e}");
            2
        }
    }
}
