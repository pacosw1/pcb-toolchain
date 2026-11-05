//! The resolved switches: defaults file, board gate, environment.
use crate::model::text::glob_match;
use crate::sha256::sha256;
use serde::Serialize;
use serde_json::{Map, Value};
use std::collections::{BTreeMap, BTreeSet};
use std::env;
use std::fs;
use std::path::{Component, Path, PathBuf};

pub const FLAGS: [&str; 7] = ["triage_opens", "rule_compiler", "via_off_small_pads", "pin_escape_check", "via_halo", "routing_rules", "fail_fast"];

/// One feature: its `on` switch and the settings beside it, as the files wrote them.
pub type Feature = Map<String, Value>;

#[derive(Debug, Clone, Default, PartialEq)]
pub struct Features {
    pub features: BTreeMap<String, Feature>,
    /// The board folder that was merged in, when there is one.
    pub board_dir: Option<PathBuf>,
}

impl Features {
    pub fn get(&self, name: &str) -> Option<&Feature> {
        self.features.get(name)
    }

    /// A setting of a feature.
    pub fn setting(&self, feature: &str, key: &str) -> Option<&Value> {
        self.get(feature)?.get(key)
    }
}

/// What the process environment says. Read once, so tests can state their own.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Env {
    pub root: PathBuf,
    pub board: String,
    pub features_file: Option<PathBuf>,
    pub overrides: String,
}

impl Env {
    pub fn current() -> Env {
        let text = |name: &str| env::var(name).unwrap_or_default();
        let file = text("ROUTE_FEATURES_FILE");
        Env { root: root(), board: text("ROUTE_BOARD"), features_file: (!file.is_empty()).then(|| file.into()), overrides: text("ROUTE_FEATURES") }
    }
}

/// The project root: `IOT_LAB`, the nearest parent of the current folder with
/// hardware-design/boards, the folder that holds the tools this binary came from.
pub fn root() -> PathBuf {
    let real = |path: PathBuf| fs::canonicalize(&path).unwrap_or(path);
    if let Some(value) = env::var_os("IOT_LAB").filter(|v| !v.is_empty()) {
        return real(value.into());
    }
    let cwd = env::current_dir().ok().map(real);
    let marked = cwd.as_deref().and_then(|dir| dir.ancestors().find(|d| d.join("hardware-design/boards").is_dir()).map(Path::to_path_buf));
    marked.or_else(tools_root).or(cwd).unwrap_or_default()
}

fn tools_root() -> Option<PathBuf> {
    let exe = env::current_exe().ok()?;
    exe.ancestors().find(|dir| dir.join("tools/route-features.json").is_file()).map(Path::to_path_buf)
}

pub fn defaults_path() -> PathBuf {
    root().join("tools/route-features.json")
}

/// `os.path.abspath`: absolute and free of `.` and `..`, without touching the file system.
fn absolute(path: &Path) -> PathBuf {
    let full = std::path::absolute(path).unwrap_or_else(|_| path.to_path_buf());
    let mut out = PathBuf::new();
    for part in full.components() {
        match part {
            Component::ParentDir => {
                out.pop();
            }
            Component::CurDir => {}
            other => out.push(other),
        }
    }
    out
}

/// The board folder (hardware-design/boards/<B>), when there is one.
pub fn board_dir(env: &Env, pcb: Option<&Path>, board: Option<&str>) -> Option<PathBuf> {
    let boards = env.root.join("hardware-design/boards");
    let board = board.filter(|b| !b.is_empty()).unwrap_or(&env.board);
    if !board.is_empty() {
        let dir = boards.join(board);
        return dir.is_dir().then_some(dir);
    }
    let pcb = pcb?;
    // Revision B keeps its CAD under BASE-PWR, but owns BASE-PWR-B's gate.
    let named = boards.join(pcb.file_stem().unwrap_or_default());
    if named.join("gate.json").is_file() {
        return Some(named);
    }
    let full = absolute(pcb);
    full.ancestors().skip(1).take(4).find(|dir| dir.join("gate.json").is_file()).map(Path::to_path_buf)
}

fn read_json(path: &Path) -> Result<Value, String> {
    let text = fs::read_to_string(path).map_err(|e| format!("{}: {e}", path.display()))?;
    serde_json::from_str(&text).map_err(|e| format!("{}: {e}", path.display()))
}

fn switch(text: &str) -> bool {
    !matches!(text.trim(), "0" | "off" | "false" | "")
}

/// The resolved features for a board, from the process environment.
pub fn load(pcb: Option<&Path>, board: Option<&str>) -> Result<Features, String> {
    load_with(&Env::current(), pcb, board)
}

pub fn load_with(env: &Env, pcb: Option<&Path>, board: Option<&str>) -> Result<Features, String> {
    let defaults = env.features_file.clone().unwrap_or_else(|| env.root.join("tools/route-features.json"));
    let raw = read_json(&defaults)?;
    let mut features = feature_map(raw.get("features")).ok_or_else(|| format!("{}: no features", defaults.display()))?;
    let dir = board_dir(env, pcb, board);
    if let Some(gate) = dir.as_ref().map(|d| d.join("gate.json")).filter(|gate| gate.is_file()) {
        for (name, over) in feature_map(read_json(&gate)?.get("route_features")).unwrap_or_default() {
            features.entry(name).or_default().extend(over);
        }
    }
    apply_overrides(&mut features, &env.overrides)?;
    Ok(Features { features, board_dir: dir })
}

fn feature_map(value: Option<&Value>) -> Option<BTreeMap<String, Feature>> {
    let features = value?.as_object()?;
    Some(features.iter().filter_map(|(name, body)| Some((name.clone(), body.as_object()?.clone()))).collect())
}

/// `all=` goes first, so "all=0,via_halo=1" works. An unknown name other than a flag of `all` is ignored.
fn apply_overrides(features: &mut BTreeMap<String, Feature>, text: &str) -> Result<(), String> {
    let items: Vec<(&str, &str)> = text.split(',').filter_map(|item| item.split_once('=')).collect();
    for (_, value) in items.iter().filter(|(name, _)| name.trim() == "all") {
        for flag in FLAGS {
            let feature = features.get_mut(flag).ok_or_else(|| format!("no feature {flag} for ROUTE_FEATURES all="))?;
            feature.insert("on".to_string(), switch(value).into());
        }
    }
    for (name, value) in &items {
        if let Some(feature) = features.get_mut(name.trim()) {
            feature.insert("on".to_string(), switch(value).into());
        }
    }
    Ok(())
}

/// Python's truth of a JSON value.
fn truthy(value: Option<&Value>) -> bool {
    match value {
        None | Some(Value::Null) => false,
        Some(Value::Bool(flag)) => *flag,
        Some(Value::Number(number)) => number.as_f64() != Some(0.0),
        Some(Value::String(text)) => !text.is_empty(),
        Some(Value::Array(items)) => !items.is_empty(),
        Some(Value::Object(map)) => !map.is_empty(),
    }
}

pub fn on(features: &Features, name: &str) -> bool {
    truthy(features.setting(name, "on"))
}

pub fn summary(features: &Features) -> String {
    let parts: Vec<String> = FLAGS.iter().map(|flag| format!("{flag}={}", if on(features, flag) { "on" } else { "off" })).collect();
    parts.join(" ")
}

/// Exact CAD and rule identity for learned hints: the SHA-256 of each file of the board that exists, by extension.
pub fn source_fingerprint(pcb: &Path) -> Result<BTreeMap<String, String>, String> {
    let mut digests = BTreeMap::new();
    for extension in ["kicad_pcb", "kicad_pro", "kicad_dru"] {
        let file = pcb.with_extension(extension);
        if file.is_file() {
            let bytes = fs::read(&file).map_err(|e| format!("{}: {e}", file.display()))?;
            digests.insert(format!(".{extension}"), sha256(&bytes));
        }
    }
    Ok(digests)
}

/// What the job records about the learned halo file.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct HaloEvidence {
    pub path: String,
    pub sha256: String,
    pub accepted: bool,
}

/// The nets `<board>/.gate/halo-nets.json` lists, when it was learned from exactly this CAD. Old unstamped files are refused.
pub fn learned_halo(pcb: &Path, board_dir: Option<&Path>) -> Result<(Vec<String>, Option<HaloEvidence>), String> {
    let Some(path) = board_dir.map(|dir| dir.join(".gate/halo-nets.json")).filter(|path| path.is_file()) else {
        return Ok((Vec::new(), None));
    };
    let data = fs::read(&path).map_err(|e| format!("{}: {e}", path.display()))?;
    let raw: Value = serde_json::from_slice(&data).map_err(|e| format!("{}: {e}", path.display()))?;
    let wanted = serde_json::to_value(source_fingerprint(pcb)?).map_err(|e| e.to_string())?;
    let accepted = raw.get("source_fingerprint") == Some(&wanted);
    let nets = if accepted { strings(raw.get("nets")) } else { Vec::new() };
    Ok((nets, Some(HaloEvidence { path: path.display().to_string(), sha256: sha256(&data), accepted })))
}

fn strings(value: Option<&Value>) -> Vec<String> {
    let items = value.and_then(Value::as_array).map_or(&[][..], Vec::as_slice);
    items.iter().filter_map(Value::as_str).map(str::to_string).collect()
}

/// Nets that get the via halo padstack (feature via_halo). With no list at all, every routed net.
pub fn halo_nets(features: &Features, nets: &[String], net_class: &BTreeMap<String, String>, board_dir: Option<&Path>, pcb: Option<&Path>) -> Result<Vec<String>, String> {
    let halo = features.get("via_halo").ok_or("no feature via_halo")?;
    let classes = strings(halo.get("classes"));
    let mut globs = strings(halo.get("nets"));
    if let (Some(dir), Some(name)) = (board_dir, halo.get("fast_nets_file").and_then(Value::as_str).filter(|name| !name.is_empty())) {
        let file = dir.join(name);
        if file.is_file() {
            globs.extend(strings(read_json(&file)?.get("fast")));
        }
    }
    if let Some(pcb) = pcb.filter(|_| truthy(halo.get("learn_noroom"))) {
        globs.extend(learned_halo(pcb, board_dir)?.0);
    }
    let everything = globs.is_empty() && classes.is_empty();
    let wanted = |net: &String| everything || globs.iter().any(|g| glob_match(net, g)) || net_class.get(net).is_some_and(|c| classes.contains(c));
    let picked: BTreeSet<String> = nets.iter().filter(|net| wanted(net)).cloned().collect();
    Ok(picked.into_iter().collect())
}
