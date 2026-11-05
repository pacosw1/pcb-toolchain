//! The rules of the check, from the .kicad_pro next to the board and its .kicad_dru. Clearance = max(both net class clearances, last
//! matching .kicad_dru clearance rule). Rule terms we cannot evaluate: a positive term skips the rule; a negated exemption "!(...)"
//! is ignored (the rule applies; conservative).
use super::items::Kind;
use crate::kicad::board::Board;
use crate::model::dru::parse_rules;
use crate::model::selector::{Decider, Selector, Stop};
use crate::model::text::glob_match;
use crate::route_features::{mm, spelled_out};
use regex_lite::Regex;
use serde::Deserialize;
use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::fs;
use std::path::Path;

const DEFAULT_CLASS: &str = "Default";
/// KiCad's own defaults when a project does not set them.
const DEFAULT_EDGE_MM: f64 = 0.3;
const DEFAULT_HOLE_MM: f64 = 0.25;
/// The exemption terms a rule may lose: `&& !(...)`, three brackets deep at most.
const EXEMPTION: &str = r"&&\s*!\((?:[^()]|\((?:[^()]|\([^()]*\))*\))*\)";
/// How much of a condition a note shows.
const NOTE_CHARS: usize = 80;

#[derive(Debug, Clone, PartialEq, Deserialize)]
pub struct NetClass {
    pub name: String,
    pub track_width: f64,
    pub clearance: f64,
    pub via_diameter: f64,
}

impl NetClass {
    /// The grid pitch of a net of this class.
    pub fn pitch(&self) -> f64 {
        self.track_width + self.clearance
    }
}

#[derive(Debug, Default, Deserialize)]
#[serde(default)]
struct Project {
    net_settings: NetSettings,
    board: ProjectBoard,
}

#[derive(Debug, Default, Deserialize)]
#[serde(default)]
struct NetSettings {
    classes: Vec<NetClass>,
    netclass_patterns: Option<Vec<ClassPattern>>,
    netclass_assignments: Option<BTreeMap<String, Assignment>>,
}

#[derive(Debug, Deserialize)]
struct ClassPattern {
    netclass: String,
    pattern: String,
}

/// One class, or a list that starts with the one that counts.
#[derive(Debug, Deserialize)]
#[serde(untagged)]
enum Assignment {
    One(String),
    Many(Vec<String>),
}

impl Assignment {
    fn class(&self) -> Option<&str> {
        match self {
            Assignment::One(name) => Some(name),
            Assignment::Many(names) => names.first().map(String::as_str),
        }
    }
}

#[derive(Debug, Default, Deserialize)]
#[serde(default)]
struct ProjectBoard {
    design_settings: DesignSettings,
}

#[derive(Debug, Default, Deserialize)]
#[serde(default)]
struct DesignSettings {
    rules: RuleSettings,
}

#[derive(Debug, Default, Deserialize)]
#[serde(default)]
struct RuleSettings {
    min_copper_edge_clearance: Option<f64>,
    min_hole_clearance: Option<f64>,
    min_track_width: Option<f64>,
}

/// A set value, or `default` for none and for 0.
fn set_or(value: Option<f64>, default: f64) -> f64 {
    value.filter(|v| *v != 0.0).unwrap_or(default)
}

struct ClearanceRule {
    text: String,
    condition: Selector,
    /// The condition without its exemptions, when it has any.
    without_exemptions: Option<Selector>,
    min: f64,
}

impl ClearanceRule {
    fn holds(&self, a: Decider, b: Decider, notes: &mut BTreeSet<String>) -> bool {
        match self.condition.decide(a, b) {
            Ok(hit) => hit,
            Err(Stop::Unreadable(_)) => false,
            Err(Stop::Unsupported(_)) => {
                let hit = self.without_exemptions.as_ref().is_some_and(|relaxed| relaxed.decide(a, b).unwrap_or(false));
                if hit {
                    notes.insert(format!("dru exemption ignored (conservative): {}", self.text.chars().take(NOTE_CHARS).collect::<String>()));
                }
                hit
            }
        }
    }
}

pub struct Rules {
    classes: BTreeMap<String, NetClass>,
    patterns: Vec<ClassPattern>,
    assignments: BTreeMap<String, Assignment>,
    /// The class KiCad gives each net.
    board_classes: BTreeMap<String, String>,
    pub edge: f64,
    pub hole: f64,
    pub min_track: f64,
    clearance_rules: Vec<ClearanceRule>,
    pub notes: BTreeSet<String>,
    known: HashMap<(String, Kind, String), f64>,
}

fn clearance_rules(dru: &str) -> Result<Vec<ClearanceRule>, String> {
    let exemption = Regex::new(EXEMPTION).map_err(|e| e.to_string())?;
    let mut out = Vec::new();
    for rule in parse_rules(dru)? {
        let text = &rule.condition.text;
        let relaxed = exemption.replace_all(text, "");
        for constraint in rule.constraints.iter().filter(|c| c.kind == "clearance") {
            let Some(min) = constraint.values.get("min") else { continue };
            out.push(ClearanceRule {
                text: text.clone(),
                condition: Selector::new(&spelled_out(text)),
                without_exemptions: (relaxed != *text).then(|| Selector::new(&spelled_out(&relaxed))),
                min: mm(min)?,
            });
        }
    }
    Ok(out)
}

impl Rules {
    /// The rules beside `pcb`. No project is the defaults; no rule file is no rule.
    pub fn read(board: &Board, pcb: &Path) -> Result<Rules, String> {
        let project = pcb.with_extension("kicad_pro");
        let project = if project.exists() { fs::read_to_string(&project).map_err(|e| format!("{}: {e}", project.display()))? } else { "{}".to_string() };
        let dru = pcb.with_extension("kicad_dru");
        let dru = if dru.exists() { Some(fs::read_to_string(&dru).map_err(|e| format!("{}: {e}", dru.display()))?) } else { None };
        Rules::of(board, &project, dru.as_deref())
    }

    pub fn of(board: &Board, project: &str, dru: Option<&str>) -> Result<Rules, String> {
        let project: Project = serde_json::from_str(project).map_err(|e| format!(".kicad_pro: {e}"))?;
        let settings = project.net_settings;
        let mut classes: BTreeMap<String, NetClass> = settings.classes.into_iter().map(|c| (c.name.clone(), c)).collect();
        classes.entry(DEFAULT_CLASS.to_string()).or_insert_with(|| NetClass { name: DEFAULT_CLASS.to_string(), track_width: 0.2, clearance: 0.2, via_diameter: 0.6 });
        let limits = project.board.design_settings.rules;
        Ok(Rules {
            classes,
            patterns: settings.netclass_patterns.unwrap_or_default(),
            assignments: settings.netclass_assignments.unwrap_or_default(),
            board_classes: board.nets.clone(),
            edge: set_or(limits.min_copper_edge_clearance, DEFAULT_EDGE_MM),
            hole: set_or(limits.min_hole_clearance, DEFAULT_HOLE_MM),
            min_track: set_or(limits.min_track_width, 0.0),
            clearance_rules: dru.map(clearance_rules).transpose()?.unwrap_or_default(),
            notes: BTreeSet::new(),
            known: HashMap::new(),
        })
    }

    /// The first class of KiCad's that this project has, Default aside: a net of several classes names them with commas.
    fn board_class(&self, net: &str) -> Option<&str> {
        self.board_classes.get(net)?.split(',').find(|name| *name != DEFAULT_CLASS && self.classes.contains_key(*name))
    }

    /// An assignment, else the first pattern that gives a class other than Default, else KiCad's class of the net.
    pub fn class(&self, net: &str) -> &NetClass {
        let assigned = self.assignments.get(net).and_then(Assignment::class);
        let named = assigned
            .or_else(|| self.patterns.iter().filter(|p| glob_match(net, &p.pattern)).map(|p| p.netclass.as_str()).find(|name| *name != DEFAULT_CLASS))
            .or_else(|| self.board_class(net));
        named.and_then(|name| self.classes.get(name)).unwrap_or(&self.classes[DEFAULT_CLASS])
    }

    /// Clearance between an item of `net_a` and a track of `net_b`.
    pub fn clearance(&mut self, net_a: &str, kind_a: Kind, net_b: &str) -> f64 {
        let key = (net_a.to_string(), kind_a, net_b.to_string());
        if let Some(value) = self.known.get(&key) {
            return *value;
        }
        let (class_a, class_b) = (self.class(net_a).clone(), self.class(net_b).clone());
        let a = Decider { net: Some(net_a), class: Some(&class_a.name), kind: Some(kind_a.rule_type()) };
        let b = Decider { net: Some(net_b), class: Some(&class_b.name), kind: Some(Kind::Track.rule_type()) };
        let mut value = class_a.clearance.max(class_b.clearance);
        let notes = &mut self.notes;
        // Later rules win. Every rule is asked, so each ignored exemption gets its note.
        let held: Vec<f64> = self.clearance_rules.iter().filter(|rule| rule.holds(a, b, notes) || rule.holds(b, a, notes)).map(|rule| rule.min).collect();
        if let Some(last) = held.last() {
            value = value.max(*last);
        }
        self.known.insert(key, value);
        value
    }
}
