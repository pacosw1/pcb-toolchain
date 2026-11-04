//! The signal-integrity gates: `iotroute si-pairs` and `iotroute si-planes`. They only read a board.
pub mod drivers;
pub mod ibis;
pub mod impedance;
pub mod json;
pub mod pairs;
pub mod planes;
pub mod py;
pub mod source;

use json::Json;
use std::fs;
use std::path::{Path, PathBuf};

/// The arguments the checkers share.
struct Args {
    board: PathBuf,
    spec: PathBuf,
    board_json: Option<PathBuf>,
    dru: Option<PathBuf>,
    tools: Option<PathBuf>,
    verbose: bool,
}

fn parse_args(args: &[String]) -> Option<Args> {
    let mut paths = Vec::new();
    let (mut board_json, mut dru, mut tools, mut verbose) = (None, None, None, false);
    let mut args = args.iter();
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--board-json" => board_json = Some(PathBuf::from(args.next()?)),
            "--dru" => dru = Some(PathBuf::from(args.next()?)),
            "--tools" => tools = Some(PathBuf::from(args.next()?)),
            "--verbose" => verbose = true,
            _ if arg.starts_with("--") => return None,
            _ => paths.push(PathBuf::from(arg)),
        }
    }
    let [board, spec] = <[PathBuf; 2]>::try_from(paths).ok()?;
    Some(Args { board, spec, board_json, dru, tools, verbose })
}

fn read_text(path: &Path) -> Result<String, String> {
    let bytes = fs::read(path).map_err(|e| format!("{}: {e}", path.display()))?;
    String::from_utf8(bytes).map_err(|e| format!("{}: {e}", path.display()))
}

fn run_pairs(args: &Args) -> Result<(Vec<String>, i32), String> {
    let spec = pairs::PairSpec::read(&Json::read(&args.spec)?)?;
    let dru = args.dru.clone().unwrap_or_else(|| args.board.with_extension("kicad_dru"));
    let (text, rules) = (read_text(&args.board)?, read_text(&dru)?);
    let board = source::load(&args.board, args.board_json.as_deref())?;
    let view = pairs::pair_board(&board, &text, rules, &spec.net_names())?;
    Ok(pairs::report(&pairs::evaluate(&spec, &view)?, args.verbose))
}

/// `iotroute si-pairs BOARD.kicad_pcb SPEC.json [--dru RULES.kicad_dru] [--verbose] [--board-json FILE]`. --dru defaults to the
/// .kicad_dru next to the board. Exit 0: all PASS. 1: a FAIL. 2: tool error (bad spec, net or rule not found, stackup mismatch).
pub fn pairs_cli(args: &[String]) -> i32 {
    let Some(args) = parse_args(args) else {
        eprintln!("usage: iotroute si-pairs BOARD.kicad_pcb SPEC.json [--dru RULES.kicad_dru] [--verbose] [--board-json FILE]");
        return 2;
    };
    match run_pairs(&args) {
        Ok((lines, code)) => {
            println!("{}", lines.join("\n"));
            code
        }
        Err(error) => {
            eprintln!("si_pairs: ERROR {error}");
            2
        }
    }
}

fn run_planes(args: &Args, tools: &Path) -> Result<Vec<String>, String> {
    if !args.board.is_file() {
        return Err(format!("no board file: {}", args.board.display()));
    }
    let mut spec = planes::spec::Spec::load(&Json::read(&args.spec)?, tools)?;
    let absolute = std::path::absolute(&args.spec).map_err(|e| format!("{}: {e}", args.spec.display()))?;
    let spec_dir = absolute.parent().unwrap_or(Path::new("/"));
    spec.load_fast(spec_dir)?;
    let board = source::load(&args.board, args.board_json.as_deref())?;
    let (netlist, table) = planes::load_drivers(&spec, spec_dir, &args.board, tools)?;
    let board_text = read_text(&args.board)?;
    let outcome = planes::analyse(&board, &spec, &planes::Sources { board_text: &board_text, netlist: &netlist, table: &table }, args.verbose)?;
    let summary = format!("{} reference-plane failures", outcome.fails.len());
    Ok(outcome.fails.into_iter().chain(outcome.info).chain(outcome.detail).chain(std::iter::once(summary)).collect())
}

/// `iotroute si-planes BOARD.kicad_pcb SPEC.json --tools DIR [--verbose] [--board-json FILE]`. DIR holds edge-rates.json and
/// driver-edges.json; its parent holds their evidence. Exit 0: pass. 1: a FAIL. 2: tool error (missing board, bad spec).
pub fn planes_cli(args: &[String]) -> i32 {
    let Some((args, tools)) = parse_args(args).and_then(|a| a.tools.clone().map(|t| (a, t))) else {
        eprintln!("usage: iotroute si-planes BOARD.kicad_pcb SPEC.json --tools DIR [--verbose] [--board-json FILE]");
        return 2;
    };
    match run_planes(&args, &tools) {
        Ok(lines) => {
            println!("{}", lines.join("\n"));
            i32::from(lines.iter().any(|l| l.starts_with("FAIL ")) || !lines.last().is_some_and(|l| l.starts_with("0 ")))
        }
        Err(error) => {
            println!("ERROR {error}");
            2
        }
    }
}
