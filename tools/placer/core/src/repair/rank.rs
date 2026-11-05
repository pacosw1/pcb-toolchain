//! A proposal and the order of proposals.

use super::search::PLACES;
use crate::congest::{HistoryMap, PinHeat};
use crate::geom::Turn;
use crate::numeric::round_to;
use crate::problem::Problem;
use serde::Serialize;
use std::cmp::Ordering;
use std::collections::{BTreeMap, HashSet};

/// The problem a proposal belongs to. The order is the rank's: by name.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Tag {
    Loose,
    Main,
}

/// What a proposal repairs.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Move {
    /// A failure point.
    Plain,
    /// A failed IC pin.
    Escape,
}

impl Move {
    fn is_plain(&self) -> bool {
        *self == Self::Plain
    }
}

#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct Proposal {
    pub problem: Tag,
    #[serde(skip_serializing_if = "Move::is_plain")]
    pub kind: Move,
    pub unit: usize,
    pub name: String,
    pub x: f64,
    pub y: f64,
    pub r: Turn,
    pub term: f64,
    pub term0: f64,
    pub dcost: f64,
    pub disp: f64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub dhot: Option<f64>,
}

/// A negative zero equals a positive one here, as in a tuple of Python floats.
fn number(a: f64, b: f64) -> Ordering {
    a.partial_cmp(&b).unwrap_or(Ordering::Equal)
}

/// Largest failure-term decrease first (the main and the loose problem have different absolute terms), then placement cost,
/// displacement and a fixed order.
pub fn rank(a: &Proposal, b: &Proposal) -> Ordering {
    let decrease = |c: &Proposal| round_to(c.term - c.term0, PLACES);
    number(decrease(a), decrease(b))
        .then_with(|| number(a.dcost, b.dcost))
        .then_with(|| number(a.disp, b.disp))
        .then_with(|| a.problem.cmp(&b.problem))
        .then_with(|| a.unit.cmp(&b.unit))
        .then_with(|| number(a.x, b.x))
        .then_with(|| number(a.y, b.y))
        .then_with(|| a.r.cmp(&b.r))
}

/// Best first per unit, then round-robin over the units, the unit with the best proposal first.
pub fn interleave(mut props: Vec<Proposal>) -> Vec<Proposal> {
    props.sort_by(rank);
    let mut per_unit: BTreeMap<(Tag, usize), Vec<Proposal>> = BTreeMap::new();
    for c in props {
        per_unit.entry((c.problem, c.unit)).or_default().push(c);
    }
    let mut queues: Vec<Vec<Proposal>> = per_unit.into_values().collect();
    queues.sort_by(|a, b| rank(&a[0], &b[0]));
    let depth = queues.iter().map(Vec::len).max().unwrap_or(0);
    let mut queues: Vec<_> = queues.into_iter().map(Vec::into_iter).collect();
    let mut out = Vec::new();
    for _ in 0..depth {
        out.extend(queues.iter_mut().filter_map(Iterator::next));
    }
    out
}

/// first[0], second[0], first[1], second[1], ... with no unit pose twice.
pub fn alternate(first: &[Proposal], second: &[Proposal]) -> Vec<Proposal> {
    let bits = |v: f64| (v + 0.0).to_bits();
    let mut seen = HashSet::new();
    let mut out = Vec::new();
    for k in 0..first.len().max(second.len()) {
        for c in [first.get(k), second.get(k)].into_iter().flatten() {
            if seen.insert((c.problem, c.unit, bits(c.x), bits(c.y), c.r)) {
                out.push(c.clone());
            }
        }
    }
    out
}

/// Rank 'hot' (README "Repair rank by router congestion"): the proposals that take the most PathFinder history of the present
/// route away from the unit's signal pins first (dhot = history at the pins after - before), then the given order.
pub fn hot_order(props: Vec<Proposal>, main: &Problem, loose: Option<&Problem>, map: &HistoryMap) -> Vec<Proposal> {
    let heat = |pr: &Problem| PinHeat::new(pr, map.clone());
    let (main_heat, loose_heat) = (heat(main), loose.map(heat));
    let mut out: Vec<Proposal> = props.into_iter().map(|mut c| {
        let (model, pr) = match (c.problem, &loose_heat, loose) {
            (Tag::Loose, Some(model), Some(pr)) => (model, pr),
            _ => (&main_heat, main),
        };
        c.dhot = Some(round_to(model.value(c.unit, (c.x, c.y, c.r)) - model.value(c.unit, pr.units[c.unit].place()), PLACES));
        c
    }).collect();
    out.sort_by(|a, b| number(a.dhot.unwrap_or(0.0), b.dhot.unwrap_or(0.0)));
    out
}
