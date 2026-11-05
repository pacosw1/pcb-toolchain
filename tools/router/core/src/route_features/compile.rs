//! The rule compiler: `.kicad_dru` rules and config rules become per-net allowed layers and class-to-class clearances.
//! The notes say what was compiled and what stays with the mandatory native post-check. A condition is run the way the job
//! has always run it: left to right, stopping at the first term it cannot read, so the nets before that term keep their result.
use crate::model::dru::{Constraint, Rule, parse_rules};
use crate::model::num::short_float;
use crate::model::selector::{Decider, Selector, Stop};
use crate::model::text::glob_match;
use crate::pytext::repr_list;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::{BTreeMap, BTreeSet};

/// A rule of `rule_compiler.extra`: nets by glob and net classes lose layers or their vias.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct ExtraRule {
    pub nets: Vec<String>,
    pub classes: Vec<String>,
    pub deny_layers: Vec<String>,
    pub no_via: bool,
    pub about: Option<Value>,
}

impl ExtraRule {
    fn label(&self) -> String {
        match &self.about {
            Some(Value::String(text)) => text.clone(),
            Some(other) => other.to_string(),
            None => format!("nets {} classes {}", repr_list(&self.nets), repr_list(&self.classes)),
        }
    }
}

#[derive(Debug, Clone, Default, PartialEq)]
pub struct Compiled {
    /// Allowed layers of the nets that lose a layer.
    pub masks: BTreeMap<String, Vec<String>>,
    /// Clearance in mm of a DSN class pair, the names in order.
    pub pairs: BTreeMap<(String, String), f64>,
    pub notes: Vec<String>,
}

#[derive(Default)]
struct Bans {
    deny: BTreeMap<String, BTreeSet<String>>,
    no_via: BTreeSet<String>,
}

/// The KiCad net class name of a DSN class: the KiCad DSN export calls Default "kicad_default".
fn kicad_name(class: &str) -> &str {
    if class == "kicad_default" { "Default" } else { class }
}

/// A rule value in mm, leniently: the number at the start, then an optional unit (mm, mil, in). Anything after is not read.
pub fn mm(text: &str) -> Result<f64, String> {
    let end = text.find(|c: char| !c.is_ascii_digit() && c != '.').unwrap_or(text.len());
    let (digits, rest) = text.split_at(end);
    let value: f64 = digits.parse().map_err(|_| format!("could not convert string to float: '{digits}'"))?;
    let rest = rest.trim_start();
    Ok(if rest.starts_with("mil") {
        value * 0.0254
    } else if rest.starts_with("in") {
        value * 25.4
    } else {
        value
    })
}

/// `&&`, `||` and `!` spelled out over the whole text, quoted literals included: the literal a compiled rule compares is
/// the literal after this, so a net name with `!` in it matches nothing. The coverage check does not share this.
pub fn spelled_out(condition: &str) -> String {
    let words = condition.replace("&&", " and ").replace("||", " or ");
    let mut out = String::with_capacity(words.len());
    let mut chars = words.chars().peekable();
    while let Some(c) = chars.next() {
        if c == '!' && chars.peek() != Some(&'=') {
            out.push_str(" not ");
        } else {
            out.push(c);
        }
    }
    out
}

struct Compiler<'a> {
    nets: &'a [String],
    net_class: &'a BTreeMap<String, String>,
    classes: BTreeSet<&'a str>,
    bans: Bans,
    pairs: BTreeMap<(String, String), f64>,
    notes: Vec<String>,
}

impl Compiler<'_> {
    fn class_of(&self, net: &str) -> Option<&str> {
        self.net_class.get(net).map(|class| kicad_name(class))
    }

    fn net_side<'s>(&'s self, net: &'s str, kind: &'s str) -> Decider<'s> {
        Decider { net: Some(net), class: self.class_of(net), kind: Some(kind) }
    }

    fn rule(&mut self, rule: &Rule) -> Result<(), String> {
        let condition = Selector::new(&spelled_out(&rule.condition.text));
        for constraint in &rule.constraints {
            match constraint.kind.as_str() {
                "disallow" => self.disallow(rule, &condition, constraint)?,
                "clearance" => self.clearance(rule, &condition, constraint)?,
                kind => self.notes.push(format!("rule '{}': {kind} not compiled; mandatory native/final post-check", rule.name)),
            }
        }
        Ok(())
    }

    fn disallow(&mut self, rule: &Rule, condition: &Selector, constraint: &Constraint) -> Result<(), String> {
        let what: BTreeSet<&str> = constraint.items.iter().map(String::as_str).collect();
        match self.disallow_nets(rule, condition, &what) {
            Ok(hit) => self.disallow_notes(rule, &what, hit),
            Err(Halt::Refused(text)) => return Err(text),
            Err(Halt::Stopped(Stop::Unsupported(term))) => self.notes.push(format!("rule '{}': term {term} not supported, not compiled", rule.name)),
            Err(Halt::Stopped(Stop::Unreadable(cause))) => self.notes.push(format!("rule '{}': condition not read ({cause}), not compiled", rule.name)),
        }
        Ok(())
    }

    fn disallow_nets(&mut self, rule: &Rule, condition: &Selector, what: &BTreeSet<&str>) -> Result<usize, Halt> {
        let mut hit = 0;
        for net in self.nets {
            if what.contains("track") && condition.decide(self.net_side(net, "Track"), Decider::default()).map_err(Halt::Stopped)? {
                let Some(layer) = &rule.layer else {
                    return Err(Halt::Refused(format!("rule '{}': track prohibited on every layer for {net}", rule.name)));
                };
                self.bans.deny.entry(net.clone()).or_default().insert(layer.clone());
                hit += 1;
            }
            if what.contains("via") && condition.decide(self.net_side(net, "Via"), Decider::default()).map_err(Halt::Stopped)? {
                self.bans.no_via.insert(net.clone());
                hit += 1;
            }
        }
        Ok(hit)
    }

    fn disallow_notes(&mut self, rule: &Rule, what: &BTreeSet<&str>, hit: usize) {
        let (kept, rest): (Vec<&str>, Vec<&str>) = what.iter().partition(|item| matches!(**item, "track" | "via"));
        if !kept.is_empty() {
            self.notes.push(format!("rule '{}': disallow {} -> {hit} net(s)", rule.name, kept.join("/")));
        }
        if !rest.is_empty() {
            self.notes.push(format!("rule '{}': disallow {} not compiled; mandatory native post-check", rule.name, rest.join("/")));
        }
    }

    fn clearance(&mut self, rule: &Rule, condition: &Selector, constraint: &Constraint) -> Result<(), String> {
        let Some(minimum) = constraint.values.get("min").filter(|_| rule.condition.text.contains("B.")) else {
            self.notes.push(format!("rule '{}': clearance not compiled; mandatory native post-check", rule.name));
            return Ok(());
        };
        let value = mm(minimum)?;
        match self.clearance_pairs(condition, value) {
            Ok(hit) => self.notes.push(format!("rule '{}': clearance {} mm -> {hit} class pair(s)", rule.name, short_float(value))),
            Err(Stop::Unsupported(term)) => self.notes.push(format!("rule '{}': clearance term {term} not supported, not compiled", rule.name)),
            Err(Stop::Unreadable(cause)) => self.notes.push(format!("rule '{}': clearance condition not read ({cause}), not compiled", rule.name)),
        }
        Ok(())
    }

    fn clearance_pairs(&mut self, condition: &Selector, value: f64) -> Result<usize, Stop> {
        let mut hit = 0;
        let classes: Vec<&str> = self.classes.iter().copied().collect();
        for a in &classes {
            for b in &classes {
                if condition.decide(class_side(a), class_side(b))? {
                    let key = if a <= b { (a.to_string(), b.to_string()) } else { (b.to_string(), a.to_string()) };
                    let best = self.pairs.entry(key).or_insert(0.0);
                    *best = best.max(value);
                    hit += 1;
                }
            }
        }
        Ok(hit)
    }

    fn extra(&mut self, rule: &ExtraRule) {
        let selected: Vec<&String> = self.nets.iter().filter(|net| {
            rule.nets.iter().any(|glob| glob_match(net, glob)) || self.class_of(net).is_some_and(|class| rule.classes.iter().any(|c| c == class))
        }).collect();
        for net in &selected {
            self.bans.deny.entry((*net).clone()).or_default().extend(rule.deny_layers.iter().cloned());
            if rule.no_via {
                self.bans.no_via.insert((*net).clone());
            }
        }
        let count = selected.len();
        self.notes.push(format!("extra rule {}: {count} net(s)", rule.label()));
    }
}

enum Halt {
    /// The rule cannot be met: the job stops.
    Refused(String),
    /// The condition could not be run: the rule is reported as not compiled.
    Stopped(Stop),
}

fn class_side(class: &str) -> Decider<'_> {
    Decider { net: None, class: Some(kicad_name(class)), kind: None }
}

/// The layers a net may use, given what it lost and where its pads are.
fn allowed_layers(net: &str, layers: &[String], bans: &Bans, pads: Option<&BTreeSet<String>>) -> Result<Vec<String>, String> {
    let denied = bans.deny.get(net);
    let mut allow: Vec<String> = layers.iter().filter(|layer| !denied.is_some_and(|set| set.contains(*layer))).cloned().collect();
    if bans.no_via.contains(net) {
        allow = single_layer(net, allow, pads)?;
    }
    if allow.is_empty() {
        return Err(format!("{net}: every job layer denied"));
    }
    Ok(allow)
}

/// A via-banned net gets one layer: the layer of its SMD pads, or an outer layer when it has none.
fn single_layer(net: &str, allow: Vec<String>, pads: Option<&BTreeSet<String>>) -> Result<Vec<String>, String> {
    let smd: Vec<&String> = pads.into_iter().flatten().filter(|layer| *layer != "*").collect();
    let fits = |layer: &String| smd.is_empty() || smd == [layer];
    if smd.len() > 1 || !allow.iter().any(fits) {
        return Err(format!("via ban on {net}: cannot construct a legal single-layer route"));
    }
    let outer = allow.iter().find(|layer| matches!(layer.as_str(), "F.Cu" | "B.Cu"));
    let chosen = if smd.is_empty() { outer.or(allow.first()) } else { allow.iter().find(|layer| fits(layer)) };
    Ok(chosen.cloned().into_iter().collect())
}

/// `nets`: routed net names; `net_class`: net to DSN class; `pad_layers`: net to its SMD pad layers (`*` for a through-hole
/// pad); `layers`: the job's signal layers in order; `extra`: config rules. An error is a rule that cannot be met.
pub fn compile_dru(dru_text: &str, nets: &[String], net_class: &BTreeMap<String, String>, pad_layers: &BTreeMap<String, BTreeSet<String>>, layers: &[String], extra: &[ExtraRule]) -> Result<Compiled, String> {
    let mut compiler = Compiler { nets, net_class, classes: net_class.values().map(String::as_str).collect(), bans: Bans::default(), pairs: BTreeMap::new(), notes: Vec::new() };
    for rule in parse_rules(dru_text)? {
        compiler.rule(&rule)?;
    }
    extra.iter().for_each(|rule| compiler.extra(rule));
    let mut masks = BTreeMap::new();
    for net in nets {
        let allow = allowed_layers(net, layers, &compiler.bans, pad_layers.get(net))?;
        if allow != layers {
            masks.insert(net.clone(), allow);
        }
    }
    Ok(Compiled { masks, pairs: compiler.pairs, notes: compiler.notes })
}
