//! `iotroute board-json BOARD.kicad_pcb`: the board as versioned JSON on stdout, for tools that are not Rust or not on the host
//! with the pinned KiCad. Lengths are whole nanometres, points {x, y}, y down. The three hashes are of the file bytes: the same
//! hashes, schema and kicad_commit give the same output, so a cache can key on them.
use super::api::{PINNED_COMMIT, Server, read_board};
use super::board::Board;
use crate::sha256::sha256;
use serde::Serialize;
use std::fs;
use std::path::Path;

const SCHEMA: &str = "iot-lab.board.v1";

#[derive(Serialize)]
struct Document {
    schema: &'static str,
    kicad_commit: &'static str,
    /// The version string of the server that read the board.
    kicad: String,
    board_sha256: String,
    /// Of the .kicad_pro beside the board: net classes come from it. Empty when there is none.
    project_sha256: String,
    /// Of the .kicad_dru beside the board. Empty when there is none.
    rules_sha256: String,
    board: Board,
}

pub fn cli(args: &[String]) -> i32 {
    let [path] = args else {
        eprintln!("usage: iotroute board-json BOARD.kicad_pcb");
        return 2;
    };
    match document(Path::new(path)).and_then(|d| serde_json::to_string(&d).map_err(|e| e.to_string())) {
        Ok(json) => {
            println!("{json}");
            0
        }
        Err(e) => {
            eprintln!("{e}");
            2
        }
    }
}

fn sidecar_sha256(board: &Path, extension: &str) -> String {
    fs::read(board.with_extension(extension)).map_or(String::new(), |b| sha256(&b))
}

fn document(path: &Path) -> Result<Document, String> {
    let board_bytes = fs::read(path).map_err(|e| format!("{}: {e}", path.display()))?;
    let (_server, mut client) = Server::start(path)?;
    let kicad = client.version().map_err(|e| e.to_string())?.full_version;
    if !kicad.contains(&PINNED_COMMIT[..10]) {
        return Err(format!("the API server is {kicad}, not the pinned commit {PINNED_COMMIT}"));
    }
    let board = read_board(&mut client, path).map_err(|e| e.to_string())?;
    Ok(Document {
        schema: SCHEMA,
        kicad_commit: PINNED_COMMIT,
        kicad,
        board_sha256: sha256(&board_bytes),
        project_sha256: sidecar_sha256(path, "kicad_pro"),
        rules_sha256: sidecar_sha256(path, "kicad_dru"),
        board,
    })
}
