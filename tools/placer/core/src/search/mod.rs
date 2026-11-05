//! Search: simulated annealing on the incremental cost, one run per worker, best exchange per epoch.
//!
//! T0 = mean uphill delta of 200 random moves at the full window (or t0). T falls geometrically from T0 to T0 * t_ratio
//! over all epochs, the move window from w0 (half the board) to w1. The spacing and forbidden-area weights grow from w
//! to w * ramp. Each epoch, each worker runs `steps` moves from its own state with its own seed; after the epoch the
//! worse half of the workers restart from the global best pose. The exchange is synchronous, so a seed gives one result.
//! The best pose of each worker is legalized and ranked: illegal unit count, mains faults, then cost.

mod anneal;
pub(crate) mod legalize;
mod mover;

pub use anneal::{Best, Schedule, anneal, estimate_t0};
pub use legalize::{Timeout, legalize, ring};
pub use mover::Mover;

use crate::evaluator::{Evaluator, Terms};
use crate::model::Model;
use crate::numeric::{PyRandom, hypot};
use crate::params::Params;
use crate::problem::{Pose, Problem};
use serde::Serialize;
use std::collections::BTreeSet;
use std::time::Instant;

/// The size of a search.
#[derive(Clone, Copy, Debug)]
pub struct Plan {
    pub workers: usize,
    pub epochs: usize,
    pub steps: usize,
    pub seed: u64,
    pub top: usize,
}

#[derive(Debug, Serialize)]
pub struct Initial {
    pub pose: Pose,
    pub cost: f64,
    pub components: Terms,
}

#[derive(Debug, Serialize)]
pub struct EpochRecord {
    pub epoch: usize,
    pub cost: f64,
    pub pose: Pose,
    pub components: Terms,
}

#[derive(Clone, Debug, Serialize)]
pub struct Candidate {
    pub worker: usize,
    pub pose: Pose,
    pub prelegal_pose: Pose,
    pub cost: f64,
    pub components: Terms,
    pub illegal: Vec<String>,
    pub timeout: bool,
    pub mains: Vec<crate::mains::Fault>,
    pub finish_seconds: f64,
}

#[derive(Debug, Serialize)]
pub struct GlobalStage {
    pub iters: usize,
    pub overflow: Option<f64>,
}

#[derive(Debug, Serialize)]
pub struct SearchResult {
    pub global: Option<GlobalStage>,
    pub initial: Initial,
    pub candidates: Vec<Candidate>,
    pub history: Vec<EpochRecord>,
    pub t0: f64,
    pub seed: u64,
    pub workers: usize,
    pub epochs: usize,
    pub steps: usize,
    pub params: Params,
    pub wall_s: f64,
    pub moves_per_s_per_worker: f64,
}

/// Weights of an epoch: the spacing and forbidden-area weights grow geometrically over the epochs.
pub fn epoch_params(p: &Params, epoch: usize, epochs: usize) -> Params {
    let f = if epochs > 1 { epoch as f64 / (epochs - 1) as f64 } else { 1.0 };
    let (w_ov, w_oob) = p.spacing_weights_at(f);
    Params { w_ov, w_oob, ..p.clone() }
}

fn seed_for(seed: u64, worker: usize, epoch: usize) -> u64 {
    seed.wrapping_mul(1_000_003).wrapping_add(worker as u64 * 10_007).wrapping_add(epoch as u64 * 101) & 0xffff_ffff
}

/// a to b at the fraction f, geometric.
fn between(a: f64, b: f64, f: f64) -> f64 {
    a * (b / a).powf(f)
}

/// What a worker carries from epoch to epoch.
#[derive(Clone)]
struct Worker {
    pose: Pose,
    cost: f64,
    best_pose: Pose,
    best_cost: f64,
}

struct EpochTask<'a> {
    pose: &'a Pose,
    seed: u64,
    schedule: Schedule,
    params: &'a Params,
}

struct EpochOutcome {
    worker: Worker,
    seconds: f64,
}

pub type MoveObserver = dyn Fn(usize, usize, usize, usize, usize, f64, &Pose, f64, &Pose) + Sync;

fn run_epoch(model: &Model, mover: &Mover, t: EpochTask, worker: usize, epoch: usize, observer: Option<&MoveObserver>) -> EpochOutcome {
    let mut ev = Evaluator::new(model, t.params, t.pose);
    let mut rng = PyRandom::new(t.seed);
    let start = Instant::now();
    let callback = |step, accepted, rejected, cost, current: &Pose, best_cost, best: &Pose| {
        if let Some(observe) = observer { observe(worker, epoch + 1, step, accepted, rejected, cost, current, best_cost, best); }
    };
    let best = anneal::anneal_observed(&mut ev, mover, &mut rng, t.schedule, observer.map(|_| &callback as &dyn Fn(usize,usize,usize,f64,&Pose,f64,&Pose)));
    let seconds = start.elapsed().as_secs_f64();
    EpochOutcome { worker: Worker { pose: ev.pose(), cost: ev.cost(), best_pose: best.pose, best_cost: best.cost }, seconds }
}

/// Run f per worker, on one thread each when there are several.
fn in_parallel<T: Send>(count: usize, f: impl Fn(usize) -> T + Sync) -> Vec<T> {
    if count == 1 {
        return vec![f(0)];
    }
    std::thread::scope(|s| {
        let handles: Vec<_> = (0..count).map(|w| { let f = &f; s.spawn(move || f(w)) }).collect();
        handles.into_iter().map(|h| h.join().expect("a worker thread does not panic")).collect()
    })
}

/// Legalize a worker's best pose and name what stays illegal.
fn finish(model: &Model, p: &Params, worker: usize, pose: &Pose) -> Candidate {
    let start = Instant::now();
    let mut ev = Evaluator::new(model, p, pose);
    let prelegal_pose = ev.pose();
    let (bad, timeout) = match legalize(&mut ev, p) {
        Ok(bad) => (bad, false),
        Err(Timeout { illegal }) => (illegal, true),
    };
    let pr = model.problem;
    let mains = if p.mains != 0.0 { crate::mains::faults(pr, &ev.pose(), &crate::mains::domain_nets(pr)) } else { Vec::new() };
    Candidate {
        worker,
        pose: ev.pose(),
        prelegal_pose,
        cost: ev.cost(),
        components: ev.terms(),
        illegal: bad.iter().map(|&i| pr.units[i].name.clone()).collect(),
        timeout,
        mains,
        finish_seconds: start.elapsed().as_secs_f64(),
    }
}

/// Final candidate order: legal first, then no mains path faults, then the lower cost.
pub fn rank(a: &Candidate, b: &Candidate) -> std::cmp::Ordering {
    let key = |c: &Candidate| (c.illegal.len(), c.mains.len());
    key(a).cmp(&key(b)).then(a.cost.total_cmp(&b.cost)).then(a.worker.cmp(&b.worker))
}

/// The pose key at 3 decimals, for exact copies.
fn pose_key(pose: &Pose) -> String {
    pose.iter().map(|(x, y, r)| format!("{x:.3},{y:.3},{r};")).collect()
}

/// Mean move in mm of the movable units between two poses.
fn mean_gap(a: &Pose, b: &Pose, movable: &[usize]) -> f64 {
    let sum = crate::numeric::compensated(movable.iter().map(|&i| hypot(a[i].0 - b[i].0, a[i].1 - b[i].1)));
    sum / movable.len().max(1) as f64
}

/// Candidates (best first) whose movable units are on average d mm or more from each kept one; with d = 0, only exact
/// copies are dropped.
pub fn distinct(candidates: Vec<Candidate>, d: f64, movable: &[usize]) -> Vec<Candidate> {
    let mut seen = BTreeSet::new();
    let mut kept: Vec<Candidate> = Vec::new();
    for c in candidates {
        let too_close = d > 0.0 && kept.iter().any(|k| mean_gap(&c.pose, &k.pose, movable) < d);
        if !too_close && seen.insert(pose_key(&c.pose)) {
            kept.push(c);
        }
    }
    kept
}

struct Run<'a> {
    model: &'a Model<'a>,
    params: &'a Params,
    plan: Plan,
    t0: f64,
    t1: f64,
    w0: f64,
    w1: f64,
}

impl Run<'_> {
    fn schedule(&self, epoch: usize) -> Schedule {
        let e = self.plan.epochs as f64;
        let (f0, f1) = (epoch as f64 / e, (epoch + 1) as f64 / e);
        Schedule {
            steps: self.plan.steps,
            t0: between(self.t0, self.t1, f0),
            t1: between(self.t0, self.t1, f1),
            w0: between(self.w0, self.w1, f0),
            w1: between(self.w0, self.w1, f1),
        }
    }

    fn epoch(&self, mover: &Mover, workers: &[Worker], epoch: usize, observer: Option<&MoveObserver>) -> Vec<EpochOutcome> {
        let params = epoch_params(self.params, epoch, self.plan.epochs);
        let schedule = self.schedule(epoch);
        in_parallel(workers.len(), |w| {
            let seed = seed_for(self.plan.seed, w, epoch);
            run_epoch(self.model, mover, EpochTask { pose: &workers[w].pose, seed, schedule, params: &params }, w, epoch, observer)
        })
    }
}

/// The worker with the best cost of this epoch.
fn best_worker(workers: &[Worker]) -> usize {
    (0..workers.len()).fold(0, |g, w| if workers[w].best_cost < workers[g].best_cost { w } else { g })
}

/// The worse half of the workers restart from the best pose. The weights of the epoch made the costs comparable.
fn exchange(workers: &mut [Worker], best: usize) {
    let mut order: Vec<usize> = (0..workers.len()).collect();
    order.sort_by(|&a, &b| workers[b].cost.total_cmp(&workers[a].cost).then(a.cmp(&b)));
    for &w in order.iter().take(workers.len() / 2).filter(|&&w| w != best) {
        workers[w].pose = workers[best].best_pose.clone();
        workers[w].cost = workers[best].best_cost;
    }
}

fn check(pr: &Problem, p: &Params, plan: Plan) -> crate::Result<()> {
    if plan.workers == 0 || plan.epochs == 0 {
        return Err("workers and epochs must be at least 1".into());
    }
    if p.mains != 0.0 && pr.route_rules.is_none() {
        return Err("mains = 1 needs route_rules and cu_nets in the problem: read it again".into());
    }
    Ok(())
}

/// `log` receives one line per epoch. With params global = 1 the units of the problem move to the analytic places.
pub fn optimize(pr: &mut Problem, p: &Params, plan: Plan, log: &dyn Fn(&str)) -> crate::Result<SearchResult> {
    optimize_with_preview(pr, p, plan, log, &|_,_,_,_| {})
}

/// Calls preview after each epoch. A preview callback must not affect search state.
pub fn optimize_with_preview(pr: &mut Problem, p: &Params, plan: Plan, log: &dyn Fn(&str),
    preview: &dyn Fn(usize,usize,f64,&Pose)) -> crate::Result<SearchResult> {
    optimize_observed(pr, p, plan, log, preview, None)
}

pub fn optimize_observed(pr: &mut Problem, p: &Params, plan: Plan, log: &dyn Fn(&str),
    preview: &dyn Fn(usize,usize,f64,&Pose), observer: Option<&MoveObserver>) -> crate::Result<SearchResult> {
    check(pr, p, plan)?;
    let global = crate::gplace::apply(pr, p, log);
    anneal_all(pr, p, plan, log, global, preview, observer)
}

fn anneal_all(pr: &Problem, p: &Params, plan: Plan, log: &dyn Fn(&str), global: Option<GlobalStage>,
    preview: &dyn Fn(usize,usize,f64,&Pose), observer: Option<&MoveObserver>) -> crate::Result<SearchResult> {
    let start = pr.initial_pose();
    let model = Model::new(pr, p)?;
    let last = epoch_params(p, plan.epochs - 1, plan.epochs);
    let mut first = Evaluator::new(&model, &epoch_params(p, 0, plan.epochs), &start);
    let final_weights = Evaluator::new(&model, &last, &start);
    let initial = Initial { pose: final_weights.pose(), cost: final_weights.cost(), components: final_weights.terms() };
    let mover = Mover::new(&model, p);
    if !mover.has_movable_units() {
        return Err("no movable unit in the problem".into());
    }
    let b = model.outline_box;
    let w0 = p.w0.filter(|w| *w != 0.0).unwrap_or((b.x1 - b.x0).max(b.y1 - b.y0) / 2.0);
    let t0 = match p.t0.filter(|t| *t != 0.0) {
        Some(t) => t,
        None => estimate_t0(&mut first, &mover, &mut PyRandom::new(plan.seed), w0),
    };
    let run = Run { model: &model, params: p, plan, t0, t1: t0 * p.t_ratio, w0, w1: p.w1.min(w0) };
    let seed_worker = Worker { pose: initial.pose.clone(), cost: initial.cost, best_pose: initial.pose.clone(), best_cost: first.cost() };
    let mut workers = vec![seed_worker; plan.workers];
    let started = Instant::now();
    let mut busy = 0.0;
    let mut history = Vec::new();
    for e in 0..plan.epochs {
        let outcomes = run.epoch(&mover, &workers, e, observer);
        busy += outcomes.iter().map(|o| o.seconds).sum::<f64>();
        workers = outcomes.into_iter().map(|o| o.worker).collect();
        let g = best_worker(&workers);
        preview(e+1, plan.epochs, workers[g].best_cost, &workers[g].best_pose);
        let terms = Evaluator::new(&model, &last, &workers[g].best_pose).terms();
        history.push(EpochRecord { epoch: e + 1, cost: workers[g].best_cost, pose: workers[g].best_pose.clone(), components: terms });
        let current: Vec<String> = workers.iter().map(|w| format!("{:.1}", w.cost)).collect();
        log(&format!(
            "epoch {}/{} T {:.3e} best {:.2} (worker {g}) cur {}",
            e + 1,
            plan.epochs,
            between(t0, run.t1, (e + 1) as f64 / plan.epochs as f64),
            workers[g].best_cost,
            current.join(" ")
        ));
        if e + 1 < plan.epochs {
            exchange(&mut workers, g);
        }
    }
    let mut finished = in_parallel(workers.len(), |w| finish(&model, &last, w, &workers[w].best_pose));
    finished.sort_by(rank);
    let movable: Vec<usize> = (0..pr.units.len()).filter(|&i| !pr.units[i].fixed).collect();
    let mut candidates = distinct(finished, p.distinct, &movable);
    candidates.truncate(plan.top);
    let moves = (plan.epochs * plan.steps * plan.workers) as f64;
    Ok(SearchResult {
        global,
        initial,
        candidates,
        history,
        t0,
        seed: plan.seed,
        workers: plan.workers,
        epochs: plan.epochs,
        steps: plan.steps,
        params: p.clone(),
        wall_s: started.elapsed().as_secs_f64(),
        moves_per_s_per_worker: if busy > 0.0 { moves / busy } else { 0.0 },
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn seeds_mix_worker_and_epoch() {
        assert_eq!(seed_for(1, 0, 0), 1_000_003);
        assert_eq!(seed_for(1, 2, 3), 1_000_003 + 20_014 + 303);
    }

    #[test]
    fn the_last_epoch_has_the_full_ramp() {
        let p = Params::default();
        assert_eq!(epoch_params(&p, 0, 5).w_ov, 20.0);
        assert!((epoch_params(&p, 4, 5).w_ov - 400.0).abs() < 1e-9);
        assert!((epoch_params(&p, 0, 1).w_ov - 400.0).abs() < 1e-9);
    }
}
