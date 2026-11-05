//! Legalizer: move each unit with spacing overlap or edge/keepout area to the lowest-cost legal spot nearby.
//! Biggest units first; ring search on legal_step up to legal_radius, own turn first; each pass doubles the radius.
//! The exact pad-edge predicate also rejects raster misses, for both the current pose and every trial spot.

use crate::evaluator::Evaluator;
use crate::geom::Turn;
use crate::numeric::hypot;
use crate::params::Params;
use std::time::{Duration, Instant};

const LEGAL: f64 = 1e-9;

/// Integer offsets on the square ring at distance k (k >= 1).
pub fn ring(k: i64) -> impl Iterator<Item = (i64, i64)> {
    let rows = (-k..=k).flat_map(move |a| [(a, -k), (a, k)]);
    let columns = (-k + 1..k).flat_map(move |b| [(-k, b), (k, b)]);
    rows.chain(columns)
}

/// The legalizer used its time. The placement is not legal: `illegal` = the units with a penalty.
#[derive(Debug)]
pub struct Timeout {
    pub illegal: Vec<usize>,
}

/// A spot found for a unit.
#[derive(Clone, Copy)]
struct Spot {
    delta: f64,
    place: (f64, f64, Turn),
}

struct Legalizer<'a, 'm> {
    ev: &'a mut Evaluator<'m>,
    step: f64,
    max_displacement: f64,
    rotate: bool,
    exact_edge: bool,
    end: Instant,
}

/// Returns the units that stay illegal.
pub fn legalize(ev: &mut Evaluator, p: &Params) -> Result<Vec<usize>, Timeout> {
    let end = Instant::now() + Duration::from_secs_f64(p.legal_time);
    let mut legalizer = Legalizer { ev, step: p.legal_step, max_displacement: p.max_displacement, rotate: p.legal_rotate != 0.0, exact_edge: p.exact_edge != 0.0, end };
    legalize_with(&mut legalizer, p)
}

fn legalize_with(l: &mut Legalizer, p: &Params) -> Result<Vec<usize>, Timeout> {
    let mut bad = Vec::new();
    for k in 0..p.legal_passes as i32 {
        bad = l.pass(p.legal_radius * 2.0_f64.powi(k))?;
        if bad.is_empty() {
            break;
        }
    }
    Ok(bad)
}

impl Legalizer<'_, '_> {
    fn illegal(&self, i: usize) -> bool {
        self.ev.legal_penalty(i) > LEGAL || (self.exact_edge && self.ev.edge_miss_at(i, self.ev.place(i)))
    }

    fn check_time(&self) -> Result<(), Timeout> {
        if Instant::now() <= self.end {
            return Ok(());
        }
        let illegal = (0..self.ev.unit_count())
            .filter(|&j| !self.ev.shape(j).fixed && self.illegal(j))
            .collect();
        Err(Timeout { illegal })
    }

    fn pass(&mut self, radius: f64) -> Result<Vec<usize>, Timeout> {
        let rings = (radius / self.step + 1e-9) as i64;
        let mut order: Vec<usize> = (0..self.ev.unit_count()).filter(|&i| !self.ev.shape(i).fixed).collect();
        order.sort_by(|&a, &b| self.ev.shape(b).area.total_cmp(&self.ev.shape(a).area).then(a.cmp(&b)));
        let mut bad = Vec::new();
        for i in order {
            if !self.illegal(i) {
                continue;
            }
            self.check_time()?;
            match self.find_spot(i, rings)? {
                Some(spot) => {
                    self.ev.propose(&[(i, spot.place)]);
                    self.ev.commit();
                }
                None => bad.push(i),
            }
        }
        Ok(bad)
    }

    /// The own turn first; the other turns only when it has no spot.
    fn find_spot(&mut self, i: usize, rings: i64) -> Result<Option<Spot>, Timeout> {
        let (_, _, r0) = self.ev.place(i);
        if let Some(spot) = self.search_turns(i, rings, &[r0])? {
            return Ok(Some(spot));
        }
        if !self.rotate || !self.ev.shape(i).rotate {
            return Ok(None);
        }
        let turns: Vec<Turn> = (0..4).filter(|&r| r != r0).collect();
        self.search_turns(i, rings, &turns)
    }

    /// Ring by ring; the search ends two rings after the first ring with a legal spot.
    fn search_turns(&mut self, i: usize, rings: i64, turns: &[Turn]) -> Result<Option<Spot>, Timeout> {
        let (x0, y0, _) = self.ev.place(i);
        let mut best: Option<Spot> = None;
        let mut first = None;
        for k in 1..=rings {
            self.check_time()?;
            for (a, b) in ring(k) {
                let (x, y) = (x0 + a as f64 * self.step, y0 + b as f64 * self.step);
                for &r in turns {
                    if self.try_place(i, (x, y, r), &mut best) {
                        first = first.or(Some(k));
                    }
                }
            }
            if first.is_some_and(|f| k >= f + 2) {
                break;
            }
        }
        Ok(best)
    }

    /// True when the place is legal; `best` keeps the lowest cost delta.
    fn try_place(&mut self, i: usize, place: (f64, f64, Turn), best: &mut Option<Spot>) -> bool {
        if !self.within_displacement(i, place) || (self.exact_edge && self.ev.edge_miss_at(i, place)) || self.ev.legal_penalty_at(i, place) > LEGAL {
            return false;
        }
        let delta = self.ev.propose(&[(i, place)]);
        self.ev.revert();
        if best.is_none_or(|b| delta < b.delta - 1e-12) {
            *best = Some(Spot { delta, place });
        }
        true
    }

    fn within_displacement(&self, i: usize, (x, y, _): (f64, f64, Turn)) -> bool {
        let (ax, ay) = self.ev.anchor(i);
        self.max_displacement <= 0.0 || hypot(x - ax, y - ay) <= self.max_displacement + 1e-9
    }
}

#[cfg(test)]
mod tests {
    use super::ring;

    #[test]
    fn a_ring_is_the_square_at_distance_k() {
        let r: Vec<_> = ring(1).collect();
        assert_eq!(r.len(), 8);
        assert!(r.iter().all(|&(a, b)| a.abs().max(b.abs()) == 1));
        assert_eq!(ring(2).count(), 16);
    }
}
