//! `pcbsearch route` and `route-srj`: routing on a frozen model, saved as a new record bound to its input.

use std::fs;
use std::path::{Path, PathBuf};

use serde_json::Value;

use super::{EXIT_PASS, EXIT_STUCK, USAGE, all_options, option, read_json, seconds};
use crate::budget::{Budget, monotonic};
use crate::contract::{Problem, check_positive};
use crate::error::{Invalid, Result, invalid};
use crate::native::digest::file_sha256;
use crate::patterns::route_patterns;
use crate::pyjson::{fingerprint, indented};
use crate::srj::capacity::{self, Backend};

/// The frozen input of a run and where its record goes.
struct Job {
    input: PathBuf,
    output: PathBuf,
    raw: Value,
    source_sha256: String,
}

impl Job {
    fn open(input: &str, options: &[String]) -> Result<Job> {
        let (input, output) = (PathBuf::from(input), PathBuf::from(option(options, "--output")?));
        if output.exists() || fs::canonicalize(&input)? == std::path::absolute(&output)? {
            return invalid("output must be new and separate from input");
        }
        let raw = read_json(&input)?;
        let source_sha256 = fingerprint(&raw)?;
        Ok(Job { input, output, raw, source_sha256 })
    }

    /// Bind the record to its input and save it. A partial result is STUCK; PASS is never native acceptance.
    fn finish(self, mode: &str, mut record: Value) -> Result<u8> {
        if self.source_sha256 != fingerprint(&read_json(&self.input)?)? {
            return invalid("input changed during computation; result not saved");
        }
        record["source_sha256"] = self.source_sha256.into();
        record["implementation_sha256"] = file_sha256(&std::env::current_exe()?)?.into();
        save(&self.output, &record)?;
        let unresolved = record.get("unresolved").and_then(Value::as_array).map_or(0, Vec::len);
        let status = record["status"].as_str().unwrap_or("");
        let complete = status == "candidate" && unresolved == 0;
        println!("{}: {mode} {status}; {unresolved} unresolved; proposal only, native validation required; {}",
                 if complete { "PASS" } else { "STUCK" }, self.output.display());
        Ok(if complete { EXIT_PASS } else { EXIT_STUCK })
    }
}

pub fn run(args: &[String]) -> Result<u8> {
    let [input, options @ ..] = args else { return invalid(USAGE) };
    let budget_s = seconds(options)?;
    let job = Job::open(input, options)?;
    let problem = Problem::read(&job.raw)?;
    let limit_s = check_positive(budget_s, "budget_s")?;
    let clock = monotonic();
    let outcome = route_patterns(&problem, &Budget::new(limit_s, &clock));
    job.finish("route", serde_json::to_value(&outcome)?)
}

pub fn run_srj(args: &[String]) -> Result<u8> {
    let [input, options @ ..] = args else { return invalid(USAGE) };
    let budget_s = seconds(options)?;
    let job = Job::open(input, options)?;
    let backend = Backend {
        adapter: fs::canonicalize(option(options, "--adapter")?)?,
        node: "node".to_string(),
        pipeline: all_options(options, "--pipeline").pop().unwrap_or("topology").to_string(),
        capture_stages: all_options(options, "--capture-stages").pop() == Some("yes"),
        budget_s: check_positive(budget_s, "budget_s")?,
    };
    let record = capacity::run(&job.raw, &backend)?;
    job.finish("route-srj", record)
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
