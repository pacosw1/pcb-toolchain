//! The signal-integrity gates: `iotroute si-pairs` and `iotroute si-planes`. They only read a board.
pub mod impedance;
pub mod json;
pub mod pairs;
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
    verbose: bool,
}

fn parse_args(args: &[String]) -> Option<Args> {
    let mut paths = Vec::new();
    let (mut board_json, mut dru, mut verbose) = (None, None, false);
    let mut args = args.iter();
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--board-json" => board_json = Some(PathBuf::from(args.next()?)),
            "--dru" => dru = Some(PathBuf::from(args.next()?)),
            "--verbose" => verbose = true,
            _ if arg.starts_with("--") => return None,
            _ => paths.push(PathBuf::from(arg)),
        }
    }
    let [board, spec] = <[PathBuf; 2]>::try_from(paths).ok()?;
    Some(Args { board, spec, board_json, dru, verbose })
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
