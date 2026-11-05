//! The job's command line. The names and defaults are the ones callers already pass; `configuration` in the job's files is this struct.
use serde::Serialize;
use std::collections::BTreeMap;

const OPTIMIZER: [&str; 3] = ["always", "off", "if-routed"];

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Args {
    pub board: String,
    pub outdir: String,
    pub passes: i64,
    pub quality_backend_manifest: Option<String>,
    pub layers: String,
    pub skip_net: String,
    pub gnd_vias: bool,
    pub plane_nets: String,
    pub only_nets: String,
    pub route_planes: bool,
    pub neck_um: i64,
    pub via_args: String,
    pub pairs_json: String,
    pub max_time: i64,
    pub threads: i64,
    pub optimizer: String,
    pub preflight: bool,
    pub native_thermal_checkback: bool,
    pub render: bool,
    pub set: Vec<String>,
    pub signal_via: f64,
    pub signal_via_classes: String,
    pub signal_via_nets: String,
    pub unlock_nets: String,
    pub snapshot_interval_s: f64,
}

impl Args {
    fn new(board: String, outdir: String, manifest: Option<String>) -> Args {
        Args {
            board,
            outdir,
            passes: 40,
            quality_backend_manifest: manifest,
            layers: "F.Cu,B.Cu".into(),
            skip_net: "*GND*".into(),
            gnd_vias: false,
            plane_nets: String::new(),
            only_nets: String::new(),
            route_planes: false,
            neck_um: 0,
            via_args: String::new(),
            pairs_json: String::new(),
            max_time: 0,
            threads: 0,
            optimizer: "always".into(),
            preflight: false,
            native_thermal_checkback: false,
            render: false,
            set: Vec::new(),
            signal_via: 0.0,
            signal_via_classes: "FIELD,HOST".into(),
            signal_via_nets: String::new(),
            unlock_nets: String::new(),
            snapshot_interval_s: 5.0,
        }
    }

    /// The layers of the job, in the order given.
    pub fn layer_list(&self) -> Vec<String> {
        items(&self.layers)
    }
}

/// The items of a comma list; an empty item is none.
pub fn items(text: &str) -> Vec<String> {
    text.split(',').filter(|item| !item.is_empty()).map(str::to_string).collect()
}

fn set_name(entry: &str) -> &str {
    entry.split_once('=').map_or(entry, |(name, _)| name)
}

fn check(a: &Args) -> Result<(), String> {
    if a.max_time < 0 || a.threads < 0 || a.passes <= 0 {
        return Err("passes must be positive; time and threads must be nonnegative".into());
    }
    if a.set.iter().any(|entry| matches!(set_name(entry), "router.autorouter.max_threads" | "router.optimizer.max_threads")) {
        return Err("use --threads for admitted autorouter and optimizer caps".into());
    }
    if a.optimizer != "always" && a.set.iter().any(|entry| set_name(entry) == "router.optimizer.enabled") {
        return Err("--optimizer conflicts with --set router.optimizer.enabled".into());
    }
    let operations = !a.plane_nets.is_empty() || a.gnd_vias || a.route_planes || !a.unlock_nets.is_empty() || a.neck_um != 0;
    if a.native_thermal_checkback && (!a.preflight || a.only_nets.is_empty() || operations) {
        return Err("native thermal checkback needs preflight, exact selected nets and no plane/unlock/repair operation".into());
    }
    Ok(())
}

fn number<T: std::str::FromStr>(name: &str, value: &str) -> Result<T, String> {
    value.parse().map_err(|_| format!("{name}: invalid value: {value}"))
}

/// `--name=value` is one word; a value may hold spaces and equals signs of its own, as `--via-args` does.
fn split_word(word: &str) -> (String, Option<String>) {
    match word.split_once('=') {
        Some((name, value)) if word.starts_with("--") && !name.contains(char::is_whitespace) => (name.to_string(), Some(value.to_string())),
        _ => (word.to_string(), None),
    }
}

/// Parses the words after the subcommand. `env` gives the default of `--quality-backend-manifest`.
pub fn parse(words: &[String], env: &BTreeMap<String, String>) -> Result<Args, String> {
    let mut paths = Vec::new();
    let mut options: Vec<(String, Option<String>)> = Vec::new();
    let mut rest = words.iter();
    while let Some(word) = rest.next() {
        if !word.starts_with("--") {
            paths.push(word.clone());
            continue;
        }
        let (name, inline) = split_word(word);
        let flag = matches!(name.as_str(), "--gnd-vias" | "--route-planes" | "--preflight" | "--native-thermal-checkback" | "--render");
        if flag {
            if inline.is_some() {
                return Err(format!("{name}: ignored explicit argument"));
            }
            options.push((name, None));
        } else {
            let value = match inline {
                Some(value) => value,
                None => rest.next().cloned().ok_or_else(|| format!("{name}: expected one argument"))?,
            };
            options.push((name, Some(value)));
        }
    }
    let [board, outdir] = <[String; 2]>::try_from(paths).map_err(|_| "the board and the output folder are required".to_string())?;
    let mut a = Args::new(board, outdir, env.get("FASTROUTE_QUALITY_MANIFEST").filter(|value| !value.is_empty()).cloned());
    for (name, value) in options {
        let text = value.unwrap_or_default();
        match name.as_str() {
            "--gnd-vias" => a.gnd_vias = true,
            "--route-planes" => a.route_planes = true,
            "--preflight" => a.preflight = true,
            "--native-thermal-checkback" => a.native_thermal_checkback = true,
            "--render" => a.render = true,
            "--passes" => a.passes = number(&name, &text)?,
            "--quality-backend-manifest" => a.quality_backend_manifest = Some(text),
            "--layers" => a.layers = text,
            "--skip-net" => a.skip_net = text,
            "--plane-nets" => a.plane_nets = text,
            "--only-nets" => a.only_nets = text,
            "--neck-um" => a.neck_um = number(&name, &text)?,
            "--via-args" => a.via_args = text,
            "--pairs-json" => a.pairs_json = text,
            "--max-time" => a.max_time = number(&name, &text)?,
            "--threads" => a.threads = number(&name, &text)?,
            "--optimizer" if OPTIMIZER.contains(&text.as_str()) => a.optimizer = text,
            "--optimizer" => return Err(format!("--optimizer: invalid choice: {text}")),
            "--set" => a.set.push(text),
            "--signal-via" => a.signal_via = number(&name, &text)?,
            "--signal-via-classes" => a.signal_via_classes = text,
            "--signal-via-nets" => a.signal_via_nets = text,
            "--unlock-nets" => a.unlock_nets = text,
            "--snapshot-interval-s" => a.snapshot_interval_s = number(&name, &text)?,
            other => return Err(format!("unrecognized arguments: {other}")),
        }
    }
    check(&a)?;
    Ok(a)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn words(text: &[&str]) -> Vec<String> {
        text.iter().map(|word| word.to_string()).collect()
    }

    fn args(text: &[&str]) -> Result<Args, String> {
        parse(&words(text), &BTreeMap::new())
    }

    #[test]
    fn the_defaults_are_the_callers_defaults() {
        let a = args(&["b.kicad_pcb", "out"]).unwrap();
        assert_eq!((a.passes, a.layers.as_str(), a.skip_net.as_str(), a.optimizer.as_str(), a.snapshot_interval_s), (40, "F.Cu,B.Cu", "*GND*", "always", 5.0));
    }

    #[test]
    fn a_value_may_be_empty_or_hold_spaces_and_equals() {
        let a = args(&["b", "o", "--skip-net", "", "--via-args=--skip U1 R7.1", "--via-args", "--via 0.5 0.3 --clearance=0.15", "--set", "router.x=1"]).unwrap();
        assert_eq!((a.skip_net.as_str(), a.via_args.as_str(), a.set.as_slice()), ("", "--via 0.5 0.3 --clearance=0.15", &["router.x=1".to_string()][..]));
    }

    #[test]
    fn the_rejections_of_the_job_stand() {
        assert!(args(&["b", "o", "--passes", "0"]).is_err());
        assert!(args(&["b", "o", "--max-time", "-1"]).is_err());
        assert!(args(&["b", "o", "--set", "router.autorouter.max_threads=2"]).unwrap_err().contains("--threads"));
        assert!(args(&["b", "o", "--optimizer", "off", "--set", "router.optimizer.enabled=true"]).unwrap_err().contains("conflicts"));
        assert!(args(&["b", "o", "--optimizer", "sometimes"]).is_err());
        assert!(args(&["b", "o", "--native-thermal-checkback", "--preflight"]).unwrap_err().contains("exact selected nets"));
        assert!(args(&["b", "o", "--native-thermal-checkback", "--preflight", "--only-nets", "A", "--gnd-vias"]).is_err());
        assert!(args(&["b", "o", "--unknown", "1"]).is_err());
        assert!(args(&["b"]).is_err());
    }

    #[test]
    fn the_manifest_default_comes_from_the_environment() {
        let env = BTreeMap::from([("FASTROUTE_QUALITY_MANIFEST".to_string(), "m.json".to_string())]);
        assert_eq!(parse(&words(&["b", "o"]), &env).unwrap().quality_backend_manifest.as_deref(), Some("m.json"));
    }
}
