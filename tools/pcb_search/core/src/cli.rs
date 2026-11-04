//! The `pcbsearch` command line. Each mode reads a frozen JSON model and writes a new proposal; it never edits CAD.

use std::fs;
use std::path::{Path, PathBuf};

use serde_json::Value;

use crate::budget::{Budget, monotonic};
use crate::contract::{Problem, check_positive};
use crate::error::{Invalid, Result, invalid};
use crate::patterns::route_patterns;
use crate::pyjson::{fingerprint, indented, sha256_hex};

const USAGE: &str = "usage: pcbsearch route INPUT --output OUTPUT --budget-s SECONDS";
const EXIT_PASS: u8 = 0;
const EXIT_FAIL: u8 = 2;
const EXIT_STUCK: u8 = 3;

struct Request {
    input: PathBuf,
    output: PathBuf,
    budget_s: f64,
}

pub fn run(args: &[String]) -> u8 {
    match parse(args).and_then(|request| route(&request)) {
        Ok(code) => code,
        Err(error) => {
            eprintln!("FAIL: {error}");
            EXIT_FAIL
        }
    }
}

fn parse(args: &[String]) -> Result<Request> {
    let [mode, input, options @ ..] = args else { return invalid(USAGE) };
    if mode != "route" {
        return invalid(USAGE);
    }
    let (mut output, mut budget_s) = (None, None);
    for option in options.chunks(2) {
        match option {
            [flag, value] if flag == "--output" => output = Some(PathBuf::from(value)),
            [flag, value] if flag == "--budget-s" => budget_s = value.parse().ok(),
            _ => return invalid(USAGE),
        }
    }
    let (Some(output), Some(budget_s)) = (output, budget_s) else { return invalid(USAGE) };
    Ok(Request { input: input.into(), output, budget_s })
}

fn route(request: &Request) -> Result<u8> {
    check_output_is_new(request)?;
    let raw = read_json(&request.input)?;
    let source_sha256 = fingerprint(&raw)?;
    let problem = Problem::read(&raw)?;
    let limit_s = check_positive(request.budget_s, "budget_s")?;
    let clock = monotonic();
    let outcome = route_patterns(&problem, &Budget::new(limit_s, &clock));
    if source_sha256 != fingerprint(&read_json(&request.input)?)? {
        return invalid("input changed during computation; result not saved");
    }
    let mut record = serde_json::to_value(&outcome)?;
    record["source_sha256"] = source_sha256.into();
    record["implementation_sha256"] = implementation_sha256()?.into();
    save(&request.output, &record)?;
    let unresolved = outcome.unresolved.len();
    let complete = outcome.status == "candidate" && unresolved == 0;
    println!("{}: route {}; {unresolved} unresolved; proposal only, native validation required; {}",
             if complete { "PASS" } else { "STUCK" }, outcome.status, request.output.display());
    Ok(if complete { EXIT_PASS } else { EXIT_STUCK })
}

fn check_output_is_new(request: &Request) -> Result<()> {
    if request.output.exists() || fs::canonicalize(&request.input)? == std::path::absolute(&request.output)? {
        return invalid("output must be new and separate from input");
    }
    Ok(())
}

fn read_json(path: &Path) -> Result<Value> {
    Ok(serde_json::from_str(&fs::read_to_string(path)?)?)
}

/// Identifies the code that made a record: the hash of this executable.
fn implementation_sha256() -> Result<String> {
    Ok(sha256_hex(&fs::read(std::env::current_exe()?)?))
}

/// Write beside the target and rename, so a reader never sees half a record.
fn save(path: &Path, record: &Value) -> Result<()> {
    let folder = path.parent().filter(|parent| !parent.as_os_str().is_empty()).unwrap_or(Path::new("."));
    fs::create_dir_all(folder)?;
    let name = path.file_name().ok_or_else(|| Invalid("output needs a file name".into()))?;
    let temporary = folder.join(format!(".{}.{}.tmp", name.to_string_lossy(), std::process::id()));
    fs::write(&temporary, indented(record)? + "\n")?;
    fs::rename(&temporary, path)?;
    Ok(())
}
