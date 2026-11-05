//! Moves of single tied decaps. A decap that the reader ties to its IC is rigid in the main problem; in the loose problem (read
//! with --decap-tie 0) it may move alone while the tie stays true: its pad-edge gap to the IC pin (the gap the reader ties on) is
//! within the tie distance.

use super::corridor;
use super::failure::{Failure, candidates, ref_units};
use super::rank::{Proposal, Tag};
use super::search::{self, Scope};
use crate::geom::{EPS, Rect, TaggedRect};
use crate::numeric::hypot;
use crate::params::Params;
use crate::problem::{Place, Problem};
use std::collections::{BTreeMap, BTreeSet};

fn world_box(q: &TaggedRect, (x, y, r): Place) -> Rect {
    q.rect.turned(r).shifted(x, y)
}

fn box_gap(a: Rect, b: Rect) -> f64 {
    hypot((a.x0 - b.x1).max(0.0).max(b.x0 - a.x1), (a.y0 - b.y1).max(0.0).max(b.y0 - a.y1))
}

fn gnd_codes(pr: &Problem) -> BTreeSet<i64> {
    pr.cu_nets.iter().filter(|(_, (name, _))| name == "GND").filter_map(|(code, _)| code.parse().ok()).collect()
}

/// {loose unit of a tied decap: loose unit of its IC}, for the caps of `pr` that are a unit of their own in the loose problem.
pub fn tied_decaps(pr: &Problem, loose: &Problem) -> BTreeMap<usize, usize> {
    let units = ref_units(loose);
    let mut out = BTreeMap::new();
    for (cap, ic, _) in pr.decaps.iter().flatten() {
        if let (Some(&c), Some(&i)) = (units.get(cap.as_str()), units.get(ic.as_str())) {
            if loose.units[c].refs == [cap.as_str()] {
                out.insert(c, i);
            }
        }
    }
    out
}

/// The tie of the decaps of a loose problem at a trial place.
struct Tie<'a> {
    loose: &'a Problem,
    pose: Vec<Place>,
    ties: BTreeMap<usize, usize>,
    gnd: BTreeSet<i64>,
    distance: f64,
}

impl<'a> Tie<'a> {
    fn new(pr: &Problem, loose: &'a Problem, distance: f64) -> Self {
        Self { loose, pose: loose.initial_pose(), ties: tied_decaps(pr, loose), gnd: gnd_codes(loose), distance }
    }

    /// Smallest gap from a non-GND pad of the cap at `place` to a pad of the same net on its IC.
    fn gap(&self, cap: usize, ic: usize, place: Place) -> f64 {
        let (uc, ui) = (&self.loose.units[cap], &self.loose.units[ic]);
        let signal = |a: &&TaggedRect| a.value > 0.0 && !self.gnd.contains(&(a.value as i64));
        let to_ic = |a: &TaggedRect| {
            let same_net = ui.cu.iter().filter(|b| b.value == a.value);
            same_net.map(|b| box_gap(world_box(a, place), world_box(b, self.pose[ic]))).fold(f64::INFINITY, f64::min)
        };
        uc.cu.iter().filter(signal).map(to_ic).fold(f64::INFINITY, f64::min)
    }

    /// True for every unit but a tied decap, and for a tied decap that keeps its tie.
    fn holds(&self, unit: usize, place: Place) -> bool {
        self.ties.get(&unit).is_none_or(|&ic| self.gap(unit, ic, place) <= self.distance + EPS)
    }
}

/// Moves of single tied decaps in the loose problem: legal there, failure term down, tie still true.
pub fn slides(pr: &Problem, loose: &Problem, fails: &[Failure], distance: f64, rotate: bool) -> crate::Result<Vec<Proposal>> {
    let tie = Tie::new(pr, loose, distance);
    if tie.ties.is_empty() || distance <= 0.0 {
        return Ok(Vec::new());
    }
    let near: BTreeSet<usize> = candidates(loose, &tie.pose, fails, Params::default().legal_radius).into_iter().collect();
    let units = tie.ties.keys().copied().filter(|i| near.contains(i)).collect();
    let scope = Scope::new(loose, &tie.pose, fails, rotate, Tag::Loose);
    search::proposals(&scope, Some(units), &|i, place| tie.holds(i, place))
}

/// Escape proposals in the loose problem: a tied decap that walls in the pin may move when its tie stays true; other units move as
/// in the main problem.
pub fn escapes(pr: &Problem, loose: &Problem, fails: &[Failure], distance: f64, rotate: bool) -> crate::Result<Vec<Proposal>> {
    let tie = Tie::new(pr, loose, distance);
    let scope = Scope::new(loose, &tie.pose, fails, rotate, Tag::Loose);
    corridor::proposals(&scope, &|i, place| tie.holds(i, place))
}
