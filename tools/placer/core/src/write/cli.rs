//! `iotplace write BOARD.kicad_pcb --board-json DOC.json PROB.json POSE.json -o OUT.kicad_pcb [--outline-scale K] [--retain-copper]`
//! POSE.json is a list of [x, y, r]. One KiCad 10 kicad-cli run refills the zones and saves OUT. Prints the report as JSON.

use super::{WriteOptions, WriteProblem, write_board};
use crate::kicad::doc::load_board;
use crate::problem::Place;
use crate::read::cli::Flags;
use crate::read::project::Project;
use iotroute::kicad::save::{WorkDir, put_in_place, save_refilled};
use serde::de::DeserializeOwned;
use std::path::Path;

pub fn read_json<T: DeserializeOwned>(path: &str) -> crate::Result<T> {
    let text = std::fs::read_to_string(path).map_err(|e| format!("{path}: {e}"))?;
    Ok(serde_json::from_str(&text).map_err(|e| format!("{path}: {e}"))?)
}

/// `text` as the board at `out`, saved by KiCad 10 with `source`'s project.
pub fn save_board(source: &Path, text: &str, out: &Path) -> crate::Result<()> {
    if std::path::absolute(source)? == std::path::absolute(out)? {
        return Err("a write makes a copy only: the output must differ from the input board".into());
    }
    let folder = WorkDir::beside(out, "place")?;
    let saved = save_refilled(source, text, &folder.0)?;
    put_in_place(&saved.path, out)?;
    Ok(())
}

pub fn run(argv: &[String]) -> crate::Result<()> {
    let flags = Flags::parse(argv, &["--retain-copper"]);
    let [board_file, problem, pose] = &flags.positional[..] else {
        return Err("usage: iotplace write BOARD.kicad_pcb --board-json DOC.json PROB.json POSE.json -o OUT.kicad_pcb".into());
    };
    let source = Path::new(board_file);
    let board = load_board(&flags.path("--board-json")?)?;
    let design = Project::load(source, &board, None)?.design;
    let pr: WriteProblem = read_json(problem)?;
    let places: Vec<Place> = read_json(pose)?;
    let options = WriteOptions { outline_scale: flags.number("--outline-scale", 1.0)?, retain_copper: flags.has("--retain-copper") };
    let text = std::fs::read_to_string(source).map_err(|e| format!("{board_file}: {e}"))?;
    let (edited, report) = write_board(&text, &board, &design, &pr, &places, options)?;
    save_board(source, &edited, &flags.path("-o")?)?;
    println!("{}", serde_json::to_string(&report)?);
    Ok(())
}
