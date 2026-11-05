//! Where a checker's board comes from. On a Mac the gate fetches the JSON (tools/lib/board-json.ts); inside a job the board is
//! read here. Either way the fill is KiCad 10's: the file may hold a stale one, so a copy is refilled first.
use crate::kicad::api::{Server, read_board};
use crate::kicad::board::Board;
use serde::Deserialize;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

const MAC_KICAD_CLI: &str = "/Applications/KiCad/KiCad.app/Contents/MacOS/kicad-cli";
const SCHEMA: &str = "iot-lab.board.v1";

#[derive(Deserialize)]
struct Document {
    schema: String,
    board: Board,
}

pub fn kicad_cli() -> String {
    std::env::var("KICAD_CLI").unwrap_or_else(|_| if cfg!(target_os = "macos") { MAC_KICAD_CLI.to_string() } else { "kicad-cli".to_string() })
}

fn from_json(path: &Path) -> Result<Board, String> {
    let text = fs::read_to_string(path).map_err(|e| format!("{}: {e}", path.display()))?;
    let document: Document = serde_json::from_str(&text).map_err(|e| format!("{}: {e}", path.display()))?;
    if document.schema != SCHEMA {
        return Err(format!("{}: board JSON schema {}, this tool reads {SCHEMA}", path.display(), document.schema));
    }
    Ok(document.board)
}

/// A copy of the board with its project, zones refilled and saved by KiCad 10. The source is only read.
fn refilled_copy(board: &Path, folder: &Path) -> Result<PathBuf, String> {
    fs::create_dir_all(folder).map_err(|e| format!("{}: {e}", folder.display()))?;
    let source = board.parent().filter(|d| !d.as_os_str().is_empty()).unwrap_or(Path::new("."));
    let copy = folder.join(board.file_name().ok_or_else(|| format!("no file name in {}", board.display()))?);
    fs::copy(board, &copy).map_err(|e| format!("{}: {e}", board.display()))?;
    for name in ["kicad_pro", "kicad_dru", "kicad_sch"].map(|suffix| board.with_extension(suffix)).into_iter().chain(["sym-lib-table", "fp-lib-table"].map(|name| source.join(name))) {
        if name.exists() {
            let target = folder.join(name.file_name().expect("a joined name"));
            fs::copy(&name, target).map_err(|e| format!("{}: {e}", name.display()))?;
        }
    }
    let report = folder.join("drc.json");
    let run = Command::new(kicad_cli())
        .args(["pcb", "drc", "--refill-zones", "--save-board", "--format", "json", "--severity-error", "--output"])
        .arg(&report).arg(&copy).output().map_err(|e| format!("kicad-cli: {e}"))?;
    if !report.exists() {
        return Err(format!("kicad-cli wrote no report (exit {:?}): {}", run.status.code(), String::from_utf8_lossy(&run.stderr)));
    }
    Ok(copy)
}

fn through_api(board: &Path) -> Result<Board, String> {
    let folder = std::env::temp_dir().join(format!("si-refill-{}", std::process::id()));
    let read = refilled_copy(board, &folder).and_then(|copy| {
        let (_server, mut client) = Server::start(&copy)?;
        read_board(&mut client, &copy).map_err(|e| e.to_string())
    });
    let _ = fs::remove_dir_all(&folder);
    read
}

/// The board of a check: the JSON when one is given, else a refilled copy read through the API.
pub fn load(board: &Path, board_json: Option<&Path>) -> Result<Board, String> {
    if !board.is_file() {
        return Err(format!("no board file: {}", board.display()));
    }
    board_json.map_or_else(|| through_api(board), from_json)
}
