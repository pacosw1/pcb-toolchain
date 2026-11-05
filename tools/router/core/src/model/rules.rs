//! The custom rules against the nets: every DRU constraint ends in exactly one state. applied: a per-net value the router keeps;
//! stage: owned by a named stage; plane: a plane layer, no tracks; checked: left to KiCad DRC after routing; unknown: stops the
//! model. A selector the router cannot decide is reported, never guessed.
use super::dru::{Constraint, HoleScope, Rule, number};
use super::num::Num;
use super::output::{HoleRule, Net, NetVia, RuleReport, RuleState};
use super::selector::{Item, Scope, Selector};
use std::collections::{BTreeMap, BTreeSet};

const PAIR_KINDS: [&str; 3] = ["diff_pair_gap", "diff_pair_uncoupled", "skew"];
const ROUTED_KINDS: [&str; 5] = ["clearance", "track_width", "via_count", "length", "disallow"];
/// Constraints on items the router does not make: KiCad DRC after routing, also when the selector cannot be decided.
const NOT_ROUTED: [&str; 11] = ["silk_clearance", "courtyard_clearance", "zone_connection", "thermal_relief_gap", "thermal_spoke_width", "min_resolved_spokes", "text_height", "text_thickness", "solder_mask_expansion", "solder_paste_abs_margin", "solder_paste_rel_margin"];
/// The item types of a `disallow` as KiCad's rule parser spells them. The router makes tracks and through vias; the rest it never adds.
const DISALLOW_ITEMS: [&str; 12] = ["track", "via", "through_via", "hole", "micro_via", "blind_via", "buried_via", "pad", "zone", "text", "graphic", "footprint"];
/// A through via is a via, and a drilled hole.
const VIA_ITEMS: [&str; 3] = ["via", "through_via", "hole"];
const NOT_EVERY_NET: &str = "selector not evaluable for every net: the rule would reach only some of the nets it means";

/// A clearance rule that names a zone: the pour model of the core reads it per net.
pub struct ZoneRule {
    pub condition: Selector,
    pub min: f64,
}

#[derive(Default)]
pub struct RuleOutcome {
    pub report: Vec<RuleReport>,
    pub hole_to_hole: Vec<HoleRule>,
    pub hole_clearance: Vec<HoleRule>,
    pub zone_rules: Vec<ZoneRule>,
}

/// What a constraint reaches: the nets it holds for, and whether it may hold for others.
struct Reach {
    hits: Vec<String>,
    unknown: bool,
}

fn reach(condition: &Selector, nets: &BTreeMap<String, Net>) -> Reach {
    let (mut hits, mut unknown) = (BTreeSet::new(), false);
    let nobody = Item::default();
    for (name, net) in nets {
        for item_type in ["Track", "Via"] {
            let item = Item::plain(name, &net.class, item_type);
            match condition.eval(Scope { a: &item, b: &nobody, pair: false }) {
                None => unknown = true,
                Some(true) => {
                    hits.insert(name.clone());
                }
                Some(false) => {}
            }
        }
    }
    Reach { hits: hits.into_iter().collect(), unknown }
}

/// Why the router cannot keep all of a rule that reaches a net, or None. A net has one width and one limit of each kind, so
/// `applied` must not mean that part of the rule was thrown away.
fn dropped_value(con: &Constraint, layer: Option<&str>) -> Option<String> {
    let kept: &[&str] = match con.kind.as_str() {
        "track_width" => return dropped_width(con, layer),
        "disallow" => return con.items.iter().find(|item| !DISALLOW_ITEMS.contains(&item.as_str())).map(|item| format!("disallow {item}: not an item type the router knows")),
        "hole_size" | "via_diameter" | "annular_width" => &["min"],
        "length" | "via_count" => &["max"],
        _ => return None,
    };
    let extra: Vec<&str> = con.values.keys().map(String::as_str).filter(|k| !kept.contains(k)).collect();
    (!extra.is_empty()).then(|| format!("{} {}: the router keeps only {}", con.kind, extra.join(" "), kept.join(" ")))
}

fn dropped_width(con: &Constraint, layer: Option<&str>) -> Option<String> {
    if !con.values.contains_key("opt") {
        return Some("track_width with no opt: the router takes a net width from opt only".to_string());
    }
    layer.map(|l| format!("track_width on {l}: the router has one width per net, on every layer"))
}

fn shown_nets(hits: &[String]) -> Vec<String> {
    let mut shown: Vec<String> = hits.iter().take(8).cloned().collect();
    if hits.len() > 8 {
        shown.push("...".to_string());
    }
    shown
}

struct Context<'a> {
    nets: &'a mut BTreeMap<String, Net>,
    pair_nets: &'a BTreeSet<String>,
    plane_layers: &'a BTreeSet<String>,
    out: RuleOutcome,
}

impl Context<'_> {
    fn report(&mut self, rule: &Rule, con: &Constraint, state: RuleState, nets: Vec<String>, why: impl Into<String>) {
        self.out.report.push(RuleReport { rule: rule.name.clone(), constraint: con.kind.clone(), state, nets, why: why.into() });
    }

    fn apply(&mut self, rule: &Rule, con: &Constraint) -> Result<(), String> {
        if con.kind == "clearance"
            && rule.condition.text.contains("Zone")
            && let Some(min) = con.value("min")
        {
            self.out.zone_rules.push(ZoneRule { condition: rule.condition.clone(), min: min? });
        }
        let reached = reach(&rule.condition, self.nets);
        match con.kind.as_str() {
            "hole_clearance" | "hole_to_hole" => self.hole_rule(rule, con),
            "hole_size" | "via_diameter" | "annular_width" => self.via_rule(rule, con, &reached),
            _ => self.net_rule(rule, con, &reached),
        }
    }

    fn hole_rule(&mut self, rule: &Rule, con: &Constraint) -> Result<(), String> {
        let (Some(scope), Some(min)) = (HoleScope::of(&rule.condition), con.value("min")) else {
            let why = format!("hole rule condition not recognised: {}", rule.condition.text);
            self.report(rule, con, RuleState::Unknown, Vec::new(), why);
            return Ok(());
        };
        let entry = HoleRule { rule: rule.name.clone(), min: min?, scope: scope.name() };
        if con.kind == "hole_to_hole" { self.out.hole_to_hole.push(entry) } else { self.out.hole_clearance.push(entry) }
        self.report(rule, con, RuleState::Applied, Vec::new(), format!("router hole rule (scope {}; the core applies it to every drilled item, a superset)", scope.name()));
        Ok(())
    }

    fn via_rule(&mut self, rule: &Rule, con: &Constraint, reached: &Reach) -> Result<(), String> {
        let lost = (!reached.hits.is_empty() || reached.unknown).then(|| dropped_value(con, rule.layer.as_deref())).flatten().or(reached.unknown.then(|| NOT_EVERY_NET.to_string()));
        for name in &reached.hits {
            let via = self.nets.get_mut(name).expect("a reached net").via.get_or_insert_with(NetVia::default);
            if let Some(min) = con.value("min") {
                let field = via_field(via, &con.kind);
                *field = Some(field.unwrap_or(0.0).max(min?));
            }
        }
        let (state, why) = lost.map_or((RuleState::Applied, "router via geometry".to_string()), |w| (RuleState::Unknown, w));
        self.report(rule, con, state, shown_nets(&reached.hits), why);
        Ok(())
    }

    fn net_rule(&mut self, rule: &Rule, con: &Constraint, reached: &Reach) -> Result<(), String> {
        let (state, why) = match self.state_before_values(rule, con, reached) {
            Some(decided) => decided,
            None if ROUTED_KINDS.contains(&con.kind.as_str()) => {
                for name in &reached.hits {
                    self.keep_value(rule, con, name)?;
                }
                let lost = (!reached.hits.is_empty()).then(|| dropped_value(con, rule.layer.as_deref())).flatten().or(reached.unknown.then(|| NOT_EVERY_NET.to_string()));
                lost.map_or((RuleState::Applied, String::new()), |w| (RuleState::Unknown, w))
            }
            // The pair stage and the pair table answer for these; what reaches no net asks nothing of the router.
            None if reached.hits.is_empty() || NOT_ROUTED.contains(&con.kind.as_str()) || PAIR_KINDS.contains(&con.kind.as_str()) || con.kind == "creepage" => (RuleState::Checked, format!("{}: KiCad DRC after routing", con.kind)),
            None => (RuleState::Unknown, format!("{}: not modelled, so routing would not keep it", con.kind)),
        };
        self.report(rule, con, state, shown_nets(&reached.hits), why);
        Ok(())
    }

    /// The states decided before the rule's values are looked at, in order.
    fn state_before_values(&self, rule: &Rule, con: &Constraint, reached: &Reach) -> Option<(RuleState, String)> {
        let kind = con.kind.as_str();
        let text = &rule.condition.text;
        let (none, unknown) = (reached.hits.is_empty(), reached.unknown);
        if NOT_ROUTED.contains(&kind) && none && unknown {
            return Some((RuleState::Checked, format!("{kind}: not a router item, KiCad DRC after routing")));
        }
        if none && unknown && text.contains("inDiffPair") && text.contains("intersectsArea") {
            return Some((RuleState::Stage, "pairs stage: pad-field gap window (spatial selector, rule areas around the pad fields)".to_string()));
        }
        if let Some(layer) = rule.layer.as_ref().filter(|l| self.plane_layers.contains(*l)) {
            return Some((RuleState::Plane, format!("{layer} is a plane layer: no tracks")));
        }
        let pair_stage = PAIR_KINDS.contains(&kind) || matches!(kind, "track_width" | "clearance" | "via_count");
        if !none && reached.hits.iter().all(|h| self.pair_nets.contains(h)) && pair_stage {
            return Some((RuleState::Stage, "pairs stage (centerline at width + gap)".to_string()));
        }
        // A rule on a zone goes to the pour model, the gap inside a pair to the pairs stage, one that reads both items to the pair
        // table. Nothing else reads the rest.
        if kind == "clearance" && none && unknown && (text.contains("Zone") || text.contains("isCoupledDiffPair") || rule.condition.reads_both_items()) {
            return Some((RuleState::Checked, "pad / zone geometry rule: KiCad DRC after routing".to_string()));
        }
        if kind == "clearance" && none && unknown {
            return Some((RuleState::Unknown, format!("selector not evaluable for any net, and no pair or pour rule reads it: {text}")));
        }
        if unknown && none {
            return Some((RuleState::Unknown, "selector not evaluable for any net".to_string()));
        }
        None
    }

    fn keep_value(&mut self, rule: &Rule, con: &Constraint, name: &str) -> Result<(), String> {
        let net = self.nets.get_mut(name).expect("a reached net");
        let value = |key: &str| con.values.get(key).map(|v| number(v)).transpose();
        match con.kind.as_str() {
            "track_width" => {
                if let Some(opt) = value("opt")? {
                    net.width = Some(Num::Float(opt));
                }
            }
            "clearance" => {
                if let Some(min) = value("min")? {
                    net.clearance = Some(net.clearance.unwrap_or(Num::Int(0)).max(Num::Float(min)));
                }
            }
            "via_count" => net.limits.via_count = value("max")?.or(net.limits.via_count),
            "length" => net.limits.length = value("max")?.or(net.limits.length),
            "disallow" => disallow(net, con, rule.layer.as_deref()),
            _ => {}
        }
        Ok(())
    }
}

fn via_field<'a>(via: &'a mut NetVia, kind: &str) -> &'a mut Option<f64> {
    match kind {
        "hole_size" => &mut via.hole_size,
        "via_diameter" => &mut via.via_diameter,
        _ => &mut via.annular_width,
    }
}

/// True when a rule's `layer` clause holds on a copper layer. No clause holds everywhere; `outer` and `inner` are KiCad's own words.
fn rule_layer_holds(layer: Option<&str>, copper: &str) -> bool {
    let outer = copper == "F.Cu" || copper == "B.Cu";
    match layer {
        None => true,
        Some("outer") => outer,
        Some("inner") => !outer,
        Some(only) => copper == only,
    }
}

/// KiCad disallow names item types: `track` takes the layer, or every layer, from the net; a via type sets via_count 0, as a through
/// via touches every layer. Other types are not router items: KiCad DRC checks them after routing.
fn disallow(net: &mut Net, con: &Constraint, layer: Option<&str>) {
    if con.items.iter().any(|i| i == "track") {
        net.layers.retain(|l| !rule_layer_holds(layer, l));
    }
    if con.items.iter().any(|i| VIA_ITEMS.contains(&i.as_str())) {
        net.limits.via_count = Some(0.0);
    }
}

pub fn apply_rules(rules: &[Rule], nets: &mut BTreeMap<String, Net>, pair_nets: &BTreeSet<String>, plane_layers: &BTreeSet<String>) -> Result<RuleOutcome, String> {
    let mut context = Context { nets, pair_nets, plane_layers, out: RuleOutcome::default() };
    for rule in rules {
        for con in &rule.constraints {
            context.apply(rule, con)?;
        }
    }
    Ok(context.out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::dru::parse_rules;

    fn nets() -> BTreeMap<String, Net> {
        let net = |class: &str| Net { class: class.to_string(), layers: vec!["F.Cu".to_string(), "B.Cu".to_string()], width: Some(Num::Float(0.2)), clearance: Some(Num::Float(0.2)), ..Net::default() };
        BTreeMap::from([("ISO1".to_string(), net("ISO")), ("X".to_string(), net("Default"))])
    }

    fn run(text: &str) -> (Vec<RuleReport>, BTreeMap<String, Net>, RuleOutcome) {
        let mut n = nets();
        let rules = parse_rules(&format!("(version 1)\n{text}")).unwrap();
        let mut out = apply_rules(&rules, &mut n, &BTreeSet::new(), &BTreeSet::from(["In1.Cu".to_string()])).unwrap();
        (std::mem::take(&mut out.report), n, out)
    }

    fn assert_stops(text: &str, why: &str) {
        let (report, ..) = run(text);
        assert_eq!(report[0].state, RuleState::Unknown, "{text}");
        assert!(report[0].why.contains(why), "{}", report[0].why);
    }

    #[test]
    fn a_rule_value_the_router_cannot_keep_stops_the_model() {
        assert_stops(r#"(rule "w" (condition "A.NetClass == 'ISO'") (constraint track_width (min 0.8mm)))"#, "no opt");
        assert_stops(r#"(rule "w" (layer "F.Cu") (condition "A.NetClass == 'ISO'") (constraint track_width (opt 0.4mm)))"#, "F.Cu");
        assert_stops(r#"(rule "l" (condition "A.NetClass == 'ISO'") (constraint length (min 20mm) (max 30mm)))"#, "min");
        assert_stops(r#"(rule "c" (condition "A.NetClass == 'ISO'") (constraint via_count (min 1) (max 3)))"#, "min");
        assert_stops(r#"(rule "v" (condition "A.NetClass == 'ISO'") (constraint via_diameter (min 0.5mm) (max 0.7mm)))"#, "max");
    }

    #[test]
    fn the_values_the_router_keeps_are_applied() {
        let (report, n, _) = run(r#"(rule "w" (condition "A.NetClass == 'ISO'") (constraint track_width (min 0.2mm) (opt 0.3mm) (max 0.4mm)))
(rule "l" (condition "A.NetClass == 'ISO'") (constraint length (max 30mm)))
(rule "c" (condition "A.NetClass == 'ISO'") (constraint via_count (max 3)))
(rule "v" (condition "A.NetClass == 'ISO'") (constraint via_diameter (min 0.5mm)))"#);
        assert!(report.iter().all(|r| r.state == RuleState::Applied));
        let net = &n["ISO1"];
        assert_eq!(net.width, Some(Num::Float(0.3)));
        assert_eq!((net.limits.length, net.limits.via_count), (Some(30.0), Some(3.0)));
        assert_eq!(net.via.as_ref().unwrap().via_diameter, Some(0.5));
    }

    #[test]
    fn a_rule_that_reaches_no_net_stops_nothing() {
        let (report, ..) = run(r#"(rule "w" (condition "A.NetClass == 'NONE'") (constraint track_width (min 0.8mm)))"#);
        assert_eq!(report[0].state, RuleState::Applied);
    }

    #[test]
    fn disallow_takes_layers_and_vias() {
        let (_, n, _) = run(r#"(rule "d" (layer "F.Cu") (condition "A.NetClass == 'ISO'") (constraint disallow track via))"#);
        assert_eq!(n["ISO1"].layers, ["B.Cu"]);
        assert_eq!(n["ISO1"].limits.via_count, Some(0.0));
        let (_, n, _) = run(r#"(rule "d" (condition "A.NetClass == 'ISO'") (constraint disallow track))"#);
        assert!(n["ISO1"].layers.is_empty());
        let (_, n, _) = run(r#"(rule "d" (layer outer) (condition "A.NetClass == 'ISO'") (constraint disallow track))"#);
        assert!(n["ISO1"].layers.is_empty());
        let (_, n, _) = run(r#"(rule "d" (layer inner) (condition "A.NetClass == 'ISO'") (constraint disallow track))"#);
        assert_eq!(n["ISO1"].layers, ["F.Cu", "B.Cu"]);
        let (_, n, _) = run(r#"(rule "d" (condition "A.NetClass == 'ISO'") (constraint disallow through_via))"#);
        assert_eq!(n["ISO1"].limits.via_count, Some(0.0));
    }

    #[test]
    fn hole_rules_are_kept_with_their_scope() {
        let (report, _, out) = run(r#"(rule "h" (constraint hole_to_hole (min 0.45mm)) (condition "A.Pad_Type == 'Through-hole' && B.Pad_Type == 'Through-hole'"))"#);
        assert_eq!((out.hole_to_hole[0].min, out.hole_to_hole[0].scope), (0.45, "both_th"));
        assert_eq!(report[0].state, RuleState::Applied);
        let (report, ..) = run(r#"(rule "h" (constraint hole_clearance (min 0.3mm)) (condition "A.Type == 'Via'"))"#);
        assert_eq!(report[0].state, RuleState::Unknown);
    }

    #[test]
    fn the_board_rules_of_a_plane_layer_and_of_silk_end_in_their_states() {
        let (report, ..) = run(r#"(rule "In1 no tracks" (layer "In1.Cu") (condition "A.Type == 'Track'") (constraint disallow track))
(rule "Edge" (condition "A.memberOfFootprint('J1') && B.Layer == 'Edge.Cuts'") (constraint silk_clearance (min -10mm)))
(rule "NPTH" (condition "A.Type == 'Pad' && A.intersectsArea('K')") (constraint disallow pad))"#);
        assert_eq!(report[0].state, RuleState::Plane);
        assert_eq!(report[1].state, RuleState::Checked);
        // Tracks and vias are not pads: the selector is false for every net.
        assert_eq!(report[2].state, RuleState::Applied);
    }

    #[test]
    fn a_clearance_that_names_a_zone_also_goes_to_the_pour_model() {
        let (.., out) = run(r#"(rule "pour" (condition "A.NetClass == 'ISO' && B.Type == 'Zone'") (constraint clearance (min 0.5mm)))"#);
        assert_eq!(out.zone_rules[0].min, 0.5);
    }
}
