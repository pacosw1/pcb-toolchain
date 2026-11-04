//! Spawn options: lean_owned._validate_options on the wire form, and the IOT_LEAN_DEADLINE protocol.

use super::failure::Failure;
use super::native::monotonic_s;
use serde_json::{Map, Value};
use std::collections::BTreeMap;
use std::ffi::OsString;
use std::path::PathBuf;

const DEADLINE_ENV: &str = "IOT_LEAN_DEADLINE";
const DEADLINE_PROTOCOL: &str = "clock-monotonic-v1:";
const WIRE_KEYS: [&str; 13] = ["stdin", "stdout", "stderr", "cwd", "env", "text", "universal_newlines", "encoding", "errors",
                               "bufsize", "restore_signals", "close_fds", "passed"];
// subprocess constants on the wire
const PIPE: i64 = -1;
const STDOUT: i64 = -2;
const DEVNULL: i64 = -3;

#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Role {
    Inherit,
    Pipe,
    Null,
    /// stderr only: the same target as stdout.
    Stdout,
    /// Index into the descriptors received with the request.
    Descriptor(usize),
}

#[derive(Debug)]
pub struct SpawnOptions {
    pub cwd: PathBuf,
    pub env: BTreeMap<OsString, OsString>,
    pub stdin: Role,
    pub stdout: Role,
    pub stderr: Role,
    /// (child descriptor number, index into the received descriptors)
    pub passed: Vec<(i32, usize)>,
}

impl SpawnOptions {
    /// The root stage: the caller's own cwd, environment and stdio.
    pub fn inherited() -> Result<SpawnOptions, Failure> {
        Ok(SpawnOptions { cwd: std::env::current_dir()?, env: std::env::vars_os().collect(), stdin: Role::Inherit,
                          stdout: Role::Inherit, stderr: Role::Inherit, passed: Vec::new() })
    }
}

fn exact_int(value: &Value) -> Option<i64> {
    value.as_i64()
}

fn role(key: &str, value: Option<&Value>, roles: &mut Vec<i64>) -> Result<Role, Failure> {
    match value {
        None | Some(Value::Null) => Ok(Role::Inherit),
        Some(Value::Object(fields)) => {
            let index = fields.get("fd").and_then(exact_int).filter(|_| fields.len() == 1)
                .ok_or_else(|| Failure::value("invalid owned-stage stdio descriptor"))?;
            roles.push(index);
            Ok(Role::Descriptor(index.max(0) as usize))
        }
        Some(other) => match exact_int(other) {
            Some(PIPE) => Ok(Role::Pipe),
            Some(DEVNULL) => Ok(Role::Null),
            Some(STDOUT) if key == "stderr" => Ok(Role::Stdout),
            _ => Err(Failure::value("unsupported owned-stage stdio option")),
        },
    }
}

fn passed_list(options: &Map<String, Value>, roles: &mut Vec<i64>) -> Result<Vec<(i32, usize)>, Failure> {
    let list = options.get("passed").and_then(Value::as_array).ok_or_else(|| Failure::value("invalid owned-stage passed descriptors"))?;
    let mut passed: Vec<(i32, usize)> = Vec::new();
    for pair in list {
        let numbers: Option<Vec<i64>> = pair.as_array().map(|items| items.iter().filter_map(exact_int).collect());
        let (target, index) = match numbers.as_deref() {
            Some([target, index]) if *target >= 3 && *target <= i32::MAX as i64 => (*target as i32, *index),
            _ => return Err(Failure::value("invalid/duplicate owned-stage descriptor target")),
        };
        if passed.iter().any(|(seen, _)| *seen == target) {
            return Err(Failure::value("invalid/duplicate owned-stage descriptor target"));
        }
        roles.push(index);
        passed.push((target, index.max(0) as usize));
    }
    Ok(passed)
}

/// Text options only shape the client's decoding, and bufsize and restore_signals have no broker meaning, so they
/// are checked for form and dropped.
fn check_ignored(options: &Map<String, Value>) -> Result<(), Failure> {
    for key in ["text", "universal_newlines", "restore_signals", "close_fds"] {
        if options.get(key).is_some_and(|value| !value.is_boolean()) {
            return Err(Failure::value("invalid owned-stage boolean option"));
        }
    }
    if options.get("close_fds").is_some_and(|value| value != &Value::Bool(true)) {
        return Err(Failure::value("owned stages require close_fds"));
    }
    for key in ["encoding", "errors"] {
        if options.get(key).is_some_and(|value| !value.is_null() && !value.is_string()) {
            return Err(Failure::value("invalid owned-stage text option"));
        }
    }
    if options.get("bufsize").is_some_and(|value| exact_int(value).is_none()) {
        return Err(Failure::value("invalid owned-stage buffering"));
    }
    Ok(())
}

pub fn from_wire(value: &Value, fd_count: usize) -> Result<SpawnOptions, Failure> {
    let unsupported = || Failure::value("unsupported owned-stage wire options");
    let options = value.as_object().ok_or_else(unsupported)?;
    if options.keys().any(|key| !WIRE_KEYS.contains(&key.as_str())) {
        return Err(unsupported());
    }
    let invalid = || Failure::value("invalid owned-stage cwd/environment");
    let cwd = options.get("cwd").and_then(Value::as_str).ok_or_else(invalid)?;
    let mut env = BTreeMap::new();
    for (key, text) in options.get("env").and_then(Value::as_object).ok_or_else(invalid)? {
        env.insert(OsString::from(key), OsString::from(text.as_str().ok_or_else(invalid)?));
    }
    let mut roles = Vec::new();
    let stdin = role("stdin", options.get("stdin"), &mut roles)?;
    let stdout = role("stdout", options.get("stdout"), &mut roles)?;
    let stderr = role("stderr", options.get("stderr"), &mut roles)?;
    let passed = passed_list(options, &mut roles)?;
    roles.sort_unstable();
    if !roles.iter().copied().eq(0..fd_count as i64) {
        return Err(Failure::value("owned-stage descriptor role mismatch"));
    }
    check_ignored(options)?;
    Ok(SpawnOptions { cwd: PathBuf::from(cwd), env, stdin, stdout, stderr, passed })
}

/// Seconds left of the deadline in `env`, None without one. A malformed deadline is an error, not "no deadline".
pub fn remaining_s(env: &BTreeMap<OsString, OsString>) -> Result<Option<f64>, Failure> {
    let Some(value) = env.get(&OsString::from(DEADLINE_ENV)) else { return Ok(None) };
    let unsupported = || Failure::value("unsupported inherited deadline protocol");
    let text = value.to_str().and_then(|text| text.strip_prefix(DEADLINE_PROTOCOL)).ok_or_else(unsupported)?;
    let deadline: f64 = text.parse().map_err(|_| unsupported())?;
    if !deadline.is_finite() {
        return Err(Failure::value("deadline must be finite"));
    }
    Ok(Some((deadline - monotonic_s()).max(0.0)))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn base() -> Value {
        json!({"cwd": "/tmp", "env": {"A": "b"}, "passed": []})
    }

    fn with(key: &str, value: Value) -> Value {
        let mut options = base();
        options[key] = value;
        options
    }

    fn rejected(options: Value, fd_count: usize) -> String {
        from_wire(&options, fd_count).unwrap_err().message
    }

    #[test]
    fn the_python_client_form_is_accepted() {
        let options = json!({"stdin": {"fd": 0}, "stdout": -1, "stderr": -2, "cwd": "/tmp", "env": {"K": "v"}, "text": true,
                             "encoding": null, "errors": "strict", "bufsize": -1, "restore_signals": true, "close_fds": true,
                             "universal_newlines": false, "passed": [[70, 1]]});
        let parsed = from_wire(&options, 2).unwrap();
        assert_eq!((parsed.stdin, parsed.stdout, parsed.stderr), (Role::Descriptor(0), Role::Pipe, Role::Stdout));
        assert_eq!(parsed.passed, [(70, 1)]);
    }

    #[test]
    fn unknown_keys_and_shapes_are_refused() {
        assert!(rejected(with("shell", json!(true)), 0).contains("wire options"));
        assert!(rejected(json!([]), 0).contains("wire options"));
        assert!(rejected(with("cwd", json!(1)), 0).contains("cwd/environment"));
        assert!(rejected(with("env", json!({"A": 1})), 0).contains("cwd/environment"));
        assert!(rejected(with("passed", json!(null)), 0).contains("passed descriptors"));
    }

    #[test]
    fn stdio_values_outside_the_contract_are_refused() {
        assert!(rejected(with("stdout", json!(-2)), 0).contains("stdio option"));
        assert!(rejected(with("stdin", json!(7)), 0).contains("stdio option"));
        assert!(rejected(with("stdout", json!({"fd": 0, "x": 1})), 1).contains("stdio descriptor"));
        assert!(rejected(with("stdout", json!({"fd": true})), 1).contains("stdio descriptor"));
    }

    #[test]
    fn every_descriptor_needs_exactly_one_role() {
        assert!(rejected(base(), 1).contains("role mismatch"));
        assert!(rejected(with("stdout", json!({"fd": 1})), 1).contains("role mismatch"));
        let mut twice = with("stdout", json!({"fd": 0}));
        twice["stderr"] = json!({"fd": 0});
        assert!(rejected(twice, 2).contains("role mismatch"));
        assert!(rejected(with("stdout", json!({"fd": -1})), 1).contains("role mismatch"));
    }

    #[test]
    fn passed_targets_must_be_high_and_unique() {
        assert!(rejected(with("passed", json!([[2, 0]])), 1).contains("descriptor target"));
        assert!(rejected(with("passed", json!([[9, 0], [9, 1]])), 2).contains("descriptor target"));
        assert!(rejected(with("passed", json!([[9, true]])), 1).contains("descriptor target"));
    }

    #[test]
    fn ignored_options_are_still_checked_for_form() {
        assert!(rejected(with("close_fds", json!(false)), 0).contains("close_fds"));
        assert!(rejected(with("text", json!(1)), 0).contains("boolean"));
        assert!(rejected(with("encoding", json!(1)), 0).contains("text option"));
        assert!(rejected(with("bufsize", json!("x")), 0).contains("buffering"));
    }

    fn deadline(value: &str) -> BTreeMap<OsString, OsString> {
        BTreeMap::from([(OsString::from(DEADLINE_ENV), OsString::from(value))])
    }

    #[test]
    fn the_deadline_protocol_matches_lean_workflow() {
        assert_eq!(remaining_s(&BTreeMap::new()).unwrap(), None);
        let future = format!("{DEADLINE_PROTOCOL}{}", monotonic_s() + 100.0);
        assert!(remaining_s(&deadline(&future)).unwrap().unwrap() > 90.0);
        assert_eq!(remaining_s(&deadline("clock-monotonic-v1:1.5")).unwrap(), Some(0.0));
        assert!(remaining_s(&deadline("12.5")).is_err());
        assert!(remaining_s(&deadline("clock-monotonic-v1:inf")).is_err());
        assert!(remaining_s(&deadline("clock-monotonic-v1:x")).is_err());
    }
}
