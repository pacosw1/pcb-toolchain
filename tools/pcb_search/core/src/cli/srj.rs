//! `pcbsearch scope` and `repair`: narrow a solver response against a frozen native export.

use std::fs;
use std::path::{Path, PathBuf};

use serde_json::{Value, json};

use super::{EXIT_PASS, EXIT_STUCK, USAGE, file_sha256, read_json, seconds};
use crate::budget::{Budget, monotonic};
use crate::contract::check_positive;
use crate::error::{Result, invalid};
use crate::pyjson::{fingerprint, indented, inline};
use crate::srj::repair::prune_crossing_excursion;
use crate::srj::same_value;
use crate::srj::scope::selected_route_proposal;

const SIDECARS: [&str; 4] = ["kicad_pcb", "kicad_pro", "kicad_dru", "kicad_sch"];

struct Frozen {
    manifest: Value,
    srj: Value,
}

pub fn scope(args: &[String]) -> u8 {
    report(run_scope(args))
}

pub fn repair(args: &[String]) -> u8 {
    report(run_repair(args))
}

/// Refusals here are STUCK on stdout: the run can go on with another proposal.
fn report(outcome: Result<u8>) -> u8 {
    outcome.unwrap_or_else(|error| {
        println!("STUCK: {error}");
        EXIT_STUCK
    })
}

fn run_scope(args: &[String]) -> Result<u8> {
    let [folder, result, output] = args else { return invalid(USAGE) };
    let frozen = read_frozen(Path::new(folder))?;
    let nets: Vec<String> = serde_json::from_value(frozen.manifest["selected_nets"].clone())?;
    let response = read_json(Path::new(result))?;
    finish(Path::new(output), selected_route_proposal(&frozen.srj, &response, &nets)?)
}

fn run_repair(args: &[String]) -> Result<u8> {
    let [folder, result, output, options @ ..] = args else { return invalid(USAGE) };
    let limit_s = check_positive(seconds(options)?, "budget_s")?;
    let frozen = read_frozen(Path::new(folder))?;
    let response = read_json(Path::new(result))?;
    let clock = monotonic();
    finish(Path::new(output), prune_crossing_excursion(&frozen.srj, &response, &Budget::new(limit_s, &clock))?)
}

fn read_frozen(folder: &Path) -> Result<Frozen> {
    let manifest = read_json(&folder.join("record.json"))?;
    let srj = read_json(&folder.join("srj.json"))?;
    let unchanged = same_value(&manifest["input_files"], &source_set(&folder.join("input.kicad_pcb"))?)
        && manifest["srj_sha256"].as_str() == Some(fingerprint(&srj)?.as_str());
    if !unchanged {
        return invalid("native project or SRJ changed before proposal scoping");
    }
    Ok(Frozen { manifest, srj })
}

/// SHA-256 of the board and its three sidecars, by file name.
fn source_set(board: &Path) -> Result<Value> {
    let files: Vec<PathBuf> = SIDECARS.iter().map(|extension| board.with_extension(extension)).collect();
    if !files.iter().all(|file| file.is_file()) {
        return invalid("complete native project sidecars required");
    }
    let mut set = serde_json::Map::new();
    for file in files {
        let name = file.file_name().map(|name| name.to_string_lossy().into_owned()).unwrap_or_default();
        set.insert(name, file_sha256(&file)?.into());
    }
    Ok(Value::Object(set))
}

fn finish(output: &Path, proposal: Value) -> Result<u8> {
    if output.exists() {
        return invalid("proposal output must be new");
    }
    fs::write(output, indented(&proposal)?)?;
    let summary = json!({
        "status": proposal["status"],
        "qualified": false,
        "reason": proposal["reason"],
        "conflicts": proposal["conflicts"].as_array().map_or(0, Vec::len),
        "discarded_backend_changes": proposal["discarded_backend_changes"].as_array().map_or(0, Vec::len),
    });
    let success = proposal["status"] == "candidate";
    println!("{}: native/SRJ proposal step; native validation required; {}",
             if success { "PASS" } else { "STUCK" }, inline(&summary)?);
    Ok(if success { EXIT_PASS } else { EXIT_STUCK })
}
