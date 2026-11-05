//! Live progress of a routing job: OUTDIR/progress.jsonl, one line per event. tools/route_status.ts reads it.
//!
//! Row: t (ISO time), t0, elapsed_s, stage, pass, open, vias (null until the board is imported), best_open, eta_s (seconds to 0
//! open from the slope of the recent passes, null when not estimable).
use super::files::{append_line, iso_now, rounded, unix_time};
use super::scan::Scan;
use serde::Serialize;
use std::path::PathBuf;

const WINDOW: usize = 5;

/// A Fastroute pass line.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Pass {
    pub number: u64,
    pub open: u64,
    pub seconds: f64,
}

/// The pass of a line holding "Auto-routing pass #N was completed in S seconds ... (K unrouted".
pub fn parse_pass(line: &str) -> Option<Pass> {
    line.match_indices("Auto-routing pass #").find_map(|(at, head)| pass_at(&line[at + head.len()..]))
}

fn pass_at(text: &str) -> Option<Pass> {
    let mut scan = Scan::new(text);
    let number = scan.whole()?;
    scan.literal(" was completed in ")?;
    let seconds = scan.number()?;
    scan.literal(" seconds ")?;
    let open = scan.rest().match_indices('(').find_map(|(at, _)| {
        let mut inner = Scan::new(&scan.rest()[at + 1..]);
        let open = inner.whole()?;
        inner.literal(" unrouted")?;
        Some(open)
    })?;
    Some(Pass { number, open, seconds })
}

/// Seconds to 0 open from the least-squares slope of the last points; None when fewer than 2 points or the slope is not negative.
pub fn eta(history: &[(f64, u64)]) -> Option<f64> {
    let points = &history[history.len().saturating_sub(WINDOW)..];
    let last = points.last()?.1;
    if last == 0 {
        return Some(0.0);
    }
    if points.len() < 2 {
        return None;
    }
    let count = points.len() as f64;
    let mean_t = points.iter().map(|p| p.0).sum::<f64>() / count;
    let mean_n = points.iter().map(|p| p.1 as f64).sum::<f64>() / count;
    let spread: f64 = points.iter().map(|p| (p.0 - mean_t).powi(2)).sum();
    if spread <= 0.0 {
        return None;
    }
    let slope = points.iter().map(|p| (p.0 - mean_t) * (p.1 as f64 - mean_n)).sum::<f64>() / spread;
    (slope < 0.0).then(|| rounded(last as f64 / -slope, 1))
}

#[derive(Serialize)]
struct Row<'a> {
    t: String,
    t0: f64,
    elapsed_s: f64,
    stage: &'a str,
    pass: Option<u64>,
    open: Option<u64>,
    vias: Option<u64>,
    best_open: Option<u64>,
    eta_s: Option<f64>,
}

pub struct Progress {
    path: PathBuf,
    t0: f64,
    best: Option<u64>,
    vias: Option<u64>,
    history: Vec<(f64, u64)>,
}

impl Progress {
    pub fn new(path: impl Into<PathBuf>) -> Progress {
        Progress { path: path.into(), t0: unix_time(), best: None, vias: None, history: Vec::new() }
    }

    pub fn t0(&self) -> f64 {
        self.t0
    }

    /// A stage boundary. A row that cannot be written is said once on stderr: progress never stops the job.
    pub fn mark(&mut self, stage: &str) {
        self.write(stage, None, None, None, None);
    }

    pub fn with_vias(&mut self, stage: &str, vias: u64) {
        self.write(stage, None, None, Some(vias), None);
    }

    pub fn with_open(&mut self, stage: &str, open: u64, vias: Option<u64>) {
        self.write(stage, None, Some(open), vias, None);
    }

    pub fn router_pass(&mut self, pass: u64, open: u64, stage: &str) {
        self.history.push((unix_time() - self.t0, open));
        let eta_s = eta(&self.history);
        self.write(stage, Some(pass), Some(open), None, eta_s);
    }

    fn write(&mut self, stage: &str, pass: Option<u64>, open: Option<u64>, vias: Option<u64>, eta_s: Option<f64>) {
        self.vias = vias.or(self.vias);
        if let Some(open) = open {
            self.best = Some(self.best.map_or(open, |best| best.min(open)));
        }
        let row = Row { t: iso_now(), t0: rounded(self.t0, 1), elapsed_s: rounded(unix_time() - self.t0, 1), stage, pass, open, vias: self.vias, best_open: self.best, eta_s };
        let line = serde_json::to_string(&row).expect("a progress row is plain data");
        if let Err(error) = append_line(&self.path, &line) {
            eprintln!("fastroute_job: progress: {error}");
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::Value;
    use std::fs;

    const LINE: &str = "  12.3 INFO Auto-routing pass #4 was completed in 1.25 seconds with score 901.2 (17 unrouted and 2 violations)";

    #[test]
    fn a_pass_line_gives_pass_open_and_seconds() {
        assert_eq!(parse_pass(LINE), Some(Pass { number: 4, open: 17, seconds: 1.25 }));
        assert_eq!(parse_pass("Auto-routing stage started"), None);
        assert_eq!(parse_pass("    4.2 INFO  checkpoint: best board so far (84 unrouted, 20 violations)"), None);
    }

    #[test]
    fn eta_needs_a_falling_slope() {
        assert_eq!(eta(&[]), None);
        assert_eq!(eta(&[(1.0, 10.min(10))]), None);
        assert_eq!(eta(&[(0.0, 20), (10.0, 10)]), Some(10.0));
        assert_eq!(eta(&[(0.0, 10), (10.0, 20)]), None);
        assert_eq!(eta(&[(0.0, 10), (0.0, 5)]), None);
        assert_eq!(eta(&[(0.0, 10), (5.0, 0)]), Some(0.0));
    }

    #[test]
    fn only_the_last_five_points_count() {
        let mut history = vec![(0.0, 1000), (1.0, 900)];
        history.extend([(2.0, 50), (3.0, 40), (4.0, 30), (5.0, 20), (6.0, 10)]);
        assert_eq!(eta(&history), Some(1.0));
    }

    #[test]
    fn rows_keep_the_best_count_and_the_last_via_count() {
        let path = std::env::temp_dir().join(format!("progress-{}.jsonl", std::process::id()));
        let _ = fs::remove_file(&path);
        let mut progress = Progress::new(&path);
        progress.mark("job start");
        progress.router_pass(1, 9, "route");
        progress.router_pass(2, 12, "route");
        progress.with_vias("import end", 7);
        progress.with_open("triage end", 3, None);
        let text = fs::read_to_string(&path).unwrap();
        let rows: Vec<Value> = text.lines().map(|line| serde_json::from_str(line).unwrap()).collect();
        assert_eq!(rows[0]["stage"], "job start");
        assert!(rows[0]["pass"].is_null() && rows[0]["open"].is_null() && rows[0]["vias"].is_null());
        assert_eq!((rows[2]["pass"].as_u64(), rows[2]["open"].as_u64(), rows[2]["best_open"].as_u64()), (Some(2), Some(12), Some(9)));
        assert_eq!((rows[4]["vias"].as_u64(), rows[4]["best_open"].as_u64()), (Some(7), Some(3)));
        let _ = fs::remove_file(&path);
    }
}
