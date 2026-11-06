//! `iotroute route-policy CANDIDATE.kicad_pcb < SPEC.json`: the --spec of `tools/pcb route --router iotroute`, checked, as run
//! arguments, one per line. An empty spec or null is the default policy. Exact fields: {"schema", "iters": 1..1000, "max_time_s": null or > 0, "keep": "lock-nets" | "all", "return_exempt": bool}.
//! keep lock-nets: route from the candidate's pair and crystal copper; keep all: keep and lock all candidate copper, route only
//! what is open. tune (default false): the opt-in length / skew tuning stage after the route (`--tune`, DESIGN.md 5f); it adds
//! meanders to router-routed nets only, never to kept or locked (hand) copper. return_exempt: no return vias for the nets the board's gate exempts from RP-001 (`--return-exempt`); without it a
//! route that gives such a net its returns leaves the exemption stale, and the gate fails on that.
use serde_json::Value;
use std::io::Read;

const SCHEMA: &str = "iot-lab.iotroute-policy.v1";
const FIELDS: [&str; 10] = ["schema", "iters", "max_time_s", "keep", "return_exempt", "layers", "nets", "reuse", "reuse_nets", "tune"];
const DEFAULT_ITERS: u64 = 80;

#[derive(Debug, PartialEq)]
pub struct Policy {
    pub iters: u64,
    pub max_time_s: Option<f64>,
    pub keep_all: bool,
    pub return_exempt: bool,
    /// The layers and nets of the route; empty is all of them.
    pub layers: Vec<String>,
    pub nets: Vec<String>,
    /// The board of an earlier run to start from, and nets to route again with what it left open: `--reuse`, without the full fallback.
    pub reuse: Option<String>,
    pub reuse_nets: Vec<String>,
    /// The post-route length / skew tuning stage (`--tune`).
    pub tune: bool,
}

/// A list of distinct names, none by default.
fn names(object: &serde_json::Map<String, Value>, key: &str) -> Result<Vec<String>, String> {
    let bad = || format!("iotroute policy {key} must be a list of distinct names");
    let Some(value) = object.get(key) else { return Ok(Vec::new()) };
    let list: Vec<String> = value.as_array().ok_or_else(bad)?.iter().map(|name| name.as_str().filter(|n| !n.is_empty()).map(str::to_string).ok_or_else(bad)).collect::<Result<_, _>>()?;
    if (1..list.len()).any(|i| list[..i].contains(&list[i])) {
        return Err(bad());
    }
    Ok(list)
}

/// The policy of a spec; None for the defaults.
pub fn policy(spec: Option<&Value>) -> Result<Policy, String> {
    let Some(spec) = spec else { return Ok(Policy { iters: DEFAULT_ITERS, max_time_s: None, keep_all: false, return_exempt: false, layers: Vec::new(), nets: Vec::new(), reuse: None, reuse_nets: Vec::new(), tune: false }) };
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
    let return_exempt = object.get("return_exempt").map_or(Some(false), Value::as_bool).ok_or("iotroute policy return_exempt must be true or false")?;
    let reuse = match object.get("reuse") {
        None | Some(Value::Null) => None,
        Some(v) => Some(v.as_str().filter(|path| path.starts_with('/')).ok_or("iotroute policy reuse must be null or an absolute path")?.to_string()),
    };
    let tune = object.get("tune").map_or(Some(false), Value::as_bool).ok_or("iotroute policy tune must be true or false")?;
    Ok(Policy { iters, max_time_s, keep_all, return_exempt, layers: names(object, "layers")?, nets: names(object, "nets")?, reuse, reuse_nets: names(object, "reuse_nets")?, tune })
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
    if p.return_exempt {
        args.push("--return-exempt".to_string());
    }
    args.extend(p.layers.iter().flat_map(|layer| ["--layer".to_string(), layer.clone()]));
    args.extend(p.nets.iter().flat_map(|net| ["--net".to_string(), net.clone()]));
    if let Some(reuse) = &p.reuse {
        args.extend(["--reuse".to_string(), reuse.clone(), "--reuse-fallback".to_string(), "none".to_string()]);
    }
    args.extend(p.reuse_nets.iter().flat_map(|net| ["--reuse-net".to_string(), net.clone()]));
    if p.tune {
        args.push("--tune".to_string());
    }
    args
}

fn read_spec(text: &str) -> Result<Option<Value>, String> {
    if text.trim().is_empty() {
        return Ok(None);
    }
    let value: Value = serde_json::from_str(text).map_err(|e| format!("spec: {e}"))?;
    Ok(Some(value).filter(|v| !v.is_null()))
}

pub fn cli(args: &[String]) -> i32 {
    let [candidate] = args else {
        eprintln!("usage: iotroute route-policy CANDIDATE.kicad_pcb < SPEC.json");
        return 2;
    };
    let mut text = String::new();
    if let Err(e) = std::io::stdin().read_to_string(&mut text) {
        eprintln!("spec: {e}");
        return 2;
    }
    match read_spec(&text).and_then(|s| policy(s.as_ref())) {
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
    fn reuse_starts_from_an_earlier_board_without_the_full_fallback() {
        let p = policy(Some(&json!({"schema": SCHEMA, "keep": "all", "reuse": "/run/B.kicad_pcb", "reuse_nets": ["/A"]}))).unwrap();
        assert_eq!(policy_args(&p, "c"), ["--iters", "80", "--reuse", "/run/B.kicad_pcb", "--reuse-fallback", "none", "--reuse-net", "/A"]);
        assert!(policy(Some(&json!({"schema": SCHEMA, "reuse": "B.kicad_pcb"}))).is_err());
    }

    #[test]
    fn return_exempt_asks_for_the_run_option() {
        let p = policy(Some(&json!({"schema": SCHEMA, "return_exempt": true}))).unwrap();
        assert_eq!(policy_args(&p, "c"), ["--iters", "80", "--lock-from", "c", "--return-exempt"]);
    }

    #[test]
    fn layers_and_nets_narrow_the_run_and_a_repeat_is_refused() {
        let p = policy(Some(&json!({"schema": SCHEMA, "keep": "all", "layers": ["F.Cu"], "nets": ["/A", "GND"]}))).unwrap();
        assert_eq!(policy_args(&p, "c"), ["--iters", "80", "--layer", "F.Cu", "--net", "/A", "--net", "GND"]);
        let none = policy(Some(&json!({"schema": SCHEMA, "keep": "all", "layers": [], "nets": []}))).unwrap();
        assert_eq!(policy_args(&none, "c"), ["--iters", "80"]);
        for spec in [json!({"schema": SCHEMA, "nets": ["/A", "/A"]}), json!({"schema": SCHEMA, "layers": "F.Cu"}), json!({"schema": SCHEMA, "nets": [""]})] {
            assert!(policy(Some(&spec)).is_err(), "{spec}");
        }
    }

    #[test]
    fn tune_is_off_unless_the_spec_asks_for_it() {
        assert!(!policy(Some(&json!({"schema": SCHEMA}))).unwrap().tune);
        let p = policy(Some(&json!({"schema": SCHEMA, "tune": true}))).unwrap();
        assert_eq!(policy_args(&p, "c"), ["--iters", "80", "--lock-from", "c", "--tune"]);
        assert_eq!(policy_args(&policy(Some(&json!({"schema": SCHEMA, "tune": false}))).unwrap(), "c"), ["--iters", "80", "--lock-from", "c"]);
        assert!(policy(Some(&json!({"schema": SCHEMA, "tune": "yes"}))).is_err());
    }

    #[test]
    fn no_text_and_null_are_no_spec() {
        assert_eq!(read_spec(" ").unwrap(), None);
        assert_eq!(read_spec("null").unwrap(), None);
        assert!(read_spec("{").is_err());
    }

    #[test]
    fn anything_else_is_refused() {
        for spec in [json!({"schema": "x"}), json!({"schema": SCHEMA, "more": 1}), json!({"schema": SCHEMA, "iters": 0}), json!({"schema": SCHEMA, "iters": 1.5}), json!({"schema": SCHEMA, "max_time_s": 0}), json!({"schema": SCHEMA, "keep": "some"}), json!({"schema": SCHEMA, "return_exempt": 1})] {
            assert!(policy(Some(&spec)).is_err(), "{spec}");
        }
    }
}
