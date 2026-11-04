//! The `pcbsearch` command line. Each mode reads frozen inputs and writes new files; it never edits a source board.

mod native;
mod route;
mod srj;

use std::fs;
use std::path::Path;

use serde_json::Value;

use crate::error::{Invalid, Result, invalid};
use crate::pyjson::fingerprint;

const USAGE: &str = "usage: pcbsearch route INPUT --output OUTPUT --budget-s SECONDS
       pcbsearch route-srj INPUT --output OUTPUT --budget-s SECONDS --adapter DIR [--pipeline NAME] [--capture-stages yes]
       pcbsearch scope FOLDER RESULT OUTPUT
       pcbsearch repair FOLDER RESULT OUTPUT --budget-s SECONDS
       pcbsearch native-candidate SOURCE CANDIDATE OUT --net NET...
       pcbsearch native-eco BOARD VIA ALONG OUT --fraction F
       pcbsearch native-conflicts EXPORT OUT --fraction F... --budget-s SECONDS
       pcbsearch geometry-digest BOARD [--omit ID]...
       pcbsearch source-set BOARD
       pcbsearch fingerprint FILE";
const EXIT_PASS: u8 = 0;
const EXIT_FAIL: u8 = 2;
const EXIT_STUCK: u8 = 3;

pub fn run(args: &[String]) -> u8 {
    match args.split_first().map(|(mode, rest)| (mode.as_str(), rest)) {
        Some(("route", rest)) => report_fail(route::run(rest)),
        Some(("route-srj", rest)) => report_fail(route::run_srj(rest)),
        Some(("scope", rest)) => srj::scope(rest),
        Some(("repair", rest)) => srj::repair(rest),
        Some(("native-candidate", rest)) => native::candidate(rest),
        Some(("native-eco", rest)) => native::eco(rest),
        Some(("native-conflicts", rest)) => native::conflicts(rest),
        Some(("geometry-digest", rest)) => report_fail(native::print_geometry_digest(rest)),
        Some(("source-set", rest)) => report_fail(native::print_source_set(rest)),
        Some(("fingerprint", [file])) => report_fail(print_fingerprint(Path::new(file))),
        _ => report_fail(invalid(USAGE)),
    }
}

fn report_fail(outcome: Result<u8>) -> u8 {
    outcome.unwrap_or_else(|error| {
        eprintln!("FAIL: {error}");
        EXIT_FAIL
    })
}

/// Hash of a JSON file. JavaScript callers use this: `JSON.parse` cannot tell 1 from 1.0.
fn print_fingerprint(file: &Path) -> Result<u8> {
    println!("{}", fingerprint(&read_json(file)?)?);
    Ok(EXIT_PASS)
}

fn read_json(path: &Path) -> Result<Value> {
    Ok(serde_json::from_str(&fs::read_to_string(path)?)?)
}

/// The value after `flag` in `--flag value` pairs.
fn option<'a>(options: &'a [String], flag: &str) -> Result<&'a str> {
    all_options(options, flag).pop().ok_or_else(|| Invalid(USAGE.into()))
}

/// Every value of a repeatable `--flag value`.
fn all_options<'a>(options: &'a [String], flag: &str) -> Vec<&'a str> {
    options.chunks(2).filter_map(|pair| match pair {
        [name, value] if name == flag => Some(value.as_str()),
        _ => None,
    }).collect()
}

fn seconds(options: &[String]) -> Result<f64> {
    option(options, "--budget-s")?.parse().map_err(|_| Invalid(USAGE.into()))
}
