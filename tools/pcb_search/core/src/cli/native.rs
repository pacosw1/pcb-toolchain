//! Modes that work on native board text: scoping backend copper, via repairs, and the hashes other tools need.

use std::collections::BTreeSet;
use std::path::Path;

use super::{EXIT_PASS, EXIT_STUCK, USAGE, all_options, option, seconds};
use crate::budget::{Budget, monotonic};
use crate::contract::check_positive;
use crate::error::{Invalid, Result, invalid};
use crate::native::board::Board;
use crate::native::candidate::scope_native;
use crate::native::conflicts::propose;
use crate::native::digest::{geometry_digest, source_set};
use crate::native::eco::shift_via;
use crate::pyjson::inline;

/// Refusals here are STUCK on stdout: the run can go on with another proposal.
fn report(outcome: Result<u8>) -> u8 {
    outcome.unwrap_or_else(|error| {
        println!("STUCK: {error}");
        EXIT_STUCK
    })
}

pub fn candidate(args: &[String]) -> u8 {
    report(run_candidate(args))
}

pub fn eco(args: &[String]) -> u8 {
    report(run_eco(args))
}

pub fn conflicts(args: &[String]) -> u8 {
    report(run_conflicts(args))
}

fn run_candidate(args: &[String]) -> Result<u8> {
    let [source, candidate, out, options @ ..] = args else { return invalid(USAGE) };
    let nets: Vec<String> = all_options(options, "--net").iter().map(|net| net.to_string()).collect();
    let record = scope_native(Path::new(source), Path::new(candidate), Path::new(out), &nets)?;
    let count = |field: &str| record[field].as_array().map_or(0, Vec::len);
    println!("PASS: native proposal scoped; {} added, {} discarded; native checks required",
             count("added_items"), count("discarded_items"));
    Ok(EXIT_PASS)
}

fn run_eco(args: &[String]) -> Result<u8> {
    let [board, via, along, out, options @ ..] = args else { return invalid(USAGE) };
    let fraction = option(options, "--fraction")?.parse().map_err(|_| Invalid(USAGE.into()))?;
    shift_via(Path::new(board), via, along, Path::new(out), fraction)?;
    println!("PASS: local via proposal; all original tracks retained; native and board gates required");
    Ok(EXIT_PASS)
}

fn run_conflicts(args: &[String]) -> Result<u8> {
    let [folder, out, options @ ..] = args else { return invalid(USAGE) };
    let fractions = all_options(options, "--fraction").iter().map(|text| text.parse())
        .collect::<std::result::Result<Vec<f64>, _>>().map_err(|_| Invalid(USAGE.into()))?;
    let limit_s = check_positive(seconds(options)?, "budget_s")?;
    let clock = monotonic();
    let result = propose(Path::new(folder), Path::new(out), &fractions, limit_s, &Budget::new(limit_s, &clock))?;
    if result["status"] != "candidate" {
        println!("STUCK: local repair {}; {}", result["status"].as_str().unwrap_or(""), inline(&result["diagnostic_reasons"])?);
        return Ok(EXIT_STUCK);
    }
    println!("PASS: native conflicts select one local via repair; original tracks retained; native gates required");
    Ok(EXIT_PASS)
}

/// `geometry-digest BOARD [--omit ID]...`: the protected hash, for tools that compare boards.
pub fn print_geometry_digest(args: &[String]) -> Result<u8> {
    let [board, options @ ..] = args else { return invalid(USAGE) };
    let omit: BTreeSet<String> = all_options(options, "--omit").iter().map(|id| id.to_string()).collect();
    println!("{}", geometry_digest(&Board::read(Path::new(board))?, &omit)?);
    Ok(EXIT_PASS)
}

/// `source-set BOARD`: the project file hashes, as JSON.
pub fn print_source_set(args: &[String]) -> Result<u8> {
    let [board] = args else { return invalid(USAGE) };
    println!("{}", inline(&source_set(Path::new(board))?)?);
    Ok(EXIT_PASS)
}
