//! The edge time of a net from its actual driver (D-124 addendum, 2026-10-09).
//!
//! The driver of a net is found in the board's schematic netlist. The edge time of each driver pin comes from
//! tools/driver-edges.json (per part: datasheet tr and tf with the test load, or the IBIS model), never from a default. A net whose
//! driver or edge time is not known is "unknown driver". Rules (tools/driver-edges.json "about" has the full text):
//!   - A pin of a part in the table has a role: "input" (not a driver), "push_pull" (edge = min(tr, tf)), "open_drain" (edge = tf;
//!     the RC rise is slower), "opto" (edge = min(tr, tf)) or "unknown" (with the reason).
//!   - A part not in the table, or a pin no rule of its part matches, is unknown.
//!   - Passive parts are no driver. A 2-pin resistor or ferrite passes the drivers of the net at its other end (not a rail), with
//!     the same edge (the series part only slows it).
//!   - A connector pin is a load when the net has a driver on the board. With no driver, the spec must name the off-board
//!     interface ("offboard"); else the net is unknown.
//!   - "receivers" in the spec: parts whose pin on that net is an input by firmware or by design (with a reason).
//!   - The edge of the net is the shortest of all its drivers. One unknown driver makes the whole net unknown.
//!   - A rail is a net from a power symbol (no "/" in front of the name) or a spec power net: no driver search.
//!
//! D-124c: IBIS drivers use static V-I mean-current estimates with the routed trace, sourced receiver loads and driver C_comp MIN.
//! All estimates remain conditional. No estimate here is a qualified fastest-edge bound (D-124d).
pub mod estimate;
pub mod netlist;
pub mod table;

use crate::model::text::glob_match;
use crate::si::planes::spec::{Applicability, EdgeClass, EdgeRates, Offboard, matches_any};
use crate::si::py::g;
use netlist::Netlist;
use std::collections::BTreeMap;
use table::{Part, Rule, Table, regex_full};

const PASSIVE: [&str; 14] = ["R", "C", "L", "FB", "D", "TP", "F", "Y", "SW", "BT", "H", "MH", "NT", "JP"];
const SERIES: [&str; 2] = ["R", "FB"];
const CONNECTOR: [&str; 3] = ["J", "P", "CN"];

/// The edge of a net, or why there is none.
#[derive(Debug, Clone, PartialEq)]
pub enum Edge {
    Known { edge_ns: f64, driver: String },
    Unknown(String),
}

/// Routed-load inputs of the C*dV/I estimates: per net its length and capacitance per length with where it came from.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct Geometry {
    pub length_mm: BTreeMap<String, f64>,
    pub pf_per_mm: BTreeMap<String, (f64, String)>,
}

/// The spec parts of a driver search.
pub struct Lookup<'a> {
    pub netlist: &'a Netlist,
    pub table: &'a Table,
    pub receivers: &'a [(String, Vec<String>)],
    pub offboard: &'a [(String, Offboard)],
    pub rates: &'a EdgeRates,
    pub power: &'a [String],
    pub geom: &'a Geometry,
}

/// The letters of a reference: U12 -> U.
pub fn ref_prefix(reference: &str) -> String {
    reference.chars().take_while(|c| c.is_ascii_alphabetic() || *c == '_' || *c == '#').collect::<String>().to_uppercase()
}

pub fn is_passive_or_connector(prefix: &str) -> bool {
    PASSIVE.contains(&prefix) || CONNECTOR.contains(&prefix)
}

pub fn is_rail(net: &str, power: &[String]) -> bool {
    (!net.starts_with('/') && !net.starts_with("Net-") && !net.starts_with("unconnected")) || matches_any(net, power)
}

/// '10k' -> 10000, '4.7k' -> 4700, '330' -> 330, '1M' -> 1e6, '4k7' -> 4700. None if not a value.
pub fn r_value(text: &str) -> Option<f64> {
    let shape = regex_lite::Regex::new(r"^\s*(\d+(?:\.\d+)?)\s*([RkKmM]?)(\d*)\s*(?:ohm|Ω)?\s*$").expect("a fixed pattern");
    let found = shape.captures(text)?;
    let scale = match &found[2] {
        "k" | "K" => 1e3,
        "m" | "M" => 1e6,
        _ => 1.0,
    };
    let digits = if found[3].is_empty() { found[1].to_string() } else { format!("{}.{}", &found[1], &found[3]) };
    digits.parse::<f64>().ok().map(|v| v * scale)
}

/// A driver whose edge comes from an estimate, and where it drives from.
#[derive(Debug, Clone)]
pub struct Estimated<'a> {
    pub part: &'a Part,
    pub rule: &'a Rule,
    pub home: String,
    pub series: Vec<(String, Option<f64>)>,
}

#[derive(Debug, Clone)]
struct Driver<'a> {
    part: String,
    pin: String,
    edge: Option<f64>,
    text: String,
    estimated: Option<Estimated<'a>>,
}

enum PinEdge<'a> {
    Input,
    Unknown(String),
    Driver(f64, String),
    Estimated(&'a Part, &'a Rule),
}

fn class_covers(class: &EdgeClass, mpn: &str, pin: &str) -> bool {
    let Applicability::Part { mpn: patterns, pins } = &class.applicability else { return false };
    patterns.iter().any(|q| glob_match(mpn, q)) && regex_full(pins).is_ok_and(|re| re.is_match(pin))
}

/// The role and edge of one part pin. The edge is the time the return current flows in.
fn pin_edge<'a>(mpn: &str, pin: &str, table: &'a Table, class: Option<&EdgeClass>) -> PinEdge<'a> {
    if let Some(class) = class.filter(|c| class_covers(c, mpn, pin)) {
        return PinEdge::Driver(class.tr_ns, format!("part-bound class {mpn}.{pin}: {}", class.source));
    }
    let Some(part) = table.part_of(mpn) else { return PinEdge::Unknown(format!("{mpn}: no entry in tools/driver-edges.json")) };
    let key = &part.key;
    let Some(rule) = part.rule(pin) else { return PinEdge::Unknown(format!("{key} pin {pin}: no rule in tools/driver-edges.json")) };
    if rule.role == "input" {
        return PinEdge::Input;
    }
    if let Some(class) = class {
        let Applicability::Part { mpn: patterns, .. } = &class.applicability else { unreachable!("a protocol class never reaches a pin") };
        return PinEdge::Unknown(format!("{mpn}.{pin}: incompatible with part-bound class {}", crate::si::py::list_repr(patterns)));
    }
    if rule.role == "unknown" {
        return PinEdge::Unknown(format!("{key} {pin}: {}", rule.source));
    }
    if rule.ibis_model.is_some() || (rule.bound.is_some() && !crate::si::planes::spec::positive_finite(rule.tf_ns)) {
        return PinEdge::Estimated(part, rule);
    }
    let tf = rule.tf_ns.expect("a checked rule");
    if rule.role == "open_drain" {
        return PinEdge::Driver(tf, format!("{key} {pin} open drain, tf {} ns: {}", g(tf), rule.source));
    }
    let tr = rule.tr_ns.expect("a checked rule");
    let e = tr.min(tf);
    PinEdge::Driver(e, format!("{key} {pin} {}, min(tr {}, tf {}) = {} ns: {}", rule.role, g(tr), g(tf), g(e), rule.source))
}

fn receivers_of<'a>(net: &str, receivers: &'a [(String, Vec<String>)]) -> Vec<&'a str> {
    receivers.iter().filter(|(pattern, _)| glob_match(net, pattern)).flat_map(|(_, refs)| refs.iter().map(String::as_str)).collect()
}

#[derive(Default)]
struct Found<'a> {
    drivers: Vec<Driver<'a>>,
    unknowns: Vec<String>,
    connectors: Vec<String>,
}

struct Search<'a, 'b> {
    lookup: &'b Lookup<'a>,
    class: Option<&'b EdgeClass>,
    seen: Vec<String>,
}

impl<'a> Search<'a, '_> {
    /// Follows a 2-pin series resistor or ferrite to a net that is not a rail.
    fn through_series(&mut self, net: &str, part: &str, prefix: &str, series: &[(String, Option<f64>)], found: &mut Found<'a>) {
        let nl = self.lookup.netlist;
        let others: Vec<&str> = nl.nets.iter().filter(|(n, nodes)| n != net && nodes.iter().any(|node| node.part == part)).map(|(n, _)| n.as_str()).collect();
        let [other] = others[..] else { return };
        if self.seen.iter().any(|s| s == other) || is_rail(other, self.lookup.power) {
            return;
        }
        self.seen.push(other.to_string());
        let ohms = if prefix == "R" { nl.values.get(part).and_then(|v| r_value(v)) } else { None };
        let mut series = series.to_vec();
        series.push((part.to_string(), ohms));
        let inner = self.walk(other, &series);
        for mut d in inner.drivers {
            if d.edge.is_some() {
                d.text = format!("{} (through {part} from {other})", d.text);
            }
            found.drivers.push(d);
        }
        found.unknowns.extend(inner.unknowns.into_iter().map(|t| format!("{t} (through {part} from {other})")));
    }

    fn walk(&mut self, net: &str, series: &[(String, Option<f64>)]) -> Found<'a> {
        let mut found = Found::default();
        let receivers = receivers_of(net, self.lookup.receivers);
        let nl = self.lookup.netlist;
        for node in nl.net(net).unwrap_or(&[]) {
            let prefix = ref_prefix(&node.part);
            if receivers.contains(&node.part.as_str()) {
                continue;
            }
            if CONNECTOR.contains(&prefix.as_str()) {
                found.connectors.push(format!("{}.{}", node.part, node.pin));
                continue;
            }
            if PASSIVE.contains(&prefix.as_str()) {
                if SERIES.contains(&prefix.as_str()) {
                    self.through_series(net, &node.part, &prefix, series, &mut found);
                }
                continue;
            }
            let (part, name) = (&node.part, &node.name);
            let mpn = nl.comps.get(part).map_or("", String::as_str);
            let driver = |edge, text, estimated| Driver { part: part.clone(), pin: name.clone(), edge, text, estimated };
            match pin_edge(mpn, name, self.lookup.table, self.class) {
                PinEdge::Input => {}
                PinEdge::Unknown(text) => found.unknowns.push(format!("{part}.{name} {text}")),
                PinEdge::Driver(edge, text) => found.drivers.push(driver(Some(edge), format!("{part}.{name} {text}"), None)),
                PinEdge::Estimated(p, rule) => found.drivers.push(driver(None, String::new(), Some(Estimated { part: p, rule, home: net.to_string(), series: series.to_vec() }))),
            }
        }
        found
    }
}

fn resolve<'a>(net: &str, lookup: &Lookup, found: Found<'a>) -> (Vec<(f64, String)>, Vec<String>) {
    let (mut resolved, mut unknowns) = (Vec::new(), found.unknowns);
    for d in found.drivers {
        let Some(estimated) = &d.estimated else {
            resolved.push((d.edge.expect("a plain driver has an edge"), d.text));
            continue;
        };
        match estimate::edge_of(&d.part, &d.pin, estimated, net, lookup) {
            Ok(Ok(row)) => resolved.push(row),
            Ok(Err(reason)) => unknowns.push(reason),
            Err(error) => unknowns.push(format!("{}.{}: invalid conditional estimate: {error}", d.part, d.pin)),
        }
    }
    (resolved, unknowns)
}

fn offboard_edge(net: &str, lookup: &Lookup, connectors: &[String]) -> Option<Edge> {
    let (_, o) = lookup.offboard.iter().find(|(pattern, _)| glob_match(net, pattern))?;
    let Some(class) = lookup.rates.get(&o.class) else {
        return Some(Edge::Unknown(format!("offboard class {} is not in tools/edge-rates.json", o.class)));
    };
    if connectors.is_empty() {
        return Some(Edge::Unknown("offboard class requires an actual schematic connector endpoint".to_string()));
    }
    if !class.is_protocol() && !class_covers(class, &o.driver_mpn, &o.driver_pin) {
        return Some(Edge::Unknown("offboard driver MPN/pin absent or incompatible with part-bound class".to_string()));
    }
    Some(Edge::Known { edge_ns: class.tr_ns, driver: format!("off-board via {}: class {} ({}); {}", connectors.join(", "), o.class, class.source, o.reason) })
}

/// The edge of a net. `interface`: its "edge_classes" class, when the lookup goes by class (D-124d).
pub fn net_edge(net: &str, lookup: &Lookup, interface: Option<&str>) -> Edge {
    let Some(nodes) = lookup.netlist.net(net) else { return Edge::Unknown(format!("net {net} is not in the schematic netlist")) };
    let class = interface.and_then(|name| lookup.rates.get(name).map(|c| (name, c)));
    if let Some((name, c)) = class.filter(|(_, c)| c.is_protocol()) {
        if nodes.is_empty() {
            return Edge::Unknown("interface net has no schematic endpoints".to_string());
        }
        let Applicability::Protocol { reason } = &c.applicability else { unreachable!("checked above") };
        return Edge::Known { edge_ns: c.tr_ns, driver: format!("protocol {name}: {reason}; {}", c.source) };
    }
    let mut search = Search { lookup, class: class.map(|(_, c)| c), seen: vec![net.to_string()] };
    let found = search.walk(net, &[]);
    let connectors = found.connectors.clone();
    let (drivers, unknowns) = resolve(net, lookup, found);
    if !unknowns.is_empty() {
        return Edge::Unknown(unknowns.join("; "));
    }
    if let Some((edge_ns, driver)) = drivers.iter().fold(None::<&(f64, String)>, |best, d| if best.is_none_or(|b| d.0 < b.0) { Some(d) } else { best }) {
        return Edge::Known { edge_ns: *edge_ns, driver: driver.clone() };
    }
    if let Some(edge) = offboard_edge(net, lookup, &connectors) {
        return edge;
    }
    if connectors.is_empty() {
        Edge::Unknown("no driver pin on the net".to_string())
    } else {
        Edge::Unknown(format!("driven from off-board via {}; no interface class (spec \"offboard\")", connectors.join(", ")))
    }
}

#[cfg(test)]
mod tests;
