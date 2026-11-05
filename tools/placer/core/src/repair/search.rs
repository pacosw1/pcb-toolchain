//! Legal places on the legalizer grid (legal_step, out to legal_radius) and the 4 turns that lower a term: one per unit, direction
//! octant and turn, the best by rank.

use super::failure::{Failure, Term, candidates};
use super::rank::{Move, Proposal, Tag, interleave, rank};
use crate::evaluator::Evaluator;
use crate::geom::{EPS, Turn};
use crate::model::Model;
use crate::numeric::{hypot, round_to};
use crate::params::Params;
use crate::problem::{Place, Problem};
use crate::search::legalize::ring;
use std::cmp::Ordering;
use std::collections::BTreeMap;
use std::f64::consts::PI;

/// Output numbers keep this many places.
pub const PLACES: usize = 6;

/// An extra legality rule of a move.
pub type Allowed<'a> = &'a dyn Fn(usize, Place) -> bool;

pub fn anywhere(_unit: usize, _place: Place) -> bool {
    true
}

/// What a search looks at.
pub struct Scope<'a> {
    pub problem: &'a Problem,
    pub pose: &'a [Place],
    pub fails: &'a [Failure],
    pub params: Params,
    pub rotate: bool,
    pub tag: Tag,
}

impl<'a> Scope<'a> {
    pub fn new(problem: &'a Problem, pose: &'a [Place], fails: &'a [Failure], rotate: bool, tag: Tag) -> Self {
        Self { problem, pose, fails, params: Params::default(), rotate, tag }
    }

    fn turns(&self, i: usize) -> Vec<Turn> {
        let r0 = self.pose[i].2;
        let others = (0..4).filter(|&r| r != r0 && self.rotate && self.problem.units[i].rotate);
        std::iter::once(r0).chain(others).collect()
    }
}

fn octant(dx: f64, dy: f64) -> i8 {
    ((((dy.atan2(dx) + PI) / (2.0 * PI)) * 8.0 + 0.5) as i64 % 8) as i8
}

fn sites(rings: i64) -> impl Iterator<Item = (i64, i64)> {
    std::iter::once((0, 0)).chain((1..=rings).flat_map(ring))
}

/// What a scan keeps of a place, by rank.
struct Best<'s> {
    scope: &'s Scope<'s>,
    kind: Move,
    term0: f64,
    found: BTreeMap<(usize, i8, Turn), Proposal>,
}

impl Best<'_> {
    fn keep(&mut self, unit: usize, (a, b): (i64, i64), place: Place, term: f64, dcost: f64, disp: f64) {
        let round = |v| round_to(v, PLACES);
        let (x, y, r) = place;
        let name = self.scope.problem.units[unit].name.clone();
        let candidate = Proposal {
            problem: self.scope.tag, kind: self.kind, unit, name, x: round(x), y: round(y), r,
            term: round(term), term0: round(self.term0), dcost: round(dcost), disp: round(disp), dhot: None,
        };
        let direction = if a != 0 || b != 0 { octant(a as f64, b as f64) } else { -1 };
        let key = (unit, direction, r);
        if self.found.get(&key).is_none_or(|held| rank(&candidate, held) == Ordering::Less) {
            self.found.insert(key, candidate);
        }
    }
}

/// Every place of `units` that is legal, allowed, within the radius and lowers `term` below `term0`; best first.
pub fn scan(s: &Scope, ev: &mut Evaluator, units: &[usize], kind: Move, term0: f64, allowed: Allowed, mut term: impl FnMut(usize, Place) -> f64) -> Vec<Proposal> {
    let (step, radius) = (s.params.legal_step, s.params.legal_radius);
    let rings = (radius / step + EPS) as i64;
    let mut best = Best { scope: s, kind, term0, found: BTreeMap::new() };
    for &i in units {
        let (x0, y0, r0) = s.pose[i];
        let turns = s.turns(i);
        for (a, b) in sites(rings) {
            let (x, y) = (x0 + a as f64 * step, y0 + b as f64 * step);
            let disp = hypot(x - x0, y - y0);
            if disp > radius + EPS {
                continue;
            }
            for &r in &turns {
                let place = (x, y, r);
                if (a == 0 && b == 0 && r == r0) || ev.legal_penalty_at(i, place) > EPS || !allowed(i, place) {
                    continue;
                }
                let value = term(i, place);
                if value >= term0 - EPS {
                    continue;
                }
                let dcost = ev.propose(&[(i, place)]);
                ev.revert();
                best.keep(i, (a, b), place, value, dcost, disp);
            }
        }
    }
    interleave(best.found.into_values().collect())
}

/// Legal, failure-improving single-unit moves of `units` (default: the candidates), best first.
pub fn proposals(s: &Scope, units: Option<Vec<usize>>, allowed: Allowed) -> crate::Result<Vec<Proposal>> {
    let model = Model::new(s.problem, &s.params)?;
    let mut ev = Evaluator::new(&model, &s.params, s.pose);
    let radius = s.params.legal_radius;
    let mut term = Term::new(s.problem, s.pose, s.fails, radius);
    let term0 = term.value(None);
    let units = units.unwrap_or_else(|| candidates(s.problem, s.pose, s.fails, radius));
    Ok(scan(s, &mut ev, &units, Move::Plain, term0, allowed, |i, place| term.value(Some((i, place)))))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_octant_per_direction() {
        let seen: Vec<i8> = [(1, 0), (1, 1), (0, 1), (-1, 1), (-1, 0), (-1, -1), (0, -1), (1, -1)].map(|(a, b): (i32, i32)| octant(a.into(), b.into())).to_vec();
        assert_eq!(seen, [4, 5, 6, 7, 0, 1, 2, 3]);
    }
}
