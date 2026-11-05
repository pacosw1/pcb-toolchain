//! Sprints: a time-boxed search of independent seeds, with a checkpoint per epoch and a routability score to pick the winner.
//!
//! `--budget-s S` makes each worker one seed with no exchange: the best pose does not overwrite the worse half, so the seeds stay
//! apart. Without --steps the steps come from the speed measured on this problem and are fitted again after each epoch to the time
//! left, so every epoch runs and the schedule always cools: such a run depends on the clock. With --steps and a seed a sprint
//! repeats exactly, unless it stops at the epoch that would pass 90 % of the budget. Each seed keeps its best pose under the final
//! weights. The legalizer gets the rest of the budget.
//!
//! `--checkpoint FILE`, schema `iot-lab.place-checkpoint.v0`, also on a plain run: after each epoch the state of every worker under
//! one common objective (the final weights), each file written to FILE.tmp and renamed, as iotroute --checkpoint does. A file that
//! stays `running` is a run that was killed: its poses are still good. What to do with it (kill a variant, pack N jobs) belongs to
//! the sprint runner, not here.
//!
//! The route score is the congestion term with net tracks at limit 0.3, the setting that ranked routed poses best on RELAY-4
//! (README, "Routing room terms"). The router's own congestion map exists only after a route, so this is the estimate before one.

use super::{mean_gap, pose_key};
use crate::evaluator::{Evaluator, Terms};
use crate::geom::{Rect, poly_edge_d2};
use crate::model::Model;
use crate::numeric::hypot;
use crate::params::Params;
use crate::problem::{Pose, Problem};
use serde::Serialize;
use std::collections::BTreeSet;
use std::path::PathBuf;

/// The share of the budget the moves may use.
const SEARCH_SHARE: f64 = 0.9;
/// Moves of the speed measurement.
pub const SPEED_MOVES: usize = 2000;
const SCHEMA: &str = "iot-lab.place-checkpoint.v0";

#[derive(Clone, Debug, Default)]
pub struct Sprint {
    pub budget_s: Option<f64>,
    pub checkpoint: Option<PathBuf>,
    /// The SHA-256 of the problem file: which input a checkpoint belongs to.
    pub bind: String,
}

impl Sprint {
    /// The steps per epoch that fit the budget at `speed` moves per second and worker.
    pub fn steps(&self, speed: f64, epochs: usize) -> Option<usize> {
        self.budget_s.map(|s| ((speed * s * SEARCH_SHARE / epochs as f64) as usize).max(1))
    }

    /// The steps of each of the `epochs` left, at `speed` moves per second and worker, after `elapsed` s.
    pub fn steps_left(&self, speed: f64, elapsed: f64, epochs: usize) -> usize {
        let left = (self.budget_s.unwrap_or(0.0) * SEARCH_SHARE - elapsed).max(0.0);
        ((speed * left / epochs.max(1) as f64) as usize).max(1)
    }

    /// Fixed steps stop here: `done` epochs took `elapsed` s and one more would pass the share of the budget.
    pub fn out_of_time(&self, elapsed: f64, done: usize) -> bool {
        self.budget_s.is_some_and(|s| elapsed + elapsed / done as f64 > s * SEARCH_SHARE)
    }

    /// The final weights with the legalizer inside the budget.
    pub fn finish_params(&self, last: &Params) -> Params {
        let legal_time = self.budget_s.map_or(last.legal_time, |s| last.legal_time.min((s * (1.0 - SEARCH_SHARE)).max(1.0)));
        Params { legal_time, ..last.clone() }
    }
}

/// What a sprint or a checkpointed run measured.
#[derive(Clone, Debug, Default, Serialize)]
pub struct Report {
    pub budget_s: Option<f64>,
    pub stop: String,
    pub epochs_run: usize,
    pub busy_s: f64,
    /// Worker seconds spent waiting at the end of an epoch.
    pub idle_s: f64,
    /// Different poses among the workers' best, and their mean distance in mm.
    pub unique: usize,
    pub spread_mm: f64,
}

pub struct Scorer<'p> {
    model: Model<'p>,
    params: Params,
}

impl<'p> Scorer<'p> {
    pub fn new(pr: &'p Problem, p: &Params) -> crate::Result<Self> {
        let params = Params { tracks: 1.0, limit: 0.3, ..p.clone() };
        Ok(Self { model: Model::new(pr, &params)?, params })
    }

    /// Lower is better; 0 = no cell over its limit.
    pub fn score(&self, pose: &Pose) -> f64 {
        Evaluator::new(&self.model, &self.params, pose).terms().cong
    }
}

#[derive(Serialize)]
pub struct WorkerState {
    pub worker: usize,
    pub cost: f64,
    pub route_score: f64,
    pub terms: Terms,
    pub pose: Pose,
}

#[derive(Serialize)]
struct File<'a> {
    schema: &'static str,
    state: &'a str,
    bind: &'a str,
    seed: u64,
    epochs: usize,
    steps: usize,
    report: &'a Report,
    workers: &'a [WorkerState],
    /// Per epoch the cost of each worker: enough to test a pruning rule later.
    trail: &'a [Vec<f64>],
}

pub struct Progress<'a> {
    pub sprint: &'a Sprint,
    pub seed: u64,
    pub epochs: usize,
    pub steps: usize,
    pub trail: Vec<Vec<f64>>,
}

impl Progress<'_> {
    pub fn save(&self, state: &str, report: &Report, workers: &[WorkerState]) -> crate::Result<()> {
        let Some(path) = &self.sprint.checkpoint else { return Ok(()) };
        let file = File { schema: SCHEMA, state, bind: &self.sprint.bind, seed: self.seed, epochs: self.epochs, steps: self.steps, report, workers, trail: &self.trail };
        let temporary = path.with_extension("tmp");
        std::fs::write(&temporary, serde_json::to_vec(&file)?)?;
        std::fs::rename(&temporary, path)?;
        Ok(())
    }
}

/// Movable units with a pad box closer to the outline than the edge clearance, measured exactly. The search works on a raster: on
/// ENV-SENSE it left 27 % of its winners 0.002-0.047 mm inside the clearance, and the router's preflight refused them. Every search
/// counts such a pose illegal: another worker wins, or the run says no legal candidate before a route is spent on it.
pub fn edge_misses(model: &Model, pose: &Pose) -> Vec<String> {
    let board = &model.problem.board;
    let outline = &board.outline;
    let clear = board.edge_clearance - 1e-6;
    let gap = |q: Rect| {
        let corners = q.corners().into_iter().map(|c| poly_edge_d2(c, outline).sqrt());
        let vertices = outline.iter().map(|&v| {
            let (dx, dy) = q.axis_gaps(v);
            hypot(dx, dy)
        });
        corners.chain(vertices).fold(f64::INFINITY, f64::min)
    };
    let close = |i: usize| {
        let (x, y, r) = pose[i];
        model.units[i].edge_pads.as_ref().is_some_and(|turns| turns[r as usize].iter().any(|q| gap(q.shifted(x, y)) < clear))
    };
    (0..pose.len()).filter(|&i| !model.units[i].fixed && close(i)).map(|i| format!("edge:{}", model.problem.units[i].name)).collect()
}

/// How many different poses, and how far apart on average.
pub fn diversity(poses: &[&Pose], movable: &[usize]) -> (usize, f64) {
    let unique = poses.iter().map(|p| pose_key(p)).collect::<BTreeSet<_>>().len();
    let pairs: Vec<f64> = (0..poses.len()).flat_map(|a| (a + 1..poses.len()).map(move |b| (a, b))).map(|(a, b)| mean_gap(poses[a], poses[b], movable)).collect();
    (unique, crate::numeric::compensated(pairs.iter().copied()) / pairs.len().max(1) as f64)
}
