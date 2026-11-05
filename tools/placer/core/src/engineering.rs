//! A reviewed engineering contract inside the search: how far a pose misses the pose-level rules, in mm.
//!
//! The contract is made and verified by tools/placer/engineering-problem.ts, which also writes the full report of a pose.
//! The search only needs the sum of the misses, as a legality term. An escape rule has no pose proxy: exact native evidence
//! checks it after the placement.

use crate::numeric::hypot;
use crate::problem::{Pose, Unit};
use serde::Deserialize;
use serde_json::Value;
use std::collections::{BTreeMap, BTreeSet};

type Xy = (f64, f64);
type Box4 = [f64; 4];

#[derive(Debug, Deserialize)]
struct Pad {
    center: Xy,
    shape: String,
    size: Xy,
    layers: Vec<String>,
}

#[derive(Debug, Deserialize)]
struct Part {
    origin: Xy,
    quarter: f64,
    pads: BTreeMap<String, Vec<Pad>>,
    courtyard: Option<Box4>,
    locked: bool,
}

#[derive(Debug, Deserialize)]
struct Geometry {
    refs: BTreeMap<String, Part>,
    bounds: Option<Box4>,
}

#[derive(Debug, Deserialize)]
struct Endpoint {
    #[serde(rename = "ref")]
    reference: String,
    pad: Value,
}

#[derive(Debug, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
enum Rule {
    Fixed { refs: Vec<String> },
    RigidGroup {
        refs: Vec<String>,
        #[serde(default)]
        retained_internal_copper: bool,
    },
    PinDistance { a: Endpoint, b: Endpoint, min_mm: Option<f64>, max_mm: Option<f64> },
    Clearance { a: Endpoint, b: Endpoint, min_mm: Option<f64> },
    ConnectorAccess {
        #[serde(rename = "ref")]
        reference: String,
        corridor_mm: Box4,
        exit_side: String,
    },
    Escape { refs: Vec<String> },
}

impl Rule {
    fn refs(&self) -> Vec<&str> {
        match self {
            Self::Fixed { refs } | Self::RigidGroup { refs, .. } | Self::Escape { refs } => refs.iter().map(String::as_str).collect(),
            Self::PinDistance { a, b, .. } | Self::Clearance { a, b, .. } => vec![&a.reference, &b.reference],
            Self::ConnectorAccess { reference, .. } => vec![reference],
        }
    }
}

#[derive(Debug, Deserialize)]
struct Document {
    rules: Vec<Rule>,
    geometry: Geometry,
    #[serde(rename = "where")]
    unit_of: BTreeMap<String, usize>,
}

/// Rules, source geometry and the unit origins the contract was read with.
#[derive(Debug)]
pub struct Contract {
    doc: Document,
    /// The rule indexes that a move of each unit can change. A connector corridor depends on every part.
    unit_rules: Vec<Vec<usize>>,
    anchors: Vec<Xy>,
}

/// A part at a pose: where it was read and where it stands now.
struct Moved<'a> {
    part: &'a Part,
    from: Xy,
    to: Xy,
    turn: f64,
}

/// (x, y) turned by q quarters as in a KiCad board (y down), then moved to origin.
fn turned(x: f64, y: f64, q: f64, origin: Xy) -> Xy {
    let (a, b) = match q {
        0.0 => (x, y),
        1.0 => (y, -x),
        2.0 => (-x, -y),
        3.0 => (-y, x),
        _ => {
            let angle = (q * 90.0).to_radians();
            (x * angle.cos() + y * angle.sin(), -x * angle.sin() + y * angle.cos())
        }
    };
    (origin.0 + a, origin.1 + b)
}

fn turned_box([x0, y0, x1, y1]: Box4, q: f64, origin: Xy) -> Box4 {
    let corners = [(x0, y0), (x1, y0), (x1, y1), (x0, y1)].map(|(x, y)| turned(x, y, q, origin));
    let fold = |f: fn(f64, f64) -> f64, pick: fn(&Xy) -> f64| corners.iter().map(pick).reduce(f).unwrap_or(0.0);
    [fold(f64::min, |p| p.0), fold(f64::min, |p| p.1), fold(f64::max, |p| p.0), fold(f64::max, |p| p.1)]
}

impl Moved<'_> {
    fn at(&self, p: Xy) -> Xy {
        turned(p.0 - self.from.0, p.1 - self.from.1, self.turn, self.to)
    }

    fn origin(&self) -> Xy {
        self.at(self.part.origin)
    }

    fn quarter(&self) -> f64 {
        (self.part.quarter + self.turn).rem_euclid(4.0)
    }

    fn courtyard(&self) -> Option<Box4> {
        let [a, b, c, d] = self.part.courtyard?;
        let (fx, fy) = self.from;
        Some(turned_box([a - fx, b - fy, c - fx, d - fy], self.turn, self.to))
    }
}

/// A pad at a pose: its centre and size. Odd turns swap the size.
struct Copper<'a> {
    pad: &'a Pad,
    center: Xy,
    size: Xy,
}

fn round6(v: f64) -> f64 {
    (v * 1e6).round() / 1e6
}

/// Copper-to-copper distance of two axis-aligned rect or circle pads.
fn pad_gap(first: &Copper, second: &Copper) -> f64 {
    let (a, b) = if first.pad.shape == "circle" && second.pad.shape != "circle" { (second, first) } else { (first, second) };
    if a.pad.shape == "circle" {
        return hypot(a.center.0 - b.center.0, a.center.1 - b.center.1) - (a.size.0 + b.size.0) / 2.0;
    }
    let dx = (a.center.0 - b.center.0).abs() - a.size.0 / 2.0;
    let dy = (a.center.1 - b.center.1).abs() - a.size.1 / 2.0;
    if b.pad.shape == "circle" {
        return hypot(dx.max(0.0), dy.max(0.0)) - b.size.0 / 2.0;
    }
    hypot((dx - b.size.0 / 2.0).max(0.0), (dy - b.size.1 / 2.0).max(0.0))
}

fn shares_copper(a: &Pad, b: &Pad) -> bool {
    a.layers.iter().any(|l| l == "*.Cu" || b.layers.contains(l)) || b.layers.iter().any(|l| l == "*.Cu")
}

fn pad_key(pad: &Value) -> String {
    pad.as_str().map_or_else(|| pad.to_string(), String::from)
}

impl Contract {
    /// The contract of a problem. `value` was verified by its producer; here each rule must be one this module can measure.
    pub fn new(value: &Value, units: &[Unit]) -> crate::Result<Self> {
        let doc: Document = serde_json::from_value(value.clone()).map_err(|e| format!("engineering contract: {e}"))?;
        let contract = Self { unit_rules: rules_of_units(&doc, units.len())?, anchors: units.iter().map(|u| (u.x, u.y)).collect(), doc };
        contract.check_rules()?;
        Ok(contract)
    }

    fn check_rules(&self) -> crate::Result<()> {
        for rule in &self.doc.rules {
            match rule {
                Rule::PinDistance { a, b, .. } => {
                    self.endpoint(a)?;
                    self.endpoint(b)?;
                }
                Rule::Clearance { a, b, .. } => {
                    let (a, b) = (self.endpoint(a)?, self.endpoint(b)?);
                    if !shares_copper(a, b) {
                        return Err("clearance endpoints have no common modeled copper layer".into());
                    }
                    if [a, b].iter().any(|p| p.shape == "circle" && p.size.0 != p.size.1) {
                        return Err("noncircular native circle pad".into());
                    }
                }
                Rule::ConnectorAccess { .. } => {
                    if self.doc.geometry.bounds.is_none() || self.doc.geometry.refs.values().any(|p| p.courtyard.is_none()) {
                        return Err("connector access needs board edges and every footprint courtyard".into());
                    }
                }
                Rule::Fixed { .. } | Rule::RigidGroup { .. } | Rule::Escape { .. } => {}
            }
            if let Some(unknown) = rule.refs().iter().find(|r| !self.doc.geometry.refs.contains_key(**r)) {
                return Err(format!("engineering rule names {unknown}, which the reviewed geometry does not hold").into());
            }
        }
        Ok(())
    }

    fn endpoint(&self, e: &Endpoint) -> crate::Result<&Pad> {
        let rows = self.doc.geometry.refs.get(&e.reference).and_then(|p| p.pads.get(&pad_key(&e.pad)));
        match rows.map(Vec::as_slice) {
            Some([pad]) => Ok(pad),
            _ => Err(format!("pad endpoint missing or ambiguous: {}.{}", e.reference, pad_key(&e.pad)).into()),
        }
    }

    fn moved(&self, reference: &str, pose: &Pose) -> Moved<'_> {
        let part = &self.doc.geometry.refs[reference];
        let unit = self.doc.unit_of[reference];
        let (x, y, r) = pose[unit];
        Moved { part, from: self.anchors[unit], to: (x, y), turn: f64::from(r) }
    }

    fn copper(&self, e: &Endpoint, pose: &Pose) -> Copper<'_> {
        let at = self.moved(&e.reference, pose);
        let pad = &at.part.pads[&pad_key(&e.pad)][0];
        let size = if at.turn % 2.0 == 1.0 { (pad.size.1, pad.size.0) } else { pad.size };
        Copper { pad, center: at.at(pad.center), size }
    }

    /// Each part's (turn, x, y) relative to its source, the way a rigid move of the whole group shows.
    fn transform(&self, reference: &str, pose: &Pose) -> (f64, f64, f64) {
        let at = self.moved(reference, pose);
        let q = (at.quarter() - at.part.quarter).rem_euclid(4.0);
        let (x, y) = turned(at.part.origin.0, at.part.origin.1, q, (0.0, 0.0));
        let origin = at.origin();
        (q, round6(origin.0 - x), round6(origin.1 - y))
    }

    fn rigid_miss(&self, refs: &[String], frozen: bool, pose: &Pose) -> f64 {
        let moves: Vec<_> = refs.iter().map(|r| self.transform(r, pose)).collect();
        let bad = if frozen { moves.iter().any(|&m| m != (0.0, 0.0, 0.0)) } else { moves.windows(2).any(|w| w[0] != w[1]) };
        f64::from(u8::from(bad))
    }

    fn connector_miss(&self, reference: &str, corridor: Box4, exit: &str, pose: &Pose) -> f64 {
        let at = self.moved(reference, pose);
        let [a, b, c, d] = turned_box(corridor, at.quarter(), at.origin());
        let Some([x0, y0, x1, y1]) = self.doc.geometry.bounds else { return 1.0 };
        let reaches = match exit {
            "L" => a <= x0,
            "R" => c >= x1,
            "T" => b <= y0,
            _ => d >= y1,
        };
        let clash = self.doc.geometry.refs.keys().filter(|r| *r != reference).any(|r| {
            self.moved(r, pose).courtyard().is_some_and(|[p, q, s, t]| c.min(s) > a.max(p) && d.min(t) > b.max(q))
        });
        f64::from(u8::from(clash || !reaches))
    }

    fn rule_miss(&self, rule: &Rule, pose: &Pose) -> f64 {
        match rule {
            Rule::Escape { .. } => 0.0,
            Rule::Fixed { refs } => self.rigid_miss(refs, true, pose),
            Rule::RigidGroup { refs, retained_internal_copper } => self.rigid_miss(refs, *retained_internal_copper, pose),
            Rule::PinDistance { a, b, min_mm, max_mm } => {
                let (p, q) = (self.copper(a, pose).center, self.copper(b, pose).center);
                let measured = hypot(p.0 - q.0, p.1 - q.1);
                (min_mm.unwrap_or(0.0) - measured).max(0.0).max(measured - max_mm.unwrap_or(f64::INFINITY))
            }
            Rule::Clearance { a, b, min_mm } => (min_mm.unwrap_or(0.0) - pad_gap(&self.copper(a, pose), &self.copper(b, pose))).max(0.0),
            Rule::ConnectorAccess { reference, corridor_mm, exit_side } => self.connector_miss(reference, *corridor_mm, exit_side, pose),
        }
    }

    fn locked_part_moved(&self, reference: &str, pose: &Pose) -> bool {
        let at = self.moved(reference, pose);
        at.part.locked && (at.origin() != at.part.origin || at.quarter() != at.part.quarter)
    }

    /// The miss of the rules that unit i takes part in, at a pose, plus 1 for each locked part those rules touch that moved.
    pub fn miss(&self, i: usize, pose: &Pose) -> f64 {
        let rules: Vec<&Rule> = self.unit_rules[i].iter().map(|&k| &self.doc.rules[k]).collect();
        let misses: f64 = rules.iter().map(|r| self.rule_miss(r, pose)).sum();
        let connector = rules.iter().any(|r| matches!(r, Rule::ConnectorAccess { .. }));
        let touched: BTreeSet<&str> = if connector {
            self.doc.geometry.refs.keys().map(String::as_str).collect()
        } else {
            rules.iter().flat_map(|r| r.refs()).collect()
        };
        misses + touched.into_iter().filter(|r| self.locked_part_moved(r, pose)).count() as f64
    }
}

fn rules_of_units(doc: &Document, units: usize) -> crate::Result<Vec<Vec<usize>>> {
    let mut rows = vec![Vec::new(); units];
    for (k, rule) in doc.rules.iter().enumerate() {
        let every = matches!(rule, Rule::ConnectorAccess { .. });
        for (i, row) in rows.iter_mut().enumerate() {
            let mine = rule.refs().iter().any(|r| doc.unit_of.get(*r) == Some(&i));
            if every || mine {
                row.push(k);
            }
        }
    }
    if doc.unit_of.values().any(|&i| i >= units) {
        return Err("engineering reference-to-unit map names a unit outside the problem".into());
    }
    Ok(rows)
}
