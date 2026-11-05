//! `iotplace repair-proposals PROB.json --failures FAILS.json [-o OUT.json] [--loose LOOSE.json] [--tie MM] [--no-rotate]
//! [--no-escape] [--rank term|hot] [--congestion MAP.json]`
//!
//! FAILS.json is the list repair.ts parses from the KiCad report. Prints, or writes to OUT.json: {candidates, escape, proposals}.
//! --tie is the --decap-tie of the read (default 3 mm). Rank hot needs a map; without the file the term order stays.

use super::failure::Failure;
use super::{Request, repair_proposals};
use crate::congest::HistoryMap;
use crate::problem::Problem;
use crate::read::cli::Flags;
use crate::write::cli::read_json;
use std::path::Path;

/// The --decap-tie of a read that names none.
const DEFAULT_TIE: f64 = 3.0;

fn heat(flags: &Flags) -> crate::Result<Option<HistoryMap>> {
    match flags.one("--rank")?.unwrap_or("term") {
        "term" => Ok(None),
        "hot" => {
            let map = flags.path("--congestion")?;
            map.is_file().then(|| HistoryMap::load(&map)).transpose()
        }
        other => Err(format!("--rank: bad value {other}").into()),
    }
}

pub fn run(argv: &[String]) -> crate::Result<()> {
    let flags = Flags::parse(argv, &["--no-rotate", "--no-escape"]);
    let [problem] = &flags.positional[..] else {
        return Err("usage: iotplace repair-proposals PROB.json --failures FAILS.json [-o OUT.json] [flags]".into());
    };
    let pr = Problem::load(Path::new(problem))?;
    let loose = flags.one("--loose")?.map(|path| Problem::load(Path::new(path))).transpose()?;
    let fails: Vec<Failure> = read_json(&flags.path("--failures")?.to_string_lossy())?;
    let answer = repair_proposals(&Request {
        problem: &pr,
        loose: loose.as_ref(),
        fails: &fails,
        tie: flags.number("--tie", DEFAULT_TIE)?,
        rotate: !flags.has("--no-rotate"),
        escape: !flags.has("--no-escape"),
        heat: heat(&flags)?,
    })?;
    let text = serde_json::to_string(&answer)?;
    match flags.one("-o")? {
        Some(path) => std::fs::write(path, text).map_err(|e| format!("{path}: {e}"))?,
        None => println!("{text}"),
    }
    Ok(())
}
