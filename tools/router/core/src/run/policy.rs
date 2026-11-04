//! `iotroute route-policy SPEC.json CANDIDATE.kicad_pcb`: the --spec of `tools/pcb route --router iotroute`, checked, as run
//! arguments, one per line. Exact fields: {"schema", "iters": 1..1000, "max_time_s": null or > 0, "keep": "lock-nets" | "all"}.
//! keep lock-nets: route from the candidate's pair and crystal copper; keep all: keep and lock all candidate copper, route only
//! what is open.
use serde_json::Value;
use std::fs;

const SCHEMA: &str = "iot-lab.iotroute-policy.v1";
const FIELDS: [&str; 4] = ["schema", "iters", "max_time_s", "keep"];
const DEFAULT_ITERS: u64 = 80;

#[derive(Debug, PartialEq)]
pub struct Policy {
    pub iters: u64,
    pub max_time_s: Option<f64>,
    pub keep_all: bool,
}

/// The policy of a spec; None for the defaults.
pub fn policy(spec: Option<&Value>) -> Result<Policy, String> {
    let Some(spec) = spec else { return Ok(Policy { iters: DEFAULT_ITERS, max_time_s: None, keep_all: false }) };
    let object = spec.as_object().filter(|o| o.get("schema").and_then(Value::as_str) == Some(SCHEMA)).ok_or_else(|| format!("route --router iotroute requires a {SCHEMA} spec"))?;
    let unknown: Vec<&str> = object.keys().map(String::as_str).filter(|k| !FIELDS.contains(k)).collect();
    if !unknown.is_empty() {
        return Err(format!("unknown iotroute policy fields: {}", unknown.join(", ")));
    }
    let iters = object.get("iters").map_or(Some(DEFAULT_ITERS), Value::as_u64).filter(|i| (1..=1000).contains(i)).ok_or("iotroute policy iters must be an integer 1..1000")?;
    let max_time_s = match object.get("max_time_s") {
        None | Some(Value::Null) => None,
        Some(v) => Some(v.as_f64().filter(|s| *s > 0.0).ok_or("iotroute policy max_time_s must be null or a positive number")?),
    };
    let keep_all = match object.get("keep").map_or(Some("lock-nets"), Value::as_str) {
        Some("lock-nets") => false,
        Some("all") => true,
        _ => return Err("iotroute policy keep must be lock-nets or all".to_string()),
    };
    Ok(Policy { iters, max_time_s, keep_all })
}

/// The run arguments of a policy on the candidate board.
pub fn policy_args(p: &Policy, candidate: &str) -> Vec<String> {
    let mut args = vec!["--iters".to_string(), p.iters.to_string()];
    if let Some(seconds) = p.max_time_s {
        args.extend(["--max-time".to_string(), seconds.to_string()]);
    }
    if !p.keep_all {
        args.extend(["--lock-from".to_string(), candidate.to_string()]);
    }
    args
}

fn read_spec(path: &str) -> Result<Option<Value>, String> {
    if path == "-" {
        return Ok(None);
    }
    let text = fs::read_to_string(path).map_err(|e| format!("{path}: {e}"))?;
    serde_json::from_str(&text).map(Some).map_err(|e| format!("{path}: {e}"))
}

pub fn cli(args: &[String]) -> i32 {
    let [spec, candidate] = args else {
        eprintln!("usage: iotroute route-policy SPEC.json|- CANDIDATE.kicad_pcb");
        return 2;
    };
    match read_spec(spec).and_then(|s| policy(s.as_ref())) {
        Ok(p) => {
            println!("{}", policy_args(&p, candidate).join("\n"));
            0
        }
        Err(e) => {
            eprintln!("{e}");
            2
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn no_spec_is_the_default_policy() {
        let p = policy(None).unwrap();
        assert_eq!(policy_args(&p, "c.kicad_pcb"), ["--iters", "80", "--lock-from", "c.kicad_pcb"]);
    }

    #[test]
    fn a_spec_sets_its_fields() {
        let p = policy(Some(&json!({"schema": SCHEMA, "iters": 5, "max_time_s": 1.5, "keep": "all"}))).unwrap();
        assert_eq!(policy_args(&p, "c"), ["--iters", "5", "--max-time", "1.5"]);
    }

    #[test]
    fn anything_else_is_refused() {
        for spec in [json!({"schema": "x"}), json!({"schema": SCHEMA, "more": 1}), json!({"schema": SCHEMA, "iters": 0}), json!({"schema": SCHEMA, "iters": 1.5}), json!({"schema": SCHEMA, "max_time_s": 0}), json!({"schema": SCHEMA, "keep": "some"})] {
            assert!(policy(Some(&spec)).is_err(), "{spec}");
        }
    }
}
