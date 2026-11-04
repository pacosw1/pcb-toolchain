//! The `pcbsearch` command line. Each mode reads frozen JSON and writes a new proposal; it never edits CAD.

mod route;
mod srj;

use std::fs;
use std::path::Path;

use serde_json::Value;

use crate::error::{Invalid, Result, invalid};
use crate::pyjson::{fingerprint, sha256_hex};

const USAGE: &str = "usage: pcbsearch route INPUT --output OUTPUT --budget-s SECONDS
       pcbsearch scope FOLDER RESULT OUTPUT
       pcbsearch repair FOLDER RESULT OUTPUT --budget-s SECONDS
       pcbsearch fingerprint FILE";
const EXIT_PASS: u8 = 0;
const EXIT_FAIL: u8 = 2;
const EXIT_STUCK: u8 = 3;

pub fn run(args: &[String]) -> u8 {
    match args.split_first().map(|(mode, rest)| (mode.as_str(), rest)) {
        Some(("route", rest)) => report_fail(route::run(rest)),
        Some(("scope", rest)) => srj::scope(rest),
        Some(("repair", rest)) => srj::repair(rest),
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

fn file_sha256(path: &Path) -> Result<String> {
    Ok(sha256_hex(&fs::read(path)?))
}

/// The value after `flag` in `--flag value` pairs.
fn option<'a>(options: &'a [String], flag: &str) -> Result<&'a str> {
    match options.chunks(2).find(|pair| pair[0] == flag) {
        Some([_, value]) => Ok(value),
        _ => invalid(USAGE),
    }
}

fn seconds(options: &[String]) -> Result<f64> {
    option(options, "--budget-s")?.parse().map_err(|_| Invalid(USAGE.into()))
}
