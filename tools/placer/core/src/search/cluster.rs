//! Soft clusters in the search (read/clusters.rs): the groups a move takes as one, and the start pose with each part at its pin.
//!
//! A group = the units of a cluster that nothing holds to a place. A fixed unit, an edge anchor, a region box, a near rule or a rule
//! of the reviewed contract stays out, and pulls the others only by the cost of its tie: a cluster never overrides a constraint.

use super::legalize::ring;
use crate::evaluator::Evaluator;
use crate::geom::turn_point;
use crate::model::Model;
use crate::numeric::hypot;
use crate::params::Params;
use crate::problem::{Cluster, Pose, Problem};

/// mm: how far from its pin `gather` looks for room. A part stays where it is when none is free. To tune.
const REACH: f64 = 10.0;
const LEGAL: f64 = 1e-9;

#[derive(Clone, Debug)]
pub struct Group {
    /// The first unit is the pivot of a turn.
    pub units: Vec<usize>,
    pub turn: bool,
}

/// True when a constraint holds unit i to a place.
pub fn held(pr: &Problem, i: usize) -> bool {
    let u = &pr.units[i];
    u.fixed || u.edge.is_some() || u.in_box.is_some() || !u.near.is_empty() || pr.contract.as_ref().is_some_and(|c| c.binds(i))
}

/// A radius from the seed place is a promise per unit: cluster moves stay off with one.
pub fn active(pr: &Problem, p: &Params) -> bool {
    !pr.clusters.is_empty() && p.max_displacement == 0.0
}

pub fn groups(model: &Model) -> Vec<Group> {
    let pr = model.problem;
    let free = |c: &Cluster| c.units.iter().copied().filter(|&i| !held(pr, i)).collect::<Vec<_>>();
    let rows = pr.clusters.iter().map(free).filter(|g| g.len() > 1);
    rows.map(|units| Group { turn: units.iter().all(|&i| model.units[i].rotate), units }).collect()
}

/// Offsets from the middle out, on square rings up to `rings`.
fn around(rings: i64) -> impl Iterator<Item = (i64, i64)> {
    std::iter::once((0, 0)).chain((1..=rings).flat_map(ring))
}

/// The start pose with each tied part at the pin it is tied to, on the nearest free place. A part already within clu_local mm of
/// its pin stays, so a warm start keeps its placement.
pub fn gather(model: &Model, p: &Params, pose: &Pose) -> Pose {
    let pr = model.problem;
    let mut ev = Evaluator::new(model, p, pose);
    let rings = (REACH / p.legal_step) as i64;
    for tie in pr.clusters.iter().flat_map(|c| &c.ties).filter(|t| !held(pr, t.unit)) {
        let (x, y, r) = ev.place(tie.unit);
        let (tx, ty, tr) = ev.place(tie.to);
        let (px, py) = turn_point(tie.target, tr);
        let (ax, ay) = turn_point(tie.at, r);
        let (gx, gy) = (tx + px - ax, ty + py - ay);
        if hypot(gx - x, gy - y) <= p.clu_local {
            continue;
        }
        let places = around(rings).map(|(a, b)| (gx + a as f64 * p.legal_step, gy + b as f64 * p.legal_step, r));
        if let Some(place) = places.into_iter().find(|&place| ev.legal_penalty_at(tie.unit, place) <= LEGAL) {
            ev.propose(&[(tie.unit, place)]);
            ev.commit();
        }
    }
    ev.pose()
}
