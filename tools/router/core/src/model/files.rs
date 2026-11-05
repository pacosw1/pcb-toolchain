//! The files beside a board that the model reads: gate, project, planes, pairs, current paths, thermal vias, and the pin ratings
//! of the tools folder. Each is typed by what the model uses of it; the gate keeps checking the rest.
use super::dru::{Rule, parse_rules};
use super::num::Num;
use serde::Deserialize;
use serde::de::DeserializeOwned;
use serde_json::value::RawValue;
use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};

#[derive(Debug, Default, Deserialize)]
pub struct Gate {
    pub project: String,
    #[serde(default)]
    pub checks: Checks,
    #[serde(default)]
    pub route_features: RouteFeatures,
}

#[derive(Debug, Default, Deserialize)]
pub struct Checks {
    pub kicad_happy: Option<HappyCheck>,
    pub viapads: Option<ViaPadsCheck>,
}

/// `true`, or an object with settings.
#[derive(Debug, Deserialize)]
#[serde(untagged)]
pub enum HappyCheck {
    Settings(HappySettings),
    Flag(bool),
}

#[derive(Debug, Default, Deserialize)]
pub struct HappySettings {
    pub return_planes: Option<String>,
    pub exempt: Option<String>,
    #[serde(default)]
    pub grounds: Vec<String>,
}

impl Checks {
    /// The gate runs kicad-happy on this board.
    pub fn happy_enabled(&self) -> bool {
        match &self.kicad_happy {
            Some(HappyCheck::Flag(on)) => *on,
            Some(HappyCheck::Settings(_)) => true,
            None => false,
        }
    }

    pub fn happy_settings(&self) -> Option<&HappySettings> {
        match &self.kicad_happy {
            Some(HappyCheck::Settings(s)) => Some(s),
            _ => None,
        }
    }

    /// Pads that may hold a via, as REF.NUM.
    pub fn via_pad_allow(&self) -> &[String] {
        match &self.viapads {
            Some(ViaPadsCheck::Settings { allow }) => allow,
            _ => &[],
        }
    }
}

#[derive(Debug, Deserialize)]
#[serde(untagged)]
pub enum ViaPadsCheck {
    Settings {
        #[serde(default)]
        allow: Vec<String>,
    },
    Flag(bool),
}

#[derive(Debug, Default, Deserialize)]
pub struct RouteFeatures {
    pub rule_compiler: Option<RuleCompiler>,
}

#[derive(Debug, Deserialize)]
#[serde(untagged)]
pub enum RuleCompiler {
    Settings {
        #[serde(default)]
        extra: Vec<LayerDeny>,
    },
    Flag(bool),
}

/// Layers a set of nets or classes may not use.
#[derive(Debug, Deserialize)]
pub struct LayerDeny {
    #[serde(default)]
    pub nets: Vec<String>,
    #[serde(default)]
    pub classes: Vec<String>,
    #[serde(default)]
    pub deny_layers: Vec<String>,
}

#[derive(Debug, Deserialize)]
pub struct Project {
    pub net_settings: NetSettings,
    pub board: ProjectBoard,
}

#[derive(Debug, Deserialize)]
pub struct NetSettings {
    pub classes: Vec<ProjectClass>,
}

#[derive(Debug, Deserialize)]
pub struct ProjectClass {
    pub name: String,
    pub track_width: Option<Num>,
    pub clearance: Option<Num>,
    pub via_diameter: Option<Num>,
    pub via_drill: Option<Num>,
}

#[derive(Debug, Deserialize)]
pub struct ProjectBoard {
    pub design_settings: DesignSettings,
}

#[derive(Debug, Deserialize)]
pub struct DesignSettings {
    pub rules: DesignRules,
}

#[derive(Debug, Default, Deserialize)]
pub struct DesignRules {
    pub min_via_diameter: Option<Num>,
    pub min_through_hole_diameter: Option<Num>,
    pub min_clearance: Option<Num>,
    pub min_track_width: Option<Num>,
    pub min_copper_edge_clearance: Option<Num>,
    pub min_resolved_spokes: Option<Num>,
    pub min_hole_clearance: Option<Num>,
    pub min_hole_to_hole: Option<Num>,
    pub min_via_annular_width: Option<Num>,
}

/// reference-planes.json, the keys the router reads.
#[derive(Debug, Default, Deserialize)]
#[serde(default)]
pub struct PlaneSpec {
    pub adjacent: BTreeMap<String, String>,
    pub plane_layers: Vec<String>,
    pub grounds: Vec<String>,
    pub via_allow_mm: Option<Num>,
    pub alt_refs: BTreeMap<String, AltRef>,
    pub domains: BTreeMap<String, Vec<String>>,
    pub exempt: Exempt,
    pub mixed_layers: BTreeMap<String, MixedLayer>,
    pub fast_file: Option<String>,
    pub power: Vec<String>,
}

#[derive(Debug, Default, Deserialize)]
pub struct AltRef {
    pub domain: String,
    pub cap_mm: Option<Num>,
    #[serde(default)]
    pub slow_only: bool,
}

#[derive(Debug, Default, Deserialize)]
#[serde(default)]
pub struct Exempt {
    pub nets: BTreeMap<String, String>,
    pub areas: Vec<ExemptArea>,
}

#[derive(Debug, Deserialize)]
pub struct ExemptArea {
    #[serde(rename = "box")]
    pub bounds: [Num; 4],
    pub nets: Vec<String>,
}

#[derive(Debug, Default, Deserialize)]
pub struct MixedLayer {
    pub fast_file: String,
    #[serde(default)]
    pub power: Vec<String>,
}

#[derive(Debug, Default, Deserialize)]
struct FastNets {
    #[serde(default)]
    fast: Vec<String>,
}

#[derive(Debug, Default, Deserialize)]
struct DiffPairsFile {
    #[serde(default)]
    pairs: Vec<Box<RawValue>>,
}

#[derive(Debug, Deserialize)]
struct PairNames {
    p: String,
    n: String,
}

/// A diff pair: its two nets, and the entry as the file has it, which the model passes on.
#[derive(Debug)]
pub struct DiffPair {
    pub p: String,
    pub n: String,
    pub raw: Box<RawValue>,
}

#[derive(Debug, Default, Deserialize)]
pub struct CurrentPaths {
    #[serde(rename = "dT")]
    pub dt: Option<Num>,
    pub via_plating_mm: Option<Num>,
    #[serde(default)]
    pub nets: BTreeMap<String, NetPaths>,
}

/// A net's current: the fields of one chain, or `chains`.
#[derive(Debug, Default, Deserialize)]
pub struct NetPaths {
    pub amps: Option<Num>,
    #[serde(default)]
    pub pads: Vec<String>,
    #[serde(default)]
    pub parallel: bool,
    pub chains: Option<Vec<Chain>>,
}

impl NetPaths {
    /// The net's chains, its own fields being one when it lists none.
    pub fn chains(&self) -> Vec<Chain> {
        self.chains.clone().unwrap_or_else(|| vec![Chain { amps: self.amps, pads: self.pads.clone(), parallel: self.parallel }])
    }
}

#[derive(Debug, Clone, Default, Deserialize)]
pub struct Chain {
    pub amps: Option<Num>,
    #[serde(default)]
    pub pads: Vec<String>,
    #[serde(default)]
    pub parallel: bool,
}

/// thermal-vias.json: `{"pads": {"U4.9": {...}}}`. Every key is required; the model refuses a pad entry that lacks one.
#[derive(Debug, Default, Deserialize)]
pub struct ThermalFile {
    #[serde(default)]
    pub pads: BTreeMap<String, ThermalSpec>,
}

#[derive(Debug, Clone, Default, Deserialize)]
pub struct ThermalSpec {
    pub long: Option<Num>,
    pub short: Option<Num>,
    pub pitch_long: Option<Num>,
    pub pitch_short: Option<Num>,
    pub drill: Option<Num>,
    pub diameter: Option<Num>,
    pub source: Option<String>,
}

#[derive(Debug, Default, Deserialize)]
pub struct ExemptEntry {
    pub rule: Option<String>,
    pub net: Option<String>,
}

#[derive(Debug, Default, Deserialize)]
pub struct PinRatings {
    pub parts: BTreeMap<String, PartRating>,
}

#[derive(Debug, Deserialize)]
pub struct PartRating {
    pub mpn: Vec<String>,
    pub pins: BTreeMap<String, PinRating>,
}

#[derive(Debug, Deserialize)]
pub struct PinRating {
    pub amps: Num,
    pub name: String,
    pub source: String,
}

/// Everything the model reads beside the board itself.
#[derive(Debug)]
pub struct BoardFiles {
    pub folder: PathBuf,
    pub gate: Gate,
    pub project: Project,
    pub rules: Vec<Rule>,
    pub planes: PlaneSpec,
    /// rp001-fast-nets.json.
    pub fast: Vec<String>,
    pub pairs: Vec<DiffPair>,
    pub paths: CurrentPaths,
    pub thermal: ThermalFile,
    /// Net patterns of fast_file and of each mixed layer: si_planes.is_fast.
    pub fast_top: Vec<String>,
    pub fast_mixed: Vec<Vec<String>>,
}

fn read_json<T: DeserializeOwned>(path: &Path) -> Result<T, String> {
    let text = fs::read_to_string(path).map_err(|e| format!("{}: {e}", path.display()))?;
    serde_json::from_str(&text).map_err(|e| format!("{}: {e}", path.display()))
}

fn read_optional<T: DeserializeOwned + Default>(path: &Path) -> Result<T, String> {
    if path.exists() { read_json(path) } else { Ok(T::default()) }
}

fn gate_of(folder: &Path) -> Result<Gate, String> {
    let found = ["gate.json", "gate.pending.json"].iter().map(|n| folder.join(n)).find(|p| p.exists());
    read_json(&found.ok_or_else(|| format!("no gate.json / gate.pending.json in {}", folder.display()))?)
}

fn read_pairs(path: &Path) -> Result<Vec<DiffPair>, String> {
    let file: DiffPairsFile = read_optional(path)?;
    file.pairs.into_iter().map(|raw| {
        let names: PairNames = serde_json::from_str(raw.get()).map_err(|e| format!("{}: {e}", path.display()))?;
        Ok(DiffPair { p: names.p, n: names.n, raw })
    }).collect()
}

fn fast_patterns(path: &Path) -> Result<Vec<String>, String> {
    let file: FastNets = read_json(path)?;
    if file.fast.is_empty() { Err(format!("{}: \"fast\" must be a list of net patterns", path.display())) } else { Ok(file.fast) }
}

impl BoardFiles {
    pub fn load(folder: &Path) -> Result<BoardFiles, String> {
        let gate = gate_of(folder)?;
        let project_base = folder.join(&gate.project);
        let planes: PlaneSpec = read_optional(&folder.join("reference-planes.json"))?;
        let fast_mixed = planes.mixed_layers.values().map(|m| fast_patterns(&folder.join(&m.fast_file))).collect::<Result<_, _>>()?;
        let fast_top = planes.fast_file.as_ref().map_or(Ok(Vec::new()), |f| read_json::<FastNets>(&folder.join(f)).map(|n| n.fast))?;
        let dru = project_base.with_extension("kicad_dru");
        let rules = if dru.exists() { parse_rules(&fs::read_to_string(&dru).map_err(|e| format!("{}: {e}", dru.display()))?)? } else { Vec::new() };
        Ok(BoardFiles {
            project: read_json(&project_base.with_extension("kicad_pro"))?,
            fast: read_optional::<FastNets>(&folder.join("rp001-fast-nets.json"))?.fast,
            pairs: read_pairs(&folder.join("diff-pairs.json"))?,
            paths: read_optional(&folder.join("current-paths.json"))?,
            thermal: read_optional(&folder.join("thermal-vias.json"))?,
            folder: folder.to_path_buf(),
            gate,
            rules,
            planes,
            fast_top,
            fast_mixed,
        })
    }

    pub fn project_base(&self) -> PathBuf {
        self.folder.join(&self.gate.project)
    }

    pub fn rules_setup(&self) -> &DesignRules {
        &self.project.board.design_settings.rules
    }
}

pub fn read_pin_ratings(tools: &Path) -> Result<PinRatings, String> {
    read_json(&tools.join("pin-ratings.json"))
}

pub fn read_plane_spec(path: &Path) -> Result<PlaneSpec, String> {
    read_json(path)
}

pub fn read_exempt(path: &Path) -> Result<Vec<ExemptEntry>, String> {
    read_json(path)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_check_may_be_a_flag_or_an_object() {
        let on: Checks = serde_json::from_str(r#"{"kicad_happy": true, "viapads": {"allow": ["U1.9"]}}"#).unwrap();
        assert!(on.happy_enabled() && on.happy_settings().is_none());
        assert_eq!(on.via_pad_allow(), ["U1.9"]);
        let set: Checks = serde_json::from_str(r#"{"kicad_happy": {"exempt": "x.json", "grounds": ["GND"]}, "viapads": true}"#).unwrap();
        assert_eq!(set.happy_settings().unwrap().grounds, ["GND"]);
        assert!(set.via_pad_allow().is_empty());
        let off: Checks = serde_json::from_str(r#"{"kicad_happy": false}"#).unwrap();
        assert!(!off.happy_enabled());
    }

    #[test]
    fn a_net_has_one_chain_or_many() {
        let p: CurrentPaths = serde_json::from_str(r#"{"dT": 10, "nets": {"A": {"amps": 1.5, "pads": ["J1.1"]}, "B": {"chains": [{"amps": 2, "pads": ["J2.1"], "parallel": true}]}}}"#).unwrap();
        assert_eq!(p.dt, Some(Num::Int(10)));
        assert_eq!(p.nets["A"].chains()[0].amps, Some(Num::Float(1.5)));
        assert!(p.nets["B"].chains()[0].parallel);
    }

    #[test]
    fn the_spec_defaults_every_missing_key() {
        let s: PlaneSpec = serde_json::from_str(r#"{"grounds": ["GND"], "alt_refs": {"VBAT": {"domain": "GND", "cap_mm": 3}}, "exempt": {"areas": [{"box": [1, 2, 3.5, 4], "nets": ["A"]}]}}"#).unwrap();
        assert_eq!(s.alt_refs["VBAT"].cap_mm, Some(Num::Int(3)));
        assert_eq!(s.exempt.areas[0].bounds[2], Num::Float(3.5));
        assert!(s.adjacent.is_empty());
    }
}
