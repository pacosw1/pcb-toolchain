//! What the project files beside a board add to the model: net classes (.kicad_pro), domain rules (.kicad_dru), and the tables
//! derived from them.

use crate::dru::{self, Rules, fnmatch};
use crate::kicad::doc::{Board, Footprint, Pad, mm};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::path::Path;

/// mm on top of the .kicad_dru no-net creepage: the placer grid and the router do not hit it exactly.
const KEEPOUT_MARGIN: f64 = 0.05;

#[derive(Clone, Debug, Deserialize)]
pub struct NetClass {
    pub name: String,
    pub clearance: f64,
    pub track_width: f64,
    #[serde(default)]
    pub via_diameter: f64,
}

#[derive(Deserialize)]
struct NetSettings {
    classes: Vec<NetClass>,
}

#[derive(Deserialize)]
struct ProjectFile {
    net_settings: NetSettings,
}

pub struct Project {
    pub classes: Vec<NetClass>,
    pub rules: Rules,
    /// The text of the .kicad_dru, empty when there is none.
    pub dru_text: String,
}

impl Project {
    /// The sidecars of a board. A .kicad_pro is required; `domains` replaces the rules of the .kicad_dru.
    pub fn load(board: &Path, domains: Option<&[(String, f64, f64)]>) -> crate::Result<Self> {
        let pro = board.with_extension("kicad_pro");
        let text = std::fs::read_to_string(&pro).map_err(|e| format!("{}: {e}", pro.display()))?;
        let file: ProjectFile = serde_json::from_str(&text).map_err(|e| format!("{}: {e}", pro.display()))?;
        let dru_text = std::fs::read_to_string(board.with_extension("kicad_dru")).unwrap_or_default();
        let rules = match domains {
            Some(given) => Rules { domains: given.to_vec(), ..Rules::default() },
            None => dru::parse(&dru_text),
        };
        Ok(Self { classes: file.net_settings.classes, rules, dru_text })
    }

    pub fn class(&self, name: &str) -> Option<&NetClass> {
        self.classes.iter().find(|c| c.name == name)
    }

    /// {net class: track width + clearance}. The clearance is at least the gap between two classes of the class's domain:
    /// tracks of one domain run together. The domain gap to other nets is a placement spacing, not a track pitch.
    pub fn class_tracks(&self) -> BTreeMap<&str, f64> {
        let pitch = |c: &NetClass| {
            let gaps = self.rules.domains.iter().filter(|d| fnmatch(&c.name, &d.0)).map(|d| d.2);
            c.track_width + gaps.fold(c.clearance, f64::max)
        };
        self.classes.iter().map(|c| (c.name.as_str(), pitch(c))).collect()
    }

    /// {net class: [clearance, track width]}.
    pub fn class_rules(&self) -> BTreeMap<String, [f64; 2]> {
        self.classes.iter().map(|c| (c.name.clone(), [c.clearance, c.track_width])).collect()
    }

    /// The first domain of a pad's class, with its gaps.
    pub fn domain_of(&self, class: &str) -> Option<&(String, f64, f64)> {
        self.rules.domains.iter().find(|d| class.split(',').any(|x| fnmatch(x, &d.0)))
    }

    /// A pad of a class in a pair rule is a domain pad with the net clearance and no class gap.
    pub fn in_pair(&self, class: &str) -> bool {
        let patterns = self.rules.pairs.iter().flat_map(|(a, b, _)| a.iter().chain(b));
        patterns.into_iter().any(|q| class.split(',').any(|x| fnmatch(x, q)))
    }

    /// GetOwnClearance on F.Cu: a pad override, a footprint override, else the net class.
    pub fn pad_clearance(&self, board: &Board, fp: &Footprint, pad: &Pad) -> f64 {
        if let Some(v) = pad.clearance_override.or(fp.clearance_override) {
            return mm(v);
        }
        self.net_clearance(board, &pad.net)
    }

    /// The largest clearance of a net's classes, Default for a class the project does not list.
    pub fn net_clearance(&self, board: &Board, net: &str) -> f64 {
        let class = |name: &str| self.class(name).or_else(|| self.class("Default")).map_or(0.0, |c| c.clearance);
        board.net_class(net).split(',').map(class).fold(0.0, f64::max)
    }
}

/// How the classes of a problem's domain pads are numbered: the first class met is 1.
#[derive(Debug, Default)]
pub struct DomainClasses(pub Vec<String>);

impl DomainClasses {
    pub fn id(&mut self, class: &str) -> i64 {
        let found = self.0.iter().position(|c| c == class);
        let index = found.unwrap_or_else(|| {
            self.0.push(class.to_string());
            self.0.len() - 1
        });
        index as i64 + 1
    }

    fn matching<'a>(&'a self, pattern: &'a str) -> impl Iterator<Item = i64> + 'a {
        let hit = move |name: &str| name.split(',').any(|x| fnmatch(x, pattern));
        self.0.iter().enumerate().filter(move |(_, name)| hit(name)).map(|(k, _)| k as i64 + 1)
    }
}

#[derive(Debug, Serialize)]
pub struct DomainArea {
    pub classes: Vec<i64>,
    pub gap: f64,
}

#[derive(Debug, Serialize)]
pub struct ClassGaps {
    pub names: Vec<String>,
    pub gaps: Vec<Vec<f64>>,
}

/// {class id: gap} from the no-net creepage rules: a domain pad keeps the creepage + a margin to each board keepout.
pub fn keepout_gaps(classes: &DomainClasses, nonet: &[(String, f64)]) -> BTreeMap<String, f64> {
    let mut out: BTreeMap<String, f64> = BTreeMap::new();
    for (pattern, gap) in nonet {
        for id in classes.matching(pattern) {
            let entry = out.entry(id.to_string()).or_insert(0.0);
            *entry = entry.max(gap + KEEPOUT_MARGIN);
        }
    }
    out
}

/// One area per .kicad_dru domain with pads: its class ids and its gap to other nets.
pub fn domain_areas(classes: &DomainClasses, domains: &[(String, f64, f64)]) -> Vec<DomainArea> {
    let area = |(pattern, gap, _): &(String, f64, f64)| {
        let mut ids: Vec<i64> = classes.matching(pattern).collect();
        ids.sort_unstable();
        (!ids.is_empty()).then_some(DomainArea { classes: ids, gap: *gap })
    };
    domains.iter().filter_map(area).collect()
}

/// Gap between domain classes (index = class id, 0 unused): the class gap inside one domain, else the larger gap to other nets
/// of the two domains, and at least the gap of a pair rule between the two classes.
pub fn class_gaps(classes: &DomainClasses, rules: &Rules) -> Option<ClassGaps> {
    if classes.0.is_empty() {
        return None;
    }
    let names: Vec<String> = std::iter::once(String::new()).chain(classes.0.iter().cloned()).collect();
    let hit = |name: &str, patterns: &[String]| patterns.iter().any(|q| name.split(',').any(|x| fnmatch(x, q)));
    let domain = |name: &str| rules.domains.iter().position(|d| hit(name, std::slice::from_ref(&d.0)));
    let gap_of = |d: Option<usize>| d.map_or(0.0, |k| rules.domains[k].1);
    let n = names.len();
    let mut gaps = vec![vec![0.0; n]; n];
    for i in 1..n {
        for j in (1..n).filter(|j| *j != i) {
            let (a, b) = (domain(&names[i]), domain(&names[j]));
            let same = a.filter(|_| a == b);
            let mut g = same.map_or(gap_of(a).max(gap_of(b)), |k| rules.domains[k].2);
            for (pa, pb, pg) in &rules.pairs {
                if (hit(&names[i], pa) && hit(&names[j], pb)) || (hit(&names[i], pb) && hit(&names[j], pa)) {
                    g = g.max(*pg);
                }
            }
            gaps[i][j] = g;
        }
    }
    Some(ClassGaps { names, gaps })
}

#[derive(Debug, Serialize)]
pub struct EscapeRules {
    pub track: f64,
    pub clearance: f64,
    pub via_d: f64,
    pub sources: Vec<String>,
}

/// The numbers of `via_diameter (min N mm)` in a rule text.
fn dru_via_minimums(text: &str) -> Vec<f64> {
    let number = |rest: &str| -> Option<f64> {
        let rest = rest.trim_start().strip_prefix('(')?.strip_prefix("min")?;
        let rest = rest.trim_start();
        let end = rest.find(|c: char| !(c.is_ascii_digit() || c == '.'))?;
        rest[end..].trim_start().starts_with("mm)").then(|| rest[..end].parse().ok())?
    };
    text.match_indices("via_diameter").filter_map(|(at, word)| number(&text[at + word.len()..])).collect()
}

/// Pin-escape corridor rules: the Default class track and clearance, and the largest of the Default via diameter, the board
/// minimum via diameter and the .kicad_dru via_diameter minimums.
pub fn escape_rules(board: &Board, project: &Project) -> EscapeRules {
    let default = project.class("Default");
    let mut vias = vec![default.map_or(0.0, |c| c.via_diameter), mm(board.constraints.min_via_size)];
    let mut sources = vec!["Default class (.kicad_pro)".to_string(), "board minimum via diameter".to_string()];
    let found = dru_via_minimums(&project.dru_text);
    if !found.is_empty() {
        vias.push(found.iter().copied().fold(f64::MIN, f64::max));
        sources.push(".kicad_dru via_diameter min".to_string());
    }
    EscapeRules {
        track: default.map_or(mm(board.constraints.min_track_width), |c| c.track_width),
        clearance: default.map_or(mm(board.constraints.min_clearance), |c| c.clearance),
        via_d: vias.into_iter().fold(f64::MIN, f64::max),
        sources,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn via_minimums_come_from_the_rule_text() {
        assert_eq!(dru_via_minimums("(constraint via_diameter (min 0.45mm))\n(constraint via_diameter (min  0.6 mm))"), vec![0.45, 0.6]);
        assert!(dru_via_minimums("(constraint via_diameter (max 1mm))").is_empty());
    }

    #[test]
    fn classes_number_from_one_in_the_order_they_are_met() {
        let mut c = DomainClasses::default();
        assert_eq!((c.id("A"), c.id("B"), c.id("A")), (1, 2, 1));
    }

    #[test]
    fn a_class_gap_inside_a_domain_beats_the_gap_to_other_nets() {
        let mut c = DomainClasses::default();
        c.id("MAINS_K1");
        c.id("MAINS_K2");
        c.id("HOST");
        let rules = Rules { domains: vec![("MAINS_K*".to_string(), 8.0, 3.0)], pairs: vec![(vec!["MAINS_K1".to_string()], vec!["HOST".to_string()], 9.0)], ..Rules::default() };
        let t = class_gaps(&c, &rules).unwrap();
        assert_eq!(t.gaps[1][2], 3.0);
        assert_eq!(t.gaps[2][3], 8.0);
        assert_eq!(t.gaps[1][3], 9.0);
    }
}
