//! One annealing run on the incremental cost.

use super::mover::Mover;
use crate::evaluator::Evaluator;
use crate::numeric::{PyRandom, compensated};
use crate::problem::Pose;

/// Temperature and move window of a run; both fall geometrically over its steps.
#[derive(Clone, Copy, Debug)]
pub struct Schedule {
    pub steps: usize,
    pub t0: f64,
    pub t1: f64,
    pub w0: f64,
    pub w1: f64,
}

/// The best cost of a run and its pose.
pub struct Best {
    pub cost: f64,
    pub pose: Pose,
}

/// Mean uphill delta of random moves at the full window.
pub fn estimate_t0(ev: &mut Evaluator, mover: &Mover, rng: &mut PyRandom, window: f64) -> f64 {
    const SAMPLES: usize = 200;
    let mut uphill = Vec::new();
    for _ in 0..SAMPLES {
        let moves = mover.propose(rng, ev, window);
        let d = ev.propose(&moves);
        ev.revert();
        if d > 0.0 {
            uphill.push(d);
        }
    }
    if uphill.is_empty() { 1.0 } else { compensated(uphill.iter().copied()) / uphill.len() as f64 }
}

pub fn anneal(ev: &mut Evaluator, mover: &Mover, rng: &mut PyRandom, s: Schedule) -> Best {
    let mut best = Best { cost: ev.cost(), pose: ev.pose() };
    if s.steps == 0 {
        return best;
    }
    let (lt0, dlt) = (s.t0.ln(), (s.t1 / s.t0).ln() / s.steps as f64);
    let (lw0, dlw) = (s.w0.ln(), (s.w1 / s.w0).ln() / s.steps as f64);
    // The pose is copied only when the run leaves a new best, not on each improvement.
    let mut improved = false;
    for step in 0..s.steps {
        let t = (lt0 + dlt * step as f64).exp();
        let moves = mover.propose(rng, ev, (lw0 + dlw * step as f64).exp());
        let d = ev.propose(&moves);
        if d <= 0.0 || rng.random() < (-d / t).exp() {
            ev.commit();
            if ev.cost() < best.cost - 1e-12 {
                best.cost = ev.cost();
                improved = true;
            } else if improved && d > 0.0 {
                best.pose = ev.pose_before_last_move();
                improved = false;
            }
        } else {
            ev.revert();
        }
    }
    if improved {
        best.pose = ev.pose();
    }
    best
}
