//! Escape-aware proposals: moves of the units that wall in a failed IC pin (an unconnected item at an escape pin).
//!
//! The term is the sum of blocked(pin) over the failed pins, against every copper pad of the board; it must decrease. The cost
//! delta comes from an evaluator with the escape term, so a move that walls in another pin ranks lower.

use super::failure::{Failure, Kind, movable, ref_units};
use super::rank::{Move, Proposal};
use super::search::{Allowed, Scope, scan};
use crate::escape::{EscapeModel, all_copper};
use crate::evaluator::Evaluator;
use crate::geom::EPS;
use crate::model::Model;
use crate::numeric::compensated;
use crate::params::Params;
use crate::problem::{Place, Problem};
use std::collections::{BTreeMap, BTreeSet};

/// w_esc of the evaluator that ranks escape moves: the weight the compaction runs use.
const ESCAPE_WEIGHT: f64 = 20.0;

/// (unit, pin index) of the IC escape pins that an unconnected item names.
pub fn failed_pins(pr: &Problem, fails: &[Failure], esc: &EscapeModel) -> Vec<(usize, usize)> {
    let by_ref = ref_units(pr);
    let mut out = BTreeSet::new();
    for item in fails.iter().filter(|f| f.kind == Kind::Unconnected).flat_map(|f| &f.items) {
        let Some(reference) = item.reference.as_deref() else { continue };
        let Some((&i, Some(pins))) = by_ref.get(reference).map(|i| (i, esc.pins[*i].as_ref())) else { continue };
        let meta = &pr.units[i].cu_pads;
        for a in 0..pins.len() {
            let number = meta.get(pins.rows[a]).and_then(|m| m.number.as_deref());
            if pins.refs[a] == reference && number.is_some() && number == item.pad.as_deref() {
                out.insert((i, a));
            }
        }
    }
    out.into_iter().collect()
}

/// Movable units whose copper is within the track radius of a ray of one of the pins: the units that wall a pin in. Nearest first.
pub fn corridor_blockers(pr: &Problem, pose: &[Place], model: &Model, esc: &EscapeModel, pins: &[(usize, usize)]) -> Vec<usize> {
    let copper = all_copper(model, esc, pose);
    let mut best: BTreeMap<usize, f64> = BTreeMap::new();
    for &(i, a) in pins {
        let q = esc.pins[i].as_ref().expect("a failed pin has pins");
        for pad in copper.iter().filter(|pad| pad.unit != i && !q.passes(i, a, pad) && movable(pr, pad.unit)) {
            let gap = q.gap_to(a, pose[i], pad.rect);
            if gap < q.track_radius(a) {
                let nearest = best.entry(pad.unit).or_insert(f64::INFINITY);
                *nearest = nearest.min(gap);
            }
        }
    }
    let mut order: Vec<(usize, f64)> = best.into_iter().collect();
    order.sort_by(|a, b| a.1.total_cmp(&b.1).then(a.0.cmp(&b.0)));
    order.into_iter().map(|(j, _)| j).collect()
}

fn blocked_sum(model: &Model, esc: &EscapeModel, pins: &[(usize, usize)], pose: &[Place]) -> f64 {
    let copper = all_copper(model, esc, pose);
    compensated(pins.iter().map(|&(i, a)| esc.pins[i].as_ref().expect("a failed pin has pins").blocked(i, a, pose[i], &copper)))
}

/// The escape weight, unless the scope sets one.
fn with_escape(params: &Params) -> Params {
    let weight = if params.w_esc != 0.0 { params.w_esc } else { ESCAPE_WEIGHT };
    Params { w_esc: weight, ..params.clone() }
}

/// Legal single-unit moves of the units that wall in a failed pin, best first. None when no failed pin is blocked.
pub fn proposals(s: &Scope, allowed: Allowed) -> crate::Result<Vec<Proposal>> {
    let params = with_escape(&s.params);
    let model = Model::new(s.problem, &params)?;
    let esc = model.escape.as_ref().ok_or("the escape weight makes an escape model")?;
    let pins = failed_pins(s.problem, s.fails, esc);
    if pins.is_empty() {
        return Ok(Vec::new());
    }
    let term0 = blocked_sum(&model, esc, &pins, s.pose);
    if term0 <= EPS {
        return Ok(Vec::new());
    }
    let mut ev = Evaluator::new(&model, &params, s.pose);
    let blockers = corridor_blockers(s.problem, s.pose, &model, esc, &pins);
    let mut trial = s.pose.to_vec();
    Ok(scan(s, &mut ev, &blockers, Move::Escape, term0, allowed, |j, place| {
        let old = std::mem::replace(&mut trial[j], place);
        let value = blocked_sum(&model, esc, &pins, &trial);
        trial[j] = old;
        value
    }))
}
