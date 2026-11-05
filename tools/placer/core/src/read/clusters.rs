//! Proposed clusters (`iotplace read --auto-clusters`): which parts belong together, from the netlist, the part fields and the soft
//! blocks of a membership file. A proposal never reads a position, so a spread board and a placed board get the same answer.
//!
//! Each part gets at most one tie: its pad, the pad it should sit next to. First match wins:
//!   crystal    a crystal to its IC pin; its load caps and feedback resistor to the crystal
//!   regulator  a passive on a short net with a regulator pin (switch node, feedback, bootstrap)
//!   decap      a capacitor from a net to ground to a pin of an IC on that net: the biggest caps go to a regulator, the others
//!              over the pins by count. A cap with a Group field goes only to a pin of the same Group.
//! A tie is a soft pull (a cohesion net from pad to pad) and a cluster is what the search may move as one (search/cluster.rs). It
//! has no authority over a reviewed rule: reviewed rigid groups are units already, and a tie inside a unit is dropped.

use super::out::{Net, Unit};
use super::parts::{is_test_point, ref_prefix};
use crate::kicad::doc::{Board, Footprint, Pad, mm};
use crate::problem::{Cluster, Tie};
use std::collections::{BTreeMap, BTreeSet, HashMap};

/// An IC is a U with more pads than this (grouping.rs `decaps`).
const IC_PADS: usize = 3;
/// A net on more parts is a rail. To tune: the value of the old membership code.
const RAIL_PARTS: usize = 6;
/// Above this a U is not a regulator (an MCU description also says "regulator"). To tune.
const REGULATOR_PADS: usize = 16;
const REGULATOR_WORDS: [&str; 7] = ["regulator", "ldo", "buck", "boost", "dc-dc", "dcdc", "switcher"];
const ESD_WORDS: [&str; 5] = ["esd", "tvs", "pesd", "usblc", "prtr"];

pub struct Proposal {
    pub clusters: Vec<Cluster>,
    pub nets: Vec<Net>,
}

#[derive(Clone, Copy)]
struct Pin<'a> {
    part: &'a Footprint,
    pad: &'a Pad,
}

struct Link<'a> {
    from: Pin<'a>,
    to: Pin<'a>,
    rule: &'static str,
}

struct Netlist<'a> {
    parts: Vec<&'a Footprint>,
    nets: BTreeMap<&'a str, Vec<Pin<'a>>>,
    links: Vec<Link<'a>>,
    tied: BTreeSet<&'a str>,
}

fn natural(reference: &str) -> (&str, u64) {
    let prefix = ref_prefix(reference);
    (prefix, reference[prefix.len()..].parse().unwrap_or(0))
}

fn is_ground(net: &str) -> bool {
    let n = net.to_uppercase();
    n.contains("GND") || n.contains("VSS") || n == "0V" || n.ends_with("_0V") || n.ends_with("/0V")
}

fn field<'a>(fp: &'a Footprint, name: &str) -> Option<&'a str> {
    fp.fields.iter().find(|(k, _)| k == name).map(|(_, v)| v.as_str())
}

fn says(fp: &Footprint, words: &[&str]) -> bool {
    let text = format!("{} {}", fp.value, field(fp, "Description").unwrap_or("")).to_lowercase();
    words.iter().any(|w| text.contains(w))
}

fn is_ic(fp: &Footprint) -> bool {
    ref_prefix(&fp.reference) == "U" && fp.pads.len() > IC_PADS && !says(fp, &ESD_WORDS)
}

/// Farads from 100nF, 4.7uF, 2u2; 0 when the value is no capacitance.
fn farads(value: &str) -> f64 {
    let v = value.trim();
    let Some(at) = v.find(|c: char| !(c.is_ascii_digit() || c == '.')) else { return 0.0 };
    let scale = match v[at..].chars().next() {
        Some('p') => 1e-12,
        Some('n') => 1e-9,
        Some('u' | 'µ') => 1e-6,
        Some('m') => 1e-3,
        _ => return 0.0,
    };
    let tail: String = v[at..].chars().skip(1).take_while(char::is_ascii_digit).collect();
    format!("{}.{}", &v[..at], if tail.is_empty() { "0" } else { &tail }).parse::<f64>().unwrap_or(0.0) * scale
}

impl<'a> Netlist<'a> {
    fn new(board: &'a Board) -> Self {
        let mut parts: Vec<&Footprint> = board.footprints.iter().filter(|f| !is_test_point(&f.reference)).collect();
        parts.sort_by(|a, b| natural(&a.reference).cmp(&natural(&b.reference)));
        let mut nets: BTreeMap<&str, Vec<Pin>> = BTreeMap::new();
        for &part in &parts {
            for pad in part.pads.iter().filter(|p| !p.net.is_empty() && !p.net.starts_with("unconnected-")) {
                nets.entry(&pad.net).or_default().push(Pin { part, pad });
            }
        }
        Self { parts, nets, links: Vec::new(), tied: BTreeSet::new() }
    }

    fn pins(&self, net: &str) -> Vec<Pin<'a>> {
        self.nets.get(net).cloned().unwrap_or_default()
    }

    fn is_rail(&self, net: &str) -> bool {
        is_ground(net) || self.pins(net).iter().map(|p| p.part.reference.as_str()).collect::<BTreeSet<_>>().len() > RAIL_PARTS
    }

    fn is_regulator(&self, fp: &Footprint) -> bool {
        let inductor = || fp.pads.iter().any(|p| !self.is_rail(&p.net) && self.pins(&p.net).iter().any(|q| ref_prefix(&q.part.reference) == "L"));
        ref_prefix(&fp.reference) == "U" && fp.pads.len() <= REGULATOR_PADS && !says(fp, &ESD_WORDS) && (says(fp, &REGULATOR_WORDS) || inductor())
    }

    fn tie(&mut self, from: Pin<'a>, to: Pin<'a>, rule: &'static str) {
        if from.part.reference != to.part.reference && self.tied.insert(&from.part.reference) {
            self.links.push(Link { from, to, rule });
        }
    }

    fn crystals(&mut self) {
        let crystals: Vec<&Footprint> = self.parts.iter().copied().filter(|f| matches!(ref_prefix(&f.reference), "Y" | "X")).collect();
        for crystal in crystals {
            let own: Vec<&Pad> = crystal.pads.iter().filter(|p| !p.net.is_empty() && !self.is_rail(&p.net)).collect();
            let ic = own.iter().find_map(|&pad| self.pins(&pad.net).into_iter().find(|p| is_ic(p.part)).map(|to| (pad, to)));
            if let Some((pad, to)) = ic {
                self.tie(Pin { part: crystal, pad }, to, "crystal");
            }
            for &pad in &own {
                for pin in self.pins(&pad.net).into_iter().filter(|p| p.part.pads.len() == 2) {
                    let other = pin.part.pads.iter().find(|q| q.net != pad.net).map_or("", |q| q.net.as_str());
                    let load = ref_prefix(&pin.part.reference) == "C" && is_ground(other);
                    let feedback = ref_prefix(&pin.part.reference) == "R" && own.iter().any(|q| q.net == other);
                    if load || feedback {
                        self.tie(pin, Pin { part: crystal, pad }, "crystal");
                    }
                }
            }
        }
    }

    fn regulators(&mut self) {
        let regulators: Vec<&Footprint> = self.parts.iter().copied().filter(|f| self.is_regulator(f)).collect();
        for part in regulators {
            let short: Vec<&Pad> = part.pads.iter().filter(|p| !p.net.is_empty() && !self.is_rail(&p.net)).collect();
            for pad in short {
                for pin in self.pins(&pad.net) {
                    let passive = matches!(ref_prefix(&pin.part.reference), "L" | "D" | "C" | "R") && pin.part.pads.len() == 2;
                    if passive && !says(pin.part, &["led"]) {
                        self.tie(pin, Pin { part, pad }, "regulator");
                    }
                }
            }
        }
    }

    /// The pins a cap on `net` may go to: an IC or a regulator, of the cap's Group when it has one.
    fn load_pins(&self, net: &str, cap: &Footprint) -> Vec<Pin<'a>> {
        let group = field(cap, "Group");
        let same = |p: &Pin| group.is_none() || field(p.part, "Group") == group;
        self.pins(net).into_iter().filter(|p| (is_ic(p.part) || self.is_regulator(p.part)) && same(p)).collect()
    }

    fn decaps(&mut self) {
        let mut caps: BTreeMap<&'a str, Vec<&'a Footprint>> = BTreeMap::new();
        for part in self.parts.iter().copied().filter(|f| ref_prefix(&f.reference) == "C" && f.pads.len() == 2 && !self.tied.contains(f.reference.as_str())) {
            let ground = part.pads.iter().filter(|p| is_ground(&p.net)).count();
            if let (1, Some(pad)) = (ground, part.pads.iter().find(|p| !p.net.is_empty() && !is_ground(&p.net))) {
                caps.entry(&pad.net).or_default().push(part);
            }
        }
        for (net, mut on_net) in caps {
            on_net.sort_by(|a, b| farads(&b.value).total_cmp(&farads(&a.value)).then(natural(&a.reference).cmp(&natural(&b.reference))));
            let mut count: BTreeMap<(&str, &str), usize> = BTreeMap::new();
            for cap in on_net {
                let pins = self.load_pins(net, cap);
                let used = |p: &Pin, count: &BTreeMap<(&str, &str), usize>| count.get(&(p.part.reference.as_str(), p.pad.number.as_str())).copied().unwrap_or(0);
                let open: Vec<Pin<'a>> = pins.iter().copied().filter(|p| self.is_regulator(p.part) && used(p, &count) == 0).collect();
                let pool = if open.is_empty() { &pins } else { &open };
                let Some(&to) = pool.iter().min_by_key(|p| (used(p, &count), natural(&p.part.reference), natural(&p.pad.number))) else { continue };
                *count.entry((to.part.reference.as_str(), to.pad.number.as_str())).or_default() += 1;
                let Some(pad) = cap.pads.iter().find(|p| p.net == net) else { continue };
                self.tie(Pin { part: cap, pad }, to, "decap");
            }
        }
    }
}

fn find(root: &mut [usize], i: usize) -> usize {
    if root[i] != i {
        root[i] = find(root, root[i]);
    }
    root[i]
}

fn join(root: &mut [usize], a: usize, b: usize) {
    let (a, b) = (find(root, a), find(root, b));
    root[a] = b;
}

/// The proposal of a board. Soft blocks are the cohesion nets `~block:NAME` already in `nets`: their units go in one cluster.
pub fn propose(board: &Board, units: &[Unit], unit_of: &HashMap<String, usize>, nets: &[Net], weight: f64) -> Proposal {
    let mut list = Netlist::new(board);
    list.crystals();
    list.regulators();
    list.decaps();
    let local = |pin: &Pin, unit: usize| (mm(pin.pad.position.x) - units[unit].x, mm(pin.pad.position.y) - units[unit].y);
    let mut root: Vec<usize> = (0..units.len()).collect();
    let mut ties: Vec<Tie> = Vec::new();
    for Link { from, to, rule } in &list.links {
        let (unit, onto) = (unit_of[&from.part.reference], unit_of[&to.part.reference]);
        if unit != onto {
            join(&mut root, unit, onto);
            let why = format!("{}.{} next to {}.{} on {}", from.part.reference, from.pad.number, to.part.reference, to.pad.number, from.pad.net);
            ties.push(Tie { unit, at: local(from, unit), to: onto, target: local(to, onto), rule: rule.to_string(), why });
        }
    }
    let blocks: Vec<&Net> = nets.iter().filter(|n| n.cohesion && n.name.starts_with("~block:")).collect();
    for pair in blocks.iter().flat_map(|n| n.pins.windows(2)) {
        join(&mut root, pair[0].0, pair[1].0);
    }
    let linked: BTreeSet<usize> = ties.iter().flat_map(|t| [t.unit, t.to]).chain(blocks.iter().flat_map(|n| n.pins.iter().map(|p| p.0))).collect();
    let mut members: BTreeMap<usize, Vec<usize>> = BTreeMap::new();
    for i in linked {
        members.entry(find(&mut root, i)).or_default().push(i);
    }
    let mut clusters: Vec<Cluster> = members.into_values().map(|mut group| {
        // The first unit is the root of the ties (an IC): the cluster has its name and turns about it.
        group.sort_by_key(|&i| (ties.iter().any(|t| t.unit == i), std::cmp::Reverse(units[i].rects.len()), i));
        let own = ties.iter().filter(|t| group.contains(&t.unit)).cloned().collect();
        Cluster { name: units[group[0]].name.clone(), units: group, ties: own }
    }).collect();
    clusters.sort_by(|a, b| natural(&a.name).cmp(&natural(&b.name)));
    let pull = |t: &Tie| {
        let pin = |unit: usize, (x, y): (f64, f64)| (unit, x, y, x, y);
        let name = format!("~clu:{}:{}", units[t.unit].name, units[t.to].name);
        Net { name, weight, pins: vec![pin(t.unit, t.at), pin(t.to, t.target)], pts: None, track: 0.0, cohesion: true }
    };
    Proposal { nets: ties.iter().map(pull).collect(), clusters }
}

#[cfg(test)]
mod tests {
    use super::farads;

    #[test]
    fn a_value_reads_as_farads() {
        assert_eq!(farads("100nF"), 100.0 * 1e-9);
        assert_eq!(farads("2u2"), 2.2 * 1e-6);
        assert_eq!(farads("10R"), 0.0);
    }
}
