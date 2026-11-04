//! The final backend command. Every supported switch is explicit and none can load another config; an unknown switch abstains
//! rather than guess whether it weakens a rule.
use std::collections::BTreeSet;
use std::path::Path;

const WITH_VALUE: [&str; 3] = ["-de", "-do", "-mp"];
const SWITCHES: [&str; 2] = ["--diagnose", "--quality-first"];
const OPTIONS: [&str; 10] = [
    "--report",
    "--max-time",
    "--router.min_trace_width_um",
    "--router.copper_to_edge_clearance_um",
    "--router.neck_width_um",
    "--router.autorouter.ignore_net_classes",
    "--router.optimizer.enabled",
    "--router.autorouter.max_threads",
    "--router.optimizer.max_threads",
    "--router.scoring.via_costs",
];

pub fn validate_backend_command(command: &[String], dsn: &Path) -> Result<(), String> {
    if command.is_empty() || command.iter().any(String::is_empty) {
        return Err("final backend argv is missing or malformed".to_string());
    }
    let (mut seen, mut index) = (BTreeSet::new(), 1);
    while index < command.len() {
        let value = command[index].as_str();
        let name = value.split('=').next().unwrap_or(value);
        if !seen.insert(name) {
            return Err(format!("duplicate backend argv option: {name}"));
        }
        if WITH_VALUE.contains(&name) && value == name && index + 1 < command.len() {
            if name == "-de" && command[index + 1] != dsn.display().to_string() {
                return Err("final backend argv targets a different DSN".to_string());
            }
            index += 2;
        } else if SWITCHES.contains(&value) || (OPTIONS.contains(&name) && value.len() > name.len() + 1) {
            index += 1;
        } else {
            return Err(format!("unknown or malformed backend argv option: {value}"));
        }
    }
    if seen.contains("-de") { Ok(()) } else { Err("final backend argv does not name its admitted DSN".to_string()) }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn argv(items: &[&str]) -> Vec<String> {
        items.iter().map(|item| item.to_string()).collect()
    }

    fn check(items: &[&str]) -> Result<(), String> {
        validate_backend_command(&argv(items), Path::new("/m.dsn"))
    }

    #[test]
    fn the_job_command_passes() {
        assert_eq!(check(&["fr", "-de", "/m.dsn", "-do", "o.ses", "-mp", "40", "--router.min_trace_width_um=150", "--report=r.json", "--diagnose", "--max-time=30"]), Ok(()));
    }

    #[test]
    fn duplicates_unknowns_and_other_models_are_refused() {
        assert_eq!(check(&[]).unwrap_err(), "final backend argv is missing or malformed");
        assert_eq!(check(&["fr", "-de", "/other.dsn"]).unwrap_err(), "final backend argv targets a different DSN");
        assert_eq!(check(&["fr", "-de", "/m.dsn", "--max-time=1", "--max-time=2"]).unwrap_err(), "duplicate backend argv option: --max-time");
        assert_eq!(check(&["fr", "-de", "/m.dsn", "--config=x"]).unwrap_err(), "unknown or malformed backend argv option: --config=x");
        assert_eq!(check(&["fr", "-de", "/m.dsn", "--report="]).unwrap_err(), "unknown or malformed backend argv option: --report=");
        assert_eq!(check(&["fr", "--diagnose"]).unwrap_err(), "final backend argv does not name its admitted DSN");
    }
}
