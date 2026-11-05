//! `pcbsearch route`: cheap pattern routing on a frozen route problem.

use std::fs;
use std::path::{Path, PathBuf};

use serde_json::Value;

use super::{EXIT_PASS, EXIT_STUCK, USAGE, option, read_json, seconds};
use crate::budget::{Budget, monotonic};
use crate::contract::{Problem, check_positive};
use crate::error::{Invalid, Result, invalid};
use crate::native::digest::file_sha256;
use crate::patterns::route_patterns;
use crate::pyjson::{fingerprint, indented};

pub fn run(args: &[String]) -> Result<u8> {
    let [input, options @ ..] = args else { return invalid(USAGE) };
    let input = PathBuf::from(input);
    let output = PathBuf::from(option(options, "--output")?);
    let budget_s = seconds(options)?;

    check_output_is_new(&input, &output)?;
    let raw = read_json(&input)?;
    let source_sha256 = fingerprint(&raw)?;
    let problem = Problem::read(&raw)?;
    let limit_s = check_positive(budget_s, "budget_s")?;
    let clock = monotonic();
    let outcome = route_patterns(&problem, &Budget::new(limit_s, &clock));
    if source_sha256 != fingerprint(&read_json(&input)?)? {
        return invalid("input changed during computation; result not saved");
    }
    let mut record = serde_json::to_value(&outcome)?;
    record["source_sha256"] = source_sha256.into();
    record["implementation_sha256"] = file_sha256(&std::env::current_exe()?)?.into();
    save(&output, &record)?;
    let unresolved = outcome.unresolved.len();
    let complete = outcome.status == "candidate" && unresolved == 0;
    println!("{}: route {}; {unresolved} unresolved; proposal only, native validation required; {}",
             if complete { "PASS" } else { "STUCK" }, outcome.status, output.display());
    Ok(if complete { EXIT_PASS } else { EXIT_STUCK })
}

fn check_output_is_new(input: &Path, output: &Path) -> Result<()> {
    if output.exists() || fs::canonicalize(input)? == std::path::absolute(output)? {
        return invalid("output must be new and separate from input");
    }
    Ok(())
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
